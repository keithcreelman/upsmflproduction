#!/usr/bin/env python3
"""The Standings page's Forecast is the UPS Wire's own season simulation, counted more ways
(Keith 2026-10-21: "Build Forecast from the same simulation and calculation used by UPS Wire.
Do not create a second forecasting model ... The Forecast must reconcile with Full League,
Divisions and Playoff Picture").

  1. season_sim's own seeding, run on the real 2026 Weeks 1-6, gives exactly the order, seeds,
     division winners, all-play and records production's /api/standings showed for Week 6.
  2. The Hawk Tuah Bowl draws from its own random stream: every number published before it
     existed comes out the same, run for run.
  3. The new counts agree with the old ones and with each other in every simulated season, including
     each final counted as a (champion, runner-up) pair (#1370 gate 3: the most likely matchup).
  4. The bracket re-seeds after round 1, as every season 2016-2025 did.

Offline: a committed fixture of public MFL results, no MFL, D1 or network.
    python3 pipelines/etl/wire/test_season_sim_standings_forecast.py
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import season_sim as S                 # noqa: E402

FIXTURE = os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "standings_forecast_2026_wk06.json")
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:600]))
    if not cond:
        fails += 1


print("1. season_sim's seeding on the real 2026 Weeks 1-6 = the Standings page's Week 6")
fx = json.load(open(FIXTURE, encoding="utf-8"))
teams = fx["teams"]
fids = sorted(teams)
wk = fx["throughWeek"]
sched = {int(w): [tuple(g) for g in gs] for w, gs in fx["schedule"].items()}
actual = {int(w): s for w, s in fx["scores"].items()}
# The regular season "ends" at Week 6: every regular-season week is a real result, so the one
# simulated season is the real standings. The playoff weeks after it are irrelevant here.
wp = {f: {w: 0.0 for w in range(1, wk + 4)} for f in fids}
seen = {}


def hook(stt, champ, runner, seeds, drawn, dw):
    seen.update(st=stt, seeds=list(seeds), dw=set(dw))


agg, _ = S.simulate(teams, sched, wp, wk, wk + 3, 1, 25.0, 0.0, random.Random(1), collect=True,
                    hook=hook, actual=actual)
order = [None] * len(fids)
for f in fids:
    order[agg[f]["place"].index(1)] = f
W = fx["worker"]
check("full-league order, 1-12, matches /api/standings Week 6 (seed_by_week)", order == W["order"], (order, W["order"]))
check("playoff seeds 1-6 match", {f: i + 1 for i, f in enumerate(seen["seeds"])}
      == {f: t["playoff_seed"] for f, t in W["teams"].items() if t["playoff_seed"]})
check("division winners match (MFL standingsSort %s)" % W["standingsSort"],
      seen["dw"] == {f for f, t in W["teams"].items() if t["is_division_leader"]})


def tally(f):
    apw = sum(1 for w in actual for g in fids if g != f and actual[w][f] > actual[w][g])
    apl = sum(1 for w in actual for g in fids if g != f and actual[w][f] < actual[w][g])
    apt = sum(1 for w in actual for g in fids if g != f and actual[w][f] == actual[w][g])
    rec = [0, 0, 0]
    for w, gs in sched.items():
        for a, b in gs:
            if f in (a, b):
                o = b if f == a else a
                rec[0 if actual[w][f] > actual[w][o] else 1 if actual[w][f] < actual[w][o] else 2] += 1
    return [apw, apl, apt], rec, round(sum(actual[w][f] for w in actual), 1)


bad = [(f, tally(f), W["teams"][f]) for f in fids
       if tally(f) != (W["teams"][f]["all_play"], W["teams"][f]["record"], W["teams"][f]["points_for"])]
check("all-play W-L-T, record W-L-T and points for match for all 12 teams", not bad, bad)

print("2. the Hawk Tuah Bowl's own random stream changes nothing published before it")
DIVS = {"00": ["01", "02", "03"], "01": ["04", "05", "06"], "02": ["07", "08", "09"], "03": ["10", "11", "12"]}
syn = {f: {"division": d} for d, fs in DIVS.items() for f in fs}
sf = sorted(syn)
reg_end, end = 6, 9
ssched = {}
for w in range(1, reg_end + 1):
    gs = [(fs[0], fs[1]) for fs in DIVS.values()] + [(fs[0], fs[2]) for fs in DIVS.values()] + [(fs[1], fs[2]) for fs in DIVS.values()]
    ssched[w] = gs + [("01", "04"), ("07", "10")] if w % 2 else gs + [("02", "05"), ("08", "11")]
swp = {f: {w: 140 + 4 * (i % 6) for w in range(1, end + 1)} for i, f in enumerate(sf)}
runs = 4000
a0, v0 = S.simulate(syn, ssched, swp, reg_end, end, runs, 25.0, 8.0, random.Random(5), collect=True)
a1, v1 = S.simulate(syn, ssched, swp, reg_end, end, runs, 25.0, 8.0, random.Random(5), collect=True,
                    rng_hawk=random.Random(6))
OLD = ("h2h_w", "ap_pct", "div", "po", "bye", "title", "runner", "ap_rank", "ap_samples", "place")
check("h2h, all-play, division, playoff, bye, title and runner-up counts identical with and without it",
      all(a0[f][k] == a1[f][k] for f in sf for k in OLD) and v0 == v1 and a0["_shape"] == a1["_shape"])
check("without it, no Hawk Tuah games are counted", all(a0[f]["hawk_title"] == 0 for f in sf))

print("3. the new counts agree with the old ones")
out = S.standings_forecast(a1, sf, runs, 5)
check("standings_forecast() accepts them (place 1-6 = playoffs, 1-2 = bye, one team per place and final)",
      set(out["teams"]) == set(sf))
check("a team reaches a UPS final only from places 1-6, a Hawk Tuah final only from 7-12",
      all(a1[f]["title"] + a1[f]["runner"] <= sum(a1[f]["place"][:6])
          and a1[f]["hawk_title"] + a1[f]["hawk_runner"] <= sum(a1[f]["place"][6:]) for f in sf))
check("expected place is the mean of the place distribution",
      all(abs(out["teams"][f]["expectedPlace"] - sum((i + 1) * p for i, p in enumerate(out["teams"][f]["place"]))) < 0.02
          for f in sf))
broken = {f: dict(a1[f], place=list(a1[f]["place"])) for f in sf}
broken[sf[0]]["place"][0] -= 1
broken[sf[0]]["place"][7] += 1
try:
    S.standings_forecast(broken, sf, runs, 5)
    refused = False
except AssertionError:
    refused = True
check("a place count that disagrees with the playoff count stops the run", refused)
check("the (champion, runner-up) pair counts change no draw: identical with and without the Hawk Tuah stream",
      a0["_finals"]["ups"] == a1["_finals"]["ups"])
for side, ck, rk in (("ups", "title", "runner"), ("hawk", "hawk_title", "hawk_runner")):
    fp = out["finalPairs"][side]
    check(side + ": every simulated season has exactly one final pair", abs(sum(p for _, _, p in fp) - 1) < 0.002
          and sum(a1["_finals"][side].values()) == runs)
    check(side + ": a team's champion pairs add up to its title odds, its runner-up pairs to its runner-up odds",
          all(abs(sum(p for c, _, p in fp if c == f) - out["teams"][f]["titleOdds" if side == "ups" else "hawkTitleOdds"]) < 0.003
              and abs(sum(p for _, r, p in fp if r == f) - out["teams"][f]["runnerUpOdds" if side == "ups" else "hawkRunnerUpOdds"]) < 0.003
              for f in sf))
    check(side + ": most common first, no team plays itself",
          [p for _, _, p in fp] == sorted((p for _, _, p in fp), reverse=True) and all(c != r for c, r, _ in fp))
bad_pairs = dict(a1, _finals={"ups": dict(a1["_finals"]["ups"]), "hawk": a1["_finals"]["hawk"]})
k0 = next(iter(bad_pairs["_finals"]["ups"]))
bad_pairs["_finals"]["ups"][k0] += 1
try:
    S.standings_forecast(bad_pairs, sf, runs, 5)
    refused = False
except AssertionError:
    refused = True
check("final pairs that disagree with the champion counts stop the run", refused)

print("4. the bracket re-seeds after round 1")
side = ["s1", "s2", "s3", "s4", "s5", "s6"]
games = []


def upset_36(a, b, w):
    games.append((a, b, w))
    if {a, b} == {"s3", "s6"}:
        return "s6"
    return a if side.index(a) < side.index(b) else b


champ, runner = S.bracket(side, upset_36, 14, 17)
check("6 beats 3 -> week 16 is 1 v 6 and 2 v 4 (not 1 v 4-5 winner)",
      ("s1", "s6", 16) in games and ("s2", "s4", 16) in games, games)
check("final in week 17, favorite wins, runner-up is the other finalist", (champ, runner) == ("s1", "s2") and games[-1][2] == 17)

print("\nALL PASS" if not fails else "\n%d FAILED" % fails)
sys.exit(1 if fails else 0)
