"""Component models + Monte Carlo for UPS punter weekly points.
volume (team punts/drives, Poisson/Ridge) x punt probability -> N punts; inside-20 (binomial GLM on LOS-curve base + punter skill + weather);
gross average (ridge on punter skill + context); exact UPS scoring (4/PI, ANY tiers 45/50/60 = 1/3/5, -2/blocked punt) applied per simulated game."""
import os, sys, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from punter_common import *
from sklearn.linear_model import Ridge, PoissonRegressor
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.impute import SimpleImputer
import statsmodels.api as sm

COEF = np.load(os.path.join(P, "los_curve_coef.npy"))[0]
VOL_COLS = ["lg_punt_rate"] + FEATURE_GROUPS["volume"] + FEATURE_GROUPS["A_offense"] + FEATURE_GROUPS["B_opp_defense"] + FEATURE_GROUPS["D_coaching"]
VEGAS = FEATURE_GROUPS["C_vegas"]
ENV = ["dome", "wind", "temp", "altitude"]
LG = ["lg_punt_rate"]
MFL_RULES = {"PI": 4.0, "HBP": -2.0, "ANY": [(45.0, 1.0), (50.0, 3.0), (60.0, 5.0)]}

def ups_points(i20, avg, blocked, n):
    pts = MFL_RULES["PI"] * i20 + MFL_RULES["HBP"] * blocked
    tier = np.where(avg >= 60, 5.0, np.where(avg >= 50, 3.0, np.where(avg >= 45, 1.0, 0.0)))
    return pts + np.where(n > 0, tier, 0.0)

def base_i20(los, dome, wind, temp, alt):
    z = COEF[0] * los + COEF[1] * los ** 2 / 100.0 + COEF[2] * dome + COEF[3] * wind + COEF[4] * temp + COEF[5] * alt
    return 1 / (1 + np.exp(-z))

def pipe(m): return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), m)

class Model:
    """Fit on team-games and punter-games strictly before `year`; predict for rows of `year` (or any future rows with features)."""
    def __init__(self, year, with_vegas=True):
        self.year, self.with_vegas = year, with_vegas
    def fit(self, team, pg):
        tr = team[(team.season < self.year) & team.punts.notna()]
        cols = VOL_COLS + (VEGAS if self.with_vegas else []) 
        self.cols = cols
        self.pm = pipe(PoissonRegressor(alpha=1e-3, max_iter=600)).fit(tr[cols], tr["punts"])
        drv_cols = FEATURE_GROUPS["volume"] + FEATURE_GROUPS["A_offense"] + (VEGAS if self.with_vegas else []) + ENV + ["home"]
        self.drv_cols = drv_cols
        self.dm = pipe(Ridge(alpha=50.0)).fit(tr[drv_cols], tr["drives"])
        self.sd_drives = float(np.std(tr["drives"] - self.dm.predict(tr[drv_cols])))
        # inside-20: binomial GLM on punter-games
        p = pg[(pg.season < self.year) & (pg.punts > 0)].copy(); p = self._i20_x(p)
        X = sm.add_constant(p[self.i20_cols].fillna(0.0), has_constant="add")
        self.i20m = sm.GLM(np.column_stack([p["i20"], p["punts"] - p["i20"]]), X, family=sm.families.Binomial()).fit()
        # gross average
        self.gcols = ["pk_gross", "pk_gross_last5", "lg_gross", "o_punt_los", "wind", "temp", "dome", "altitude", "home"]
        g = pg[(pg.season < self.year) & (pg.punts > 0) & pg.gross.notna()].copy(); g["pk_gross_last5"] = g["pk_gross_last5"].fillna(g["pk_gross"])
        self.gm = pipe(Ridge(alpha=20.0)).fit(g[self.gcols], g["gross"], ridge__sample_weight=g["punts"])
        res = g["gross"] - self.gm.predict(g[self.gcols])
        self.sd_punt = 8.9
        self.tau = float(np.sqrt(max(np.average(res ** 2, weights=g["punts"]) - np.mean(self.sd_punt ** 2 / g["punts"]), 1.0)))
        self.blk = float(pg[pg.season < self.year]["blocked"].sum() / pg[pg.season < self.year]["punts_all"].sum())
        return self
    i20_cols = ["base_logit", "pk_i20_resid", "wind", "dome", "temp10", "lg_logit"]
    def _i20_x(self, p):
        los = p["o_punt_los"].fillna(p["o_punt_los"].median() if len(p) else 40.0)
        b = np.clip(base_i20(los, p["dome"], p["wind"], p["temp"], p["altitude"]), 0.02, 0.98)
        p["base_logit"] = np.log(b / (1 - b)); p["temp10"] = p["temp"] / 10.0
        lg = np.clip(p["lg_i20_rate"].fillna(0.37), 0.2, 0.6); p["lg_logit"] = np.log(lg / (1 - lg)) - np.log(0.37 / 0.63)
        return p
    def components(self, X):
        X = X.copy(); X["wind"] = X["wind"].fillna(0.0); X["temp"] = X["temp"].fillna(68.0)
        punts = self.pm.predict(X[self.cols]); drives = np.clip(self.dm.predict(X[self.drv_cols]), 6, 18)
        Xi = self._i20_x(X); Z = sm.add_constant(Xi[self.i20_cols].fillna(0.0), has_constant="add")
        p20 = self.i20m.predict(Z).to_numpy()
        gx = X.copy(); gx["pk_gross_last5"] = gx["pk_gross_last5"].fillna(gx["pk_gross"])
        mu = self.gm.predict(gx[self.gcols])
        return punts, drives, p20, mu
    def simulate(self, X, S=5000, seed=11):
        rng = np.random.default_rng(seed)
        punts, drives, p20, mu = self.components(X); R = len(X)
        pr = np.clip(punts / drives, 0.02, 0.9)
        D = np.clip(np.rint(rng.normal(drives[:, None], self.sd_drives, (R, S))), 5, 20)
        N = rng.binomial(D.astype(int), pr[:, None])
        I20 = rng.binomial(N, p20[:, None]); BLK = rng.binomial(N, self.blk)
        sd = self.sd_punt / np.sqrt(np.maximum(N, 1))
        avg = mu[:, None] + rng.normal(0.0, 1.0, (R, S)) * np.sqrt(sd ** 2 + self.tau ** 2)
        PTS = ups_points(I20, avg, BLK, N)
        return PTS, N, I20, avg, (punts, drives, p20, mu)

def summarize(PTS, N, I20, avg, comp):
    punts, drives, p20, mu = comp
    Pc = np.where(N >= 1, PTS, np.nan)          # a punter who never punts has no MFL row; conditional on N>=1 is what a played game looks like
    return pd.DataFrame({"exp_punts": N.mean(1), "exp_i20": I20.mean(1), "exp_gross": mu, "p_no_punt": (N == 0).mean(1),
                         "mean_all": PTS.mean(1), "mean": np.nanmean(Pc, 1), "median": np.nanmedian(Pc, 1),
                         "p10": np.nanquantile(Pc, .1, 1), "p90": np.nanquantile(Pc, .9, 1)})
