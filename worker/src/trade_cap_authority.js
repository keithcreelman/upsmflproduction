// trade_cap_authority.js — the ONE post-trade cap / roster / loaded-contract / lineup
// calculation, shared by the 2-way accept path, the 2-way preview, the 3-way accept +
// execute gates and the 3-way detail view.
//
// RULING (Keith, 2026-09-25): a trade must not execute if the authoritative post-trade calculation PROVES a
// participating franchise would exceed the salary cap; an unavailable or unresolved calculation fails closed.
// Roster counts stay ADVISORY: they are projected and flagged, never a block (MFL itself refuses a trade it
// won't take, and that refusal is passed through untouched).
//
// RULING (2026-09-28): the SAME fail-closed philosophy extends to a second HARD block --
// a trade must not execute if it would leave any participant with more than 5 loaded
// (front-loaded + back-loaded combined) contracts (canon §2.G/§6.G). Lineup feasibility
// (can every participant still field one complete legal 18-man lineup after the trade) is
// a THIRD, ADVISORY-only sibling check, same vocabulary and same never-blocks contract as
// roster counts -- see worker/src/trade_lineup_feasibility.js's header for why it is a
// separate module and what is explicitly out of scope (current-week bye/injury/Out/
// Doubtful availability, a distinct courtesy warning, is NOT built here).
//
// AUTHORITY = the SAME code the Front Office roster workbench runs (worker/src/cap_math.js: currentCapHit, derivePlayerCapFields,
// parseCapDollars, readSalaryOverlay — imported by both, no second copy) computed from LIVE MFL exports read at the moment of the action:
//   • rosters + salaries — every rostered player: status, salary (the CURRENT-year amount, so a loaded /
//                          front-loaded contract already counts what it costs this year), contract fields; the
//                          `salaries` export overlays the roster row exactly as it does in the Front Office
//   • salaryAdjustments  — every adjustment MFL holds (drop penalties = dead money, earlier trade cap money,
//                          manual commissioner entries); summed per franchise
//   • league             — the cap amount (auctionStartAmount, else salaryCapAmount) and the roster maximum
// used(franchise) = Σ hit(player) + Σ adjustments,  hit = 0 for TAXI, 50% for INJURED_RESERVE (canon B3),
//                   0 for a KNOWN-expired contract (years remaining ≤ 0), otherwise the full salary.
//
// Post-trade: a franchise drops what it sends (at its CURRENT hit), takes on what it receives (a traded player
// lands as ROSTER at full salary — or, when an accepted pre-trade extension resets the current-year salary,
// at that amount — and only a player that is on the sender's taxi AND flagged taxi in the offer is
// re-demoted, hit 0), and settles cap money: the franchise SENDING cap money is charged +amount, the one
// RECEIVING it is credited −amount (exactly the salaryAdjustment rows the worker posts after an accept).
//
// Nothing here trusts the client: it takes raw export results and the server's own token lists. A missing,
// failed, malformed or unresolvable input returns status "unavailable" — never "ok".
//
// Pure functions only.

import { currentCapHit, derivePlayerCapFields, parseCapDollars, readSalaryOverlay } from "./cap_math.js";
import { resolveLoadedStatus, resolveExtensionLoadedStatus } from "./contract_classification.js";
import { evaluateLineupFeasibility, posGroup } from "./trade_lineup_feasibility.js";

export const ROSTER_MIN = 27;   // canon B1: MFL-enforced minimum (not exposed by the API)
export const LOADED_CONTRACT_MAX = 5;   // canon §2.G/§6.G: max 5 loaded (FL+BL combined) contracts per roster

const s = (v) => String(v == null ? "" : v).trim();
const pad4 = (v) => { const d = s(v).replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; };
const arr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const money = (n) => "$" + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** A single unresolved input fails the WHOLE calculation closed. */
const unavailable = (reason, detail) => ({ ok: false, reason, detail: detail || "" });

function num(v) {
  if (v === "" || v == null) return NaN;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : NaN;
}
const dollars = (v) => { const n = parseCapDollars(v); return n == null ? NaN : n; };

/** MFL 'league' export → { cap, rosterMax, names } or an unavailable result. */
export function readLeague(res) {
  if (!res || !res.ok || !isObj(res.data)) return unavailable("league_unavailable");
  const root = isObj(res.data.league) ? res.data.league : res.data;
  const cap = [root.auctionStartAmount, root.salaryCapAmount, root.salary_cap_amount].map(num).find((n) => Number.isFinite(n) && n > 0);
  if (!cap) return unavailable("cap_amount_unavailable");
  const rosterMax = [root.rosterSize].map(num).find((n) => Number.isFinite(n) && n > 0) || null;
  const names = {};
  for (const f of arr(root.franchises && (root.franchises.franchise || root.franchises))) {
    const id = pad4(f && (f.id || f.franchise_id)); if (id) names[id] = s(f.name || f.franchise_name) || id;
  }
  return { ok: true, cap: Math.round(cap), rosterMax, names };
}

/** MFL 'salaryAdjustments' export → { byFranchise } (raw dollars; + = charge, − = credit) or unavailable. */
export function readAdjustments(res) {
  if (!res || !res.ok || !isObj(res.data) || !("salaryAdjustments" in res.data)) return unavailable("adjustments_unavailable");
  const root = res.data.salaryAdjustments;
  let rows;
  if (root == null || root === "" ) rows = [];
  else if (isObj(root)) {
    const keys = Object.keys(root);
    if (!keys.length) rows = [];
    else if ("salaryAdjustment" in root) rows = arr(root.salaryAdjustment);
    else return unavailable("adjustments_malformed");
  } else if (Array.isArray(root)) rows = root;
  else return unavailable("adjustments_malformed");
  const byFranchise = {};
  for (const r of rows) {
    if (!isObj(r)) return unavailable("adjustments_malformed");
    const fid = pad4(r.franchise_id != null ? r.franchise_id : r.franchise);
    const amount = dollars(r.amount);
    if (!fid || !Number.isFinite(amount)) return unavailable("adjustments_malformed");
    if (fid === "0000") continue;
    byFranchise[fid] = (byFranchise[fid] || 0) + amount;
  }
  return { ok: true, byFranchise };
}

/** Re-exported for tests: THE rule lives in cap_math.js. */
export const capHit = currentCapHit;

/** rosters export (+ salaries overlay) → { fid → { pid → player } } for the wanted franchises, or unavailable. */
function readRosters(res, overlay, wanted) {
  if (!res || !res.ok || !isObj(res.data) || !isObj(res.data.rosters)) return unavailable("rosters_unavailable");
  const frs = arr(res.data.rosters.franchise || res.data.rosters.franchises).filter(isObj);
  if (!frs.length) return unavailable("rosters_unavailable");
  const out = {};
  for (const fr of frs) {
    const fid = pad4(fr.id || fr.franchise_id);
    if (!fid || !wanted.has(fid)) continue;
    const players = {};
    for (const raw of arr(fr.player || fr.players)) {
      const pid = s(raw && raw.id).replace(/\D/g, "");
      if (!pid) return unavailable("roster_malformed", fid);
      players[pid] = derivePlayerCapFields(raw, overlay.byPlayer[pid]);
    }
    out[fid] = players;
  }
  for (const fid of wanted) if (!out[fid]) return unavailable("franchise_not_in_rosters", fid);
  return { ok: true, byFranchise: out };
}

const tokenKind = (t) => (/^\d+$/.test(t) ? "player" : /^BB_/i.test(t) ? "cap" : "pick");

/** MFL 'players' export -> { pid -> raw position string } or null (unavailable -- the
 * lineup check is advisory and reports "unavailable" honestly rather than assuming
 * compliance; it never blocks, so this never triggers the whole-calculation empty()). */
function readPlayerPositions(res) {
  if (!res || !res.ok || !isObj(res.data) || !isObj(res.data.players)) return null;
  const rows = arr(res.data.players.player);
  if (!rows.length) return null;
  const out = {};
  for (const row of rows) {
    if (!isObj(row)) continue;
    const pid = s(row.id).replace(/\D/g, "");
    if (pid) out[pid] = s(row.position);
  }
  return out;
}

/**
 * @param league,rosters,adjustments,players  raw export results {ok, data} (`players` is optional --
 *                   its absence only degrades the ADVISORY lineup check to "unavailable", never the
 *                   HARD cap/loaded-contract blocks, which never touch position data at all)
 * @param movements  [{from, to, tokens:[…MFL tokens: player id | FP_ | DP_ | BB_<dollars>], capDollars?}]
 *                   (cap money is read from BB_ tokens; `capDollars` adds to it, used by builders that carry cap apart)
 * @param extensionSalary  { playerId → current-year salary (dollars) AFTER an accepted pre-trade extension }
 * @param taxiFlags        { playerId → true } for players the offer says stay on taxi after the trade
 * @param extensionRequests  [{player_id, to_franchise_id, loaded_indicator:"FL"|"BL"|"NONE"}] -- pre-trade
 *                   extensions in THIS deal (canon §C4); a player being extended lands on the acquiring
 *                   franchise (to_franchise_id) with the EXTENSION's loaded status, never their
 *                   about-to-be-replaced current one -- see the movements loop below.
 * @param conditionalDrops  { franchiseId -> [playerId, ...] } -- players THAT franchise has selected to
 *                   drop, conditional on this trade going through (Keith's ruling, 2026-09-29: a team
 *                   whose projected loaded-contract count would exceed 5 may still trade, but only with
 *                   enough valid conditional drops of ITS OWN loaded-contract players to bring it back to
 *                   5 or fewer -- required = max(0, projected − 5), never assumed equal to the number of
 *                   loaded players received). A selected player counts toward the requirement ONLY when it
 *                   is (a) currently on THAT franchise's own roster, (b) a genuinely loaded contract by the
 *                   SAME resolveLoadedStatus() this module already runs for everyone, and (c) not ALSO a
 *                   player being sent away in this same trade (a player can't be both sent and dropped).
 *                   Every selected id is reported back with why it did or didn't count -- nothing here
 *                   silently drops (pun intended) an invalid selection without saying so.
 */
export function evaluateTradeCompliance({ league, rosters, salaries, adjustments, movements, extensionSalary, taxiFlags, players, extensionRequests, conditionalDrops }) {
  const empty = (why) => ({
    participants: [],
    cap: { status: "unavailable", reason: why.reason, cap_dollars: null, rows: [], violations: [],
      message: "We couldn't verify the salary cap for this trade right now." },
    roster: { status: "unavailable", advisory: true, rows: [], warnings: [],
      message: "We couldn't check the roster counts for this trade right now." },
    loaded_contracts: { status: "unavailable", max: LOADED_CONTRACT_MAX, rows: [], violations: [],
      message: "We couldn't verify the loaded-contract count for this trade right now." },
    lineup: { status: "unavailable", advisory: true, rows: [], warnings: [],
      message: "We couldn't check lineup feasibility for this trade right now." },
  });
  const L = readLeague(league); if (!L.ok) return empty(L);
  const A = readAdjustments(adjustments); if (!A.ok) return empty(A);
  const mv = arr(movements).filter(isObj).map((m) => ({ from: pad4(m.from), to: pad4(m.to), tokens: arr(m.tokens).map(s).filter(Boolean), extraCap: Math.max(0, num(m.capDollars) || 0) }));
  const parts = new Set(); for (const m of mv) { if (m.from) parts.add(m.from); if (m.to) parts.add(m.to); }
  if (!parts.size || mv.some((m) => !m.from || !m.to || m.from === m.to)) return empty(unavailable("movements_malformed"));
  const O = readSalaryOverlay(salaries); if (!O.ok) return empty(O);
  const R = readRosters(rosters, O, parts); if (!R.ok) return empty(R);

  const ext = isObj(extensionSalary) ? extensionSalary : {}, taxi = isObj(taxiFlags) ? taxiFlags : {};
  // Scoped to loaded_contracts ONLY -- see resolveLoadedStatus's header for the priority
  // order; only a genuinely unresolvable contract (or, here, an unresolvable/mismatched
  // extension) sets this.
  let loadedUnresolved = false;
  // Extension requests: pid -> acquiring franchise / pid -> "FL"|"BL"|"" (post-extension).
  // A malformed/absent entry is simply not an extension for that pid -- extension WELL-
  // FORMEDNESS (player/franchise membership) is already enforced upstream (trade_3way.js's
  // extReqs filter) before this data ever reaches here.
  //
  // The extension's loaded status is DERIVED from its own authoritative priced terms
  // (preview_contract_info_string -- the exact year-by-year schedule the price was built
  // from), never trusted directly off e.loaded_indicator, which is a client-carried label
  // on a stored offer/preview. A mismatch between the claimed indicator and what the
  // priced terms actually show is treated as unresolved (fail closed) rather than
  // silently preferring one side -- a caller lying about loaded_indicator can never make
  // an actually-loaded extension look flat, and can never make an actually-flat one look
  // falsely blocked either; either way the gate refuses to guess.
  const extReqs = arr(extensionRequests).filter(isObj);
  const extendedPidToFid = {}, extendedPidLoaded = {};
  for (const e of extReqs) {
    const pid = s(e.player_id).replace(/\D/g, "");
    const to = pad4(e.to_franchise_id);
    if (!pid || !parts.has(to)) continue;
    extendedPidToFid[pid] = to;
    const claimed = s(e.loaded_indicator).toUpperCase();
    const claimedLoaded = claimed === "FL" || claimed === "BL" ? claimed : "";
    const derived = resolveExtensionLoadedStatus(s(e.preview_contract_info_string), Number(e.new_aav_future));
    if (!derived.resolved) { loadedUnresolved = true; continue; }
    if (derived.loaded !== claimedLoaded) { loadedUnresolved = true; continue; }   // claimed vs. priced terms disagree -- never guess which is right
    extendedPidLoaded[pid] = derived.loaded;
  }

  const positions = readPlayerPositions(players); // null = lineup check degrades to "unavailable" only
  const postTradeRoster = {};
  for (const fid of parts) postTradeRoster[fid] = [];

  const state = {};
  for (const fid of parts) {
    let used = A.byFranchise[fid] || 0, active = 0, loadedBefore = 0;
    for (const [pid, p] of Object.entries(R.byFranchise[fid])) {
      if (!p.taxi && !p.salaryResolved) return empty(unavailable("roster_salary_unresolved", fid));   // MFL blank ≠ $0
      // Loaded-contract classification runs BEFORE the taxi skip below -- a loaded
      // contract on taxi must still count (canon: max 5 loaded per roster, no taxi
      // carve-out; never fail OPEN by silently excluding a taxi player from the count).
      // A fully blank contract (years AND status AND info all blank -- p.unknown) goes
      // through this SAME resolveLoadedStatus() call as every other player, with no
      // shortcut to flat (2026-09-28 review, second pass): currentCapHit()'s "silence is
      // not proof of expiry" posture for THIS SAME flag, just below, is a cap-math
      // convention about the safe conservative default for a dollar total -- it does not
      // extend to "silence is proof of flat" here, where there is no safe default. A
      // genuinely blank contract naturally resolves as unresolved via priority 4 below
      // (status, length, and schedule are all unreadable), which is the correct outcome:
      // `loaded_contracts: unavailable`, never a silently assumed flat.
      const lstatus = resolveLoadedStatus(p.contractStatus, p.contractInfo);
      if (!lstatus.resolved) loadedUnresolved = true;
      else if (lstatus.loaded) loadedBefore += 1;
      const expired = (p.years | 0) <= 0 && !p.unknown;
      postTradeRoster[fid].push({ id: pid, group: positions ? posGroup(positions[pid]) : "", excluded: p.taxi || p.ir || expired });
      if (p.taxi) continue;
      used += currentCapHit(p);
      if (!p.ir) active += 1;
    }
    state[fid] = { before: used, after: used, activeBefore: active, activeAfter: active, sends: 0, receives: 0, capOut: 0, capIn: 0, loadedBefore, loadedAfter: loadedBefore };
  }
  for (const m of mv) {
    let capDollars = m.extraCap;
    for (const tok of m.tokens) {
      const kind = tokenKind(tok);
      if (kind === "cap") {
        const d = num(tok.slice(3));
        if (!Number.isFinite(d) || d < 0) return empty(unavailable("cap_money_malformed", tok));
        capDollars += d;
      } else if (kind === "player") {
        const p = R.byFranchise[m.from][tok];
        if (!p) return empty(unavailable("asset_not_on_sender", tok));
        const send = state[m.from];
        send.after -= currentCapHit(p); if (!p.taxi && !p.ir) send.activeAfter -= 1; send.sends += 1;
        // The sender always loses whatever contract they CURRENTLY hold -- extended or
        // not, they're giving that contract up, full stop. (Already resolved/flagged in
        // the per-franchise scan above, since m.from is always a participant scanned
        // there -- resolving again here just reuses the same deterministic function, with
        // no p.unknown shortcut, matching the scan above.)
        const sentLoaded = resolveLoadedStatus(p.contractStatus, p.contractInfo);
        if (sentLoaded.resolved && sentLoaded.loaded) send.loadedAfter -= 1;
        postTradeRoster[m.from] = postTradeRoster[m.from].filter((r) => r.id !== tok);

        const carriesTaxi = p.taxi && taxi[tok] === true;
        const recvSalary = Number.isFinite(num(ext[tok])) ? Math.round(num(ext[tok])) : p.salary;
        if (!Number.isFinite(recvSalary)) return empty(unavailable("roster_salary_unresolved", m.from));
        const land = { ...p, salary: recvSalary, ir: false, taxi: carriesTaxi };
        const recv = state[m.to];
        recv.after += currentCapHit(land); if (!carriesTaxi) recv.activeAfter += 1; recv.receives += 1;
        // Loaded-contract landing: if this token is ALSO being extended in this same
        // deal (to this exact receiver), the extension's own loaded_indicator decides
        // what lands -- never the pre-extension status (avoids double counting the same
        // contract slot). Otherwise the receiver simply inherits the sender's contract
        // unchanged, loaded status included.
        if (extendedPidToFid[tok] === m.to) { if (extendedPidLoaded[tok]) recv.loadedAfter += 1; }
        else if (sentLoaded.resolved && sentLoaded.loaded) recv.loadedAfter += 1;
        const expiredLanded = (land.years | 0) <= 0 && !land.unknown;
        postTradeRoster[m.to].push({ id: tok, group: positions ? posGroup(positions[tok]) : "", excluded: land.taxi || land.ir || expiredLanded });
      }
    }
    if (capDollars > 0) { state[m.from].after += capDollars; state[m.from].capOut += capDollars; state[m.to].after -= capDollars; state[m.to].capIn += capDollars; }
  }
  // Defensive fallback only: an extension whose player somehow isn't ALSO a movement
  // token (not the documented shape -- extensions accompany the exact asset they extend
  // -- but handled rather than silently ignored) still lands its new loaded status.
  for (const pid of Object.keys(extendedPidToFid)) {
    const to = extendedPidToFid[pid];
    const alreadyHandled = mv.some((m) => m.to === to && m.tokens.includes(pid));
    if (!alreadyHandled && extendedPidLoaded[pid]) state[to].loadedAfter += 1;
  }

  // Which tokens each franchise is SENDING in this trade (a player can't be both sent and dropped).
  const sentTokensByFranchise = {};
  for (const fid of parts) sentTokensByFranchise[fid] = new Set();
  for (const m of mv) for (const tok of m.tokens) if (tokenKind(tok) === "player") sentTokensByFranchise[m.from].add(tok);

  const name = (fid) => L.names[fid] || fid;
  const capRows = [], violations = [];
  for (const fid of [...parts].sort()) {
    const st = state[fid], over = st.after - L.cap;
    const row = { franchise_id: fid, franchise_name: name(fid), used_before: st.before, used_after: st.after, cap_dollars: L.cap, room_after: L.cap - st.after, over_by: Math.max(0, over) };
    capRows.push(row);
    if (over > 0) violations.push({ franchise_id: fid, franchise_name: name(fid), amount_over: over, projected_used: st.after, cap_dollars: L.cap,
      message: `${name(fid)} would be ${money(over)} over the ${money(L.cap)} salary cap after this trade (projected ${money(st.after)}).` });
  }
  const rosterRows = [], warnings = [];
  const maxKnown = L.rosterMax != null;
  for (const fid of [...parts].sort()) {
    const st = state[fid];
    let status = "within";
    if (st.activeAfter < ROSTER_MIN) status = "below_min"; else if (maxKnown && st.activeAfter > L.rosterMax) status = "above_max";
    const row = { franchise_id: fid, franchise_name: name(fid), active_before: st.activeBefore, active_after: st.activeAfter, min: ROSTER_MIN, max: L.rosterMax, status };
    rosterRows.push(row);
    if (status === "above_max") warnings.push({ ...row, message: `${name(fid)} would have ${st.activeAfter} active players after this trade (limit ${L.rosterMax}), so a cut may be needed afterward.` });
    if (status === "below_min") warnings.push({ ...row, message: `${name(fid)} would have ${st.activeAfter} active players after this trade (minimum ${ROSTER_MIN}), so an add may be needed afterward.` });
  }
  const rosterStatus = !maxKnown ? "unavailable" : warnings.length ? "warn" : "ok";

  // Conditional drops (Keith's ruling, 2026-09-29): a franchise projected over the limit may still
  // trade if it validly selects enough of its OWN loaded-contract players to drop. `dropReqs` is
  // built for EVERY over-limit franchise regardless of whether any drops were supplied, so the
  // caller always sees "how many are required" even before anyone has picked anything.
  const loadedRows = [], loadedViolations = [], dropReqs = [];
  const drops = isObj(conditionalDrops) ? conditionalDrops : {};
  if (!loadedUnresolved) {
    for (const fid of [...parts].sort()) {
      const st = state[fid];
      const projected = st.loadedAfter;   // BEFORE any conditional drop -- the figure the requirement is computed from
      const over = projected > LOADED_CONTRACT_MAX;
      const row = { franchise_id: fid, franchise_name: name(fid), loaded_before: st.loadedBefore, loaded_after: projected, max: LOADED_CONTRACT_MAX };
      loadedRows.push(row);
      if (!over) continue;
      const required = projected - LOADED_CONTRACT_MAX;   // max(0, projected - 5), and projected > 5 here so this IS positive
      const selected = arr(drops[fid]).map(s).filter(Boolean);
      const seen = new Set();
      const picks = selected.map((pid) => {
        if (seen.has(pid)) return { player_id: pid, valid: false, reason: "duplicate_selection" };
        seen.add(pid);
        const p = R.byFranchise[fid] && R.byFranchise[fid][pid];
        if (!p) return { player_id: pid, valid: false, reason: "not_on_roster" };
        if (sentTokensByFranchise[fid].has(pid)) return { player_id: pid, valid: false, reason: "also_being_sent" };
        const lst = resolveLoadedStatus(p.contractStatus, p.contractInfo);
        if (!lst.resolved) return { player_id: pid, valid: false, reason: "contract_unresolved" };
        if (!lst.loaded) return { player_id: pid, valid: false, reason: "not_a_loaded_contract" };
        return { player_id: pid, valid: true, reason: "" };
      });
      const validCount = picks.filter((x) => x.valid).length;
      const satisfied = validCount >= required;
      dropReqs.push({ franchise_id: fid, franchise_name: name(fid), loaded_before: st.loadedBefore, projected, required_drops: required, selected: picks, valid_count: validCount, satisfied });
      if (!satisfied) {
        loadedViolations.push({ franchise_id: fid, franchise_name: name(fid), projected, max: LOADED_CONTRACT_MAX, required_drops: required, valid_drops: validCount,
          message: `${name(fid)} would move from ${st.loadedBefore} to ${projected} loaded contracts. The maximum is ${LOADED_CONTRACT_MAX}, so ${required} conditional drop${required === 1 ? "" : "s"} of ${name(fid)}'s own loaded-contract player${required === 1 ? "" : "s"} ${required === 1 ? "is" : "are"} required before this trade can go through` +
            (validCount > 0 ? ` (${validCount} of ${required} currently selected and valid).` : ".") });
      }
    }
  }

  const lineup = evaluateLineupFeasibility({
    franchises: Object.fromEntries([...parts].map((fid) => [fid, { name: name(fid), roster: positions ? postTradeRoster[fid] : null }])),
    expectedFids: [...parts],
  });

  return {
    participants: [...parts].sort(),
    cap: violations.length
      ? { status: "blocked", reason: "over_cap", cap_dollars: L.cap, rows: capRows, violations, message: violations.map((v) => v.message).join(" ") }
      : { status: "ok", reason: "", cap_dollars: L.cap, rows: capRows, violations: [], message: "Every team stays under the salary cap." },
    roster: {
      status: rosterStatus, advisory: true, rows: rosterRows, warnings,
      message: rosterStatus === "unavailable" ? "We couldn't confirm the roster limit for this trade right now."
        : warnings.length ? warnings.map((w) => w.message).join(" ") + " This is a heads-up, not a ruling on whether the trade is allowed — MFL decides when it processes the trade."
        : "Every team stays within its roster limits.",
    },
    // status: "ok" (nobody over, before any drop) | "needs_drops" (someone's over, but every
    // over-limit franchise has a VALID, SUFFICIENT drop selection -- the trade is conditional but
    // may proceed) | "blocked" (someone's over and does NOT yet have a satisfied selection -- a
    // hard stop, exactly like before this ruling, just now escapable via drops rather than
    // permanent) | "unavailable".
    loaded_contracts: loadedUnresolved
      ? { status: "unavailable", max: LOADED_CONTRACT_MAX, rows: [], violations: [], drop_requirements: [], message: "We couldn't verify the loaded-contract count for this trade right now (at least one contract's structure isn't resolvable from live data)." }
      : loadedViolations.length
      ? { status: "blocked", max: LOADED_CONTRACT_MAX, rows: loadedRows, violations: loadedViolations, drop_requirements: dropReqs, message: loadedViolations.map((v) => v.message).join(" ") }
      : dropReqs.length
      ? { status: "needs_drops", max: LOADED_CONTRACT_MAX, rows: loadedRows, violations: [], drop_requirements: dropReqs, message: dropReqs.map((d) => `${d.franchise_name}: ${d.required_drops} conditional drop${d.required_drops === 1 ? "" : "s"} selected and valid.`).join(" ") }
      : { status: "ok", max: LOADED_CONTRACT_MAX, rows: loadedRows, violations: [], drop_requirements: [], message: "Every team stays at or under the 5 loaded-contract limit." },
    lineup,
  };
}
