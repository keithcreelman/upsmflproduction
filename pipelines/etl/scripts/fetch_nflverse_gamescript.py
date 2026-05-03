#!/usr/bin/env python3
"""Per-(season, gsis_id, role) plays + yards split by game-script category.

Source: nflreadpy.load_pbp() filtered by score_differential.

Buckets:
  leading  : score_differential >= +7
  neutral  : -7 < score_differential < +7
  trailing : score_differential <= -7

Rushing = play_type='run' AND qb_dropback=0 (excludes scrambles).
Receiving = play_type='pass' AND complete_pass=1.

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_gamescript.py --seasons 2014-2025
  python3 pipelines/etl/scripts/fetch_nflverse_gamescript.py --seasons 2024 --skip-d1

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

TABLE = "nfl_player_gamescript_season"
COLS = ["season", "gsis_id", "role",
        "plays_leading", "plays_neutral", "plays_trailing",
        "yards_leading", "yards_neutral", "yards_trailing"]
PK = ["season", "gsis_id", "role"]


def parse_seasons(spec):
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
          role                TEXT    NOT NULL,
          plays_leading       INTEGER,
          plays_neutral       INTEGER,
          plays_trailing      INTEGER,
          yards_leading       INTEGER,
          yards_neutral       INTEGER,
          yards_trailing      INTEGER,
          PRIMARY KEY (season, gsis_id, role)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_gamescript_player_season ON {TABLE} (gsis_id, season)")
    db.commit()


def _agg_role(sub, id_col, role, season):
    import pandas as pd
    if sub.empty: return []
    sub = sub.copy()
    sub["yards_gained"] = pd.to_numeric(sub["yards_gained"], errors="coerce").fillna(0)
    sub["score_differential"] = pd.to_numeric(sub["score_differential"], errors="coerce")
    rows = []
    for pid, g in sub.groupby(id_col, dropna=True):
        sd = g["score_differential"]
        ygs = g["yards_gained"]
        lead_mask = sd >= 7
        trail_mask = sd <= -7
        neutral_mask = ~lead_mask & ~trail_mask
        rows.append((
            season, str(pid), role,
            int(lead_mask.sum()), int(neutral_mask.sum()), int(trail_mask.sum()),
            int(ygs[lead_mask].sum()), int(ygs[neutral_mask].sum()),
            int(ygs[trail_mask].sum()),
        ))
    return rows


def process_season(db, season, args):
    try:
        import nflreadpy as nfl
        import pandas as pd
    except Exception as e:
        sys.exit(f"FATAL import: {e}")

    print(f"  loading PBP for {season}...", file=sys.stderr)
    df = nfl.load_pbp(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df[df["season_type"].isin(["REG", "POST"])]

    rush = df[(df["play_type"] == "run") & (df["qb_dropback"].fillna(0) == 0)
              & (df["rusher_player_id"].notna())]
    rec = df[(df["play_type"] == "pass") & (df["complete_pass"].fillna(0) == 1)
             & (df["receiver_player_id"].notna())]

    rows = []
    rows.extend(_agg_role(rush, "rusher_player_id", "rusher", season))
    rows.extend(_agg_role(rec, "receiver_player_id", "receiver", season))

    if not rows:
        print(f"  {season}: no rows", file=sys.stderr)
        return 0

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
            print(f"  [gamescript {season}] local FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    print(f"  {season}: rows={len(rows)}", file=sys.stderr)
    return len(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2014-2025")
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
