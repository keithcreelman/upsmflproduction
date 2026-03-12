#!/usr/bin/env python3
"""Sync worker-driven contract submission logs into SQLite contract_submissions."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, List

from db_utils import DEFAULT_DB_PATH, get_conn


ROOT_DIR = Path(__file__).resolve().parents[3]
SUBMISSIONS_DIR = ROOT_DIR / "site" / "rosters" / "contract_submissions"
LEGACY_SUBMISSIONS_DIR = ROOT_DIR / "site" / "ccc"
DEFAULT_MYM_JSON_PATH = SUBMISSIONS_DIR / "mym_submissions.json"
DEFAULT_RESTRUCTURE_JSON_PATH = SUBMISSIONS_DIR / "restructure_submissions.json"
DEFAULT_EXTENSION_JSON_PATH = SUBMISSIONS_DIR / "extension_submissions.json"
DEFAULT_MANUAL_JSON_PATH = SUBMISSIONS_DIR / "manual_contract_submissions.json"
LEGACY_MYM_JSON_PATH = LEGACY_SUBMISSIONS_DIR / "mym_submissions.json"
LEGACY_RESTRUCTURE_JSON_PATH = LEGACY_SUBMISSIONS_DIR / "restructure_submissions.json"
LEGACY_EXTENSION_JSON_PATH = LEGACY_SUBMISSIONS_DIR / "extension_submissions.json"


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def pad4(value: Any) -> str:
    digits = "".join(ch for ch in safe_str(value) if ch.isdigit())
    return digits.zfill(4)[-4:] if digits else ""


def normalize_position(value: Any) -> str:
    raw = safe_str(value).upper()
    if raw in {"K", "PK", "P", "PN"}:
        return "PK"
    return raw


def build_fallback_submission_uid(
    submission_type: str,
    detail_table: str,
    row: Dict[str, Any],
) -> str:
    seed = "|".join(
        [
            submission_type,
            detail_table,
            safe_str(row.get("league_id") or row.get("leagueId")),
            safe_str(row.get("season") or row.get("year")),
            pad4(row.get("franchise_id") or row.get("franchiseId")),
            safe_str(row.get("player_id") or row.get("playerId")),
            safe_str(row.get("contract_year") or row.get("contractYear")),
            safe_str(row.get("contract_status") or row.get("contractStatus")),
            safe_str(row.get("submitted_at_utc") or row.get("submitted_at") or row.get("submittedAt")),
            safe_str(row.get("contract_info") or row.get("contractInfo")),
        ]
    )
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()[:24]


def load_submission_rows(path: Path) -> List[Dict[str, Any]]:
    if not path.exists():
        return []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return [row for row in raw if isinstance(row, dict)]
    if isinstance(raw, dict):
        rows = raw.get("submissions") or raw.get("rows") or []
        return [row for row in rows if isinstance(row, dict)]
    return []


def ensure_table(conn) -> None:
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
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contract_submissions_season ON contract_submissions(season)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contract_submissions_type ON contract_submissions(submission_type)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contract_submissions_player ON contract_submissions(player_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_contract_submissions_franchise ON contract_submissions(franchise_id)"
    )


def build_raw_text(submission_type: str, row: Dict[str, Any]) -> str:
    manual_kind = safe_str(row.get("submission_kind")).replace("_", "-").lower()
    years = max(0, safe_int(row.get("contract_year"), 0))
    label = {
        "MYM": "MYM",
        "RESTRUCTURE": "Restructure",
        "EXTENSION": "Extension",
        "ROOKIE_OPTION": "Rookie Option",
        "MANUAL_CONTRACT": "Manual Contract Update",
    }.get(submission_type, submission_type.title())
    if submission_type == "MANUAL_CONTRACT" and manual_kind:
        label = manual_kind.replace("-", " ").title()
    parts = []
    if years > 0:
        parts.append(f"{label} {years} years")
    else:
        parts.append(label)

    status = safe_str(row.get("contract_status"))
    if status:
        parts.append(f"status={status}")

    salary = safe_int(row.get("salary"), 0)
    if salary > 0:
        parts.append(f"salary={salary}")

    contract_info = safe_str(row.get("contract_info"))
    if contract_info:
        parts.append(f"info={contract_info}")

    return " | ".join(parts)


def detail_table_for_path(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(ROOT_DIR.resolve())).replace("\\", "/")
    except ValueError:
        return str(path)


def manual_submission_type(row: Dict[str, Any]) -> str:
    kind = safe_str(row.get("submission_kind")).replace("_", "-").lower()
    if kind == "rookie-option":
        return "ROOKIE_OPTION"
    return "MANUAL_CONTRACT"


def normalize_row(
    submission_type: str,
    detail_table: str,
    row: Dict[str, Any],
) -> Dict[str, Any] | None:
    submission_id = safe_str(row.get("submission_id"))
    season = safe_int(row.get("season") or row.get("year"), 0)
    player_id = safe_str(row.get("player_id"))
    if not season or not player_id:
        return None
    if not submission_id:
        submission_id = build_fallback_submission_uid(submission_type, detail_table, row)

    return {
        "submission_uid": submission_id,
        "submission_type": submission_type,
        "source": safe_str(row.get("source")) or {
            "MYM": "worker-offer-mym",
            "RESTRUCTURE": "worker-offer-restructure",
            "EXTENSION": "worker-offer-extension",
        }.get(submission_type, ""),
        "source_group_id": "",
        "source_ref": submission_id,
        "season": season,
        "league_id": safe_str(row.get("league_id")),
        "franchise_id": pad4(row.get("franchise_id")),
        "franchise_name": safe_str(row.get("franchise_name")),
        "player_id": player_id,
        "player_name": safe_str(row.get("player_name")),
        "position": normalize_position(row.get("position") or row.get("pos")),
        "submitted_at_utc": safe_str(row.get("submitted_at_utc") or row.get("submitted_at")),
        "raw_text": build_raw_text(submission_type, row),
        "match_status": "worker_logged",
        "match_confidence": 1.0,
        "match_notes": "",
        "detail_table": detail_table,
        "detail_id": submission_id,
    }


def iter_normalized_rows(
    sources: Iterable[tuple[str, str, Iterable[Dict[str, Any]]]],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen_ids = set()
    for submission_type, detail_table, rows in sources:
        for row in rows:
            effective_type = (
                manual_submission_type(row)
                if submission_type == "MANUAL_CONTRACT"
                else submission_type
            )
            norm = normalize_row(effective_type, detail_table, row)
            if not norm:
                continue
            submission_uid = safe_str(norm.get("submission_uid"))
            if submission_uid and submission_uid in seen_ids:
                continue
            if submission_uid:
                seen_ids.add(submission_uid)
            out.append(norm)
    return out


def load_rows_with_legacy_fallback(primary_path: Path, legacy_path: Path | None = None) -> List[tuple[str, List[Dict[str, Any]]]]:
    pairs: List[tuple[str, List[Dict[str, Any]]]] = []
    primary_rows = load_submission_rows(primary_path)
    if primary_rows:
        pairs.append((detail_table_for_path(primary_path), primary_rows))
    if legacy_path and legacy_path.resolve() != primary_path.resolve():
        legacy_rows = load_submission_rows(legacy_path)
        if legacy_rows:
            pairs.append((detail_table_for_path(legacy_path), legacy_rows))
    return pairs


def upsert_rows(conn, rows: Iterable[Dict[str, Any]]) -> tuple[int, int]:
    inserted = 0
    updated = 0
    sql = """
    INSERT INTO contract_submissions (
        submission_uid, submission_type, source, source_group_id, source_ref,
        season, league_id, franchise_id, franchise_name, player_id, player_name,
        position, submitted_at_utc, raw_text, match_status, match_confidence,
        match_notes, detail_table, detail_id
    ) VALUES (
        :submission_uid, :submission_type, :source, :source_group_id, :source_ref,
        :season, :league_id, :franchise_id, :franchise_name, :player_id, :player_name,
        :position, :submitted_at_utc, :raw_text, :match_status, :match_confidence,
        :match_notes, :detail_table, :detail_id
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
        detail_id=excluded.detail_id
    """
    for row in rows:
        existed = conn.execute(
            "SELECT 1 FROM contract_submissions WHERE submission_uid = ? LIMIT 1",
            (row["submission_uid"],),
        ).fetchone()
        conn.execute(sql, row)
        if existed:
            updated += 1
        else:
            inserted += 1
    return inserted, updated


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--mym-json-path", default=str(DEFAULT_MYM_JSON_PATH))
    parser.add_argument("--restructure-json-path", default=str(DEFAULT_RESTRUCTURE_JSON_PATH))
    parser.add_argument("--extension-json-path", default=str(DEFAULT_EXTENSION_JSON_PATH))
    parser.add_argument("--manual-json-path", default=str(DEFAULT_MANUAL_JSON_PATH))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    mym_sources = load_rows_with_legacy_fallback(Path(args.mym_json_path), LEGACY_MYM_JSON_PATH)
    restructure_sources = load_rows_with_legacy_fallback(
        Path(args.restructure_json_path), LEGACY_RESTRUCTURE_JSON_PATH
    )
    extension_sources = load_rows_with_legacy_fallback(
        Path(args.extension_json_path), LEGACY_EXTENSION_JSON_PATH
    )
    manual_sources = load_rows_with_legacy_fallback(Path(args.manual_json_path))
    rows = iter_normalized_rows(
        [
            *[("MYM", detail_table, source_rows) for detail_table, source_rows in mym_sources],
            *[
                ("RESTRUCTURE", detail_table, source_rows)
                for detail_table, source_rows in restructure_sources
            ],
            *[
                ("EXTENSION", detail_table, source_rows)
                for detail_table, source_rows in extension_sources
            ],
            *[
                ("MANUAL_CONTRACT", detail_table, source_rows)
                for detail_table, source_rows in manual_sources
            ],
        ]
    )

    conn = get_conn(args.db_path)
    try:
        ensure_table(conn)
        inserted, updated = upsert_rows(conn, rows)
        conn.commit()
        total = conn.execute("SELECT COUNT(*) FROM contract_submissions").fetchone()[0]
    finally:
        conn.close()

    print(f"rows_read={len(rows)} inserted={inserted} updated={updated} total={total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
