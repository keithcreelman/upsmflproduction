#!/usr/bin/env python3
"""Build static JSON artifacts for the Reports Module player scoring report."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_DB_PATH = Path(os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db")))
DEFAULT_OUT_DIR = ROOT_DIR / "site" / "reports" / "player_scoring"
DEFAULT_SQL_PATH = DEFAULT_OUT_DIR / "player_scoring_sql.sql"
DEFAULT_ELITE_THRESHOLD = 75
DEFAULT_DUD_THRESHOLD = 25
WEEKLY_SCHEMA = [
    "week",
    "score",
    "weekly_vam",
    "usage_status_code",
    "season_roster_status_code",
    "season_franchise_id",
    "position_week_rank",
    "position_week_player_count",
    "position_week_percentile",
    "position_week_percent_rank",
]
USAGE_STATUS_LOOKUP = ["starter", "nonstarter", "fa"]
USAGE_STATUS_CODES = {value: index for index, value in enumerate(USAGE_STATUS_LOOKUP)}
ROSTER_STATUS_LOOKUP = ["ROSTER", "TAXI_SQUAD", "INJURED_RESERVE", "FA"]
ROSTER_STATUS_CODES = {value: index for index, value in enumerate(ROSTER_STATUS_LOOKUP)}
REQUIRED_SOURCE_TABLES = (
    "player_weeklyscoringresults",
    "dim_player",
    "rosters_current",
    "player_season_dominance",
    "transactions_adddrop",
)


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


def rounded(value: Any, digits: int = 3) -> float:
    return round(safe_float(value, 0.0), digits)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=str(DEFAULT_DB_PATH))
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--sql-path", default=str(DEFAULT_SQL_PATH))
    parser.add_argument("--min-season", type=int)
    parser.add_argument("--max-season", type=int)
    return parser.parse_args()


def load_sql(sql_path: Path) -> str:
    return sql_path.read_text(encoding="utf-8")


def query_rows(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> List[sqlite3.Row]:
    cur = conn.execute(sql, tuple(params))
    return list(cur.fetchall())


def ensure_inputs(db_path: Path, sql_path: Path) -> None:
    if not db_path.is_file():
        raise SystemExit(f"Player scoring report export requires a SQLite DB at {db_path}")
    if not sql_path.is_file():
        raise SystemExit(f"Player scoring report export requires SQL definitions at {sql_path}")


def ensure_source_tables(conn: sqlite3.Connection) -> None:
    rows = query_rows(
        conn,
        """
        SELECT name
        FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name IN ({})
        ORDER BY name
        """.format(", ".join("?" for _ in REQUIRED_SOURCE_TABLES)),
        REQUIRED_SOURCE_TABLES,
    )
    available = {safe_str(row["name"]) for row in rows}
    missing = [name for name in REQUIRED_SOURCE_TABLES if name not in available]
    if missing:
        raise SystemExit(
            "Player scoring report export is missing required source tables/views: "
            + ", ".join(missing)
        )


def ensure_views(conn: sqlite3.Connection, sql_path: Path) -> None:
    conn.executescript(load_sql(sql_path))
    conn.commit()


def load_available_seasons(conn: sqlite3.Connection, min_season: int | None, max_season: int | None) -> List[int]:
    clauses: List[str] = []
    params: List[Any] = []
    if min_season is not None:
        clauses.append("nfl_season >= ?")
        params.append(min_season)
    if max_season is not None:
        clauses.append("nfl_season <= ?")
        params.append(max_season)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = query_rows(
        conn,
        f"""
        SELECT DISTINCT nfl_season
        FROM report_player_scoring_summary_v1
        {where_sql}
        ORDER BY nfl_season DESC
        """,
        params,
    )
    return [safe_int(row["nfl_season"]) for row in rows if safe_int(row["nfl_season"]) > 0]


def load_current_roster_meta(conn: sqlite3.Connection) -> Dict[str, int]:
    row = conn.execute(
        """
        SELECT
          COALESCE(MAX(roster_snapshot_season), 0) AS current_roster_season,
          COALESCE(MAX(roster_snapshot_week), 0) AS current_roster_week
        FROM rosters_currentseason
        """
    ).fetchone()
    return {
        "current_roster_season": safe_int(row["current_roster_season"]) if row else 0,
        "current_roster_week": safe_int(row["current_roster_week"]) if row else 0,
    }


def load_summary_rows(conn: sqlite3.Connection, season: int) -> List[sqlite3.Row]:
    return load_summary_rows_bulk(conn, [season]).get(season, [])


def load_weekly_rows(conn: sqlite3.Connection, season: int) -> List[sqlite3.Row]:
    return load_weekly_rows_bulk(conn, [season]).get(season, [])


def build_in_clause(values: List[int]) -> tuple[str, List[int]]:
    placeholders = ", ".join("?" for _ in values)
    return placeholders, values


def load_summary_rows_bulk(conn: sqlite3.Connection, seasons: List[int]) -> Dict[int, List[sqlite3.Row]]:
    if not seasons:
        return {}
    placeholders, params = build_in_clause(seasons)
    rows = query_rows(
        conn,
        f"""
        SELECT *
        FROM report_player_scoring_summary_v1
        WHERE nfl_season IN ({placeholders})
        ORDER BY nfl_season DESC, position_group, points_per_game DESC, total_points DESC, player_name ASC
        """,
        params,
    )
    by_season: Dict[int, List[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        by_season[safe_int(row["nfl_season"])].append(row)
    return by_season


def load_weekly_rows_bulk(conn: sqlite3.Connection, seasons: List[int]) -> Dict[int, List[sqlite3.Row]]:
    if not seasons:
        return {}
    placeholders, params = build_in_clause(seasons)
    rows = query_rows(
        conn,
        f"""
        SELECT *
        FROM report_player_scoring_weekly_v1
        WHERE nfl_season IN ({placeholders})
        ORDER BY nfl_season DESC, player_id ASC, nfl_week ASC
        """,
        params,
    )
    by_season: Dict[int, List[sqlite3.Row]] = defaultdict(list)
    for row in rows:
        by_season[safe_int(row["nfl_season"])].append(row)
    return by_season


def build_weekly_lookup(rows: Iterable[sqlite3.Row]) -> tuple[Dict[str, List[List[Any]]], Dict[str, str]]:
    by_player: Dict[str, List[List[Any]]] = defaultdict(list)
    franchise_lookup: Dict[str, str] = {}
    for row in rows:
        player_id = safe_str(row["player_id"])
        usage_status = safe_str(row["season_usage_status"]) or "fa"
        roster_status = safe_str(row["season_roster_status"]) or "FA"
        franchise_id = safe_str(row["season_franchise_id"])
        franchise_name = safe_str(row["season_franchise_name"])
        if franchise_id and franchise_name:
            franchise_lookup[franchise_id] = franchise_name
        by_player[player_id].append(
            [
                safe_int(row["nfl_week"]),
                rounded(row["weekly_score"], 3),
                rounded(row["weekly_vam"], 3),
                USAGE_STATUS_CODES.get(usage_status, USAGE_STATUS_CODES["fa"]),
                ROSTER_STATUS_CODES.get(roster_status, ROSTER_STATUS_CODES["FA"]),
                franchise_id,
                safe_int(row["position_week_rank"]),
                safe_int(row["position_week_player_count"]),
                round(safe_float(row["position_week_cume_dist"]) * 100.0, 1),
                round(safe_float(row["position_week_percent_rank"]) * 100.0, 1),
            ]
        )
    return by_player, franchise_lookup


def normalize_summary_row(row: sqlite3.Row, weekly_scores: List[List[Any]]) -> Dict[str, Any]:
    franchise_name = safe_str(row["franchise_name"])
    current_roster_status = safe_str(row["current_roster_status"]) or "FREE_AGENT"
    roster_status_label = franchise_name if franchise_name else ("Free Agent" if safe_int(row["free_agent_ind"]) else current_roster_status.title())
    games_started = safe_int(row["starter_count"])
    games_benched = safe_int(row["bench_count"])
    standard_deviation = rounded(row["std_dev"], 3)
    elite_week_rate = rounded(row["boom_rate"], 1)
    dud_week_rate = rounded(row["bust_rate"], 1)
    return {
        "nfl_season": safe_int(row["nfl_season"]),
        "player_id": safe_str(row["player_id"]),
        "player_name": safe_str(row["player_name"]),
        "position": safe_str(row["position"]),
        "position_group": safe_str(row["position_group"]),
        "team": safe_str(row["team"]),
        "current_roster_season": safe_int(row["current_roster_season"]),
        "current_roster_week": safe_int(row["current_roster_week"]),
        "franchise_id": safe_str(row["franchise_id"]),
        "franchise_name": franchise_name,
        "owner_name": safe_str(row["owner_name"]),
        "current_roster_status": current_roster_status,
        "roster_status_label": roster_status_label,
        "rostered_ind": bool(safe_int(row["rostered_ind"])),
        "free_agent_ind": bool(safe_int(row["free_agent_ind"])),
        "games_played": safe_int(row["games_played"]),
        "games_started": games_started,
        "games_benched": games_benched,
        "total_points": rounded(row["total_points"], 1),
        "points_per_game": rounded(row["points_per_game"], 3),
        "median_points": rounded(row["median_points"], 3),
        "max_points": rounded(row["max_points"], 1),
        "min_points": rounded(row["min_points"], 1),
        "std_dev": rounded(row["std_dev"], 3),
        "standard_deviation": standard_deviation,
        "elite_weeks": safe_int(row["elite_weeks"]),
        "neutral_weeks": safe_int(row["neutral_weeks"]),
        "dud_weeks": safe_int(row["dud_weeks"]),
        "position_average_points_per_game": rounded(row["position_average_points_per_game"], 3),
        "vam": rounded(row["vam"], 3),
        "vam_total": rounded(row["vam_total"], 3),
        "starter_count": safe_int(row["starter_count"]),
        "bench_count": safe_int(row["bench_count"]),
        "free_agent_count": safe_int(row["free_agent_count"]),
        "positional_rank": safe_int(row["positional_rank"]),
        "percentile_rank": rounded(row["percentile_rank"], 1),
        "consistency_index": rounded(row["consistency_index"], 1),
        "boom_rate": rounded(row["boom_rate"], 1),
        "elite_week_rate": elite_week_rate,
        "bust_rate": rounded(row["bust_rate"], 1),
        "dud_week_rate": dud_week_rate,
        "dominance_total_vam": rounded(row["dominance_total_vam"], 3),
        "dominance_win_chunks_pos": rounded(row["dominance_win_chunks_pos"], 3),
        "last_transaction_season": safe_int(row["last_transaction_season"]),
        "last_move_type": safe_str(row["last_move_type"]),
        "last_move_method": safe_str(row["last_move_method"]),
        "last_transaction_franchise_id": safe_str(row["last_transaction_franchise_id"]),
        "last_transaction_franchise_name": safe_str(row["last_transaction_franchise_name"]),
        "last_transaction_date": safe_str(row["last_transaction_date"]),
        "last_transaction_datetime": safe_str(row["last_transaction_datetime"]),
        "weekly_score_count": len(weekly_scores),
    }


def unique_sorted(values: Iterable[str]) -> List[str]:
    return sorted({safe_str(value) for value in values if safe_str(value)})


def build_filter_options(players: List[Dict[str, Any]]) -> Dict[str, Any]:
    current_roster_statuses = unique_sorted(player["current_roster_status"] for player in players)
    rostered_franchises = sorted(
        (
            {
                "franchise_id": player["franchise_id"],
                "franchise_name": player["franchise_name"],
            }
            for player in players
            if player["rostered_ind"] and player["franchise_id"] and player["franchise_name"]
        ),
        key=lambda item: (item["franchise_name"], item["franchise_id"]),
    )
    deduped_franchises: List[Dict[str, str]] = []
    seen_franchises: set[str] = set()
    for item in rostered_franchises:
        franchise_id = safe_str(item["franchise_id"])
        if franchise_id in seen_franchises:
            continue
        seen_franchises.add(franchise_id)
        deduped_franchises.append(item)
    return {
        "positions": unique_sorted(player["position_group"] for player in players),
        "teams": unique_sorted(player["team"] for player in players),
        "current_roster_statuses": current_roster_statuses,
        "franchises": deduped_franchises,
    }


def build_season_document(
    season: int,
    summary_rows: List[sqlite3.Row],
    weekly_rows: List[sqlite3.Row],
    current_roster_meta: Dict[str, int],
) -> Dict[str, Any]:
    weekly_lookup, season_franchises = build_weekly_lookup(weekly_rows)
    players = [
      normalize_summary_row(row, weekly_lookup.get(safe_str(row["player_id"]), []))
      for row in summary_rows
    ]
    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "season": season,
            "row_count": len(players),
            "weekly_row_count": len(weekly_rows),
            "current_roster_season": current_roster_meta["current_roster_season"],
            "current_roster_week": current_roster_meta["current_roster_week"],
            "default_thresholds": {
                "elite_percentile": DEFAULT_ELITE_THRESHOLD,
                "dud_percentile": DEFAULT_DUD_THRESHOLD,
            },
            "summary_view": "report_player_scoring_summary_v1",
            "weekly_view": "report_player_scoring_weekly_v1",
        },
        "filters": build_filter_options(players),
        "lookups": {
            "weekly_schema": WEEKLY_SCHEMA,
            "usage_statuses": USAGE_STATUS_LOOKUP,
            "season_roster_statuses": ROSTER_STATUS_LOOKUP,
            "season_franchises": dict(sorted(season_franchises.items())),
        },
        "players": players,
        "weekly_scores_by_player": weekly_lookup,
    }


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def main() -> int:
    args = parse_args()
    db_path = Path(args.db_path).expanduser()
    out_dir = Path(args.out_dir).expanduser()
    sql_path = Path(args.sql_path).expanduser()
    ensure_inputs(db_path, sql_path)

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        ensure_source_tables(conn)
        ensure_views(conn, sql_path)
        current_roster_meta = load_current_roster_meta(conn)
        seasons = load_available_seasons(conn, args.min_season, args.max_season)
        if not seasons:
            raise SystemExit(
                "Player scoring report export found no eligible seasons after refreshing views. "
                "Confirm player scoring, dominance, and roster sources are populated."
            )
        summary_by_season = load_summary_rows_bulk(conn, seasons)
        weekly_by_season = load_weekly_rows_bulk(conn, seasons)
        manifest_seasons: List[Dict[str, Any]] = []
        for season in seasons:
            summary_rows = summary_by_season.get(season, [])
            weekly_rows = weekly_by_season.get(season, [])
            doc = build_season_document(season, summary_rows, weekly_rows, current_roster_meta)
            season_filename = f"player_scoring_{season}.json"
            write_json(out_dir / season_filename, doc)
            manifest_seasons.append(
                {
                    "season": season,
                    "path": f"./{season_filename}",
                    "row_count": len(summary_rows),
                    "weekly_row_count": len(weekly_rows),
                    "positions": doc["filters"]["positions"],
                    "teams": doc["filters"]["teams"],
                }
            )
    finally:
        conn.close()

    manifest = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "current_roster_season": current_roster_meta["current_roster_season"],
            "current_roster_week": current_roster_meta["current_roster_week"],
            "default_thresholds": {
                "elite_percentile": DEFAULT_ELITE_THRESHOLD,
                "dud_percentile": DEFAULT_DUD_THRESHOLD,
            },
            "sql_path": "./player_scoring_sql.sql",
            "data_dictionary_path": "./player_scoring_data_dictionary.md",
        },
        "seasons": manifest_seasons,
    }
    write_json(out_dir / "player_scoring_manifest.json", manifest)
    print(
        "Wrote player scoring report artifacts to"
        f" {out_dir} for {len(manifest_seasons)} season(s)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
