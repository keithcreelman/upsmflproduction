#!/usr/bin/env python3
"""Build roster acquisition lookup JSON for the roster workbench modal."""

from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from db_utils import DEFAULT_DB_PATH, get_conn


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def pad4(value: Any) -> str:
    digits = "".join(ch for ch in safe_str(value) if ch.isdigit())
    return digits.zfill(4)[-4:] if digits else ""


def fetch_rosters(league_id: str, season: str) -> List[Dict[str, Any]]:
    qs = urllib.parse.urlencode({"TYPE": "rosters", "L": league_id, "JSON": "1"})
    url = f"https://api.myfantasyleague.com/{urllib.parse.quote(season)}/export?{qs}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        payload = json.loads(resp.read())
    franchises = payload.get("rosters", {}).get("franchise", [])
    if isinstance(franchises, dict):
        franchises = [franchises]
    rows: List[Dict[str, Any]] = []
    for fr in franchises:
        fid = pad4(fr.get("id") or fr.get("franchise_id"))
        if not fid:
            continue
        players = fr.get("player") or []
        if isinstance(players, dict):
            players = [players]
        for p in players:
            pid = "".join(ch for ch in safe_str(p.get("id") or p.get("player_id")) if ch.isdigit())
            if not pid:
                continue
            rows.append(
                {
                    "season": season,
                    "league_id": league_id,
                    "franchise_id": fid,
                    "player_id": pid,
                    "roster_status": safe_str(p.get("status")).upper(),
                    "notes": safe_str(p.get("drafted") or p.get("acquired") or p.get("added")),
                }
            )
    return rows


def normalize_adddrop_label(method: str) -> str:
    raw = safe_str(method).upper()
    if raw == "BBID":
        return "Waiver"
    if raw == "FREE_AGENT":
        return "Free Agent Add"
    return raw.replace("_", " ").title() or "Add"


def normalize_auction_label(auction_type: str, date_et: str) -> str:
    raw = safe_str(auction_type)
    if raw == "TagOrExpiredRookie":
        return "Expired Rookie Auction"
    if raw == "FreeAgent":
        return "Free Agent Auction"
    try:
        month = datetime.strptime(safe_str(date_et), "%Y-%m-%d").month
    except ValueError:
        month = 0
    if month and month <= 6:
        return "Expired Rookie Auction"
    return "Free Agent Auction"


def build_event_index(conn, season: str, roster_rows: List[Dict[str, Any]]) -> Dict[Tuple[str, str], Dict[str, Any]]:
    current_keys = {(row["franchise_id"], row["player_id"]) for row in roster_rows}
    current_player_ids = sorted({row["player_id"] for row in roster_rows})
    if not current_keys or not current_player_ids:
        return {}

    placeholders = ",".join("?" for _ in current_player_ids)
    max_season = safe_int(season, 0)
    params_base: List[Any] = [max_season, *current_player_ids]
    out: Dict[Tuple[str, str], Dict[str, Any]] = {}

    def keep_best(key: Tuple[str, str], event: Dict[str, Any]) -> None:
        if key not in current_keys:
            return
        current = out.get(key)
        if not current or safe_int(event.get("unix_timestamp"), 0) >= safe_int(current.get("unix_timestamp"), 0):
            out[key] = event

    sql_trade = f"""
    SELECT season, franchise_id, player_id, date_et, datetime_et, unix_timestamp
    FROM transactions_trades
    WHERE season <= ?
      AND UPPER(COALESCE(asset_type, '')) = 'PLAYER'
      AND UPPER(COALESCE(asset_role, '')) = 'ACQUIRE'
      AND player_id IN ({placeholders})
    """
    for row in conn.execute(sql_trade, params_base).fetchall():
        key = (pad4(row[1]), safe_str(row[2]))
        keep_best(
            key,
            {
                "season": safe_int(row[0], 0),
                "acquisition_date": safe_str(row[3]),
                "acquisition_datetime_et": safe_str(row[4]),
                "unix_timestamp": safe_int(row[5], 0),
                "acquisition_label": "Trade",
                "source_table": "transactions_trades",
            },
        )

    sql_auction = f"""
    SELECT season, franchise_id, player_id, auction_type, bid_amount, date_et, datetime_et, unix_timestamp
    FROM transactions_auction
    WHERE season <= ?
      AND finalbid_ind = 1
      AND player_id IN ({placeholders})
    """
    for row in conn.execute(sql_auction, params_base).fetchall():
        key = (pad4(row[1]), safe_str(row[2]))
        keep_best(
            key,
            {
                "season": safe_int(row[0], 0),
                "acquisition_date": safe_str(row[5]),
                "acquisition_datetime_et": safe_str(row[6]),
                "unix_timestamp": safe_int(row[7], 0),
                "acquisition_label": normalize_auction_label(row[3], row[5]),
                "acquisition_detail": f"${safe_int(row[4], 0):,}",
                "source_table": "transactions_auction",
            },
        )

    sql_add = f"""
    SELECT season, franchise_id, player_id, method, salary, date_et, datetime_et, unix_timestamp
    FROM transactions_adddrop
    WHERE season <= ?
      AND UPPER(COALESCE(move_type, '')) = 'ADD'
      AND player_id IN ({placeholders})
    """
    for row in conn.execute(sql_add, params_base).fetchall():
        key = (pad4(row[1]), safe_str(row[2]))
        detail = ""
        if safe_int(row[4], 0) > 0:
          detail = f"${safe_int(row[4], 0):,}"
        keep_best(
            key,
            {
                "season": safe_int(row[0], 0),
                "acquisition_date": safe_str(row[5]),
                "acquisition_datetime_et": safe_str(row[6]),
                "unix_timestamp": safe_int(row[7], 0),
                "acquisition_label": normalize_adddrop_label(row[3]),
                "acquisition_detail": detail,
                "source_table": "transactions_adddrop",
            },
        )

    sql_draft = f"""
    SELECT season, franchise_id, player_id, date_et, datetime_et, unix_timestamp, draftpick_round, draftpick_overall
    FROM draftresults_combined
    WHERE season <= ?
      AND player_id IN ({placeholders})
    """
    for row in conn.execute(sql_draft, params_base).fetchall():
        key = (pad4(row[1]), safe_str(row[2]))
        detail_parts = []
        if safe_int(row[6], 0) > 0:
            detail_parts.append(f"Round {safe_int(row[6], 0)}")
        if safe_int(row[7], 0) > 0:
            detail_parts.append(f"Pick {safe_int(row[7], 0)}")
        keep_best(
            key,
            {
                "season": safe_int(row[0], 0),
                "acquisition_date": safe_str(row[3]),
                "acquisition_datetime_et": safe_str(row[4]),
                "unix_timestamp": safe_int(row[5], 0),
                "acquisition_label": "Rookie Draft",
                "acquisition_detail": " | ".join(detail_parts),
                "source_table": "draftresults_combined",
            },
        )

    return out


def build_player_origin_index(conn, season: str, roster_rows: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    current_player_ids = sorted({row["player_id"] for row in roster_rows})
    if not current_player_ids:
        return {}

    placeholders = ",".join("?" for _ in current_player_ids)
    max_season = safe_int(season, 0)
    params: List[Any] = [max_season, *current_player_ids]
    out: Dict[str, Dict[str, Any]] = {}

    sql_draft = f"""
    SELECT player_id, MIN(season) AS draft_season
    FROM draftresults_combined
    WHERE season <= ?
      AND player_id IN ({placeholders})
    GROUP BY player_id
    """
    for row in conn.execute(sql_draft, params).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        out[pid] = {
            "original_draft_season": safe_int(row[1], 0),
        }

    return out


def fallback_label_from_notes(notes: str) -> str:
    raw = safe_str(notes)
    upper = raw.upper()
    if "TRADE" in upper:
        return "Trade"
    if "AUCTION" in upper:
        return "Auction"
    if "BBID" in upper or "WAIVER" in upper:
        return "Waiver"
    if "FREE_AGENT" in upper or "FREE AGENT" in upper:
        return "Free Agent Add"
    if "DRAFT" in upper:
        return "Rookie Draft"
    return raw


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", required=True)
    parser.add_argument("--league-id", required=True)
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    roster_rows = fetch_rosters(safe_str(args.league_id), safe_str(args.season))
    conn = get_conn(args.db_path)
    try:
        event_index = build_event_index(conn, safe_str(args.season), roster_rows)
        player_origin_index = build_player_origin_index(conn, safe_str(args.season), roster_rows)
    finally:
        conn.close()

    rows: List[Dict[str, Any]] = []
    for roster_row in roster_rows:
        key = (roster_row["franchise_id"], roster_row["player_id"])
        event = event_index.get(key, {})
        origin = player_origin_index.get(roster_row["player_id"], {})
        row = {
            "season": safe_str(args.season),
            "league_id": safe_str(args.league_id),
            "franchise_id": roster_row["franchise_id"],
            "player_id": roster_row["player_id"],
            "acquisition_date": safe_str(event.get("acquisition_date")),
            "acquisition_datetime_et": safe_str(event.get("acquisition_datetime_et")),
            "acquisition_label": safe_str(event.get("acquisition_label")),
            "acquisition_detail": safe_str(event.get("acquisition_detail")),
            "source_table": safe_str(event.get("source_table")),
            "original_draft_season": safe_int(origin.get("original_draft_season"), 0),
            "notes_fallback": safe_str(roster_row.get("notes")),
        }
        if not row["acquisition_label"] and row["notes_fallback"]:
            row["acquisition_label"] = fallback_label_from_notes(row["notes_fallback"])
        rows.append(row)

    rows.sort(key=lambda row: (row["franchise_id"], row["player_id"]))
    out_doc = {
        "meta": {
            "season": safe_str(args.season),
            "league_id": safe_str(args.league_id),
            "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "count": len(rows),
            "source": "roster-acquisition-lookup",
        },
        "rows": rows,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out_doc, indent=2), encoding="utf-8")
    print(f"Wrote {out_path} ({len(rows)} rows).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
