#!/usr/bin/env python3
"""Generic RB-feature evaluator: stickiness + univariate signal + marginal R².

For each candidate feature, runs four tests and prints a summary table:

  1. STICKINESS  — corr(feature_yearN, feature_yearN+1) across consecutive
                    pairs with min volume in both seasons.
  2. SIGNAL_FP   — corr(feature_yearN, fp_per_g_yearN). Same-year fantasy
                    points correlation (descriptive).
  3. SIGNAL_FPOE — corr(feature_yearN, fpoe_per_g_yearN). Same-year over-
                    performance correlation.
  4. SNAP_PRED   — corr(feature_yearN, off_snap_pct_yearN+1). Does the
                    feature predict next-year snap share?
  5. MARGINAL_R² — does feature_yearN add lift to a multivariate model
                    of fp_per_g_yearN+1 (vs baseline)?

Test universe: RB-classified player-seasons with >= 100 carries year-N
and >= 6 games year-N+1.

Usage:
  python3 pipelines/etl/scripts/evaluate_rb_features.py
"""
from __future__ import annotations
import json
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy import stats

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"

MIN_CARRIES_N = 100
MIN_GAMES_N1 = 6

# Each candidate is a (label, computer-fn) pair. The computer takes a
# context dict {weekly, brk, pbp, adv, rz, opp} for one (gsis_id, season)
# and returns a float or None.

def _safe_div(a, b):
    if a is None or b in (None, 0): return None
    return a / b


def feat_rate_20plus(ctx):
    b = ctx.get("brk")
    if not b: return None
    return _safe_div(b.get("plays_20plus"), b.get("attempts"))


def feat_rate_15plus(ctx):
    b = ctx.get("brk")
    if not b: return None
    return _safe_div(b.get("plays_15plus"), b.get("attempts"))


def feat_success_rate(ctx):
    p = ctx.get("pbp")
    if not p: return None
    return p.get("success_rate")


def feat_epa_per_play(ctx):
    p = ctx.get("pbp")
    if not p: return None
    return p.get("epa_per_play")


def feat_ypc(ctx):
    w = ctx.get("weekly")
    if not w: return None
    return _safe_div(w.get("rush_yds"), w.get("rush_att"))


def feat_yac_per_a(ctx):
    a = ctx.get("adv")
    if not a: return None
    return a.get("rush_yac_per_a")


def feat_ybc_per_a(ctx):
    a = ctx.get("adv")
    if not a: return None
    return a.get("rush_ybc_per_a")


def feat_brk_tkl_per_a(ctx):
    a = ctx.get("adv")
    if not a: return None
    return _safe_div(a.get("rush_brk_tkl"), ctx["weekly"].get("rush_att"))


def feat_rz_share(ctx):
    rz = ctx.get("rz")
    w = ctx.get("weekly")
    if not rz or not w: return None
    return _safe_div(rz.get("rush_att_i20"), w.get("rush_att"))


def feat_fpoe_per_g(ctx):
    f = ctx.get("opp")
    if not f: return None
    return f.get("fpoe_per_g")


def feat_snap_pct(ctx):
    return ctx.get("snap_pct")  # injected pre-build; see build_universe


CANDIDATES = [
    # (label, computer, min volume note for stickiness)
    ("rate_20plus",       feat_rate_20plus),
    ("rate_15plus",       feat_rate_15plus),
    ("success_rate",      feat_success_rate),
    ("epa_per_play",      feat_epa_per_play),
    ("ypc",               feat_ypc),
    ("rush_yac_per_a",    feat_yac_per_a),
    ("rush_ybc_per_a",    feat_ybc_per_a),
    ("brk_tkl_per_a",     feat_brk_tkl_per_a),
    ("rz_share",          feat_rz_share),
    ("fpoe_per_g",        feat_fpoe_per_g),
    ("snap_pct",          feat_snap_pct),
]


def wrangler_query(sql: str) -> list[dict]:
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    res = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"wrangler failed: {res.stderr[:1000]}")
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def pull_data():
    print("Pulling D1 data...", file=sys.stderr)
    weekly = wrangler_query(
        "SELECT season, gsis_id, "
        "       SUM(COALESCE(rush_att,0))   AS rush_att, "
        "       SUM(COALESCE(rush_yds,0))   AS rush_yds, "
        "       SUM(COALESCE(rush_tds,0))   AS rush_tds, "
        "       SUM(COALESCE(receptions,0)) AS rec, "
        "       SUM(COALESCE(rec_yds,0))    AS rec_yds, "
        "       COUNT(*)                    AS weeks "
        "FROM nfl_player_weekly WHERE season>=2018 GROUP BY season, gsis_id"
    )
    breakaway = wrangler_query(
        "SELECT season, gsis_id, attempts, plays_15plus, plays_20plus "
        "FROM nfl_player_breakaway_season WHERE role='rusher' AND season>=2018"
    )
    pbp = wrangler_query(
        "SELECT season, gsis_id, n_plays, epa_per_play, success_rate "
        "FROM nfl_player_pbp_season WHERE role='rusher' AND season>=2018"
    )
    adv = wrangler_query(
        "SELECT season, gsis_id, rush_yac_per_a, rush_ybc_per_a, rush_brk_tkl, "
        "       rush_att_per_br "
        "FROM nfl_player_advstats_season WHERE season>=2018"
    )
    rz = wrangler_query(
        "SELECT season, gsis_id, "
        "       SUM(COALESCE(rush_att_i20,0)) AS rush_att_i20, "
        "       SUM(COALESCE(rush_tds_i20,0)) AS rush_tds_i20 "
        "FROM nfl_player_redzone WHERE season>=2018 GROUP BY season, gsis_id"
    )
    opp = wrangler_query(
        "SELECT season, gsis_id, position, games, total_fp, fpoe_per_g "
        "FROM nfl_player_ff_opportunity_season WHERE season>=2018"
    )
    pos_per_season = wrangler_query(
        "SELECT season, gsis_id, position, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season>=2018 AND position IS NOT NULL AND position != '' "
        "GROUP BY season, gsis_id, position"
    )
    team_per_season = wrangler_query(
        "SELECT season, gsis_id, team, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season>=2018 AND team IS NOT NULL AND team != '' "
        "GROUP BY season, gsis_id, team"
    )
    vegas = wrangler_query(
        "SELECT season, team, AVG(implied_total) AS implied_total_avg "
        "FROM nfl_team_vegas_weekly WHERE season>=2018 AND implied_total IS NOT NULL "
        "GROUP BY season, team"
    )
    coaching = wrangler_query(
        "SELECT season, team, hc_change_flag, oc_change_flag "
        "FROM nfl_team_coaching_history WHERE season>=2018"
    )
    # snaps: per-(season, week, pfr_id, team). Aggregate to season mean off_snap_pct.
    # Need pfr_id → gsis_id via crosswalk.
    snaps = wrangler_query(
        "SELECT season, pfr_id, AVG(off_snap_pct) AS off_snap_pct_avg, COUNT(*) AS weeks "
        "FROM nfl_player_snaps WHERE season>=2018 AND off_snap_pct IS NOT NULL "
        "GROUP BY season, pfr_id"
    )
    xwalk = wrangler_query(
        "SELECT gsis_id, pfr_id FROM player_id_crosswalk "
        "WHERE gsis_id IS NOT NULL AND pfr_id IS NOT NULL"
    )
    print(f"  weekly={len(weekly)}, brk={len(breakaway)}, pbp={len(pbp)}, "
          f"adv={len(adv)}, rz={len(rz)}, opp={len(opp)}, snaps={len(snaps)}, "
          f"vegas={len(vegas)}, coaching={len(coaching)}, "
          f"pos_per_season={len(pos_per_season)}, xwalk={len(xwalk)}",
          file=sys.stderr)
    return (weekly, breakaway, pbp, adv, rz, opp, snaps, vegas, coaching,
            pos_per_season, team_per_season, xwalk)


def mode_map(rows, key_field):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_key[(r["gsis_id"], r["season"])][r[key_field]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def build_universe(weekly, breakaway, pbp, adv, rz, opp, snaps,
                   vegas, coaching, pos_map, team_map, xwalk):
    """Returns a list of dicts, one per (gsis, season_n) RB row with year-N
    feature context + year-N+1 target context."""
    weekly_idx = {(r["gsis_id"], r["season"]): r for r in weekly}
    brk_idx = {(r["gsis_id"], r["season"]): r for r in breakaway}
    pbp_idx = {(r["gsis_id"], r["season"]): r for r in pbp}
    adv_idx = {(r["gsis_id"], r["season"]): r for r in adv}
    rz_idx = {(r["gsis_id"], r["season"]): r for r in rz}
    opp_idx = {(r["gsis_id"], r["season"]): r for r in opp}
    vegas_idx = {(r["season"], r["team"]): r["implied_total_avg"] for r in vegas}
    coach_idx = {(r["season"], r["team"]): r for r in coaching}
    # snaps: keyed by (season, pfr_id). Translate to gsis via xwalk.
    pfr_to_gsis = {r["pfr_id"]: r["gsis_id"] for r in xwalk}
    snap_idx = {}
    for s in snaps:
        gsis = pfr_to_gsis.get(s["pfr_id"])
        if gsis:
            snap_idx[(gsis, s["season"])] = s["off_snap_pct_avg"]

    out = []
    for (gsis, season_n), w in weekly_idx.items():
        if pos_map.get((gsis, season_n)) not in ("RB", "FB"):
            continue
        if (w.get("rush_att") or 0) < MIN_CARRIES_N:
            continue
        # Need year-N+1 target
        f_n1 = opp_idx.get((gsis, season_n + 1))
        if not f_n1: continue
        if (f_n1.get("games") or 0) < MIN_GAMES_N1: continue
        target = _safe_div(f_n1.get("total_fp"), f_n1.get("games"))
        if target is None: continue
        # Forward team context
        team_n1 = team_map.get((gsis, season_n + 1))
        vegas_n1 = vegas_idx.get((season_n + 1, team_n1)) if team_n1 else None
        c = coach_idx.get((season_n + 1, team_n1)) if team_n1 else None
        coach_change_n1 = int(((c or {}).get("hc_change_flag") or 0) or
                              ((c or {}).get("oc_change_flag") or 0)) if c else 0
        # Year-N opp / fpoe / fp
        f_n = opp_idx.get((gsis, season_n)) or {}
        fp_per_g_n = _safe_div(f_n.get("total_fp"), f_n.get("games"))
        fpoe_per_g_n = f_n.get("fpoe_per_g")
        # Snap pct year-N and year-N+1
        snap_n = snap_idx.get((gsis, season_n))
        snap_n1 = snap_idx.get((gsis, season_n + 1))

        ctx = {"weekly": w, "brk": brk_idx.get((gsis, season_n)),
               "pbp": pbp_idx.get((gsis, season_n)),
               "adv": adv_idx.get((gsis, season_n)),
               "rz": rz_idx.get((gsis, season_n)),
               "opp": f_n, "snap_pct": snap_n}
        # Pre-compute every candidate feature for this row
        feats = {label: fn(ctx) for label, fn in CANDIDATES}
        # Also year-N+1 same features (for stickiness lookup later)
        ctx_n1 = {"weekly": weekly_idx.get((gsis, season_n + 1)),
                  "brk": brk_idx.get((gsis, season_n + 1)),
                  "pbp": pbp_idx.get((gsis, season_n + 1)),
                  "adv": adv_idx.get((gsis, season_n + 1)),
                  "rz": rz_idx.get((gsis, season_n + 1)),
                  "opp": opp_idx.get((gsis, season_n + 1)),
                  "snap_pct": snap_n1}
        feats_n1 = {label: fn(ctx_n1) for label, fn in CANDIDATES}

        out.append({
            "gsis_id": gsis, "season_n": season_n, "season_n1": season_n + 1,
            "att_n": w.get("rush_att"),
            "att_n1": (weekly_idx.get((gsis, season_n + 1)) or {}).get("rush_att") or 0,
            "ypc_n": _safe_div(w.get("rush_yds"), w.get("rush_att")),
            "rush_tds_per_g_n": _safe_div(w.get("rush_tds"), w.get("weeks")),
            "rec_per_g_n": _safe_div(w.get("rec"), w.get("weeks")),
            "rec_yds_per_g_n": _safe_div(w.get("rec_yds"), w.get("weeks")),
            "fp_per_g_n": fp_per_g_n,
            "fpoe_per_g_n": fpoe_per_g_n,
            "vegas_n1": vegas_n1, "coach_change_n1": coach_change_n1,
            "snap_pct_n": snap_n, "snap_pct_n1": snap_n1,
            "target_fp_per_g_n1": target,
            "feats_n": feats, "feats_n1": feats_n1,
        })
    return out


def pearson(xs, ys):
    if len(xs) < 5 or len(xs) != len(ys): return None
    if len(set(xs)) <= 1 or len(set(ys)) <= 1: return None
    mx = statistics.mean(xs); my = statistics.mean(ys)
    num = sum((xs[i]-mx)*(ys[i]-my) for i in range(len(xs)))
    dx = sum((v-mx)**2 for v in xs)**0.5
    dy = sum((v-my)**2 for v in ys)**0.5
    if dx == 0 or dy == 0: return None
    return num / (dx*dy)


BASELINE = ["att_n", "ypc_n", "rush_tds_per_g_n", "rec_per_g_n",
            "rec_yds_per_g_n", "fp_per_g_n", "fpoe_per_g_n",
            "vegas_n1", "coach_change_n1"]


def fit_ols(rows, features):
    # filter rows where any feature is None
    clean = [r for r in rows if all(r.get(f) is not None for f in features)]
    if len(clean) < 30: return None
    X = np.array([[r[f] for f in features] for r in clean], dtype=float)
    y = np.array([r["target_fp_per_g_n1"] for r in clean], dtype=float)
    n = X.shape[0]
    Xa = np.column_stack([np.ones(n), X])
    XtX = Xa.T @ Xa
    XtX_inv = np.linalg.inv(XtX)
    beta = XtX_inv @ Xa.T @ y
    yh = Xa @ beta
    rss = float(np.sum((y - yh) ** 2))
    tss = float(np.sum((y - y.mean()) ** 2))
    return {"r2": 1 - rss / tss, "rss": rss, "n": n, "k": Xa.shape[1],
            "beta": beta, "XtX_inv": XtX_inv}


def f_test_marginal(rows, baseline_feats, test_feat):
    feats_b = baseline_feats
    feats_full = baseline_feats + [test_feat]
    # Need to fit on the SAME rows for both — filter where neither model is missing
    clean = [r for r in rows if all(r.get(f) is not None for f in feats_full)]
    if len(clean) < 30: return None
    fa = fit_ols(clean, feats_b)
    fb = fit_ols(clean, feats_full)
    if fa is None or fb is None: return None
    rss_a, rss_b = fa["rss"], fb["rss"]
    df_resid_b = fb["n"] - fb["k"]
    if df_resid_b <= 0: return None
    f_stat = ((rss_a - rss_b) / 1) / (rss_b / df_resid_b)
    p = 1 - stats.f.cdf(f_stat, 1, df_resid_b)
    coef = fb["beta"][-1]
    se = float(np.sqrt(fb["rss"] / df_resid_b * fb["XtX_inv"][-1, -1]))
    t_stat = coef / se if se > 0 else 0
    p_t = 2 * (1 - stats.t.cdf(abs(t_stat), df_resid_b))
    return {"r2_a": fa["r2"], "r2_b": fb["r2"],
            "delta_r2": fb["r2"] - fa["r2"],
            "f_stat": f_stat, "f_p": p,
            "coef": coef, "se": se, "t": t_stat, "p_coef": p_t,
            "n_used": len(clean)}


def fmt_r(r):
    return f"{r:>+6.3f}" if r is not None else f"{'—':>6}"


def fmt_d(r):
    return f"{r:>+7.4f}" if r is not None else f"{'—':>7}"


def main():
    (weekly, breakaway, pbp, adv, rz, opp, snaps, vegas, coaching,
     pos_per_season, team_per_season, xwalk) = pull_data()
    pos_map = mode_map(pos_per_season, "position")
    team_map = mode_map(team_per_season, "team")
    universe = build_universe(weekly, breakaway, pbp, adv, rz, opp, snaps,
                              vegas, coaching, pos_map, team_map, xwalk)
    print(f"\nUniverse: {len(universe)} (RB, year-N → year-N+1) pairs", file=sys.stderr)

    # Per-feature battery
    print(f"\n{'='*92}")
    print(f" RB FEATURE BATTERY  (n={len(universe)} year-N→year-N+1 pairs)")
    print(f"{'='*92}")
    print(f" {'feature':<18}  {'sticky':>7} {'sig_fp':>7} {'sig_fpoe':>9} "
          f"{'snap_n+1':>9} {'ΔR²':>8} {'F p':>7}  {'verdict':<22}")
    print(f" {'-'*18}  {'-'*7} {'-'*7} {'-'*9} {'-'*9} {'-'*8} {'-'*7}  {'-'*22}")

    for label, fn in CANDIDATES:
        # 1. STICKINESS — corr(feat_yearN, feat_yearN+1) within universe
        xs, ys = [], []
        for r in universe:
            v0 = r["feats_n"].get(label); v1 = r["feats_n1"].get(label)
            if v0 is not None and v1 is not None:
                xs.append(float(v0)); ys.append(float(v1))
        sticky = pearson(xs, ys)

        # 2. SIGNAL_FP — corr(feat_yearN, fp_per_g_yearN)
        xs, ys = [], []
        for r in universe:
            v = r["feats_n"].get(label); f = r["fp_per_g_n"]
            if v is not None and f is not None:
                xs.append(float(v)); ys.append(float(f))
        sig_fp = pearson(xs, ys)

        # 3. SIGNAL_FPOE
        xs, ys = [], []
        for r in universe:
            v = r["feats_n"].get(label); f = r["fpoe_per_g_n"]
            if v is not None and f is not None:
                xs.append(float(v)); ys.append(float(f))
        sig_fpoe = pearson(xs, ys)

        # 4. SNAP_PRED — corr(feat_yearN, snap_pct_yearN+1)
        xs, ys = [], []
        for r in universe:
            v = r["feats_n"].get(label); s = r["snap_pct_n1"]
            if v is not None and s is not None:
                xs.append(float(v)); ys.append(float(s))
        snap_pred = pearson(xs, ys)

        # 5. MARGINAL R² — does feat_n add lift to baseline? If the test
        # feature clashes with a baseline column, drop the baseline copy
        # so we're not testing a feature against itself.
        baseline_for_test = list(BASELINE)
        col_collisions = {
            "ypc": "ypc_n",
            "fpoe_per_g": "fpoe_per_g_n",
        }
        if label in col_collisions and col_collisions[label] in baseline_for_test:
            baseline_for_test.remove(col_collisions[label])
        for r in universe:
            r[f"_{label}"] = r["feats_n"].get(label)
        marginal = f_test_marginal(universe, baseline_for_test, f"_{label}")

        # Verdict logic
        if marginal is None:
            verdict = "(insufficient data)"
        elif marginal["delta_r2"] > 0.005 and marginal["f_p"] < 0.05:
            verdict = "ADDS marginal lift ✓"
        elif marginal["delta_r2"] > 0.001 and marginal["f_p"] < 0.10:
            verdict = "marginal, weak"
        else:
            verdict = "redundant"

        d_r2 = marginal["delta_r2"] if marginal else None
        f_p = marginal["f_p"] if marginal else None
        print(f" {label:<18}  {fmt_r(sticky)} {fmt_r(sig_fp)} "
              f"{fmt_r(sig_fpoe)} {fmt_r(snap_pred)} "
              f"{fmt_d(d_r2)} {fmt_r(f_p)}  {verdict:<22}")

    print(f"\nLegend: sticky=corr(year_N, year_N+1); sig_fp/fpoe=same-year univariate; "
          f"snap_n+1=does feat_N predict snap_pct_N+1; ΔR²/F p=marginal "
          f"contribution above baseline (att, ypc, tds/g, rec, fp/g, fpoe/g, vegas, "
          f"coach_change).")


if __name__ == "__main__":
    main()
