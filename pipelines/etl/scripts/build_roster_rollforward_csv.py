#!/usr/bin/env python3
"""Build rolled-forward roster CSV artifacts for target season imports."""

from __future__ import annotations

import argparse
import csv
import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
DEFAULT_DB_PATH = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))
DEFAULT_OUT_FULL = ETL_ROOT / "artifacts" / "rosters_rollforward_2026_full.csv"
DEFAULT_OUT_IMPORT = ETL_ROOT / "artifacts" / "mfl_roster_import_2026.csv"


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def parse_contract_year_values(contract_info: str) -> List[int]:
    if not contract_info:
        return []
    pairs = re.findall(r"Y\s*([0-9]+)\s*-\s*([0-9]+(?:\.[0-9]+)?)(\s*[kK])?", contract_info)
    by_year: Dict[int, int] = {}
    for yraw, vraw, kraw in pairs:
        y = safe_int(yraw, -1)
        if y <= 0:
            continue
        try:
            val = float(vraw)
        except ValueError:
            continue
        amount = int(round(val * 1000.0)) if kraw or val <= 1000 else int(round(val))
        by_year[y] = amount
    return [by_year[y] for y in sorted(by_year.keys())]


def parse_contract_money_token(token: str) -> int:
    raw = safe_str(token).upper().replace("$", "")
    if not raw:
        return 0
    cleaned = re.sub(r"[^0-9K.\-]", "", raw)
    if not cleaned:
        return 0
    mult = 1000 if "K" in cleaned else 1
    cleaned = cleaned.replace("K", "")
    if not cleaned:
        return 0
    try:
        num = float(cleaned)
    except ValueError:
        return 0
    amount = int(round(num * mult))
    if mult == 1 and 0 < amount < 1000:
        amount *= 1000
    return amount


def parse_contract_aav_values(contract_info: str) -> List[int]:
    info = safe_str(contract_info)
    if not info:
        return []
    match = re.search(r"(?:^|\|)\s*AAV\s*([^|]+)", info, flags=re.IGNORECASE)
    if not match or not safe_str(match.group(1)):
        return []
    out: List[int] = []
    for token in re.split(r"[,/]", safe_str(match.group(1))):
        amount = parse_contract_money_token(token)
        if amount > 0:
            out.append(amount)
    return out


def infer_next_salary(contract_info: str, contract_year: int, salary: int) -> int:
    year_vals = parse_contract_year_values(contract_info)
    if contract_year <= 1 or not year_vals:
        return salary

    candidates: List[int] = []
    if contract_year > 0 and len(year_vals) >= contract_year:
        idx = len(year_vals) - contract_year
        if 0 <= idx < len(year_vals):
            candidates.append(idx)

    if salary > 0 and year_vals:
        exact_idxs = [i for i, v in enumerate(year_vals) if int(v) == int(salary)]
        candidates.extend(exact_idxs)
        closest_idx = min(range(len(year_vals)), key=lambda i: abs(float(year_vals[i]) - float(salary)))
        candidates.append(closest_idx)

    seen = set()
    ordered = []
    for idx in candidates:
        if idx in seen:
            continue
        seen.add(idx)
        ordered.append(idx)

    for idx in ordered:
        if idx + 1 < len(year_vals):
            return int(year_vals[idx + 1])

    if len(year_vals) >= 2:
        return int(year_vals[1])
    return salary


def format_k(amount: int) -> str:
    if amount <= 0:
        return "0K"
    if amount % 1000 == 0:
        return f"{amount // 1000}K"
    return f"{round(amount / 1000.0, 1)}K"


def infer_next_aav(contract_info: str, next_salary: int, old_salary: int) -> int:
    aav_values = parse_contract_aav_values(contract_info)
    if len(aav_values) >= 2:
        return int(aav_values[-1])
    if len(aav_values) == 1:
        return int(aav_values[0])
    if next_salary > 0:
        return int(next_salary)
    return int(old_salary)


def update_contract_info_aav(contract_info: str, next_aav: int, old_year: int) -> str:
    info = safe_str(contract_info)
    if not info or next_aav <= 0 or old_year <= 1:
        return info
    repl = f"AAV {format_k(next_aav)}"
    if re.search(r"AAV\s+[^|]+", info, flags=re.IGNORECASE):
        return re.sub(r"AAV\s+[^|]+", repl, info, count=1, flags=re.IGNORECASE)
    return info


def load_source_rows(conn: sqlite3.Connection, season: int) -> List[Dict[str, Any]]:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT MAX(week) FROM rosters_current WHERE season = ?
        """,
        (season,),
    )
    max_week = safe_int(cur.fetchone()[0], 0)
    cur.execute(
        """
        SELECT
            rc.season,
            rc.week,
            rc.franchise_id,
            rc.team_name,
            rc.player_id,
            rc.player_name,
            rc.position,
            rc.nfl_team,
            rc.status,
            rc.salary,
            rc.contract_year,
            rc.contract_status,
            rc.contract_info,
            rc.contract_length,
            rc.tcv,
            rc.aav,
            rc.salary_yearminus1,
            rc.salary_yearminus2,
            rc.salary_yearplus1,
            rc.salary_yearplus2,
            rc.extension_flag,
            mf.franchise_name
        FROM rosters_current rc
        LEFT JOIN metadata_franchise mf
          ON mf.season = rc.season
         AND mf.franchise_id = rc.franchise_id
        WHERE rc.season = ?
          AND rc.week = ?
        ORDER BY rc.franchise_id, rc.status, rc.player_id
        """,
        (season, max_week),
    )
    cols = [d[0] for d in cur.description]
    rows = []
    for rec in cur.fetchall():
        rows.append({cols[i]: rec[i] for i in range(len(cols))})
    return rows


def roll_row(row: Dict[str, Any], target_season: int) -> Dict[str, Any]:
    out = dict(row)
    old_salary = safe_int(row.get("salary"), 0)
    old_year = max(0, safe_int(row.get("contract_year"), 0))
    next_salary = infer_next_salary(safe_str(row.get("contract_info")), old_year, old_salary)
    next_aav = infer_next_aav(safe_str(row.get("contract_info")), next_salary, old_salary)
    out["season"] = target_season
    out["week"] = 1
    out["contract_year"] = max(0, old_year - 1)
    out["salary"] = next_salary if old_year > 1 else old_salary
    out["aav"] = next_aav if old_year > 1 else safe_int(row.get("aav"), old_salary)
    out["contract_info"] = update_contract_info_aav(
        safe_str(row.get("contract_info")),
        next_aav,
        old_year,
    )
    return out


def write_full_csv(rows: List[Dict[str, Any]], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        out_path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    with out_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def write_import_csv(rows: List[Dict[str, Any]], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "franchise_id",
        "player_id",
        "status",
        "salary",
        "contract_year",
        "contract_status",
        "contract_info",
    ]
    with out_path.open("w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(
                {
                    "franchise_id": safe_str(r.get("franchise_id")).zfill(4),
                    "player_id": safe_str(r.get("player_id")),
                    "status": safe_str(r.get("status") or "ROSTER"),
                    "salary": max(0, safe_int(r.get("salary"), 0)),
                    "contract_year": max(0, safe_int(r.get("contract_year"), 0)),
                    "contract_status": safe_str(r.get("contract_status") or "Veteran"),
                    "contract_info": safe_str(r.get("contract_info")),
                }
            )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--base-season", type=int, default=2025)
    parser.add_argument("--target-season", type=int, default=2026)
    parser.add_argument("--out-full", default=str(DEFAULT_OUT_FULL))
    parser.add_argument("--out-import", default=str(DEFAULT_OUT_IMPORT))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = str(args.db_path)
    out_full = Path(args.out_full)
    out_import = Path(args.out_import)

    conn = sqlite3.connect(db_path)
    try:
        source_rows = load_source_rows(conn, int(args.base_season))
    finally:
        conn.close()

    rolled = [roll_row(r, int(args.target_season)) for r in source_rows]
    write_full_csv(rolled, out_full)
    write_import_csv(rolled, out_import)

    print(f"Wrote {out_full} ({len(rolled)} rows)")
    print(f"Wrote {out_import} ({len(rolled)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
