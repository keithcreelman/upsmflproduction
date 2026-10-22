#!/usr/bin/env python3
"""season_sim.bracket plays the same bracket rule as the Standings pages (#1370 gate 2: one rule
for Forecast, desktop and phone). Round 1 is 3 v 6 and 4 v 5; round 2 re-seeds, the top seed
meeting the lowest seed left; the final is the round-2 winners. UPS Championship and Hawk Tuah
Bowl alike.

The vectors are shared with tests/standings_bracket_reseed.test.mjs (site/shared/standings_race.js):
MFL's own archived brackets for every 6-team side 2014-2025, plus a synthetic upset for each
opening-round outcome on both sides.

Offline: a committed fixture of public MFL results, no MFL, D1 or network.
    python3 pipelines/etl/wire/test_season_sim_bracket_reseed.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import season_sim as S                 # noqa: E402

FIXTURE = os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "bracket_reseed_vectors.json")
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:600]))
    if not cond:
        fails += 1


def play_vector(v):
    """Run season_sim.bracket with the vector's recorded winners; return its game calls and result."""
    winner = {frozenset((g["a"], g["b"])): g["winner"] for g in v["games"]}
    calls = []

    def play(a, b, week):
        calls.append((a, b))
        return winner[frozenset((a, b))]
    champ, runner = S.bracket(list(v["seeds"]), play, 14, 17)
    return calls, champ, runner


vectors = json.load(open(FIXTURE, encoding="utf-8"))["vectors"]
recorded = [v for v in vectors if v["season"] is not None]
synthetic = [v for v in vectors if v["season"] is None]

print("1. Every recorded 6-team side 2014-2025: season_sim.bracket reproduces MFL's round 2, final and champion")
check("22 recorded sides (12 UPS Championship, 10 Hawk Tuah Bowl)",
      len(recorded) == 22 and sum(v["side"] == "hawk" for v in recorded) == 10, len(recorded))
for v in recorded:
    calls, champ, runner = play_vector(v)
    s = v["seeds"]
    check(v["id"] + ": round 1 is 3 v 6 and 4 v 5", calls[:2] == [(s[2], s[5]), (s[3], s[4])], calls[:2])
    check(v["id"] + ": round 2 = MFL's", [list(c) for c in calls[2:4]] == v["expected"]["round2"],
          (calls[2:4], v["expected"]["round2"]))
    check(v["id"] + ": final, champion and runner-up = MFL's",
          sorted(calls[4]) == v["expected"]["final"] and champ == v["expected"]["champion"]
          and runner == v["expected"]["runner_up"], (calls[4], champ, runner, v["expected"]))

print("2. The seasons that rule out a fixed 1 v winner-of-4/5 path")
differs = [v["id"] for v in recorded if v["fixed_path_differs"]]
check("2014, 2016, 2017, 2022 championship; 2016, 2021 Hawk Tuah",
      differs == ["2014-champ", "2016-champ", "2016-hawk", "2017-champ", "2021-hawk", "2022-champ"], differs)
for v in recorded:
    if v["fixed_path_differs"]:
        calls, _, _ = play_vector(v)
        check(v["id"] + ": the top seed met the 6 seed, not the 4/5 winner",
              calls[2] == (v["seeds"][0], v["seeds"][5]) and calls[2][1] != v["fixed_path_round2"][0][1], calls[2])

print("3. Synthetic opening-round upsets on both sides: the top seed gets the lowest seed left")
check("4 round-1 outcomes x 2 sides", len(synthetic) == 8, len(synthetic))
for v in synthetic:
    calls, champ, runner = play_vector(v)
    s = v["seeds"]
    low = max(calls[0][0] if v["games"][0]["winner"] == calls[0][0] else calls[0][1],
              calls[1][0] if v["games"][1]["winner"] == calls[1][0] else calls[1][1], key=s.index)
    check(v["id"], [list(c) for c in calls[2:4]] == v["expected"]["round2"] and calls[2][1] == low,
          (calls[2:4], v["expected"]["round2"]))

print("\n%s" % ("ALL PASS" if not fails else "%d FAILED" % fails))
sys.exit(1 if fails else 0)
