import json, collections, itertools
H = json.load(open("hist.json")); B = {int(k): v for k, v in json.load(open("brackets.json")).items()}
fws = collections.defaultdict(dict)   # (season) -> {(week, fid): score}
for r in H["fws"]:
    if not r["is_playoff"]: fws[r["season"]][(r["week"], r["franchise_id"])] = r["team_score"]
sched = collections.defaultdict(list)
for r in H["schedule"]:
    if not r["is_playoff"]: sched[r["season"]].append(r)
div = {(r["season"], r["franchise_id"]): r["division"] for r in H["franchises"]}
own = {(r["season"], r["franchise_id"]): r["owner_name"] for r in H["franchises"]}
# games per team per week in H2H seasons
for s in (2012, 2020, 2021, 2022, 2023, 2024, 2025):
    c = collections.Counter((r["week"], r["franchise_id"]) for r in sched[s])
    print(s, "H2H games per team-week:", sorted(collections.Counter(c.values()).items()), "games/team thru wk5:",
          sorted(collections.Counter(n for (w, f), n in collections.Counter((r["franchise_id"]) for r in sched[s] if r["week"] <= 5).items()).items()) if False else
          sorted(set(sum(1 for r in sched[s] if r["week"] <= 5 and r["franchise_id"] == f) for f in {r["franchise_id"] for r in sched[s]})))
def snap(s, upto=5):
    teams = sorted({f for (w, f) in fws[s]})
    out = {}
    for f in teams:
        apw = apl = apt = 0; pf = 0.0
        for w in range(1, upto + 1):
            sc = {g: fws[s].get((w, g)) for g in teams}
            if sc[f] is None: continue
            pf += sc[f]
            for g in teams:
                if g == f or sc[g] is None: continue
                apw += sc[f] > sc[g]; apl += sc[f] < sc[g]; apt += sc[f] == sc[g]
        g5 = [r for r in sched[s] if r["franchise_id"] == f and r["week"] <= upto]
        out[f] = dict(apw=apw, apl=apl, apt=apt, ap=(apw + 0.5 * apt) / max(1, apw + apl + apt), pf=pf,
                      w=sum(r["result"] == "W" for r in g5), l=sum(r["result"] == "L" for r in g5), t=sum(r["result"] == "T" for r in g5),
                      div=div.get((s, f)), owner=own.get((s, f)))
    for key, nm in (("ap", "aprk"), ("pf", "pfrk")):
        for f in teams: out[f][nm] = 1 + sum(1 for g in teams if out[g][key] > out[f][key])
    for f in teams:  # division position by H2H pct (2020+) else AP
        mates = [g for g in teams if out[g]["div"] == out[f]["div"]]
        k = (lambda g: ((out[g]["w"] + 0.5 * out[g]["t"]) / max(1, out[g]["w"] + out[g]["l"] + out[g]["t"]), out[g]["ap"])) if g5 else (lambda g: (out[g]["ap"],))
        out[f]["divpos"] = 1 + sum(1 for g in mates if k(g) > k(f))
    ranked = sorted(teams, key=lambda g: -out[g]["ap"])
    six = out[ranked[5]]["apw"] if len(ranked) > 5 else 0
    for f in teams: out[f]["gap6"] = out[f]["apw"] - six   # AP wins vs the 6th-best AP team (negative = behind)
    return out
made = {s: {x["franchise_id"] for x in B[s]["seeds"] if x.get("path") != "HAWK"} for s in B}
rows = []
for s in range(2010, 2026):
    sn = snap(s)
    for f, v in sn.items():
        rows.append(dict(season=s, fid=f, made=f in made[s], **v))
json.dump(rows, open("survival_rows.json", "w"), indent=1)
def table(rs, key, label):
    c = collections.defaultdict(lambda: [0, 0])
    for r in rs: c[key(r)][0] += r["made"]; c[key(r)][1] += 1
    print(label); [print("   %-10s %2d/%-2d = %3.0f%%" % (k, a, n, 100.0 * a / n)) for k, (a, n) in sorted(c.items())]
modern = [r for r in rows if 2017 <= r["season"] <= 2025]
h2h = [r for r in rows if 2020 <= r["season"] <= 2025]
print("\nplayoff teams per season:", {s: len(made[s]) for s in sorted(made)})
table(modern, lambda r: r["aprk"], "2017-2025: Week-5 ALL-PLAY RANK -> made playoffs")
table(modern, lambda r: r["pfrk"], "2017-2025: Week-5 PF RANK -> made playoffs")
table(h2h, lambda r: "%d-%d" % (r["w"], r["l"]), "2020-2025: Week-5 H2H RECORD -> made playoffs")
table(modern, lambda r: r["divpos"], "2017-2025: Week-5 DIVISION POSITION -> made playoffs")
table(modern, lambda r: ("<=-8" if r["gap6"] <= -8 else ("-7..-4" if r["gap6"] <= -4 else ("-3..-1" if r["gap6"] < 0 else ">=0"))), "2017-2025: AP wins vs 6th place at Week 5")
table(rows, lambda r: r["aprk"], "ALL 2010-2025 (mixed formats): Week-5 AP rank")
# predictive power: AUC of each metric at week 5 for making playoffs
def auc(rs, key):
    pos = [key(r) for r in rs if r["made"]]; neg = [key(r) for r in rs if not r["made"]]
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))
print("\nAUC 2020-2025 (n=%d): AP %.3f  PF %.3f  H2H win%% %.3f" % (len(h2h), auc(h2h, lambda r: r["ap"]), auc(h2h, lambda r: r["pf"]),
      auc(h2h, lambda r: (r["w"] + .5 * r["t"]) / max(1, r["w"] + r["l"] + r["t"]))))
print("AUC 2017-2025 (n=%d): AP %.3f  PF %.3f" % (len(modern), auc(modern, lambda r: r["ap"]), auc(modern, lambda r: r["pf"])))
print("\nWorst Week-5 AP ranks that still made it (2017-2025):")
for r in sorted([r for r in modern if r["made"]], key=lambda r: -r["aprk"])[:6]:
    print("   %d %-18s AP rank %2d (%d-%d AP), H2H %s, gap6 %+d" % (r["season"], r["owner"], r["aprk"], r["apw"], r["apl"], "%d-%d" % (r["w"], r["l"]) if r["season"] >= 2020 else "n/a", r["gap6"]))
print("Worst Week-5 H2H records that made it (2020-2025):")
for r in sorted([r for r in h2h if r["made"]], key=lambda r: (r["w"] - r["l"]))[:5]:
    print("   %d %-18s %d-%d, AP rank %d" % (r["season"], r["owner"], r["w"], r["l"], r["aprk"]))
print("Best Week-5 AP ranks that MISSED (2017-2025):")
for r in sorted([r for r in modern if not r["made"]], key=lambda r: r["aprk"])[:5]:
    print("   %d %-18s AP rank %2d (%d-%d)" % (r["season"], r["owner"], r["aprk"], r["apw"], r["apl"]))
