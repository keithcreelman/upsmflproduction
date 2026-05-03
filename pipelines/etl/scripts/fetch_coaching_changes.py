#!/usr/bin/env python3
"""Per-(season, team) head coach + change flags from nflverse schedules.

Source: nflreadpy.load_schedules() exposes `home_coach` / `away_coach`
per game, fully populated 2011-2025. We pick the most-frequent HC per
(season, team) — handles in-season firings (the new coach wins ties
toward season-end). Year-with-team and change-vs-prior-season flags
derive from the resulting time series.

OC/DC are NOT in load_schedules, so those columns stay NULL until a
PFR scrape gets wired in. Schema reserves slots for them.

Run:
  python3 pipelines/etl/scripts/fetch_coaching_changes.py --seasons 2011-2025

Override DB path with $MFL_DB_PATH.
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

TABLE = "nfl_team_coaching_history"
COLS = ["season", "team", "hc_name", "oc_name", "dc_name",
        "hc_year_with_team", "oc_year_with_team", "dc_year_with_team",
        "hc_change_flag", "oc_change_flag", "dc_change_flag"]
PK = ["season", "team"]


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
    db.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
          season              INTEGER NOT NULL,
          team                TEXT    NOT NULL,
          hc_name             TEXT,
          oc_name             TEXT,
          dc_name             TEXT,
          hc_year_with_team   INTEGER,
          oc_year_with_team   INTEGER,
          dc_year_with_team   INTEGER,
          hc_change_flag      INTEGER,
          oc_change_flag      INTEGER,
          dc_change_flag      INTEGER,
          PRIMARY KEY (season, team)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_coaching_team ON {TABLE} (team, season)")
    db.commit()


def gather_hc_per_team_season(seasons: list[int]) -> dict[tuple[int, str], str]:
    """Returns {(season, team): hc_name}. Picks majority coach per
    season — in-season firings break the tie toward whoever ran more
    games (typically the new HC if fired by midseason; old HC if late)."""
    try:
        import nflreadpy as nfl
    except Exception as e:
        sys.exit(f"FATAL: could not import nflreadpy: {type(e).__name__}: {e}")

    counters: dict[tuple[int, str], Counter] = defaultdict(Counter)
    for season in seasons:
        print(f"  loading schedules for {season}...", file=sys.stderr)
        df = nfl.load_schedules(seasons=[season])
        if hasattr(df, "to_pandas"):
            df = df.to_pandas()
        df = df[df["game_type"] == "REG"]   # regular season defines HC tenure
        for r in df.to_dict(orient="records"):
            for side in ("home", "away"):
                team = r.get(f"{side}_team")
                coach = r.get(f"{side}_coach")
                if team and coach:
                    counters[(season, str(team))][str(coach).strip()] += 1

    return {key: c.most_common(1)[0][0] for key, c in counters.items()}


def build_rows(hc_map: dict[tuple[int, str], str], seasons: list[int]) -> list[tuple]:
    """Compute year-with-team + change flag from the (season, team) → hc map."""
    teams = sorted({t for (_s, t) in hc_map.keys()})
    rows: list[tuple] = []

    # Per-team timeline: walk seasons in order, track current HC + year counter.
    for team in teams:
        prev_hc: str | None = None
        year_counter = 0
        for season in seasons:
            hc = hc_map.get((season, team))
            if hc is None:
                # team didn't exist that season (relocations, expansion); skip
                continue
            if hc == prev_hc:
                year_counter += 1
                change = 0
            else:
                year_counter = 1
                # change_flag=1 only when prev_hc is known and differs;
                # first observed season for a team gets change=NULL since
                # we have no prior baseline.
                change = 1 if prev_hc is not None else None
            rows.append((
                season, team, hc, None, None,    # hc_name, oc, dc
                year_counter, None, None,         # year_with_team
                change, None, None,               # change flags
            ))
            prev_hc = hc

    return rows


def write_rows(db: sqlite3.Connection, rows: list[tuple], args) -> int:
    if not rows:
        return 0
    if not args.skip_local:
        try:
            db.executemany(f"""
                INSERT INTO {TABLE}
                  (season, team, hc_name, oc_name, dc_name,
                   hc_year_with_team, oc_year_with_team, dc_year_with_team,
                   hc_change_flag, oc_change_flag, dc_change_flag)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(season, team) DO UPDATE SET
                  hc_name           = excluded.hc_name,
                  hc_year_with_team = excluded.hc_year_with_team,
                  hc_change_flag    = excluded.hc_change_flag
            """, rows)
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [coaching] local: FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--skip-local", action="store_true")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()

    if not args.skip_local and not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}\n"
                 f"(set MFL_DB_PATH env var if DB lives elsewhere)")
    print(f"DB: {LOCAL_DB}", file=sys.stderr)
    db = sqlite3.connect(str(LOCAL_DB), timeout=30)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=30000")
    except sqlite3.DatabaseError:
        pass
    if not args.skip_local:
        try:
            ensure_table(db)
        except sqlite3.OperationalError as e:
            print(f"  [schema] local ensure FAILED ({e}) — continuing in D1-only mode",
                  file=sys.stderr)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    hc_map = gather_hc_per_team_season(seasons)
    rows = build_rows(hc_map, seasons)
    n = write_rows(db, rows, args)
    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: {n} (season, team) rows "
          f"(local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
