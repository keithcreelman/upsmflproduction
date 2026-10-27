#!/usr/bin/env python3
"""Leakage-free backtest of the future-pick model, and the in-season coefficients it uses.

A future pick's slot is set by its original franchise's final finish (canon
§A1). For every team-season 2013-2025 this predicts the pick using only what
was known before: seasons before it for owner history, earlier seasons for
any tuning or fitting, and weeks already played for the in-season blend. The
score is the error in the football value of the slot actually earned, so a
model is rewarded for the value it would have put into a grade.

Reported:
  1. by horizon: picks decided 1, 2 and 3 seasons ahead (k = 4, then 6)
  2. by season, with a season-bootstrap interval for the improvement over x.06
  3. in season, by completed week: owner history alone vs the blend
  4. calibration of the bracket odds and of the likely / leans / toss-up labels

Offline: reads tests/fixtures/final_finish_history_2010_2025.json (finishes from
the bracket games, canon §D.2 tenure) and tests/fixtures/weekly_allplay_2010_2025.json.
Values use the curve the grader runs with today (500 * exp(-0.03 * pick)).

  python3 pipelines/etl/scripts/backtest_pick_slot_model.py
  python3 pipelines/etl/scripts/backtest_pick_slot_model.py --write-config   # refit 2011-2025
"""
import argparse
import json
import math
import random
import statistics
import sys
from collections import Counter
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import pick_valuation as pv  # noqa: E402

FINISHES = REPO / "tests" / "fixtures" / "final_finish_history_2010_2025.json"
WEEKLY = REPO / "tests" / "fixtures" / "weekly_allplay_2010_2025.json"
FIRST_TARGET = 2013
LAST_TARGET = 2025
FIRST_TRAIN = 2011          # 2010 used a different bracket under different franchise ids
RIDGE = 1.0
MAX_WEEK = 14


# ── data ───────────────────────────────────────────────────────────────────

def load_finishes(path=FINISHES):
    data = json.loads(Path(path).read_text())
    finish = {(fid, int(s)): f for s, m in data["finishes"].items() for fid, f in m.items()}
    tenure = {o: [(f, int(s)) for f, s in pairs] for o, pairs in data["owner_tenure"].items()}
    return finish, tenure


def load_weekly(path=WEEKLY):
    data = json.loads(Path(path).read_text())
    reg_end = {int(s): w for s, w in data["regular_season_weeks"].items()}
    weeks = {(int(s), fid): rows for s, by in data["weeks"].items() for fid, rows in by.items()}
    return weeks, reg_end


def standings_through(weeks: dict, season: int, cutoff_week: int) -> tuple[dict, dict]:
    """All-Play % and points for through `cutoff_week`. Rows after the cutoff
    are never read, so a later week cannot leak into an earlier projection."""
    ap, pf = {}, {}
    for (s, fid), rows in weeks.items():
        if s != season:
            continue
        w_ = g_ = p_ = 0.0
        for week, apw, apg, pts in rows:
            if week > cutoff_week:
                continue
            w_, g_, p_ = w_ + apw, g_ + apg, p_ + pts
        ap[fid] = w_ / g_ if g_ else 0.5
        pf[fid] = p_
    return ap, pf


def use_live_curve():
    pv._CURVE_A, pv._CURVE_B, pv._DOLLARS_PER_POINT = 500.0, 0.03, 60.0


def r1_value(slot: int) -> float:
    return pv.pick_expected_points(0, 1, slot=slot)


def ev(dist: dict) -> float:
    return sum(p * r1_value(s) for s, p in dist.items())


# ── the production model, fed history as it stood ─────────────────────────

def production_projection(fid, hist, seasons_ahead, season_state=None, k_override=None):
    """pick_valuation.project_future_pick with a career file holding only `hist`."""
    current = 3000
    saved, saved_k = pv._CAREER_CACHE, (pv.PRIOR_SEASONS_NEXT, pv.PRIOR_SEASONS_LATER)
    try:
        pv._CAREER_CACHE = {fid: {"current_year": current, "owner": {
            "display": "", "seasons_by_franchise": {},
            "seasons_count": len(hist), "playoff_appearances": sum(1 for f in hist if f <= 6)}}}
        if k_override is not None:
            pv.PRIOR_SEASONS_NEXT = pv.PRIOR_SEASONS_LATER = k_override
        state = season_state or pv.SeasonState(current, "offseason")
        return pv.project_future_pick(fid, current + 1 + seasons_ahead, 1, state)
    finally:
        pv._CAREER_CACHE = saved
        pv.PRIOR_SEASONS_NEXT, pv.PRIOR_SEASONS_LATER = saved_k


def targets(finish, lag: int, owner_tenure=None):
    """(season T, fid, history known `lag` seasons before T, actual slot)."""
    seasons = sorted({s for _, s in finish})
    rows = []
    if owner_tenure is None:
        for fid in sorted({f for f, _ in finish}):
            for t in range(FIRST_TARGET + lag - 1, LAST_TARGET + 1):
                hist = [finish[(fid, s)] for s in seasons if s <= t - lag]
                rows.append((t, fid, hist, pv.slot_for_finish(finish[(fid, t)])))
    else:
        for pairs in owner_tenure.values():
            pairs = sorted(pairs, key=lambda p: p[1])
            for fid, t in pairs:
                hist = [finish[p] for p in pairs if p[1] <= t - lag]
                if len(hist) >= 2 and t >= FIRST_TARGET:
                    rows.append((t, fid, hist, pv.slot_for_finish(finish[(fid, t)])))
    return rows


def offseason_models(lag: int):
    k_rule = pv.PRIOR_SEASONS_NEXT if lag == 1 else pv.PRIOR_SEASONS_LATER

    def mean(h):
        return sum(h) / len(h) if h else 6.5
    return {
        "x.06 (live today)": lambda t, fid, h: {6: 1.0},
        "uniform 1.01-1.12": lambda t, fid, h: {s: 1 / 12 for s in range(1, 13)},
        "round(13 - avg finish) (old code)":
            lambda t, fid, h: {max(1, min(12, round(13 - mean(h)))): 1.0},
        "canon slot of avg finish (naive)":
            lambda t, fid, h: {pv.slot_for_finish(max(1, min(12, round(mean(h))))): 1.0},
        f"bracket odds, k={k_rule} (ruling)":
            lambda t, fid, h: production_projection(fid, h, lag - 1).dist,
    }


def rmse(errs):
    return math.sqrt(sum(e * e for e in errs) / len(errs)) if errs else float("nan")


def score(rows, model):
    errs, ll = [], 0.0
    for t, fid, h, actual in rows:
        dist = model(t, fid, h)
        errs.append(ev(dist) - r1_value(actual))
        ll -= math.log(max(dist.get(actual, 0.0), 1e-3))
    return errs, ll / len(rows)


def rolling_k_model(all_rows, grid=(0, 2, 4, 6, 8, 12, 20)):
    """k tuned each season on earlier target seasons only."""
    cache = {}

    def k_for(t):
        if t not in cache:
            past = [r for r in all_rows if r[0] < t]
            if len(past) < 24:
                cache[t] = 4
            else:
                cache[t] = min(grid, key=lambda k: rmse(score(
                    past, lambda t_, f_, h_, k=k: production_projection(f_, h_, 0, k_override=k).dist)[0]))
        return cache[t]
    return (lambda t, fid, h: production_projection(fid, h, 0, k_override=k_for(t)).dist), cache


# ── in season ──────────────────────────────────────────────────────────────

def _sig(x):
    return 1 / (1 + math.exp(-max(-35.0, min(35.0, x))))


def fit_logistic(X, y, l2=RIDGE, iters=100):
    k = len(X[0]); b = [0.0] * k
    for _ in range(iters):
        g = [0.0] * k; H = [[0.0] * k for _ in range(k)]
        for xi, yi in zip(X, y):
            p = _sig(sum(bj * xj for bj, xj in zip(b, xi)))
            for j in range(k):
                g[j] += (yi - p) * xi[j]
                for m in range(k):
                    H[j][m] -= p * (1 - p) * xi[j] * xi[m]
        for j in range(1, k):
            g[j] -= l2 * b[j]; H[j][j] -= l2
        A = [row[:] + [-gj] for row, gj in zip(H, g)]
        for c in range(k):
            piv = max(range(c, k), key=lambda r: abs(A[r][c])); A[c], A[piv] = A[piv], A[c]
            for r in range(k):
                if r != c and A[c][c]:
                    f = A[r][c] / A[c][c]
                    for cc in range(c, k + 1):
                        A[r][cc] -= f * A[c][cc]
        d = [A[i][k] / A[i][i] if A[i][i] else 0.0 for i in range(k)]
        m = max(abs(x) for x in d)
        if m > 1.0:
            d = [x / m for x in d]
        b = [bj + dj for bj, dj in zip(b, d)]
        if m < 1e-9:
            break
    return b


def franchise_prior(finish, fid, season):
    hist = [finish[(fid, s)] for s in range(2010, season) if (fid, s) in finish]
    return (sum(1 for f in hist if f <= 6) + pv.PRIOR_SEASONS_NEXT / 2) / (len(hist) + pv.PRIOR_SEASONS_NEXT)


def feature_rows(finish, weeks, reg_end, season, week):
    w = min(week, reg_end[season])
    ap, pf = standings_through(weeks, season, w)
    za, zp = pv._zscores(ap), pv._zscores(pf)
    fids = sorted(ap)
    return [(fid, [1.0, pv._logit(franchise_prior(finish, fid, season)), za[fid], zp[fid]],
             1 if finish[(fid, season)] <= 6 else 0) for fid in fids]


def fit_coefficients(finish, weeks, reg_end, train_seasons, fit_weeks=None):
    table = {}
    for week in (fit_weeks or range(1, MAX_WEEK + 1)):
        X, y = [], []
        for s in train_seasons:
            for _fid, x, yy in feature_rows(finish, weeks, reg_end, s, week):
                X.append(x); y.append(yy)
        table[str(week)] = [round(v, 6) for v in fit_logistic(X, y)]
    return table


def inseason_backtest(finish, weeks, reg_end, week_list=(1, 2, 4, 6, 8, 10, 12, 14)):
    """For each target season, coefficients fitted on earlier seasons only."""
    out = {}
    needed = sorted({min(w, reg_end[t]) for w in week_list for t in range(FIRST_TARGET, LAST_TARGET + 1)})
    tables = {t: fit_coefficients(finish, weeks, reg_end, range(FIRST_TRAIN, t), needed)
              for t in range(FIRST_TARGET, LAST_TARGET + 1)}
    saved = pv._COEFFICIENTS
    preds = {}
    try:
        for week in week_list:
            e_owner, e_blend, pr = [], [], []
            for t in range(FIRST_TARGET, LAST_TARGET + 1):
                pv._COEFFICIENTS = {"weeks": tables[t]}
                w = min(week, reg_end[t])
                ap, pf = standings_through(weeks, t, w)
                for fid in sorted(ap):
                    rate = franchise_prior(finish, fid, t)
                    p = pv.inseason_playoff_probability(rate, fid, ap, pf, w)
                    actual = pv.slot_for_finish(finish[(fid, t)])
                    e_owner.append(ev(pv.bracket_distribution(rate)) - r1_value(actual))
                    e_blend.append(ev(pv.bracket_distribution(p)) - r1_value(actual))
                    pr.append((p, 1 if finish[(fid, t)] <= 6 else 0))
            out[week] = (rmse(e_owner), rmse(e_blend))
            preds[week] = pr
    finally:
        pv._COEFFICIENTS = saved
    return out, preds


def calibration(preds):
    bins = [(0, .2), (.2, .4), (.4, .6), (.6, .8), (.8, 1.01)]
    rows = []
    for lo, hi in bins:
        g = [(p, y) for p, y in preds if lo <= p < hi]
        if g:
            rows.append((lo, hi, len(g), sum(p for p, _ in g) / len(g), sum(y for _, y in g) / len(g)))
    return rows


def label_calibration(preds):
    """How often the side a label points to actually happened."""
    out = {}
    for p, y in preds:
        lead = max(p, 1 - p)
        label = "likely" if lead >= pv.LIKELY_AT else "leans" if lead >= pv.LEANS_AT else "toss-up"
        hit = (y == 1) if p >= 0.5 else (y == 0)
        n, h = out.get(label, (0, 0))
        out[label] = (n + 1, h + hit)
    return out


# ── report ─────────────────────────────────────────────────────────────────

def run(verbose=True):
    use_live_curve()
    finish, tenure = load_finishes()
    weeks, reg_end = load_weekly()
    res = {"horizon": {}, "by_season": {}, "owner_set": {}}
    say = print if verbose else (lambda *a, **k: None)

    for lag in (1, 2, 3):
        rows = targets(finish, lag)
        say(f"\n{lag}-season-ahead picks ({len(rows)} team-seasons, history through T-{lag}):")
        say(f"  {'model':<40} {'RMSE':>7} {'vs x.06':>8} {'logloss':>8}")
        base = None
        res["horizon"][lag] = {}
        models = offseason_models(lag)
        if lag == 1:
            roll, ks = rolling_k_model(rows)
            models["bracket odds, k tuned on earlier seasons"] = roll
        for name, m in models.items():
            errs, ll = score(rows, m)
            r = rmse(errs)
            base = r if base is None else base
            res["horizon"][lag][name] = {"rmse": r, "logloss": ll}
            say(f"  {name:<40} {r:7.2f} {100 * (r - base) / base:+7.1f}% {ll:8.3f}")
        if lag == 1:
            say(f"  (rolling k by season: {dict(sorted(ks.items()))})")

    rows = targets(finish, 1)
    models = offseason_models(1)
    rule = "bracket odds, k=4 (ruling)"
    say("\nBy season, next-season picks (RMSE; lower is better):")
    wins = 0
    per = {}
    for t in range(FIRST_TARGET, LAST_TARGET + 1):
        sub = [r for r in rows if r[0] == t]
        a = rmse(score(sub, models["x.06 (live today)"])[0])
        b = rmse(score(sub, models[rule])[0])
        per[t] = (a, b)
        wins += b < a
        say(f"  {t}: x.06 {a:6.2f}   bracket {b:6.2f}   {'better' if b < a else 'worse'}")
    random.seed(7)
    diffs = []
    ts = list(per)
    for _ in range(4000):
        samp = [random.choice(ts) for _ in ts]
        ra = math.sqrt(statistics.mean(per[t][0] ** 2 for t in samp))
        rb = math.sqrt(statistics.mean(per[t][1] ** 2 for t in samp))
        diffs.append(100 * (rb - ra) / ra)
    diffs.sort()
    ci = (diffs[int(0.05 * len(diffs))], diffs[len(diffs) // 2], diffs[int(0.95 * len(diffs))])
    res["by_season"] = {"wins": wins, "seasons": len(per), "ci90": ci, "per": per}
    say(f"  bracket beats x.06 in {wins}/{len(per)} seasons; "
        f"season bootstrap change {ci[1]:+.1f}% (90% interval {ci[0]:+.1f}% to {ci[2]:+.1f}%)")

    own = targets(finish, 1, tenure)
    a = rmse(score(own, models["x.06 (live today)"])[0])
    b = rmse(score(own, models[rule])[0])
    res["owner_set"] = {"n": len(own), "x06": a, "bracket": b}
    say(f"\nCurrent owners' own tenures (canon §D.2), {len(own)} seasons: x.06 {a:.2f} vs bracket {b:.2f}")

    ins, preds = inseason_backtest(finish, weeks, reg_end)
    res["in_season"] = ins
    say("\nIn season (coefficients fitted on earlier seasons only), next-season picks:")
    say(f"  {'after week':>10} {'owner only':>11} {'blend':>7} {'change':>8}")
    for w, (o, bl) in ins.items():
        say(f"  {w:>10} {o:>11.2f} {bl:>7.2f} {100 * (bl - o) / o:>+7.1f}%")

    off_preds = []
    for t, fid, h, actual in rows:
        off_preds.append((production_projection(fid, h, 0).p_playoff, 1 if actual >= 7 else 0))
    res["calibration"] = {"offseason": calibration(off_preds)}
    res["labels"] = {"offseason": label_calibration(off_preds)}
    for w in (4, 8, 14):
        res["calibration"][f"week {w}"] = calibration(preds[w])
        res["labels"][f"week {w}"] = label_calibration(preds[w])
    say("\nCalibration (predicted vs actual playoff rate) and labels (how often the named side happened):")
    for key in res["calibration"]:
        cal = "  ".join(f"[{lo:.1f},{hi:.1f}) n={n} {pr:.2f}->{ob:.2f}" for lo, hi, n, pr, ob in res["calibration"][key])
        lab = "  ".join(f"{lab} {h}/{n}={h / n:.0%}" for lab, (n, h) in sorted(res["labels"][key].items()))
        say(f"  {key:>9}: {cal}")
        say(f"  {'':>9}  {lab}")
    return res


def write_config():
    finish, _ = load_finishes()
    weeks, reg_end = load_weekly()
    table = fit_coefficients(finish, weeks, reg_end, range(FIRST_TRAIN, LAST_TARGET + 1))
    out = {
        "_about": ("Logistic coefficients for the in-season future-pick blend, by completed regular-season week "
                   "(a later week uses the last one). P(championship bracket) = sigmoid(b0 + b_prior * logit(owner "
                   "playoff rate, k=4) + b_ap * z(All-Play %) + b_pf * z(points for)), z-scored across the league. "
                   f"Fitted on seasons {FIRST_TRAIN}-{LAST_TARGET} (finishes from the bracket games), ridge {RIDGE}, "
                   "by pipelines/etl/scripts/backtest_pick_slot_model.py --write-config. Valid for seasons after "
                   f"{LAST_TARGET}: never fitted on the season it scores."),
        "fitted_seasons": [FIRST_TRAIN, LAST_TARGET],
        "fitted_on": date.today().isoformat(),
        "terms": ["b0", "b_prior", "b_allplay", "b_points_for"],
        "weeks": table,
    }
    pv.INSEASON_COEFFICIENTS.parent.mkdir(parents=True, exist_ok=True)
    pv.INSEASON_COEFFICIENTS.write_text(json.dumps(out, indent=1) + "\n")
    print(f"wrote {pv.INSEASON_COEFFICIENTS}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--write-config", action="store_true")
    args = ap.parse_args()
    if args.write_config:
        write_config()
    else:
        run()
