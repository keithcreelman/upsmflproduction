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
    WITH champs_raw AS (
      SELECT
        fs.year,
        printf('%04d', CAST(fs.franchise_id AS INT)) AS franchise_id,
        fs.franchise AS champion_name
      FROM metadata_finalstandings fs
      WHERE fs.final_finish = 1
    ),
    champs AS (
      SELECT
        c.year,
        c.franchise_id,
        COALESCE(NULLIF(TRIM(f.owner_name), ''), c.champion_name, c.franchise_id) AS winner_name
      FROM champs_raw c
      LEFT JOIN franchises f
        ON CAST(f.season AS INT) = c.year
       AND printf('%04d', CAST(f.franchise_id AS INT)) = c.franchise_id
    ),
    ordered AS (
      SELECT year, franchise_id, winner_name
      FROM champs
      ORDER BY year DESC
      LIMIT ?
    ),
    with_titles AS (
      SELECT
        o.year,
        o.franchise_id,
        o.winner_name,
        (
          SELECT COUNT(*)
          FROM champs c2
          WHERE c2.winner_name = o.winner_name
            AND c2.year <= o.year
        ) AS title_number
      FROM ordered o
    )
    SELECT
      w.year,
      w.franchise_id,
      w.winner_name,
      COALESCE(s.allplay_pct, 0) AS allplay_pct,
      COALESCE(mf.icon, mf.logo, '') AS icon,
      w.title_number
    FROM with_titles w
    LEFT JOIN standings s
      ON CAST(s.season AS INT) = w.year
     AND printf('%04d', CAST(s.franchise_id AS INT)) = w.franchise_id
    LEFT JOIN metadata_franchise mf
      ON CAST(mf.season AS INT) = w.year
     AND printf('%04d', CAST(mf.franchise_id AS INT)) = w.franchise_id
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
      SELECT
        fs.year,
        printf('%04d', CAST(fs.franchise_id AS INT)) AS franchise_id,
        COALESCE(NULLIF(TRIM(f.owner_name), ''), fs.franchise, printf('%04d', CAST(fs.franchise_id AS INT))) AS owner_name,
        COALESCE(mf.icon, mf.logo, '') AS icon
      FROM metadata_finalstandings fs
      LEFT JOIN franchises f
        ON CAST(f.season AS INT) = fs.year
       AND printf('%04d', CAST(f.franchise_id AS INT)) = printf('%04d', CAST(fs.franchise_id AS INT))
      LEFT JOIN metadata_franchise mf
        ON CAST(mf.season AS INT) = fs.year
       AND printf('%04d', CAST(mf.franchise_id AS INT)) = printf('%04d', CAST(fs.franchise_id AS INT))
      WHERE fs.final_finish = 1
    ),
    totals AS (
      SELECT
        c.owner_name,
        COUNT(*) AS titles,
        MAX(c.year) AS latest_title_year,
        (
          SELECT GROUP_CONCAT(x.year, ', ')
          FROM (
            SELECT year
            FROM champs c2
            WHERE c2.owner_name = c.owner_name
            ORDER BY year
          ) x
        ) AS years,
        (
          SELECT c3.franchise_id
          FROM champs c3
          WHERE c3.owner_name = c.owner_name
          ORDER BY c3.year DESC
          LIMIT 1
        ) AS latest_franchise_id,
        (
          SELECT c3.icon
          FROM champs c3
          WHERE c3.owner_name = c.owner_name
          ORDER BY c3.year DESC
          LIMIT 1
        ) AS latest_icon
      FROM champs c
      GROUP BY c.owner_name
    )
    SELECT
      t.latest_franchise_id,
      t.owner_name AS franchise_name,
      COALESCE(t.latest_icon, '') AS icon,
      t.titles,
      t.years,
      t.latest_title_year
    FROM totals t
    ORDER BY t.titles DESC, t.latest_title_year DESC, t.owner_name ASC
    LIMIT 10
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
            "source": "metadata_finalstandings + standings + metadata_franchise + franchises(owner_name)",
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
