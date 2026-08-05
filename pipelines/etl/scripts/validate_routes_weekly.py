#!/usr/bin/env python3
"""ACCEPTANCE GATE for the weekly-route leakage fix (Phase 0 task 0.1).

Asserts three things about nfl_player_routes_weekly, all read from D1:

  1. ROLLUP IDENTITY — for EVERY (season, gsis_id), Σ weekly == the season-table
     value, on all four sum columns. The season table is derived from weekly by
     fetch_nflverse_routes.py, so any mismatch means the derivation or the write
     is broken. Checked per player, not just in aggregate: offsetting per-player
     errors cancel in a league total.

  2. GRAIN SANITY — max routes in a single player-week must be game-plausible
     (<= ~75). If a weekly row carries season-scale routes (500+), the week key
     collapsed and the table is still leaking full-season information, which is
     the exact defect this table exists to fix.

  3. WEEK COVERAGE — weeks present per season must match the NFL calendar
     (1-17 through 2020, 1-18 from 2021). A missing tail week would silently
     truncate every as-of feature built on this table.

WHY THIS MATTERS
----------------
nfl_player_routes is keyed (season, gsis_id) and holds COMPLETED season totals.
Reading it while generating a historical Week 5 prediction hands the model route
volume from Weeks 6-18 — revealing, at Week 5, the season-end usage of exactly
the players whose roles were about to expand. Backtested lead-time metrics would
be fabricated. See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.1.

Usage:
  python3 pipelines/etl/scripts/validate_routes_weekly.py
  python3 pipelines/etl/scripts/validate_routes_weekly.py --seasons 2016-2025
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

WORKER = Path(__file__).resolve().parents[3] / "worker"
MAX_PLAUSIBLE_WEEKLY_ROUTES = 75  # an every-down WR runs ~40-60 routes in a game


def d1(sql: str):
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json",
         "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=300)
    i = r.stdout.find("[")
    if i < 0:
        sys.exit(f"D1 query failed:\n{r.stdout[:600]}\n{r.stderr[:600]}")
    return json.loads(r.stdout[i:])[0].get("results", [])


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2016-2025")
    args = ap.parse_args()
    a, b = (args.seasons.split("-") + [args.seasons])[:2]
    lo, hi = int(a), int(b)
    rng = f"season BETWEEN {lo} AND {hi}"

    failures = 0

    # ── 1. per-player rollup identity ──────────────────────────────────────
    print("1. ROLLUP IDENTITY (per player, all four sum columns)")
    rows = d1(f"""
      WITH wk AS (
        SELECT season, gsis_id, SUM(routes) rt, SUM(team_dropbacks) tdb,
               SUM(routes_tgt) tg, SUM(routes_rec_yds) ry
        FROM nfl_player_routes_weekly WHERE {rng} GROUP BY season, gsis_id
      )
      SELECT s.season,
             COUNT(*) AS players,
             SUM(CASE WHEN COALESCE(wk.rt,-1)  <> s.routes         THEN 1 ELSE 0 END) AS bad_rt,
             SUM(CASE WHEN COALESCE(wk.tdb,-1) <> s.team_dropbacks THEN 1 ELSE 0 END) AS bad_tdb,
             SUM(CASE WHEN COALESCE(wk.tg,-1)  <> s.routes_tgt     THEN 1 ELSE 0 END) AS bad_tg,
             SUM(CASE WHEN COALESCE(wk.ry,-1)  <> s.routes_rec_yds THEN 1 ELSE 0 END) AS bad_ry
      FROM nfl_player_routes s
      LEFT JOIN wk ON wk.season = s.season AND wk.gsis_id = s.gsis_id
      WHERE s.{rng}
      GROUP BY s.season ORDER BY s.season
    """)
    for r in rows:
        bad = r["bad_rt"] + r["bad_tdb"] + r["bad_tg"] + r["bad_ry"]
        failures += bool(bad)
        print(f"   {r['season']}  players={r['players']:>4}  mismatches: "
              f"routes={r['bad_rt']} dropbacks={r['bad_tdb']} "
              f"tgt={r['bad_tg']} recyds={r['bad_ry']}  "
              f"{'PASS' if not bad else 'FAIL'}")
    if not rows:
        sys.exit("   NO ROWS — refusing to report a pass on an empty table")

    # ── 2. grain sanity ────────────────────────────────────────────────────
    print("\n2. GRAIN SANITY (a weekly row must not carry season-scale routes)")
    g = d1(f"SELECT season, MAX(routes) mx, COUNT(*) n FROM nfl_player_routes_weekly "
           f"WHERE {rng} GROUP BY season ORDER BY season")
    for r in g:
        ok = r["mx"] <= MAX_PLAUSIBLE_WEEKLY_ROUTES
        failures += (not ok)
        print(f"   {r['season']}  rows={r['n']:>5}  max weekly routes={r['mx']:>4}  "
              f"{'PASS' if ok else 'FAIL — week key collapsed, STILL LEAKING'}")

    # ── 3. week coverage ───────────────────────────────────────────────────
    print("\n3. WEEK COVERAGE (1-17 through 2020, 1-18 from 2021)")
    w = d1(f"SELECT season, MIN(week) lo, MAX(week) hi, COUNT(DISTINCT week) n "
           f"FROM nfl_player_routes_weekly WHERE {rng} GROUP BY season ORDER BY season")
    for r in w:
        want = 18 if r["season"] >= 2021 else 17
        ok = r["lo"] == 1 and r["hi"] == want and r["n"] == want
        failures += (not ok)
        print(f"   {r['season']}  weeks {r['lo']}-{r['hi']} ({r['n']} distinct), "
              f"expected 1-{want}  {'PASS' if ok else 'FAIL'}")

    print("\n" + "-" * 66)
    if failures:
        sys.exit(f"GATE FAILED: {failures} check(s) failed")
    print("GATE PASSED: weekly routes reconcile exactly and carry no season-scale rows")


if __name__ == "__main__":
    main()
