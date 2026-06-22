#!/usr/bin/env python3
"""Fetch the nflverse all-time player master → nfl_player_names (gsis_id → name).

WHY: the advanced-stats leaderboard keys on nflverse gsis_id but resolved each
player's name from player_id_crosswalk, which is built from MFL's CURRENT player
pool. Players no longer in that pool (e.g. retired 2014 punters) therefore showed
blank names. nflreadpy.load_players() carries display_name for EVERY gsis_id
(1999→present), so this gives a season-correct name for every row in
nfl_player_weekly. The Worker COALESCEs the crosswalk name then this one.

Source : nflreadpy.load_players()  (~25k rows)
Writes : local mfl_database.db + D1 `nfl_player_names` (dual-write; UPSERT by gsis_id)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_player_names.py
  python3 pipelines/etl/scripts/fetch_nflverse_player_names.py --skip-d1   # local only
"""
from __future__ import annotations
import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

LOCAL_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")

DDL = """
CREATE TABLE IF NOT EXISTS nfl_player_names (
  gsis_id      TEXT PRIMARY KEY,
  display_name TEXT,
  position     TEXT,
  last_season  INTEGER,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP
);
"""


def fetch_rows() -> list[tuple]:
    import nflreadpy as nfl
    df = nfl.load_players()
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    out, seen = [], set()
    for r in df.to_dict("records"):
        gid = r.get("gsis_id")
        if not gid or str(gid) in seen:
            continue
        name = r.get("display_name")
        if not name:
            name = (str(r.get("first_name", "")).strip() + " " + str(r.get("last_name", "")).strip()).strip()
        if not name:
            continue
        ls = r.get("last_season")
        try:
            ls = int(ls) if ls is not None and str(ls) not in ("", "nan", "None") else None
        except (TypeError, ValueError):
            ls = None
        pos = (str(r.get("position") or "").upper() or None)
        seen.add(str(gid))
        out.append((str(gid), str(name), pos, ls))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-d1", action="store_true", help="write only the local mirror")
    args = ap.parse_args()

    print("fetching nflverse player master (load_players)…", file=sys.stderr)
    rows = fetch_rows()
    print(f"  {len(rows)} players with gsis_id + name", file=sys.stderr)
    if not rows:
        sys.exit("no rows — aborting")

    if LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB))
        db.executescript(DDL)
        db.executemany(
            """INSERT INTO nfl_player_names (gsis_id, display_name, position, last_season)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(gsis_id) DO UPDATE SET
                 display_name = excluded.display_name,
                 position     = excluded.position,
                 last_season  = excluded.last_season""",
            rows,
        )
        db.commit()
        db.close()
        print(f"  wrote {len(rows)} → local nfl_player_names", file=sys.stderr)
    else:
        print(f"  (local DB missing at {LOCAL_DB}; skipping local mirror)", file=sys.stderr)

    if not args.skip_d1:
        print("  D1: upserting nfl_player_names …", file=sys.stderr)
        with D1Writer(
            table="nfl_player_names",
            cols=["gsis_id", "display_name", "position", "last_season"],
            pk_cols=["gsis_id"],
            chunk_size=500,
        ) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
