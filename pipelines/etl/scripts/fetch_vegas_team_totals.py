#!/usr/bin/env python3
"""Per-team weekly Vegas implied totals from nflverse schedules.

For every (season, week, team) row we record:
  - is_home, opponent
  - this team's spread (negative = favored)
  - game total_line
  - implied_total = total_line/2 ± spread_line/2
  - actual_score (NULL for unplayed)

Source: nflreadpy.load_schedules() — `spread_line` is the HOME team's
spread (negative = home favored). Verified 2026-04-26 against 2024:
HOU @ IND with HOU favored at -155 ml shows spread_line=-3.0, so
home_implied = total/2 + spread_line/2 = (49 + (-3))/2 = 23 (IND, dog)
and away_implied = (49 - (-3))/2 = 26 (HOU, fav). ✓

Run:
  python3 pipelines/etl/scripts/fetch_vegas_team_totals.py --seasons 2011-2025
  python3 pipelines/etl/scripts/fetch_vegas_team_totals.py --seasons 2024 --skip-local

Override DB path with $MFL_DB_PATH.
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

TABLE = "nfl_team_vegas_weekly"
COLS = ["season", "week", "team", "opponent", "is_home",
        "spread", "total_line", "implied_total", "actual_score"]
PK = ["season", "week", "team"]


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
          season         INTEGER NOT NULL,
          week           INTEGER NOT NULL,
          team           TEXT    NOT NULL,
          opponent       TEXT,
          is_home        INTEGER,
          spread         REAL,
          total_line     REAL,
          implied_total  REAL,
          actual_score   INTEGER,
          PRIMARY KEY (season, week, team)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_vegas_team_season ON {TABLE} (team, season)")
    db.commit()


def _to_int(v):
    if v is None:
        return None
    try:
        if isinstance(v, float) and v != v:  # NaN
            return None
        return int(v)
    except (ValueError, TypeError):
        return None


def _to_float(v):
    if v is None:
        return None
    try:
        f = float(v)
        if f != f:
            return None
        return f
    except (ValueError, TypeError):
        return None


def process_season(db: sqlite3.Connection, season: int, args) -> int:
    try:
        import nflreadpy as nfl
    except Exception as e:
        sys.exit(f"FATAL: could not import nflreadpy: {type(e).__name__}: {e}")

    print(f"  loading schedules for {season}...", file=sys.stderr)
    df = nfl.load_schedules(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()

    # REG + POST only (preseason has no betting markets we trust)
    df = df[df["game_type"].isin(["REG", "POST", "WC", "DIV", "CON", "SB"])]

    rows = []
    for r in df.to_dict(orient="records"):
        wk = _to_int(r.get("week"))
        if wk is None:
            continue
        home = r.get("home_team")
        away = r.get("away_team")
        spread_line = _to_float(r.get("spread_line"))   # home's spread (neg = home favored)
        total_line = _to_float(r.get("total_line"))
        home_score = _to_int(r.get("home_score"))
        away_score = _to_int(r.get("away_score"))

        # Implied totals (when both spread + total available)
        if spread_line is not None and total_line is not None:
            home_implied = total_line / 2.0 + spread_line / 2.0
            away_implied = total_line / 2.0 - spread_line / 2.0
        else:
            home_implied = None
            away_implied = None

        # team_spread perspective:
        #   home: spread = -spread_line (negative when home favored)
        #   away: spread = +spread_line
        home_spread = (-spread_line) if spread_line is not None else None
        away_spread = (spread_line) if spread_line is not None else None

        if home:
            rows.append((season, wk, home, away, 1,
                         home_spread, total_line, home_implied, home_score))
        if away:
            rows.append((season, wk, away, home, 0,
                         away_spread, total_line, away_implied, away_score))

    if not rows:
        print(f"  {season}: no rows", file=sys.stderr)
        return 0

    if not args.skip_local:
        try:
            db.executemany(f"""
                INSERT INTO {TABLE}
                  (season, week, team, opponent, is_home,
                   spread, total_line, implied_total, actual_score)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(season, week, team) DO UPDATE SET
                  opponent      = excluded.opponent,
                  is_home       = excluded.is_home,
                  spread        = excluded.spread,
                  total_line    = excluded.total_line,
                  implied_total = excluded.implied_total,
                  actual_score  = excluded.actual_score
            """, rows)
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [vegas {season}] local: FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    print(f"  {season}: {len(rows)} team-game rows", file=sys.stderr)
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--skip-local", action="store_true",
                    help="Skip local SQLite UPSERT")
    ap.add_argument("--skip-d1", action="store_true",
                    help="Skip the D1 dual-write")
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

    total = 0
    for s in seasons:
        total += process_season(db, s, args)

    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: {total} rows across {len(seasons)} seasons "
          f"(local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
