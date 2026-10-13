#!/usr/bin/env python3
"""Regression test: NO target-game information reaches any predictor or "usual" (no data needed).
Builds a small synthetic league (3 seasons, 8 teams, byes), then for EVERY target:
  1. replaces every score in the target week and all later weeks with huge numbers and rebuilds:
     every predictor, the league average and the target's usual (E) must be unchanged, and the
     target's actual must change (so the perturbation really reached the data);
  2. checks the target's usual by hand from weeks < T only;
  3. self-check: a deliberately leaky usual (week <= T) MUST be caught, or the test is useless.
Exit 0 = pass. Run: python3 pipelines/analysis/pts_agst_window/leak_test_synthetic.py"""
import copy, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wf_core as W

def league(seed=5):
    rnd = random.Random(seed); teams = ["T%d" % i for i in range(8)]; data = {}
    groups = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]
    roster = {(t, g): ["%s%s%d" % (t, g, j) for j in range(1 if g in ("QB", "PK", "PN") else 2)] for t in teams for g in groups}
    for y in (2017, 2018, 2019):
        games, pg = [], []
        for w in range(1, 9):
            order = teams[:]; rnd.shuffle(order)
            if w in (4, 6): order = order[2:]                       # two teams on bye these weeks
            for i in range(0, len(order), 2):
                a, b = order[i], order[i + 1]; games.append({"wk": w, "a": a, "b": b})
                for own, opp in ((a, b), (b, a)):
                    for g in groups:
                        for pid in roster[(own, g)]:
                            if rnd.random() < 0.15: continue          # sometimes he doesn't play
                            pg.append([pid, w, round(rnd.uniform(0, 25), 1), g, own, opp])
        data[y] = {"endWeek": 8, "weeks": 8, "games": games, "pg": pg}
    return data

def run(data, y):
    ts, S = W.build_targets(data, [y]); return ts, S

def check(data, leaky=False):
    if leaky:
        orig = W.Season.usual_before
        def leak(self, pid, T, excl=None): return orig(self, pid, T + 1, excl)    # sees week T: a leak
        W.Season.usual_before = leak
    try:
        fails = 0; n = 0
        for y in (2018, 2019):
            base, S = run(data, y)
            for t in base[::7]:
                n += 1; T = t["T"]
                pert = copy.deepcopy(data)
                for row in pert[y]["pg"]:
                    if row[1] >= T: row[2] = row[2] * 1000 + 77
                new, _ = run(pert, y)
                m = [u for u in new if (u["D"], u["g"], u["T"]) == (t["D"], t["g"], T)][0]
                p0, p1 = W.predictors(t, None), W.predictors(m, None)
                same = all(p0[k][0] == p1[k][0] and p0[k][1] == p1[k][1] for k in p0) and t["lg"] == m["lg"] and t["Eb"] == m["Eb"]
                moved = m["A"] != t["A"] or t["A"] == 0
                # the target's usual by hand, from weeks < T only
                cur, prev = S[y], S[y - 1]; e = 0.0
                for pid, pts in cur.faced.get((T, t["D"], t["g"]), ()):
                    prior = [p for wk, p in cur.pgames[pid] if wk < T]
                    u = (sum(prior) / len(prior)) if prior else prev.pmean.get(pid)
                    if u is not None: e += u
                if not (same and moved and abs(e - t["Eb"]) < 1e-9): fails += 1
        return fails, n
    finally:
        if leaky: W.Season.usual_before = orig

if __name__ == "__main__":
    data = league()
    fails, n = check(data)
    leak_fails, _ = check(data, leaky=True)
    print(f"targets checked: {n}; leaks found: {fails}; deliberate leak caught on {leak_fails} targets")
    if fails or leak_fails == 0:
        print("FAIL"); sys.exit(1)
    print("PASS")
