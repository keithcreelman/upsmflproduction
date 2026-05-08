// worker/src/lib/cap_penalty.js
//
// Era-aware cap-penalty calculator — JS mirror of pipelines/etl/lib/cap_penalty.py.
// The two MUST stay in sync. Any change here requires the same change there
// (and vice versa). See the Python file for full documentation; this file is
// intentionally light on prose to keep parity easy to verify.

export const ERA_PRE_2019_FLAT = "era_pre_2019_flat";
export const ERA_2019_CALENDAR_MONTHLY = "era_2019_calendar_monthly";
export const ERA_2026_05_08_PER_WEEK = "era_2026_05_08_per_week";

export const ALL_ERAS = [
  ERA_PRE_2019_FLAT,
  ERA_2019_CALENDAR_MONTHLY,
  ERA_2026_05_08_PER_WEEK,
];

const ERA_2019_START = "2019-09-01";    // ISO date string
const ERA_2026_START = "2026-05-08";

// CycleInputs shape (object):
// {
//   player_id, franchise_id, season,
//   acquisition_path, acquisition_week, contract_type,
//   drop_date,           // ISO date string YYYY-MM-DD
//   drop_week,           // integer 1..N or null
//   drop_reason,
//   salary_at_drop_usd, tcv_at_drop_usd, contract_years_remaining,
//   original_tcv_usd,            // for AAV calc (pre-2019 loaded correction)
//   actual_paid_total_usd,       // sum of fully-played-out year salaries
//   weeks_active, total_eligible_weeks,
//   contract_was_grandfathered,    // boolean
//   contract_original_length_years // integer (anchors AAV)
// }

export function determineRuleEra(dropDateIso, wasGrandfathered) {
  if (wasGrandfathered) return ERA_PRE_2019_FLAT;
  if (dropDateIso >= ERA_2026_START) return ERA_2026_05_08_PER_WEEK;
  if (dropDateIso >= ERA_2019_START) return ERA_2019_CALENDAR_MONTHLY;
  return ERA_PRE_2019_FLAT;
}

export function isCapFree(c) {
  if (c.drop_reason === "retired") return { capFree: true, reason: "retired_player" };
  if (c.drop_reason === "expired") return { capFree: true, reason: "contract_expired_naturally" };
  if (c.drop_reason === "trade") return { capFree: true, reason: "trade_away_no_cap_consequence" };
  if (c.drop_reason === "taxi_drop") return { capFree: true, reason: "taxi_never_permanently_promoted" };

  if (
    c.contract_original_length_years === 1 &&
    ["auction", "ww", "veteran"].includes(c.contract_type) &&
    c.tcv_at_drop_usd < 5000
  ) {
    return { capFree: true, reason: "1yr_original_under_5k" };
  }

  if (c.drop_reason === "cap_free_cut") {
    return { capFree: true, reason: "explicit_cap_free_category" };
  }

  return { capFree: false, reason: null };
}

export function multiYearLowTcvPenalty(c) {
  if (
    c.contract_original_length_years > 1 &&
    c.tcv_at_drop_usd < 5000 &&
    c.contract_years_remaining > 1
  ) return 1000;
  return null;
}

export function earnedPre2019Flat(_c) {
  return 0; // no earning concept in pre-2019 era
}

export function earnedCalendarMonthly(c) {
  const drop = new Date(`${c.drop_date}T00:00:00Z`);
  const month = drop.getUTCMonth() + 1; // 1-12
  let pct = 0.0;
  if (month >= 12) pct = 0.75;
  else if (month === 11) pct = 0.50;
  else if (month === 10) pct = 0.25;
  // Jan-Sep: 0% (offseason or pre-Oct in-season)
  // Caller handles which season's cap is hit.
  return Math.round(pct * c.salary_at_drop_usd);
}

export function earnedPerWeek(c) {
  if (c.total_eligible_weeks <= 0) return 0;
  if (c.weeks_active <= 0) return 0;
  let frac = c.weeks_active / c.total_eligible_weeks;
  if (frac > 1.0) frac = 1.0;
  return Math.round(frac * c.salary_at_drop_usd);
}

// Pre-2019 unified loaded-correction formula. Derived from Forumotion
// commish post (worked examples for straight, back-loaded, and front-loaded
// contracts). Equates total cost-per-year-of-service to what an equally
// distributed deal would have cost.
//
//   AAV               = original_tcv_usd / contract_original_length_years
//   years_played      = contract_original_length_years - contract_years_remaining
//   target_total_paid = (AAV * years_played) + (0.20 * AAV * years_remaining)
//   cap_hit           = target_total_paid - actual_paid_total_usd
//
// Reduces to the simple "20% × salary remaining" rule for straight contracts
// or any Y1 cut. Y2/Y3 cuts of loaded deals get the correction.
// Sub-$5K TCV exempt (pre-2019 buffer-zone rule).
export function penaltyPre2019Loaded(c) {
  if (c.tcv_at_drop_usd < 5000) return 0;
  if (!c.contract_original_length_years || c.contract_original_length_years <= 0) {
    return Math.round(0.20 * c.tcv_at_drop_usd);
  }
  const aav = c.original_tcv_usd / c.contract_original_length_years;
  let yearsPlayed = c.contract_original_length_years - c.contract_years_remaining;
  if (yearsPlayed < 0) yearsPlayed = 0;
  const targetTotal = (aav * yearsPlayed) + (0.20 * aav * c.contract_years_remaining);
  return Math.round(targetTotal - c.actual_paid_total_usd);
}

// Back-compat alias for any callers using the old name.
export const penaltyPre2019Flat = penaltyPre2019Loaded;

export function penaltyCalendarMonthly(c, earned) {
  const fixed = multiYearLowTcvPenalty(c);
  if (fixed !== null) return fixed;

  if (
    ["ww", "fcfs"].includes(c.acquisition_path) &&
    c.salary_at_drop_usd >= 5000 &&
    c.drop_week !== null && c.drop_week >= 1 &&
    c.contract_type === "ww"
  ) {
    return Math.round(0.35 * c.salary_at_drop_usd);
  }

  const guarantee = Math.round(c.tcv_at_drop_usd * 0.75);
  return Math.max(0, guarantee - earned);
}

export function penaltyPerWeek(c, earned) {
  const fixed = multiYearLowTcvPenalty(c);
  if (fixed !== null) return fixed;
  const guarantee = Math.round(c.tcv_at_drop_usd * 0.75);
  return Math.max(0, guarantee - earned);
}

export function computeCycle(c) {
  const ruleEra = determineRuleEra(c.drop_date, !!c.contract_was_grandfathered);
  const { capFree, reason: capFreeReason } = isCapFree(c);

  const ePre2019 = earnedPre2019Flat(c);
  const eCalMonthly = earnedCalendarMonthly(c);
  const ePerWeek = earnedPerWeek(c);

  let pPre2019, pCalMonthly, pPerWeek;
  if (capFree) {
    pPre2019 = 0; pCalMonthly = 0; pPerWeek = 0;
  } else {
    pPre2019 = penaltyPre2019Flat(c);
    pCalMonthly = penaltyCalendarMonthly(c, eCalMonthly);
    pPerWeek = penaltyPerWeek(c, ePerWeek);
  }

  let earnedLegacy, penaltyLegacy;
  if (ruleEra === ERA_PRE_2019_FLAT) { earnedLegacy = ePre2019; penaltyLegacy = pPre2019; }
  else if (ruleEra === ERA_2019_CALENDAR_MONTHLY) { earnedLegacy = eCalMonthly; penaltyLegacy = pCalMonthly; }
  else { earnedLegacy = ePerWeek; penaltyLegacy = pPerWeek; }

  if (capFree) { earnedLegacy = 0; penaltyLegacy = 0; }

  return {
    rule_era_at_drop: ruleEra,
    earned_legacy_usd: earnedLegacy,
    penalty_legacy_usd: penaltyLegacy,
    cap_free: capFree,
    cap_free_reason: capFreeReason,
    earned_pre2019_usd: ePre2019,
    earned_calendar_monthly_usd: eCalMonthly,
    earned_per_week_usd: ePerWeek,
    penalty_pre2019_usd: pPre2019,
    penalty_calendar_monthly_usd: pCalMonthly,
    penalty_per_week_usd: pPerWeek,
  };
}

export function totalEligibleWeeks(regularSeasonWeeks, acquisitionWeek) {
  if (acquisitionWeek <= 0) return regularSeasonWeeks;
  if (acquisitionWeek > regularSeasonWeeks) return 0;
  return regularSeasonWeeks - acquisitionWeek + 1;
}

export function deriveNflWeek(dropDateIso, week1ThursdayIso, regularSeasonWeeks) {
  if (dropDateIso < week1ThursdayIso) return null;
  const drop = new Date(`${dropDateIso}T00:00:00Z`);
  const week1 = new Date(`${week1ThursdayIso}T00:00:00Z`);
  const daysElapsed = Math.floor((drop - week1) / (1000 * 60 * 60 * 24));
  const week = Math.floor(daysElapsed / 7) + 1;
  if (week < 1 || week > regularSeasonWeeks) return null;
  return week;
}
