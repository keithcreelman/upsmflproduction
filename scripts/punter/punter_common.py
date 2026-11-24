"""Shared loaders, splits and metrics for the punter model scripts."""
import os, json, numpy as np, pandas as pd
from scipy.stats import spearmanr, pearsonr
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
P = os.path.join(ROOT, "data", "punter", "processed")
RES = os.path.join(P, "results"); os.makedirs(RES, exist_ok=True)
REPORTS = os.path.join(ROOT, "reports", "punter")

# Chronological split (spec): train through 2023, select on 2024, LOCKED test 2025, prospective 2026.
TRAIN_END, SELECT_YEAR, TEST_YEAR, SHADOW_YEAR = 2023, 2024, 2025, 2026
FIRST_MODEL_SEASON = 2012       # PN scoring (PI x4, ANY tiers) is constant 2012-2026; 2010-2011 are burn-in history only

FEATURE_GROUPS = {
    "volume": ["o_punt_rate", "o_drives"],
    "A_offense": ["o_epa", "o_sr", "o_ppd", "o_tno_rate", "o_third_rate", "o_sack_rate", "o_to_rate", "o_start_yl", "o_plays"],
    "B_opp_defense": ["opp_d_epa", "opp_d_sr", "opp_d_third_rate", "opp_d_sack_rate", "opp_d_to_rate", "opp_d_punt_rate", "opp_o_drives"],
    "C_vegas": ["spread", "total_line", "implied"],
    "D_coaching": ["o_go_rate", "o_fg_rate", "opp_o_go_rate"],
    "F_environment": ["dome", "wind", "temp", "altitude", "home"],
}

def team_frame():
    d = pd.read_parquet(os.path.join(P, "team_features.parquet"))
    d = d[(d.season >= FIRST_MODEL_SEASON) & (d.week <= 17)].copy()
    d["wind"] = d["wind"].fillna(0.0); d["temp"] = d["temp"].fillna(68.0)   # dome / closed roof: no weather; neutral values
    return d.sort_values(["date", "game_id", "team"]).reset_index(drop=True)

def split_masks(d):
    return {"train": d.season <= TRAIN_END, "select": d.season == SELECT_YEAR, "test": d.season == TEST_YEAR, "shadow": d.season == SHADOW_YEAR}

def metrics(y, p):
    y = np.asarray(y, float); p = np.asarray(p, float); ok = ~(np.isnan(y) | np.isnan(p)); y, p = y[ok], p[ok]
    e = p - y; ss = ((y - y.mean()) ** 2).sum()
    return {"n": int(len(y)), "rmse": float(np.sqrt((e ** 2).mean())), "mae": float(np.abs(e).mean()),
            "r2": float(1 - (e ** 2).sum() / ss) if ss > 0 else np.nan, "bias": float(e.mean()),
            "pearson": float(pearsonr(y, p)[0]) if len(y) > 2 and np.std(p) > 0 else np.nan}

def weekly_spearman(df, ycol, pcol):
    r = []
    for (s, w), g in df.groupby(["season", "week"]):
        if len(g) >= 6 and g[pcol].nunique() > 1 and g[ycol].nunique() > 1:
            r.append(spearmanr(g[pcol], g[ycol])[0])
    return float(np.nanmean(r)) if r else np.nan

def league_context(window_weeks=6):
    """Trailing league-wide punting environment known BEFORE each (season, week): punts/drive, inside-20 rate, gross average,
    computed over the previous `window_weeks` played weeks (spanning the season boundary). Strictly earlier weeks only."""
    d = pd.read_parquet(os.path.join(P, "team_features.parquet"))
    d = d[d["punts"].notna()]
    w = d.groupby(["season", "week"]).agg(punts=("punts", "sum"), drives=("drives", "sum"), i20=("punt_i20", "sum"), kd=("punt_kd", "sum")).reset_index()
    w = w.sort_values(["season", "week"]).reset_index(drop=True)
    allw = pd.read_parquet(os.path.join(P, "team_features.parquet"))[["season", "week"]].drop_duplicates().sort_values(["season", "week"]).reset_index(drop=True)
    rows = []
    for _, r in allw.iterrows():
        prior = w[(w.season < r.season) | ((w.season == r.season) & (w.week < r.week))].tail(window_weeks)
        if len(prior) == 0: rows.append((r.season, r.week, np.nan, np.nan, np.nan)); continue
        rows.append((r.season, r.week, prior.punts.sum() / prior.drives.sum(), prior.i20.sum() / prior.punts.sum(), prior.kd.sum() / prior.punts.sum()))
    return pd.DataFrame(rows, columns=["season", "week", "lg_punt_rate", "lg_i20_rate", "lg_gross"])
