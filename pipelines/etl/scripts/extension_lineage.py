#!/usr/bin/env python3
from __future__ import annotations

import re
from typing import Any, Dict, List


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def pad4(franchise_id: Any) -> str:
    digits = "".join(ch for ch in safe_str(franchise_id) if ch.isdigit())
    return digits.zfill(4)[-4:] if digits else ""


def normalize_ext_token(token: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", safe_str(token).lower())


def parse_extension_tokens(contract_info: Any) -> List[str]:
    text = safe_str(contract_info)
    if not text:
        return []
    match = re.search(r"(?:^|\|)\s*Ext:\s*([^|]+)", text, re.IGNORECASE)
    if not match:
        return []
    return [
        token
        for token in (
            safe_str(part)
            for part in re.split(r"[,/;&]|\band\b", match.group(1), flags=re.IGNORECASE)
        )
        if token
    ]


def load_extension_lookup(conn, season: int) -> Dict[str, Dict[str, str]]:
    sql = """
    SELECT
      COALESCE(n.ext_nickname, '') AS ext_nickname,
      COALESCE(n.ext_ownername, '') AS ext_ownername,
      COALESCE(n.franchiseid, '') AS franchise_id,
      COALESCE(mf.franchise_name, '') AS team_name,
      COALESCE(mf.abbrev, '') AS franchise_abbrev
    FROM conformance_extensionnickname n
    LEFT JOIN metadata_franchise mf
      ON mf.season = ? AND mf.franchise_id = n.franchiseid
    """
    out: Dict[str, Dict[str, str]] = {}
    for row in conn.execute(sql, (season,)).fetchall():
        token = normalize_ext_token(row[0])
        if not token:
            continue
        out[token] = {
            "ext_nickname": safe_str(row[0]),
            "ext_ownername": safe_str(row[1]),
            "franchise_id": pad4(row[2]),
            "team_name": safe_str(row[3]),
            "franchise_abbrev": safe_str(row[4]),
        }
    return out


def resolve_extension_lineage(
    contract_info: Any,
    current_franchise_id: Any,
    extension_lookup: Dict[str, Dict[str, str]],
) -> Dict[str, Any]:
    tokens = parse_extension_tokens(contract_info)
    history: List[Dict[str, str]] = []
    for raw_token in tokens:
        token_key = normalize_ext_token(raw_token)
        mapped = extension_lookup.get(token_key, {})
        history.append(
            {
                "raw_token": raw_token,
                "token_key": token_key,
                "ext_nickname": safe_str(mapped.get("ext_nickname")) or safe_str(raw_token),
                "ext_ownername": safe_str(mapped.get("ext_ownername")),
                "franchise_id": pad4(mapped.get("franchise_id")),
                "team_name": safe_str(mapped.get("team_name")) or safe_str(mapped.get("ext_ownername")) or safe_str(raw_token),
                "franchise_abbrev": safe_str(mapped.get("franchise_abbrev")),
            }
        )

    current_fid = pad4(current_franchise_id)
    last = history[-1] if history else {}
    return {
        "has_extension_history": 1 if history else 0,
        "extension_history": history,
        "extension_tokens": tokens,
        "extended_by_current_owner": 1
        if current_fid and any(item["franchise_id"] == current_fid for item in history if item["franchise_id"])
        else 0,
        "last_extension_nickname": safe_str(last.get("ext_nickname")),
        "last_extension_owner_name": safe_str(last.get("ext_ownername")),
        "last_extension_franchise_id": pad4(last.get("franchise_id")),
        "last_extension_team_name": safe_str(last.get("team_name")),
        "last_extension_franchise_abbrev": safe_str(last.get("franchise_abbrev")),
        "last_extension_by_current_owner": 1
        if current_fid and pad4(last.get("franchise_id")) == current_fid
        else 0,
    }


def build_extension_overlay(row: Dict[str, Any], extension_lookup: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    lineage = resolve_extension_lineage(
        row.get("contract_info"),
        row.get("franchise_id"),
        extension_lookup,
    )
    contract_year = 0
    try:
        contract_year = int(row.get("contract_year") or 0)
    except (TypeError, ValueError):
        contract_year = 0
    extension_eligible = (
        1
        if contract_year == 1
        and lineage.get("has_extension_history")
        and safe_str(lineage.get("last_extension_franchise_id"))
        and not lineage.get("last_extension_by_current_owner")
        else 0
    )
    return {
        "extension_eligible": extension_eligible,
        "extended_by_current_owner": lineage.get("extended_by_current_owner", 0),
        "last_extension_by_current_owner": lineage.get("last_extension_by_current_owner", 0),
        "last_extension_nickname": lineage.get("last_extension_nickname", ""),
        "last_extension_owner_name": lineage.get("last_extension_owner_name", ""),
        "last_extension_franchise_id": lineage.get("last_extension_franchise_id", ""),
        "last_extension_team_name": lineage.get("last_extension_team_name", ""),
        "last_extension_franchise_abbrev": lineage.get("last_extension_franchise_abbrev", ""),
    }
