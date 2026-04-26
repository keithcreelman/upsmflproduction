#!/usr/bin/env python3
"""Build auction value model v2 — era-aware + cap-clipped + inflation-adjusted.

V1 issues this fixes (Keith 2026-04-25):

  1. No upper-bound clipping. Top-ADP RBs in the early 2010s got computed
     perceived values >$300k (above the $300k team cap), driving 0.17-0.30×
     'underpay' artifacts. V2 clips perceived_value at 30% of league cap.

  2. Hardcoded `superflex_start_year=2023`. Actual league regime change
     was 2022 (QB starter slots went 1 → 1-2, TE 1-3 → 1-4). V2 uses 2022.

  3. No accounting for the systematic gap between ADP-implied value and
     actual auction price. In this league, QBs auction at 1.93× perceived
     value in the SF era (vs 1.33× pre-SF). V2 adds an empirically-derived
     `expected_auction_bid` column = perceived_value × era×position
     inflation factor. This is the actual market-price expectation.

  4. `fallback_missing_adp` players had median ratio 2.27× — model
     systematically underprices them. V2 applies a 2.0× safety floor
     to fallback rows to better reflect their auction-time value.

Era × position inflation factors (computed empirically from won auctions
≥ $5k in real Jul/Aug auction windows, post-perceived-value calibration):

  PRE_SF era (2011-2021):
    QB: 1.33   RB: 1.33   WR: 1.49   TE: 1.35
    LB: 1.75   DE: 2.22   S: 2.05    DT: 2.04

  SF_TE_PREM era (2022+):
    QB: 1.93 ← +45% jump from superflex roster slots
    RB: 1.82 ← elite scarcity carries over
    WR: 1.18 ← cap shifts away to QB/TE
    TE: 1.48 ← TE premium starter slot
    LB: 1.16   DE: 2.27   S: 2.05    DT: 2.04

Run after build_auction_value_model.py:
  python3 pipelines/etl/scripts/build_auction_value_model_v2.py

Reads:  auction_player_value_model_v1
Writes: auction_player_value_model_v2 (same schema + 4 new cols)
"""
from __future__ import annotations
import argparse
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
DB_DEFAULT = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))

# Era boundaries — verified empirically from MFL metadata_rawrules
# (mfl_scoring_rules in D1) on 2026-04-26.
#   2022: QB superflex starter limit goes 1 → 1-2 (SF era starts)
#   2025: TE-only scoring block adds CC=*1.5 (TE Premium era starts)
# These are SEPARATE rule changes, so the model uses three eras, not two.
SF_START       = 2022   # year 1 of QB superflex
TE_PREM_START  = 2025   # year 1 of TE 1.5 PPR

# Anticipation effect: the rule change is voted on the season before, so
# the prior year's auction may show partial inflation as people prepare
# for the regime shift. Applied at 50% of the position bump for that prior
# year only.
ANTICIPATION_FRACTION = 0.50

# Empirically-derived inflation factors at the position-era level. These
# capture the average bidding inflation for a given era × position. They
# are USEFUL for understanding position-level demand, but they do NOT
# capture the COMPRESSION CURVE — the auction systematically pays less for
# top-tier perceived values (cap pressure prevents 2x bids on $60k players)
# and more for bottom-tier (FOMO on $5k mid-tier guys).
#
# So v2 uses the COMPRESSION_CURVE below as the primary multiplier, and
# applies POSITION_MODULATOR (era-aware position-vs-overall-median delta)
# on top to capture residual position effects.
#
# Era assignment as of 2026-04-26:
#   PRE_SF        2010-2021 — original QB=1, TE 1.0 PPR
#   SF_NO_TE_PREM 2022-2024 — superflex live, TE still 1.0 PPR
#   SF_TE_PREM    2025+     — superflex + TE 1.5 PPR
#
# 2022-2024 calibration is real data (3 seasons of SF auctions).
# 2025+ TE bump is INFERRED — only 1 season of TE-Premium data, so TE
# inflation will refine as 2026/2027 auctions land.

POSITION_INFLATION = {
    "PRE_SF": {
        "QB": 1.33, "RB": 1.33, "WR": 1.49, "TE": 1.35,
        "LB": 1.75, "DE": 2.22, "DT": 2.04, "S": 2.05, "CB": 2.0,
        "PK": 1.0, "PN": 1.0, "DEFAULT": 1.4,
    },
    "SF_NO_TE_PREM": {
        "QB": 1.93, "RB": 1.82, "WR": 1.18, "TE": 1.35,
        "LB": 1.16, "DE": 2.27, "DT": 2.04, "S": 2.05, "CB": 2.0,
        "PK": 1.0, "PN": 1.0, "DEFAULT": 1.4,
    },
    # SF_TE_PREM: same as SF_NO_TE_PREM but TE bumped ~1.5x (1.5 PPR).
    # Keith 2026-04-26: TE will likely climb above 2.00 once a full season
    # of premium data lands; refine via --recompute-factors after 2026 auction.
    "SF_TE_PREM": {
        "QB": 1.93, "RB": 1.82, "WR": 1.18, "TE": 2.00,
        "LB": 1.16, "DE": 2.27, "DT": 2.04, "S": 2.05, "CB": 2.0,
        "PK": 1.0, "PN": 1.0, "DEFAULT": 1.4,
    },
}

# Era-overall median inflation (used to compute position modulator).
# Placeholder 1.40 across all eras — refine via --recompute-factors once
# v1 auction data is available. SF eras likely run higher than PRE_SF
# given QB inflation jump.
ERA_OVERALL_MEDIAN = {
    "PRE_SF":        1.40,
    "SF_NO_TE_PREM": 1.40,
    "SF_TE_PREM":    1.40,
}

# AUCTION REGIME — Keith 2026-04-25 calibration.
# The whole-market QB ratio depends on how many tier-1 QBs are actually
# available in the auction pool. When elites get tagged/traded out of the
# pool, even mid-tier QBs (Mayfield 2025 QB7) sell at deep discounts because
# there's no anchor to set the ceiling. When elites are abundant
# (2022 SF launch), ALL QBs sell at premiums because demand-side scrambling.
#
# Regimes are detected EMPIRICALLY by season median QB ratio:
#   LAUNCH_HIGH:  2022 — multiple top-10 QBs, every team needs 2 (rule change)
#   HIGH_DEMAND:  2026 (projected) — 4 tier-1 QBs (Lamar/Allen/Burrow/Mahomes)
#                  hit FA simultaneously after years of tag/trade lockout
#   MODERATE:     2021/2023/2025 — 1 marquee QB available (Rodgers/Herbert)
#   COOL:         2018-2020/2024 — best available is QB7+, no anchor
#
# Regime multiplier scales the compression-curve output. Applied AFTER
# compression to capture market-wide demand pressure independent of player
# tier.
REGIME_BY_SEASON = {
    2018: "COOL", 2019: "COOL", 2020: "COOL",
    2021: "MODERATE", 2022: "LAUNCH_HIGH", 2023: "MODERATE",
    2024: "COOL", 2025: "MODERATE",
    2026: "HIGH_DEMAND",  # 4 tier-1 QBs hitting FA — see Round 11 analysis
}

# Regime multiplier — TIER-AWARE. The demand pressure in HIGH_DEMAND/LAUNCH
# regimes hits TIER-1 (the elite anchors that everyone wants) much harder
# than it propagates to TIER-2/TIER-3. Empirical 2022 example:
#   Brady QB16 (tier-1 best-available): 4.99×
#   Tua QB10 (tier-1): 4.11×
#   Goff QB20 (tier-2): 2.56×
#   Wentz unranked (tier-3): 2.92× — but small bid ($17k)
# So tier-1 sees 4-5× multiplication, tier-2 ~2.5×, tier-3 ~2× of perceived.
#
# In our model, perceived is already inflated by compression. So the regime
# multiplier just adds the demand-pressure bump on top.
#
# Tier thresholds based on perceived_value:
#   TIER_1: ≥ $25k perceived (Allen/Mahomes/Burrow/Lamar tier)
#   TIER_2: $10-25k (Goff/Stafford/Murray tier)
#   TIER_3: < $10k (backup tier)

REGIME_QB_MULTIPLIER = {
    # tuple = (tier_1, tier_2, tier_3)
    "LAUNCH_HIGH": (1.95, 1.40, 1.15),
    "HIGH_DEMAND": (1.85, 1.30, 1.10),  # 2026
    "MODERATE":    (1.30, 1.15, 1.05),
    "COOL":        (1.00, 1.00, 1.00),
}

REGIME_SKILL_MULTIPLIER = {
    "LAUNCH_HIGH": (1.20, 1.10, 1.05),
    "HIGH_DEMAND": (1.15, 1.08, 1.03),
    "MODERATE":    (1.05, 1.02, 1.00),
    "COOL":        (1.00, 1.00, 1.00),
}


def _tier_of(perceived: float) -> int:
    if perceived >= 25_000: return 0   # tier-1
    if perceived >= 10_000: return 1   # tier-2
    return 2                            # tier-3


def regime_for(season: int) -> str:
    return REGIME_BY_SEASON.get(season, "MODERATE")

# Compression curve — derived empirically from SF-era data 2022-2025.
# Auctions overpay mid-tier and underpay top-tier relative to perceived value.
# Bucket: (low_perceived, high_perceived, compression_factor).
#
# SF_NO_TE_PREM and SF_TE_PREM use the same compression for now — TE Premium
# affects POSITION inflation, not the bucket-level compression behavior. May
# diverge once 2026+ data shows whether TE Premium changes top-tier dynamics.
COMPRESSION_CURVE = {
    "PRE_SF": [
        (0,      5_000,  1.55),
        (5_000,  10_000, 1.40),
        (10_000, 20_000, 1.35),
        (20_000, 35_000, 1.20),
        (35_000, 60_000, 1.00),
        (60_000, 1e12,   0.75),
    ],
    "SF_NO_TE_PREM": [
        (0,      5_000,  1.85),  # bottom tier: FOMO
        (5_000,  10_000, 1.48),
        (10_000, 20_000, 1.65),
        (20_000, 35_000, 1.25),
        (35_000, 60_000, 1.00),  # top tier: cap-pressure parity
        (60_000, 1e12,   0.60),  # extreme top: market disbelieves ADP (Mayfield 2025)
    ],
    "SF_TE_PREM": [
        (0,      5_000,  1.85),
        (5_000,  10_000, 1.48),
        (10_000, 20_000, 1.65),
        (20_000, 35_000, 1.25),
        (35_000, 60_000, 1.00),
        (60_000, 1e12,   0.60),
    ],
}


def compression_factor(perceived: float, era: str) -> float:
    curve = COMPRESSION_CURVE.get(era, COMPRESSION_CURVE["SF_NO_TE_PREM"])
    for lo, hi, factor in curve:
        if lo <= perceived < hi:
            return factor
    return 1.0


def position_modulator(season: int, position: str | None) -> float:
    """How much above/below the era median does this position bid?"""
    era = era_for(season)
    base = POSITION_INFLATION[era].get(
        (position or "").upper(),
        POSITION_INFLATION[era]["DEFAULT"],
    )
    overall = ERA_OVERALL_MEDIAN[era]
    if overall <= 0:
        return 1.0
    return base / overall

# Cap-clip: no single player's perceived value should exceed this fraction
# of the per-team cap. The Peterson / Foster / Ekeler $300k+ blowups were
# all > 60% of cap — clearly impossible auction outcomes.
CAP_CLIP_FRACTION = 0.30

# Hard ceiling: even after inflation × compression, expected_auction_bid
# should never exceed this fraction of cap. Acts as a safety valve when
# market inflation multipliers hit the ceiling. 50% is permissive — auctions
# have never topped ~30% in practice.
EXPECTED_BID_HARD_CEILING = 0.50

# Fallback uplift — when a player has no ADP and falls back to the
# season-pool baseline, v1 systematically underprices them by ~2×.
FALLBACK_UPLIFT = 2.0


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def era_for(season: int) -> str:
    """Three-era mapping driven by actual MFL rule changes.

    PRE_SF        2010-2021  — original QB=1, TE 1.0 PPR
    SF_NO_TE_PREM 2022-2024  — superflex live, TE still 1.0 PPR
    SF_TE_PREM    2025+      — superflex + TE 1.5 PPR
    """
    if season >= TE_PREM_START:
        return "SF_TE_PREM"
    if season >= SF_START:
        return "SF_NO_TE_PREM"
    return "PRE_SF"


def anticipation_for(season: int, position: str | None) -> float:
    """Multiplier capturing pre-regime-change auction inflation.

    The year BEFORE a rule change, owners often pre-load the relevant
    position to lock in lower prices. Returns a small (≤ ANTICIPATION_FRACTION)
    bump applied on top of the prior era's position inflation.

    Currently triggers for:
      season SF_START - 1   on QB    (people stocked QBs in 2021 for 2022 SF)
      season TE_PREM_START - 1 on TE (people stocked TEs in 2024 for 2025 PPR)
    """
    pos = (position or "").upper()
    if season == SF_START - 1 and pos == "QB":
        # ratio = next-era QB inflation / this-era QB inflation
        bump = POSITION_INFLATION["SF_NO_TE_PREM"]["QB"] / POSITION_INFLATION["PRE_SF"]["QB"]
        return 1.0 + (bump - 1.0) * ANTICIPATION_FRACTION
    if season == TE_PREM_START - 1 and pos == "TE":
        bump = POSITION_INFLATION["SF_TE_PREM"]["TE"] / POSITION_INFLATION["SF_NO_TE_PREM"]["TE"]
        return 1.0 + (bump - 1.0) * ANTICIPATION_FRACTION
    return 1.0


def market_factor(season: int, position: str | None, perceived: float) -> tuple[float, float, float, str]:
    """Combined market factor for a single (player, season) row.

    Returns (compression, position_modulator, combined, regime). Multiplies
    perceived_value to get expected_auction_bid.

    Layers (in order):
      1. compression_factor(perceived, era) — bucket-level compression
      2. position_modulator (IDP only — skill positions handled in compression)
      3. regime multiplier — captures whole-market demand pressure based on
         supply of tier-1 talent in the year's pool. Empirically:
           2022 (LAUNCH_HIGH) median QB ratio 2.75
           2023/2025 (MODERATE) median 1.43-1.88
           2024 (COOL) median 1.16
           2026 (projected HIGH_DEMAND) — 4 tier-1 QBs available

    For 2026 the regime captures Keith's correct intuition: when 4 elite
    QBs hit FA simultaneously after years of tag/trade lockout, the WHOLE
    QB market inflates (not just elites). 2025's 0.44× Mayfield wasn't ADP
    misprice — it was demand vacuum from no anchor in the pool. With 4
    anchors in the 2026 pool, the entire QB market re-prices upward.
    """
    era = era_for(season)
    pos_u = (position or "").upper()
    regime = regime_for(season)
    IDP = {"DE", "DT", "LB", "S", "CB"}

    comp = compression_factor(perceived, era)
    if pos_u in IDP:
        pmod = position_modulator(season, position)
    else:
        pmod = 1.0

    tier = _tier_of(perceived)
    if pos_u == "QB":
        regime_tuple = REGIME_QB_MULTIPLIER.get(regime, (1.0, 1.0, 1.0))
        regime_mult = regime_tuple[tier]
    elif pos_u in ("RB", "WR", "TE"):
        regime_tuple = REGIME_SKILL_MULTIPLIER.get(regime, (1.0, 1.0, 1.0))
        regime_mult = regime_tuple[tier]
    else:
        regime_mult = 1.0  # IDP/PK/PN — no regime effect

    # TE Premium multiplier: SF_TE_PREM era boosts TE specifically.
    # position_modulator only fires for IDP, so TE PPR can't show up there;
    # apply directly to all TEs in the TE-Premium era.
    te_prem_mult = 1.0
    if pos_u == "TE" and era == "SF_TE_PREM":
        te_prem_mult = (POSITION_INFLATION["SF_TE_PREM"]["TE"] /
                        POSITION_INFLATION["SF_NO_TE_PREM"]["TE"])

    # Anticipation bump for the year before each rule change (2021 QB, 2024 TE).
    antic = anticipation_for(season, position)

    combined = round(comp * pmod * regime_mult * te_prem_mult * antic, 4)
    return comp, pmod, combined, regime


def cap_pressure_floor(perceived: float, position: str, position_adp_rank: int | None,
                       elite_supply: int, n_needy_teams: int,
                       second_highest_needy_cap: float) -> float | None:
    """Optional override for elite players in cap-pressure auctions.

    When a player is genuinely tier-1 (top-N by position ADP), the bid
    is dominated by cap-pressure between competing needy teams, not by
    ADP-implied perceived value. Returns a floor expected_bid based on
    the 2nd-highest competing needy team's likely allocation.

    Args:
      perceived: ADP-derived perceived value
      position: 'QB', 'RB', 'WR', 'TE'
      position_adp_rank: rank within position by ADP (1 = top)
      elite_supply: count of tier-1 players at this position available
      n_needy_teams: count of teams that NEED this position
      second_highest_needy_cap: $ cap of the 2nd-most-needy team

    Returns the floor expected_bid, or None if player is not tier-1.

    Heuristic — for top-3-by-ADP at scarce positions (where supply
    < demand), the floor is ~30% of the 2nd-highest-needy-team's cap
    times an escalation factor for SF-era frenzy.
    """
    if not position_adp_rank or position_adp_rank > 3:
        return None
    if elite_supply >= n_needy_teams:
        # Not scarce. No floor.
        return None
    # Scarce: 2nd-bidder max + bid escalation
    base_allocation = second_highest_needy_cap * 0.30
    escalation = 1.20  # auction frenzy on a generational class
    floor = base_allocation * escalation
    return round(floor, 2)


def get_team_cap(conn: sqlite3.Connection, season: int) -> float:
    """Pull team cap from auction_value_summary_v1 if present; else default."""
    row = conn.execute(
        "SELECT cap_per_team FROM auction_value_summary_v1 WHERE season=?",
        (season,)
    ).fetchone()
    if row and row[0]:
        return float(row[0])
    return 300_000.0


def compute_inflation_factors(conn: sqlite3.Connection) -> tuple[dict, dict]:
    """Re-derive both POSITION_INFLATION and COMPRESSION_CURVE empirically.

    Returns (position_inflation, compression_curve) where each mirrors the
    constants above. Used to validate the constants against fresh data.

    Filters: won_ind=1, winning_bid >= $5k, perceived_value_from_spend > 0.
    """
    pos_infl: dict[str, dict[str, float]] = {
        "PRE_SF": {}, "SF_NO_TE_PREM": {}, "SF_TE_PREM": {},
    }
    compression: dict[str, list[tuple]] = {
        "PRE_SF": [], "SF_NO_TE_PREM": [], "SF_TE_PREM": [],
    }

    era_windows = [
        ("PRE_SF",        2011, SF_START - 1),
        ("SF_NO_TE_PREM", SF_START, TE_PREM_START - 1),
        ("SF_TE_PREM",    TE_PREM_START, 2099),
    ]
    for era_label, lo_yr, hi_yr in era_windows:
        # Position factors
        rows = conn.execute(
            """
            SELECT position, winning_bid * 1.0 / perceived_value_from_spend AS ratio
              FROM auction_player_value_model_v1
             WHERE won_ind = 1 AND winning_bid >= 5000
               AND perceived_value_from_spend > 0
               AND season BETWEEN ? AND ? AND position IS NOT NULL
            """,
            (lo_yr, hi_yr),
        ).fetchall()
        by_pos: dict[str, list[float]] = {}
        for pos, ratio in rows:
            by_pos.setdefault(pos.upper(), []).append(float(ratio))
        for pos, ratios in by_pos.items():
            ratios.sort()
            if len(ratios) >= 5:
                pos_infl[era_label][pos] = round(ratios[len(ratios) // 2], 2)
        pos_infl[era_label].setdefault("DEFAULT", 1.4)

        # Compression curve
        buckets = [(0, 5_000), (5_000, 10_000), (10_000, 20_000),
                   (20_000, 35_000), (35_000, 60_000), (60_000, 999_999_999)]
        for lo, hi in buckets:
            rs = conn.execute(
                """
                SELECT winning_bid * 1.0 / perceived_value_from_spend AS ratio
                  FROM auction_player_value_model_v1
                 WHERE won_ind = 1 AND winning_bid >= 5000
                   AND perceived_value_from_spend BETWEEN ? AND ?
                   AND season BETWEEN ? AND ?
                """,
                (lo, hi, lo_yr, hi_yr),
            ).fetchall()
            ratios = sorted(r[0] for r in rs)
            if len(ratios) >= 3:
                med = ratios[len(ratios) // 2]
                compression[era_label].append((lo, hi, round(med, 2), len(ratios)))
            else:
                compression[era_label].append((lo, hi, None, len(ratios)))
    return pos_infl, compression


def ensure_v2_table(conn: sqlite3.Connection) -> None:
    # Drop and recreate so schema additions (e.g. `regime`) take effect.
    # The table is fully rebuilt from v1 each run anyway.
    conn.execute("DROP TABLE IF EXISTS auction_player_value_model_v2")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS auction_player_value_model_v2 (
          season               INTEGER NOT NULL,
          player_id            TEXT    NOT NULL,
          player_name          TEXT,
          position             TEXT,
          nfl_team             TEXT,
          available_in_auction INTEGER NOT NULL DEFAULT 1,
          won_ind              INTEGER NOT NULL DEFAULT 0,
          winner_franchise_id  TEXT,
          winner_team_name     TEXT,
          winning_bid          INTEGER,
          first_bid_ts         INTEGER,
          first_bid_datetime   TEXT,
          last_cut_ts          INTEGER,
          last_cut_datetime    TEXT,
          auction_window       TEXT,
          last_move_before_first_bid          TEXT,
          last_move_method_before_first_bid   TEXT,
          normalized_adp       REAL,
          mfl_average_pick     REAL,
          normalization_source TEXT,
          weight               REAL,

          -- v1 baseline (ADP-implied), retained for reference
          perceived_value_v1            REAL,

          -- v2 corrections
          era                           TEXT,
          regime                        TEXT,   -- LAUNCH_HIGH / HIGH_DEMAND / MODERATE / COOL
          inflation_factor              REAL,
          cap_clip_applied              INTEGER NOT NULL DEFAULT 0,
          fallback_uplift_applied       INTEGER NOT NULL DEFAULT 0,
          perceived_value_v2            REAL,   -- ADP-implied with cap-clip + fallback uplift
          expected_auction_bid          REAL,   -- perceived_value_v2 × inflation_factor (the real market price)
          value_delta_vs_winning_bid_v2 REAL,
          winning_bid_to_value_ratio_v2 REAL,

          generated_at_utc     TEXT NOT NULL,

          PRIMARY KEY (season, player_id)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_av2_season_pos "
        "ON auction_player_value_model_v2 (season, position)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_av2_season_bid "
        "ON auction_player_value_model_v2 (season, expected_auction_bid)"
    )
    conn.commit()


def build(conn: sqlite3.Connection, recompute_factors: bool, verbose: bool) -> int:
    if recompute_factors:
        pos_infl, compression = compute_inflation_factors(conn)
        if verbose:
            print("Empirically recomputed factors:")
            for era, by_pos in pos_infl.items():
                pos_str = ", ".join(f"{p}={v}" for p, v in sorted(by_pos.items()))
                print(f"  POSITION_INFLATION {era}: {pos_str}")
            print()
            for era, buckets in compression.items():
                print(f"  COMPRESSION_CURVE {era}:")
                for lo, hi, med, n in buckets:
                    hi_s = "inf" if hi >= 999_999_999 else f"${hi:,.0f}"
                    med_s = f"{med:.2f}" if med is not None else "—"
                    print(f"    ${lo:>7,} – {hi_s:<10} med={med_s}  n={n}")
            print()
            print("(These are computed from data. The INFLATION + COMPRESSION_CURVE")
            print(" constants above are source-of-truth — update them if you want")
            print(" the recomputed values to apply.)")

    ensure_v2_table(conn)
    conn.execute("DELETE FROM auction_player_value_model_v2")

    # Pull v1 rows we want to upgrade
    src_rows = conn.execute(
        """
        SELECT season, player_id, player_name, position, nfl_team,
               available_in_auction, won_ind, winner_franchise_id, winner_team_name,
               winning_bid, first_bid_ts, first_bid_datetime,
               last_cut_ts, last_cut_datetime, auction_window,
               last_move_before_first_bid, last_move_method_before_first_bid,
               normalized_adp, mfl_average_pick, normalization_source,
               weight, perceived_value_from_spend
          FROM auction_player_value_model_v1
        """
    ).fetchall()

    if not src_rows:
        print("auction_player_value_model_v1 is empty — run build_auction_value_model.py first")
        return 0

    cap_by_season: dict[int, float] = {}

    inserts = []
    n_capped = 0
    n_fallback_uplift = 0
    now = now_utc()
    for r in src_rows:
        (season, pid, pname, position, nfl_team, avail, won, win_fid, win_team,
         win_bid, fbts, fbdt, lcts, lcdt, awnd, lmbf, lmmbf,
         norm_adp, mfl_avg, norm_src, weight, perceived_v1) = r

        era = era_for(int(season))

        if season not in cap_by_season:
            cap_by_season[season] = get_team_cap(conn, int(season))
        cap = cap_by_season[season]
        cap_clip = cap * CAP_CLIP_FRACTION

        # Step 1: start with v1's perceived value (ADP × spend pool slice)
        pv = float(perceived_v1 or 0)

        # Step 2: fallback uplift — when ADP was missing, v1 underprices ~2×
        fallback_applied = 0
        if norm_src == "fallback_missing_adp" and pv > 0:
            pv = pv * FALLBACK_UPLIFT
            fallback_applied = 1
            n_fallback_uplift += 1

        # Step 3: cap clip — no single player should exceed 30% of cap
        cap_clip_applied = 0
        if pv > cap_clip:
            pv = cap_clip
            cap_clip_applied = 1
            n_capped += 1

        pv_v2 = round(pv, 2)

        # Step 4: apply compression curve × position modulator × regime
        # multiplier for market price. Compression handles per-bucket pricing,
        # position modulator handles IDP overpay, regime captures whole-market
        # demand pressure (2022/2026 = high demand, 2024 = cool).
        comp, pmod, infl, regime = market_factor(int(season), position, pv_v2)
        expected_bid = round(pv_v2 * infl, 2) if pv_v2 > 0 else 0.0
        # Hard ceiling: expected_bid should not exceed EXPECTED_BID_HARD_CEILING
        # of cap. Safety valve against inflation runaway.
        if expected_bid > cap * EXPECTED_BID_HARD_CEILING:
            expected_bid = round(cap * EXPECTED_BID_HARD_CEILING, 2)

        delta_v2 = None
        ratio_v2 = None
        if win_bid is not None and pv_v2 > 0:
            delta_v2 = round(pv_v2 - float(win_bid), 2)
            ratio_v2 = round(float(win_bid) / pv_v2, 4)

        inserts.append((
            season, pid, pname, position, nfl_team,
            avail, won, win_fid, win_team, win_bid,
            fbts, fbdt, lcts, lcdt, awnd, lmbf, lmmbf,
            norm_adp, mfl_avg, norm_src, weight,
            round(perceived_v1 or 0, 2),
            era, regime, infl, cap_clip_applied, fallback_applied,
            pv_v2, expected_bid, delta_v2, ratio_v2,
            now,
        ))

    conn.executemany(
        """
        INSERT INTO auction_player_value_model_v2 (
            season, player_id, player_name, position, nfl_team,
            available_in_auction, won_ind, winner_franchise_id, winner_team_name,
            winning_bid, first_bid_ts, first_bid_datetime, last_cut_ts, last_cut_datetime,
            auction_window, last_move_before_first_bid, last_move_method_before_first_bid,
            normalized_adp, mfl_average_pick, normalization_source, weight,
            perceived_value_v1,
            era, regime, inflation_factor, cap_clip_applied, fallback_uplift_applied,
            perceived_value_v2, expected_auction_bid,
            value_delta_vs_winning_bid_v2, winning_bid_to_value_ratio_v2,
            generated_at_utc
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """,
        inserts,
    )
    conn.commit()
    print(f"v2: wrote {len(inserts)} rows  "
          f"(cap-clipped {n_capped}, fallback-uplifted {n_fallback_uplift})")
    return len(inserts)


def validation_report(conn: sqlite3.Connection) -> None:
    """Compare v2 expected_auction_bid against actual winning_bid for 2025
    AND show 2022 LAUNCH_HIGH regime for comparison."""
    for season, label in [(2022, "2022 LAUNCH_HIGH"), (2025, "2025 MODERATE")]:
        print(f"\nValidation: {season} expected_auction_bid vs actual (won, ≥$5k, {label})")
        print(f"  {'name':<22}{'pos':<5}{'regime':<13}{'pv_v2':>8}{'infl':>5}{'expected':>10}{'actual':>9}{'gap':>9}{'gap%':>7}")
        rows = conn.execute(
            """
            SELECT player_name, position, regime, perceived_value_v2, inflation_factor,
                   expected_auction_bid, winning_bid
              FROM auction_player_value_model_v2
             WHERE season = ? AND won_ind = 1 AND winning_bid >= 5000
             ORDER BY winning_bid DESC
             LIMIT 15
            """,
            (season,)
        ).fetchall()
        for r in rows:
            name, pos, regime, pv, infl, exp, actual = r
            gap = actual - (exp or 0)
            gap_pct = (gap / actual * 100) if actual else 0
            print(f"  {(name or '?')[:21]:<22}{(pos or '?'):<5}{regime:<13}"
                  f"{(pv or 0):>8.0f}{(infl or 0):>5.2f}{(exp or 0):>10.0f}{actual:>9}{gap:>+9.0f}{gap_pct:>+7.1f}")
    # Aggregate accuracy by season (2018+, era-aware)
    import statistics
    print()
    print("v2 accuracy by season (won, ≥ $5k):")
    print(f"  {'season':<8}{'regime':<14}{'n':>5}{'med_abs_err':>13}{'mean_abs_err':>13}{'med_pct_err':>13}")
    for season in range(2018, 2026):
        rs = conn.execute(
            """SELECT expected_auction_bid, winning_bid FROM auction_player_value_model_v2
               WHERE season=? AND won_ind=1 AND winning_bid>=5000 AND expected_auction_bid>0""",
            (season,)
        ).fetchall()
        if not rs: continue
        abs_errs = [abs(actual - exp) for exp, actual in rs]
        pct_errs = [abs(actual - exp) / actual for exp, actual in rs]
        regime = REGIME_BY_SEASON.get(season, "?")
        print(f"  {season:<8}{regime:<14}{len(rs):>5}"
              f"${statistics.median(abs_errs):>12,.0f}"
              f"${statistics.mean(abs_errs):>12,.0f}"
              f"{statistics.median(pct_errs)*100:>12.1f}%")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db-path", default=DB_DEFAULT)
    ap.add_argument("--recompute-factors", action="store_true",
                    help="Print empirically-derived inflation factors before building")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--validate", action="store_true",
                    help="Print 2025 validation table after building")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db_path, timeout=30.0)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        n = build(conn, args.recompute_factors, args.verbose)
        if args.validate and n > 0:
            validation_report(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
