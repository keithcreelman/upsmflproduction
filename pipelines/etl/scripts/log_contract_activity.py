#!/usr/bin/env python3
"""
Append a contract activity record into a canonical season log JSON file.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or value == "":
            return default
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def parse_money_token(token: str) -> int:
    raw = safe_str(token).upper().replace(",", "")
    if not raw:
        return 0
    if raw.endswith("K"):
        try:
            return int(round(float(raw[:-1].strip()) * 1000))
        except ValueError:
            return 0
    try:
        return int(round(float(raw)))
    except ValueError:
        return 0


def parse_contract_info_values(contract_info: str) -> Dict[str, int]:
    text = safe_str(contract_info)
    out = {"tcv": 0, "aav": 0, "guaranteed": 0}
    if not text:
        return out
    m_tcv = re.search(r"(?:^|\|)\s*TCV\s*:?\s*([^|]+)", text, re.IGNORECASE)
    m_aav = re.search(r"(?:^|\|)\s*AAV\s*:?\s*([^|]+)", text, re.IGNORECASE)
    m_gtd = re.search(r"(?:^|\|)\s*GTD\s*:?\s*([^|]+)", text, re.IGNORECASE)
    if m_tcv:
        out["tcv"] = parse_money_token(m_tcv.group(1))
    if m_aav:
        out["aav"] = parse_money_token(m_aav.group(1))
    if m_gtd:
        out["guaranteed"] = parse_money_token(m_gtd.group(1))
    return out


def normalize_timestamp(raw_ts: str) -> str:
    ts = safe_str(raw_ts)
    if not ts:
        return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return ts


def parse_payload_defaults(raw_payload: str) -> Dict[str, Any]:
    raw = safe_str(raw_payload)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-path", default="contract_activity_2026.json")
    parser.add_argument("--payload-json", default=os.environ.get("PAYLOAD_JSON", ""))
    parser.add_argument("--activity-id", default=os.environ.get("ACTIVITY_ID", ""))
    parser.add_argument("--submission-id", default=os.environ.get("SUBMISSION_ID", ""))
    parser.add_argument("--activity-scope", default=os.environ.get("ACTIVITY_SCOPE", "contract_mutation"))
    parser.add_argument("--activity-type", default=os.environ.get("ACTIVITY_TYPE", ""))
    parser.add_argument("--season", default=os.environ.get("SEASON", ""))
    parser.add_argument("--year", default=os.environ.get("YEAR", ""))
    parser.add_argument("--league-id", default=os.environ.get("LEAGUE_ID", ""))
    parser.add_argument("--franchise-id", default=os.environ.get("FRANCHISE_ID", ""))
    parser.add_argument("--franchise-name", default=os.environ.get("FRANCHISE_NAME", ""))
    parser.add_argument("--player-id", default=os.environ.get("PLAYER_ID", ""))
    parser.add_argument("--player-name", default=os.environ.get("PLAYER_NAME", ""))
    parser.add_argument("--position", default=os.environ.get("POSITION", ""))
    parser.add_argument("--salary", default=os.environ.get("SALARY", "0"))
    parser.add_argument("--contract-year", default=os.environ.get("CONTRACT_YEAR", "0"))
    parser.add_argument("--contract-status", default=os.environ.get("CONTRACT_STATUS", ""))
    parser.add_argument("--contract-info", default=os.environ.get("CONTRACT_INFO", ""))
    parser.add_argument("--submitted-at", default=os.environ.get("SUBMITTED_AT_UTC", ""))
    parser.add_argument("--source", default=os.environ.get("SOURCE", "worker-contract-activity"))
    parser.add_argument("--test-flag", default=os.environ.get("TEST_FLAG", "0"))
    parser.add_argument("--commish-override-flag", default=os.environ.get("COMMISH_OVERRIDE_FLAG", "0"))
    parser.add_argument("--override-as-of-date", default=os.environ.get("OVERRIDE_AS_OF_DATE", ""))
    parser.add_argument("--delivery-target", default=os.environ.get("DELIVERY_TARGET", ""))
    parser.add_argument("--discord-channel-id", default=os.environ.get("DISCORD_CHANNEL_ID", ""))
    parser.add_argument("--discord-message-id", default=os.environ.get("DISCORD_MESSAGE_ID", ""))
    parser.add_argument("--discord-pinned-flag", default=os.environ.get("DISCORD_PINNED_FLAG", "0"))
    parser.add_argument("--notes", default=os.environ.get("NOTES", ""))
    return parser.parse_args()


def load_doc(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not path.exists():
        return {"meta": {}, "activities": []}, []
    raw = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(raw, list):
        return {"meta": {}, "activities": raw}, raw
    if isinstance(raw, dict):
        rows = raw.get("activities") or raw.get("submissions") or raw.get("rows") or []
        if not isinstance(rows, list):
            rows = []
        return raw, rows
    return {"meta": {}, "activities": []}, []


def build_activity_id(entry: Dict[str, Any]) -> str:
    seeded = safe_str(entry.get("submission_id"))
    if seeded:
        return seeded
    raw = "|".join(
        [
            safe_str(entry.get("activity_type")),
            safe_str(entry.get("season")),
            safe_str(entry.get("league_id")),
            safe_str(entry.get("franchise_id")),
            safe_str(entry.get("player_id")),
            safe_str(entry.get("contract_year")),
            safe_str(entry.get("contract_status")),
            safe_str(entry.get("contract_info")),
            safe_str(entry.get("submitted_at_utc")),
            safe_str(entry.get("source")),
        ]
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def sort_key(item: Dict[str, Any]) -> Tuple[int, str]:
    ts = safe_str(item.get("submitted_at_utc"))
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        val = int(dt.timestamp())
    except ValueError:
        val = 0
    return (-val, safe_str(item.get("player_name")).lower())


def main() -> int:
    args = parse_args()
    payload = parse_payload_defaults(args.payload_json)
    season = (
        safe_str(args.season)
        or safe_str(args.year)
        or safe_str(payload.get("season"))
        or safe_str(payload.get("year"))
    )
    contract_info = (
        safe_str(args.contract_info)
        or safe_str(payload.get("contract_info"))
        or safe_str(payload.get("contractInfo"))
    )
    parsed = parse_contract_info_values(contract_info)
    entry: Dict[str, Any] = {
        "activity_id": safe_str(args.activity_id) or safe_str(payload.get("activity_id")) or safe_str(payload.get("activityId")),
        "submission_id": safe_str(args.submission_id) or safe_str(payload.get("submission_id")) or safe_str(payload.get("submissionId")),
        "activity_scope": safe_str(args.activity_scope) or safe_str(payload.get("activity_scope")) or "contract_mutation",
        "activity_type": safe_str(args.activity_type) or safe_str(payload.get("activity_type")) or safe_str(payload.get("activityType")),
        "season": season,
        "league_id": safe_str(args.league_id) or safe_str(payload.get("league_id")) or safe_str(payload.get("leagueId")),
        "franchise_id": safe_str(args.franchise_id) or safe_str(payload.get("franchise_id")) or safe_str(payload.get("franchiseId")),
        "franchise_name": safe_str(args.franchise_name) or safe_str(payload.get("franchise_name")) or safe_str(payload.get("franchiseName")),
        "player_id": safe_str(args.player_id) or safe_str(payload.get("player_id")) or safe_str(payload.get("playerId")),
        "player_name": safe_str(args.player_name) or safe_str(payload.get("player_name")) or safe_str(payload.get("playerName")),
        "position": safe_str(args.position) or safe_str(payload.get("position")) or safe_str(payload.get("pos")),
        "salary": safe_int(args.salary if safe_str(args.salary) else payload.get("salary"), 0),
        "contract_year": safe_int(args.contract_year if safe_str(args.contract_year) else payload.get("contract_year", payload.get("contractYear")), 0),
        "contract_status": safe_str(args.contract_status) or safe_str(payload.get("contract_status")) or safe_str(payload.get("contractStatus")),
        "contract_info": contract_info,
        "tcv": safe_int(payload.get("tcv"), parsed["tcv"]),
        "aav": safe_int(payload.get("aav"), parsed["aav"]),
        "guaranteed": safe_int(payload.get("guaranteed"), parsed["guaranteed"]),
        "submitted_at_utc": normalize_timestamp(
            safe_str(args.submitted_at) or safe_str(payload.get("submitted_at_utc")) or safe_str(payload.get("submitted_at"))
        ),
        "source": safe_str(args.source) or safe_str(payload.get("source")) or "worker-contract-activity",
        "test_flag": 1 if safe_int(args.test_flag if safe_str(args.test_flag) else payload.get("test_flag", payload.get("testFlag")), 0) else 0,
        "commish_override_flag": 1 if safe_int(args.commish_override_flag if safe_str(args.commish_override_flag) else payload.get("commish_override_flag", payload.get("commishOverrideFlag")), 0) else 0,
        "override_as_of_date": safe_str(args.override_as_of_date) or safe_str(payload.get("override_as_of_date")) or safe_str(payload.get("overrideAsOfDate")),
        "delivery_target": safe_str(args.delivery_target) or safe_str(payload.get("delivery_target")) or safe_str(payload.get("deliveryTarget")),
        "discord_channel_id": safe_str(args.discord_channel_id) or safe_str(payload.get("discord_channel_id")) or safe_str(payload.get("discordChannelId")),
        "discord_message_id": safe_str(args.discord_message_id) or safe_str(payload.get("discord_message_id")) or safe_str(payload.get("discordMessageId")),
        "discord_pinned_flag": 1 if safe_int(args.discord_pinned_flag if safe_str(args.discord_pinned_flag) else payload.get("discord_pinned_flag", payload.get("discordPinnedFlag")), 0) else 0,
        "notes": safe_str(args.notes) or safe_str(payload.get("notes")),
    }

    required = {
        "activity_type": entry["activity_type"],
        "season": entry["season"],
        "league_id": entry["league_id"],
        "player_id": entry["player_id"],
        "contract_year": entry["contract_year"],
        "contract_status": entry["contract_status"],
    }
    missing = [k for k, v in required.items() if v in ("", 0)]
    if missing:
        raise RuntimeError(f"Missing required activity fields: {', '.join(missing)}")

    if not entry["activity_id"]:
        entry["activity_id"] = build_activity_id(entry)

    json_path = Path(args.json_path)
    doc, activities = load_doc(json_path)
    by_id = {safe_str(row.get("activity_id")): row for row in activities if isinstance(row, dict)}
    by_id[entry["activity_id"]] = entry
    rows = list(by_id.values())
    rows.sort(key=sort_key)

    doc["activities"] = rows
    doc["meta"] = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "source": "contract-activity-log",
        "count": len(rows),
        "season": safe_int(entry["season"], 0),
    }

    json_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = json_path.with_suffix(json_path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    tmp_path.replace(json_path)
    print(f"Logged contract activity {entry['activity_id']} for player {entry['player_id']} ({entry['player_name']}).")
    print(f"Wrote {json_path}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
