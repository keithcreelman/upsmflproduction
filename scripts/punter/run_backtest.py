#!/usr/bin/env python3
"""Punter-level backtest. Dev mode: train < 2024, evaluate 2024 only. --final: train < 2025, evaluate 2025 once (use via run_locked_test.py)."""
import os, sys, json, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from punter_common import *
from punter_models import *
from sklearn.ensemble import HistGradientBoostingRegressor

def load():
    lc = league_context()
    team = team_frame().merge(lc, on=["season", "week"], how="left")
    pg = pd.read_parquet(os.path.join(P, "punter_games.parquet")).merge(lc, on=["season", "week"], how="left")
    pg = pg[(pg.season >= FIRST_MODEL_SEASON) & (pg.week <= 17)].copy()
    pg["wind"] = pg["wind"].fillna(0.0); pg["temp"] = pg["temp"].fillna(68.0)
    return team, pg

def decisions(df, pcol, basecol=None, ycol="points"):
    """Weekly pairwise + top-pick decision metrics. basecol: baseline projection to compute gains against."""
    out = {}; pair = []; reg = []; gain = []; top3 = []; top5 = []
    for (s, w), g in df.groupby(["season", "week"]):
        if len(g) < 6: continue
        y = g[ycol].to_numpy(); p = g[pcol].to_numpy()
        i, j = np.triu_indices(len(g), 1); dp = p[i] - p[j]; dy = y[i] - y[j]
        ok = (dy != 0) & (np.abs(dp) > 1e-9)
        pair.append(pd.DataFrame({"season": s, "week": w, "dp": np.abs(dp[ok]), "win": (np.sign(dp[ok]) == np.sign(dy[ok])).astype(float)}))
        reg.append(y.max() - y[np.argmax(p)])
        k = np.argsort(-p)
        top3.append(len(set(k[:3]) & set(np.argsort(-y)[:3])) / 3); top5.append(len(set(k[:5]) & set(np.argsort(-y)[:5])) / 5)
        if basecol is not None:
            gain.append(y[np.argmax(p)] - y[np.argmax(g[basecol].to_numpy())])
    pr = pd.concat(pair)
    out["pairwise_win_rate"] = pr.win.mean()
    for lo, hi in [(0, .5), (.5, 1), (1, 2), (2, 99)]:
        m = pr[(pr.dp >= lo) & (pr.dp < hi)]; out["win_rate_diff_%s_%s" % (lo, hi)] = m.win.mean(); out["n_pairs_%s_%s" % (lo, hi)] = len(m)
    out["regret_vs_best"] = float(np.mean(reg)); out["top3_hit"] = float(np.mean(top3)); out["top5_hit"] = float(np.mean(top5))
    if gain:
        gain = np.array(gain); out["pick_gain_vs_baseline"] = float(gain.mean())
        rng = np.random.default_rng(5); bs = [rng.choice(gain, len(gain)).mean() for _ in range(2000)]
        out["pick_gain_ci95"] = [float(np.quantile(bs, .025)), float(np.quantile(bs, .975))]
    return out

def project_all(final=False, S=3000, year=None):
    team, pg = load(); year = year or (TEST_YEAR if final else SELECT_YEAR)
    assert year != TEST_YEAR or final, "2025 is the locked test season: use run_locked_test.py"
    ev = pg[pg.season == year].copy()
    m = Model(year).fit(team, pg)
    PTS, N, I20, avg, comp = m.simulate(ev, S=S)
    sm_ = summarize(PTS, N, I20, avg, comp); sm_.index = ev.index
    ev = pd.concat([ev, sm_.add_prefix("mc_")], axis=1)
    # baselines (NaN history -> training mean of points)
    tr_mean = pg[pg.season < year]["points"].mean()
    for c in ["pk_ups_last4", "pk_ups_std", "pk_ups_prev", "pk_ups_ew"]:
        ev["base_" + c[3:]] = ev[c].fillna(ev["pk_ups_ew"]).fillna(tr_mean)
    # direct regression models over cumulative feature groups (ablation at punter level)
    trn = pg[pg.season < year]
    hist = ["pk_ups_last4", "pk_ups_std", "pk_ups_prev", "pk_ups_ew"]
    ev["pred_punts_team"] = comp[0]; trn = trn.copy()
    tm = Model(year).fit(team, pg); trn_comp = tm.components(trn)[0]; trn["pred_punts_team"] = trn_comp
    groups = [("B1_history", hist), ("+volume", ["pred_punts_team", "o_punt_rate", "o_drives"]), ("+A_offense", FEATURE_GROUPS["A_offense"]),
              ("+B_opp_defense", FEATURE_GROUPS["B_opp_defense"]), ("+C_vegas", FEATURE_GROUPS["C_vegas"]), ("+D_coaching", FEATURE_GROUPS["D_coaching"]),
              ("+E_punter", ["pk_gross", "pk_i20_resid", "pk_tb_resid", "pk_blk", "pk_ppg", "pk_n_punts"]), ("+F_environment", ["dome", "wind", "temp", "altitude", "home"])]
    cols = []; abl = []
    for name, add in groups:
        cols += add
        r = pipe(Ridge(alpha=100.0)).fit(trn[cols], trn["points"]); ev["ridge_" + name] = r.predict(ev[cols])
        g = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.04, max_iter=200, min_samples_leaf=80, l2_regularization=3.0, random_state=3).fit(trn[cols], trn["points"])
        ev["gbm_" + name] = g.predict(ev[cols])
        for kind in ("ridge", "gbm"):
            met = metrics(ev["points"], ev[kind + "_" + name]); met.update({"group": name, "model": kind, "spearman_weekly": weekly_spearman(ev, "points", kind + "_" + name)})
            abl.append(met)
    return ev, pd.DataFrame(abl), m

if __name__ == "__main__":
    final = "--final" in sys.argv
    ev, abl, m = project_all(final=final)
    pd.set_option("display.width", 220)
    rows = []
    for name, col in [("league_mean", None), ("prior4_UPS", "base_ups_last4"), ("season_to_date_UPS", "base_ups_std"), ("prior_season_UPS", "base_ups_prev"), ("EW_UPS", "base_ups_ew"),
                      ("component_MC_mean", "mc_mean"), ("component_MC_median", "mc_median"), ("ridge_full", "ridge_+F_environment"), ("gbm_full", "gbm_+F_environment")]:
        p = np.full(len(ev), 7.6) if col is None else ev[col]
        r = metrics(ev["points"], p); r["spearman_weekly"] = weekly_spearman(ev, "points", col) if col else np.nan; r["projection"] = name; rows.append(r)
    cmp = pd.DataFrame(rows); print(cmp[["projection", "n", "rmse", "mae", "r2", "bias", "spearman_weekly"]].round(4).to_string(index=False))
    print(abl.round(4)[["group", "model", "rmse", "mae", "r2", "spearman_weekly"]].to_string(index=False))
    cover = ((ev["points"] >= ev["mc_p10"]) & (ev["points"] <= ev["mc_p90"])).mean(); print("p10-p90 coverage:", round(cover, 3), "(nominal 0.80)")
    print(json.dumps({k: (round(v, 4) if isinstance(v, float) else v) for k, v in decisions(ev, "mc_mean", "base_ups_ew").items()}, indent=0))
    print("tau", round(m.tau, 2), "sd_drives", round(m.sd_drives, 2), "blk", round(m.blk, 4))
