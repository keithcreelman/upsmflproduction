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
from xml.sax.saxutils import escape as xml_escape

from salary_adjustments_feed import (
    fetch_salary_adjustments,
    infer_feed_export_season,
    load_salary_adjustments_file,
    normalize_player_name,
    redact_feed_source,
    rewrite_feed_export_season,
)


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_DB_PATH = Path(os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db")))
DEFAULT_OUT_DIR = ROOT_DIR / "site" / "reports" / "salary_adjustments"
DEFAULT_SQL_PATH = DEFAULT_OUT_DIR / "salary_adjustments_sql.sql"
DEFAULT_IMPORT_OUT_DIR = Path(os.getenv("MFL_ETL_ARTIFACT_DIR", str(ETL_ROOT / "artifacts")))
DEFAULT_SALARY_ADJUSTMENTS_URL = os.getenv("MFL_SALARY_ADJUSTMENTS_URL", "")
DEFAULT_SALARY_ADJUSTMENTS_FILE = os.getenv("MFL_SALARY_ADJUSTMENTS_FILE", "")
DEFAULT_SALARY_ADJUSTMENTS_SPECIAL_CASES_FILE = os.getenv(
    "MFL_SALARY_ADJUSTMENTS_SPECIAL_CASES_FILE",
    str(ETL_ROOT / "inputs" / "salary_adjustments_special_cases.json"),
)
DEFAULT_SALARY_ADJUSTMENTS_TIMEOUT = 30
REQUIRED_SOURCE_TABLES = (
    "transactions_trades",
    "transactions_adddrop",
    "transactions_auction",
    "transactions_base",
    "contract_history_transaction_snapshots",
    "dim_franchise",
    "dim_player",
    "draftresults_combined",
    "rosters_weekly",
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


def safe_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = safe_str(value).lower()
    if not text:
        return default
    if text in {"1", "true", "yes", "y", "on"}:
        return True
    if text in {"0", "false", "no", "n", "off"}:
        return False
    return default


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--sql-path", default=str(DEFAULT_SQL_PATH))
    parser.add_argument("--import-out-dir", default=str(DEFAULT_IMPORT_OUT_DIR))
    parser.add_argument("--salary-adjustments-url", default=DEFAULT_SALARY_ADJUSTMENTS_URL)
    parser.add_argument("--salary-adjustments-file", default=DEFAULT_SALARY_ADJUSTMENTS_FILE)
    parser.add_argument(
        "--salary-adjustments-special-cases-file",
        default=DEFAULT_SALARY_ADJUSTMENTS_SPECIAL_CASES_FILE,
    )
    parser.add_argument("--salary-adjustments-timeout", type=int, default=DEFAULT_SALARY_ADJUSTMENTS_TIMEOUT)
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


def latest_acquisition_before(
    acquisition_lookup: Dict[tuple[str, str], List[Dict[str, Any]]],
    franchise_id: str,
    player_id: str,
    transaction_dt: datetime | None,
) -> Dict[str, Any] | None:
    rows = acquisition_lookup.get((safe_str(franchise_id), safe_str(player_id))) or []
    if not rows:
        return None
    if transaction_dt is None:
        return rows[-1]
    last_event: Dict[str, Any] | None = None
    for row in rows:
        event_dt = row.get("datetime")
        if not isinstance(event_dt, datetime):
            continue
        if event_dt <= transaction_dt:
            last_event = row
        else:
            break
    return last_event


def is_one_year_default_add_lineage(
    acquisition_event: Dict[str, Any] | None,
    contract_status: str,
) -> bool:
    if acquisition_event is not None:
        if safe_str(acquisition_event.get("acquisition_type")) != "add":
            return False
        method = safe_str(acquisition_event.get("method")).upper()
        event_source = safe_str(acquisition_event.get("event_source")).upper()
        if method in {"BBID", "WAIVER", "FREE_AGENT"}:
            return True
        return event_source.startswith("ADDDROP:")
    return safe_str(contract_status).upper() in {"WW", "ADD_DEFAULT_1YR"}


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
    contract_length: int,
    contract_year: int,
    year_values: Dict[int, int],
    current_year_salary: int,
) -> int:
    total_years = max(1, safe_int(contract_length, 1))
    years_remaining = max(1, safe_int(contract_year, 1))
    if year_values:
        current_year_index = max(1, total_years - years_remaining + 1)
        return sum(max(0, safe_int(amount, 0)) for idx, amount in year_values.items() if idx < current_year_index)
    elapsed_years = max(0, total_years - years_remaining)
    return max(0, elapsed_years * max(0, safe_int(current_year_salary, 0)))


def parse_datetime_et(value: str) -> datetime | None:
    text = safe_str(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


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


def chunked(values: List[str], size: int = 500) -> Iterable[List[str]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def load_acquisition_lineage_lookup(
    conn: sqlite3.Connection,
    player_ids: Iterable[str],
) -> Dict[tuple[str, str], List[Dict[str, Any]]]:
    player_values = sorted({safe_str(player_id) for player_id in player_ids if safe_str(player_id)})
    if not player_values:
        return {}

    out: Dict[tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)

    def append_event(
        franchise_id: str,
        player_id: str,
        acquisition_type: str,
        event_source: str,
        datetime_et: str,
        source_id: str,
        salary: int = 0,
        method: str = "",
    ) -> None:
        franchise_key = safe_str(franchise_id)
        player_key = safe_str(player_id)
        event_dt = parse_datetime_et(datetime_et)
        if not franchise_key or not player_key or event_dt is None:
            return
        out[(franchise_key, player_key)].append(
            {
                "acquisition_type": acquisition_type,
                "event_source": safe_str(event_source),
                "datetime_et": safe_str(datetime_et),
                "datetime": event_dt,
                "source_id": safe_str(source_id),
                "salary": max(0, safe_int(salary, 0)),
                "method": safe_str(method),
            }
        )

    for player_chunk in chunked(player_values):
        placeholders = ", ".join("?" for _ in player_chunk)

        add_rows = query_rows(
            conn,
            f"""
            SELECT
              franchise_id,
              player_id,
              method,
              salary,
              datetime_et,
              transactionid
            FROM transactions_adddrop
            WHERE move_type = 'ADD'
              AND player_id IN ({placeholders})
            ORDER BY player_id, franchise_id, datetime_et, txn_index
            """,
            player_chunk,
        )
        for row in add_rows:
            method = safe_str(row["method"])
            append_event(
                franchise_id=row["franchise_id"],
                player_id=row["player_id"],
                acquisition_type="add",
                event_source=f"ADDDROP:{method}" if method else "ADDDROP",
                datetime_et=safe_str(row["datetime_et"]),
                source_id=safe_str(row["transactionid"]),
                salary=safe_int(row["salary"], 0),
                method=method,
            )

        auction_rows = query_rows(
            conn,
            f"""
            SELECT
              franchise_id,
              player_id,
              auction_type,
              bid_amount,
              datetime_et,
              transactionid
            FROM transactions_auction
            WHERE finalbid_ind = 1
              AND player_id IN ({placeholders})
            ORDER BY player_id, franchise_id, datetime_et, txn_index
            """,
            player_chunk,
        )
        for row in auction_rows:
            auction_type = safe_str(row["auction_type"])
            append_event(
                franchise_id=row["franchise_id"],
                player_id=row["player_id"],
                acquisition_type="auction",
                event_source=f"AUCTION:{auction_type}" if auction_type else "AUCTION",
                datetime_et=safe_str(row["datetime_et"]),
                source_id=safe_str(row["transactionid"]),
                salary=safe_int(row["bid_amount"], 0),
            )

        trade_rows = query_rows(
            conn,
            f"""
            SELECT
              franchise_id,
              player_id,
              datetime_et,
              COALESCE(NULLIF(trade_group_id, ''), transactionid) AS source_id
            FROM transactions_trades
            WHERE franchise_role = 'RECEIVER'
              AND asset_role = 'ACQUIRE'
              AND asset_type = 'PLAYER'
              AND player_id IN ({placeholders})
            ORDER BY player_id, franchise_id, datetime_et, txn_index
            """,
            player_chunk,
        )
        for row in trade_rows:
            append_event(
                franchise_id=row["franchise_id"],
                player_id=row["player_id"],
                acquisition_type="trade",
                event_source="TRADE",
                datetime_et=safe_str(row["datetime_et"]),
                source_id=safe_str(row["source_id"]),
            )

    for events in out.values():
        events.sort(key=lambda event: (event["datetime"], event["source_id"], event["event_source"]))
    return out


def load_prior_season_contract_lookup(
    conn: sqlite3.Connection,
    seasons: Iterable[int],
) -> Dict[tuple[int, str, str], sqlite3.Row]:
    prior_seasons = sorted({safe_int(season, 0) - 1 for season in seasons if safe_int(season, 0) > 1})
    if not prior_seasons:
        return {}
    rows = query_rows(
        conn,
        """
        SELECT
          season,
          franchise_id,
          player_id,
          salary,
          contract_status,
          contract_length,
          contract_year,
          tcv,
          contract_info,
          year_values_json
        FROM contract_history_snapshots
        WHERE season IN ({})
          AND COALESCE(franchise_id, '') <> ''
          AND COALESCE(player_id, '') <> ''
        """.format(", ".join("?" for _ in prior_seasons)),
        prior_seasons,
    )
    out: Dict[tuple[int, str, str], sqlite3.Row] = {}
    for row in rows:
        key = (
            safe_int(row["season"]),
            safe_str(row["franchise_id"]),
            safe_str(row["player_id"]),
        )
        out[key] = row
    return out


def is_default_drop_contract(contract_status: str, contract_length: int, contract_info: str) -> bool:
    status = safe_str(contract_status).upper()
    info = safe_str(contract_info).upper()
    if max(0, safe_int(contract_length, 0)) > 1:
        return False
    if status in {"WW", "ADD_DEFAULT_1YR", ""}:
        return True
    return info in {"", "CL 1|"}


def roll_forward_prior_season_contract(prior_snapshot: sqlite3.Row | None) -> Dict[str, Any] | None:
    if prior_snapshot is None:
        return None
    contract_length = safe_int(prior_snapshot["contract_length"], 0)
    years_remaining = safe_int(prior_snapshot["contract_year"], 0)
    if contract_length <= 0 or years_remaining <= 1:
        return None
    year_values = parse_year_values(safe_str(prior_snapshot["year_values_json"]))
    if not year_values:
        return None
    rolled_years_remaining = years_remaining - 1
    current_year_index = max(1, contract_length - rolled_years_remaining + 1)
    current_year_salary = max(0, safe_int(year_values.get(current_year_index), 0))
    if current_year_salary <= 0:
        return None
    return {
        "salary": current_year_salary,
        "contract_length": contract_length,
        "contract_year": rolled_years_remaining,
        "tcv": max(0, safe_int(prior_snapshot["tcv"], 0)),
        "contract_status": safe_str(prior_snapshot["contract_status"]),
        "contract_info": safe_str(prior_snapshot["contract_info"]),
        "year_values": year_values,
    }


def load_salary_adjustments_special_cases(path_text: str) -> tuple[List[Dict[str, Any]], str]:
    path_value = safe_str(path_text)
    if not path_value:
        return [], ""
    path = Path(path_value).expanduser()
    if not path.is_file():
        return [], ""
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Salary adjustments special-cases file is invalid JSON at {path}: {exc}") from exc

    raw_rows = payload.get("rows") if isinstance(payload, dict) else payload
    if not isinstance(raw_rows, list):
        raise SystemExit(f"Salary adjustments special-cases file must contain a JSON list or an object with 'rows' at {path}")

    out: List[Dict[str, Any]] = []
    for raw_row in raw_rows:
        if not isinstance(raw_row, dict):
            continue
        row = {
            "source_id": safe_str(raw_row.get("source_id")),
            "source_season": safe_int(raw_row.get("source_season"), 0),
            "adjustment_season": safe_int(raw_row.get("adjustment_season"), 0),
            "franchise_id": safe_str(raw_row.get("franchise_id")),
            "player_id": safe_str(raw_row.get("player_id")),
            "player_name": safe_str(raw_row.get("player_name")),
            "exemption_type": safe_str(raw_row.get("exemption_type")).lower() or "manual",
            "note": safe_str(raw_row.get("note")),
            "cap_penalty_exempt": safe_bool(raw_row.get("cap_penalty_exempt"), True),
            "source": safe_str(raw_row.get("source")) or str(path),
        }
        match_key_count = sum(
            1
            for value in (
                row["source_id"],
                row["franchise_id"],
                row["player_id"],
                row["player_name"],
                row["source_season"],
                row["adjustment_season"],
            )
            if value not in {"", 0}
        )
        if match_key_count == 0:
            continue
        row["match_key_count"] = match_key_count
        out.append(row)
    return out, str(path)


def match_salary_adjustments_special_case(
    special_cases: List[Dict[str, Any]],
    source_id: str,
    source_season: int,
    adjustment_season: int,
    franchise_id: str,
    player_id: str,
    player_name: str,
) -> Dict[str, Any] | None:
    matches: List[Dict[str, Any]] = []
    for row in special_cases:
        if row["source_id"] and row["source_id"] != safe_str(source_id):
            continue
        if row["source_season"] and row["source_season"] != safe_int(source_season, 0):
            continue
        if row["adjustment_season"] and row["adjustment_season"] != safe_int(adjustment_season, 0):
            continue
        if row["franchise_id"] and row["franchise_id"] != safe_str(franchise_id):
            continue
        if row["player_id"] and row["player_id"] != safe_str(player_id):
            continue
        if row["player_name"] and row["player_name"] != safe_str(player_name):
            continue
        matches.append(row)
    if not matches:
        return None
    matches.sort(key=lambda row: (-safe_int(row.get("match_key_count"), 0), row["source"]))
    return matches[0]


def load_salary_adjustments_feed(
    feed_url: str,
    feed_file: str,
    timeout: int,
    required_feed_seasons: Iterable[int] = (),
) -> tuple[List[Dict[str, Any]], str, str, List[int]]:
    url_text = safe_str(feed_url)
    file_text = safe_str(feed_file)
    timeout_value = max(5, safe_int(timeout, 30))
    if url_text:
        feed_rows: List[Dict[str, Any]] = []
        fetch_errors: List[str] = []
        seen_keys: set[tuple[Any, ...]] = set()
        requested_season = infer_feed_export_season(url_text)
        season_candidates = sorted(
            {
                season
                for season in [requested_season, *[safe_int(value, 0) for value in required_feed_seasons]]
                if season > 0
            },
            reverse=True,
        )
        url_candidates = [url_text]
        if season_candidates:
            url_candidates = []
            seen_urls: set[str] = set()
            for season in season_candidates:
                candidate_url = rewrite_feed_export_season(url_text, season)
                if not candidate_url or candidate_url in seen_urls:
                    continue
                seen_urls.add(candidate_url)
                url_candidates.append(candidate_url)
        for candidate_url in url_candidates:
            try:
                payload = fetch_salary_adjustments(candidate_url, timeout=timeout_value)
            except Exception as exc:
                fetch_errors.append(f"{candidate_url}: {exc}")
                continue
            for row in payload.get("rows") or []:
                row_key = (
                    safe_int(row.get("feed_export_season"), 0),
                    safe_str(row.get("id")),
                    safe_str(row.get("franchise_id")),
                    safe_int(row.get("timestamp"), 0),
                    safe_str(row.get("description")),
                    rounded(row.get("amount"), 6),
                )
                if row_key in seen_keys:
                    continue
                seen_keys.add(row_key)
                feed_rows.append(dict(row))
        if feed_rows:
            loaded_seasons = sorted(
                {
                    safe_int(row.get("feed_export_season"), 0)
                    for row in feed_rows
                    if safe_int(row.get("feed_export_season"), 0) > 0
                },
                reverse=True,
            )
            if not loaded_seasons:
                loaded_seasons = [0]
            return feed_rows, url_text, "; ".join(fetch_errors), loaded_seasons
        if not file_text:
            return [], url_text, "; ".join(fetch_errors), []
    if file_text:
        try:
            payload = load_salary_adjustments_file(file_text)
            rows = [dict(row) for row in (payload.get("rows") or [])]
            loaded_seasons = sorted(
                {
                    safe_int(row.get("feed_export_season"), 0)
                    for row in rows
                    if safe_int(row.get("feed_export_season"), 0) > 0
                },
                reverse=True,
            )
            if rows and not loaded_seasons:
                loaded_seasons = [0]
            return rows, safe_str(payload.get("source")), "", loaded_seasons
        except Exception as exc:
            return [], file_text or url_text, str(exc), []
    return [], url_text or file_text, "", []


def load_drop_source_seasons(conn: sqlite3.Connection) -> List[int]:
    rows = query_rows(
        conn,
        """
        SELECT DISTINCT source_season
        FROM report_salary_adjustments_drop_base_v1
        WHERE COALESCE(source_season, 0) > 0
        ORDER BY source_season DESC
        """,
    )
    return [safe_int(row["source_season"], 0) for row in rows if safe_int(row["source_season"], 0) > 0]


def build_marker_lookup(feed_rows: List[Dict[str, Any]]) -> Dict[tuple[int, str, str], List[Dict[str, Any]]]:
    out: Dict[tuple[int, str, str], List[Dict[str, Any]]] = {}
    for row in feed_rows:
        if safe_str(row.get("category")) != "drop_marker":
            continue
        key = (
            safe_int(row.get("feed_export_season"), 0),
            safe_str(row.get("franchise_id")),
            safe_str(row.get("marker_player_name_normalized")),
        )
        if not key[1] or not key[2]:
            continue
        out.setdefault(key, []).append(row)
    return out


def build_team_cap_penalty_lookup(feed_rows: List[Dict[str, Any]]) -> Dict[tuple[int, str], int]:
    totals: Dict[tuple[int, str], int] = defaultdict(int)
    for row in feed_rows:
        if safe_str(row.get("category")) != "cap_penalty":
            continue
        season = safe_int(row.get("cap_penalty_season"), 0)
        franchise_id = safe_str(row.get("franchise_id"))
        if season <= 0 or not franchise_id:
            continue
        totals[(season, franchise_id)] += safe_int(row.get("amount"), 0)
    return dict(totals)


def match_drop_marker(
    marker_lookup: Dict[tuple[int, str, str], List[Dict[str, Any]]],
    source_season: int,
    franchise_id: str,
    player_name: str,
    transaction_dt: datetime | None,
    tolerance_seconds: int = 24 * 60 * 60,
) -> tuple[Dict[str, Any] | None, str]:
    player_key = normalize_player_name(player_name)
    season_key = (safe_int(source_season, 0), safe_str(franchise_id), player_key)
    candidates = marker_lookup.get(season_key) or []
    if not candidates:
        candidates = marker_lookup.get((0, safe_str(franchise_id), player_key)) or []
    if not candidates:
        return None, "missing"
    if transaction_dt is None:
        return (candidates[0], "matched_name_only") if len(candidates) == 1 else (None, "ambiguous")

    ranked: List[tuple[float, Dict[str, Any], bool]] = []
    for row in candidates:
        created_dt = parse_datetime_et(safe_str(row.get("created_at_et")))
        if created_dt is None:
            continue
        delta = abs((created_dt - transaction_dt).total_seconds())
        if delta <= tolerance_seconds:
            ranked.append((delta, row, delta < 1))
    if not ranked:
        return None, "missing"
    exact = [item for item in ranked if item[2]]
    if len(exact) == 1:
        return exact[0][1], "matched_exact"
    if len(exact) > 1:
        return None, "ambiguous"
    ranked.sort(key=lambda item: item[0])
    if len(ranked) > 1 and abs(ranked[0][0] - ranked[1][0]) < 1:
        return None, "ambiguous"
    return ranked[0][1], "matched_window"


def marker_contract_basis(marker_row: Dict[str, Any]) -> Dict[str, Any]:
    current_year_salary = max(0, safe_int(marker_row.get("marker_drop_salary"), 0))
    contract_length = max(
        0,
        safe_int(marker_row.get("marker_contract_length"), safe_int(marker_row.get("marker_years_remaining"), 0)),
    )
    contract_year = max(0, safe_int(marker_row.get("marker_years_remaining"), 0))
    total_contract_value = max(0, safe_int(marker_row.get("marker_tcv"), 0))
    contract_status = safe_str(marker_row.get("marker_type"))
    contract_info = safe_str(marker_row.get("marker_special"))
    year_values = parse_year_values(safe_str(marker_row.get("marker_year_values_json")))
    if not year_values and contract_length == 1 and current_year_salary > 0:
        year_values = {1: current_year_salary}
    if total_contract_value <= 0 and year_values:
        total_contract_value = sum(max(0, safe_int(amount, 0)) for amount in year_values.values())
    if total_contract_value <= 0 and contract_length > 0 and current_year_salary > 0:
        total_contract_value = current_year_salary * contract_length
    return {
        "salary": current_year_salary,
        "contract_length": contract_length,
        "contract_year": contract_year,
        "tcv": total_contract_value,
        "contract_status": contract_status,
        "contract_info": contract_info,
        "year_values": year_values,
    }


def format_mfl_amount(dollars: Any) -> str:
    amount = safe_float(dollars, 0.0)
    rounded_amount = round(amount)
    if abs(amount - rounded_amount) < 1e-9:
        return str(int(rounded_amount))
    text = f"{amount:.3f}".rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


def write_import_xml(path: Path, rows: List[Dict[str, Any]]) -> None:
    items = []
    for row in rows:
        if not row.get("import_eligible"):
            continue
        items.append(
            '<salary_adjustment franchise_id="{franchise_id}" amount="{amount}" explanation="{explanation}"/>'.format(
                franchise_id=xml_escape(safe_str(row.get("franchise_id"))),
                amount=xml_escape(format_mfl_amount(row.get("amount"))),
                explanation=xml_escape(safe_str(row.get("description"))),
            )
        )
    path.write_text(f"<salary_adjustments>{''.join(items)}</salary_adjustments>\n", encoding="utf-8")


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


def contract_year_index(contract_length: int, contract_year: int) -> int:
    total_years = max(1, safe_int(contract_length, 1))
    years_remaining = max(1, safe_int(contract_year, 1))
    return max(1, total_years - years_remaining + 1)


def parse_id_list(text: Any) -> List[str]:
    return [part.strip() for part in safe_str(text).split(",") if part.strip()]


def load_contract_deadline_lookup(
    conn: sqlite3.Connection,
    seasons: Iterable[int],
) -> Dict[int, str]:
    season_values = sorted({safe_int(season, 0) for season in seasons if safe_int(season, 0) > 0})
    if not season_values:
        return {}
    rows = query_rows(
        conn,
        """
        SELECT season, MAX(cutoff_contract_deadline_date) AS cutoff_contract_deadline_date
        FROM contract_history_snapshots
        WHERE season IN ({})
          AND COALESCE(cutoff_contract_deadline_date, '') <> ''
        GROUP BY season
        """.format(", ".join("?" for _ in season_values)),
        season_values,
    )
    return {
        safe_int(row["season"], 0): safe_str(row["cutoff_contract_deadline_date"])
        for row in rows
        if safe_int(row["season"], 0) > 0 and safe_str(row["cutoff_contract_deadline_date"])
    }


def load_draft_pick_lookup(
    conn: sqlite3.Connection,
    player_ids: Iterable[str],
) -> Dict[str, sqlite3.Row]:
    player_values = sorted({safe_str(player_id) for player_id in player_ids if safe_str(player_id)})
    if not player_values:
        return {}
    out: Dict[str, sqlite3.Row] = {}
    for player_chunk in chunked(player_values):
        rows = query_rows(
            conn,
            """
            SELECT
              season,
              draftpick_round,
              draftpick_roundorder,
              draftpick_overall,
              player_id,
              player_name,
              franchise_id,
              franchise_name
            FROM draftresults_combined
            WHERE player_id IN ({})
            ORDER BY season ASC, draftpick_overall ASC, player_id ASC
            """.format(", ".join("?" for _ in player_chunk)),
            player_chunk,
        )
        for row in rows:
            player_id = safe_str(row["player_id"])
            if player_id and player_id not in out:
                out[player_id] = row
    return out


def load_taxi_event_lookup(
    conn: sqlite3.Connection,
    player_ids: Iterable[str],
    max_season: int,
) -> Dict[tuple[str, str], List[Dict[str, Any]]]:
    player_values = {safe_str(player_id) for player_id in player_ids if safe_str(player_id)}
    if not player_values:
        return {}
    rows = query_rows(
        conn,
        """
        SELECT season, datetime_et, raw_json
        FROM transactions_base
        WHERE type = 'TAXI'
          AND season <= ?
        ORDER BY season, datetime_et, txn_index
        """,
        (max(0, safe_int(max_season, 0)),),
    )
    out: Dict[tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for row in rows:
        raw_json_text = safe_str(row["raw_json"])
        if not raw_json_text:
            continue
        try:
            payload = json.loads(raw_json_text)
        except json.JSONDecodeError:
            continue
        franchise_id = safe_str(payload.get("franchise")).zfill(4)[-4:]
        event_dt = parse_datetime_et(safe_str(row["datetime_et"]))
        if not franchise_id or event_dt is None:
            continue
        for player_id in parse_id_list(payload.get("demoted")):
            if player_id not in player_values:
                continue
            out[(franchise_id, player_id)].append({"datetime": event_dt, "state": "taxi"})
        for player_id in parse_id_list(payload.get("promoted")):
            if player_id not in player_values:
                continue
            out[(franchise_id, player_id)].append({"datetime": event_dt, "state": "active"})
    for events in out.values():
        events.sort(key=lambda item: item["datetime"])
    return out


def latest_taxi_state_before(
    taxi_lookup: Dict[tuple[str, str], List[Dict[str, Any]]],
    franchise_id: str,
    player_id: str,
    transaction_dt: datetime | None,
) -> str:
    rows = taxi_lookup.get((safe_str(franchise_id), safe_str(player_id))) or []
    if not rows:
        return ""
    if transaction_dt is None:
        return safe_str(rows[-1].get("state"))
    last_state = ""
    for row in rows:
        event_dt = row.get("datetime")
        if not isinstance(event_dt, datetime):
            continue
        if event_dt <= transaction_dt:
            last_state = safe_str(row.get("state"))
        else:
            break
    return last_state


def load_weekly_roster_status_lookup(
    conn: sqlite3.Connection,
    player_ids: Iterable[str],
    max_season: int,
) -> Dict[tuple[str, str], List[Dict[str, Any]]]:
    player_values = sorted({safe_str(player_id) for player_id in player_ids if safe_str(player_id)})
    if not player_values:
        return {}
    out: Dict[tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for player_chunk in chunked(player_values):
        rows = query_rows(
            conn,
            """
            SELECT season, week, franchise_id, player_id, status
            FROM rosters_weekly
            WHERE season <= ?
              AND player_id IN ({})
            ORDER BY season, week
            """.format(", ".join("?" for _ in player_chunk)),
            [max(0, safe_int(max_season, 0)), *player_chunk],
        )
        for row in rows:
            key = (safe_str(row["franchise_id"]), safe_str(row["player_id"]))
            out[key].append(
                {
                    "season": safe_int(row["season"], 0),
                    "week": safe_int(row["week"], 0),
                    "status": safe_str(row["status"]),
                }
            )
    return out


def latest_weekly_roster_status_before(
    weekly_lookup: Dict[tuple[str, str], List[Dict[str, Any]]],
    source_season: int,
    franchise_id: str,
    player_id: str,
) -> str:
    rows = weekly_lookup.get((safe_str(franchise_id), safe_str(player_id))) or []
    if not rows:
        return ""
    last_status = ""
    for row in rows:
        season = safe_int(row.get("season"), 0)
        if season > safe_int(source_season, 0):
            break
        last_status = safe_str(row.get("status"))
    return last_status


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
                "contract_basis_source": "not_applicable",
                "marker_match_status": "not_applicable",
                "marker_description": "",
                "marker_created_at_et": "",
                "reconciliation_status": "not_applicable",
                "reconciliation_note": "",
                "posted_team_season_cap_penalty": None,
                "computed_team_season_cap_penalty": None,
                "team_season_cap_penalty_delta": None,
                "original_guarantee": 0,
                "total_salary_earned": 0,
                "penalty_amount": amount,
                "penalty_rule": "",
                "pre_exemption_penalty_amount": amount,
                "cap_free_exemption_flag": False,
                "cap_free_exemption_type": "",
                "cap_free_exemption_note": "",
                "cap_free_exemption_source": "",
                "import_eligible": status == "recorded",
                "candidate_rule": "",
            }
        )
    return out


def build_drop_candidate_rows(
    conn: sqlite3.Connection,
    min_season: int | None,
    max_season: int | None,
    feed_rows: List[Dict[str, Any]],
    feed_export_seasons: List[int],
    special_cases: List[Dict[str, Any]],
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
    player_ids = {safe_str(row["player_id"]) for row in rows if safe_str(row["player_id"])}
    auction_start_lookup = load_free_agent_auction_start_lookup(conn, source_seasons)
    contract_deadline_lookup = load_contract_deadline_lookup(conn, source_seasons)
    add_lookup = load_adddrop_add_lookup(conn, source_seasons)
    acquisition_lookup = load_acquisition_lineage_lookup(conn, player_ids)
    prior_contract_lookup = load_prior_season_contract_lookup(conn, source_seasons)
    draft_pick_lookup = load_draft_pick_lookup(conn, player_ids)
    taxi_event_lookup = load_taxi_event_lookup(conn, player_ids, max(source_seasons) if source_seasons else 0)
    weekly_roster_status_lookup = load_weekly_roster_status_lookup(conn, player_ids, max(source_seasons) if source_seasons else 0)
    marker_lookup = build_marker_lookup(feed_rows)
    out: List[Dict[str, Any]] = []
    for row in rows:
        source_season = safe_int(row["source_season"])
        transaction_dt = parse_datetime_et(row["transaction_datetime_et"])
        season, season_note = effective_drop_adjustment_season(source_season, transaction_dt, auction_start_lookup)
        if min_season is not None and season < min_season:
            continue
        if max_season is not None and season > max_season:
            continue
        current_year_salary = safe_int(row["pre_drop_salary"], 0)
        contract_length = safe_int(row["pre_drop_contract_length"], 0)
        total_contract_value = safe_int(row["pre_drop_tcv"], 0)
        contract_year = safe_int(row["pre_drop_contract_year"], 0)
        contract_status = safe_str(row["pre_drop_contract_status"])
        contract_info = safe_str(row["pre_drop_contract_info"])
        year_values = parse_year_values(row["pre_drop_year_values_json"])
        draft_pick = draft_pick_lookup.get(safe_str(row["player_id"]))

        penalty = 0
        original_guarantee = 0
        total_salary_earned = 0
        candidate_rule = ""
        penalty_rule = ""
        note = ""
        context_note = ""
        contract_basis_source = "snapshot_fallback"
        marker_id = ""
        marker_feed_export_season = 0
        marker_description = ""
        marker_created_at_et = ""
        pre_exemption_penalty_amount = 0
        cap_free_exemption_flag = False
        cap_free_exemption_type = ""
        cap_free_exemption_note = ""
        cap_free_exemption_source = ""

        feed_applicable = source_season in feed_export_seasons or 0 in feed_export_seasons
        matched_marker = None
        marker_match_status = "not_applicable"
        if feed_applicable:
            matched_marker, marker_match_status = match_drop_marker(
                marker_lookup,
                source_season,
                safe_str(row["franchise_id"]),
                safe_str(row["player_name"]),
                transaction_dt,
            )
        elif feed_rows:
            marker_match_status = "not_applicable"
        else:
            marker_match_status = "feed_unavailable"

        last_add = latest_adddrop_add_before(
            add_lookup,
            source_season,
            safe_str(row["franchise_id"]),
            safe_str(row["player_id"]),
            transaction_dt,
        )
        acquisition_event = latest_acquisition_before(
            acquisition_lookup,
            safe_str(row["franchise_id"]),
            safe_str(row["player_id"]),
            transaction_dt,
        )
        if matched_marker is not None:
            basis = marker_contract_basis(matched_marker)
            current_year_salary = safe_int(basis["salary"], 0)
            total_contract_value = safe_int(basis["tcv"], 0)
            contract_year = safe_int(basis["contract_year"], 0)
            contract_length = safe_int(basis["contract_length"], 0)
            contract_status = safe_str(basis["contract_status"])
            contract_info = safe_str(basis["contract_info"])
            year_values = dict(basis["year_values"])
            contract_basis_source = "live_marker"
            marker_id = safe_str(matched_marker.get("salary_adjustment_id") or matched_marker.get("id"))
            marker_feed_export_season = safe_int(matched_marker.get("feed_export_season"), 0)
            marker_description = safe_str(matched_marker.get("description"))
            marker_created_at_et = safe_str(matched_marker.get("created_at_et"))
            context_note = "Pre-drop contract taken from matching live salaryAdjustments marker."
        else:
            if is_default_drop_contract(contract_status, contract_length, contract_info):
                prior_snapshot = prior_contract_lookup.get(
                    (
                        source_season - 1,
                        safe_str(row["franchise_id"]),
                        safe_str(row["player_id"]),
                    )
                )
                rolled_contract = roll_forward_prior_season_contract(prior_snapshot)
                if rolled_contract is not None:
                    current_year_salary = safe_int(rolled_contract["salary"], 0)
                    total_contract_value = safe_int(rolled_contract["tcv"], 0)
                    contract_year = safe_int(rolled_contract["contract_year"], 0)
                    contract_length = safe_int(rolled_contract["contract_length"], 0)
                    contract_status = safe_str(rolled_contract["contract_status"])
                    contract_info = safe_str(rolled_contract["contract_info"])
                    year_values = dict(rolled_contract["year_values"])
                    contract_basis_source = "prior_season_rollforward"
                    context_note = (
                        f"Pre-drop contract rolled forward from the {source_season - 1} end-of-season snapshot for the same franchise."
                    )
            if (
                contract_basis_source == "snapshot_fallback"
                and last_add is not None
                and contract_length == 1
                and is_one_year_default_add_lineage(acquisition_event, contract_status)
            ):
                add_salary = max(0, safe_int(last_add["salary"], 0))
                if add_salary > 0 and add_salary != current_year_salary:
                    current_year_salary = add_salary
                    total_contract_value = add_salary
                    contract_year = 1
                    contract_length = 1
                    if not contract_status:
                        contract_status = "WW"
                    year_values = {1: add_salary}
                    contract_basis_source = "preceding_add_salary"
                    context_note = (
                        f"Waiver salary basis taken from preceding {safe_str(last_add['method']) or 'add/drop'} add salary of {add_salary:,}."
                    )

        explicit_guarantee = parse_explicit_guarantee(contract_info)
        current_year_index = contract_year_index(contract_length, contract_year) if contract_length > 0 else 0
        deadline_date = safe_str(contract_deadline_lookup.get(source_season))
        is_pre_deadline_cut = bool(
            transaction_dt is not None
            and deadline_date
            and transaction_dt.date().isoformat() <= deadline_date
        )
        draft_round = safe_int(draft_pick["draftpick_round"], 0) if draft_pick is not None else 0
        taxi_state = latest_taxi_state_before(
            taxi_event_lookup,
            safe_str(row["franchise_id"]),
            safe_str(row["player_id"]),
            transaction_dt,
        )
        if not taxi_state:
            weekly_status = latest_weekly_roster_status_before(
                weekly_roster_status_lookup,
                source_season,
                safe_str(row["franchise_id"]),
                safe_str(row["player_id"]),
            )
            if weekly_status.upper() == "TAXI_SQUAD":
                taxi_state = "taxi"
        on_taxi_at_drop = taxi_state == "taxi"
        rookie_round_2_plus_pre_deadline = (
            contract_status.upper() == "ROOKIE"
            and current_year_index == 1
            and draft_round >= 2
            and is_pre_deadline_cut
        )

        if contract_length <= 0:
            penalty = 0
        elif on_taxi_at_drop:
            penalty = 0
        elif rookie_round_2_plus_pre_deadline:
            penalty = 0
        elif is_tag_cut_pre_auction_assumption(contract_status, auction_start_lookup.get(source_season), transaction_dt):
            penalty = 0
        elif contract_length == 1 and current_year_salary < 5000 and contract_status.upper() in {"VETERAN", "WW"}:
            penalty = 0
        elif (
            contract_length == 1
            and current_year_salary >= 5000
            and is_one_year_default_add_lineage(acquisition_event, contract_status)
        ):
            original_guarantee = current_year_salary
            total_salary_earned = 0
            penalty = round(current_year_salary * 0.35)
            candidate_rule = "waiver_35pct"
            penalty_rule = f"35% of current-year salary ({current_year_salary:,} x 35%)"
            note = f"Waiver pickup rule: {penalty_rule}."
        else:
            prior_earned = earned_before_current_contract_year(
                contract_length,
                contract_year,
                year_values,
                current_year_salary,
            )
            accrued = prorated_earned_for_drop(source_season, current_year_salary, transaction_dt)
            guaranteed, guarantee_label = guaranteed_contract_value(
                total_contract_value,
                current_year_salary,
                explicit_guarantee=explicit_guarantee,
            )
            original_guarantee = guaranteed
            total_salary_earned = prior_earned + accrued
            penalty = max(0, original_guarantee - total_salary_earned)
            candidate_rule = "guarantee_minus_earned"
            penalty_rule = f"{guarantee_label} ({guaranteed:,}) minus earned to date ({total_salary_earned:,})"
            note = (
                "Projected current-rule penalty: "
                f"{guarantee_label} is {guaranteed:,}; earned to date is {total_salary_earned:,}."
            )

        special_case = match_salary_adjustments_special_case(
            special_cases,
            safe_str(row["source_id"]),
            source_season,
            season,
            safe_str(row["franchise_id"]),
            safe_str(row["player_id"]),
            safe_str(row["player_name"]),
        )
        if special_case is not None and penalty > 0 and safe_bool(special_case.get("cap_penalty_exempt"), True):
            pre_exemption_penalty_amount = penalty
            cap_free_exemption_flag = True
            cap_free_exemption_type = safe_str(special_case.get("exemption_type"))
            cap_free_exemption_note = safe_str(special_case.get("note"))
            cap_free_exemption_source = safe_str(special_case.get("source"))
            penalty = 0

        if penalty <= 0 and not cap_free_exemption_flag:
            continue

        status = "candidate"
        status_detail = "Projected from add/drop transaction history plus inferred contract lineage."
        reconciliation_status = ""
        reconciliation_note = ""
        if contract_basis_source == "live_marker":
            status_detail = "Projected from add/drop transaction history with the pre-drop contract overridden by a live salaryAdjustments marker."
            reconciliation_status = "marker_matched"
            reconciliation_note = "Matched a live salaryAdjustments drop marker for this event."
        elif contract_basis_source == "prior_season_rollforward":
            status_detail = "Projected from add/drop transaction history with the pre-drop contract rolled forward from the prior season end."
        elif contract_basis_source == "preceding_add_salary":
            status_detail = "Projected from add/drop transaction history using the same-owner preceding add salary for a one-year waiver/default contract."
        else:
            status_detail = "Projected from add/drop transaction history plus the pre-drop contract snapshot."

        if feed_applicable and matched_marker is None:
            status = "review_required"
            reconciliation_status = "unmatched_marker"
            if marker_match_status == "ambiguous":
                reconciliation_note = "Multiple live salaryAdjustments markers matched this drop within the timestamp window."
            else:
                reconciliation_note = "No live salaryAdjustments marker matched this drop; inference remains unreconciled."
        elif not feed_rows and season != source_season and contract_basis_source == "snapshot_fallback":
            status = "review_required"
            reconciliation_status = "feed_unavailable"
            reconciliation_note = "No live salaryAdjustments feed was provided, and this rolled-next-season drop still relies on snapshot fallback."

        if cap_free_exemption_flag:
            status = "review_required"
            reconciliation_status = "special_case_flagged"
            reconciliation_note = (
                f"Flagged by manual special-cases input as a cap-free {cap_free_exemption_type or 'special-case'} candidate."
            )
            status_detail = (
                "Projected from add/drop transaction history, but a manual special-cases input flagged this row as a cap-free exemption candidate."
            )

        description_parts = [
            f"Candidate drop penalty from {safe_str(row['drop_method']) or safe_str(row['event_source']) or 'drop transaction'}.",
            note,
        ]
        if season_note:
            description_parts.append(season_note)
        if context_note:
            description_parts.append(context_note)
        if cap_free_exemption_flag:
            description_parts.append(
                "Flagged manual cap-free exemption; import suppressed pending commissioner review."
            )
            if cap_free_exemption_note:
                description_parts.append(cap_free_exemption_note)
        out.append(
            {
                "adjustment_season": season,
                "franchise_id": safe_str(row["franchise_id"]),
                "franchise_name": safe_str(row["franchise_name"]),
                "adjustment_type": safe_str(row["adjustment_type"]),
                "source_table": safe_str(row["source_table"]),
                "source_id": safe_str(row["source_id"]),
                "source_season": source_season,
                "player_id": safe_str(row["player_id"]),
                "player_name": safe_str(row["player_name"]),
                "transaction_datetime_et": safe_str(row["transaction_datetime_et"]),
                "amount": penalty,
                "direction": "review" if cap_free_exemption_flag else "charge",
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
                "contract_basis_source": contract_basis_source,
                "marker_id": marker_id,
                "marker_feed_export_season": marker_feed_export_season,
                "marker_match_status": marker_match_status,
                "marker_description": marker_description,
                "marker_created_at_et": marker_created_at_et,
                "reconciliation_status": reconciliation_status,
                "reconciliation_note": reconciliation_note,
                "posted_team_season_cap_penalty": None,
                "computed_team_season_cap_penalty": None,
                "team_season_cap_penalty_delta": None,
                "original_guarantee": original_guarantee,
                "total_salary_earned": total_salary_earned,
                "penalty_amount": penalty,
                "penalty_rule": penalty_rule,
                "pre_exemption_penalty_amount": pre_exemption_penalty_amount or penalty,
                "cap_free_exemption_flag": cap_free_exemption_flag,
                "cap_free_exemption_type": cap_free_exemption_type,
                "cap_free_exemption_note": cap_free_exemption_note,
                "cap_free_exemption_source": cap_free_exemption_source,
                "import_eligible": status == "candidate" and not cap_free_exemption_flag,
                "candidate_rule": candidate_rule,
            }
        )
    return out


def apply_drop_reconciliation(
    rows: List[Dict[str, Any]],
    team_cap_penalty_lookup: Dict[tuple[int, str], int],
) -> None:
    computed_by_team_season: Dict[tuple[int, str], int] = defaultdict(int)
    for row in rows:
        key = (safe_int(row.get("adjustment_season"), 0), safe_str(row.get("franchise_id")))
        if key[0] > 0 and key[1]:
            computed_by_team_season[key] += safe_int(row.get("amount"), 0)

    for row in rows:
        season = safe_int(row.get("adjustment_season"), 0)
        franchise_id = safe_str(row.get("franchise_id"))
        computed_total = computed_by_team_season.get((season, franchise_id), 0)
        row["computed_team_season_cap_penalty"] = computed_total

        posted_total = team_cap_penalty_lookup.get((season, franchise_id))
        row["posted_team_season_cap_penalty"] = posted_total if posted_total is not None else None
        if safe_bool(row.get("cap_free_exemption_flag"), False):
            if posted_total is not None:
                row["team_season_cap_penalty_delta"] = computed_total - posted_total
            continue
        if posted_total is None:
            if safe_str(row.get("contract_basis_source")) == "live_marker":
                row["reconciliation_status"] = "marker_matched"
                row["reconciliation_note"] = (
                    safe_str(row.get("reconciliation_note"))
                    or f"Matched a live drop marker, but no posted {season}_Cap_Penalties row exists yet for this team."
                )
            elif not safe_str(row.get("reconciliation_status")):
                row["reconciliation_status"] = "not_applicable"
            continue

        delta = computed_total - posted_total
        row["team_season_cap_penalty_delta"] = delta
        if delta == 0:
            if safe_str(row.get("contract_basis_source")) == "live_marker":
                row["reconciliation_status"] = "matched"
                row["reconciliation_note"] = f"Matched live drop marker and posted {season}_Cap_Penalties total."
            elif safe_str(row.get("reconciliation_status")) != "review_required":
                row["reconciliation_status"] = "team_total_matched"
                row["reconciliation_note"] = f"Matched posted {season}_Cap_Penalties total."
            continue

        row["status"] = "review_required"
        row["import_eligible"] = False
        row["reconciliation_status"] = "team_total_mismatch"
        row["reconciliation_note"] = (
            f"Computed {season}_Cap_Penalties total is {computed_total:,}; posted live total is {posted_total:,}."
        )


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
            "import_eligible_count": sum(1 for row in season_rows if row.get("import_eligible")),
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
    special_cases, special_cases_source = load_salary_adjustments_special_cases(
        safe_str(args.salary_adjustments_special_cases_file)
    )

    ensure_inputs(db_path, sql_path)
    out_dir.mkdir(parents=True, exist_ok=True)
    import_out_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        ensure_source_tables(conn)
        ensure_views(conn, sql_path)
        feed_source_seasons = load_drop_source_seasons(conn)
        feed_rows, feed_source, feed_error, feed_export_seasons = load_salary_adjustments_feed(
            safe_str(args.salary_adjustments_url),
            safe_str(args.salary_adjustments_file),
            safe_int(args.salary_adjustments_timeout, DEFAULT_SALARY_ADJUSTMENTS_TIMEOUT),
            required_feed_seasons=feed_source_seasons,
        )
        team_cap_penalty_lookup = build_team_cap_penalty_lookup(feed_rows)
        trade_rows = build_trade_rows(conn, args.min_season, args.max_season)
        drop_rows = build_drop_candidate_rows(
            conn,
            args.min_season,
            args.max_season,
            feed_rows,
            feed_export_seasons,
            special_cases,
        )
    finally:
        conn.close()

    apply_drop_reconciliation(drop_rows, team_cap_penalty_lookup)
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
                "import_eligible_count": meta["import_eligible_count"],
            }
        )
        write_import_xml(import_out_dir / f"mfl_salary_adjustments_{season}.xml", payload["rows"])

    manifest = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "meta": {
            "report_id": "salary-adjustments",
            "status_values": ["recorded", "review_required", "candidate"],
            "direction_values": ["charge", "relief", "review"],
            "adjustment_types": ["TRADED_SALARY", "DROP_PENALTY_CANDIDATE"],
            "notes": [
                "Traded salary rows are pulled directly from normalized accepted trade history.",
                "Drop penalty rows reconcile against the live salaryAdjustments feed when available and otherwise fall back to inferred contract lineage.",
                "Drop adjustments stay in the source season before the first FreeAgent auction opens and roll into the following season on or after that auction start.",
                "Manual special-cases input can flag cap-free retirement or jail-bird exemptions and suppress import output for those rows.",
            ],
            "salary_adjustments_feed_source": redact_feed_source(feed_source),
            "salary_adjustments_feed_season": infer_feed_export_season(feed_source),
            "salary_adjustments_feed_export_seasons": feed_export_seasons,
            "salary_adjustments_feed_error": feed_error,
            "salary_adjustments_feed_row_count": len(feed_rows),
            "salary_adjustments_special_cases_source": special_cases_source,
            "salary_adjustments_special_cases_count": len(special_cases),
        },
        "seasons": manifest_seasons,
    }
    write_json(out_dir / "salary_adjustments_manifest.json", manifest)
    print(f"Wrote salary adjustments report artifacts to {out_dir} for {len(seasons)} season(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
