#!/usr/bin/env python3
"""Phase 4 — does adding rate_20plus improve RB next-year fantasy projection?

The univariate correlation of rate_20plus to fpoe_per_g is +0.50 (n=385).
But high univariate correlation doesn't mean a feature ADDS information on
top of baseline volume + efficiency stats. This script tests marginal R²:

  Model A (baseline): att, ypc, rush_tds_per_g, rec_per_g, rec_yds_per_g,
                       fp_per_g, fpoe_per_g, vegas_implied_total_n1,
                       coach_change_n1
  Model B (test):     baseline + rate_20plus

Target Y = fp_per_g in year N+1 (predicting next-season fantasy points).
Features measured in year N, except Vegas + coaching which use year N+1
(forward-looking context the auction would have at draft time).

Sample: RB-classified player-seasons with >= 100 carries in year N and
        >= 6 games played in year N+1.

Reports:
  - In-sample R² (and adj R²) for both models
  - Leave-one-season-out cross-validation RMSE
  - Coefficient, std error, t-stat, p-value for rate_20plus in Model B
  - Recommendation: integrate or pass

Usage:
  python3 pipelines/etl/scripts/regression_test_breakaway.py
"""
from __future__ import annotations
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"

MIN_CARRIES_N = 100        # year-N min carries for inclusion
MIN_GAMES_N1 = 6           # year-N+1 min games to count as a target


def wrangler_query(sql: str) -> list[dict]:
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    res = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"wrangler failed: {res.stderr[:1000]}")
    return json.loads(res.stdout)[0]["results"]


def pull_data():
    print("Pulling D1 data...", file=sys.stderr)
    breakaway = wrangler_query(
        "SELECT season, gsis_id, attempts, plays_20plus "
        "FROM nfl_player_breakaway_season WHERE role='rusher' AND season>=2018"
    )
    fpoe = wrangler_query(
        "SELECT season, gsis_id, position, games, total_fp, fpoe_per_g "
        "FROM nfl_player_ff_opportunity_season WHERE season>=2018"
    )
    # Aggregate per-player season stats from weekly. Position MODE per season.
    weekly = wrangler_query(
        "SELECT season, gsis_id, "
        "       SUM(COALESCE(rush_att,0))   AS rush_att, "
        "       SUM(COALESCE(rush_yds,0))   AS rush_yds, "
        "       SUM(COALESCE(rush_tds,0))   AS rush_tds, "
        "       SUM(COALESCE(receptions,0)) AS rec, "
        "       SUM(COALESCE(rec_yds,0))    AS rec_yds, "
        "       COUNT(*)                    AS weeks "
        "FROM nfl_player_weekly WHERE season>=2018 "
        "GROUP BY season, gsis_id"
    )
    pos_per_season = wrangler_query(
        "SELECT season, gsis_id, position, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season>=2018 AND position IS NOT NULL AND position != '' "
        "GROUP BY season, gsis_id, position"
    )
    # Player team per season — pick the team where they had the most weeks
    team_per_season = wrangler_query(
        "SELECT season, gsis_id, team, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season>=2018 AND team IS NOT NULL AND team != '' "
        "GROUP BY season, gsis_id, team"
    )
    # Vegas — season mean of implied_total per team
    vegas = wrangler_query(
        "SELECT season, team, AVG(implied_total) AS implied_total_avg "
        "FROM nfl_team_vegas_weekly WHERE season>=2018 AND implied_total IS NOT NULL "
        "GROUP BY season, team"
    )
    coaching = wrangler_query(
        "SELECT season, team, hc_change_flag, oc_change_flag "
        "FROM nfl_team_coaching_history WHERE season>=2018"
    )
    print(f"  breakaway: {len(breakaway)}, fpoe: {len(fpoe)}, weekly: {len(weekly)}, "
          f"vegas: {len(vegas)}, coaching: {len(coaching)}", file=sys.stderr)
    return breakaway, fpoe, weekly, pos_per_season, team_per_season, vegas, coaching


def build_pos_map(pos_per_season):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in pos_per_season:
        by_key[(r["gsis_id"], r["season"])][r["position"]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def build_team_map(team_per_season):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in team_per_season:
        by_key[(r["gsis_id"], r["season"])][r["team"]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def build_dataset(breakaway, fpoe, weekly, pos_map, team_map, vegas, coaching):
    weekly_idx = {(r["gsis_id"], r["season"]): r for r in weekly}
    fpoe_idx = {(r["gsis_id"], r["season"]): r for r in fpoe}
    brk_idx = {(r["gsis_id"], r["season"]): r for r in breakaway}
    vegas_idx = {(r["season"], r["team"]): r["implied_total_avg"] for r in vegas}
    coach_idx = {(r["season"], r["team"]): r for r in coaching}

    rows = []  # one per (player, year_n) with year_n features + year_n+1 target
    seen_pairs = set()
    for (gsis, season_n), w in weekly_idx.items():
        if pos_map.get((gsis, season_n)) not in ("RB", "FB"):
            continue
        # Need year-N+1 fantasy data
        f_n1 = fpoe_idx.get((gsis, season_n + 1))
        if not f_n1: continue
        if (f_n1.get("games") or 0) < MIN_GAMES_N1: continue
        tfp_n1 = f_n1.get("total_fp")
        games_n1 = f_n1.get("games")
        if tfp_n1 is None or games_n1 is None or games_n1 == 0:
            continue
        target = tfp_n1 / games_n1

        # Baseline features (year N)
        att = w.get("rush_att") or 0
        if att < MIN_CARRIES_N: continue
        ypc = (w.get("rush_yds") or 0) / att
        weeks = w.get("weeks") or 0
        if weeks <= 0: continue
        rush_tds_per_g = (w.get("rush_tds") or 0) / weeks
        rec_per_g = (w.get("rec") or 0) / weeks
        rec_yds_per_g = (w.get("rec_yds") or 0) / weeks

        f_n = fpoe_idx.get((gsis, season_n)) or {}
        fp_per_g_n = ((f_n.get("total_fp") or 0) / (f_n.get("games") or 1)) if f_n.get("games") else None
        fpoe_per_g_n = f_n.get("fpoe_per_g")
        if fp_per_g_n is None or fpoe_per_g_n is None:
            continue

        # rate_20plus year N
        b_n = brk_idx.get((gsis, season_n))
        if not b_n: continue
        b_att = b_n.get("attempts") or 0
        if b_att <= 0: continue
        rate_20plus = (b_n.get("plays_20plus") or 0) / b_att

        # Forward-looking context: year N+1 team's Vegas + coaching
        team_n1 = team_map.get((gsis, season_n + 1))
        if not team_n1: continue
        vegas_n1 = vegas_idx.get((season_n + 1, team_n1))
        if vegas_n1 is None: continue
        c = coach_idx.get((season_n + 1, team_n1)) or {}
        coach_change_n1 = int((c.get("hc_change_flag") or 0) or (c.get("oc_change_flag") or 0))

        rows.append({
            "gsis_id": gsis, "season_n": season_n, "season_n1": season_n + 1,
            "target": target,
            "att": att, "ypc": ypc, "rush_tds_per_g": rush_tds_per_g,
            "rec_per_g": rec_per_g, "rec_yds_per_g": rec_yds_per_g,
            "fp_per_g_n": fp_per_g_n, "fpoe_per_g_n": fpoe_per_g_n,
            "vegas_n1": float(vegas_n1), "coach_change_n1": coach_change_n1,
            "rate_20plus": rate_20plus,
        })
        seen_pairs.add((gsis, season_n))
    return rows


_FULL_BASELINE = ["att", "ypc", "rush_tds_per_g", "rec_per_g", "rec_yds_per_g",
                  "fp_per_g_n", "fpoe_per_g_n", "vegas_n1", "coach_change_n1"]
_NARROW_BASELINE = ["att", "ypc", "rush_tds_per_g", "rec_per_g", "rec_yds_per_g",
                    "vegas_n1", "coach_change_n1"]
import os
BASELINE_FEATS = _NARROW_BASELINE if os.environ.get("NARROW") else _FULL_BASELINE
BREAKAWAY_FEAT = "rate_20plus"


def make_xy(rows, features):
    X = np.array([[r[f] for f in features] for r in rows], dtype=float)
    y = np.array([r["target"] for r in rows], dtype=float)
    return X, y


def fit_ols(X, y):
    """OLS with intercept. Returns dict with coef, se, t, p, r2, adj_r2, n, k."""
    n = X.shape[0]
    X_aug = np.column_stack([np.ones(n), X])
    k = X_aug.shape[1]  # includes intercept
    XtX = X_aug.T @ X_aug
    XtX_inv = np.linalg.inv(XtX)
    beta = XtX_inv @ X_aug.T @ y
    y_hat = X_aug @ beta
    resid = y - y_hat
    rss = float(np.sum(resid ** 2))
    tss = float(np.sum((y - y.mean()) ** 2))
    r2 = 1 - rss / tss
    df_resid = n - k
    adj_r2 = 1 - (rss / df_resid) / (tss / (n - 1))
    sigma2 = rss / df_resid
    var_beta = sigma2 * np.diag(XtX_inv)
    se = np.sqrt(var_beta)
    tvals = beta / se
    pvals = 2 * (1 - stats.t.cdf(np.abs(tvals), df_resid))
    return {
        "beta": beta, "se": se, "t": tvals, "p": pvals,
        "r2": r2, "adj_r2": adj_r2,
        "rss": rss, "tss": tss, "n": n, "k": k,
        "rmse_in": float(np.sqrt(rss / n)),
    }


def cv_loso(rows, features):
    """Leave-one-season-out CV. Train on other seasons, predict the holdout.

    Returns (rmse_per_season_n1, rows_per_season_n1)."""
    by_n1 = defaultdict(list)
    for r in rows:
        by_n1[r["season_n1"]].append(r)
    out = {}
    for hold_n1 in sorted(by_n1):
        train_rows = [r for r in rows if r["season_n1"] != hold_n1]
        test_rows = by_n1[hold_n1]
        if len(train_rows) < 30 or len(test_rows) < 5:
            continue
        Xtr, ytr = make_xy(train_rows, features)
        Xte, yte = make_xy(test_rows, features)
        # Fit
        n_tr = Xtr.shape[0]
        Xtr_aug = np.column_stack([np.ones(n_tr), Xtr])
        beta = np.linalg.solve(Xtr_aug.T @ Xtr_aug, Xtr_aug.T @ ytr)
        Xte_aug = np.column_stack([np.ones(len(test_rows)), Xte])
        y_pred = Xte_aug @ beta
        rmse = float(np.sqrt(np.mean((yte - y_pred) ** 2)))
        out[hold_n1] = {"rmse": rmse, "n": len(test_rows)}
    return out


def report_model(name, fit, features):
    print(f"\n{name}:")
    print(f"  n = {fit['n']}, R² = {fit['r2']:.4f}, adj R² = {fit['adj_r2']:.4f}, "
          f"in-sample RMSE = {fit['rmse_in']:.3f}")
    print(f"  {'feature':<22} {'coef':>10} {'se':>9} {'t':>7} {'p':>9}")
    print(f"  {'-'*22} {'-'*10} {'-'*9} {'-'*7} {'-'*9}")
    names = ["(intercept)"] + features
    for i, fn in enumerate(names):
        sig = "***" if fit["p"][i] < 0.001 else \
              "**" if fit["p"][i] < 0.01 else \
              "*"  if fit["p"][i] < 0.05 else " "
        print(f"  {fn:<22} {fit['beta'][i]:>+10.4f} {fit['se'][i]:>9.4f} "
              f"{fit['t'][i]:>+7.2f} {fit['p'][i]:>8.4f}{sig}")


def main():
    breakaway, fpoe, weekly, pos_per_season, team_per_season, vegas, coaching = pull_data()
    pos_map = build_pos_map(pos_per_season)
    team_map = build_team_map(team_per_season)
    rows = build_dataset(breakaway, fpoe, weekly, pos_map, team_map, vegas, coaching)
    print(f"\nDataset: {len(rows)} (RB, year-N → year-N+1) pairs, "
          f"min {MIN_CARRIES_N} carries year-N, min {MIN_GAMES_N1} games year-N+1")
    seasons_n = sorted({r['season_n'] for r in rows})
    print(f"Year-N seasons: {seasons_n[0]}–{seasons_n[-1]} "
          f"(predicting {seasons_n[0]+1}–{seasons_n[-1]+1})")

    # Models
    Xa, y = make_xy(rows, BASELINE_FEATS)
    fit_a = fit_ols(Xa, y)
    Xb, _ = make_xy(rows, BASELINE_FEATS + [BREAKAWAY_FEAT])
    fit_b = fit_ols(Xb, y)

    report_model("Model A — BASELINE (no breakaway)", fit_a, BASELINE_FEATS)
    report_model("Model B — BASELINE + rate_20plus", fit_b, BASELINE_FEATS + [BREAKAWAY_FEAT])

    # F-test: is rate_20plus jointly significant beyond baseline?
    rss_a = fit_a["rss"]
    rss_b = fit_b["rss"]
    df_diff = 1
    df_resid_b = fit_b["n"] - fit_b["k"]
    f_stat = ((rss_a - rss_b) / df_diff) / (rss_b / df_resid_b)
    f_pval = 1 - stats.f.cdf(f_stat, df_diff, df_resid_b)

    print(f"\n=== MARGINAL R² OF rate_20plus ===")
    delta_r2 = fit_b['r2'] - fit_a['r2']
    print(f"  Model A R² (baseline)        : {fit_a['r2']:.4f}")
    print(f"  Model B R² (with breakaway)  : {fit_b['r2']:.4f}")
    print(f"  ΔR² (marginal contribution)  : {delta_r2:+.4f}  ({delta_r2*100:+.2f} pp)")
    print(f"  F-test (rate_20plus vs null) : F={f_stat:.3f}, p={f_pval:.4f}")
    print(f"  Adjusted R² delta            : {(fit_b['adj_r2']-fit_a['adj_r2']):+.4f}")

    # CV
    print(f"\n=== LEAVE-ONE-SEASON-OUT CROSS-VALIDATION ===")
    cv_a = cv_loso(rows, BASELINE_FEATS)
    cv_b = cv_loso(rows, BASELINE_FEATS + [BREAKAWAY_FEAT])
    print(f"  {'predict_year':<14} {'n':>4} {'rmse_A':>9} {'rmse_B':>9} {'delta':>9}")
    print(f"  {'-'*14} {'-'*4} {'-'*9} {'-'*9} {'-'*9}")
    deltas = []
    for s in sorted(cv_a):
        a = cv_a[s]; b = cv_b[s]
        d = b["rmse"] - a["rmse"]
        deltas.append(d)
        flag = " " if d == 0 else ("✓" if d < 0 else "✗")
        print(f"  {s:<14} {a['n']:>4} {a['rmse']:>9.3f} {b['rmse']:>9.3f} {d:>+9.4f} {flag}")
    avg_d = sum(deltas) / len(deltas) if deltas else 0
    wins = sum(1 for d in deltas if d < 0)
    print(f"  {'avg':<14} {'':>4} {'':>9} {'':>9} {avg_d:>+9.4f}  ({wins}/{len(deltas)} seasons improved)")

    # Recommendation
    print(f"\n=== RECOMMENDATION ===")
    coef_idx = len(BASELINE_FEATS) + 1  # +1 for intercept
    rate_coef = fit_b["beta"][coef_idx]
    rate_p = fit_b["p"][coef_idx]
    decision = []
    if delta_r2 > 0.005 and f_pval < 0.05 and avg_d < 0 and wins >= len(deltas) * 0.6:
        verdict = "INTEGRATE — adds material marginal R² and OOS improvement"
    elif delta_r2 > 0 and f_pval < 0.10:
        verdict = "MARGINAL — small lift, hold for more data or add as light modifier"
    else:
        verdict = "PASS — baseline already absorbs the breakaway signal"
    print(f"  Verdict: {verdict}")
    print(f"  rate_20plus coefficient: {rate_coef:+.4f} (p={rate_p:.4f})")
    print(f"  Interpretation: a 1.0 unit (i.e., 100%) increase in rate_20plus "
          f"predicts {rate_coef:+.2f} fp/g change.")
    print(f"  Realistic range: rate goes 0→0.06 (top elite), so impact ≈ "
          f"{rate_coef * 0.06:+.2f} fp/g for top-tier breakaway profile.")


if __name__ == "__main__":
    main()
