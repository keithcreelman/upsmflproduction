#!/usr/bin/env python3
"""Per-(season, gsis_id) injury-report rollup from nflverse load_injuries().

Source: NFL official injury reports (per game week, per player).
Aggregated to season level with counts of out/doubtful/questionable
designations. weeks_designated is the "any flag" count.

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_injuries.py --seasons 2009-2025
  python3 pipelines/etl/scripts/fetch_nflverse_injuries.py --seasons 2024 --skip-d1

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

TABLE = "nfl_player_injuries_season"
COLS = ["season", "gsis_id", "weeks_out", "weeks_doubtful",
        "weeks_questionable", "weeks_designated", "distinct_body_parts"]
PK = ["season", "gsis_id"]


def parse_seasons(spec: str) -> list[int]:
    out = set()
    for piece in spec.split(","):
        piece = piece.strip()
        if not piece: continue
        if "-" in piece:
            a, b = piece.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(piece))
    return sorted(out)


def ensure_table(db):
    db.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
          season              INTEGER NOT NULL,
          gsis_id             TEXT    NOT NULL,
          weeks_out           INTEGER,
          weeks_doubtful      INTEGER,
          weeks_questionable  INTEGER,
          weeks_designated    INTEGER,
          distinct_body_parts INTEGER,
          PRIMARY KEY (season, gsis_id)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_injuries_player_season ON {TABLE} (gsis_id, season)")
    db.commit()


def process_season(db, season, args):
    try:
        import nflreadpy as nfl
        import pandas as pd
    except Exception as e:
        sys.exit(f"FATAL import: {e}")

    print(f"  loading injuries for {season}...", file=sys.stderr)
    df = nfl.load_injuries(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df[df["gsis_id"].notna()]
    if df.empty:
        print(f"  {season}: no rows", file=sys.stderr)
        return 0

    # Aggregate per (season, gsis_id)
    rows = []
    for gsis, g in df.groupby("gsis_id", dropna=True):
        statuses = g["report_status"].fillna("").str.strip()
        weeks_out = int((statuses == "Out").sum())
        weeks_doubtful = int((statuses == "Doubtful").sum())
        weeks_questionable = int((statuses == "Questionable").sum())
        weeks_designated = int((statuses != "").sum())
        body_parts = g["report_primary_injury"].dropna().astype(str).str.strip()
        distinct_parts = int(body_parts[body_parts != ""].nunique())
        rows.append((season, str(gsis), weeks_out, weeks_doubtful,
                     weeks_questionable, weeks_designated, distinct_parts))

    if not args.skip_local and db is not None:
        try:
            update_cols = [c for c in COLS if c not in PK]
            set_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)
            placeholders = ", ".join(["?"] * len(COLS))
            db.executemany(
                f"INSERT INTO {TABLE} ({', '.join(COLS)}) VALUES ({placeholders}) "
                f"ON CONFLICT({', '.join(PK)}) DO UPDATE SET {set_clause}", rows)
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [injuries {season}] local FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    print(f"  {season}: rows={len(rows)}", file=sys.stderr)
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2009-2025")  # nflverse injuries start ~2009
    ap.add_argument("--skip-local", action="store_true")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()

    db = None
    if args.skip_local:
        print("DB: D1-only", file=sys.stderr)
    else:
        if not LOCAL_DB.exists():
            sys.exit(f"local DB missing at {LOCAL_DB}")
        db = sqlite3.connect(str(LOCAL_DB), timeout=30)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=30000")
        except sqlite3.DatabaseError:
            pass
        try:
            ensure_table(db)
        except sqlite3.OperationalError as e:
            print(f"  [schema] FAILED ({e})", file=sys.stderr)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)
    total = 0
    for s in seasons:
        total += process_season(db, s, args)
    print(f"DONE: {total} rows", file=sys.stderr)


if __name__ == "__main__":
    main()
