#!/usr/bin/env python3
"""Build static JSON artifacts for the Reports Module salary adjustments report."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_DB_PATH = Path(os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db")))
DEFAULT_OUT_DIR = ROOT_DIR / "site" / "reports" / "salary_adjustments"
DEFAULT_SQL_PATH = DEFAULT_OUT_DIR / "salary_adjustments_sql.sql"
REQUIRED_SOURCE_TABLES = (
    "transactions_trades",
    "transactions_adddrop",
    "contract_history_transaction_snapshots",
    "dim_franchise",
    "dim_player",
)
STATUS_ORDER = {
    "recorded": 0,
    "review_required": 1,
    "candidate": 2,
}


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None or value == "":
            return default
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def rounded(value: Any, digits: int = 2) -> float:
    return round(safe_float(value, 0.0), digits)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--sql-path", default=str(DEFAULT_SQL_PATH))
    parser.add_argument("--min-season", type=int)
    parser.add_argument("--max-season", type=int)
    return parser.parse_args()


def load_sql(sql_path: Path) -> str:
    return sql_path.read_text(encoding="utf-8")


def query_rows(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> List[sqlite3.Row]:
    cur = conn.execute(sql, tuple(params))
    return list(cur.fetchall())


def ensure_inputs(db_path: Path, sql_path: Path) -> None:
    if not db_path.is_file():
        raise SystemExit(f"Salary adjustments report export requires a SQLite DB at {db_path}")
    if not sql_path.is_file():
        raise SystemExit(f"Salary adjustments report export requires SQL definitions at {sql_path}")


def ensure_source_tables(conn: sqlite3.Connection) -> None:
    rows = query_rows(
        conn,
        """
        SELECT name
        FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name IN ({})
        ORDER BY name
        """.format(", ".join("?" for _ in REQUIRED_SOURCE_TABLES)),
        REQUIRED_SOURCE_TABLES,
    )
    available = {safe_str(row["name"]) for row in rows}
    missing = [name for name in REQUIRED_SOURCE_TABLES if name not in available]
    if missing:
        raise SystemExit(
            "Salary adjustments report export is missing required source tables/views: "
            + ", ".join(missing)
        )


def ensure_views(conn: sqlite3.Connection, sql_path: Path) -> None:
    conn.executescript(load_sql(sql_path))
    conn.commit()


def parse_year_values(raw_json: str) -> Dict[int, int]:
    text = safe_str(raw_json)
    if not text or text == "{}":
        return {}
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return {}
    values: Dict[int, int] = {}
    if isinstance(payload, dict):
        for key, value in payload.items():
            digits = "".join(ch for ch in str(key) if ch.isdigit())
            if digits:
                values[int(digits)] = safe_int(value, 0)
    return values


def parse_explicit_guarantee(contract_info: str) -> int:
    text = safe_str(contract_info).upper()
    if not text:
        return 0
    match = re.search(r"GTD\s*:\s*([0-9][0-9,]*)(K)?", text)
    if not match:
        return 0
    amount = safe_int(match.group(1).replace(",", ""), 0)
    if match.group(2):
        amount *= 1000
    return amount


def season_end_estimate_date(season: int) -> datetime | None:
    if season <= 0:
        return None
    return datetime(season, 12, 31, 23, 59, 59, 999000)


def prorated_earned_for_drop(season: int, amount: int, drop_date: datetime | None) -> int:
    salary = max(0, safe_int(amount, 0))
    if season <= 0 or salary <= 0 or drop_date is None:
        return 0
    milestones = [
        datetime(season, 9, 30, 23, 59, 59, 999000),
        datetime(season, 10, 31, 23, 59, 59, 999000),
        datetime(season, 11, 30, 23, 59, 59, 999000),
        season_end_estimate_date(season),
    ]
    earned_steps = sum(1 for milestone in milestones if milestone and drop_date >= milestone)
    earned_steps = max(0, min(earned_steps, 4))
    return round((salary / 4) * earned_steps)


def is_likely_waiver_pickup(event_source: str, contract_status: str) -> bool:
    source = safe_str(event_source).upper()
    status = safe_str(contract_status).upper()
    return "BBID_WAIVER" in source or status == "WW"


def is_tag_cut_pre_auction_assumption(contract_status: str, season: int, drop_date: datetime | None) -> bool:
    if safe_str(contract_status).upper() != "TAG":
        return False
    if season <= 0 or drop_date is None:
        return False
    return drop_date < datetime(season, 8, 1, 0, 0, 0)


def guaranteed_contract_value(
    total_contract_value: int,
    current_year_salary: int,
    explicit_guarantee: int = 0,
) -> tuple[int, str]:
    if explicit_guarantee > 0:
        return explicit_guarantee, "contract guarantee"
    tcv = max(0, safe_int(total_contract_value, 0))
    current_salary = max(0, safe_int(current_year_salary, 0))
    if tcv <= 4000:
        return max(0, tcv - current_salary), "TCV minus year 1 salary"
    return round(tcv * 0.75), "75% of TCV"


def earned_before_current_contract_year(
    contract_year: int,
    year_values: Dict[int, int],
    current_year_salary: int,
) -> int:
    year_idx = max(1, safe_int(contract_year, 1))
    if year_values:
        return sum(max(0, safe_int(amount, 0)) for idx, amount in year_values.items() if idx < year_idx)
    return max(0, (year_idx - 1) * max(0, safe_int(current_year_salary, 0)))


def parse_datetime_et(value: str) -> datetime | None:
    text = safe_str(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def direction_for_amount(amount: float) -> str:
    if amount > 0:
        return "charge"
    if amount < 0:
        return "relief"
    return "review"


def status_sort_key(value: str) -> tuple[int, str]:
    text = safe_str(value).lower()
    return STATUS_ORDER.get(text, 99), text


def build_trade_rows(conn: sqlite3.Connection, min_season: int | None, max_season: int | None) -> List[Dict[str, Any]]:
    clauses: List[str] = []
    params: List[Any] = []
    if min_season is not None:
        clauses.append("adjustment_season >= ?")
        params.append(min_season)
    if max_season is not None:
        clauses.append("adjustment_season <= ?")
        params.append(max_season)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = query_rows(
        conn,
        f"""
        SELECT *
        FROM report_salary_adjustments_trade_base_v1
        {where_sql}
        ORDER BY adjustment_season DESC, transaction_datetime_et DESC, source_id ASC
        """,
        params,
    )
    out: List[Dict[str, Any]] = []
    for row in rows:
        amount = safe_int(row["raw_amount"], 0)
        status = "recorded" if amount != 0 else "review_required"
        if amount == 0:
            description = "Trade flagged as salary adjustment, but the normalized amount is blank or zero."
        else:
            description = safe_str(row["comments"]) or "Accepted trade salary settlement from normalized trade history."
        out.append(
            {
                "adjustment_season": safe_int(row["adjustment_season"]),
                "franchise_id": safe_str(row["franchise_id"]),
                "franchise_name": safe_str(row["franchise_name"]),
                "adjustment_type": safe_str(row["adjustment_type"]),
                "source_table": safe_str(row["source_table"]),
                "source_id": safe_str(row["source_id"]),
                "source_season": safe_int(row["source_season"]),
                "player_id": safe_str(row["player_id"]),
                "player_name": safe_str(row["player_name"]),
                "transaction_datetime_et": safe_str(row["transaction_datetime_et"]),
                "amount": amount,
                "direction": direction_for_amount(amount),
                "description": description,
                "status": status,
                "status_detail": (
                    "Recorded traded-salary row from accepted transaction history."
                    if status == "recorded"
                    else "Trade row marked as salary adjustment, but the normalized amount requires review."
                ),
                "source_group_id": safe_str(row["source_group_id"]),
                "event_source": "trade",
                "drop_method": "",
                "pre_drop_salary": 0,
                "pre_drop_contract_length": 0,
                "pre_drop_tcv": 0,
                "pre_drop_contract_year": 0,
                "pre_drop_contract_status": "",
                "pre_drop_contract_info": "",
                "candidate_rule": "",
            }
        )
    return out


def build_drop_candidate_rows(
    conn: sqlite3.Connection,
    min_season: int | None,
    max_season: int | None,
) -> List[Dict[str, Any]]:
    clauses: List[str] = []
    params: List[Any] = []
    if min_season is not None:
        clauses.append("adjustment_season >= ?")
        params.append(min_season)
    if max_season is not None:
        clauses.append("adjustment_season <= ?")
        params.append(max_season)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = query_rows(
        conn,
        f"""
        SELECT *
        FROM report_salary_adjustments_drop_base_v1
        {where_sql}
        ORDER BY adjustment_season DESC, transaction_datetime_et DESC, source_id ASC
        """,
        params,
    )
    out: List[Dict[str, Any]] = []
    for row in rows:
        season = safe_int(row["adjustment_season"])
        transaction_dt = parse_datetime_et(row["transaction_datetime_et"])
        current_year_salary = safe_int(row["pre_drop_salary"], 0)
        contract_length = safe_int(row["pre_drop_contract_length"], 0)
        total_contract_value = safe_int(row["pre_drop_tcv"], 0)
        contract_year = safe_int(row["pre_drop_contract_year"], 0)
        contract_status = safe_str(row["pre_drop_contract_status"])
        contract_info = safe_str(row["pre_drop_contract_info"])
        year_values = parse_year_values(row["pre_drop_year_values_json"])
        explicit_guarantee = parse_explicit_guarantee(contract_info)

        penalty = 0
        candidate_rule = ""
        note = ""

        if contract_length <= 0:
            penalty = 0
        elif is_tag_cut_pre_auction_assumption(contract_status, season, transaction_dt):
            penalty = 0
        elif contract_length == 1 and current_year_salary < 5000 and contract_status.upper() in {"VETERAN", "WW"}:
            penalty = 0
        elif is_likely_waiver_pickup(row["event_source"], contract_status) and contract_length == 1 and current_year_salary >= 5000:
            penalty = round(current_year_salary * 0.35)
            candidate_rule = "waiver_35pct"
            note = f"Waiver pickup rule: 35% of current-year salary ({current_year_salary:,} x 35%)."
        else:
            prior_earned = earned_before_current_contract_year(contract_year, year_values, current_year_salary)
            accrued = prorated_earned_for_drop(season, current_year_salary, transaction_dt)
            guaranteed, guarantee_label = guaranteed_contract_value(
                total_contract_value,
                current_year_salary,
                explicit_guarantee=explicit_guarantee,
            )
            penalty = max(0, guaranteed - (prior_earned + accrued))
            candidate_rule = "guarantee_minus_earned"
            note = (
                "Projected current-rule penalty: "
                f"{guarantee_label} is {guaranteed:,}; earned to date is {prior_earned + accrued:,}."
            )

        if penalty <= 0:
            continue

        description_parts = [
            f"Candidate drop penalty from {safe_str(row['drop_method']) or safe_str(row['event_source']) or 'drop transaction'}.",
            note,
        ]
        out.append(
            {
                "adjustment_season": season,
                "franchise_id": safe_str(row["franchise_id"]),
                "franchise_name": safe_str(row["franchise_name"]),
                "adjustment_type": safe_str(row["adjustment_type"]),
                "source_table": safe_str(row["source_table"]),
                "source_id": safe_str(row["source_id"]),
                "source_season": safe_int(row["source_season"]),
                "player_id": safe_str(row["player_id"]),
                "player_name": safe_str(row["player_name"]),
                "transaction_datetime_et": safe_str(row["transaction_datetime_et"]),
                "amount": penalty,
                "direction": "charge",
                "description": " ".join(part for part in description_parts if part),
                "status": "candidate",
                "status_detail": "Projected from add/drop transaction history plus the pre-drop contract snapshot.",
                "source_group_id": "",
                "event_source": safe_str(row["event_source"]),
                "drop_method": safe_str(row["drop_method"]),
                "pre_drop_salary": current_year_salary,
                "pre_drop_contract_length": contract_length,
                "pre_drop_tcv": total_contract_value,
                "pre_drop_contract_year": contract_year,
                "pre_drop_contract_status": contract_status,
                "pre_drop_contract_info": contract_info,
                "candidate_rule": candidate_rule,
            }
        )
    return out


def season_sort_key(row: Dict[str, Any]) -> tuple:
    return (
        -safe_int(row["adjustment_season"]),
        safe_str(row["transaction_datetime_et"]) == "",
        safe_str(row["transaction_datetime_et"]),
        -abs(safe_int(row["amount"], 0)),
        safe_str(row["franchise_name"]).lower(),
        safe_str(row["player_name"]).lower(),
        safe_str(row["source_id"]).lower(),
    )


def build_season_payload(rows: List[Dict[str, Any]], season: int) -> Dict[str, Any]:
    season_rows = [row for row in rows if safe_int(row["adjustment_season"]) == season]
    season_rows.sort(key=season_sort_key)
    charges_total = round(sum(max(0, safe_float(row["amount"], 0.0)) for row in season_rows), 2)
    relief_total = round(sum(abs(min(0, safe_float(row["amount"], 0.0))) for row in season_rows), 2)
    net_total = round(sum(safe_float(row["amount"], 0.0) for row in season_rows), 2)
    statuses = sorted({safe_str(row["status"]) for row in season_rows}, key=status_sort_key)
    adjustment_types = sorted({safe_str(row["adjustment_type"]) for row in season_rows})
    franchises = sorted(
        {
            (safe_str(row["franchise_id"]), safe_str(row["franchise_name"]))
            for row in season_rows
            if safe_str(row["franchise_id"]) or safe_str(row["franchise_name"])
        },
        key=lambda item: (item[1].lower(), item[0]),
    )
    players = sorted(
        {
            (safe_str(row["player_id"]), safe_str(row["player_name"]))
            for row in season_rows
            if safe_str(row["player_id"]) or safe_str(row["player_name"])
        },
        key=lambda item: (item[1].lower(), item[0]),
    )
    source_seasons = sorted({safe_int(row["source_season"]) for row in season_rows if safe_int(row["source_season"]) > 0}, reverse=True)
    return {
        "meta": {
            "season": season,
            "row_count": len(season_rows),
            "charges_total": charges_total,
            "relief_total": relief_total,
            "net_total": net_total,
            "recorded_count": sum(1 for row in season_rows if safe_str(row["status"]) == "recorded"),
            "review_required_count": sum(1 for row in season_rows if safe_str(row["status"]) == "review_required"),
            "candidate_count": sum(1 for row in season_rows if safe_str(row["status"]) == "candidate"),
        },
        "filters": {
            "franchises": [{"id": franchise_id, "name": franchise_name} for franchise_id, franchise_name in franchises],
            "adjustment_types": adjustment_types,
            "source_seasons": source_seasons,
            "statuses": statuses,
            "players": [{"id": player_id, "name": player_name} for player_id, player_name in players],
        },
        "rows": season_rows,
    }


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=False) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    db_path = Path(args.db_path).expanduser()
    out_dir = Path(args.out_dir).expanduser()
    sql_path = Path(args.sql_path).expanduser()

    ensure_inputs(db_path, sql_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        ensure_source_tables(conn)
        ensure_views(conn, sql_path)
        trade_rows = build_trade_rows(conn, args.min_season, args.max_season)
        drop_rows = build_drop_candidate_rows(conn, args.min_season, args.max_season)
    finally:
        conn.close()

    all_rows = trade_rows + drop_rows
    seasons = sorted({safe_int(row["adjustment_season"]) for row in all_rows if safe_int(row["adjustment_season"]) > 0}, reverse=True)
    if not seasons:
        raise SystemExit("Salary adjustments report export found no eligible seasons.")

    manifest_seasons: List[Dict[str, Any]] = []
    for season in seasons:
        payload = build_season_payload(all_rows, season)
        season_path = out_dir / f"salary_adjustments_{season}.json"
        write_json(season_path, payload)
        meta = payload["meta"]
        manifest_seasons.append(
            {
                "season": season,
                "path": f"./salary_adjustments_{season}.json",
                "row_count": meta["row_count"],
                "charges_total": meta["charges_total"],
                "relief_total": meta["relief_total"],
                "net_total": meta["net_total"],
                "recorded_count": meta["recorded_count"],
                "review_required_count": meta["review_required_count"],
                "candidate_count": meta["candidate_count"],
            }
        )

    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "meta": {
            "report_id": "salary-adjustments",
            "status_values": ["recorded", "review_required", "candidate"],
            "direction_values": ["charge", "relief", "review"],
            "adjustment_types": ["TRADED_SALARY", "DROP_PENALTY_CANDIDATE"],
            "notes": [
                "Traded salary rows are pulled directly from normalized accepted trade history.",
                "Drop penalty rows are candidate adjustments derived from add/drop events plus the pre-drop contract snapshot.",
            ],
        },
        "seasons": manifest_seasons,
    }
    write_json(out_dir / "salary_adjustments_manifest.json", manifest)
    print(f"Wrote salary adjustments report artifacts to {out_dir} for {len(seasons)} season(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
