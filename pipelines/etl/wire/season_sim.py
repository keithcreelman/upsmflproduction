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
import urllib.request
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lineup_engine as LE  # noqa: E402

MFL = "https://www48.myfantasyleague.com/%d/export?TYPE=%s&L=74598&JSON=1%s"
MFL_PLAYERS = "https://api.myfantasyleague.com/%d/export?TYPE=players&JSON=1"

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
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if path:
        os.makedirs(cache_dir, exist_ok=True)
        json.dump(data, open(path, "w", encoding="utf-8"))
    return data


def load_inputs(season, cache_dir=None):
    league = fetch(MFL % (season, "league", ""), cache_dir)["league"]
    reg_end = int(league.get("lastRegularSeasonWeek") or 14)
    end = int(league.get("endWeek") or 17)
    fr = _as_list(league["franchises"]["franchise"])
    teams = {f["id"]: {"name": f.get("name"), "division": f.get("division")} for f in fr}
    pos = {p["id"]: p.get("position") for p in fetch(MFL_PLAYERS % season, cache_dir)["players"]["player"]}

    rosters, rostered = {}, set()
    for f in _as_list(fetch(MFL % (season, "rosters", ""), cache_dir)["rosters"]["franchise"]):
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


def simulate(teams, sched, wp, reg_end, end, runs, sigma_w, sigma_s, rng, collect=True):
    fids = sorted(teams)
    agg = {f: {"h2h_w": 0.0, "ap_pct": 0.0, "div": 0, "po": 0, "bye": 0, "title": 0, "runner": 0,
               "ap_rank": [0] * len(fids)} for f in fids}
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
            agg[f]["ap_pct"] += st[f]["ap_pct"]
        for f in dws:
            agg[f]["div"] += 1
        for f in seeds:
            agg[f]["po"] += 1
        for f in seeds[:2]:
            agg[f]["bye"] += 1
        agg[champ]["title"] += 1
        agg[runner]["runner"] += 1
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


def run(season, runs, seed, cache_dir, out_path, k=REGRESS_DEFAULT):
    league, teams, rosters, sched, proj, reg_end, end, pos, rostered = load_inputs(season, cache_dir)
    games = {}
    for wk, ms in sched.items():
        for a, b in ms:
            games[a] = games.get(a, 0) + 1; games[b] = games.get(b, 0) + 1
    if set(games.values()) != {37} and season == 2026:
        raise SystemExit("season_sim: expected 37 regular-season games per team, got %s" % sorted(set(games.values())))
    rep = replacement_levels(proj, pos, rostered, end, reg_end)
    wp_raw, fills = weekly_projections(rosters, proj, end, rep)
    wp = regress(wp_raw, k)
    proj_var = _within_var_of_projections(wp, reg_end)
    sigma_w = math.sqrt(max(TARGET_WITHIN_VAR - proj_var, 0.0))
    sigma_s, table = calibrate(teams, sched, wp, reg_end, end, sigma_w, max(500, runs // 5), seed)
    agg, ap_var = simulate(teams, sched, wp, reg_end, end, runs, sigma_w, sigma_s, random.Random(seed))

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
        "teams": rows,
    }
    if out_path:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        open(out_path, "w", encoding="utf-8").write(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--runs", type=int, default=10000)
    ap.add_argument("--seed", type=int, default=20260911)
    ap.add_argument("--cache-dir", default=None, help="reuse MFL responses from this directory")
    ap.add_argument("--out", default=None)
    ap.add_argument("--regress", type=float, default=REGRESS_DEFAULT,
                    help="share of each team's projected edge to keep (1.0 = none regressed)")
    a = ap.parse_args()
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
