#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def safe_str(value) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value, default: int = 0) -> int:
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def normalize_pos_group(position: str) -> str:
    p = safe_str(position).upper()
    if p in {"CB", "S", "DB"}:
        return "DB"
    if p in {"DE", "DT", "DL"}:
        return "DL"
    if p in {"K", "PK", "PN", "P"}:
        return "PK"
    return p


def round_to_k(value: int) -> int:
    return max(1000, int(round(float(value) / 1000.0) * 1000))


def format_k(value: int) -> str:
    if value <= 0:
        return "0K"
    if value % 1000 == 0:
        return f"{value // 1000}K"
    return f"{round(value / 1000.0, 1)}K"


def parse_money_token(token: str) -> int:
    raw = safe_str(token).upper().replace("$", "")
    if not raw:
        return 0
    cleaned = re.sub(r"[^0-9K.\-]", "", raw)
    if not cleaned:
        return 0
    mult = 1000 if "K" in cleaned else 1
    cleaned = cleaned.replace("K", "")
    if not cleaned:
        return 0
    try:
        num = float(cleaned)
    except ValueError:
        return 0
    amount = int(round(num * mult))
    if mult == 1 and 0 < amount < 1000:
        amount *= 1000
    return amount


def parse_contract_aav(contract_info: str) -> int:
    info = safe_str(contract_info)
    if not info:
        return 0
    match = re.search(r"(?:^|\|)\s*AAV\s*([^|]+)", info, flags=re.IGNORECASE)
    if not match:
        return 0
    amounts = [parse_money_token(token) for token in re.split(r"[,/]", safe_str(match.group(1)))]
    amounts = [amount for amount in amounts if amount > 0]
    return amounts[-1] if amounts else 0


def parse_extension_history(contract_info: str) -> str:
    match = re.search(r"(?:^|\|)\s*Ext:\s*([^|]+)", safe_str(contract_info), flags=re.IGNORECASE)
    return safe_str(match.group(1)) if match else ""


def load_current_roster_snapshot(conn: sqlite3.Connection, season: int) -> dict[str, dict]:
    week_row = conn.execute(
        "SELECT MAX(week) FROM rosters_current WHERE season = ?",
        (season,),
    ).fetchone()
    week = safe_int(week_row[0], 0) if week_row else 0
    out: dict[str, dict] = {}
    if week <= 0:
        return out
    rows = conn.execute(
        """
        SELECT
          player_id,
          COALESCE(position, '') AS position,
          COALESCE(aav, 0) AS aav,
          COALESCE(contract_info, '') AS contract_info
        FROM rosters_current
        WHERE season = ? AND week = ?
        """,
        (season, week),
    ).fetchall()
    for row in rows:
        player_id = safe_str(row["player_id"])
        if not player_id:
            continue
        out[player_id] = {
            "position": safe_str(row["position"]),
            "aav": safe_int(row["aav"], 0),
            "contract_info": safe_str(row["contract_info"]),
        }
    return out


def load_extension_rates(conn: sqlite3.Connection, season: int) -> dict[str, dict[int, int]]:
    season_row = conn.execute(
        "SELECT MAX(season) FROM conformance_extensions WHERE season <= ?",
        (season,),
    ).fetchone()
    rate_season = safe_int(season_row[0], season) if season_row else season
    out: dict[str, dict[int, int]] = {}
    rows = conn.execute(
        """
        SELECT positional_grouping, extensionrate_1yr, extensionrate_2yr
        FROM conformance_extensions
        WHERE season = ?
        """,
        (rate_season,),
    ).fetchall()
    for row in rows:
        out[normalize_pos_group(row["positional_grouping"])] = {
            1: safe_int(row["extensionrate_1yr"], 0),
            2: safe_int(row["extensionrate_2yr"], 0),
        }
    return out


def normalize_preview_rows(rows: list[sqlite3.Row], conn: sqlite3.Connection, season: int) -> list[dict]:
    roster = load_current_roster_snapshot(conn, season)
    rates = load_extension_rates(conn, season)
    out: list[dict] = []
    for row in rows:
        item = dict(row)
        player_id = safe_str(item.get("player_id"))
        term = safe_str(item.get("extension_term")).upper()
        years_to_add = 1 if term == "1YR" else (2 if term == "2YR" else 0)
        current = roster.get(player_id, {})
        current_aav = safe_int(current.get("aav"), 0) or parse_contract_aav(current.get("contract_info"))
        pos_group = normalize_pos_group(current.get("position") or item.get("position"))
        raise_amt = safe_int((rates.get(pos_group) or {}).get(years_to_add), 0)
        if years_to_add <= 0 or current_aav <= 0 or raise_amt <= 0:
            out.append(item)
            continue
        future_aav = round_to_k(current_aav + raise_amt)
        contract_length = years_to_add + 1
        tcv = current_aav + (future_aav * years_to_add)
        guarantee = round(tcv * 0.75) if tcv > 4000 else max(0, tcv - current_aav)
        ext_text = parse_extension_history(item.get("preview_contract_info_string")) or parse_extension_history(current.get("contract_info"))
        year_tokens = [f"Y1-{format_k(current_aav)}"] + [f"Y{year + 2}-{format_k(future_aav)}" for year in range(years_to_add)]
        info_parts = [
            f"CL {contract_length}",
            f"TCV {format_k(tcv)}",
            f"AAV {format_k(current_aav)}, {format_k(future_aav)}",
            ", ".join(year_tokens),
        ]
        if ext_text:
            info_parts.append(f"Ext: {ext_text}")
        info_parts.append(f"GTD: {format_k(guarantee)}")
        item.update(
            {
                "new_contract_status": f"EXT{years_to_add}",
                "new_contract_length": contract_length,
                "new_TCV": tcv,
                "new_aav_current": current_aav,
                "new_aav_future": future_aav,
                "new_contract_guarantee": guarantee,
                "preview_contract_info_string": "|".join(info_parts),
            }
        )
        out.append(item)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--out-path", required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            """
            SELECT
              id,
              nfl_season,
              franchise_id,
              player_id,
              preview_ts,
              extension_term,
              loaded_indicator,
              success,
              error_message,
              new_contract_status,
              new_contract_length,
              new_TCV,
              new_aav_current,
              new_aav_future,
              new_contract_guarantee,
              preview_contract_info_string,
              franchise_name,
              player_name,
              position,
              committed,
              committed_ts,
              committed_event_id,
              mfl_post_status,
              mfl_post_ts,
              mfl_post_error,
              reverted,
              reverted_ts,
              reverted_event_id,
              mfl_revert_status,
              mfl_revert_ts,
              mfl_revert_error
            FROM extension_previews
            WHERE nfl_season = ?
              AND success = 1
            ORDER BY player_name, extension_term, preview_ts, id
            """,
            (args.season,),
        ).fetchall()

        out_path = Path(args.out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "meta": {
                "season": args.season,
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "row_count": len(rows),
                "db_path": args.db_path,
                "table": "extension_previews",
                "success_only": True,
                "columns": list(rows[0].keys()) if rows else [],
            },
            "rows": normalize_preview_rows(rows, conn, args.season),
        }
        out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(json.dumps({"out_path": str(out_path), "row_count": len(rows)}))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
