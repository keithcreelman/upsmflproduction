#!/usr/bin/env python3
"""Before/after table from two journeys.mjs logs: worker calls, leaderboard calls and D1 rows per journey.
   python3 scripts/phone_requests/journey_table.py <outDir>   (reads before_requests.json + after_requests.json there)
D1 rows = each call × its route's [low, high] rows per call from d1_per_call.json (low = worker edge-cache hit)."""
import json, os, sys, collections
OUT = sys.argv[1]
D1 = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "d1_per_call.json")))["routes"]   # route -> [lo, hi]
def d1(route, query):
    if route == "/api/advanced-stats-leaderboard" and "limit=500" in (query or ""): return D1.get(route + "#500", [0, 0])
    return D1.get(route, [0, 0])
JOURNEYS = [  # (id, label, unused)
 ("J1", "1. Signed-out cold boot (Sign-in card)", None),
 ("J2", "2. Signed-in cold boot, Home", None),
 ("J3", "3. Home reopened (same session)", None),
 ("J4", "4. Standings opened", None),
 ("J5", "5. Stats → Players opened", None),
 ("J6", "6. Position / filter changes (RB tab, Free agents, back to QB)", None),
 ("J7", "7. Leave Stats and come back", None),
 ("J8", "8. Background, then resume", None),
 ("JS", "+ My Team → player sheet → its Stats tab, then a second player", None),
 ("JR", "+ Pull-to-refresh / Refresh data", None),
 ("J9", "9. Sign out, then another owner's cold boot", None),
 ("J10", "10. Failed reads, then the controlled retry (sheet Stats tab)", None),
]
def summarize(f):
    log = json.load(open(f))["log"]
    out = collections.OrderedDict()
    for e in log:
        if e["kind"] != "worker": continue
        j = e["journey"]
        if j == "setup": continue
        o = out.setdefault(j, {"calls": 0, "lb": 0, "d1calls": 0, "lo": 0, "hi": 0, "fail": 0, "steps": collections.OrderedDict()})
        o["calls"] += 1
        lo, hi = d1(e["route"], e.get("query"))
        if e["status"] >= 500: o["fail"] += 1; lo = hi = 0
        if e["route"] == "/api/advanced-stats-leaderboard": o["lb"] += 1
        if hi: o["d1calls"] += 1
        o["lo"] += lo; o["hi"] += hi
        s = o["steps"].setdefault(e["step"], collections.Counter()); s[e["route"].replace("/api/", "")] += 1
    return out
b, a = summarize(os.path.join(OUT, "before_requests.json")), summarize(os.path.join(OUT, "after_requests.json"))
rows = []
for j, label, _ in JOURNEYS:
    x, y = b.get(j, {"calls": 0, "lb": 0, "lo": 0, "hi": 0, "d1calls": 0}), a.get(j, {"calls": 0, "lb": 0, "lo": 0, "hi": 0, "d1calls": 0})
    rng = lambda o: (f"{o['lo']:,}" if o["lo"] == o["hi"] else f"{o['lo']:,}–{o['hi']:,}")
    rows.append({"id": j, "label": label, "before": {"calls": x["calls"], "lb": x["lb"], "d1": rng(x), "d1lo": x["lo"], "d1hi": x["hi"]},
                 "after": {"calls": y["calls"], "lb": y["lb"], "d1": rng(y), "d1lo": y["lo"], "d1hi": y["hi"]},
                 "steps_before": {k: dict(v) for k, v in b.get(j, {}).get("steps", {}).items()},
                 "steps_after": {k: dict(v) for k, v in a.get(j, {}).get("steps", {}).items()}})
json.dump(rows, open(os.path.join(OUT, "journey_table.json"), "w"), indent=1, ensure_ascii=False)
print(f"{'journey':66} {'calls b→a':>12} {'leaderboard':>12} {'D1 rows before':>16} {'D1 rows after':>14}")
for r in rows:
    print(f"{r['label'][:66]:66} {r['before']['calls']:>5} → {r['after']['calls']:<4} {r['before']['lb']:>5} → {r['after']['lb']:<4} {r['before']['d1']:>16} {r['after']['d1']:>14}")
