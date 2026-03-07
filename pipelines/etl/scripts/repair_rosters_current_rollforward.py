#!/usr/bin/env python3
"""Repair a target-season rosters_current snapshot using rollforward expectations."""

from __future__ import annotations

import argparse
import sqlite3

from build_roster_rollforward_csv import (
    DEFAULT_DB_PATH,
    DEFAULT_OVERRIDES_PATH,
    load_rollforward_overrides,
    load_source_rows,
    roll_row,
    safe_int,
    safe_str,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--base-season", type=int, default=2025)
    parser.add_argument("--target-season", type=int, default=2026)
    parser.add_argument("--overrides-json", default=str(DEFAULT_OVERRIDES_PATH))
    return parser.parse_args()


def target_has_rows(conn: sqlite3.Connection, season: int) -> bool:
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM rosters_current WHERE season = ?", (season,))
    return safe_int(cur.fetchone()[0], 0) > 0


def main() -> int:
    args = parse_args()
    db_path = str(args.db_path)
    base_season = int(args.base_season)
    target_season = int(args.target_season)
    overrides = load_rollforward_overrides(str(args.overrides_json))

    conn = sqlite3.connect(db_path)
    try:
        if not target_has_rows(conn, target_season):
            print(f"No rosters_current rows found for season {target_season}; nothing to repair.")
            return 0

        rolled = [
            roll_row(row, target_season, overrides=overrides)
            for row in load_source_rows(conn, base_season)
        ]

        update_sql = """
            UPDATE rosters_current
            SET salary = ?,
                contract_year = ?,
                contract_status = ?,
                contract_info = ?,
                contract_length = ?,
                tcv = ?,
                aav = ?,
                salary_yearminus1 = ?,
                salary_yearminus2 = ?,
                salary_yearplus1 = ?,
                salary_yearplus2 = ?,
                extension_flag = ?
            WHERE season = ?
              AND franchise_id = ?
              AND player_id = ?
              AND status = ?
        """

        payload = []
        for row in rolled:
            payload.append(
                (
                    safe_int(row.get("salary"), 0),
                    safe_int(row.get("contract_year"), 0),
                    safe_str(row.get("contract_status")),
                    safe_str(row.get("contract_info")),
                    safe_int(row.get("contract_length"), 0),
                    safe_int(row.get("tcv"), 0),
                    safe_int(row.get("aav"), 0),
                    row.get("salary_yearminus1"),
                    row.get("salary_yearminus2"),
                    row.get("salary_yearplus1"),
                    row.get("salary_yearplus2"),
                    safe_int(row.get("extension_flag"), 0),
                    target_season,
                    safe_str(row.get("franchise_id")),
                    safe_str(row.get("player_id")),
                    safe_str(row.get("status")),
                )
            )

        cur = conn.cursor()
        cur.executemany(update_sql, payload)
        conn.commit()
        print(f"Updated rosters_current season {target_season}: {cur.rowcount} rows")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
