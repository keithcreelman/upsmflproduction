#!/usr/bin/env python3
"""BASELINES — the bar any model must clear (spec §12, implementation step 4).

Establishes, per position and per horizon, how well trivially-simple predictors
do at forecasting next-week UPS points. Nothing goes to production that does not
beat these out of sample.

    "Do not put a machine-learning model into production simply because it is
     more complicated."

BASELINES IMPLEMENTED
  std_ppg      season-to-date mean UPS points, weeks 1..W-1
  l3_ppg       mean over weeks W-3..W-1
  l4_ppg       mean over weeks W-4..W-1
  last         the single most recent week's score
  prev_season  mean UPS PPG in season S-1
  replacement  position-group mean among rostered scorers, weeks 1..W-1
               (the "simple position-average replacement projection")

DELIBERATELY COMPUTED FROM src_weekly DIRECTLY, not from
model_player_week_features. A baseline that depends on the model's own feature
pipeline is not an independent bar — if the pipeline has a bug, both move
together and the comparison flatters the model. These share nothing with it
except the as-of guard.

METRICS
  MAE          mean absolute error
  pinball@0.5  the P50 quantile loss the champion model is scored on, so the
               numbers are directly comparable (== MAE/2 at q=0.5, reported
               explicitly to avoid anyone re-deriving it wrongly)
  bias         mean signed error; a baseline that is unbiased but imprecise is
               a different problem from one that is systematically low

EVERY BASELINE IS AS-OF CLEAN. Predictions for week W use only weeks < W, via
lib/asof. That matters: a baseline computed with hindsight would be an
impossibly high bar and would quietly kill a good model.

Usage:
  python3 pipelines/etl/scripts/evaluate_baselines.py --season 2024
  python3 pipelines/etl/scripts/evaluate_baselines.py --season 2024 --weeks 5-17
"""
from __future__ import annotations
import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402

POSITIONS = ("QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB")
BASELINES = ("std_ppg", "l3_ppg", "l4_ppg", "last", "prev_season", "replacement")


def parse_weeks(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def eval_week(season: int, week: int, prev_ppg: dict) -> list[tuple]:
    """Return (pos, baseline_name, abs_err, signed_err) for every player-week."""
    ctx = AsOfContext(season=season, week=week)
    hi = week - 1
    if hi < 1:
        return []
    l3, l4 = max(1, hi - 2), max(1, hi - 3)

    # History strictly before W (as-of guard supplies the predicate).
    hist = {}
    for r in ctx.run(ctx.select(
            "src_weekly",
            "player_id, MAX(pos_group) pos, COUNT(*) n, AVG(score) std_ppg,"
            f" AVG(CASE WHEN week >= {l3} THEN score END) l3_ppg,"
            f" AVG(CASE WHEN week >= {l4} THEN score END) l4_ppg,"
            f" MAX(CASE WHEN week = {hi} THEN score END) last",
            where=f"season = {season}", group_by="player_id")):
        hist[r["player_id"]] = r

    # Replacement level: the position-group mean among players who actually
    # appeared. Computed from the SAME as-of history, never from final ranks.
    pos_sum, pos_n = defaultdict(float), defaultdict(int)
    for h in hist.values():
        if h.get("pos") and h.get("std_ppg") is not None:
            pos_sum[h["pos"]] += h["std_ppg"]
            pos_n[h["pos"]] += 1
    replacement = {p: pos_sum[p] / pos_n[p] for p in pos_sum if pos_n[p]}

    # Actuals for the target week. This is the TARGET, not a feature — reading
    # it here is evaluation, not leakage; nothing about it feeds a prediction.
    actual = ctx.run(
        f"SELECT player_id, pos_group pos, score FROM src_weekly"
        f" WHERE season = {season} AND week = {week} AND score IS NOT NULL")

    out = []
    for a in actual:
        pid, pos, act = a["player_id"], a["pos"], a["score"]
        if not pos or act is None:
            continue
        h = hist.get(pid) or {}
        preds = {
            "std_ppg": h.get("std_ppg"),
            "l3_ppg": h.get("l3_ppg"),
            "l4_ppg": h.get("l4_ppg"),
            "last": h.get("last"),
            "prev_season": prev_ppg.get(pid),
            "replacement": replacement.get(pos),
        }
        for name, p in preds.items():
            if p is None:
                continue          # no prediction is not a zero prediction
            out.append((pos, name, abs(act - p), act - p))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--weeks", default="5-17",
                    help="Default starts at 5 so the L3/L4 windows are real.")
    args = ap.parse_args()

    # Prior-season PPG — a SEASON-grain lookback, so strictly season S-1.
    ctx0 = AsOfContext(season=args.season, week=1)
    prev = {r["player_id"]: r["ppg"] for r in ctx0.run(
        f"SELECT player_id, AVG(score) ppg FROM src_weekly"
        f" WHERE season = {args.season - 1} GROUP BY player_id")}
    print(f"prior-season PPG loaded for {len(prev)} players "
          f"(season {args.season - 1})\n", file=sys.stderr)

    agg = defaultdict(lambda: [0.0, 0.0, 0])   # (pos, baseline) -> [abs, signed, n]
    for wk in parse_weeks(args.weeks):
        rows = eval_week(args.season, wk, prev)
        for pos, name, ae, se in rows:
            k = (pos, name)
            agg[k][0] += ae
            agg[k][1] += se
            agg[k][2] += 1
        print(f"  W{wk}: {len(rows)} predictions scored", file=sys.stderr, flush=True)

    print(f"\nBASELINE ACCURACY — season {args.season}, weeks {args.weeks}")
    print("(next-week UPS points; lower MAE is better. pinball@0.5 == MAE/2.)\n")
    hdr = f"{'pos':>4} {'baseline':>12} {'n':>6} {'MAE':>7} {'pinball':>8} {'bias':>7}"
    print(hdr)
    print("-" * len(hdr))
    for pos in POSITIONS:
        best, bestv = None, None
        for name in BASELINES:
            a = agg.get((pos, name))
            if not a or not a[2]:
                continue
            mae = a[0] / a[2]
            if bestv is None or mae < bestv:
                best, bestv = name, mae
        for name in BASELINES:
            a = agg.get((pos, name))
            if not a or not a[2]:
                continue
            mae, bias, n = a[0] / a[2], a[1] / a[2], a[2]
            star = "  <- best" if name == best else ""
            print(f"{pos:>4} {name:>12} {n:>6} {mae:>7.3f} {mae/2:>8.3f} "
                  f"{bias:>7.3f}{star}")
        if best:
            print()
    print("Any model must beat the starred baseline for its position, out of "
          "sample, before it ships.")


if __name__ == "__main__":
    main()
