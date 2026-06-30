#!/usr/bin/env python3
"""Expected Fantasy Points (xFP), LEAGUE-SCORED, for the Stats Workbench.

Source : nflverse ffopportunity via nflreadpy.load_ff_opportunity(stat_type="weekly").
         It ships, per player-week, both EXPECTED (`*_exp`) and ACTUAL component
         stats (receptions, yards, TDs, first downs, 2pt) — so we re-score BOTH
         under OUR exact league rules (validate_scoring_alignment.py:55-65):
           pass yds ×0.04 + 300/375/425 tier; pass TD 6; INT −2; 2pt 2
           rush yds ×0.1  + 100/150/200/250 tier; rush TD 6
           rec  yds ×0.1  + 100/150/200 tier; rec TD 6; receptions ×PPR
           first downs (pass+rush+rec) ×0.2 ; PPR = TE 1.5 / RB 0.8 / WR-QB 1.0
         (Sacks/fumbles aren't opportunity-modeled, so excluded from BOTH — they
         cancel in the ± and aren't part of expected-opportunity anyway.)

Output : site/stats_workbench/nfl_xfp_<season>.json — one row per offensive player
         keyed by gsis_id: total expected xFP + role split + opportunity games.
         The ± (over/under-his-opportunity regression signal) is computed in the
         WORKBENCH as (official MFL actual − xFP), over MFL's game denominator —
         that ties the ± to the MFL Pts / MFL PPG columns the user sees, and uses
         the league's authoritative actual rather than a re-score of ffopportunity's
         own actual components (which differ from MFL by stat-source by a point or
         two). Negative ± = left points on the table vs his usage (buy / positive-
         regression lean); positive ± = outproduced his opportunity (sell lean).

Weeks 1-17 only — our FANTASY season (reg + playoffs Wk15-17). NFL week 18 is NOT
scored by the league, so including it inflated totals and game counts (verified: ≤17
matches MFL's per-player game count 24/24; ≤18 only 5/24). Joins by gsis_id like EPA.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

REG_MAX_WEEK = 17  # our fantasy season is weeks 1-17; NFL week 18 isn't scored


def tier(v, ts):
    b = 0
    for lo, p in ts:
        if v >= lo:
            b = p
    return b


def score_offense(get, pos):
    """get(name) -> component value; pos for PPR. Mirrors compute() offense block."""
    pos = (pos or "").upper()
    ppr = 1.5 if pos == "TE" else (0.8 if pos == "RB" else 1.0)
    pass_y = get("pass_yards_gained")
    rush_y = get("rush_yards_gained")
    rec_y = get("rec_yards_gained")
    p = 0.0
    p += pass_y * 0.04 + tier(pass_y, [(300, 1), (375, 2), (425, 3)])
    p += get("pass_touchdown") * 6 + get("pass_interception") * -2 + get("pass_two_point_conv") * 2
    p += rush_y * 0.1 + tier(rush_y, [(100, 1), (150, 2), (200, 3), (250, 5)])
    p += get("rush_touchdown") * 6 + get("rush_two_point_conv") * 2
    p += rec_y * 0.1 + tier(rec_y, [(100, 2), (150, 3), (200, 5)])
    p += get("rec_touchdown") * 6 + get("rec_two_point_conv") * 2 + get("receptions") * ppr
    p += (get("pass_first_down") + get("rush_first_down") + get("rec_first_down")) * 0.2
    # role split (for context)
    pass_p = pass_y * 0.04 + tier(pass_y, [(300, 1), (375, 2), (425, 3)]) + get("pass_touchdown") * 6 \
        + get("pass_interception") * -2 + get("pass_two_point_conv") * 2 + get("pass_first_down") * 0.2
    rush_p = rush_y * 0.1 + tier(rush_y, [(100, 1), (150, 2), (200, 3), (250, 5)]) + get("rush_touchdown") * 6 \
        + get("rush_two_point_conv") * 2 + get("rush_first_down") * 0.2
    rec_p = p - pass_p - rush_p
    return p, pass_p, rush_p, rec_p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--out", default="site/stats_workbench/nfl_xfp_2025.json")
    args = ap.parse_args()

    try:
        import nflreadpy as nfl
    except Exception as e:  # noqa: BLE001
        print(f"[xfp] nflreadpy unavailable: {e}", file=sys.stderr)
        return 1
    df = nfl.load_ff_opportunity(seasons=[args.season], stat_type="weekly")
    rows = df.to_dicts() if hasattr(df, "to_dicts") else list(df.iter_rows(named=True))
    print(f"[xfp] {len(rows)} player-weeks for {args.season}", file=sys.stderr)

    agg = defaultdict(lambda: {"xfp": 0.0, "g": 0, "name": "", "pos": "",
                               "xpass": 0.0, "xrush": 0.0, "xrec": 0.0})
    for r in rows:
        wk = r.get("week")
        try:
            if int(wk) > REG_MAX_WEEK:
                continue
        except (TypeError, ValueError):
            continue
        gid = r.get("player_id")
        if not gid:
            continue
        pos = r.get("position") or ""

        def fexp(name, _r=r):
            v = _r.get(name + "_exp")
            return float(v) if v not in (None, "") else 0.0

        xfp, xp, xr, xc = score_offense(fexp, pos)
        # only count a "game" if there was real opportunity that week
        had = any(fexp(n) for n in ("pass_yards_gained", "rush_yards_gained", "rec_yards_gained", "receptions"))
        a = agg[gid]
        a["xfp"] += xfp; a["xpass"] += xp; a["xrush"] += xr; a["xrec"] += xc
        if had:
            a["g"] += 1
        a["name"] = r.get("full_name") or a["name"]
        a["pos"] = pos or a["pos"]

    out = []
    for gid, a in agg.items():
        out.append({
            "gsis_id": gid, "name": a["name"], "position": (a["pos"] or "").upper(), "season": args.season,
            "games": a["g"],
            "xfp": round(a["xfp"], 1),
            "xfp_pass": round(a["xpass"], 1), "xfp_rush": round(a["xrush"], 1), "xfp_rec": round(a["xrec"], 1),
        })
    out = [r for r in out if r["games"] > 0]
    out.sort(key=lambda r: -r["xfp"])
    payload = {
        "season": args.season,
        "source": "nflverse ffopportunity (load_ff_opportunity) — expected components re-scored under UPS league rules",
        "metric": "Expected Fantasy Points (league-scored), weeks 1-17 (fantasy season). The ± vs actual is computed in the workbench against official MFL points.",
        "count": len(out),
        "players": out,
    }
    op = Path(args.out)
    op.parent.mkdir(parents=True, exist_ok=True)
    with op.open("w") as fh:
        json.dump(payload, fh, indent=1)
        fh.write("\n")
    print(f"[xfp] wrote {len(out)} players → {op}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
