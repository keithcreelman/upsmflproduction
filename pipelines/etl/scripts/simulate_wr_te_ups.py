#!/usr/bin/env python3
"""COMPONENT SIMULATION — Models A + B + C, the interpretable CHAMPION.

Spec §8. Where the GBM challenger (train_wr_te_pilot.py) learns a direct mapping
from features to quantiles, this decomposes the problem the way the game works:

    Model A  opportunity   how many routes will he run, and how many targets
    Model B  efficiency    at what rates does he convert them
    Model C  simulation    draw both many times, score each draw with the EXACT
                           UPS rules, read the quantiles off the result

WHY BOTHER, GIVEN THE CHALLENGER EXISTS
---------------------------------------
Three things the direct model cannot do:

  1. EXPLAIN. "P90 is high because his route share is up while his TD rate is
     unchanged" is a sentence this produces natively. SHAP on a GBM is not the
     same claim.
  2. SCORE UPS EXACTLY. TE receptions pay 1.5 from 2025 and 1.0 before; yardage
     carries tier bonuses at 100/150/200; a 50+ yard TD pays 7 not 6. The
     simulation applies the real rule to every draw rather than learning an
     approximation of it.
  3. PUT RARE EVENTS IN THE TAIL, NOT THE MIDDLE. A touchdown is a Bernoulli
     draw here, so it moves P90 far more than P50 — what the spec asks for, and
     what a pinball-loss regressor will not do on its own.

MODEL A'S TARGET IS ACTUAL NEXT-WEEK ROUTES
-------------------------------------------
Not a feature-derived proxy. Training on `routes_l3 / 3` would be circular — a
model predicting a number already sitting in its own input. The target is the
routes he really ran in week W, read from nfl_player_routes_weekly at training
time, exactly as realized UPS points are the target for the direct model.

EMPIRICAL-BAYES SHRINKAGE (Model B)
-----------------------------------
A 40-route player with a gaudy YPRR is not a 500-route player with the same
number. Each rate is shrunk toward its position prior:

    r_hat = (successes + k * prior_mean) / (trials + k)

k is estimated per metric by method of moments from between-player variance.
Larger k = slower to believe the individual, which reproduces the spec's
ordering: role updates fast, catch/first-down rates moderately, yards per
reception slowly, TOUCHDOWN RATE SLOWEST.

Usage:
  python3 pipelines/etl/scripts/simulate_wr_te_ups.py --train 2021-2024 --test 2025
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.asof import AsOfContext  # noqa: E402
import train_wr_te_pilot as P  # noqa: E402

RNG = np.random.default_rng(0)

# P(a receiving TD travelled 50+ yards) -> pays 7 instead of 6. Measured from
# PBP, not assumed: 38 of 811 passing TDs in 2025 REG were 50+.
LONG_TD_P = 38.0 / 811.0


def rec_points(season: int, pos: str) -> float:
    """UPS reception value, ERA-CORRECT.

    Verified against mfl_scoring_rules: TE receptions became 1.5 in 2025 and
    were 1.0 in every prior season; WR is 1.0 throughout. Hardcoding 1.5 would
    silently mis-score every pre-2025 TE row.
    """
    return 1.5 if (pos == "TE" and season >= 2025) else 1.0


def yard_bonus(y):
    """CY tier bonuses: 100-149 +2, 150-199 +3, 200+ +5."""
    return np.where(y >= 200, 5.0, np.where(y >= 150, 3.0, np.where(y >= 100, 2.0, 0.0)))


def eb_k(rates, trials, prior_mean, floor=1.0, cap=800.0):
    """Method-of-moments shrinkage constant for a Beta-Binomial."""
    m = trials >= 5
    if m.sum() < 20:
        return 60.0
    var = float(np.var(rates[m]))
    if var <= 1e-9:
        return cap
    return float(np.clip(prior_mean * (1 - prior_mean) / var - 1.0, floor, cap))


def shrink(succ, trials, prior_mean, k):
    return (float(succ or 0) + k * prior_mean) / (float(trials or 0) + k)


def load_rows(season: int, weeks, positions):
    """Feature rows + the two things this script needs that the pilot loader
    does not return: gsis_id (to join history) and ACTUAL routes in week W
    (Model A's training target).

    Reading week W's actual routes/score here is the TARGET on a completed
    season — supervised learning, not leakage. The feature row itself was built
    under the as-of guard and cannot see either.
    """
    ctx = AsOfContext(season=season, week=1)
    poslist = ",".join("'" + p + "'" for p in positions)
    X, y, meta = [], [], []
    for wk in weeks:
        rows = ctx.run(
            "SELECT f.*, s.score AS target, r.routes AS actual_routes"
            " FROM model_player_week_features f"
            " JOIN ff_player_ids p ON p.gsis_id = f.gsis_id"
            " JOIN src_weekly s ON s.player_id = CAST(p.mfl_id AS INTEGER)"
            f"  AND s.season = {season} AND s.week = {wk}"
            " LEFT JOIN nfl_player_routes_weekly r ON r.gsis_id = f.gsis_id"
            f"  AND r.season = {season} AND r.week = {wk}"
            f" WHERE f.season = {season} AND f.week = {wk}"
            f"   AND f.mfl_pos IN ({poslist}) AND f.routes_std > 0"
            "    AND s.score IS NOT NULL")
        for r in rows:
            X.append([P.encode(c, r.get(c)) for c in P.FEATURES])
            y.append(float(r["target"]))
            meta.append({
                "gsis": r["gsis_id"], "week": wk, "pos": r.get("mfl_pos"),
                "name": r.get("player_name"), "base": r.get("ups_ppg_std"),
                "actual_routes": r.get("actual_routes"),
            })
        print(f"  {season} W{wk}: {len(rows)}", file=sys.stderr, flush=True)
    return np.array(X, dtype=float), np.array(y, dtype=float), meta


def load_history(season: int, week: int, positions):
    """As-of receiving history per gsis: rec / tgt / yds / TD / FD.

    The feature store carries rates, but Model B needs raw numerator and
    denominator to shrink correctly. Pulled through the as-of guard, so it obeys
    the same week < W contract as everything else.
    """
    ctx = AsOfContext(season=season, week=week)
    poslist = ",".join("'" + p + "'" for p in positions)
    return {r["gsis"]: r for r in ctx.run(ctx.select(
        "nfl_player_weekly",
        "n.gsis_id gsis, SUM(n.receptions) rec, SUM(n.targets) tgt,"
        " SUM(n.rec_yds) yds, SUM(n.rec_tds) td,"
        " SUM(COALESCE(x.rec_first_downs,0)) fd",
        alias="n",
        join="LEFT JOIN nfl_player_weekly_ext x ON x.gsis_id = n.gsis_id"
             " AND x.season = n.season AND x.week = n.week",
        join_tables=("nfl_player_weekly_ext",),
        where=f"n.season = {season} AND n.position IN ({poslist})",
        group_by="n.gsis_id"))}


def simulate(routes_hat, sigma, tprr, catch, ypr, tdpt, fdpr, cc, n):
    """Model C — one player-week, n draws, exact UPS receiving score."""
    routes = np.maximum(0, RNG.normal(routes_hat, sigma, n)).round().astype(int)
    targets = RNG.binomial(routes, np.clip(tprr, 1e-6, 0.999))
    rec = RNG.binomial(targets, np.clip(catch, 1e-6, 0.999))

    # Per-reception gamma draws summed: keeps yardage positive and right-skewed
    # (the occasional long catch), which a normal would not.
    shape = 1.6
    scale = max(ypr, 0.1) / shape
    tot = int(rec.sum())
    yards = np.zeros(n)
    if tot:
        np.add.at(yards, np.repeat(np.arange(n), rec), RNG.gamma(shape, scale, tot))

    tds = RNG.binomial(targets, np.clip(tdpt, 1e-9, 0.5))
    long_td = RNG.binomial(tds, LONG_TD_P)      # 50+ yard TD pays 7 not 6
    fds = RNG.binomial(rec, np.clip(fdpr, 1e-6, 0.999))

    return (rec * cc + yards * 0.1 + yard_bonus(yards)
            + tds * 6.0 + long_td * 1.0 + fds * 0.2)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="2021-2024")
    ap.add_argument("--test", type=int, default=2025)
    ap.add_argument("--positions", default="WR,TE")
    ap.add_argument("--sims", type=int, default=2000)
    args = ap.parse_args()

    from sklearn.ensemble import HistGradientBoostingRegressor

    pos = tuple(x.strip() for x in args.positions.split(",") if x.strip())
    tr_seasons = P._parse_seasons(args.train)
    if any(s >= args.test for s in tr_seasons):
        sys.exit(f"WALK-FORWARD VIOLATION: train {tr_seasons} must precede {args.test}")
    weeks = range(5, 18)

    Xtr_l, ytr_l, mtr_l = [], [], []
    for s in tr_seasons:
        a, b, c = load_rows(s, weeks, pos)
        if len(a):
            Xtr_l.append(a); ytr_l.append(b); mtr_l += c
    Xtr = np.vstack(Xtr_l); ytr = np.concatenate(ytr_l)
    Xte, yte, mte = load_rows(args.test, weeks, pos)

    # ── Model A: expected routes next week, trained on ACTUAL next-week routes
    a_y = np.array([m["actual_routes"] if m["actual_routes"] is not None else np.nan
                    for m in mtr_l], dtype=float)
    fit = np.isfinite(a_y)
    a_model = HistGradientBoostingRegressor(
        max_iter=250, learning_rate=0.06, max_depth=6,
        min_samples_leaf=40, random_state=0)
    a_model.fit(Xtr[fit], a_y[fit])
    routes_hat = np.maximum(0.0, a_model.predict(Xte))
    resid = a_y[fit] - a_model.predict(Xtr[fit])
    sd = float(np.std(resid))
    a_te = np.array([m["actual_routes"] if m["actual_routes"] is not None else np.nan
                     for m in mte], dtype=float)
    ok_a = np.isfinite(a_te)
    print(f"\nModel A  expected routes/week — train n={int(fit.sum())}, "
          f"residual sd {sd:.2f}, out-of-sample MAE "
          f"{np.mean(np.abs(a_te[ok_a]-routes_hat[ok_a])):.2f} routes")

    # ── Model B: priors + shrinkage constants, from TRAIN SEASONS ONLY ─────
    H = []
    for s in tr_seasons:
        for wk in weeks:
            H += list(load_history(s, wk, pos).values())
    T = np.array([[float(r.get(c) or 0) for c in ("rec", "tgt", "yds", "td", "fd")]
                  for r in H]) if H else np.zeros((0, 5))
    if not len(T):
        sys.exit("no training history")
    rec_, tgt_, yds_, td_, fd_ = T.T

    p_catch = float(np.sum(rec_) / max(np.sum(tgt_), 1))
    p_ypr = float(np.sum(yds_) / max(np.sum(rec_), 1))
    p_tdpt = float(np.sum(td_) / max(np.sum(tgt_), 1))
    p_fdpr = float(np.sum(fd_) / max(np.sum(rec_), 1))
    with np.errstate(divide="ignore", invalid="ignore"):
        k_catch = eb_k(np.nan_to_num(rec_ / np.maximum(tgt_, 1)), tgt_, p_catch)
        k_tdpt = eb_k(np.nan_to_num(td_ / np.maximum(tgt_, 1)), tgt_, p_tdpt)
        k_fdpr = eb_k(np.nan_to_num(fd_ / np.maximum(rec_, 1)), rec_, p_fdpr)
    k_ypr = 12.0

    print(f"Model B  catch {p_catch:.3f} (k={k_catch:.0f}) | ypr {p_ypr:.2f} "
          f"(k={k_ypr:.0f}) | td/tgt {p_tdpt:.4f} (k={k_tdpt:.0f}) | "
          f"fd/rec {p_fdpr:.3f} (k={k_fdpr:.0f})")
    print("         larger k = slower to trust the individual; TD rate is the "
          "slowest, as the spec requires")

    # ── Model C ────────────────────────────────────────────────────────────
    hist_te = {wk: load_history(args.test, wk, pos) for wk in weeks}
    ti = P.FEATURES.index("tprr_std")
    n = len(Xte)
    p50 = np.zeros(n); p75 = np.zeros(n); p90 = np.zeros(n)
    matched = 0
    for i, m in enumerate(mte):
        h = hist_te.get(m["week"], {}).get(m["gsis"])
        matched += bool(h)
        tp = Xte[i, ti]
        tprr = float(tp) if np.isfinite(tp) and tp > 0 else 0.20
        if h:
            catch = shrink(h.get("rec"), h.get("tgt"), p_catch, k_catch)
            ypr = shrink(h.get("yds"), h.get("rec"), p_ypr, k_ypr)
            tdpt = shrink(h.get("td"), h.get("tgt"), p_tdpt, k_tdpt)
            fdpr = shrink(h.get("fd"), h.get("rec"), p_fdpr, k_fdpr)
        else:
            catch, ypr, tdpt, fdpr = p_catch, p_ypr, p_tdpt, p_fdpr
        sig = max(2.0, 0.35 * routes_hat[i])
        d = simulate(routes_hat[i], sig, tprr, catch, ypr, tdpt, fdpr,
                     rec_points(args.test, m["pos"] or "WR"), args.sims)
        p50[i], p75[i], p90[i] = np.percentile(d, [50, 75, 90])

    print(f"Model C  {n} player-weeks x {args.sims} sims; "
          f"history matched for {matched}/{n} "
          f"({100*matched/max(n,1):.1f}%) — the rest fall back to league priors")
    if matched < 0.8 * n:
        print("  ⚠️  LOW MATCH RATE — most players are being scored on league "
              "priors, so Model B is barely contributing. Investigate before "
              "trusting these numbers.")

    base = np.array([m["base"] if m["base"] is not None else np.nan for m in mte])
    ok = ~np.isnan(base)
    print(f"\n{'model':>24} {'MAE':>8} {'pinball@.5':>11} {'P50 cov':>9} {'P90 cov':>9}")
    print("-" * 64)
    print(f"{'baseline std_ppg':>24} {np.mean(np.abs(yte[ok]-base[ok])):>8.3f} "
          f"{P.pinball(yte[ok], base[ok], 0.5):>11.3f} "
          f"{100*np.mean(yte[ok] <= base[ok]):>8.1f}% {'—':>9}")
    print(f"{'CHAMPION simulation':>24} {np.mean(np.abs(yte-p50)):>8.3f} "
          f"{P.pinball(yte, p50, 0.5):>11.3f} "
          f"{100*np.mean(yte <= p50):>8.1f}% {100*np.mean(yte <= p90):>8.1f}%")
    print(f"\nP75 coverage {100*np.mean(yte <= p75):.1f}% (target 75%)")
    print(f"mean P50 {np.mean(p50):.2f}  P90 {np.mean(p90):.2f}  "
          f"gap {np.mean(p90-p50):.2f}")


if __name__ == "__main__":
    main()
