#!/usr/bin/env python3
"""Player biographical reference data — birth_date, draft, height/weight.

One-shot fetcher for `dim_player_bio` table. Source: nflreadpy.load_players().

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_player_bio.py
  python3 pipelines/etl/scripts/fetch_nflverse_player_bio.py --skip-d1

Override DB path with $MFL_DB_PATH.
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

TABLE = "dim_player_bio"
COLS = ["gsis_id", "display_name", "position", "position_group", "birth_date",
        "height_in", "weight_lb", "college", "rookie_season", "last_season",
        "draft_year", "draft_round", "draft_pick", "draft_team",
        "pfr_id", "espn_id", "updated_at"]
PK = ["gsis_id"]


def ensure_table(db: sqlite3.Connection) -> None:
    db.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
          gsis_id          TEXT PRIMARY KEY,
          display_name     TEXT,
          position         TEXT,
          position_group   TEXT,
          birth_date       TEXT,
          height_in        INTEGER,
          weight_lb        INTEGER,
          college          TEXT,
          rookie_season    INTEGER,
          last_season      INTEGER,
          draft_year       INTEGER,
          draft_round      INTEGER,
          draft_pick       INTEGER,
          draft_team       TEXT,
          pfr_id           TEXT,
          espn_id          TEXT,
          updated_at       TEXT
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_dim_player_bio_pfr ON {TABLE} (pfr_id)")
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_dim_player_bio_pos ON {TABLE} (position)")
    db.commit()


def _to_int(v):
    if v is None or (isinstance(v, float) and v != v):  # NaN
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _to_str(v):
    if v is None or (isinstance(v, float) and v != v):
        return None
    s = str(v).strip()
    return s or None


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-local", action="store_true")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()

    try:
        import nflreadpy as nfl
    except Exception as e:
        sys.exit(f"FATAL: import failed: {type(e).__name__}: {e}")

    print("Loading nflverse players parquet...", file=sys.stderr)
    df = nfl.load_players()
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    print(f"  {len(df)} player rows", file=sys.stderr)

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows = []
    for _, r in df.iterrows():
        gsis = _to_str(r.get("gsis_id"))
        if not gsis:
            continue
        rows.append((
            gsis,
            _to_str(r.get("display_name")),
            _to_str(r.get("position")),
            _to_str(r.get("position_group")),
            _to_str(r.get("birth_date")),
            _to_int(r.get("height")),
            _to_int(r.get("weight")),
            _to_str(r.get("college_name")),
            _to_int(r.get("rookie_season")),
            _to_int(r.get("last_season")),
            _to_int(r.get("draft_year")),
            _to_int(r.get("draft_round")),
            _to_int(r.get("draft_pick")),
            _to_str(r.get("draft_team")),
            _to_str(r.get("pfr_id")),
            _to_str(r.get("espn_id")),
            now,
        ))
    print(f"  {len(rows)} rows with non-null gsis_id", file=sys.stderr)

    db: sqlite3.Connection | None = None
    if args.skip_local:
        print("DB: D1-only (--skip-local)", file=sys.stderr)
    else:
        if not LOCAL_DB.exists():
            sys.exit(f"local DB missing at {LOCAL_DB}\n"
                     f"(set MFL_DB_PATH or pass --skip-local)")
        print(f"DB: {LOCAL_DB}", file=sys.stderr)
        db = sqlite3.connect(str(LOCAL_DB), timeout=30)
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=30000")
        except sqlite3.DatabaseError:
            pass
        try:
            ensure_table(db)
        except sqlite3.OperationalError as e:
            print(f"  [schema] local ensure FAILED ({e})", file=sys.stderr)

    if db is not None:
        try:
            update_cols = [c for c in COLS if c not in PK]
            set_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)
            placeholders = ", ".join(["?"] * len(COLS))
            db.executemany(
                f"INSERT INTO {TABLE} ({', '.join(COLS)}) VALUES ({placeholders}) "
                f"ON CONFLICT({', '.join(PK)}) DO UPDATE SET {set_clause}",
                rows,
            )
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [bio] local FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    print(f"DONE: {len(rows)} bio rows "
          f"(local={'skipped' if args.skip_local else 'ok'}, "
          f"d1={'skipped' if args.skip_d1 else 'ok'})", file=sys.stderr)


if __name__ == "__main__":
    main()
