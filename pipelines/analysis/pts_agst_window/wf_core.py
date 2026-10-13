"""Walk-forward backtest core for Stats → Pts Agst (UPS / MFL league 74598).

Unit = one TARGET GAME: (season y, defense D, position group g, D's k-th final game, week T).
  A_t   = UPS/MFL points scored by group-g players who faced D in that game (0 if none).
  usual = a player's mean MFL points over his games in season y with week < T (any opponent);
          if he has none yet, his previous-season mean; otherwise he has no baseline.
  A^b_t, E^b_t = points and summed usuals over the players WITH a baseline.
  ratio_t = A^b_t / E^b_t  (the schedule-adjusted result).

NO LEAKAGE: every predictor uses only D's games with week < T (and season y-1), and every usual
used for a predictor's past game s is that player's mean over weeks < T EXCLUDING game s itself
(previous-season games: his previous-season mean excluding that game). Week T never enters any
predictor or baseline. Recency = D's last N completed GAMES (a bye is not an observation).
"""
import json, math
from collections import defaultdict

GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"]
LAST_N = [1, 2, 3, 4, 5, 6, 8]
EW_H = [1, 2, 3, 4, 6, 8]           # half-lives in games (across the season boundary)
BLEND_C = [0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1.0]   # weight of a previous-season game vs a current one
SHRINK_K = [0, 1, 2, 3, 5, 8, 12, 20, 30, 50, 80, 120, 200, 400, 1e9]


def load(path):
    raw = json.load(open(path))
    return {int(y): v for y, v in raw.items()}


class Season:
    def __init__(self, s):
        self.weeks = s["weeks"]
        self.team_weeks = defaultdict(list)            # team -> sorted weeks with a final game
        for gm in s["games"]:
            self.team_weeks[gm["a"]].append(gm["wk"]); self.team_weeks[gm["b"]].append(gm["wk"])
        for t in self.team_weeks: self.team_weeks[t].sort()
        self.faced = defaultdict(list)                 # (wk, def, grp) -> [(pid, pts)]
        self.pgames = defaultdict(list)                # pid -> [(wk, pts)]
        for pid, wk, pts, g, own, opp in s["pg"]:
            self.faced[(wk, opp, g)].append((pid, pts))
            self.pgames[pid].append((wk, pts))
        for p in self.pgames: self.pgames[p].sort()
        self.pmean = {p: sum(x for _, x in v) / len(v) for p, v in self.pgames.items()}

    def usual_before(self, pid, T, excl=None):
        """(sum, n) of the player's games this season with week < T, excluding week `excl`."""
        s = n = 0
        for wk, pts in self.pgames.get(pid, ()):
            if wk >= T: break
            if wk == excl: continue
            s += pts; n += 1
        return s, n

    def mean_excl(self, pid, excl):
        s = n = 0
        for wk, pts in self.pgames.get(pid, ()):
            if wk == excl: continue
            s += pts; n += 1
        return (s / n) if n else None


def game_terms(cur, prev, D, g, S, T):
    """Points and leak-free usual sums for D's game in week S (S < T) of the CURRENT season."""
    A = Ab = Eb = 0.0
    for pid, pts in cur.faced.get((S, D, g), ()):
        A += pts
        s, n = cur.usual_before(pid, T, excl=S)
        u = (s / n) if n else (prev.pmean.get(pid) if prev else None)
        if u is not None: Ab += pts; Eb += u
    return A, Ab, Eb


def prev_terms(prev, D, g):
    """D's previous-season games: points and usuals (previous-season mean excluding that game)."""
    out = []
    for S in prev.team_weeks.get(D, ()):
        A = Ab = Eb = 0.0
        for pid, pts in prev.faced.get((S, D, g), ()):
            A += pts
            u = prev.mean_excl(pid, S)
            if u is not None: Ab += pts; Eb += u
        out.append((S, A, Ab, Eb))
    return out


def build_targets(data, seasons):
    """Every eligible target with all predictors' inputs. Eligible = D has >=1 completed game this
    season before T, a previous season exists, and >=1 facing player has a baseline (E^b_t > 0)."""
    S = {y: Season(data[y]) for y in data}
    targets = []
    prev_cache = {}
    for y in seasons:
        cur, prev = S[y], S.get(y - 1)
        if prev is None: continue
        # league per (week, grp): sum A over all team-games, count, and ratio parts for the league ratio
        lg = defaultdict(lambda: [0.0, 0])
        for t, wks in cur.team_weeks.items():
            for w in wks:
                for g in GROUPS:
                    a = sum(p for _, p in cur.faced.get((w, t, g), ()))
                    lg[(w, g)][0] += a; lg[(w, g)][1] += 1
        prev_lg = {g: 0.0 for g in GROUPS}
        for g in GROUPS:
            tot = n = 0
            for t, wks in prev.team_weeks.items():
                for w in wks:
                    tot += sum(p for _, p in prev.faced.get((w, t, g), ())); n += 1
            prev_lg[g] = tot / n if n else 0.0
        for D, wks in cur.team_weeks.items():
            for g in GROUPS:
                pk = (y - 1, D, g)
                # franchise moves: the Raiders are OAK through 2019, LVR from 2020
                Dprev = D if D in prev.team_weeks else {"LVR": "OAK"}.get(D, D)
                if pk not in prev_cache: prev_cache[pk] = prev_terms(prev, Dprev, g)
                prv = prev_cache[pk]
                for k in range(1, len(wks)):          # k = number of completed games before the target
                    T = wks[k]
                    # target
                    A = Ab = Eb = 0.0; Efull = 0.0; nmiss = 0
                    for pid, pts in cur.faced.get((T, D, g), ()):
                        A += pts
                        s, n = cur.usual_before(pid, T)
                        u = (s / n) if n else prev.pmean.get(pid)
                        if u is not None: Ab += pts; Eb += u; Efull += u
                        else: nmiss += 1
                    if Eb <= 0: continue
                    # league average allowed per team-game in weeks < T (else previous season)
                    tot = cnt = 0
                    for w in range(1, T):
                        if (w, g) in lg: tot += lg[(w, g)][0]; cnt += lg[(w, g)][1]
                    lgavg = tot / cnt if cnt else prev_lg[g]
                    # rookies / no-baseline players: league per-player-game mean of the group (prior weeks)
                    # is used ONLY in the raw no-adjustment baseline E_full.
                    curg = [cur_terms for cur_terms in (game_terms(cur, prev, D, g, Sw, T) for Sw in wks[:k])]
                    targets.append({
                        "y": y, "D": D, "g": g, "T": T, "k": k, "A": A, "Ab": Ab, "Eb": Eb, "Efull": Efull, "nmiss": nmiss,
                        "lg": lgavg, "cur": curg, "prv": [(a, ab, eb) for _, a, ab, eb in prv],
                    })
    # league ratio entering T (all defenses, weeks < T): sum Ab / sum Eb of past games, leak-free
    by_yg = defaultdict(list)
    for t in targets: by_yg[(t["y"], t["g"])].append(t)
    return targets, S


def league_ratio(targets):
    """Leak-free league Allowed/Usual entering each week: pooled over all defenses' games < T,
    using each target's own leak-free past-game terms (so the usual definition matches)."""
    acc = defaultdict(lambda: defaultdict(lambda: [0.0, 0.0]))
    # each target t carries D's past games with usuals computed as of T; pool them per (y, g, T)
    for t in targets:
        a = acc[(t["y"], t["g"])][t["T"]]
        for (_, ab, eb) in t["cur"]: a[0] += ab; a[1] += eb
    out = {}
    for key, byT in acc.items():
        for T, (ab, eb) in byT.items(): out[(key[0], key[1], T)] = (ab / eb) if eb > 0 else 1.0
    return out


def wmean(vals):
    num = sum(w * x for w, x in vals); den = sum(w for w, _ in vals)
    return (num / den) if den > 0 else None, den


def predictors(t, lr):
    """All candidate predictions for one target. Returns {name: (raw_pred, ratio_pred, n_eff)}."""
    cur, prv = t["cur"], t["prv"]
    out = {}
    def win(games, weights=None):
        if not games: return None, None, 0.0
        if weights is None: weights = [1.0] * len(games)
        sa = sum(w * g[0] for w, g in zip(weights, games)); sw = sum(weights)
        sab = sum(w * g[1] for w, g in zip(weights, games)); seb = sum(w * g[2] for w, g in zip(weights, games))
        return sa / sw, (sab / seb if seb > 0 else None), sw
    out["Season to date"] = win(cur)
    for n in LAST_N: out[f"Last {n}"] = win(cur[-n:])
    out["Previous season"] = win(prv)
    seq = list(reversed(cur)) + list(reversed(prv))     # age 0 = most recent completed game
    for h in EW_H: out[f"EW half-life {h}"] = win(seq, [0.5 ** (i / h) for i in range(len(seq))])
    for c in BLEND_C: out[f"Blend c={c}"] = win(cur + prv, [1.0] * len(cur) + [c] * len(prv))
    return out


def shrink(x, n, prior, k):
    if x is None: return prior
    if k >= 1e8: return prior
    return (n * x + k * prior) / (n + k)
