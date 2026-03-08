#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime
from typing import Any, Dict

from extension_lineage import (
    load_extension_lookup,
    normalize_ext_token,
    parse_extension_tokens,
    resolve_extension_lineage,
)


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def pad4(value: Any) -> str:
    digits = "".join(ch for ch in safe_str(value) if ch.isdigit())
    return digits.zfill(4)[-4:] if digits else ""


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
    return f"{int(round(float(value) / 1000.0))}K"


def load_team_meta(conn, season: int) -> Dict[str, Dict[str, str]]:
    season_row = conn.execute(
        "SELECT MAX(season) FROM metadata_franchise WHERE season <= ?",
        (season,),
    ).fetchone()
    meta_season = safe_int(season_row[0], season) if season_row else season
    out: Dict[str, Dict[str, str]] = {}
    for row in conn.execute(
        """
        SELECT franchise_id, COALESCE(franchise_name, ''), COALESCE(abbrev, '')
        FROM metadata_franchise
        WHERE season = ?
        """,
        (meta_season,),
    ).fetchall():
        fid = pad4(row[0])
        if not fid:
            continue
        out[fid] = {
            "franchise_name": safe_str(row[1]),
            "abbrev": safe_str(row[2]),
        }
    return out


def load_extension_rates(conn, season: int) -> Dict[str, Dict[int, int]]:
    season_row = conn.execute(
        "SELECT MAX(season) FROM conformance_extensions WHERE season <= ?",
        (season,),
    ).fetchone()
    rate_season = safe_int(season_row[0], season) if season_row else season
    out: Dict[str, Dict[int, int]] = {}
    for row in conn.execute(
        """
        SELECT positional_grouping, extensionrate_1yr, extensionrate_2yr
        FROM conformance_extensions
        WHERE season = ?
        """,
        (rate_season,),
    ).fetchall():
        pos_group = normalize_pos_group(row[0])
        out[pos_group] = {
            1: safe_int(row[1], 0),
            2: safe_int(row[2], 0),
        }
    return out


def load_roster_snapshot(conn, season: int) -> Dict[str, Dict[str, Any]]:
    week_row = conn.execute(
        "SELECT MAX(week) FROM rosters_current WHERE season = ?",
        (season,),
    ).fetchone()
    week = safe_int(week_row[0], 0) if week_row else 0
    out: Dict[str, Dict[str, Any]] = {}
    for row in conn.execute(
        """
        SELECT
          player_id,
          COALESCE(player_name, '') AS player_name,
          COALESCE(franchise_id, '') AS franchise_id,
          COALESCE(team_name, '') AS team_name,
          COALESCE(position, '') AS position,
          COALESCE(status, '') AS roster_status,
          COALESCE(salary, 0) AS salary,
          COALESCE(contract_year, 0) AS contract_year,
          COALESCE(contract_status, '') AS contract_status,
          COALESCE(contract_info, '') AS contract_info
        FROM rosters_current
        WHERE season = ? AND week = ?
        """,
        (season, week),
    ).fetchall():
        pid = safe_str(row[0])
        if not pid:
            continue
        out[pid] = {
            "player_id": pid,
            "player_name": safe_str(row[1]),
            "franchise_id": pad4(row[2]),
            "team_name": safe_str(row[3]),
            "position": safe_str(row[4]),
            "roster_status": safe_str(row[5]),
            "salary": safe_int(row[6], 0),
            "contract_year": safe_int(row[7], 0),
            "contract_status": safe_str(row[8]),
            "contract_info": safe_str(row[9]),
        }
    return out


def build_preview_contract_info(
    salary_now: int,
    ext_salary: int,
    years_to_add: int,
    ext_tokens: list[str],
    guarantee: int,
) -> str:
    year_salaries = [salary_now] + [ext_salary] * years_to_add
    total_years = len(year_salaries)
    tcv = sum(year_salaries)
    year_parts = ", ".join(f"Y{i + 1}-{format_k(v)}" for i, v in enumerate(year_salaries))
    info = [
        f"CL {total_years}",
        f"TCV {format_k(tcv)}",
        f"AAV {format_k(salary_now)}, {format_k(ext_salary)}",
        year_parts,
        f"Ext: {', '.join(ext_tokens)}",
        f"GTD: {format_k(guarantee)}",
    ]
    return "|".join(info)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--base-season", type=int, required=True)
    parser.add_argument("--target-season", type=int, required=True)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    try:
        base_rows = load_roster_snapshot(conn, args.base_season)
        target_rows = load_roster_snapshot(conn, args.target_season)
        team_meta = load_team_meta(conn, args.base_season)
        extension_lookup = load_extension_lookup(conn, args.base_season)
        extension_rates = load_extension_rates(conn, args.base_season)
        existing = {
            (safe_str(row[0]), safe_str(row[1]).upper())
            for row in conn.execute(
                """
                SELECT player_id, extension_term
                FROM extension_previews
                WHERE nfl_season = ?
                """,
                (args.target_season,),
            ).fetchall()
        }

        preview_ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        inserted = 0
        player_count = 0

        for pid, target in target_rows.items():
            base = base_rows.get(pid)
            if not base:
                continue
            if safe_int(base.get("contract_year"), 0) != 1 or safe_int(target.get("contract_year"), 0) != 0:
                continue
            if safe_str(target.get("roster_status")).upper() not in {"ROSTER", "INJURED_RESERVE"}:
                continue

            lineage = resolve_extension_lineage(
                target.get("contract_info"),
                target.get("franchise_id"),
                extension_lookup,
            )
            last_ext_fid = pad4(lineage.get("last_extension_franchise_id"))
            current_fid = pad4(target.get("franchise_id"))
            if not last_ext_fid or last_ext_fid == current_fid:
                continue

            salary_now = safe_int(target.get("salary"), 0)
            pos_group = normalize_pos_group(target.get("position"))
            rates = extension_rates.get(pos_group) or extension_rates.get("DB") or {1: 0, 2: 0}
            if salary_now <= 0 or safe_int(rates.get(1), 0) <= 0:
                continue

            current_team = team_meta.get(current_fid, {})
            current_abbrev = safe_str(current_team.get("abbrev")) or safe_str(target.get("team_name")) or current_fid
            ext_tokens = parse_extension_tokens(target.get("contract_info"))
            if current_abbrev and normalize_ext_token(current_abbrev) not in {
                normalize_ext_token(token) for token in ext_tokens
            }:
                ext_tokens.append(current_abbrev)

            inserted_for_player = 0
            for years_to_add, term in ((1, "1YR"), (2, "2YR")):
                if (pid, term) in existing:
                    continue
                raise_amt = safe_int(rates.get(years_to_add), 0)
                if raise_amt <= 0:
                    continue
                ext_salary = round_to_k(salary_now + raise_amt)
                year_salaries = [salary_now] + [ext_salary] * years_to_add
                tcv = sum(year_salaries)
                guarantee = round(tcv * 0.75) if tcv > 4000 else max(0, tcv - salary_now)
                contract_info = build_preview_contract_info(
                    salary_now=salary_now,
                    ext_salary=ext_salary,
                    years_to_add=years_to_add,
                    ext_tokens=ext_tokens,
                    guarantee=guarantee,
                )
                conn.execute(
                    """
                    INSERT INTO extension_previews (
                      nfl_season,
                      franchise_id,
                      player_id,
                      preview_ts,
                      extension_term,
                      loaded_indicator,
                      y1_salary,
                      y2_salary,
                      y3_salary,
                      new_contract_length,
                      new_TCV,
                      new_aav_current,
                      new_aav_future,
                      new_contract_guarantee,
                      new_contract_status,
                      new_extension_history_json,
                      preview_contract_info_string,
                      success,
                      franchise_name,
                      player_name,
                      position,
                      committed,
                      reverted
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, 0)
                    """,
                    (
                        args.target_season,
                        current_fid,
                        pid,
                        preview_ts,
                        term,
                        "NONE",
                        salary_now,
                        ext_salary,
                        ext_salary if years_to_add == 2 else None,
                        len(year_salaries),
                        tcv,
                        salary_now,
                        ext_salary,
                        guarantee,
                        f"EXT{years_to_add}",
                        json.dumps(ext_tokens),
                        contract_info,
                        safe_str(target.get("team_name")),
                        safe_str(target.get("player_name")),
                        safe_str(target.get("position")),
                    ),
                )
                existing.add((pid, term))
                inserted += 1
                inserted_for_player += 1

            if inserted_for_player:
                player_count += 1

        conn.commit()
        print(json.dumps({"players_backfilled": player_count, "preview_rows_inserted": inserted}))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
