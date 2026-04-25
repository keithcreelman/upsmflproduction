#!/usr/bin/env python3
"""Compute year-over-year stickiness for per-position player stats.

For each (position, metric), correlate the metric in season N with the same
metric in season N+1 across every (player, consecutive-season-pair) where the
player meets a games-played threshold in both seasons. Output one row per
(position, metric, min_games) into the `metric_stickiness` table.

Phase 1 scope: QB only. See ~/.claude/plans/can-we-plan-out-dynamic-rocket.md
for the full plan and Phase 2/3 follow-ups.

Usage:
  python3 pipelines/etl/scripts/build_stickiness_report.py
  python3 pipelines/etl/scripts/build_stickiness_report.py --min-games 12
  python3 pipelines/etl/scripts/build_stickiness_report.py --position QB --min-season 2015
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
DB_DEFAULT = os.getenv(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
)


# ─────────────────────────────────────────────────────────────────────────────
# Metric definitions
# ─────────────────────────────────────────────────────────────────────────────
# Each metric is computed from per-season totals. Rate metrics use sum(num) /
# sum(denom) — NOT the average of weekly rates. A metric returns None for a
# (player, season) when its denominator is missing/zero; those players are
# excluded from that metric's pair list (but may still contribute to others).

VOLUME_METRICS_QB = [
    "pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks",
    "rush_att", "rush_yds", "rush_tds",
]


def _safe_div(num, den):
    if den is None or den == 0:
        return None
    return num / den


def derive_metrics_qb(totals: dict) -> dict:
    """Given per-season totals for one (player, season), return metric→value."""
    pa = totals.get("pass_att") or 0
    ra = totals.get("rush_att") or 0
    gp = totals.get("games_played") or 0
    out = {k: totals.get(k) for k in VOLUME_METRICS_QB}
    out["cmp_pct"]       = _safe_div(totals.get("pass_cmp"), pa)
    out["ypa"]           = _safe_div(totals.get("pass_yds"), pa)
    out["td_pct"]        = _safe_div(totals.get("pass_tds"), pa)
    out["int_pct"]       = _safe_div(totals.get("pass_ints"), pa)
    out["sack_rate"]     = _safe_div(totals.get("pass_sacks"), pa + (totals.get("pass_sacks") or 0))
    out["yds_per_carry"] = _safe_div(totals.get("rush_yds"), ra)
    out["pass_yds_per_g"] = _safe_div(totals.get("pass_yds"), gp)
    out["pass_tds_per_g"] = _safe_div(totals.get("pass_tds"), gp)
    out["rush_yds_per_g"] = _safe_div(totals.get("rush_yds"), gp)
    out["rush_tds_per_g"] = _safe_div(totals.get("rush_tds"), gp)
    return out


METRIC_LIST_BY_POS = {
    "QB": VOLUME_METRICS_QB + [
        "cmp_pct", "ypa", "td_pct", "int_pct", "sack_rate", "yds_per_carry",
        "pass_yds_per_g", "pass_tds_per_g", "rush_yds_per_g", "rush_tds_per_g",
    ],
}

DERIVE_BY_POS = {"QB": derive_metrics_qb}


# ─────────────────────────────────────────────────────────────────────────────
# Correlation helpers (stdlib only — same shape as yoy_signals.py:397+)
# ─────────────────────────────────────────────────────────────────────────────
def _pearson(xs, ys):
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    mx = statistics.mean(xs)
    my = statistics.mean(ys)
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(len(xs)))
    dx = sum((v - mx) ** 2 for v in xs) ** 0.5
    dy = sum((v - my) ** 2 for v in ys) ** 0.5
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def _spearman(xs, ys):
    if len(xs) < 3:
        return None
    def rank(vs):
        order = sorted(range(len(vs)), key=lambda i: vs[i])
        ranks = [0.0] * len(vs)
        for r, idx in enumerate(order):
            ranks[idx] = r + 1
        return ranks
    return _pearson(rank(xs), rank(ys))


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline
# ─────────────────────────────────────────────────────────────────────────────
def fetch_qb_season_totals(conn, min_season, max_season, min_games):
    """One row per (gsis_id, season) of summed totals + games_played."""
    sql = """
        SELECT
            gsis_id,
            season,
            SUM(CASE WHEN COALESCE(pass_att,0) > 0 OR COALESCE(rush_att,0) > 0
                     THEN 1 ELSE 0 END) AS games_played,
            SUM(COALESCE(pass_att,0))  AS pass_att,
            SUM(COALESCE(pass_cmp,0))  AS pass_cmp,
            SUM(COALESCE(pass_yds,0))  AS pass_yds,
            SUM(COALESCE(pass_tds,0))  AS pass_tds,
            SUM(COALESCE(pass_ints,0)) AS pass_ints,
            SUM(COALESCE(pass_sacks,0)) AS pass_sacks,
            SUM(COALESCE(rush_att,0))  AS rush_att,
            SUM(COALESCE(rush_yds,0))  AS rush_yds,
            SUM(COALESCE(rush_tds,0))  AS rush_tds
        FROM nfl_player_weekly
        WHERE position = 'QB'
          AND season BETWEEN ? AND ?
        GROUP BY gsis_id, season
        HAVING games_played >= ?
    """
    cols = ["gsis_id", "season", "games_played",
            "pass_att", "pass_cmp", "pass_yds", "pass_tds", "pass_ints", "pass_sacks",
            "rush_att", "rush_yds", "rush_tds"]
    rows = conn.execute(sql, (min_season, max_season, min_games)).fetchall()
    return [dict(zip(cols, r)) for r in rows]


def build_pairs(seasons_by_player: dict, derive_fn) -> dict:
    """
    seasons_by_player: { gsis_id: { season: totals_dict } }
    Returns: { metric: [(val_n, val_n_plus_1, gsis_id, season_n), ...] }
    """
    pairs = defaultdict(list)
    for gsis_id, by_season in seasons_by_player.items():
        years = sorted(by_season.keys())
        for i in range(len(years) - 1):
            yn, yn1 = years[i], years[i + 1]
            if yn1 != yn + 1:
                continue  # only consecutive seasons
            m_n  = derive_fn(by_season[yn])
            m_n1 = derive_fn(by_season[yn1])
            for metric in m_n:
                v0, v1 = m_n.get(metric), m_n1.get(metric)
                if v0 is None or v1 is None:
                    continue
                pairs[metric].append((float(v0), float(v1), gsis_id, yn))
    return pairs


def compute_rows(position, min_games, pair_map, computed_at):
    rows = []
    for metric in METRIC_LIST_BY_POS[position]:
        pairs = pair_map.get(metric, [])
        n = len(pairs)
        if n == 0:
            rows.append((position, metric, min_games, 0, 0, None, None, None, None, computed_at))
            continue
        xs = [p[0] for p in pairs]
        ys = [p[1] for p in pairs]
        n_players = len({p[2] for p in pairs})
        season_min = min(p[3] for p in pairs)
        season_max = max(p[3] + 1 for p in pairs)
        if len(set(xs)) <= 1 or len(set(ys)) <= 1:
            pe = sp = None  # zero variance — correlation undefined
        else:
            pe = _pearson(xs, ys)
            sp = _spearman(xs, ys)
        rows.append((
            position, metric, min_games, n, n_players,
            pe, sp, season_min, season_max, computed_at,
        ))
    return rows


def write_stickiness(conn, rows):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS metric_stickiness (
            position      TEXT NOT NULL,
            metric        TEXT NOT NULL,
            min_games     INTEGER NOT NULL,
            n_pairs       INTEGER NOT NULL,
            n_players     INTEGER NOT NULL,
            corr_pearson  REAL,
            corr_spearman REAL,
            season_min    INTEGER,
            season_max    INTEGER,
            computed_at   TEXT NOT NULL,
            PRIMARY KEY (position, metric, min_games)
        )
    """)
    conn.executemany("""
        INSERT OR REPLACE INTO metric_stickiness
            (position, metric, min_games, n_pairs, n_players,
             corr_pearson, corr_spearman, season_min, season_max, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()


def parse_args():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db-path", default=DB_DEFAULT)
    p.add_argument("--position", default="QB", choices=["QB"],
                   help="Position to compute (Phase 1: QB only)")
    p.add_argument("--min-games", type=int, default=8,
                   help="Min games played in BOTH seasons of a pair (default 8)")
    p.add_argument("--min-season", type=int, default=2011)
    p.add_argument("--max-season", type=int, default=2025)
    p.add_argument("--dry-run", action="store_true",
                   help="Compute and print summary without writing to the DB")
    return p.parse_args()


def main():
    args = parse_args()
    conn = sqlite3.connect(args.db_path, timeout=30.0)
    conn.execute("PRAGMA busy_timeout = 30000")
    try:
        if args.position != "QB":
            raise SystemExit(f"Only QB supported in Phase 1, got {args.position}")

        totals_rows = fetch_qb_season_totals(conn, args.min_season, args.max_season, args.min_games)
        if not totals_rows:
            raise SystemExit("No QB-season rows after filtering. Check nfl_player_weekly population.")

        seasons_by_player: dict = defaultdict(dict)
        for r in totals_rows:
            seasons_by_player[r["gsis_id"]][r["season"]] = r

        pair_map = build_pairs(seasons_by_player, DERIVE_BY_POS[args.position])

        computed_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        rows = compute_rows(args.position, args.min_games, pair_map, computed_at)
        write_err = None
        if not args.dry_run:
            try:
                write_stickiness(conn, rows)
            except sqlite3.OperationalError as e:
                write_err = str(e)

        # Stdout summary, sorted by Pearson desc (None last)
        print(f"\nStickiness — {args.position} (min_games={args.min_games}, "
              f"seasons {args.min_season}–{args.max_season})")
        print(f"  source rows: {len(totals_rows)} qualifying (player, season) totals")
        print(f"  computed_at: {computed_at}")
        if args.dry_run:
            print(f"  WRITE SKIPPED (--dry-run)")
        elif write_err:
            print(f"  WRITE FAILED: {write_err}")
        else:
            print(f"  wrote {len(rows)} rows to metric_stickiness")
        print()
        print(f"  {'metric':<20} {'pearson':>9} {'spearman':>9} {'n_pairs':>8} {'players':>8} {'years':>12}")
        print(f"  {'-'*20} {'-'*9} {'-'*9} {'-'*8} {'-'*8} {'-'*12}")
        sortable = sorted(
            rows,
            key=lambda r: (r[5] is None, -(r[5] or 0)),
        )
        for (_pos, metric, _mg, n_pairs, n_players, pe, sp, smin, smax, _ts) in sortable:
            pe_s = f"{pe:>9.3f}" if pe is not None else f"{'—':>9}"
            sp_s = f"{sp:>9.3f}" if sp is not None else f"{'—':>9}"
            yr_s = f"{smin}–{smax}" if smin else "—"
            print(f"  {metric:<20} {pe_s} {sp_s} {n_pairs:>8} {n_players:>8} {yr_s:>12}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
