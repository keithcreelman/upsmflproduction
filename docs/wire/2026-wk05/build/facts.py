#!/usr/bin/env python3
"""Every fact the Week 5 issue prints, recomputed from the cached sources, with its
source and cutoff. Output: facts.json (also the reconciliation report's input).

Sources (pulled once, 2026-10-14 ~01:55Z; no D1 reads here):
  mfl_2026.json        MFL weeklyResults W1-5, leagueStandings, schedule, transactions, players
  hist.json            D1 src_* tables (3,173 + 3,440 + ... rows; 7,234 rows read in total)
  brackets.json        worker /api/playoff-bracket?YEAR=2010..2025 (who made each bracket)
  week_preview_2026_wk06.json, season_sim_2026_live_wk05.json   the forecast (inputs 01:56:56Z)
  week_preview_2026_wk04.json   the odds published in the Week 3 issue (cutoff Wed Sep 30 8:22 AM ET)
  nflverse (nflreadpy): player stats 1999-2026, snaps, injuries, schedules, pbp 2026, ff ids
  mfl_injuries.json    api.myfantasyleague.com TYPE=injuries (IR status + expected return)
"""
import collections, json, os, statistics as S
import polars as pl
from core import *                      # TW, AP, FIDS, owner, pname, ppos, M, H, L, WEEKS
from upsscore import ups

DIR = os.path.dirname(os.path.abspath(__file__))
WT = os.path.join(DIR, "..", "wt5")
F = {"sources": {}, "teams": {}, "odds": {}, "history": {}, "players": {}, "notes": []}
def src(k, v): F["sources"][k] = v

# ---------------------------------------------------------------- teams (MFL)
src("mfl", "MFL export weeklyResults W=1..5 + leagueStandings, league 74598, pulled %s" % M["pulledAtUtc"])
st = {f["id"]: f for f in L(M["leagueStandings"]["leagueStandings"]["franchise"])}
for f in FIDS:
    sc = [TW[(w, f)]["score"] for w in WEEKS]; op = [TW[(w, f)]["opt"] for w in WEEKS]
    games = [dict(g, week=w) for w in WEEKS for g in TW[(w, f)]["games"]]
    W_ = sum(g["result"] == "W" for g in games); L_ = sum(g["result"] == "L" for g in games)
    apw = [AP[w][f][0] for w in WEEKS]; apl = [AP[w][f][1] for w in WEEKS]
    xw = sum(AP[w][f][0] / 11.0 for w in WEEKS for g in TW[(w, f)]["games"])
    lost_best = [g for g in games if g["result"] == "L" and TW[(g["week"], f)]["opt"] > TW[(g["week"], g["opp"])]["score"]]
    F["teams"][f] = dict(owner=owner(f), team=FR[f]["team_name"], div=FR[f]["division"], W=W_, L=L_,
        apw=sum(apw), apl=sum(apl), ap3=(sum(apw[2:]), sum(apl[2:])), ap45=(sum(apw[3:]), sum(apl[3:])), apw_by_week=apw,
        w45=sum(g["result"] == "W" for g in games if g["week"] >= 4), l45=sum(g["result"] == "L" for g in games if g["week"] >= 4),
        pf=round(sum(sc), 1), ppw=round(sum(sc) / 5, 1), ppw12=round(sum(sc[:2]) / 2, 1), ppw3=round(sum(sc[2:]) / 3, 1),
        optw=round(sum(op) / 5, 1), eff=sum(sc) / sum(op), bench_w=round(sum(o - s for o, s in zip(op, sc)) / 5, 1),
        bench_by_week=[round(o - s, 1) for o, s in zip(op, sc)], weekly=sc, xw=round(xw, 1), luck=round(W_ - xw, 1),
        lost_best=len(lost_best), mfl_pf=float(st[f]["pf"]), mfl_ap=st[f]["all_play_wlt"])
    assert abs(F["teams"][f]["pf"] - float(st[f]["pf"])) < 0.05, f            # D1/derived == MFL standings
    assert st[f]["all_play_wlt"].startswith("%d-%d" % (sum(apw), sum(apl))), (f, st[f]["all_play_wlt"])
    assert (W_, L_) == (int(st[f]["h2hw"]), int(st[f]["h2hl"])), f
for key, nm in (("ppw12", "rk12"), ("ppw3", "rk3"), ("ppw", "rkfull"), ("optw", "rkopt"), ("bench_w", "rkbench")):
    vals = {f: F["teams"][f][key] for f in FIDS}
    for f in FIDS: F["teams"][f][nm] = 1 + sum(1 for g in FIDS if vals[g] > vals[f])
ap = {f: F["teams"][f]["apw"] for f in FIDS}
for f in FIDS: F["teams"][f]["aprk"] = 1 + sum(1 for g in FIDS if ap[g] > ap[f])

# ---------------------------------------------------------------- the forecast
sim = json.load(open(os.path.join(WT, "site/wire/data/season_sim_2026_live_wk05.json")))
p6 = json.load(open(os.path.join(WT, "site/wire/data/week_preview_2026_wk06.json")))
p4 = json.load(open(os.path.join(WT, "site/wire/data/week_preview_2026_wk04.json")))
src("odds", "season_sim.py --through-week 5 (official refresh-only model), %d runs, seed %s, generated %s; inputs fetched %s (shared with week_preview_2026_wk06.json)"
    % (sim["runs"], sim["seed"], sim["generatedAtUtc"], p6["generatedAtUtc"]))
mv = {m["fid"]: m for m in p6["movement"]}; mv4 = {m["fid"]: m for m in p4["movement"]}
for t in sim["teams"]:
    f = t["franchiseId"]
    F["odds"][f] = dict(div=t["currentDivisionOdds"], po=t["currentPlayoffOdds"], bye=t["currentByeOdds"], title=t["currentTitleOdds"],
                        po_wk3=mv4[f]["enteringPlayoff"], title_wk3=mv4[f]["enteringTitle"], po_pre=t["preseasonPlayoffOdds"],
                        title_pre=t["preseasonTitleOdds"], proj_end_ap=t["projectedEndingApPct"],
                        po_preview=mv[f]["enteringPlayoff"], po_mfl=mv[f]["enteringPlayoffMflOffense"], switch=mv[f]["switchEffect"],
                        absence=t.get("biggestAbsence"))
    assert abs(mv[f]["enteringPlayoff"] - t["currentPlayoffOdds"]) < 0.01, f   # the two runs agree
F["odds_meta"] = dict(runs=sim["runs"], seed=sim["seed"], generated=sim["generatedAtUtc"], inputs=p6["generatedAtUtc"],
                      regress=sim["model"]["regress"], wk3_cutoff=p4["generatedAtUtc"], through=sim["throughWeek"],
                      assumptions=p6["model"]["assumptions"], keptMfl=sim["model"]["evCoverage"]["keptMfl"])
F["week6_games"] = sorted([dict(a=g["a"], b=g["b"], pA=g["pA"], stakes=g["stakes"], aW=g["aPoWin"], aL=g["aPoLoss"], bW=g["bPoWin"], bL=g["bPoLoss"])
                           for g in p6["games"]], key=lambda g: -g["stakes"])

# ---------------------------------------------------------------- history (D1 + bracket API)
rows = json.load(open(os.path.join(DIR, "survival_rows.json")))
src("history", "D1 src_franchise_weekly_score + src_schedule (Week 1-5 only, nothing later), bracket field = /api/playoff-bracket path != HAWK")
modern = [r for r in rows if 2017 <= r["season"] <= 2025]
h13 = [r for r in rows if 2021 <= r["season"] <= 2025]
def grp(rs, key, buckets):
    return [(lab, sum(r["made"] for r in rs if t(key(r))), sum(1 for r in rs if t(key(r)))) for lab, t in buckets]
F["history"]["ap_groups"] = grp(modern, lambda r: r["aprk"], [("1–2", lambda x: x <= 2), ("3–4", lambda x: 3 <= x <= 4), ("5–6", lambda x: 5 <= x <= 6),
                                                              ("7–8", lambda x: 7 <= x <= 8), ("9–10", lambda x: 9 <= x <= 10), ("11–12", lambda x: x >= 11)])
F["history"]["h2h_groups"] = grp(h13, lambda r: r["w"], [("10 or more", lambda w: w >= 10), ("8–9", lambda w: 8 <= w <= 9), ("6–7", lambda w: 6 <= w <= 7),
                                                         ("4–5", lambda w: 4 <= w <= 5), ("3 or fewer", lambda w: w <= 3)])
F["history"]["n_modern"], F["history"]["n_h13"] = len(modern), len(h13)
F["history"]["three_ten"] = (sum(r["made"] for r in rows if 2020 <= r["season"] <= 2025 and (r["w"], r["l"]) == (3, 10)),
                             sum(1 for r in rows if 2020 <= r["season"] <= 2025 and (r["w"], r["l"]) == (3, 10)))
b17 = next(r for r in rows if r["season"] == 2017 and r["owner"] == "Bear Dunn")
br = {int(k): v for k, v in json.load(open(os.path.join(DIR, "brackets.json"))).items()}
e17 = next(s for s in br[2017]["seeds"] if s["franchise_id"] == b17["fid"])
F["history"]["bear2017"] = dict(apw=b17["apw"], apl=b17["apl"], aprk=b17["aprk"], seed=e17["seed"], finish=e17["final_finish"], path=e17["path"])
def auc(rs, key):
    pos = [key(r) for r in rs if r["made"]]; neg = [key(r) for r in rs if not r["made"]]
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))
h2020 = [r for r in rows if 2020 <= r["season"] <= 2025]
F["history"]["auc"] = dict(n=len(h2020), ap=auc(h2020, lambda r: r["ap"]), h2h=auc(h2020, lambda r: (r["w"] + .5 * r["t"]) / max(1, r["w"] + r["l"] + r["t"])),
                           pf=auc(h2020, lambda r: r["pf"]))
F["history"]["bottom3"] = (sum(r["made"] for r in modern if r["aprk"] >= 10), sum(1 for r in modern if r["aprk"] >= 10))
F["history"]["playoff_teams"] = {s: sum(1 for x in br[s]["seeds"] if x.get("path") != "HAWK") for s in range(2017, 2026)}

# ---------------------------------------------------------------- players
pw = json.load(open(os.path.join(DIR, "player_weeks.json")))
tpp = json.load(open(os.path.join(DIR, "team_player_par.json")))
F["team_players"] = tpp
ps26 = pl.read_parquet(os.path.join(DIR, "ps_2026.parquet"))
def box(name, w):
    r = ps26.filter((pl.col("player_display_name") == name) & (pl.col("week") == w)).to_dicts()
    return r[0] if r else None
def upsrow(name):
    return [r for r in pw if r["name"] == name]
# Warren / Dowdle
sn = pl.read_parquet(os.path.join(DIR, "snaps_2026.parquet")).filter((pl.col("team") == "PIT") & (pl.col("position") == "RB"))
snap = {(r["player"], r["week"]): r["offense_pct"] for r in sn.iter_rows(named=True)}
pbp = pl.read_parquet(os.path.join(DIR, "pbp_2026.parquet")).filter((pl.col("posteam") == "PIT") & (pl.col("season_type") == "REG"))
rbs = set(pl.read_parquet(os.path.join(DIR, "rw_2026.parquet")).filter((pl.col("team") == "PIT") & (pl.col("position") == "RB"))["gsis_id"].to_list())
WARREN, DOWDLE = "00-0037228", "00-0036139"
def car(w, gid): return pbp.filter((pl.col("week") == w) & (pl.col("rush_attempt") == 1) & (pl.col("rusher_player_id") == gid)).height
def rbcar(w): return pbp.filter((pl.col("week") == w) & (pl.col("rush_attempt") == 1) & (pl.col("rusher_player_id").is_in(list(rbs)))).height
inj = pl.read_parquet(os.path.join(DIR, "inj_2026.parquet"))
dinj = {r["week"]: r for r in inj.filter(pl.col("full_name") == "Rico Dowdle").iter_rows(named=True)}
wr = {r["week"]: r for r in upsrow("Jaylen Warren")}; dr = {r["week"]: r for r in upsrow("Rico Dowdle")}
tds = pbp.filter((pl.col("week") == 5) & (pl.col("touchdown") == 1) & ((pl.col("rusher_player_id") == WARREN) | (pl.col("receiver_player_id") == WARREN)))
F["players"]["warren"] = dict(
    snap={w: snap.get(("Jaylen Warren", w)) for w in WEEKS}, dsnap={w: snap.get(("Rico Dowdle", w)) for w in WEEKS},
    car={w: car(w, WARREN) for w in WEEKS}, dcar={w: car(w, DOWDLE) for w in WEEKS}, rbcar={w: rbcar(w) for w in WEEKS},
    tgt={w: (box("Jaylen Warren", w) or {}).get("targets") for w in WEEKS}, ups={w: wr[w]["ups"] for w in WEEKS},
    owner={w: owner(wr[w]["fid"]) for w in WEEKS}, downer={w: owner(dr[w]["fid"]) for w in WEEKS}, dups={w: dr[w]["ups"] for w in WEEKS},
    dstatus={w: dr[w]["status"] for w in WEEKS},
    dinj={w: (dinj[w]["report_status"], dinj[w]["report_primary_injury"], dinj[w]["practice_status"]) for w in dinj},
    wk5_tds=[(r["yards_gained"], r["play_type"]) for r in tds.iter_rows(named=True)],
    wk5_rz=pbp.filter((pl.col("week") == 5) & (pl.col("yardline_100") <= 20) & ((pl.col("rusher_player_id") == WARREN) | (pl.col("receiver_player_id") == WARREN))).height,
    wk5_box=box("Jaylen Warren", 5) and {k: box("Jaylen Warren", 5)[k] for k in ("carries", "rushing_yards", "rushing_tds", "receptions", "targets", "receiving_yards", "receiving_tds")})
src("pit", "nflverse pbp 2026 (rusher/receiver ids), snap_counts, injuries (week 5 = last report; Week 6 practice reports start Wed Oct 14)")
# Bowers, JSN, Gibbs, Puka, Lamb, Nabers
F["players"]["ups"] = {nm: {"weeks": {r["week"]: dict(ups=r["ups"], status=r["status"], owner=owner(r["fid"]) if r["fid"] else None,
                                                      snap=r["snappct"], tgt=r["targets"], car=r["carries"]) for r in upsrow(nm)}}
                       for nm in ("Brock Bowers", "Jaxon Smith-Njigba", "Jahmyr Gibbs", "Puka Nacua", "CeeDee Lamb", "Malik Nabers",
                                  "Tyler Huntley", "Aaron Rodgers", "Deshaun Watson", "Drake Maye", "Lamar Jackson", "Davante Adams", "Derrick Henry",
                                  "Christian Watson", "Dak Prescott", "Josh Allen", "Brock Purdy", "Bijan Robinson", "Malik Willis")}
F5 = json.load(open(os.path.join(DIR, "first5.json")))
def rank(name, season, pos, key="pts"):
    pool = [r for r in F5 if r["pos"] == pos]
    me = next(r for r in pool if r["name"] == name and r["season"] == season)
    top = sorted(pool, key=lambda r: -r[key])
    return dict(me=me, rank=1 + sum(1 for r in pool if r[key] > me[key]), n=len(pool), above=[r for r in top if r[key] > me[key]])
F["players"]["jsn"] = rank("Jaxon Smith-Njigba", 2026, "WR"); F["players"]["gibbs"] = rank("Jahmyr Gibbs", 2026, "RB")
src("first5", "nflverse weekly stats 1999-2026, REG; a player's TEAM's first five games (missed games count zero); 2026 UPS offensive rules applied to every season (scorer reproduces MFL's 2026 scores exactly in 81% of 952 player-games, within 1 point in 91%)")
F["notes"].append("History scoring basis: 2026 UPS rules applied to box scores; the +1 for a 50+ yard TD and return yards are not in box scores.")
json.dump(F, open(os.path.join(DIR, "facts.json"), "w"), indent=1, default=str)
print("facts.json written:", {k: len(v) if hasattr(v, "__len__") else v for k, v in F.items()})
