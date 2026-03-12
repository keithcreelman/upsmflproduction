#!/usr/bin/env python3
"""
Sync canonical contract activity JSON logs into SQLite contract_submissions.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_JSON_PATH = ROOT_DIR / "site" / "rosters" / "contract_submissions" / "contract_activity_2026.json"


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def load_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
      return [row for row in raw if isinstance(row, dict)]
    if isinstance(raw, dict):
      rows = raw.get("activities") or raw.get("submissions") or raw.get("rows") or []
      return [row for row in rows if isinstance(row, dict)]
    return []


def ensure_columns(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS contract_submissions (
            submission_uid TEXT PRIMARY KEY,
            submission_type TEXT NOT NULL,
            source TEXT,
            source_group_id TEXT,
            source_ref TEXT,
            season INTEGER,
            league_id TEXT,
            franchise_id TEXT,
            franchise_name TEXT,
            player_id TEXT,
            player_name TEXT,
            position TEXT,
            submitted_at_utc TEXT,
            raw_text TEXT,
            match_status TEXT,
            match_confidence REAL,
            match_notes TEXT,
            detail_table TEXT,
            detail_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
        """
    )
    wanted = {
        "activity_scope": "ALTER TABLE contract_submissions ADD COLUMN activity_scope TEXT",
        "activity_type": "ALTER TABLE contract_submissions ADD COLUMN activity_type TEXT",
        "test_flag": "ALTER TABLE contract_submissions ADD COLUMN test_flag INTEGER DEFAULT 0",
        "commish_override_flag": "ALTER TABLE contract_submissions ADD COLUMN commish_override_flag INTEGER DEFAULT 0",
        "override_as_of_date": "ALTER TABLE contract_submissions ADD COLUMN override_as_of_date TEXT",
        "salary": "ALTER TABLE contract_submissions ADD COLUMN salary INTEGER",
        "contract_year": "ALTER TABLE contract_submissions ADD COLUMN contract_year INTEGER",
        "contract_status": "ALTER TABLE contract_submissions ADD COLUMN contract_status TEXT",
        "contract_info": "ALTER TABLE contract_submissions ADD COLUMN contract_info TEXT",
        "tcv": "ALTER TABLE contract_submissions ADD COLUMN tcv INTEGER",
        "aav": "ALTER TABLE contract_submissions ADD COLUMN aav INTEGER",
        "guaranteed": "ALTER TABLE contract_submissions ADD COLUMN guaranteed INTEGER",
        "delivery_target": "ALTER TABLE contract_submissions ADD COLUMN delivery_target TEXT",
        "discord_channel_id": "ALTER TABLE contract_submissions ADD COLUMN discord_channel_id TEXT",
        "discord_message_id": "ALTER TABLE contract_submissions ADD COLUMN discord_message_id TEXT",
        "discord_pinned_flag": "ALTER TABLE contract_submissions ADD COLUMN discord_pinned_flag INTEGER DEFAULT 0",
    }
    cols = {row[1] for row in conn.execute("PRAGMA table_info(contract_submissions)").fetchall()}
    for col, ddl in wanted.items():
        if col not in cols:
            conn.execute(ddl)


def normalize_submission_type(activity_type: str) -> str:
    raw = safe_str(activity_type).upper().replace(" ", "_")
    return raw or "CONTRACT_ACTIVITY"


def build_raw_text(row: Dict[str, Any]) -> str:
    parts = [
        safe_str(row.get("activity_type")) or "Contract Activity",
        f"{safe_int(row.get('contract_year'), 0)} Year" if safe_int(row.get("contract_year"), 0) == 1 else f"{safe_int(row.get('contract_year'), 0)} Years",
        f"status={safe_str(row.get('contract_status'))}",
        f"salary={safe_int(row.get('salary'), 0)}",
    ]
    info = safe_str(row.get("contract_info"))
    if info:
        parts.append(f"info={info}")
    return " | ".join([part for part in parts if safe_str(part)])


def upsert_row(conn, row: Dict[str, Any], detail_table: str) -> None:
    submission_uid = safe_str(row.get("activity_id"))
    payload = (
        submission_uid,
        normalize_submission_type(row.get("activity_type")),
        safe_str(row.get("source")),
        safe_str(row.get("activity_scope")),
        safe_str(row.get("submission_id")) or submission_uid,
        safe_int(row.get("season"), 0),
        safe_str(row.get("league_id")),
        safe_str(row.get("franchise_id")).zfill(4)[-4:],
        safe_str(row.get("franchise_name")),
        safe_str(row.get("player_id")),
        safe_str(row.get("player_name")),
        safe_str(row.get("position")),
        safe_str(row.get("submitted_at_utc")),
        build_raw_text(row),
        "worker_logged",
        1.0,
        safe_str(row.get("notes")),
        detail_table,
        submission_uid,
        safe_str(row.get("activity_scope")),
        safe_str(row.get("activity_type")),
        1 if safe_int(row.get("test_flag"), 0) else 0,
        1 if safe_int(row.get("commish_override_flag"), 0) else 0,
        safe_str(row.get("override_as_of_date")),
        safe_int(row.get("salary"), 0),
        safe_int(row.get("contract_year"), 0),
        safe_str(row.get("contract_status")),
        safe_str(row.get("contract_info")),
        safe_int(row.get("tcv"), 0),
        safe_int(row.get("aav"), 0),
        safe_int(row.get("guaranteed"), 0),
        safe_str(row.get("delivery_target")),
        safe_str(row.get("discord_channel_id")),
        safe_str(row.get("discord_message_id")),
        1 if safe_int(row.get("discord_pinned_flag"), 0) else 0,
    )
    conn.execute(
        """
        INSERT INTO contract_submissions (
            submission_uid, submission_type, source, source_group_id, source_ref,
            season, league_id, franchise_id, franchise_name, player_id, player_name,
            position, submitted_at_utc, raw_text, match_status, match_confidence,
            match_notes, detail_table, detail_id, activity_scope, activity_type,
            test_flag, commish_override_flag, override_as_of_date, salary, contract_year,
            contract_status, contract_info, tcv, aav, guaranteed, delivery_target,
            discord_channel_id, discord_message_id, discord_pinned_flag
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(submission_uid) DO UPDATE SET
            submission_type=excluded.submission_type,
            source=excluded.source,
            source_group_id=excluded.source_group_id,
            source_ref=excluded.source_ref,
            season=excluded.season,
            league_id=excluded.league_id,
            franchise_id=excluded.franchise_id,
            franchise_name=excluded.franchise_name,
            player_id=excluded.player_id,
            player_name=excluded.player_name,
            position=excluded.position,
            submitted_at_utc=excluded.submitted_at_utc,
            raw_text=excluded.raw_text,
            match_status=excluded.match_status,
            match_confidence=excluded.match_confidence,
            match_notes=excluded.match_notes,
            detail_table=excluded.detail_table,
            detail_id=excluded.detail_id,
            activity_scope=excluded.activity_scope,
            activity_type=excluded.activity_type,
            test_flag=excluded.test_flag,
            commish_override_flag=excluded.commish_override_flag,
            override_as_of_date=excluded.override_as_of_date,
            salary=excluded.salary,
            contract_year=excluded.contract_year,
            contract_status=excluded.contract_status,
            contract_info=excluded.contract_info,
            tcv=excluded.tcv,
            aav=excluded.aav,
            guaranteed=excluded.guaranteed,
            delivery_target=excluded.delivery_target,
            discord_channel_id=excluded.discord_channel_id,
            discord_message_id=excluded.discord_message_id,
            discord_pinned_flag=excluded.discord_pinned_flag
        """,
        payload,
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--json-path", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    json_paths = [Path(path) for path in args.json_path] if args.json_path else [DEFAULT_JSON_PATH]
    conn = get_conn(args.db_path)
    ensure_columns(conn)
    inserted = 0
    for path in json_paths:
        rows = load_rows(path)
        for row in rows:
            activity_id = safe_str(row.get("activity_id"))
            season = safe_int(row.get("season"), 0)
            if not activity_id or season <= 0:
                continue
            upsert_row(conn, row, str(path.relative_to(ROOT_DIR)))
            inserted += 1
    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM contract_submissions").fetchone()[0]
    print(f"upserted={inserted} total_contract_submissions={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
