#!/usr/bin/env python3
"""Download nflverse play-by-play (via nflreadpy) for the model window and keep only the columns the punter model
needs. Writes data/punter/processed/pbp_slim.parquet and schedules.parquet (both git-ignored; rebuild with this script).
Vegas lines in nflverse (spread_line/total_line) are the lines nflverse recorded for the game; they are treated as the
pregame line and the timing limitation is documented in the data dictionary."""
import os, sys, polars as pl, nflreadpy as nfl
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
OUT = os.path.join(ROOT, "data", "punter", "processed")
COLS = ["game_id","season","week","season_type","posteam","defteam","home_team","away_team","posteam_type","drive","play_id",
 "play_type","down","ydstogo","yardline_100","qtr","game_seconds_remaining","score_differential","posteam_score","defteam_score",
 "epa","wp","success","pass","rush","sack","qb_dropback","interception","fumble_lost","touchdown","field_goal_attempt",
 "fourth_down_converted","fourth_down_failed","third_down_converted","third_down_failed","penalty","play_deleted",
 "punt_attempt","punt_blocked","punt_inside_twenty","punt_in_endzone","punt_out_of_bounds","punt_downed","punt_fair_catch",
 "kick_distance","return_yards","punter_player_id","punter_player_name","punt_returner_player_id","fixed_drive_result",
 "drive_play_count","drive_start_yard_line","drive_end_yard_line","drive_ended_with_score","fixed_drive","drive_quarter_start",
 "drive_time_of_possession","home_coach","away_coach","roof","surface","temp","wind","stadium","spread_line","total_line",
 "home_timeouts_remaining","away_timeouts_remaining","qb_scramble","two_point_attempt","special_teams_play","kick_distance","yards_gained"]
def main(first=2010, last=2026):
    os.makedirs(OUT, exist_ok=True)
    seasons = list(range(first, last + 1))
    parts = []
    for s in seasons:
        try:
            d = nfl.load_pbp([s])
        except Exception as e:
            print("skip", s, e); continue
        keep = [c for c in dict.fromkeys(COLS) if c in d.columns]
        parts.append(d.select(keep)); print(s, d.height, flush=True)
    pl.concat(parts, how="diagonal_relaxed").write_parquet(os.path.join(OUT, "pbp_slim.parquet"))
    nfl.load_schedules(seasons).write_parquet(os.path.join(OUT, "schedules.parquet"))
    nfl.load_ff_playerids().write_parquet(os.path.join(OUT, "ff_playerids.parquet"))
if __name__ == "__main__":
    main()
