#!/usr/bin/env python3
"""BREAKOUT RADAR — lead-time measurement. Spec §10.

THE QUESTION THIS ANSWERS
=========================
Does a role-change signal flag a player BEFORE his first elite week, earlier
than simply watching his box score do it?

That is the entire premise of the system. Next-week MAE cannot test it —
by construction it only asks "how close was the points estimate", never "how
early did we know". Three of the inputs added on 2026-08-05 (injury, depth rank,
role deltas) exist *only* for this question, which is why they ablated to ~zero
on point accuracy and why that was not evidence against them.

THREE DEFINITIONS THAT DECIDE EVERYTHING
========================================
Get these wrong and the numbers are meaningless, so they are stated explicitly
rather than buried in code.

1. ELITE WEEK — a top-12 finish at the player's MFL position in that week,
   scored on realized UPS points. Top-12 because UPS starts roughly a dozen at
   the skill positions, so it is the threshold at which a player is genuinely
   startable rather than merely useful.

2. BREAKOUT — a player's FIRST elite week in a season, AND he must not already
   have been performing like a starter going into it. Without that second
   clause, every good week by an established WR1 counts as a "breakout" and the
   radar gets credit for noticing Ja'Marr Chase. Operationally: his
   season-to-date UPS PPG entering that week must sit below his position's
   24th-best PPG — i.e. he was not yet a startable asset, and therefore was
   plausibly cheap.

3. FLAG — each radar gets the SAME BUDGET: the top K players per
   (season, week, position), drawn only from the not-yet-established pool. Equal
   budget is what makes the comparison fair; a radar that flags everybody would
   otherwise win on recall by doing nothing. K=5 mirrors a realistic weekly
   waiver shortlist and the spec's "hit rate among top five".

THE RADARS COMPARED
===================
  role        the thesis — d_route_pct_l3, d_tgt_share_l3, d_snap_pct_l3 and
              depth-rank promotion. Opportunity moving before production does.
  production  the null hypothesis — recent PPG minus season PPG. This is what
              a person scanning a box score does, and it is the thing role
              signals must beat to justify their existence.
  volume      raw recent opportunity (routes_l3), no change term. Separates
              "he is playing a lot" from "he is playing MORE than he was".
  random      a floor. Any radar that cannot beat shuffled noise at equal budget
              is measuring nothing, and it is cheap to find that out.

EVERY FLAG IS AS-OF CLEAN. Radar scores come from model_player_week_features,
which is built under the leakage guard, so a flag in week W uses only weeks < W.
Elite weeks and breakouts are LABELS computed from realized results — used to
score the radars afterwards, never to produce a flag.

Usage:
  python3 pipelines/etl/scripts/breakout_radar_leadtime.py --seasons 2021-2025
  python3 pipelines/etl/scripts/breakout_radar_leadtime.py --seasons 2024 --topk 10
"""
from __future__ import annotations
import argparse
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402

ELITE_RANK = 12          # top-N at the position = an "elite" week
ESTABLISHED_RANK = 24    # already startable => not a breakout candidate
POSITIONS = ("WR", "TE", "RB", "QB")

RNG = np.random.default_rng(0)


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def _f(v, default=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if x != x else x


def load_season(season: int, weeks):
    """Feature rows + realized score for every player-week."""
    ctx = AsOfContext(season=season, week=1)
    poslist = ",".join("'" + p + "'" for p in POSITIONS)
    rows = []
    for wk in weeks:
        got = ctx.run(
            "SELECT f.gsis_id, f.player_name, f.mfl_pos, f.week,"
            " f.d_route_pct_l3, f.d_tgt_share_l3, f.d_snap_pct_l3,"
            " f.d_depth_rank, f.depth_rank, f.routes_l3, f.routes_std,"
            " f.ups_ppg_l3, f.ups_ppg_std, s.score"
            " FROM model_player_week_features f"
            " JOIN ff_player_ids p ON p.gsis_id = f.gsis_id"
            " JOIN src_weekly s ON s.player_id = CAST(p.mfl_id AS INTEGER)"
            f"  AND s.season = {season} AND s.week = {wk}"
            f" WHERE f.season = {season} AND f.week = {wk}"
            f"   AND f.mfl_pos IN ({poslist}) AND s.score IS NOT NULL")
        rows += got
        print(f"  {season} W{wk}: {len(got)}", file=sys.stderr, flush=True)
    return rows


def radar_scores(r):
    """Each radar's score for one player-week. Higher = more interesting."""
    # ROLE: opportunity moving. Depth promotion is negative when promoted
    # (rank 1 is the starter), so it is negated to point the same way.
    role = (_f(r.get("d_route_pct_l3")) * 3.0
            + _f(r.get("d_tgt_share_l3")) * 3.0
            + _f(r.get("d_snap_pct_l3")) * 1.0
            - _f(r.get("d_depth_rank")) * 0.15)
    # PRODUCTION: the box score already moved. The null hypothesis.
    prod = _f(r.get("ups_ppg_l3")) - _f(r.get("ups_ppg_std"))
    # VOLUME: level, not change.
    vol = _f(r.get("routes_l3"))
    return {"role": role, "production": prod, "volume": vol,
            "random": float(RNG.random())}


def analyse(season: int, weeks, topk: int):
    rows = load_season(season, weeks)
    if not rows:
        return None

    by_week = defaultdict(list)
    for r in rows:
        by_week[r["week"]].append(r)

    # ── labels: elite weeks, and the established threshold per position ────
    elite = set()                      # (gsis, week)
    established = {}                   # (pos, week) -> PPG cutoff
    for wk, rs in by_week.items():
        for pos in POSITIONS:
            p = [x for x in rs if x["mfl_pos"] == pos]
            if not p:
                continue
            for x in sorted(p, key=lambda z: -_f(z["score"]))[:ELITE_RANK]:
                elite.add((x["gsis_id"], wk))
            ppg = sorted((_f(x["ups_ppg_std"], -1) for x in p), reverse=True)
            established[(pos, wk)] = (ppg[ESTABLISHED_RANK - 1]
                                      if len(ppg) >= ESTABLISHED_RANK else -1)

    # ── breakouts: FIRST elite week for a not-yet-established player ───────
    first_elite = {}
    for (g, wk) in sorted(elite, key=lambda t: t[1]):
        first_elite.setdefault(g, wk)
    breakout = {}
    for r in rows:
        g, wk = r["gsis_id"], r["week"]
        if first_elite.get(g) != wk:
            continue
        cut = established.get((r["mfl_pos"], wk), -1)
        if _f(r["ups_ppg_std"], -1) < cut:      # not already startable
            breakout[g] = wk

    # ── flags: equal budget per radar ─────────────────────────────────────
    names = ("role", "production", "volume", "random")
    first_flag = {n: {} for n in names}
    flagged_any = {n: set() for n in names}
    for wk in sorted(by_week):
        for pos in POSITIONS:
            pool = [x for x in by_week[wk] if x["mfl_pos"] == pos
                    and _f(x["ups_ppg_std"], -1) < established.get((pos, wk), -1)]
            if not pool:
                continue
            scored = [(x, radar_scores(x)) for x in pool]
            for n in names:
                for x, sc in sorted(scored, key=lambda t: -t[1][n])[:topk]:
                    g = x["gsis_id"]
                    flagged_any[n].add(g)
                    first_flag[n].setdefault(g, wk)
    return breakout, first_flag, flagged_any, len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2021-2025")
    ap.add_argument("--weeks", default="5-17")
    ap.add_argument("--topk", type=int, default=5,
                    help="Flags per position per week, per radar. Equal budget "
                         "is what makes the radars comparable.")
    args = ap.parse_args()
    a, b = (args.weeks.split("-") + [args.weeks])[:2]
    weeks = range(int(a), int(b) + 1)

    names = ("role", "production", "volume", "random")
    tot = {n: defaultdict(int) for n in names}
    lead_sum = {n: [] for n in names}
    n_break = 0
    n_flagged = {n: 0 for n in names}

    for season in parse_seasons(args.seasons):
        got = analyse(season, weeks, args.topk)
        if not got:
            continue
        breakout, first_flag, flagged_any, nrows = got
        n_break += len(breakout)
        for n in names:
            n_flagged[n] += len(flagged_any[n])
            for g, bw in breakout.items():
                fw = first_flag[n].get(g)
                if fw is None:
                    tot[n]["never"] += 1
                elif fw >= bw:
                    tot[n]["after"] += 1
                else:
                    lead = bw - fw
                    lead_sum[n].append(lead)
                    if lead >= 5:
                        tot[n]["5plus"] += 1
                    elif lead >= 2:
                        tot[n]["2to4"] += 1
                    else:
                        tot[n]["1wk"] += 1
        print(f"[{season}] {len(breakout)} breakouts from {nrows} player-weeks",
              file=sys.stderr, flush=True)

    if not n_break:
        sys.exit("no breakouts identified — check the definitions")

    print(f"\nBREAKOUT RADAR LEAD TIME — {n_break} breakouts, "
          f"top-{args.topk} flags per position-week\n")
    hdr = (f"{'radar':>12} {'5+ wk':>7} {'2-4 wk':>7} {'1 wk':>6} "
           f"{'after':>7} {'never':>7} {'RECALL':>8} {'players':>8} "
           f"{'PRECISION':>10} {'mean lead':>10}")
    print(hdr)
    print("-" * len(hdr))
    for n in names:
        t = tot[n]
        early = t["5plus"] + t["2to4"] + t["1wk"]
        lead = float(np.mean(lead_sum[n])) if lead_sum[n] else 0.0
        # PRECISION is the decision-relevant number: of the distinct players
        # this radar ever put on the shortlist, what share went on to break out
        # AFTER being flagged? That is the roster spot you actually spent.
        prec = early / max(n_flagged[n], 1)
        print(f"{n:>12} {t['5plus']:>7} {t['2to4']:>7} {t['1wk']:>6} "
              f"{t['after']:>7} {t['never']:>7} {100*early/n_break:>7.1f}% "
              f"{n_flagged[n]:>8} {100*prec:>9.1f}% {lead:>10.2f}")

    print("\n⚠️ READ PRECISION, NOT RECALL.")
    print("RECALL (share of breakouts caught early) is CONFOUNDED BY HOW MANY")
    print("DISTINCT PLAYERS A RADAR FLAGS. Flags accumulate over the season, so")
    print("over 13 weeks even random selection eventually shortlists a large")
    print("fraction of the pool and racks up recall for free — the top-K budget")
    print("is equal PER WEEK, but the distinct-player count is not.")
    print("\nPRECISION = of the distinct players a radar shortlisted, the share")
    print("that broke out AFTER being flagged. That is budget-fair, and it is")
    print("the quantity that maps to a real decision: a roster spot spent.")
    print("\n'random' is the floor. A radar that cannot beat shuffled noise on")
    print("PRECISION is measuring nothing, whatever its recall says.")


if __name__ == "__main__":
    main()
