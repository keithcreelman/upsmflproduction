"""Extra facts for the v2 rewrite (Keith's 2026-10-14 review), appended to facts.json as F['v2']."""
import json, collections, polars as pl
from core import *
F = json.load(open("facts.json")); V = {}
R = json.load(open("player_weeks.json")); tpp = json.load(open("team_player_par.json"))
POSG = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN", "DE": "DL", "DT": "DL", "LB": "LB", "CB": "DB", "S": "DB"}
fid = lambda o: next(f for f in FIDS if owner(f) == o)
# replacement levels (same definition as scan.py)
import statistics as S
starters = collections.Counter((r["week"], POSG.get(r["pos"], r["pos"])) for r in R if r["status"] == "starter")
S_n = {g: round(S.mean([starters[(w, g)] for w in WEEKS])) for g in {g for (_, g) in starters}}
repl = {}
for w in WEEKS:
    for g, n in S_n.items():
        sc = sorted([r["ups"] or 0 for r in R if r["week"] == w and POSG.get(r["pos"], r["pos"]) == g and r["teamgame"] and r["fid"]], reverse=True)
        pool = sc[n:n + 6]; repl[(w, g)] = sum(pool) / len(pool) if pool else 0
V["repl_rb"] = {w: round(repl[(w, "RB")], 1) for w in WEEKS}
# ---- Bousquet and Warren
BO = fid("Ryan Bousquet"); sc = {w: TW[(w, BO)]["score"] for w in WEEKS}
war = {r["week"]: r for r in R if r["name"] == "Jaylen Warren"}
cf = {w: sc[w] - ((war[w]["ups"] or 0) - repl[(w, "RB")] if war[w]["status"] == "starter" else 0) for w in WEEKS}
def rec_with(scores_by_week):
    W = L_ = 0
    for w in WEEKS:
        for g in TW[(w, BO)]["games"]:
            opp = TW[(w, g["opp"])]["score"]
            if scores_by_week[w] > opp: W += 1
            elif scores_by_week[w] < opp: L_ += 1
    return W, L_
def ap_with(scores_by_week):
    return sum(sum(1 for f in FIDS if f != BO and scores_by_week[w] > TW[(w, f)]["score"]) for w in WEEKS)
V["bousquet"] = dict(ppw12=round((sc[1] + sc[2]) / 2, 1), ppw3=round((sc[3] + sc[4] + sc[5]) / 3, 1), weekly=sc,
                     warren12=round((war[1]["ups"] + war[2]["ups"]) / 2, 1), warren3=round((war[3]["ups"] + war[4]["ups"] + war[5]["ups"]) / 3, 1),
                     rec=rec_with(sc), rec_cf=rec_with(cf), ap=ap_with(sc), ap_cf=ap_with(cf),
                     cf_ppw3=round((cf[3] + cf[4] + cf[5]) / 3, 1), w13=[g["result"] for w in (1, 2, 3) for g in TW[(w, BO)]["games"]],
                     w45=[g["result"] for w in (4, 5) for g in TW[(w, BO)]["games"]], apweekly=[AP[w][BO][0] for w in WEEKS])
V["bousquet"]["rise"] = round(V["bousquet"]["ppw3"] - V["bousquet"]["ppw12"], 1)
V["bousquet"]["warren_rise"] = round(V["bousquet"]["warren3"] - V["bousquet"]["warren12"], 1)
# ---- Pittsburgh backfield by situation (nflverse pbp)
pbp = pl.read_parquet("pbp_2026.parquet").filter((pl.col("posteam") == "PIT") & (pl.col("season_type") == "REG"))
WA, DO = "00-0037228", "00-0036139"
rbs = set(pl.read_parquet("rw_2026.parquet").filter((pl.col("team") == "PIT") & (pl.col("position") == "RB"))["gsis_id"].to_list())
def split(weeks):
    g = pbp.filter(pl.col("week").is_in(weeks))
    runs = g.filter((pl.col("rush_attempt") == 1) & pl.col("rusher_player_id").is_in(list(rbs)))
    tg = g.filter((pl.col("pass_attempt") == 1) & pl.col("receiver_player_id").is_in(list(rbs)))
    out = {}
    for who, gid in (("warren", WA), ("dowdle", DO)):
        r = runs.filter(pl.col("rusher_player_id") == gid); t = tg.filter(pl.col("receiver_player_id") == gid)
        out[who] = dict(early_car=r.filter(pl.col("down").is_in([1, 2])).height, short_car=r.filter(pl.col("ydstogo") <= 2).height,
                        rz_car=r.filter(pl.col("yardline_100") <= 20).height, gl_car=r.filter(pl.col("yardline_100") <= 5).height,
                        tgt=t.height, tgt_3rd=t.filter(pl.col("down").is_in([3, 4])).height)
    out["rb"] = dict(early_car=runs.filter(pl.col("down").is_in([1, 2])).height, short_car=runs.filter(pl.col("ydstogo") <= 2).height,
                     rz_car=runs.filter(pl.col("yardline_100") <= 20).height, gl_car=runs.filter(pl.col("yardline_100") <= 5).height,
                     tgt=tg.height, tgt_3rd=tg.filter(pl.col("down").is_in([3, 4])).height)
    return out
V["pit"] = {"with": split([1, 2]), "without": split([3, 4, 5])}
firsts = {}
for w in WEEKS:
    g = pbp.filter((pl.col("week") == w) & (pl.col("rush_attempt") == 1) & pl.col("rusher_player_id").is_in(list(rbs))).sort(["game_seconds_remaining"], descending=True)
    firsts[w] = g["rusher_player_name"].to_list()[0] if g.height else None
V["pit"]["first_rb_carry"] = firsts
# ---- concentration: depth behind each team's top two (current week-5 roster), and dips
cur = {f: [p for p in TW[(5, f)]["players"]] for f in FIDS}
def avg_when_played(name):
    v = [r["ups"] for r in R if r["name"] == name and (r["snaps"] or 0) > 0 and r["ups"] is not None]
    return round(sum(v) / len(v), 1) if v else None
conc = {}
for f in FIDS:
    rows = sorted([(nm, v) for nm, v in tpp[f].items() if POSG.get(next((r["pos"] for r in R if r["name"] == nm), "?")) not in ("PK", "PN")], key=lambda kv: -kv[1]["par"])
    tot = sum(v["par"] for _, v in rows if v["par"] > 0)
    top2 = rows[:2]; info = []
    for nm, v in top2:
        pos = POSG.get(next(r["pos"] for r in R if r["name"] == nm))
        bench = [pname(p["pid"]) for p in cur[f] if p["status"] != "starter" and POSG.get(ppos(p["pid"])) == pos]
        bench_avg = sorted([(avg_when_played(b) or 0, b) for b in bench], reverse=True)
        wk = {r["week"]: r["ups"] for r in R if r["name"] == nm and r["fid"] == f}
        info.append(dict(name=nm, pos=pos, par=round(v["par"], 1), per_week_edge=round(v["par"] / max(1, len([w for w in wk if w])), 1),
                         weekly=wk, best_bench=bench_avg[0] if bench_avg else None))
    conc[owner(f)] = dict(top2_share=round(100 * sum(v["par"] for _, v in top2) / tot, 1), total=round(tot, 1), players=info,
                          apweekly=[AP[w][f][0] for w in WEEKS], resweekly=["".join(g["result"] for g in TW[(w, f)]["games"]) for w in WEEKS])
V["concentration"] = conc
# ---- Gibbs' share of Cutting
CU = fid("Brian Cutting"); started_cu = sum(v["pts"] for v in tpp[CU].values())
pos_edge_cu = sum(v["par"] for nm, v in tpp[CU].items() if v["par"] > 0 and POSG.get(next((r["pos"] for r in R if r["name"] == nm), "?")) not in ("PK", "PN"))
V["gibbs_share"] = dict(pts=round(100 * tpp[CU]["Jahmyr Gibbs"]["pts"] / started_cu, 1), edge=round(100 * tpp[CU]["Jahmyr Gibbs"]["par"] / pos_edge_cu, 1),
                        ppg=round(tpp[CU]["Jahmyr Gibbs"]["pts"] / 5, 1))
# ---- within-season pair comparison, 2020-2025
rows = json.load(open("survival_rows.json"))
def pairs(rs, key):
    hit = tot = 0.0
    for s in sorted({r["season"] for r in rs}):
        po = [r for r in rs if r["season"] == s and r["made"]]; no = [r for r in rs if r["season"] == s and not r["made"]]
        for a in po:
            for b in no:
                tot += 1; hit += 1 if key(a) > key(b) else (0.5 if key(a) == key(b) else 0)
    return hit / tot, int(tot)
h20 = [r for r in rows if 2020 <= r["season"] <= 2025]
V["pairs"] = {k: pairs(h20, fn) for k, fn in (("ap", lambda r: r["ap"]), ("h2h", lambda r: (r["w"] + .5 * r["t"]) / max(1, r["w"] + r["l"] + r["t"])), ("pf", lambda r: r["pf"]))}
# ---- Week 6 scenarios from the corrected preview (same simulated seasons as the odds)
pv = json.load(open("../wt5/site/wire/data/week_preview_2026_wk06.json")); mv = {m["fid"]: m for m in pv["movement"]}
V["week6"] = [dict(a=g["a"], b=g["b"], pA=g["pA"], stakes=g["stakes"], aW=g["aPoWin"], aL=g["aPoLoss"], bW=g["bPoWin"], bL=g["bPoLoss"],
                   aNow=mv[g["a"]]["enteringPlayoff"], bNow=mv[g["b"]]["enteringPlayoff"]) for g in sorted(pv["games"], key=lambda g: -g["stakes"])]
F["v2"] = V
json.dump(F, open("facts.json", "w"), indent=1, default=str)
b = V["bousquet"]; print("BOUSQUET", {k: b[k] for k in b if k != "weekly"})
print("PIT", json.dumps(V["pit"]))
print("GIBBS", V["gibbs_share"]); print("PAIRS", V["pairs"]); print("REPL RB", V["repl_rb"])
for o in ("Shawn Blake", "Eric Mannila", "Bear Dunn", "Chris Klingenberg", "Brian Cutting"):
    c = conc[o]; print("CONC", o, c["top2_share"], c["apweekly"], c["resweekly"], [(p["name"], p["per_week_edge"], p["weekly"], p["best_bench"]) for p in c["players"]])
w = next(g for g in V["week6"] if {owner(g["a"]), owner(g["b"])} == {"Derrick Whitman", "Brian Cutting"}); print("WHIT-CUT", w)
