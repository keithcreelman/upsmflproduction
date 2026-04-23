#!/usr/bin/env python3
"""Fetch nflverse PFR weekly advanced rec + rush stats.

Pulls two separate nflverse endpoints and merges them into
nfl_player_weekly:

  load_pfr_advstats(stat_type="rec") provides:
    - receiving_drops
    - receiving_broken_tackles
    - passing_drops  (drops by this QB's receivers, when row is a QB)

  load_pfr_advstats(stat_type="rush") provides:
    - rushing_broken_tackles              (RB's actual broken tackles)
    - rushing_yards_before_contact        (YBC — yards at the LoS before
                                           first contact)
    - rushing_yards_after_contact         (YAC — yards gained after
                                           contact, classic RB power
                                           stat)

Keith 2026-04-23: Rico Dowdle 2025 showed BrTkl=3 in the popup but
PFR's season page lists 34 forced missed tackles. Root cause was this
fetcher only pulling the rec payload — the rec endpoint has a
rushing_broken_tackles column that's always NULL. Actual values come
from the rush payload.

What's still NOT in this payload: routes_run (PFF/NGS-subscription
metric; no free source). See governance doc.

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


def _load(stat_type: str, seasons: list[int]):
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit("FATAL: nflreadpy not installed. Run: pip install nflreadpy pandas")
    print(f"  loading PFR {stat_type} advstats {seasons[0]}-{seasons[-1]}...", file=sys.stderr)
    df = nfl.load_pfr_advstats(seasons=seasons, stat_type=stat_type)
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    print(f"  got {len(df)} rows", file=sys.stderr)
    return df


def _col_int(row, *names):
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


def upsert_rec_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict) -> int:
    if df is None or df.empty:
        return 0
    rows = []
    skipped = 0
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1; continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1; continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week: continue
        rec_drops   = _col_int(row, "receiving_drop", "receiving_drops")
        rec_brtkl   = _col_int(row, "receiving_broken_tackles")
        pass_drops  = _col_int(row, "passing_drops")
        if rec_drops is None and rec_brtkl is None and pass_drops is None:
            continue
        rows.append((rec_drops, rec_brtkl, pass_drops, season, week, gsis))

    if not rows:
        print(f"  [rec] nothing to upsert (skipped {skipped} unmapped)", file=sys.stderr)
        return 0
    db.executemany(
        """
        UPDATE nfl_player_weekly
           SET receiving_drops          = COALESCE(?, receiving_drops),
               receiving_broken_tackles = COALESCE(?, receiving_broken_tackles),
               passing_drops            = COALESCE(?, passing_drops)
         WHERE season = ? AND week = ? AND gsis_id = ?
        """,
        rows,
    )
    db.commit()
    print(f"  [rec] updated {len(rows)} rows (skipped {skipped} unmapped)", file=sys.stderr)
    return len(rows)


def upsert_rush_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict) -> int:
    if df is None or df.empty:
        return 0
    rows = []
    skipped = 0
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1; continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1; continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week: continue
        rush_brtkl = _col_int(row, "rushing_broken_tackles")
        rush_ybc   = _col_int(row, "rushing_yards_before_contact", "rushing_ybc")
        rush_yac   = _col_int(row, "rushing_yards_after_contact", "rushing_yac")
        if rush_brtkl is None and rush_ybc is None and rush_yac is None:
            continue
        rows.append((rush_brtkl, rush_ybc, rush_yac, season, week, gsis))

    if not rows:
        print(f"  [rush] nothing to upsert (skipped {skipped} unmapped)", file=sys.stderr)
        return 0
    db.executemany(
        """
        UPDATE nfl_player_weekly
           SET rushing_broken_tackles        = COALESCE(?, rushing_broken_tackles),
               rushing_yards_before_contact  = COALESCE(?, rushing_yards_before_contact),
               rushing_yards_after_contact   = COALESCE(?, rushing_yards_after_contact)
         WHERE season = ? AND week = ? AND gsis_id = ?
        """,
        rows,
    )
    db.commit()
    print(f"  [rush] updated {len(rows)} rows (skipped {skipped} unmapped)", file=sys.stderr)
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2018-2025",
                    help='Season list: "2018-2025" (default; PFR rec advstats start 2018)')
    ap.add_argument("--skip-rec", action="store_true", help="Skip the rec stat_type fetch")
    ap.add_argument("--skip-rush", action="store_true", help="Skip the rush stat_type fetch")
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

    total = 0
    if not args.skip_rec:
        df_rec = _load("rec", seasons)
        total += upsert_rec_weekly(db, df_rec, pfr_to_gsis)
    if not args.skip_rush:
        df_rush = _load("rush", seasons)
        total += upsert_rush_weekly(db, df_rush, pfr_to_gsis)

    print(f"DONE: {total} player-week rows updated with PFR advstats", file=sys.stderr)


if __name__ == "__main__":
    main()
