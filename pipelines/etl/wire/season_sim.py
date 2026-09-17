#!/usr/bin/env python3
"""Preseason Monte Carlo for UPS: expected all-play %, projected record, and
division / playoff / bye / title odds for every franchise.

    python pipelines/etl/wire/season_sim.py --season 2026
    python pipelines/etl/wire/season_sim.py --season 2026 --runs 20000 --out site/wire/packs/2026/season_sim_2026.json

WHY (Keith 2026-09-11): "is my data setup in a way to run simulations to
determine the preseason rankings?" -- and the Wire's team reviews hold their
Pre Season Power Rankings until this exists and is checked.

THE MODEL, and where every piece comes from:
  * Rosters: MFL `rosters` export, ACTIVE roster only (taxi and IR cannot start).
  * Weekly points: MFL `projectedScores` for weeks 1-17 under this league's own
    scoring (the export is league-scoped), every position incl. K, P and IDP.
  * Lineups: each team's best legal 18-man lineup EVERY WEEK from that week's
    projections, via lineup_engine (the same slot rules the app enforces), so
    bye weeks and projected absences cost what they should.
  * Schedule: MFL `schedule` export -- 37 regular-season games in weeks 1-14,
    two or three per team per week, five against each division rival.
  * Randomness, two layers, both CALIBRATED to this league's own history:
      weekly  -- a team's score swings around its projection; sigma_w is set so
                 the simulated week-to-week spread matches D1's actual within-
                 team-season variance of weekly scores (regular seasons
                 2021-2025).
      season  -- a team is better or worse than its projection all year
                 (projection error, injuries, in-season moves); sigma_s is
                 chosen by a grid search so the simulated spread of season
                 all-play % across the twelve teams matches the real spread.
  * Rules: division winners by MFL's 2026 standingsSort (PCT, DIVPCT, H2H, PTS,
    ALL_PLAY_PCT); six-team playoff; seeds 1-2 are the top two division winners
    by all-play %, seeds 3-6 the rest by all-play % (league_context F.1); byes
    for 1 and 2; weeks 15-17; single matchups.

WHAT IT CANNOT SEE: trades and waiver moves after today, owners' real lineup
choices (it starts the projected-best lineup every week), and any head-to-head
tiebreak inside a division (it goes straight to points). A preseason projection,
not a prophecy -- say so wherever it is printed.

Stdlib only, invoked by path.
"""

import argparse
import hashlib
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lineup_engine as LE  # noqa: E402

MFL = "https://www48.myfantasyleague.com/%d/export?TYPE=%s&L=74598&JSON=1%s"
MFL_PLAYERS = "https://api.myfantasyleague.com/%d/export?TYPE=players&JSON=1"
MFL_BYES = "https://api.myfantasyleague.com/%d/export?TYPE=nflByeWeeks&JSON=1"
MFL_INJURIES = "https://api.myfantasyleague.com/%d/export?TYPE=injuries&JSON=1"   # no L=

# KNOWN ABSENCES (Keith 2026-09-11: "review all injuries that have occurred
# thus far. Sam Darnold no mention of injury and impact"). MFL's projections do
# not price an injury on their own: the 2026-09-11 cache still projected Brock
# Bowers (Out, meniscus) for week one and Darnold for weeks two to four. So the
# forecast removes a player's projection for every week he is listed out:
#   * MFL's injury feed, status Out / IR* / Suspended / Holdout / RETIRED, for
#     every week whose Sunday falls before his expected-return DATE;
#   * with no return date: IR is the NFL's four-game minimum, anything else
#     the current week only;
#   * Questionable and Doubtful change nothing -- most of them play;
#   * REPORTED_ABSENCES: a reported absence MFL has not listed yet, each with
#     its source. Remove an entry the moment MFL lists the player.
ABSENT_STATUSES = ("Out", "IR", "IR-R", "IR-PUP", "IR-NFI", "Suspended", "Holdout", "RETIRED")
NFL_IR_MIN_GAMES = 4
WEEK1_SUNDAY = {2026: date(2026, 9, 13)}
REPORTED_ABSENCES = {2026: {
    "13592": {"weeks": [2], "status": "Reported out", "details": "Right hip",
              "source": "Sam Darnold was hurt on Seattle's first drive of the opener (2026-09-09); NFL "
                        "Network, 2026-09-10: expected to miss week 2. Not in MFL's injury feed as of "
                        "2026-09-11 12:01 UTC."},
    "14104": {"weeks": [2, 3, 4], "status": "Reported out", "details": "Right high-ankle sprain",
              "source": "A.J. Brown left the opener (2026-09-09) in the third quarter with a right high-ankle "
                        "sprain, MRI-confirmed 2026-09-10; NFL Network (Rapoport, via ESPN) reports at least four "
                        "weeks, other reports three to six. Weeks 2-4 only are held out. Not in MFL's injury feed "
                        "as of 2026-09-11 12:01 UTC."},
}}

# Calibration targets, measured on prod D1 2026-09-11 (regular season only):
#   within-team-season variance of weekly team score, 2021-2025   943.2
#   variance of season all-play % across the 12 teams, mean of the
#   2021-2025 seasons (0.0224, 0.0266, 0.0218, 0.0301, 0.0180)     0.0238
TARGET_WITHIN_VAR = 943.2
TARGET_AP_VAR = 0.0238
SIGMA_S_GRID = (0, 4, 8, 12, 16, 20, 24, 28, 32)


def _as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


# A LIVE FORECAST READS TODAY. The cache exists so a backtest can resume after
# MFL's rate limit, but the 2026-09-12 forecast ran on a cache written the
# morning before: rosters, projections and an injury feed that still had
# Jonathan Greenard and Teddye Buchanan Questionable when MFL had them Out, while
# the team reviews beside it showed them Out. run() sets the season; any cached
# export for it older than LIVE_MAX_AGE_HOURS is fetched again.
LIVE_SEASON = None
LIVE_MAX_AGE_HOURS = 3


def fetch(url, cache_dir=None):
    key = hashlib.sha1(url.encode()).hexdigest()[:16]
    path = os.path.join(cache_dir, key + ".json") if cache_dir else None
    stale = (path and LIVE_SEASON and "/%d/" % LIVE_SEASON in url and os.path.exists(path)
             and time.time() - os.path.getmtime(path) > LIVE_MAX_AGE_HOURS * 3600)
    if path and os.path.exists(path) and not stale:
        return json.load(open(path, encoding="utf-8"))
    req = urllib.request.Request(url, headers={"User-Agent": "ups-season-sim"})
    # A backtest pulls ~150 exports; MFL answers a burst with 429 and keeps
    # refusing for minutes. Pace fresh requests, honour Retry-After, and wait
    # up to ~20 minutes in all before failing. Cached responses skip all this,
    # so a rerun resumes where the last one stopped.
    for attempt in range(8):
        time.sleep(1.5)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            if e.code != 429 or attempt == 7:
                raise
            retry_after = e.headers.get("Retry-After") if e.headers else None
            wait = int(retry_after) if (retry_after or "").isdigit() else min(300, 15 * 2 ** attempt)
            print("season_sim: MFL 429, waiting %ds" % wait, file=sys.stderr, flush=True)
            time.sleep(wait)
    if path:
        os.makedirs(cache_dir, exist_ok=True)
        json.dump(data, open(path, "w", encoding="utf-8"))
    return data


def load_inputs(season, cache_dir=None, roster_week=None, include_ir=False):
    """roster_week=None is today's roster; the backtest passes 1 for the roster a
    past season actually opened with (MFL serves real point-in-time rosters for
    2021+: 2025's week-1 and week-14 rosters differ by 354 players)."""
    league = fetch(MFL % (season, "league", ""), cache_dir)["league"]
    reg_end = int(league.get("lastRegularSeasonWeek") or 14)
    end = int(league.get("endWeek") or 17)
    fr = _as_list(league["franchises"]["franchise"])
    teams = {f["id"]: {"name": f.get("name"), "division": f.get("division")} for f in fr}
    pos = {p["id"]: p.get("position") for p in fetch(MFL_PLAYERS % season, cache_dir)["players"]["player"]}

    rosters, rostered, ir_pids = {}, set(), set()
    rw = "&W=%d" % roster_week if roster_week else ""
    for f in _as_list(fetch(MFL % (season, "rosters", rw), cache_dir)["rosters"]["franchise"]):
        rows = []
        for p in _as_list(f.get("player")):
            if not p:
                continue
            rostered.add(p["id"])          # any status: taxi and IR are not free agents
            # IR PLAYERS COME BACK. The first version dropped every injured-reserve
            # player for all fourteen weeks, return date or not: Josh Jacobs, back in
            # week three with 171 projected points, never started for HammerTime
            # (the 2026-09-12 review measured 3.9 points a week). The live forecast
            # now keeps them in the pool and lets absences() zero the weeks they miss;
            # the backtest does not, because MFL's injury feed only knows today.
            if p.get("status") == "INJURED_RESERVE" and include_ir:
                ir_pids.add(p["id"])
            elif p.get("status") != "ROSTER":
                continue
            rows.append({"pid": p["id"], "pos": pos.get(p["id"], ""), "is_taxi": False, "is_ir": False})
        rosters[f["id"]] = rows

    sched = {}
    for w in _as_list(fetch(MFL % (season, "schedule", ""), cache_dir)["schedule"]["weeklySchedule"]):
        wk = int(w["week"])
        if wk > reg_end:
            continue
        sched[wk] = [tuple(x["id"] for x in m["franchise"]) for m in _as_list(w.get("matchup"))]

    proj = {}
    for wk in range(1, end + 1):
        rows = _as_list(fetch(MFL % (season, "projectedScores", "&W=%d" % wk), cache_dir)
                        ["projectedScores"].get("playerScore"))
        proj[wk] = {r["id"]: float(r["score"]) for r in rows if r.get("id") and r.get("score") not in (None, "")}
        if not proj[wk]:
            raise SystemExit("season_sim: MFL returned no projections for week %d -- refusing to "
                             "simulate a week as if everyone scores zero" % wk)
    return league, teams, rosters, sched, proj, reg_end, end, pos, rostered, ir_pids


# REPLACEMENT LEVEL. The first run left thin rosters' dead slots dead for all
# fourteen weeks -- Gride, with eight active defenders for seven defensive
# slots and an unprojected punter, started 35 zero-point slot-weeks and
# projected thirty points a week below the field. No owner plays a season like
# that: he picks someone up. So a slot is worth at least what the waiver wire
# offers at that position -- a season-long pickup (see replacement_levels).
#
# HOW DEEP INTO THE WIRE, by position -- the main dial on the whole ranking:
#   offense  3rd-best free agent.  Offense barely uses it (0-10 of 252 starter
#            slot-weeks per team): rostered skill players almost always beat it.
#   K / P    6th-best.  Most teams stream these; half the league is shopping.
#   DL/LB/DB 12th-best -- one per team. MFL projects free-agent defenders above
#            many rostered starters (the league's own finding: about half of
#            top-24 defenders come off the wire), but twelve owners filling
#            seven defensive slots each are drawing on the same small pool, so
#            "everyone gets the third-best DB" overstated it badly: at rank 3,
#            55-146 of 252 starter slot-weeks per team went to the wire.
REPLACEMENT_RANK_BY_GROUP = {"QB": 3, "RB": 3, "WR": 3, "TE": 3, "PK": 6, "PN": 6,
                             "DL": 12, "LB": 12, "DB": 12}
# How many replacement bodies each position group may contribute: enough to
# fill every slot that group can play (its fixed slots plus the flexes).
_REP_DEPTH = {"QB": 2, "RB": 5, "WR": 5, "TE": 4, "PK": 1, "PN": 1, "DL": 3, "LB": 3, "DB": 3}


def replacement_levels(proj, pos, rostered, end, reg_end):
    """{week: {group: [points of each replacement body]}}.

    SEASON-LONG pickups, not weekly streaming. The first version took the
    third-best free agent EACH WEEK, which let every team stream five positions
    all season -- 55 to 146 of 252 starting slot-weeks went to "the wire" and
    the whole field squeezed together. Real owners make a pickup and keep him.
    So each position's replacement bodies are fixed real players -- the
    Nth-best unrostered player by season-long projection (N per position in
    REPLACEMENT_RANK_BY_GROUP), and the next ones down for deeper groups -- and
    they carry their OWN weekly
    projections, byes included. Depth per group: REPLACEMENT_RANK_BY_GROUP."""
    totals = {}
    for wk in range(1, reg_end + 1):
        for pid, pts in proj[wk].items():
            if pid not in rostered:
                totals[pid] = totals.get(pid, 0.0) + pts
    bodies = {}
    for g, depth in _REP_DEPTH.items():
        ranked = sorted((pid for pid in totals if LE.pos_group(pos.get(pid, "")) == g),
                        key=lambda pid: -totals[pid])
        rank = REPLACEMENT_RANK_BY_GROUP[g]
        bodies[g] = ranked[rank - 1:rank - 1 + depth]
    return {wk: {g: [proj[wk].get(pid, 0.0) for pid in bodies[g]] for g in _REP_DEPTH}
            for wk in range(1, end + 1)}


# WHERE A TEAM'S POINTS COME FROM. Keith 2026-09-12, on Cleon Ca$h ranking 8th
# with the third-best offense: "This tells me something is wrong with the
# forecast because defense isn't that big of a factor based on your prior
# analysis." It is a fair challenge and the answer is in the slots: nine of the
# eighteen a team starts are defenders, a kicker and a punter. The tier study is
# still right that the TOP of defense is flat -- you cannot buy an edge there --
# but a team can be short at all nine at once, and this split shows who is.
SLOT_SIDES = {"O": ("QB1", "RB1", "RB2", "WR1", "WR2", "TE1", "OF1", "OF2", "SF1"),
              "D": ("DL1", "DL2", "LB1", "LB2", "DB1", "DB2", "DF1"),
              "K": ("PK1", "PN1")}


def weekly_projections(rosters, proj, end, rep=None, reg_end=None):
    """({fid: {week: projected points of the best legal lineup}},
        {fid: replacement slot-weeks},
        {fid: {"O"/"D"/"K": projected points a week from those slots}}).

    The pool is the active roster plus replacement-level bodies (see
    REPLACEMENT_RANK_BY_GROUP); a replacement only starts where it beats every eligible
    rostered player, and each start is counted so the reviews can say how often
    a team is leaning on the wire."""
    out, fills, parts = {}, {}, {}
    for fid, rows in rosters.items():
        out[fid], fills[fid] = {}, 0
        parts[fid] = {"O": 0.0, "D": 0.0, "K": 0.0}
        for wk in range(1, end + 1):
            pw = dict(proj[wk])
            pool = list(rows)
            if rep:
                for g, vals in rep[wk].items():
                    for i, v in enumerate(vals):
                        rid = "REP:%s:%d" % (g, i)
                        pw[rid] = v
                        pool.append({"pid": rid, "pos": g, "is_taxi": False, "is_ir": False})
            slots = LE.fill_slots(pool, lambda r, pw=pw: pw.get(r["pid"], 0.0))
            out[fid][wk] = sum(pw.get(pid, 0.0) for pid in slots.values() if pid)
            fills[fid] += sum(1 for pid in slots.values() if pid and pid.startswith("REP:"))
            # The split must cover the SAME weeks as the total it sits beside
            # (weeks 1 to the end of the regular season). The first version
            # averaged 1-17 against a 1-14 total, so no row of the table added up.
            if wk <= (reg_end or end):
                for side, ids in SLOT_SIDES.items():
                    parts[fid][side] += sum(pw.get(slots.get(sid), 0.0) for sid in ids if slots.get(sid))
    for fid in parts:
        for side in parts[fid]:
            parts[fid][side] = round(parts[fid][side] / float(reg_end or end), 1)
    return out, fills, parts


# REGRESSION TO THE MEAN (Keith 2026-09-11: "there probably needs to be some
# level of regressions with the simulation"). A preseason projection is an
# estimate, and estimates of who is good overshoot: the favourites come back
# toward the pack more often than they pull away, and so do the long shots.
# Each week every team's projected edge over that week's league average is
# multiplied by REGRESS (1.0 = trust projections fully, 0.0 = everyone is
# average), and the season-level uncertainty is then re-fitted so final
# standings still spread out the way real UPS seasons do.
#
# 0.7 is BACKTESTED (backtest() below; 2021-2025, week-1 rosters, preseason
# projections, 1500 runs a season, 60 team-seasons; run 2026-09-11):
#     k     miss (rmse)  slope   rank corr.
#    1.0      .128       0.67      .56     overconfident: gaps too big
#    0.8      .120       0.84      .57
#    0.7      .118       0.96      .57     smallest miss, gaps right-sized
#    0.6      .119       1.13      .56
#    0.5      .121       1.36      .56     underconfident
#    "everyone .500"  .153
# It explains about 40% of the spread in final all-play %. Rank correlation
# by season: .90 .87 .42 .31 .34 (2021-2025) -- the recent seasons were far
# less predictable from September, and the reviews should say so. The same
# backtest on MFL's week-of projections (which knew in-season news) prefers
# k = 1.0 with rank correlation .72 -- that is hindsight, not a better model.
REGRESS_DEFAULT = 0.7


def regress(wp, k):
    """Shrink each team's weekly projection toward that week's league mean by k."""
    if k >= 1.0:
        return wp
    weeks = next(iter(wp.values())).keys()
    means = {w: sum(wp[f][w] for f in wp) / len(wp) for w in weeks}
    return {f: {w: means[w] + k * (wp[f][w] - means[w]) for w in weeks} for f in wp}


def _within_var_of_projections(wp, reg_end):
    vs = []
    for fid, weeks in wp.items():
        xs = [weeks[w] for w in range(1, reg_end + 1)]
        m = sum(xs) / len(xs)
        vs.append(sum((x - m) ** 2 for x in xs) / len(xs))
    return sum(vs) / len(vs)


def _div_winner_key(t):
    # MFL 2026 standingsSort: PCT, DIVPCT, H2H, PTS, ALL_PLAY_PCT, PWR.
    # Pairwise H2H between tied teams is skipped (goes to PTS) -- see docstring.
    return (-t["pct"], -t["divpct"], -t["pf"], -t["ap_pct"])


def simulate(teams, sched, wp, reg_end, end, runs, sigma_w, sigma_s, rng, collect=True, hook=None,
             actual=None, posterior=None):
    """`actual` ({week: {fid: real score}}) fixes already-played weeks instead of
    drawing them -- what happened is not a random variable. `posterior`
    ({fid: (mean, var)}) replaces the shared N(0, sigma_s) shock draw with each
    team's own updated belief; see posterior_shock() for where it comes from.
    Both default to None, which reproduces the preseason behaviour exactly."""
    fids = sorted(teams)
    agg = {f: {"h2h_w": 0.0, "ap_pct": 0.0, "div": 0, "po": 0, "bye": 0, "title": 0, "runner": 0,
               "ap_rank": [0] * len(fids), "ap_samples": []} for f in fids}
    # THE SHAPE OF A SEASON, not just its average. Keith 2026-09-12: "i need to
    # see a more realistic regular season. You can show 'Averages' as a baseline
    # but then also show the more league-shaped result." A team's MEAN all-play
    # across 20,000 seasons is compressed by construction -- the good and the bad
    # cancel -- so the table also needs what one season looks like: each team's
    # own spread, and the all-play that lands at each finishing place.
    shape_by_finish = [0.0] * len(fids)
    champ_ap_rank = [0] * len(fids)
    ap_var_sum = 0.0
    actual = actual or {}
    for _ in range(runs):
        shock = ({f: rng.gauss(*posterior[f]) for f in fids} if posterior
                 else {f: rng.gauss(0, sigma_s) for f in fids})
        rec = {f: {"w": 0, "l": 0, "t": 0, "dw": 0, "dl": 0, "apw": 0, "apl": 0, "pf": 0.0} for f in fids}
        drawn = {}
        for wk in range(1, reg_end + 1):
            score = actual[wk] if wk in actual else {f: wp[f][wk] + shock[f] + rng.gauss(0, sigma_w) for f in fids}
            if hook is not None:
                drawn[wk] = score
            order = sorted(fids, key=lambda f: score[f])
            for i, f in enumerate(order):
                rec[f]["apw"] += i
                rec[f]["apl"] += len(fids) - 1 - i
                rec[f]["pf"] += score[f]
            for a, b in sched.get(wk, []):
                if score[a] == score[b]:
                    rec[a]["t"] += 1; rec[b]["t"] += 1
                    continue
                win, lose = (a, b) if score[a] > score[b] else (b, a)
                rec[win]["w"] += 1; rec[lose]["l"] += 1
                if teams[a]["division"] == teams[b]["division"]:
                    rec[win]["dw"] += 1; rec[lose]["dl"] += 1
        st = {}
        for f in fids:
            r = rec[f]
            g = r["w"] + r["l"] + r["t"]
            st[f] = {"pct": (r["w"] + 0.5 * r["t"]) / g if g else 0.0,
                     "divpct": r["dw"] / (r["dw"] + r["dl"]) if (r["dw"] + r["dl"]) else 0.0,
                     "ap_pct": r["apw"] / (r["apw"] + r["apl"]), "pf": r["pf"]}
        aps = [st[f]["ap_pct"] for f in fids]
        m = sum(aps) / len(aps)
        ap_var_sum += sum((x - m) ** 2 for x in aps) / len(aps)
        for f in fids:
            agg[f]["ap_pct"] += st[f]["ap_pct"]
            agg[f]["ap_samples"].append(st[f]["ap_pct"])
        for i, f in enumerate(sorted(fids, key=lambda f2: (-st[f2]["ap_pct"], -st[f2]["pf"]))):
            shape_by_finish[i] += st[f]["ap_pct"]
        if not collect:
            continue

        seed_key = lambda f: (-st[f]["ap_pct"], -st[f]["pct"], -st[f]["pf"])
        divs = {}
        for f in fids:
            divs.setdefault(teams[f]["division"], []).append(f)
        dws = [sorted(members, key=lambda f: _div_winner_key(st[f]))[0] for members in divs.values()]
        dws_sorted = sorted(dws, key=seed_key)
        wild = sorted((f for f in fids if f not in dws), key=seed_key)[:2]
        seeds = dws_sorted[:2] + sorted(dws_sorted[2:] + wild, key=seed_key)

        def play(a, b, wk):
            sa = wp[a][wk] + shock[a] + rng.gauss(0, sigma_w)
            sb = wp[b][wk] + shock[b] + rng.gauss(0, sigma_w)
            return a if sa >= sb else b
        # Round 1 (week 15): 3 v 6, 4 v 5. Round 2 (week 16): the top seed meets
        # the lowest seed left, 2 meets the other. Final (week 17).
        w36, w45 = play(seeds[2], seeds[5], reg_end + 1), play(seeds[3], seeds[4], reg_end + 1)
        low, high = sorted((w36, w45), key=lambda f: seeds.index(f), reverse=True)
        f1, f2 = play(seeds[0], low, reg_end + 2), play(seeds[1], high, reg_end + 2)
        champ = play(f1, f2, min(end, reg_end + 3))
        runner = f2 if champ == f1 else f1

        for i, f in enumerate(sorted(fids, key=lambda f: (-st[f]["ap_pct"], -st[f]["pf"]))):
            agg[f]["ap_rank"][i] += 1
        for f in fids:
            agg[f]["h2h_w"] += rec[f]["w"] + 0.5 * rec[f]["t"]
        for f in dws:
            agg[f]["div"] += 1
        for f in seeds:
            agg[f]["po"] += 1
        for f in seeds[:2]:
            agg[f]["bye"] += 1
        agg[champ]["title"] += 1
        agg[runner]["runner"] += 1
        champ_ap_rank[sorted(fids, key=lambda f2: (-st[f2]["ap_pct"], -st[f2]["pf"])).index(champ)] += 1
        # Diagnostics (inert in production): one call per simulated season, so a
        # caller can ask what the CHAMPION's realized all-play looks like rather
        # than what a team's mean is. Keith 2026-09-12: ".598 for a league
        # champion feels low ... which might make sense since this is the mean".
        # `scores` ({week: {fid: score}}) lets a caller condition on one week's
        # games inside the SAME simulated seasons -- week_preview.py uses it for
        # "playoff odds with a win vs with a loss" in next week's matchups.
        if hook is not None:
            hook(st, champ, runner, seeds, drawn)
    for f in fids:
        agg[f]["ap_samples"].sort()
    agg["_shape"] = {"byFinish": [x / runs for x in shape_by_finish],
                     "champApRank": [x / runs for x in champ_ap_rank]}
    return agg, ap_var_sum / runs


def calibrate(teams, sched, wp, reg_end, end, sigma_w, runs, seed):
    table = []
    for s in SIGMA_S_GRID:
        _, ap_var = simulate(teams, sched, wp, reg_end, end, runs, sigma_w, s, random.Random(seed), collect=False)
        table.append({"sigma_s": s, "sim_ap_var": round(ap_var, 5)})
    best = min(table, key=lambda r: abs(r["sim_ap_var"] - TARGET_AP_VAR))
    # Interpolate between the two grid points that bracket the target.
    lo = [r for r in table if r["sim_ap_var"] <= TARGET_AP_VAR]
    hi = [r for r in table if r["sim_ap_var"] >= TARGET_AP_VAR]
    if lo and hi:
        a, b = max(lo, key=lambda r: r["sim_ap_var"]), min(hi, key=lambda r: r["sim_ap_var"])
        if b["sim_ap_var"] > a["sim_ap_var"]:
            frac = (TARGET_AP_VAR - a["sim_ap_var"]) / (b["sim_ap_var"] - a["sim_ap_var"])
            return a["sigma_s"] + frac * (b["sigma_s"] - a["sigma_s"]), table
    return float(best["sigma_s"]), table


def preseason_view(proj, season, cache_dir, end):
    """What a projection made BEFORE week 1 knows: each player's week-1 projection
    carried through the season, zeroed on his NFL bye. The backtest's honest mode.

    MFL archives past seasons' weekly projections, but the week-9 projection was
    made the week of week 9 -- it already knew who got hurt, benched or traded.
    Backtesting on those grades a preseason model with in-season hindsight and
    flatters it (it would argue for trusting projections more than we can in
    September). Blind spot of this view: a player hurt for week 1 only is zero
    all year, as he was on the draft sheet."""
    team_of = {p["id"]: p.get("team") for p in fetch(MFL_PLAYERS % season, cache_dir)["players"]["player"]}
    bye = {t["id"]: int(t["bye_week"]) for t in _as_list(fetch(MFL_BYES % season, cache_dir)
                                                          ["nflByeWeeks"].get("team")) if t.get("bye_week")}
    if not bye:
        raise SystemExit("season_sim: MFL returned no %d bye weeks" % season)
    return {wk: {pid: (0.0 if bye.get(team_of.get(pid)) == wk else pts) for pid, pts in proj[1].items()}
            for wk in range(1, end + 1)}


def absences(season, cache_dir, end):
    """{pid: {weeks, status, details, returns, source}} -- the weeks a player will
    not play, per the rules at ABSENT_STATUSES. Fails closed on a season with no
    week-one Sunday on file rather than guessing the calendar."""
    if season not in WEEK1_SUNDAY:
        raise SystemExit("season_sim: no WEEK1_SUNDAY for %s -- add it before simulating injuries" % season)
    feed = fetch(MFL_INJURIES % season, cache_dir)["injuries"]
    cur = int(feed.get("week") or 1)
    sun1 = WEEK1_SUNDAY[season]
    out = {}
    for r in _as_list(feed.get("injury")):
        st = r.get("status") or ""
        if st not in ABSENT_STATUSES:
            continue
        ret = r.get("exp_return") or ""
        if ret:
            back = datetime.strptime(ret, "%b %d, %Y").date()
            weeks = [w for w in range(cur, end + 1) if sun1 + timedelta(days=7 * (w - 1)) < back]
            # Listed OUT means out this week, whatever the return date says:
            # Brock Bowers (Out, meniscus) carried a return date of the week-one
            # Sunday and was otherwise projected to play the game he will miss.
            weeks = sorted(set(weeks) | {cur})
        elif st.startswith("IR"):
            weeks = list(range(cur, min(end, cur + NFL_IR_MIN_GAMES - 1) + 1))
        else:
            weeks = [cur]
        if weeks:
            out[r["id"]] = {"weeks": weeks, "status": st, "details": r.get("details") or "",
                            "returns": ret, "source": "MFL injuries export (week %d)" % cur}
    for pid, a in REPORTED_ABSENCES.get(season, {}).items():
        have = out.get(pid)
        out[pid] = {"weeks": sorted(set(a["weeks"]) | set((have or {}).get("weeks") or [])),
                    "status": (have or {}).get("status") or a["status"],
                    "details": (have or {}).get("details") or a["details"],
                    "returns": (have or {}).get("returns") or "", "source": a["source"]}
    return out


OFFENSE_GROUPS = (LE.QB, LE.RB, LE.WR, LE.TE)


def apply_ev_offense(season, proj, pos, end, cache_dir=None):
    """Replace MFL's offensive projections with EXPECTED-VALUE ones, in place.

    Keith 2026-09-16: MFL's projectedScores move in whole-touchdown steps (a
    0.49 touchdown counts as 0, a 0.51 as a full 6), so one small nudge after
    week 1 flipped whole seasons of future weeks by ~7.5 points. "Multiply the
    ratio by the points it would generate, so a TD that's 0.49 = .49 * 6."
    ev_projections scores Sleeper's fractional stat lines with UPS rules.
    Backtested on 2025 (weeks 1-17, offense): weekly MAE 6.33 vs MFL 6.64,
    correlation .51 vs .43; rest-of-season per-game MAE 1.88 vs 3.32; weeks
    jumping 6+ points 0.6%% vs 7.3%%.

    QB/RB/WR/TE only -- defenders, kickers and punters stay on MFL. Whether a
    player PLAYS is MFL's call (see below); how much he scores is RotoWire's. A
    player MFL projects but Sleeper does not keeps his MFL number (counted);
    a week whose Sleeper feed is empty or unreadable FAILS, never "scores zero".
    Returns coverage stats for the output file.
    """
    import ev_projections as EV
    import wire_data as WD
    xw = {}
    for r in WD.d1("SELECT sleeper_id, mfl_player_id FROM player_id_crosswalk "
                   "WHERE sleeper_id IS NOT NULL AND mfl_player_id IS NOT NULL"):
        xw[str(r["sleeper_id"]).split(".")[0]] = str(r["mfl_player_id"]).split(".")[0]
    # NAME FALLBACK for players the crosswalk has no Sleeper id for -- 54 rostered
    # offensive players on 2026-09-16, nearly all 2026 rookies (Carnell Tate,
    # Kenyon Sadiq, Jeremiyah Love, Jadarian Price...). Left on MFL numbers they
    # would sit on a lower, rounded scale than everyone else. Matched only on a
    # UNIQUE normalized name + position whose NFL team agrees; anything
    # ambiguous stays unmatched and is counted.
    mfl_players = dict((p["id"], p) for p in fetch(MFL_PLAYERS % season, cache_dir)["players"]["player"])
    have = set(xw.values())
    cov = {"source": "Sleeper weekly projections (RotoWire stat lines) scored with UPS rules; MFL decides availability",
           "rotowirePoints": 0, "keptMfl": 0, "nameMatchedPlayers": 0,
           "mflSaysOut": 0, "mflSaysPlays": 0, "availabilityDisagreements": [],
           "sleeperUpdatedAt": None}
    newest = 0
    name_matched = set()
    rw = {}                                     # {week: {mfl pid: RotoWire expected points}}
    for wk in range(1, end + 1):
        evw = EV.fetch_week(season, wk, lambda url: fetch(url, cache_dir))
        by_name = {}
        for sid, v in evw.items():
            by_name.setdefault((EV.norm_name(v["name"]), v["pos"]), []).append((sid, v))
        pts = {}
        for sid, v in evw.items():
            pid = xw.get(sid)
            if pid:
                pts[pid] = v["points"]
                newest = max(newest, int(v.get("updatedAt") or 0))
        for pid, p in mfl_players.items():
            if pid in have or pid in pts or LE.pos_group(p.get("position", "")) not in OFFENSE_GROUPS:
                continue
            hits = by_name.get((EV.norm_name(p.get("name")), (p.get("position") or "").upper()), [])
            team = EV.MFL_TO_NFL_TEAM.get(p.get("team") or "", p.get("team") or "")
            if len(hits) == 1 and (not hits[0][1]["team"] or not team or team == "FA" or hits[0][1]["team"] == team):
                pts[pid] = hits[0][1]["points"]
                name_matched.add(pid)
        rw[wk] = pts

    # MFL DECIDES WHO PLAYS, ROTOWIRE DECIDES HOW MUCH (Keith 2026-09-16: "switch
    # but let MFL decide availability"). MFL's own availability signals are its
    # injury feed (Out/IR/Suspended + return dates, applied later by absences())
    # and its depth order -- MFL projects BACKUPS too (Spencer Rattler 9 a week,
    # Michael Penix 8), so "MFL projects him" is not "MFL says he plays".
    #   QB: per NFL team per week, MFL's starter is its highest-projected QB. If
    #       RotoWire names a different starter, MFL's starter gets RotoWire's QB1
    #       line and RotoWire's pick gets the backup line (Kirk Cousins over
    #       Fernando Mendoza). If MFL's starter has no RotoWire line that week
    #       (Kyler Murray, week 2), he plays at RotoWire's own average for him.
    #   RB/WR/TE: MFL at 5+ while RotoWire is ~0 -> he plays, at RotoWire's
    #       average for him when it has one, else MFL's number (Josh Jacobs back
    #       from suspension in week 3); a same-team, same-position teammate whose
    #       RotoWire role assumed him out drops to MFL's number that week
    #       (MarShawn Lloyd). MFL ~0 while RotoWire projects 3+ -> he does not
    #       play (Jordyn Tyson after IR).
    #   otherwise: RotoWire's expected points.
    PLAYS, ROLE = 1.0, 5.0
    ref = {}
    for wk, pts in rw.items():
        for pid, v in pts.items():
            if v >= PLAYS:
                ref.setdefault(pid, []).append(v)
    ref = dict((pid, sum(v) / len(v)) for pid, v in ref.items())
    team_of = lambda pid: (mfl_players.get(pid) or {}).get("team") or ""
    disagree = {}

    def note(pid, kind, wk):
        disagree.setdefault(pid, {"mflSaysOut": [], "mflSaysPlays": [], "mflStarter": [], "mflBackup": []})[kind].append(wk)
    for wk in range(1, end + 1):
        pts = rw[wk]
        mfl_now = dict(proj[wk])
        final = {}
        ids = [pid for pid in set(mfl_now) | set(pts) if LE.pos_group(pos.get(pid, "")) in OFFENSE_GROUPS]
        # quarterbacks, team by team
        by_team = {}
        for pid in ids:
            if LE.pos_group(pos.get(pid, "")) == LE.QB:
                by_team.setdefault(team_of(pid), []).append(pid)
        for team, qbs in by_team.items():
            m_s = max((q for q in qbs if (mfl_now.get(q) or 0) >= PLAYS), key=lambda q: mfl_now[q], default=None)
            r_s = max((q for q in qbs if (pts.get(q) or 0) >= PLAYS), key=lambda q: pts[q], default=None)
            for q in qbs:
                m, r = mfl_now.get(q), pts.get(q)
                if r is None:
                    if m is not None:
                        final[q] = m; cov["keptMfl"] += 1
                    continue
                if q == m_s and team not in ("", "FA"):
                    if r >= PLAYS and (r_s is None or r_s == q):
                        final[q] = r; cov["rotowirePoints"] += 1
                    elif r_s is not None and r_s != q and pts.get(q, 0) < PLAYS and q in ref:
                        final[q] = ref[q]; cov["mflSaysPlays"] += 1; note(q, "mflSaysPlays", wk)
                    elif r_s is not None and r_s != q:
                        final[q] = pts[r_s]; cov["mflSaysPlays"] += 1; note(q, "mflStarter", wk)
                    else:
                        final[q] = ref.get(q, m); cov["mflSaysPlays"] += 1; note(q, "mflSaysPlays", wk)
                elif q == r_s and m_s is not None and m_s != q:
                    final[q] = pts.get(m_s, 0.0) if pts.get(m_s, 0.0) < PLAYS else 0.0
                    cov["mflSaysOut"] += 1; note(q, "mflBackup", wk)
                elif m is None or m < PLAYS:
                    final[q] = 0.0 if r >= 3.0 else r
                    if r >= 3.0:
                        cov["mflSaysOut"] += 1; note(q, "mflSaysOut", wk)
                else:
                    final[q] = r; cov["rotowirePoints"] += 1
        # everyone else
        overridden = set()
        for pid in ids:
            if pid in final:
                continue
            m, r = mfl_now.get(pid), pts.get(pid)
            if r is None:
                if m is not None:
                    final[pid] = m; cov["keptMfl"] += 1
                continue
            if m is not None and m >= ROLE and r < PLAYS:
                final[pid] = ref.get(pid, m); cov["mflSaysPlays"] += 1; note(pid, "mflSaysPlays", wk)
                if final[pid] >= ROLE:                # a real return, not a fringe player
                    overridden.add((team_of(pid), LE.pos_group(pos.get(pid, ""))))
            elif (m is None or m < PLAYS) and r >= 3.0:
                final[pid] = 0.0; cov["mflSaysOut"] += 1; note(pid, "mflSaysOut", wk)
            else:
                final[pid] = r; cov["rotowirePoints"] += 1
        for pid in ids:
            key = (team_of(pid), LE.pos_group(pos.get(pid, "")))
            if key not in overridden or key[1] == LE.QB:
                continue
            if wk in (disagree.get(pid) or {}).get("mflSaysPlays", []):
                continue                              # he is the player MFL put back
            m, r = mfl_now.get(pid), pts.get(pid)
            if r is not None and m is not None and r >= ROLE and m < r - 4.0:
                final[pid] = m
                note(pid, "mflBackup", wk)
        for pid, v in final.items():
            if v <= 0 and pid not in mfl_now:
                proj[wk].pop(pid, None)
            else:
                proj[wk][pid] = v
    cov["availabilityDisagreements"] = sorted(
        (dict({"pid": pid, "player": (mfl_players.get(pid) or {}).get("name"),
               "rotowireAverageWhenPlaying": round(ref[pid], 1) if pid in ref else None}, **d)
         for pid, d in disagree.items()), key=lambda x: -sum(len(x[k]) for k in ("mflSaysOut", "mflSaysPlays", "mflStarter", "mflBackup")))
    cov["nameMatchedPlayers"] = len(name_matched)
    if newest:
        cov["sleeperUpdatedAt"] = datetime.fromtimestamp(newest / 1000.0, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return cov


def prepare(season, cache_dir=None, roster_week=None, projections="weekly", injuries=False, ev_offense=False):
    """Everything that does not depend on the regression dial."""
    league, teams, rosters, sched, proj, reg_end, end, pos, rostered, ir_pids = load_inputs(
        season, cache_dir, roster_week, include_ir=injuries)
    games = {}
    for wk, ms in sched.items():
        for a, b in ms:
            games[a] = games.get(a, 0) + 1; games[b] = games.get(b, 0) + 1
    if set(games.values()) != {37} and season == 2026:
        raise SystemExit("season_sim: expected 37 regular-season games per team, got %s" % sorted(set(games.values())))
    if projections == "preseason":
        proj = preseason_view(proj, season, cache_dir, end)
    ev_coverage = apply_ev_offense(season, proj, pos, end, cache_dir) if ev_offense else None
    # Only the live forecast takes injuries: a backtest must see what MFL said
    # at the time, and the feed only knows today.
    absent = absences(season, cache_dir, end) if injuries else {}
    # An IR player the injury feed does not list still cannot play: hold him out
    # for the NFL's four-game minimum rather than start him in week one. No
    # fail-open -- an unlisted IR player is absent, not healthy.
    if ir_pids:
        _cur = int((fetch(MFL_INJURIES % season, cache_dir)["injuries"] or {}).get("week") or 1)
        for pid in ir_pids:
            if pid not in absent:
                absent[pid] = {"weeks": list(range(_cur, min(end, _cur + NFL_IR_MIN_GAMES - 1) + 1)),
                               "status": "IR (not on the injury feed)", "details": "",
                               "returns": "", "source": "MFL rosters export: INJURED_RESERVE"}
    for pid, a in absent.items():
        for wk in a["weeks"]:
            (proj.get(wk) or {}).pop(pid, None)
    rep = replacement_levels(proj, pos, rostered, end, reg_end)
    wp_raw, fills, parts = weekly_projections(rosters, proj, end, rep, reg_end=reg_end)
    return {"league": league, "teams": teams, "sched": sched, "reg_end": reg_end, "end": end,
            "evCoverage": ev_coverage,
            "games": games, "wp_raw": wp_raw, "fills": fills, "parts": parts, "proj": proj, "pos": pos,
            "rosters": rosters, "rep": rep, "rostered": rostered,
            "absent": dict((p, a) for p, a in absent.items() if p in rostered)}


SEASON_PROJ_GROUPS = ("PK", "PN", "DL", "LB", "DB")


def season_projections(proj, pos, end, groups=SEASON_PROJ_GROUPS):
    """{pid: {pos, seasonProj, rank}} for every kicker, punter and defender MFL
    projects.

    Keith 2026-09-11: "MFL has kicker forecasts for this season, let's use that
    as our source of truth." The team reviews had no source for K/P at all and
    printed "no ranking source (salary-filled)" in every lineup. Then, on the
    defenders graded from last season's production: "Isn't IDP based on
    projected season finish? No prior season shouldn't matter" -- a rookie or a
    returning veteran printed "no prior-season production" instead of a grade.
    The season total is weeks 1..end summed, byes included, and the rank is
    league-wide at the position, rostered or not -- the same basis the tier
    labels use."""
    out = {}
    for g in groups:
        tot = {}
        for wk in range(1, end + 1):
            for pid, pts in proj[wk].items():
                if LE.pos_group(pos.get(pid, "")) == g:
                    tot[pid] = tot.get(pid, 0.0) + pts
        for i, pid in enumerate(sorted(tot, key=lambda p: (-tot[p], p)), 1):
            out[pid] = {"pos": g, "seasonProj": round(tot[pid], 1), "rank": i}
    return out


def fit(prep, k, runs, seed, collect=True):
    """Regress, calibrate both noise layers, simulate."""
    teams, sched, reg_end, end = prep["teams"], prep["sched"], prep["reg_end"], prep["end"]
    wp = regress(prep["wp_raw"], k)
    proj_var = _within_var_of_projections(wp, reg_end)
    sigma_w = math.sqrt(max(TARGET_WITHIN_VAR - proj_var, 0.0))
    sigma_s, table = calibrate(teams, sched, wp, reg_end, end, sigma_w, max(500, runs // 5), seed)
    agg, ap_var = simulate(teams, sched, wp, reg_end, end, runs, sigma_w, sigma_s, random.Random(seed), collect)
    return {"wp": wp, "proj_var": proj_var, "sigma_w": sigma_w, "sigma_s": sigma_s, "table": table,
            "agg": agg, "ap_var": ap_var}


def actual_scores_by_week(season, through_week, cache_dir=None):
    """{week: {fid: real team score}} for weeks 1..through_week, straight from
    MFL's weeklyResults -- the same export actual_allplay() reads, kept
    separate because the live update needs raw scores, not the all-play
    summary. Fails closed on a week that does not resolve to exactly 12 teams,
    same guard as actual_allplay()."""
    out = {}
    for wk in range(1, int(through_week) + 1):
        wr = fetch(MFL % (season, "weeklyResults", "&W=%d" % wk), cache_dir)["weeklyResults"]
        score = {}
        for m in _as_list(wr.get("matchup")):
            for x in _as_list(m.get("franchise")):
                score[x["id"]] = float(x["score"])
        for x in _as_list(wr.get("franchise")):
            score.setdefault(x["id"], float(x["score"]))
        if len(score) != 12:
            raise SystemExit("season_sim: %d week %d weeklyResults covers %d teams, not 12"
                             % (season, wk, len(score)))
        out[wk] = score
    return out


# BAYESIAN UPDATE OF THE SEASON-LONG SHOCK. `simulate()`'s model is
# score[wk] = wp[f][wk] + shock[f] + N(0, sigma_w) -- shock is drawn once per
# simulated season from the prior N(0, sigma_s), a team's constant quality
# error the preseason projection could not see. Once real weeks are in hand,
# that is no longer unknown: a team that has scored consistently above its own
# weekly projection almost certainly has positive shock, and by how much is a
# textbook normal-normal conjugate update, using the SAME sigma_w/sigma_s this
# file already backtested -- no new, uncalibrated "weeks of prior" knob.
def posterior_shock(wp, actual, sigma_w, sigma_s, fids):
    """{fid: (posterior_mean, posterior_sd)} from real deviations vs `wp`.

    n=0 (nothing played yet) returns (0, sigma_s) for every team -- identical
    to the preseason prior, so a live run before week 1 reproduces run()."""
    out = {}
    for f in fids:
        devs = [actual[wk][f] - wp[f][wk] for wk in actual if f in actual[wk]]
        n = len(devs)
        if n == 0:
            out[f] = (0.0, sigma_s)
            continue
        dbar = sum(devs) / n
        # Posterior precision = prior precision + n * likelihood precision.
        prior_prec = 1.0 / (sigma_s * sigma_s) if sigma_s > 0 else 0.0
        like_prec = n / (sigma_w * sigma_w) if sigma_w > 0 else 0.0
        post_prec = prior_prec + like_prec
        post_var = 1.0 / post_prec if post_prec > 0 else 0.0
        post_mean = (like_prec * dbar) / post_prec if post_prec > 0 else 0.0
        out[f] = (post_mean, math.sqrt(post_var))
    return out


# NAME THE CAUSE, WHEN THE DATA ACTUALLY SUPPORTS IT. Keith 2026-09-15, after
# tracing why The Long Haulers' outlook cratered relative to a much worse
# week from L.A. Looks: "note when large swings ... highlight this is
# because no A.J. Brown for 6 weeks." The preseason forecast never applies
# injury logic (see absences() above), so any team whose real absence
# predates or coincides with the preseason snapshot -- or is simply large
# enough to matter -- will show a swing that looks like pure model noise
# unless the cause is surfaced by name.
def _net_absence_impact(prep, fid, pid, weeks, restore_value):
    """This team's actual point swing from missing `pid` for `weeks`, using
    the SAME lineup optimization (the rest of the bench, plus the same
    replacement-level wire bodies) the model already applies to every week --
    not the player's own raw value, which silently assumes the roster slot
    goes empty. Keith 2026-09-16: "we will find a replacement on WW ... we
    have a replacement on our bench" -- an owner fills the hole, so the
    estimate has to reflect the next-best player actually available, not a
    zero.

    Reruns weekly_projections() for this one team with `pid`'s typical value
    restored for the weeks he is out, and diffs against prep["wp_raw"] (the
    current, already-without-him optimum) -- so both sides of the comparison
    run through the identical slot-filling logic."""
    proj_with = dict(prep["proj"])
    for w in weeks:
        proj_with[w] = dict(proj_with.get(w, {}))
        proj_with[w][pid] = restore_value
    wp_with, _, _ = weekly_projections({fid: prep["rosters"][fid]}, proj_with, prep["end"],
                                       prep["rep"], reg_end=prep["reg_end"])
    deltas = [wp_with[fid][w] - prep["wp_raw"][fid][w] for w in weeks if w in wp_with.get(fid, {})]
    return sum(deltas) / len(deltas) if deltas else None


def biggest_absences(prep, cache_dir=None, min_points=8.0):
    """{fid: {player, pos, weeksOut, details, estPtsPerWeek, estTotalPtsLost}}
    -- the single largest real, sourced absence per team, so a forecast swing
    can be explained by name instead of left as an unexplained number.

    estPtsPerWeek/estTotalPtsLost are the NET impact after the model's own
    bench-and-waiver-level replacement fills the slot (see
    _net_absence_impact) -- not the absent player's own raw value, which
    overstates the hit every owner actually takes.

    No fabricated point values: a player never projected while active (most
    season-long IR/PUP tags -- MFL simply does not project them) is skipped
    rather than guessed, and a team's NET absence must clear min_points
    (roughly a full game's worth of production) before it is reported at
    all."""
    if not prep["absent"]:
        return {}
    names = ({p["id"]: p.get("name") for p in fetch(MFL_PLAYERS % LIVE_SEASON, cache_dir)
             ["players"]["player"]} if LIVE_SEASON else {})
    owner_of = {}
    for fid, rows in prep["rosters"].items():
        for r in rows:
            owner_of[r["pid"]] = fid
    proj = prep["proj"]
    best = {}
    for pid, a in prep["absent"].items():
        fid = owner_of.get(pid)
        if not fid:
            continue
        vals = [proj[w][pid] for w in proj if pid in proj[w]]
        if not vals:
            continue
        avg = sum(vals) / len(vals)
        net = _net_absence_impact(prep, fid, pid, a["weeks"], avg)
        if net is None:
            continue
        total = net * len(a["weeks"])
        if total < min_points:
            continue
        cur = best.get(fid)
        if cur is None or total > cur["estTotalPtsLost"]:
            best[fid] = {"player": names.get(pid, pid), "pos": prep["pos"].get(pid, ""),
                        "weeksOut": a["weeks"], "details": a["details"] or a["status"],
                        "estPtsPerWeek": round(net, 1), "estTotalPtsLost": round(total, 1)}
    return best


# NOT EVERY REAL LOSS IS AN ABSENCE. Keith 2026-09-16, after biggest_absences()
# cleared everyone but Cross's A.J. Brown and only for 8.5 net points: "can't
# you compare current projections vs what you had?" ups_player_projections
# (2026-08-02 on) answers that for STILL-ROSTERED players whose own MFL
# projection simply fell -- Quentin Johnston (traded for by Cross in July)
# went 13.7 -> 7.7 in week 1's own captured history, and nets to roughly
# 5.5 pts/week for the team because, unlike Brown, nothing on the bench sits
# where Johnston used to.
def biggest_decliners(prep, cache_dir=None, min_points=8.0, min_ratio=1.3, min_raw_drop=3.0):
    """{fid: {player, pos, weekOneFirstProjected, weekOneNowProjected,
    estPtsPerWeek, estTotalPtsLost}} -- the single largest real decline in a
    still-active player's OWN projection since MFL's earliest captured value
    for him, per team, netted the same way as biggest_absences(): restore his
    old value, re-optimize the lineup, diff against the current optimum.
    Unlike a raw point drop, this correctly reads as near-zero for a player
    whose fall just lands him beside an equally-good bench option, and as
    real when nothing behind him is comparable.

    A player already counted in biggest_absences() is skipped here (he is out
    entirely -- a different story, not a smaller version of this one).
    min_ratio/min_raw_drop are a cheap pre-filter on the RAW week-1 decline,
    checked before the expensive netting pass even runs; min_points is the
    real gate, applied to the NET total.

    CONSISTENCY GATE, not just a pre-filter (the bug the first version of
    this shipped with): week 1's captured drop is only trusted as a real,
    durable signal if the player's CURRENT week-1 number is close to his
    CURRENT week-2-onward average. When it is not -- his own week-2+ number
    is already back near his ORIGINAL week-1 projection -- the week-1 drop
    was a one-week matchup/game-script wobble, not a quality reassessment,
    and extrapolating it forward fabricates a number: an early version of
    this restored Chuba Hubbard to a 25-point/week running back and Kenyon
    Sadiq (a backup TE) to 24. Both had already-healthy week-2+ averages;
    only a player whose current week 1 and week 2+ numbers AGREE (like
    Quentin Johnston: 7.7 now vs a 7.65 week-2+ average) is extrapolated at
    all. Restoration itself uses the flat point difference, not a ratio --
    multiplying a small denominator explodes exactly when this gate is meant
    to catch it.

    PLAUSIBILITY GATE, a second and distinct check (Keith 2026-09-16: "is
    this 16.1 for Godwin his original weekly average for the season? That's
    elite numbers and feels like it might've been just Week 1 projection?"):
    the consistency gate above only protects the CURRENT trajectory -- it
    says nothing about whether the ORIGINAL captured value was ever a
    credible number to begin with. `first_projected` is captured as early as
    2026-08-02, deep offseason, well before camp battles and roles settle --
    three of five early candidates (Chris Godwin 16.1, Michael Penix Jr.
    14.6, Jake Tonges 13.4) turned out to be numbers the model has NEVER
    shown that player again, in any week, even a good matchup (Godwin's
    entire current range is 7.0-9.2). That is not a player who "declined" --
    it is an unreliable first capture with nothing to have declined FROM.
    Requiring first <= max(current weeks 2+) * 1.15 keeps only a decline
    whose claimed old level the model still sometimes produces for that
    player today (Quentin Johnston hits 14.4 in week 8; Rome Odunze hits
    16.8 twice) -- a real, still-achievable level he has fallen away from,
    not a phantom one.

    Source: ups_player_projections (D1), which has captured every player's
    own week-1 projection repeatedly since 2026-08-02 -- but only week 1 so
    far. The decline is extrapolated onto weeks 2+ by the SAME flat point
    amount observed in week 1 (a labeled assumption -- there is no second
    real data point for those weeks yet), not a fabricated number: see the
    caller for how this is surfaced."""
    import wire_data as WD  # local: only the live path touches D1
    owner_of = {}
    for fid, rows in prep["rosters"].items():
        for r in rows:
            owner_of[r["pid"]] = fid
    d1_rows = WD.d1("SELECT player_id, first_projected, projected_score FROM ups_player_projections "
                    "WHERE season = %d AND week = 1" % LIVE_SEASON)
    names = ({p["id"]: p.get("name") for p in fetch(MFL_PLAYERS % LIVE_SEASON, cache_dir)
             ["players"]["player"]} if LIVE_SEASON else {})
    proj = prep["proj"]
    end, reg_end = prep["end"], prep["reg_end"]
    best = {}
    for r in d1_rows:
        pid = r["player_id"]
        fid = owner_of.get(pid)
        if not fid or pid in prep["absent"]:
            continue
        first, now = r["first_projected"], r["projected_score"]
        if not first or not now or now <= 0 or first <= now:
            continue
        if (first - now) < min_raw_drop or (first / now) < min_ratio:
            continue
        cur_vals = [proj[w][pid] for w in range(2, end + 1) if pid in proj.get(w, {})]
        if not cur_vals:
            continue
        cur_avg = sum(cur_vals) / len(cur_vals)
        if abs(now - cur_avg) > max(2.0, 0.25 * max(now, cur_avg)):
            continue  # week 1's drop does not match his own current weeks 2+ -- noise, not a real decline
        if first > max(cur_vals) * 1.15:
            continue  # the model never shows him this level anymore, in any week -- an unreliable
                      # first capture, not a real level he fell away from
        restored = cur_avg + (first - now)
        weeks = list(range(2, end + 1))
        proj_with = dict(proj)
        for w in weeks:
            proj_with[w] = dict(proj_with.get(w, {}))
            proj_with[w][pid] = restored
        wp_with, _, _ = weekly_projections({fid: prep["rosters"][fid]}, proj_with, end, prep["rep"],
                                           reg_end=reg_end)
        deltas = [wp_with[fid][w] - prep["wp_raw"][fid][w] for w in weeks if w in wp_with.get(fid, {})]
        if not deltas:
            continue
        net = sum(deltas) / len(deltas)
        total = net * len(deltas)
        if total < min_points:
            continue
        cur = best.get(fid)
        if cur is None or total > cur["estTotalPtsLost"]:
            best[fid] = {"player": names.get(pid, pid), "pos": prep["pos"].get(pid, ""),
                        "weekOneFirstProjected": round(first, 1), "weekOneNowProjected": round(now, 1),
                        "estPtsPerWeek": round(net, 1), "estTotalPtsLost": round(total, 1)}
    return best


def run_live(season, through_week, runs, seed, cache_dir, out_path, k=REGRESS_DEFAULT,
             preseason_path=None, ev_offense=True):
    """The in-season update: same roster/projection/injury pipeline as run(),
    the same fit() (regression + calibration) an ordinary preseason run uses,
    but weeks 1..through_week are FIXED to what actually happened and every
    later week draws its shock from that team's updated posterior instead of
    the shared prior. Diffed against the ORIGINAL preseason file, read as-is
    and never rewritten -- Keith 2026-09-15: "Preserve it as the prior forecast
    so readers can see how beliefs changed."

    Deliberately file-based, like the preseason output, not D1: this project's
    existing convention for season_sim's output is a committed JSON per run,
    and a live snapshot is the same kind of artifact one week later. Call this
    by hand once a week's games are final, the same way the preseason run is
    invoked by hand -- no new scheduled job.
    """
    global LIVE_SEASON
    LIVE_SEASON = season
    pre_path = preseason_path or "site/wire/data/season_sim_%d.json" % season
    if not os.path.exists(pre_path):
        raise SystemExit("season_sim: no preseason forecast at %s -- run a preseason forecast first, "
                         "it is the prior this update reads and never overwrites" % pre_path)
    preseason = json.load(open(pre_path, encoding="utf-8"))
    pre_by_fid = dict((t["franchiseId"], t) for t in preseason["teams"])

    prep = prepare(season, cache_dir, injuries=True, ev_offense=ev_offense)
    teams, games = prep["teams"], prep["games"]
    reg_end, end = prep["reg_end"], prep["end"]
    if through_week < 1 or through_week > reg_end:
        raise SystemExit("season_sim: --through-week must be between 1 and %d" % reg_end)
    res = fit(prep, k, runs, seed, collect=False)
    wp, sigma_w, sigma_s = res["wp"], res["sigma_w"], res["sigma_s"]

    actual = actual_scores_by_week(season, through_week, cache_dir)
    fids = sorted(teams)
    posterior = posterior_shock(wp, actual, sigma_w, sigma_s, fids)

    # OFFICIAL = "refresh-only": banked results + this run's live rosters/
    # projections/full-league resim, but NO persistent per-team shock -- every
    # team's own quality error for weeks not yet played still draws from the
    # shared, un-updated prior N(0, sigma_s^2), same as a fresh preseason run.
    # Keith 2026-09-15 (Phase 2 brief): the permanent Bayesian shock below
    # compounds one outlier week across every remaining week and has not been
    # backtested -- it runs alongside as a SHADOW diagnostic only, never the
    # number this function (or the Wire) publishes. See
    # docs/wire/dynamic_forecast_model.md.
    agg, ap_var = simulate(teams, prep["sched"], wp, reg_end, end, runs, sigma_w, sigma_s,
                           random.Random(seed), collect=True, actual=actual, posterior=None)
    agg_shadow, _ = simulate(teams, prep["sched"], wp, reg_end, end, runs, sigma_w, sigma_s,
                             random.Random(seed), collect=True, actual=actual, posterior=posterior)
    injury_by_fid = biggest_absences(prep, cache_dir)
    # biggest_decliners() reads MFL's own week-1 projection history, which moves
    # in whole-touchdown steps -- Quentin Johnston's 13.7 -> 7.7 is one step. On
    # expected-value offense it would name rounding flips as causes, so it is off.
    decline_by_fid = {} if ev_offense else biggest_decliners(prep, cache_dir)

    def _pctl(xs, p):
        return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0.0

    # Games remaining is schedule-derived (this league's weeks are not one
    # game each -- see the docstring's 37-games note), never a flat 14 x 11.
    played_games = dict((f, 0) for f in fids)
    for wk, ms in prep["sched"].items():
        if wk > through_week:
            continue
        for a, b in ms:
            played_games[a] = played_games.get(a, 0) + 1
            played_games[b] = played_games.get(b, 0) + 1

    rows = []
    for f in fids:
        a = agg[f]
        b = agg_shadow[f]
        cur_wk = actual[through_week]
        week_rank = 1 + sum(1 for g in fids if cur_wk[g] > cur_wk[f])
        cur_ap_w = sum(1 for wk in actual for g in fids if g != f and actual[wk][f] > actual[wk][g])
        cur_ap_l = sum(1 for wk in actual for g in fids if g != f and actual[wk][f] < actual[wk][g])
        cur_ap_t = sum(1 for wk in actual for g in fids if g != f and actual[wk][f] == actual[wk][g])
        pre = pre_by_fid.get(f, {})
        rows.append({
            "franchiseId": f, "team": teams[f]["name"], "division": teams[f]["division"],
            "weekScore": round(cur_wk[f], 1), "weekRank": week_rank,
            "weekApWins": cur_ap_w, "weekApLosses": (len(fids) - 1) - cur_ap_w,
            "currentApWins": cur_ap_w, "currentApLosses": cur_ap_l, "currentApTies": cur_ap_t,
            "currentApPct": round((cur_ap_w + 0.5 * cur_ap_t) / (cur_ap_w + cur_ap_l + cur_ap_t), 4),
            "gamesPlayed": played_games.get(f, 0), "gamesTotal": games.get(f, 0),
            "projectedEndingApPct": round(a["ap_pct"] / runs, 4),
            "apP10": round(_pctl(a["ap_samples"], 0.10), 4), "apP90": round(_pctl(a["ap_samples"], 0.90), 4),
            "currentDivisionOdds": round(a["div"] / runs, 4), "currentPlayoffOdds": round(a["po"] / runs, 4),
            "currentByeOdds": round(a["bye"] / runs, 4), "currentTitleOdds": round(a["title"] / runs, 4),
            "startingAllPlayPct": pre.get("expAllPlayPct"), "startingPowerRank": pre.get("powerRank"),
            "preseasonTitleOdds": pre.get("pTitle"), "preseasonPlayoffOdds": pre.get("pPlayoffs"),
            "preseasonDivisionOdds": pre.get("pDivision"),
            "titleOddsChange": (round(a["title"] / runs - pre["pTitle"], 4) if pre.get("pTitle") is not None else None),
            "playoffOddsChange": (round(a["po"] / runs - pre["pPlayoffs"], 4) if pre.get("pPlayoffs") is not None else None),
            # The single largest real, sourced absence dragging on this team's
            # outlook (None if nothing clears biggest_absences()'s materiality
            # bar) -- the preseason forecast never knew about it, by design.
            "biggestAbsence": injury_by_fid.get(f),
            # Same idea, for a player who is still rostered but whose own
            # projection genuinely fell (see biggest_decliners()) -- distinct
            # from an absence, and only reported when the netted team cost
            # clears its own materiality bar.
            "biggestDecline": decline_by_fid.get(f),
            # INTERNAL DIAGNOSTIC ONLY -- the permanent Bayesian shock model
            # (current Phase 1), not backtested, never cited in Wire prose.
            # Compare against the official fields above to see what the
            # permanent-shock model would have published instead.
            "shadowShock": {
                "posteriorShockMean": round(posterior[f][0], 2), "posteriorShockSd": round(posterior[f][1], 2),
                "projectedEndingApPct": round(b["ap_pct"] / runs, 4),
                "currentDivisionOdds": round(b["div"] / runs, 4), "currentPlayoffOdds": round(b["po"] / runs, 4),
                "currentByeOdds": round(b["bye"] / runs, 4), "currentTitleOdds": round(b["title"] / runs, 4),
                "titleOddsChange": (round(b["title"] / runs - pre["pTitle"], 4)
                                    if pre.get("pTitle") is not None else None),
            },
        })
    rows.sort(key=lambda r: -r["projectedEndingApPct"])
    out = {
        "schema": 2, "season": season, "throughWeek": through_week,
        "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runs": runs, "seed": seed, "preseasonSource": pre_path,
        "preseasonGeneratedAtUtc": preseason.get("generatedAtUtc"),
        "model": {"regress": k, "sigmaWeekly": round(sigma_w, 2), "sigmaSeason": round(sigma_s, 2),
                  "regularSeasonWeeks": reg_end, "endWeek": end,
                  "offenseProjections": ("expected value" if ev_offense else "MFL projectedScores"),
                  "evCoverage": prep.get("evCoverage"),
                  "official": "refresh-only: played weeks are fixed to actual results; every "
                              "remaining week uses this run's live rosters and MFL projections with "
                              "the shared, un-updated prior N(0, sigma_s^2) -- the same form as a "
                              "fresh preseason run, just re-run on today's data. No persistent "
                              "per-team shock is applied to the published numbers.",
                  "shadow": "each team's shadowShock carries the Bayesian posterior-shock model "
                            "(a normal-normal conjugate update of the season-long shock term, drawn "
                            "from that team's own deviation from `wp` instead of the shared prior) "
                            "-- an internal diagnostic, not backtested, not published. See "
                            "docs/wire/dynamic_forecast_model.md."},
        "teams": rows,
    }
    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        if os.path.exists(out_path):
            raise SystemExit("season_sim: %s already exists -- a live snapshot is never overwritten; "
                             "pick a new path or delete it deliberately first" % out_path)
        open(out_path, "w", encoding="utf-8").write(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def actual_allplay(season, reg_end, cache_dir=None):
    """{fid: regular-season all-play %} from MFL's own weekly results -- every
    week's score against the other eleven, weeks 1..reg_end (the same basis as
    D1 src_standings.allplay_regseason_*, 154 decisions a team)."""
    ap = {}
    for wk in range(1, reg_end + 1):
        wr = fetch(MFL % (season, "weeklyResults", "&W=%d" % wk), cache_dir)["weeklyResults"]
        score = {}
        for m in _as_list(wr.get("matchup")):
            for x in _as_list(m.get("franchise")):
                score[x["id"]] = float(x["score"])
        for x in _as_list(wr.get("franchise")):
            score.setdefault(x["id"], float(x["score"]))
        if len(score) != 12:
            raise SystemExit("season_sim: %d week %d weekly results cover %d teams, not 12" % (season, wk, len(score)))
        for f, s in score.items():
            w = sum(1 for g, o in score.items() if g != f and s > o)
            t = sum(1 for g, o in score.items() if g != f and s == o)
            a = ap.setdefault(f, [0.0, 0])
            a[0] += w + 0.5 * t
            a[1] += len(score) - 1
    return {f: w / n for f, (w, n) in ap.items()}


def _spearman(xs, ys):
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for pos_, i in enumerate(order):
            r[i] = float(pos_)
        return r
    rx, ry = ranks(xs), ranks(ys)
    n = len(xs)
    mx, my = sum(rx) / n, sum(ry) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    return cov / math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))


# BACKTEST (Keith 2026-09-11: "allow back testing via projections which should
# be available in the API? else just use the rec of 70%"). Each past season is
# replayed from the roster it opened with (week 1) and MFL's archived
# projections, at every regression dial in `ks`, and the expected all-play %
# is scored against what happened:
#   rmse   -- typical miss per team-season, in all-play %; the model to beat is
#             "everyone is .500" (rmse = the real spread, about .15)
#   slope  -- actual on predicted; 1.0 means the predicted gaps were the right
#             size, below 1 means the model was overconfident (regress more)
#   rho    -- Spearman rank correlation, the power-ranking order alone
# Caveat that belongs next to any number it produces: the variance targets
# were measured on these same seasons, so this checks the regression dial and
# the ranking, not the noise calibration.
def backtest(seasons, ks, runs, seed, cache_dir, projections="preseason"):
    rows = {k: [] for k in ks}
    per_season = []
    for season in seasons:
        prep = prepare(season, cache_dir, roster_week=1, projections=projections)
        act = actual_allplay(season, prep["reg_end"], cache_dir)
        fids = sorted(prep["teams"])
        for k in ks:
            res = fit(prep, k, runs, seed, collect=False)
            pred = [res["agg"][f]["ap_pct"] / runs for f in fids]
            real = [act[f] for f in fids]
            rows[k].extend(zip(pred, real))
            per_season.append({"season": season, "k": k, "rho": round(_spearman(pred, real), 3),
                               "sigma_s": round(res["sigma_s"], 1)})
    summary = []
    for k in ks:
        pr = rows[k]
        n = len(pr)
        rmse = math.sqrt(sum((p - a) ** 2 for p, a in pr) / n)
        base = math.sqrt(sum((0.5 - a) ** 2 for _, a in pr) / n)
        sxx = sum((p - 0.5) ** 2 for p, _ in pr)
        slope = sum((p - 0.5) * (a - 0.5) for p, a in pr) / sxx if sxx else 0.0
        rhos = [r["rho"] for r in per_season if r["k"] == k]
        summary.append({"k": k, "n": n, "rmse": round(rmse, 4), "rmseEveryone500": round(base, 4),
                        "slope": round(slope, 3), "meanRho": round(sum(rhos) / len(rhos), 3)})
    return {"seasons": list(seasons), "projections": projections, "runs": runs, "summary": summary,
            "perSeason": per_season}


def run(season, runs, seed, cache_dir, out_path, k=REGRESS_DEFAULT):
    global LIVE_SEASON
    LIVE_SEASON = season
    prep = prepare(season, cache_dir, injuries=True)
    league, teams, games, fills, wp_raw = prep["league"], prep["teams"], prep["games"], prep["fills"], prep["wp_raw"]
    parts = prep["parts"]
    reg_end, end = prep["reg_end"], prep["end"]
    res = fit(prep, k, runs, seed)
    wp, proj_var, sigma_w, sigma_s = res["wp"], res["proj_var"], res["sigma_w"], res["sigma_s"]
    table, agg, ap_var = res["table"], res["agg"], res["ap_var"]

    def _pctl(xs, p):
        return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0.0

    rows = []
    for f in sorted(teams):
        a = agg[f]
        exp_ap = a["ap_pct"] / runs
        rows.append({
            "franchiseId": f, "team": teams[f]["name"], "division": teams[f]["division"],
            "projWeekly": round(sum(wp_raw[f][w] for w in range(1, reg_end + 1)) / reg_end, 1),
            "projWeeklyRegressed": round(sum(wp[f][w] for w in range(1, reg_end + 1)) / reg_end, 1),
            "waiverFillSlotWeeks": fills.get(f, 0),
            "projWeeklyOffense": (parts.get(f) or {}).get("O", 0.0),
            "projWeeklyDefense": (parts.get(f) or {}).get("D", 0.0),
            "projWeeklyKicking": (parts.get(f) or {}).get("K", 0.0),
            "expAllPlayPct": round(exp_ap, 4),
            "apP10": round(_pctl(a["ap_samples"], 0.10), 4),
            "apP50": round(_pctl(a["ap_samples"], 0.50), 4),
            "apP90": round(_pctl(a["ap_samples"], 0.90), 4),
            "expWins": round(a["h2h_w"] / runs, 1), "games": games.get(f, 0),
            "pDivision": round(a["div"] / runs, 4), "pPlayoffs": round(a["po"] / runs, 4),
            "pBye": round(a["bye"] / runs, 4), "pTitle": round(a["title"] / runs, 4),
            "pRunnerUp": round(a["runner"] / runs, 4),
            "apRankDist": [round(x / runs, 4) for x in a["ap_rank"]],
        })
    rows.sort(key=lambda r: -r["expAllPlayPct"])
    for i, r in enumerate(rows, 1):
        r["powerRank"] = i
    out = {
        "schema": 1, "season": season,
        "generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "runs": runs, "seed": seed,
        "model": {"regress": k, "sigmaWeekly": round(sigma_w, 2), "sigmaSeason": round(sigma_s, 2),
                  "projectionWithinVar": round(proj_var, 1), "targetWithinVar": TARGET_WITHIN_VAR,
                  "targetApVar": TARGET_AP_VAR, "simApVar": round(ap_var, 5),
                  "calibration": table, "regularSeasonWeeks": reg_end, "endWeek": end,
                  "replacementRankByGroup": REPLACEMENT_RANK_BY_GROUP,
                  "divisionTiebreak": league.get("standingsSort")},
        "powerRankBasis": "expected regular-season all-play %, schedule-neutral",
        # What one simulated season looks like: the all-play that lands at each
        # finishing place, and where the champion finished in all-play.
        "seasonShape": {"byFinish": [round(x, 4) for x in agg["_shape"]["byFinish"]],
                        "champApRank": [round(x, 4) for x in agg["_shape"]["champApRank"]]},
        "teams": rows,
        "seasonProjections": {"weeks": [1, end], "groups": list(SEASON_PROJ_GROUPS),
                              "players": season_projections(prep["proj"], prep["pos"], end)},
        # Rostered players the forecast holds out, and for which weeks.
        "absences": prep["absent"],
    }
    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        open(out_path, "w", encoding="utf-8").write(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int)
    ap.add_argument("--runs", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=20260911)
    ap.add_argument("--cache-dir", default=None, help="reuse MFL responses from this directory")
    ap.add_argument("--out", default=None)
    ap.add_argument("--regress", type=float, default=REGRESS_DEFAULT,
                    help="share of each team's projected edge to keep (1.0 = none regressed)")
    ap.add_argument("--backtest", default=None, metavar="2021-2025",
                    help="replay these past seasons from their week-1 rosters and score each --ks value")
    ap.add_argument("--ks", default="1.0,0.9,0.8,0.7,0.6,0.5,0.4,0.3")
    ap.add_argument("--projections", choices=("preseason", "weekly"), default="preseason",
                    help="backtest only: preseason = week-1 projections carried forward (honest); "
                         "weekly = MFL's archived week-of projections (knows in-season news)")
    ap.add_argument("--through-week", type=int, default=None,
                    help="live update: blend the preseason forecast with actual results through this "
                         "week instead of running a fresh preseason forecast")
    ap.add_argument("--mfl-offense", action="store_true",
                    help="live update only: use MFL's own (touchdown-rounded) offensive projections instead of "
                         "expected-value ones (ev_projections.py)")
    ap.add_argument("--preseason-file", default=None,
                    help="live update only: path to the preseason JSON (default site/wire/data/"
                         "season_sim_<season>.json), read as the immutable prior")
    a = ap.parse_args()
    if a.through_week:
        if not a.season:
            ap.error("--season is required with --through-week")
        out = run_live(a.season, a.through_week, a.runs, a.seed, a.cache_dir, a.out, k=a.regress,
                       preseason_path=a.preseason_file, ev_offense=not a.mfl_offense)
        print("live update: season %d through week %d, %d runs" % (a.season, a.through_week, a.runs))
        print("OFFICIAL = refresh-only (no persistent shock). shadow cols = permanent Bayesian shock "
              "model, internal diagnostic only -- not published.")
        print("rank team                 wk score  wk rk  cur AP   proj end AP  cur PO%%  cur title%%  "
              "title chg  | shadow title%%  shadow chg")
        for r in out["teams"]:
            chg = r["titleOddsChange"]
            sh = r["shadowShock"]
            shg = sh["titleOddsChange"]
            print("     %-20s %7.1f  %5d  %6.1f%%     %6.1f%%    %6.1f%%    %6.1f%%   %+.1f%%   |    %6.1f%%     %+.1f%%" % (
                (r["team"] or "")[:20], r["weekScore"], r["weekRank"], 100 * r["currentApPct"],
                100 * r["projectedEndingApPct"], 100 * r["currentPlayoffOdds"], 100 * r["currentTitleOdds"],
                100 * chg if chg is not None else 0.0,
                100 * sh["currentTitleOdds"], 100 * shg if shg is not None else 0.0))
        return 0
    if a.backtest:
        lo, _, hi = a.backtest.partition("-")
        seasons = range(int(lo), int(hi or lo) + 1)
        ks = [float(x) for x in a.ks.split(",")]
        bt = backtest(seasons, ks, a.runs, a.seed, a.cache_dir, a.projections)
        if a.out:
            open(a.out, "w", encoding="utf-8").write(json.dumps(bt, indent=1) + "\n")
        print("backtest %s, %s projections, %d runs/season" % (a.backtest, a.projections, a.runs))
        print("  k     rmse   (everyone .500)  slope   mean rho")
        for r in bt["summary"]:
            print("%5.2f  %.4f   (%.4f)          %5.3f   %5.3f" % (
                r["k"], r["rmse"], r["rmseEveryone500"], r["slope"], r["meanRho"]))
        return 0
    if not a.season:
        ap.error("--season is required unless --backtest is given")
    out = run(a.season, a.runs, a.seed, a.cache_dir, a.out, k=a.regress)
    m = out["model"]
    print("sigma_w %.1f  sigma_s %.1f  (sim AP var %.4f vs target %.4f)" % (
        m["sigmaWeekly"], m["sigmaSeason"], m["simApVar"], m["targetApVar"]))
    print("rank team                 proj/wk  expAP   wins   div%   PO%   bye%  title%")
    for r in out["teams"]:
        print("%3d  %-20s %6.1f  %.3f  %5.1f  %5.1f  %5.1f  %5.1f  %5.1f" % (
            r["powerRank"], (r["team"] or "")[:20], r["projWeekly"], r["expAllPlayPct"], r["expWins"],
            100 * r["pDivision"], 100 * r["pPlayoffs"], 100 * r["pBye"], 100 * r["pTitle"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
