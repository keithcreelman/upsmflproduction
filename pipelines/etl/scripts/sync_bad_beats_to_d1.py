#!/usr/bin/env python3
"""
sync_bad_beats_to_d1.py — mirror wire_data.bench_burns() into D1
(ups_bad_beats, migration 0151) so the Discord /therapy bot can draw a real,
verdict-classified "bad beat" story at request time.

WHY THIS EXISTS (Keith 2026-09-14): /therapy needed variety instead of
reciting the same career-stat facts every call, and a way to occasionally
needle whoever's named in a vent with a REAL fact rather than a vague jab.
bench_burns() already computes exactly this (benched-vs-started swing,
classified process/genuine misplay vs variance/bad luck on each player's
recent form) but it lives in this Python pipeline and reads src_weekly,
which the Cloudflare Worker cannot query at request time — same reason
ups_owner_career_stats and ups_roast_owner_ammo exist as D1 mirrors of
Python-computed facts. This script is that mirror for bad beats.

Owner attribution uses src_franchises PER SEASON (wire_data.owner_map), not
ups_owner_career_stats, because a franchise's owner can change across years
— see wire_data.py's own module docstring on why.

RUN THIS BY HAND (no cron). Re-run any time bench_burns' inputs change (new
season data lands, a correction). Safe to re-run: UPSERT on
(season, week, franchise_id).

Usage:
  python3 sync_bad_beats_to_d1.py                        # 2021-2025, weeks 1-17
  python3 sync_bad_beats_to_d1.py --seasons 2025          # one season
  python3 sync_bad_beats_to_d1.py --seasons 2023-2025
  python3 sync_bad_beats_to_d1.py --dry-run
"""

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WIRE_DIR = SCRIPT_DIR.parent / "wire"
WORKER_DIR = SCRIPT_DIR.resolve().parents[2] / "worker"

sys.path.insert(0, str(WIRE_DIR))
import wire_data as D  # noqa: E402

COLS = [
    "season", "week", "franchise_id", "pos",
    "benched_name", "benched_id", "benched_score",
    "started_name", "started_id", "started_score",
    "diff", "verdict", "matchup_result", "matchup_margin",
    "swing_flips_result", "synced_at_utc",
]


def _sql_quote(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def parse_season_range(spec):
    if "-" in spec:
        lo, hi = spec.split("-", 1)
        return range(int(lo), int(hi) + 1)
    return [int(spec)]


def matchup_for(season, week, fid):
    """Single-opponent result/margin for this franchise's week, or all-NULL
    for a bye, a multi-opponent week (15-17 -- see ups_all_12_teams_play
    memory), or missing data. Deliberately conservative: a wrong result is
    worse than no result."""
    rows = D.d1(
        "SELECT team_score, opponent_score FROM src_schedule "
        "WHERE season = %d AND week = %d AND franchise_id = '%s'"
        % (int(season), int(week), fid)
    )
    if len(rows) != 1:
        return None, None
    my, opp = float(rows[0]["team_score"]), float(rows[0]["opponent_score"])
    result = "won" if my > opp else ("lost" if my < opp else "tied")
    return result, round(abs(my - opp), 2)


def build_rows(seasons, weeks):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []
    for season in seasons:
        owners = D.owner_map(season)  # unused directly (names come from bench_burns), kept for parity/logging
        for week in weeks:
            try:
                burns = D.bench_burns(season, week)
            except Exception as exc:  # noqa: BLE001
                sys.stderr.write("bench_burns(%s, %s) failed: %s\n" % (season, week, exc))
                continue
            for fid, b in burns.items():
                if fid not in owners:
                    continue
                result, margin = matchup_for(season, week, fid)
                swing = float(b["benched_score"]) - float(b["started_score"])
                flips = None
                if result == "lost" and margin is not None:
                    flips = 1 if swing > margin else 0
                rows.append({
                    "season": season, "week": week, "franchise_id": fid,
                    "pos": b.get("pos"),
                    "benched_name": b.get("benched"), "benched_id": b.get("benched_id"),
                    "benched_score": b.get("benched_score"),
                    "started_name": b.get("started"), "started_id": b.get("started_id"),
                    "started_score": b.get("started_score"),
                    "diff": b.get("diff"), "verdict": b.get("verdict"),
                    "matchup_result": result, "matchup_margin": margin,
                    "swing_flips_result": flips,
                    "synced_at_utc": now,
                })
            print("  %d wk%02d: %d bad beat(s)" % (season, week, len([r for r in rows if r["season"] == season and r["week"] == week])))
    return rows


def build_sql(rows):
    update_clause = ", ".join(f"{c} = excluded.{c}" for c in COLS if c not in ("season", "week", "franchise_id"))
    parts = []
    for r in rows:
        values = ", ".join(_sql_quote(r.get(c)) for c in COLS)
        parts.append(
            f"INSERT INTO ups_bad_beats ({', '.join(COLS)}) VALUES ({values}) "
            f"ON CONFLICT(season, week, franchise_id) DO UPDATE SET {update_clause};"
        )
    return "\n".join(parts) + "\n"


def d1_execute_file(sql_text):
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write(sql_text)
        sql_path = f.name
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", sql_path],
        capture_output=True, text=True, cwd=str(WORKER_DIR),
    )
    if result.returncode != 0:
        sys.stderr.write(f"D1 execute failed:\n{result.stderr}\n")
        sys.exit(1)
    print(result.stdout[-2000:])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", default="2021-2025", help="e.g. 2025 or 2023-2025")
    parser.add_argument("--weeks", default="1-17", help="e.g. 1-17")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    seasons = list(parse_season_range(args.seasons))
    weeks = list(parse_season_range(args.weeks))
    print(f"Computing bad beats for seasons {seasons[0]}-{seasons[-1]}, weeks {weeks[0]}-{weeks[-1]}...")
    rows = build_rows(seasons, weeks)
    print(f"\n{len(rows)} bad beat(s) found across {len(seasons)} season(s).")
    if not rows:
        return 0

    sql_text = build_sql(rows)
    if args.dry_run:
        print(sql_text[:4000])
        print(f"DRY RUN — would UPSERT {len(rows)} row(s), not writing")
        return 0

    d1_execute_file(sql_text)
    print(f"D1 sync: {len(rows)} row(s) UPSERTed into ups_bad_beats")
    return 0


if __name__ == "__main__":
    sys.exit(main())
