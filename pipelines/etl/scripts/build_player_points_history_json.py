#!/usr/bin/env python3
"""Build CCC player points history JSON for multi-season rookie views."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_DB_PATH = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))
DEFAULT_OUT_PATH = ROOT_DIR / "site" / "ccc" / "player_points_history.json"


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--out-path", default=str(DEFAULT_OUT_PATH))
    parser.add_argument("--target-season", type=int, default=2026)
    parser.add_argument("--years-back", type=int, default=3)
    return parser.parse_args()


def load_rows(conn: sqlite3.Connection, min_season: int, max_season: int) -> List[Dict[str, Any]]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            season,
            player_id,
            player_name,
            points_total
        FROM player_pointssummary
        WHERE season BETWEEN ? AND ?
          AND points_total IS NOT NULL
        ORDER BY season DESC, player_id
        """,
        (min_season, max_season),
    )
    out: List[Dict[str, Any]] = []
    for season, player_id, player_name, points_total in cur.fetchall():
        out.append(
            {
                "season": safe_int(season),
                "player_id": safe_str(player_id),
                "player_name": safe_str(player_name),
                "points_total": round(safe_float(points_total), 1),
            }
        )
    return out


def main() -> int:
    args = parse_args()
    db_path = str(args.db_path)
    target = safe_int(args.target_season, 2026)
    years_back = max(1, safe_int(args.years_back, 3))
    min_season = target - years_back
    max_season = target - 1

    conn = sqlite3.connect(db_path)
    try:
        rows = load_rows(conn, min_season, max_season)
    finally:
        conn.close()

    out_doc = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "target_season": target,
            "season_range": [min_season, max_season],
            "row_count": len(rows),
            "source": "player_pointssummary",
        },
        "rows": rows,
    }

    out_path = Path(args.out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out_doc, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
