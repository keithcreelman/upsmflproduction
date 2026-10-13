# Leakage check: for sampled targets, blow up every score in the target week AND every later week
# (x1000 + 77) and rebuild the predictors through the same code. Nothing a predictor or a "usual"
# uses may move. The target's actual (A) must move — proving the perturbation reached the data.
import json, copy, random, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from wf_core import *
HERE = os.path.dirname(os.path.abspath(__file__))
data = load(os.path.join(HERE, "dataset.json"))
rnd = random.Random(3)
fails = checked = 0
for y in (2019, 2022, 2024, 2025):
    base, _ = build_targets(data, [y])
    lr0 = league_ratio(base)
    sample = rnd.sample(base, 60)
    for t in sample:
        T = t["T"]
        pert = copy.deepcopy(data)
        for row in pert[y]["pg"]:
            if row[1] >= T: row[2] = row[2] * 1000 + 77
        newt, _ = build_targets(pert, [y])
        m = [u for u in newt if u["D"] == t["D"] and u["g"] == t["g"] and u["T"] == T][0]
        p0, p1 = predictors(t, lr0), predictors(m, league_ratio(newt))
        same = all((p0[k][0] == p1[k][0] and p0[k][1] == p1[k][1]) for k in p0) and t["lg"] == m["lg"] and t["Eb"] == m["Eb"]
        moved = m["A"] != t["A"] or t["A"] == 0
        checked += 1
        if not (same and moved): fails += 1; print("LEAK?", y, t["D"], t["g"], T, same, moved)
    print(y, "checked", checked, "fails", fails, flush=True)
print("RESULT", "PASS" if fails == 0 else "FAIL", checked, "targets")
