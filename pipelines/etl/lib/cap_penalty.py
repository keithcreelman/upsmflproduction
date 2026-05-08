"""
Era-aware cap-penalty calculator for the UPS Salary Cap Dynasty league.

This is the canonical Python reference. The JS mirror at
`worker/src/lib/cap_penalty.js` MUST stay in sync — both compute the same
values for the same inputs.

Three rule eras (see docs/league_context_v1.md Section 4 + Section 6.B):
  1. era_pre_2019_flat        — 2010 through 2018 NFL season; 20% flat × salary remaining
  2. era_2019_calendar_monthly — 2019 NFL season through 2026-05-07
                                 75% TCV guarantee, 25/50/75 Oct/Nov/Dec checkpoints
                                 WW $5K+ in-season override = flat 35% × salary
  3. era_2026_05_08_per_week  — 2026-05-08 onward
                                 75% TCV guarantee, true per-completed-week pro-rated
                                 uniform across all acquisition paths

Grandfather clause (2019 cutover): contracts active at end of 2018 with 2+
years remaining were tagged 'GF' in MFL contract_info. They stayed on the
old (era_pre_2019_flat) rule until "touched" (extension/restructure/release/
natural expiration). So the era determination is NOT a pure date lookup —
it requires both `drop_date` AND `was_grandfathered_at_drop`.

Cap-free overrides (apply across ALL eras — when triggered, return penalty=$0
regardless of era's earning math):
  - 1-year original-length contract under $5K → 0% guarantee
  - Multi-year TCV < $5K → fixed $1K penalty (NOT zero — see calc)
  - Taxi never-permanently-promoted
  - Retired player (cap-free cut)
  - Off-season suspension opt-out
  - New-owner onboarding cap-free cut
  - Tag cut BEFORE FA Auction starts (tag nullified)

Earning rules:
  - "Active for the week" = on active roster OR IR (or temp-call-up under
    new rule). Per Keith 2026-05-08: taxi weeks ALSO count for earning
    ("they all earn"). So counts_for_earning = 1 for any rostered state
    other than 'not_rostered'.
  - weeks_active is an INPUT to this calculator (computed upstream from the
    player_weekly_active table). The calculator does not derive weeks_active
    from dates.

Pure functions — no I/O, no DB access, no side effects. The calling code
is responsible for loading inputs and persisting outputs.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Optional


# ---------------------------------------------------------------------------
# Era constants
# ---------------------------------------------------------------------------

ERA_PRE_2019_FLAT = "era_pre_2019_flat"
ERA_2019_CALENDAR_MONTHLY = "era_2019_calendar_monthly"
ERA_2026_05_08_PER_WEEK = "era_2026_05_08_per_week"

ALL_ERAS = (
    ERA_PRE_2019_FLAT,
    ERA_2019_CALENDAR_MONTHLY,
    ERA_2026_05_08_PER_WEEK,
)

# Era cutover date constants (UTC dates).
ERA_2019_START_DATE = date(2019, 9, 1)   # ~start of 2019 NFL Season; first drop date under new rule
ERA_2026_05_08_START_DATE = date(2026, 5, 8)


# ---------------------------------------------------------------------------
# Input + output dataclasses
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class CycleInputs:
    """All immutable per-cycle inputs needed to compute earned + penalty."""

    # Identity (for tracing only — not used in math)
    player_id: str
    franchise_id: str
    season: int

    # Acquisition
    acquisition_path: str          # 'auction'|'ww'|'fcfs'|'trade'|'rookie_draft'|'dispersal'|'comp_pick'
    acquisition_week: int          # 0 = pre-Week-1; 1..N for in-season pickups
    contract_type: str             # 'auction'|'rookie'|'ww'|'extension'|'mym'|'tag'

    # Drop
    drop_date: date                # actual drop date (UTC)
    drop_week: Optional[int]       # 1..N or None for offseason cut
    drop_reason: str               # 'cut'|'trade'|'expired'|'retired'|'taxi_drop'|'cap_free_cut'

    # Money — current state (at moment of drop)
    salary_at_drop_usd: int        # year's actual salary (not AAV)
    tcv_at_drop_usd: int           # total contract value at the moment of drop
                                   #   For pre-2019 loaded contracts: caller passes the FULL TCV
                                   #   (not "remaining"). years_played + actual_paid_total_usd
                                   #   handle the loaded correction.
    contract_years_remaining: int  # years still on the deal at the moment of drop (includes current year)

    # Money — original anchors (for pre-2019 loaded correction)
    original_tcv_usd: int          # TCV at contract creation; AAV = original_tcv_usd / contract_original_length_years
                                   #   For straight contracts equals tcv_at_drop_usd. For extensions,
                                   #   resets at extension time (new contract context).
    actual_paid_total_usd: int     # Sum of year salaries that have FULLY played out before the cut.
                                   #   For a Y1 mid-season cut: $0.
                                   #   For a Y2 cut: Y1 salary.
                                   #   For a Y3 cut: Y1 + Y2 salaries.

    # Weeks-active math
    weeks_active: int              # accumulated from player_weekly_active (counts_for_earning sum)
    total_eligible_weeks: int      # set at acquisition: regular_season_weeks - acq_week + 1

    # Era determination
    contract_was_grandfathered: bool
    contract_original_length_years: int  # original contract length; anchors AAV + "1-yr-under-$5K" check

    # NFL calendar context (needed for era_2019_calendar_monthly's Oct/Nov/Dec checkpoints)
    # Drop month is sufficient since calendar checkpoints are calendar-month-based.


@dataclass(frozen=True)
class CycleOutputs:
    """Computed values for a single cycle."""
    rule_era_at_drop: str
    earned_legacy_usd: int
    penalty_legacy_usd: int
    cap_free: bool
    cap_free_reason: Optional[str]

    # Comparison columns — what each era WOULD compute for the same cycle.
    earned_pre2019_usd: int
    earned_calendar_monthly_usd: int
    earned_per_week_usd: int
    penalty_pre2019_usd: int
    penalty_calendar_monthly_usd: int
    penalty_per_week_usd: int


# ---------------------------------------------------------------------------
# Era determination
# ---------------------------------------------------------------------------

def determine_rule_era(drop_date: date, was_grandfathered: bool) -> str:
    """Pick the rule era that applies at the moment of drop.

    Grandfathered contracts ALWAYS use era_pre_2019_flat regardless of drop date.
    Otherwise, the era is determined by drop date.
    """
    if was_grandfathered:
        return ERA_PRE_2019_FLAT
    if drop_date >= ERA_2026_05_08_START_DATE:
        return ERA_2026_05_08_PER_WEEK
    if drop_date >= ERA_2019_START_DATE:
        return ERA_2019_CALENDAR_MONTHLY
    return ERA_PRE_2019_FLAT


# ---------------------------------------------------------------------------
# Cap-free override detection
# ---------------------------------------------------------------------------

def is_cap_free(c: CycleInputs) -> tuple[bool, Optional[str]]:
    """Return (is_cap_free, reason) if cycle qualifies for a $0 penalty
    regardless of era. These overrides are era-independent per Keith
    (cap-free categories show $0 in all era columns).

    Multi-year TCV < $5K is NOT cap-free — it's a special $1K-fixed penalty
    handled in compute_penalty(), not here.
    """
    reason = c.drop_reason

    if reason == "retired":
        return True, "retired_player"
    if reason == "expired":
        return True, "contract_expired_naturally"
    if reason == "trade":
        return True, "trade_away_no_cap_consequence"

    # Taxi-squad never permanently promoted: cap-free cut.
    if reason == "taxi_drop":
        return True, "taxi_never_permanently_promoted"

    # 1-year ORIGINAL-LENGTH contract under $5K (Veteran or WW): 0% guarantee.
    # Note: "original" — a multi-year contract whose final year is under $5K
    # is NOT cap-free by this rule.
    if (
        c.contract_original_length_years == 1
        and c.contract_type in {"auction", "ww", "veteran"}
        and c.tcv_at_drop_usd < 5_000
    ):
        return True, "1yr_original_under_5k"

    if reason == "cap_free_cut":
        # New-owner onboarding, tag-cut-pre-auction, off-season-suspension opt-out, etc.
        return True, "explicit_cap_free_category"

    return False, None


def multi_year_low_tcv_penalty(c: CycleInputs) -> Optional[int]:
    """Returns the fixed $1K penalty if cycle qualifies for the
    multi-year-low-TCV special case; else None.

    Rule (preserved across eras): multi-year contract with TCV < $5K cut
    with > 1 year remaining → fixed $1K penalty. Otherwise → no special case.
    """
    if (
        c.contract_original_length_years > 1
        and c.tcv_at_drop_usd < 5_000
        and c.contract_years_remaining > 1
    ):
        return 1_000
    return None


# ---------------------------------------------------------------------------
# Earning calculations — one per era
# ---------------------------------------------------------------------------

def earned_pre2019_flat(c: CycleInputs) -> int:
    """Pre-2019 era had no 'earned' concept — penalty was simply 20% of
    salary remaining. We return 0 here; the penalty function uses the
    salary-remaining shortcut directly. This keeps the comparison-column
    semantics clean (earned column = 0 for pre-2019)."""
    return 0


def earned_calendar_monthly(c: CycleInputs) -> int:
    """2019-era calendar-month earning: 25% Oct, 50% Nov, 75% Dec, 100%
    post-rollover. Earning ticks up at the START of each month.

    For WW $5K+ in-season cuts, the FLAT 35% rule supersedes this (handled
    in compute_penalty). The earning column here still reports the
    calendar-month figure for non-WW reference; the penalty column reports
    whichever rule actually applied.
    """
    drop = c.drop_date
    salary = c.salary_at_drop_usd

    # Once season ends and rolls over, prior year is 100% earned.
    # We approximate "post-rollover" as "drop date >= March 1 of the year
    # AFTER the season". Pre-season offseason cuts (March-Aug of the SAME
    # year as season start) earn 0% for that year.
    if drop.month >= 12 and drop.day >= 1:
        pct = 0.75  # all of December
    elif drop.month == 11:
        pct = 0.50
    elif drop.month == 10:
        pct = 0.25
    else:
        # Jan–Sep: drops here are either the cut-after-season or the
        # offseason-pre-auction window. The 0%/100% distinction comes from
        # which season's cap the penalty hits (handled by the caller); the
        # in-season-current-year earned curve is 0% before Oct 1.
        pct = 0.0

    # Special case: post-rollover (after the season fully completed and the
    # next NFL season has started). We use March 1 of the FOLLOWING calendar
    # year as the "100% earned" threshold.
    if drop.month <= 2 or (drop.month == 1):
        # If drop_date is in Jan-Feb, the prior season fully completed.
        # Year-of-season = drop.year - 1. The drop is post-rollover for that
        # season. But for the CURRENT year's salary (which hasn't started
        # earning yet), it's 0%.
        # Caller handles which season's cap is hit; this function only
        # returns the in-season earned %.
        pct = 0.0

    return round(pct * salary)


def earned_per_week(c: CycleInputs) -> int:
    """2026-05-08 era: per-completed-week pro-rated.

    earned = (weeks_active / total_eligible_weeks) * year_salary

    weeks_active is provided as input (computed upstream).
    total_eligible_weeks is set at acquisition.
    """
    if c.total_eligible_weeks <= 0:
        return 0  # acquired post-season; no earning possible
    if c.weeks_active <= 0:
        return 0
    fraction = c.weeks_active / c.total_eligible_weeks
    fraction = min(fraction, 1.0)  # cap at 100%
    return round(fraction * c.salary_at_drop_usd)


# ---------------------------------------------------------------------------
# Penalty calculations — one per era
# ---------------------------------------------------------------------------

def penalty_pre2019_loaded(c: CycleInputs) -> int:
    """Pre-2019: unified loaded-correction formula.

    Source: Forumotion archive — commish post explaining the cap-penalty rule
    with worked examples for straight, back-loaded, and front-loaded contracts.

    The rule equates total cost-per-year-of-service to what an equally
    distributed deal would have cost:

        AAV               = original_tcv_usd / contract_original_length_years
        years_played      = contract_original_length_years − contract_years_remaining
        target_total_paid = (AAV × years_played) + (0.20 × AAV × years_remaining)
        cap_hit           = target_total_paid − actual_paid_total_usd

    Properties:
    - Reduces to "20% × salary remaining" for straight contracts (or any
      Y1 cut, where actual_paid = 0 and years_played = 0).
    - For backloaded cuts after Y1+: penalty is HIGHER than the simple rule
      (actual_paid was less than AAV × years_played).
    - For frontloaded cuts after Y1+: penalty can be NEGATIVE (a credit;
      actual_paid was more than AAV × years_played). The forum post
      explicitly says credits work both ways under this rule.

    Sub-$5K TCV exempt (pre-2019 buffer-zone rule).

    Returns dollar penalty as an integer. Negative values are credits and
    are returned as-is — caller decides whether to floor at $0 (depending
    on whether the league actually applied credits in practice). The current
    league_context interpretation honors credits per the forum post.
    """
    if c.tcv_at_drop_usd < 5_000:
        return 0
    if c.contract_original_length_years <= 0:
        # Defensive: avoid divide-by-zero. Falls back to simple 20% × TCV.
        return round(0.20 * c.tcv_at_drop_usd)

    aav = c.original_tcv_usd / c.contract_original_length_years
    years_played = c.contract_original_length_years - c.contract_years_remaining
    if years_played < 0:
        years_played = 0  # defensive

    target_total = (aav * years_played) + (0.20 * aav * c.contract_years_remaining)
    cap_hit = target_total - c.actual_paid_total_usd
    return round(cap_hit)


# Back-compat alias: the simpler "20% × salary remaining" rule was the original
# pre-2019 implementation. The loaded formula above subsumes it for both
# straight and loaded contracts. Keeping this name for any callers that
# imported the old function — they get the unified behavior automatically.
penalty_pre2019_flat = penalty_pre2019_loaded


def penalty_calendar_monthly(c: CycleInputs, earned: int) -> int:
    """2019-era: (TCV × 75%) − earned, with WW $5K+ in-season override."""
    # Multi-year low-TCV special case takes precedence.
    fixed = multi_year_low_tcv_penalty(c)
    if fixed is not None:
        return fixed

    # WW $5K+ in-season special case: flat 35% × salary, regardless of earned.
    if (
        c.acquisition_path in {"ww", "fcfs"}
        and c.salary_at_drop_usd >= 5_000
        and c.drop_week is not None
        and c.drop_week >= 1
        and c.contract_type == "ww"  # only the original WW contract; if MYM'd or extended, normal rule applies
    ):
        return round(0.35 * c.salary_at_drop_usd)

    guarantee = round(c.tcv_at_drop_usd * 0.75)
    penalty = guarantee - earned
    return max(0, penalty)


def penalty_per_week(c: CycleInputs, earned: int) -> int:
    """2026-05-08 era: (TCV × 75%) − earned, uniform across all paths."""
    fixed = multi_year_low_tcv_penalty(c)
    if fixed is not None:
        return fixed

    guarantee = round(c.tcv_at_drop_usd * 0.75)
    penalty = guarantee - earned
    return max(0, penalty)


# ---------------------------------------------------------------------------
# Top-level: compute everything
# ---------------------------------------------------------------------------

def compute_cycle(c: CycleInputs) -> CycleOutputs:
    """Compute legacy + comparison columns for a single cycle.

    Pure function. Caller is responsible for persisting the result and
    handling the immutability invariant for legacy values once recorded.
    """
    rule_era = determine_rule_era(c.drop_date, c.contract_was_grandfathered)

    # Cap-free check applies to all eras.
    cap_free, cap_free_reason = is_cap_free(c)

    # Comparison columns — earned + penalty under each era.
    e_pre2019 = earned_pre2019_flat(c)
    e_calmonthly = earned_calendar_monthly(c)
    e_perweek = earned_per_week(c)

    if cap_free:
        # All era columns mirror $0 per Keith — era differences don't apply
        # to cap-free categories.
        p_pre2019 = 0
        p_calmonthly = 0
        p_perweek = 0
    else:
        p_pre2019 = penalty_pre2019_flat(c)
        p_calmonthly = penalty_calendar_monthly(c, e_calmonthly)
        p_perweek = penalty_per_week(c, e_perweek)

    # Legacy = whichever rule was actually in effect at the drop.
    if rule_era == ERA_PRE_2019_FLAT:
        earned_legacy = e_pre2019
        penalty_legacy = p_pre2019
    elif rule_era == ERA_2019_CALENDAR_MONTHLY:
        earned_legacy = e_calmonthly
        penalty_legacy = p_calmonthly
    else:  # ERA_2026_05_08_PER_WEEK
        earned_legacy = e_perweek
        penalty_legacy = p_perweek

    if cap_free:
        earned_legacy = 0
        penalty_legacy = 0

    return CycleOutputs(
        rule_era_at_drop=rule_era,
        earned_legacy_usd=earned_legacy,
        penalty_legacy_usd=penalty_legacy,
        cap_free=cap_free,
        cap_free_reason=cap_free_reason,
        earned_pre2019_usd=e_pre2019,
        earned_calendar_monthly_usd=e_calmonthly,
        earned_per_week_usd=e_perweek,
        penalty_pre2019_usd=p_pre2019,
        penalty_calendar_monthly_usd=p_calmonthly,
        penalty_per_week_usd=p_perweek,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def total_eligible_weeks(regular_season_weeks: int, acquisition_week: int) -> int:
    """Compute total_eligible_weeks for a cycle.

    acquisition_week=0 means pre-Week-1 (full season).
    acquisition_week=W (1..N) means in-season pickup; eligible weeks = N - W + 1.
    """
    if acquisition_week <= 0:
        return regular_season_weeks
    if acquisition_week > regular_season_weeks:
        return 0
    return regular_season_weeks - acquisition_week + 1


def derive_nfl_week(drop_date: date, week1_thursday: date, regular_season_weeks: int) -> Optional[int]:
    """Given a drop date and the season's Week 1 Thursday, return the NFL
    regular-season week number (1..N) the drop falls in, or None if the
    drop is outside the regular season.
    """
    if drop_date < week1_thursday:
        return None
    days_elapsed = (drop_date - week1_thursday).days
    week = (days_elapsed // 7) + 1
    if week < 1 or week > regular_season_weeks:
        return None
    return week
