#!/usr/bin/env python3
"""Hypotheses H1-H6. Uses 2012-2023 (+2024 where marked OOS). It never reads 2025 or 2026 outcomes."""
import os, sys, json, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from punter_common import *
from sklearn.linear_model import Ridge, PoissonRegressor, LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
import statsmodels.api as sm, statsmodels.formula.api as smf
pd.set_option("display.width", 220); pd.set_option("display.max_columns", 30)
OUT = {}

def pipe(m): return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), m)

def main():
    team = team_frame(); team = team[team.season <= SELECT_YEAR]
    pg = pd.read_parquet(os.path.join(P, "punter_games.parquet")); pg = pg[(pg.season >= 2012) & (pg.season <= SELECT_YEAR) & (pg.week <= 17)].copy()
    pg["wind"] = pg["wind"].fillna(0); pg["temp"] = pg["temp"].fillna(68)
    tr, se = pg[pg.season <= TRAIN_END], pg[pg.season == SELECT_YEAR]
    # ---------------- H1 volume
    print("== H1 contemporaneous: how much of UPS points does each game stat explain (2012-2024, n=%d)" % len(pg))
    h1 = {}
    for name, cols in [("punts", ["punts"]), ("inside-20 count", ["i20"]), ("gross avg", ["gross"]), ("punts + I20", ["punts", "i20"]), ("punts + I20 + gross", ["punts", "i20", "gross"])]:
        d = pg.dropna(subset=cols + ["points"]); lr = LinearRegression().fit(d[cols], d["points"]); h1[name] = lr.score(d[cols], d["points"])
    d = pg[pg.punts > 0]; h1["I20 rate (per punt)"] = np.corrcoef(d.i20 / d.punts, d.points)[0, 1] ** 2
    print(pd.Series(h1).round(3)); OUT["H1_contemporaneous_R2"] = {k: float(v) for k, v in h1.items()}
    print("== H1 predictive (one feature at a time, fit <=2023, scored on 2024): R2 / spearman")
    rows = []
    for name, col in [("expected punts (team model feature: o_punt_rate*o_drives)", None), ("EW prior punts per game", "pk_ppg"), ("punter gross avg skill", "pk_gross"),
                      ("punter I20 skill (opportunity-adjusted)", "pk_i20_resid"), ("prior UPS points (EW)", "pk_ups_ew"), ("prior4 UPS points", "pk_ups_last4"), ("prior-season UPS points", "pk_ups_prev")]:
        X = (tr["o_punt_rate"] * tr["o_drives"]) if col is None else tr[col]; Xs = (se["o_punt_rate"] * se["o_drives"]) if col is None else se[col]
        m = pipe(Ridge(alpha=10.0)).fit(X.to_frame("x"), tr["points"]); p = m.predict(Xs.to_frame("x")); r = metrics(se["points"], p)
        rows.append({"predictor": name, "rmse_2024": r["rmse"], "r2_2024": r["r2"], "pearson": r["pearson"]})
    h1p = pd.DataFrame(rows); print(h1p.round(4).to_string(index=False)); OUT["H1_predictive"] = h1p.to_dict("records")
    # ---------------- H2 implied total vs spread (team punts, Poisson, fit <=2023, score 2024)
    print("== H2 team punts: Vegas variants, base = volume + offense + opponent defense (fit <=2023, scored on 2024)")
    base = FEATURE_GROUPS["volume"] + FEATURE_GROUPS["A_offense"] + FEATURE_GROUPS["B_opp_defense"]
    t_tr, t_se = team[team.season <= TRAIN_END], team[team.season == SELECT_YEAR]
    def tm(cols):
        m = pipe(PoissonRegressor(alpha=1e-3, max_iter=500)).fit(t_tr[cols], t_tr["punts"]); return metrics(t_se["punts"], m.predict(t_se[cols]))
    t_tr = t_tr.assign(abs_spread=t_tr.spread.abs()); t_se = t_se.assign(abs_spread=t_se.spread.abs())
    rows = []
    variants = {"volume only (no Vegas, no matchup)": FEATURE_GROUPS["volume"], "spread alone (+volume)": FEATURE_GROUPS["volume"] + ["spread"],
                "implied total alone (+volume)": FEATURE_GROUPS["volume"] + ["implied"], "game total alone (+volume)": FEATURE_GROUPS["volume"] + ["total_line"],
                "spread + total (+volume)": FEATURE_GROUPS["volume"] + ["spread", "total_line"],
                "offense EPA + opponent defense (no Vegas)": base,
                "base + spread": base + ["spread"], "base + implied": base + ["implied"], "base + total": base + ["total_line"], "base + all Vegas": base + FEATURE_GROUPS["C_vegas"]}
    for k, cols in variants.items():
        r = tm(cols); r["variant"] = k; rows.append(r)
    h2 = pd.DataFrame(rows); print(h2[["variant", "n", "rmse", "mae", "r2"]].round(4).to_string(index=False)); OUT["H2"] = h2.to_dict("records")
    # coefficients on standardized Vegas inputs given base (full 2012-2023 Poisson GLM, robust SE)
    X = t_tr[base + FEATURE_GROUPS["C_vegas"]].copy(); X = (X - X.mean()) / X.std(); X = sm.add_constant(X.fillna(0))
    glm = sm.GLM(t_tr["punts"].to_numpy(), X, family=sm.families.Poisson()).fit(cov_type="HC1")
    co = pd.DataFrame({"coef": glm.params, "z": glm.tvalues})[["spread" in i or "implied" in i or "total" in i for i in glm.params.index]]
    print(co.round(3)); OUT["H2_vegas_coefs_given_base"] = co.round(4).to_dict()
    # ---------------- H3 spread buckets
    print("== H3 spread buckets (team side; 2012-2024 descriptive)")
    def bucket(s):
        return ("1 fav 7+" if s >= 7 else "2 fav 3-6.5" if s >= 3 else "3 within 2.5" if s > -3 else "4 dog 3-6.5" if s > -7 else "5 dog 7-10" if s > -10.5 else "6 dog >10")
    team["bucket"] = team["spread"].map(bucket)
    qtr = pd.read_parquet(os.path.join(P, "punts.parquet"))[["game_id", "team", "qtr", "score_differential"]]
    q4 = qtr[qtr.qtr == 4].groupby(["game_id", "team"]).size().rename("q4_punts").reset_index()
    team = team.merge(q4, on=["game_id", "team"], how="left"); team["q4_punts"] = team["q4_punts"].fillna(0)
    pgp = pg[["game_id", "team", "points"]]; tp = team.merge(pgp, on=["game_id", "team"], how="left")
    g = tp.groupby("bucket").agg(n=("punts", "size"), drives=("drives", "mean"), punts=("punts", "mean"), punt_per_drive=("punts", "sum"), d=("drives", "sum"),
                                 fourth_go=("fourth_go", "mean"), turnovers=("tos", "mean"), tod=("tods", "mean"), i20=("punt_i20", "mean"), q4_punts=("q4_punts", "mean"),
                                 ups_points=("points", "mean"), o_epa=("o_epa", "mean"))
    g["punt_per_drive"] = g["punt_per_drive"] / g["d"]; g = g.drop(columns="d"); print(g.round(3)); OUT["H3_buckets"] = g.round(4).reset_index().to_dict("records")
    m = smf.glm("punts ~ C(bucket, Treatment('3 within 2.5')) + o_epa + o_drives + opp_d_epa", data=tp.dropna(subset=["o_epa", "opp_d_epa", "o_drives"]), family=sm.families.Poisson()).fit(cov_type="HC1")
    co = pd.DataFrame({"coef": m.params, "se": m.bse, "z": m.tvalues}); co = co[co.index.str.contains("bucket")]
    co.index = [i.split("[T.")[1].rstrip("]") for i in co.index]; print("Poisson bucket effects on punts, controlling o_epa/o_drives/opp_d_epa (log scale vs 'within 2.5'):"); print(co.round(3))
    OUT["H3_bucket_effects_controlled"] = co.round(4).to_dict()
    # ---------------- H4 offense type vs I20
    print("== H4 offense type (pre-game EW) vs inside-20 production, per punt (2012-2024)")
    pts_ = pd.read_parquet(os.path.join(P, "punts.parquet")); pts_ = pts_[(pts_.season >= 2012) & (pts_.season <= SELECT_YEAR)]
    pts_ = pts_.merge(team[["game_id", "team", "o_epa", "o_ypd", "o_ppd", "o_tno_rate", "o_start_yl"]], on=["game_id", "team"], how="left")
    pts_["epa_q"] = pd.qcut(pts_["o_epa"], 5, labels=["1 worst", "2", "3", "4", "5 best"])
    a = pts_.groupby("epa_q").agg(punts=("los", "size"), mean_los=("los", "mean"), i20_rate=("punt_inside_twenty", "mean"), exp_i20=("exp_i20", "mean"), tb=("punt_in_endzone", "mean"), gross=("kick_distance", "mean"))
    print(a.round(3)); OUT["H4_epa_quintiles"] = a.round(4).reset_index().astype({"epa_q": str}).to_dict("records")
    med = pts_[["o_ypd", "o_ppd"]].median()
    pts_["type"] = np.where((pts_.o_ypd >= med.o_ypd) & (pts_.o_ppd < med.o_ppd), "functional-but-stalled (yds/drive high, pts/drive low)",
                   np.where((pts_.o_ypd < med.o_ypd) & (pts_.o_ppd < med.o_ppd), "bad (low yds, low pts)", np.where(pts_.o_ppd >= med.o_ppd, "scoring offense", "other")))
    b = pts_.groupby("type").agg(punts=("los", "size"), mean_los=("los", "mean"), i20_rate=("punt_inside_twenty", "mean"), exp_i20=("exp_i20", "mean")); b["i20_minus_expected"] = b.i20_rate - b.exp_i20
    print(b.round(3)); OUT["H4_types"] = b.round(4).reset_index().to_dict("records")
    # ---------------- H5 opportunity adjusted
    print("== H5 next-game inside-20 prediction (GLM deviance per punter-game, fit<=2023, scored 2024; lower is better)")
    pgi = pg[pg.punts > 0].copy()
    pgi["raw_ew_rate"] = np.nan
    # raw punter I20 rate (EW) built point-in-time from punter history (no opportunity adjustment), shrunk n0=100
    pgi = pgi.sort_values(["gsis_id", "date"]); pgi["cum_i20"] = pgi.groupby("gsis_id")["i20"].cumsum() - pgi["i20"]; pgi["cum_p"] = pgi.groupby("gsis_id")["punts"].cumsum() - pgi["punts"]
    pgi["raw_rate"] = (pgi["cum_i20"] + 100 * 0.37) / (pgi["cum_p"] + 100)
    pgi["raw_logit"] = np.log(pgi.raw_rate / (1 - pgi.raw_rate))
    from punter_models import base_i20
    los = pgi["o_punt_los"].fillna(pgi["o_punt_los"].median()); b0 = np.clip(base_i20(los, pgi.dome, pgi.wind, pgi.temp, pgi.altitude), .02, .98)
    pgi["base_logit"] = np.log(b0 / (1 - b0))
    trn, tst = pgi[pgi.season <= TRAIN_END], pgi[pgi.season == SELECT_YEAR]
    def dev(cols):
        X = sm.add_constant(trn[cols].fillna(0), has_constant="add") if cols else np.ones((len(trn), 1))
        m = sm.GLM(np.column_stack([trn.i20, trn.punts - trn.i20]), X, family=sm.families.Binomial()).fit()
        Xt = sm.add_constant(tst[cols].fillna(0), has_constant="add") if cols else np.ones((len(tst), 1)); p = np.clip(m.predict(Xt), 1e-4, 1 - 1e-4)
        ll = tst.i20 * np.log(p) + (tst.punts - tst.i20) * np.log(1 - p); return float(-2 * ll.sum() / tst.punts.sum()), m
    h5 = {"league constant": dev([])[0], "opportunity only (LOS curve)": dev(["base_logit"])[0], "raw punter I20% only": dev(["raw_logit"])[0],
          "raw punter I20% + opportunity": dev(["base_logit", "raw_logit"])[0], "opportunity + adjusted punter skill (pk_i20_resid)": dev(["base_logit", "pk_i20_resid"])[0]}
    h5 = pd.Series(h5); print((h5).round(5)); OUT["H5_deviance_per_punt"] = h5.round(5).to_dict()
    # ---------------- H6 stability
    print("== H6 punter persistence: season-to-season r (>=40 punts both seasons) and split-half reliability")
    pt = pd.read_parquet(os.path.join(P, "punts.parquet")); pt = pt[(pt.season >= 2012) & (pt.season <= SELECT_YEAR)]
    pt["net"] = pt["kick_distance"] - pt["return_yards"].fillna(0) - 20 * pt["punt_in_endzone"]; pt["fc"] = pt["punt_fair_catch"]
    ps = pt.groupby(["punter_player_id", "season"]).agg(n=("los", "size"), gross=("kick_distance", "mean"), net=("net", "mean"), i20=("punt_inside_twenty", "mean"), tb=("punt_in_endzone", "mean"), fc=("fc", "mean"),
                                                       exp_i20=("exp_i20", "mean")).reset_index(); ps["i20_adj"] = ps.i20 - ps.exp_i20
    upg = pg.groupby(["gsis_id", "season"]).agg(ups_pg=("points", "mean"), games=("points", "size"), punts_pg=("punts", "mean")).reset_index().rename(columns={"gsis_id": "punter_player_id"})
    ps = ps.merge(upg, on=["punter_player_id", "season"], how="left"); ps = ps[ps.n >= 40]
    nxt = ps.copy(); nxt["season"] = nxt["season"] - 1
    j = ps.merge(nxt, on=["punter_player_id", "season"], suffixes=("", "_next"))
    st = {m: float(np.corrcoef(j.dropna(subset=[m, m + "_next"])[m], j.dropna(subset=[m, m + "_next"])[m + "_next"])[0, 1]) for m in ["gross", "net", "i20", "i20_adj", "tb", "fc", "ups_pg", "punts_pg"]}
    print(pd.Series(st).round(3).to_string(), "\n n punter-season pairs:", len(j)); OUT["H6_year_to_year_r"] = {k: round(v, 4) for k, v in st.items()}; OUT["H6_pairs"] = int(len(j))
    pt["half"] = (pt.groupby(["punter_player_id", "season"]).cumcount() % 2)
    h = pt.groupby(["punter_player_id", "season", "half"]).agg(n=("los", "size"), gross=("kick_distance", "mean"), net=("net", "mean"), i20=("punt_inside_twenty", "mean"), tb=("punt_in_endzone", "mean"), fc=("fc", "mean")).reset_index()
    h = h[h.n >= 25].pivot(index=["punter_player_id", "season"], columns="half", values=["gross", "net", "i20", "tb", "fc"]).dropna()
    sh = {m: float(np.corrcoef(h[(m, 0)], h[(m, 1)])[0, 1]) for m in ["gross", "net", "i20", "tb", "fc"]}
    sb = {m: round(2 * r / (1 + r), 3) for m, r in sh.items()}
    print("split-half r (odd/even punts):", {k: round(v, 3) for k, v in sh.items()}, "\nSpearman-Brown full-season reliability:", sb); OUT["H6_split_half_r"] = {k: round(v, 4) for k, v in sh.items()}; OUT["H6_spearman_brown"] = sb
    json.dump(OUT, open(os.path.join(RES, "hypotheses_dev.json"), "w"), indent=1, default=str)

if __name__ == "__main__":
    main()
