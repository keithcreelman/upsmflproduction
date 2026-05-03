#!/usr/bin/env python3
"""Per-(season, gsis_id, role) breakaway-play counts at 15/20/40 yard thresholds.

Source: nflreadpy.load_pbp(). Writes to nfl_player_breakaway_season (see
worker/migrations/0024_player_breakaway_season.sql).

Rushing scope — pure designed runs:
  play_type='run' AND qb_dropback=0   (excludes scrambles + sacks)

Receiving scope — completed catches:
  play_type='pass' AND complete_pass=1

Per-role row stores: total attempts/yards/longest, plus
plays_Nplus + yards_Nplus for N in (15, 20, 40). Breakaway *rates*
are derived at read-time as plays_Nplus / attempts.

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_breakaway.py --seasons 2011-2025
  python3 pipelines/etl/scripts/fetch_nflverse_breakaway.py --seasons 2024 --skip-d1

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

TABLE = "nfl_player_breakaway_season"
COLS = [
    "season", "gsis_id", "role", "position",
    "attempts", "yards", "longest",
    "plays_15plus", "yards_15plus",
    "plays_20plus", "yards_20plus",
    "plays_40plus", "yards_40plus",
]
PK = ["season", "gsis_id", "role"]
THRESHOLDS = (15, 20, 40)


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
          season             INTEGER NOT NULL,
          gsis_id            TEXT    NOT NULL,
          role               TEXT    NOT NULL,
          position           TEXT,
          attempts           INTEGER,
          yards              INTEGER,
          longest            INTEGER,
          plays_15plus       INTEGER,
          yards_15plus       INTEGER,
          plays_20plus       INTEGER,
          yards_20plus       INTEGER,
          plays_40plus       INTEGER,
          yards_40plus       INTEGER,
          PRIMARY KEY (season, gsis_id, role)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_breakaway_player_season ON {TABLE} (gsis_id, season)")
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_breakaway_season_role ON {TABLE} (season, role)")
    db.commit()


def _aggregate(sub, id_col: str, role: str, season: int) -> list[tuple]:
    """Build one row per (gsis_id) for the given role."""
    import pandas as pd
    if sub.empty:
        return []
    sub = sub.copy()
    sub["yards_gained"] = pd.to_numeric(sub["yards_gained"], errors="coerce").fillna(0)
    rows: list[tuple] = []
    grp = sub.groupby(id_col, dropna=True)
    for pid, g in grp:
        ygs = g["yards_gained"]
        attempts = int(len(g))
        total_yards = int(ygs.sum())
        longest = int(ygs.max()) if attempts else 0
        # nflverse PBP doesn't carry a clean per-play position; leave None.
        # The crosswalk join at read-time supplies position.
        out = [season, str(pid), role, None,
               attempts, total_yards, longest]
        for n in THRESHOLDS:
            mask = ygs >= n
            out.append(int(mask.sum()))
            out.append(int(ygs[mask].sum()))
        rows.append(tuple(out))
    return rows


def process_season(db: sqlite3.Connection, season: int, args) -> int:
    try:
        import nflreadpy as nfl
        import pandas as pd
    except Exception as e:
        sys.exit(f"FATAL: import failed: {type(e).__name__}: {e}")

    print(f"  loading PBP for {season}...", file=sys.stderr)
    df = nfl.load_pbp(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()

    df = df[df["season_type"].isin(["REG", "POST"])]

    # Designed rushes: play_type='run' AND qb_dropback=0 (excludes scrambles +
    # sacks-turned-runs). The Keith-confirmed scope (2026-04-28).
    rush = df[
        (df["play_type"] == "run")
        & (df["qb_dropback"].fillna(0) == 0)
        & (df["rusher_player_id"].notna())
    ]

    # Completed receptions.
    rec = df[
        (df["play_type"] == "pass")
        & (df["complete_pass"].fillna(0) == 1)
        & (df["receiver_player_id"].notna())
    ]

    rows = []
    rows.extend(_aggregate(rush, "rusher_player_id", "rusher", season))
    rows.extend(_aggregate(rec, "receiver_player_id", "receiver", season))

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
                f"ON CONFLICT({', '.join(PK)}) DO UPDATE SET {set_clause}",
                rows,
            )
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [breakaway {season}] local FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    print(f"  {season}: rows={len(rows)} "
          f"(rushers={sum(1 for r in rows if r[2]=='rusher')}, "
          f"receivers={sum(1 for r in rows if r[2]=='receiver')})",
          file=sys.stderr)
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--skip-local", action="store_true")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()

    db: sqlite3.Connection | None = None
    if args.skip_local:
        print("DB: D1-only (--skip-local)", file=sys.stderr)
    else:
        if not LOCAL_DB.exists():
            sys.exit(f"local DB missing at {LOCAL_DB}\n"
                     f"(set MFL_DB_PATH env var if DB lives elsewhere, "
                     f"or pass --skip-local for D1-only)")
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
            print(f"  [schema] local ensure FAILED ({e}) — continuing in D1-only mode",
                  file=sys.stderr)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    total = 0
    for s in seasons:
        total += process_season(db, s, args)

    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: rows={total} across {len(seasons)} seasons "
          f"(local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
