#!/usr/bin/env python3
"""Sync transactions_auction from local SQLite to D1.

The local SQLite `mfl_database.db` has full historical auction-bid
history (2011-2025) populated outside this repo. This fetcher mirrors
that table to D1 so cloud-side analyses (Layer 4 owner-pattern model,
Layer 5 simulator priors, Layer 6 league-wide realism) can read it
without depending on the local DB.

Default window: 2020-2025 (the brief's owner-pattern lookback).
Use --all-seasons to backfill the full 2011-2025 history.

Run:
  python3 pipelines/etl/scripts/fetch_transactions_auction.py
  python3 pipelines/etl/scripts/fetch_transactions_auction.py --seasons 2020-2025
  python3 pipelines/etl/scripts/fetch_transactions_auction.py --all-seasons
"""
from __future__ import annotations

import argparse
import os
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
sys.path.insert(0, str(ETL_ROOT))

from lib.d1_io import D1Writer  # noqa: E402

_DEFAULT_DB = Path(
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/"
    "Desktop/MFL_Scripts/Datastorage/mfl_database.db"
)
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

TABLE = "transactions_auction"
COLS = [
    "transactionid", "season", "txn_index",
    "auction_group_id", "auction_event_type", "transaction_type", "bid_sequence",
    "player_id", "player_name", "position", "nfl_team",
    "franchise_id", "team_name", "owner_name",
    "franchise_currentbid_id", "franchise_currentbid_team_name", "franchise_currentbid_owner_name",
    "franchise_forcing_id", "franchise_forcing_team_name", "franchise_forcing_owner_name",
    "bid_amount", "initialbid_ind", "finalbid_ind", "forced_bid_ind",
    "auction_type", "unix_timestamp", "datetime_et", "date_et", "time_et",
    "auction_start_ts", "seconds_since_start", "seconds_since_prev_bid",
    "comment_raw", "raw_json",
]
PK = ["transactionid"]


def parse_seasons(spec: str) -> list[int]:
    """Parse '2020-2025' or '2020,2022,2024' into a sorted list."""
    if "-" in spec:
        lo, hi = spec.split("-", 1)
        return list(range(int(lo), int(hi) + 1))
    return [int(s) for s in spec.split(",") if s.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2020-2025",
                    help="Range '2020-2025' or list '2020,2022'. Default: 2020-2025")
    ap.add_argument("--all-seasons", action="store_true",
                    help="Override --seasons; pull every season present in the local DB")
    ap.add_argument("--db-path", default=str(LOCAL_DB))
    ap.add_argument("--skip-d1", action="store_true",
                    help="Read locally + report counts, but don't push to D1")
    args = ap.parse_args()

    db_path = Path(args.db_path)
    if not db_path.exists():
        print(f"ERROR: local DB not found at {db_path}", file=sys.stderr)
        print("       Set MFL_DB_PATH env var if it's elsewhere.", file=sys.stderr)
        return 1

    conn = sqlite3.connect(db_path, timeout=30.0)
    conn.execute("PRAGMA busy_timeout=30000")

    try:
        if args.all_seasons:
            rows = conn.execute(
                f"SELECT DISTINCT season FROM {TABLE} ORDER BY season"
            ).fetchall()
            seasons = [r[0] for r in rows]
        else:
            seasons = parse_seasons(args.seasons)

        if not seasons:
            print("No seasons selected.", file=sys.stderr)
            return 1

        placeholders = ",".join("?" * len(seasons))
        col_list = ", ".join(COLS)
        query = (
            f"SELECT {col_list} FROM {TABLE} "
            f"WHERE season IN ({placeholders}) "
            f"ORDER BY season, txn_index"
        )

        per_season = dict(conn.execute(
            f"SELECT season, COUNT(*) FROM {TABLE} "
            f"WHERE season IN ({placeholders}) GROUP BY season",
            seasons,
        ).fetchall())
        total_expected = sum(per_season.values())

        print(f"Local DB: {db_path}")
        print(f"Seasons: {seasons}")
        print(f"Expected rows: {total_expected}")
        for s in seasons:
            print(f"  {s}: {per_season.get(s, 0)} rows")

        if args.skip_d1:
            print("\n--skip-d1 set; not writing to D1.")
            return 0

        with D1Writer(table=TABLE, cols=COLS, pk_cols=PK) as w:
            cursor = conn.execute(query, seasons)
            for row in cursor:
                w.add(row)

        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
