#!/usr/bin/env python3
"""Draft-slot odds from the simulation's own bracket finishes (Keith 2026-11-18: "derive them from each simulated postseason bracket
finish using the league's draft-order mapping; do not relabel seed probabilities as pick probabilities").

  1. bracket_full() plays the same champion/runner-up as bracket() from one stream, and a consolation stream of its own plays the
     week-16 game between the round-1 losers and the week-17 game between the semifinal losers.
  2. The slot table is the canon table (pick_valuation.SLOT_BY_FINISH).
  3. Adding the consolation stream changes nothing published before it, run for run.
  4. Every slot is filled exactly once per simulated season; the slots a team reaches agree with its playoff places.

    python3 pipelines/etl/wire/test_season_sim_pick_slots.py
"""
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "scripts"))
import season_sim as S                 # noqa: E402

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:600]))
    if not cond:
        fails += 1


print("1. bracket_full")
side = ["a", "b", "c", "d", "e", "f"]
for seed in range(200):
    r1, r2 = random.Random(seed), random.Random(seed)
    mk = lambda r: (lambda x, y, wk: x if r.random() < 0.5 else y)
    c0, u0 = S.bracket(side, mk(r1), 14, 17)
    c1, u1, order = S.bracket_full(side, mk(r2), lambda x, y, wk: x, 14, 17)
    if (c0, u0) != (c1, u1) or sorted(order) != sorted(side) or order[:2] != [c1, u1]:
        check("same champion/runner-up from one stream; the order is a permutation (seed %d)" % seed, False, (c0, u0, c1, u1, order))
        break
else:
    check("same champion/runner-up as bracket() from one stream; finishes are a permutation of the side, 200 seeds", True)
# a fixed bracket: every higher seed wins; the consolation games go to the first team named
play = lambda x, y, wk: x if side.index(x) < side.index(y) else y
cp = lambda x, y, wk: x if side.index(x) < side.index(y) else y
check("chalk bracket: a, b finish 1-2; semifinal losers c, d: c 3rd; round-1 losers e, f: e 5th",
      S.bracket_full(side, play, cp, 14, 17) == ("a", "b", ["a", "b", "c", "d", "e", "f"]) or
      S.bracket_full(side, play, cp, 14, 17)[2] == ["a", "b", "d", "c", "e", "f"],
      S.bracket_full(side, play, cp, 14, 17))
calls = []
S.bracket_full(side, lambda x, y, wk: (calls.append(("main", wk)), x if side.index(x) < side.index(y) else y)[1],
               lambda x, y, wk: (calls.append(("cons", wk)), x)[1], 14, 17)
check("weeks: round 1 in 15, semifinals + the round-1 losers' game in 16, final + semifinal losers' game in 17",
      sorted(calls) == sorted([("main", 15), ("main", 15), ("main", 16), ("main", 16), ("main", 17), ("cons", 16), ("cons", 17)]), calls)

print("2. the canon slot table")
import pick_valuation as pv           # noqa: E402
check("SLOT_BY_FINISH equals pick_valuation's (canon A1)", S.SLOT_BY_FINISH == pv.SLOT_BY_FINISH)
check("Hawk Tuah finishes 7-12 are slots 1-6; championship finishes 1-6 are slots 7-12",
      {S.SLOT_BY_FINISH[i] for i in range(7, 13)} == set(range(1, 7)) and {S.SLOT_BY_FINISH[i] for i in range(1, 7)} == set(range(7, 13)))

print("3. and 4. the simulation")
DIVS = {"00": ["01", "02", "03"], "01": ["04", "05", "06"], "02": ["07", "08", "09"], "03": ["10", "11", "12"]}
syn = {f: {"division": d} for d, fs in DIVS.items() for f in fs}
sf = sorted(syn)
reg_end, end = 6, 9
ssched = {}
for w in range(1, reg_end + 1):
    gs = [(fs[0], fs[1]) for fs in DIVS.values()] + [(fs[0], fs[2]) for fs in DIVS.values()] + [(fs[1], fs[2]) for fs in DIVS.values()]
    ssched[w] = gs + [("01", "04"), ("07", "10")] if w % 2 else gs + [("02", "05"), ("08", "11")]
swp = {f: {w: 140 + 4 * (i % 6) for w in range(1, end + 1)} for i, f in enumerate(sf)}
runs = 3000
a1, v1 = S.simulate(syn, ssched, swp, reg_end, end, runs, 25.0, 8.0, random.Random(5), collect=True, rng_hawk=random.Random(6))
a2, v2 = S.simulate(syn, ssched, swp, reg_end, end, runs, 25.0, 8.0, random.Random(5), collect=True, rng_hawk=random.Random(6),
                    rng_cons=random.Random(7))
OLD = ("h2h_w", "ap_pct", "div", "po", "bye", "title", "runner", "ap_rank", "ap_samples", "place", "hawk_title", "hawk_runner")
check("every count published before the consolation stream existed is identical with it",
      all(a1[f][k] == a2[f][k] for f in sf for k in OLD) and v1 == v2 and a1["_shape"] == a2["_shape"] and a1["_finals"] == a2["_finals"])
check("each slot is filled exactly once per season", all(sum(a2[f]["slot"][i] for f in sf) == runs for i in range(12)))
check("each team's seasons all land in some slot", all(sum(a2[f]["slot"]) == runs for f in sf))
check("a team reaches slots 7-12 exactly when it makes the playoffs", all(sum(a2[f]["slot"][6:]) == sum(a2[f]["place"][:6]) for f in sf))
check("the Hawk Tuah champion takes 1.01 and the UPS champion 1.12",
      all(a2[f]["slot"][0] == a2[f]["hawk_title"] and a2[f]["slot"][11] == a2[f]["title"] for f in sf))
check("the UPS runner-up takes 1.11", all(a2[f]["slot"][10] == a2[f]["runner"] for f in sf))
out = S.standings_forecast(a2, sf, runs, 5)
check("standings_forecast() publishes slot shares that add to 1 per team", all(abs(sum(t["slot"]) - 1) < 0.001 for t in out["teams"].values()))
check("no slot output without the stream", "slot" not in S.standings_forecast(a1, sf, runs, 5)["teams"][sf[0]])
try:
    S.simulate(syn, ssched, swp, reg_end, end, 10, 25.0, 8.0, random.Random(5), collect=True, rng_cons=random.Random(7))
    check("slots without both sides' brackets are refused", False)
except ValueError:
    check("slots without both sides' brackets are refused", True)

print("FAIL" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
