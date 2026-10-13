"""Above/below accuracy of the defense effect vs the trivial rule 'always below the offense's normal'
(offenses land below their own mean more often than above). Same subset, paired cluster bootstrap."""
import json, os, pickle, random, sys
from collections import defaultdict
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import matchup as MU
ts = pickle.load(open(os.path.join(HERE, "matchup_targets.pkl"), "rb"))
G = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]
out = {}
for g in G:
    for per, ys in (("2019-2024", set(MU.TRAIN)), ("2025", {2025})):
        by = defaultdict(lambda: [0, 0, 0])
        for t in ts:
            if t["g"] != g or t["y"] not in ys: continue
            w = t["W"]["Full season"]; e = w["eff"] if w else None
            if e is None or not t["O"] or t["O"] <= 0 or e == t["lr"] or t["A"] == t["O"]: continue
            below = t["A"] < t["O"]
            c = by[(t["y"], t["T"])]; c[0] += ((e > t["lr"]) == (not below)); c[1] += below; c[2] += 1
        cs = list(by.values())
        def st(sel):
            n = sum(cs[j][2] for j in sel); return (sum(cs[j][0] for j in sel) - sum(cs[j][1] for j in sel)) / n
        pt = st(range(len(cs))); n = sum(c[2] for c in cs)
        acc = sum(c[0] for c in cs) / n; base = sum(c[1] for c in cs) / n
        rnd = random.Random(7); bs = sorted(st([rnd.randrange(len(cs)) for _ in cs]) for _ in range(2000))
        out[(g, per)] = (acc, base, pt, bs[50], bs[1949], n)
        print(f"{g:3} {per}: effect calls above/below right {100*acc:.1f}% vs 'always below' {100*base:.1f}% -> {100*pt:+.1f} [{100*bs[50]:+.1f}, {100*bs[1949]:+.1f}] n={n}")
json.dump({f"{g}|{p}": v for (g, p), v in out.items()}, open(os.path.join(HERE, "matchup_direction.json"), "w"), indent=1)
