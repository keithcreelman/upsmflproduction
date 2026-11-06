#!/usr/bin/env python3
"""Models A+B: team punts per game. Compares baselines, ridge, Poisson, negative binomial, gradient boosting, a hierarchical
(team + coach random effects) model and the decomposed drives x punt-rate model, over cumulative feature groups.
Development mode evaluates ONLY on the 2024 selection season (training <= 2023). The locked 2025 run is run_locked_test.py.
Usage: train_volume_model.py [--final]  (--final trains through 2024 and predicts 2025 + 2026; used only by the locked run)"""
import os, sys, json, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from punter_common import *
from sklearn.linear_model import Ridge, PoissonRegressor
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
import statsmodels.api as sm
import statsmodels.formula.api as smf

CUM = ["volume", "A_offense", "B_opp_defense", "C_vegas", "D_coaching", "F_environment"]

def cols_for(groups):
    out = []
    for g in groups: out += FEATURE_GROUPS[g]
    return list(dict.fromkeys(out))

def prep(df, cols):
    return df[cols].astype(float)

def fit_predict(kind, tr, te, cols, target="punts"):
    Xtr, Xte = prep(tr, cols), prep(te, cols)
    ytr = tr[target].astype(float).to_numpy()
    if kind == "baseline_rolling":
        return (te["o_punt_rate"] * te["o_drives"]).to_numpy()
    if kind == "baseline_league":
        return np.full(len(te), ytr.mean())
    pre = lambda m: make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), m)
    if kind == "ridge":
        return pre(Ridge(alpha=50.0)).fit(Xtr, ytr).predict(Xte)
    if kind == "poisson":
        return pre(PoissonRegressor(alpha=1e-3, max_iter=500)).fit(Xtr, ytr).predict(Xte)
    if kind == "negbin":
        imp = SimpleImputer(strategy="median").fit(Xtr); sc = StandardScaler().fit(imp.transform(Xtr))
        A = sm.add_constant(sc.transform(imp.transform(Xtr)), has_constant="add")
        pois = sm.GLM(ytr, A, family=sm.families.Poisson()).fit()
        mu = pois.mu; alpha = max(((ytr - mu) ** 2 - mu).sum() / (mu ** 2).sum(), 1e-4)
        nb = sm.GLM(ytr, A, family=sm.families.NegativeBinomial(alpha=alpha)).fit()
        B = sm.add_constant(sc.transform(imp.transform(Xte)), has_constant="add")
        kind_alpha[target] = alpha
        return nb.predict(B)
    if kind == "gbm":
        return HistGradientBoostingRegressor(loss="poisson", max_depth=3, learning_rate=0.04, max_iter=250, min_samples_leaf=60, l2_regularization=2.0,
                                             random_state=7).fit(Xtr, ytr).predict(Xte)
    if kind == "hier":
        # team random intercept + coach variance component on top of the Poisson-style fixed part (linear approx on log scale)
        tr2 = tr.copy(); te2 = te.copy()
        imp = SimpleImputer(strategy="median").fit(Xtr); sc = StandardScaler().fit(imp.transform(Xtr))
        names = ["x%d" % i for i in range(len(cols))]
        tr2[names] = sc.transform(imp.transform(Xtr)); te2[names] = sc.transform(imp.transform(Xte))
        f = "punts ~ " + " + ".join(names)
        m = smf.mixedlm(f, tr2, groups=tr2["team"], vc_formula={"coach": "0 + C(coach)"}, re_formula="1").fit(method="lbfgs", reml=False, maxiter=200)
        fe = m.predict(te2)
        re_team = {k: float(v.iloc[0]) for k, v in m.random_effects.items()}
        return fe.to_numpy() + te2["team"].map(re_team).fillna(0.0).to_numpy()
    raise ValueError(kind)

kind_alpha = {}

def decomposed(tr, te, cols_drives, cols_rate):
    """Expected punts = expected drives x punt probability per drive (binomial GLM)."""
    drv = fit_predict("ridge", tr, te, cols_drives, target="drives")
    imp = SimpleImputer(strategy="median").fit(prep(tr, cols_rate)); sc = StandardScaler().fit(imp.transform(prep(tr, cols_rate)))
    A = sm.add_constant(sc.transform(imp.transform(prep(tr, cols_rate))), has_constant="add")
    k = tr["punts"].to_numpy(float); n = tr["drives"].to_numpy(float)
    m = sm.GLM(np.column_stack([np.minimum(k, n), np.maximum(n - k, 0)]), A, family=sm.families.Binomial()).fit()
    B = sm.add_constant(sc.transform(imp.transform(prep(te, cols_rate))), has_constant="add")
    return drv * m.predict(B), drv

def main(final=False):
    d = team_frame(); mk = split_masks(d)
    tr = d[mk["train"] | (mk["select"] if final else False)]
    te = d[mk["test"] if final else mk["select"]]
    rows = []
    def rec(name, kind, groups, pred):
        r = metrics(te["punts"], pred); r.update({"model": kind, "features": name}); rows.append(r)
    rec("-", "baseline_league", [], fit_predict("baseline_league", tr, te, []))
    rec("rolling punts/drive x drives (no fit)", "baseline_rolling", ["volume"], fit_predict("baseline_rolling", tr, te, []))
    for i in range(len(CUM)):
        groups = CUM[: i + 1]; cols = cols_for(groups); label = "+".join(g.split("_")[0] for g in groups)
        for kind in ["ridge", "poisson", "negbin", "gbm"] + (["hier"] if i in (0, len(CUM) - 1) else []):
            try: rec(label, kind, groups, fit_predict(kind, tr, te, cols))
            except Exception as e: print("FAILED", kind, label, e)
    # decomposed drives x punt-rate
    for i in (1, len(CUM) - 1):
        groups = CUM[: i + 1]; cols = cols_for(groups)
        p, _ = decomposed(tr, te, cols_for(["volume", "A_offense", "C_vegas", "F_environment"]), cols)
        rec("+".join(g.split("_")[0] for g in groups), "decomposed_drives_x_rate", groups, p)
    out = pd.DataFrame(rows)
    tag = "final_2025" if final else "dev_2024"
    out.to_csv(os.path.join(RES, "volume_models_%s.csv" % tag), index=False)
    pd.set_option("display.width", 200)
    print(out.sort_values("rmse")[["features", "model", "n", "rmse", "mae", "r2", "bias"]].round(4).to_string(index=False))
    print("NB alpha:", kind_alpha)

if __name__ == "__main__":
    main(final="--final" in sys.argv)
