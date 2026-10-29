#!/usr/bin/env python3
"""Rolling-origin cross-validation inside the training period: for each year 2018..2024 fit on seasons < year, score that year.
Never touches 2025 or 2026. Gives the multi-season stability evidence behind the model-selection decision."""
import os, sys, json, numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(__file__))
from run_backtest import *

def main():
    rows = []
    for y in range(2018, SELECT_YEAR + 1):
        ev, abl, m = project_all(final=False, S=1500, year=y)
        tr_mean = pd.read_parquet(os.path.join(P, "punter_games.parquet")).query("season>=2012 and season<@y")["points"].mean()
        r = {"year": y, "n": len(ev)}
        for name, c in [("league_mean", None), ("prior4", "base_ups_last4"), ("season_to_date", "base_ups_std"), ("EW_UPS", "base_ups_ew"), ("component_MC", "mc_mean")]:
            p = np.full(len(ev), tr_mean) if c is None else ev[c]; r["rmse_" + name] = float(np.sqrt(((p - ev.points) ** 2).mean()))
            if c: r["rho_" + name] = weekly_spearman(ev, "points", c)
        rows.append(r); print(y, {k: round(v, 3) for k, v in r.items() if k not in ("year", "n")}, flush=True)
    df = pd.DataFrame(rows); df.to_csv(os.path.join(RES, "rolling_origin_cv.csv"), index=False)
    best = df[[c for c in df.columns if c.startswith("rmse_") and c != "rmse_component_MC"]].min(axis=1)
    df["mc_vs_best_simple_pct"] = 100 * (1 - df["rmse_component_MC"] / best); df["mc_vs_league_pct"] = 100 * (1 - df["rmse_component_MC"] / df["rmse_league_mean"])
    print(df[["year", "n", "rmse_league_mean", "rmse_EW_UPS", "rmse_component_MC", "mc_vs_best_simple_pct", "mc_vs_league_pct", "rho_EW_UPS", "rho_component_MC"]].round(3).to_string(index=False))
    print("mean improvement vs league mean: %.2f%%  vs best simple baseline: %.2f%%; years MC beats league: %d/%d" % (df.mc_vs_league_pct.mean(), df.mc_vs_best_simple_pct.mean(), (df.mc_vs_league_pct > 0).sum(), len(df)))
    df.to_csv(os.path.join(RES, "rolling_origin_cv.csv"), index=False)

if __name__ == "__main__":
    main()
