#!/usr/bin/env python3
"""Build 2026 auction bid sheet using:
  - adp_consensus 2026 player pool (KTC + FP dynasty + FP redraft consensus)
  - perceived_value derived from historical (position, pos_rank) → winning_bid curve
    fitted on 2022-2025 (SF_TE_PREM era only)
  - era=SF_TE_PREM, regime=HIGH_DEMAND (4 tier-1 QBs FA simultaneously)
  - 2025 prior-year signals: FPOE, Vegas W1 implied, team PROE, age+1

Output: `auction_2026_bid_sheet` table with one row per consensus player,
ranked by expected_auction_bid.

Run:
  python3 pipelines/etl/scripts/build_2026_auction_sheet.py
"""
from __future__ import annotations
import argparse
import datetime as dt
import os
import sqlite3
import sys
import statistics
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

# Reuse signal logic from v2 model
from build_auction_value_model_v2 import (
    signal_factor, market_factor, era_for, regime_for, _tier_of,
    YOY_DB,
)

DB_DEFAULT = os.getenv("MFL_DB_PATH",
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL_Scripts/Datastorage/mfl_database.db")

TARGET_SEASON = 2026
SIGNAL_SEASON = 2025  # use prior year signals (forward-looking)


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def fit_perceived_value_curve(conn: sqlite3.Connection) -> dict:
    """For each position, fit pos_rank → perceived_value curve from historical data.

    Use SF_TE_PREM era seasons (2022-2025) and only winning bids ≥ $1k to avoid
    $0 fillers. Group by position, sort by pos_rank within season, then take the
    median perceived_value at each rank across the 4 seasons.
    """
    rows = conn.execute("""
        SELECT season, position, perceived_value_v2, winning_bid
          FROM auction_player_value_model_v2
         WHERE season >= 2022 AND season <= 2025
           AND perceived_value_v2 > 0
           AND won_ind = 1
    """).fetchall()

    # Per-season ranking within position
    by_pos_rank = defaultdict(list)  # (pos, rank) -> [perceived_values]
    by_season_pos = defaultdict(list)
    for r in rows:
        season, pos, pv, wb = r
        by_season_pos[(season, pos)].append(pv)
    for (season, pos), pvs in by_season_pos.items():
        sorted_pvs = sorted(pvs, reverse=True)
        for rank, pv in enumerate(sorted_pvs, 1):
            by_pos_rank[(pos, rank)].append(pv)

    # Median at each (pos, rank)
    curve = {}
    for (pos, rank), pvs in by_pos_rank.items():
        curve[(pos, rank)] = statistics.median(pvs)
    return curve


def perceived_value_from_consensus(curve: dict, position: str, consensus_pos_rank: int) -> float:
    """Look up perceived value from fitted curve. Fall back to interpolation
    if exact rank not in dict."""
    if not position or not consensus_pos_rank:
        return 0.0
    pos = position.upper()
    if (pos, consensus_pos_rank) in curve:
        return curve[(pos, consensus_pos_rank)]
    # Find nearest rank for this position
    matches = [r for (p, r) in curve.keys() if p == pos]
    if not matches:
        return 0.0
    matches.sort()
    if consensus_pos_rank > matches[-1]:
        # Beyond observed — extrapolate downward (small value)
        return curve.get((pos, matches[-1]), 0) * 0.5
    # Find closest
    nearest = min(matches, key=lambda r: abs(r - consensus_pos_rank))
    return curve.get((pos, nearest), 0)


def preload_signals(conn: sqlite3.Connection, signal_season: int) -> dict:
    out = {
        'fpoe': {},
        'vegas': {},
        'proe': {},
        'mfl_to_gsis': {},
        'gsis_to_team': {},
    }
    for r in conn.execute(
        "SELECT mfl_player_id, gsis_id FROM player_id_crosswalk WHERE gsis_id IS NOT NULL"
    ):
        out['mfl_to_gsis'][str(r[0])] = r[1]
    for r in conn.execute(
        "SELECT gsis_id, fpoe_per_g FROM nfl_player_ff_opportunity_season "
        "WHERE season = ? AND fpoe_per_g IS NOT NULL", (signal_season,)
    ):
        out['fpoe'][r[0]] = r[1]
    for r in conn.execute(
        "SELECT team, implied_total FROM nfl_team_vegas_weekly "
        "WHERE season = ? AND week = 1 AND implied_total IS NOT NULL", (signal_season,)
    ):
        out['vegas'][r[0]] = r[1]
    for r in conn.execute(
        "SELECT team, proe FROM nfl_team_pbp_season "
        "WHERE season = ? AND proe IS NOT NULL", (signal_season,)
    ):
        out['proe'][r[0]] = r[1]
    for r in conn.execute(
        "SELECT gsis_id, team FROM nfl_player_weekly "
        "WHERE season = ? AND team IS NOT NULL "
        "GROUP BY gsis_id HAVING MAX(week)", (signal_season,)
    ):
        out['gsis_to_team'][r[0]] = r[1]
    return out


def load_ages_for_2026(yoy_path: str) -> dict:
    """Get age_at_season=2025, then add 1 for 2026."""
    out = {}
    if not Path(yoy_path).exists():
        return out
    conn = sqlite3.connect(yoy_path)
    try:
        for r in conn.execute(
            "SELECT player_id, age_at_season FROM yoy_player_signals "
            "WHERE year = 2025 AND age_at_season IS NOT NULL"
        ):
            out[str(r[0])] = r[1] + 1  # 2026 age
    finally:
        conn.close()
    return out


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute("DROP TABLE IF EXISTS auction_2026_bid_sheet")
    conn.execute("""
        CREATE TABLE auction_2026_bid_sheet (
            mfl_player_id          TEXT,
            name                   TEXT NOT NULL,
            position               TEXT,
            team_2025              TEXT,
            consensus_rank         INTEGER,
            consensus_pos_rank     INTEGER,
            ktc_overall            INTEGER,
            ktc_value              INTEGER,
            fp_dynasty_overall     INTEGER,
            fp_redraft_overall     INTEGER,
            age_2026               INTEGER,
            fpoe_per_g_2025        REAL,
            vegas_implied_w1_2025  REAL,
            team_proe_2025         REAL,
            era                    TEXT,
            regime                 TEXT,
            perceived_value        REAL,
            inflation_factor       REAL,
            expected_bid_pre_signal REAL,
            signal_factor          REAL,
            expected_bid           REAL,
            tier                   INTEGER,
            generated_at_utc       TEXT NOT NULL
        )
    """)
    conn.execute("CREATE INDEX idx_2026_pos ON auction_2026_bid_sheet (position, expected_bid DESC)")
    conn.execute("CREATE INDEX idx_2026_bid ON auction_2026_bid_sheet (expected_bid DESC)")
    conn.commit()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-path", default=DB_DEFAULT)
    ap.add_argument("--top-n", type=int, default=200, help="how many to print to stdout")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db_path, timeout=30.0)
    conn.execute("PRAGMA busy_timeout=30000")
    try:
        # Load adp_consensus 2026
        consensus = list(conn.execute("""
            SELECT mfl_player_id, name, position, team,
                   consensus_rank, consensus_pos_rank,
                   ktc_overall, ktc_value,
                   fp_dynasty_overall, fp_redraft_overall
              FROM adp_consensus
             WHERE season = ? AND consensus_pos_rank IS NOT NULL
        """, (TARGET_SEASON,)).fetchall())
        print(f"Loaded {len(consensus)} 2026 consensus players")

        # Fit perceived value curve from historical SF era data
        curve = fit_perceived_value_curve(conn)
        print(f"Fit curve has {len(curve)} (position, rank) entries")

        # Preload signals
        signals = preload_signals(conn, SIGNAL_SEASON)
        ages = load_ages_for_2026(YOY_DB)

        ensure_table(conn)
        now = now_utc()
        rows_to_insert = []
        for r in consensus:
            mfl_pid, name, pos, team_consensus, c_rank, c_pos_rank, ktc, ktc_val, fpdy, fpre = r
            if not pos:
                continue

            # Compute perceived value from curve
            pv = perceived_value_from_consensus(curve, pos, c_pos_rank)
            if pv <= 0:
                continue

            # Era + regime + compression + position modulator
            comp, pmod, infl, regime = market_factor(TARGET_SEASON, pos, pv)
            era = era_for(TARGET_SEASON)
            expected_pre = pv * infl

            # Cap clip — 30% cap = $70k for 2026 ($234k)
            cap = 234_000.0
            cap_clip = cap * 0.30
            if expected_pre > cap_clip:
                expected_pre = cap_clip

            # Lookup signals — try mfl crosswalk first
            gsis = signals['mfl_to_gsis'].get(str(mfl_pid)) if mfl_pid else None
            team_for_sig = signals['gsis_to_team'].get(gsis) if gsis else (team_consensus or None)
            fpoe = signals['fpoe'].get(gsis) if gsis else None
            vegas = signals['vegas'].get(team_for_sig) if team_for_sig else None
            proe = signals['proe'].get(team_for_sig) if team_for_sig else None
            age = ages.get(str(mfl_pid)) if mfl_pid else None

            sig = signal_factor(fpoe, vegas, proe, age, pos)
            expected_bid = round(expected_pre * sig, 0)
            tier = _tier_of(pv)

            rows_to_insert.append((
                mfl_pid, name, pos, team_for_sig, c_rank, c_pos_rank,
                ktc, ktc_val, fpdy, fpre,
                age, fpoe, vegas, proe,
                era, regime,
                round(pv, 0), round(infl, 4),
                round(expected_pre, 0),
                round(sig, 4),
                expected_bid,
                tier + 1,  # 1-indexed for readability
                now,
            ))

        conn.executemany("""
            INSERT INTO auction_2026_bid_sheet (
                mfl_player_id, name, position, team_2025, consensus_rank, consensus_pos_rank,
                ktc_overall, ktc_value, fp_dynasty_overall, fp_redraft_overall,
                age_2026, fpoe_per_g_2025, vegas_implied_w1_2025, team_proe_2025,
                era, regime, perceived_value, inflation_factor,
                expected_bid_pre_signal, signal_factor, expected_bid, tier,
                generated_at_utc
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, rows_to_insert)
        conn.commit()
        print(f"Wrote {len(rows_to_insert)} rows to auction_2026_bid_sheet")

        # Print top-N to stdout for quick review
        print(f"\nTop {args.top_n} by expected_bid:")
        print(f"  {'rank':<5}{'pos':<5}{'name':<26}{'team':<5}{'age':>5}{'cons':>6}{'pre':>9}{'sig':>7}{'BID':>9}")
        rows = conn.execute("""
            SELECT name, position, team_2025, age_2026, consensus_pos_rank,
                   expected_bid_pre_signal, signal_factor, expected_bid
              FROM auction_2026_bid_sheet
             ORDER BY expected_bid DESC LIMIT ?
        """, (args.top_n,)).fetchall()
        for i, r in enumerate(rows, 1):
            name, pos, team, age, c_rank, pre, sig, bid = r
            tm = (team or '?')[:4]
            print(f"  {i:<5}{(pos or ''):<5}{(name or '')[:25]:<26}{tm:<5}"
                  f"{(age or 0):>5}{(c_rank or 0):>6}${pre:>8.0f}{sig:>7.3f}${bid:>8.0f}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
