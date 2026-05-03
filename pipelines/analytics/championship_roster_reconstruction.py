#!/usr/bin/env python3
"""
Championship roster reconstruction (corrected).

Source of truth: rosters_weekly + weeklyresults (per docs/league-context/data_sources_master.md).

Outputs:
  - site/rookies/championship_rosters_full.csv   — every (season, champion, player) row with starts/points/salary
  - site/rookies/championship_rosters_summary.json — per-season summary (top starters, cap dist, position breakdown)

NO external crosswalks needed — the MFL DB already has everything joined.
"""

from __future__ import annotations

import csv
import json
import os
import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = os.getenv(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Documents/New project/mfl_database.db",
)

REPO_ROOT = Path(__file__).resolve().parents[2]
OUT_CSV = REPO_ROOT / "site" / "rookies" / "championship_rosters_full.csv"
OUT_JSON = REPO_ROOT / "site" / "rookies" / "championship_rosters_summary.json"

# SF + TEP era boundaries
ERAS = {
    range(2010, 2022): "1QB",
    range(2022, 2025): "SF",
    range(2025, 2027): "SF_TEP",
}

# UPS lineup (per claude_canonical_rules.md / UPS_Master_Rulebook.html):
# 1 QB, 2 RB, 2 WR, 1 TE, 2 FLEX, 1 SuperFlex, 1 K, 1 P, 2 DL, 2 LB, 2 DB, 1 Def Flex
OFFENSIVE_POS = {"QB", "RB", "WR", "TE"}
KICKER_POS = {"PK", "K"}
PUNTER_POS = {"PN", "P"}
IDP_POS = {"DE", "DT", "LB", "S", "CB", "DB"}


def era_for(season: int) -> str:
    for r, label in ERAS.items():
        if season in r:
            return label
    return "unknown"


def find_champions(con: sqlite3.Connection, min_season: int = 2017) -> list[dict[str, Any]]:
    """Return champion (season, franchise_id, team_name, final_score) for each season."""
    rows = con.execute(
        """
        WITH max_playoff AS (
          SELECT season, MAX(week) AS final_week
          FROM weeklyresults WHERE is_playoff=1
          GROUP BY season
        ),
        finals AS (
          SELECT wr.season, wr.week, wr.franchise_id, wr.result, wr.team_score
          FROM weeklyresults wr
          JOIN max_playoff mp ON mp.season=wr.season AND mp.final_week=wr.week
          WHERE wr.is_playoff=1
          GROUP BY wr.season, wr.week, wr.franchise_id
        ),
        ranked AS (
          SELECT season, franchise_id, team_score,
            ROW_NUMBER() OVER (PARTITION BY season ORDER BY team_score DESC) AS rn
          FROM finals WHERE result='W'
        )
        SELECT r.season, r.franchise_id,
               COALESCE((SELECT team_name FROM rosters_weekly rw
                          WHERE rw.season=r.season AND rw.franchise_id=r.franchise_id
                          LIMIT 1), 'unknown') AS team_name,
               ROUND(r.team_score, 1) AS final_score
        FROM ranked r
        WHERE r.rn=1 AND r.season >= ?
        ORDER BY r.season
        """,
        (min_season,),
    ).fetchall()

    return [
        {"season": s, "franchise_id": fid, "team_name": tn, "final_score": fs}
        for (s, fid, tn, fs) in rows
    ]


def champion_starter_rows(con: sqlite3.Connection, season: int, fid: str) -> list[dict[str, Any]]:
    """Per-player starter rows for a champion's season. Aggregated across all weeks they started."""
    rows = con.execute(
        """
        SELECT
          wr.player_id,
          COALESCE(rw.player_name, '?') AS player_name,
          COALESCE(rw.position, '?') AS position,
          COALESCE(rw.nfl_team, '?') AS nfl_team,
          COUNT(DISTINCT wr.week) AS weeks_started,
          SUM(CASE WHEN wr.is_playoff=1 THEN 1 ELSE 0 END) AS playoff_weeks_started,
          ROUND(SUM(wr.player_score), 1) AS total_pts_started,
          ROUND(SUM(CASE WHEN wr.is_playoff=1 THEN wr.player_score ELSE 0 END), 1) AS playoff_pts_started,
          ROUND(AVG(wr.player_score), 2) AS ppg_started,
          CAST(ROUND(AVG(rw.salary)) AS INTEGER) AS avg_salary,
          MIN(rw.contract_year) AS min_contract_year,
          MAX(rw.contract_year) AS max_contract_year,
          (SELECT contract_status FROM rosters_weekly rw2
            WHERE rw2.season=wr.season AND rw2.franchise_id=wr.franchise_id
              AND rw2.player_id=wr.player_id
            ORDER BY rw2.week DESC LIMIT 1) AS contract_status_last
        FROM weeklyresults wr
        LEFT JOIN rosters_weekly rw
          ON rw.season=wr.season AND rw.week=wr.week
          AND rw.franchise_id=wr.franchise_id AND rw.player_id=wr.player_id
        WHERE wr.season=? AND wr.franchise_id=? AND wr.status='starter'
        GROUP BY wr.player_id, rw.player_name, rw.position, rw.nfl_team
        ORDER BY total_pts_started DESC
        """,
        (season, fid),
    ).fetchall()

    cols = [
        "player_id", "player_name", "position", "nfl_team",
        "weeks_started", "playoff_weeks_started",
        "total_pts_started", "playoff_pts_started", "ppg_started",
        "avg_salary", "min_contract_year", "max_contract_year",
        "contract_status_last",
    ]
    return [dict(zip(cols, r)) for r in rows]


def summarize(season: int, fid: str, team_name: str, final_score: float, rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Build a per-champion summary."""
    era = era_for(season)

    # Position-level rollups
    pos_groups: dict[str, list[dict[str, Any]]] = {}
    for r in rows:
        pos = r["position"]
        bucket = "OFF" if pos in OFFENSIVE_POS else ("K" if pos in KICKER_POS else ("P" if pos in PUNTER_POS else ("IDP" if pos in IDP_POS else "OTH")))
        key = f"{pos}"
        pos_groups.setdefault(key, []).append(r)

    # Top starters (≥6 weeks started — meaningful contributor)
    core_starters = [r for r in rows if r["weeks_started"] >= 6 and r["position"] in OFFENSIVE_POS]
    core_starters.sort(key=lambda x: -x["total_pts_started"])

    # QB room (SF-relevant) — every QB that started any week
    qb_room = sorted(
        [r for r in rows if r["position"] == "QB"],
        key=lambda x: -x["total_pts_started"],
    )

    # TE room
    te_room = sorted(
        [r for r in rows if r["position"] == "TE"],
        key=lambda x: -x["total_pts_started"],
    )

    # Cap allocation across core starters
    cap_by_pos: dict[str, int] = {}
    for r in core_starters:
        cap_by_pos[r["position"]] = cap_by_pos.get(r["position"], 0) + (r["avg_salary"] or 0)

    return {
        "season": season,
        "franchise_id": fid,
        "team_name": team_name,
        "era": era,
        "final_score": final_score,
        "core_starters_count": len(core_starters),
        "core_starters": [
            {
                "player_name": r["player_name"],
                "position": r["position"],
                "weeks_started": r["weeks_started"],
                "playoff_weeks_started": r["playoff_weeks_started"],
                "total_pts": r["total_pts_started"],
                "ppg": r["ppg_started"],
                "salary": r["avg_salary"],
                "contract_status": r["contract_status_last"],
            }
            for r in core_starters
        ],
        "qb_room": [
            {"player_name": r["player_name"], "weeks_started": r["weeks_started"],
             "total_pts": r["total_pts_started"], "ppg": r["ppg_started"], "salary": r["avg_salary"]}
            for r in qb_room
        ],
        "te_room": [
            {"player_name": r["player_name"], "weeks_started": r["weeks_started"],
             "total_pts": r["total_pts_started"], "ppg": r["ppg_started"], "salary": r["avg_salary"]}
            for r in te_room
        ],
        "core_cap_by_position": cap_by_pos,
        "core_total_cap": sum(cap_by_pos.values()),
    }


def main() -> int:
    if not Path(DB_PATH).exists():
        print(f"DB not found at {DB_PATH}")
        return 1

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)

    with sqlite3.connect(DB_PATH) as con:
        champions = find_champions(con, min_season=2017)
        print(f"Champions found: {len(champions)}")

        all_rows: list[dict[str, Any]] = []
        summaries: list[dict[str, Any]] = []

        for ch in champions:
            rows = champion_starter_rows(con, ch["season"], ch["franchise_id"])
            for r in rows:
                r2 = {
                    "season": ch["season"],
                    "franchise_id": ch["franchise_id"],
                    "team_name": ch["team_name"],
                    "era": era_for(ch["season"]),
                    **r,
                }
                all_rows.append(r2)

            summaries.append(summarize(ch["season"], ch["franchise_id"], ch["team_name"], ch["final_score"], rows))
            print(f"  {ch['season']} {ch['team_name']:30s}  {len(rows):3d} starter-players, {sum(1 for r in rows if r['weeks_started']>=6 and r['position'] in OFFENSIVE_POS)} core offensive starters")

    # Write CSV
    if all_rows:
        with OUT_CSV.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(all_rows[0].keys()))
            w.writeheader()
            w.writerows(all_rows)
        print(f"\nWrote {len(all_rows)} rows → {OUT_CSV}")

    # Write JSON summary
    with OUT_JSON.open("w") as f:
        json.dump(
            {
                "meta": {
                    "source": "rosters_weekly + weeklyresults (MFL DB iCloud)",
                    "filter": "champion of each season 2017-2025, starter weeks only",
                    "lineup": "1QB / 2RB / 2WR / 1TE / 2FLEX / 1SF / K / P / 2DL / 2LB / 2DB / 1DefFlex (UPS)",
                    "core_starter_def": "weeks_started >= 6 AND position in {QB,RB,WR,TE}",
                },
                "champions": summaries,
            },
            f,
            indent=2,
        )
    print(f"Wrote summary JSON → {OUT_JSON}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
