// trade_cap_authority.js — the ONE post-trade cap / roster calculation, shared by the 2-way accept path,
// the 2-way preview, the 3-way accept + execute gates and the 3-way detail view.
//
// RULING (Keith, 2026-09-25): a trade must not execute if the authoritative post-trade calculation PROVES a
// participating franchise would exceed the salary cap; an unavailable or unresolved calculation fails closed.
// Roster counts stay ADVISORY: they are projected and flagged, never a block (MFL itself refuses a trade it
// won't take, and that refusal is passed through untouched).
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

export const ROSTER_MIN = 27;   // canon B1: MFL-enforced minimum (not exposed by the API)

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

/**
 * @param league,rosters,adjustments  raw export results {ok, data}
 * @param movements  [{from, to, tokens:[…MFL tokens: player id | FP_ | DP_ | BB_<dollars>], capDollars?}]
 *                   (cap money is read from BB_ tokens; `capDollars` adds to it, used by builders that carry cap apart)
 * @param extensionSalary  { playerId → current-year salary (dollars) AFTER an accepted pre-trade extension }
 * @param taxiFlags        { playerId → true } for players the offer says stay on taxi after the trade
 */
export function evaluateTradeCompliance({ league, rosters, salaries, adjustments, movements, extensionSalary, taxiFlags }) {
  const empty = (why) => ({
    participants: [],
    cap: { status: "unavailable", reason: why.reason, cap_dollars: null, rows: [], violations: [],
      message: "We couldn't verify the salary cap for this trade right now." },
    roster: { status: "unavailable", advisory: true, rows: [], warnings: [],
      message: "We couldn't check the roster counts for this trade right now." },
  });
  const L = readLeague(league); if (!L.ok) return empty(L);
  const A = readAdjustments(adjustments); if (!A.ok) return empty(A);
  const mv = arr(movements).filter(isObj).map((m) => ({ from: pad4(m.from), to: pad4(m.to), tokens: arr(m.tokens).map(s).filter(Boolean), extraCap: Math.max(0, num(m.capDollars) || 0) }));
  const parts = new Set(); for (const m of mv) { if (m.from) parts.add(m.from); if (m.to) parts.add(m.to); }
  if (!parts.size || mv.some((m) => !m.from || !m.to || m.from === m.to)) return empty(unavailable("movements_malformed"));
  const O = readSalaryOverlay(salaries); if (!O.ok) return empty(O);
  const R = readRosters(rosters, O, parts); if (!R.ok) return empty(R);

  const ext = isObj(extensionSalary) ? extensionSalary : {}, taxi = isObj(taxiFlags) ? taxiFlags : {};
  const state = {};
  for (const fid of parts) {
    let used = A.byFranchise[fid] || 0, active = 0;
    for (const p of Object.values(R.byFranchise[fid])) {
      if (!p.taxi && !p.salaryResolved) return empty(unavailable("roster_salary_unresolved", fid));   // MFL blank ≠ $0
      if (p.taxi) continue;
      used += currentCapHit(p);
      if (!p.ir) active += 1;
    }
    state[fid] = { before: used, after: used, activeBefore: active, activeAfter: active, sends: 0, receives: 0, capOut: 0, capIn: 0 };
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
        const carriesTaxi = p.taxi && taxi[tok] === true;
        const recvSalary = Number.isFinite(num(ext[tok])) ? Math.round(num(ext[tok])) : p.salary;
        if (!Number.isFinite(recvSalary)) return empty(unavailable("roster_salary_unresolved", m.from));
        const land = { ...p, salary: recvSalary, ir: false, taxi: carriesTaxi };
        const recv = state[m.to];
        recv.after += currentCapHit(land); if (!carriesTaxi) recv.activeAfter += 1; recv.receives += 1;
      }
    }
    if (capDollars > 0) { state[m.from].after += capDollars; state[m.from].capOut += capDollars; state[m.to].after -= capDollars; state[m.to].capIn += capDollars; }
  }

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
  };
}
