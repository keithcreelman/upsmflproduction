#!/usr/bin/env python3
"""Build static JSON artifacts for the Reports Module salary adjustments report."""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List
from xml.sax.saxutils import escape

from salary_adjustments_feed import (
    build_drop_marker_lookup,
    fetch_salary_adjustments,
    match_drop_marker,
)


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_DB_PATH = Path(os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db")))
DEFAULT_OUT_DIR = ROOT_DIR / "site" / "reports" / "salary_adjustments"
DEFAULT_SQL_PATH = DEFAULT_OUT_DIR / "salary_adjustments_sql.sql"
DEFAULT_IMPORT_OUT_DIR = ETL_ROOT / "artifacts"
DEFAULT_SALARY_ADJUSTMENTS_URL = os.getenv("MFL_SALARY_ADJUSTMENTS_URL", "")
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
    parser.add_argument("--import-out-dir", default=str(DEFAULT_IMPORT_OUT_DIR))
    parser.add_argument("--salary-adjustments-url", default=str(DEFAULT_SALARY_ADJUSTMENTS_URL))
    parser.add_argument("--salary-adjustments-timeout", type=int, default=30)
    parser.add_argument(
        "--require-live-drop-feed",
        type=int,
        default=int(os.getenv("MFL_SALARY_ADJUSTMENTS_REQUIRE_LIVE_DROP_FEED", "0")),
    )
    parser.add_argument(
        "--allow-snapshot-fallback",
        type=int,
        default=int(os.getenv("MFL_SALARY_ADJUSTMENTS_ALLOW_SNAPSHOT_FALLBACK", "1")),
    )
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


def is_tag_cut_pre_auction_assumption(
    contract_status: str,
    auction_start_date: datetime | None,
    drop_date: datetime | None,
) -> bool:
    if safe_str(contract_status).upper() != "TAG":
        return False
    if auction_start_date is None or drop_date is None:
        return False
    return drop_date < auction_start_date


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


def build_drop_contract_context(
    salary: int,
    contract_length: int,
    total_contract_value: int,
    contract_year: int,
    contract_status: str,
    contract_info: str,
    year_values: Dict[int, int],
) -> Dict[str, Any]:
    return {
        "salary": safe_int(salary, 0),
        "contract_length": safe_int(contract_length, 0),
        "tcv": safe_int(total_contract_value, 0),
        "contract_year": safe_int(contract_year, 0),
        "contract_status": safe_str(contract_status),
        "contract_info": safe_str(contract_info),
        "year_values": {safe_int(k, 0): safe_int(v, 0) for k, v in (year_values or {}).items() if safe_int(k, 0) > 0},
    }


def drop_context_mismatch_reason(
    marker_context: Dict[str, Any],
    fallback_context: Dict[str, Any],
) -> str:
    mismatches: List[str] = []
    if safe_int(marker_context.get("salary"), 0) != safe_int(fallback_context.get("salary"), 0):
        mismatches.append(
            f"salary {safe_int(fallback_context.get('salary'), 0):,} -> {safe_int(marker_context.get('salary'), 0):,}"
        )
    if safe_int(marker_context.get("contract_length"), 0) != safe_int(fallback_context.get("contract_length"), 0):
        mismatches.append(
            "contract_length "
            f"{safe_int(fallback_context.get('contract_length'), 0)} -> {safe_int(marker_context.get('contract_length'), 0)}"
        )
    if safe_int(marker_context.get("tcv"), 0) != safe_int(fallback_context.get("tcv"), 0):
        mismatches.append(
            f"tcv {safe_int(fallback_context.get('tcv'), 0):,} -> {safe_int(marker_context.get('tcv'), 0):,}"
        )
    if safe_int(marker_context.get("contract_year"), 0) != safe_int(fallback_context.get("contract_year"), 0):
        mismatches.append(
            "contract_year "
            f"{safe_int(fallback_context.get('contract_year'), 0)} -> {safe_int(marker_context.get('contract_year'), 0)}"
        )
    if safe_str(marker_context.get("contract_status")).upper() != safe_str(fallback_context.get("contract_status")).upper():
        mismatches.append(
            "contract_status "
            f"{safe_str(fallback_context.get('contract_status')) or '(blank)'} -> {safe_str(marker_context.get('contract_status')) or '(blank)'}"
        )
    if safe_str(marker_context.get("contract_info")) != safe_str(fallback_context.get("contract_info")):
        mismatches.append("contract_info differs")
    return "; ".join(mismatches)


def canonical_text_token(value: Any, fallback: str = "unknown") -> str:
    text = safe_str(value)
    if not text:
        return fallback
    cleaned = re.sub(r"[^A-Za-z0-9_.:-]+", "_", text.strip())
    return cleaned.strip("_") or fallback


def canonical_player_token(value: Any) -> str:
    text = safe_str(value).replace("|", "/")
    return text or "Unknown Player"


def bucket_for_adjustment_type(adjustment_type: str) -> str:
    text = safe_str(adjustment_type).upper()
    if text == "TRADED_SALARY":
        return "traded_salary"
    if text == "DROP_PENALTY_CANDIDATE":
        return "cut_players"
    return "other"


def parse_trade_id(source_group_id: str, source_id: str) -> str:
    for raw in (source_group_id, source_id):
        text = safe_str(raw)
        if not text:
            continue
        match = re.search(r"(?:^|[_:-])([0-9]+)(?:[A-Za-z.]*)?$", text)
        if match:
            return safe_str(match.group(1))
    return ""


def build_trade_ledger_key(
    season: int,
    source_group_id: str,
    source_id: str,
    franchise_id: str,
    amount: int,
) -> str:
    trade_ref = canonical_text_token(source_group_id or source_id, f"trade_{safe_int(season, 0)}")
    return f"trade:{safe_int(season, 0)}:{trade_ref}:{canonical_text_token(franchise_id)}:{safe_int(amount, 0)}"


def build_cut_ledger_key(
    adjustment_season: int,
    source_id: str,
    franchise_id: str,
    amount: int,
) -> str:
    cut_ref = canonical_text_token(source_id, f"cut_{safe_int(adjustment_season, 0)}")
    return f"cut:{safe_int(adjustment_season, 0)}:{cut_ref}:{canonical_text_token(franchise_id)}:{safe_int(amount, 0)}"


def build_trade_import_explanation(
    adjustment_season: int,
    trade_id: str,
    ledger_key: str,
    amount: int,
) -> str:
    parts = [
        "UPS cap adjustment",
        "type=trade",
        f"season={safe_int(adjustment_season, 0)}",
    ]
    if safe_str(trade_id):
        parts.append(f"trade_id={safe_str(trade_id)}")
    parts.extend(
        [
            f"ref={ledger_key}",
            f"amount={safe_int(amount, 0)}",
        ]
    )
    return " | ".join(parts)


def build_cut_import_explanation(
    adjustment_season: int,
    player_name: str,
    ledger_key: str,
    amount: int,
) -> str:
    return " | ".join(
        [
            "UPS cap adjustment",
            "type=cut",
            f"season={safe_int(adjustment_season, 0)}",
            f"player={canonical_player_token(player_name)}",
            f"ref={ledger_key}",
            f"amount={safe_int(amount, 0)}",
        ]
    )


def mfl_amount_text(amount: int) -> str:
    return str(safe_int(amount, 0))


def write_import_xml(path: Path, rows: List[Dict[str, Any]]) -> None:
    lines = ["<salary_adjustments>"]
    for row in rows:
        if not safe_str(row.get("franchise_id")):
            continue
        lines.append(
            "  <salary_adjustment franchise_id=\"{franchise_id}\" amount=\"{amount}\" explanation=\"{explanation}\"/>".format(
                franchise_id=escape(safe_str(row.get("franchise_id"))),
                amount=escape(mfl_amount_text(safe_int(row.get("amount"), 0))),
                explanation=escape(safe_str(row.get("import_explanation"))),
            )
        )
    lines.extend(["</salary_adjustments>", ""])
    path.write_text("\n".join(lines), encoding="utf-8")


def load_free_agent_auction_start_lookup(
    conn: sqlite3.Connection,
    seasons: Iterable[int],
) -> Dict[int, datetime]:
    season_values = sorted({safe_int(season, 0) for season in seasons if safe_int(season, 0) > 0})
    if not season_values:
        return {}
    rows = query_rows(
        conn,
        """
        SELECT
          season,
          MIN(
            COALESCE(
              NULLIF(datetime_et, ''),
              TRIM(COALESCE(date_et, '') || ' ' || COALESCE(NULLIF(time_et, ''), '00:00:00'))
            )
          ) AS auction_start_datetime_et
        FROM transactions_auction
        WHERE auction_type = 'FreeAgent'
          AND season IN ({})
        GROUP BY season
        """.format(", ".join("?" for _ in season_values)),
        season_values,
    )
    out: Dict[int, datetime] = {}
    for row in rows:
        season = safe_int(row["season"], 0)
        auction_start = parse_datetime_et(row["auction_start_datetime_et"])
        if season > 0 and auction_start is not None:
            out[season] = auction_start
    return out


def effective_drop_adjustment_season(
    source_season: int,
    drop_date: datetime | None,
    auction_start_lookup: Dict[int, datetime],
) -> tuple[int, str]:
    season = safe_int(source_season, 0)
    if season <= 0:
        return 0, ""
    if drop_date is None:
        return season, ""
    auction_start = auction_start_lookup.get(season)
    if auction_start is None:
        return season, ""
    if drop_date >= auction_start:
        next_season = season + 1
        return (
            next_season,
            f"Applied to {next_season} because the drop occurred on or after the {season} FreeAgent auction start ({auction_start.date().isoformat()}).",
        )
    return season, ""


def direction_for_amount(amount: float) -> str:
    if amount > 0:
        return "charge"
    if amount < 0:
        return "relief"
    return "review"


def status_sort_key(value: str) -> tuple[int, str]:
    text = safe_str(value).lower()
    return STATUS_ORDER.get(text, 99), text


def load_contract_snapshot_lookup(
    conn: sqlite3.Connection,
    seasons: Iterable[int],
) -> Dict[tuple[int, str, str], sqlite3.Row]:
    season_values = sorted({safe_int(season, 0) for season in seasons if safe_int(season, 0) > 0})
    if not season_values:
        return {}
    rows = query_rows(
        conn,
        """
        SELECT
          season,
          player_id,
          franchise_id,
          source_detail,
          salary,
          contract_status,
          contract_info,
          contract_length,
          contract_year,
          contract_year_index,
          tcv,
          year_values_json,
          prior_salary,
          prior_contract_info,
          prior_contract_length,
          prior_contract_status,
          prior_tcv,
          prior_year_values_json,
          at_time_cap_penalty_amount,
          current_cap_penalty_amount,
          manual_review_flag,
          manual_review_reason
        FROM contract_history_snapshots
        WHERE season IN ({})
        """.format(", ".join("?" for _ in season_values)),
        season_values,
    )
    return {
        (safe_int(row["season"]), safe_str(row["player_id"]), safe_str(row["franchise_id"])): row
        for row in rows
    }


def load_adddrop_add_lookup(
    conn: sqlite3.Connection,
    seasons: Iterable[int],
) -> Dict[tuple[int, str, str], List[sqlite3.Row]]:
    season_values = sorted({safe_int(season, 0) for season in seasons if safe_int(season, 0) > 0})
    if not season_values:
        return {}
    rows = query_rows(
        conn,
        """
        SELECT
          season,
          transactionid,
          franchise_id,
          player_id,
          method,
          salary,
          datetime_et
        FROM transactions_adddrop
        WHERE season IN ({})
          AND move_type = 'ADD'
        ORDER BY season, franchise_id, player_id, datetime_et, txn_index
        """.format(", ".join("?" for _ in season_values)),
        season_values,
    )
    out: Dict[tuple[int, str, str], List[sqlite3.Row]] = {}
    for row in rows:
        key = (
            safe_int(row["season"]),
            safe_str(row["franchise_id"]),
            safe_str(row["player_id"]),
        )
        out.setdefault(key, []).append(row)
    return out


def latest_adddrop_add_before(
    add_lookup: Dict[tuple[int, str, str], List[sqlite3.Row]],
    season: int,
    franchise_id: str,
    player_id: str,
    transaction_dt: datetime | None,
) -> sqlite3.Row | None:
    rows = add_lookup.get((safe_int(season), safe_str(franchise_id), safe_str(player_id))) or []
    if not rows:
        return None
    if transaction_dt is None:
        return rows[-1]
    last_row: sqlite3.Row | None = None
    for row in rows:
        add_dt = parse_datetime_et(row["datetime_et"])
        if add_dt is None:
            continue
        if add_dt < transaction_dt:
            last_row = row
        else:
            break
    return last_row


def derive_rollforward_contract_context(
    current_snapshot: sqlite3.Row | None,
    prior_snapshot: sqlite3.Row | None,
) -> Dict[str, Any] | None:
    if current_snapshot is None or prior_snapshot is None:
        return None
    if safe_str(current_snapshot["source_detail"]).lower() != "week1_not_under_contract":
        return None
    if (
        safe_int(current_snapshot["salary"], 0) > 0
        or safe_int(current_snapshot["contract_length"], 0) > 0
        or safe_str(current_snapshot["contract_status"])
        or safe_str(current_snapshot["contract_info"])
    ):
        return None

    prior_year_values = parse_year_values(prior_snapshot["year_values_json"])
    prior_contract_length = safe_int(prior_snapshot["contract_length"], 0)
    prior_year_index = safe_int(prior_snapshot["contract_year_index"], 1)
    if not prior_year_values or prior_contract_length <= prior_year_index:
        return None

    remaining_pairs = [
        (year_idx, amount)
        for year_idx, amount in sorted(prior_year_values.items())
        if year_idx > prior_year_index and safe_int(amount, 0) > 0
    ]
    if not remaining_pairs:
        return None

    compact_year_values = {
        offset + 1: safe_int(amount, 0)
        for offset, (_, amount) in enumerate(remaining_pairs)
    }
    remaining_amounts = [amount for _, amount in remaining_pairs]
    return {
        "salary": safe_int(remaining_amounts[0], 0),
        "contract_length": len(remaining_amounts),
        "contract_year": 1,
        "tcv": sum(safe_int(amount, 0) for amount in remaining_amounts),
        "contract_status": safe_str(prior_snapshot["contract_status"]),
        "contract_info": safe_str(prior_snapshot["contract_info"]),
        "year_values": compact_year_values,
        "resolution_note": "Pre-drop contract rolled forward from prior-season salary schedule due placeholder week 1 snapshot.",
    }


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
        adjustment_season = safe_int(row["adjustment_season"])
        franchise_id = safe_str(row["franchise_id"])
        source_group_id = safe_str(row["source_group_id"])
        source_id = safe_str(row["source_id"])
        trade_id = parse_trade_id(source_group_id, source_id)
        ledger_key = build_trade_ledger_key(
            adjustment_season,
            source_group_id,
            source_id,
            franchise_id,
            amount,
        )
        import_eligible = status == "recorded" and amount != 0
        if amount == 0:
            description = "Trade flagged as salary adjustment, but the normalized amount is blank or zero."
        else:
            description = safe_str(row["comments"]) or "Accepted trade salary settlement from normalized trade history."
        out.append(
            {
                "adjustment_season": adjustment_season,
                "franchise_id": franchise_id,
                "franchise_name": safe_str(row["franchise_name"]),
                "adjustment_type": safe_str(row["adjustment_type"]),
                "source_table": safe_str(row["source_table"]),
                "source_id": source_id,
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
                "source_group_id": source_group_id,
                "event_source": "trade",
                "drop_method": "",
                "pre_drop_salary": 0,
                "pre_drop_contract_length": 0,
                "pre_drop_tcv": 0,
                "pre_drop_contract_year": 0,
                "pre_drop_contract_status": "",
                "pre_drop_contract_info": "",
                "candidate_rule": "",
                "bucket": bucket_for_adjustment_type(row["adjustment_type"]),
                "ledger_key": ledger_key,
                "trade_id": trade_id,
                "import_eligible": import_eligible,
                "import_explanation": (
                    build_trade_import_explanation(adjustment_season, trade_id, ledger_key, amount)
                    if import_eligible
                    else ""
                ),
                "import_target_season": adjustment_season,
                "drop_contract_source": "",
                "drop_marker_description": "",
                "drop_marker_created_at_et": "",
                "drop_marker_match_delta_seconds": None,
                "drop_snapshot_salary": 0,
                "drop_snapshot_contract_info": "",
                "drop_snapshot_contract_status": "",
                "drop_snapshot_contract_length": 0,
                "drop_snapshot_contract_year": 0,
                "drop_snapshot_tcv": 0,
                "drop_snapshot_year_values_json": "{}",
                "drop_contract_mismatch_flag": False,
                "drop_contract_mismatch_reason": "",
                "drop_feed_available": None,
            }
        )
    return out


def build_drop_candidate_rows(
    conn: sqlite3.Connection,
    min_season: int | None,
    max_season: int | None,
    drop_feed_available: bool,
    allow_snapshot_fallback: bool,
    drop_marker_lookup: Dict[tuple[str, str], List[Dict[str, Any]]] | None = None,
) -> List[Dict[str, Any]]:
    rows = query_rows(
        conn,
        """
        SELECT *
        FROM report_salary_adjustments_drop_base_v1
        ORDER BY source_season DESC, transaction_datetime_et DESC, source_id ASC
        """,
    )
    source_seasons = {safe_int(row["source_season"]) for row in rows if safe_int(row["source_season"]) > 0}
    snapshot_lookup = load_contract_snapshot_lookup(
        conn,
        source_seasons | {season - 1 for season in source_seasons if season > 1},
    )
    auction_start_lookup = load_free_agent_auction_start_lookup(conn, source_seasons)
    add_lookup = load_adddrop_add_lookup(conn, source_seasons)
    out: List[Dict[str, Any]] = []
    for row in rows:
        source_season = safe_int(row["source_season"])
        transaction_dt = parse_datetime_et(row["transaction_datetime_et"])
        season, season_note = effective_drop_adjustment_season(source_season, transaction_dt, auction_start_lookup)
        rolls_forward = season != source_season
        if min_season is not None and season < min_season:
            continue
        if max_season is not None and season > max_season:
            continue

        player_id = safe_str(row["player_id"])
        franchise_id = safe_str(row["franchise_id"])
        context_notes: List[str] = []
        marker_note = ""
        review_only_note = ""

        fallback_context = build_drop_contract_context(
            salary=safe_int(row["pre_drop_salary"], 0),
            contract_length=safe_int(row["pre_drop_contract_length"], 0),
            total_contract_value=safe_int(row["pre_drop_tcv"], 0),
            contract_year=safe_int(row["pre_drop_contract_year"], 0),
            contract_status=safe_str(row["pre_drop_contract_status"]),
            contract_info=safe_str(row["pre_drop_contract_info"]),
            year_values=parse_year_values(row["pre_drop_year_values_json"]),
        )

        current_snapshot = snapshot_lookup.get((source_season, player_id, franchise_id))
        prior_snapshot = snapshot_lookup.get((source_season - 1, player_id, franchise_id))
        rollover_context = derive_rollforward_contract_context(current_snapshot, prior_snapshot)
        if rollover_context:
            fallback_context = build_drop_contract_context(
                salary=safe_int(rollover_context["salary"], fallback_context["salary"]),
                contract_length=safe_int(rollover_context["contract_length"], fallback_context["contract_length"]),
                total_contract_value=safe_int(rollover_context["tcv"], fallback_context["tcv"]),
                contract_year=safe_int(rollover_context["contract_year"], fallback_context["contract_year"]),
                contract_status=safe_str(rollover_context["contract_status"]) or fallback_context["contract_status"],
                contract_info=safe_str(rollover_context["contract_info"]) or fallback_context["contract_info"],
                year_values=dict(rollover_context["year_values"]),
            )
            if safe_str(rollover_context["resolution_note"]):
                context_notes.append(safe_str(rollover_context["resolution_note"]))

        last_add = latest_adddrop_add_before(
            add_lookup,
            source_season,
            franchise_id,
            player_id,
            transaction_dt,
        )
        if (
            last_add is not None
            and safe_int(fallback_context["contract_length"], 0) == 1
            and (
                "BBID_WAIVER" in safe_str(row["event_source"]).upper()
                or safe_str(fallback_context["contract_status"]).upper() == "WW"
            )
        ):
            add_salary = max(0, safe_int(last_add["salary"], 0))
            if add_salary > 0 and add_salary != safe_int(fallback_context["salary"], 0):
                fallback_context = build_drop_contract_context(
                    salary=add_salary,
                    contract_length=1,
                    total_contract_value=add_salary,
                    contract_year=1,
                    contract_status=safe_str(fallback_context["contract_status"]) or "WW",
                    contract_info=safe_str(fallback_context["contract_info"]),
                    year_values={1: add_salary},
                )
                context_notes.append(
                    f"Waiver salary basis taken from preceding {safe_str(last_add['method']) or 'add/drop'} add salary of {add_salary:,}."
                )

        drop_marker_row = match_drop_marker(
            drop_marker_lookup or {},
            franchise_id,
            safe_str(row["player_name"]),
            transaction_dt,
        )
        marker_context: Dict[str, Any] | None = None
        marker_match_delta_seconds: int | None = None
        if drop_marker_row:
            marker = drop_marker_row.get("drop_marker") or {}
            marker_context = build_drop_contract_context(
                salary=safe_int(marker.get("salary"), 0),
                contract_length=safe_int(marker.get("contract_length"), 0),
                total_contract_value=safe_int(marker.get("tcv"), 0),
                contract_year=safe_int(marker.get("contract_year_index"), 0),
                contract_status=safe_str(marker.get("contract_type")),
                contract_info=safe_str(marker.get("special")),
                year_values=marker.get("year_values") or {},
            )
            marker_note = "Contract state taken from live salaryAdjustments drop marker."
            marker_dt = drop_marker_row.get("timestamp_et")
            if transaction_dt is not None and marker_dt is not None:
                marker_match_delta_seconds = abs(int((marker_dt - transaction_dt).total_seconds()))

        if marker_context is None and not allow_snapshot_fallback:
            continue

        final_context = marker_context or fallback_context
        current_year_salary = safe_int(final_context["salary"], 0)
        contract_length = safe_int(final_context["contract_length"], 0)
        total_contract_value = safe_int(final_context["tcv"], 0)
        contract_year = safe_int(final_context["contract_year"], 0)
        contract_status = safe_str(final_context["contract_status"])
        contract_info = safe_str(final_context["contract_info"])
        year_values = dict(final_context["year_values"])
        explicit_guarantee = parse_explicit_guarantee(contract_info)

        mismatch_reason = ""
        if marker_context:
            mismatch_reason = drop_context_mismatch_reason(marker_context, fallback_context)

        penalty = 0
        candidate_rule = ""
        note = ""
        if contract_length <= 0:
            penalty = 0
        elif is_tag_cut_pre_auction_assumption(contract_status, auction_start_lookup.get(source_season), transaction_dt):
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

        status = "candidate"
        status_detail = "Projected from add/drop transaction history with the best available local contract context."
        import_eligible = penalty > 0
        if marker_context:
            status_detail = "Projected from add/drop transaction history with live drop-marker contract state."
        if rolls_forward and marker_context is None:
            status = "review_required"
            import_eligible = False
            review_only_note = (
                "Review only: post-auction carryover row is using local fallback contract inference instead of a live salaryAdjustments drop marker."
            )
            status_detail = review_only_note

        description_parts = [
            f"Candidate drop penalty from {safe_str(row['drop_method']) or safe_str(row['event_source']) or 'drop transaction'}.",
            note,
        ]
        if season_note:
            description_parts.append(season_note)
        description_parts.extend(context_notes)
        if marker_note:
            description_parts.append(marker_note)
        if mismatch_reason:
            description_parts.append(f"Live marker differs from local fallback: {mismatch_reason}.")
        if review_only_note:
            description_parts.append(review_only_note)
        if not drop_feed_available and rolls_forward:
            description_parts.append("Live salaryAdjustments feed was unavailable for this build.")

        ledger_key = build_cut_ledger_key(
            season,
            safe_str(row["source_id"]),
            franchise_id,
            penalty,
        )
        out.append(
            {
                "adjustment_season": season,
                "franchise_id": franchise_id,
                "franchise_name": safe_str(row["franchise_name"]),
                "adjustment_type": safe_str(row["adjustment_type"]),
                "source_table": safe_str(row["source_table"]),
                "source_id": safe_str(row["source_id"]),
                "source_season": source_season,
                "player_id": player_id,
                "player_name": safe_str(row["player_name"]),
                "transaction_datetime_et": safe_str(row["transaction_datetime_et"]),
                "amount": penalty,
                "direction": "charge",
                "description": " ".join(part for part in description_parts if part),
                "status": status,
                "status_detail": status_detail,
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
                "bucket": bucket_for_adjustment_type(row["adjustment_type"]),
                "ledger_key": ledger_key,
                "trade_id": "",
                "import_eligible": import_eligible,
                "import_explanation": (
                    build_cut_import_explanation(
                        season,
                        safe_str(row["player_name"]),
                        ledger_key,
                        penalty,
                    )
                    if import_eligible
                    else ""
                ),
                "import_target_season": season,
                "drop_contract_source": "live_marker" if marker_context else "snapshot_inferred",
                "drop_marker_description": safe_str(drop_marker_row.get("description")) if drop_marker_row else "",
                "drop_marker_created_at_et": (
                    drop_marker_row.get("timestamp_et").isoformat(sep=" ")
                    if drop_marker_row and drop_marker_row.get("timestamp_et") is not None
                    else ""
                ),
                "drop_marker_match_delta_seconds": marker_match_delta_seconds,
                "drop_snapshot_salary": safe_int(fallback_context["salary"], 0),
                "drop_snapshot_contract_info": safe_str(fallback_context["contract_info"]),
                "drop_snapshot_contract_status": safe_str(fallback_context["contract_status"]),
                "drop_snapshot_contract_length": safe_int(fallback_context["contract_length"], 0),
                "drop_snapshot_contract_year": safe_int(fallback_context["contract_year"], 0),
                "drop_snapshot_tcv": safe_int(fallback_context["tcv"], 0),
                "drop_snapshot_year_values_json": json.dumps(fallback_context["year_values"], sort_keys=True),
                "drop_contract_mismatch_flag": bool(mismatch_reason),
                "drop_contract_mismatch_reason": mismatch_reason,
                "drop_feed_available": bool(drop_feed_available),
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
    import_rows = [row for row in season_rows if bool(row.get("import_eligible"))]
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
            "import_eligible_count": len(import_rows),
            "import_eligible_total": round(sum(safe_float(row["amount"], 0.0) for row in import_rows), 2),
            "live_marker_rows_used": sum(1 for row in season_rows if safe_str(row.get("drop_contract_source")) == "live_marker"),
            "snapshot_fallback_rows_used": sum(
                1 for row in season_rows if safe_str(row.get("drop_contract_source")) == "snapshot_inferred"
            ),
            "drop_contract_mismatch_count": sum(1 for row in season_rows if bool(row.get("drop_contract_mismatch_flag"))),
            "review_only_due_to_missing_feed_count": sum(
                1
                for row in season_rows
                if safe_str(row.get("adjustment_type")) == "DROP_PENALTY_CANDIDATE"
                and safe_str(row.get("status")) == "review_required"
                and safe_str(row.get("drop_contract_source")) == "snapshot_inferred"
            ),
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
    import_out_dir = Path(args.import_out_dir).expanduser()

    ensure_inputs(db_path, sql_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    import_out_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    drop_feed_available = False
    drop_feed_error = ""
    try:
        ensure_source_tables(conn)
        ensure_views(conn, sql_path)
        drop_marker_lookup: Dict[tuple[str, str], List[Dict[str, Any]]] = {}
        if safe_str(args.salary_adjustments_url):
            try:
                feed_payload = fetch_salary_adjustments(
                    safe_str(args.salary_adjustments_url),
                    timeout=max(5, safe_int(args.salary_adjustments_timeout, 30)),
                    user_agent="codex-salary-adjustments-report/1.0",
                )
                drop_marker_lookup = build_drop_marker_lookup(feed_payload["rows"])
                drop_feed_available = bool(drop_marker_lookup)
            except Exception as exc:
                drop_feed_error = str(exc)
        trade_rows = build_trade_rows(conn, args.min_season, args.max_season)
        drop_rows = build_drop_candidate_rows(
            conn,
            args.min_season,
            args.max_season,
            drop_feed_available=drop_feed_available,
            allow_snapshot_fallback=bool(safe_int(args.allow_snapshot_fallback, 1)),
            drop_marker_lookup=drop_marker_lookup,
        )
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
        import_rows = [row for row in payload["rows"] if bool(row.get("import_eligible"))]
        import_path = import_out_dir / f"mfl_salary_adjustments_{season}.xml"
        write_import_xml(import_path, import_rows)
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
                "import_eligible_count": meta["import_eligible_count"],
                "import_eligible_total": meta["import_eligible_total"],
                "live_marker_rows_used": meta["live_marker_rows_used"],
                "snapshot_fallback_rows_used": meta["snapshot_fallback_rows_used"],
                "drop_contract_mismatch_count": meta["drop_contract_mismatch_count"],
                "review_only_due_to_missing_feed_count": meta["review_only_due_to_missing_feed_count"],
            }
        )

    notes = [
        "Traded salary rows are pulled directly from normalized accepted trade history.",
        "Drop penalty rows use live salaryAdjustments drop markers when available and otherwise fall back to local contract-history inference.",
        "Post-auction drop carryovers without live drop-marker evidence remain visible but are review-only and are excluded from XML import output.",
        "Drop adjustments stay in the current season before the first FreeAgent auction opens and roll into the next adjustment season on or after that auction start.",
    ]
    if safe_str(args.salary_adjustments_url) and drop_feed_error:
        notes.append(f"Live salaryAdjustments feed could not be loaded for this run: {drop_feed_error}")
    elif safe_str(args.salary_adjustments_url) and not drop_feed_available:
        notes.append("Live salaryAdjustments feed loaded, but no drop marker rows were matched for this run.")
    elif not safe_str(args.salary_adjustments_url):
        notes.append("No live salaryAdjustments feed URL was configured for this run.")

    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "meta": {
            "report_id": "salary-adjustments",
            "status_values": ["recorded", "review_required", "candidate"],
            "direction_values": ["charge", "relief", "review"],
            "adjustment_types": ["TRADED_SALARY", "DROP_PENALTY_CANDIDATE"],
            "drop_feed_configured": bool(safe_str(args.salary_adjustments_url)),
            "drop_feed_available": drop_feed_available,
            "drop_feed_error": drop_feed_error,
            "require_live_drop_feed": bool(safe_int(args.require_live_drop_feed, 0)),
            "allow_snapshot_fallback": bool(safe_int(args.allow_snapshot_fallback, 1)),
            "notes": notes,
        },
        "seasons": manifest_seasons,
    }
    write_json(out_dir / "salary_adjustments_manifest.json", manifest)
    print(
        f"Wrote salary adjustments report artifacts to {out_dir} and XML imports to {import_out_dir} "
        f"for {len(seasons)} season(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
