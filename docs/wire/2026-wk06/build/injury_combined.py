#!/usr/bin/env python3
"""Team-level combined injury effects for the Week 6 article's injury stories (Keith 2026-10-21: only injuries that
materially change a team earn article space). Reuses the validated lineup algorithm and inputs of verify_injuries.py
(2026 points per game, best legal lineup, every rostered player assumed healthy for the baseline) and writes
injury_combined.json. "Unavailable" = MFL status Out, IR, IR-R, IR-PUP, Doubtful or Suspended; Questionable counts as
available unless a case says so explicitly. Ranks compare the team's lineup with every other team healthy, as in the
validated Injury Report."""
import json, os, sys

D = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(D, "verify_injuries.py")).read().split('print("Injury Report: independent recomputation")')[0]
sys.argv = ["x", ""]
exec(compile(src, "verify_injuries_prefix", "exec"))        # roster, players, feed, bye, ppg, lineup, pool, healthy
OUT = {"IR", "Out", "Doubtful", "Suspended", "IR-R", "IR-PUP", "PUP"}
byname = {}
for f, ps in roster.items():
    for p in ps:
        byname[(f, players[p["id"]]["name"])] = p["id"]
tot = {f: healthy[f][0] for f in roster}
rank = lambda f, v: 1 + sum(1 for g in tot if g != f and tot[g] > v)


def combined(f, extra_out=()):
    ex = {byname[(f, n)] for n in extra_out}
    avail = [x for x in pool(f) if (feed.get(x) or {}).get("status") not in OUT and x not in ex]
    a = lineup(avail)
    return {"healthy": healthy[f][0], "lineup": a[0], "drop": round(healthy[f][0] - a[0], 1), "rankHealthy": rank(f, healthy[f][0]) if False else 1 + sum(1 for g in tot if tot[g] > healthy[f][0]),
            "rankWithout": rank(f, a[0]),
            "unavailableInBestLineup": sorted(players[x]["name"] for x in healthy[f][1] if x not in a[1])}


def week7(f, extra_out=()):
    ex = {byname[(f, n)] for n in extra_out}
    wk = [p["id"] for p in roster[f] if p["status"] == "ROSTER" and bye.get(players[p["id"]]["team"]) != 7
          and (feed.get(p["id"]) or {}).get("status") not in OUT and p["id"] not in ex]
    qbs = [players[x]["name"] for x in wk if players[x]["position"] == "QB"]
    return {"lineup": lineup(wk)[0], "drop": round(healthy[f][0] - lineup(wk)[0], 1), "quarterbacks": qbs}


out = {"note": __doc__.split("\n")[0], "teams": {}}
for f in ("0006", "0011", "0002", "0003", "0004", "0010", "0008"):
    out["teams"][f] = {"now": combined(f)}
out["teams"]["0006"]["withWarrenOut"] = combined("0006", ["Warren, Tyler"])
out["teams"]["0006"]["week7"] = week7("0006")
out["teams"]["0006"]["week7WarrenOut"] = week7("0006", ["Warren, Tyler"])
out["teams"]["0003"]["withGrahamMonangaiOut"] = combined("0003", ["Graham, Mason", "Monangai, Kyle"])
out["teams"]["0004"]["withJacksonOut"] = combined("0004", ["Jackson, Lamar"])
json.dump(out, open(os.path.join(D, "injury_combined.json"), "w"), indent=1)
for f, v in out["teams"].items():
    print(f, json.dumps(v))
