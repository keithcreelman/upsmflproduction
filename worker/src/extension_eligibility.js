// extension_eligibility.js — is a PRE-TRADE EXTENSION still allowed, judged NOW, from authoritative data? (pure; no I/O)
//
// A pre-trade extension is promised when an offer is built and applied only after MFL executes the trade. Days or weeks can pass in between,
// so everything that made it legal has to be re-proven at the moment of the accept / execute. This module is the single place that re-proof
// lives; both the two-team accept and the three-team accept + execute gates reach it through `planExtensionSalaries` (worker/src/index.js),
// which loads the FACTS from the authorities named below and hands them here.
//
// FAIL CLOSED: a fact that could not be loaded (undefined / null where a value is required) is never read as "no restriction" — the extension
// is refused with `authority_unavailable:<fact>` and the trade is held (it is recoverable: re-check once the source is readable).
//
// Rules, in the order they are judged, with the authority each is judged against (docs/league_context_v1.md §C4 unless noted):
//   R1 scope       — the offer's league/season are the exact ones being judged, and that season is the CURRENT one      [trade row / worker season]
//   R2 owner       — the player is on the roster of the team that is giving him up (the extender), right now            [MFL rosters export]
//   R3 contract    — MFL has a readable, non-blank contract for him (a blank contract is unresolved, not $0)              [MFL salaries export]
//   R4 final year  — years remaining = 1 (or an expired ROOKIE, 0, while the rookie-extension window is open)              [MFL salaries export; tag/rookie deadline]
//   R5 type/lock   — not tagged (tag overrides extension, §Tag), and not a Vet-ERA winner inside its MYAC window (§E3)    [D1 ups_tag_master + MFL contractStatus; Sept deadline]
//   R6 deadline    — on/before the September contract deadline; after it ONLY inside the four-week acquisition window     [contract deadline (calendar → hardcoded, fail-closed); MFL transactions]
//   R7 history     — nobody extended him this season, and this franchise's earlier extension is not still running          [D1 ups_extension_master]
//   R8 restructure — his contract was not restructured after the offer was made (it moved on)                             [D1 ups_restructure_submissions]
//   R9 amount      — the live salary/AAV still anchors year 1 of the offer; the offer is internally consistent           [MFL salaries export vs the stored offer]
// "Offer revision current": the stored offer is immutable (two-team: the accept reads the stored offer and refuses any other; three-team: the
// row's extension_requests are never edited after create — a changed deal is a NEW trade id), so what is judged is always what was accepted.
//
// Window arithmetic (seconds, inclusive at the edges — "at the deadline" is still allowed, one second after is not):
//   standard:      now <= septDeadline
//   after it:      trade-acquired      0 <= age <= 28 days
//                  FCFS/waiver/auction 14 days <= age <= 28 days   (days 1-14 are the MYM window, days 15-28 extension — §C4)

export const DAY = 86400;
export const WINDOW_DAYS = 28;
export const PICKUP_MYM_DAYS = 14;

const s = (v) => String(v == null ? "" : v).trim();
const digits = (v) => s(v).replace(/\D/g, "");
const pad4 = (v) => { const d = digits(v); return d ? d.padStart(4, "0").slice(-4) : ""; };
const roundK = (n) => Math.round((Number(n) || 0) / 1000) * 1000;

export const EXT_RULES = Object.freeze({
  scope: "the offer's league/season, and that season is the current one",
  owner: "MFL rosters export — the extender still owns the player",
  contract: "MFL salaries export — a readable, non-blank contract",
  final_year: "MFL salaries export — contractYear (years remaining) = 1, or an expired rookie inside the rookie-extension window",
  tag: "D1 ups_tag_master (+ MFL contractStatus) — tagged players cannot be extended",
  era_myac: "MFL contractStatus Vet-ERA before the September contract deadline (canon §E3)",
  deadline: "September contract deadline (commissioner calendar → pinned baseline; unreadable ⇒ closed)",
  window: "MFL transactions export — acquisition time: trade 0-28 days, FCFS/waiver/auction days 14-28",
  history: "D1 ups_extension_master — extended this season by anyone, or by this franchise while the contract still runs",
  restructure: "D1 ups_restructure_submissions — restructured after the offer was made",
  amount: "MFL salaries export vs the stored offer — year 1 anchors to the live salary/AAV; length/TCV/term agree",
});

/**
 * Latest acquisition of `pid` by franchise `fid` from MFL's `transactions` export (all types).
 *   FREE_AGENT / BBID_WAIVER / AUCTION_WON: `transaction` = "<added ids>|<dropped ids>", franchise = the acquirer  → kind "pickup"
 *   TRADE: franchise1_gave_up / franchise2_gave_up are the asset lists each side sent → the OTHER side acquired   → kind "trade"
 * Returns { kind, ts } | null (no acquisition found). Throws nothing; a malformed export yields null (the caller distinguishes "unreadable").
 */
export function latestAcquisition(txData, pid, fid) {
  const p = digits(pid), f = pad4(fid);
  const raw = txData && txData.transactions && txData.transactions.transaction;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  let best = null;
  const has = (csv) => s(csv).split(",").map((x) => digits(x.split("_")[0])).includes(p);
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const ts = Number(t.timestamp) || 0;
    if (!ts) continue;
    const type = s(t.type).toUpperCase();
    let hit = null;
    if (type === "FREE_AGENT" || type === "BBID_WAIVER" || type === "AUCTION_WON") {
      if (pad4(t.franchise) === f && has(s(t.transaction).split("|")[0])) hit = "pickup";
    } else if (type === "TRADE") {
      const f1 = pad4(t.franchise), f2 = pad4(t.franchise2);
      if (f2 === f && has(t.franchise1_gave_up)) hit = "trade";
      else if (f1 === f && has(t.franchise2_gave_up)) hit = "trade";
    }
    if (hit && (!best || ts > best.ts)) best = { kind: hit, ts };
  }
  return best;
}

const no = (rule, reason, detail) => ({ ok: false, rule, reason, detail: detail || "" });
const missing = (fact) => no("authority", `authority_unavailable:${fact}`, `The ${fact} could not be read, so the extension cannot be confirmed.`);

/** Parse `TCV 12K|CL 2|AAV 6K` style info. Values in dollars; null when absent. */
export function parseLiveContract(info) {
  const t = s(info);
  const num = (re) => { const m = t.match(re); if (!m) return null; let n = Number(String(m[1]).replace(/,/g, "")); if (!Number.isFinite(n)) return null; if (m[2] || n < 1000) n *= 1000; return Math.round(n); };
  const tcv = num(/TCV\s*\$?([\d,]+(?:\.\d+)?)\s*(K)?/i);
  const clm = t.match(/\bCL\s*(\d+)/i);
  const cl = clm ? parseInt(clm[1], 10) : null;
  return { tcv, cl, aav: tcv != null && cl > 0 ? Math.round(tcv / cl) : null };
}

/**
 * Judge ONE extension request. `facts` is described at the top of this file / in the caller. Returns { ok:true } or
 * { ok:false, rule, reason, detail }. `reason` is a stable machine code.
 */
export function evaluateExtensionEligibility({ request, facts, nowUnix }) {
  const f = facts || {};
  const req = request || {};
  const pid = digits(req.player_id);
  if (!pid) return no("scope", "missing_player_id");
  const now = Number(nowUnix);
  if (!Number.isFinite(now) || now <= 0) return missing("clock");

  // R1 — exact league/season, and the CURRENT season
  if (!s(f.tradeLeagueId) || !s(f.tradeSeason) || !s(f.currentSeason)) return missing("season");
  if (s(f.tradeSeason) !== s(f.currentSeason)) return no("scope", "wrong_season", `This offer is for ${f.tradeSeason}; the current season is ${f.currentSeason}.`);
  if (s(req.season) && s(req.season) !== s(f.tradeSeason)) return no("scope", "wrong_season", "The extension was built for a different season.");
  if (s(req.league_id) && s(req.league_id) !== s(f.tradeLeagueId)) return no("scope", "wrong_league", "The extension was built for a different league.");

  // R2 — the extender still owns him
  if (f.ownerFid === undefined || f.ownerFid === null) return missing("rosters");
  const extender = pad4(req.from_franchise_id || req.fromFranchiseId);
  if (!extender) return no("owner", "no_extender", "The extension does not say which team is extending.");
  if (pad4(f.ownerFid) !== extender) return no("owner", "not_current_owner", "The player is no longer on the team that was going to extend him.");

  // R3 — a readable contract
  const c = f.contract;
  if (!c) return no("contract", "no_live_contract", "MFL has no contract for this player.");
  const cy = parseInt(s(c.cy), 10);
  if (!Number.isFinite(cy)) return no("contract", "live_contract_unreadable", "The player's contract years remaining could not be read.");
  const status = s(c.status);

  // R5 (first: a tag overrides everything) — tag lock
  if (f.tagged === null || f.tagged === undefined) return missing("tags");
  if (f.tagged || /(^|[^a-z])tag(ged)?([^a-z]|$)/i.test(status)) return no("tag", "tagged", "Tagged players cannot be extended.");

  // R4 — final year (or an expired rookie inside the rookie-extension window)
  if (cy > 1) return no("final_year", "not_final_year", "The player has more than one year left, so he is not extension-eligible.");
  if (cy < 1) {
    if (f.rookieWindowOpen === null || f.rookieWindowOpen === undefined) return missing("rookie_deadline");
    if (!/^rookie/i.test(status)) return no("final_year", "not_final_year", "An expired contract can only be extended for a rookie.");
    if (!f.rookieWindowOpen) return no("final_year", "rookie_window_closed", "The rookie-extension deadline has passed.");
  }

  // R5b — Vet-ERA winners are locked out of pre-trade extensions until the September deadline (§E3)
  if (f.septDeadlineUnix === null || f.septDeadlineUnix === undefined) return missing("contract_deadline");
  const deadline = Number(f.septDeadlineUnix);
  if (!Number.isFinite(deadline) || deadline <= 0) return missing("contract_deadline");
  if (/^vet-era/i.test(status) && now <= deadline) return no("era_myac", "vet_era_myac_window", "This ERA winner is still in the MYAC window, so a pre-trade extension isn't allowed yet.");

  // R6 — the deadline / four-week window
  let window = "standard";
  if (now > deadline) {
    if (f.acquisition === undefined) return missing("transactions");
    if (f.acquisition === null) return no("window", "deadline_passed", "The September contract deadline has passed and no recent acquisition opens a window.");
    const age = now - Number(f.acquisition.ts);
    if (!Number.isFinite(age) || age < 0) return no("window", "window_unresolved", "The acquisition time could not be trusted.");
    if (age > WINDOW_DAYS * DAY) return no("window", "window_closed", "The four-week extension window has closed.");
    if (f.acquisition.kind === "pickup" && age < PICKUP_MYM_DAYS * DAY) return no("window", "window_not_open", "A waiver/FCFS pickup is in its MYM window for the first 14 days; extensions open on day 15.");
    window = f.acquisition.kind === "trade" ? "trade_window" : "pickup_window";
  }

  // R7 — extension history
  if (!f.extension) return missing("extension_history");
  if (f.extension.thisSeason) return no("history", "already_extended", "This player was already extended this season.");
  if (f.extension.pairActive) return no("history", "already_extended", "This team's earlier extension of the player is still running.");

  // R8 — restructure history
  if (f.restructuredSinceOffer === null || f.restructuredSinceOffer === undefined) return missing("restructure_history");
  if (f.restructuredSinceOffer) return no("restructure", "contract_restructured_since_offer", "The contract was restructured after this offer was made.");

  // R9 — current salary / amount
  const plan = f.plan;
  if (!plan || !Number.isFinite(Number(plan.year1Salary))) return no("amount", "missing_salary_for_contract_year", "The offer's year-1 salary could not be determined.");
  if (cy >= 1) {
    const liveSalary = Number(String(c.salary == null ? "" : c.salary).replace(/[^\d.]/g, ""));
    const live = parseLiveContract(c.info);
    if (!Number.isFinite(liveSalary) || liveSalary <= 0 || live.aav == null) return no("amount", "live_contract_unreadable", "The player's current salary/contract could not be read, so the extension can't be checked against it.");
    const y1 = roundK(plan.year1Salary);
    if (y1 !== roundK(liveSalary) && y1 !== roundK(live.aav)) return no("amount", "stale_current_salary", "The player's contract has changed since this offer was made.");
  }
  const reqLen = req.new_contract_length != null ? parseInt(req.new_contract_length, 10) : null;
  if (reqLen != null && Number.isFinite(reqLen) && Number.isFinite(Number(plan.length)) && reqLen !== Number(plan.length)) return no("amount", "terms_inconsistent", "The offer's contract length doesn't match its own contract terms.");
  const reqTcv = req.new_TCV != null ? Number(req.new_TCV) : req.new_tcv != null ? Number(req.new_tcv) : null;
  if (reqTcv != null && Number.isFinite(reqTcv) && Number.isFinite(Number(plan.tcv)) && roundK(reqTcv) !== roundK(plan.tcv)) return no("amount", "terms_inconsistent", "The offer's total contract value doesn't match its own year-by-year salaries.");
  const term = parseInt((s(req.extension_term || req.extensionTerm || req.term).match(/(\d+)/) || [])[1], 10);
  if (Number.isFinite(term) && Number.isFinite(Number(plan.length))) {
    const expected = (cy >= 1 ? 1 : 0) + term;
    if (Number(plan.length) !== expected) return no("amount", "terms_inconsistent", "The offer's contract length doesn't match the extension term requested.");
  }
  return { ok: true, window, cy, status };
}
