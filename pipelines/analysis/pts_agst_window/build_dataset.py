# Canonical dataset for the walk-forward backtest (read-only inputs, same rules as the draft engine):
#  - season weeks = MFL league endWeek (2018-2020: 16, 2021+: 17); a playerScores reply whose
#    week differs from the request is dropped (MFL repeats its last week)
#  - group from MFL's season player file; game-day team from nflverse (single team spanning
#    first..last nflverse week, else per week), validated against the MFL schedule; MFL team fallback
#  - only FINAL games (all historical; 2026 = Wks 1-5, read after Monday night was final)
# Usage: python3 build_dataset.py <inputs-dir> [out-dir]   (inputs from fetch_inputs.py)
import json, os, sys
IN = sys.argv[1]; OUTDIR = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(os.path.abspath(__file__))
END = {2018: 16, 2019: 16, 2020: 16, 2021: 17, 2022: 17, 2023: 17, 2024: 17, 2025: 17, 2026: 17}
NV2MFL = {"GB": "GBP", "KC": "KCC", "NE": "NEP", "NO": "NOS", "SF": "SFO", "TB": "TBB", "LV": "LVR", "JAX": "JAC", "LA": "LAR"}
arr = lambda x: x if isinstance(x, list) else ([] if x is None else [x])
def grp(p):
    p = (p or "").upper()
    return {"QB":"QB","RB":"RB","FB":"RB","HB":"RB","WR":"WR","TE":"TE","PK":"PK","K":"PK","PN":"PN","P":"PN","DT":"DL","DE":"DL","NT":"DL","DL":"DL","LB":"LB","OLB":"LB","ILB":"LB","MLB":"LB","CB":"DB","S":"DB","FS":"DB","SS":"DB","DB":"DB"}.get(p, "")
def path(kind, y, w=None):
    return f"{IN}/mfl/{kind}_{y}" + (f"_w{w}" if w else "") + ".json"
ids = {}
for r in json.load(open(IN + "/d1/ff_player_ids.json")):
    if r.get("gsis_id") not in (None, "", "NA"): ids[r["mfl_id"]] = r["gsis_id"]
out = {}
for y in range(2018, 2027):
    players = {p["id"]: p for p in arr(json.load(open(path("players", y)))["players"]["player"])}
    wkf = f"{IN}/d1/weekly_team_opp_{y}.json"
    nv = {}
    for r in json.load(open(wkf)): nv.setdefault(r["gsis_id"], {})[r["week"]] = r["team"]
    games, pg, dropped_weeks, stats = [], [], [], {"gameDay": 0, "mflTeam": 0, "unattributed": 0}
    last = min(END[y], max(int(f.split("_w")[1].split(".")[0]) for f in os.listdir(IN + "/mfl") if f.startswith(f"scores_{y}_w")))
    for w in range(1, last + 1):
        sc = json.load(open(path("scores", y, w)))["playerScores"]
        if str(sc.get("week")) != str(w): dropped_weeks.append(w); continue
        sched = arr(json.load(open(path("sched", y, w)))["nflSchedule"].get("matchup"))
        opp = {}
        for m in sched:
            t = arr(m.get("team"))
            if len(t) < 2: continue
            a, b = t[0]["id"], t[1]["id"]
            opp[a] = b; opp[b] = a; games.append({"wk": w, "a": a, "b": b})
        for s in arr(sc.get("playerScore")):
            try: pts = float(s["score"])
            except Exception: continue
            p = players.get(s.get("id"));
            if not p: continue
            g = grp(p.get("position"))
            if not g: continue
            own = None
            byw = nv.get(ids.get(s["id"]), {})
            if byw:
                teams = set(byw.values())
                t = (next(iter(teams)) if (len(teams) == 1 and min(byw) <= w <= max(byw)) else byw.get(w)) if teams else None
                if t:
                    c = NV2MFL.get(t, t)
                    if c in opp: own = c; stats["gameDay"] += 1
            if not own and p.get("team") in opp: own = p["team"]; stats["mflTeam"] += 1
            if not own: stats["unattributed"] += 1; continue
            pg.append([s["id"], w, round(pts, 1), g, own, opp[own]])
    out[y] = {"endWeek": END[y], "weeks": last, "games": games, "pg": pg, "dropped_weeks": dropped_weeks, "attribution": stats}
    print(y, "weeks", last, "games", len(games), "player-games", len(pg), "dropped", dropped_weeks, stats)
json.dump(out, open(OUTDIR + "/dataset.json", "w"))
