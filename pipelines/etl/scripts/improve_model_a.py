#!/usr/bin/env python3
"""MODEL A bake-off — opportunity prediction is the simulation's bottleneck.

The component simulation loses to the direct GBM (4.505 vs 4.365 MAE), and the
most likely reason is upstream: expected routes carries an out-of-sample MAE of
**6.50 routes** against a typical volume of 25-30. Everything the simulation
does downstream — targets, receptions, yards, touchdowns — is conditioned on
that number, so its noise propagates into every quantile.

Three framings, same features, same walk-forward fold:

  A1  DIRECT          predict routes/week straight.
                      The current approach. Has to learn team pace, game script
                      and availability all at once, inside one target.

  A2  SHARE x VOLUME  predict route SHARE, multiply by expected team dropbacks.
                      routes = share x team_dropbacks is an identity, and the
                      share is far more stable than the product because it is
                      insensitive to how many plays the offence happened to run.
                      Decomposing a product into stable x predictable is usually
                      worth more than a better estimator on the product.

  A3  HURDLE          P(he runs any routes) x E[routes | he plays].
                      A player who is inactive has zero routes, and averaging
                      that against his active workload gives a number that
                      describes neither state. This is the spec's own injury
                      framing (§4: "do not represent injury with one yes/no
                      field") applied to opportunity.

WHY THIS MATTERS BEYOND THE SIMULATION
--------------------------------------
Opportunity prediction IS the pre-breakout problem. The Radar's job is to notice
a role change before the box score reflects it, which is a statement about
routes and targets, not points. A better Model A improves the thing Keith
actually asked for, whichever scoring model ends up winning.

Usage:
  python3 pipelines/etl/scripts/improve_model_a.py --train 2021-2024 --test 2025
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_wr_te_pilot as P  # noqa: E402
import simulate_wr_te_ups as S  # noqa: E402


def report(name, pred, truth, extra=""):
    mae = float(np.mean(np.abs(truth - pred)))
    rmse = float(np.sqrt(np.mean((truth - pred) ** 2)))
    bias = float(np.mean(pred - truth))
    print(f"{name:>26} {mae:>8.3f} {rmse:>8.3f} {bias:>+8.3f}   {extra}")
    return mae


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", default="2021-2024")
    ap.add_argument("--test", type=int, default=2025)
    ap.add_argument("--positions", default="WR,TE")
    args = ap.parse_args()

    from sklearn.ensemble import (HistGradientBoostingRegressor,
                                  HistGradientBoostingClassifier)

    pos = tuple(x.strip() for x in args.positions.split(",") if x.strip())
    tr_seasons = P._parse_seasons(args.train)
    if any(s >= args.test for s in tr_seasons):
        sys.exit(f"WALK-FORWARD VIOLATION: train {tr_seasons} must precede {args.test}")
    weeks = range(5, 18)

    Xtr_l, mtr = [], []
    for s in tr_seasons:
        a, _b, c = S.load_rows(s, weeks, pos)
        if len(a):
            Xtr_l.append(a); mtr += c
    Xtr = np.vstack(Xtr_l)
    Xte, _yte, mte = S.load_rows(args.test, weeks, pos)

    # Actual routes in the predicted week. Missing means he ran none that week
    # (no participation row) — which is a REAL zero for this target, not an
    # unknown, because the feature row only exists for players on a roster.
    ytr = np.array([m["actual_routes"] or 0.0 for m in mtr], dtype=float)
    yte = np.array([m["actual_routes"] or 0.0 for m in mte], dtype=float)

    print(f"\ntrain {Xtr.shape}  test {Xte.shape}  "
          f"mean routes {yte.mean():.1f}  zero-route weeks "
          f"{100*np.mean(yte == 0):.1f}%")
    print(f"\n{'model':>26} {'MAE':>8} {'RMSE':>8} {'bias':>8}")
    print("-" * 62)

    # naive floor — his own recent average
    i_l3 = P.FEATURES.index("routes_l3")
    naive = np.nan_to_num(Xte[:, i_l3] / 3.0)
    report("naive routes_l3/3", naive, yte)

    # ── A1 direct ──────────────────────────────────────────────────────────
    kw = dict(max_iter=300, learning_rate=0.06, max_depth=6,
              min_samples_leaf=40, random_state=0)
    m1 = HistGradientBoostingRegressor(**kw).fit(Xtr, ytr)
    a1 = np.maximum(0, m1.predict(Xte))
    report("A1 direct routes", a1, yte)

    # ── A2 share x volume ──────────────────────────────────────────────────
    # Team dropbacks in the predicted week are not knowable, so use the team's
    # recent rate — itself an as-of feature. routes = share x dropbacks is an
    # identity; the point is that share is the stable half.
    i_tdb = P.FEATURES.index("team_dropbacks_l4")
    tdb_tr = np.nan_to_num(Xtr[:, i_tdb] / 4.0)
    tdb_te = np.nan_to_num(Xte[:, i_tdb] / 4.0)
    share_tr = np.divide(ytr, np.maximum(tdb_tr, 1e-6),
                         out=np.zeros_like(ytr), where=tdb_tr > 0)
    share_tr = np.clip(share_tr, 0, 1.2)
    fit2 = tdb_tr > 0
    m2 = HistGradientBoostingRegressor(**kw).fit(Xtr[fit2], share_tr[fit2])
    a2 = np.clip(m2.predict(Xte), 0, 1.2) * tdb_te
    report("A2 share x dropbacks", a2, yte)

    # ── A3 hurdle ──────────────────────────────────────────────────────────
    played_tr = (ytr > 0).astype(int)
    clf = HistGradientBoostingClassifier(**kw).fit(Xtr, played_tr)
    p_play = clf.predict_proba(Xte)[:, 1]
    pos_fit = ytr > 0
    m3 = HistGradientBoostingRegressor(**kw).fit(Xtr[pos_fit], ytr[pos_fit])
    cond = np.maximum(0, m3.predict(Xte))
    a3 = p_play * cond
    report("A3 hurdle P(play)xE[r|play]", a3, yte,
           f"mean P(play) {p_play.mean():.3f}")

    # ── A4 hurdle on shares — both ideas together ──────────────────────────
    m4 = HistGradientBoostingRegressor(**kw).fit(Xtr[pos_fit & fit2],
                                                 share_tr[pos_fit & fit2])
    a4 = p_play * np.clip(m4.predict(Xte), 0, 1.2) * tdb_te
    report("A4 hurdle x share", a4, yte)

    print("\nBias is mean(pred - actual): a systematically low opportunity")
    print("estimate drags every downstream quantile down with it, so it matters")
    print("more here than in a terminal scoring model.")
    print(f"\n{100*np.mean(yte == 0):.1f}% of rostered WR/TE player-weeks have")
    print("ZERO routes. Any framing that cannot represent 'did not play' is")
    print("averaging two different states into a number describing neither.")


if __name__ == "__main__":
    main()
