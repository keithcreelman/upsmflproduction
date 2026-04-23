#!/usr/bin/env python3
"""Fetch Pro-Football-Reference advanced receiving stats — Routes Run.

Populates nfl_player_weekly.routes_run so the Raw Stats "Routes" and
YPRR columns on the skill-position (RB/WR/TE) template render real
values instead of "—".

Source: nflverse load_pfr_advstats(stat_type="rec"). PFR scraped the
advanced receiving data back to 2018; earlier seasons will silently
have no rows (routes_run stays NULL → UI renders "—").

Keys: PFR returns `pfr_player_id` + `season` + `week`. Upserts into
nfl_player_weekly by (season, week, gsis_id) — we translate pfr_id →
gsis_id via the local player_id_crosswalk table so the upsert PK
matches. Players without a crosswalk entry are skipped.

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
    """Use our crosswalk to map PFR ID → GSIS ID."""
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
    print(f"  loading PFR advanced receiving stats {seasons[0]}-{seasons[-1]}...", file=sys.stderr)
    df = nfl.load_pfr_advstats(seasons=seasons, stat_type="rec")
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    print(f"  got {len(df)} rows", file=sys.stderr)
    print(f"  columns: {sorted(df.columns.tolist())}", file=sys.stderr)
    # Spot-check: any column whose name hints at "routes"?
    route_cols = [c for c in df.columns if "rout" in c.lower()]
    if route_cols:
        print(f"  route-related columns: {route_cols}", file=sys.stderr)
        # Preview one populated value from each to see what's actually there
        for c in route_cols:
            vals = df[c].dropna().head(3).tolist()
            print(f"    {c}: sample non-null values = {vals}", file=sys.stderr)
    else:
        print(f"  WARNING: no columns matching 'rout' — PFR schema may have renamed it", file=sys.stderr)
    return df


def upsert_routes(db: sqlite3.Connection, df, pfr_to_gsis: dict) -> int:
    if df is None or df.empty:
        return 0
    # Column candidates — nflverse has renamed this a few times.
    # Expanded 2026-04-22 after Keith's run showed 0 routes landing
    # across 26,850 crosswalk-matched rows — suggests the column is
    # named something else. Trying a wider net; fetch_pfr_rec() now
    # also prints the raw df columns for diagnostics.
    ROUTE_KEYS = [
        "routes_run", "pass_routes", "routes",
        "routes_run_count", "route_count", "rt", "rec_routes",
        "total_routes", "offensive_snaps_route",
    ]
    PFR_KEYS = ["pfr_player_id", "pfr_id", "player_id"]

    rows_to_update = []
    skipped = 0
    for row in df.to_dict(orient="records"):
        pfr = None
        for k in PFR_KEYS:
            if k in row and row[k]:
                pfr = str(row[k])
                break
        if not pfr:
            skipped += 1
            continue
        gsis = pfr_to_gsis.get(pfr)
        if not gsis:
            skipped += 1
            continue
        routes = None
        for k in ROUTE_KEYS:
            if k in row and row[k] is not None:
                try: routes = int(float(row[k]))
                except (ValueError, TypeError): pass
                if routes is not None:
                    break
        if routes is None:
            continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week:
            continue
        rows_to_update.append((routes, season, week, gsis))

    if not rows_to_update:
        print(f"  nothing to upsert (skipped {skipped} rows without crosswalk or missing ids)", file=sys.stderr)
        return 0

    # routes_run is a column on nfl_player_weekly — UPDATE where rows
    # already exist. Skip INSERT path since box-score fetcher should
    # already have populated the (season, week, gsis_id) rows.
    db.executemany(
        "UPDATE nfl_player_weekly SET routes_run = ? WHERE season = ? AND week = ? AND gsis_id = ?",
        rows_to_update,
    )
    updated = db.total_changes  # includes all prior changes but gives us a rough signal
    db.commit()
    print(f"  updated {len(rows_to_update)} rows (skipped {skipped} unmapped)", file=sys.stderr)
    return len(rows_to_update)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2018-2025",
                    help='Season list: "2018-2025" or "2023,2024" (default: 2018-2025; PFR adv stats start 2018)')
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
    n = upsert_routes(db, df, pfr_to_gsis)
    print(f"DONE: {n} player-week rows had routes_run updated", file=sys.stderr)


if __name__ == "__main__":
    main()
