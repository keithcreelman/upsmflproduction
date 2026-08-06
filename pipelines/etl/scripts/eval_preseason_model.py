#!/usr/bin/env python3
"""Walk-forward evaluation of preseason season-PPG projection.

    python3 pipelines/etl/scripts/eval_preseason_model.py
    python3 pipelines/etl/scripts/eval_preseason_model.py --positions RB --min-games 8

THE QUESTION
    Does a learned model beat simply applying the league's own rule? The canon
    baseline (prior_ppg_w_aged = prior-3-season weighted PPG x age multiplier)
    is not a strawman — it encodes real stickiness research, and a challenger
    that cannot beat it has earned nothing.

WALK-FORWARD, NEVER SHUFFLED
    For each test season S the model trains only on seasons < S. Shuffling
    player-seasons across the season boundary would leak the future into the
    past and inflate every number here.

WHY MAE ON PPG
    Season PPG is the natural preseason target: a season total conflates "how
    good" with "how available", and availability is a separate model. Reported
    per position because 3.5 PPG means something very different at QB and TE.

THE AGE x TALENT QUESTION
    Keith asked (2026-08-05) whether age curves should depend on player quality
    — Derrick Henry is not Raheem Mostert. The direct empirical test
    (research_age_talent_interaction.py) could not support a hand-built curve:
    n=16 at RB 31+, one player holding 3 of 8 elite slots, and a residual
    regression artifact in the retention denominator. So instead the model is
    given age_at_season and prior_ppg_w as separate features and left to learn
    the interaction if it exists. --importance reports whether it used them.
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402

FEATS = ["prior_ppg_w", "prior_ppg_w_aged", "age_multiplier", "seasons_of_history",
         "ppg_1", "ppg_2", "ppg_3", "games_1", "games_2", "games_3",
         "routes_pg_1", "targets_pg_1", "carries_pg_1", "dropbacks_pg_1",
         "age_at_season", "years_exp", "is_rookie", "team_changed",
         "depth_rank", "mfl_salary"]


def load(seasons, positions, min_games):
    ctx = AsOfContext(season=max(seasons), week=1)
    out = []
    for s in seasons:
        rows = ctx.run(
            f"SELECT * FROM model_player_preseason_features WHERE season = {s}"
            f"   AND ups_ppg_actual IS NOT NULL"
            f"   AND ups_games_actual >= {min_games}"
            + (f" AND mfl_pos IN ({','.join(chr(39)+p+chr(39) for p in positions)})"
               if positions else ""))
        out += rows
        print(f"  {s}: {len(rows)}", file=sys.stderr)
    return out


def main():
    import numpy as np
    ap = argparse.ArgumentParser()
    ap.add_argument("--positions", default="QB,RB,WR,TE")
    ap.add_argument("--min-games", type=int, default=4)
    ap.add_argument("--test-seasons", default="2022-2025")
    ap.add_argument("--importance", action="store_true")
    args = ap.parse_args()

    pos = [p.strip() for p in args.positions.split(",") if p.strip()]
    a, b = args.test_seasons.split("-")
    tests = list(range(int(a), int(b) + 1))

    rows = load(list(range(2018, max(tests) + 1)), pos, args.min_games)
    if not rows:
        raise SystemExit("REFUSING: no rows loaded")

    def X(rs):
        return np.array([[float(r[f]) if r.get(f) is not None else np.nan
                          for f in FEATS] for r in rs], dtype=float)

    print(f"\n{'season':<9}{'n':>6}{'canon MAE':>12}{'model MAE':>12}"
          f"{'naive MAE':>12}{'model vs canon':>16}")
    print("-" * 67)
    agg = {"canon": [], "model": [], "naive": [], "n": 0}
    per_pos = {}
    all_diff = []

    for s in tests:
        tr = [r for r in rows if r["season"] < s]
        te = [r for r in rows if r["season"] == s]
        # Canon and naive are only defined where a prior exists; compare all
        # three on the SAME subset or the numbers are not comparable.
        te = [r for r in te if r.get("prior_ppg_w_aged") is not None
              and r.get("ppg_1") is not None]
        tr = [r for r in tr if r.get("prior_ppg_w_aged") is not None]
        if len(tr) < 200 or len(te) < 40:
            print(f"{s:<9}{len(te):>6}   (insufficient data)")
            continue

        y_te = np.array([float(r["ups_ppg_actual"]) for r in te])
        canon = np.array([float(r["prior_ppg_w_aged"]) for r in te])
        naive = np.array([float(r["ppg_1"]) for r in te])   # last season, unadjusted

        from sklearn.ensemble import HistGradientBoostingRegressor
        m = HistGradientBoostingRegressor(
            max_iter=300, learning_rate=0.05, max_depth=4,
            min_samples_leaf=25, l2_regularization=1.0, random_state=0)
        m.fit(X(tr), np.array([float(r["ups_ppg_actual"]) for r in tr]))
        pred = m.predict(X(te))

        mae = lambda p: float(np.mean(np.abs(p - y_te)))  # noqa: E731
        c, mo, na = mae(canon), mae(pred), mae(naive)
        lift = (c - mo) / c * 100
        print(f"{s:<9}{len(te):>6}{c:>12.3f}{mo:>12.3f}{na:>12.3f}{lift:>15.1f}%")
        agg["canon"].append(c); agg["model"].append(mo); agg["naive"].append(na)
        agg["n"] += len(te)

        # Keep the RAW per-row error differences, not just per-season MAEs. A
        # mean of four season-MAEs cannot be bootstrapped; the 1,289 paired rows
        # underneath it can, and that is the only way to tell a real gain from a
        # lucky one at n=142 (QB).
        for p in pos:
            idx = [i for i, r in enumerate(te) if r.get("mfl_pos") == p]
            if len(idx) >= 15:
                d = per_pos.setdefault(p, {"c": [], "m": [], "n": 0, "diff": []})
                d["c"].append(float(np.mean(np.abs(canon[idx] - y_te[idx]))))
                d["m"].append(float(np.mean(np.abs(pred[idx] - y_te[idx]))))
                d["n"] += len(idx)
                d["diff"] += list(np.abs(canon[idx] - y_te[idx])
                                  - np.abs(pred[idx] - y_te[idx]))
        all_diff.extend(np.abs(canon - y_te) - np.abs(pred - y_te))

        if args.importance and s == tests[-1]:
            from sklearn.inspection import permutation_importance
            r = permutation_importance(m, X(te), y_te, n_repeats=8, random_state=0)
            order = np.argsort(-r.importances_mean)[:10]
            print(f"\n  permutation importance, {s} ({len(te)} rows)")
            for i in order:
                print(f"    {FEATS[i]:<22}{r.importances_mean[i]:+.4f}")

    if agg["canon"]:
        mc = sum(agg["canon"]) / len(agg["canon"])
        mm = sum(agg["model"]) / len(agg["model"])
        mn = sum(agg["naive"]) / len(agg["naive"])
        print("-" * 67)
        print(f"{'MEAN':<9}{agg['n']:>6}{mc:>12.3f}{mm:>12.3f}{mn:>12.3f}"
              f"{(mc - mm) / mc * 100:>15.1f}%")
        print(f"\ncanon = prior-3-season weighted PPG x age multiplier "
              f"(the league's own rule)")
        print(f"naive = last season's PPG, unadjusted")

    def boot(v, n=4000):
        v = np.asarray(v, dtype=float)
        rng = np.random.default_rng(0)
        b = np.array([rng.choice(v, len(v), replace=True).mean() for _ in range(n)])
        return v.mean(), np.percentile(b, 2.5), np.percentile(b, 97.5), (b > 0).mean()

    if per_pos:
        print(f"\n{'pos':<6}{'n':>6}{'canon':>9}{'model':>9}{'lift':>8}"
              f"{'diff PPG':>11}{'95% CI':>20}{'P(better)':>11}")
        for p, d in sorted(per_pos.items()):
            c = sum(d["c"]) / len(d["c"]); m = sum(d["m"]) / len(d["m"])
            mu, lo, hi, pb = boot(d["diff"])
            star = "  *" if lo > 0 else ""
            print(f"{p:<6}{d['n']:>6}{c:>9.3f}{m:>9.3f}{(c - m) / c * 100:>7.1f}%"
                  f"{mu:>+11.3f}   [{lo:+.3f}, {hi:+.3f}]{pb:>10.2f}{star}")
    if all_diff:
        mu, lo, hi, pb = boot(all_diff)
        print(f"{'POOLED':<6}{len(all_diff):>6}{'':>9}{'':>9}{'':>8}"
              f"{mu:>+11.3f}   [{lo:+.3f}, {hi:+.3f}]{pb:>10.2f}")
        print("\n  diff = mean(|canon error| - |model error|); positive = model better.")
        print("  * = 95% CI excludes zero. Anything else is not distinguishable")
        print("    from just applying the league's own rule.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
