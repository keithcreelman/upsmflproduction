#!/usr/bin/env python3
"""Backtest: how well does each model value a FUTURE rookie pick?

A future pick's slot is set by the original owner's final finish (canon §A1:
finish 7 picks 1.01 ... finish 12 picks 1.06, finish 5 picks 1.07 ... the
champion picks 1.12). For every team-season 2013-2025, each model predicts the
pick from the seasons BEFORE it, and is scored against the value of the slot
the team actually earned.

Offline: reads tests/fixtures/final_finish_history_2010_2025.json only. No D1,
no network. Values use the curve the grader runs with today (500 * exp(-0.03 *
overall pick), the fallback while the trade-value model file is missing).
Round 2 and 3 errors are the round 1 errors times exp(-0.36) and exp(-0.72), so
the ranking is the same for every round.

  python3 pipelines/etl/scripts/backtest_pick_slot_model.py
"""
import json
import math
import sys
from collections import Counter
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
import pick_valuation as pv  # noqa: E402

FIXTURE = SCRIPT_DIR.parents[2] / "tests" / "fixtures" / "final_finish_history_2010_2025.json"
FIRST_TARGET_SEASON = 2013
K_GRID = (0, 2, 4, 6, 10, 20)


def load_fixture(path=FIXTURE):
    data = json.loads(Path(path).read_text())
    finish = {(fid, int(season)): f
              for season, by_fid in data["finishes"].items() for fid, f in by_fid.items()}
    tenure = {owner: [(fid, int(season)) for fid, season in pairs]
              for owner, pairs in data["owner_tenure"].items()}
    return finish, tenure


def use_live_curve():
    """Pin the grader's live valuation inputs so nothing is read from disk."""
    pv._CURVE_A, pv._CURVE_B, pv._DOLLARS_PER_POINT = 500.0, 0.03, 60.0
    pv._CAREER_CACHE = {}


def r1_points(slot: int) -> float:
    return pv.pick_expected_points(0, 1, slot=slot)


def targets(finish, tenure):
    """(prior finishes, actual slot) pairs.

    franchise: every franchise, history = that franchise's earlier seasons.
    owner:     current owners only, history = their earlier tenure seasons
               (any franchise), targets with at least 2 prior seasons.
    """
    seasons = sorted({s for _, s in finish})
    fids = sorted({f for f, _ in finish})
    by_franchise = []
    for fid in fids:
        for t in seasons:
            if t >= FIRST_TARGET_SEASON:
                hist = [finish[(fid, s)] for s in seasons if s < t]
                by_franchise.append((hist, pv.slot_for_finish(finish[(fid, t)])))
    by_owner = []
    for pairs in tenure.values():
        pairs = sorted(pairs, key=lambda p: p[1])
        for i, key in enumerate(pairs):
            if i >= 2:
                hist = [finish[p] for p in pairs[:i]]
                by_owner.append((hist, pv.slot_for_finish(finish[key])))
    return {"franchise": by_franchise, "owner": by_owner}


def point(slot):
    return {slot: 1.0}


def mean_or(hist, default):
    return sum(hist) / len(hist) if hist else default


def proposed(hist, k=None):
    """The production model: pick_valuation.future_slot_distribution() fed an
    owner block built from the history, exactly as the grader would see it."""
    saved_cache, saved_k = pv._CAREER_CACHE, pv.PLAYOFF_PRIOR_SEASONS
    try:
        pv._CAREER_CACHE = {"X": {"owner": {
            "seasons_count": len(hist),
            "playoff_appearances": sum(1 for f in hist if f <= 6)}}}
        if k is not None:
            pv.PLAYOFF_PRIOR_SEASONS = k
        return pv.future_slot_distribution("X")
    finally:
        pv._CAREER_CACHE, pv.PLAYOFF_PRIOR_SEASONS = saved_cache, saved_k


def finish_distribution(hist, k=8):
    c, n = Counter(hist), len(hist)
    return {pv.slot_for_finish(f): (c[f] + k / 12) / (n + k) for f in range(1, 13)}


def models():
    out = {
        "live today: every future pick at x.06": lambda h: point(6),
        "code as written, data restored: round(13 - avg finish)":
            lambda h: point(max(1, min(12, round(13 - mean_or(h, 6.5))))),
        "naive fix: canon slot of round(avg finish)":
            lambda h: point(pv.slot_for_finish(max(1, min(12, round(mean_or(h, 6.5)))))),
        "league average: uniform 1.01-1.12": lambda h: {s: 1 / 12 for s in range(1, 13)},
        "finish distribution, shrunk (k=8)": finish_distribution,
    }
    for k in K_GRID:
        tag = " <- PROPOSED" if k == pv.PLAYOFF_PRIOR_SEASONS else ""
        out[f"bracket first (k={k}){tag}"] = (lambda h, k=k: proposed(h, k))
    return out


def score(model, rows):
    se = ae = bias = ll = 0.0
    for hist, actual in rows:
        dist = model(hist)
        pred = sum(p * r1_points(s) for s, p in dist.items())
        err = pred - r1_points(actual)
        se += err * err
        ae += abs(err)
        bias += err
        ll -= math.log(max(dist.get(actual, 0.0), 1e-3))
    n = len(rows)
    return {"rmse": math.sqrt(se / n), "mae": ae / n, "bias": bias / n, "logloss": ll / n, "n": n}


def run_backtest(path=FIXTURE):
    use_live_curve()
    finish, tenure = load_fixture(path)
    sets = targets(finish, tenure)
    return {name: {set_name: score(m, rows) for set_name, rows in sets.items()}
            for name, m in models().items()}


def persistence(path=FIXTURE):
    """How often teams with a high / low prior playoff rate made it next year."""
    finish, tenure = load_fixture(path)
    rows = [(h, a) for h, a in targets(finish, tenure)["franchise"] if len(h) >= 3]
    high = [a >= 7 for h, a in rows if sum(f <= 6 for f in h) / len(h) >= 0.6]
    low = [a >= 7 for h, a in rows if sum(f <= 6 for f in h) / len(h) <= 0.4]
    return {"high": (sum(high), len(high)), "low": (sum(low), len(low))}


def main():
    res = run_backtest()
    for set_name, label in (("franchise", "franchise history, 2013-2025 targets"),
                            ("owner", "current-owner tenure, >=2 prior seasons")):
        n = next(iter(res.values()))[set_name]["n"]
        print(f"\n{label} ({n} team-seasons). Error in round-1 expected points:")
        print(f"  {'model':<58} {'RMSE':>6} {'MAE':>6} {'bias':>6} {'logloss':>8}")
        for name, by_set in res.items():
            r = by_set[set_name]
            print(f"  {name:<58} {r['rmse']:>6.2f} {r['mae']:>6.2f} {r['bias']:>+6.2f} {r['logloss']:>8.3f}")
    p = persistence()
    print("\nNext-season playoff rate, franchises with 3+ prior seasons:")
    print(f"  prior playoff rate >= 60%: {p['high'][0]}/{p['high'][1]}"
          f" = {p['high'][0] / p['high'][1]:.0%}")
    print(f"  prior playoff rate <= 40%: {p['low'][0]}/{p['low'][1]}"
          f" = {p['low'][0] / p['low'][1]:.0%}")


if __name__ == "__main__":
    main()
