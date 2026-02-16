#!/usr/bin/env python3
"""Build historical tag submissions JSON for CCC finalized submissions view."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_OUT_PATH = ROOT_DIR / "site" / "ccc" / "tag_submissions.json"


OFFENSE_POS = {"QB", "RB", "WR", "TE", "PK", "K", "P"}
DEFENSE_POS = {"DL", "DE", "DT", "LB", "DB", "CB", "S"}


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


def side_for_pos(pos: str) -> str:
    p = normalize_pos(pos)
    if p in DEFENSE_POS:
        return "DEFENSE"
    if p in OFFENSE_POS:
        return "OFFENSE"
    return "OFFENSE"


def memorial_day(year: int) -> datetime:
    d = datetime(year, 5, 31, tzinfo=timezone.utc)
    while d.weekday() != 0:  # Monday
        d -= timedelta(days=1)
    return d


def default_tag_submitted_at_utc(season: int) -> str:
    if season <= 0:
        return ""
    memorial = memorial_day(season)
    tag_deadline = memorial - timedelta(days=4)
    dt = datetime(
        tag_deadline.year,
        tag_deadline.month,
        tag_deadline.day,
        23,
        59,
        0,
        tzinfo=timezone.utc,
    )
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_rows(conn, season_filter: int | None) -> List[Dict[str, Any]]:
    sql = """
    SELECT
      rw.season,
      rw.franchise_id,
      COALESCE(rw.team_name, mf.franchise_name, rw.franchise_id) AS franchise_name,
      CAST(rw.player_id AS TEXT) AS player_id,
      rw.player_name,
      rw.position,
      COALESCE(rw.salary, 0) AS salary
    FROM rosters_weekly rw
    LEFT JOIN metadata_franchise mf
      ON mf.season = rw.season
     AND mf.franchise_id = rw.franchise_id
    WHERE rw.week = 1
      AND UPPER(COALESCE(rw.contract_status, '')) LIKE '%TAG%'
    """
    params: List[Any] = []
    if season_filter:
        sql += " AND rw.season = ?"
        params.append(int(season_filter))
    sql += " ORDER BY rw.season DESC, rw.franchise_id ASC, rw.player_name ASC"

    out: List[Dict[str, Any]] = []
    for row in conn.execute(sql, params).fetchall():
        season = safe_int(row[0])
        pos = normalize_pos(row[5])
        out.append(
            {
                "season": str(season),
                "franchise_id": safe_str(row[1]).zfill(4)[-4:],
                "franchise_name": safe_str(row[2]),
                "player_id": safe_str(row[3]),
                "player_name": safe_str(row[4]),
                "pos": pos,
                "side": side_for_pos(pos),
                "tag_salary": safe_int(row[6]),
                "submitted_at_utc": default_tag_submitted_at_utc(season),
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
            "source": "rosters_weekly week=1 where contract_status contains TAG",
            "season_filter": int(args.season) if args.season else None,
        },
        "rows": rows,
    }
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"Rows: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
