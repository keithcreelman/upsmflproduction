#!/usr/bin/env python3
"""Build compact roster points history JSON for current roster players."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
if str(ETL_ROOT) not in sys.path:
    sys.path.insert(0, str(ETL_ROOT))

from lib.weekly_classification import (  # noqa: E402
    POS_BUCKET_CODE_TO_LABEL,
    compute_pos_week_score,
    pos_bucket_code,
)

DEFAULT_DB_PATH = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))
DEFAULT_OUT_PATH = ROOT_DIR / "site" / "rosters" / "player_points_history.json"

POS_ROLLUP_SPLITS = ("all", "started", "benched")
POS_ROLLUP_COUNT_ORDER = ("elite", "plus", "neutral", "dud")
YEARLY_BASE_FIELDS = ["points", "games", "ppg", "pos_rank", "ppg_rank", "elite_weeks", "elite_weeks_pos"]
YEARLY_POS_ROLLUP_FIELDS = [
    "pos_score_all",
    "pos_score_started",
    "pos_score_benched",
    "pos_elite_weeks_all",
    "pos_plus_weeks_all",
    "pos_neutral_weeks_all",
    "pos_dud_weeks_all",
    "pos_elite_weeks_started",
    "pos_plus_weeks_started",
    "pos_neutral_weeks_started",
    "pos_dud_weeks_started",
    "pos_elite_weeks_benched",
    "pos_plus_weeks_benched",
    "pos_neutral_weeks_benched",
    "pos_dud_weeks_benched",
]
WEEKLY_FIELDS = [
    "points",
    "pos_rank",
    "started",
    "elite_week",
    "elite_week_pos",
    "pos_week_score",
    "pos_bucket",
]


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


def init_pos_rollup() -> Dict[str, Any]:
    return {
        "score": {split: 0.0 for split in POS_ROLLUP_SPLITS},
        "count": {
            split: {label: 0 for label in POS_ROLLUP_COUNT_ORDER}
            for split in POS_ROLLUP_SPLITS
        },
    }


def update_pos_rollup(rollup: Dict[str, Any], score: Optional[float], bucket: Optional[int], started: bool) -> None:
    if rollup is None or score is None or bucket is None:
        return
    split = "started" if started else "benched"
    bucket_label = POS_BUCKET_CODE_TO_LABEL.get(bucket)
    if not bucket_label:
        return
    rollup["score"]["all"] += score
    rollup["score"][split] += score
    rollup["count"]["all"][bucket_label] += 1
    rollup["count"][split][bucket_label] += 1


def flatten_pos_rollup(rollup: Optional[Dict[str, Any]]) -> List[Any]:
    if not rollup:
        return [0.0, 0.0, 0.0] + [0] * 12

    flat: List[Any] = [
        round(safe_float(rollup["score"]["all"], 0.0), 3),
        round(safe_float(rollup["score"]["started"], 0.0), 3),
        round(safe_float(rollup["score"]["benched"], 0.0), 3),
    ]
    for split in POS_ROLLUP_SPLITS:
        for label in POS_ROLLUP_COUNT_ORDER:
            flat.append(safe_int(rollup["count"][split][label], 0))
    return flat


def blank_yearly_row() -> List[Any]:
    return [0.0, 0, 0.0, 0, 0, 0, 0]


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
    return max(
        fetch_scalar(cur, "SELECT MAX(season) FROM player_pointssummary"),
        fetch_scalar(cur, "SELECT MAX(season) FROM player_weeklyscoringresults"),
    )


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
) -> List[Tuple[int, str, str, str, int, float, float, int, int, int, int]]:
    cur.execute(
        """
        SELECT
            pps.season,
            CAST(pps.player_id AS TEXT) AS player_id,
            COALESCE(pps.player_name, ''),
            COALESCE(pps.position, ''),
            COALESCE(pps.games_played, 0),
            COALESCE(pps.points_total, 0),
            COALESCE(pps.ppg, 0),
            COALESCE(pps.pos_rank, 0),
            COALESCE(pps.pos_ppg_rank, 0),
            COALESCE(psd.elite_weeks, 0),
            COALESCE(psd.elite_weeks_pos, 0)
        FROM player_pointssummary pps
        LEFT JOIN player_season_dominance psd
          ON psd.season = pps.season
         AND CAST(psd.player_id AS TEXT) = CAST(pps.player_id AS TEXT)
        WHERE pps.season BETWEEN ? AND ?
          AND CAST(pps.player_id AS TEXT) IN (SELECT player_id FROM _selected_roster_players)
        ORDER BY pps.season, pps.player_id
        """,
        (start_season, end_season),
    )
    return list(cur.fetchall())


def load_weekly_history(
    cur: sqlite3.Cursor, start_season: int, end_season: int
) -> List[Tuple[Any, ...]]:
    cur.execute(
        """
        WITH selected_weekly AS (
            SELECT
                pwsr.season,
                pwsr.week,
                CAST(pwsr.player_id AS TEXT) AS player_id,
                COALESCE(pwsr.player_name, '') AS player_name,
                COALESCE(pwsr.position, '') AS position,
                COALESCE(pwsr.pos_group, '') AS pos_group,
                COALESCE(pwsr.score, 0) AS score,
                COALESCE(pwsr.pos_rank, 0) AS pos_rank,
                COALESCE(pwsr.status, '') AS status,
                COALESCE(pwsr.elite_week, 0) AS elite_week,
                COALESCE(pwsr.elite_week_pos, 0) AS elite_week_pos,
                pwsr.win_chunks_pos_vam AS stored_pos_week_score
            FROM player_weeklyscoringresults pwsr
            WHERE pwsr.season BETWEEN ? AND ?
              AND CAST(pwsr.player_id AS TEXT) IN (SELECT player_id FROM _selected_roster_players)
        )
        SELECT
            sw.season,
            sw.week,
            sw.player_id,
            sw.player_name,
            sw.position,
            sw.pos_group,
            sw.score,
            sw.pos_rank,
            sw.status,
            sw.elite_week,
            sw.elite_week_pos,
            sw.stored_pos_week_score,
            wpb.median_starter_score,
            pwp.delta_win_pos AS season_delta_win_pos
        FROM selected_weekly sw
        LEFT JOIN metadata_weeklypositionalbaselines wpb
          ON wpb.season = sw.season
         AND wpb.week = sw.week
         AND COALESCE(wpb.pos_group, '') = sw.pos_group
        LEFT JOIN metadata_positionalwinprofile pwp
          ON pwp.season = sw.season
         AND COALESCE(pwp.pos_group, '') = sw.pos_group
        ORDER BY sw.season, sw.week, sw.player_id
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
    yearly_pos_rollups: Dict[str, Dict[str, Dict[str, Any]]] = {}

    for (
        season,
        player_id,
        player_name,
        position,
        games_played,
        points_total,
        ppg,
        pos_rank,
        pos_ppg_rank,
        elite_weeks,
        elite_weeks_pos,
    ) in yearly_rows:
        pid = safe_str(player_id)
        if pid not in players:
            players[pid] = {"n": safe_str(player_name), "p": safe_str(position).upper(), "y": {}, "w": {}}
        else:
            if not safe_str(players[pid].get("n")) and safe_str(player_name):
                players[pid]["n"] = safe_str(player_name)
            if not safe_str(players[pid].get("p")) and safe_str(position):
                players[pid]["p"] = safe_str(position).upper()
        season_key = safe_str(season)
        seasons_with_data.add(season_key)
        players[pid]["y"][season_key] = [
            round(safe_float(points_total), 1),
            safe_int(games_played, 0),
            round(safe_float(ppg), 3),
            safe_int(pos_rank, 0),
            safe_int(pos_ppg_rank, 0),
            safe_int(elite_weeks, 0),
            safe_int(elite_weeks_pos, 0),
        ]

    for (
        season,
        week,
        player_id,
        player_name,
        position,
        _pos_group,
        score,
        pos_rank,
        status,
        elite_week,
        elite_week_pos,
        stored_pos_week_score,
        median_starter_score,
        season_delta_win_pos,
    ) in weekly_rows:
        pid = safe_str(player_id)
        if pid not in players:
            players[pid] = {"n": safe_str(player_name), "p": safe_str(position).upper(), "y": {}, "w": {}}
        else:
            if not safe_str(players[pid].get("n")) and safe_str(player_name):
                players[pid]["n"] = safe_str(player_name)
            if not safe_str(players[pid].get("p")) and safe_str(position):
                players[pid]["p"] = safe_str(position).upper()
        season_key = safe_str(season)
        week_key = safe_str(week)
        seasons_with_data.add(season_key)
        pos_week_score = compute_pos_week_score(
            score,
            median_starter_score,
            season_delta_win_pos,
            stored_pos_week_score,
        )
        pos_bucket = pos_bucket_code(pos_week_score)
        started = 1 if safe_str(status).lower() == "starter" else 0
        season_weeks = players[pid]["w"].setdefault(season_key, {})
        season_weeks[week_key] = [
            round(safe_float(score), 1),
            safe_int(pos_rank, 0),
            started,
            safe_int(elite_week, 0),
            safe_int(elite_week_pos, 0),
            round(pos_week_score, 3) if pos_week_score is not None else None,
            pos_bucket,
        ]
        player_rollups = yearly_pos_rollups.setdefault(pid, {})
        season_rollup = player_rollups.setdefault(season_key, init_pos_rollup())
        update_pos_rollup(season_rollup, pos_week_score, pos_bucket, started == 1)

    for pid, player in players.items():
        yearly_map = player.setdefault("y", {})
        season_keys = set(yearly_map.keys())
        if pid in yearly_pos_rollups:
            season_keys.update(yearly_pos_rollups[pid].keys())
        for season_key in sorted(season_keys, key=lambda value: safe_int(value, 0)):
            base_row = yearly_map.get(season_key)
            if base_row is None:
                base_row = blank_yearly_row()
                yearly_map[season_key] = base_row
            elif len(base_row) > len(YEARLY_BASE_FIELDS):
                base_row = base_row[: len(YEARLY_BASE_FIELDS)]
                yearly_map[season_key] = base_row
            rollup = yearly_pos_rollups.get(pid, {}).get(season_key)
            yearly_map[season_key] = base_row + flatten_pos_rollup(rollup)

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
            "yearly_fields": YEARLY_BASE_FIELDS + YEARLY_POS_ROLLUP_FIELDS,
            "weekly_fields": WEEKLY_FIELDS,
            "pos_bucket_codes": POS_BUCKET_CODE_TO_LABEL,
            "pos_bucket_thresholds": {
                "elite_min": 1.0,
                "plus_min": 0.25,
                "neutral_min": -0.5,
            },
            "source_tables": [
                "rosters_current",
                "player_pointssummary",
                "player_weeklyscoringresults",
                "player_season_dominance",
                "metadata_weeklypositionalbaselines",
                "metadata_positionalwinprofile",
            ],
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
