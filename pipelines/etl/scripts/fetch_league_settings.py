#!/usr/bin/env python3
"""Sync historical league IDs + starter configs to D1.

Two sources, used together:
  1. LOCAL DB (default)        — mirror league_years + metadata_starters to D1
  2. MFL API (--fetch-api)     — pull current/future seasons direct from MFL,
                                 then upsert to BOTH local DB and D1

Tables created/updated in D1:
  - mfl_league_years           (season → server, league_id)
  - mfl_metadata_starters      (season, position_name → limit_range)
  - mfl_league_settings        (season → qb_limit, te_limit — derived rollup
                                for era detection / auction model)

Local SQLite has authoritative copies of league_years + metadata_starters
already populated by historical ingest. This script:
  - Default: reads local DB → upserts to D1 (catches up new local data)
  - --fetch-api SEASONS: also hits MFL API for those seasons, updates both

Usage:
  # Mirror everything in local DB to D1
  python3 pipelines/etl/scripts/fetch_league_settings.py

  # Mirror only specific seasons from local
  python3 pipelines/etl/scripts/fetch_league_settings.py --seasons 2010-2025

  # Pull current year from MFL API + update local + D1 (for new seasons)
  python3 pipelines/etl/scripts/fetch_league_settings.py --fetch-api 2026
"""
from __future__ import annotations
import argparse
import json
import os
import sqlite3
import sys
import urllib.request
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)


def parse_seasons(spec: str | None) -> list[int] | None:
    if not spec:
        return None
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


# ---------------------------------------------------------------------
# Local DB → in-memory rows
# ---------------------------------------------------------------------

def read_league_years_from_local(db: sqlite3.Connection,
                                 seasons: list[int] | None) -> list[tuple]:
    """Read league_years rows from local DB."""
    if seasons:
        ph = ",".join("?" for _ in seasons)
        rows = db.execute(
            f"SELECT season, server, league_id FROM league_years "
            f"WHERE season IN ({ph}) ORDER BY season",
            seasons,
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT season, server, league_id FROM league_years ORDER BY season"
        ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def read_metadata_starters_from_local(db: sqlite3.Connection,
                                      seasons: list[int] | None) -> list[tuple]:
    """Read metadata_starters rows from local DB."""
    if seasons:
        ph = ",".join("?" for _ in seasons)
        rows = db.execute(
            f"SELECT season, position_name, limit_range FROM metadata_starters "
            f"WHERE season IN ({ph}) ORDER BY season, position_name",
            seasons,
        ).fetchall()
    else:
        rows = db.execute(
            "SELECT season, position_name, limit_range FROM metadata_starters "
            "ORDER BY season, position_name"
        ).fetchall()
    return [(r[0], r[1], r[2]) for r in rows]


def derive_league_settings(starter_rows: list[tuple]) -> list[tuple]:
    """Roll metadata_starters up into per-season qb_limit/te_limit/json."""
    by_season: dict[int, dict[str, str]] = {}
    for season, pos, limit in starter_rows:
        by_season.setdefault(season, {})[pos] = limit
    out = []
    for season in sorted(by_season):
        positions = by_season[season]
        out.append((
            season,
            positions.get("QB"),
            positions.get("TE"),
            json.dumps(positions, sort_keys=True),
        ))
    return out


# ---------------------------------------------------------------------
# MFL API → in-memory rows (for current/future seasons)
# ---------------------------------------------------------------------

def fetch_league_from_api(season: int, server: str, league_id: int):
    """Fetch TYPE=league for a season. Returns league dict or None."""
    url = f"https://{server}.myfantasyleague.com/{season}/export?TYPE=league&L={league_id}&JSON=1"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("league")
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        print(f"  {season}: API fetch failed ({e})", file=sys.stderr)
        return None


def parse_starters_from_api(league: dict) -> dict[str, str] | None:
    """Extract {position: limit_string} from MFL API league response."""
    if not league:
        return None
    starters = league.get("starters", {})
    positions = starters.get("position", [])
    if isinstance(positions, dict):
        positions = [positions]
    out = {}
    for cfg in positions:
        name = cfg.get("name")
        limit = cfg.get("limit")
        if name and limit:
            out[name] = limit
    return out or None


def fetch_via_api(seasons: list[int], local_db: sqlite3.Connection | None
                  ) -> tuple[list[tuple], list[tuple]]:
    """For the given seasons, fetch league info from API and persist BOTH
    the league_years row AND metadata_starters rows.

    For future seasons (no league_years row yet), default server=www48 + the
    most-recent league_id from local DB. This is the standard MFL pattern —
    once a league is on a server, it stays. New seasons reuse the same
    league_id.

    Returns (league_year_rows, metadata_starters_rows) for D1 upsert.
    """
    # Find most-recent server + league_id as the default for new seasons
    default_server = "www48"
    default_league_id = 74598
    if local_db is not None:
        try:
            row = local_db.execute(
                "SELECT server, league_id FROM league_years ORDER BY season DESC LIMIT 1"
            ).fetchone()
            if row:
                default_server, default_league_id = row[0], int(row[1])
        except sqlite3.OperationalError:
            pass

    year_rows: list[tuple] = []
    starter_rows: list[tuple] = []

    for season in seasons:
        # Pull existing server/league_id if we have it; else use default
        server, league_id = default_server, default_league_id
        if local_db is not None:
            row = local_db.execute(
                "SELECT server, league_id FROM league_years WHERE season=?",
                (season,),
            ).fetchone()
            if row:
                server, league_id = row[0], int(row[1])

        league = fetch_league_from_api(season, server, league_id)
        if not league:
            continue

        positions = parse_starters_from_api(league)
        if not positions:
            print(f"  {season}: no starters in API response", file=sys.stderr)
            continue

        print(f"  {season} (L={league_id} on {server}): "
              f"QB={positions.get('QB')}, TE={positions.get('TE')}", file=sys.stderr)

        year_rows.append((season, server, league_id))
        for pos, limit in sorted(positions.items()):
            starter_rows.append((season, pos, limit))

    return year_rows, starter_rows


# ---------------------------------------------------------------------
# Local DB UPSERTs (used after API fetch)
# ---------------------------------------------------------------------

def upsert_local_league_years(db: sqlite3.Connection, rows: list[tuple]) -> None:
    if not rows:
        return
    db.executemany(
        "INSERT INTO league_years (season, server, league_id) VALUES (?, ?, ?) "
        "ON CONFLICT(season) DO UPDATE SET server=excluded.server, "
        "league_id=excluded.league_id",
        rows,
    )
    db.commit()
    print(f"  local league_years: upserted {len(rows)} rows", file=sys.stderr)


def upsert_local_metadata_starters(db: sqlite3.Connection, rows: list[tuple]) -> None:
    if not rows:
        return
    db.executemany(
        "INSERT INTO metadata_starters (season, position_name, limit_range) "
        "VALUES (?, ?, ?) ON CONFLICT(season, position_name) DO UPDATE SET "
        "limit_range=excluded.limit_range",
        rows,
    )
    db.commit()
    print(f"  local metadata_starters: upserted {len(rows)} rows", file=sys.stderr)


# ---------------------------------------------------------------------
# D1 writes
# ---------------------------------------------------------------------

def push_to_d1(year_rows: list[tuple], starter_rows: list[tuple],
               settings_rows: list[tuple]) -> None:
    """Push three tables to D1 via D1Writer (UPSERT-by-PK)."""
    if year_rows:
        print(f"  D1 mfl_league_years: writing {len(year_rows)} rows...", file=sys.stderr)
        with D1Writer(
            table="mfl_league_years",
            cols=["season", "server", "league_id"],
            pk_cols=["season"],
        ) as w:
            for r in year_rows:
                w.add(r)

    if starter_rows:
        print(f"  D1 mfl_metadata_starters: writing {len(starter_rows)} rows...",
              file=sys.stderr)
        with D1Writer(
            table="mfl_metadata_starters",
            cols=["season", "position_name", "limit_range"],
            pk_cols=["season", "position_name"],
        ) as w:
            for r in starter_rows:
                w.add(r)

    if settings_rows:
        print(f"  D1 mfl_league_settings: writing {len(settings_rows)} rows...",
              file=sys.stderr)
        with D1Writer(
            table="mfl_league_settings",
            cols=["season", "qb_limit", "te_limit", "starters_json"],
            pk_cols=["season"],
        ) as w:
            for r in settings_rows:
                w.add(r)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", default=None,
                    help="Season filter for local mirror (e.g., '2010-2025'). "
                         "Default: all seasons in local DB.")
    ap.add_argument("--fetch-api", default=None,
                    help="Seasons to fetch via MFL API (e.g., '2026'). Updates "
                         "BOTH local DB and D1.")
    ap.add_argument("--skip-d1", action="store_true",
                    help="Skip D1 push (local-only debug)")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}\n"
                 f"(set MFL_DB_PATH env var if DB lives elsewhere)")

    db = sqlite3.connect(str(LOCAL_DB), timeout=30)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=30000")
    except sqlite3.DatabaseError:
        pass

    # ---- Step 1: API fetch (if requested) updates BOTH local + D1 sources ----
    if args.fetch_api:
        api_seasons = parse_seasons(args.fetch_api)
        print(f"Fetching {len(api_seasons)} season(s) from MFL API...", file=sys.stderr)
        api_years, api_starters = fetch_via_api(api_seasons, db)
        upsert_local_league_years(db, api_years)
        upsert_local_metadata_starters(db, api_starters)

    # ---- Step 2: read everything from local DB and mirror to D1 ----
    seasons = parse_seasons(args.seasons)
    year_rows = read_league_years_from_local(db, seasons)
    starter_rows = read_metadata_starters_from_local(db, seasons)
    settings_rows = derive_league_settings(starter_rows)

    print(f"Local: {len(year_rows)} league_years, {len(starter_rows)} starters, "
          f"{len(settings_rows)} settings rollups", file=sys.stderr)

    if args.skip_d1:
        print("DONE: --skip-d1 set, no D1 writes", file=sys.stderr)
        return

    push_to_d1(year_rows, starter_rows, settings_rows)
    print("DONE: D1 sync complete", file=sys.stderr)


if __name__ == "__main__":
    main()
