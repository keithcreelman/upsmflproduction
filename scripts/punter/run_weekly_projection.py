#!/usr/bin/env python3
"""Weekly projections for upcoming games (10,000 simulated games per punter) + the point-in-time archive.
Usage: run_weekly_projection.py --season 2026 --weeks 8 9 [--sims 10000]
* Trains on every completed game strictly before the cutoff (seasons < season + 2026 weeks already played).
* Each team's punter = the punter who punted for the team in its most recent game (no depth-chart feed is available point-in-time).
* Games with no posted Vegas line use the no-Vegas model; forecast weather is not stored, so outdoor games use neutral weather.
* Output + manifest are written under data/punter/projections/ and never overwritten (timestamped)."""
import os, sys, json, hashlib, subprocess, datetime as dt, argparse, warnings, numpy as np, pandas as pd
warnings.filterwarnings("ignore")
sys.path.insert(0, os.path.dirname(__file__))
from run_backtest import *
OUTDIR = os.path.join(ROOT, "data", "punter", "projections"); os.makedirs(OUTDIR, exist_ok=True)
GROUPS = {"volume": ["o_punt_rate", "o_drives", "lg_punt_rate"], "offense": FEATURE_GROUPS["A_offense"], "matchup": FEATURE_GROUPS["B_opp_defense"],
          "Vegas": FEATURE_GROUPS["C_vegas"], "coaching": FEATURE_GROUPS["D_coaching"],
          "punter skill": ["pk_gross", "pk_gross_last5", "pk_i20_resid", "pk_tb_resid", "pk_blk"], "weather/venue": ["dome", "wind", "temp", "altitude", "home"]}

def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()[:16]

def current_punters(pg, season):
    last = pg[pg.season == season].sort_values(["date", "game_id"]).groupby("team").tail(1)
    return last[["team", "gsis_id", "punter_name"]]

def build_rows(team_all, pg, season, week):
    """Rows for upcoming games: team features (pre-game by construction) + the team's last punter's current state."""
    lc = league_context()
    t = team_all[(team_all.season == season) & (team_all.week == week)].copy().merge(lc, on=["season", "week"], how="left")
    cp = current_punters(pg, season)
    state = pd.read_parquet(os.path.join(P, "punter_state_current.parquet"))
    t = t.merge(cp, on="team", how="left").merge(state, on="gsis_id", how="left")
    outdoor = ~t["roof"].isin(["dome", "closed"])
    t.loc[outdoor & t["wind"].isna(), "wind"] = 8.0; t.loc[outdoor & t["temp"].isna(), "temp"] = 58.0     # neutral outdoor weather (no stored forecast)
    t["wind"] = t["wind"].fillna(0.0); t["temp"] = t["temp"].fillna(68.0)
    return t

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--season", type=int, default=2026); ap.add_argument("--weeks", type=int, nargs="+", default=[8, 9]); ap.add_argument("--sims", type=int, default=10000)
    a = ap.parse_args()
    team, pg = load()
    team_all = pd.read_parquet(os.path.join(P, "team_features.parquet"))
    team_l = team
    ff = pd.read_parquet(os.path.join(P, "ff_playerids.parquet"))[["gsis_id", "mfl_id", "name"]]
    cutoff = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"); data_through = str(pd.to_datetime(team_all[(team_all.season == a.season) & team_all.punts.notna()].date).max().date())
    models = {v: Model(a.season + 0.5, with_vegas=v).fit(team_l, pg) for v in (True, False)}
    outs = []
    for wk in a.weeks:
        X = build_rows(team_all, pg, a.season, wk).reset_index(drop=True)
        X["has_line"] = X["total_line"].notna()
        S = a.sims; sims = np.zeros((len(X), S)); comp = {}
        pieces = []
        for v in (True, False):
            idx = X.index[X.has_line == v]
            if len(idx) == 0: continue
            Xi = X.loc[idx]
            if not v: Xi = Xi.assign(**{c: 0.0 for c in VEGAS})
            PTS, N, I20, avg, c = models[v].simulate(Xi, S=S, seed=20260 + wk)
            Pc = np.where(N >= 1, PTS, np.nan); sims[idx] = PTS
            part = pd.DataFrame({"idx": idx, "exp_punts": N.mean(1), "exp_i20": I20.mean(1), "exp_gross": c[3], "mean": np.nanmean(Pc, 1), "median": np.nanmedian(Pc, 1),
                                 "p10": np.nanquantile(Pc, .1, 1), "p90": np.nanquantile(Pc, .9, 1), "p_no_punt": (N == 0).mean(1)})
            # reasons: neutralize one feature group at a time (common random numbers) and report the change in mean points
            for gname, cols in GROUPS.items():
                Xn = Xi.copy()
                for cname in cols:
                    if cname in Xn.columns: Xn[cname] = Xn[cname].mean() if Xn[cname].notna().any() else Xn[cname]
                P2, N2, *_ = models[v].simulate(Xn, S=2000, seed=20260 + wk); P1, N1, *_ = models[v].simulate(Xi, S=2000, seed=20260 + wk)
                part["why_" + gname] = np.nanmean(np.where(N1 >= 1, P1, np.nan), 1) - np.nanmean(np.where(N2 >= 1, P2, np.nan), 1)
            pieces.append(part)
        part = pd.concat(pieces).set_index("idx").sort_index()
        X = X.join(part)
        # joint ranks among the week's punters (independent games) -> P(top-3), P(top-6)
        rng = np.random.default_rng(7 + wk); jit = sims + rng.random(sims.shape) * 1e-6
        rk = (-jit).argsort(0).argsort(0) + 1
        X["p_top3"] = (rk <= 3).mean(1); X["p_top6"] = (rk <= 6).mean(1)
        def reasons(r):
            d = {k[4:]: r[k] for k in r.index if k.startswith("why_")}
            pos = sorted([(k, v) for k, v in d.items() if v > 0.15], key=lambda kv: -kv[1])[:2]; neg = sorted([(k, v) for k, v in d.items() if v < -0.15], key=lambda kv: kv[1])[:2]
            return "; ".join(["+%s %.1f" % kv for kv in pos] + ["%s %.1f" % kv for kv in neg]) or "near league average"
        X["reasons"] = X.apply(reasons, axis=1); X["week"] = wk
        X = X.merge(ff.rename(columns={"name": "ff_name"}), on="gsis_id", how="left")
        outs.append(X)
    R = pd.concat(outs)
    cols = ["week", "punter_name", "team", "opp", "exp_punts", "exp_i20", "exp_gross", "mean", "median", "p10", "p90", "p_top3", "p_top6", "p_no_punt", "reasons",
            "has_line", "spread", "total_line", "implied", "pk_n_punts", "pk_gross", "pk_i20_resid", "mfl_id", "gsis_id"]
    R = R[cols].rename(columns={"mean": "ups_mean"}).sort_values(["week", "ups_mean"], ascending=[True, False])
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    f = os.path.join(OUTDIR, "projections_%d_wk%s_%s.csv" % (a.season, "-".join("%02d" % w for w in a.weeks), stamp)); R.to_csv(f, index=False)
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    man = {"created_utc": cutoff, "data_through_game_date": data_through, "season": a.season, "weeks": a.weeks, "sims_per_punter": a.sims, "git_head": commit,
           "inputs_sha256_16": {n: sha(os.path.join(P, n)) for n in ["team_features.parquet", "punter_games.parquet", "punter_state_current.parquet", "punts.parquet"]},
           "notes": ["Vegas lines: nflverse stored lines; weeks with no posted line use the no-Vegas model", "forecast weather not stored: neutral outdoor weather", "punter = last game's punter per team"],
           "output": os.path.basename(f), "output_sha256_16": sha(f)}
    json.dump(man, open(os.path.join(ROOT, "data", "punter", "manifests", os.path.basename(f).replace(".csv", ".manifest.json")), "w"), indent=1)
    pd.set_option("display.width", 250); pd.set_option("display.max_colwidth", 60)
    for wk in a.weeks:
        print("\n=== Week %d" % wk)
        print(R[R.week == wk][["punter_name", "team", "opp", "exp_punts", "exp_i20", "exp_gross", "ups_mean", "median", "p10", "p90", "p_top3", "p_top6", "reasons"]].round(2).to_string(index=False))
    print("\nwrote", f)

if __name__ == "__main__":
    main()
