#!/usr/bin/env python3
"""Calibrate the RELIABILITY of each xFP residual component — how much of a
player's over/under-expected production is repeatable skill vs transient luck.

For Sustainable± (the projection of what carries forward) we need, per component
and per position, two numbers:
  r  — split-half reliability: of the variance in this component's per-opportunity
       over-expected RATE, how much is signal (true talent) vs noise? Estimated by
       correlating a player's ODD-week rate against his EVEN-week rate within each
       season (same player, same season, same true talent — isolates reliability,
       unlike year-over-year which also absorbs real talent drift), pooled across
       2006-2025, then Spearman-Brown stepped up to a full season:
           r_full = 2*r_half / (1 + r_half)
  k  — stabilization point: the opportunity count at which reliability hits 0.5,
       so a low-sample player's number gets shrunk harder. Derived from r_full at
       the median sample: k = n_med * (1 - r_full) / r_full.

Components (per-opportunity over-expected rate; opp = targets+carries for skill,
dropbacks for QB):
  td   — touchdowns over expected per opp        (expected: ~pure luck, r≈0)
  yds  — yards over expected per opp              (expected: modest skill)
  rec  — receptions over expected per target      (skill positions only)
  fd   — first downs over expected per opp        (minor)

Also reports YoY Pearson as a secondary "season-to-season persistence" disclosure.

Output: site/stats_workbench/xfp_reliability.json
  { "<POS>": { "<component>": {r, k, r_half, yoy_r, n_pairs, n_med_opp} }, ... }
Re-run rarely (the constants are population averages; data only grows slowly).
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REG_MAX_WEEK = 17
SEASONS = list(range(2006, 2026))
# position -> bucket
BUCKET = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR_TE", "TE": "WR_TE"}
# qualification (full season)
MIN_WEEKS = 8
MIN_OPP = {"QB": 150, "RB": 60, "WR_TE": 50}
COMPONENTS = ["td", "yds", "rec", "fd"]


def gv(r, n):
    v = r.get(n)
    return float(v) if v not in (None, "") else 0.0


def week_components(r, bucket):
    """Return {component: (residual, opportunities)} for one player-week."""
    if bucket == "QB":
        opp = gv(r, "pass_attempt")
        td = (gv(r, "pass_touchdown") - gv(r, "pass_touchdown_exp")) + (gv(r, "rush_touchdown") - gv(r, "rush_touchdown_exp"))
        yds = (gv(r, "pass_yards_gained") - gv(r, "pass_yards_gained_exp")) + (gv(r, "rush_yards_gained") - gv(r, "rush_yards_gained_exp"))
        fd = (gv(r, "pass_first_down") - gv(r, "pass_first_down_exp")) + (gv(r, "rush_first_down") - gv(r, "rush_first_down_exp"))
        return {"td": (td, opp), "yds": (yds, opp), "rec": (0.0, 0.0), "fd": (fd, opp)}
    opp = gv(r, "rec_attempt") + gv(r, "rush_attempt")
    rec_opp = gv(r, "rec_attempt")
    td = (gv(r, "rec_touchdown") - gv(r, "rec_touchdown_exp")) + (gv(r, "rush_touchdown") - gv(r, "rush_touchdown_exp"))
    yds = (gv(r, "rec_yards_gained") - gv(r, "rec_yards_gained_exp")) + (gv(r, "rush_yards_gained") - gv(r, "rush_yards_gained_exp"))
    rec = gv(r, "receptions") - gv(r, "receptions_exp")
    fd = (gv(r, "rec_first_down") - gv(r, "rec_first_down_exp")) + (gv(r, "rush_first_down") - gv(r, "rush_first_down_exp"))
    return {"td": (td, opp), "yds": (yds, opp), "rec": (rec, rec_opp), "fd": (fd, opp)}


def pearson(xs, ys):
    n = len(xs)
    if n < 10:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return num / (dx * dy) if dx * dy else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/stats_workbench/xfp_reliability.json")
    args = ap.parse_args()

    import nflreadpy as nfl
    df = nfl.load_ff_opportunity(seasons=SEASONS, stat_type="weekly")
    rows = df.to_dicts()
    print(f"[calib] {len(rows)} player-weeks {SEASONS[0]}-{SEASONS[-1]}", file=sys.stderr)

    # per (season,pid): odd/even half {component: [resid,opp]}, total {component:[resid,opp]}, weeks, bucket
    PS = defaultdict(lambda: {
        "bucket": "", "weeks": 0,
        "odd": defaultdict(lambda: [0.0, 0.0]), "even": defaultdict(lambda: [0.0, 0.0]),
        "tot": defaultdict(lambda: [0.0, 0.0]),
    })
    for r in rows:
        try:
            wk = int(r.get("week"))
        except (TypeError, ValueError):
            continue
        if wk > REG_MAX_WEEK:
            continue
        pid = r.get("player_id")
        bucket = BUCKET.get((r.get("position") or "").upper())
        if not pid or not bucket:
            continue
        comp = week_components(r, bucket)
        if not any(o for _, o in comp.values()):
            continue
        a = PS[(int(r["season"]), pid)]
        a["bucket"] = bucket
        a["weeks"] += 1
        half = "odd" if wk % 2 else "even"
        for c, (resid, opp) in comp.items():
            a[half][c][0] += resid; a[half][c][1] += opp
            a["tot"][c][0] += resid; a["tot"][c][1] += opp

    # collect per bucket/component: split-half rate pairs, season rates for YoY, season opp
    half_pairs = defaultdict(lambda: defaultdict(lambda: [[], []]))    # bucket->comp->[A,B]
    season_rate = defaultdict(lambda: defaultdict(dict))               # bucket->comp->{(s,pid):rate}
    season_opp = defaultdict(lambda: defaultdict(list))               # bucket->comp->[opp]
    for (s, pid), a in PS.items():
        b = a["bucket"]
        if a["weeks"] < MIN_WEEKS:
            continue
        for c in COMPONENTS:
            tot_opp = a["tot"][c][1]
            if tot_opp < MIN_OPP[b]:
                continue
            oo, oe = a["odd"][c][1], a["even"][c][1]
            if oo <= 0 or oe <= 0:
                continue
            half_pairs[b][c][0].append(a["odd"][c][0] / oo)
            half_pairs[b][c][1].append(a["even"][c][0] / oe)
            season_rate[b][c][(s, pid)] = a["tot"][c][0] / tot_opp
            season_opp[b][c].append(tot_opp)

    out = {}
    print("\n bucket | comp |  r_half  Spearman-Brown r | YoY r  |   k    | n     interpretation", file=sys.stderr)
    for b in ("QB", "RB", "WR_TE"):
        out[b] = {}
        for c in COMPONENTS:
            A, B = half_pairs[b][c]
            if len(A) < 10:
                continue
            rh = pearson(A, B)
            if rh is None:
                continue
            r_full = (2 * rh / (1 + rh)) if (1 + rh) != 0 else rh
            r_full = max(0.0, min(0.999, r_full))
            # YoY
            sr = season_rate[b][c]
            yx, yy = [], []
            for (s, pid), v in sr.items():
                nxt = sr.get((s + 1, pid))
                if nxt is not None:
                    yx.append(v); yy.append(nxt)
            yoy = pearson(yx, yy)
            n_med = statistics.median(season_opp[b][c]) if season_opp[b][c] else 0
            k = (n_med * (1 - r_full) / r_full) if r_full > 1e-6 else 9999.0
            out[b][c] = {
                "r": round(r_full, 4), "k": round(k, 1), "r_half": round(rh, 4),
                "yoy_r": (round(yoy, 4) if yoy is not None else None),
                "n_pairs": len(A), "n_med_opp": round(n_med, 1),
            }
            interp = "LUCK" if r_full < 0.15 else ("mixed" if r_full < 0.35 else "SKILL")
            print(f"  {b:5} | {c:4} |  {rh:+.3f}   {r_full:.3f}          | {('%+.3f'%yoy) if yoy is not None else ' n/a '} | {k:6.0f} | {len(A):4}  {interp}", file=sys.stderr)

    payload = {
        "source": "nflverse ffopportunity split-half (odd/even week) per-opportunity residual-rate reliability, Spearman-Brown stepped up; 2006-2025 weeks 1-17",
        "method": "r = split-half reliability of per-opportunity over-expected rate; k = stabilization opp count (r=0.5); yoy_r = season-to-season Pearson (disclosure).",
        "qualifiers": {"min_weeks": MIN_WEEKS, "min_opp": MIN_OPP},
        "reliability": out,
    }
    op = Path(args.out)
    op.parent.mkdir(parents=True, exist_ok=True)
    with op.open("w") as fh:
        json.dump(payload, fh, indent=1)
        fh.write("\n")
    print(f"\n[calib] wrote {op}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
