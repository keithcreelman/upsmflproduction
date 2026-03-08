#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--out-path", required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT
              id,
              nfl_season,
              franchise_id,
              player_id,
              preview_ts,
              extension_term,
              loaded_indicator,
              success,
              error_message,
              new_contract_status,
              new_contract_length,
              new_TCV,
              new_aav_current,
              new_aav_future,
              new_contract_guarantee,
              preview_contract_info_string,
              franchise_name,
              player_name,
              position,
              committed,
              committed_ts,
              committed_event_id,
              mfl_post_status,
              mfl_post_ts,
              mfl_post_error,
              reverted,
              reverted_ts,
              reverted_event_id,
              mfl_revert_status,
              mfl_revert_ts,
              mfl_revert_error
            FROM extension_previews
            WHERE nfl_season = ?
              AND success = 1
            ORDER BY player_name, extension_term, preview_ts, id
            """,
            (args.season,),
        ).fetchall()

        out_path = Path(args.out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "meta": {
                "season": args.season,
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "row_count": len(rows),
                "db_path": args.db_path,
                "table": "extension_previews",
                "success_only": True,
                "columns": list(rows[0].keys()) if rows else [],
            },
            "rows": [dict(row) for row in rows],
        }
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(json.dumps({"out_path": str(out_path), "row_count": len(rows)}))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
