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


def fetch(url, cache_dir=None):
    key = hashlib.sha1(url.encode()).hexdigest()[:16]
    path = os.path.join(cache_dir, key + ".json") if cache_dir else None
    if path and os.path.exists(path):
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


def load_inputs(season, cache_dir=None, roster_week=None):
    """roster_week=None is today's roster; the backtest passes 1 for the roster a
    past season actually opened with (MFL serves real point-in-time rosters for
    2021+: 2025's week-1 and week-14 rosters differ by 354 players)."""
    league = fetch(MFL % (season, "league", ""), cache_dir)["league"]
    reg_end = int(league.get("lastRegularSeasonWeek") or 14)
    end = int(league.get("endWeek") or 17)
    fr = _as_list(league["franchises"]["franchise"])
    teams = {f["id"]: {"name": f.get("name"), "division": f.get("division")} for f in fr}
    pos = {p["id"]: p.get("position") for p in fetch(MFL_PLAYERS % season, cache_dir)["players"]["player"]}

    rosters, rostered = {}, set()
    rw = "&W=%d" % roster_week if roster_week else ""
    for f in _as_list(fetch(MFL % (season, "rosters", rw), cache_dir)["rosters"]["franchise"]):
        rows = []
        for p in _as_list(f.get("player")):
            if not p:
                continue
            rostered.add(p["id"])          # any status: taxi and IR are not free agents
            if p.get("status") != "ROSTER":
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
    return league, teams, rosters, sched, proj, reg_end, end, pos, rostered


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


def weekly_projections(rosters, proj, end, rep=None):
    """({fid: {week: projected points of the best legal lineup}}, {fid: replacement slot-weeks}).

    The pool is the active roster plus replacement-level bodies (see
    REPLACEMENT_RANK_BY_GROUP); a replacement only starts where it beats every eligible
    rostered player, and each start is counted so the reviews can say how often
    a team is leaning on the wire."""
    out, fills = {}, {}
    for fid, rows in rosters.items():
        out[fid], fills[fid] = {}, 0
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
    return out, fills


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


def simulate(teams, sched, wp, reg_end, end, runs, sigma_w, sigma_s, rng, collect=True, hook=None):
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
    for _ in range(runs):
        shock = {f: rng.gauss(0, sigma_s) for f in fids}
        rec = {f: {"w": 0, "l": 0, "t": 0, "dw": 0, "dl": 0, "apw": 0, "apl": 0, "pf": 0.0} for f in fids}
        for wk in range(1, reg_end + 1):
            score = {f: wp[f][wk] + shock[f] + rng.gauss(0, sigma_w) for f in fids}
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
        for i, f in enumerate(sorted(fids, key=lambda f2: -st[f2]["ap_pct"])):
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

        for i, f in enumerate(sorted(fids, key=lambda f: -st[f]["ap_pct"])):
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
        champ_ap_rank[sorted(fids, key=lambda f2: -st[f2]["ap_pct"]).index(champ)] += 1
        # Diagnostics (inert in production): one call per simulated season, so a
        # caller can ask what the CHAMPION's realized all-play looks like rather
        # than what a team's mean is. Keith 2026-09-12: ".598 for a league
        # champion feels low ... which might make sense since this is the mean".
        if hook is not None:
            hook(st, champ, runner, seeds)
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


def prepare(season, cache_dir=None, roster_week=None, projections="weekly", injuries=False):
    """Everything that does not depend on the regression dial."""
    league, teams, rosters, sched, proj, reg_end, end, pos, rostered = load_inputs(season, cache_dir, roster_week)
    games = {}
    for wk, ms in sched.items():
        for a, b in ms:
            games[a] = games.get(a, 0) + 1; games[b] = games.get(b, 0) + 1
    if set(games.values()) != {37} and season == 2026:
        raise SystemExit("season_sim: expected 37 regular-season games per team, got %s" % sorted(set(games.values())))
    if projections == "preseason":
        proj = preseason_view(proj, season, cache_dir, end)
    # Only the live forecast takes injuries: a backtest must see what MFL said
    # at the time, and the feed only knows today.
    absent = absences(season, cache_dir, end) if injuries else {}
    for pid, a in absent.items():
        for wk in a["weeks"]:
            (proj.get(wk) or {}).pop(pid, None)
    rep = replacement_levels(proj, pos, rostered, end, reg_end)
    wp_raw, fills = weekly_projections(rosters, proj, end, rep)
    return {"league": league, "teams": teams, "sched": sched, "reg_end": reg_end, "end": end,
            "games": games, "wp_raw": wp_raw, "fills": fills, "proj": proj, "pos": pos,
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
    prep = prepare(season, cache_dir, injuries=True)
    league, teams, games, fills, wp_raw = prep["league"], prep["teams"], prep["games"], prep["fills"], prep["wp_raw"]
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
    a = ap.parse_args()
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
