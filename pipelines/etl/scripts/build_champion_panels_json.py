#!/usr/bin/env python3
"""Build champion panel JSON used by the MFL header side rails."""

from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_OUT_PATH = ROOT_DIR / "site" / "champions_panels.json"


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def safe_float(v: Any, default: float = 0.0) -> float:
    try:
        if v is None:
            return default
        return float(str(v).strip())
    except (TypeError, ValueError):
        return default


def fetch_recent_winners(conn, lookback: int) -> List[Dict[str, Any]]:
    sql = """
    WITH champs AS (
      SELECT year, franchise_id, franchise AS franchise_name
      FROM metadata_finalstandings
      WHERE final_finish = 1
    ),
    ordered AS (
      SELECT year, franchise_id, franchise_name
      FROM champs
      ORDER BY year DESC
      LIMIT ?
    ),
    with_titles AS (
      SELECT
        o.year,
        o.franchise_id,
        o.franchise_name,
        (
          SELECT COUNT(*)
          FROM champs c2
          WHERE c2.franchise_id = o.franchise_id
            AND c2.year <= o.year
        ) AS title_number
      FROM ordered o
    )
    SELECT
      w.year,
      w.franchise_id,
      w.franchise_name,
      COALESCE(s.allplay_pct, 0) AS allplay_pct,
      COALESCE(mf.icon, mf.logo, '') AS icon,
      w.title_number
    FROM with_titles w
    LEFT JOIN standings s
      ON s.season = w.year
     AND s.franchise_id = w.franchise_id
    LEFT JOIN metadata_franchise mf
      ON mf.season = w.year
     AND mf.franchise_id = w.franchise_id
    ORDER BY w.year DESC
    """
    out: List[Dict[str, Any]] = []
    for row in conn.execute(sql, (lookback,)).fetchall():
        out.append(
            {
                "year": safe_int(row[0]),
                "franchise_id": safe_str(row[1]).zfill(4)[-4:],
                "franchise": safe_str(row[2]),
                "all_play_pct": round(safe_float(row[3]), 3),
                "icon": safe_str(row[4]),
                "title_number": max(1, safe_int(row[5], 1)),
            }
        )
    return out


def fetch_title_leaders(conn) -> List[Dict[str, Any]]:
    sql = """
    WITH champs AS (
      SELECT year, franchise_id
      FROM metadata_finalstandings
      WHERE final_finish = 1
    ),
    totals AS (
      SELECT
        franchise_id,
        COUNT(*) AS titles,
        GROUP_CONCAT(year, ', ') AS years
      FROM champs
      GROUP BY franchise_id
    ),
    latest_meta AS (
      SELECT
        franchise_id,
        franchise_name,
        COALESCE(icon, logo, '') AS icon,
        ROW_NUMBER() OVER (PARTITION BY franchise_id ORDER BY season DESC) AS rn
      FROM metadata_franchise
    )
    SELECT
      t.franchise_id,
      COALESCE(lm.franchise_name, t.franchise_id) AS franchise_name,
      COALESCE(lm.icon, '') AS icon,
      t.titles,
      t.years
    FROM totals t
    LEFT JOIN latest_meta lm
      ON lm.franchise_id = t.franchise_id
     AND lm.rn = 1
    ORDER BY t.titles DESC, t.franchise_id ASC
    """
    out: List[Dict[str, Any]] = []
    for row in conn.execute(sql).fetchall():
        out.append(
            {
                "franchise_id": safe_str(row[0]).zfill(4)[-4:],
                "franchise": safe_str(row[1]),
                "icon": safe_str(row[2]),
                "titles": safe_int(row[3]),
                "years": safe_str(row[4]),
            }
        )
    return out


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--out-path", default=str(DEFAULT_OUT_PATH))
    parser.add_argument("--lookback", type=int, default=10)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    out_path = Path(args.out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = get_conn(args.db_path)
    try:
        recent = fetch_recent_winners(conn, max(1, safe_int(args.lookback, 10)))
        leaders = fetch_title_leaders(conn)
    finally:
        conn.close()

    doc = {
        "meta": {
            "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "source": "metadata_finalstandings + standings + metadata_franchise",
        },
        "recent_winners": recent,
        "title_leaders": leaders,
    }
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Recent winners: {len(recent)}")
    print(f"Title leaders: {len(leaders)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
