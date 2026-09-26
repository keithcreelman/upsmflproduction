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

# yahoo_id added 2026-08-11 for the multi-platform fantasy pipeline (migration
# 0132). It was ALWAYS present in the upstream CSV — this fetcher just never
# selected it. Verified against the live header on 2026-08-11: `yahoo_id` is
# column 9 of db_playerids.csv.
#
# ⚠️ THE HEADER NAME MATTERS MORE THAN IT LOOKS. Every run rewrites all non-PK
# columns via ON CONFLICT DO UPDATE, so if this name did not match the upstream
# header, `r.get("yahoo_id")` would return None and the next Wednesday cron
# would silently wipe yahoo_id for all 12,468 rows. Re-verify the header before
# ever renaming this entry.
COLS = ["mfl_id", "gsis_id", "sleeper_id", "ktc_id", "fantasypros_id",
        "pfr_id", "espn_id", "yahoo_id", "name", "merge_name", "position",
        "team", "birthdate"]

# ⚠️ This DDL is for the LOCAL SQLite mirror only and uses CREATE TABLE IF NOT
# EXISTS, which is a NO-OP on an already-existing table. Adding a column to
# COLS therefore does NOT add it locally — the local INSERT would fail with
# "no such column" while the D1 write succeeded. main() reconciles the local
# schema explicitly below for exactly this reason. (D1 got the column from
# migration 0132.)
DDL = """
CREATE TABLE IF NOT EXISTS ff_player_ids (
  mfl_id TEXT PRIMARY KEY, gsis_id TEXT, sleeper_id TEXT, ktc_id TEXT,
  fantasypros_id TEXT, pfr_id TEXT, espn_id TEXT, yahoo_id TEXT, name TEXT,
  merge_name TEXT, position TEXT, team TEXT, birthdate TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_gsis    ON ff_player_ids(gsis_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_sleeper ON ff_player_ids(sleeper_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_ktc     ON ff_player_ids(ktc_id);
CREATE INDEX IF NOT EXISTS idx_ff_player_ids_yahoo   ON ff_player_ids(yahoo_id);
"""


def ensure_local_columns(conn) -> None:
    """Add any COLS column the local mirror is missing.

    CREATE TABLE IF NOT EXISTS silently does nothing when the table already
    exists, so a new entry in COLS needs an explicit ALTER on the local side or
    the dual-write breaks with "no such column" — while D1, which got the column
    from a migration, keeps working. That asymmetry is easy to miss and hard to
    diagnose, so it is handled here rather than left to whoever edits COLS next.
    """
    have = {r[1] for r in conn.execute("PRAGMA table_info(ff_player_ids)")}
    for col in COLS:
        if col not in have:
            conn.execute(f"ALTER TABLE ff_player_ids ADD COLUMN {col} TEXT")
            print(f"  local mirror: added missing column {col}", file=sys.stderr)


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

    # A shrink guard, in the spirit of fetch_fantasypros_adp.py: this fetcher
    # rewrites every non-PK column on every run, so an upstream CSV that came
    # back truncated would quietly blank real ids across the whole table.
    yahoo_present = sum(1 for t in rows if t[COLS.index("yahoo_id")])
    print(f"  {yahoo_present}/{len(rows)} rows carry a yahoo_id "
          f"({100.0 * yahoo_present / len(rows):.1f}%)", file=sys.stderr)
    if yahoo_present == 0:
        # ⚠️ REFUSE. Zero yahoo_id values means the upstream header changed and
        # every row is about to be overwritten with NULL. An unreadable input is
        # never an empty one.
        sys.exit(
            "REFUSING TO WRITE: not one row carried a yahoo_id. The upstream "
            "CSV header has almost certainly changed. Re-check column names at "
            f"{CSV_URL} before running again — writing now would blank yahoo_id "
            "for every row."
        )

    if LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB))
        db.executescript(DDL)
        ensure_local_columns(db)
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
