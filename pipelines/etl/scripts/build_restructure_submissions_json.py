#!/usr/bin/env python3
"""Build historical restructure submissions JSON for CCC submitted view."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_OUT_PATH = ROOT_DIR / "site" / "ccc" / "restructure_submissions.json"


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def normalize_pos(v: Any) -> str:
    raw = safe_str(v).upper()
    if raw in {"K", "PK"}:
        return "PK"
    if raw in {"P", "PN"}:
        return "P"
    if raw in {"DE", "DT", "DL"}:
        return "DL"
    if raw in {"CB", "S", "DB"}:
        return "DB"
    return raw


def fetch_rows(conn, season_filter: int | None) -> List[Dict[str, Any]]:
    sql = """
    SELECT
      league_id,
      season,
      franchise_id,
      franchise_name,
      player_id,
      player_name,
      position,
      salary,
      contract_year,
      contract_status,
      contract_info,
      submitted_at_utc,
      commish_override_flag,
      override_as_of_date,
      source
    FROM restructure_submissions
    WHERE COALESCE(player_id, '') <> ''
    """
    params: List[Any] = []
    if season_filter:
        sql += " AND CAST(season AS INTEGER) = ?"
        params.append(int(season_filter))
    sql += " ORDER BY COALESCE(submitted_at_utc, '') DESC, season DESC, franchise_id ASC, player_name ASC"

    out: List[Dict[str, Any]] = []
    for row in conn.execute(sql, params).fetchall():
        out.append(
            {
                "league_id": safe_str(row[0]),
                "season": safe_str(row[1]),
                "franchise_id": safe_str(row[2]).zfill(4)[-4:],
                "franchise_name": safe_str(row[3]),
                "player_id": safe_str(row[4]),
                "player_name": safe_str(row[5]),
                "position": normalize_pos(row[6]),
                "salary": safe_int(row[7]),
                "contract_year": safe_int(row[8]),
                "contract_status": safe_str(row[9]),
                "contract_info": safe_str(row[10]),
                "submitted_at_utc": safe_str(row[11]),
                "commish_override_flag": 1 if safe_int(row[12]) else 0,
                "override_as_of_date": safe_str(row[13]),
                "source": safe_str(row[14] or "restructure_submissions"),
            }
        )
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--out-path", default=str(DEFAULT_OUT_PATH))
    parser.add_argument("--season", type=int, default=0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_path = Path(args.out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = get_conn(args.db_path)
    try:
        rows = fetch_rows(conn, args.season if args.season else None)
    finally:
        conn.close()

    doc = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source": "restructure_submissions table",
            "season_filter": int(args.season) if args.season else None,
            "count": len(rows),
        },
        "submissions": rows,
    }
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
