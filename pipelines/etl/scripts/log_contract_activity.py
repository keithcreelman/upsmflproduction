#!/usr/bin/env python3
"""
Append a contract activity record into a canonical season log JSON file.

IDEMPOTENT BY DESIGN (2026-09-12). The log-contract-activity workflow no longer
rebases a JSON conflict: when its push is rejected it resets to fresh
origin/main and RE-RUNS this script. So running it N times with the same
payload against any version of the file must land exactly one row:

  * the row is keyed by activity_id (the worker sends submission_id), and an
    existing row with that id is replaced IN PLACE, never duplicated;
  * a fallback id (no activity_id / submission_id) is a hash of payload fields
    only -- never of the wall clock -- so it is identical on every attempt;
  * submitted_at_utc is REQUIRED; it is no longer defaulted to now() (a
    now()-default made the fallback id different on every retry);
  * if the identical row is already present the file is NOT rewritten
    (meta.generated_at stays put), status "unchanged", exit 0;
  * rows in the file that have no activity_id are preserved (the old dict
    keyed on activity_id collapsed them all into one and silently dropped the
    rest);
  * any error (bad JSON payload, missing field, unparseable log, season
    mismatch) exits non-zero. Nothing is swallowed.

--result-json PATH writes {"status": appended|replaced|unchanged,
"activity_id": ..., "json_path": ..., "count": N} for the workflow.
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
    # No now() default: the timestamp feeds the fallback activity_id, and a
    # retry must produce the same id. A missing timestamp is a required-field
    # error below, not something to invent.
    return safe_str(raw_ts)


def parse_payload_defaults(raw_payload: str) -> Dict[str, Any]:
    raw = safe_str(raw_payload)
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"PAYLOAD_JSON is not valid JSON: {exc}") from exc
    if not isinstance(parsed, dict):
        raise RuntimeError(f"PAYLOAD_JSON must be a JSON object, got {type(parsed).__name__}")
    return parsed


def parse_args() -> argparse.Namespace:
    # EVERY default is "" so the payload is read. A non-empty CLI default is a
    # value under safe_str() and shadows the payload: that is how #113 lost
    # contract_year, and until 2026-09-12 it stamped every row
    # source="worker-contract-activity", test_flag=0, commish_override_flag=0
    # whatever the worker sent.
    parser = argparse.ArgumentParser()
    parser.add_argument("--json-path", default="contract_activity_2026.json")
    parser.add_argument("--payload-json", default=os.environ.get("PAYLOAD_JSON", ""))
    parser.add_argument("--activity-id", default=os.environ.get("ACTIVITY_ID", ""))
    parser.add_argument("--submission-id", default=os.environ.get("SUBMISSION_ID", ""))
    parser.add_argument("--activity-scope", default=os.environ.get("ACTIVITY_SCOPE", ""))
    parser.add_argument("--activity-type", default=os.environ.get("ACTIVITY_TYPE", ""))
    parser.add_argument("--season", default=os.environ.get("SEASON", ""))
    parser.add_argument("--year", default=os.environ.get("YEAR", ""))
    parser.add_argument("--league-id", default=os.environ.get("LEAGUE_ID", ""))
    parser.add_argument("--franchise-id", default=os.environ.get("FRANCHISE_ID", ""))
    parser.add_argument("--franchise-name", default=os.environ.get("FRANCHISE_NAME", ""))
    parser.add_argument("--player-id", default=os.environ.get("PLAYER_ID", ""))
    parser.add_argument("--player-name", default=os.environ.get("PLAYER_NAME", ""))
    parser.add_argument("--position", default=os.environ.get("POSITION", ""))
    parser.add_argument("--salary", default=os.environ.get("SALARY", ""))
    parser.add_argument("--contract-year", default=os.environ.get("CONTRACT_YEAR", ""))
    parser.add_argument("--contract-status", default=os.environ.get("CONTRACT_STATUS", ""))
    parser.add_argument("--contract-info", default=os.environ.get("CONTRACT_INFO", ""))
    parser.add_argument("--submitted-at", default=os.environ.get("SUBMITTED_AT_UTC", ""))
    parser.add_argument("--source", default=os.environ.get("SOURCE", ""))
    parser.add_argument("--test-flag", default=os.environ.get("TEST_FLAG", ""))
    parser.add_argument("--commish-override-flag", default=os.environ.get("COMMISH_OVERRIDE_FLAG", ""))
    parser.add_argument("--override-as-of-date", default=os.environ.get("OVERRIDE_AS_OF_DATE", ""))
    parser.add_argument("--delivery-target", default=os.environ.get("DELIVERY_TARGET", ""))
    parser.add_argument("--discord-channel-id", default=os.environ.get("DISCORD_CHANNEL_ID", ""))
    parser.add_argument("--discord-message-id", default=os.environ.get("DISCORD_MESSAGE_ID", ""))
    parser.add_argument("--discord-pinned-flag", default=os.environ.get("DISCORD_PINNED_FLAG", ""))
    parser.add_argument("--notes", default=os.environ.get("NOTES", ""))
    parser.add_argument("--result-json", default="", help="write {status, activity_id, json_path, count} here")
    return parser.parse_args()


def load_doc(path: Path) -> Tuple[Dict[str, Any], List[Dict[str, Any]]]:
    if not path.exists():
        return {"meta": {}, "activities": []}, []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        # e.g. conflict markers committed by hand. Refuse -- never rebuild the
        # log from just this one entry.
        raise RuntimeError(f"{path} is not valid JSON ({exc}); refusing to rewrite it") from exc
    if isinstance(raw, list):
        return {"meta": {}, "activities": raw}, raw
    if isinstance(raw, dict):
        rows = raw.get("activities") or raw.get("submissions") or raw.get("rows") or []
        if not isinstance(rows, list):
            raise RuntimeError(f"{path}: activities is not a list; refusing to rewrite it")
        return raw, rows
    raise RuntimeError(f"{path}: top level is {type(raw).__name__}, expected object or list")


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
        # CLI defaults "--salary 0" / "--contract-year 0" are truthy
        # strings under safe_str(), which would shadow payload values.
        # Treat a CLI-derived 0 as "absent" and consult the payload.
        "salary": (lambda c: c if c > 0 else safe_int(payload.get("salary"), 0))(safe_int(args.salary, 0)),
        "contract_year": (lambda c: c if c > 0 else safe_int(payload.get("contract_year", payload.get("contractYear")), 0))(safe_int(args.contract_year, 0)),
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
        "submitted_at_utc": entry["submitted_at_utc"],
    }
    missing = [k for k, v in required.items() if v in ("", 0)]
    if missing:
        raise RuntimeError(f"Missing required activity fields: {', '.join(missing)}")

    if not entry["activity_id"]:
        entry["activity_id"] = build_activity_id(entry)

    json_path = Path(args.json_path)
    doc, activities = load_doc(json_path)

    file_season = safe_int((doc.get("meta") or {}).get("season"), 0) if isinstance(doc, dict) else 0
    if file_season and file_season != safe_int(entry["season"], 0):
        raise RuntimeError(
            f"{json_path} is the {file_season} log but this activity is season {entry['season']}; refusing to mix seasons"
        )

    aid = entry["activity_id"]
    matches = [i for i, row in enumerate(activities) if isinstance(row, dict) and safe_str(row.get("activity_id")) == aid]
    if len(matches) > 1:
        raise RuntimeError(f"{json_path} already holds {len(matches)} rows with activity_id {aid}; fix the file by hand")

    if matches and activities[matches[0]] == entry:
        status = "unchanged"
        rows = activities
        print(f"Activity {aid} is already in {json_path} byte-for-byte; not rewriting.")
    else:
        rows = list(activities)            # every existing row survives, id or not
        if matches:
            status = "replaced"
            old = rows[matches[0]]
            changed = sorted(k for k in set(old) | set(entry) if old.get(k) != entry.get(k))
            print(f"::warning::activity_id {aid} already logged with different values; replacing fields: {', '.join(changed)}")
            rows[matches[0]] = entry
        else:
            status = "appended"
            rows.append(entry)
        rows.sort(key=sort_key)

        doc["activities"] = rows
        doc["meta"] = {
            **(doc.get("meta") or {}),     # keep hand-written notes such as last_edit
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "source": "contract-activity-log",
            "count": len(rows),
            "season": safe_int(entry["season"], 0),
        }

        json_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = json_path.with_suffix(json_path.suffix + ".tmp")
        tmp_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
        tmp_path.replace(json_path)
        print(f"Logged contract activity {aid} ({status}) for player {entry['player_id']} ({entry['player_name']}).")
        print(f"Wrote {json_path}.")

    if args.result_json:
        Path(args.result_json).write_text(
            json.dumps({"status": status, "activity_id": aid, "json_path": str(json_path), "count": len(rows)}),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
