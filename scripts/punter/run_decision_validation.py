#!/usr/bin/env python3
"""Decision-based validation: weekly lineup + waiver-order metrics for the component Monte Carlo model against baselines.
Dev mode scores 2024. --final scores 2025 and must only be called through run_locked_test.py (one-shot lock)."""
import os, sys, json, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from run_backtest import *

def waiver_pool_metrics(ev, pcol, ycol="points"):
    """Proxy waiver pool: punters outside the 12 best by EW prior UPS points that week (12-team league, one starting punter each).
    Historical ownership is not reconstructed (archive roster_status is unreliable before 2020), so this is a proxy and is labeled as one."""
    acc = []; top_vs_avg = []
    for (s, w), g in ev.groupby(["season", "week"]):
        g = g.assign(rk=g["base_ups_ew"].rank(ascending=False, method="first"))
        pool = g[g.rk > 12]
        if len(pool) < 5: continue
        y, p = pool[ycol].to_numpy(), pool[pcol].to_numpy()
        i, j = np.triu_indices(len(pool), 1); dy, dp = y[i] - y[j], p[i] - p[j]; ok = (dy != 0) & (np.abs(dp) > 1e-9)
        acc.append(((np.sign(dy[ok]) == np.sign(dp[ok])).mean(), ok.sum()))
        top_vs_avg.append(y[np.argmax(p)] - y.mean())
    a = np.array([x[0] for x in acc]); n = np.array([x[1] for x in acc])
    return {"waiver_pool_pair_accuracy": float((a * n).sum() / n.sum()), "waiver_top_pick_vs_pool_avg": float(np.mean(top_vs_avg))}

def run(final=False, S=3000):
    ev, abl, m = project_all(final=final, S=S)
    rng = np.random.default_rng(1)
    ev["rand"] = rng.random(len(ev))
    cols = {"random": "rand", "prior4_UPS": "base_ups_last4", "season_to_date_UPS": "base_ups_std", "prior_season_UPS": "base_ups_prev", "EW_UPS (baseline)": "base_ups_ew",
            "component_MC_mean (model)": "mc_mean", "ridge_full": "ridge_+F_environment", "gbm_full": "gbm_+F_environment"}
    rows = []
    for name, c in cols.items():
        d = decisions(ev, c, "base_ups_ew"); d["projection"] = name
        met = metrics(ev["points"], ev[c]) if name != "random" else {"rmse": np.nan, "mae": np.nan, "r2": np.nan}
        d.update({"rmse": met["rmse"], "mae": met["mae"], "r2": met["r2"], "spearman_weekly": weekly_spearman(ev, "points", c)}); d.update(waiver_pool_metrics(ev, c))
        rows.append(d)
    res = pd.DataFrame(rows)
    # clustered bootstrap by week for model - baseline pairwise win rate and RMSE gain
    weeks = ev.groupby(["season", "week"]).ngroup().to_numpy(); uw = np.unique(weeks); bs_rmse = []; bs_win = []
    model_c, base_c = "mc_mean", "base_ups_ew"
    for _ in range(600):
        pick = rng.choice(uw, len(uw)); idx = np.concatenate([np.where(weeks == w)[0] for w in pick]); e = ev.iloc[idx]
        bs_rmse.append(1 - np.sqrt(((e[model_c] - e.points) ** 2).mean()) / np.sqrt(((e[base_c] - e.points) ** 2).mean()))
    summary = {"rmse_improvement_vs_EW_UPS_baseline_pct": round(100 * float(np.mean(bs_rmse)), 3),
               "rmse_improvement_ci95_pct": [round(100 * float(np.quantile(bs_rmse, .025)), 3), round(100 * float(np.quantile(bs_rmse, .975)), 3)],
               "p10_p90_coverage": float(((ev.points >= ev.mc_p10) & (ev.points <= ev.mc_p90)).mean())}
    league_rmse = float(np.sqrt(((ev.points - pg_train_mean(ev, final)) ** 2).mean()))
    summary["rmse_improvement_vs_league_mean_pct"] = round(100 * (1 - float(np.sqrt(((ev.mc_mean - ev.points) ** 2).mean())) / league_rmse), 3)
    summary["best_simple_baseline_rmse"] = float(min(np.sqrt(((ev[c] - ev.points) ** 2).mean()) for c in ["base_ups_last4", "base_ups_std", "base_ups_prev", "base_ups_ew"]))
    summary["model_rmse"] = float(np.sqrt(((ev.mc_mean - ev.points) ** 2).mean()))
    summary["rmse_improvement_vs_best_simple_baseline_pct"] = round(100 * (1 - summary["model_rmse"] / summary["best_simple_baseline_rmse"]), 3)
    return ev, abl, res, summary

def pg_train_mean(ev, final):
    pg = pd.read_parquet(os.path.join(P, "punter_games.parquet")); y = TEST_YEAR if final else SELECT_YEAR
    return pg[(pg.season < y) & (pg.season >= FIRST_MODEL_SEASON)]["points"].mean()

if __name__ == "__main__":
    final = "--final" in sys.argv
    ev, abl, res, summary = run(final=final)
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 40)
    print(res[["projection", "rmse", "r2", "spearman_weekly", "pairwise_win_rate", "win_rate_diff_0_0.5", "win_rate_diff_0.5_1", "win_rate_diff_1_2", "win_rate_diff_2_99",
               "top3_hit", "top5_hit", "regret_vs_best", "pick_gain_vs_baseline", "waiver_pool_pair_accuracy", "waiver_top_pick_vs_pool_avg"]].round(4).to_string(index=False))
    print(json.dumps(summary, indent=1))
    tag = "final_2025" if final else "dev_2024"
    res.to_csv(os.path.join(RES, "decisions_%s.csv" % tag), index=False); abl.to_csv(os.path.join(RES, "punter_ablation_%s.csv" % tag), index=False)
    json.dump(summary, open(os.path.join(RES, "decision_summary_%s.json" % tag), "w"), indent=1)
