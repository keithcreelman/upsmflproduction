#!/usr/bin/env python3
"""Fetch the ffverse / DynastyProcess all-eras player-ID crosswalk → ff_player_ids.

The repo's player_id_crosswalk only covers MFL's CURRENT pool, so retired
players (2012-era) have no mfl_id→gsis_id mapping and their MFL fantasy scores
can't join — historical "MFL PTS" shows blank. db_playerids.csv is the all-eras
map (one row per MFL player_id ever) and also carries sleeper_id / ktc_id /
fantasypros_id / pfr_id for cross-source ADP joining.

Source : https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv
Writes : local mfl_database.db + D1 ff_player_ids (dual-write; UPSERT by mfl_id)

Usage:
  python3 pipelines/etl/scripts/fetch_ff_playerids.py
  python3 pipelines/etl/scripts/fetch_ff_playerids.py --skip-d1
"""
from __future__ import annotations
import argparse
import csv
import io
import sqlite3
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

LOCAL_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
CSV_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"

COLS = ["mfl_id", "gsis_id", "sleeper_id", "ktc_id", "fantasypros_id",
        "pfr_id", "espn_id", "name", "merge_name", "position", "team", "birthdate"]

DDL = """
CREATE TABLE IF NOT EXISTS ff_player_ids (
  mfl_id TEXT PRIMARY KEY, gsis_id TEXT, sleeper_id TEXT, ktc_id TEXT,
  fantasypros_id TEXT, pfr_id TEXT, espn_id TEXT, name TEXT, merge_name TEXT,
  position TEXT, team TEXT, birthdate TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_gsis    ON ff_player_ids(gsis_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_sleeper ON ff_player_ids(sleeper_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_ktc     ON ff_player_ids(ktc_id);
"""


def fetch_rows() -> list[tuple]:
    req = urllib.request.Request(CSV_URL, headers={"User-Agent": "ups-mfl-etl/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8")
    reader = csv.DictReader(io.StringIO(text))
    rows = []
    for r in reader:
        mfl = (r.get("mfl_id") or "").strip()
        if not mfl:
            continue  # the table is keyed by MFL id; rows without one are useless here
        rows.append(tuple((r.get(c) or "").strip() or None for c in COLS))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()
    print(f"fetching {CSV_URL} …", file=sys.stderr)
    rows = fetch_rows()
    print(f"  {len(rows)} rows with an mfl_id", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB))
        db.executescript(DDL)
        ph = ",".join("?" * len(COLS))
        sets = ",".join(f"{c}=excluded.{c}" for c in COLS if c != "mfl_id")
        db.executemany(
            f"INSERT INTO ff_player_ids ({','.join(COLS)}) VALUES ({ph}) "
            f"ON CONFLICT(mfl_id) DO UPDATE SET {sets}",
            rows,
        )
        db.commit()
        db.close()
        print("  wrote local ff_player_ids", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="ff_player_ids", cols=COLS, pk_cols=["mfl_id"], chunk_size=200) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
