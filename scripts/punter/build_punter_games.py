#!/usr/bin/env python3
"""Punter-game modeling table: one row per (season, week, punter) with
  * outcomes: punts, inside-20, gross, UPS points (official MFL points when present, else reconstructed),
  * point-in-time punter skill state (only that punter's earlier games, any team),
  * point-in-time team / opponent / context features for his team that week (team_features.parquet).
Output: data/punter/processed/punter_games.parquet and punter_state_current.parquet (state after the last game, for projections)."""
import os, sys, numpy as np, pandas as pd, polars as pl
sys.path.insert(0, os.path.dirname(__file__))
import build_scoring_audit as A
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
P = os.path.join(ROOT, "data", "punter", "processed")
FR = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS", "JAC": "JAX"}
N0_GROSS, N0_I20, N0_TB, N0_BLK = 80.0, 100.0, 100.0, 400.0
HALF_LIFE_GAMES = 24.0

def main():
    pg = A.punter_games().to_pandas()
    pt = pl.read_parquet(os.path.join(P, "punts.parquet")).to_pandas()
    ex = pt.groupby(["season", "week", "punter_player_id"]).agg(exp_i20=("exp_i20", "sum"), exp_tb=("exp_tb", "sum"),
                                                                 los=("los", "mean")).reset_index()
    pg = pg.merge(ex, on=["season", "week", "punter_player_id"], how="left")
    pg["team"] = pg["team"].map(lambda t: FR.get(t, t))
    m = A.load_mfl().to_pandas()[["season", "week", "gsis_id", "mfl_points", "mfl_id"]]
    pg = pg.rename(columns={"punter_player_id": "gsis_id"}).merge(m, on=["season", "week", "gsis_id"], how="left")
    pg["recon_points"] = [A.recon(r) for r in pg.to_dict("records")]
    pg["points"] = pg["mfl_points"].fillna(pg["recon_points"])
    tf = pd.read_parquet(os.path.join(P, "team_features.parquet"))
    pg = pg.merge(tf.drop(columns=["punts", "punt_i20", "punt_blk", "punt_kd", "punt_tb", "punt_los"]), on=["season", "week", "team"], how="inner")
    pg = pg.sort_values(["date", "game_id", "gsis_id"]).reset_index(drop=True)
    lg = pg[pg.season <= 2017]
    lg_gross = lg["kd"].sum() / max(lg["punts"].sum(), 1); lg_blk = lg["blocked"].sum() / max(lg["punts_all"].sum(), 1)
    state_cols = ["pk_n_games", "pk_n_punts", "pk_gross", "pk_i20_resid", "pk_tb_resid", "pk_blk", "pk_ppg", "pk_ups_last4", "pk_ups_std", "pk_ups_prev", "pk_ups_ew", "pk_gross_last5"]
    S = np.full((len(pg), len(state_cols)), np.nan)
    cur = []
    for gid, sub in pg.groupby("gsis_id"):
        ix = sub.index.to_numpy(); n = len(ix)
        punts = sub["punts"].to_numpy(float); kd = sub["kd"].to_numpy(float); i20 = sub["i20"].to_numpy(float)
        e20 = sub["exp_i20"].to_numpy(float); tb = sub["tb"].to_numpy(float); etb = sub["exp_tb"].to_numpy(float)
        blk = sub["blocked"].to_numpy(float); pall = sub["punts_all"].to_numpy(float); pts = sub["points"].to_numpy(float); seas = sub["season"].to_numpy()
        for k in range(n + 1):
            if k > 0:
                lag = np.arange(k - 1, -1, -1); w = 0.5 ** (lag / HALF_LIFE_GAMES)
            else:
                w = np.array([])
            wp = w * punts[:k]
            row = [k, punts[:k].sum(),
                   (np.sum(w * kd[:k]) + N0_GROSS * lg_gross) / (np.sum(wp) + N0_GROSS),
                   np.sum(w * (i20[:k] - e20[:k])) / (np.sum(wp) + N0_I20),
                   np.sum(w * (tb[:k] - etb[:k])) / (np.sum(wp) + N0_TB),
                   (np.sum(w * blk[:k]) + N0_BLK * lg_blk) / (np.sum(w * pall[:k]) + N0_BLK),
                   (np.sum(w * pall[:k]) / np.sum(w)) if k else np.nan,
                   pts[max(0, k - 4):k].mean() if k else np.nan,
                   pts[:k][seas[:k] == (seas[k] if k < n else seas[k - 1] + 1)].mean() if (k < n and (seas[:k] == seas[k]).any()) else np.nan,
                   pts[:k][seas[:k] == (seas[k] - 1)].mean() if (k < n and (seas[:k] == seas[k] - 1).any()) else np.nan,
                   np.sum(w * pts[:k]) / np.sum(w) if k else np.nan,
                   (kd[max(0, k - 5):k].sum() / max(punts[max(0, k - 5):k].sum(), 1)) if k else np.nan]
            if k < n: S[ix[k]] = row
            else: cur.append([gid] + row)
    pg[state_cols] = S
    pg.to_parquet(os.path.join(P, "punter_games.parquet"))
    pd.DataFrame(cur, columns=["gsis_id"] + state_cols).to_parquet(os.path.join(P, "punter_state_current.parquet"))
    print(pg.shape, pg.season.min(), pg.season.max(), "league gross", round(lg_gross, 2), "blk", round(lg_blk, 4))
    print(pg[["points", "punts", "i20", "gross"]].describe().round(2))

if __name__ == "__main__":
    main()
