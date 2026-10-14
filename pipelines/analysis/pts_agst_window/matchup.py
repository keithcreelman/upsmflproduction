"""Matchup decomposition backtest (Keith 2026-10-13): does the DEFENSIVE effect add anything to an
OFFENSIVE baseline when predicting the next game?

Target (one per season / defense D / position group g / D's next final game at week T):
  A_t = UPS/MFL points the opposing offense's g-players scored against D in that game.
Everything below uses only games completed BEFORE week T (and season y-1).

  OFF   offense baseline: the upcoming offense's own points at g per game over its completed games
        before T (season to date; none yet -> its previous season), shrunk toward the league by k_o.
  OFFP  player baseline: sum of the pregame usuals of the players who actually played (knows the
        lineup, so it is NOT strictly pregame; reported for comparison only).
  RAW   defense raw Allowed per game (window W).
  EFF   schedule-adjusted defensive effect over window W: sum A_s / sum O_s, where O_s = that past
        opponent's own average at g over its games before T EXCLUDING game s (team-level "usual").
        EFFP = the player-level version (sum of player usuals entering T, excluding game s).
  COMB  OFF x shrink(EFF, k_d)        (multiplicative, ratio effect)
  ADD   OFF + shrink(DIFF, k_d)       (additive, difference effect: mean of A_s - O_s)
  COMBP OFFP x shrink(EFFP, k_d)
k_o and k_d are chosen leave-one-season-out on 2019-2024; 2025 is scored with k from 2019-2024.
"""
import json, os, sys, random, math
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wf_core import Season, load, GROUPS, game_terms

HERE = os.path.dirname(os.path.abspath(__file__))
TRAIN = [2019, 2020, 2021, 2022, 2023, 2024]
K = [0, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 400, 1e9]
WIN = ["Full season", "Last 3", "Last 8", "Previous season", "Blend .5"]
ALIAS = {"LVR": "OAK"}

def build(data):
    S = {y: Season(data[y]) for y in data}
    opp, scored = {}, {}
    for y in data:
        o = {}; sc = defaultdict(float)
        for gm in data[y]["games"]: o[(gm["wk"], gm["a"])] = gm["b"]; o[(gm["wk"], gm["b"])] = gm["a"]
        for pid, wk, pts, g, own, op in data[y]["pg"]: sc[(wk, own, g)] += pts
        opp[y], scored[y] = o, sc
    return S, opp, scored

def off_mean(S, scored, y, team, g, T, excl=None, full=False):
    """Offense `team`'s mean points at g over its games in season y with week < T (all weeks if full),
    excluding week `excl`. Returns (mean, n)."""
    s = S[y]; wks = s.team_weeks.get(team) or s.team_weeks.get(ALIAS.get(team, ""), [])
    tm = team if team in s.team_weeks else ALIAS.get(team, team)
    vals = [scored[y].get((w, tm, g), 0.0) for w in wks if (full or w < T) and w != excl]
    return (sum(vals) / len(vals), len(vals)) if vals else (None, 0)

def targets(data, seasons):
    S, opp, scored = build(data)
    out = []
    for y in seasons:
        cur, prev = S[y], S.get(y - 1)
        lgw = defaultdict(lambda: [0.0, 0])
        for t, wks in cur.team_weeks.items():
            for w in wks:
                for g in GROUPS: a = lgw[(w, g)]; a[0] += scored[y].get((w, t, g), 0.0); a[1] += 1
        prev_lg = {}
        for g in GROUPS:
            v = [scored[y - 1].get((w, t, g), 0.0) for t, wks in prev.team_weeks.items() for w in wks]
            prev_lg[g] = sum(v) / len(v)
        ppm = {}
        for g in GROUPS:
            tot = n = 0
            for T in range(1, 19):
                ppm[(g, T)] = (tot / n) if n else 0.0
                for (w, d, gg), lst in cur.faced.items():
                    if w == T and gg == g: tot += sum(p for _, p in lst); n += len(lst)
        for D, wks in cur.team_weeks.items():
            Dp = D if D in prev.team_weeks else ALIAS.get(D, D)
            for g in GROUPS:
                prv = []
                for Sw in prev.team_weeks.get(Dp, []):
                    o = opp[y - 1][(Sw, Dp)]
                    A = sum(p for _, p in prev.faced.get((Sw, Dp, g), ()))
                    O, _ = off_mean(S, scored, y - 1, o, g, 99, excl=Sw, full=True)
                    pa = pe = 0.0
                    for pid, pts in prev.faced.get((Sw, Dp, g), ()):
                        u = prev.mean_excl(pid, Sw)
                        if u is not None: pa += pts; pe += u
                    prv.append((A, O, pa, pe))
                for k in range(1, len(wks)):
                    T = wks[k]; off = opp[y][(T, D)]
                    A = sum(p for _, p in cur.faced.get((T, D, g), ()))
                    tot = cnt = 0
                    for w in range(1, T):
                        if (w, g) in lgw: tot += lgw[(w, g)][0]; cnt += lgw[(w, g)][1]
                    lg = tot / cnt if cnt else prev_lg[g]
                    O, n_o = off_mean(S, scored, y, off, g, T)
                    if O is None:
                        Op, _ = off_mean(S, scored, y - 1, off, g, 99, full=True); O = Op if Op is not None else lg
                    # player-level baseline (knows who played)
                    Eb = Efull = 0.0; nmiss = 0
                    for pid, pts in cur.faced.get((T, D, g), ()):
                        s_, n_ = cur.usual_before(pid, T)
                        u = (s_ / n_) if n_ else prev.pmean.get(pid)
                        if u is not None: Eb += u
                        else: nmiss += 1
                    offp = Eb + nmiss * ppm[(g, T)]
                    curg = []
                    for Sw in wks[:k]:
                        o = opp[y][(Sw, D)]
                        a = sum(p for _, p in cur.faced.get((Sw, D, g), ()))
                        Os, _ = off_mean(S, scored, y, o, g, T, excl=Sw)
                        if Os is None: Os, _ = off_mean(S, scored, y - 1, o, g, 99, full=True)
                        _, pa, pe = game_terms(cur, prev, D, g, Sw, T)
                        curg.append((a, Os, pa, pe))
                    out.append({"y": y, "D": D, "g": g, "T": T, "k": k, "off": off, "A": A, "O": O, "n_o": n_o, "lg": lg,
                                "offp": offp, "cur": curg, "prv": prv})
    return out

def windows(t):
    cur, prv = t["cur"], t["prv"]
    def agg(games, w=None):
        if not games: return None
        w = w or [1.0] * len(games)
        sA = sum(x * g[0] for x, g in zip(w, games)); sO = sum(x * (g[1] or 0) for x, g in zip(w, games))
        sPA = sum(x * g[2] for x, g in zip(w, games)); sPE = sum(x * g[3] for x, g in zip(w, games)); n = sum(w)
        return {"raw": sA / n, "eff": (sA / sO) if sO > 0 else None, "diff": (sA - sO) / n,
                "effp": (sPA / sPE) if sPE > 0 else None, "n": n}
    return {"Full season": agg(cur), "Last 3": agg(cur[-3:]), "Last 8": agg(cur[-8:]), "Previous season": agg(prv),
            "Blend .5": agg(cur + prv, [1.0] * len(cur) + [0.5] * len(prv))}

def shr(x, n, prior, k):
    if x is None or k >= 1e8: return prior
    return (n * x + k * prior) / (n + k)

def league_refs(ts):
    """Leak-free league ratio / difference entering each (y, g, T), pooled over all defenses' past games."""
    acc = defaultdict(lambda: [0.0, 0.0, 0.0, 0.0, 0])
    for t in ts:
        a = acc[(t["y"], t["g"], t["T"])]
        for A, O, pa, pe in t["cur"]:
            a[0] += A; a[1] += (O or 0); a[2] += pa; a[3] += pe; a[4] += 1
    return {k: ((v[0] / v[1]) if v[1] else 1.0, ((v[0] - v[1]) / v[4]) if v[4] else 0.0, (v[2] / v[3]) if v[3] else 1.0) for k, v in acc.items()}
