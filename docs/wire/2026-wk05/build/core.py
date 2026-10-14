"""Shared loaders for the Week 5 analysis (cached data only -- no network, no D1)."""
import json, os, statistics as S
DIR = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(os.path.join(DIR, "mfl_2026.json")))
H = json.load(open(os.path.join(DIR, "hist.json")))
WEEKS = [1, 2, 3, 4, 5]
def L(x): return x if isinstance(x, list) else ([x] if x else [])
PLAYERS = {p["id"]: p for p in L(M["players"]["players"]["player"])}
FR = {f["franchise_id"]: f for f in H["franchises"] if f["season"] == 2026}
def owner(fid): return FR[fid]["owner_name"]
def pname(pid):
    n = PLAYERS.get(pid, {}).get("name", pid)
    if ", " in n: last, first = n.split(", ", 1); return first + " " + last
    return n
def ppos(pid): return PLAYERS.get(pid, {}).get("position", "?")
def pteam(pid): return PLAYERS.get(pid, {}).get("team", "?")
OFF = {"QB", "RB", "WR", "TE"}
IDP = {"DE", "DT", "LB", "CB", "S"}
def side(pos):
    return "O" if pos in OFF else ("D" if pos in IDP else ("K" if pos in ("PK", "PN", "K", "P") else "?"))
# per (week, fid): score, opt, players[{pid,score,status}], games[(opp, result, margin)]
TW = {}
for w in WEEKS:
    for m in L(M["weeklyResults_%d" % w]["weeklyResults"]["matchup"]):
        fs = L(m["franchise"])
        for f in fs:
            key = (w, f["id"])
            if key not in TW:
                TW[key] = {"score": float(f["score"]), "opt": float(f["opt_pts"]),
                           "players": [{"pid": p["id"], "score": float(p.get("score") or 0), "noScore": "score" not in p, "status": p["status"],
                                        "shouldStart": p.get("shouldStart")} for p in L(f["player"])],
                           "games": []}
        if len(fs) == 2:
            a, b = fs
            for x, y in ((a, b), (b, a)):
                TW[(w, x["id"])]["games"].append({"opp": y["id"], "result": x["result"],
                                                  "margin": round(float(x["score"]) - float(y["score"]), 1)})
FIDS = sorted(FR)
def allplay(w):
    out = {}
    sc = {f: TW[(w, f)]["score"] for f in FIDS}
    for f in FIDS:
        out[f] = (sum(1 for g in FIDS if g != f and sc[f] > sc[g]), sum(1 for g in FIDS if g != f and sc[f] < sc[g]),
                  sum(1 for g in FIDS if g != f and sc[f] == sc[g]))
    return out
AP = {w: allplay(w) for w in WEEKS}
def rank(vals, f):  # 1 = highest
    return 1 + sum(1 for g in vals if vals[g] > vals[f])
