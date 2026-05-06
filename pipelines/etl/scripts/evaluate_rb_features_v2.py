#!/usr/bin/env python3
"""Extended RB-feature battery: age, multi-year trailing, volume-share metrics.

Builds on evaluate_rb_features.py. Adds these candidates:

  age_at_season         — player age at Sept 1 of season_n (from dim_player_bio)
  fp_per_g_trail2       — fp/g averaged over (season_n-1, season_n), weighted by games
  fp_per_g_trail3       — fp/g averaged over (season_n-2..season_n), weighted by games
  ypc_trail2 / 3        — same idea, weighted by carries
  att_trail2 / 3        — total carries averaged over trailing seasons
  team_rush_share       — player_carries / team_carries in season_n
  i5_rush_share         — player_rush_att_i5 / team_rush_att_i5 in season_n

Plus a baseline-swap test: how much does R² improve when single-year baseline
features (fp_per_g_n, ypc_n, att_n) are swapped for their trailing-3yr versions?

Universe and reporting are identical to v1 (n ≈ 284 RB year-N→year-N+1 pairs).

Usage:
  python3 pipelines/etl/scripts/evaluate_rb_features_v2.py
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

MIN_CARRIES_N = 100
MIN_GAMES_N1 = 6
TRAIL_MIN_GAMES_PER_YR = 4   # require some real activity per trailing season


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
        "FROM nfl_player_weekly WHERE season>=2014 GROUP BY season, gsis_id"
    )
    breakaway = wrangler_query(
        "SELECT season, gsis_id, attempts, plays_15plus, plays_20plus "
        "FROM nfl_player_breakaway_season WHERE role='rusher' AND season>=2014"
    )
    pbp = wrangler_query(
        "SELECT season, gsis_id, n_plays, epa_per_play, success_rate "
        "FROM nfl_player_pbp_season WHERE role='rusher' AND season>=2014"
    )
    adv = wrangler_query(
        "SELECT season, gsis_id, rush_yac_per_a, rush_ybc_per_a, rush_brk_tkl, "
        "       rush_att_per_br "
        "FROM nfl_player_advstats_season WHERE season>=2014"
    )
    # Aggregate i5 to player-season level
    rz = wrangler_query(
        "SELECT season, gsis_id, "
        "       SUM(COALESCE(rush_att_i20,0)) AS rush_att_i20, "
        "       SUM(COALESCE(rush_att_i10,0)) AS rush_att_i10, "
        "       SUM(COALESCE(rush_att_i5,0))  AS rush_att_i5, "
        "       SUM(COALESCE(rush_tds_i20,0)) AS rush_tds_i20 "
        "FROM nfl_player_redzone WHERE season>=2014 GROUP BY season, gsis_id"
    )
    opp = wrangler_query(
        "SELECT season, gsis_id, position, games, total_fp, fpoe_per_g "
        "FROM nfl_player_ff_opportunity_season WHERE season>=2014"
    )
    pos_per_season = wrangler_query(
        "SELECT season, gsis_id, position, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season>=2014 AND position IS NOT NULL AND position != '' "
        "GROUP BY season, gsis_id, position"
    )
    team_per_season = wrangler_query(
        "SELECT season, gsis_id, team, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season>=2014 AND team IS NOT NULL AND team != '' "
        "GROUP BY season, gsis_id, team"
    )
    vegas = wrangler_query(
        "SELECT season, team, AVG(implied_total) AS implied_total_avg "
        "FROM nfl_team_vegas_weekly WHERE season>=2014 AND implied_total IS NOT NULL "
        "GROUP BY season, team"
    )
    coaching = wrangler_query(
        "SELECT season, team, hc_change_flag, oc_change_flag "
        "FROM nfl_team_coaching_history WHERE season>=2014"
    )
    snaps = wrangler_query(
        "SELECT season, pfr_id, AVG(off_snap_pct) AS off_snap_pct_avg "
        "FROM nfl_player_snaps WHERE season>=2014 AND off_snap_pct IS NOT NULL "
        "GROUP BY season, pfr_id"
    )
    xwalk = wrangler_query(
        "SELECT gsis_id, pfr_id FROM player_id_crosswalk "
        "WHERE gsis_id IS NOT NULL AND pfr_id IS NOT NULL"
    )
    bio = wrangler_query(
        "SELECT gsis_id, birth_date, draft_year, draft_round, draft_pick "
        "FROM dim_player_bio WHERE birth_date IS NOT NULL"
    )
    print(f"  weekly={len(weekly)}, brk={len(breakaway)}, pbp={len(pbp)}, "
          f"adv={len(adv)}, rz={len(rz)}, opp={len(opp)}, snaps={len(snaps)}, "
          f"vegas={len(vegas)}, coaching={len(coaching)}, "
          f"pos_per_season={len(pos_per_season)}, xwalk={len(xwalk)}, "
          f"bio={len(bio)}", file=sys.stderr)
    return (weekly, breakaway, pbp, adv, rz, opp, snaps, vegas, coaching,
            pos_per_season, team_per_season, xwalk, bio)


def mode_map(rows, key_field):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_key[(r["gsis_id"], r["season"])][r[key_field]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


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
    """Age on Sept 1 of the given season."""
    if not birth: return None
    cutoff = date(season, 9, 1)
    yrs = cutoff.year - birth.year
    if (cutoff.month, cutoff.day) < (birth.month, birth.day):
        yrs -= 1
    return yrs


def trailing_avg(values, weights):
    """Weighted average; returns None if total weight is 0."""
    tot_w = sum(weights)
    if tot_w == 0: return None
    return sum(v * w for v, w in zip(values, weights)) / tot_w


def build_universe(weekly, breakaway, pbp, adv, rz, opp, snaps,
                   vegas, coaching, pos_map, team_map, xwalk, bio):
    weekly_idx = {(r["gsis_id"], r["season"]): r for r in weekly}
    brk_idx = {(r["gsis_id"], r["season"]): r for r in breakaway}
    pbp_idx = {(r["gsis_id"], r["season"]): r for r in pbp}
    adv_idx = {(r["gsis_id"], r["season"]): r for r in adv}
    rz_idx = {(r["gsis_id"], r["season"]): r for r in rz}
    opp_idx = {(r["gsis_id"], r["season"]): r for r in opp}
    vegas_idx = {(r["season"], r["team"]): r["implied_total_avg"] for r in vegas}
    coach_idx = {(r["season"], r["team"]): r for r in coaching}
    pfr_to_gsis = {r["pfr_id"]: r["gsis_id"] for r in xwalk}
    snap_idx = {}
    for s in snaps:
        gsis = pfr_to_gsis.get(s["pfr_id"])
        if gsis:
            snap_idx[(gsis, s["season"])] = s["off_snap_pct_avg"]
    bio_idx = {r["gsis_id"]: parse_birth_date(r["birth_date"]) for r in bio}
    bio_meta = {r["gsis_id"]: r for r in bio}

    # Team-season totals from weekly: team_rush_att, team_rush_yds
    team_rush = defaultdict(lambda: {"att": 0, "yds": 0})
    for (gsis, season), w in weekly_idx.items():
        team = team_map.get((gsis, season))
        if not team: continue
        team_rush[(season, team)]["att"] += w.get("rush_att") or 0
        team_rush[(season, team)]["yds"] += w.get("rush_yds") or 0

    # Team i5 totals — sum rush_att_i5 across players who played for that team
    team_i5 = defaultdict(int)
    for (gsis, season), rzr in rz_idx.items():
        team = team_map.get((gsis, season))
        if not team: continue
        team_i5[(season, team)] += rzr.get("rush_att_i5") or 0

    out = []
    for (gsis, season_n), w in weekly_idx.items():
        if pos_map.get((gsis, season_n)) not in ("RB", "FB"):
            continue
        if (w.get("rush_att") or 0) < MIN_CARRIES_N:
            continue
        f_n1 = opp_idx.get((gsis, season_n + 1))
        if not f_n1: continue
        if (f_n1.get("games") or 0) < MIN_GAMES_N1: continue
        target = _safe_div(f_n1.get("total_fp"), f_n1.get("games"))
        if target is None: continue

        team_n1 = team_map.get((gsis, season_n + 1))
        vegas_n1 = vegas_idx.get((season_n + 1, team_n1)) if team_n1 else None
        c = coach_idx.get((season_n + 1, team_n1)) if team_n1 else None
        coach_change_n1 = int(((c or {}).get("hc_change_flag") or 0) or
                              ((c or {}).get("oc_change_flag") or 0)) if c else 0

        f_n = opp_idx.get((gsis, season_n)) or {}
        fp_per_g_n = _safe_div(f_n.get("total_fp"), f_n.get("games"))
        fpoe_per_g_n = f_n.get("fpoe_per_g")

        ypc_n = _safe_div(w.get("rush_yds"), w.get("rush_att"))
        att_n = w.get("rush_att")
        snap_n = snap_idx.get((gsis, season_n))
        snap_n1 = snap_idx.get((gsis, season_n + 1))

        # Multi-year trailing — use seasons (n-2, n-1, n) for trail3 and (n-1, n) for trail2.
        # Weight fp/g by games, ypc by carries.
        fp_vals, fp_wts, ypc_vals, ypc_wts, att_vals = [], [], [], [], []
        for off in (-2, -1, 0):
            s = season_n + off
            wk_s = weekly_idx.get((gsis, s)) or {}
            opp_s = opp_idx.get((gsis, s)) or {}
            games_s = opp_s.get("games") or 0
            tfp_s = opp_s.get("total_fp")
            if games_s >= TRAIL_MIN_GAMES_PER_YR and tfp_s is not None:
                fp_vals.append(tfp_s / games_s); fp_wts.append(games_s)
            att_s = wk_s.get("rush_att") or 0
            yds_s = wk_s.get("rush_yds") or 0
            if att_s > 0:
                ypc_vals.append(yds_s / att_s); ypc_wts.append(att_s)
                att_vals.append(att_s)

        fp_trail2 = trailing_avg(fp_vals[-2:], fp_wts[-2:]) if len(fp_vals) >= 2 else fp_per_g_n
        fp_trail3 = trailing_avg(fp_vals[-3:], fp_wts[-3:]) if len(fp_vals) >= 3 else fp_trail2
        ypc_trail2 = trailing_avg(ypc_vals[-2:], ypc_wts[-2:]) if len(ypc_vals) >= 2 else ypc_n
        ypc_trail3 = trailing_avg(ypc_vals[-3:], ypc_wts[-3:]) if len(ypc_vals) >= 3 else ypc_trail2
        att_trail2 = sum(att_vals[-2:]) / len(att_vals[-2:]) if len(att_vals) >= 2 else att_n
        att_trail3 = sum(att_vals[-3:]) / len(att_vals[-3:]) if len(att_vals) >= 3 else att_trail2

        # Volume-share metrics
        team_n = team_map.get((gsis, season_n))
        team_rush_att_n = team_rush.get((season_n, team_n), {}).get("att") if team_n else None
        team_rush_share = _safe_div(att_n, team_rush_att_n) if team_rush_att_n else None
        player_i5 = (rz_idx.get((gsis, season_n)) or {}).get("rush_att_i5") or 0
        team_i5_n = team_i5.get((season_n, team_n)) if team_n else None
        i5_rush_share = _safe_div(player_i5, team_i5_n) if team_i5_n else None

        # Age
        age = age_at_season(bio_idx.get(gsis), season_n)
        bm = bio_meta.get(gsis) or {}
        draft_year = bm.get("draft_year")
        # UDFAs (no draft_year) are treated as drafted in the player's
        # rookie season at round 8 / pick 300 — the natural extension of
        # the 7-round draft. Keeps them in the regression sample.
        draft_round = bm.get("draft_round") if bm.get("draft_round") else 8
        draft_pick = bm.get("draft_pick") if bm.get("draft_pick") else 300
        nfl_yrs = (season_n - draft_year) if draft_year else None

        out.append({
            "gsis_id": gsis, "season_n": season_n, "season_n1": season_n + 1,
            # baseline
            "att_n": att_n, "ypc_n": ypc_n,
            "rush_tds_per_g_n": _safe_div(w.get("rush_tds"), w.get("weeks")),
            "rec_per_g_n": _safe_div(w.get("rec"), w.get("weeks")),
            "rec_yds_per_g_n": _safe_div(w.get("rec_yds"), w.get("weeks")),
            "fp_per_g_n": fp_per_g_n, "fpoe_per_g_n": fpoe_per_g_n,
            "vegas_n1": vegas_n1, "coach_change_n1": coach_change_n1,
            "snap_pct_n": snap_n, "snap_pct_n1": snap_n1,
            # NEW candidates
            "age": age, "nfl_yrs": nfl_yrs,
            "draft_round": draft_round, "draft_pick": draft_pick,
            "fp_per_g_trail2": fp_trail2, "fp_per_g_trail3": fp_trail3,
            "ypc_trail2": ypc_trail2, "ypc_trail3": ypc_trail3,
            "att_trail2": att_trail2, "att_trail3": att_trail3,
            "team_rush_share": team_rush_share, "i5_rush_share": i5_rush_share,
            # year-N+1 versions for stickiness lookups
            "_fp_per_g_n1": _safe_div((opp_idx.get((gsis, season_n+1)) or {}).get("total_fp"),
                                       (opp_idx.get((gsis, season_n+1)) or {}).get("games")),
            "_age_n1": age_at_season(bio_idx.get(gsis), season_n + 1),
            "target_fp_per_g_n1": target,
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


def fit_ols(rows, features, target_key="target_fp_per_g_n1"):
    clean = [r for r in rows if all(r.get(f) is not None for f in features)
             and r.get(target_key) is not None]
    if len(clean) < 30: return None, 0
    X = np.array([[r[f] for f in features] for r in clean], dtype=float)
    y = np.array([r[target_key] for r in clean], dtype=float)
    n = X.shape[0]
    Xa = np.column_stack([np.ones(n), X])
    XtX = Xa.T @ Xa
    try:
        XtX_inv = np.linalg.inv(XtX)
    except np.linalg.LinAlgError:
        return None, n
    beta = XtX_inv @ Xa.T @ y
    yh = Xa @ beta
    rss = float(np.sum((y - yh) ** 2))
    tss = float(np.sum((y - y.mean()) ** 2))
    return ({"r2": 1 - rss/tss, "rss": rss, "n": n, "k": Xa.shape[1],
             "beta": beta, "XtX_inv": XtX_inv}, n)


def f_test_marginal(rows, baseline_feats, test_feat):
    feats_full = baseline_feats + [test_feat]
    clean = [r for r in rows
             if all(r.get(f) is not None for f in feats_full)
             and r.get("target_fp_per_g_n1") is not None]
    if len(clean) < 30: return None
    fa, _ = fit_ols(clean, baseline_feats)
    fb, _ = fit_ols(clean, feats_full)
    if fa is None or fb is None: return None
    df_resid_b = fb["n"] - fb["k"]
    if df_resid_b <= 0: return None
    f_stat = ((fa["rss"] - fb["rss"]) / 1) / (fb["rss"] / df_resid_b)
    p = 1 - stats.f.cdf(f_stat, 1, df_resid_b)
    coef = fb["beta"][-1]
    se_diag = fb["XtX_inv"][-1, -1]
    se = float(np.sqrt(max(0.0, fb["rss"] / df_resid_b * se_diag)))
    return {"r2_a": fa["r2"], "r2_b": fb["r2"],
            "delta_r2": fb["r2"] - fa["r2"],
            "f_p": p, "coef": coef, "se": se,
            "n_used": len(clean)}


def fmt_r(r): return f"{r:>+6.3f}" if r is not None else f"{'—':>6}"
def fmt_d(r): return f"{r:>+7.4f}" if r is not None else f"{'—':>7}"


BASELINE_SINGLE = ["att_n", "ypc_n", "rush_tds_per_g_n", "rec_per_g_n",
                   "rec_yds_per_g_n", "fp_per_g_n", "fpoe_per_g_n",
                   "vegas_n1", "coach_change_n1"]

BASELINE_TRAILING = ["att_trail3", "ypc_trail3", "rush_tds_per_g_n", "rec_per_g_n",
                     "rec_yds_per_g_n", "fp_per_g_trail3", "fpoe_per_g_n",
                     "vegas_n1", "coach_change_n1"]

# Candidate label -> (row_key, sticky_year_n1_key, snap_correlate)
# row_key is the column on the universe row holding the value at year N.
CANDIDATES = [
    ("age",                "age",              "_age_n1",        None),
    ("nfl_yrs",            "nfl_yrs",          None,             None),
    ("draft_round",        "draft_round",      None,             None),
    ("fp_per_g_trail3",    "fp_per_g_trail3",  None,             None),
    ("fp_per_g_trail2",    "fp_per_g_trail2",  None,             None),
    ("ypc_trail3",         "ypc_trail3",       None,             None),
    ("ypc_trail2",         "ypc_trail2",       None,             None),
    ("att_trail3",         "att_trail3",       None,             None),
    ("att_trail2",         "att_trail2",       None,             None),
    ("team_rush_share",    "team_rush_share",  None,             None),
    ("i5_rush_share",      "i5_rush_share",    None,             None),
]


def main():
    data = pull_data()
    pos_map = mode_map(data[9], "position")
    team_map = mode_map(data[10], "team")
    universe = build_universe(*data[:9], pos_map, team_map, *data[11:])
    print(f"\nUniverse: {len(universe)} (RB year-N→year-N+1) pairs",
          file=sys.stderr)

    # ── Per-feature battery
    print(f"\n{'='*102}")
    print(f" EXTENDED RB BATTERY  (n={len(universe)} pairs, baseline=single-year)")
    print(f"{'='*102}")
    print(f" {'feature':<22}  {'sticky':>7} {'sig_fp':>7} {'sig_fpoe':>9} "
          f"{'snap_n+1':>9} {'ΔR²':>8} {'F p':>7}  {'verdict':<22}")
    print(f" {'-'*22}  {'-'*7} {'-'*7} {'-'*9} {'-'*9} {'-'*8} {'-'*7}  {'-'*22}")

    for label, key, sticky_key, _ in CANDIDATES:
        # Stickiness — corr(feat_yearN, feat_yearN+1).
        # For age, the year-N+1 value is just age+1, which is mechanically perfect.
        # For everything else, we'd need the next-year value of the same metric.
        if sticky_key:
            xs = [r[key] for r in universe if r.get(key) is not None and r.get(sticky_key) is not None]
            ys = [r[sticky_key] for r in universe if r.get(key) is not None and r.get(sticky_key) is not None]
            sticky = pearson([float(x) for x in xs], [float(y) for y in ys])
        else:
            sticky = None  # for trailing/share metrics, "year-N+1 same metric" needs separate joins; skip

        # Same-year univariate vs fp_per_g_n
        xs = [float(r[key]) for r in universe
              if r.get(key) is not None and r.get("fp_per_g_n") is not None]
        ys = [float(r["fp_per_g_n"]) for r in universe
              if r.get(key) is not None and r.get("fp_per_g_n") is not None]
        sig_fp = pearson(xs, ys)
        # vs fpoe_per_g_n
        xs = [float(r[key]) for r in universe
              if r.get(key) is not None and r.get("fpoe_per_g_n") is not None]
        ys = [float(r["fpoe_per_g_n"]) for r in universe
              if r.get(key) is not None and r.get("fpoe_per_g_n") is not None]
        sig_fpoe = pearson(xs, ys)
        # vs snap_pct_n+1
        xs = [float(r[key]) for r in universe
              if r.get(key) is not None and r.get("snap_pct_n1") is not None]
        ys = [float(r["snap_pct_n1"]) for r in universe
              if r.get(key) is not None and r.get("snap_pct_n1") is not None]
        snap_pred = pearson(xs, ys)

        # Marginal R²: drop conflicting baseline col before testing
        baseline_for_test = list(BASELINE_SINGLE)
        col_collisions = {
            "fp_per_g_trail3": "fp_per_g_n",
            "fp_per_g_trail2": "fp_per_g_n",
            "ypc_trail3": "ypc_n",
            "ypc_trail2": "ypc_n",
            "att_trail3": "att_n",
            "att_trail2": "att_n",
        }
        if label in col_collisions and col_collisions[label] in baseline_for_test:
            baseline_for_test.remove(col_collisions[label])
        marginal = f_test_marginal(universe, baseline_for_test, key)

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

        print(f" {label:<22}  {fmt_r(sticky)} {fmt_r(sig_fp)} "
              f"{fmt_r(sig_fpoe)} {fmt_r(snap_pred)} "
              f"{fmt_d(d_r2)} {fmt_r(f_p)}  {verdict:<22}")

    # ── Baseline swap test: how does single-year baseline compare to trailing?
    print(f"\n{'='*102}")
    print(f" BASELINE SWAP — single-year vs trailing-3yr")
    print(f"{'='*102}")
    fit_single, n_s = fit_ols(universe, BASELINE_SINGLE)
    fit_trail, n_t = fit_ols(universe, BASELINE_TRAILING)
    if fit_single and fit_trail:
        print(f"  Model SINGLE  : n={n_s}, R² = {fit_single['r2']:.4f}, "
              f"k={fit_single['k']}")
        print(f"  Model TRAIL-3 : n={n_t}, R² = {fit_trail['r2']:.4f}, "
              f"k={fit_trail['k']}")
        print(f"  ΔR² (TRAIL − SINGLE) = {fit_trail['r2']-fit_single['r2']:+.4f}")
    else:
        print("  insufficient data")

    # ── Combined: SINGLE + age + i5_rush_share + team_rush_share
    print(f"\n{'='*102}")
    print(f" KITCHEN-SINK — SINGLE + age + nfl_yrs + draft_round + team_rush_share + fp_per_g_trail3")
    print(f"{'='*102}")
    sink = BASELINE_SINGLE + ["age", "nfl_yrs", "draft_round", "team_rush_share",
                              "fp_per_g_trail3"]
    fit_sink, n_k = fit_ols(universe, sink)
    if fit_sink:
        print(f"  n={n_k}, R² = {fit_sink['r2']:.4f}, k={fit_sink['k']}")
        print(f"  ΔR² vs SINGLE = {fit_sink['r2']-fit_single['r2']:+.4f}")
        # Coefficient table with t/p
        df_resid = fit_sink["n"] - fit_sink["k"]
        sigma2 = fit_sink["rss"] / df_resid
        ses = np.sqrt(np.maximum(0.0, sigma2 * np.diag(fit_sink["XtX_inv"])))
        names = ["(intercept)"] + sink
        print(f"  {'feature':<24} {'coef':>10} {'se':>9} {'t':>7} {'p':>9}")
        print(f"  {'-'*24} {'-'*10} {'-'*9} {'-'*7} {'-'*9}")
        for i, fn in enumerate(names):
            t = fit_sink["beta"][i] / ses[i] if ses[i] > 0 else 0
            p = 2 * (1 - stats.t.cdf(abs(t), df_resid))
            sig = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else " "
            print(f"  {fn:<24} {fit_sink['beta'][i]:>+10.4f} {ses[i]:>9.4f} "
                  f"{t:>+7.2f} {p:>8.4f}{sig}")
    else:
        print("  insufficient data")

    # ── PARSIMONIOUS — just SINGLE + draft_round + fp_per_g_trail3
    print(f"\n{'='*102}")
    print(f" PARSIMONIOUS — SINGLE + draft_round + fp_per_g_trail3 (the 2 features that survive)")
    print(f"{'='*102}")
    pars = BASELINE_SINGLE + ["draft_round", "fp_per_g_trail3"]
    fit_pars, n_p = fit_ols(universe, pars)
    if fit_pars:
        print(f"  n={n_p}, R² = {fit_pars['r2']:.4f}, k={fit_pars['k']}")
        print(f"  ΔR² vs SINGLE = {fit_pars['r2']-fit_single['r2']:+.4f}")
        df_resid = fit_pars["n"] - fit_pars["k"]
        sigma2 = fit_pars["rss"] / df_resid
        ses = np.sqrt(np.maximum(0.0, sigma2 * np.diag(fit_pars["XtX_inv"])))
        names = ["(intercept)"] + pars
        print(f"  {'feature':<24} {'coef':>10} {'se':>9} {'t':>7} {'p':>9}")
        print(f"  {'-'*24} {'-'*10} {'-'*9} {'-'*7} {'-'*9}")
        for i, fn in enumerate(names):
            t = fit_pars["beta"][i] / ses[i] if ses[i] > 0 else 0
            p = 2 * (1 - stats.t.cdf(abs(t), df_resid))
            sig = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else " "
            print(f"  {fn:<24} {fit_pars['beta'][i]:>+10.4f} {ses[i]:>9.4f} "
                  f"{t:>+7.2f} {p:>8.4f}{sig}")

    # ── LOSO cross-validation: SINGLE vs KITCHEN-SINK
    print(f"\n{'='*102}")
    print(f" LEAVE-ONE-SEASON-OUT CV — does the kitchen-sink hold up out-of-sample?")
    print(f"{'='*102}")
    by_n1 = defaultdict(list)
    # Use the COMMON sample (rows where every kitchen-sink feature is present)
    sink_clean = [r for r in universe
                  if all(r.get(f) is not None for f in sink)
                  and r.get("target_fp_per_g_n1") is not None]
    for r in sink_clean: by_n1[r["season_n1"]].append(r)
    print(f"  {'predict_year':<14} {'n':>4} {'rmse_SINGLE':>12} "
          f"{'rmse_SINK':>11} {'delta':>9}")
    print(f"  {'-'*14} {'-'*4} {'-'*12} {'-'*11} {'-'*9}")
    deltas = []
    for hold in sorted(by_n1):
        train = [r for r in sink_clean if r["season_n1"] != hold]
        test = by_n1[hold]
        if len(train) < 30 or len(test) < 5: continue
        # Fit SINGLE
        Xs = np.array([[r[f] for f in BASELINE_SINGLE] for r in train], dtype=float)
        ys = np.array([r["target_fp_per_g_n1"] for r in train], dtype=float)
        Xs_a = np.column_stack([np.ones(len(train)), Xs])
        beta_s = np.linalg.solve(Xs_a.T @ Xs_a, Xs_a.T @ ys)
        Xte_s = np.array([[r[f] for f in BASELINE_SINGLE] for r in test], dtype=float)
        Xte_s_a = np.column_stack([np.ones(len(test)), Xte_s])
        yp_s = Xte_s_a @ beta_s
        yte = np.array([r["target_fp_per_g_n1"] for r in test], dtype=float)
        rmse_s = float(np.sqrt(np.mean((yte - yp_s) ** 2)))
        # Fit SINK
        Xk = np.array([[r[f] for f in sink] for r in train], dtype=float)
        Xk_a = np.column_stack([np.ones(len(train)), Xk])
        beta_k = np.linalg.solve(Xk_a.T @ Xk_a, Xk_a.T @ ys)
        Xte_k = np.array([[r[f] for f in sink] for r in test], dtype=float)
        Xte_k_a = np.column_stack([np.ones(len(test)), Xte_k])
        yp_k = Xte_k_a @ beta_k
        rmse_k = float(np.sqrt(np.mean((yte - yp_k) ** 2)))
        d = rmse_k - rmse_s
        deltas.append(d)
        flag = "✓" if d < 0 else "✗"
        print(f"  {hold:<14} {len(test):>4} {rmse_s:>12.3f} "
              f"{rmse_k:>11.3f} {d:>+9.4f} {flag}")
    if deltas:
        avg = sum(deltas) / len(deltas)
        wins = sum(1 for d in deltas if d < 0)
        print(f"  {'avg':<14} {'':>4} {'':>12} {'':>11} {avg:>+9.4f}  "
              f"({wins}/{len(deltas)} seasons improved)")


if __name__ == "__main__":
    main()
