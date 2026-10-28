#!/usr/bin/env python3
"""Independent check of the injury numbers the Week 7 report uses. Shares NO code with injury_wk08.py: it re-reads the raw saved inputs,
recomputes points per game and every best legal lineup with a different algorithm (fill each position's minimum, then the best remaining
flex-eligible players under the maximums -- optimal because every slot counts equally), and compares injury_wk08.json."""
import json, os, sys

D = os.path.dirname(os.path.abspath(__file__))
L = lambda n: json.load(open(os.path.join(D, n)))
inj = L("injury_wk08.json")
players = {p["id"]: p for p in L("players.json")["players"]["player"]}
score = {}
for w in range(1, 8):
    for r in L("ps%d.json" % w)["playerScores"]["playerScore"]:
        if r.get("score") not in (None, ""):
            score.setdefault(r["id"], {})[w] = float(r["score"])
bye = {t["id"]: int(t["bye_week"]) for t in L("byes.json")["nflByeWeeks"]["team"]}
nv = L("nflverse.json")
roster = {f["id"]: f.get("player", []) for f in L("rosters.json")["rosters"]["franchise"]}
fails = []


def ok(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  -- " + str(detail)[:200]))
    if not cond:
        fails.append(name)


def games(pid):
    t = players[pid].get("team")
    g = {int(w) for w in nv["played"].get(pid, [])} | {w for w, v in score.get(pid, {}).items() if v != 0}
    return sorted(w for w in g if bye.get(t) != w)


def ppg(pid):
    g = games(pid)
    return sum(score.get(pid, {}).get(w, 0.0) for w in g) / len(g) if g else 0.0


GRP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN", "DT": "DL", "DE": "DL", "LB": "LB", "CB": "DB", "S": "DB"}


def lineup(pool):
    by = {}
    for p in pool:
        by.setdefault(GRP.get(players[p]["position"]), []).append(p)
    for k in by:
        by[k].sort(key=lambda x: -ppg(x))
    chosen = set()
    for mins, maxs, n in (({"QB": 1, "RB": 2, "WR": 2, "TE": 1}, {"QB": 2, "RB": 5, "WR": 5, "TE": 4}, 9),
                          ({"DL": 2, "LB": 2, "DB": 2}, {"DL": 3, "LB": 3, "DB": 3}, 7)):
        take = [p for k, m in mins.items() for p in by.get(k, [])[:m]]
        rest = sorted([p for k in mins for p in by.get(k, [])[mins[k]:maxs[k]]], key=lambda x: -ppg(x))
        chosen |= set(take + rest[:n - len(take)])
    for k in ("PK", "PN"):
        chosen.add(by[k][0])
    return round(sum(ppg(p) for p in chosen), 1), chosen


pool = {f: [p["id"] for p in ps if p["status"] in ("ROSTER", "INJURED_RESERVE")] for f, ps in roster.items()}
healthy = {f: lineup(pool[f])[0] for f in pool}
for f, v in inj["healthyLineups"].items():
    ok("healthy lineup %s" % f, abs(v["ppg"] - healthy[f]) < 0.051, (v["ppg"], healthy[f]))
rank = {f: 1 + sum(1 for g in healthy if healthy[g] > healthy[f]) for f in healthy}
ok("healthy ranks", all(inj["healthyLineups"][f]["rank"] == rank[f] for f in rank), rank)
for c in inj["cases"]:
    if c["player"] in ("DeVonta Smith", "Lamar Jackson", "Tavius Robinson"):
        f, pid = c["fid"], c["pid"]
        without = lineup([p for p in pool[f] if p != pid])[0]
        ok("%s lineup without" % c["player"], abs(c["lineupWithout"] - without) < 0.051, (c["lineupWithout"], without))
        ok("%s lineup drop" % c["player"], abs(c["lineupDrop"] - round(healthy[f] - without, 1)) < 0.11, (c["lineupDrop"], healthy[f] - without))
        ok("%s ppg" % c["player"], abs(c["ppg"] - ppg(pid)) < 0.051, (c["ppg"], ppg(pid)))
        tot = dict(healthy); tot[f] = without
        ok("%s rank without" % c["player"], c["rankWithout"] == 1 + sum(1 for g in tot if g != f and tot[g] > tot[f]))
ds = [c for c in inj["cases"] if c["player"] == "DeVonta Smith"][0]
rostered = {p["id"] for ps in roster.values() for p in ps}
fa = max((p for p in players if p not in rostered and GRP.get(players[p]["position"]) == "WR" and len(games(p)) >= 2), key=ppg)
print("   best free agent WR (no availability filter): %s %.1f" % (players[fa]["name"], ppg(fa)))
ok("best FA does not beat Smith's replacement" , ds["bestFreeAgent"]["ppg"] < ds["replacement"]["ppg"])
print("FAIL" if fails else "PASS", fails)
sys.exit(1 if fails else 0)
