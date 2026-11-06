#!/usr/bin/env python3
"""Build one row per (season, week, team) of what happened in that game (offense + defense-allowed), from nflverse
play-by-play. These are POST-game facts; point-in-time use goes through build_weekly_features.py, which only ever
reads rows from games played before the projected game. Output: data/punter/processed/team_games.parquet"""
import os, polars as pl
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
P = os.path.join(ROOT, "data", "punter", "processed")

def main():
    pbp = pl.read_parquet(os.path.join(P, "pbp_slim.parquet")).filter(
        (pl.col("season_type") == "REG") & (pl.col("play_deleted").fill_null(0) == 0) & pl.col("posteam").is_not_null())
    # ---- drive level: one row per (game, offense, drive)
    first = pbp.sort(["game_id", "drive", "play_id"]).group_by(["game_id", "posteam", "drive"], maintain_order=True).agg(
        season=pl.col("season").first(), week=pl.col("week").first(), defteam=pl.col("defteam").first(),
        result=pl.col("fixed_drive_result").first(), plays=pl.col("drive_play_count").first(),
        start_yl=pl.col("yardline_100").first(), qtr=pl.col("qtr").first(),
        start_gsr=pl.col("game_seconds_remaining").first(), start_sd=pl.col("score_differential").first())
    first = first.with_columns(
        punt=(pl.col("result") == "Punt").cast(pl.Int8), td=(pl.col("result") == "Touchdown").cast(pl.Int8),
        fg=pl.col("result").is_in(["Field goal", "Missed field goal"]).cast(pl.Int8),
        to=(pl.col("result") == "Turnover").cast(pl.Int8), tod=(pl.col("result") == "Turnover on downs").cast(pl.Int8),
        endh=pl.col("result").is_in(["End of half", "End of game"]).cast(pl.Int8),
        tno=((pl.col("result") == "Punt") & (pl.col("plays") <= 3)).cast(pl.Int8))
    first.write_parquet(os.path.join(P, "drives.parquet"))
    d = first.group_by(["season", "week", "game_id", "posteam"]).agg(
        drives=pl.len(), punts_d=pl.col("punt").sum(), tds=pl.col("td").sum(), fgs=pl.col("fg").sum(), tos=pl.col("to").sum(),
        tods=pl.col("tod").sum(), endh=pl.col("endh").sum(), tno=pl.col("tno").sum(), start_yl=pl.col("start_yl").mean())
    # ---- play level offense
    scr = pbp.filter((pl.col("pass") == 1) | (pl.col("rush") == 1))
    o = scr.group_by(["season", "week", "game_id", "posteam", "defteam"]).agg(
        plays=pl.len(), epa=pl.col("epa").mean(), sr=pl.col("success").mean(),
        early_epa=pl.col("epa").filter(pl.col("down").is_in([1, 2])).mean(),
        pass_rate=pl.col("pass").mean(), sacks=pl.col("sack").sum(), dropbacks=pl.col("qb_dropback").sum(),
        third_att=((pl.col("down") == 3)).sum(), third_conv=pl.col("third_down_converted").sum(),
        third_ytg=pl.col("ydstogo").filter(pl.col("down") == 3).mean(),
        fourth_go=((pl.col("down") == 4)).sum(), fourth_conv=pl.col("fourth_down_converted").sum(),
        yds=pl.col("yards_gained").sum())
    # 4th-down decisions: go / punt / fg
    fd = pbp.filter(pl.col("down") == 4).group_by(["game_id", "posteam"]).agg(
        fourth_punt=pl.col("punt_attempt").sum(), fourth_fg=pl.col("field_goal_attempt").sum())
    # punt-level facts for the team (post-game truth for the opportunity model)
    pu = pbp.filter(pl.col("punt_attempt") == 1).group_by(["game_id", "posteam"]).agg(
        punts=pl.len(), punt_i20=pl.col("punt_inside_twenty").sum(), punt_blk=pl.col("punt_blocked").sum(),
        punt_los=pl.col("yardline_100").mean(), punt_kd=pl.col("kick_distance").sum(),
        punt_tb=pl.col("punt_in_endzone").sum())
    g = o.join(d, on=["season", "week", "game_id", "posteam"], how="left").join(fd, on=["game_id", "posteam"], how="left") \
         .join(pu, on=["game_id", "posteam"], how="left")
    for c in ["punts", "punt_i20", "punt_blk", "punt_kd", "punt_tb", "fourth_punt", "fourth_fg"]:
        g = g.with_columns(pl.col(c).fill_null(0))
    # ---- game context (one row per game) from schedules, plus per-team implied total
    s = pl.read_parquet(os.path.join(P, "schedules.parquet")).filter(pl.col("game_type") == "REG").select(
        ["game_id", "season", "week", "home_team", "away_team", "spread_line", "total_line", "roof", "temp", "wind",
         "surface", "stadium", "home_coach", "away_coach", "home_score", "away_score", "overtime", "gameday", "gametime",
         "home_qb_id", "away_qb_id", "location"])
    h = s.select(["game_id", pl.col("home_team").alias("posteam"), pl.col("away_team").alias("opp"), pl.lit(1).alias("home"),
                  pl.col("spread_line").alias("spread"), "total_line", (pl.col("total_line") + pl.col("spread_line")).truediv(2).alias("implied"),
                  pl.col("home_coach").alias("coach"), pl.col("home_qb_id").alias("qb_id"), pl.col("home_score").alias("pf"), pl.col("away_score").alias("pa")])
    a = s.select(["game_id", pl.col("away_team").alias("posteam"), pl.col("home_team").alias("opp"), pl.lit(0).alias("home"),
                  (-pl.col("spread_line")).alias("spread"), "total_line", (pl.col("total_line") - pl.col("spread_line")).truediv(2).alias("implied"),
                  pl.col("away_coach").alias("coach"), pl.col("away_qb_id").alias("qb_id"), pl.col("away_score").alias("pf"), pl.col("home_score").alias("pa")])
    ctx = pl.concat([h, a]).join(s.select(["game_id", "roof", "temp", "wind", "surface", "stadium", "overtime", "gameday", "gametime", "location"]), on="game_id")
    g = pl.concat([g, ctx.filter(~pl.col("game_id").is_in(g["game_id"].unique())).select(["game_id", "posteam"]).join(
        s.select(["game_id", "season", "week"]), on="game_id")], how="diagonal_relaxed")  # scheduled games without play-by-play yet (future weeks)
    g = g.join(ctx, on=["game_id", "posteam"], how="inner")
    g = g.with_columns(spread_fav=pl.col("spread"))  # + = this team favored by that many
    g.write_parquet(os.path.join(P, "team_games.parquet"))
    print(g.shape, g["season"].min(), g["season"].max())

if __name__ == "__main__":
    main()
