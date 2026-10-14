#!/usr/bin/env python3
"""Division titles in the season simulation: one champion per division in every
simulated season, MFL's tiebreak order (PCT, DIVPCT, H2H, PTS, ALL_PLAY_PCT), raw
division odds that total exactly 100%, and a display rounding that keeps them at
100.0. Keith's Week 5 review (2026-10-14): "Do not normalize broken raw results
merely to make the display look correct. First verify that every simulation
assigns the division properly."

    python3 pipelines/etl/wire/test_season_sim_divisions.py
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import season_sim as S                 # noqa: E402

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:400]))
    if not cond:
        fails += 1


def st(pct, divpct, pf, ap):
    return {"pct": pct, "divpct": divpct, "pf": pf, "ap_pct": ap}


print("1. the tiebreak order, one rule at a time")
W = S.division_winner
check("overall record decides first (even against division record, points and all-play)",
      W(["A", "B"], {"A": st(.60, .20, 100, .1), "B": st(.50, 1.0, 999, .9)}, {}) == "A")
check("equal record -> division record decides",
      W(["A", "B"], {"A": st(.50, .60, 100, .1), "B": st(.50, .40, 999, .9)}, {}) == "A")
check("equal record and division record -> HEAD-TO-HEAD decides, ahead of points",
      W(["A", "B"], {"A": st(.5, .5, 100, .1), "B": st(.5, .5, 999, .9)}, {"A": {"B": 3}, "B": {"A": 2}}) == "A")
check("head-to-head split (ties count half) -> points decide",
      W(["A", "B"], {"A": st(.5, .5, 100, .9), "B": st(.5, .5, 101, .1)}, {"A": {"B": 2.5}, "B": {"A": 2.5}}) == "B")
check("points equal too -> all-play decides",
      W(["A", "B"], {"A": st(.5, .5, 100, .4), "B": st(.5, .5, 100, .6)}, {"A": {"B": 2.5}, "B": {"A": 2.5}}) == "B")
check("H2H applies only among teams STILL tied (a third team with a worse record cannot interfere)",
      W(["A", "B", "C"], {"A": st(.5, .5, 1, .1), "B": st(.5, .5, 9, .9), "C": st(.3, .9, 99, .99)},
        {"A": {"B": 3, "C": 0}, "B": {"A": 2, "C": 5}, "C": {"A": 5, "B": 0}}) == "A")
check("three-way tie with a circular head-to-head -> points decide",
      W(["A", "B", "C"], {"A": st(.5, .5, 1, .9), "B": st(.5, .5, 3, .1), "C": st(.5, .5, 2, .5)},
        {"A": {"B": 3, "C": 2}, "B": {"A": 2, "C": 3}, "C": {"A": 3, "B": 2}}) == "B")
rng = random.Random(7)
ok = True
for _ in range(5000):
    mem = ["A", "B", "C"]
    s = {f: st(rng.choice([.4, .5, .6]), rng.choice([.3, .5, .7]), rng.choice([100, 200]), rng.choice([.4, .6])) for f in mem}
    h = {f: {g: float(rng.randint(0, 5)) for g in mem if g != f} for f in mem}
    ok &= W(mem, s, h) in mem
check("always returns exactly one member of the division (5,000 random tie-heavy states)", ok)

print("2. inside the simulation")
DIVS = {"00": ["01", "02", "03"], "01": ["04", "05", "06"], "02": ["07", "08", "09"], "03": ["10", "11", "12"]}
teams = {f: {"division": d} for d, fs in DIVS.items() for f in fs}
fids = sorted(teams)
reg_end, end = 6, 9
sched = {}
for wk in range(1, reg_end + 1):
    games = [(fs[0], fs[1]) for fs in DIVS.values()] + [(fs[0], fs[2]) for fs in DIVS.values()] + [(fs[1], fs[2]) for fs in DIVS.values()]
    sched[wk] = games + [("01", "04"), ("07", "10")] if wk % 2 else games + [("02", "05"), ("08", "11")]
wp = {f: {wk: 150 + 3 * (i % 5) for wk in range(1, end + 1)} for i, f in enumerate(fids)}   # near-equal: ties are common
runs, per_run_ok, seen = 3000, [True], [0]


def hook(stt, champ, runner, seeds, drawn, dw):
    seen[0] += 1
    per_run_ok[0] &= len(dw) == 4 and sorted(teams[f]["division"] for f in dw) == sorted(DIVS)


agg, _ = S.simulate(teams, sched, wp, reg_end, end, runs, 25.0, 8.0, random.Random(11), collect=True, hook=hook)
check("every one of %d simulated seasons crowned exactly one champion in each of the 4 divisions" % runs,
      seen[0] == runs and per_run_ok[0], (seen[0], per_run_ok[0]))
sums = {d: sum(agg[f]["div"] for f in fs) for d, fs in DIVS.items()}
check("raw division-title counts total exactly the number of seasons in every division (=100% before rounding)",
      all(v == runs for v in sums.values()), sums)

# A scripted season the old points-first rule gets wrong: in division 00, team 01
# beats 02 three times in five, both finish 7-3 overall and in the division, but
# 02 scored far more points. MFL's order (H2H before PTS) makes 01 the champion.
A, B, C = "01", "02", "03"
order = {1: (A, B, C), 2: (A, B, C), 3: (A, B, C), 4: (B, A, C), 5: (B, C, A)}
big = {1: {A: 101, B: 100, C: 50}, 2: {A: 101, B: 100, C: 50}, 3: {A: 101, B: 100, C: 50},
       4: {B: 200, A: 100, C: 50}, 5: {B: 200, C: 60, A: 55}}
sched2 = {wk: [(A, B), (A, C), (B, C)] for wk in range(1, 6)}
actual = {wk: dict({f: 120.0 + int(f) for f in fids if f not in (A, B, C)}, **big[wk]) for wk in range(1, 6)}
wp2 = {f: {wk: 150.0 for wk in range(1, 9)} for f in fids}
agg2, _ = S.simulate(teams, sched2, wp2, 5, 8, 500, 20.0, 5.0, random.Random(3), collect=True, actual=actual)
pf = {f: sum(actual[wk][f] for wk in actual) for f in (A, B)}
old_rule = lambda f: (-0.7, -0.7, -pf[f])                       # pre-2026-10-14 key: PCT, DIVPCT, then straight to PTS
check("the old points-first rule would have crowned 02 in that season (so the test can tell the rules apart)",
      sorted((A, B), key=old_rule)[0] == B)
check("scripted tie: 01 and 02 both 7-3, 01 won the head-to-head 3-2, 02 scored more (%.0f vs %.0f) -> 01 wins the division every time"
      % (pf[B], pf[A]), agg2[A]["div"] == 500 and agg2[B]["div"] == 0, (agg2[A]["div"], agg2[B]["div"]))

print("3. the published Week 5 forecast")
data = os.path.join(HERE, "..", "..", "..", "site", "wire", "data")
for fn in ("season_sim_2026_live_wk05.json",):
    p = os.path.join(data, fn)
    if not os.path.exists(p):
        print("  skip %s (not in this checkout)" % fn)
        continue
    sim = json.load(open(p))
    bydiv = {}
    for t in sim["teams"]:
        bydiv.setdefault(t["division"], {})[t["franchiseId"]] = t["currentDivisionOdds"]
    check("%s: 4 divisions of 3" % fn, len(bydiv) == 4 and all(len(v) == 3 for v in bydiv.values()), {d: len(v) for d, v in bydiv.items()})
    for d, probs in sorted(bydiv.items()):
        raw = sum(probs.values())
        shown = S.display_percentages(probs)
        check("division %s: raw odds total %.12f (=1); shown %s total exactly 100.0" % (d, raw, "/".join(shown[f] for f in sorted(shown))),
              abs(raw - 1.0) < 1e-9 and abs(sum(float(x) for x in shown.values()) - 100.0) < 1e-9)

print("4. the display rounding rule")
r = S.display_percentages({"a": 0.95654, "b": 0.02996, "c": 0.0135})
check("largest-remainder rounding: 95.654/2.996/1.350 -> 95.7/3.0/1.3, total exactly 100.0 (plain rounding would show 100.1)",
      r == {"a": "95.7", "b": "3.0", "c": "1.3"} and abs(sum(float(x) for x in r.values()) - 100.0) < 1e-9, r)
r2 = S.display_percentages({"a": 1 / 3, "b": 1 / 3, "c": 1 / 3})
check("thirds show as 33.4/33.3/33.3 (the leftover tenth goes to the first key on equal remainders)", r2 == {"a": "33.4", "b": "33.3", "c": "33.3"}, r2)
r3 = S.display_percentages({"a": 0.5, "b": 0.5})
check("values that round exactly are untouched", r3 == {"a": "50.0", "b": "50.0"}, r3)

print("\n" + ("ALL PASS" if not fails else "%d FAILURE(S)" % fails))
sys.exit(1 if fails else 0)
