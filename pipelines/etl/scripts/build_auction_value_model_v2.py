#!/usr/bin/env python3
"""Build auction value model v2 — era + regime + tier-aware market factors
plus signal-layer modifiers from advanced datasets.

Calibration history (Keith 2026-04-25 / 2026-04-26 deep dives):

  1. ERA: SF + TE-prem started 2022. v1 had 2023 — off by one.

  2. COMPRESSION CURVE: tier-aware (FOMO mid, deflation top). Tier-1 ($60k+)
     deflation is n=3 ADP-mispriced; true tier-1 SF QBs never auctioned.

  3. REGIME: whole-market QB demand by season pool supply. 2026 = HIGH_DEMAND
     (4 tier-1 QBs FA simultaneously).

  4. TIER-AWARE regime multiplier: tier-1 ($25k+) absorbs demand spike most.

  5. CAP CLIP at 30% of cap to prevent blowups.

  6. FALLBACK UPLIFT 2.0× when ADP missing.

Signal-layer modifiers (added 2026-04-26 after pbp/ff_opportunity/Vegas ETL):

  7. FPOE-per-game modifier — fade overperformers (stickiness only 0.16 →
     mostly variance). Capped ±8%. From nfl_player_ff_opportunity_season.

  8. VEGAS implied total (Week-1 only — preseason proxy r=0.35 stickiness).
     High-implied teams +3-5%; low-implied -5-7%. From nfl_team_vegas_weekly.

  9. PROE modifier — team pass-rate-over-expected. WR/TE benefit from high
     PROE; RB inverse. Cap ±3%. From nfl_team_pbp_season.

  10. AGE CURVE — RB age 28+ steep decline; TE 30+ inflection; QB 37+ cliff;
      WR 32+ decline. Computed from yoy_player_signals.age_at_season.

All modifiers combined as multiplicative `signal_factor`, capped to
[0.65, 1.20] to prevent over-correction in compounding edge cases.

This script reads `auction_player_value_model_v1` and writes
`auction_player_value_model_v2` with the original 4 cols PLUS the new
signal columns: fpoe_per_g, vegas_implied_w1, team_proe, age_at_season,
signal_factor, expected_auction_bid_pre_signal.

Run after build_auction_value_model.py:
  python3 pipelines/etl/scripts/build_auction_value_model_v2.py --validate
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

SF_ERA_START = 2022  # SF (1→1-2 QB) + TE-prem (1-3→1-4 TE) launched

POSITION_INFLATION = {
    "PRE_SF": {
        "QB": 1.33, "RB": 1.33, "WR": 1.49, "TE": 1.35,
        "LB": 1.75, "DE": 2.22, "DT": 2.04, "S": 2.05, "CB": 2.0,
        "PK": 1.0, "PN": 1.0, "DEFAULT": 1.4,
    },
    "SF_TE_PREM": {
        "QB": 1.93, "RB": 1.82, "WR": 1.18, "TE": 1.48,
        "LB": 1.16, "DE": 2.27, "DT": 2.04, "S": 2.05, "CB": 2.0,
        "PK": 1.0, "PN": 1.0, "DEFAULT": 1.4,
    },
}

ERA_OVERALL_MEDIAN = {"PRE_SF": 1.40, "SF_TE_PREM": 1.40}

COMPRESSION_CURVE = {
    "PRE_SF": [
        (0,      5_000,  1.55),
        (5_000,  10_000, 1.40),
        (10_000, 20_000, 1.35),
        (20_000, 35_000, 1.20),
        (35_000, 60_000, 1.00),
        (60_000, 1e12,   0.75),
    ],
    "SF_TE_PREM": [
        (0,      5_000,  1.85),  # bottom tier: FOMO
        (5_000,  10_000, 1.48),
        (10_000, 20_000, 1.65),
        (20_000, 35_000, 1.25),
        (35_000, 60_000, 1.00),
        (60_000, 1e12,   0.60),  # n=3 in dataset, mostly ADP-mispriced
    ],
}

# Auction regime — tier-1 supply × demand structure of the year's pool.
REGIME_BY_SEASON = {
    2018: "COOL", 2019: "COOL", 2020: "COOL",
    2021: "MODERATE", 2022: "LAUNCH_HIGH", 2023: "MODERATE",
    2024: "COOL", 2025: "MODERATE",
    2026: "HIGH_DEMAND",  # 4 tier-1 QBs FA simultaneously
}

# Tier-aware regime multipliers. (tier_1, tier_2, tier_3) keyed by
# perceived value:  tier_1 ≥ $25k, tier_2 $10-25k, tier_3 < $10k.
REGIME_QB_MULTIPLIER = {
    "LAUNCH_HIGH": (1.95, 1.40, 1.15),
    "HIGH_DEMAND": (1.85, 1.30, 1.10),
    "MODERATE":    (1.30, 1.15, 1.05),
    "COOL":        (1.00, 1.00, 1.00),
}

REGIME_SKILL_MULTIPLIER = {
    "LAUNCH_HIGH": (1.20, 1.10, 1.05),
    "HIGH_DEMAND": (1.15, 1.08, 1.03),
    "MODERATE":    (1.05, 1.02, 1.00),
    "COOL":        (1.00, 1.00, 1.00),
}

CAP_CLIP_FRACTION = 0.30
FALLBACK_UPLIFT = 2.0

# Signal-layer modifier limits (compound multiplier capped to this band)
SIGNAL_FACTOR_MIN = 0.65
SIGNAL_FACTOR_MAX = 1.20

YOY_DB = os.getenv("YOY_DB_PATH",
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Documents/mfl/Development/pipelines/etl/data/yoy_signals.db")


def _fpoe_modifier(fpoe_per_g: float | None) -> float:
    """FPOE/g signal — fade overperformers, buy underperformers.

    Stickiness r=0.16 → small effect (mostly variance). Capped ±8%.
    """
    if fpoe_per_g is None:
        return 1.0
    if fpoe_per_g >= 3.0:
        return 0.92
    if fpoe_per_g >= 1.5:
        return 0.96
    if fpoe_per_g <= -3.0:
        return 1.08
    if fpoe_per_g <= -1.5:
        return 1.04
    return 1.0


def _vegas_modifier(implied_total: float | None, position: str | None) -> float:
    """Vegas Week-1 implied total (preseason proxy, stickiness r=0.35).

    Teams favored by Vegas to score more produce more fantasy. QB benefit most.
    """
    if implied_total is None:
        return 1.0
    pos = (position or "").upper()
    if pos == "QB":
        if implied_total >= 25:
            return 1.05
        if implied_total <= 20:
            return 0.93
    elif pos in ("RB", "WR", "TE"):
        if implied_total >= 25:
            return 1.03
        if implied_total <= 20:
            return 0.95
    return 1.0


def _proe_modifier(proe: float | None, position: str | None) -> float:
    """Team PROE → WR/TE benefit, RB inverse. Stickiness r=0.38."""
    if proe is None:
        return 1.0
    pos = (position or "").upper()
    if pos in ("WR", "TE"):
        if proe >= 0.03:
            return 1.03
        if proe <= -0.05:
            return 0.97
    elif pos == "RB":
        if proe >= 0.03:
            return 0.98
        if proe <= -0.05:
            return 1.02
    return 1.0


def _age_modifier(age: int | None, position: str | None) -> float:
    """Position-specific age decline.

    RB 28+ steep, TE 30+ inflection, QB 37+ cliff, WR 32+ decline.
    """
    if not age:
        return 1.0
    pos = (position or "").upper()
    if pos == "QB":
        if age >= 37:
            return 0.85
        if age >= 35:
            return 0.92
    elif pos == "RB":
        if age >= 30:
            return 0.78
        if age >= 28:
            return 0.88
        if age >= 27:
            return 0.94
    elif pos == "WR":
        if age >= 33:
            return 0.85
        if age >= 31:
            return 0.94
    elif pos == "TE":
        if age >= 31:
            return 0.85
        if age >= 30:
            return 0.92
    return 1.0


def signal_factor(fpoe_per_g, implied_total, proe, age, position):
    """Combine all signal modifiers, capped to band."""
    f = (_fpoe_modifier(fpoe_per_g)
         * _vegas_modifier(implied_total, position)
         * _proe_modifier(proe, position)
         * _age_modifier(age, position))
    return max(SIGNAL_FACTOR_MIN, min(SIGNAL_FACTOR_MAX, f))


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def era_for(season: int) -> str:
    return "SF_TE_PREM" if season >= SF_ERA_START else "PRE_SF"


def regime_for(season: int) -> str:
    return REGIME_BY_SEASON.get(season, "MODERATE")


def compression_factor(perceived: float, era: str) -> float:
    curve = COMPRESSION_CURVE.get(era, COMPRESSION_CURVE["SF_TE_PREM"])
    for lo, hi, factor in curve:
        if lo <= perceived < hi:
            return factor
    return 1.0


def position_modulator(season: int, position: str | None) -> float:
    era = era_for(season)
    base = POSITION_INFLATION[era].get(
        (position or "").upper(), POSITION_INFLATION[era]["DEFAULT"]
    )
    overall = ERA_OVERALL_MEDIAN[era]
    if overall <= 0:
        return 1.0
    return base / overall


def _tier_of(perceived: float) -> int:
    if perceived >= 25_000: return 0   # tier-1
    if perceived >= 10_000: return 1   # tier-2
    return 2                            # tier-3


def market_factor(season: int, position: str | None,
                   perceived: float) -> tuple[float, float, float, str]:
    """Combined market factor.

    Returns (compression, position_modulator, combined, regime).
      For QB: regime QB-multiplier (tier-aware)
      For RB/WR/TE: regime skill-multiplier (tier-aware)
      For IDP (DE/DT/LB/S/CB): position_modulator (regime doesn't apply)
      For PK/PN: no adjustment beyond compression
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
        regime_mult = 1.0  # IDP/PK/PN don't follow the QB/skill regime

    combined = round(comp * pmod * regime_mult, 4)
    return comp, pmod, combined, regime


def get_team_cap(conn: sqlite3.Connection, season: int) -> float:
    row = conn.execute(
        "SELECT cap_per_team FROM auction_value_summary_v1 WHERE season=?",
        (season,)
    ).fetchone()
    if row and row[0]:
        return float(row[0])
    return 300_000.0


def ensure_v2_table(conn: sqlite3.Connection) -> None:
    conn.execute("DROP TABLE IF EXISTS auction_player_value_model_v2")
    conn.execute("""
        CREATE TABLE auction_player_value_model_v2 (
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
          perceived_value_v1            REAL,
          era                           TEXT,
          regime                        TEXT,
          inflation_factor              REAL,
          cap_clip_applied              INTEGER NOT NULL DEFAULT 0,
          fallback_uplift_applied       INTEGER NOT NULL DEFAULT 0,
          perceived_value_v2            REAL,
          expected_auction_bid_pre_signal REAL,
          fpoe_per_g                    REAL,
          vegas_implied_w1              REAL,
          team_proe                     REAL,
          age_at_season                 INTEGER,
          signal_factor                 REAL,
          expected_auction_bid          REAL,
          value_delta_vs_winning_bid_v2 REAL,
          winning_bid_to_value_ratio_v2 REAL,
          generated_at_utc     TEXT NOT NULL,
          PRIMARY KEY (season, player_id)
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_av2_season_pos "
        "ON auction_player_value_model_v2 (season, position)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_av2_season_bid "
        "ON auction_player_value_model_v2 (season, expected_auction_bid)"
    )
    conn.commit()


def _preload_signals(conn: sqlite3.Connection) -> dict:
    """Load FPOE / Vegas / PROE / age into in-memory dicts keyed for fast lookup."""
    out = {
        'fpoe': {},        # (mfl_pid, season) -> fpoe_per_g
        'vegas': {},       # (team, season) -> week-1 implied total
        'proe': {},        # (team, season) -> proe
        'age': {},         # (mfl_pid, season) -> age
        'mfl_to_gsis': {}, # mfl_pid -> gsis_id
        'gsis_to_team': {},# (gsis, season) -> team
    }
    # Crosswalk
    for r in conn.execute(
        "SELECT mfl_player_id, gsis_id FROM player_id_crosswalk WHERE gsis_id IS NOT NULL"
    ):
        out['mfl_to_gsis'][str(r[0])] = r[1]
    # FPOE per game (player-season)
    for r in conn.execute(
        "SELECT gsis_id, season, fpoe_per_g FROM nfl_player_ff_opportunity_season "
        "WHERE fpoe_per_g IS NOT NULL"
    ):
        out['fpoe'][(r[0], r[1])] = r[2]
    # Vegas Week-1 implied total per (team, season)
    for r in conn.execute(
        "SELECT team, season, implied_total FROM nfl_team_vegas_weekly "
        "WHERE week=1 AND implied_total IS NOT NULL"
    ):
        out['vegas'][(r[0], r[1])] = r[2]
    # PROE per (team, season)
    for r in conn.execute(
        "SELECT team, season, proe FROM nfl_team_pbp_season WHERE proe IS NOT NULL"
    ):
        out['proe'][(r[0], r[1])] = r[2]
    # Player's NFL team for that season (max-week assignment)
    for r in conn.execute(
        "SELECT gsis_id, season, team FROM nfl_player_weekly "
        "WHERE team IS NOT NULL GROUP BY gsis_id, season HAVING MAX(week)"
    ):
        out['gsis_to_team'][(r[0], r[1])] = r[2]
    return out


def _load_ages_from_yoy(yoy_path: str) -> dict:
    """Load (mfl_pid, season) -> age_at_season from yoy_signals.db."""
    out = {}
    if not Path(yoy_path).exists():
        return out
    conn = sqlite3.connect(yoy_path)
    try:
        for r in conn.execute(
            "SELECT player_id, year, age_at_season FROM yoy_player_signals "
            "WHERE age_at_season IS NOT NULL"
        ):
            out[(str(r[0]), r[1])] = r[2]
    finally:
        conn.close()
    return out


def build(conn: sqlite3.Connection, verbose: bool) -> int:
    ensure_v2_table(conn)

    src_rows = conn.execute("""
        SELECT season, player_id, player_name, position, nfl_team,
               available_in_auction, won_ind, winner_franchise_id, winner_team_name,
               winning_bid, first_bid_ts, first_bid_datetime,
               last_cut_ts, last_cut_datetime, auction_window,
               last_move_before_first_bid, last_move_method_before_first_bid,
               normalized_adp, mfl_average_pick, normalization_source,
               weight, perceived_value_from_spend
          FROM auction_player_value_model_v1
    """).fetchall()

    if not src_rows:
        print("auction_player_value_model_v1 is empty — run v1 first")
        return 0

    # Pre-load all signal sources for fast lookup during loop
    signals = _preload_signals(conn)
    ages = _load_ages_from_yoy(YOY_DB)

    cap_by_season: dict[int, float] = {}
    inserts = []
    n_capped = 0
    n_fallback_uplift = 0
    n_signal_applied = 0
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

        pv = float(perceived_v1 or 0)

        fallback_applied = 0
        if norm_src == "fallback_missing_adp" and pv > 0:
            pv = pv * FALLBACK_UPLIFT
            fallback_applied = 1
            n_fallback_uplift += 1

        cap_clip_applied = 0
        if pv > cap_clip:
            pv = cap_clip
            cap_clip_applied = 1
            n_capped += 1

        pv_v2 = round(pv, 2)

        comp, pmod, infl, regime = market_factor(int(season), position, pv_v2)
        expected_bid_pre = round(pv_v2 * infl, 2) if pv_v2 > 0 else 0.0
        if expected_bid_pre > cap * 0.50:
            expected_bid_pre = round(cap * 0.50, 2)

        # Look up signal inputs
        gsis = signals['mfl_to_gsis'].get(str(pid))
        team_for_signals = signals['gsis_to_team'].get((gsis, int(season))) if gsis else None
        # Fall back to nfl_team field from v1 row
        if not team_for_signals and nfl_team:
            team_for_signals = nfl_team
        fpoe_pg = signals['fpoe'].get((gsis, int(season))) if gsis else None
        vegas_w1 = signals['vegas'].get((team_for_signals, int(season))) if team_for_signals else None
        proe_team = signals['proe'].get((team_for_signals, int(season))) if team_for_signals else None
        age_val = ages.get((str(pid), int(season)))

        sig = signal_factor(fpoe_pg, vegas_w1, proe_team, age_val, position)
        if sig != 1.0:
            n_signal_applied += 1
        expected_bid = round(expected_bid_pre * sig, 2)

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
            pv_v2, expected_bid_pre,
            fpoe_pg, vegas_w1, proe_team, age_val, round(sig, 4),
            expected_bid, delta_v2, ratio_v2,
            now,
        ))

    conn.executemany("""
        INSERT INTO auction_player_value_model_v2 (
            season, player_id, player_name, position, nfl_team,
            available_in_auction, won_ind, winner_franchise_id, winner_team_name,
            winning_bid, first_bid_ts, first_bid_datetime, last_cut_ts, last_cut_datetime,
            auction_window, last_move_before_first_bid, last_move_method_before_first_bid,
            normalized_adp, mfl_average_pick, normalization_source, weight,
            perceived_value_v1,
            era, regime, inflation_factor, cap_clip_applied, fallback_uplift_applied,
            perceived_value_v2, expected_auction_bid_pre_signal,
            fpoe_per_g, vegas_implied_w1, team_proe, age_at_season, signal_factor,
            expected_auction_bid,
            value_delta_vs_winning_bid_v2, winning_bid_to_value_ratio_v2,
            generated_at_utc
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    """, inserts)
    conn.commit()
    print(f"v2: wrote {len(inserts)} rows  "
          f"(cap-clipped {n_capped}, fallback-uplifted {n_fallback_uplift}, "
          f"signal-adjusted {n_signal_applied})")
    return len(inserts)


def validation_report(conn: sqlite3.Connection) -> None:
    import statistics
    print("\nv2 accuracy by season (won, ≥ $5k):")
    print(f"  {'season':<8}{'regime':<14}{'n':>5}{'med_abs_err':>13}{'mean_abs_err':>13}{'med_pct_err':>13}")
    for season in range(2018, 2026):
        rs = conn.execute("""
            SELECT expected_auction_bid, winning_bid FROM auction_player_value_model_v2
             WHERE season=? AND won_ind=1 AND winning_bid>=5000 AND expected_auction_bid>0
        """, (season,)).fetchall()
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
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--validate", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db_path, timeout=30.0)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        n = build(conn, args.verbose)
        if args.validate and n > 0:
            validation_report(conn)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
