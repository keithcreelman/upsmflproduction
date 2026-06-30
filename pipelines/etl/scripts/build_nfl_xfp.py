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
         keyed by gsis_id: total expected xFP + role split + opportunity games, PLUS the
         residual decomposition (td_diff = scoring-event LUCK, eff_diff = yards+receptions
         SKILL, fd_diff) and sustainable_diff (the reliability-weighted, sample-shrunk skill
         residual from xfp_reliability.json — the part projected to carry forward). The ±/
         scaling to official MFL points and the Buy/Hold/Sell verdict happen in the workbench.
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


BUCKET = {"QB": "QB", "RB": "RB", "FB": "RB", "HB": "RB", "WR": "WR_TE", "TE": "WR_TE"}

# Fallback reliability (r, k) per bucket/component if the calibration file is absent.
# Mirrors calibrate_xfp_reliability.py output (split-half Spearman-Brown, 2006-2025).
DEFAULT_RELIABILITY = {
    "QB":    {"td": (0.00, 9999.0), "yds": (0.39, 727.0), "rec": (0.00, 9999.0), "fd": (0.39, 718.0)},
    "RB":    {"td": (0.10, 1516.0), "yds": (0.33, 341.0), "rec": (0.53, 64.0),   "fd": (0.19, 729.0)},
    "WR_TE": {"td": (0.27, 235.0),  "yds": (0.64, 48.0),  "rec": (0.80, 22.0),   "fd": (0.67, 42.0)},
}


def load_reliability(path):
    """{bucket: {component: (r, k)}} from the calibration JSON, defaults filled in."""
    out = {b: dict(c) for b, c in DEFAULT_RELIABILITY.items()}
    try:
        rel = json.loads(Path(path).read_text()).get("reliability", {})
        for b, comps in rel.items():
            out.setdefault(b, {})
            for c, v in comps.items():
                if v.get("r") is not None and v.get("k") is not None:
                    out[b][c] = (float(v["r"]), float(v["k"]))
    except Exception:  # noqa: BLE001 — fall back to constants
        pass
    return out


def component_points(get, pos):
    """Per-week league-scored points split by component (td / yds / rec / fd / misc).
    Call once with the EXPECTED closure and once with the ACTUAL closure and difference
    the components — the five sum to score_offense's offense total, so the diffs sum to
    (actual - expected). Tier bonuses stay inside `yds` (a yardage phenomenon)."""
    pos = (pos or "").upper()
    ppr = 1.5 if pos == "TE" else (0.8 if pos == "RB" else 1.0)
    py = get("pass_yards_gained"); ry = get("rush_yards_gained"); cy = get("rec_yards_gained")
    td = (get("pass_touchdown") + get("rush_touchdown") + get("rec_touchdown")) * 6
    yds = (py * 0.04 + tier(py, [(300, 1), (375, 2), (425, 3)])
           + ry * 0.1 + tier(ry, [(100, 1), (150, 2), (200, 3), (250, 5)])
           + cy * 0.1 + tier(cy, [(100, 2), (150, 3), (200, 5)]))
    rec = get("receptions") * ppr
    fd = (get("pass_first_down") + get("rush_first_down") + get("rec_first_down")) * 0.2
    misc = get("pass_interception") * -2 + (get("pass_two_point_conv") + get("rush_two_point_conv") + get("rec_two_point_conv")) * 2
    return {"td": td, "yds": yds, "rec": rec, "fd": fd, "misc": misc}


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

    reliability = load_reliability("site/stats_workbench/xfp_reliability.json")

    agg = defaultdict(lambda: {"xfp": 0.0, "g": 0, "name": "", "pos": "",
                               "xpass": 0.0, "xrush": 0.0, "xrec": 0.0,
                               "td_d": 0.0, "yds_d": 0.0, "rec_d": 0.0, "fd_d": 0.0, "misc_d": 0.0,
                               "opps": 0.0, "rec_opps": 0.0,
                               "td_oe": 0.0, "yds_oe": 0.0, "rec_oe": 0.0})
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

        def fact(name, _r=r):
            v = _r.get(name)
            return float(v) if v not in (None, "") else 0.0

        xfp, xp, xr, xc = score_offense(fexp, pos)
        ep = component_points(fexp, pos)
        ap = component_points(fact, pos)
        # only count a "game" if there was real opportunity that week
        had = any(fexp(n) for n in ("pass_yards_gained", "rush_yards_gained", "rec_yards_gained", "receptions"))
        a = agg[gid]
        a["xfp"] += xfp; a["xpass"] += xp; a["xrush"] += xr; a["xrec"] += xc
        for c, key in (("td", "td_d"), ("yds", "yds_d"), ("rec", "rec_d"), ("fd", "fd_d"), ("misc", "misc_d")):
            a[key] += ap[c] - ep[c]
        bucket = BUCKET.get(pos.upper())
        a["opps"] += fact("pass_attempt") if bucket == "QB" else (fact("rec_attempt") + fact("rush_attempt"))
        a["rec_opps"] += fact("rec_attempt")
        a["td_oe"] += (fact("pass_touchdown") + fact("rush_touchdown") + fact("rec_touchdown")) \
            - (fexp("pass_touchdown") + fexp("rush_touchdown") + fexp("rec_touchdown"))
        a["yds_oe"] += (fact("pass_yards_gained") + fact("rush_yards_gained") + fact("rec_yards_gained")) \
            - (fexp("pass_yards_gained") + fexp("rush_yards_gained") + fexp("rec_yards_gained"))
        a["rec_oe"] += fact("receptions") - fexp("receptions")
        if had:
            a["g"] += 1
        a["name"] = r.get("full_name") or a["name"]
        a["pos"] = pos or a["pos"]

    out = []
    for gid, a in agg.items():
        pos = (a["pos"] or "").upper()
        rel = reliability.get(BUCKET.get(pos, "WR_TE"), {})
        opps, recopps = a["opps"], a["rec_opps"]

        def shrink(c, n):
            r_c, k_c = rel.get(c, (0.0, 9999.0))
            return r_c * (n / (n + k_c)) if (n + k_c) > 0 else 0.0

        # Sustainable± = reliability-weighted, sample-shrunk skill residual (misc = luck → 0).
        sustainable = (a["td_d"] * shrink("td", opps) + a["yds_d"] * shrink("yds", opps)
                       + a["rec_d"] * shrink("rec", recopps) + a["fd_d"] * shrink("fd", opps))
        modeled_total = a["td_d"] + a["yds_d"] + a["rec_d"] + a["fd_d"] + a["misc_d"]
        out.append({
            "gsis_id": gid, "name": a["name"], "position": pos, "season": args.season,
            "games": a["g"],
            "xfp": round(a["xfp"], 1),
            "xfp_pass": round(a["xpass"], 1), "xfp_rush": round(a["xrush"], 1), "xfp_rec": round(a["xrec"], 1),
            # decomposition (modeled, league-scored; scaled to official ± in the workbench)
            "td_diff": round(a["td_d"] + a["misc_d"], 1),   # scoring-event (luck) bucket
            "eff_diff": round(a["yds_d"] + a["rec_d"], 1),  # yards+receptions (skill) bucket
            "fd_diff": round(a["fd_d"], 1),
            "modeled_diff": round(modeled_total, 1),
            "sustainable_diff": round(sustainable, 1),
            "opps": round(opps, 1), "rec_opps": round(recopps, 1),
            "td_oe_per_opp": round(a["td_oe"] / opps, 4) if opps else None,
            "yds_oe_per_opp": round(a["yds_oe"] / opps, 3) if opps else None,
            "rec_oe_per_tgt": round(a["rec_oe"] / recopps, 4) if recopps else None,
        })
    out = [r for r in out if r["games"] > 0]
    out.sort(key=lambda r: -r["xfp"])
    payload = {
        "season": args.season,
        "source": "nflverse ffopportunity (load_ff_opportunity) — expected components re-scored under UPS league rules",
        "metric": "Expected Fantasy Points (league-scored), weeks 1-17. The ± vs actual is computed in the workbench vs official MFL points. Decomposition (td_diff=scoring-event luck, eff_diff=yards+receptions skill, fd_diff) and sustainable_diff (reliability-weighted, sample-shrunk via xfp_reliability.json) are MODELED (ffopp actual-expected); the workbench scales them to the official ±.",
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
