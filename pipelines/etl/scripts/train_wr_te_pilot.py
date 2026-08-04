#!/usr/bin/env python3
"""WR/TE PILOT — Model D (direct quantile regression), the CHALLENGER.

Spec implementation step 5. The one question this answers, before any effort
goes into the component simulation:

    Do the as-of features beat the season-to-date-PPG baseline at all?

If they do not, nothing downstream matters — and the honest response is to keep
the baseline, per the spec's own instruction not to ship complexity for its own
sake.

WHY THE CHALLENGER FIRST
------------------------
The spec designates the component simulation (Models A+B+C) the interpretable
CHAMPION and direct quantile regression the challenger, and that ordering is
right for production. But the challenger is far cheaper to stand up and gives an
upper-ish bound on what the current feature set supports. Building it first is a
feasibility probe, not a change of plan.

STRICT WALK-FORWARD
-------------------
Train on earlier seasons, test on a later one. Player-weeks are NEVER shuffled
across seasons — the spec is explicit, and random splitting would let the model
see a player's own later usage while predicting his earlier weeks.

QUANTILE CROSSING
-----------------
Independently-fit quantiles cross in sparse regions (P90 < P75 happens). The
spec requires P90 >= P75 >= P50, so the three predictions are sorted per row
after fitting. Sorting is the standard non-parametric fix and cannot degrade
pinball loss (rearrangement is a projection onto the monotone cone).

Usage:
  python3 pipelines/etl/scripts/train_wr_te_pilot.py --train 2024 --test 2025
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402

QUANTILES = (0.50, 0.75, 0.90)

FEATURES = [
    "weeks_played_std", "weeks_since_last",
    "routes_l1", "routes_l3", "routes_l4", "routes_std",
    "route_pct_l3", "route_pct_l4", "route_pct_std",
    "targets_l1", "targets_l3", "targets_l4", "targets_std",
    "tgt_share_l3", "tgt_share_l4", "tgt_share_std",
    "off_snaps_l3", "off_snap_pct_l3", "off_snap_pct_l4",
    "carries_l4", "touches_l4",
    "rz_tgt_l4", "rz_tgt_std", "ez_tgt_l4",
    "tprr_l4", "tprr_std", "yprr_l4", "yprr_std", "fdprr_l4", "fdprr_std",
    "catch_rate_std", "ypt_std",
    "ups_ppg_l3", "ups_ppg_l4", "ups_ppg_std", "ups_last",
    "d_route_pct_l3", "d_tgt_share_l3", "d_routes_l3", "d_snap_pct_l3",
    "team_dropbacks_l4", "team_targets_l4",
    "vegas_spread", "vegas_total", "vegas_implied",
]


def load(season: int, weeks=range(5, 18), positions=("WR", "TE")):
    """Features for (season, W) joined to the realized score IN week W.

    Reading week W's score here is the TARGET, not a feature — supervised
    learning on a completed season. Nothing about it feeds a prediction; the
    feature row was built under the as-of guard and cannot see it.
    """
    ctx = AsOfContext(season=season, week=1)
    X, y, meta = [], [], []
    for wk in weeks:
        rows = ctx.run(
            "SELECT f.*, s.score AS target"
            " FROM model_player_week_features f"
            " JOIN ff_player_ids p ON p.gsis_id = f.gsis_id"
            " JOIN src_weekly s ON s.player_id = CAST(p.mfl_id AS INTEGER)"
            f"  AND s.season = {season} AND s.week = {wk}"
            f" WHERE f.season = {season} AND f.week = {wk}"
            f"   AND f.mfl_pos IN ({','.join(chr(39)+x+chr(39) for x in positions)})"
            "   AND f.routes_std > 0"
            "   AND s.score IS NOT NULL")
        for r in rows:
            X.append([None if r.get(c) is None else float(r[c]) for c in FEATURES])
            y.append(float(r["target"]))
            meta.append((r.get("player_name"), r.get("mfl_pos"), wk,
                         r.get("ups_ppg_std")))
        print(f"  {season} W{wk}: {len(rows)}", file=sys.stderr, flush=True)
    return (np.array(X, dtype=float), np.array(y, dtype=float), meta)


def _parse_seasons(spec: str) -> list[int]:
    out: list[int] = []
    for part in str(spec).split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def pinball(y, pred, q):
    d = y - pred
    return float(np.mean(np.maximum(q * d, (q - 1) * d)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="2024",
                    help="Comma/range list of TRAIN seasons, e.g. 2021-2024. "
                         "Strictly earlier than --test; never shuffled with it.")
    ap.add_argument("--test", type=int, default=2025)
    ap.add_argument("--positions", default="WR,TE",
                    help="Comma list. NOTE: TE scoring changed in 2025 (CC 1.0 "
                         "-> 1.5 reception premium) while WR did not, so a "
                         "2024-train/2025-test split has a SHIFTED TARGET for "
                         "TE. Run WR-only to measure without that confound.")
    args = ap.parse_args()

    from sklearn.ensemble import HistGradientBoostingRegressor

    print(f"loading train {args.train}…", file=sys.stderr)
    pos = tuple(x.strip() for x in args.positions.split(",") if x.strip())
    tr_seasons = _parse_seasons(args.train)
    if any(s_ >= args.test for s_ in tr_seasons):
        sys.exit(f"WALK-FORWARD VIOLATION: train {tr_seasons} must be strictly "
                 f"earlier than test {args.test}.")
    parts = [load(s_, positions=pos) for s_ in tr_seasons]
    Xtr = np.vstack([p_[0] for p_ in parts if len(p_[0])])
    ytr = np.concatenate([p_[1] for p_ in parts if len(p_[1])])
    print(f"loading test {args.test}…", file=sys.stderr)
    Xte, yte, mte = load(args.test, positions=pos)
    if not len(Xtr) or not len(Xte):
        sys.exit("no data — is the feature store built for both seasons?")
    print(f"\ntrain {Xtr.shape}  test {Xte.shape}\n")

    preds = {}
    for q in QUANTILES:
        m = HistGradientBoostingRegressor(
            loss="quantile", quantile=q, max_iter=300, learning_rate=0.06,
            max_depth=6, min_samples_leaf=40, l2_regularization=1.0,
            random_state=0)
        m.fit(Xtr, ytr)
        preds[q] = m.predict(Xte)

    # Enforce P90 >= P75 >= P50 (spec requirement). Sorting is a projection onto
    # the monotone cone and cannot worsen pinball loss.
    stack = np.vstack([preds[q] for q in QUANTILES])
    crossed = int(np.sum(np.diff(stack, axis=0) < 0))
    stack = np.sort(stack, axis=0)
    p50, p75, p90 = stack[0], stack[1], stack[2]

    # Baseline on the SAME rows — season-to-date PPG, the winner from
    # evaluate_baselines.py. Same-rows comparison is the only fair one.
    base = np.array([m[3] if m[3] is not None else np.nan for m in mte])
    ok = ~np.isnan(base)

    print(f"quantile crossings repaired: {crossed}\n")
    print(f"{'model':>22} {'MAE':>8} {'pinball@.5':>11} {'P50 cov':>9} {'P90 cov':>9}")
    print("-" * 62)
    print(f"{'baseline std_ppg':>22} {np.mean(np.abs(yte[ok]-base[ok])):>8.3f} "
          f"{pinball(yte[ok], base[ok], 0.5):>11.3f} "
          f"{100*np.mean(yte[ok] <= base[ok]):>8.1f}% {'—':>9}")
    print(f"{'pilot GBM quantile':>22} {np.mean(np.abs(yte-p50)):>8.3f} "
          f"{pinball(yte, p50, 0.5):>11.3f} "
          f"{100*np.mean(yte <= p50):>8.1f}% {100*np.mean(yte <= p90):>8.1f}%")
    print(f"{'  (same rows as base)':>22} {np.mean(np.abs(yte[ok]-p50[ok])):>8.3f} "
          f"{pinball(yte[ok], p50[ok], 0.5):>11.3f}")

    print(f"\nP75 coverage {100*np.mean(yte <= p75):.1f}%  (target 75%)")
    print(f"mean P50 {np.mean(p50):.2f}  P90 {np.mean(p90):.2f}  "
          f"gap {np.mean(p90-p50):.2f}")
    print("\nA P90 that hits ~90% coverage by being enormous is uninformative —")
    print("the spec rejects it. Report the P50->P90 gap alongside coverage.")

    d = np.mean(np.abs(yte[ok]-base[ok])) - np.mean(np.abs(yte[ok]-p50[ok]))
    verdict = "BEATS" if d > 0 else "DOES NOT BEAT"
    print(f"\nVERDICT: pilot {verdict} the baseline by {abs(d):.3f} MAE "
          f"({100*abs(d)/np.mean(np.abs(yte[ok]-base[ok])):.1f}%)")
    if d <= 0:
        print("Per the spec, do not ship a more complicated model that loses.")


if __name__ == "__main__":
    main()
