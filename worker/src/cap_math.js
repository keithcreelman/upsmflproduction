// cap_math.js — the ONE salary-cap calculation. The Front Office roster workbench (`/roster-workbench`, worker/src/index.js) and the Trade War
// Room's post-trade cap gate (worker/src/trade_cap_authority.js) both import these functions; there is no second copy of the formula.
//
//   used(franchise) = Σ currentCapHit(player) + Σ salaryAdjustments(franchise)
//   currentCapHit   = 0 for TAXI, 0 for a KNOWN-expired contract (years remaining ≤ 0), 50% for INJURED_RESERVE, else the salary MFL holds
//                     (the CURRENT-year amount — a loaded / front-loaded contract counts what it costs this year)
//   a contract MFL has said NOTHING about (`unknown`) still counts its salary: MFL has recorded a real salary; silence is not "expired"
//
// Unresolved data is reported, never guessed: a non-taxi player whose salary is blank (blank ≠ $0) and an adjustment row whose amount cannot be
// read are returned in `unresolved`. The Front Office shows the flag; the trade gate fails closed on it.
//
// Pure functions only.

export const IR_RELIEF_RATE = 0.5;

const s = (v) => String(v == null ? "" : v).trim();

/** Adjustment / money token → whole dollars. Same rules as the worker's parseMoneyTokenToDollars(raw, {assumeKIfNoUnit:false}); null = unreadable. */
export function parseCapDollars(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;
  const text = s(raw);
  if (!text) return null;
  const upper = text.toUpperCase().replace(/\s+/g, "");
  const match = upper.match(/^(-?\d+(?:\.\d+)?)([KM]?)$/);
  if (!match) {
    const cleaned = text.replace(/[^0-9.-]/g, "");
    if (!cleaned || cleaned === "-" || cleaned === ".") return null;
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const base = Number.parseFloat(match[1]);
  if (!Number.isFinite(base)) return null;
  if (match[2] === "K") return Math.round(base * 1000);
  if (match[2] === "M") return Math.round(base * 1000000);
  return Math.round(base);
}

/** A rostered player's salary → integer dollars, exactly as the Front Office reads it (parseInt); null when blank/unreadable. */
export function parseSalaryDollars(raw) {
  const t = s(raw);
  if (!t) return null;
  const n = Number.parseInt(t, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * The `salaries` export, read the way the Front Office reads it: only rows with contractYear > 0 (years REMAINING) count as an overlay on the
 * roster row. Returns { ok, byPlayer } or { ok:false } when the export is missing/malformed.
 */
export function readSalaryOverlay(res) {
  if (!res || !res.ok || !res.data || typeof res.data !== "object") return { ok: false, reason: "salaries_unavailable" };
  const root = res.data.salaries;
  if (!root || typeof root !== "object") return { ok: false, reason: "salaries_unavailable" };
  const unit = root.leagueUnit || root.leagueunit || {};
  let rows = unit.player || unit.players || [];
  if (!Array.isArray(rows)) rows = rows ? [rows] : [];
  const byPlayer = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const pid = s(row.id).replace(/\D/g, "");
    if (!pid || pid === "0000") continue;
    const cyRaw = s(row.contractYear);
    const cy = cyRaw ? Number.parseInt(cyRaw, 10) || 0 : 0;
    if (cy <= 0) continue;
    const salaryRaw = s(row.salary), statusRaw = s(row.contractStatus), infoRaw = s(row.contractInfo);
    if (!salaryRaw && !cyRaw && !statusRaw && !infoRaw) continue;
    byPlayer[pid] = { salary: salaryRaw ? parseSalaryDollars(salaryRaw) : null, contractYear: cy, contractStatus: statusRaw || null, contractInfo: infoRaw || null };
  }
  return { ok: true, byPlayer };
}

/**
 * One rostered player → the fields the cap rule needs. `rosterRow` is the MFL `rosters` export row; `overlay` the matching readSalaryOverlay entry
 * (salaries export wins where it has a row, exactly like the Front Office).
 */
export function derivePlayerCapFields(rosterRow, overlay) {
  const pid = s(rosterRow && (rosterRow.id || rosterRow.player_id)).replace(/\D/g, "");
  const status = s(rosterRow && rosterRow.status).toUpperCase();
  const blank = (v) => !v || v === "-";
  const yearsRaw = overlay && overlay.contractYear != null ? s(overlay.contractYear) : s(rosterRow && rosterRow.contractYear);
  const typeRaw = s(overlay && overlay.contractStatus) || s(rosterRow && rosterRow.contractStatus);
  const infoRaw = s(overlay && overlay.contractInfo) || s(rosterRow && rosterRow.contractInfo);
  const salary = overlay && overlay.salary != null ? overlay.salary : parseSalaryDollars(rosterRow && rosterRow.salary);
  return {
    pid, status,
    taxi: status.includes("TAXI"),
    ir: status.includes("INJURED"),
    salary, salaryResolved: salary != null,
    years: yearsRaw ? Math.max(0, Number.parseInt(yearsRaw, 10) || 0) : 0,
    unknown: blank(yearsRaw) && blank(typeRaw) && blank(infoRaw),
    // Preserved for the Trade War Room's loaded-contract gate (worker/src/
    // trade_cap_authority.js + worker/src/contract_classification.js) -- NOT used by
    // currentCapHit()/franchiseCapUsed() above, which only need status/salary/years.
    contractStatus: typeRaw || null,
    contractInfo: infoRaw || null,
  };
}

/** THE rule. `p` = { salary, years, taxi, ir, unknown } (salary null → treated as 0 here; callers check `salaryResolved` and report it). */
export function currentCapHit(p) {
  if (p.taxi) return 0;
  const amt = Number.isFinite(p.salary) ? p.salary : 0;
  if ((p.years | 0) <= 0 && !p.unknown) return 0;
  if (p.ir) return Math.round(amt * IR_RELIEF_RATE);
  return amt;
}

/** A franchise's cap used: Σ hit + adjustments, with every unresolved input named. */
export function franchiseCapUsed(players, adjustmentDollars) {
  let used = Number.isFinite(adjustmentDollars) ? adjustmentDollars : 0;
  const unresolved = [];
  for (const p of players) {
    if (!p.taxi && !p.salaryResolved) { unresolved.push({ player_id: p.pid, reason: "salary_blank" }); continue; }
    used += currentCapHit(p);
  }
  return { used, unresolved };
}
