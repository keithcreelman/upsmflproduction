// fcfs_contract.js — the FCFS (first-come, first-serve free agent) contract, in one place. Pure; no I/O.
//
// CANON (docs/league_context_v1.md §A5, §T1.6): every FCFS acquisition is a $1,000, ONE-YEAR "WW" contract. The league's 2026 vocabulary and token
// string (Keith's ruling — canon itself says only "1-year WW") make that:
//     $1,000 salary · one-year · Vet-WW (Rookie-WW for an NFL rookie) · CL 1 · TCV 1K · AAV 1K
// There is no bid, no negotiation and no other price. It is NOT ambiguous, so it is never a "needs a price from a human" case.
//
// Everything that writes, audits, classifies or displays an FCFS contract goes through this file:
//   • the five-minute stamper (`finalizeWaiverContracts` in index.js)         — builds the canonical row, decides the outcome
//   • the historical backfill tool (scripts/fcfs_contract_backfill.mjs) — classifies every FCFS acquisition period
//   • the drop calculator (`_computeDropPenalty`)                       — the "$1K Per Yr" full-year rule (no weekly earnings)
//
// Terminal outcomes of one FCFS acquisition (a blank contract is NOT a successful FCFS acquisition):
//   fcfs_contract_verified     MFL was re-read after the write and holds exactly the canonical contract
//   fcfs_contract_retryable    the write or its verification did not complete; nothing wrong is recorded; the next tick retries
//   fcfs_contract_needs_review something the rule cannot decide (a different price already in MFL, a different holder, an
//                              unresolvable player/franchise); a human is alerted and NOTHING is written

export const FCFS_SALARY = 1000;
export const FCFS_CONTRACT_YEAR = "1";
export const FCFS_CONTRACT_INFO = "CL 1| TCV 1K| AAV 1K";
/** First season whose WW contracts carry the CL/TCV/AAV tokens (the 2026 stamp era). Earlier seasons were `$1K`, WW, 1 year, blank info. */
export const TOKEN_ERA_START_SEASON = 2026;

/** Carried on every stamper response — the deployment discriminator: an OLD worker has no such field, so "is the FCFS fix live?" is a read-only check. */
export const FCFS_RULE_VERSION = "canon_a5_2026-09-26";
export const FCFS_OUTCOME = Object.freeze({
  VERIFIED: "fcfs_contract_verified",
  RETRYABLE: "fcfs_contract_retryable",
  NEEDS_REVIEW: "fcfs_contract_needs_review",
});

const s = (v) => String(v == null ? "" : v).trim();
const digits = (v) => s(v).replace(/\D/g, "");

/** The one canonical FCFS contract, in the exact four attributes an MFL salaries import carries. */
export function canonicalFcfsContract({ rookie = false } = {}) {
  return {
    salary: String(FCFS_SALARY),
    contractStatus: rookie ? "Rookie-WW" : "Vet-WW",
    contractYear: FCFS_CONTRACT_YEAR,
    contractInfo: FCFS_CONTRACT_INFO,
  };
}

// "0" is how MFL serves an undescribed contractYear / salary for a player under no contract; it is blank, not a described contract.
const isBlank = (v) => { const t = s(v); return !t || t === "-" || t === "0"; };
const money = (v) => { const n = Number(s(v).replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : 0; };

/**
 * What state is this contract row in, measured against the FCFS canon?
 *   missing_row      no salaries row at all
 *   blank            salary, status, year and info all empty            (the Sep-20 defect)
 *   zero             salary is an explicit 0 and nothing else is described
 *   award_salary_only MFL's award state — salary set, status/year/info blank
 *   correct          exactly the canonical FCFS contract (status Vet-WW or Rookie-WW)
 *   non_canonical    a described contract that is not the canonical one (reasons listed)
 * `season` decides whether the CL/TCV/AAV tokens are required (2026+) — earlier eras carried a blank contractInfo.
 */
export function classifyFcfsContract(row, { season = TOKEN_ERA_START_SEASON } = {}) {
  if (!row || typeof row !== "object") return { state: "missing_row", reasons: ["no_salaries_row"] };
  const sal = s(row.salary), st = s(row.contractStatus), yr = s(row.contractYear), info = s(row.contractInfo);
  const allDescribeBlank = isBlank(st) && isBlank(yr) && isBlank(info);
  if (allDescribeBlank) {
    if (!sal || sal === "-") return { state: "blank", reasons: ["salary_blank", "status_blank", "year_blank", "info_blank"] };
    if (money(sal) === 0) return { state: "zero", reasons: ["salary_zero"] };
    return { state: "award_salary_only", reasons: ["status_blank", "year_blank", "info_blank"] };
  }
  const reasons = [];
  if (money(sal) !== FCFS_SALARY) reasons.push(`salary_${money(sal)}_not_${FCFS_SALARY}`);
  if (!/^(Vet|Rookie)-WW$/i.test(st) && !(Number(season) < TOKEN_ERA_START_SEASON && /^WW$/i.test(st))) reasons.push(`status_${st || "blank"}_not_ww`);
  if (yr !== FCFS_CONTRACT_YEAR) reasons.push(`years_remaining_${yr || "blank"}_not_1`);
  if (Number(season) >= TOKEN_ERA_START_SEASON) {
    if (!/^CL 1\|\s*TCV 1K\|\s*AAV 1K\b/.test(info)) reasons.push(`info_${info || "blank"}_not_canonical`);
  } else if (info && !/^CL 1\|\s*TCV 1K\|\s*AAV 1K\b/.test(info)) {
    reasons.push(`info_${info}_not_canonical`);
  }
  return reasons.length ? { state: "non_canonical", reasons } : { state: "correct", reasons: [] };
}

/** The decision for an acquisition that is being stamped NOW (the five-minute cron and the admin route). Pure.
 *  input: { award:{source,fid,ts,bid}, holderFid, current:{salary,contractStatus,contractYear,contractInfo}, rostered:boolean, rookie:boolean }
 *  → { ok:true, write:{...canonical}, ...}                    write it (then verify by re-read)
 *    { ok:false, outcome:"fcfs_contract_needs_review", reason } nothing is written; a human decides
 *    { ok:true, write:null, skip:"already_canonical"|"dropped_before_stamp", outcome? }                            */
export function planFcfsStamp({ award, holderFid, current, rostered, rookie }) {
  if (!award || award.source !== "fcfs") return { ok: false, outcome: FCFS_OUTCOME.NEEDS_REVIEW, reason: "not_an_fcfs_award" };
  if (!digits(award.fid)) return { ok: false, outcome: FCFS_OUTCOME.NEEDS_REVIEW, reason: "franchise_unresolved" };
  const cls = classifyFcfsContract(current, { season: TOKEN_ERA_START_SEASON });
  if (!rostered) {
    // The player left the roster (dropped/traded to FA) before the stamp landed: MFL keeps no contract for a free agent, and we never
    // stamp a ghost. (The five-minute stamper only ever considers ROSTERED blank contracts, so this branch is the rule's answer for callers that ask;
    // a drop recorded before its contract was written is repaired after the fact by `planUnstampedFcfsDropRepair`.)
    return { ok: true, write: null, skip: "dropped_before_stamp", canonical: canonicalFcfsContract({ rookie }), classification: cls };
  }
  if (cls.state === "correct") return { ok: true, write: null, skip: "already_canonical", canonical: canonicalFcfsContract({ rookie }), classification: cls };
  if (digits(holderFid) !== digits(award.fid)) {
    // Someone else holds him now (a trade / a later claim). The contract still travels unchanged, but WHICH later event described
    // (or blanked) it is not something a price rule can decide.
    return { ok: false, outcome: FCFS_OUTCOME.NEEDS_REVIEW, reason: "award_franchise_differs_from_current_roster", classification: cls };
  }
  if (cls.state === "blank" || cls.state === "zero") {
    return { ok: true, write: canonicalFcfsContract({ rookie }), classification: cls };
  }
  if (cls.state === "award_salary_only") {
    // MFL set only a salary. $1,000 is canon; any other number is a disagreement, never silently "fixed".
    if (money(current.salary) !== FCFS_SALARY) return { ok: false, outcome: FCFS_OUTCOME.NEEDS_REVIEW, reason: "fcfs_salary_not_canonical", classification: cls };
    return { ok: true, write: canonicalFcfsContract({ rookie }), classification: cls };
  }
  // A DESCRIBED contract that is not canonical belongs to somebody (MYM, MYAC, the commissioner): never overwritten.
  return { ok: false, outcome: FCFS_OUTCOME.NEEDS_REVIEW, reason: "described_contract_not_canonical", classification: cls };
}

/** After a write: compare a re-read to the canonical row. */
export function verifyFcfsWrite(reread, canonical) {
  const a = reread || {};
  const ok = s(a.salary) === canonical.salary && s(a.contractStatus) === canonical.contractStatus
    && s(a.contractYear) === canonical.contractYear && s(a.contractInfo) === canonical.contractInfo;
  return { ok, outcome: ok ? FCFS_OUTCOME.VERIFIED : FCFS_OUTCOME.RETRYABLE, after: { salary: s(a.salary), contractStatus: s(a.contractStatus), contractYear: s(a.contractYear), contractInfo: s(a.contractInfo) } };
}

// ───────────────────────── the "$1K Per Yr" full-year rule (drop calculator + every earned display) ─────────────────────────
// WHAT CANON SAYS (docs/league_context_v1.md), and what it does not:
//   • §D1 "Sub-$5K TCV rule": for ANY contract with TCV ≤ $4K the PENALTY is a dedicated flat rule ($1K when years remaining ≥ 2, else $0) that
//     "overrides the standard guaranteed-minus-earned formula entirely". That is a rule about the penalty, for every TCV ≤ $4K contract.
//   • §C3 worked table: "WW under $4K, any time — earned n/a — $0 (cap-free)". §D2: a 1-year original contract under $5K is cap-free.
//   • Until 2026-09-26 canon had NO term "full-year rule" and NO term "$1K Per Yr", and the Front Office's PER WK label printed "1K Per Yr" for EVERY contract with
//     TCV ≤ $4K — including a one-year $4K waiver deal, where "1K per year" is simply wrong. Canon §A5 / §D1 / §C3 now define both rules (Keith's rulings), and the label is class-based.
// THE RULING THIS FILE IMPLEMENTS (Keith, 2026-09-25/26): a contract that pays $1,000 in EVERY contract year has no weekly and no cumulative
// earned salary. That class — and only that class — is the "$1K Per Yr" class (`isOneKPerYear`): TCV = $1,000 × CL, every year token and the
// current salary $1,000, AAV $1,000, CL ≤ 4 (so TCV ≤ $4K). A TCV-under-$5K contract that pays more than $1,000 in any year (a $4K one-year
// WW deal, a $2K Vet-FAA) is NOT in it — TCV alone is not a proxy. The one-year pure-WW deal of $2K–$4K has its OWN class (`classifyWwEarnedNa`, canon §C3: earned not
// applicable); a non-WW $2K–$4K deal keeps its earned figure until Keith rules on it.
// Any earned figure shown for a class member (the old $59 = 1/17 of $1,000, $118 = 2/17, $1,118 = a prior $1K year + 118) was arithmetic the
// rule never uses.
export const FULL_YEAR_RULE = "full_year_sub_5k";
export const FULL_YEAR_LABEL = "Full-year rule";
export const ONE_K = 1000;
// Two more bases, both stored on `ups_drop_events.penalty_basis` and both emitted by the calculator (one implementation, so a stored row and a fresh
// calculation can never disagree about the vocabulary):
//   full_year_1k_contract    a multi-year contract paying exactly $1,000 in EVERY year, priced by canon §D1's flat sub-$5K rule ($1,000 while more than
//                            one year remains). It replaces the legacy `tcv_under_5k_guarantee`, whose penalty was DERIVED from earned salary
//                            (guarantee − earned) and therefore cannot survive earned being cleared.
//   ww_under_5k_earned_na    a one-year pure-WW contract of $4K or less that is NOT the $1K-per-year class: canon §C3 "WW under $4K, any time — earned
//                            n/a — $0 (cap-free)". Earned is NULL (not applicable); the penalty is the same cap-free $0 it always was.
export const FULL_YEAR_1K_BASIS = "full_year_1k_contract";
export const WW_EARNED_NA_BASIS = "ww_under_5k_earned_na";
export const WW_EARNED_NA_RULE = "ww_earned_na";
export const WW_EARNED_NA_LABEL = "Not applicable";
export const LEGACY_GUARANTEE_BASIS = "tcv_under_5k_guarantee";
/** The drop bases that ARE the dedicated sub-$5K penalty rule (worker `_computeDropPenalty`). Taxi / tag / unpriced results are never in it. */
export const SUB_FIVE_K_BASES = new Set(["ww_under_5k_exempt", "one_year_under_5k_exempt", "tcv_under_5k_final_year_exempt", "tcv_under_5k_flat", "tcv_under_5k_fixed_1k", "tcv_under_5k_guarantee",
  FULL_YEAR_1K_BASIS, WW_EARNED_NA_BASIS]);
export const isSubFiveKTcv = (tcv) => { const n = Number(tcv); return Number.isFinite(n) && n > 0 && n <= 4000; };

/**
 * The contract tokens the drop calculator reads (`_parseContractData` in index.js — the two MUST agree; tests/fcfs_contract.test.mjs proves it
 * over every contract shape the league stores). `TCV nK` (falls back to the salary), `CL n`, `AAV nK`, `Yn-mK` (a bare number is $K).
 */
export function parseContractTokens(info, salary) {
  const ci = s(info);
  const tcvM = ci.match(/TCV\s*(\d+(?:\.\d+)?)\s*K/i);
  const clM = ci.match(/CL\s*(\d+)/i);
  const aavM = ci.match(/AAV\s*(\d+(?:\.\d+)?)\s*K/i);
  // every AAV tier ("AAV 33K, 43K" = a dual-tier loaded contract) — the class needs ALL of them to be $1,000
  const tiersM = ci.match(/AAV\s*([0-9.]+\s*K?(?:\s*,\s*[0-9.]+\s*K?)*)/i);
  const aavTiers = tiersM ? tiersM[1].split(",").map((x) => Math.round(Number(x.replace(/[^0-9.]/g, "")) * 1000)).filter((n) => Number.isFinite(n)) : [];
  const yearSalaries = {};
  const yRe = /Y(\d+)\s*[-:]\s*(\d+(?:\.\d+)?)\s*K?/gi;
  let m;
  while ((m = yRe.exec(ci)) !== null) yearSalaries[Number(m[1])] = Math.round(Number(m[2]) * 1000);
  return {
    tcv: tcvM ? Math.round(Number(tcvM[1]) * 1000) : (Number(salary) || 0),
    cl: clM ? Number(clM[1]) : null,
    aav: aavM ? Math.round(Number(aavM[1]) * 1000) : null,
    aavTiers,
    yearSalaries,
  };
}

/**
 * Is this contract in the "$1K Per Yr" class? Pure; returns the PROOF, not just a boolean.
 * @param c { salary, tcv, cl, aav, aavTiers?, yearSalaries }  dollars; `cl` the original contract length; `aav` null when the token is absent;
 *                                                   `aavTiers` every AAV tier when the parser found them; `yearSalaries` { 1: dollars, … } for the Y-tokens that exist
 * A schedule that names some years but not all of them (Y-tokens ≠ CL) is UNPROVEN, not "fine": missing evidence never proves membership.
 * @returns { member, reasons:[…why not…], proof:{ cl, tcv, salary, aav, years:[…] } }
 */
export function classifyFullYearRule(c) {
  const salary = Number(c && c.salary), tcv = Number(c && c.tcv), cl = Number(c && c.cl);
  const aav = c && c.aav != null ? Number(c.aav) : null;
  const tiers = c && Array.isArray(c.aavTiers) ? c.aavTiers.map(Number) : (aav != null ? [aav] : []);
  const ys = c && c.yearSalaries && typeof c.yearSalaries === "object" ? c.yearSalaries : {};
  const years = Object.keys(ys).map(Number).sort((x, y) => x - y).map((k) => Number(ys[k]));
  const reasons = [];
  if (!Number.isFinite(cl) || cl < 1) reasons.push("no_contract_length");
  else {
    if (cl > 4) reasons.push("tcv_over_4k");
    if (!(tcv === ONE_K * cl)) reasons.push("tcv_not_1k_per_year");
  }
  if (!(salary === ONE_K)) reasons.push("salary_not_1000");
  if (tiers.some((v) => v !== ONE_K)) reasons.push("aav_not_1000");
  if (years.some((v) => v !== ONE_K)) reasons.push("a_year_is_not_1000");
  if (years.length && Number.isFinite(cl) && years.length !== cl) reasons.push("year_schedule_incomplete");
  return { member: reasons.length === 0, reasons, proof: { cl: Number.isFinite(cl) ? cl : null, tcv: Number.isFinite(tcv) ? tcv : null, salary: Number.isFinite(salary) ? salary : null, aav, aav_tiers: tiers, years } };
}
export const isOneKPerYear = (c) => classifyFullYearRule(c).member;

/** What KIND of contract is this? (the report's classes) — one-year $1K WW (the FCFS shape) · other $1K/yr · above-$1K one-year · above-$1K multi-year · not sub-$5K. */
export function contractClass(c, status) {
  const cls = classifyFullYearRule(c);
  const st = s(status);
  if (cls.member) return Number(c.cl) === 1 && /^(Vet|Rookie)-WW$/i.test(st) ? "one_year_1k_ww" : "other_1k_per_year";   // (the FCFS canonical SHAPE — FCFS ORIGIN is a separate fact, proven from ups_add_events)
  if (!isSubFiveKTcv(c && c.tcv)) return "not_sub_5k";
  return Number(c.cl) === 1 ? "sub_5k_one_year_above_1k" : "sub_5k_multi_year_above_1k";
}

/**
 * Mark a computed drop result under the full-year rule: earned is NOT a number (null), never a weekly/cumulative amount.
 * `args` are the SAME inputs `_computeDropPenalty` was given (the current-year salary lives there, not in the result).
 * Only a "$1K Per Yr" contract priced by the dedicated sub-$5K penalty rule qualifies; everything else is returned untouched.
 */
export function applyFullYearRule(result, args) {
  if (!result || typeof result !== "object") return result;
  if (!SUB_FIVE_K_BASES.has(result.basis)) return result;   // taxi / tag / unpriced results keep their own arithmetic (D2a reads it)
  // canon §C3 WW-under-$4K: the calculator already chose the dedicated basis — earned is not applicable
  if (result.basis === WW_EARNED_NA_BASIS) return { ...result, earned: null, priorEarned: null, currentYearEarned: null, earned_rule: WW_EARNED_NA_RULE };
  const tk = parseContractTokens(args && args.contractInfo, args && args.salary);
  const member = isOneKPerYear({ salary: Number(args && args.salary), tcv: tk.tcv, cl: tk.cl, aav: tk.aav, aavTiers: tk.aavTiers, yearSalaries: tk.yearSalaries });
  if (!member) return result;
  // a class member priced by the flat multi-year rule carries the explicit full-year basis (the flat rule is the SAME $1,000 / $0 — only the name changes)
  const basis = result.basis === "tcv_under_5k_flat" ? FULL_YEAR_1K_BASIS : result.basis;
  return { ...result, basis, earned: null, priorEarned: null, currentYearEarned: null, earned_rule: FULL_YEAR_RULE };
}

// ───────────────────────── canon §D1's flat sub-$5K rule, and canon §C3's "WW under $4K" class — ONE implementation ─────────────────────────
/** canon §D1: a multi-year sub-$5K contract costs a flat $1,000 while MORE THAN ONE year remains; in its final year (or a 1-year deal) it is cap-free. */
export function isSubFiveKMultiYearFlat({ cl, yearsRemaining }) {
  return (Number(cl) || 1) > 1 && Number(yearsRemaining) > 1;
}
export const subFiveKFlatPenalty = (c) => (isSubFiveKMultiYearFlat(c) ? 1000 : 0);
// NULL / blank / unreadable years-remaining is UNKNOWN (NaN) — never 0: `Number(null)` is 0, which would read as "in its final year" and fail OPEN
const knownNumber = (v) => (v == null || (typeof v === "string" && v.trim() === "") ? NaN : Number(v));
const WW_PURE_STATUS = /^(Vet-|Rookie-)?WW$/i;
/**
 * canon §C3 worked table: "WW under $4K, any time — earned n/a — $0 (cap-free, preserved)". The class this file adopts for it (Keith, 2026-09-26): a
 * ONE-YEAR ORIGINAL pure-WW contract (status WW / Vet-WW / Rookie-WW — not a WW-MYM), salary $4,000 or less, TCV = salary, in its final year, not taxi.
 * (The $1K-per-year class is handled by `classifyFullYearRule`; a $1,000 WW deal is BOTH, and stays on its `ww_under_5k_exempt` basis.)
 * @param c { status, salary, tcv, cl, yearsRemaining, taxi }
 * @returns { member, reasons }
 */
export function classifyWwEarnedNa(c) {
  const reasons = [];
  const sal = Number(c && c.salary), t = Number(c && c.tcv), cl = knownNumber(c && c.cl), yr = knownNumber(c && c.yearsRemaining);
  // the $1,000-a-year class is its own class (§A5): when the caller supplies the contract text, a class member is NOT in this one — decided HERE, by the proof, never by a salary literal
  if (c && c.contractInfo !== undefined) {
    const tk = parseContractTokens(c.contractInfo, sal);
    if (isOneKPerYear({ salary: sal, tcv: tk.tcv, cl: tk.cl, aav: tk.aav, aavTiers: tk.aavTiers, yearSalaries: tk.yearSalaries })) reasons.push("full_year_class");
  }
  if (!WW_PURE_STATUS.test(s(c && c.status))) reasons.push("status_not_ww");
  if (c && c.taxi) reasons.push("taxi");
  if (!(sal > 0 && sal <= 4000)) reasons.push("salary_not_within_4k");
  if (cl !== 1) reasons.push("not_a_one_year_original_contract");
  if (!(t === sal)) reasons.push("tcv_differs_from_salary");
  if (!(yr <= 1)) reasons.push("not_in_final_year");
  return { member: reasons.length === 0, reasons };
}

// ───────────────────────── the row repairs: earned → NULL (and, for two classes, an explicit basis) ─────────────────────────
// Three approved repairs on `ups_drop_events`, each changing EXACTLY the columns listed and proving that the penalty, the dead money and the cap
// effect are byte-identical:
//   clear_full_year_earned            the "$1K Per Yr" class — earned_to_date → NULL
//   reconcile_legacy_guarantee_basis  a class row on the legacy `tcv_under_5k_guarantee` basis — earned → NULL, basis → `full_year_1k_contract`, ONLY when the
//                                     canonical flat rule gives exactly the stored penalty (else the row is HELD and its earned is not cleared)
//   clear_ww_earned_na                the canon §C3 WW-under-$4K class — earned → NULL, basis → `ww_under_5k_earned_na`
// "Dead money" is `penalty_amount` (the same stored cap penalty); the cap effect is `posted_to_mfl` / `posted_amount` / `applies_to_season`; none of them may move.
export const EARNED_REPAIR_COLUMNS = Object.freeze({
  clear_full_year_earned: Object.freeze(["earned_to_date"]),
  reconcile_legacy_guarantee_basis: Object.freeze(["earned_to_date", "penalty_basis"]),
  clear_ww_earned_na: Object.freeze(["earned_to_date", "penalty_basis"]),
});
export const PROTECTED_FINANCIAL_COLUMNS = Object.freeze(["penalty_amount", "guaranteed_amount", "penalty_exempt", "penalty_exempt_reason", "posted_to_mfl", "posted_amount", "applies_to_season"]);
const financialSnapshot = (row) => Object.fromEntries(PROTECTED_FINANCIAL_COLUMNS.map((c) => [c, row[c] === undefined ? null : row[c]]));
// 0 is what the drop scanner stores when contractYear was blank or 0 (`cy > 0 ? cy : 0`): a real final year is stored as 1 — so 0 is UNKNOWN here, never "final year"
const rowYearsRemaining = (row) => {
  for (const v of [row.pre_drop_years_remaining, row.pre_drop_contract_year]) { const n = knownNumber(v); if (Number.isFinite(n) && n >= 1) return n; }
  return NaN;
};
const taxiKnown = (row) => row.pre_drop_taxi != null && Number.isFinite(Number(row.pre_drop_taxi));
const rowTokens = (row) => parseContractTokens(row && row.pre_drop_contract_info, row && row.pre_drop_salary);
const rowClass = (row) => { const tk = rowTokens(row); return classifyFullYearRule({ salary: Number(row.pre_drop_salary), tcv: tk.tcv, cl: tk.cl, aav: tk.aav, aavTiers: tk.aavTiers, yearSalaries: tk.yearSalaries }); };
/** the financial proof every earned repair carries: what the penalty / dead money / cap effect are BEFORE and AFTER (always identical) */
const financialProof = (row, computedPenalty) => ({
  penalty_before: Number(row.penalty_amount) || 0, penalty_after: Number(row.penalty_amount) || 0, computed_penalty: computedPenalty,
  dead_money_before: Number(row.penalty_amount) || 0, dead_money_after: Number(row.penalty_amount) || 0,
  posted_cap_before: { posted_to_mfl: Number(row.posted_to_mfl) || 0, posted_amount: row.posted_amount == null ? null : Number(row.posted_amount), applies_to_season: row.applies_to_season == null ? null : Number(row.applies_to_season) },
  posted_cap_after: { posted_to_mfl: Number(row.posted_to_mfl) || 0, posted_amount: row.posted_amount == null ? null : Number(row.posted_amount), applies_to_season: row.applies_to_season == null ? null : Number(row.applies_to_season) },
  mfl_financial_write_proposed: false,
});
/** Does the stored penalty / exempt flag / posted amount agree with a computed (penalty, exempt) pair? Returns "" when they do, else the disagreement. */
function financialDisagreement(row, penalty, exempt) {
  if (row.penalty_amount == null || !Number.isFinite(Number(row.penalty_amount))) return "penalty_amount is not stored — an unpriced value is never read as $0";
  if (!taxiKnown(row)) return "pre_drop_taxi is not stored — an unknown taxi state is never read as 'not taxi'";
  const stored = Number(row.penalty_amount);
  if (stored !== penalty) return `stored penalty ${stored} vs computed ${penalty}`;
  if ((Number(row.penalty_exempt) === 1) !== exempt) return `stored exempt=${Number(row.penalty_exempt) || 0} vs computed ${exempt ? 1 : 0}`;
  if (Number(row.posted_to_mfl) === 1 && (row.posted_amount == null || Number(row.posted_amount) !== penalty)) return `posted to MFL as ${row.posted_amount} vs computed ${penalty}`;
  if (Number(row.posted_to_mfl) !== 1 && row.posted_amount != null && Number(row.posted_amount) !== 0) return `a posted_amount ${row.posted_amount} exists without posted_to_mfl`;
  return "";
}
/**
 * The "$1K Per Yr" class repair (earned_to_date → NULL). It changes ONE column — and it is only planned when the stored financials RECONCILE with the canonical
 * flat rule (canon §D1: $1,000 while more than one year remains and CL > 1, else $0/exempt; posted amount equal to the penalty). A row that does not reconcile is
 * refused (`conflict_financials_would_change`), never repaired — fail closed.
 */
export function planFullYearClearRepair(row) {
  const basis = s(row && row.penalty_basis);
  if (row.earned_to_date == null) return { ok: false, result: "noop_already_clear" };
  // the legacy guarantee basis is NOT cleared here: its penalty was derived from earned, so it goes through reconcile_legacy_guarantee_basis
  if (Number(row.pre_drop_taxi) === 1 || !SUB_FIVE_K_BASES.has(basis) || basis === LEGACY_GUARANTEE_BASIS) return { ok: false, result: "not_in_full_year_class", detail: Number(row.pre_drop_taxi) === 1 ? "taxi" : `basis is ${basis}`, proof: rowClass(row) };
  if (!taxiKnown(row)) return { ok: false, result: "conflict_financials_would_change", detail: "pre_drop_taxi is not stored — an unknown taxi state is never read as 'not taxi'", proof: rowClass(row) };
  const cls = rowClass(row);
  if (!cls.member) return { ok: false, result: "not_in_full_year_class", proof: cls };
  const yrs = rowYearsRemaining(row);
  const tk = rowTokens(row);
  if (!Number.isFinite(yrs)) return { ok: false, result: "conflict_financials_would_change", detail: "years remaining is not stored — the canonical rule cannot be evaluated", proof: cls };
  const computed = subFiveKFlatPenalty({ cl: tk.cl, yearsRemaining: yrs });
  const bad = financialDisagreement(row, computed, computed === 0);
  if (bad) return { ok: false, result: "conflict_financials_would_change", detail: bad, proof: cls };
  return {
    ok: true, kind: "clear_full_year_earned", set: { earned_to_date: null },
    before: { earned_to_date: row.earned_to_date }, after: { earned_to_date: null },
    unchanged: { ...financialSnapshot(row), penalty_basis: row.penalty_basis }, proof: cls,
    derivation: { rule: "canon §D1 sub-$5K flat rule: $1,000 while more than one year remains and CL > 1, else $0 (cap-free)", contract_length: tk.cl, years_remaining: yrs, computed_penalty: computed, ...financialProof(row, computed) },
  };
}
/**
 * @param row a full `ups_drop_events` row.  @returns { ok:true, kind, set, before, after, unchanged, proof, derivation } | { ok:false, result, detail?, proof? }
 */
export function planWwEarnedNaRepair(row) {
  const basis = s(row && row.penalty_basis);
  if (basis === WW_EARNED_NA_BASIS && row.earned_to_date == null) return { ok: false, result: "noop_already_clear" };
  // a row already on the earned-n/a basis whose earned was left populated needs ONLY its earned cleared (the basis stays)
  if (basis !== "ww_under_5k_exempt" && basis !== WW_EARNED_NA_BASIS) return { ok: false, result: "not_in_ww_earned_na", detail: `basis is ${basis}` };
  if (row.earned_to_date == null) return { ok: false, result: "noop_already_clear" };
  const tk = rowTokens(row);
  const verdict = classifyWwEarnedNa({ status: row.pre_drop_contract_status, salary: Number(row.pre_drop_salary), tcv: tk.tcv, cl: tk.cl, yearsRemaining: rowYearsRemaining(row), taxi: Number(row.pre_drop_taxi) === 1, contractInfo: row.pre_drop_contract_info });
  if (!verdict.member) return { ok: false, result: "not_in_ww_earned_na", proof: verdict, ...(verdict.reasons.includes("full_year_class") ? { detail: "a $1,000-a-year contract is the full-year class, not the WW earned-n/a class" } : {}) };
  // the canonical calculation for this contract: cap-free, $0, exempt (canon §D2 / §C3)
  const bad = financialDisagreement(row, 0, true);
  if (bad) return { ok: false, result: "conflict_financials_would_change", detail: bad, proof: verdict };
  const set = basis === WW_EARNED_NA_BASIS ? { earned_to_date: null } : { earned_to_date: null, penalty_basis: WW_EARNED_NA_BASIS };
  return {
    ok: true, kind: "clear_ww_earned_na", set,
    before: basis === WW_EARNED_NA_BASIS ? { earned_to_date: row.earned_to_date } : { earned_to_date: row.earned_to_date, penalty_basis: basis }, after: set,
    unchanged: financialSnapshot(row), proof: { class: "ww_earned_na", ...verdict, salary: Number(row.pre_drop_salary), tcv: tk.tcv, cl: tk.cl, years_remaining: rowYearsRemaining(row) },
    derivation: { rule: "canon §C3: WW under $4K, any time — earned n/a — $0 (cap-free)", ...financialProof(row, 0) },
  };
}
export function planLegacyGuaranteeRepair(row) {
  const basis = s(row && row.penalty_basis);
  if (basis === FULL_YEAR_1K_BASIS && row.earned_to_date == null) return { ok: false, result: "noop_already_clear" };
  if (basis !== LEGACY_GUARANTEE_BASIS) return { ok: false, result: "not_a_legacy_guarantee_row", detail: `basis is ${basis}` };
  // the repair clears earned AND re-bases: a legacy row whose earned is already NULL is not what it was proven for (its penalty derivation is already gone) — held, never a misreported no-op
  if (row.earned_to_date == null) return { ok: false, result: "hold_conflict_penalty_would_change", detail: "a legacy-basis row whose earned is already NULL — nothing to derive the penalty from; held for review" };
  if (Number(row.pre_drop_taxi) === 1) return { ok: false, result: "not_in_full_year_class", detail: "taxi" };
  const cls = rowClass(row);
  if (!cls.member) return { ok: false, result: "not_in_full_year_class", proof: cls };
  const yrs = rowYearsRemaining(row);
  const tk = rowTokens(row);
  if (!Number.isFinite(yrs)) return { ok: false, result: "hold_conflict_penalty_would_change", detail: "years remaining is not stored — the canonical rule cannot be evaluated — held; earned NOT cleared", proof: cls.proof };
  // the canonical full-year calculation — the SAME flat rule the worker's calculator applies (isSubFiveKMultiYearFlat): $1,000 while > 1 year remains, else $0
  const computed = subFiveKFlatPenalty({ cl: tk.cl, yearsRemaining: yrs });
  const bad = financialDisagreement(row, computed, computed === 0);
  if (bad) return { ok: false, result: "hold_conflict_penalty_would_change", detail: `${bad} — held; earned NOT cleared`, proof: cls.proof };
  const set = { earned_to_date: null, penalty_basis: FULL_YEAR_1K_BASIS };
  return {
    ok: true, kind: "reconcile_legacy_guarantee_basis", set,
    before: { earned_to_date: row.earned_to_date, penalty_basis: basis }, after: { earned_to_date: null, penalty_basis: FULL_YEAR_1K_BASIS },
    unchanged: financialSnapshot(row), proof: { class: "full_year_1k", ...cls.proof },
    derivation: {
      rule: "canon §D1 sub-$5K flat rule (overrides guarantee − earned): $1,000 while more than one year remains, else $0",
      contract_length: tk.cl, years_remaining: yrs, computed_penalty: computed,
      legacy_derivation: { basis, guaranteed_amount: row.guaranteed_amount, earned_to_date: row.earned_to_date, note: "legacy penalty was guarantee − earned; the flat rule gives the same amount without earned" },
      ...financialProof(row, computed),
    },
  };
}

// ───────────────────────── repricing the drop of an FCFS acquisition whose contract was never written ─────────────────────────
// (Al-Shaair, drop event 141: FCFS add 09-20 → BBID drop 09-25 with the contract still blank → the drop was stored `contract_unstamped_needs_review`.)
// THE RULING: his canonical FCFS contract ($1,000, one-year Vet-WW) becomes the stored pre-drop contract, earned uses the full-year representation
// (NULL), and his ALREADY-CORRECT penalty, dead money and cap charge stay exactly as they are — if the canonical calculation would change any of them
// the repair is REFUSED (`conflict_penalty_would_change`), never applied.
/** What the worker's `_computeDropPenalty` returns for the canonical FCFS contract (tests/fcfs_contract.test.mjs proves the two agree). */
export const CANONICAL_FCFS_DROP = Object.freeze({ basis: "ww_under_5k_exempt", penalty: 0, exempt_reason: "WW pickup salary ≤ $4K, final year (§D2)." });
export const UNSTAMPED_BASIS = "contract_unstamped_needs_review";
/**
 * @param row  the ups_drop_events row (every column the repair may touch or must preserve)
 * @param calc {basis, penalty, exempt_reason} — the canonical drop calculation (the worker passes its real one; the tool passes CANONICAL_FCFS_DROP)
 * @returns { ok:true, before, after, unchanged } | { ok:false, result, detail }   — `before`/`after` list EXACTLY the columns that change
 */
export const REPRICE_COLUMNS = Object.freeze(["pre_drop_contract_status", "pre_drop_salary", "pre_drop_contract_year", "pre_drop_contract_length", "pre_drop_contract_info", "pre_drop_tcv", "pre_drop_aav",
  "pre_drop_years_remaining", "earned_to_date", "penalty_basis", "penalty_exempt", "penalty_exempt_reason", "notes"]);
export function planUnstampedFcfsDropRepair(row, calc = CANONICAL_FCFS_DROP, { rookie = false } = {}) {
  const canon = canonicalFcfsContract({ rookie });
  const basis = s(row && row.penalty_basis);
  if (basis === CANONICAL_FCFS_DROP.basis) return { ok: false, result: "noop_already_repriced" };
  if (basis !== UNSTAMPED_BASIS) return { ok: false, result: "precondition_failed", detail: `basis is ${basis}` };
  // BLANK-ONLY: the stored pre-drop contract must be the unstamped nothing the drop saw — a DESCRIBED contract is never overwritten
  const isBlank = (v) => { const x = s(v); return !x || x === "-" || x === "0"; };
  if (!isBlank(row.pre_drop_contract_status) || !isBlank(row.pre_drop_contract_info) || !isBlank(row.pre_drop_salary)) {
    return { ok: false, result: "precondition_failed", detail: "the stored pre-drop contract is not blank — a described contract is never overwritten" };
  }
  const stored = Number(row.penalty_amount) || 0;
  const posted = Number(row.posted_to_mfl) === 1;
  if (calc.basis !== CANONICAL_FCFS_DROP.basis || Number(calc.penalty) !== stored || (posted && Number(row.posted_amount) !== Number(calc.penalty))) {
    return { ok: false, result: "conflict_penalty_would_change", detail: `canonical ${calc.basis}/${calc.penalty} vs stored ${basis}/${row.penalty_amount} posted=${row.posted_to_mfl}/${row.posted_amount}` };
  }
  const note = (`${s(row.notes)} | fcfs_repair: priced under the canonical FCFS contract (canon §A5) — the contract was never written before the drop; penalty, dead money and cap charge unchanged.`).replace(/^ \| /, "");
  const set = {
    pre_drop_contract_status: canon.contractStatus, pre_drop_salary: FCFS_SALARY, pre_drop_contract_year: 1, pre_drop_contract_length: 1, pre_drop_contract_info: canon.contractInfo,
    pre_drop_tcv: FCFS_SALARY, pre_drop_aav: FCFS_SALARY, pre_drop_years_remaining: 1, earned_to_date: null, penalty_basis: calc.basis, penalty_exempt: 1, penalty_exempt_reason: s(calc.exempt_reason), notes: note,
  };
  const before = {}, after = {};
  for (const [k, v] of Object.entries(set)) { const cur = row[k] === undefined ? null : row[k]; if (cur !== v) { before[k] = cur; after[k] = v; } }
  return { ok: true, set, before, after, unchanged: { penalty_amount: row.penalty_amount, posted_to_mfl: row.posted_to_mfl, posted_amount: row.posted_amount, guaranteed_amount: row.guaranteed_amount, applies_to_season: row.applies_to_season } };
}

// ───────────────────────── acquisition periods (the historical inventory) ─────────────────────────
// One row per FCFS acquisition. A period runs from the acquisition until the first later event that ends it for that player in that
// season: a drop by the same franchise, a trade, or a later acquisition (BBID / FCFS / auction) — the last is a REPLACEMENT contract.

const tsOf = (e) => Number(e && (e.ts != null ? e.ts : e.unix_timestamp)) || 0;

/**
 * @param fcfsAdds   [{ season, txn, ts, pid, fid, name? }]                      the FCFS acquisitions (FREE_AGENT adds)
 * @param events     [{ season, ts, pid, fid, kind:'drop'|'add_bbid'|'add_fcfs'|'add_auction'|'trade_in'|'trade_out', txn? }]
 * @returns [{ ...add, endKind, endTs, endFid, dropTs, tradeTs, reacquiredTs, replacementKind, replacementTs, multiPeriod }]
 */
export function buildFcfsPeriods(fcfsAdds, events) {
  const bySeasonPid = new Map();
  for (const e of Array.isArray(events) ? events : []) {
    const k = `${e.season}|${digits(e.pid)}`;
    if (!bySeasonPid.has(k)) bySeasonPid.set(k, []);
    bySeasonPid.get(k).push(e);
  }
  for (const list of bySeasonPid.values()) list.sort((a, b) => tsOf(a) - tsOf(b));
  const periods = [];
  const adds = [...(Array.isArray(fcfsAdds) ? fcfsAdds : [])].sort((a, b) => Number(a.season) - Number(b.season) || tsOf(a) - tsOf(b));
  const perKey = new Map();
  for (const a of adds) {
    const k = `${a.season}|${digits(a.pid)}`;
    perKey.set(k, (perKey.get(k) || 0) + 1);
  }
  for (const a of adds) {
    const k = `${a.season}|${digits(a.pid)}`;
    const later = (bySeasonPid.get(k) || []).filter((e) => tsOf(e) > tsOf(a) || (tsOf(e) === tsOf(a) && e.kind !== "add_fcfs"));
    const p = { ...a, pid: digits(a.pid), fid: digits(a.fid).padStart(4, "0"), dropTs: null, tradeTs: null, reacquiredTs: null, replacementKind: null, replacementTs: null, endKind: "held_to_season_end", endTs: null, endFid: null, multiPeriod: (perKey.get(k) || 0) > 1 };
    for (const e of later) {
      if (e.kind === "drop" && digits(e.fid).padStart(4, "0") === p.fid && !p.dropTs && !p.tradeTs) { p.dropTs = tsOf(e); p.endKind = "dropped"; p.endTs = tsOf(e); p.endFid = p.fid; continue; }
      if ((e.kind === "trade_out") && digits(e.fid).padStart(4, "0") === p.fid && !p.tradeTs && !p.dropTs) { p.tradeTs = tsOf(e); p.endKind = "traded"; p.endTs = tsOf(e); p.endFid = p.fid; continue; }
      if (String(e.kind).startsWith("add_")) {
        if (!p.endTs || tsOf(e) >= p.endTs) {
          // an acquisition AFTER the period ended (drop/trade) is a re-acquisition; one while it is still open is a replacement.
          if (p.endTs) { if (p.reacquiredTs == null) p.reacquiredTs = tsOf(e); }
          else { p.replacementKind = e.kind; p.replacementTs = tsOf(e); p.endKind = "replaced"; p.endTs = tsOf(e); p.endFid = digits(e.fid).padStart(4, "0"); }
        }
      }
    }
    periods.push(p);
  }
  return periods;
}

/**
 * The decision for one historical/current period. `evidence` is whatever the sources can prove about the contract:
 *   { season, contract: {salary,contractStatus,contractYear,contractInfo}|null|undefined, contractSource, mflActive:boolean(2026 live),
 *     currentSeason:number, laterContract?: {...}, dropEvent?: {...} }
 * Returns { bucket, classification, category, action, correctionRequired, autoCorrectable, reason }.
 */
export function decidePeriod(period, evidence) {
  const season = Number(period.season);
  const cur = Number(evidence.currentSeason);
  const cls = classifyFcfsContract(evidence.contract, { season });
  const out = { classification: cls.state, classification_reasons: cls.reasons };
  const pick = (bucket, category, action, correctionRequired, autoCorrectable, reason) => ({ ...out, bucket, category, action, correctionRequired, autoCorrectable, reason });

  // 1. A later valid event replaced this FCFS contract — never overwritten.
  if (period.endKind === "replaced") return pick("replaced_by_later_event", "historical_unchanged", "none", false, false, `replaced by ${period.replacementKind} at ${period.replacementTs}`);
  const bucket = period.endKind === "dropped" ? "dropped_during_season" : period.endKind === "traded" ? "traded_under_fcfs_contract" : "retained";
  const b2 = period.multiPeriod || period.reacquiredTs ? `${bucket}+reacquired` : bucket;

  if (season < cur) {
    // Past seasons: MFL history is closed. The season-end salaries row is the only contract evidence and it belongs to the period only while
    // the period was still open at season end (held or traded). A dropped period's season-end row (if any) belongs to a later period.
    if (period.endKind === "dropped") return pick(b2, "historical_unchanged", "none", false, false, "dropped in-season; MFL keeps no contract for a free agent, and any season-end row belongs to a later period");
    if (cls.state === "correct") return pick(b2, "historical_unchanged", "none", false, false, "season-end contract matches the FCFS canon for its era");
    const reviewed = (reason, klass) => ({ ...pick(b2, "manual_review", "manual_review", true, false, reason), review_class: klass });
    if (cls.state === "missing_row") return reviewed("held per the event log but no season-end contract row exists (source gap); closed season — nothing is auto-written", "closed_season_unverifiable");
    if (cls.state === "blank" || cls.state === "zero" || cls.state === "award_salary_only") return reviewed(`season-end contract ${cls.state} on a period still open at season end; closed season — history is never auto-written`, "closed_season_unverifiable");
    // a DESCRIBED contract: it was later described/converted by another event (status ladder, MYM, extension) — not an FCFS defect — unless its price
    // is not $1,000 with nothing later to explain it
    const salaryOff = (cls.reasons || []).some((x) => x.startsWith("salary_"));
    if (salaryOff && !period.reacquiredTs) return reviewed(`season-end contract is described at a price other than $1,000 (${(cls.reasons || []).join(", ")}) with no later acquisition to explain it`, "closed_season_anomaly");
    return pick(b2, "historical_unchanged", "none", false, false, "season-end contract was later described by another event or belongs to a later acquisition; not an FCFS defect");
  }

  // Current season.
  if (period.endKind === "dropped" || period.endKind === "traded") {
    if (cls.state === "correct") return pick(b2, "historical_unchanged", "none", false, false, "contract canonical at last read");
    if (period.endKind === "dropped") {
      const de = evidence.dropEvent || null;
      // the drop was priced on a blank contract, or with weekly "earned" that the sub-$5K rule never uses
      if (de && (de.penalty_basis === "contract_unstamped_needs_review")) return pick(b2, "d1_correction", "reprice_unstamped_fcfs_drop", true, true, "dropped before its contract was written; the drop was left unpriced — reprice under the canonical $1K one-year rule");
      return pick(b2, "historical_unchanged", "none", false, false, "dropped; MFL keeps no contract for a free agent");
    }
    return pick(b2, "manual_review", "manual_review", true, false, "traded under a blank/non-canonical FCFS contract; the current holder's contract must be reviewed");
  }
  if (cls.state === "correct") return pick(b2, "historical_unchanged", "none", false, false, "already canonical — no write");
  if (cls.state === "blank" || cls.state === "zero" || cls.state === "award_salary_only") {
    if (cls.state === "award_salary_only" && money(evidence.contract && evidence.contract.salary) !== FCFS_SALARY) return pick(b2, "manual_review", "manual_review", true, false, "MFL salary differs from the canonical $1,000");
    return pick(b2, "mfl_correction", "mfl_stamp", true, true, "active FCFS contract is blank — stamp the canonical one-year $1,000 Vet-WW");
  }
  // A DESCRIBED contract on an active FCFS period. A status that is not WW (MYM, an extension, a tag, a rookie conversion, a restructure …) is a
  // REPLACEMENT contract written by a later valid event — protected, never overwritten, not a defect. A WW contract that is not the canonical
  // one (wrong price / length / tokens) is unexplained and goes to a human.
  const st = s(evidence.contract && evidence.contract.contractStatus);
  if (!isBlank(st) && !/(^|-)WW$/i.test(st)) return pick("replaced_by_later_event", "historical_unchanged", "none", false, false, `contract was later described as ${st} by another event; protected — never overwritten`);
  return pick(b2, "manual_review", "manual_review", true, false, `a WW contract that is not the canonical FCFS one (${(cls.reasons || []).join(", ")}) sits on an active FCFS period; not overwritten`);
}

// ───────────────────────── the reconciliation report: zero-contract periods, closed-season anomalies, add-event closure ─────────────────────────
// (Keith 2026-09-26: classify EVERY zero-contract period; explain the three closed-season anomalies individually; give the closure method for the four open add events.)
// Nothing here writes anything: these are the pure decisions the inventory tool reports and the one audited route re-checks.
const pad4 = (v) => digits(v).padStart(4, "0").slice(-4);

/** The four classes a zero-contract period ends in. */
export const ZERO_CLASS = Object.freeze({
  PROVEN: "transaction_proven_fcfs_acquisition",
  SUPERSEDED: "superseded_by_later_valid_contract",
  CONFLICT: "conflicting_historical_evidence",
  INSUFFICIENT: "insufficient_source_evidence",
});
/** Seasons where MFL itself returns no data for league 74598: the D1 ledger is the only evidence and nothing can corroborate it (docs/FCFS_CONTRACTS.md §4). */
export const D1_ONLY_EVIDENCE_SEASONS = Object.freeze([2011, 2012]);

/**
 * A closed-season period whose season-end contract row is an explicit $0 (salary 0, no status, year 0). What does that $0 actually say?
 *   period ended by a later acquisition  → SUPERSEDED   the later event's contract governs; the $0 row is not evidence about this period
 *   period ended by a drop               → PROVEN       the ledger proves acquisition AND drop; a period that had ended cannot own the season-end row
 *   held (or traded on) at season end    → CONFLICT     the ledger says a franchise held him, the salaries row says no contract — two sources disagree,
 *                                                       nothing resolves it, and a closed season is never written
 *                                        → INSUFFICIENT the same, but the season has NO MFL data to corroborate either side (D1 ledger only)
 * @param period a buildFcfsPeriods() row.  @param ctx { sources:[…the ledgers that prove the add…] }
 * @returns { zero_class, evidence_grade, reason }
 */
export function classifyZeroPeriod(period, ctx) {
  const c = ctx || {};
  const sources = Array.isArray(c.sources) ? c.sources : [];
  const seasonD1Only = D1_ONLY_EVIDENCE_SEASONS.includes(Number(period && period.season));
  const d1Only = seasonD1Only || !sources.includes("src_adddrop");
  const evidence_grade = seasonD1Only ? "d1_ledger_only_not_corroborated_by_mfl" : d1Only ? "single_ledger_mfl_historical_transactions_only" : "d1_ledger";
  if (period && period.endKind === "replaced") {
    return { zero_class: ZERO_CLASS.SUPERSEDED, evidence_grade, reason: `a later ${s(period.replacementKind)} of the same player (unix ${period.replacementTs}) replaced this FCFS contract; that event's contract governs and the season-end $0 row is not evidence about this period` };
  }
  if (period && period.endKind === "dropped") {
    return { zero_class: ZERO_CLASS.PROVEN, evidence_grade, reason: "the ledger proves the FCFS acquisition and the drop; the period had already ended, so no season-end contract can belong to it (any season-end row belongs to a later period)" };
  }
  const state = period && period.endKind === "traded" ? "traded him away" : "still held him at season end";
  if (d1Only) return { zero_class: ZERO_CLASS.INSUFFICIENT, evidence_grade, reason: seasonD1Only
    ? `the D1 ledger says the acquirer ${state}, but MFL has no data for this season to corroborate that or the explicit $0 season-end row — insufficient source evidence; nothing is written`
    : `the only ledger that proves this add is mfl_historical_transactions (no src_adddrop row), so nothing corroborates that the acquirer ${state} or the explicit $0 season-end row — insufficient source evidence; nothing is written` };
  return { zero_class: ZERO_CLASS.CONFLICT, evidence_grade, reason: `the ledger says the acquirer ${state} but the season-end contract row is an explicit $0 with no status — two sources disagree and no other evidence resolves it; closed season, nothing is written` };
}

/** A same-franchise DROP within this many seconds before the add is a re-add of his own player (an undone drop), not a free-agent pickup. */
export const READD_WINDOW_SECONDS = 3600;
/**
 * Why does a closed-season FCFS period carry a season-end contract at a price other than $1,000? Two explanations the LEDGER can prove:
 *   same_franchise_drop_and_readd          the acquirer DROPPED him minutes before the add and the season-end row is the acquirer's own — a re-add of his own
 *                                          player (an undone drop): his existing contract survived; FCFS cannot create a described contract
 *   season_end_row_belongs_to_prior_holder the season-end row is attributed to ANOTHER franchise that dropped/traded him earlier in the season — a stale
 *                                          prior-holder contract, not the acquirer's (the next season's row, when it names the acquirer, corroborates)
 * @param ctx { contractRow:{franchise_id,salary,contract_status,contract_year}, nextSeasonRow?, events:[{ts,fid,kind}] }   events = every ledger event for this player-season
 * @returns { explained:boolean, explanation_class, evidence, conclusion }
 */
export function explainClosedSeasonAnomaly(period, ctx) {
  const c = ctx || {};
  const fid = pad4(period && period.fid), addTs = tsOf(period);
  const row = c.contractRow || null;
  const rowFid = row && s(row.franchise_id) ? pad4(row.franchise_id) : "";
  const events = Array.isArray(c.events) ? c.events : [];
  // an event with no / unreadable timestamp is UNKNOWN — never the unix epoch, never "before the add"
  const timed = (e) => Number.isFinite(tsOf(e)) && tsOf(e) > 0;
  const exits = (holder) => events.filter((e) => timed(e) && (e.kind === "drop" || e.kind === "trade_out") && pad4(e.fid) === holder && tsOf(e) < addTs).sort((a, b) => tsOf(b) - tsOf(a));
  const returned = (holder) => events.some((e) => timed(e) && (String(e.kind).startsWith("add_") || e.kind === "trade_in") && pad4(e.fid) === holder && tsOf(e) > addTs);
  const readdDrop = exits(fid).find((e) => e.kind === "drop" && addTs - tsOf(e) <= READD_WINDOW_SECONDS);
  if (readdDrop && rowFid === fid) {
    return { explained: true, explanation_class: "same_franchise_drop_and_readd",
      evidence: { drop_unix: tsOf(readdDrop), add_unix: addTs, gap_seconds: addTs - tsOf(readdDrop), season_end_row_franchise: rowFid, season_end_status: s(row.contract_status), season_end_salary: Number(row.salary) || 0 },
      conclusion: `the same franchise dropped him ${addTs - tsOf(readdDrop)}s before this "acquisition" and the season-end contract (${s(row.contract_status)} $${Number(row.salary) || 0}) is that franchise's own — a re-add of his own player (an undone drop) whose existing contract survived, not a free-agent pickup; not an FCFS contract defect` };
  }
  if (rowFid && rowFid !== fid && !returned(rowFid)) {
    const exit = exits(rowFid)[0];
    if (exit) {
      const next = c.nextSeasonRow || null;
      return { explained: true, explanation_class: "season_end_row_belongs_to_prior_holder",
        evidence: { season_end_row_franchise: rowFid, acquirer: fid, prior_holder_exit_kind: exit.kind, prior_holder_exit_unix: tsOf(exit), add_unix: addTs, season_end_status: s(row.contract_status), season_end_salary: Number(row.salary) || 0,
          next_season_row: next ? { franchise_id: pad4(next.franchise_id) || "", salary: Number(next.salary) || 0, status: s(next.contract_status), contract_year: Number(next.contract_year) || 0 } : null,
          next_season_names_acquirer: !!(next && s(next.franchise_id) && pad4(next.franchise_id) === fid) },
        conclusion: `the season-end contract row is attributed to franchise ${rowFid}, which ${exit.kind === "drop" ? "dropped" : "traded away"} him before this acquisition — a stale prior-holder contract, not the acquirer's; the acquirer's own contract for this period is not in the closed-season export, so nothing about it is asserted` };
    }
  }
  return { explained: false, explanation_class: "unexplained", evidence: {}, conclusion: "the ledger does not explain it — stays in manual review" };
}

// ───────────────────────── closing an FCFS add event the stamper's roster re-read can never close ─────────────────────────
// The stamper's reconcile step closes an open/refused add event ONLY when MFL holds EXACTLY the canonical contract for the acquirer's rostered player. Two real cases
// can never satisfy that, and would stay `contract_annotated = 3` forever, so each has its own audited step (route kind close_fcfs_add_event), with evidence a reader can check:
//   A. the player was DROPPED before the contract was written (Al-Shaair, add 75) — he is on nobody's roster. The step runs ONLY AFTER the drop's own repair
//      (reprice_unstamped_fcfs_drop) has landed: the canonical contract is then on the drop record and in the audit log.                                   → contract_annotated 1
//   B. the canonical contract WAS written (a landed stamp in salary_change_log) and the owner then CONVERTED it (MYM / extension … — a landed change whose BEFORE state is
//      that canonical contract) (Watson, add 52): MFL no longer holds the FCFS contract, and a described contract is never reverted (the documented meaning of 2). → contract_annotated 2
// Neither is a roster/MFL verification, and neither says so.
export const ADD_EVENT_SUPERSEDED_NOTE = (stampId, changeId, endpoint, status) => `superseded_by_later_owner_contract: the canonical FCFS contract (canon §A5) was written (salary_change_log ${stampId}) and then converted by its owner (salary_change_log ${changeId}, ${s(endpoint)}, ${s(status)}); a described contract is never reverted — never fcfs_contract_verified, since MFL no longer holds the FCFS contract`;
export const ADD_EVENT_CLOSE_NOTE = (dropId) => `fcfs_contract_settled_by_drop_repair: the canonical FCFS contract (canon §A5) is recorded as the pre-drop contract by the audited repair of drop event ${dropId}; the player is not rostered, so this is NOT a roster-verified contract`;
const stampedAtSec = (r) => { const v = Date.parse(s(r && r.created_ts).replace(" ", "T") + (/Z$/.test(s(r && r.created_ts)) ? "" : "Z")); return Number.isFinite(v) ? v / 1000 : 0; };
/**
 * Is this salary_change_log row PROOF that MFL took a contract write? Only when it is not a dry run, is marked landed, AND MFL answered the
 * import (an HTTP 2xx import_status). `landed` / `dry_run` alone are not enough (2026-10-08): until then the contract routes (/offer-mym,
 * /offer-restructure, /commish-contract-update) logged every DRY RUN as dry_run=0, landed=1, notes "import_ok_log_dispatched", with
 * import_status 0 (no MFL request) and the AFTER fields a copy of BEFORE — a row that looks exactly like a stamp of whatever MFL already
 * held. Every genuinely landed row in production carries import_status 200.
 */
export function isMflConfirmedWrite(r) {
  if (!r || Number(r.landed) !== 1 || Number(r.dry_run) === 1) return false;
  const st = Number(r.import_status);
  if (!(st >= 200 && st <= 299)) return false;
  return !/^dry_run/i.test(s(r.notes));
}
/** Path B's evidence: a landed stamp of the canonical contract (at/after the acquisition) followed by a landed change whose BEFORE state is that canonical contract and whose AFTER state is a described, non-WW contract. Both must be MFL-confirmed writes (isMflConfirmedWrite). */
function ownerConversionEvidence(ev, changeLog) {
  const acq = Number(ev.acquired_at_unix) || 0;
  const rows = (Array.isArray(changeLog) ? changeLog : []).filter((r) => s(r.player_id) === s(ev.player_id) && isMflConfirmedWrite(r)).sort((a, b) => Number(a.id) - Number(b.id));
  const cls = (sal, st, yr, info) => classifyFcfsContract({ salary: sal, contractStatus: st, contractYear: yr, contractInfo: info }, { season: Number(ev.season) }).state;
  const stamp = rows.find((r) => stampedAtSec(r) >= acq - 60 && cls(r.after_salary, r.after_contract_status, r.after_contract_year, r.after_contract_info) === "correct");
  if (!stamp) return null;
  const change = rows.find((r) => Number(r.id) > Number(stamp.id) && stampedAtSec(r) >= stampedAtSec(stamp) && cls(r.before_salary, r.before_contract_status, r.before_contract_year, r.before_contract_info) === "correct"
    && !isBlank(r.after_contract_status) && !/(^|-)WW$/i.test(s(r.after_contract_status)));
  return change ? { stamp, change } : null;
}
/**
 * @param addEvent  ups_add_events row {id, season, player_id, franchise_id, acquired_at_unix, source, contract_annotated, notes}
 * @param dropRow   the EARLIEST ups_drop_events row for the same player+franchise at or after the acquisition (or null)
 * @param auditRows ups_contract_gate_audit rows of field `fcfs_reprice_unstamped_drop` whose note names this drop ([{id, note}])
 * @param changeLog landed salary_change_log rows for this player (path B — only consulted when there is no drop); each must carry import_status and notes (isMflConfirmedWrite)
 * @returns { ok:true, path:'drop_repair'|'owner_conversion', before, after, evidence } | { ok:false, result, detail? }
 */
export function planFcfsAddEventClosure({ addEvent, dropRow, auditRows, changeLog } = {}) {
  const ev = addEvent;
  if (!ev || s(ev.source) !== "fcfs") return { ok: false, result: "not_an_fcfs_add_event" };
  const state = Number(ev.contract_annotated);
  if (state === 1) return { ok: false, result: "noop_already_closed" };
  if (state !== 0 && state !== 3) return { ok: false, result: "not_open", detail: `contract_annotated=${ev.contract_annotated}` };
  if (!dropRow) {
    const conv = ownerConversionEvidence(ev, changeLog);
    if (!conv) return { ok: false, result: "no_drop_of_this_acquisition", detail: "no drop of this acquisition, and no landed canonical stamp followed by an owner conversion of it in salary_change_log" };
    return {
      ok: true, path: "owner_conversion",
      before: { contract_annotated: state, notes: ev.notes == null ? null : ev.notes },
      after: { contract_annotated: 2, notes: ADD_EVENT_SUPERSEDED_NOTE(conv.stamp.id, conv.change.id, conv.change.endpoint, conv.change.after_contract_status) },
      evidence: { stamp_log_id: conv.stamp.id, stamp_at: s(conv.stamp.created_ts), change_log_id: conv.change.id, change_at: s(conv.change.created_ts), change_endpoint: s(conv.change.endpoint),
        converted_to: { salary: conv.change.after_salary, status: conv.change.after_contract_status, year: conv.change.after_contract_year, info: conv.change.after_contract_info }, roster_verified: false },
    };
  }
  const dAt = Number(dropRow.dropped_at_unix), aAt = Number(ev.acquired_at_unix);
  if (s(dropRow.player_id) !== s(ev.player_id) || pad4(dropRow.franchise_id) !== pad4(ev.franchise_id) || !(Number.isFinite(dAt) && Number.isFinite(aAt) && dAt >= aAt)) {
    return { ok: false, result: "drop_not_of_this_acquisition", detail: `drop ${dropRow.id}: player ${dropRow.player_id} franchise ${dropRow.franchise_id} at ${dropRow.dropped_at_unix}` };
  }
  const cls = classifyFcfsContract({ salary: dropRow.pre_drop_salary, contractStatus: dropRow.pre_drop_contract_status, contractYear: dropRow.pre_drop_contract_year, contractInfo: dropRow.pre_drop_contract_info }, { season: Number(ev.season) });
  if (cls.state !== "correct") return { ok: false, result: "drop_contract_not_canonical", detail: `the drop's stored pre-drop contract is ${cls.state} (${(cls.reasons || []).join(", ")}) — run the drop repair first` };
  const audit = (Array.isArray(auditRows) ? auditRows : []).find((a) => s(a.note).startsWith(`drop_event_id=${dropRow.id} `));
  if (!audit) return { ok: false, result: "no_audited_drop_repair", detail: `no fcfs_reprice_unstamped_drop audit row names drop event ${dropRow.id} — the canonical contract did not arrive through the audited repair` };
  return {
    ok: true, path: "drop_repair",
    before: { contract_annotated: state, notes: ev.notes == null ? null : ev.notes },
    after: { contract_annotated: 1, notes: ADD_EVENT_CLOSE_NOTE(dropRow.id) },
    evidence: { drop_event_id: dropRow.id, audit_row_id: audit.id == null ? null : audit.id, pre_drop_contract: { salary: dropRow.pre_drop_salary, status: dropRow.pre_drop_contract_status, year: dropRow.pre_drop_contract_year, info: dropRow.pre_drop_contract_info }, roster_verified: false },
  };
}
