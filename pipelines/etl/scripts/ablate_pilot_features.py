#!/usr/bin/env python3
"""ABLATION — did Phase 0's route work actually earn its keep?

The pilot beats the season-to-date-PPG baseline by only 1.7%. Before concluding
anything about the feature set, the more useful question is WHICH features carry
that gain. In particular:

    Do routes / route% / TPRR / YPRR / FDPRR contribute anything the player's own
    prior scoring does not already capture?

That matters because building nfl_player_routes_weekly (migration 0115) and the
first-down columns (0114) was the bulk of Phase 0. If the route family adds
nothing over lagged UPS points, that is a finding worth having explicitly rather
than assuming — and it would redirect effort toward the role-event layer instead
of more efficiency metrics.

Loads each season ONCE and re-fits across ablations, because the D1 reads
dominate runtime.

Usage:
  python3 pipelines/etl/scripts/ablate_pilot_features.py --train 2024 --test 2025
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_wr_te_pilot as P  # noqa: E402

# Feature families, by substring. Ablating a family REMOVES those columns from
# the matrix entirely rather than NaN-filling them: an ablation should mean "this
# feature does not exist", and an all-NaN column additionally breaks sklearn's
# binner outright ("window shape cannot be larger than input array shape").
# Zero-filling would be worse still — it fabricates a measurement of nothing.
FAMILIES = {
    "routes":     ("routes_", "route_pct"),
    "efficiency": ("tprr", "yprr", "fdprr", "catch_rate", "ypt_"),
    "targets":    ("targets_", "tgt_share"),
    "snaps":      ("off_snap",),
    "redzone":    ("rz_tgt", "ez_tgt"),
    "deltas":     ("d_route", "d_tgt", "d_routes", "d_snap"),
    "lagged_ups": ("ups_ppg", "ups_last"),
    "vegas":      ("vegas_",),
    # Added 2026-08-05 (migration 0121). These are the four inputs Keith asked
    # for; ablating them is how we find out whether they earned their place
    # rather than assuming they did because they sound informative.
    "injury":     ("inj_",),
    "depth":      ("depth_rank", "d_depth_rank"),
    "matchup":    ("opp_def_",),
}


def fit_eval(Xtr, ytr, Xte, yte, drop_idx):
    from sklearn.ensemble import HistGradientBoostingRegressor
    if drop_idx:
        keep = [i for i in range(Xtr.shape[1]) if i not in set(drop_idx)]
        A, B = Xtr[:, keep], Xte[:, keep]
    else:
        A, B = Xtr, Xte
    m = HistGradientBoostingRegressor(
        loss="quantile", quantile=0.5, max_iter=300, learning_rate=0.06,
        max_depth=6, min_samples_leaf=40, l2_regularization=1.0, random_state=0)
    m.fit(A, ytr)
    p = m.predict(B)
    return float(np.mean(np.abs(yte - p))), float(100 * np.mean(yte <= p))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="2024")
    ap.add_argument("--test", type=int, default=2025)
    ap.add_argument("--positions", default="WR,TE")
    args = ap.parse_args()

    pos = tuple(x.strip() for x in args.positions.split(",") if x.strip())
    tr_seasons = P._parse_seasons(args.train)
    if any(s >= args.test for s in tr_seasons):
        sys.exit(f"WALK-FORWARD VIOLATION: train {tr_seasons} must precede "
                 f"test {args.test}")

    parts = [P.load(s, positions=pos) for s in tr_seasons]
    Xtr = np.vstack([p[0] for p in parts if len(p[0])])
    ytr = np.concatenate([p[1] for p in parts if len(p[1])])
    Xte, yte, mte = P.load(args.test, positions=pos)

    base = np.array([m[3] if m[3] is not None else np.nan for m in mte])
    ok = ~np.isnan(base)
    base_mae = float(np.mean(np.abs(yte[ok] - base[ok])))

    full_mae, full_cov = fit_eval(Xtr, ytr, Xte, yte, [])
    print(f"\ntrain {Xtr.shape}  test {Xte.shape}  positions={','.join(pos)}")
    print(f"\n{'configuration':>28} {'MAE':>8} {'vs full':>9} {'P50 cov':>9}")
    print("-" * 58)
    print(f"{'baseline std_ppg':>28} {base_mae:>8.3f} "
          f"{base_mae - full_mae:>+9.3f} {'—':>9}")
    print(f"{'FULL feature set':>28} {full_mae:>8.3f} {0.0:>+9.3f} {full_cov:>8.1f}%")
    print()

    rows = []
    for fam, pats in FAMILIES.items():
        idx = [i for i, c in enumerate(P.FEATURES)
               if any(c.startswith(x) or x in c for x in pats)]
        if not idx:
            continue
        mae, cov = fit_eval(Xtr, ytr, Xte, yte, idx)
        rows.append((mae - full_mae, fam, len(idx), mae, cov))
    for delta, fam, n, mae, cov in sorted(rows, reverse=True):
        note = "  <- carries real signal" if delta > 0.02 else (
               "  (removing it HELPS)" if delta < -0.02 else "")
        print(f"{'drop ' + fam:>28} {mae:>8.3f} {delta:>+9.3f} {cov:>8.1f}%{note}")

    print("\n'vs full' is MAE INCREASE when the family is removed — bigger is")
    print("more load-bearing. A negative value means the family was hurting.")
    print("\nAblation measures MARGINAL contribution given everything else. A")
    print("family can be individually predictive yet ablate to ~0 because a")
    print("correlated family already carries the signal — that is informative")
    print("about what to BUILD NEXT, not proof the data is worthless.")


if __name__ == "__main__":
    main()
