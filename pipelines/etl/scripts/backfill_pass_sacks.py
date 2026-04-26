#!/usr/bin/env python3
"""Targeted backfill of pass_sacks, pass_sack_yds, def_fr, def_tackles_total.

These four columns either had silent-NULL aliases (def_fr was missing
'fumble_recovery_opp', pass_sacks/pass_sack_yds didn't include the current
'sacks_suffered'/'sack_yards_lost' names) or were never aliased at all
(def_tackles_total — derived from solo + ast, since the nflverse 'tackles'
column has been renamed/dropped).

Pulls ONLY these columns from nflverse load_player_stats — avoids the wide
55-col upsert that chews through D1's daily write quota.

Usage:
  python3 pipelines/etl/scripts/backfill_pass_sacks.py --seasons 2018-2025
  python3 pipelines/etl/scripts/backfill_pass_sacks.py --seasons 2018,2019,2025
  python3 pipelines/etl/scripts/backfill_pass_sacks.py --seasons 2024 --skip-d1
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)


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


def _get_first(row, *names):
    """Return first non-None matching column value."""
    for n in names:
        if n in row and row[n] is not None and str(row[n]) != "":
            return row[n]
    return None


def _to_int(v):
    if v is None: return None
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None


def fetch_rows(season: int) -> list[tuple]:
    """Pull (season, week, gsis_id, pass_sacks, pass_sack_yds, def_fr,
    def_tackles_total) tuples for one season."""
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit("FATAL: nflreadpy not installed. Run: pip install nflreadpy pandas")

    print(f"  loading nflverse player_stats for {season}...", file=sys.stderr)
    df = nfl.load_player_stats(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})

    rows = []
    for r in df.to_dict(orient="records"):
        gsis = r.get("player_id")
        if not gsis:
            continue
        try:
            wk = int(r.get("week") or 0)
            if not wk: continue
        except (ValueError, TypeError):
            continue

        sacks = _to_int(_get_first(r, "sacks_suffered", "times_sacked", "sacks",
                                    "passing_sacks", "sack_count"))
        yds = _to_int(_get_first(r, "sack_yards_lost", "sack_yards_suffered",
                                  "sack_yards", "passing_sack_yards"))
        fr = _to_int(_get_first(r, "fumble_recovery_opp", "def_fumble_recovery_opp",
                                 "def_fumble_recoveries", "fumble_recoveries"))
        solo = _to_int(_get_first(r, "def_tackles_solo", "solo_tackles", "tackles_solo"))
        ast = _to_int(_get_first(r, "def_tackles_with_assist", "assist_tackles",
                                  "tackles_assists"))
        # def_tackles_total = solo + ast when at least one is populated
        if solo is not None or ast is not None:
            total = (solo or 0) + (ast or 0)
        else:
            total = None

        if all(x is None for x in (sacks, yds, fr, total)):
            continue
        rows.append((season, wk, gsis, sacks, yds, fr, total))
    print(f"  {season}: {len(rows)} rows with backfill data", file=sys.stderr)
    return rows


def upsert_local(db: sqlite3.Connection, rows: list[tuple]) -> int:
    """Local SQLite UPDATE for the four columns."""
    if not rows:
        return 0
    # Local UPDATE order: (sacks, yds, fr, total, season, week, gsis)
    local_rows = [(r[3], r[4], r[5], r[6], r[0], r[1], r[2]) for r in rows]
    try:
        db.executemany("""
            UPDATE nfl_player_weekly
               SET pass_sacks        = COALESCE(?, pass_sacks),
                   pass_sack_yds     = COALESCE(?, pass_sack_yds),
                   def_fr            = COALESCE(?, def_fr),
                   def_tackles_total = COALESCE(?, def_tackles_total)
             WHERE season = ? AND week = ? AND gsis_id = ?
        """, local_rows)
        db.commit()
        return len(rows)
    except sqlite3.OperationalError as e:
        print(f"  local: FAILED ({e})", file=sys.stderr)
        return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", default="2018-2025")
    ap.add_argument("--skip-local", action="store_true",
                    help="Skip the local SQLite update")
    ap.add_argument("--skip-d1", action="store_true",
                    help="Skip the D1 push")
    args = ap.parse_args()

    seasons = parse_seasons(args.seasons)
    print(f"Backfilling pass_sacks/pass_sack_yds/def_fr/def_tackles_total for: {seasons}",
          file=sys.stderr)

    db = None
    if not args.skip_local:
        if not LOCAL_DB.exists():
            print(f"  WARNING: local DB missing, switching to D1-only", file=sys.stderr)
            args.skip_local = True
        else:
            db = sqlite3.connect(str(LOCAL_DB), timeout=30)
            try:
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA busy_timeout=30000")
            except sqlite3.DatabaseError:
                pass

    total_local = 0
    total_d1 = 0
    for season in seasons:
        rows = fetch_rows(season)
        if not rows:
            continue

        if db is not None and not args.skip_local:
            n = upsert_local(db, rows)
            total_local += n
            print(f"  {season} local: updated {n} rows", file=sys.stderr)

        if not args.skip_d1:
            print(f"  {season} D1: writing {len(rows)} rows...", file=sys.stderr)
            with D1Writer(
                table="nfl_player_weekly",
                cols=["season", "week", "gsis_id",
                      "pass_sacks", "pass_sack_yds", "def_fr", "def_tackles_total"],
                pk_cols=["season", "week", "gsis_id"],
            ) as w:
                for r in rows:
                    w.add(r)
            total_d1 += len(rows)

    local_status = "skipped" if args.skip_local else f"{total_local} rows"
    d1_status = "skipped" if args.skip_d1 else f"{total_d1} rows"
    print(f"DONE: backfill complete (local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
