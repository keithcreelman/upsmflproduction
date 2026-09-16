#!/usr/bin/env python3
"""Tier-1 empirical persistence study -- no projection archive needed.

    python pipelines/etl/wire/persistence_study.py --cache-dir /tmp/persistence_cache
    python pipelines/etl/wire/persistence_study.py --cache-dir /tmp/persistence_cache --out site/wire/data/persistence_study.json

WHY THIS EXISTS
    Keith 2026-09-15 (Phase 2 forecast brief): does a hot Week 1 deserve as
    much season-long weight as season_sim.py's live update currently gives
    it? The honest way to check that exact question needs archived
    point-in-time weekly projections, and those do not exist before
    2026-09-15 -- MFL never stores projection history (see
    scripts/ingest_projections.py), and season_sim.py's own backtest already
    proved that asking MFL for a past week's projection today returns
    hindsight, not what was on screen that week (see
    project_wire_season_sim_backtest memory: "weekly" mode pushes k toward
    1.0, rank corr .72 -- contaminated by news the model could not have had).

    This is the test that IS possible today: pure historical RAW SCORES, no
    projections at all, as far back as MFL will still serve this league
    (2015 -- 2011-2014 and 2016 return no league data from the API; see
    SEASONS below).

WHAT IT MEASURES, AND WHAT IT DOES NOT
    For each team-season, split the regular season into an "early" window
    (weeks 1..W) and a "remaining" window (the rest). Season-demean both
    windows (subtract that season's across-team average for exactly those
    weeks, so a scoring-rule or roster-era shift between years cannot leak
    into the comparison), then pool every team-season and regress the
    remaining-window deviation on the early-window deviation. The OLS slope
    is the textbook reliability/shrinkage coefficient from classical test
    theory: how much of an early deviation survives into the rest of the
    season, purely empirically, no Bayesian model assumptions.

    This is a DIFFERENT and necessarily CRUDER quantity than what
    season_sim.py's live update actually reweights. That model updates on a
    team's deviation FROM ITS OWN PROJECTION (a "surprise"); this script can
    only regress raw score on raw score, because no historical point-in-time
    projection exists to net out. Raw-score persistence mixes in "this team
    drafted well and was always going to score high" -- something the
    preseason projection already knew in September, not new week-1
    information -- on top of genuine in-season surprise. It should read as an
    UPPER BOUND on how much of an early outlier is real signal, not a direct
    measurement of the live model's own reweighting question. Read the
    comparison to season_sim's derived n* with that limitation in mind, not
    as a verdict.
"""

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import season_sim as SS

# Seasons this league's MFL API will actually serve. Probed 2026-09-15:
# 2011-2014 and 2016 return no `league` payload at all (pre-API-era or a gap
# in MFL's own archive for this league) -- excluded rather than guessed.
SEASONS = (2015, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025)
SPLITS = (1, 2, 3, 4)


def team_season_scores(season, cache_dir):
    """{fid: [score_wk1, score_wk2, ...]} for the regular season, plus reg_end."""
    league = SS.fetch(SS.MFL % (season, "league", ""), cache_dir)["league"]
    reg_end = int(league.get("lastRegularSeasonWeek") or 0)
    if reg_end < max(SPLITS) + 2:
        raise SystemExit("persistence_study: %d reg_end=%d too short to use" % (season, reg_end))
    by_week = SS.actual_scores_by_week(season, reg_end, cache_dir)
    fids = sorted(by_week[1])
    return {f: [by_week[wk][f] for wk in range(1, reg_end + 1)] for f in fids}, reg_end


def ols(pairs):
    """Simple OLS y ~ a + b*x. Returns (slope, intercept, r, se_slope, n)."""
    n = len(pairs)
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    sxx = sum((x - mx) ** 2 for x, _ in pairs)
    syy = sum((y - my) ** 2 for _, y in pairs)
    sxy = sum((x - mx) * (y - my) for x, y in pairs)
    slope = sxy / sxx if sxx else 0.0
    intercept = my - slope * mx
    r = sxy / math.sqrt(sxx * syy) if sxx and syy else 0.0
    sse = sum((y - (intercept + slope * x)) ** 2 for x, y in pairs)
    s2 = sse / (n - 2) if n > 2 else 0.0
    se_slope = math.sqrt(s2 / sxx) if sxx else 0.0
    return slope, intercept, r, se_slope, n


def model_weight(n_weeks, n_star):
    return n_weeks / (n_weeks + n_star)


def run(cache_dir):
    per_season = []
    pairs_by_w = {w: [] for w in SPLITS}
    for season in SEASONS:
        scores, reg_end = team_season_scores(season, cache_dir)
        for w in SPLITS:
            if w + 2 > reg_end:
                continue
            early = {f: sum(s[:w]) / w for f, s in scores.items()}
            remaining = {f: sum(s[w:]) / (reg_end - w) for f, s in scores.items()}
            mu_e = sum(early.values()) / len(early)
            mu_r = sum(remaining.values()) / len(remaining)
            for f in scores:
                pairs_by_w[w].append((early[f] - mu_e, remaining[f] - mu_r))
        per_season.append({"season": season, "regEnd": reg_end, "teams": len(scores)})
        print("  %d: reg_end=%d, %d teams" % (season, reg_end, len(scores)))

    results = []
    for w in SPLITS:
        pairs = pairs_by_w[w]
        if len(pairs) < 10:
            continue
        slope, intercept, r, se, n = ols(pairs)
        results.append({
            "earlyWeeks": w, "teamSeasons": n,
            "empiricalSlope": round(slope, 4), "slopeSe": round(se, 4),
            "ci95": [round(slope - 1.96 * se, 4), round(slope + 1.96 * se, 4)],
            "pearsonR": round(r, 4), "intercept": round(intercept, 3),
        })
    return {"seasonsUsed": per_season, "splits": results}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache-dir", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--n-star", type=float, default=None,
                    help="season_sim's n* (sigma_w^2/sigma_s^2) to compare the empirical slope "
                         "against -- read from a live snapshot's model block if omitted")
    a = ap.parse_args()

    n_star = a.n_star
    if n_star is None:
        # Best-effort: pull the most recent live snapshot's calibration so the
        # comparison uses a real, cited number instead of a hardcoded guess.
        default_live = "site/wire/data/season_sim_2026_live_wk01.json"
        if os.path.exists(default_live):
            m = json.load(open(default_live, encoding="utf-8"))["model"]
            n_star = (m["sigmaWeekly"] ** 2) / (m["sigmaSeason"] ** 2)

    print("fetching real weekly scores, %d seasons..." % len(SEASONS))
    out = run(a.cache_dir)
    out["generatedAtUtc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    out["nStarReference"] = round(n_star, 3) if n_star is not None else None
    out["nStarSource"] = "site/wire/data/season_sim_2026_live_wk01.json (model block)" if a.n_star is None else "--n-star"

    print("\nearly-weeks  team-seasons  empirical slope (95%% CI)      model w(n) @ n*=%s" %
          (round(n_star, 2) if n_star is not None else "?"))
    for r in out["splits"]:
        mw = model_weight(r["earlyWeeks"], n_star) if n_star else None
        print("     %d           %4d       %6.3f  [%6.3f, %6.3f]         %s" % (
            r["earlyWeeks"], r["teamSeasons"], r["empiricalSlope"], r["ci95"][0], r["ci95"][1],
            ("%.3f" % mw) if mw is not None else "n/a"))

    if a.out:
        os.makedirs(os.path.dirname(a.out), exist_ok=True) if os.path.dirname(a.out) else None
        open(a.out, "w", encoding="utf-8").write(json.dumps(out, indent=1) + "\n")
        print("\nwrote %s" % a.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
