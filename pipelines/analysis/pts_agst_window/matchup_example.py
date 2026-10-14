"""Worked example: a defense that has allowed a lot at a position vs a weak upcoming offense.
Usage: python3 matchup_example.py RB [DEF] <nflSchedule JSON for the next week>
(MFL export?TYPE=nflSchedule&W=6&JSON=1). 2026 through Wk 5 was used for the PR #1238 example."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_core import load
import matchup as MU
HERE = os.path.dirname(os.path.abspath(__file__))
data = load(os.path.join(HERE, "dataset.json"))
res = json.load(open(os.path.join(HERE, "matchup_results.json")))
g = sys.argv[1] if len(sys.argv) > 1 else "RB"
ko = res["positions"][g]["k_offense_all_train"]; kd = res["positions"][g]["k_defense_all_train"]["Combined ratio|Full season"]
S, opp, scored = MU.build(data)
y = 2026; cur = S[y]
wk6 = {}
for m in json.load(open(sys.argv[-1]))["nflSchedule"]["matchup"]:
    a, b = m["team"][0]["id"], m["team"][1]["id"]; wk6[a] = b; wk6[b] = a
T = 6
# league average RB points per team-game so far (Wks 1-5)
vals = [scored[y].get((w, t, g), 0.0) for t, wks in cur.team_weeks.items() for w in wks]
lg = sum(vals) / len(vals)
rows = []
for D, wks in cur.team_weeks.items():
    games = []
    for Sw in wks:
        o = opp[y][(Sw, D)]; a = sum(p for _, p in cur.faced.get((Sw, D, g), ()))
        Os, _ = MU.off_mean(S, scored, y, o, g, T, excl=Sw)
        if Os is None: Os, _ = MU.off_mean(S, scored, y - 1, o, g, 99, full=True)
        games.append((Sw, o, a, Os))
    raw = sum(x[2] for x in games) / len(games); eff = sum(x[2] for x in games) / sum(x[3] for x in games)
    rows.append((D, raw, eff, games))
rows.sort(key=lambda r: -r[1])
off_base = {}
for t in cur.team_weeks:
    O, n = MU.off_mean(S, scored, y, t, g, T); off_base[t] = (O, n, MU.shr(O, n, lg, ko))
weak = sorted(off_base, key=lambda t: off_base[t][0])
print(f"{g}: league avg {lg:.1f} pts/team-game; tuned k_offense={ko}, k_defense(Full season ratio)={kd}")
print("Top raw-allowed defenses and their Wk 6 opponent:")
for D, raw, eff, games in rows[:8]:
    o = wk6.get(D, "bye"); ob = off_base.get(o)
    print(f"  {D}: allowed {raw:.1f}/g, vs usual x{eff:.2f} (shrunk x{MU.shr(eff, len(games), 1.0, kd):.3f}); Wk 6 vs {o}" + (f" — {o} {g} offense {ob[0]:.1f}/g (rank {weak.index(o)+1} of 32 lowest-first), shrunk baseline {ob[2]:.1f}" if ob else ""))
print("Weakest offenses:", [(t, round(off_base[t][0], 1)) for t in weak[:6]])
pick = sys.argv[2] if len(sys.argv) > 3 else None
if pick:
    D = pick; raw, eff, games = [(r[1], r[2], r[3]) for r in rows if r[0] == D][0]; o = wk6[D]; O, n, ob = off_base[o]
    print(f"\nEXAMPLE {D} defense vs {o} {g} offense, Wk 6 2026")
    for Sw, oo, a, Os in games: print(f"   Wk {Sw}: {D} allowed {a:.1f} to {oo} (whose usual entering Wk 6, excluding that game, is {Os:.1f})")
    effs = MU.shr(eff, len(games), 1.0, kd)
    print(f"   raw allowed {raw:.1f}/g (league {lg:.1f}); adjusted effect x{eff:.3f} unshrunk, x{effs:.3f} shrunk (k={kd})")
    print(f"   {o} {g} offense baseline: {O:.1f}/g over {n} games; shrunk toward league (k={ko}) = {ob:.1f}")
    print(f"   combined expectation = {ob:.1f} x {effs:.3f} = {ob*effs:.1f}  (unshrunk effect: {ob*eff:.1f}); raw-allowed would say {raw:.1f}")
