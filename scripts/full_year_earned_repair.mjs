#!/usr/bin/env node
// Sub-$5K earned clean-up — a row-level dry run, then (only when told to) ONE audited, idempotent repair per row through the worker.
//
// THE PROBLEM. Until 2026-09-26 `_computeDropPenalty` hung a per-week fraction on every sub-$5K contract ($59 = 1/17 of $1,000, $118 = 2/17,
// $1,118 = a prior $1K year + 118) although the dedicated sub-$5K penalty rule never uses "earned", and stored it in ups_drop_events.earned_to_date.
// THE RULINGS (Keith 2026-09-26). Three repairs, each changing EXACTLY the columns it names and PROVING the penalty, dead money and cap effect identical:
//   clear_full_year_earned            the "$1K Per Yr" class (worker/src/fcfs_contract.js `classifyFullYearRule`: EVERY contract year exactly $1,000) — earned → NULL.
//                                     Planned only when the stored penalty / exempt flag / posted amount RECONCILE with the canonical flat rule (else HELD — fail closed).
//   reconcile_legacy_guarantee_basis  the approved legacy rows on `tcv_under_5k_guarantee` (their penalty was guarantee − earned) — earned → NULL and basis →
//                                     `full_year_1k_contract`, ONLY when the canonical $1K/year rule reproduces the stored penalty exactly (else HELD, earned NOT cleared).
//   clear_ww_earned_na                canon §C3 "WW under $4K — earned n/a", the six approved one-year pure-WW rows — earned → NULL, basis → `ww_under_5k_earned_na`.
// The plain class-1 rows are approved BY CLASS PROOF, and the reviewer may EXCLUDE any row by id (`--exclude 149,150` → `hold_excluded`, never planned).
// TCV ≤ $4K is NOT a proxy for any of these classes (it only SCOPES the candidates; a row the contract text proves into a class is a candidate whatever its stored pre_drop_tcv). Every other candidate row (the nine non-WW $2K–$4K deals) is HELD, unchanged. A row that proves into a class
// but is not on Keith's approved list is HELD as `hold_not_approved`.
//
//   node scripts/full_year_earned_repair.mjs                          # DRY RUN (default): classify every candidate row; writes nothing anywhere
//   node scripts/full_year_earned_repair.mjs --verify [--against <before_state.json>]   # read-only: nothing left to change (+ penalties/dead money/cap unchanged)
//   UPS_COMMISH_API_KEY=… node scripts/full_year_earned_repair.mjs --server-dry-run --season 2026   # asks the WORKER to re-prove every row (dry_run:true) — writes nothing
//   UPS_COMMISH_API_KEY=… node scripts/full_year_earned_repair.mjs --apply --yes --season 2026   # EXPLICIT write mode
//   options: --out DIR   --cache DIR   --base URL   --offline   --exclude ID,ID   --plan FILE (REQUIRED with --apply: the reviewed plan.json the write is bound to)
//
// What --apply sends: POST /admin/drops/full-year-repair { kind, id, expect } for every row PROVEN and approved — nothing else. The worker re-proves each row from
// its stored pre-drop contract, refuses a row that changed since the dry run, changes exactly the planned columns, asserts every other column is byte-identical, and
// audits before/after/proof/derivation to ups_contract_gate_audit. A second run plans nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFullYearRule, contractClass, parseContractTokens, SUB_FIVE_K_BASES, REPRICE_COLUMNS, EARNED_REPAIR_COLUMNS, PROTECTED_FINANCIAL_COLUMNS, LEGACY_GUARANTEE_BASIS,
  planFullYearClearRepair, planWwEarnedNaRepair, planLegacyGuaranteeRepair } from "../worker/src/fcfs_contract.js";
import { productionIo, CURRENT_SEASON, LEAGUE_ID, DEFAULT_BASE } from "./fcfs_contract_backfill.mjs";

const s = (v) => String(v == null ? "" : v).trim();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

export const DROP_COLS = ["id", "season", "league_id", "player_id", "player_name", "franchise_id", "franchise_name", "dropped_at_unix", "dropped_at_iso", "pre_drop_contract_status", "pre_drop_salary",
  "pre_drop_contract_year", "pre_drop_contract_length", "pre_drop_contract_info", "pre_drop_tcv", "pre_drop_aav", "pre_drop_years_remaining", "pre_drop_taxi", "earned_to_date", "guaranteed_amount",
  "penalty_amount", "penalty_basis", "penalty_exempt", "penalty_exempt_reason", "posted_to_mfl", "posted_amount", "applies_to_season", "discord_posted", "notes"];
export const QUERIES = Object.freeze({
  // EVERY column (SELECT *): the unchanged-columns proof compares the whole row, not a hand-picked list
  drops: `SELECT * FROM ups_drop_events WHERE season='${CURRENT_SEASON}' AND league_id='${LEAGUE_ID}' ORDER BY id`,
  fcfsAdds: `SELECT player_id, franchise_id, acquired_at_unix FROM ups_add_events WHERE season='${CURRENT_SEASON}' AND source='fcfs'`,
});

/** Keith's approvals (2026-09-26), by production drop-event id. The 97 plain "$1K Per Yr" rows are approved BY CLASS PROOF; these two lists are approved BY NAME. */
export const APPROVED = Object.freeze({
  excluded_ids: Object.freeze([]),                                                     // rows the reviewer keeps out of the plan (the CLI's --exclude adds to this)
  legacy_guarantee_ids: Object.freeze([32, 33, 40]),                                 // KeAndre Lambert-Smith, Konata Mumpfield, Ja'Tavion Sanders — `tcv_under_5k_guarantee`
  ww_earned_na_ids: Object.freeze([116, 117, 122, 131, 136, 140, 152]),               // Wilson, Nailor, Brooks, C. Johnson, Ezeiruaku, Wentz, Ertz (2026-09-27) — canon §C3
});
export const REPAIR_KINDS = Object.freeze(Object.keys(EARNED_REPAIR_COLUMNS));

/** One row of the dry run: the contract, the class proof, the current and proposed earned, and everything that must NOT change. */
export function analyzeRow(r, fcfsAdds, adjustments, approved = APPROVED) {
  const tk = parseContractTokens(r.pre_drop_contract_info, r.pre_drop_salary);
  const c = { salary: num(r.pre_drop_salary), tcv: tk.tcv, cl: tk.cl, aav: tk.aav, aavTiers: tk.aavTiers, yearSalaries: tk.yearSalaries };
  const proof = classifyFullYearRule(c);
  const klass = contractClass(c, r.pre_drop_contract_status);
  const fcfsOrigin = fcfsAdds.some((a) => s(a.player_id) === s(r.player_id) && s(a.franchise_id) === s(r.franchise_id) && num(a.acquired_at_unix) <= num(r.dropped_at_unix));
  const dedicated = SUB_FIVE_K_BASES.has(s(r.penalty_basis)) && num(r.pre_drop_taxi) !== 1;
  const member = proof.member && dedicated;
  const wwUnder4k = klass === "sub_5k_one_year_above_1k" && /(^|-)WW$/i.test(s(r.pre_drop_contract_status));
  const posted = num(r.posted_to_mfl) === 1;
  let mflAdj = null;
  if (posted && adjustments) mflAdj = adjustments.filter((x) => s(x.franchise_id) === s(r.franchise_id) && num(x.amount) === num(r.posted_amount) && s(x.description).includes(s(r.player_name).split(",")[0].trim())).length;

  // ── decide: which repair (if any) does this row PROVE into, and is it approved? Every plan is the SAME pure function the worker route re-runs. ──
  const isLegacy = s(r.penalty_basis) === LEGACY_GUARANTEE_BASIS;
  let kind = null, plan = null, action, holdReason = null, holdDetail = null;
  const excluded = (approved.excluded_ids || []).map(Number).includes(Number(r.id));
  if (r.earned_to_date == null) action = "none_already_null";
  else if (excluded) { action = "hold_excluded"; holdReason = "excluded_by_reviewer"; }
  else if (isLegacy) {
    kind = "reconcile_legacy_guarantee_basis"; plan = planLegacyGuaranteeRepair(r);
    if (plan.ok) action = approved.legacy_guarantee_ids.includes(Number(r.id)) ? kind : "hold_not_approved";
    else action = /^hold_conflict|^conflict/.test(plan.result) ? "hold_conflict" : "hold_for_ruling";
  } else {
    const clear = planFullYearClearRepair(r);
    if (clear.ok) { kind = "clear_full_year_earned"; plan = clear; action = kind; }
    else if (clear.result === "conflict_financials_would_change") { kind = "clear_full_year_earned"; plan = clear; action = "hold_conflict"; }
    else {
      const ww = planWwEarnedNaRepair(r);
      if (ww.ok) { kind = "clear_ww_earned_na"; plan = ww; action = approved.ww_earned_na_ids.includes(Number(r.id)) ? kind : "hold_not_approved"; }
      else if (ww.result === "conflict_financials_would_change") { kind = "clear_ww_earned_na"; plan = ww; action = "hold_conflict"; }
      else action = "hold_for_ruling";
    }
  }
  if (action === "hold_conflict") { holdReason = "financials_would_change"; holdDetail = plan.detail || plan.result; }
  else if (action === "hold_not_approved") holdReason = kind === "reconcile_legacy_guarantee_basis" ? "legacy_row_not_on_the_approved_list" : "ww_row_not_on_the_approved_list";
  else if (action === "hold_for_ruling") { holdReason = kind === "reconcile_legacy_guarantee_basis" ? "legacy_row_not_provable" : (proof.member ? "taxi_or_non_dedicated_penalty_basis" : "not_1k_per_year"); holdDetail = (plan && (plan.detail || plan.result)) || null; }
  const planned = kind !== null && action === kind;
  // the after-state, simulated: apply the plan's columns to a copy of the row and compare the protected financial columns
  const after = planned ? { ...r, ...plan.set } : r;
  const finUnchanged = PROTECTED_FINANCIAL_COLUMNS.every((k) => String(r[k] == null ? "" : r[k]) === String(after[k] == null ? "" : after[k]) && (r[k] == null) === (after[k] == null));
  const deriv = planned ? plan.derivation : null;
  return {
    drop_event_id: r.id, player_id: r.player_id, player_name: r.player_name, franchise_id: r.franchise_id, franchise_name: r.franchise_name,
    contract_status: r.pre_drop_contract_status, contract_info: r.pre_drop_contract_info, salary: num(r.pre_drop_salary), tcv: tk.tcv, aav: tk.aav, cl: tk.cl, years_remaining: num(r.pre_drop_years_remaining),
    dropped_at: r.dropped_at_iso, class: klass, fcfs_origin: fcfsOrigin, penalty_basis: r.penalty_basis,
    in_full_year_class: member, class_proof: proof.member ? { tcv_equals_1k_times_cl: true, every_year_1k: true, salary_1k: true, aav_1k: true, cl: tk.cl, tcv: tk.tcv, years: proof.proof.years } : { reasons: proof.reasons },
    captured_only_by_tcv_under_5k: !proof.member && num(r.pre_drop_tcv) > 0 && num(r.pre_drop_tcv) <= 4000,
    canon_earned_na_for_ww_under_4k: wwUnder4k,
    repair_kind: planned ? kind : null, approved: planned ? true : (action === "hold_not_approved" ? false : null),
    earned_now: r.earned_to_date, earned_proposed: planned ? null : r.earned_to_date,
    penalty_basis_proposed: planned ? (plan.after.penalty_basis !== undefined ? plan.after.penalty_basis : r.penalty_basis) : r.penalty_basis,
    penalty_amount: r.penalty_amount, dead_money: r.penalty_amount, guaranteed_amount: r.guaranteed_amount, penalty_exempt: r.penalty_exempt,
    posted_to_mfl: r.posted_to_mfl, posted_amount: r.posted_amount, cap_adjustment_posted: posted ? num(r.posted_amount) : 0, mfl_adjustment_rows_matching: mflAdj, applies_to_season: r.applies_to_season,
    // the financial reconciliation: what the canonical rule computes vs what is stored, and proof that nothing financial moves
    computed_penalty: deriv ? deriv.computed_penalty : null,
    // (before from the STORED row, after from the row with the plan's columns APPLIED — a plan that touched a financial column would show here, independent of its own derivation)
    financials: planned ? { penalty_before: num(r.penalty_amount), penalty_after: num(after.penalty_amount), dead_money_before: num(r.penalty_amount), dead_money_after: num(after.penalty_amount),
      posted_cap_before: { posted_to_mfl: num(r.posted_to_mfl), posted_amount: r.posted_amount == null ? null : num(r.posted_amount), applies_to_season: r.applies_to_season == null ? null : num(r.applies_to_season) },
      posted_cap_after: { posted_to_mfl: num(after.posted_to_mfl), posted_amount: after.posted_amount == null ? null : num(after.posted_amount), applies_to_season: after.applies_to_season == null ? null : num(after.applies_to_season) },
      stored_penalty_equals_canonical: num(r.penalty_amount) === num(deriv.computed_penalty), protected_columns_identical: finUnchanged, mfl_financial_write_proposed: false } : null,
    hold_reason: holdReason, hold_detail: holdDetail,
    action, changes: planned ? Object.keys(plan.set) : [],
    before: planned ? plan.before : null, after: planned ? plan.after : null,
    derivation: deriv,
    expect: planned ? { earned_to_date: r.earned_to_date, penalty_amount: r.penalty_amount, penalty_basis: r.penalty_basis } : null,
  };
}

export function buildAnalysis(ds, { approved = APPROVED, asOfUnix = null } = {}) {
  const fcfsAdds = ds.fcfsAdds || [];
  // (the TCV ≤ $4K filter only SCOPES the candidates — it classifies nothing: every row below is proven into a class or held)
  const tokenClass = (r) => { const tk = parseContractTokens(r.pre_drop_contract_info, r.pre_drop_salary); return classifyFullYearRule({ salary: num(r.pre_drop_salary), tcv: tk.tcv, cl: tk.cl, aav: tk.aav, aavTiers: tk.aavTiers, yearSalaries: tk.yearSalaries }).member; };
  const isCandidate = (r) => r.earned_to_date != null && ((num(r.pre_drop_tcv) > 0 && num(r.pre_drop_tcv) <= 4000) || tokenClass(r));
  // an --as-of cutoff scopes the HISTORICAL repair to drops that happened at or before it (Keith 2026-09-27: a cutoff bound to one
  // explicit UTC timestamp, recorded before the final dry run, so continuing live waiver activity can never move a bound plan —
  // a row dropped AFTER the cutoff is reported here, then left for the deployed worker's own future-write path, never repaired by this tool).
  const afterCutoff = asOfUnix == null ? [] : ds.drops.filter((r) => isCandidate(r) && num(r.dropped_at_unix) > asOfUnix);
  const universe = (asOfUnix == null ? ds.drops : ds.drops.filter((r) => num(r.dropped_at_unix) <= asOfUnix)).filter(isCandidate);
  const rows = universe.map((r) => analyzeRow(r, fcfsAdds, ds.adjustments, approved));
  const by = (f) => rows.reduce((m, r) => { const k = f(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const members = rows.filter((r) => r.in_full_year_class), held = rows.filter((r) => /^hold/.test(r.action));   // (hold_for_ruling · hold_conflict · hold_not_approved · hold_excluded)
  const plan = rows.filter((r) => r.repair_kind).map((r) => ({ kind: r.repair_kind, id: r.drop_event_id, player_id: r.player_id, expect: r.expect, before: r.before, after: r.after, derivation: r.derivation }));
  const plannedRows = rows.filter((r) => r.repair_kind);
  const ids = (k) => plannedRows.filter((r) => r.repair_kind === k).map((r) => r.drop_event_id);
  const apprCheck = (list, k) => ({ approved: [...list], planned: ids(k), approved_but_not_planned: list.filter((i) => !ids(k).includes(i)), planned_but_not_approved: ids(k).filter((i) => !list.includes(i)) });
  return {
    rows, plan,
    summary: {
      as_of_unix: asOfUnix, as_of_utc: asOfUnix == null ? null : new Date(asOfUnix * 1000).toISOString(),
      excluded_by_cutoff: { total: afterCutoff.length, ids: afterCutoff.map((r) => r.id), dropped_at: Object.fromEntries(afterCutoff.map((r) => [r.id, r.dropped_at_iso])) },
      candidates: rows.length, in_full_year_class: members.length, held_for_ruling: held.length,
      by_action: by((r) => r.action), planned_by_kind: by((r) => r.repair_kind || "(none)"),
      by_class: by((r) => r.class), by_penalty_basis: by((r) => r.penalty_basis),
      fcfs_origin_rows: rows.filter((r) => r.fcfs_origin).length,
      class_members_with_earned_gt_0: members.filter((r) => num(r.earned_now) > 0).length, class_members_with_earned_0: members.filter((r) => num(r.earned_now) === 0).length,
      held_with_earned_gt_0: held.filter((r) => num(r.earned_now) > 0).length,
      captured_only_by_tcv_under_5k: rows.filter((r) => r.captured_only_by_tcv_under_5k).length,
      held_where_canon_says_earned_na_ww_under_4k: held.filter((r) => r.canon_earned_na_for_ww_under_4k).length,
      rows_with_penalty_gt_0: rows.filter((r) => num(r.penalty_amount) > 0).length, rows_posted_to_mfl: rows.filter((r) => num(r.posted_to_mfl) === 1).length,
      taxi_rows: rows.filter((r) => num(ds.drops.find((d) => d.id === r.drop_event_id).pre_drop_taxi) === 1).length,
      planned_actions: plan.length,
      approvals: { legacy_guarantee: apprCheck(approved.legacy_guarantee_ids, "reconcile_legacy_guarantee_basis"), ww_earned_na: apprCheck(approved.ww_earned_na_ids, "clear_ww_earned_na") },
      // for EVERY planned repair: penalty, dead money and the posted cap effect before == after, and no MFL write of any kind is proposed
      financial_reconciliation: {
        planned_rows: plannedRows.length,
        penalty_unchanged: plannedRows.every((r) => r.financials.penalty_before === r.financials.penalty_after),
        dead_money_unchanged: plannedRows.every((r) => r.financials.dead_money_before === r.financials.dead_money_after),
        posted_cap_unchanged: plannedRows.every((r) => JSON.stringify(r.financials.posted_cap_before) === JSON.stringify(r.financials.posted_cap_after)),
        protected_columns_identical: plannedRows.every((r) => r.financials.protected_columns_identical),
        every_stored_penalty_equals_the_canonical_computation: plannedRows.every((r) => r.financials.stored_penalty_equals_canonical),
        planned_with_penalty_gt_0: plannedRows.filter((r) => num(r.penalty_amount) > 0).length, planned_posted_to_mfl: plannedRows.filter((r) => num(r.posted_to_mfl) === 1).length,
        mfl_financial_writes_proposed: 0,
      },
    },
  };
}

export async function loadDataset(io, { cacheDir = "", offline = false } = {}) {
  const file = (n) => (cacheDir ? path.join(cacheDir, `${n}.json`) : "");
  const cached = (n) => { const p = file(n); return p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : undefined; };
  const store = (n, v) => { const p = file(n); if (p) { fs.mkdirSync(cacheDir, { recursive: true }); fs.writeFileSync(p, JSON.stringify(v)); } return v; };
  const ds = {};
  for (const k of Object.keys(QUERIES)) { const hit = cached(k); if (hit !== undefined) ds[k] = hit; else if (offline) throw new Error(`--offline: no cached dataset "${k}"`); else ds[k] = store(k, await io.d1(QUERIES[k])); }
  let adj = cached("mflSalaryAdjustments");
  if (adj === undefined && !offline) { try { adj = store("mflSalaryAdjustments", await io.mfl(CURRENT_SEASON, "salaryAdjustments")); } catch (_) { adj = null; } }
  ds.adjustments = adj ? asArr(adj.salaryAdjustments && adj.salaryAdjustments.salaryAdjustment) : null;
  return ds;
}

/**
 * Everything that must NOT change: EVERY column of EVERY row, except the ones a planned action is allowed to change.
 *  - a planned row may change ONLY the columns its repair names (`plannedAfter[id]`: earned_to_date, and for two kinds the basis) and must end on exactly those values;
 *  - a row that was `contract_unstamped_needs_review` and is now `ww_under_5k_exempt` (the Al-Shaair reprice) may change exactly REPRICE_COLUMNS.
 * Any other difference — a changed penalty, dead money, cap charge, posted amount, or an earned value on a row nobody planned — is a violation.
 * (`plannedIds` alone keeps the original contract: the planned rows may change earned_to_date only, and it must become NULL.)
 */
export function unchangedProof(beforeRows, afterRows, { plannedIds = null, plannedAfter = null } = {}) {
  const after = new Map(afterRows.map((r) => [r.id, r]));
  const planned = plannedIds ? new Set(plannedIds) : null;
  const expectedAfter = (id) => (plannedAfter && plannedAfter[id]) || { earned_to_date: null };
  const violations = [];
  for (const b of beforeRows) {
    const a = after.get(b.id);
    if (!a) { violations.push({ id: b.id, column: "(row missing)" }); continue; }
    const repriced = s(b.penalty_basis) === "contract_unstamped_needs_review" && s(a.penalty_basis) === "ww_under_5k_exempt";
    const isPlanned = planned === null || planned.has(b.id);
    const allowed = repriced ? REPRICE_COLUMNS : isPlanned ? Object.keys(expectedAfter(b.id)) : [];
    for (const c of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (allowed.includes(c)) continue;
      if (String(b[c] == null ? "" : b[c]) !== String(a[c] == null ? "" : a[c]) || (b[c] == null) !== (a[c] == null)) violations.push({ id: b.id, column: c, before: b[c], after: a[c] });
    }
    if (planned && planned.has(b.id) && b.earned_to_date != null) {
      const want = expectedAfter(b.id);
      for (const k of Object.keys(want)) if (a[k] !== want[k]) violations.push({ id: b.id, column: k, before: b[k], after: a[k], note: `a planned row must end ${want[k] === null ? "NULL" : want[k]}` });
    }
  }
  return { ok: violations.length === 0, rows_compared: beforeRows.length, violations };
}

export async function applyPlan(plan, io, { key, season = CURRENT_SEASON, dryRun = true } = {}) {   // DRY by default: a caller must say `dryRun: false` to write
  if (!key) throw new Error("apply needs UPS_COMMISH_API_KEY in the environment");
  const results = [];
  for (let i = 0; i < plan.length; i += 50) {
    const batch = plan.slice(i, i + 50);
    const res = await io.post("/admin/drops/full-year-repair?L=" + LEAGUE_ID + "&YEAR=" + season, { season: String(season), league_id: LEAGUE_ID, dry_run: dryRun, actions: batch.map((a) => ({ kind: a.kind, id: a.id, expect: a.expect })) }, key);
    const rr = (res.body && res.body.results) || [];
    for (const a of batch) { const x = rr.find((y) => y.id === a.id); results.push({ ...a, result: x ? x.result : `http_${res.status}` }); }
  }
  return results;
}

/** The exact reverse of the planned changes — a REVIEWED UPDATE for Keith to run, never applied by this tool. Guarded on the AFTER state, so it can never undo a later change. */
export function rollbackSql(plan) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
  return plan.map((a) => {
    const sets = [`earned_to_date = ${Number(a.before.earned_to_date)}`], guard = ["earned_to_date IS NULL"];
    if (a.before.penalty_basis !== undefined) { sets.push(`penalty_basis = ${q(a.before.penalty_basis)}`); guard.push(`penalty_basis = ${q(a.after.penalty_basis)}`); }
    return `UPDATE ups_drop_events SET ${sets.join(", ")} WHERE id = ${Number(a.id)} AND ${guard.join(" AND ")};`;
  }).join("\n") + (plan.length ? "\n" : "");
}
/** --apply may only send what was REVIEWED: the fresh plan must equal the reviewed plan.json (same rows, same expected before-state). */
export function planDrift(fresh, reviewed) {
  const key = (a) => `${a.id}:${a.kind || ""}:${JSON.stringify(a.expect)}:${JSON.stringify(a.after || null)}`;
  const f = new Set(fresh.map(key)), r = new Set(reviewed.map(key));
  return { ok: f.size === r.size && [...f].every((k) => r.has(k)), added: [...f].filter((k) => !r.has(k)), removed: [...r].filter((k) => !f.has(k)) };
}

const csvCell = (v) => { const t = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v == null ? "" : v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function toCsv(rows) {
  const cols = ["drop_event_id", "player_id", "player_name", "franchise_id", "contract_status", "contract_info", "salary", "tcv", "aav", "cl", "years_remaining", "dropped_at", "class", "fcfs_origin", "penalty_basis",
    "in_full_year_class", "hold_reason", "hold_detail", "captured_only_by_tcv_under_5k", "canon_earned_na_for_ww_under_4k", "repair_kind", "approved", "earned_now", "earned_proposed", "penalty_basis_proposed", "penalty_amount",
    "computed_penalty", "dead_money", "guaranteed_amount", "penalty_exempt", "posted_to_mfl", "posted_amount", "cap_adjustment_posted", "applies_to_season", "action", "changes"];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

export function parseArgs(argv) {
  const o = { apply: false, yes: false, verify: false, offline: false, serverDryRun: false, season: "", plan: "", exclude: [], asOf: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i], nx = () => argv[++i];
    if (a === "--apply") o.apply = true; else if (a === "--yes") o.yes = true; else if (a === "--verify") o.verify = true; else if (a === "--offline") o.offline = true; else if (a === "--server-dry-run") o.serverDryRun = true;
    else if (a === "--season") o.season = nx(); else if (a === "--out") o.out = nx(); else if (a === "--cache") o.cache = nx(); else if (a === "--base") o.base = nx(); else if (a === "--against") o.against = nx(); else if (a === "--plan") o.plan = nx(); else if (a === "--exclude") o.exclude = nx().split(",").map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
    else if (a === "--as-of") o.asOf = nx();
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}
/** --as-of <ISO-8601 UTC> → unix seconds. Throws on anything unparsable — a silently-ignored cutoff would repair rows past it. */
export function parseAsOf(v) {
  if (!v) return null;
  const t = Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(v) ? v : v + "Z");
  if (!Number.isFinite(t)) throw new Error(`--as-of "${v}" is not a parseable UTC timestamp (use e.g. 2026-09-27T15:10:00Z)`);
  return Math.floor(t / 1000);
}

export async function run(argv, { io: ioIn, log = console.log, env = process.env, approved = APPROVED } = {}) {
  const o = parseArgs(argv);
  if ([o.apply, o.serverDryRun, o.verify].filter(Boolean).length > 1) throw new Error("choose ONE mode: --apply, --server-dry-run or --verify");
  if (o.apply && !(o.yes && o.season)) throw new Error("--apply needs --yes and an explicit --season (write mode is never implicit)");
  if (o.apply && num(o.season) !== CURRENT_SEASON) throw new Error(`--apply is only permitted for the current season (${CURRENT_SEASON})`);
  if (o.apply && !o.plan) throw new Error("--apply needs --plan <plan.json from the reviewed dry run> (write mode only sends what was reviewed)");
  approved = { ...approved, excluded_ids: [...(approved.excluded_ids || []), ...o.exclude] };
  const asOfUnix = parseAsOf(o.asOf);
  const io = ioIn || productionIo({ base: o.base || DEFAULT_BASE });
  const dir = o.out || path.join(process.cwd(), "full_year_earned_out", new Date().toISOString().replace(/[:.]/g, "-"));
  if (!o.offline && !o.cache && fs.existsSync(path.join(dir, "dataset_before_state"))) throw new Error(`the output directory ${dir} already holds a before-state dataset — use a NEW --out (a reused directory would silently reuse stale data), or --offline to deliberately reuse it`);
  fs.mkdirSync(dir, { recursive: true });
  const ds = await loadDataset(io, { cacheDir: o.cache || path.join(dir, "dataset_before_state"), offline: o.offline });
  const analysis = buildAnalysis(ds, { approved, asOfUnix });
  const report = { mode: o.apply ? "apply" : o.serverDryRun ? "server_dry_run" : o.verify ? "verify" : "dry_run", as_of: o.asOf || null, summary: analysis.summary };
  fs.writeFileSync(path.join(dir, "earned_rows_dryrun.json"), JSON.stringify(analysis.rows, null, 1));
  fs.writeFileSync(path.join(dir, "earned_rows_dryrun.csv"), toCsv(analysis.rows));
  fs.writeFileSync(path.join(dir, "plan.json"), JSON.stringify(analysis.plan, null, 1));
  fs.writeFileSync(path.join(dir, "rollback.sql"), rollbackSql(analysis.plan));
  if (o.serverDryRun) {
    report.server_dry_run = await applyPlan(analysis.plan, io, { key: s(env.UPS_COMMISH_API_KEY), season: num(o.season) || CURRENT_SEASON, dryRun: true });
    report.server_dry_run_summary = report.server_dry_run.reduce((m, r) => { m[r.result] = (m[r.result] || 0) + 1; return m; }, {});
  } else if (o.apply) {
    const drift = planDrift(analysis.plan, JSON.parse(fs.readFileSync(o.plan, "utf8")));
    if (!drift.ok) throw new Error(`the plan changed since it was reviewed (${o.plan}): +${drift.added.length} / -${drift.removed.length} — re-run the dry run and review again`);
    report.plan_bound_to = o.plan;
    report.applied = await applyPlan(analysis.plan, io, { key: s(env.UPS_COMMISH_API_KEY), season: num(o.season), dryRun: false });
    try {
      const after = await io.d1(QUERIES.drops);
      report.unchanged_proof = unchangedProof(ds.drops, after, { plannedIds: analysis.plan.map((a) => a.id), plannedAfter: Object.fromEntries(analysis.plan.map((a) => [a.id, a.after])) });
    } catch (e) { report.unchanged_proof = { ok: false, error: `could not re-read D1: ${String(e && e.message || e)}` }; }
  } else if (o.verify) {
    const remaining = analysis.plan.length;
    report.verify = { ok: remaining === 0, remaining_actions: remaining };
    if (o.against) {
      const raw = JSON.parse(fs.readFileSync(o.against, "utf8")), before = Array.isArray(raw) ? raw : raw.drops;
      // only the rows the DRY RUN planned (the class members that held a stored earned in that before-state) may differ, and only in earned_to_date → NULL
      const beforePlan = buildAnalysis({ ...ds, drops: before }, { approved }).plan;
      report.unchanged_proof = unchangedProof(before, ds.drops, { plannedIds: beforePlan.map((a) => a.id), plannedAfter: Object.fromEntries(beforePlan.map((a) => [a.id, a.after])) });
      report.verify.ok = report.verify.ok && report.unchanged_proof.ok;
    }
  }
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(report, null, 1));
  log(JSON.stringify({ out: dir, ...report, applied: report.applied ? report.applied.map((a) => ({ id: a.id, result: a.result })) : undefined }, null, 1));
  // the process exit code must tell the truth: an apply that did not fully apply, or whose proof failed, is NOT a success
  const okResults = new Set(["applied", "noop_already_clear"]);
  report.success = report.mode === "apply" ? (report.applied.every((a) => okResults.has(a.result)) && !!report.unchanged_proof && report.unchanged_proof.ok)
    : report.mode === "server_dry_run" ? report.server_dry_run.every((a) => a.result === "would_apply" || a.result === "noop_already_clear")
    : report.mode === "verify" ? report.verify.ok : true;
  return { ...analysis, report, dir };
}

// (realpath on BOTH sides: a symlinked invocation must still run — silently doing nothing and exiting 0 would read as a passing --verify)
const isMain = (() => { try { return fs.realpathSync(process.argv[1] || "") === fs.realpathSync(fileURLToPath(import.meta.url)); } catch (_) { return false; } })();
if (isMain) {
  run(process.argv.slice(2)).then((r) => { if (r.report.success === false) process.exit(1); }).catch((e) => { console.error(String(e && e.message || e)); process.exit(2); });
}
