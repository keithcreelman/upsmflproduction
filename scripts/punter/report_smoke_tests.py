#!/usr/bin/env python3
"""2026 smoke tests on the named punters. Descriptive only (never used to tune)."""
import os, sys, glob, pandas as pd, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from punter_common import *
NAMES = ["Tommy Townsend", "Jordan Stout", "Ryan Rehkow", "Corey Bojorquez", "Tress Way", "Braden Mann", "Jeremy Crawshaw", "Daniel Whelan"]
def main():
    pg = pd.read_parquet(os.path.join(P, "punter_games.parquet")); st = pd.read_parquet(os.path.join(P, "punter_state_current.parquet"))
    ff = pd.read_parquet(os.path.join(P, "ff_playerids.parquet"))[["gsis_id", "name", "mfl_id"]]
    f = sorted(glob.glob(os.path.join(ROOT, "data", "punter", "projections", "projections_2026_wk08-09_*.csv")))[-1]; pr = pd.read_csv(f)
    rows = []
    for n in NAMES:
        gid = ff[ff.name == n].gsis_id.dropna().iloc[0]
        g = pg[(pg.gsis_id == gid) & (pg.season == 2026)]; s = st[st.gsis_id == gid].iloc[0]
        career_punts = pg[(pg.gsis_id == gid) & (pg.season < 2026)].punts.sum()
        w8 = pr[(pr.gsis_id == gid) & (pr.week == 8)]; w9 = pr[(pr.gsis_id == gid) & (pr.week == 9)]
        rows.append({"punter": n, "team": g.team.iloc[-1] if len(g) else "", "g26": len(g), "punts_g": g.punts.mean(), "i20_pct": g.i20.sum() / max(g.punts.sum(), 1), "gross26": g.kd.sum() / max(g.punts.sum(), 1),
                     "ups_avg26": g.points.mean(), "career_punts_pre26": int(career_punts), "pk_gross": s.pk_gross, "pk_i20_resid": s.pk_i20_resid,
                     "wk8_mean": w8.ups_mean.iloc[0] if len(w8) else np.nan, "wk9_mean": w9.ups_mean.iloc[0] if len(w9) else np.nan,
                     "wk8_exp_punts": w8.exp_punts.iloc[0] if len(w8) else np.nan, "wk8_exp_i20": w8.exp_i20.iloc[0] if len(w8) else np.nan,
                     "wk9_exp_punts": w9.exp_punts.iloc[0] if len(w9) else np.nan, "wk9_exp_i20": w9.exp_i20.iloc[0] if len(w9) else np.nan})
    d = pd.DataFrame(rows); d["gap_ups_avg_vs_wk9_proj"] = d.ups_avg26 - d.wk9_mean
    pd.set_option("display.width", 250); pd.set_option("display.max_columns", 30); print(d.round(2).to_string(index=False)); d.round(4).to_csv(os.path.join(RES, "smoke_tests_2026.csv"), index=False)
if __name__ == "__main__": main()
