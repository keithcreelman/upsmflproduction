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

import { PHASES, candidateRosterMaxes, CALENDAR_FIX_TEXT } from "./trade_season_window.js";
import { currentCapHit, derivePlayerCapFields, parseCapDollars, readSalaryOverlay } from "./cap_math.js";
import { resolveLoadedStatus, resolveExtensionLoadedStatus } from "./contract_classification.js";
import { evaluateLineupFeasibility, posGroup } from "./trade_lineup_feasibility.js";

export const ROSTER_MIN = 27;   // canon B1: MFL-enforced minimum (not exposed by the API)
export const LOADED_CONTRACT_MAX = 5;   // canon §2.G/§6.G: max 5 loaded (FL+BL combined) contracts per roster
export const ACTIVE_QB_MAX = 5;         // canon §B1: at most 5 QBs on the ACTIVE roster (taxi and IR excluded) — a War Room trade-time gate on the ACTUAL post-trade count

// RULING (Keith, 2026-09-29, reviewing the FIRST conditional-drop PR): "needs_drops must not
// allow a two-team MFL acceptance or a three-team execution while no conditional-drop executor
// exists." No code anywhere calls MFL to actually drop a player yet -- see
// docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md for the traced write sequence and why it is not
// built. A franchise validly SELECTING enough drops to cover its requirement ("needs_drops") is
// NOT the same thing as those drops having actually happened, so it must not by itself permit a
// real, irreversible MFL write -- including, for a 2-way trade, even PROPOSING it to MFL, since
// a proposed offer becomes a real, natively-acceptable pending trade the instant it exists (see
// the design doc's native-MFL-bypass section). Flip this to true ONLY once that executor is
// built AND separately reviewed/approved; until then it stays false everywhere in this file.
export const LOADED_CONTRACT_DROP_EXECUTION_LIVE = false;

// The ONE function every enforcement point (2-way create/accept, 3-way create/capGate) must call
// before treating a loaded-contract verdict as safe to act on for a REAL write. "ok" (nobody
// over) always permits it. "needs_drops" (over, but a currently-valid selection covers it) only
// permits it once LOADED_CONTRACT_DROP_EXECUTION_LIVE is true -- never based on `satisfied`
// alone. "blocked" and "unavailable" never permit it. Centralized here, rather than duplicated
// as an inline `status === "ok" || status === "needs_drops"` at each call site, specifically
// because that exact duplication is what let a satisfied-but-unexecuted selection slip through
// in the first PR (the client's own interpretPreview had it, index.js's create/accept gates did
// not check it at all).
export function loadedContractsPermitsWrite(status) {
  return status === "ok" || (LOADED_CONTRACT_DROP_EXECUTION_LIVE && status === "needs_drops");
}

// RULING (Keith, 2026-10-01): "I do not want owners using... a conditional-drop picker... for
// this rule." Replaces every call site's own ad-hoc "pick drops to fix it" response-building
// with ONE shared shape: which team(s), their projected count, the limit, and nothing
// resembling an in-trade fix. Callers pass `loaded_contracts.violations` (only meaningful once
// `status === "blocked"` -- "unavailable"/"ok" are each handled separately, per call site, the
// same way they already were before this ruling). No `drop_requirements`/`candidates` here --
// there is nothing to pick.
export function loadedContractBlockPayload(loadedContracts) {
  const violations = Array.isArray(loadedContracts && loadedContracts.violations) ? loadedContracts.violations : [];
  const message = violations.length ? violations.map((v) => v.message).join(" ") : "This trade would leave a team over the loaded-contract limit.";
  const teams = violations.map((v) => ({ franchise_id: v.franchise_id, franchise_name: v.franchise_name, projected: v.projected, max: v.max }));
  return { code: "loaded_contract_limit_exceeded", message, teams };
}

/** The 409 body for a roster-maximum or five-active-QB refusal (Keith 2026-10-07): the team, the actual
 * count, (roster only) the count after the arriving-taxi moves this trade's own taxi step will make, and
 * the limit. The QB count is ACTUAL only. No picker, no conditional anything. */
export function tradeLimitBlockPayload(gate, code) {
  const violations = Array.isArray(gate && gate.violations) ? gate.violations : [];
  const message = violations.length ? violations.map((v) => v.message).join(" ") : "This trade would leave a team over a roster limit.";
  const teams = violations.map((v) => code === "qb_limit_exceeded"
    ? { franchise_id: v.franchise_id, franchise_name: v.franchise_name, active_qbs_after: v.active_qbs_after, max: v.max }
    : { franchise_id: v.franchise_id, franchise_name: v.franchise_name, active_after: v.active_after, active_after_taxi: v.active_after_taxi, max: v.max, moves_needed: v.moves_needed,
        taxi_moves: v.taxi_moves || [], taxi_not_credited: v.taxi_not_credited || [] });
  return { code, message, teams };
}

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
  const taxiMax = [root.taxiSquad].map(num).find((n) => Number.isFinite(n) && n >= 0);
  const names = {};
  for (const f of arr(root.franchises && (root.franchises.franchise || root.franchises))) {
    const id = pad4(f && (f.id || f.franchise_id)); if (id) names[id] = s(f.name || f.franchise_name) || id;
  }
  return { ok: true, cap: Math.round(cap), rosterMax, taxiMax: Number.isFinite(taxiMax) ? taxiMax : null, names };
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

/** MFL 'players' export -> { pid -> "First Last" } (display only; {} when unavailable). */
function readPlayerNames(res) {
  const out = {};
  if (!res || !res.ok || !isObj(res.data) || !isObj(res.data.players)) return out;
  for (const row of arr(res.data.players.player)) {
    if (!isObj(row)) continue;
    const pid = s(row.id).replace(/\D/g, "");
    const raw = s(row.name), m = raw.match(/^([^,]+),\s*(.+)$/);
    if (pid) out[pid] = m ? `${m[2]} ${m[1]}` : raw;
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
 * @param taxiFlags        IGNORED (kept for callers). It once let a player the offer flagged "taxi" arrive on the
 *                   receiver's taxi squad here ($0, not active). MFL never does that: every traded player arrives on
 *                   the ACTIVE roster (7 of 7 taxi players traded in 2026), and under lockout nothing moves him back at
 *                   that moment (#1249, 2026-10-07: Matthew Golden was counted taxi/$0 and arrived active at $5,000).
 *                   An arriving player now always counts as active and at full salary; see taxi_arrivals.
 * @param taxiStep         The post-trade taxi step of the engine that will EXECUTE this trade, or null when it has none.
 *                   `{ pids: [...] }` = the two-team War Room accept: after MFL executes, it moves exactly these
 *                   players (the offer's taxi-flagged ones) to the receiver's taxi squad, verifies each against MFL's
 *                   rosters, and on any failure marks the trade needs-review and DMs the receiving owner and the
 *                   commissioner (#1187). Only a player in `pids` can have his move credited against the roster
 *                   MAXIMUM. null/omitted (the 3-way engine, Send-time checks with no flags) = no taxi step: every
 *                   arriving player counts as active and any room must be made first (Keith 2026-10-07). The cap and
 *                   the QB limit never credit a taxi move.
 * @param taxiDestinations { pid -> { eligible, reason, text } } from trade_taxi_destination.js (read live by the caller).
 * @param seasonWindow     trade_season_window.js tradeSeasonWindow(): WHICH limits apply right now (Keith 2026-10-08) —
 *                   offseason: none · FA Auction → contract deadline: maximum 35 · in-season: maximum 30 + five active QBs.
 *                   With a window the maximum is CANON's for the phase, never MFL's rosterSize. A phase that can't be
 *                   established fails closed only where it matters (a trade within every possible limit is fine; one
 *                   that would break a possible limit is "unavailable"). Omitted = MFL's rosterSize + the QB limit (strict).
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
export function evaluateTradeCompliance({ league, rosters, salaries, adjustments, movements, extensionSalary, taxiFlags, players, extensionRequests, conditionalDrops, taxiDestinations, taxiStep, seasonWindow }) {
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
    roster_limit: { status: "unavailable", max: null, rows: [], violations: [], executable: false,
      message: "We couldn't verify the roster limit for this trade right now." },
    qb_limit: { status: "unavailable", max: ACTIVE_QB_MAX, rows: [], violations: [], executable: false,
      message: "We couldn't verify the active-QB count for this trade right now." },
  });
  const L = readLeague(league); if (!L.ok) return empty(L);
  const A = readAdjustments(adjustments); if (!A.ok) return empty(A);
  const mv = arr(movements).filter(isObj).map((m) => ({ from: pad4(m.from), to: pad4(m.to), tokens: arr(m.tokens).map(s).filter(Boolean), extraCap: Math.max(0, num(m.capDollars) || 0) }));
  const parts = new Set(); for (const m of mv) { if (m.from) parts.add(m.from); if (m.to) parts.add(m.to); }
  if (!parts.size || mv.some((m) => !m.from || !m.to || m.from === m.to)) return empty(unavailable("movements_malformed"));
  const O = readSalaryOverlay(salaries); if (!O.ok) return empty(O);
  const R = readRosters(rosters, O, parts); if (!R.ok) return empty(R);

  const ext = isObj(extensionSalary) ? extensionSalary : {};
  void taxiFlags;   // ignored: see the @param note above
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

  const positions = readPlayerPositions(players); // null = lineup check "unavailable"; QB gate fails closed
  const playerNames = readPlayerNames(players);
  const isQb = (pid) => !!positions && s(positions[pid]).toUpperCase() === "QB";
  const postTradeRoster = {};
  for (const fid of parts) postTradeRoster[fid] = [];

  const state = {};
  for (const fid of parts) {
    let used = A.byFranchise[fid] || 0, active = 0, loadedBefore = 0, taxiCount = 0, activeQbs = 0;
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
      if (p.taxi) { taxiCount += 1; continue; }
      used += currentCapHit(p);
      if (!p.ir) { active += 1; if (isQb(pid)) activeQbs += 1; }
    }
    state[fid] = { before: used, after: used, activeBefore: active, activeAfter: active, sends: 0, receives: 0, capOut: 0, capIn: 0, loadedBefore, loadedAfter: loadedBefore, taxiArrivals: [],
      taxiBefore: taxiCount, taxiAfter: taxiCount, qbBefore: activeQbs, qbAfter: activeQbs };
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
        send.after -= currentCapHit(p); if (!p.taxi && !p.ir) { send.activeAfter -= 1; if (isQb(tok)) send.qbAfter -= 1; } if (p.taxi) send.taxiAfter -= 1; send.sends += 1;
        // The sender always loses whatever contract they CURRENTLY hold -- extended or
        // not, they're giving that contract up, full stop. (Already resolved/flagged in
        // the per-franchise scan above, since m.from is always a participant scanned
        // there -- resolving again here just reuses the same deterministic function, with
        // no p.unknown shortcut, matching the scan above.)
        const sentLoaded = resolveLoadedStatus(p.contractStatus, p.contractInfo);
        if (sentLoaded.resolved && sentLoaded.loaded) send.loadedAfter -= 1;
        postTradeRoster[m.from] = postTradeRoster[m.from].filter((r) => r.id !== tok);

        // Every traded player ARRIVES on the receiver's active roster -- MFL never carries taxi (or IR)
        // status through a trade -- so he counts as active and at his full salary until a later move
        // is CONFIRMED on MFL. Nothing here may assume that move will happen (2026-10-07, #1249).
        const recvSalary = Number.isFinite(num(ext[tok])) ? Math.round(num(ext[tok])) : p.salary;
        if (!Number.isFinite(recvSalary)) return empty(unavailable("roster_salary_unresolved", m.from));
        const land = { ...p, salary: recvSalary, ir: false, taxi: false };
        const recv = state[m.to];
        recv.after += currentCapHit(land); recv.activeAfter += 1; recv.receives += 1; if (isQb(tok)) recv.qbAfter += 1;
        if (p.taxi) recv.taxiArrivals.push(tok);
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
  // ── Valid taxi destinations (Keith 2026-10-07) ────────────────────────────────────────────────
  // A player coming off the other team's taxi squad lands ACTIVE on MFL. For the roster MAXIMUM only, his
  // later taxi move is credited when ALL hold: the engine executing this trade has a verified taxi step
  // that will move HIM (taxiStep.pids — the two-team War Room accept; a 3-way has none), the caller proved
  // he is taxi-eligible for the receiver right now (taxiDestinations), and the receiver's taxi squad has
  // room after the trade. The cap rows, the actual counts and the QB limit never credit it.
  const dests = isObj(taxiDestinations) ? taxiDestinations : null;
  const stepPids = taxiStep && Array.isArray(taxiStep.pids) ? new Set(taxiStep.pids.map((x) => s(x).replace(/\D/g, "")).filter(Boolean)) : null;
  const nm = (pid) => playerNames[pid] || `player ${pid}`;
  for (const fid of parts) {
    const st = state[fid];
    st.taxiMoves = []; st.taxiNotCredited = [];
    let room = L.taxiMax == null ? null : L.taxiMax - st.taxiAfter;
    for (const pid of st.taxiArrivals) {
      const miss = (reason, text) => st.taxiNotCredited.push({ player_id: pid, player_name: nm(pid), reason, text });
      if (!stepPids) { miss("no_taxi_step", parts.size > 2 ? "a 3-way trade has no step that moves him to the taxi squad afterward" : "nothing in this trade moves him to the taxi squad afterward"); continue; }
      if (!stepPids.has(pid)) { miss("not_sent_to_taxi", "the offer doesn't send him to the taxi squad"); continue; }
      const d = dests && dests[pid];
      if (!d) { miss("eligibility_not_checked", "his taxi eligibility couldn't be checked"); continue; }
      if (!d.eligible) { miss(d.reason || "not_eligible", d.text || "he isn't taxi-eligible for this team"); continue; }
      if (room == null) { miss("taxi_limit_unknown", "we couldn't read the taxi squad limit"); continue; }
      if (room <= 0) { miss("no_taxi_space", `${name(fid)}'s taxi squad would be full (${L.taxiMax} of ${L.taxiMax})`); continue; }
      room -= 1; st.taxiMoves.push(pid);
    }
    st.activeAfterTaxi = st.activeAfter - st.taxiMoves.length;
  }
  const listNames = (pids) => { const n = pids.map(nm); return n.length <= 1 ? (n[0] || "") : `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`; };

  // ── Roster maximum + five active QBs, in the SEASON WINDOW (trade_season_window.js; Keith 2026-10-08) ──
  // A window whose phase isn't one of the known ones, or an "unknown" one that lists no recognisable candidate, is treated as
  // "nothing is known" (every phase possible) — never as "no limit" (review 2026-10-09: no fail-open on a malformed window).
  const win = !isObj(seasonWindow) ? null
    : (PHASES[seasonWindow.phase] && seasonWindow.phase !== "unknown") ? seasonWindow
    : { ...seasonWindow, phase: "unknown", roster_max: null, qb_limit: null,
        candidates: (Array.isArray(seasonWindow.candidates) ? seasonWindow.candidates : []).filter((p) => PHASES[p]).length
          ? seasonWindow.candidates.filter((p) => PHASES[p]) : Object.keys(PHASES),
        reason: seasonWindow.reason || (seasonWindow.phase === "unknown" ? "" : "window_malformed") };
  const minApplies = !win || win.phase !== "offseason";   // no roster minimum in the offseason either
  // why the phase is unknown, in words, plus the commissioner's fix when it's a league-calendar input (2026-10-09)
  const whyUnknown = win && win.phase === "unknown" ? (win.reason_text || win.reason || "the league calendar doesn't say") : "";
  const fixUnknown = win && win.phase === "unknown" && win.calendar_input_missing ? ` ${CALENDAR_FIX_TEXT}` : "";
  const rosterPass = (max) => {
    const rows = [], warns = [], viol = [];
    for (const fid of [...parts].sort()) {
      const st = state[fid];
      const projected = st.activeAfterTaxi;
      let status = "within";
      if (minApplies && projected < ROSTER_MIN) status = "below_min"; else if (max != null && projected > max) status = "above_max";
      const row = { franchise_id: fid, franchise_name: name(fid), active_before: st.activeBefore, active_after: st.activeAfter, active_after_taxi: projected,
        taxi_moves: st.taxiMoves.map((pid) => ({ player_id: pid, player_name: nm(pid) })), taxi_not_credited: st.taxiNotCredited, taxi_arrivals: st.taxiArrivals.slice(),
        min: minApplies ? ROSTER_MIN : null, max, status, moves_needed: max != null ? Math.max(0, projected - max) : null };
      rows.push(row);
      if (status === "above_max") {
        const n = projected - max;
        const moved = st.taxiMoves.length ? ` and ${projected} once ${listNames(st.taxiMoves)} ${st.taxiMoves.length === 1 ? "is" : "are"} moved to its taxi squad` : "";
        const notCounted = st.taxiNotCredited.map((x) => ` ${x.player_name} can't count as a taxi move: ${x.text}.`).join("");
        viol.push({ ...row, message: `${name(fid)} would have ${st.activeAfter} active players right after this trade${moved} — the maximum is ${max}. ${name(fid)} needs ${n} more roster spot${n === 1 ? "" : "s"}: make ${n} legal roster move${n === 1 ? "" : "s"} first (for example, move an eligible injured player to IR), or revise the offer.${notCounted}` });
      }
      if (status === "below_min") warns.push({ ...row, message: `${name(fid)} would have ${projected} active players after this trade (minimum ${ROSTER_MIN}), so an add may be needed afterward.` });
    }
    return { rows, warns, viol };
  };
  const winOut = win ? { phase: win.phase, candidates: win.candidates || [], boundaries: win.boundaries || {}, reason: win.reason || "", reason_text: win.reason_text || "", calendar_input_missing: !!win.calendar_input_missing }
    : { phase: "not_supplied", candidates: [], boundaries: {}, reason: "mfl_roster_size" };
  // rosterDecision: { kind: "ok"|"blocked"|"unavailable"|"not_applicable", max, pass, note }
  let rosterDecision;
  if (!win) {
    const max = L.rosterMax != null ? L.rosterMax : null;
    const pass = rosterPass(max);
    rosterDecision = { kind: max == null ? "unavailable" : pass.viol.length ? "blocked" : "ok", max, pass, note: "" };
  } else if (win.phase !== "unknown") {
    const max = PHASES[win.phase].roster_max;   // canon's number for the phase (never a value carried on the window object)
    const pass = rosterPass(max);
    rosterDecision = { kind: max == null ? "not_applicable" : pass.viol.length ? "blocked" : "ok", max, pass, note: "" };
  } else {
    const { strict, lenient } = candidateRosterMaxes(win);
    const pStrict = rosterPass(strict);
    if (!pStrict.viol.length) rosterDecision = { kind: "ok", max: strict, pass: pStrict, note: "fits_every_possible_limit" };
    else if (lenient != null && rosterPass(lenient).viol.length) rosterDecision = { kind: "blocked", max: lenient, pass: rosterPass(lenient), note: "over_every_possible_limit" };
    else rosterDecision = { kind: "unavailable", max: strict, pass: pStrict, note: "depends_on_unknown_phase" };
  }
  const rosterRows = rosterDecision.pass.rows, warnings = rosterDecision.pass.warns, limitViolations = rosterDecision.kind === "blocked" ? rosterDecision.pass.viol : [];
  // the five-QB trade limit: true | false | "depends" (an unknown phase where only some candidates are in-season)
  const qbApplies = !win ? true : win.phase !== "unknown" ? PHASES[win.phase].qb_limit
    : (win.candidates || []).every((p) => PHASES[p].qb_limit) ? true : (win.candidates || []).some((p) => PHASES[p].qb_limit) ? "depends" : false;
  const qbRows = [], qbViolations = [];
  if (positions) {
    for (const fid of [...parts].sort()) {
      const st = state[fid];
      // ACTUAL count right after MFL executes (Keith 2026-10-07): an arriving QB is active — even one who could
      // later move to taxi. QBs MFL already shows on taxi or IR don't count.
      const row = { franchise_id: fid, franchise_name: name(fid), active_qbs_before: st.qbBefore, active_qbs_after: st.qbAfter, max: ACTIVE_QB_MAX };
      qbRows.push(row);
      if (st.qbAfter > ACTIVE_QB_MAX) {
        qbViolations.push({ ...row, message: `${name(fid)} would have ${st.qbAfter} QBs on the active roster right after this trade — the maximum is ${ACTIVE_QB_MAX}. QBs MFL already shows on taxi or IR don't count; an arriving QB counts as active. ${name(fid)} must first make a legal QB move — move one of its current QBs to IR if MFL lists him on IR, move an eligible current QB to the taxi squad, or drop one — or the offer must be revised. A move made for this stands whether or not the trade happens.` });
      }
    }
  }
  const rosterStatus = rosterDecision.kind === "unavailable" && !win ? "unavailable" : warnings.length ? "warn" : "ok";


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
      // The full menu the owner can pick FROM: every one of the franchise's OWN roster players
      // that is currently a loaded contract and isn't already being sent away in this trade --
      // the same two checks `picks` validates a selection against, just run over the whole
      // roster instead of just what was selected. Lets a client render a real picker without
      // re-deriving loaded-contract classification itself (which is exactly the eyeballing gap
      // that caused the Hammer Times miss -- see Addison/Montgomery in the investigation).
      const roster = R.byFranchise[fid] || {};
      const candidates = Object.keys(roster).filter((pid) => {
        if (sentTokensByFranchise[fid].has(pid)) return false;
        const lst = resolveLoadedStatus(roster[pid].contractStatus, roster[pid].contractInfo);
        return lst.resolved && lst.loaded;
      }).sort();
      dropReqs.push({ franchise_id: fid, franchise_name: name(fid), loaded_before: st.loadedBefore, projected, required_drops: required, selected: picks, valid_count: validCount, satisfied, candidates });
      if (!satisfied) {
        // RULING (Keith, 2026-10-01): REPLACES the conditional-drop-picker wording from the
        // 2026-09-29 ruling -- no call site passes a conditionalDrops selection anymore (the
        // picker UI is gone), so this is now always a hard block, never a "pick these to fix
        // it" prompt. The message names the team, the projected count, and the limit, and
        // tells the owner to revise the offer or make a separate roster move first -- it never
        // mentions selecting or dropping a specific player.
        loadedViolations.push({ franchise_id: fid, franchise_name: name(fid), projected, max: LOADED_CONTRACT_MAX, required_drops: required, valid_drops: validCount,
          message: `${name(fid)} would have ${projected} loaded contracts (including IR) after this trade — the limit is ${LOADED_CONTRACT_MAX}. Revise the offer, or make a separate roster move first, then try again.` });
      }
    }
  }

  // A VALID, currently-selected conditional drop is also gone from the roster the lineup check
  // sees -- "Show ... an updated structural lineup warning before that owner confirms" (Keith's
  // ruling, 2026-09-29). Only a genuinely valid selection counts (an invalid one never removes
  // the player -- the drop hasn't actually happened, and won't, until it's valid).
  const postTradeRosterAfterDrops = postTradeRoster;
  if (positions && dropReqs.length) {
    for (const req of dropReqs) {
      const dropIds = new Set(req.selected.filter((x) => x.valid).map((x) => x.player_id));
      if (dropIds.size) postTradeRosterAfterDrops[req.franchise_id] = postTradeRosterAfterDrops[req.franchise_id].filter((r) => !dropIds.has(r.id));
    }
  }
  const lineup = evaluateLineupFeasibility({
    franchises: Object.fromEntries([...parts].map((fid) => [fid, { name: name(fid), roster: positions ? postTradeRosterAfterDrops[fid] : null }])),
    expectedFids: [...parts],
  });

  return {
    participants: [...parts].sort(),
    cap: violations.length
      ? { status: "blocked", reason: "over_cap", cap_dollars: L.cap, rows: capRows, violations, message: violations.map((v) => v.message).join(" ") }
      : { status: "ok", reason: "", cap_dollars: L.cap, rows: capRows, violations: [], message: "Every team stays under the salary cap." },
    // The 27 minimum stays a heads-up (Keith 2026-10-07). The MAXIMUM is the hard roster_limit gate below.
    roster: {
      status: rosterStatus, advisory: true, rows: rosterRows, warnings,
      message: rosterStatus === "unavailable" ? "We couldn't confirm the roster limit for this trade right now."
        : warnings.length ? warnings.map((w) => w.message).join(" ") + " The minimum is a heads-up, not a block."
        : !minApplies ? "There's no roster minimum in the offseason."
        : "Every team stays at or above the roster minimum.",
    },
    // HARD (Keith 2026-10-07): no War Room accept while any team would be over the maximum after the arriving-taxi moves
    // its OWN verified taxi step will make (two-team accept only; see taxiStep). Send only warns. The maximum is the
    // SEASON WINDOW's (Keith 2026-10-08): none in the offseason, 35 from the FA Auction to the contract deadline, 30 in-season.
    roster_limit: rosterDecision.kind === "not_applicable"
      ? { status: "not_applicable", max: null, rows: rosterRows, violations: [], executable: true, window: winOut,
          message: "There's no roster limit in the offseason (before the FA Auction starts or after the season ends), so the maximum doesn't apply to this trade." }
      : rosterDecision.kind === "unavailable"
      ? { status: "unavailable", max: win ? rosterDecision.max : null, rows: rosterRows, violations: [], executable: false, window: winOut,
          message: win ? `We couldn't confirm which roster limit applies right now: ${whyUnknown}. This trade depends on it — a team would be over ${rosterDecision.max}.${fixUnknown}` : "We couldn't confirm the roster maximum for this trade right now." }
      : limitViolations.length
      ? { status: "blocked", max: rosterDecision.max, rows: rosterRows, violations: limitViolations, executable: false, window: winOut, message: limitViolations.map((v) => v.message).join(" ") }
      : { status: "ok", max: rosterDecision.max, rows: rosterRows, violations: [], executable: true, window: winOut,
          message: rosterRows.some((r) => r.taxi_moves.length)
            ? "Every team fits at or under the maximum once the arriving taxi player moves to its taxi squad. Until MFL confirms that move, the actual count is what MFL shows."
            : rosterDecision.note === "fits_every_possible_limit" ? "Every team stays within every roster limit that could apply right now."
            : "Every team stays at or under the roster maximum." },
    // HARD (Keith 2026-10-07): at Send and at Accept, no team may end up with more than 5 ACTIVE QBs — the actual count
    // right after MFL executes, no taxi credit. IN-SEASON only (Keith 2026-10-08): the season window's in_season phase.
    qb_limit: qbApplies === false
      ? { status: "not_applicable", max: ACTIVE_QB_MAX, rows: qbRows, violations: [], executable: true, window: winOut,
          message: "The five-active-QB trade limit applies in-season only (from the September contract deadline through the end of Week 17), so it doesn't apply to this trade." }
      : !positions
      ? { status: "unavailable", max: ACTIVE_QB_MAX, rows: [], violations: [], executable: false, window: winOut, message: "We couldn't verify the active-QB count for this trade right now." }
      : qbApplies === "depends" && qbViolations.length
      ? { status: "unavailable", max: ACTIVE_QB_MAX, rows: qbRows, violations: [], executable: false, window: winOut,
          message: `We couldn't confirm whether the in-season five-QB limit applies right now: ${whyUnknown}. This trade depends on it.${fixUnknown}` }
      : qbApplies === true && qbViolations.length
      ? { status: "blocked", max: ACTIVE_QB_MAX, rows: qbRows, violations: qbViolations, executable: false, window: winOut, message: qbViolations.map((v) => v.message).join(" ") }
      : { status: "ok", max: ACTIVE_QB_MAX, rows: qbRows, violations: [], executable: true, window: winOut, message: `Every team stays at or under ${ACTIVE_QB_MAX} active QBs.` },
    // status: "ok" (nobody over, before any drop) | "needs_drops" (someone's over, but every
    // over-limit franchise has a VALID, SUFFICIENT drop selection -- the trade is conditional but
    // may proceed) | "blocked" (someone's over and does NOT yet have a satisfied selection -- a
    // hard stop, exactly like before this ruling, just now escapable via drops rather than
    // permanent) | "unavailable".
    // `executable` (Keith's ruling, 2026-09-29): whether this verdict permits a REAL MFL write
    // right now -- see loadedContractsPermitsWrite() above. Exposed directly on the object (not
    // just as a function callers must remember to call) so a client can trust it without
    // re-deriving the rule, and so a future server-side call site that only checks `status` the
    // way the first PR's did can't silently regress -- every enforcement point in this codebase
    // is expected to gate on `.executable`, not on `status !== "blocked"`.
    loaded_contracts: loadedUnresolved
      ? { status: "unavailable", max: LOADED_CONTRACT_MAX, rows: [], violations: [], drop_requirements: [], executable: false, message: "We couldn't verify the loaded-contract count for this trade right now (at least one contract's structure isn't resolvable from live data)." }
      : loadedViolations.length
      ? { status: "blocked", max: LOADED_CONTRACT_MAX, rows: loadedRows, violations: loadedViolations, drop_requirements: dropReqs, executable: false, message: loadedViolations.map((v) => v.message).join(" ") }
      : dropReqs.length
      ? { status: "needs_drops", max: LOADED_CONTRACT_MAX, rows: loadedRows, violations: [], drop_requirements: dropReqs, executable: loadedContractsPermitsWrite("needs_drops"), message: dropReqs.map((d) => `${d.franchise_name}: ${d.required_drops} conditional drop${d.required_drops === 1 ? "" : "s"} selected and valid — but conditional-drop execution isn't available yet, so this can't proceed while ${d.franchise_name} would still be over.`).join(" ") }
      : { status: "ok", max: LOADED_CONTRACT_MAX, rows: loadedRows, violations: [], drop_requirements: [], executable: true, message: "Every team stays at or under the 5 loaded-contract limit." },
    lineup,
  };
}
