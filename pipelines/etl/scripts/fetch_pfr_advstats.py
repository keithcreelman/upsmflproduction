#!/usr/bin/env python3
"""Fetch nflverse PFR weekly advanced receiving stats.

Pulls `nflreadpy.load_pfr_advstats(stat_type="rec")` and UPDATEs the
following columns on nfl_player_weekly:
  - receiving_drops           (receiving_drop count)
  - receiving_broken_tackles
  - rushing_broken_tackles
  - passing_drops             (for QBs: drops by their receivers)

**What's NOT in this payload:** routes_run. PFR's public advanced
receiving table (pro-football-reference.com/years/<YYYY>/
receiving_advanced.htm) does not publish routes-run counts — it's a
PFF / Next Gen Stats subscription metric. nflverse load_pbp() +
load_participation() can APPROXIMATE routes per player per week by
counting pass plays where the player is in `offense_players`, but
that's a Phase-3 effort and deferred. UI's Routes / YPRR columns
have been removed rather than left forever blank.

Dependencies:
  pip install nflreadpy pandas

Usage:
  python3 pipelines/etl/scripts/fetch_pfr_advstats.py --seasons 2018-2025
  python3 pipelines/etl/scripts/fetch_pfr_advstats.py --seasons 2024,2025
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


def build_pfr_to_gsis(db: sqlite3.Connection) -> dict[str, str]:
    rows = db.execute("""
        SELECT pfr_id, gsis_id FROM player_id_crosswalk
         WHERE pfr_id IS NOT NULL AND gsis_id IS NOT NULL
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def fetch_pfr_rec(seasons: list[int]):
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit("FATAL: nflreadpy not installed. Run: pip install nflreadpy pandas")
    print(f"  loading PFR rec advstats {seasons[0]}-{seasons[-1]}...", file=sys.stderr)
    df = nfl.load_pfr_advstats(seasons=seasons, stat_type="rec")
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    print(f"  got {len(df)} rows", file=sys.stderr)
    return df


def upsert_pfr_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict) -> int:
    if df is None or df.empty:
        return 0

    def col(row, *names):
        for n in names:
            if n in row and row[n] is not None:
                try:
                    v = float(row[n])
                    if v != v:  # NaN
                        continue
                    return int(v)
                except (ValueError, TypeError):
                    continue
        return None

    rows_to_update = []
    skipped = 0
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1
            continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1
            continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week:
            continue
        rec_drops   = col(row, "receiving_drop", "receiving_drops")
        rec_brtkl   = col(row, "receiving_broken_tackles")
        rush_brtkl  = col(row, "rushing_broken_tackles")
        pass_drops  = col(row, "passing_drops")
        # Skip rows where every stat is None — no signal
        if rec_drops is None and rec_brtkl is None and rush_brtkl is None and pass_drops is None:
            continue
        rows_to_update.append((rec_drops, rec_brtkl, rush_brtkl, pass_drops, season, week, gsis))

    if not rows_to_update:
        print(f"  nothing to upsert (skipped {skipped} unmapped rows)", file=sys.stderr)
        return 0

    # COALESCE preserves pre-existing non-NULL values on columns we
    # didn't get a value for in this row (defensive; most rows have
    # multiple values).
    db.executemany(
        """
        UPDATE nfl_player_weekly
           SET receiving_drops           = COALESCE(?, receiving_drops),
               receiving_broken_tackles  = COALESCE(?, receiving_broken_tackles),
               rushing_broken_tackles    = COALESCE(?, rushing_broken_tackles),
               passing_drops             = COALESCE(?, passing_drops)
         WHERE season = ? AND week = ? AND gsis_id = ?
        """,
        rows_to_update,
    )
    db.commit()
    print(f"  updated {len(rows_to_update)} rows (skipped {skipped} unmapped)", file=sys.stderr)
    return len(rows_to_update)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2018-2025",
                    help='Season list: "2018-2025" (default; PFR rec advstats start 2018)')
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}")
    db = sqlite3.connect(str(LOCAL_DB))

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    pfr_to_gsis = build_pfr_to_gsis(db)
    print(f"  crosswalk: {len(pfr_to_gsis)} pfr_id → gsis_id mappings", file=sys.stderr)
    if not pfr_to_gsis:
        sys.exit("no crosswalk — run build_player_id_crosswalk.py first")

    df = fetch_pfr_rec(seasons)
    n = upsert_pfr_weekly(db, df, pfr_to_gsis)
    print(f"DONE: {n} player-week rows updated with PFR advstats (drops / broken tackles)", file=sys.stderr)


if __name__ == "__main__":
    main()
