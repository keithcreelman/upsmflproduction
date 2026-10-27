// /api/player-transactions — which contract belongs to which event (#1338, Player Modal Phase 1).
//
// The route used to attach a season's ONE contract row (src_contracts, PK season+player) to EVERY acquisition
// that season, so an earlier acquisition inherited a later contract (Jacoby Brissett 2026: a July 17 $12,000
// test-auction row showed the July 29 $13,000 contract). These pure functions fix the association:
//
//   1. An MFL AUCTION_WON is VERIFIED only when MFL's own completed auction results (TYPE=auctionResults)
//      list the same player, franchise and winning bid. Otherwise it stays in the log, marked unresolved,
//      with no contract (MFL's transaction log is append-only: test or reversed lots stay there forever).
//   2. A season's contract row belongs to the ownership chain that ends at the row's franchise: walking the
//      season backwards, trades into that franchise carry it, and the first acquisition by that franchise owns
//      it (for a 1-year deal the price must equal the contract's salary). Every other acquisition, trade or
//      tag that season gets contract: null and a contract_unresolved reason — never another event's terms.
//   3. A drop is hidden only when the SAME franchise re-acquires the player later that season (expired-
//      contract churn); a drop followed by another team's acquisition is a real move and stays.
//
// No fetch, no D1: the route passes MFL's auction results and its src_contracts rows in.

const pad4 = (v) => { const d = String(v == null ? "" : v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
const money = (s) => { const n = parseInt(String(s == null ? "" : s).replace(/[^0-9]/g, ""), 10); return Number.isFinite(n) ? n : 0; };
const CHAIN_KINDS = new Set(["auction", "add", "trade", "dispersal", "tag"]);
const ACQ_KINDS = new Set(["auction", "add", "draft"]);
// A win posts after the last bid: up to 5.1 days in 2019–2021, under 2 days since (every AUCTION_WON 2019–2025
// matched MFL's auction results on player + team + bid; 2026's only 18 misses are the July 13–17 test lots).
const WIN_WINDOW_S = 7 * 86400;

// MFL TYPE=auctionResults JSON → { ok, rows: [{ player, franchise, bid, lastBid }] }. A body without the
// auctionResults key (an error envelope, a failed read) is ok:false — "can't verify", never "no auctions".
export function auctionResultsIndex(json) {
  const root = json && json.auctionResults;
  if (!root) return { ok: false, rows: [] };
  let units = root.auctionUnit || [];
  if (!Array.isArray(units)) units = [units];
  const rows = [];
  for (const u of units) {
    let a = (u && u.auction) || [];
    if (!Array.isArray(a)) a = [a];
    for (const r of a) {
      rows.push({ player: String(r.player || "").replace(/\D/g, ""), franchise: pad4(r.franchise), bid: money(r.winningBid), lastBid: parseInt(r.lastBidTime, 10) || 0 });
    }
  }
  return { ok: true, rows };
}

// Is this AUCTION_WON event one of MFL's completed auctions? → { verified, reason }
export function verifyAuctionWin(ev, pid, results) {
  if (!results || !results.ok) return { verified: false, reason: "MFL’s auction results for " + ev.season + " couldn’t be read" };
  const bid = money(ev.detail);
  const hit = results.rows.find((r) => r.player === String(pid) && r.franchise === pad4(ev.franchise_id) && r.bid === bid &&
    (!r.lastBid || !ev.ts || (ev.ts >= r.lastBid - 3600 && ev.ts - r.lastBid <= WIN_WINDOW_S)));
  return hit ? { verified: true, reason: "" } : { verified: false, reason: "not in MFL’s completed auction results (a test or reversed lot)" };
}

function isAuctionWon(ev) { return ev.kind === "auction" && (ev.mfl_type === "AUCTION_WON" || (!ev.mfl_type && ev.label === "Auction Won")); }
function unresolve(ev, reason) { ev.contract = null; ev.contract_unresolved = reason; }

// events: the route's list (mutated and returned). ctx: { pid, srcBySeason: { [season]: src_contracts row },
// auctionsBySeason: { [season]: auctionResultsIndex(...) } }.
export function resolveEventContracts(events, ctx) {
  const pid = String(ctx && ctx.pid || "");
  const src = (ctx && ctx.srcBySeason) || {};
  const auctions = (ctx && ctx.auctionsBySeason) || {};
  // 1. Verify every MFL auction win.
  for (const ev of events) {
    if (!isAuctionWon(ev)) continue;
    const v = verifyAuctionWin(ev, pid, auctions[String(ev.season)]);
    ev.verified = v.verified;
    if (!v.verified) { ev.unresolved = v.reason; unresolve(ev, "the auction isn’t verified, so no contract is attached"); }
  }
  // 2. Each season's contract follows its ownership chain.
  const seasons = Array.from(new Set(events.map((e) => String(e.season))));
  for (const s of seasons) {
    const row = src[s];
    const chain = events.filter((e) => String(e.season) === s && CHAIN_KINDS.has(e.kind)).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!row) continue;                         // no season contract → the route attached none
    let owner = pad4(row.franchise_id);
    if (!owner) { chain.forEach((e) => { if (e.contract) unresolve(e, "the season’s contract record has no team"); }); continue; }
    const cl = parseInt(row.contract_length, 10) || 0;
    const salary = Math.round(Number(row.aav) || 0) || (cl === 1 ? Math.round(Number(row.tcv) || 0) : 0);
    let owned = false;
    for (const ev of chain) {
      if (ev.unresolved) continue;
      const fid = pad4(ev.franchise_id);
      if (owned) { if (ev.contract) unresolve(ev, "an earlier move this season; the season’s contract record belongs to a later acquisition"); continue; }
      if (ev.kind === "trade" || ev.kind === "dispersal") {
        if (fid === owner) { owner = pad4(ev.from_franchise_id); continue; }   // a trade into the record's team carries it
        if (pad4(ev.from_franchise_id) === owner) continue;                       // the record predates a trade out: same contract
        if (ev.contract) unresolve(ev, "not on the path to the team that holds the season’s contract record");
        continue;
      }
      if (ev.kind === "tag") {
        if (fid !== owner && ev.contract) unresolve(ev, "a different team’s tag; the season’s contract record belongs to another team");
        continue;
      }
      // An acquisition (auction / add).
      if (fid !== owner) { if (ev.contract) unresolve(ev, "a different team’s acquisition; the season’s contract record belongs to another team"); continue; }
      const price = money(ev.detail);
      if (ev.contract && cl === 1 && price && salary && price !== salary) {
        unresolve(ev, "price " + "$" + price.toLocaleString("en-US") + " doesn’t match the season contract’s $" + salary.toLocaleString("en-US"));
      }
      owned = true;
    }
  }
  return events;
}

// Hide a drop only when the SAME franchise re-acquires the player later that season (verified acquisitions only).
export function cleanDrops(events) {
  return events.filter((e) => {
    if (e.kind !== "drop") return true;
    const next = events.filter((x) => ACQ_KINDS.has(x.kind) && !x.unresolved && String(x.season) === String(e.season) && (x.ts || 0) > (e.ts || 0))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))[0];
    return !(next && pad4(next.franchise_id) === pad4(e.franchise_id));
  });
}
