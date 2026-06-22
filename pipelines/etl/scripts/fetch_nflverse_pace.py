#!/usr/bin/env python3
"""Derive team PACE (plays per game) from nflverse PBP → nfl_team_pace.

For each (season, team), REG season only:
  - off_plays_pg : offensive plays per game (run+pass; the team's own pace)
  - def_plays_pg : plays the team's defense faces per game
  - pace_sos     : avg off_plays_pg of the opponents on that team's schedule
                   (the SCHEDULE ADJUSTMENT — high = faces fast opponents =
                   more total plays = more fantasy opportunity)

Opponents are read straight from the PBP (each game has posteam/defteam), so
no separate schedule fetch is needed.

Source : nflreadpy.load_pbp(seasons)
Writes : local mfl_database.db + D1 nfl_team_pace (dual-write; UPSERT by season+team)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_pace.py --seasons 2014-2025
  python3 pipelines/etl/scripts/fetch_nflverse_pace.py --seasons 2024 --skip-d1
"""
from __future__ import annotations
import argparse
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

LOCAL_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")

DDL = """
CREATE TABLE IF NOT EXISTS nfl_team_pace (
  season INTEGER NOT NULL, team TEXT NOT NULL, games INTEGER,
  off_plays_pg REAL, def_plays_pg REAL, pace_sos REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, team)
);
"""


def parse_seasons(s: str) -> list[int]:
    out = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-"); out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def compute(seasons: list[int]) -> list[tuple]:
    import nflreadpy as nfl
    pbp = nfl.load_pbp(seasons)
    df = pbp.to_pandas() if hasattr(pbp, "to_pandas") else pbp
    df = df.rename(columns={c: c.lower() for c in df.columns})
    if "season_type" in df.columns:
        df = df[df["season_type"] == "REG"]
    off = df[(df["play_type"].isin(["pass", "run"])) & (df["posteam"].notna()) & (df["defteam"].notna())]

    rows = []
    for season in sorted(set(int(s) for s in off["season"].dropna().unique())):
        s = off[off["season"] == season]
        # offensive plays + games per team
        off_plays = s.groupby("posteam").size()
        off_games = s.groupby("posteam")["game_id"].nunique()
        def_plays = s.groupby("defteam").size()
        def_games = s.groupby("defteam")["game_id"].nunique()
        off_pg = (off_plays / off_games)
        def_pg = (def_plays / def_games)
        # opponents each team faced (for the schedule adjustment)
        opp = s.groupby(["posteam", "defteam"]).size().reset_index()
        opps_by_team = {}
        for _, r in opp.iterrows():
            opps_by_team.setdefault(r["posteam"], []).append(r["defteam"])
        for team in off_pg.index:
            opps = opps_by_team.get(team, [])
            opp_paces = [off_pg[o] for o in opps if o in off_pg.index]
            pace_sos = round(float(sum(opp_paces) / len(opp_paces)), 1) if opp_paces else None
            rows.append((
                int(season), str(team), int(off_games.get(team, 0)),
                round(float(off_pg[team]), 1),
                round(float(def_pg.get(team, 0)), 1) if team in def_pg.index else None,
                pace_sos,
            ))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2014-2025", help="e.g. 2014-2025 or 2024 or 2018,2019")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()
    seasons = parse_seasons(args.seasons)
    print(f"loading PBP for {seasons} (big download)…", file=sys.stderr)
    rows = compute(seasons)
    print(f"  {len(rows)} (season,team) pace rows", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            """INSERT INTO nfl_team_pace (season, team, games, off_plays_pg, def_plays_pg, pace_sos)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(season, team) DO UPDATE SET
                 games=excluded.games, off_plays_pg=excluded.off_plays_pg,
                 def_plays_pg=excluded.def_plays_pg, pace_sos=excluded.pace_sos""",
            rows,
        )
        db.commit(); db.close()
        print("  wrote local nfl_team_pace", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="nfl_team_pace", cols=["season", "team", "games", "off_plays_pg", "def_plays_pg", "pace_sos"],
                      pk_cols=["season", "team"], chunk_size=200) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
