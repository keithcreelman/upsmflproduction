#!/usr/bin/env python3
"""Descriptive report statistics computed AFTER the locked run. Nothing here changes a model: component accuracy, calibration deciles,
week-clustered bootstrap CIs for decision metrics, touchback supplement, and the named-punter smoke tests."""
import os, sys, json, warnings, numpy as np, pandas as pd, polars as pl
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from run_decision_validation import *
OUT = {}

def boot(ev, fn, B=800, seed=3):
    rng = np.random.default_rng(seed); w = ev.groupby(["season", "week"]).ngroup().to_numpy(); uw = np.unique(w); idx = {k: np.where(w == k)[0] for k in uw}
    vals = []
    for _ in range(B):
        pick = rng.choice(uw, len(uw)); vals.append(fn(ev.iloc[np.concatenate([idx[k] for k in pick])]))
    vals = np.array(vals); return float(np.nanmean(vals)), float(np.nanquantile(vals, .025)), float(np.nanquantile(vals, .975))

def pair_win(df, col):
    wins = tot = 0
    for _, g in df.groupby(["season", "week"]):
        y, p = g.points.to_numpy(), g[col].to_numpy(); i, j = np.triu_indices(len(g), 1); dy, dp = y[i] - y[j], p[i] - p[j]; ok = (dy != 0) & (np.abs(dp) > 1e-9)
        wins += (np.sign(dy[ok]) == np.sign(dp[ok])).sum(); tot += ok.sum()
    return wins / max(tot, 1)

def components(final):
    team, pg = load(); year = TEST_YEAR if final else SELECT_YEAR
    ev = pg[pg.season == year].copy(); m = Model(year).fit(team, pg)
    PTS, N, I20, avg, comp = m.simulate(ev, S=3000); punts, drives, p20, mu = comp
    ev["pred_punts"] = N.mean(1); ev["pred_i20"] = I20.mean(1); ev["pred_gross"] = mu; ev["p20"] = p20
    r = {}
    tr = pg[pg.season < year]
    r["punt_attempts"] = {"model": metrics(ev.punts, ev.pred_punts), "last-4-games average": metrics(ev.punts, ev["pk_ppg"].fillna(tr.punts.mean())), "league mean": metrics(ev.punts, np.full(len(ev), tr.punts.mean()))}
    r["inside20_count"] = {"model": metrics(ev.i20, ev.pred_i20), "league rate x actual punts (skill-free, oracle volume)": metrics(ev.i20, ev.punts * (tr.i20.sum() / tr.punts.sum())),
                           "league mean count": metrics(ev.i20, np.full(len(ev), tr.i20.mean()))}
    g = ev[ev.gross.notna()]
    r["gross_average"] = {"model": metrics(g.gross, g.pred_gross), "punter career-shrunk average (pk_gross)": metrics(g.gross, g.pk_gross), "league mean": metrics(g.gross, np.full(len(g), tr.kd.sum() / tr.punts.sum()))}
    # probability calibration of the per-punt inside-20 probability (binned)
    q = ev[ev.punts > 0].copy(); q["bin"] = pd.qcut(q.p20, 5, duplicates="drop")
    cal = q.groupby("bin", observed=True).apply(lambda d: pd.Series({"mean_pred": np.average(d.p20, weights=d.punts), "observed": d.i20.sum() / d.punts.sum(), "punts": int(d.punts.sum())}))
    r["i20_calibration"] = cal.round(4).reset_index(drop=True).to_dict("records")
    # calibration of projected points by decile of mc_mean
    ev["mc_mean"] = pd.Series(np.nanmean(np.where(N >= 1, PTS, np.nan), 1), index=ev.index)
    ev["dec"] = pd.qcut(ev.mc_mean, 10, labels=False, duplicates="drop")
    r["points_calibration_deciles"] = ev.groupby("dec").agg(projected=("mc_mean", "mean"), actual=("points", "mean"), n=("points", "size")).round(3).reset_index().to_dict("records")
    # interval coverage 10/50/90
    P_ = np.where(N >= 1, PTS, np.nan); q10, q50, q90 = (np.nanquantile(P_, k, 1) for k in (.1, .5, .9))
    r["coverage"] = {"below_p10": float((ev.points < q10).mean()), "below_p50": float((ev.points < q50).mean()), "below_p90": float((ev.points < q90).mean()), "nominal": [0.1, 0.5, 0.9]}
    return r

def main():
    for final in (False, True):
        OUT["components_%d" % (TEST_YEAR if final else SELECT_YEAR)] = components(final)
    # decision CIs on 2024 and 2025
    for final in (False, True):
        ev, abl, m = project_all(final=final, S=3000); y = TEST_YEAR if final else SELECT_YEAR
        ev["lg"] = pg_train_mean(ev, final)
        cis = {}
        cis["pairwise_win_rate_model"] = boot(ev, lambda d: pair_win(d, "mc_mean"), B=300)
        cis["pairwise_win_rate_EW_UPS_baseline"] = boot(ev, lambda d: pair_win(d, "base_ups_ew"), B=300)
        cis["pairwise_win_rate_model_minus_EW"] = boot(ev, lambda d: pair_win(d, "mc_mean") - pair_win(d, "base_ups_ew"), B=300)
        cis["rmse_improvement_vs_league_mean_pct"] = boot(ev, lambda d: 100 * (1 - np.sqrt(((d.mc_mean - d.points) ** 2).mean()) / np.sqrt(((d.lg - d.points) ** 2).mean())))
        cis["rmse_improvement_vs_best_simple_pct"] = boot(ev, lambda d: 100 * (1 - np.sqrt(((d.mc_mean - d.points) ** 2).mean()) / min(np.sqrt(((d[c] - d.points) ** 2).mean()) for c in ["lg", "base_ups_last4", "base_ups_std", "base_ups_prev", "base_ups_ew"])))
        cis["weekly_spearman_model"] = boot(ev, lambda d: weekly_spearman(d, "points", "mc_mean"), B=300)
        # is a projected 1-point advantage actionable?  pairs binned by |difference| with win rates + n
        rows = []
        for lo, hi in [(0, .5), (.5, 1), (1, 1.5), (1.5, 2), (2, 3), (3, 99)]:
            w = n = 0
            for _, g in ev.groupby(["season", "week"]):
                yv, p = g.points.to_numpy(), g.mc_mean.to_numpy(); i, j = np.triu_indices(len(g), 1); dy, dp = yv[i] - yv[j], np.abs(p[i] - p[j]); sg = np.sign(p[i] - p[j])
                ok = (dy != 0) & (dp >= lo) & (dp < hi); w += (np.sign(dy[ok]) == sg[ok]).sum(); n += ok.sum()
            rows.append({"proj_diff": "%s-%s" % (lo, hi), "win_rate": round(w / max(n, 1), 4), "pairs": int(n)})
        cis["win_rate_by_projected_difference"] = rows
        OUT["decision_cis_%d" % y] = cis
    # touchback supplement + named-punter smoke test
    pbp = pl.read_parquet(os.path.join(P, "pbp_slim.parquet"))
    OUT["note_touchback"] = "nflverse punt_in_endzone flags only punts caught in the end zone (0.06% of punts); the model does not forecast touchbacks because UPS has no touchback scoring event"
    json.dump(OUT, open(os.path.join(RES, "report_stats.json"), "w"), indent=1, default=float)
    print(json.dumps({k: v for k, v in OUT.items() if k.startswith("decision_cis")}, indent=1, default=float)[:6000])
    for y in (2024, 2025):
        c = OUT["components_%d" % y]
        print(y, "punts RMSE model %.3f vs league %.3f | I20 count RMSE model %.3f vs league %.3f | gross RMSE model %.3f vs league %.3f" % (
            c["punt_attempts"]["model"]["rmse"], c["punt_attempts"]["league mean"]["rmse"], c["inside20_count"]["model"]["rmse"], c["inside20_count"]["league mean count"]["rmse"],
            c["gross_average"]["model"]["rmse"], c["gross_average"]["league mean"]["rmse"]))
        print("   coverage below p10/p50/p90:", {k: round(v, 3) for k, v in c["coverage"].items() if k.startswith("below")})
        print("   I20 calibration:", [(round(r["mean_pred"], 3), round(r["observed"], 3)) for r in c["i20_calibration"]])
if __name__ == "__main__":
    main()
