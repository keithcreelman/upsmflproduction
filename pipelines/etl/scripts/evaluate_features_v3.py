#!/usr/bin/env python3
"""Generalized RB/WR/TE feature battery + consistency + gamescript + injuries.

Builds on evaluate_rb_features_v2.py — adds:
  - --position flag (RB | WR | TE)
  - Position-specific baseline (volume metric, min thresholds)
  - Per-week consistency (coefficient of variation of weekly fp)
  - Game-script splits (rush/rec yards in leading vs trailing)
  - Injury history (weeks_out, weeks_designated)

Per-position baselines:
  RB:  att_n, ypc_n, rush_tds_per_g, rec_per_g, rec_yds_per_g,
       fp_per_g_n, fpoe_per_g_n, vegas_n1, coach_change_n1
  WR:  rec_per_g, rec_yds_per_g, rec_tds_per_g, target_share, adot,
       fp_per_g_n, fpoe_per_g_n, vegas_n1, coach_change_n1
  TE:  same as WR

Test universe: position-classified player-seasons with min volume in
year-N and >= 6 games in year-N+1.

Usage:
  python3 pipelines/etl/scripts/evaluate_features_v3.py --position RB
  python3 pipelines/etl/scripts/evaluate_features_v3.py --position WR
  python3 pipelines/etl/scripts/evaluate_features_v3.py --position TE
"""
from __future__ import annotations
import argparse
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

POSITION_CONFIG = {
    "RB": {
        "positions": ["RB", "FB"],
        "volume_field": "rush_att",
        "min_volume": 100,
        "primary_role": "rusher",
        "baseline": ["att_n", "ypc_n", "rush_tds_per_g_n", "rec_per_g_n",
                     "rec_yds_per_g_n", "fp_per_g_n", "fpoe_per_g_n",
                     "vegas_n1", "coach_change_n1"],
    },
    "WR": {
        "positions": ["WR"],
        "volume_field": "targets",
        "min_volume": 50,
        "primary_role": "receiver",
        # adot_n is 0% populated in nfl_player_weekly (it's a PFR-derived
        # field that needs a separate fetcher); excluded from baseline.
        "baseline": ["targets_n", "rec_per_g_n", "rec_yds_per_g_n",
                     "rec_tds_per_g_n",
                     "fp_per_g_n", "fpoe_per_g_n",
                     "vegas_n1", "coach_change_n1"],
    },
    "TE": {
        "positions": ["TE"],
        "volume_field": "targets",
        "min_volume": 30,
        "primary_role": "receiver",
        "baseline": ["targets_n", "rec_per_g_n", "rec_yds_per_g_n",
                     "rec_tds_per_g_n",
                     "fp_per_g_n", "fpoe_per_g_n",
                     "vegas_n1", "coach_change_n1"],
    },
}

MIN_GAMES_N1 = 6
TRAIL_MIN_GAMES_PER_YR = 4


def wrangler_query(sql: str, max_attempts: int = 4) -> list[dict]:
    """Run wrangler d1 execute with retry on transient 401/5xx auth blips."""
    import time
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    last_err = ""
    for attempt in range(1, max_attempts + 1):
        res = subprocess.run(cmd, cwd=str(WORKER_DIR),
                             capture_output=True, text=True)
        if res.returncode == 0:
            out = res.stdout
            idx = out.find("[")
            if idx < 0:
                last_err = f"no JSON: {out[:300]}"
            else:
                try:
                    return json.loads(out[idx:])[0]["results"]
                except (json.JSONDecodeError, KeyError, IndexError) as e:
                    last_err = f"json parse: {e}"
        else:
            last_err = (f"rc={res.returncode} stderr={res.stderr[:300]} "
                        f"stdout={res.stdout[:200]}")
        if attempt < max_attempts:
            print(f"  wrangler retry {attempt}/{max_attempts}: {last_err[:200]}",
                  file=sys.stderr)
            time.sleep(2 * attempt)
    sys.exit(f"wrangler failed after {max_attempts} attempts: {last_err}")


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


def trailing_avg(values, weights):
    tot_w = sum(weights)
    if tot_w == 0: return None
    return sum(v * w for v, w in zip(values, weights)) / tot_w


# Standard PPR-ish weekly fantasy points (matches ff_opportunity's nflverse PPR).
# Used for per-week consistency only.
def weekly_fp(row):
    rush_yds = row.get("rush_yds") or 0
    rush_tds = row.get("rush_tds") or 0
    rec = row.get("receptions") or 0
    rec_yds = row.get("rec_yds") or 0
    rec_tds = row.get("rec_tds") or 0
    pass_yds = row.get("pass_yds") or 0
    pass_tds = row.get("pass_tds") or 0
    pass_ints = row.get("pass_ints") or 0
    fum_lost = (row.get("rush_fumbles_lost") or 0) + (row.get("rec_fumbles_lost") or 0)
    return (0.1 * rush_yds + 6 * rush_tds + 0.1 * rec_yds + 1 * rec
            + 6 * rec_tds + 0.04 * pass_yds + 4 * pass_tds - 2 * pass_ints
            - 2 * fum_lost)


def pull_data(min_season=2014):
    print(f"Pulling D1 data from {min_season}...", file=sys.stderr)

    # WEEKLY at the WEEK level (need this for consistency CV)
    weekly_week = wrangler_query(
        f"SELECT season, week, gsis_id, team, position, "
        f"       rush_att, rush_yds, rush_tds, rush_fumbles_lost, "
        f"       receptions, targets, rec_yds, rec_tds, rec_fumbles_lost, "
        f"       pass_att, pass_cmp, pass_yds, pass_tds, pass_ints, "
        f"       receiving_air_yards, receiving_adot "
        f"FROM nfl_player_weekly WHERE season>={min_season}"
    )
    # Aggregate per-(gsis_id, season) for the regression
    weekly_season = defaultdict(lambda: {
        "rush_att": 0, "rush_yds": 0, "rush_tds": 0,
        "rec": 0, "targets": 0, "rec_yds": 0, "rec_tds": 0,
        "pass_att": 0, "pass_yds": 0, "pass_tds": 0,
        "weeks": 0, "rec_air_yards": 0, "rec_adot_sum": 0, "rec_adot_n": 0,
    })
    for r in weekly_week:
        k = (r["gsis_id"], r["season"])
        s = weekly_season[k]
        s["rush_att"] += r.get("rush_att") or 0
        s["rush_yds"] += r.get("rush_yds") or 0
        s["rush_tds"] += r.get("rush_tds") or 0
        s["rec"] += r.get("receptions") or 0
        s["targets"] += r.get("targets") or 0
        s["rec_yds"] += r.get("rec_yds") or 0
        s["rec_tds"] += r.get("rec_tds") or 0
        s["pass_att"] += r.get("pass_att") or 0
        s["pass_yds"] += r.get("pass_yds") or 0
        s["pass_tds"] += r.get("pass_tds") or 0
        s["rec_air_yards"] += r.get("receiving_air_yards") or 0
        adot = r.get("receiving_adot")
        if adot is not None:
            s["rec_adot_sum"] += adot
            s["rec_adot_n"] += 1
        s["weeks"] += 1
    weekly_season_list = [{**v, "gsis_id": k[0], "season": k[1]}
                          for k, v in weekly_season.items()]

    breakaway = wrangler_query(
        f"SELECT season, gsis_id, role, attempts, plays_15plus, plays_20plus "
        f"FROM nfl_player_breakaway_season WHERE season>={min_season}"
    )
    pbp = wrangler_query(
        f"SELECT season, gsis_id, role, n_plays, epa_per_play, success_rate "
        f"FROM nfl_player_pbp_season WHERE season>={min_season}"
    )
    rz = wrangler_query(
        f"SELECT season, gsis_id, "
        f"       SUM(COALESCE(rush_att_i20,0)) AS rush_att_i20, "
        f"       SUM(COALESCE(rush_att_i10,0)) AS rush_att_i10, "
        f"       SUM(COALESCE(rush_att_i5,0))  AS rush_att_i5, "
        f"       SUM(COALESCE(rush_tds_i20,0)) AS rush_tds_i20, "
        f"       SUM(COALESCE(targets_i20,0))  AS targets_i20, "
        f"       SUM(COALESCE(targets_i10,0))  AS targets_i10, "
        f"       SUM(COALESCE(targets_i5,0))   AS targets_i5, "
        f"       SUM(COALESCE(targets_ez,0))   AS targets_ez, "
        f"       SUM(COALESCE(rec_tds_i20,0))  AS rec_tds_i20 "
        f"FROM nfl_player_redzone WHERE season>={min_season} GROUP BY season, gsis_id"
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
    snaps = wrangler_query(
        f"SELECT season, pfr_id, AVG(off_snap_pct) AS off_snap_pct_avg "
        f"FROM nfl_player_snaps WHERE season>={min_season} AND off_snap_pct IS NOT NULL "
        f"GROUP BY season, pfr_id"
    )
    xwalk = wrangler_query(
        "SELECT gsis_id, pfr_id FROM player_id_crosswalk "
        "WHERE gsis_id IS NOT NULL AND pfr_id IS NOT NULL"
    )
    bio = wrangler_query(
        "SELECT gsis_id, birth_date, draft_year, draft_round FROM dim_player_bio "
        "WHERE birth_date IS NOT NULL"
    )

    # New tables — may be empty if backfill hasn't run yet
    try:
        gamescript = wrangler_query(
            f"SELECT season, gsis_id, role, plays_leading, plays_neutral, "
            f"       plays_trailing, yards_leading, yards_neutral, yards_trailing "
            f"FROM nfl_player_gamescript_season WHERE season>={min_season}"
        )
    except Exception:
        gamescript = []
    try:
        injuries = wrangler_query(
            f"SELECT season, gsis_id, weeks_out, weeks_doubtful, weeks_questionable, "
            f"       weeks_designated, distinct_body_parts "
            f"FROM nfl_player_injuries_season WHERE season>={min_season}"
        )
    except Exception:
        injuries = []

    print(f"  weekly_week={len(weekly_week)}, weekly_season={len(weekly_season)}, "
          f"brk={len(breakaway)}, pbp={len(pbp)}, rz={len(rz)}, opp={len(opp)}, "
          f"snaps={len(snaps)}, vegas={len(vegas)}, coaching={len(coaching)}, "
          f"bio={len(bio)}, xwalk={len(xwalk)}, gamescript={len(gamescript)}, "
          f"injuries={len(injuries)}",
          file=sys.stderr)
    return (weekly_week, weekly_season_list, breakaway, pbp, rz, opp,
            snaps, vegas, coaching, pos_per_season, team_per_season,
            xwalk, bio, gamescript, injuries)


def mode_map(rows, key_field):
    by_key = defaultdict(lambda: defaultdict(int))
    for r in rows:
        by_key[(r["gsis_id"], r["season"])][r[key_field]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def compute_weekly_fp_consistency(weekly_week_rows):
    """Per (gsis_id, season): list of weekly fp values + CV (std/mean)."""
    by_key = defaultdict(list)
    for r in weekly_week_rows:
        fp = weekly_fp(r)
        if fp is not None:
            by_key[(r["gsis_id"], r["season"])].append(fp)
    out = {}
    for k, vs in by_key.items():
        if len(vs) < 4:
            continue
        m = statistics.mean(vs)
        if m <= 0.5:  # avoid div-by-zero / amplifying tiny means
            continue
        sd = statistics.stdev(vs) if len(vs) > 1 else 0
        out[k] = {
            "weekly_fp_mean": m,
            "weekly_fp_std": sd,
            "weekly_fp_cv": sd / m,
            "weekly_fp_max": max(vs),
            "weekly_fp_min": min(vs),
            "n_weeks": len(vs),
        }
    return out


def build_universe(data, position):
    (weekly_week, weekly_season, breakaway, pbp, rz, opp, snaps,
     vegas, coaching, pos_per_season, team_per_season, xwalk, bio,
     gamescript, injuries) = data
    cfg = POSITION_CONFIG[position]
    pos_map = mode_map(pos_per_season, "position")
    team_map = mode_map(team_per_season, "team")

    weekly_idx = {(r["gsis_id"], r["season"]): r for r in weekly_season}
    brk_idx = {(r["role"], r["gsis_id"], r["season"]): r for r in breakaway}
    pbp_idx = {(r["role"], r["gsis_id"], r["season"]): r for r in pbp}
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
    gs_idx = {(r["role"], r["gsis_id"], r["season"]): r for r in gamescript}
    inj_idx = {(r["gsis_id"], r["season"]): r for r in injuries}

    # Team rush + team targets totals
    team_rush_att = defaultdict(int)
    team_targets = defaultdict(int)
    for k, w in weekly_idx.items():
        gsis, season = k
        team = team_map.get(k)
        if not team: continue
        team_rush_att[(season, team)] += w.get("rush_att") or 0
        team_targets[(season, team)] += w.get("targets") or 0

    # Per-week consistency
    consistency = compute_weekly_fp_consistency(weekly_week)

    role = cfg["primary_role"]
    out = []
    for (gsis, season_n), w in weekly_idx.items():
        if pos_map.get((gsis, season_n)) not in cfg["positions"]:
            continue
        if (w.get(cfg["volume_field"]) or 0) < cfg["min_volume"]:
            continue
        f_n1 = opp_idx.get((gsis, season_n + 1))
        if not f_n1: continue
        if (f_n1.get("games") or 0) < MIN_GAMES_N1: continue
        target = _safe_div(f_n1.get("total_fp"), f_n1.get("games"))
        if target is None: continue

        team_n = team_map.get((gsis, season_n))
        team_n1 = team_map.get((gsis, season_n + 1))
        vegas_n1 = vegas_idx.get((season_n + 1, team_n1)) if team_n1 else None
        c = coach_idx.get((season_n + 1, team_n1)) if team_n1 else None
        coach_change_n1 = int(((c or {}).get("hc_change_flag") or 0) or
                              ((c or {}).get("oc_change_flag") or 0)) if c else 0

        f_n = opp_idx.get((gsis, season_n)) or {}
        fp_per_g_n = _safe_div(f_n.get("total_fp"), f_n.get("games"))
        fpoe_per_g_n = f_n.get("fpoe_per_g")

        weeks = w.get("weeks") or 0
        if weeks <= 0: continue

        # Position-flexible feature rows
        att_n = w.get("rush_att") or 0
        ypc_n = _safe_div(w.get("rush_yds"), w.get("rush_att"))
        targets_n = w.get("targets") or 0
        rec_n = w.get("rec") or 0

        # Trailing
        fp_vals, fp_wts, ypc_vals, ypc_wts = [], [], [], []
        att_vals, tgt_vals, rec_vals = [], [], []
        rec_yds_vals, rec_yds_wts = [], []
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
            tgt_s = wk_s.get("targets") or 0
            rec_s = wk_s.get("rec") or 0
            ryds_s = wk_s.get("rec_yds") or 0
            if tgt_s > 0:
                tgt_vals.append(tgt_s); rec_vals.append(rec_s)
                rec_yds_vals.append(ryds_s / tgt_s); rec_yds_wts.append(tgt_s)

        fp_trail3 = (trailing_avg(fp_vals[-3:], fp_wts[-3:])
                     if len(fp_vals) >= 3 else
                     (trailing_avg(fp_vals[-2:], fp_wts[-2:])
                      if len(fp_vals) >= 2 else fp_per_g_n))
        ypc_trail3 = (trailing_avg(ypc_vals[-3:], ypc_wts[-3:])
                      if len(ypc_vals) >= 3 else ypc_n)
        att_trail3 = (sum(att_vals[-3:])/len(att_vals[-3:])
                      if len(att_vals) >= 3 else att_n)
        tgt_trail3 = (sum(tgt_vals[-3:])/len(tgt_vals[-3:])
                      if len(tgt_vals) >= 3 else targets_n)
        rec_trail3 = (sum(rec_vals[-3:])/len(rec_vals[-3:])
                      if len(rec_vals) >= 3 else rec_n)

        # Volume share
        team_rush_att_n = team_rush_att.get((season_n, team_n)) if team_n else None
        team_rush_share = _safe_div(att_n, team_rush_att_n) if team_rush_att_n else None
        team_targets_n = team_targets.get((season_n, team_n)) if team_n else None
        target_share = _safe_div(targets_n, team_targets_n) if team_targets_n else None
        i5_player = (rz_idx.get((gsis, season_n)) or {}).get("rush_att_i5") or 0

        # Receiving features
        rec_air = w.get("rec_air_yards") or 0
        adot_n = (w.get("rec_adot_sum") / w.get("rec_adot_n")) if (w.get("rec_adot_n") or 0) > 0 else None
        rec_yds = w.get("rec_yds") or 0

        # Redzone share for receivers
        rz_n = rz_idx.get((gsis, season_n)) or {}
        rz_target_share_i20 = _safe_div(rz_n.get("targets_i20"), targets_n) if targets_n else None
        rz_target_share_i10 = _safe_div(rz_n.get("targets_i10"), targets_n) if targets_n else None
        rz_target_share_ez  = _safe_div(rz_n.get("targets_ez"), targets_n) if targets_n else None

        # Demographics
        age = age_at_season(bio_idx.get(gsis), season_n)
        bm = bio_meta.get(gsis) or {}
        draft_year = bm.get("draft_year")
        draft_round = bm.get("draft_round") if bm.get("draft_round") else 8
        nfl_yrs = (season_n - draft_year) if draft_year else None

        # Consistency
        cons = consistency.get((gsis, season_n)) or {}

        # Game script (year N)
        gs_n = gs_idx.get((role, gsis, season_n)) or {}
        gs_total = (gs_n.get("plays_leading") or 0) + (gs_n.get("plays_neutral") or 0) + (gs_n.get("plays_trailing") or 0)
        leading_share = _safe_div(gs_n.get("plays_leading"), gs_total) if gs_total else None
        trailing_share = _safe_div(gs_n.get("plays_trailing"), gs_total) if gs_total else None

        # Injuries
        inj_n = inj_idx.get((gsis, season_n)) or {}
        weeks_out = inj_n.get("weeks_out")
        weeks_designated = inj_n.get("weeks_designated")
        distinct_body_parts = inj_n.get("distinct_body_parts")

        # Snap pct
        snap_n = snap_idx.get((gsis, season_n))
        snap_n1 = snap_idx.get((gsis, season_n + 1))

        out.append({
            "gsis_id": gsis, "season_n": season_n, "season_n1": season_n + 1,
            # baseline RB
            "att_n": att_n, "ypc_n": ypc_n,
            "rush_tds_per_g_n": _safe_div(w.get("rush_tds"), weeks),
            "rec_per_g_n": _safe_div(rec_n, weeks),
            "rec_yds_per_g_n": _safe_div(rec_yds, weeks),
            # baseline WR/TE
            "targets_n": targets_n,
            "rec_tds_per_g_n": _safe_div(w.get("rec_tds"), weeks),
            "adot_n": adot_n,
            # universal
            "fp_per_g_n": fp_per_g_n, "fpoe_per_g_n": fpoe_per_g_n,
            "vegas_n1": vegas_n1, "coach_change_n1": coach_change_n1,
            "snap_pct_n": snap_n, "snap_pct_n1": snap_n1,
            # candidates
            "age": age, "nfl_yrs": nfl_yrs, "draft_round": draft_round,
            "fp_per_g_trail3": fp_trail3, "ypc_trail3": ypc_trail3,
            "att_trail3": att_trail3, "tgt_trail3": tgt_trail3,
            "rec_trail3": rec_trail3,
            "team_rush_share": team_rush_share, "target_share": target_share,
            "i5_rush_share": _safe_div(i5_player, team_rush_att.get((season_n, team_n))) if team_n else None,
            "rz_target_share_i20": rz_target_share_i20,
            "rz_target_share_i10": rz_target_share_i10,
            "rz_target_share_ez": rz_target_share_ez,
            # gamescript
            "leading_share_n": leading_share, "trailing_share_n": trailing_share,
            # injuries
            "weeks_out_n": weeks_out, "weeks_designated_n": weeks_designated,
            "distinct_body_parts_n": distinct_body_parts,
            # consistency
            "weekly_fp_cv_n": cons.get("weekly_fp_cv"),
            "weekly_fp_std_n": cons.get("weekly_fp_std"),
            "weekly_fp_mean_n": cons.get("weekly_fp_mean"),
            # target
            "target_fp_per_g_n1": target,
        })
    return out


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
    se = float(np.sqrt(max(0.0, fb["rss"]/df_resid_b * fb["XtX_inv"][-1,-1])))
    return {"r2_a": fa["r2"], "r2_b": fb["r2"],
            "delta_r2": fb["r2"] - fa["r2"],
            "f_p": p, "coef": coef, "se": se, "n_used": len(clean)}


def fmt_d(r): return f"{r:>+7.4f}" if r is not None else f"{'—':>7}"
def fmt_r(r): return f"{r:>+6.3f}" if r is not None else f"{'—':>6}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--position", required=True, choices=["RB", "WR", "TE"])
    ap.add_argument("--min-season", type=int, default=2014)
    args = ap.parse_args()

    cfg = POSITION_CONFIG[args.position]
    data = pull_data(args.min_season)
    universe = build_universe(data, args.position)
    print(f"\nUniverse for {args.position}: {len(universe)} pairs",
          file=sys.stderr)

    BASELINE = cfg["baseline"]
    fit_base, n_b = fit_ols(universe, BASELINE)

    # Candidate features to test
    base_candidates = [
        "age", "nfl_yrs", "draft_round",
        "fp_per_g_trail3", "ypc_trail3", "att_trail3",
        "tgt_trail3", "rec_trail3",
        "team_rush_share", "target_share",
        "i5_rush_share", "rz_target_share_i20",
        "rz_target_share_i10", "rz_target_share_ez",
        "leading_share_n", "trailing_share_n",
        "weeks_out_n", "weeks_designated_n", "distinct_body_parts_n",
        "weekly_fp_cv_n", "weekly_fp_std_n",
    ]

    print(f"\n{'='*102}")
    print(f" {args.position} FEATURE BATTERY  (n={len(universe)} pairs, baseline R²="
          f"{fit_base['r2']:.4f})" if fit_base else f" {args.position} BATTERY")
    print(f"{'='*102}")
    print(f" {'feature':<26} {'ΔR²':>8} {'F p':>7} {'coef':>9} {'n_used':>7}  verdict")
    print(f" {'-'*26} {'-'*8} {'-'*7} {'-'*9} {'-'*7}  -------")

    results = []
    for feat in base_candidates:
        # Skip features that collide with baseline
        baseline_for_test = list(BASELINE)
        collisions = {
            "fp_per_g_trail3": "fp_per_g_n",
            "ypc_trail3": "ypc_n",
            "att_trail3": "att_n",
            "tgt_trail3": "targets_n",
            "rec_trail3": "rec_per_g_n",
        }
        if feat in collisions and collisions[feat] in baseline_for_test:
            baseline_for_test.remove(collisions[feat])
        m = f_test_marginal(universe, baseline_for_test, feat)
        if m is None:
            verdict = "(insufficient)"
            print(f" {feat:<26} {'—':>8} {'—':>7} {'—':>9} {'—':>7}  {verdict}")
            continue
        if m["delta_r2"] > 0.005 and m["f_p"] < 0.05:
            verdict = "ADDS lift ✓"
        elif m["delta_r2"] > 0.001 and m["f_p"] < 0.10:
            verdict = "marginal"
        else:
            verdict = "redundant"
        print(f" {feat:<26} {fmt_d(m['delta_r2'])} {fmt_r(m['f_p'])} "
              f"{fmt_r(m['coef'])} {m['n_used']:>7}  {verdict}")
        results.append((feat, m, verdict))

    # Build "all-significant-features" model
    sig_feats = [r[0] for r in results if r[2].startswith("ADDS")]
    print(f"\n{'='*102}")
    print(f" KITCHEN-SINK MODEL — baseline + all 'ADDS lift' features ({len(sig_feats)})")
    print(f"{'='*102}")
    if sig_feats:
        # Drop collisions from baseline
        base_for_sink = list(BASELINE)
        collisions = {
            "fp_per_g_trail3": "fp_per_g_n",
            "ypc_trail3": "ypc_n",
            "att_trail3": "att_n",
            "tgt_trail3": "targets_n",
            "rec_trail3": "rec_per_g_n",
        }
        for f in sig_feats:
            if f in collisions and collisions[f] in base_for_sink:
                base_for_sink.remove(collisions[f])
        sink = base_for_sink + sig_feats
        fit_sink, n_s = fit_ols(universe, sink)
        if fit_sink and fit_base:
            print(f"  n={n_s}, R² = {fit_sink['r2']:.4f}, k={fit_sink['k']}")
            print(f"  ΔR² vs BASELINE = {fit_sink['r2']-fit_base['r2']:+.4f}")
            df_resid = fit_sink["n"] - fit_sink["k"]
            sigma2 = fit_sink["rss"] / df_resid
            ses = np.sqrt(np.maximum(0.0, sigma2 * np.diag(fit_sink["XtX_inv"])))
            names = ["(intercept)"] + sink
            print(f"  {'feature':<26} {'coef':>10} {'se':>9} {'t':>7} {'p':>9}")
            print(f"  {'-'*26} {'-'*10} {'-'*9} {'-'*7} {'-'*9}")
            for i, fn in enumerate(names):
                t = fit_sink["beta"][i] / ses[i] if ses[i] > 0 else 0
                p = 2 * (1 - stats.t.cdf(abs(t), df_resid))
                sig = "***" if p < 0.001 else "**" if p < 0.01 else "*" if p < 0.05 else " "
                print(f"  {fn:<26} {fit_sink['beta'][i]:>+10.4f} "
                      f"{ses[i]:>9.4f} {t:>+7.2f} {p:>8.4f}{sig}")
    else:
        print("  No features passed marginal-R² test — baseline is well-specified.")


if __name__ == "__main__":
    main()
