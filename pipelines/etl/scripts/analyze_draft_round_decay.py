#!/usr/bin/env python3
"""Does the draft_round penalty fade as a player accrues NFL seasons?

Keith's hypothesis (2026-04-30): "Did Brady get knocked as a 6th rounder?"
The implication: draft_round is a prior that should decay once a player
has demonstrated production. By year 5+, last-year stats should swamp
draft pedigree.

Test: split the RB universe by `nfl_yrs` (years since draft). Run the
parsimonious regression in each cohort. Compare the draft_round
coefficient and significance.

Cohorts:
  early       — nfl_yrs in 1..2  (rookie + sophomore)
  mid         — nfl_yrs in 3..4
  established — nfl_yrs >= 5
  all         — full sample (Phase 4 baseline)

Also tests an INTERACTION term: draft_round × max(0, 4 - nfl_yrs).
A significant interaction with the main effect not significant
confirms decay.

Repeat for WR and TE (where draft_round was weaker but worth checking).

Usage:
  python3 pipelines/etl/scripts/analyze_draft_round_decay.py
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


def parse_birth_date(s):
    if not s: return None
    try: return date.fromisoformat(s[:10])
    except: return None


def age_at_season(birth, season):
    if not birth: return None
    cutoff = date(season, 9, 1)
    yrs = cutoff.year - birth.year
    if (cutoff.month, cutoff.day) < (birth.month, birth.day):
        yrs -= 1
    return yrs


def _safe_div(a, b):
    if a is None or b in (None, 0): return None
    return a / b


POSITION_MIN_VOLUME = {"RB": 100, "WR": 50, "TE": 30}
POSITION_VOLUME_FIELD = {"RB": "rush_att", "WR": "targets", "TE": "targets"}


def pull_data(min_season=2014):
    print("Pulling D1 data...", file=sys.stderr)
    weekly = wrangler_query(
        f"SELECT season, gsis_id, "
        f"       SUM(COALESCE(rush_att,0))   AS rush_att, "
        f"       SUM(COALESCE(rush_yds,0))   AS rush_yds, "
        f"       SUM(COALESCE(rush_tds,0))   AS rush_tds, "
        f"       SUM(COALESCE(receptions,0)) AS rec, "
        f"       SUM(COALESCE(targets,0))    AS targets, "
        f"       SUM(COALESCE(rec_yds,0))    AS rec_yds, "
        f"       SUM(COALESCE(rec_tds,0))    AS rec_tds, "
        f"       COUNT(*) AS weeks "
        f"FROM nfl_player_weekly WHERE season>={min_season} GROUP BY season, gsis_id"
    )
    opp = wrangler_query(
        f"SELECT season, gsis_id, position, games, total_fp, fpoe_per_g "
        f"FROM nfl_player_ff_opportunity_season WHERE season>={min_season}"
    )
    pos_per_season = wrangler_query(
        f"SELECT season, gsis_id, position, COUNT(*) AS n FROM nfl_player_weekly "
        f"WHERE season>={min_season} AND position IS NOT NULL AND position != '' "
        f"GROUP BY season, gsis_id, position"
    )
    team_per_season = wrangler_query(
        f"SELECT season, gsis_id, team, COUNT(*) AS n FROM nfl_player_weekly "
        f"WHERE season>={min_season} AND team IS NOT NULL AND team != '' "
        f"GROUP BY season, gsis_id, team"
    )
    vegas = wrangler_query(
        f"SELECT season, team, AVG(implied_total) AS implied_total_avg "
        f"FROM nfl_team_vegas_weekly WHERE season>={min_season} AND implied_total IS NOT NULL "
        f"GROUP BY season, team"
    )
    coaching = wrangler_query(
        f"SELECT season, team, hc_change_flag, oc_change_flag "
        f"FROM nfl_team_coaching_history WHERE season>={min_season}"
    )
    bio = wrangler_query(
        "SELECT gsis_id, birth_date, draft_year, draft_round FROM dim_player_bio"
    )
    return weekly, opp, pos_per_season, team_per_season, vegas, coaching, bio


def mode_map(rows, key_field):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_key[(r["gsis_id"], r["season"])][r[key_field]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def trailing_avg(values, weights):
    tot_w = sum(weights)
    if tot_w == 0: return None
    return sum(v * w for v, w in zip(values, weights)) / tot_w


def build_universe(data, position):
    weekly, opp, pos_per_season, team_per_season, vegas, coaching, bio = data
    pos_map = mode_map(pos_per_season, "position")
    team_map = mode_map(team_per_season, "team")
    weekly_idx = {(r["gsis_id"], r["season"]): r for r in weekly}
    opp_idx = {(r["gsis_id"], r["season"]): r for r in opp}
    vegas_idx = {(r["season"], r["team"]): r["implied_total_avg"] for r in vegas}
    coach_idx = {(r["season"], r["team"]): r for r in coaching}
    bio_idx = {r["gsis_id"]: r for r in bio}

    pos_filter = ["RB", "FB"] if position == "RB" else [position]
    min_vol = POSITION_MIN_VOLUME[position]
    vol_field = POSITION_VOLUME_FIELD[position]

    out = []
    for (gsis, season_n), w in weekly_idx.items():
        if pos_map.get((gsis, season_n)) not in pos_filter: continue
        if (w.get(vol_field) or 0) < min_vol: continue
        f_n1 = opp_idx.get((gsis, season_n + 1))
        if not f_n1 or (f_n1.get("games") or 0) < 6: continue
        target = _safe_div(f_n1.get("total_fp"), f_n1.get("games"))
        if target is None: continue

        team_n1 = team_map.get((gsis, season_n + 1))
        vegas_n1 = vegas_idx.get((season_n + 1, team_n1)) if team_n1 else None
        if vegas_n1 is None: continue
        c = coach_idx.get((season_n + 1, team_n1)) if team_n1 else None
        coach_change_n1 = int(((c or {}).get("hc_change_flag") or 0) or
                              ((c or {}).get("oc_change_flag") or 0)) if c else 0

        f_n = opp_idx.get((gsis, season_n)) or {}
        fp_per_g_n = _safe_div(f_n.get("total_fp"), f_n.get("games"))
        fpoe_per_g_n = f_n.get("fpoe_per_g")
        if fp_per_g_n is None or fpoe_per_g_n is None: continue

        weeks = w.get("weeks") or 0
        if weeks <= 0: continue

        bm = bio_idx.get(gsis) or {}
        draft_year = bm.get("draft_year")
        draft_round = bm.get("draft_round") if bm.get("draft_round") else 8
        nfl_yrs = (season_n - draft_year) if draft_year else None
        if nfl_yrs is None: continue

        # Trailing 3-yr fp/g
        fp_vals, fp_wts = [], []
        for off in (-2, -1, 0):
            opp_s = opp_idx.get((gsis, season_n + off)) or {}
            g_s = opp_s.get("games") or 0
            tfp_s = opp_s.get("total_fp")
            if g_s >= 4 and tfp_s is not None:
                fp_vals.append(tfp_s / g_s); fp_wts.append(g_s)
        fp_trail3 = (trailing_avg(fp_vals[-3:], fp_wts[-3:])
                     if len(fp_vals) >= 3 else
                     (trailing_avg(fp_vals[-2:], fp_wts[-2:])
                      if len(fp_vals) >= 2 else fp_per_g_n))

        out.append({
            "gsis_id": gsis, "season_n": season_n,
            "att_n": w.get("rush_att"),
            "ypc_n": _safe_div(w.get("rush_yds"), w.get("rush_att")),
            "rush_tds_per_g_n": _safe_div(w.get("rush_tds"), weeks),
            "rec_per_g_n": _safe_div(w.get("rec"), weeks),
            "rec_yds_per_g_n": _safe_div(w.get("rec_yds"), weeks),
            "rec_tds_per_g_n": _safe_div(w.get("rec_tds"), weeks),
            "targets_n": w.get("targets"),
            "fp_per_g_n": fp_per_g_n, "fpoe_per_g_n": fpoe_per_g_n,
            "fp_per_g_trail3": fp_trail3,
            "vegas_n1": vegas_n1, "coach_change_n1": coach_change_n1,
            "draft_round": draft_round, "nfl_yrs": nfl_yrs,
            "draft_round_x_youth": draft_round * max(0, 4 - nfl_yrs),
            "target_fp_per_g_n1": target,
        })
    return out


BASELINE_BY_POS = {
    "RB": ["att_n", "ypc_n", "rush_tds_per_g_n", "rec_per_g_n",
           "rec_yds_per_g_n", "fp_per_g_n", "fpoe_per_g_n",
           "vegas_n1", "coach_change_n1", "fp_per_g_trail3"],
    "WR": ["targets_n", "rec_per_g_n", "rec_yds_per_g_n", "rec_tds_per_g_n",
           "fp_per_g_n", "fpoe_per_g_n", "vegas_n1", "coach_change_n1",
           "fp_per_g_trail3"],
    "TE": ["targets_n", "rec_per_g_n", "rec_yds_per_g_n", "rec_tds_per_g_n",
           "fp_per_g_n", "fpoe_per_g_n", "vegas_n1", "coach_change_n1",
           "fp_per_g_trail3"],
}


def fit_ols(rows, features, target_key="target_fp_per_g_n1"):
    clean = [r for r in rows if all(r.get(f) is not None for f in features)
             and r.get(target_key) is not None]
    if len(clean) < 30: return None, len(clean)
    X = np.array([[r[f] for f in features] for r in clean], dtype=float)
    y = np.array([r[target_key] for r in clean], dtype=float)
    n = X.shape[0]
    Xa = np.column_stack([np.ones(n), X])
    XtX_inv = np.linalg.inv(Xa.T @ Xa)
    beta = XtX_inv @ Xa.T @ y
    yh = Xa @ beta
    rss = float(np.sum((y - yh) ** 2))
    tss = float(np.sum((y - y.mean()) ** 2))
    return ({"r2": 1 - rss/tss, "rss": rss, "n": n, "k": Xa.shape[1],
             "beta": beta, "XtX_inv": XtX_inv}, n)


def cohort_test(universe, baseline, label):
    """Test draft_round marginal lift in this cohort."""
    feats_full = baseline + ["draft_round"]
    fb, n = fit_ols(universe, feats_full)
    fa, _ = fit_ols(universe, baseline)
    if not fb or not fa: return None
    df = fb["n"] - fb["k"]
    sigma2 = fb["rss"] / df
    se = float(np.sqrt(max(0.0, sigma2 * fb["XtX_inv"][-1, -1])))
    coef = fb["beta"][-1]
    t = coef / se if se > 0 else 0
    p = 2 * (1 - stats.t.cdf(abs(t), df))
    return {
        "n": fb["n"], "r2_a": fa["r2"], "r2_b": fb["r2"],
        "delta_r2": fb["r2"] - fa["r2"],
        "coef": coef, "se": se, "p": p,
    }


def report_position(position, universe):
    print(f"\n{'='*78}")
    print(f" {position} — DRAFT_ROUND DECAY TEST")
    print(f"{'='*78}")
    base = BASELINE_BY_POS[position]

    cohorts = [
        ("ALL",          lambda r: True),
        ("nfl_yrs 1-2",  lambda r: r["nfl_yrs"] in (1, 2)),
        ("nfl_yrs 3-4",  lambda r: r["nfl_yrs"] in (3, 4)),
        ("nfl_yrs 5+",   lambda r: r["nfl_yrs"] >= 5),
    ]
    print(f"\n{'cohort':<14} {'n':>4} {'baseline R²':>12} "
          f"{'+draft R²':>10} {'ΔR²':>8} {'coef':>8} {'p':>8}  verdict")
    print(f"{'-'*14} {'-'*4} {'-'*12} {'-'*10} {'-'*8} {'-'*8} {'-'*8}  -------")
    for label, pred in cohorts:
        cohort = [r for r in universe if pred(r)]
        if len(cohort) < 30:
            print(f"{label:<14} {len(cohort):>4}  (insufficient)")
            continue
        result = cohort_test(cohort, base, label)
        if not result:
            print(f"{label:<14} {len(cohort):>4}  (fit fail)")
            continue
        verdict = ("MATTERS" if result["p"] < 0.05 and result["delta_r2"] > 0.005
                   else "marginal" if result["p"] < 0.10
                   else "noise")
        print(f"{label:<14} {result['n']:>4} {result['r2_a']:>12.4f} "
              f"{result['r2_b']:>10.4f} {result['delta_r2']:>+8.4f} "
              f"{result['coef']:>+8.3f} {result['p']:>8.4f}  {verdict}")

    # Interaction model: does draft_round × (4-nfl_yrs)+ explain it better?
    print(f"\n--- INTERACTION TEST: draft_round_x_youth = draft_round × max(0, 4-nfl_yrs) ---")
    print("If main effect (draft_round) goes to noise but interaction is significant,")
    print("the penalty truly only applies in years 1-3 and decays after.\n")
    interaction = base + ["draft_round", "draft_round_x_youth"]
    fit_int, n_int = fit_ols(universe, interaction)
    if fit_int:
        df = fit_int["n"] - fit_int["k"]
        sigma2 = fit_int["rss"] / df
        ses = np.sqrt(np.maximum(0.0, sigma2 * np.diag(fit_int["XtX_inv"])))
        names = ["(intercept)"] + interaction
        # Print only the two we care about
        print(f"  n={fit_int['n']}, R²={fit_int['r2']:.4f}")
        print(f"  {'feature':<26} {'coef':>10} {'se':>9} {'t':>7} {'p':>9}")
        print(f"  {'-'*26} {'-'*10} {'-'*9} {'-'*7} {'-'*9}")
        for fn in ("draft_round", "draft_round_x_youth"):
            i = names.index(fn)
            t = fit_int["beta"][i] / ses[i] if ses[i] > 0 else 0
            p = 2 * (1 - stats.t.cdf(abs(t), df))
            sig = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else " "
            print(f"  {fn:<26} {fit_int['beta'][i]:>+10.4f} {ses[i]:>9.4f} "
                  f"{t:>+7.2f} {p:>8.4f}{sig}")


def main():
    data = pull_data()
    for pos in ("RB", "WR", "TE"):
        u = build_universe(data, pos)
        print(f"\n{pos} universe: {len(u)} pairs", file=sys.stderr)
        report_position(pos, u)


if __name__ == "__main__":
    main()
