#!/usr/bin/env python3
"""Build compact roster points history JSON for current roster players."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_DB_PATH = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))
DEFAULT_OUT_PATH = ROOT_DIR / "site" / "rosters" / "player_points_history.json"


def safe_int(value: Any, default: int = 0) -> int:
    try:
        if value is None:
            return default
        return int(float(str(value).strip()))
    except (TypeError, ValueError):
        return default


def safe_float(value: Any, default: float = 0.0) -> float:
    try:
        if value is None:
            return default
        return float(str(value).strip())
    except (TypeError, ValueError):
        return default


def safe_str(value: Any) -> str:
    return "" if value is None else str(value).strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--out-path", default=str(DEFAULT_OUT_PATH))
    parser.add_argument("--roster-season", type=int, default=0)
    parser.add_argument("--history-start-season", type=int, default=2010)
    parser.add_argument("--history-end-season", type=int, default=0)
    return parser.parse_args()


def fetch_scalar(cur: sqlite3.Cursor, sql: str, params: Iterable[Any] = ()) -> int:
    cur.execute(sql, tuple(params))
    row = cur.fetchone()
    if not row:
        return 0
    return safe_int(row[0], 0)


def resolve_roster_season(cur: sqlite3.Cursor, requested: int) -> int:
    if requested > 0:
        return requested
    return fetch_scalar(cur, "SELECT MAX(season) FROM rosters_current")


def resolve_history_end(cur: sqlite3.Cursor, requested: int) -> int:
    if requested > 0:
        return requested
    return fetch_scalar(cur, "SELECT MAX(season) FROM player_pointssummary")


def load_roster_players(cur: sqlite3.Cursor, roster_season: int) -> Dict[str, Dict[str, str]]:
    cur.execute(
        """
        SELECT
            CAST(player_id AS TEXT) AS player_id,
            MAX(COALESCE(player_name, '')) AS player_name,
            MAX(COALESCE(position, '')) AS position
        FROM rosters_current
        WHERE season = ?
        GROUP BY player_id
        ORDER BY player_id
        """,
        (roster_season,),
    )
    players: Dict[str, Dict[str, str]] = {}
    for player_id, player_name, position in cur.fetchall():
        pid = safe_str(player_id)
        if not pid:
            continue
        players[pid] = {
            "n": safe_str(player_name),
            "p": safe_str(position).upper(),
            "y": {},
            "w": {},
        }
    return players


def populate_selected_players(conn: sqlite3.Connection, player_ids: Iterable[str]) -> None:
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS _selected_roster_players")
    cur.execute("CREATE TEMP TABLE _selected_roster_players (player_id TEXT PRIMARY KEY)")
    cur.executemany(
        "INSERT INTO _selected_roster_players (player_id) VALUES (?)",
        [(safe_str(pid),) for pid in player_ids if safe_str(pid)],
    )
    conn.commit()


def load_yearly_history(
    cur: sqlite3.Cursor, start_season: int, end_season: int
) -> List[Tuple[int, str, str, str, int, float, float, int, int]]:
    cur.execute(
        """
        SELECT
            season,
            CAST(player_id AS TEXT) AS player_id,
            COALESCE(player_name, ''),
            COALESCE(position, ''),
            COALESCE(games_played, 0),
            COALESCE(points_total, 0),
            COALESCE(ppg, 0),
            COALESCE(pos_rank, 0),
            COALESCE(pos_ppg_rank, 0)
        FROM player_pointssummary
        WHERE season BETWEEN ? AND ?
          AND CAST(player_id AS TEXT) IN (SELECT player_id FROM _selected_roster_players)
        ORDER BY season, player_id
        """,
        (start_season, end_season),
    )
    return list(cur.fetchall())


def load_weekly_history(
    cur: sqlite3.Cursor, start_season: int, end_season: int
) -> List[Tuple[int, int, str, str, str, float, int, str]]:
    cur.execute(
        """
        SELECT
            season,
            week,
            CAST(player_id AS TEXT) AS player_id,
            COALESCE(player_name, ''),
            COALESCE(position, ''),
            COALESCE(score, 0),
            COALESCE(pos_rank, 0),
            COALESCE(status, '')
        FROM player_weeklyscoringresults
        WHERE season BETWEEN ? AND ?
          AND CAST(player_id AS TEXT) IN (SELECT player_id FROM _selected_roster_players)
        ORDER BY season, week, player_id
        """,
        (start_season, end_season),
    )
    return list(cur.fetchall())


def load_season_week_max(cur: sqlite3.Cursor, start_season: int, end_season: int) -> Dict[str, int]:
    cur.execute(
        """
        SELECT season, MAX(week)
        FROM player_weeklyscoringresults
        WHERE season BETWEEN ? AND ?
        GROUP BY season
        ORDER BY season
        """,
        (start_season, end_season),
    )
    out: Dict[str, int] = {}
    for season, max_week in cur.fetchall():
        season_key = safe_str(season)
        if not season_key:
            continue
        out[season_key] = safe_int(max_week, 0)
    return out


def main() -> int:
    args = parse_args()
    conn = sqlite3.connect(str(args.db_path))
    try:
        cur = conn.cursor()
        roster_season = resolve_roster_season(cur, safe_int(args.roster_season, 0))
        history_start = max(0, safe_int(args.history_start_season, 2010))
        history_end = resolve_history_end(cur, safe_int(args.history_end_season, 0))
        if history_end and history_end < history_start:
            history_end = history_start

        players = load_roster_players(cur, roster_season)
        populate_selected_players(conn, players.keys())

        yearly_rows = load_yearly_history(cur, history_start, history_end)
        weekly_rows = load_weekly_history(cur, history_start, history_end)
        season_week_max = load_season_week_max(cur, history_start, history_end)
    finally:
        conn.close()

    seasons_with_data = set()

    for season, player_id, player_name, position, games_played, points_total, ppg, pos_rank, pos_ppg_rank in yearly_rows:
        pid = safe_str(player_id)
        if pid not in players:
            players[pid] = {"n": safe_str(player_name), "p": safe_str(position).upper(), "y": {}, "w": {}}
        season_key = safe_str(season)
        seasons_with_data.add(season_key)
        players[pid]["y"][season_key] = [
            round(safe_float(points_total), 1),
            safe_int(games_played, 0),
            round(safe_float(ppg), 3),
            safe_int(pos_rank, 0),
            safe_int(pos_ppg_rank, 0),
        ]

    for season, week, player_id, player_name, position, score, pos_rank, status in weekly_rows:
        pid = safe_str(player_id)
        if pid not in players:
            players[pid] = {"n": safe_str(player_name), "p": safe_str(position).upper(), "y": {}, "w": {}}
        season_key = safe_str(season)
        week_key = safe_str(week)
        seasons_with_data.add(season_key)
        season_weeks = players[pid]["w"].setdefault(season_key, {})
        season_weeks[week_key] = [
            round(safe_float(score), 1),
            safe_int(pos_rank, 0),
            1 if safe_str(status).lower() == "starter" else 0,
        ]

    history_seasons = sorted(
        [safe_int(season, 0) for season in seasons_with_data if safe_int(season, 0) > 0]
    )
    out_doc = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "roster_season": roster_season,
            "history_start_season": history_start,
            "history_end_season": history_end,
            "history_seasons": history_seasons,
            "season_week_max": season_week_max,
            "player_count": len(players),
            "yearly_fields": ["points", "games", "ppg", "pos_rank", "ppg_rank"],
            "weekly_fields": ["points", "pos_rank", "started"],
            "source_tables": ["rosters_current", "player_pointssummary", "player_weeklyscoringresults"],
        },
        "players": players,
    }

    out_path = Path(args.out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out_doc, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out_path} ({len(players)} players, {len(yearly_rows)} yearly rows, {len(weekly_rows)} weekly rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
