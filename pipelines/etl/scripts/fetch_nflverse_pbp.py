#!/usr/bin/env python3
"""Parse nflverse PBP into per-player yardline-banded counts.

Lands in nfl_player_redzone — populates the Raw Stats view columns
Keith called out 2026-04-22: Goal Line Carries (inside 5), RZ Carries
(inside 20), Red Zone Targets, End Zone Targets.

PBP data is heavy: ~45k plays per season × 15 seasons ≈ 700k plays.
Filter aggressively at the query level — we only care about:
  - rushing plays (play_type = 'run')
  - passing plays (play_type = 'pass')
and we only need the columns needed to bucket by yardline and
attribute to a player.

Dependencies:
  pip install nflreadpy pandas

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_pbp.py --seasons 2011-2025
  python3 pipelines/etl/scripts/fetch_nflverse_pbp.py --seasons 2024,2025
"""
from __future__ import annotations
import argparse
import sqlite3
import sys
from pathlib import Path

LOCAL_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")


def parse_seasons(spec: str) -> list[int]:
    out = set()
    for piece in spec.split(","):
        piece = piece.strip()
        if not piece:
            continue
        if "-" in piece:
            a, b = piece.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(piece))
    return sorted(out)


def ensure_table(db: sqlite3.Connection) -> None:
    # Mirrors worker/migrations/0007_nfl_player_redzone.sql so this
    # script works standalone on fresh machines.
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_redzone (
          season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL,
          rush_att_i20 INTEGER, rush_att_i10 INTEGER, rush_att_i5 INTEGER,
          rush_yds_i20 INTEGER, rush_tds_i20 INTEGER,
          targets_i20 INTEGER, targets_i10 INTEGER, targets_i5 INTEGER,
          targets_ez INTEGER, rec_i20 INTEGER, rec_tds_i20 INTEGER,
          pass_att_i20 INTEGER, pass_tds_i20 INTEGER, pass_att_ez INTEGER,
          PRIMARY KEY (season, week, gsis_id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_redzone_player ON nfl_player_redzone (gsis_id, season)")
    db.commit()


def process_season(db: sqlite3.Connection, season: int) -> int:
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit("FATAL: nflreadpy not installed. Run: pip install nflreadpy pandas")

    print(f"  loading PBP for {season}...", file=sys.stderr)
    df = nfl.load_pbp(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})

    # Filter to reg + post (skip preseason)
    if "season_type" in df.columns:
        df = df[df["season_type"].isin(["REG", "POST"])]
    # Only run/pass
    df = df[df["play_type"].isin(["run", "pass"])]

    # yardline_100 = distance from opponent's end zone (0..99); <=20 is red zone.
    # air_yards = how far past LoS the ball traveled (nullable).
    # rusher_player_id / receiver_player_id / passer_player_id are gsis IDs.
    agg = {}
    def bucket(gsis, week):
        if not gsis:
            return None
        key = (season, int(week), str(gsis))
        if key not in agg:
            agg[key] = {
                "rush_att_i20": 0, "rush_att_i10": 0, "rush_att_i5": 0,
                "rush_yds_i20": 0, "rush_tds_i20": 0,
                "targets_i20": 0, "targets_i10": 0, "targets_i5": 0,
                "targets_ez": 0, "rec_i20": 0, "rec_tds_i20": 0,
                "pass_att_i20": 0, "pass_tds_i20": 0, "pass_att_ez": 0,
            }
        return agg[key]

    for row in df.to_dict(orient="records"):
        week = row.get("week") or 0
        yl = row.get("yardline_100")
        if yl is None:
            continue
        try:
            yl = int(yl)
        except (ValueError, TypeError):
            continue

        ptype = row.get("play_type")
        if ptype == "run":
            rusher = row.get("rusher_player_id") or row.get("rusher_id")
            if not rusher:
                continue
            b = bucket(rusher, week)
            if b is None:
                continue
            if yl <= 20: b["rush_att_i20"] += 1
            if yl <= 10: b["rush_att_i10"] += 1
            if yl <= 5:  b["rush_att_i5"]  += 1
            if yl <= 20:
                yds = row.get("yards_gained") or 0
                try: b["rush_yds_i20"] += int(yds)
                except (ValueError, TypeError): pass
                if row.get("touchdown") in (1, True, "1"):
                    b["rush_tds_i20"] += 1

        elif ptype == "pass":
            passer = row.get("passer_player_id") or row.get("passer_id")
            receiver = row.get("receiver_player_id") or row.get("receiver_id")
            air_yards = row.get("air_yards")

            # End-zone target = pass with air_yards sufficient to reach end zone
            # (air_yards ≥ yl). Account for nullable.
            is_ez = False
            try:
                if air_yards is not None:
                    is_ez = int(air_yards) >= yl
            except (ValueError, TypeError):
                pass

            if passer:
                bp = bucket(passer, week)
                if bp is not None:
                    if yl <= 20:
                        bp["pass_att_i20"] += 1
                        if row.get("touchdown") in (1, True, "1") and row.get("td_team") == row.get("posteam"):
                            bp["pass_tds_i20"] += 1
                    if is_ez:
                        bp["pass_att_ez"] += 1

            if receiver:
                br = bucket(receiver, week)
                if br is not None:
                    if yl <= 20:
                        br["targets_i20"] += 1
                        if row.get("complete_pass") in (1, True, "1"):
                            br["rec_i20"] += 1
                            if row.get("touchdown") in (1, True, "1"):
                                br["rec_tds_i20"] += 1
                    if yl <= 10: br["targets_i10"] += 1
                    if yl <= 5:  br["targets_i5"]  += 1
                    if is_ez:    br["targets_ez"]  += 1

    if not agg:
        print(f"  (no rows for {season})", file=sys.stderr)
        return 0

    rows = []
    for (s, wk, gid), v in agg.items():
        rows.append((s, wk, gid, v["rush_att_i20"], v["rush_att_i10"], v["rush_att_i5"],
                     v["rush_yds_i20"], v["rush_tds_i20"],
                     v["targets_i20"], v["targets_i10"], v["targets_i5"],
                     v["targets_ez"], v["rec_i20"], v["rec_tds_i20"],
                     v["pass_att_i20"], v["pass_tds_i20"], v["pass_att_ez"]))

    db.executemany("""
        INSERT INTO nfl_player_redzone
            (season, week, gsis_id, rush_att_i20, rush_att_i10, rush_att_i5,
             rush_yds_i20, rush_tds_i20,
             targets_i20, targets_i10, targets_i5,
             targets_ez, rec_i20, rec_tds_i20,
             pass_att_i20, pass_tds_i20, pass_att_ez)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(season, week, gsis_id) DO UPDATE SET
          rush_att_i20 = excluded.rush_att_i20,
          rush_att_i10 = excluded.rush_att_i10,
          rush_att_i5  = excluded.rush_att_i5,
          rush_yds_i20 = excluded.rush_yds_i20,
          rush_tds_i20 = excluded.rush_tds_i20,
          targets_i20  = excluded.targets_i20,
          targets_i10  = excluded.targets_i10,
          targets_i5   = excluded.targets_i5,
          targets_ez   = excluded.targets_ez,
          rec_i20      = excluded.rec_i20,
          rec_tds_i20  = excluded.rec_tds_i20,
          pass_att_i20 = excluded.pass_att_i20,
          pass_tds_i20 = excluded.pass_tds_i20,
          pass_att_ez  = excluded.pass_att_ez
    """, rows)
    db.commit()
    print(f"  {season}: {len(rows)} player-week rows", file=sys.stderr)
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}")
    db = sqlite3.connect(str(LOCAL_DB))
    ensure_table(db)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    total = 0
    for s in seasons:
        total += process_season(db, s)
    print(f"DONE: {total} total player-week rows across {len(seasons)} seasons", file=sys.stderr)


if __name__ == "__main__":
    main()
