#!/usr/bin/env python3
"""Shared helpers for live MFL salaryAdjustments exports."""

from __future__ import annotations

import re
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Dict, List


NAME_SUFFIX_TOKENS = {"jr", "sr", "ii", "iii", "iv", "v"}


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


def parse_money_token(value: str) -> int:
    text = safe_str(value).upper().replace("$", "").replace(",", "")
    if not text:
        return 0
    match = re.match(r"^([0-9]+(?:\.[0-9]+)?)(K)?$", text)
    if not match:
        return safe_int(text, 0)
    amount = float(match.group(1))
    if match.group(2):
        amount *= 1000
    return int(round(amount))


def normalize_player_name(value: Any) -> str:
    text = safe_str(value).lower()
    text = re.sub(r"[^a-z0-9]+", " ", text)
    tokens = [token for token in text.split() if token and token not in NAME_SUFFIX_TOKENS]
    return " ".join(tokens)


def parse_year_values_from_contract_info(contract_info: str) -> Dict[int, int]:
    text = safe_str(contract_info)
    if not text:
        return {}
    values: Dict[int, int] = {}
    for year_idx, amount in re.findall(
        r"Y\s*([0-9]+)\s*-\s*([0-9]+(?:\.[0-9]+)?K?)",
        text,
        flags=re.IGNORECASE,
    ):
        idx = safe_int(year_idx, 0)
        amt = parse_money_token(amount)
        if idx > 0 and amt > 0:
            values[idx] = amt
    return values


def parse_drop_salary_from_adjustment_desc(description: str) -> int | None:
    text = safe_str(description)
    match = re.search(r"Salary:\s*\$([0-9,]+)", text, flags=re.IGNORECASE)
    if not match:
        return None
    return safe_int(match.group(1).replace(",", ""), 0)


def parse_drop_marker_description(description: str) -> Dict[str, Any] | None:
    text = safe_str(description)
    if not text.lower().startswith("dropped "):
        return None
    match = re.match(
        r"^Dropped\s+(?P<player>.+?)\s+[A-Z]{2,4}\s+[A-Z/]{1,5}\s+\(Salary:\s*\$(?P<salary>[0-9,]+),\s*Special:\s*(?P<special>.*?),\s*Years:\s*(?P<years>[0-9]+),\s*Type:\s*(?P<type>[^)]+)\)$",
        text,
        flags=re.IGNORECASE,
    )
    if not match:
        return None

    player_name = safe_str(match.group("player"))
    salary = safe_int(match.group("salary").replace(",", ""), 0)
    special = safe_str(match.group("special"))
    years_remaining = safe_int(match.group("years"), 0)
    contract_type = safe_str(match.group("type"))
    contract_length_match = re.search(r"\bCL\s+([0-9]+)\b", special, flags=re.IGNORECASE)
    contract_length = safe_int(contract_length_match.group(1), 0) if contract_length_match else 0
    tcv_match = re.search(r"\bTCV\s+([0-9]+(?:\.[0-9]+)?K?)", special, flags=re.IGNORECASE)
    total_contract_value = parse_money_token(tcv_match.group(1)) if tcv_match else 0
    year_values = parse_year_values_from_contract_info(special)
    if total_contract_value <= 0 and year_values:
        total_contract_value = sum(year_values.values())
    if total_contract_value <= 0 and salary > 0 and contract_length > 0:
        total_contract_value = salary * contract_length
    contract_year_index = 0
    if contract_length > 0 and years_remaining > 0:
        contract_year_index = max(1, contract_length - years_remaining + 1)

    return {
        "player_name": player_name,
        "normalized_player_name": normalize_player_name(player_name),
        "salary": salary,
        "special": special,
        "years_remaining": years_remaining,
        "contract_type": contract_type,
        "contract_length": contract_length,
        "contract_year_index": contract_year_index,
        "tcv": total_contract_value,
        "year_values": year_values,
    }


def parse_unix_timestamp_et(value: Any) -> datetime | None:
    ts = safe_int(value, 0)
    if ts <= 0:
        return None
    try:
        return datetime.fromtimestamp(ts)
    except (OverflowError, OSError, ValueError):
        return None


def fetch_salary_adjustments(
    url: str,
    timeout: int = 30,
    user_agent: str = "codex-salary-adjustments-feed/1.0",
) -> Dict[str, Any]:
    req = urllib.request.Request(
        safe_str(url),
        headers={
            "User-Agent": user_agent,
            "Accept": "application/xml,text/xml,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=max(5, safe_int(timeout, 30))) as resp:
        payload = resp.read()
    root = ET.fromstring(payload)
    if root.tag.lower() != "salaryadjustments":
        raise RuntimeError(f"Unexpected salaryAdjustments payload root: {root.tag}")

    rows: List[Dict[str, Any]] = []
    for node in root.findall("salaryAdjustment"):
        description = safe_str(node.attrib.get("description") or node.attrib.get("explanation"))
        marker = parse_drop_marker_description(description)
        amount = safe_float(node.attrib.get("amount"), 0.0)
        timestamp = safe_int(node.attrib.get("timestamp"), 0)
        rows.append(
            {
                "id": safe_str(node.attrib.get("id")),
                "franchise_id": safe_str(node.attrib.get("franchise_id") or node.attrib.get("franchiseid")),
                "amount": amount,
                "description": description,
                "timestamp": timestamp or None,
                "timestamp_et": parse_unix_timestamp_et(timestamp),
                "drop_salary_in_desc": parse_drop_salary_from_adjustment_desc(description),
                "drop_marker": marker,
                "is_marker_row": bool(marker) and abs(amount) < 1.0,
            }
        )

    return {
        "source_url": safe_str(url),
        "rows": rows,
        "fetched_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
    }


def summarize_salary_adjustments(rows: List[Dict[str, Any]]) -> Dict[str, float]:
    tiny_threshold = 1.0
    marker_rows = [row for row in rows if abs(float(row.get("amount") or 0.0)) < tiny_threshold]
    real_rows = [row for row in rows if abs(float(row.get("amount") or 0.0)) >= tiny_threshold]

    marker_drop_salary_total = float(
        sum(float(row.get("drop_salary_in_desc") or 0.0) for row in marker_rows)
    )

    by_ts: Dict[int, List[Dict[str, Any]]] = {}
    for row in real_rows:
        timestamp = row.get("timestamp")
        if timestamp is not None:
            by_ts.setdefault(int(timestamp), []).append(row)

    used_ids = set()
    trade_transfer_volume = 0.0
    for items in by_ts.values():
        if len(items) < 2:
            continue
        net = sum(float(item.get("amount") or 0.0) for item in items)
        abs_sum = sum(abs(float(item.get("amount") or 0.0)) for item in items)
        has_pos = any(float(item.get("amount") or 0.0) > 0 for item in items)
        has_neg = any(float(item.get("amount") or 0.0) < 0 for item in items)
        if has_pos and has_neg and abs(net) < 0.01:
            trade_transfer_volume += abs_sum / 2.0
            for item in items:
                if item.get("id"):
                    used_ids.add(safe_str(item.get("id")))

    cap_penalty_total = 0.0
    other_abs_total = 0.0
    other_net_total = 0.0
    traded_label_abs_total = 0.0
    for row in real_rows:
        row_id = safe_str(row.get("id"))
        amount = float(row.get("amount") or 0.0)
        description = safe_str(row.get("description")).lower()
        if row_id in used_ids:
            continue
        if "cap_penalt" in description:
            cap_penalty_total += max(0.0, amount)
            continue
        if "tradedsalary" in description or "traded_salary" in description:
            traded_label_abs_total += abs(amount)
            continue
        other_abs_total += abs(amount)
        other_net_total += amount

    effective_volume = (
        float(trade_transfer_volume)
        + float(traded_label_abs_total / 2.0)
        + float(cap_penalty_total)
        + float(other_abs_total)
    )

    return {
        "rows_total": len(rows),
        "rows_real_amount": len(real_rows),
        "rows_marker_amount": len(marker_rows),
        "marker_drop_salary_total": round(marker_drop_salary_total, 2),
        "trade_transfer_volume": round(float(trade_transfer_volume), 2),
        "traded_label_abs_total": round(float(traded_label_abs_total), 2),
        "cap_penalty_total": round(float(cap_penalty_total), 2),
        "other_abs_total": round(float(other_abs_total), 2),
        "other_net_total": round(float(other_net_total), 2),
        "effective_volume": round(float(effective_volume), 2),
    }


def build_drop_marker_lookup(rows: List[Dict[str, Any]]) -> Dict[tuple[str, str], List[Dict[str, Any]]]:
    lookup: Dict[tuple[str, str], List[Dict[str, Any]]] = {}
    for row in rows:
        if not row.get("is_marker_row"):
            continue
        marker = row.get("drop_marker") or {}
        key = (
            safe_str(row.get("franchise_id")),
            safe_str(marker.get("normalized_player_name")),
        )
        if not key[0] or not key[1]:
            continue
        lookup.setdefault(key, []).append(row)
    for items in lookup.values():
        items.sort(
            key=lambda item: (
                item.get("timestamp_et") is None,
                item.get("timestamp_et") or datetime.min,
            )
        )
    return lookup


def match_drop_marker(
    marker_lookup: Dict[tuple[str, str], List[Dict[str, Any]]],
    franchise_id: str,
    player_name: str,
    transaction_dt: datetime | None,
    max_delta_seconds: int = 24 * 60 * 60,
) -> Dict[str, Any] | None:
    key = (safe_str(franchise_id), normalize_player_name(player_name))
    candidates = marker_lookup.get(key) or []
    if not candidates:
        return None
    if transaction_dt is None:
        return candidates[-1]

    best_row: Dict[str, Any] | None = None
    best_delta: float | None = None
    for row in candidates:
        marker_dt = row.get("timestamp_et")
        if marker_dt is None:
            continue
        delta = abs((marker_dt - transaction_dt).total_seconds())
        if best_delta is None or delta < best_delta:
            best_row = row
            best_delta = delta
    if best_row is not None and best_delta is not None and best_delta <= max_delta_seconds:
        return best_row
    return None
