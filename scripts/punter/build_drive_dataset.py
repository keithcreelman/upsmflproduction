#!/usr/bin/env python3
"""Punt-level dataset (one row per punt) + the league LOS->inside-20 curve. Output: data/punter/processed/punts.parquet
The curve (logistic on line of scrimmage, dome, wind, temperature, altitude) is fit ONLY on 2012-2017 punts so the
opportunity adjustment used by later point-in-time features never sees the 2018+ training, 2024 selection or 2025 test years."""
import os, numpy as np, pandas as pd, polars as pl
from sklearn.linear_model import LogisticRegression
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
P = os.path.join(ROOT, "data", "punter", "processed")
FR = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS", "JAC": "JAX"}

def design(df):
    los = df["los"].to_numpy(float)
    return np.column_stack([los, los ** 2 / 100.0, df["dome"], df["wind"].fillna(0), df["temp"].fillna(65), df["altitude"]])

def main():
    pbp = pl.read_parquet(os.path.join(P, "pbp_slim.parquet")).filter(
        (pl.col("punt_attempt") == 1) & (pl.col("season_type") == "REG") & (pl.col("play_deleted").fill_null(0) == 0))
    df = pbp.select(["game_id", "season", "week", "posteam", "defteam", "punter_player_id", "yardline_100", "kick_distance", "punt_inside_twenty",
                     "punt_in_endzone", "punt_out_of_bounds", "punt_fair_catch", "punt_downed", "punt_blocked", "return_yards",
                     "roof", "temp", "wind", "stadium", "qtr", "score_differential", "game_seconds_remaining"]).to_pandas()
    df["team"] = df["posteam"].map(lambda t: FR.get(t, t)); df["opp"] = df["defteam"].map(lambda t: FR.get(t, t))
    df["los"] = df["yardline_100"]; df["dome"] = df["roof"].isin(["dome", "closed"]).astype(int)
    df["altitude"] = ((df["stadium"].fillna("").str.contains("Mile High|Empower|Broncos")) ).astype(int) * 5280
    df = df[df["punt_blocked"] == 0].copy()   # blocked punts have no placement; they enter via the HBP rate
    tr = df[(df["season"] >= 2012) & (df["season"] <= 2017)]
    mu = tr[["los", "wind", "temp"]].mean()
    clf = LogisticRegression(C=5.0, max_iter=400).fit(design(tr), tr["punt_inside_twenty"])
    df["exp_i20"] = clf.predict_proba(design(df))[:, 1]
    tbm = LogisticRegression(C=5.0, max_iter=400).fit(design(tr), tr["punt_in_endzone"])
    df["exp_tb"] = tbm.predict_proba(design(df))[:, 1]
    pl.from_pandas(df).write_parquet(os.path.join(P, "punts.parquet"))
    np.save(os.path.join(P, "los_curve_coef.npy"), clf.coef_)
    print(df.shape, "mean exp_i20", round(df.exp_i20.mean(), 4), "actual", round(df.punt_inside_twenty.mean(), 4))
    print("i20 curve coef [los, los^2/100, dome, wind, temp, alt]:", np.round(clf.coef_[0], 4))

if __name__ == "__main__":
    main()
