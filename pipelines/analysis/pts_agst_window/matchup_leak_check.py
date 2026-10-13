import copy, random, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_core import load
import matchup as MU
data = load(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dataset.json"))
rnd = random.Random(9); fails = n = 0
for y in (2020, 2023, 2025):
    base = MU.targets(data, [y])
    for t in rnd.sample(base, 40):
        T = t["T"]; pert = copy.deepcopy(data)
        for row in pert[y]["pg"]:
            if row[1] >= T: row[2] = row[2] * 1000 + 77
        m = [u for u in MU.targets(pert, [y]) if (u["D"], u["g"], u["T"]) == (t["D"], t["g"], T)][0]
        wa, wb = MU.windows(t), MU.windows(m)
        same = (t["O"], t["n_o"], t["offp"], t["lg"]) == (m["O"], m["n_o"], m["offp"], m["lg"]) and wa == wb
        moved = m["A"] != t["A"] or t["A"] == 0
        n += 1
        if not (same and moved): fails += 1; print("LEAK?", y, t["D"], t["g"], T)
print("RESULT", "PASS" if fails == 0 else "FAIL", n, "targets")
