#!/usr/bin/env python3
"""Per-(player, season) FPOE = total_fp - total_xfp from nflverse.

Source: nflreadpy.load_ff_opportunity() — already provides per-game
expected and actual fantasy points (full PPR by default). We sum across
weeks per (season, player_id) and split by category (rec / rush / pass).

NEW table — no overlap with existing player tables. Per the Lurking
Rule (data_quality_findings_20260425.md), each new column belongs to
exactly one fetcher; this script owns nfl_player_ff_opportunity_season.

Run:
  python3 pipelines/etl/scripts/fetch_nflverse_ff_opportunity.py --seasons 2011-2025

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

TABLE = "nfl_player_ff_opportunity_season"
COLS = ["season", "gsis_id", "position", "games",
        "total_fp", "total_xfp", "fpoe", "fpoe_per_g",
        "rec_xfp", "rec_fpoe",
        "rush_xfp", "rush_fpoe",
        "pass_xfp", "pass_fpoe"]
PK = ["season", "gsis_id"]


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
          season       INTEGER NOT NULL,
          gsis_id      TEXT    NOT NULL,
          position     TEXT,
          games        INTEGER,
          total_fp     REAL,
          total_xfp    REAL,
          fpoe         REAL,
          fpoe_per_g   REAL,
          rec_xfp      REAL,
          rec_fpoe     REAL,
          rush_xfp     REAL,
          rush_fpoe    REAL,
          pass_xfp     REAL,
          pass_fpoe    REAL,
          PRIMARY KEY (season, gsis_id)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_ffopp_player_season ON {TABLE} (gsis_id, season)")
    db.commit()


def process_season(db: sqlite3.Connection, season: int, args) -> int:
    try:
        import nflreadpy as nfl
        import pandas as pd
    except Exception as e:
        sys.exit(f"FATAL: import failed: {type(e).__name__}: {e}")

    print(f"  loading ff_opportunity for {season}...", file=sys.stderr)
    df = nfl.load_ff_opportunity(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()

    if df.empty:
        print(f"  {season}: no rows", file=sys.stderr)
        return 0

    # nflverse uses player_id in GSIS form (00-NNNNNNN). Make sure we drop
    # rows with no player_id (rare special-teams oddities).
    df = df[df["player_id"].notna()].copy()

    num = lambda c: pd.to_numeric(df[c], errors="coerce").fillna(0)
    df["_total_fp"]  = num("total_fantasy_points")
    df["_total_xfp"] = num("total_fantasy_points_exp")
    df["_rec_fp"]    = num("rec_fantasy_points")
    df["_rec_xfp"]   = num("rec_fantasy_points_exp")
    df["_rush_fp"]   = num("rush_fantasy_points")
    df["_rush_xfp"]  = num("rush_fantasy_points_exp")
    df["_pass_fp"]   = num("pass_fantasy_points")
    df["_pass_xfp"]  = num("pass_fantasy_points_exp")

    grp = df.groupby("player_id", dropna=True)
    rows: list[tuple] = []
    for pid, g in grp:
        position = None
        if "position" in g.columns and not g["position"].isna().all():
            position = g["position"].dropna().iloc[0] if not g["position"].dropna().empty else None
        games = int(g["week"].nunique())
        total_fp  = float(g["_total_fp"].sum())
        total_xfp = float(g["_total_xfp"].sum())
        rec_fp    = float(g["_rec_fp"].sum())
        rec_xfp   = float(g["_rec_xfp"].sum())
        rush_fp   = float(g["_rush_fp"].sum())
        rush_xfp  = float(g["_rush_xfp"].sum())
        pass_fp   = float(g["_pass_fp"].sum())
        pass_xfp  = float(g["_pass_xfp"].sum())
        fpoe = total_fp - total_xfp
        fpoe_per_g = fpoe / games if games else None
        rows.append((
            season, str(pid),
            position if position is not None else None,
            games, total_fp, total_xfp, fpoe, fpoe_per_g,
            rec_xfp, rec_fp - rec_xfp,
            rush_xfp, rush_fp - rush_xfp,
            pass_xfp, pass_fp - pass_xfp,
        ))

    if not args.skip_local:
        try:
            db.executemany(f"""
                INSERT INTO {TABLE}
                  (season, gsis_id, position, games,
                   total_fp, total_xfp, fpoe, fpoe_per_g,
                   rec_xfp, rec_fpoe,
                   rush_xfp, rush_fpoe,
                   pass_xfp, pass_fpoe)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(season, gsis_id) DO UPDATE SET
                  position   = excluded.position,
                  games      = excluded.games,
                  total_fp   = excluded.total_fp,
                  total_xfp  = excluded.total_xfp,
                  fpoe       = excluded.fpoe,
                  fpoe_per_g = excluded.fpoe_per_g,
                  rec_xfp    = excluded.rec_xfp,
                  rec_fpoe   = excluded.rec_fpoe,
                  rush_xfp   = excluded.rush_xfp,
                  rush_fpoe  = excluded.rush_fpoe,
                  pass_xfp   = excluded.pass_xfp,
                  pass_fpoe  = excluded.pass_fpoe
            """, rows)
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [ffopp {season}] local: FAILED ({e})", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            for r in rows:
                w.add(r)

    print(f"  {season}: {len(rows)} player rows", file=sys.stderr)
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

    total = 0
    for s in seasons:
        total += process_season(db, s, args)

    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: {total} player rows across {len(seasons)} seasons "
          f"(local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
