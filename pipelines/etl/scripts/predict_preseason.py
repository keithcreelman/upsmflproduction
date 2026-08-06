#!/usr/bin/env python3
"""Generate preseason season-PPG projections for an unplayed season.

    python3 pipelines/etl/scripts/predict_preseason.py --season 2026 --top 40
    python3 pipelines/etl/scripts/predict_preseason.py --season 2026 --franchise 0008

WHAT THIS IS, AND WHAT IT IS NOT
    A projection of SEASON PPG — points per game played, not a season total. A
    total conflates "how good" with "how available", and availability is a
    separate model that does not exist yet. So this answers "how much will he
    score in the games he plays", and says nothing about how many that will be.

    Trained on every completed season (2018..S-1) and applied to S. There is no
    hold-out here by construction — S has not happened. The honest read on
    accuracy is the walk-forward in eval_preseason_model.py, which is what these
    numbers should be trusted to the extent of:

        WR   +0.315 PPG vs the league's canon rule, 95% CI [+0.172,+0.462]
        RB   +0.135                                        [-0.077,+0.356]
        QB   +0.138                                        [-0.296,+0.583]
        TE   +0.010                                        [-0.159,+0.178]

    Only WR's interval excludes zero. At RB, QB and TE this model is NOT
    distinguishable from simply applying prior-3-season weighted PPG x the age
    multiplier — so both numbers are printed side by side and the difference
    between them should not be over-read outside WR.

    P50/P75/P90 are direct season-PPG quantile fits (the spec's Model D), NOT
    aggregations of weekly quantiles — summing weekly P90s to build a season P90
    is wrong and is not what this does. P90 is the CONDITIONAL 90th percentile:
    ~90% of comparable outcomes at or below it. It is not a ceiling, and players
    exceed it regularly. Calibration is measured by eval_preseason_model.py
    --calibration; read that before trusting the spread.
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.asof import AsOfContext          # noqa: E402
from eval_preseason_model import FEATS    # noqa: E402  (one feature list, shared)


def main():
    import numpy as np
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--top", type=int, default=40)
    ap.add_argument("--positions", default="QB,RB,WR,TE")
    ap.add_argument("--franchise", help="MFL franchise id, e.g. 0008")
    ap.add_argument("--min-prior", type=float, default=None,
                    help="require this much prior_ppg_w (filters out no-history players)")
    args = ap.parse_args()

    pos = [p.strip() for p in args.positions.split(",") if p.strip()]
    poss = ",".join("'" + p + "'" for p in pos)
    ctx = AsOfContext(season=args.season, week=1)

    train = []
    for s in range(2018, args.season):
        train += ctx.run(
            f"SELECT * FROM model_player_preseason_features WHERE season={s}"
            f"  AND ups_ppg_actual IS NOT NULL AND ups_games_actual >= 4"
            f"  AND prior_ppg_w_aged IS NOT NULL AND mfl_pos IN ({poss})")
    target = ctx.run(
        f"SELECT * FROM model_player_preseason_features WHERE season={args.season}"
        f"  AND mfl_pos IN ({poss})")
    if not train or not target:
        raise SystemExit(f"REFUSING: train={len(train)} target={len(target)} — "
                         f"an unreadable input is not an empty one")

    # A player with no prior UPS history cannot be projected by a model whose
    # dominant feature IS that history. Emitting a number for him would be
    # inventing one; he is excluded and counted.
    usable = [r for r in target if r.get("prior_ppg_w_aged") is not None]
    dropped = len(target) - len(usable)

    def X(rs):
        return np.array([[float(r[f]) if r.get(f) is not None else np.nan
                          for f in FEATS] for r in rs], dtype=float)

    from sklearn.ensemble import HistGradientBoostingRegressor
    ytr = np.array([float(r["ups_ppg_actual"]) for r in train])
    kw = dict(max_iter=300, learning_rate=0.05, max_depth=4,
              min_samples_leaf=25, l2_regularization=1.0, random_state=0)
    m = HistGradientBoostingRegressor(**kw)
    m.fit(X(train), ytr)
    pred = m.predict(X(usable))

    # QUANTILES. Three independent pinball-loss fits, one per quantile. They are
    # NOT constrained to be ordered, so they can cross — P75 landing below P50 —
    # which is repaired by sorting each row. Sorting is the standard fix and is
    # honest: it enforces the ordering the quantiles must satisfy without
    # pretending the underlying fits agreed.
    #
    # ⚠️ P90 IS THE CONDITIONAL 90TH PERCENTILE: roughly 90% of comparable
    # outcomes at or below it. It is NOT a ceiling and must never be labelled
    # one — a player CAN and regularly will exceed it.
    #
    # ⚠️ These are SEASON-PPG quantiles fit directly (the spec's Model D). They
    # are NOT aggregated from weekly quantiles, and summing weekly P90s to make a
    # season P90 remains wrong and is not what this does.
    qs = (0.5, 0.75, 0.9)
    qp = np.column_stack([
        HistGradientBoostingRegressor(loss="quantile", quantile=q, **kw)
        .fit(X(train), ytr).predict(X(usable)) for q in qs])
    crossed = int((np.diff(qp, axis=1) < 0).any(axis=1).sum())
    qp = np.sort(qp, axis=1)
    if crossed:
        print(f"  {crossed} of {len(qp)} rows had crossing quantiles; repaired by "
              f"sorting", file=sys.stderr)

    out = []
    for r, p, q in zip(usable, pred, qp):
        out.append({
            "p50": float(q[0]), "p75": float(q[1]), "p90": float(q[2]),
            "name": r.get("player_name") or r.get("gsis_id"),
            "pos": r.get("mfl_pos"), "team": r.get("nfl_team"),
            "model": float(p), "canon": float(r["prior_ppg_w_aged"]),
            "sal": r.get("mfl_salary"), "fid": r.get("mfl_player_id"),
            "age": r.get("age_at_season"), "prior": r.get("prior_ppg_w"),
        })

    if args.franchise:
        own = {r["player_id"] for r in ctx.run(
            f"SELECT player_id FROM src_contracts WHERE season={args.season}"
            f"  AND franchise_id='{args.franchise}'")}
        out = [o for o in out if str(o["fid"]) in own]
    if args.min_prior is not None:
        out = [o for o in out if (o["prior"] or 0) >= args.min_prior]

    out.sort(key=lambda o: -o["model"])
    print(f"\n{args.season} preseason projection — SEASON PPG "
          f"(trained 2018-{args.season - 1}, n={len(train)})")
    print(f"{len(usable)} players projected; {dropped} skipped for no prior UPS history\n")
    print(f"{'#':<4}{'player':<24}{'pos':<5}{'tm':<5}{'model':>7}{'canon':>7}"
          f"{'P50':>7}{'P75':>7}{'P90':>7}{'salary':>9}")
    print("-" * 82)
    for i, o in enumerate(out[:args.top], 1):
        sal = f"${o['sal']:,}" if o["sal"] else "—"
        age = f"{o['age']:.1f}" if o["age"] else "—"
        print(f"{i:<4}{str(o['name'])[:23]:<24}{str(o['pos']):<5}{str(o['team'] or '')[:4]:<5}"
              f"{o['model']:>7.2f}{o['canon']:>7.2f}"
              f"{o['p50']:>7.2f}{o['p75']:>7.2f}{o['p90']:>7.2f}{sal:>9}")
    print("\nmodel = learned mean; canon = prior-3-season weighted PPG x age multiplier.")
    print("P90 = conditional 90th percentile — ~90%% of comparable outcomes at or")
    print("below it. It is NOT a ceiling; players exceed it regularly.")
    print("Only WR beats canon significantly in walk-forward — elsewhere treat")
    print("model and canon as interchangeable.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
