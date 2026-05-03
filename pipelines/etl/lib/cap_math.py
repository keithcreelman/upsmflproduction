"""Cap mechanics — Section 6 of `docs/league_context_v1.md` (PR #8 v16, Section 6 LOCKED v11).

This module implements the cap math the 2026 bid sheet's Layer 2 needs.
Every function header cites the Section 6 sub-section it implements.
The C4.1–C4.10 worked examples are the gating tests in
`tests/test_cap_math.py`.

Section 6 source of truth lives on PR #8 branch `docs/league-context-v1`.
Read it from there if anything in this module looks wrong.
"""
from __future__ import annotations

from dataclasses import dataclass

# Section 6.A1: hard ceiling
CAP_CEILING = 300_000

# Section 6.A2: soft floor (must be hit during FA Auction OR by Sept deadline)
CAP_FLOOR = 260_000

# Section 6.F1: minimum bid reserved per remaining roster slot
MIN_BID_RESERVE = 1_000


# -------------------------------------------------------------------
# Section 6.B1 — Earning curve (CANONICAL, Keith confirmed 2026-04-28)
# -------------------------------------------------------------------

def earned_pct(cut_month: int) -> float:
    """Fraction of THIS contract year's salary that's earned by cut_month.

    Section 6.B1 buckets (using calendar month):
        3–9 (offseason / pre-FA Auction / pre-October)  → 0%
        10  (Oct 1–31)                                  → 25%
        11  (Nov 1–30)                                  → 50%
        12  (Dec 1 – season end)                        → 75%
        1–2 (post fantasy season end, before March roll) → 100%

    Note: earning ticks UP at the START of each month — "all of October = 25%"
    (Section 6.B1 clarification). The reporting code in
    build_contract_history_snapshots.py has a known bug here (Section 6.B2);
    THIS function implements the canonical rule, not the buggy code.
    """
    if cut_month in (1, 2):
        return 1.0
    if cut_month == 12:
        return 0.75
    if cut_month == 11:
        return 0.50
    if cut_month == 10:
        return 0.25
    return 0.0


def salary_earned(
    year_values: list[int],
    current_year_index: int,
    cut_month: int,
) -> int:
    """Total salary earned across the contract through the cut date.

    Section 6.C1 rule 2: "Salary Earned is based on THE YEAR'S actual
    salary (not AAV)." Prior years that played out fully count at 100%
    of THAT year's actual salary; the current year applies earned_pct
    to the current year's actual salary.

    `year_values[i]` = actual dollar salary for year i (i=0 is Y1).
    """
    if not year_values:
        return 0
    if not (0 <= current_year_index < len(year_values)):
        raise ValueError(
            f"current_year_index {current_year_index} out of range "
            f"for {len(year_values)}-year contract"
        )
    earned = sum(year_values[:current_year_index])
    earned += int(round(earned_pct(cut_month) * year_values[current_year_index]))
    return earned


# -------------------------------------------------------------------
# Section 6.C — Cut/Drop Penalty
# -------------------------------------------------------------------

def drop_penalty_standard(
    tcv: int,
    year_values: list[int],
    current_year_index: int,
    cut_month: int,
) -> int:
    """Standard cut-penalty formula (Section 6.C1).

        Penalty = (TCV × 0.75) − Salary Earned

    Section 6.C1 rule 1: TCV is fixed at contract creation OR extension
    submission and does NOT change over the contract's life. Caller is
    responsible for passing the correct TCV (e.g., for an extended
    contract, TCV = original_total + ext_year_aav).

    Returns penalty in dollars; clamped to 0 (cannot be negative).
    """
    earned = salary_earned(year_values, current_year_index, cut_month)
    raw = int(round(0.75 * tcv)) - earned
    return max(0, raw)


def drop_penalty_ww_in_season(salary: int) -> int:
    """WW pickup $5K+ dropped during the season (Section 6.C3).

    Penalty = 35% × salary. Applies only DURING the season; post-season
    WW drops show $0 (call drop_penalty_cap_free for those).
    """
    if salary < 5_000:
        # Section 6.C2 cap-free: WW under $5K is treated as Vet/WW
        # sub-$5K and incurs $0 regardless of in-season vs post.
        return 0
    return int(round(0.35 * salary))


def drop_penalty_cap_free() -> int:
    """All Section 6.C2 cap-free categories return $0.

    Categories (caller picks based on domain knowledge):
      - 1-yr Veteran/WW under $5K original
      - Taxi player never promoted
      - Tag cut BEFORE FA Auction starts (tag nullified)
      - Jail Bird (commissioner discretion)
      - Retired player (may also trigger Calvin Johnson Rule comp)
      - Off-season suspension opt-out (contract pause, salary $0 that year)
      - New owner first cap-free cut within onboarding window
      - WW any-$, post-season (full year already earned)
    """
    return 0


# -------------------------------------------------------------------
# Section 6.E — Cap movement in trades
# -------------------------------------------------------------------

def max_trade_cap_money(outgoing_player_salaries: list[int]) -> int:
    """Section 6.E1: max cap money a side can send.

    Each side's cap-money contribution is independently capped at 50%
    of the SUM of THEIR OWN traded-away player salaries (Keith v10
    multi-player confirmation). NOT pooled across sides.
    """
    if not outgoing_player_salaries:
        return 0
    total = sum(outgoing_player_salaries)
    return int(total * 0.5)


def validate_trade_cap_money(
    side_outgoing_salaries: list[int],
    side_cap_money_sent: int,
) -> bool:
    """True iff `cap_money_sent` is within the 50%-of-own-outgoing limit."""
    return side_cap_money_sent <= max_trade_cap_money(side_outgoing_salaries)


# -------------------------------------------------------------------
# Section 6.F — Available cap per franchise
# -------------------------------------------------------------------

@dataclass
class FranchiseCapState:
    """Inputs to the available-cap formula (Section 6.F).

    `active_roster_salaries`: sum of all active-roster contracts.
        Tagged players ARE active roster — included here, no separate
        accounting (Section 6.A1 + 6.F note).
    `taxi_salaries`: not tracked here; taxi is off-cap entirely.
    `ir_refunds`: 50% of each IR'd player's salary, summed.
    `positive_adjustments`: trade cap acquired, manual credits, fines forgiven, etc.
    `outstanding_charges`: drop penalties owed, traded-away cap money sent.
    """
    active_roster_salaries: int
    ir_refunds: int = 0
    positive_adjustments: int = 0
    outstanding_charges: int = 0


def compute_available_cap(
    state: FranchiseCapState,
    cap_ceiling: int = CAP_CEILING,
) -> int:
    """Section 6.F formula:

        available_cap = ceiling
                        − active_roster_salaries     # tagged in, taxi out
                        + ir_refunds_50%
                        + positive_cap_adjustments_owed
                        − outstanding_cap_charges

    May return NEGATIVE during pre-FA-Auction offseason (Section 6.F caveat) —
    the $300K ceiling does not apply until FA Auction starts, so an owner
    can be over-committed and use cuts/restructures to get under by then.
    """
    return (
        cap_ceiling
        - state.active_roster_salaries
        + state.ir_refunds
        + state.positive_adjustments
        - state.outstanding_charges
    )


def max_bid_remaining(
    available_cap: int,
    roster_slots_needed: int,
    bid_floor: int = MIN_BID_RESERVE,
) -> int:
    """Section 6.F max-bid formula (per F1, F2 worked examples):

        max_bid = available_cap − ($1K × roster_slots_needed)

    `roster_slots_needed` from F2:
        max(27 − active_count, sum(min_positional_gaps))
    so the owner reserves cash for every slot they must still fill —
    not just the absolute 27-min count.
    """
    return available_cap - bid_floor * roster_slots_needed


def roster_slots_needed(
    active_player_count: int,
    min_positional_gaps: int = 0,
    floor_count: int = 27,
) -> int:
    """Section 6.F2: reserve cash for whichever is binding —
    the 27-min total OR remaining positional minimums (e.g., 3 RBs)."""
    by_total = max(0, floor_count - active_player_count)
    return max(by_total, min_positional_gaps)
