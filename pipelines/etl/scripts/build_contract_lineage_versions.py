#!/usr/bin/env python3
"""Build canonical contract-lineage versions, evidence, and anomaly tables."""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from db_utils import DEFAULT_DB_PATH, get_conn
from extension_lineage import load_extension_lookup, resolve_extension_lineage


ROOT_DIR = Path(__file__).resolve().parents[2]
DEFAULT_OUT_DIR = ROOT_DIR / "reports"
DEFAULT_VERSIONS_TABLE = "contract_lineage_versions"
DEFAULT_EVIDENCE_TABLE = "contract_lineage_evidence"
DEFAULT_ANOMALIES_TABLE = "contract_lineage_anomalies"


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def write_csv(path: Path, rows: List[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def upsert_rows(
    conn: sqlite3.Connection,
    table_name: str,
    rows: List[Dict[str, Any]],
    pk_cols: Iterable[str],
) -> int:
    if not rows:
        return 0
    pk_cols = list(pk_cols)
    cols = list(rows[0].keys())
    placeholders = ", ".join(f":{col}" for col in cols)
    update_cols = [col for col in cols if col not in set(pk_cols)]
    sql = f"""
        INSERT INTO {table_name} ({", ".join(cols)})
        VALUES ({placeholders})
        ON CONFLICT({", ".join(pk_cols)}) DO UPDATE SET
        {", ".join(f"{col}=excluded.{col}" for col in update_cols)}
    """
    conn.executemany(sql, rows)
    return len(rows)


def ensure_versions_table(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
          position_filter TEXT NOT NULL,
          player_id TEXT NOT NULL,
          version_seq INTEGER NOT NULL,
          player_name TEXT,
          start_season INTEGER,
          end_season INTEGER,
          season_count INTEGER,
          owner_franchise_id TEXT,
          owner_team_name TEXT,
          contract_status TEXT,
          contract_info TEXT,
          contract_length INTEGER,
          salary INTEGER,
          tcv INTEGER,
          aav INTEGER,
          year_values_json TEXT,
          contract_year_index_start INTEGER,
          contract_year_index_end INTEGER,
          extension_tokens_json TEXT,
          has_extension_history INTEGER,
          last_extension_franchise_id TEXT,
          last_extension_team_name TEXT,
          source_confidence TEXT,
          source_priority INTEGER,
          opened_by_event TEXT,
          closed_by_event TEXT,
          source_seasons_json TEXT,
          review_status TEXT,
          generated_at_utc TEXT,
          PRIMARY KEY (position_filter, player_id, version_seq)
        )
        """
    )


def ensure_evidence_table(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
          evidence_key TEXT PRIMARY KEY,
          position_filter TEXT,
          player_id TEXT,
          player_name TEXT,
          season INTEGER,
          evidence_type TEXT,
          franchise_id TEXT,
          team_name TEXT,
          event_datetime_et TEXT,
          salary INTEGER,
          contract_status TEXT,
          contract_info TEXT,
          source_table TEXT,
          source_key TEXT,
          raw_payload_ref TEXT,
          generated_at_utc TEXT
        )
        """
    )


def ensure_anomalies_table(conn: sqlite3.Connection, table_name: str) -> None:
    conn.execute(
        f"""
        CREATE TABLE IF NOT EXISTS {table_name} (
          anomaly_key TEXT PRIMARY KEY,
          position_filter TEXT,
          player_id TEXT,
          player_name TEXT,
          season INTEGER,
          franchise_id TEXT,
          anomaly_type TEXT,
          severity INTEGER,
          summary TEXT,
          expected_value TEXT,
          observed_value TEXT,
          supporting_source_keys TEXT,
          resolution_status TEXT,
          resolution_note TEXT,
          generated_at_utc TEXT
        )
        """
    )


def fetch_rows(
    conn: sqlite3.Connection,
    table_name: str,
    position: str,
    start_season: int,
    end_season: int,
) -> List[sqlite3.Row]:
    return list(
        conn.execute(
            f"""
            SELECT *
            FROM {table_name}
            WHERE position_filter = ?
              AND season BETWEEN ? AND ?
            ORDER BY player_id, season
            """,
            (position, start_season, end_season),
        ).fetchall()
    )


def has_active_contract(row: sqlite3.Row) -> bool:
    return (
        safe_int(row["salary"], 0) > 0
        or safe_int(row["contract_length"], 0) > 0
        or bool(safe_str(row["contract_status"]))
    )


def build_owner_index(owner_rows: List[sqlite3.Row]) -> Dict[tuple[int, str], List[sqlite3.Row]]:
    index: Dict[tuple[int, str], List[sqlite3.Row]] = defaultdict(list)
    for row in owner_rows:
        key = (safe_int(row["season"], 0), safe_str(row["player_id"]))
        index[key].append(row)
    for rows in index.values():
        rows.sort(
            key=lambda row: (
                safe_str(row["stint_start_date"]),
                safe_int(row["lineage_seq"], 0),
            )
        )
    return index


def pick_owner(snapshot_row: sqlite3.Row, owner_rows: List[sqlite3.Row]) -> tuple[str, str]:
    franchise_id = safe_str(snapshot_row["franchise_id"])
    team_name = safe_str(snapshot_row["team_name"])
    if franchise_id or team_name:
        return franchise_id, team_name
    for owner_row in owner_rows:
        if safe_str(owner_row["week1_owner_franchise_id"]) or safe_str(owner_row["week1_owner_team_name"]):
            return (
                safe_str(owner_row["week1_owner_franchise_id"]),
                safe_str(owner_row["week1_owner_team_name"]),
            )
    if owner_rows:
        return (
            safe_str(owner_rows[-1]["owner_franchise_id"]),
            safe_str(owner_rows[-1]["owner_team_name"]),
        )
    return "", ""


def build_state_rows(
    conn: sqlite3.Connection,
    snapshots: List[sqlite3.Row],
    owner_index: Dict[tuple[int, str], List[sqlite3.Row]],
    position: str,
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    states: List[Dict[str, Any]] = []
    anomalies: List[Dict[str, Any]] = []
    extension_cache: Dict[int, Dict[str, Dict[str, str]]] = {}
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    for row in snapshots:
        if not has_active_contract(row):
            continue

        season = safe_int(row["season"], 0)
        player_id = safe_str(row["player_id"])
        owner_rows = owner_index.get((season, player_id), [])
        owner_franchise_id, owner_team_name = pick_owner(row, owner_rows)
        if season not in extension_cache:
            extension_cache[season] = load_extension_lookup(conn, season)
        ext_lineage = resolve_extension_lineage(
            row["contract_info"],
            owner_franchise_id,
            extension_cache[season],
        )
        unresolved_tokens = [
            item["raw_token"]
            for item in ext_lineage.get("extension_history", [])
            if safe_str(item.get("raw_token")) and not safe_str(item.get("franchise_id"))
        ]

        state = {
            "position_filter": position,
            "player_id": player_id,
            "player_name": safe_str(row["player_name"]),
            "season": season,
            "owner_franchise_id": owner_franchise_id,
            "owner_team_name": owner_team_name,
            "salary": safe_int(row["salary"], 0),
            "contract_status": safe_str(row["contract_status"]),
            "contract_info": safe_str(row["contract_info"]),
            "contract_length": safe_int(row["contract_length"], 0),
            "contract_year_index": safe_int(row["contract_year_index"], safe_int(row["contract_year"], 0)),
            "tcv": safe_int(row["tcv"], 0),
            "aav": safe_int(row["aav"], 0),
            "year_values_json": safe_str(row["year_values_json"]) or "{}",
            "opened_by_event": safe_str(row["current_transaction_source"]) or safe_str(row["change_category"]),
            "source_season_detail": safe_str(row["source_detail"]),
            "source_confidence": "high" if owner_franchise_id else "medium",
            "source_priority": 80 if owner_franchise_id else 60,
            "manual_review_flag": safe_int(row["manual_review_flag"], 0),
            "extension_tokens_json": json.dumps(ext_lineage.get("extension_tokens", []), separators=(",", ":")),
            "has_extension_history": safe_int(ext_lineage.get("has_extension_history"), 0),
            "last_extension_franchise_id": safe_str(ext_lineage.get("last_extension_franchise_id")),
            "last_extension_team_name": safe_str(ext_lineage.get("last_extension_team_name")),
            "extension_flag": safe_int(row["extension_flag"], 0),
            "restructure_flag": safe_int(row["restructure_flag"], 0),
            "generated_at_utc": generated_at,
        }
        states.append(state)

        if not owner_franchise_id:
            anomalies.append(
                {
                    "anomaly_key": f"missing_owner:{position}:{player_id}:{season}",
                    "position_filter": position,
                    "player_id": player_id,
                    "player_name": safe_str(row["player_name"]),
                    "season": season,
                    "franchise_id": "",
                    "anomaly_type": "missing_owner",
                    "severity": 2,
                    "summary": "Active contract snapshot has no resolved owner.",
                    "expected_value": "owner_franchise_id",
                    "observed_value": "(blank)",
                    "supporting_source_keys": json.dumps([f"contract_history_snapshots:{season}:{player_id}"]),
                    "resolution_status": "open",
                    "resolution_note": "",
                    "generated_at_utc": generated_at,
                }
            )

        if safe_int(row["manual_review_flag"], 0) == 1:
            anomalies.append(
                {
                    "anomaly_key": f"manual_review:{position}:{player_id}:{season}",
                    "position_filter": position,
                    "player_id": player_id,
                    "player_name": safe_str(row["player_name"]),
                    "season": season,
                    "franchise_id": owner_franchise_id,
                    "anomaly_type": "manual_review_flag",
                    "severity": 2,
                    "summary": safe_str(row["manual_review_reason"]) or "Contract-history snapshot is flagged for manual review.",
                    "expected_value": "",
                    "observed_value": safe_str(row["source_detail"]),
                    "supporting_source_keys": json.dumps([f"contract_history_snapshots:{season}:{player_id}"]),
                    "resolution_status": "open",
                    "resolution_note": "",
                    "generated_at_utc": generated_at,
                }
            )

        for token in unresolved_tokens:
            anomalies.append(
                {
                    "anomaly_key": f"unresolved_ext:{position}:{player_id}:{season}:{token}",
                    "position_filter": position,
                    "player_id": player_id,
                    "player_name": safe_str(row["player_name"]),
                    "season": season,
                    "franchise_id": owner_franchise_id,
                    "anomaly_type": "unresolved_extension_token",
                    "severity": 1,
                    "summary": f"Extension token '{token}' could not be mapped to a franchise.",
                    "expected_value": "mapped franchise_id",
                    "observed_value": token,
                    "supporting_source_keys": json.dumps([f"contract_history_snapshots:{season}:{player_id}"]),
                    "resolution_status": "open",
                    "resolution_note": "",
                    "generated_at_utc": generated_at,
                }
            )
    return states, anomalies


def build_evidence_rows(
    snapshots: List[sqlite3.Row],
    owner_rows: List[sqlite3.Row],
    txn_rows: List[sqlite3.Row],
    position: str,
) -> List[Dict[str, Any]]:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    rows: List[Dict[str, Any]] = []

    for row in snapshots:
        if not (has_active_contract(row) or safe_int(row["prior_was_contract_status"], 0) == 1):
            continue
        season = safe_int(row["season"], 0)
        player_id = safe_str(row["player_id"])
        rows.append(
            {
                "evidence_key": f"snapshot:{position}:{player_id}:{season}",
                "position_filter": position,
                "player_id": player_id,
                "player_name": safe_str(row["player_name"]),
                "season": season,
                "evidence_type": "season_snapshot",
                "franchise_id": safe_str(row["franchise_id"]),
                "team_name": safe_str(row["team_name"]),
                "event_datetime_et": safe_str(row["current_transaction_date"]) or safe_str(row["season_kickoff_date"]),
                "salary": safe_int(row["salary"], 0),
                "contract_status": safe_str(row["contract_status"]),
                "contract_info": safe_str(row["contract_info"]),
                "source_table": "contract_history_snapshots",
                "source_key": f"{season}:{player_id}",
                "raw_payload_ref": safe_str(row["source_detail"]),
                "generated_at_utc": generated_at,
            }
        )

    for row in owner_rows:
        season = safe_int(row["season"], 0)
        player_id = safe_str(row["player_id"])
        lineage_seq = safe_int(row["lineage_seq"], 0)
        rows.append(
            {
                "evidence_key": f"owner:{position}:{player_id}:{season}:{lineage_seq}",
                "position_filter": position,
                "player_id": player_id,
                "player_name": safe_str(row["player_name"]),
                "season": season,
                "evidence_type": "owner_lineage",
                "franchise_id": safe_str(row["owner_franchise_id"]),
                "team_name": safe_str(row["owner_team_name"]),
                "event_datetime_et": safe_str(row["stint_start_date"]),
                "salary": 0,
                "contract_status": "",
                "contract_info": safe_str(row["week1_contract_info"]) or safe_str(row["prior_contract_info"]),
                "source_table": "contract_history_owner_lineage",
                "source_key": f"{season}:{player_id}:{lineage_seq}",
                "raw_payload_ref": safe_str(row["acquire_source"]),
                "generated_at_utc": generated_at,
            }
        )

    for row in txn_rows:
        salary = safe_int(row["salary"], 0)
        prior_salary = safe_int(row["prior_salary"], 0)
        if not (
            salary > 0
            or prior_salary > 0
            or safe_str(row["contract_status"])
            or safe_str(row["prior_contract_status"])
            or safe_str(row["contract_info"])
            or safe_str(row["prior_contract_info"])
        ):
            continue
        season = safe_int(row["season"], 0)
        player_id = safe_str(row["player_id"])
        event_seq = safe_int(row["event_seq"], 0)
        rows.append(
            {
                "evidence_key": f"txn:{position}:{player_id}:{season}:{event_seq}",
                "position_filter": position,
                "player_id": player_id,
                "player_name": safe_str(row["player_name"]),
                "season": season,
                "evidence_type": "transaction_snapshot",
                "franchise_id": safe_str(row["franchise_id"]),
                "team_name": safe_str(row["team_name"]),
                "event_datetime_et": (
                    f"{safe_str(row['event_date'])} {safe_str(row['event_time'])}".strip()
                ),
                "salary": salary,
                "contract_status": safe_str(row["contract_status"]),
                "contract_info": safe_str(row["contract_info"]),
                "source_table": "contract_history_transaction_snapshots",
                "source_key": f"{season}:{player_id}:{event_seq}",
                "raw_payload_ref": safe_str(row["event_source"]) or safe_str(row["event_detail"]),
                "generated_at_utc": generated_at,
            }
        )

    rows.sort(
        key=lambda row: (
            safe_str(row["player_name"]).lower(),
            safe_int(row["season"], 0),
            safe_str(row["event_datetime_et"]),
            safe_str(row["evidence_type"]),
            safe_str(row["evidence_key"]),
        )
    )
    return rows


def build_versions_and_yoy(
    states: List[Dict[str, Any]],
    position: str,
) -> tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]]]:
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    grouped: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for state in states:
        grouped[safe_str(state["player_id"])].append(state)
    for rows in grouped.values():
        rows.sort(key=lambda row: safe_int(row["season"], 0))

    versions: List[Dict[str, Any]] = []
    anomalies: List[Dict[str, Any]] = []
    yoy_rows: List[Dict[str, Any]] = []

    for player_id, player_states in grouped.items():
        version_seq = 0
        active_version: Dict[str, Any] | None = None
        prior_state: Dict[str, Any] | None = None
        for state in player_states:
            season = safe_int(state["season"], 0)
            same_owner = bool(prior_state) and safe_str(prior_state["owner_franchise_id"]) == safe_str(state["owner_franchise_id"])
            if prior_state:
                prior_salary = safe_int(prior_state["salary"], 0)
                current_salary = safe_int(state["salary"], 0)
                delta = current_salary - prior_salary
                delta_pct = 0.0
                if prior_salary > 0:
                    delta_pct = round((delta / prior_salary) * 100.0, 2)
                yoy_signal = {
                    "position_filter": position,
                    "player_id": player_id,
                    "player_name": safe_str(state["player_name"]),
                    "prior_season": safe_int(prior_state["season"], 0),
                    "season": season,
                    "owner_franchise_id": safe_str(state["owner_franchise_id"]),
                    "owner_team_name": safe_str(state["owner_team_name"]),
                    "same_owner": 1 if same_owner else 0,
                    "prior_salary": prior_salary,
                    "salary": current_salary,
                    "salary_delta": delta,
                    "salary_delta_pct": delta_pct,
                    "prior_contract_status": safe_str(prior_state["contract_status"]),
                    "contract_status": safe_str(state["contract_status"]),
                    "prior_contract_length": safe_int(prior_state["contract_length"], 0),
                    "contract_length": safe_int(state["contract_length"], 0),
                    "prior_tcv": safe_int(prior_state["tcv"], 0),
                    "tcv": safe_int(state["tcv"], 0),
                    "extension_flag": safe_int(state["extension_flag"], 0),
                    "restructure_flag": safe_int(state["restructure_flag"], 0),
                    "possible_anomaly": 0,
                    "note": "",
                }
                if same_owner and abs(delta) >= 10000 and not state["extension_flag"] and not state["restructure_flag"]:
                    yoy_signal["possible_anomaly"] = 1
                    yoy_signal["note"] = "Large same-owner year-over-year salary change without extension/restructure flag."
                    anomalies.append(
                        {
                            "anomaly_key": f"salary_yoy:{position}:{player_id}:{season}",
                            "position_filter": position,
                            "player_id": player_id,
                            "player_name": safe_str(state["player_name"]),
                            "season": season,
                            "franchise_id": safe_str(state["owner_franchise_id"]),
                            "anomaly_type": "salary_yoy_jump",
                            "severity": 1,
                            "summary": yoy_signal["note"],
                            "expected_value": str(prior_salary),
                            "observed_value": str(current_salary),
                            "supporting_source_keys": json.dumps(
                                [
                                    f"contract_history_snapshots:{safe_int(prior_state['season'], 0)}:{player_id}",
                                    f"contract_history_snapshots:{season}:{player_id}",
                                ]
                            ),
                            "resolution_status": "open",
                            "resolution_note": "",
                            "generated_at_utc": generated_at,
                        }
                    )
                yoy_rows.append(yoy_signal)

            boundary = True
            if active_version is not None:
                boundary = any(
                    [
                        season != safe_int(active_version["end_season"], 0) + 1,
                        safe_str(active_version["owner_franchise_id"]) != safe_str(state["owner_franchise_id"]),
                        safe_int(active_version["salary"], 0) != safe_int(state["salary"], 0),
                        safe_str(active_version["contract_status"]) != safe_str(state["contract_status"]),
                        safe_int(active_version["contract_length"], 0) != safe_int(state["contract_length"], 0),
                        safe_int(active_version["tcv"], 0) != safe_int(state["tcv"], 0),
                        safe_str(active_version["year_values_json"]) != safe_str(state["year_values_json"]),
                        safe_str(active_version["extension_tokens_json"]) != safe_str(state["extension_tokens_json"]),
                    ]
                )

            if boundary:
                if active_version is not None:
                    active_version["closed_by_event"] = safe_str(state["opened_by_event"]) or f"season_{season}_boundary"
                    versions.append(active_version)
                version_seq += 1
                active_version = {
                    "position_filter": position,
                    "player_id": player_id,
                    "version_seq": version_seq,
                    "player_name": safe_str(state["player_name"]),
                    "start_season": season,
                    "end_season": season,
                    "season_count": 1,
                    "owner_franchise_id": safe_str(state["owner_franchise_id"]),
                    "owner_team_name": safe_str(state["owner_team_name"]),
                    "contract_status": safe_str(state["contract_status"]),
                    "contract_info": safe_str(state["contract_info"]),
                    "contract_length": safe_int(state["contract_length"], 0),
                    "salary": safe_int(state["salary"], 0),
                    "tcv": safe_int(state["tcv"], 0),
                    "aav": safe_int(state["aav"], 0),
                    "year_values_json": safe_str(state["year_values_json"]),
                    "contract_year_index_start": safe_int(state["contract_year_index"], 0),
                    "contract_year_index_end": safe_int(state["contract_year_index"], 0),
                    "extension_tokens_json": safe_str(state["extension_tokens_json"]),
                    "has_extension_history": safe_int(state["has_extension_history"], 0),
                    "last_extension_franchise_id": safe_str(state["last_extension_franchise_id"]),
                    "last_extension_team_name": safe_str(state["last_extension_team_name"]),
                    "source_confidence": safe_str(state["source_confidence"]),
                    "source_priority": safe_int(state["source_priority"], 0),
                    "opened_by_event": safe_str(state["opened_by_event"]),
                    "closed_by_event": "",
                    "source_seasons_json": json.dumps([season]),
                    "review_status": "needs_review" if safe_int(state["manual_review_flag"], 0) == 1 else "ok",
                    "generated_at_utc": generated_at,
                }
            else:
                assert active_version is not None
                active_version["end_season"] = season
                active_version["season_count"] = safe_int(active_version["season_count"], 0) + 1
                active_version["contract_year_index_end"] = safe_int(state["contract_year_index"], 0)
                seasons_used = json.loads(active_version["source_seasons_json"])
                seasons_used.append(season)
                active_version["source_seasons_json"] = json.dumps(seasons_used)
                if safe_int(state["manual_review_flag"], 0) == 1:
                    active_version["review_status"] = "needs_review"

            prior_state = state

        if active_version is not None:
            versions.append(active_version)

    versions.sort(
        key=lambda row: (
            safe_str(row["player_name"]).lower(),
            safe_int(row["start_season"], 0),
            safe_int(row["version_seq"], 0),
        )
    )
    yoy_rows.sort(
        key=lambda row: (
            safe_str(row["player_name"]).lower(),
            safe_int(row["season"], 0),
            safe_int(row["prior_season"], 0),
        )
    )
    return versions, anomalies, yoy_rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--position", default="QB")
    parser.add_argument("--start-season", type=int, default=2011)
    parser.add_argument("--end-season", type=int, default=0)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--versions-table", default=DEFAULT_VERSIONS_TABLE)
    parser.add_argument("--evidence-table", default=DEFAULT_EVIDENCE_TABLE)
    parser.add_argument("--anomalies-table", default=DEFAULT_ANOMALIES_TABLE)
    parser.add_argument("--write-table", type=int, default=1)
    args = parser.parse_args()

    out_dir = Path(args.out_dir).expanduser()
    out_dir.mkdir(parents=True, exist_ok=True)
    position = safe_str(args.position).upper() or "QB"

    conn = get_conn(args.db_path)
    conn.row_factory = sqlite3.Row
    try:
        if args.end_season > 0:
            end_season = args.end_season
        else:
            row = conn.execute(
                "SELECT MAX(season) FROM contract_history_snapshots WHERE position_filter = ?",
                (position,),
            ).fetchone()
            end_season = safe_int(row[0] if row else 0, 0)
        if end_season <= 0:
            raise SystemExit("No contract_history_snapshots seasons available for lineage build.")

        snapshots = fetch_rows(conn, "contract_history_snapshots", position, args.start_season, end_season)
        owner_rows = fetch_rows(conn, "contract_history_owner_lineage", position, args.start_season, end_season)
        txn_rows = fetch_rows(conn, "contract_history_transaction_snapshots", position, args.start_season, end_season)
        owner_index = build_owner_index(owner_rows)
        states, state_anomalies = build_state_rows(conn, snapshots, owner_index, position)
        evidence_rows = build_evidence_rows(snapshots, owner_rows, txn_rows, position)
        versions, version_anomalies, yoy_rows = build_versions_and_yoy(states, position)

        anomalies_map: Dict[str, Dict[str, Any]] = {}
        for row in state_anomalies + version_anomalies:
            anomalies_map[row["anomaly_key"]] = row
        anomalies = sorted(
            anomalies_map.values(),
            key=lambda row: (
                safe_str(row["player_name"]).lower(),
                safe_int(row["season"], 0),
                safe_str(row["anomaly_type"]),
                safe_str(row["anomaly_key"]),
            ),
        )

        versions_csv = out_dir / f"contract_lineage_{position.lower()}_versions.csv"
        evidence_csv = out_dir / f"contract_lineage_{position.lower()}_evidence.csv"
        anomalies_csv = out_dir / f"contract_lineage_{position.lower()}_anomalies.csv"
        yoy_csv = out_dir / f"contract_lineage_{position.lower()}_salary_yoy_signals.csv"

        write_csv(versions_csv, versions)
        write_csv(evidence_csv, evidence_rows)
        write_csv(anomalies_csv, anomalies)
        write_csv(yoy_csv, yoy_rows)

        if args.write_table == 1:
            ensure_versions_table(conn, args.versions_table)
            ensure_evidence_table(conn, args.evidence_table)
            ensure_anomalies_table(conn, args.anomalies_table)
            wrote_versions = upsert_rows(conn, args.versions_table, versions, ["position_filter", "player_id", "version_seq"])
            wrote_evidence = upsert_rows(conn, args.evidence_table, evidence_rows, ["evidence_key"])
            wrote_anomalies = upsert_rows(conn, args.anomalies_table, anomalies, ["anomaly_key"])
            conn.commit()
        else:
            wrote_versions = wrote_evidence = wrote_anomalies = 0
    finally:
        conn.close()

    print(f"Position: {position}")
    print(f"Seasons: {args.start_season}-{end_season}")
    print(f"Versions: {len(versions)}")
    print(f"Evidence rows: {len(evidence_rows)}")
    print(f"Anomalies: {len(anomalies)}")
    print(f"Wrote CSV: {versions_csv}")
    print(f"Wrote CSV: {evidence_csv}")
    print(f"Wrote CSV: {anomalies_csv}")
    print(f"Wrote CSV: {yoy_csv}")
    if args.write_table == 1:
        print(f"Upserted rows in table {args.versions_table}: {wrote_versions}")
        print(f"Upserted rows in table {args.evidence_table}: {wrote_evidence}")
        print(f"Upserted rows in table {args.anomalies_table}: {wrote_anomalies}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
