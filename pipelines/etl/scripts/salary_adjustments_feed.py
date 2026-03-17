#!/usr/bin/env python3
"""Shared helpers for live MFL salaryAdjustments feeds."""

from __future__ import annotations

import json
import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import parse_qs, parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo


EASTERN_TZ = ZoneInfo("America/New_York")
CAP_PENALTY_SEASON_RE = re.compile(r"\b(20\d{2})_Cap_Penalties\b", re.IGNORECASE)


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


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def infer_feed_export_season(source_label: Any) -> int:
    text = safe_str(source_label)
    if not text:
        return 0
    try:
        parts = urlsplit(text)
    except ValueError:
        parts = None
    if parts is not None:
        path_bits = [bit for bit in parts.path.split("/") if bit]
        if path_bits:
            season = safe_int(path_bits[0], 0)
            if 2000 <= season <= 2099:
                return season
        query = parse_qs(parts.query)
        for key in ("YEAR", "year", "season", "SEASON"):
            values = query.get(key) or []
            for value in values:
                season = safe_int(value, 0)
                if 2000 <= season <= 2099:
                    return season
    for match in re.finditer(r"(?<!\d)(20\d{2})(?!\d)", text):
        season = safe_int(match.group(1), 0)
        if 2000 <= season <= 2099:
            return season
    return 0


def rewrite_feed_export_season(source_label: Any, season: int) -> str:
    text = safe_str(source_label)
    target = safe_int(season, 0)
    if not text or target <= 0:
        return text
    parts = urlsplit(text)
    path_bits = [bit for bit in parts.path.split("/") if bit]
    if path_bits and re.fullmatch(r"20\d{2}", path_bits[0]):
        path_bits[0] = str(target)
        new_path = "/" + "/".join(path_bits)
        return urlunsplit((parts.scheme, parts.netloc, new_path, parts.query, parts.fragment))
    return text


def redact_feed_source(source_label: Any) -> str:
    text = safe_str(source_label)
    if not text:
        return ""
    parts = urlsplit(text)
    if not parts.scheme or not parts.netloc:
        return text
    redacted_pairs = []
    changed = False
    for key, value in parse_qsl(parts.query, keep_blank_values=True):
        if key.lower() in {"apikey", "api_key", "token", "access_token"}:
            redacted_pairs.append((key, "REDACTED"))
            changed = True
        else:
            redacted_pairs.append((key, value))
    if not changed:
        return text
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(redacted_pairs), parts.fragment))


def parse_money_amount(token: Any, default: int = 0, assume_small_k: bool = False) -> int:
    text = safe_str(token).replace("$", "").replace(",", "")
    if not text:
        return default
    mult = 1
    if text.lower().endswith("k"):
        mult = 1000
        text = text[:-1]
    try:
        value = float(text)
    except ValueError:
        return default
    if assume_small_k and mult == 1 and abs(value) < 1000:
        mult = 1000
    return int(round(value * mult))


def normalize_player_name(name: Any) -> str:
    text = safe_str(name).lower()
    text = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", text)
    return re.sub(r"[^a-z0-9]", "", text)


def parse_drop_salary_from_adjustment_desc(description: Any) -> int | None:
    text = safe_str(description)
    match = re.search(r"Salary:\s*\$([0-9,]+)", text, flags=re.IGNORECASE)
    if not match:
        return None
    return parse_money_amount(match.group(1))


def parse_special_year_values(special: Any) -> Dict[int, int]:
    text = safe_str(special)
    values: Dict[int, int] = {}
    for match in re.finditer(r"Y(\d+)\s*[-:]\s*([0-9][0-9,]*)(K)?", text, flags=re.IGNORECASE):
        year_idx = safe_int(match.group(1), 0)
        amount = parse_money_amount(match.group(2) + (match.group(3) or ""), assume_small_k=True)
        if year_idx > 0 and amount > 0:
            values[year_idx] = amount
    return values


def parse_drop_marker_description(description: Any) -> Dict[str, Any]:
    text = safe_str(description)
    if not text.lower().startswith("dropped "):
        return {}
    match = re.search(
        r"^Dropped\s+(?P<body>.+?)\s*\(Salary:\s*\$(?P<salary>[0-9,]+(?:\.[0-9]+)?),\s*Special:\s*(?P<special>.*?),\s*Years:\s*(?P<years>\d+),\s*Type:\s*(?P<ptype>[^)]+)\)\s*$",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return {}

    body = safe_str(match.group("body"))
    body_parts = body.rsplit(" ", 2)
    if len(body_parts) == 3 and 2 <= len(body_parts[1]) <= 3 and 1 <= len(body_parts[2]) <= 4:
        player_name = body_parts[0]
        nfl_team = body_parts[1]
        position = body_parts[2]
    else:
        player_name = body
        nfl_team = ""
        position = ""

    special = safe_str(match.group("special"))
    salary = parse_money_amount(match.group("salary"))
    years_remaining = safe_int(match.group("years"), 0)
    player_type = safe_str(match.group("ptype"))
    contract_length_match = re.search(r"CL\s*([0-9]+)", special, flags=re.IGNORECASE)
    contract_length = safe_int(contract_length_match.group(1), years_remaining or 1) if contract_length_match else max(years_remaining, 1)
    tcv_match = re.search(r"TCV\s*([0-9][0-9,]*)(K)?", special, flags=re.IGNORECASE)
    total_contract_value = (
        parse_money_amount((tcv_match.group(1) or "") + (tcv_match.group(2) or ""), assume_small_k=True)
        if tcv_match
        else 0
    )
    year_values = parse_special_year_values(special)
    if not year_values and contract_length == 1 and salary > 0:
        year_values = {1: salary}
    if not year_values and contract_length == 2 and years_remaining == 1 and total_contract_value > salary > 0:
        year_values = {1: max(total_contract_value - salary, 0), 2: salary}

    return {
        "player_name": player_name,
        "player_name_normalized": normalize_player_name(player_name),
        "nfl_team": nfl_team,
        "position": position,
        "drop_salary": salary,
        "special": special,
        "years_remaining": years_remaining,
        "player_type": player_type,
        "contract_length": contract_length,
        "tcv": total_contract_value,
        "year_values": year_values,
    }


def timestamp_to_datetime_et(timestamp: Any) -> datetime | None:
    raw = safe_int(timestamp, 0)
    if raw <= 0:
        return None
    seconds = raw / 1000.0 if raw >= 1_000_000_000_000 else float(raw)
    try:
        return datetime.fromtimestamp(seconds, timezone.utc).astimezone(EASTERN_TZ).replace(tzinfo=None)
    except (OSError, OverflowError, ValueError):
        return None


def detect_cap_penalty_season(description: Any) -> int:
    match = CAP_PENALTY_SEASON_RE.search(safe_str(description))
    if not match:
        return 0
    return safe_int(match.group(1), 0)


def parse_salary_adjustments_payload(
    payload: bytes,
    source_label: str = "",
    feed_export_season: int | None = None,
) -> Dict[str, Any]:
    root = ET.fromstring(payload)
    if root.tag.lower() != "salaryadjustments":
        raise RuntimeError(f"Unexpected salaryAdjustments payload root: {root.tag}")

    export_season = safe_int(feed_export_season, 0) or infer_feed_export_season(source_label)
    rows: List[Dict[str, Any]] = []
    for node in root.findall("salaryAdjustment"):
        amount_raw_text = safe_str(node.attrib.get("amount"))
        amount = safe_float(amount_raw_text, 0.0)
        description = safe_str(node.attrib.get("description"))
        timestamp = safe_int(node.attrib.get("timestamp"), 0)
        marker = parse_drop_marker_description(description) if abs(amount) < 1.0 else {}
        created_at_dt = timestamp_to_datetime_et(timestamp)
        created_at_et = created_at_dt.isoformat(sep=" ") if created_at_dt else ""
        category = "other"
        if marker:
            category = "drop_marker"
        elif detect_cap_penalty_season(description):
            category = "cap_penalty"
        elif "tradedsalary" in description.lower():
            category = "traded_salary"

        rows.append(
            {
                "id": safe_str(node.attrib.get("id")),
                "salary_adjustment_id": safe_str(node.attrib.get("id")),
                "franchise_id": safe_str(node.attrib.get("franchise_id")),
                "amount": amount,
                "amount_raw_text": amount_raw_text,
                "description": description,
                "timestamp": timestamp,
                "created_at_et": created_at_et,
                "feed_export_season": export_season,
                "drop_salary_in_desc": parse_drop_salary_from_adjustment_desc(description),
                "category": category,
                "cap_penalty_season": detect_cap_penalty_season(description),
                "marker_player_name": marker.get("player_name", ""),
                "marker_player_name_normalized": marker.get("player_name_normalized", ""),
                "marker_nfl_team": marker.get("nfl_team", ""),
                "marker_position": marker.get("position", ""),
                "marker_drop_salary": marker.get("drop_salary", 0),
                "marker_special": marker.get("special", ""),
                "marker_years_remaining": marker.get("years_remaining", 0),
                "marker_type": marker.get("player_type", ""),
                "marker_contract_length": marker.get("contract_length", 0),
                "marker_tcv": marker.get("tcv", 0),
                "marker_year_values_json": json.dumps(marker.get("year_values", {}), sort_keys=True),
            }
        )

    return {
        "source": source_label,
        "feed_export_season": export_season,
        "rows": rows,
        "fetched_at_utc": now_utc(),
    }


def fetch_salary_adjustments(url: Any, timeout: int = 30) -> Dict[str, Any]:
    url_text = str(url)
    req = urllib.request.Request(
        url_text,
        headers={
            "User-Agent": "codex-salary-adjustments/1.0",
            "Accept": "application/xml,text/xml,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=max(5, safe_int(timeout, 30))) as resp:
        payload = resp.read()
    return parse_salary_adjustments_payload(
        payload,
        source_label=url_text,
        feed_export_season=infer_feed_export_season(url_text),
    )


def load_salary_adjustments_file(path: Any) -> Dict[str, Any]:
    source_path = Path(str(path)).expanduser()
    payload = source_path.read_bytes()
    return parse_salary_adjustments_payload(payload, source_label=str(source_path))
