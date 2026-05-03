#!/usr/bin/env python3
"""Project next-season games-played using injury history + age + workload.

The fp/g regression treats games as held constant. But for SEASON-TOTAL
projection (the auction model's actual target), we need games_n1 too.

Target: games_n1 (next-year games played, from nfl_player_ff_opportunity_season)
Features:
  - games_n               (last year's games — direct carry-forward)
  - games_trail3          (3-year trailing avg, weighted)
  - weeks_out_n           (NFL "Out" designations year N)
  - weeks_designated_n    (any injury flag year N)
  - distinct_body_parts_n (breadth of injury history)
  - age                   (older players miss more games)
  - att_n / targets_n     (workload exposes player to injury)
  - position dummies      (RB/WR/TE/QB)

Universe: any RB/WR/TE/QB with games_n >= 4 (real season) and games_n1
defined (i.e., they played at all next year).

Output:
  - Coefficient table with significance
  - In-sample R² and adj R²
  - Leave-one-season-out CV RMSE
  - Sample projections for current-roster players (year_n=2025 → year_n1=2026)

Usage:
  python3 pipelines/etl/scripts/project_games_played.py
"""
from __future__ import annotations
import json
import statistics
import subprocess
import sys
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"

MIN_GAMES_N = 4
MIN_GAMES_N1 = 1  # any next-year activity
MAX_GAMES = 17    # cap projection (regular season; extend if including playoffs)

POSITIONS = ("RB", "WR", "TE", "QB")


def wrangler_query(sql: str, max_attempts: int = 4) -> list[dict]:
    import time
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    last = ""
    for attempt in range(1, max_attempts + 1):
        res = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True, text=True)
        if res.returncode == 0:
            out = res.stdout
            i = out.find("[")
            if i >= 0:
                try:
                    return json.loads(out[i:])[0]["results"]
                except Exception as e:
                    last = f"json: {e}"
            else:
                last = f"no JSON: {out[:300]}"
        else:
            last = f"rc={res.returncode} stderr={res.stderr[:300]}"
        if attempt < max_attempts:
            time.sleep(2 * attempt)
    sys.exit(f"wrangler failed: {last}")


def _safe_div(a, b):
    if a is None or b in (None, 0): return None
    return a / b


def parse_birth_date(s):
    if not s: return None
    try:
        return date.fromisoformat(s[:10])
    except Exception:
        return None


def age_at_season(birth, season):
    if not birth: return None
    cutoff = date(season, 9, 1)
    yrs = cutoff.year - birth.year
    if (cutoff.month, cutoff.day) < (birth.month, birth.day):
        yrs -= 1
    return yrs


def pull_data(min_season=2014):
    print(f"Pulling D1 data from {min_season}...", file=sys.stderr)
    weekly = wrangler_query(
        f"SELECT season, gsis_id, "
        f"       SUM(COALESCE(rush_att,0))   AS rush_att, "
        f"       SUM(COALESCE(targets,0))    AS targets, "
        f"       SUM(COALESCE(pass_att,0))   AS pass_att "
        f"FROM nfl_player_weekly WHERE season>={min_season} GROUP BY season, gsis_id"
    )
    opp = wrangler_query(
        f"SELECT season, gsis_id, position, games "
        f"FROM nfl_player_ff_opportunity_season WHERE season>={min_season}"
    )
    pos_per_season = wrangler_query(
        f"SELECT season, gsis_id, position, COUNT(*) AS n FROM nfl_player_weekly "
        f"WHERE season>={min_season} AND position IS NOT NULL AND position != '' "
        f"GROUP BY season, gsis_id, position"
    )
    inj = wrangler_query(
        f"SELECT season, gsis_id, weeks_out, weeks_doubtful, weeks_questionable, "
        f"       weeks_designated, distinct_body_parts "
        f"FROM nfl_player_injuries_season WHERE season>={min_season}"
    )
    bio = wrangler_query(
        "SELECT gsis_id, birth_date FROM dim_player_bio WHERE birth_date IS NOT NULL"
    )
    xwalk = wrangler_query(
        "SELECT gsis_id, full_name FROM player_id_crosswalk WHERE gsis_id IS NOT NULL"
    )
    print(f"  weekly={len(weekly)}, opp={len(opp)}, pos_per_season={len(pos_per_season)}, "
          f"inj={len(inj)}, bio={len(bio)}, xwalk={len(xwalk)}", file=sys.stderr)
    return weekly, opp, pos_per_season, inj, bio, xwalk


def build_pos_map(pos_per_season):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in pos_per_season:
        by_key[(r["gsis_id"], r["season"])][r["position"]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def build_dataset(weekly, opp, pos_per_season, inj, bio, xwalk):
    pos_map = build_pos_map(pos_per_season)
    weekly_idx = {(r["gsis_id"], r["season"]): r for r in weekly}
    opp_idx = {(r["gsis_id"], r["season"]): r for r in opp}
    inj_idx = {(r["gsis_id"], r["season"]): r for r in inj}
    bio_idx = {r["gsis_id"]: parse_birth_date(r["birth_date"]) for r in bio}
    name_idx = {r["gsis_id"]: r["full_name"] for r in xwalk}

    rows = []
    for (gsis, season_n), w in weekly_idx.items():
        pos = pos_map.get((gsis, season_n))
        if pos not in POSITIONS: continue
        opp_n = opp_idx.get((gsis, season_n)) or {}
        games_n = opp_n.get("games") or 0
        if games_n < MIN_GAMES_N: continue
        opp_n1 = opp_idx.get((gsis, season_n + 1)) or {}
        games_n1 = opp_n1.get("games")
        if games_n1 is None or games_n1 < MIN_GAMES_N1: continue

        # Trailing 3-yr games
        gms_vals, gms_wts = [], []
        for off in (-2, -1, 0):
            opp_s = opp_idx.get((gsis, season_n + off)) or {}
            g = opp_s.get("games") or 0
            if g > 0:
                gms_vals.append(g); gms_wts.append(1)
        games_trail3 = (sum(gms_vals[-3:]) / len(gms_vals[-3:])
                        if len(gms_vals) >= 3 else
                        (sum(gms_vals[-2:]) / len(gms_vals[-2:])
                         if len(gms_vals) >= 2 else games_n))

        ij = inj_idx.get((gsis, season_n)) or {}
        weeks_out = ij.get("weeks_out") or 0
        weeks_designated = ij.get("weeks_designated") or 0
        distinct_body_parts = ij.get("distinct_body_parts") or 0

        age = age_at_season(bio_idx.get(gsis), season_n)
        rush_att = w.get("rush_att") or 0
        targets = w.get("targets") or 0
        pass_att = w.get("pass_att") or 0

        # Workload: position-aware "touches" proxy
        if pos in ("RB", "FB"):
            workload = rush_att + targets
        elif pos in ("WR", "TE"):
            workload = targets
        else:  # QB
            workload = pass_att + rush_att

        rows.append({
            "gsis_id": gsis,
            "name": name_idx.get(gsis, "?"),
            "season_n": season_n, "season_n1": season_n + 1,
            "position": pos,
            "games_n": games_n,
            "games_trail3": games_trail3,
            "weeks_out_n": weeks_out,
            "weeks_designated_n": weeks_designated,
            "distinct_body_parts_n": distinct_body_parts,
            "age": age,
            "workload_n": workload,
            "is_RB": 1 if pos in ("RB", "FB") else 0,
            "is_WR": 1 if pos == "WR" else 0,
            "is_TE": 1 if pos == "TE" else 0,
            "is_QB": 1 if pos == "QB" else 0,
            "target_games_n1": min(int(games_n1), MAX_GAMES),
        })
    return rows


def fit_ols(rows, features, target_key="target_games_n1"):
    clean = [r for r in rows if all(r.get(f) is not None for f in features)
             and r.get(target_key) is not None]
    if len(clean) < 30: return None, 0, []
    X = np.array([[r[f] for f in features] for r in clean], dtype=float)
    y = np.array([r[target_key] for r in clean], dtype=float)
    n = X.shape[0]
    Xa = np.column_stack([np.ones(n), X])
    XtX = Xa.T @ Xa
    XtX_inv = np.linalg.inv(XtX)
    beta = XtX_inv @ Xa.T @ y
    yh = Xa @ beta
    rss = float(np.sum((y - yh) ** 2))
    tss = float(np.sum((y - y.mean()) ** 2))
    df = n - Xa.shape[1]
    return ({"r2": 1 - rss/tss,
             "adj_r2": 1 - (rss/df)/(tss/(n-1)),
             "rss": rss, "n": n, "k": Xa.shape[1],
             "beta": beta, "XtX_inv": XtX_inv,
             "rmse": float(np.sqrt(rss/n))}, n, clean)


def report_model(label, fit, features):
    if not fit: print(f"{label}: insufficient data"); return
    print(f"\n{label}:")
    print(f"  n={fit['n']}, R²={fit['r2']:.4f}, adj R²={fit['adj_r2']:.4f}, "
          f"in-sample RMSE={fit['rmse']:.3f} games")
    df = fit["n"] - fit["k"]
    sigma2 = fit["rss"] / df
    ses = np.sqrt(np.maximum(0.0, sigma2 * np.diag(fit["XtX_inv"])))
    names = ["(intercept)"] + features
    print(f"  {'feature':<22} {'coef':>10} {'se':>9} {'t':>7} {'p':>9}")
    print(f"  {'-'*22} {'-'*10} {'-'*9} {'-'*7} {'-'*9}")
    for i, fn in enumerate(names):
        t = fit["beta"][i] / ses[i] if ses[i] > 0 else 0
        p = 2 * (1 - stats.t.cdf(abs(t), df))
        sig = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else " "
        print(f"  {fn:<22} {fit['beta'][i]:>+10.4f} {ses[i]:>9.4f} "
              f"{t:>+7.2f} {p:>8.4f}{sig}")


def loso_cv(rows, features):
    by_n1 = defaultdict(list)
    clean = [r for r in rows if all(r.get(f) is not None for f in features)
             and r.get("target_games_n1") is not None]
    for r in clean: by_n1[r["season_n1"]].append(r)
    deltas, all_rmse = [], []
    print(f"\n{'predict_year':<14} {'n':>4} {'rmse':>7}")
    print(f"{'-'*14} {'-'*4} {'-'*7}")
    for hold in sorted(by_n1):
        train = [r for r in clean if r["season_n1"] != hold]
        test = by_n1[hold]
        if len(train) < 30 or len(test) < 5: continue
        Xtr = np.array([[r[f] for f in features] for r in train], dtype=float)
        ytr = np.array([r["target_games_n1"] for r in train], dtype=float)
        Xtr_a = np.column_stack([np.ones(len(train)), Xtr])
        beta = np.linalg.solve(Xtr_a.T @ Xtr_a, Xtr_a.T @ ytr)
        Xte = np.array([[r[f] for f in features] for r in test], dtype=float)
        Xte_a = np.column_stack([np.ones(len(test)), Xte])
        yp = Xte_a @ beta
        yte = np.array([r["target_games_n1"] for r in test], dtype=float)
        rmse = float(np.sqrt(np.mean((yte - yp) ** 2)))
        all_rmse.append(rmse)
        print(f"{hold:<14} {len(test):>4} {rmse:>7.3f}")
    if all_rmse:
        print(f"{'avg':<14} {'':>4} {sum(all_rmse)/len(all_rmse):>7.3f}")


def project_2026(rows, features, fit):
    """Predict games for 2026 using each player's 2025 features."""
    target_rows = [r for r in rows if r["season_n"] == 2025
                   and all(r.get(f) is not None for f in features)]
    if not target_rows or not fit: return
    X = np.array([[r[f] for f in features] for r in target_rows], dtype=float)
    Xa = np.column_stack([np.ones(len(target_rows)), X])
    yp = Xa @ fit["beta"]
    # Cap projection at MAX_GAMES
    yp = np.clip(yp, 0, MAX_GAMES)
    out = []
    for i, r in enumerate(target_rows):
        out.append((r["name"], r["position"], r["games_n"],
                    r["weeks_out_n"], r["weeks_designated_n"],
                    r["age"], yp[i]))
    # Sort by largest projected DROP (high last-year games, low projected)
    out.sort(key=lambda t: t[2] - t[6], reverse=True)
    print(f"\n2026 GAMES-PLAYED PROJECTIONS — biggest expected drops vs 2025:")
    print(f"{'name':<22} {'pos':<3} {'g25':>3} {'wks_out':>7} "
          f"{'wks_dx':>7} {'age':>3} {'g26 proj':>9}")
    for t in out[:25]:
        name, pos, g25, wo, wd, age, g26 = t
        print(f"{(name or '?')[:22]:<22} {pos:<3} {g25:>3} {wo:>7} "
              f"{wd:>7} {age or 0:>3} {g26:>9.1f}")
    print(f"\n2026 GAMES-PLAYED PROJECTIONS — biggest expected GAINS:")
    out.sort(key=lambda t: t[2] - t[6])
    for t in out[:15]:
        name, pos, g25, wo, wd, age, g26 = t
        print(f"{(name or '?')[:22]:<22} {pos:<3} {g25:>3} {wo:>7} "
              f"{wd:>7} {age or 0:>3} {g26:>9.1f}")


def main():
    weekly, opp, pos_per_season, inj, bio, xwalk = pull_data()
    rows = build_dataset(weekly, opp, pos_per_season, inj, bio, xwalk)
    print(f"\nDataset: {len(rows)} (player, season-N→N+1) pairs", file=sys.stderr)

    features = ["games_n", "games_trail3", "weeks_out_n", "weeks_designated_n",
                "distinct_body_parts_n", "age", "workload_n",
                "is_RB", "is_WR", "is_TE"]  # is_QB is the omitted dummy
    fit, n_used, _ = fit_ols(rows, features)
    report_model("GAMES-PLAYED MODEL", fit, features)

    # Sanity check — strip injuries to confirm they help
    base = ["games_n", "games_trail3", "age", "workload_n",
            "is_RB", "is_WR", "is_TE"]
    fit_base, _, _ = fit_ols(rows, base)
    if fit_base and fit:
        delta = fit["r2"] - fit_base["r2"]
        print(f"\n  R² without injuries: {fit_base['r2']:.4f}")
        print(f"  R² with injuries:    {fit['r2']:.4f}")
        print(f"  ΔR² from injuries:   {delta:+.4f}")

    print(f"\n{'='*78}\n LOSO CROSS-VALIDATION (full model)\n{'='*78}")
    loso_cv(rows, features)

    project_2026(rows, features, fit)


if __name__ == "__main__":
    main()
