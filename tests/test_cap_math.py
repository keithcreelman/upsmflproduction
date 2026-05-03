"""Gating tests for `pipelines/etl/lib/cap_math.py`.

Reproduces every Section 6 worked example penny-accurately. Source of
truth is `docs/league_context_v1.md` Section 6 (LOCKED v11) on PR #8
branch `docs/league-context-v1`. If this file diverges from that doc,
the doc wins and this file must be updated.
"""
from __future__ import annotations

import pytest

from cap_math import (
    CAP_CEILING,
    CAP_FLOOR,
    FranchiseCapState,
    compute_available_cap,
    drop_penalty_cap_free,
    drop_penalty_standard,
    drop_penalty_ww_in_season,
    earned_pct,
    max_bid_remaining,
    max_trade_cap_money,
    roster_slots_needed,
    salary_earned,
    validate_trade_cap_money,
)


# -------------------------------------------------------------------
# Section 6.B1 — Earning curve table
# -------------------------------------------------------------------

@pytest.mark.parametrize("month,expected", [
    (3, 0.0), (4, 0.0), (5, 0.0), (6, 0.0), (7, 0.0),
    (8, 0.0), (9, 0.0),
    (10, 0.25),
    (11, 0.50),
    (12, 0.75),
    (1, 1.0), (2, 1.0),
])
def test_earned_pct_buckets(month, expected):
    assert earned_pct(month) == expected


# -------------------------------------------------------------------
# Section 6.C4 — worked drop-penalty examples (the gating set)
# -------------------------------------------------------------------

def test_C4_1_three_yr_vet_flat_30k_cut_march_offseason():
    # 3-yr Veteran flat $30K (TCV $90K), cut March of Y2 (offseason after Y1).
    # Earned through prior March rollover: $30K (Y1 fully sunk).
    # Penalty = (75% × $90K) − $30K = $37.5K.
    penalty = drop_penalty_standard(
        tcv=90_000,
        year_values=[30_000, 30_000, 30_000],
        current_year_index=1,
        cut_month=3,
    )
    assert penalty == 37_500


def test_C4_2_same_three_yr_30k_cut_oct_15():
    # 3-yr $30K, cut Oct 15 (Y1 in-season). Earned = 25% × $30K = $7.5K.
    # Penalty = (75% × $90K) − $7.5K = $60K.
    penalty = drop_penalty_standard(
        tcv=90_000,
        year_values=[30_000, 30_000, 30_000],
        current_year_index=0,
        cut_month=10,
    )
    assert penalty == 60_000


def test_C4_3_three_yr_front_loaded_cut_march_y2():
    # 3-yr Front-Loaded ($40K Y1 / $30K Y2 / $20K Y3, TCV $90K), cut March Y2.
    # Earned through Y1 (played out fully) = ACTUAL Y1 salary = $40K (NOT AAV $30K).
    # Penalty = (75% × $90K) − $40K = $27.5K.
    penalty = drop_penalty_standard(
        tcv=90_000,
        year_values=[40_000, 30_000, 20_000],
        current_year_index=1,
        cut_month=3,
    )
    assert penalty == 27_500


def test_C4_4_one_yr_vet_20k_cut_dec_5():
    # 1-yr Vet $20K, cut December 5. Earned = 75% × $20K = $15K.
    # Penalty = (75% × $20K) − $15K = $0.
    penalty = drop_penalty_standard(
        tcv=20_000,
        year_values=[20_000],
        current_year_index=0,
        cut_month=12,
    )
    assert penalty == 0


def test_C4_5_rookie_15k_three_yr_cut_oct_y2():
    # 1.01 Rookie ($15K flat × 3yr, TCV $45K), cut October Y2.
    # Earned = $15K (Y1 sunk) + 25% × $15K (Y2 Oct) = $18.75K.
    # Penalty = (75% × $45K) − $18.75K = $15K.
    penalty = drop_penalty_standard(
        tcv=45_000,
        year_values=[15_000, 15_000, 15_000],
        current_year_index=1,
        cut_month=10,
    )
    assert penalty == 15_000


def test_C4_6_one_yr_extended_post_rollover_cut_march():
    # 1-yr $25K extended Ext1 (+$10K → ext-yr AAV $35K).
    # TCV at extension = $25K + $35K = $60K (fixed; does NOT reset).
    # Cut March of extension year (original Y1 sunk).
    # Earned = $25K (Y1 actual) + 0% × $35K (March ext year) = $25K.
    # Penalty = (75% × $60K) − $25K = $20K.
    penalty = drop_penalty_standard(
        tcv=60_000,
        year_values=[25_000, 35_000],
        current_year_index=1,
        cut_month=3,
    )
    assert penalty == 20_000


def test_C4_7_ww_25k_in_season():
    # WW $25K pickup picked up Oct 5, dropped Nov 5. WW $5K+ in-season special case.
    # Penalty = 35% × $25K = $8.75K.
    assert drop_penalty_ww_in_season(salary=25_000) == 8_750


def test_C4_8_ww_4k_under_5k_threshold():
    # WW $4K Oct 5, dropped Nov 5. Under $5K threshold — cap-free.
    # Either path returns $0.
    assert drop_penalty_ww_in_season(salary=4_000) == 0
    assert drop_penalty_cap_free() == 0


def test_C4_9_tagged_pre_auction_nullified():
    # Tagged player ($30K tag), cut May before FA Auction starts. Tag nullified.
    # Penalty = $0 (Section 6.C2 cap-free category).
    assert drop_penalty_cap_free() == 0


def test_C4_10_tagged_in_season_oct_15():
    # Tagged player ($30K tag), cut October 15 in-season.
    # Earned = 25% × $30K = $7.5K (10/1–10/31 bucket).
    # Penalty = (75% × $30K) − $7.5K = $15K. Calendar month controls (NOT NFL week).
    # In-season tag cuts use the standard formula; treat the tag as a 1-yr $30K contract.
    penalty = drop_penalty_standard(
        tcv=30_000,
        year_values=[30_000],
        current_year_index=0,
        cut_month=10,
    )
    assert penalty == 15_000


# -------------------------------------------------------------------
# Section 6.C2 — cap-free categories
# -------------------------------------------------------------------

def test_cap_free_returns_zero():
    assert drop_penalty_cap_free() == 0


# -------------------------------------------------------------------
# Section 6.C3 — WW $5K+ in-season formula band
# -------------------------------------------------------------------

@pytest.mark.parametrize("salary,expected", [
    (5_000, 1_750),    # Section 6.C3 table
    (25_000, 8_750),   # Section 6.C3 table
    (50_000, 17_500),  # Section 6.C3 table
])
def test_ww_in_season_band(salary, expected):
    assert drop_penalty_ww_in_season(salary) == expected


# -------------------------------------------------------------------
# Section 6.E — Trade cap money
# -------------------------------------------------------------------

def test_E1_max_trade_cap_money_single():
    # 50% of own outgoing player salary.
    assert max_trade_cap_money([10_000]) == 5_000
    assert max_trade_cap_money([8_000]) == 4_000


def test_E1_max_trade_cap_money_multi_player_sum():
    # Multi-player trade: 50% of SUM of outgoing salaries (Keith v10).
    assert max_trade_cap_money([10_000, 6_000]) == 8_000


def test_E4_worked_trade_with_cap_money():
    # Owner A trades Player X ($10K) + 2026 R3 to Owner B
    # for Player Y ($8K) + cap money.
    # Owner A could send up to 50% × $10K = $5K (based on Player X).
    # Owner B could send up to 50% × $8K = $4K (based on Player Y).
    # Owner B can therefore send AT MOST $4K — NOT $5K.
    assert max_trade_cap_money([10_000]) == 5_000  # what A could send
    assert max_trade_cap_money([8_000]) == 4_000  # what B could send
    assert validate_trade_cap_money([8_000], 4_000)
    assert not validate_trade_cap_money([8_000], 5_000)


# -------------------------------------------------------------------
# Section 6.F — Available cap + max bid
# -------------------------------------------------------------------

def test_F1_single_position_need():
    # Owner has 26 active, $230K committed, $0 outstanding.
    # available_cap = $300K − $230K = $70K
    # max_bid = $70K − ($1K × 1) = $69K
    state = FranchiseCapState(active_roster_salaries=230_000)
    avail = compute_available_cap(state)
    assert avail == 70_000
    assert roster_slots_needed(active_player_count=26) == 1
    assert max_bid_remaining(avail, 1) == 69_000


def test_F2_multi_position_need():
    # Owner has 26 active but needs 2 RBs + 1 flex (3 more roster spots).
    # available_cap = $300K − $230K = $70K
    # max_bid = $70K − ($1K × 3) = $67K
    state = FranchiseCapState(active_roster_salaries=230_000)
    avail = compute_available_cap(state)
    slots = roster_slots_needed(active_player_count=26, min_positional_gaps=3)
    assert slots == 3  # binds on positional gap, not on (27-26)=1
    assert max_bid_remaining(avail, slots) == 67_000


def test_F_negative_available_cap_offseason():
    # Pre-FA-Auction: ceiling doesn't apply. Owner can be over $300K committed.
    state = FranchiseCapState(active_roster_salaries=320_000)
    assert compute_available_cap(state) == -20_000


def test_F_with_ir_refunds_and_adjustments():
    # $300K - $250K active + $5K IR refund + $3K positive adj - $2K outstanding = $56K
    state = FranchiseCapState(
        active_roster_salaries=250_000,
        ir_refunds=5_000,
        positive_adjustments=3_000,
        outstanding_charges=2_000,
    )
    assert compute_available_cap(state) == 56_000


# -------------------------------------------------------------------
# Constants sanity
# -------------------------------------------------------------------

def test_constants():
    assert CAP_CEILING == 300_000
    assert CAP_FLOOR == 260_000


# -------------------------------------------------------------------
# salary_earned helper — sanity
# -------------------------------------------------------------------

def test_salary_earned_prior_years_sum_at_full():
    # 3-yr $30K, current_year_index=2, cut Nov of Y3 → Y1+Y2 sunk + 50% × Y3
    earned = salary_earned([30_000, 30_000, 30_000], current_year_index=2, cut_month=11)
    assert earned == 30_000 + 30_000 + 15_000


def test_salary_earned_post_season_y1():
    # 1-yr $20K, cut January (1) — fully earned (post-season end).
    assert salary_earned([20_000], current_year_index=0, cut_month=1) == 20_000


def test_salary_earned_index_out_of_range():
    with pytest.raises(ValueError):
        salary_earned([30_000, 30_000], current_year_index=5, cut_month=10)
