#!/usr/bin/env python3
"""Remove the leaked 2026 Malik Nabers extension state from the local prod data path."""

from __future__ import annotations

import argparse
import json
import sqlite3
import subprocess
import sys
from pathlib import Path


PLAYER_ID = "16615"
FRANCHISE_ID = "0011"
SEASON = 2026


def fetchone_dict(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> dict | None:
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--repo-root", required=True)
    args = parser.parse_args()

    db_path = Path(args.db_path)
    repo_root = Path(args.repo_root)
    export_script = repo_root / "pipelines" / "etl" / "scripts" / "export_extension_previews_json.py"
    export_out = repo_root / "site" / "trades" / "extension_previews_2026.json"

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    before_preview_rows = conn.execute(
        "SELECT COUNT(*) FROM extension_previews WHERE nfl_season = ? AND player_id = ?",
        (SEASON, PLAYER_ID),
    ).fetchone()[0]
    before_event_rows = conn.execute(
        "SELECT COUNT(*) FROM contract_events WHERE nfl_season = ? AND player_id = ?",
        (SEASON, PLAYER_ID),
    ).fetchone()[0]
    before_version_rows = conn.execute(
        "SELECT COUNT(*) FROM contract_versions WHERE nfl_season = ? AND player_id = ?",
        (SEASON, PLAYER_ID),
    ).fetchone()[0]
    before_current_rows = conn.execute(
        "SELECT COUNT(*) FROM contracts_current WHERE player_id = ? AND franchise_id = ?",
        (PLAYER_ID, FRANCHISE_ID),
    ).fetchone()[0]

    rookie_row = fetchone_dict(
        conn,
        """
        SELECT season, week, franchise_id, team_name, player_id, player_name, status,
               salary, contract_year, contract_status, tcv, aav, contract_info
        FROM rosters_current
        WHERE season = ? AND player_id = ? AND franchise_id = ?
        ORDER BY week DESC
        LIMIT 1
        """,
        (SEASON, PLAYER_ID, FRANCHISE_ID),
    )
    if not rookie_row:
        raise SystemExit("No 2026 rosters_current row found for Malik Nabers")
    if (
        rookie_row["contract_status"] != "Rookie"
        or int(rookie_row["contract_year"]) != 1
        or int(rookie_row["tcv"]) != 39000
        or int(rookie_row["aav"]) != 13000
    ):
        raise SystemExit(
            "rosters_current does not contain the expected rookie-state source row for Malik Nabers"
        )

    leaked_event_ids = [
        row[0]
        for row in conn.execute(
            """
            SELECT event_id
            FROM contract_events
            WHERE nfl_season = ?
              AND player_id = ?
              AND franchise_id = ?
              AND event_type = 'EXTENSION'
            """,
            (SEASON, PLAYER_ID, FRANCHISE_ID),
        ).fetchall()
    ]

    with conn:
        conn.execute(
            "DELETE FROM extension_previews WHERE nfl_season = ? AND player_id = ? AND franchise_id = ?",
            (SEASON, PLAYER_ID, FRANCHISE_ID),
        )
        conn.execute(
            "DELETE FROM contract_versions WHERE nfl_season = ? AND player_id = ? AND franchise_id = ?",
            (SEASON, PLAYER_ID, FRANCHISE_ID),
        )
        conn.execute(
            "DELETE FROM contracts_current WHERE player_id = ? AND franchise_id = ?",
            (PLAYER_ID, FRANCHISE_ID),
        )
        if leaked_event_ids:
            conn.executemany(
                "DELETE FROM contract_events WHERE event_id = ?",
                [(event_id,) for event_id in leaked_event_ids],
            )

    after_preview_rows = conn.execute(
        "SELECT COUNT(*) FROM extension_previews WHERE nfl_season = ? AND player_id = ?",
        (SEASON, PLAYER_ID),
    ).fetchone()[0]
    after_event_rows = conn.execute(
        "SELECT COUNT(*) FROM contract_events WHERE nfl_season = ? AND player_id = ?",
        (SEASON, PLAYER_ID),
    ).fetchone()[0]
    after_version_rows = conn.execute(
        "SELECT COUNT(*) FROM contract_versions WHERE nfl_season = ? AND player_id = ?",
        (SEASON, PLAYER_ID),
    ).fetchone()[0]
    after_current_rows = conn.execute(
        "SELECT COUNT(*) FROM contracts_current WHERE player_id = ? AND franchise_id = ?",
        (PLAYER_ID, FRANCHISE_ID),
    ).fetchone()[0]
    conn.close()

    subprocess.run(
        [
            sys.executable,
            str(export_script),
            "--db-path",
            str(db_path),
            "--season",
            str(SEASON),
            "--out-path",
            str(export_out),
        ],
        check=True,
    )

    print(
        json.dumps(
            {
                "player_id": PLAYER_ID,
                "player_name": rookie_row["player_name"],
                "rookie_source_row": rookie_row,
                "before": {
                    "extension_previews": before_preview_rows,
                    "contract_events": before_event_rows,
                    "contract_versions": before_version_rows,
                    "contracts_current": before_current_rows,
                    "event_ids": leaked_event_ids,
                },
                "after": {
                    "extension_previews": after_preview_rows,
                    "contract_events": after_event_rows,
                    "contract_versions": after_version_rows,
                    "contracts_current": after_current_rows,
                },
                "extension_preview_json": str(export_out),
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
