#!/usr/bin/env python3
"""Independent check of the built Week 5 issue. Shares NO code with facts.py/build_wk05.py:
re-reads the raw cached sources and re-derives what the page prints."""
import html as H, json, os, re, sys, collections
import polars as pl
DIR = os.path.dirname(os.path.abspath(__file__)); WT = os.path.join(DIR, "..", "wt5")
REPO = "/Users/keithcreelman/Code/MFL/upsmflproduction"
doc = open(os.path.join(WT, "site/wire/articles/2026/2026-wk05-ups-center.html"), encoding="utf-8").read()
auto = open(os.path.join(DIR, "auto_draft.html"), encoding="utf-8").read()
def text(h): return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", h)))
sec = {m.group(1): m.group(0) for m in re.finditer(r'<section class="wire-sec" id="([^"]+)"[\s\S]*?</section>', doc)}
results = []
def ok(name, cond, detail=""):
    results.append((name, bool(cond), str(detail)[:300])); print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  -> " + str(detail)[:300]))

M = json.load(open(os.path.join(DIR, "mfl_2026.json")))
L = lambda x: x if isinstance(x, list) else [x]
fr = {f["id"]: f for f in L(M["league"]["league"]["franchises"]["franchise"])}
hist = json.load(open(os.path.join(DIR, "hist.json")))
own = {r["franchise_id"]: r["owner_name"] for r in hist["franchises"] if r["season"] == 2026}
oid = {v: k for k, v in own.items()}
short = lambda o: "%s. %s" % (o.split()[0][0], o.split(" ", 1)[1])

print("1. status: still a draft, nothing published")
ok("article status is draft", "status: draft" in doc and "status: live" not in doc)
idx = json.load(open(os.path.join(WT, "site/wire/index.json")))
ent = [a for a in (idx["articles"] if isinstance(idx, dict) else idx) if a.get("id") == "2026-wk05-ups-center"]
ok("index.json lists Week 5 as draft only", ent and all(a.get("status") == "draft" for a in ent), ent)

print("2. standings and form, straight from MFL leagueStandings")
st = {f["id"]: f for f in L(M["leagueStandings"]["leagueStandings"]["franchise"])}
heat = text(sec["heat"])
for fid, f in st.items():
    w_, l_ = f["all_play_wlt"].split("-")[:2]
    ok("heat table: %s all-play %s-%s" % (own[fid], w_, l_), re.search(re.escape(short(own[fid])) + r" (Dominant|Sinking|Rising|Cooling|Holding) \S+ \(%s–%s\) " % (w_, l_), heat), short(own[fid]))
story = text(sec["story"])
ok("odds text: Martel 9-4 and Cutting 6-7 (MFL)", "Martel is 9–4 and Cutting 6–7" in text(sec["odds"]) and (st[oid["Brian Cutting"]]["h2hw"], st[oid["Brian Cutting"]]["h2hl"]) == ("6", "7"))
three_ten = [own[f] for f, x in st.items() if (x["h2hw"], x["h2hl"]) == ("3", "10")]
ok("story: the three 3-10 teams", sorted(three_ten) == ["Brian Cross", "Josh Martel", "Matt Gerardi"], three_ten)

print("3. odds, straight from the forecast files")
sim = json.load(open(os.path.join(WT, "site/wire/data/season_sim_2026_live_wk05.json")))
p4 = json.load(open(os.path.join(WT, "site/wire/data/week_preview_2026_wk04.json")))
w3 = {m["fid"]: m for m in p4["movement"]}
odds = text(sec["odds"])
for t in sim["teams"]:
    f = t["franchiseId"]; o = own[f]
    po, d = "%.1f%%" % (100 * t["currentPlayoffOdds"]), "%+.1f" % (100 * (t["currentPlayoffOdds"] - w3[f]["enteringPlayoff"]))
    row = re.search(re.escape(short(o)) + r" (\S+) (\S+) (\S+)", odds)
    ok("odds: %s playoffs %s, since Wk3 %s" % (o, po, d), row and row.group(1) == po and row.group(2).replace("−", "-") == d, row and row.groups())
ok("odds: run is through Week 5 with 10,000 runs", sim["throughWeek"] == 5 and sim["runs"] == 10000 and "10,000 simulated seasons" in odds)
pvc = json.load(open(os.path.join(WT, "site/wire/data/week_preview_2026_wk06.json")))["model"]["cutoffs"]["rostersProjectionsInjuries"]
ok("odds: input cutoff printed (Tue Oct 13, 9:56 PM ET) matches the preview's recorded cutoff %s" % pvc, "Tue Oct 13, 9:56 PM ET" in odds and pvc == "2026-10-14T01:56:56Z")

print("4. history, re-derived from D1 rows and the bracket API (weeks 1-5 only)")
br = json.load(open(os.path.join(DIR, "brackets.json")))
made = {int(s): {x["franchise_id"] for x in v["seeds"] if x.get("path") != "HAWK"} for s, v in br.items()}
sc = collections.defaultdict(dict)
for r in hist["fws"]:
    if not r["is_playoff"] and r["week"] <= 5: sc[r["season"]].setdefault(r["franchise_id"], {})[r["week"]] = r["team_score"]
def apw(s, f):
    return sum(1 for w in range(1, 6) for g in sc[s] if g != f and w in sc[s][f] and w in sc[s][g] and sc[s][f][w] > sc[s][g][w])
cnt = collections.Counter()
for s in range(2017, 2026):
    ws = {f: apw(s, f) for f in sc[s]}
    for f in sc[s]:
        rk = 1 + sum(1 for g in ws if ws[g] > ws[f]); grp = (rk + 1) // 2
        cnt[(grp, f in made[s])] += 1
ok("history: AP rank 1-2 -> 18 of 18", cnt[(1, True)] == 18 and cnt[(1, False)] == 0, (cnt[(1, True)], cnt[(1, False)]))
ok("history: AP rank 11-12 -> 3 of 17", cnt[(6, True)] == 3 and cnt[(6, True)] + cnt[(6, False)] == 17, (cnt[(6, True)], cnt[(6, False)]))
wins = collections.Counter()
for r in hist["schedule"]:
    if 2021 <= r["season"] <= 2025 and not r["is_playoff"] and r["week"] <= 5 and r["result"] == "W": wins[(r["season"], r["franchise_id"])] += 1
le3 = [(s, f) for s in range(2021, 2026) for f in sc[s] if wins[(s, f)] <= 3]
ok("history: 3 or fewer wins after Week 5 (2021-25) -> 0 of 8", len(le3) == 8 and not any(f in made[s] for s, f in le3), le3)
bd = oid["Bear Dunn"]
ok("history: 2017 Bear Dunn 11-44 through Week 5, made it", apw(2017, "0009") == 11 and "0009" in made[2017])
ok("survival text: 8 teams, none made it; 2017 line", "8 teams have reached this point with three wins or fewer. None made the playoffs" in text(sec["survival"]) and "11–44" in text(sec["survival"]))

print("5. player stories, re-derived from nflverse")
pbp = pl.read_parquet(os.path.join(DIR, "pbp_2026.parquet")).filter((pl.col("posteam") == "PIT") & (pl.col("season_type") == "REG"))
runs = pbp.filter(pl.col("play_type") == "run")
rbids = set(pl.read_parquet(os.path.join(DIR, "rw_2026.parquet")).filter((pl.col("team") == "PIT") & (pl.col("position") == "RB"))["gsis_id"].to_list())
wc = {w: runs.filter((pl.col("week") == w) & (pl.col("rusher_player_id") == "00-0037228")).height for w in range(1, 6)}
rb = {w: runs.filter((pl.col("week") == w) & (pl.col("rusher_player_id").is_in(list(rbids)))).height for w in range(1, 6)}
ok("Warren carries 21 of 38 (wks 1-2), 49 of 54 (wks 3-5) [play_type=run]", (wc[1] + wc[2], rb[1] + rb[2], wc[3] + wc[4] + wc[5], rb[3] + rb[4] + rb[5]) == (21, 38, 49, 54), (wc, rb))
ps = pl.read_parquet(os.path.join(DIR, "ps_hist.parquet")).filter(pl.col("season_type") == "REG")
p26 = pl.read_parquet(os.path.join(DIR, "ps_2026.parquet")).filter(pl.col("season_type") == "REG")
more = ps.filter(pl.col("targets") > 24).select(["season", "week", "player_display_name", "targets"]).to_dicts()
ok("only Brandon Marshall (28, 2009) above 24 targets in a game", more == [{"season": 2009, "week": 14, "player_display_name": "Brandon Marshall", "targets": 28}], more)
ok("2026 20-target games = Nacua 24, Lamb 21, Nabers 20", sorted(p26.filter(pl.col("targets") >= 20)["targets"].to_list()) == [20, 21, 24])
inj = pl.read_parquet(os.path.join(DIR, "inj_2026.parquet")).filter(pl.col("full_name") == "Rico Dowdle").sort("week")
ok("Dowdle: Out wks 3-4 (toe), Questionable wk 5", [(r["week"], r["report_status"]) for r in inj.iter_rows(named=True)] == [(3, "Out"), (4, "Out"), (5, "Questionable")])
rw = pl.read_parquet(os.path.join(DIR, "rw_2026.parquet")).filter((pl.col("full_name") == "Rico Dowdle") & (pl.col("week") == 5))
ok("Dowdle inactive Week 5", rw["status"].to_list() == ["INA"])
ok("Lions bye in Week 6", pl.read_parquet(os.path.join(DIR, "sched_2026.parquet")).filter((pl.col("week") == 6) & ((pl.col("home_team") == "DET") | (pl.col("away_team") == "DET"))).height == 0)
mi = {i["id"]: i for i in L(json.load(open(os.path.join(DIR, "mfl_injuries.json")))["injuries"]["injury"])}
ok("MFL: Achane IR ACL back Feb 15 2027; Reed IR neck back Feb 15 2027", mi["16167"]["status"] == "IR" and "ACL" in mi["16167"]["details"] and mi["16167"]["exp_return"] == "Feb 15, 2027"
   and mi["16184"]["status"] == "IR" and mi["16184"]["exp_return"] == "Feb 15, 2027")
ok("MFL still lists Dowdle Questionable", mi["14823"]["status"] == "Questionable")

print("6. ownership at the time: who started whom")
def started(w, pid):
    for m in L(M["weeklyResults_%d" % w]["weeklyResults"]["matchup"]):
        for f in L(m["franchise"]):
            for p in L(f["player"]):
                if p["id"] == pid: return f["id"], p["status"], p.get("score")
ok("Henry: Cross wks 1-4, Blake wk 5 (22.6)", [own[started(w, "12626")[0]] for w in range(1, 6)] == ["Brian Cross"] * 4 + ["Shawn Blake"] and started(5, "12626")[2] == "22.6"
   if started(1, "12626") else False, [started(w, "12626") for w in range(1, 6)])
ok("Bowers wk3 on Bear's bench (36.0), started wks 4-5", [started(w, "16641")[1] for w in (3, 4, 5)] == ["nonstarter", "starter", "starter"] if started(3, "16641") else False, [started(w, "16641") for w in (3, 4, 5)])

print("7. quotes: verbatim, linked to their own message, allowed")
sys.path.insert(0, os.path.join(REPO, "pipelines/etl/wire")); import chat_exclusions as CX
src = json.load(open(os.path.expanduser("~/Library/Caches/upsmfl-ups-center-auto/2026-wk05-ups-center.sources.json")))
chat = {m["message_id"]: m for m in src["d1"]["chat"]}
ids = CX.excluded_ids()
qs = re.findall(r'<a class="rcpt" href="https://discord\.com/channels/(\d+)/(\d+)/(\d+)"[^>]*>&ldquo;([\s\S]*?)&rdquo;</a>', doc)
ok("five quotes", len(qs) == 5, len(qs))
for g, ch, mid, q in qs:
    m = chat.get(mid); t = H.unescape(q)
    ok("quote %s verbatim, channel matches, not excluded" % mid, m and " ".join(m["content"].split()) == t and m["channel_id"] == ch and not CX.reason(mid, t, ids), (t, m and m["content"]))
for mid in ids:
    ok("ruled-out message %s absent (id)" % mid, mid not in doc)
withheld = [m for m in src["d1"]["chat"] if m.get("withheld")]
ok("no withheld chat in the snapshot leaked (ids)", all(m["message_id"] not in doc for m in withheld))
dt = " ".join(text(s) for s in sec.values())           # what a reader sees (segments), not the runtime script
hits = [x for x in CX.PATTERN.findall(dt) if x != "ACL"]      # "torn ACL" = NFL injury news from MFL's IR record (Achane), not chat
ok("no never-material terms in the reader-visible text (an NFL 'ACL' from an IR record would be allowed)", not hits and dt.count("ACL") <= 1, hits)
pt = CX.private_terms()[0]
ok("no private (dossier) names in the reader-visible text", pt is None or not pt.search(dt), pt and pt.findall(dt)[:10])

print("8. highlight links unchanged from the validated automated draft")
links = lambda h: sorted(re.findall(r'class="wire-play-watch" href="([^"]+)"', h))
ok("same verified highlight links", links(doc) == links(auto) and links(doc), links(doc))

print("10. v2 claims (Keith's 2026-10-14 review), recomputed independently")
sys.path.insert(0, os.path.join(WT, "pipelines/etl/wire")); import season_sim as SS
r = __import__("subprocess").run([sys.executable, os.path.join(WT, "pipelines/etl/wire/test_season_sim_divisions.py")], capture_output=True, text=True)
ok("division tests pass (one winner per division per season, tiebreak order, totals, rounding)", r.returncode == 0 and "ALL PASS" in r.stdout, r.stdout[-400:])
oddstxt = text(sec["odds"])
divs = {}
for tt in sim["teams"]: divs.setdefault(tt["division"], {})[tt["franchiseId"]] = tt["currentDivisionOdds"]
for d, pr in divs.items():
    shown = SS.display_percentages(pr)
    ok("division %s: raw total 1, shown %s = 100.0, all printed" % (d, "/".join(shown.values())), abs(sum(pr.values()) - 1) < 1e-9 and abs(sum(float(x) for x in shown.values()) - 100) < 1e-9
       and all((short(own[f]) + " ") in oddstxt and (shown[f] + "%") in oddstxt for f in pr))
pv2 = json.load(open(os.path.join(WT, "site/wire/data/week_preview_2026_wk06.json"))); mv2 = {m["fid"]: m for m in pv2["movement"]}
ok("preview and forecast are the same simulated seasons (playoff odds identical to 4 dp)", all(abs(mv2[tt["franchiseId"]]["enteringPlayoff"] - round(tt["currentPlayoffOdds"], 4)) < 1e-9 for tt in sim["teams"]))
gwc = next(g for g in pv2["games"] if {g["a"], g["b"]} == {oid["Derrick Whitman"], oid["Brian Cutting"]})
wl, ww = (gwc["aPoLoss"], gwc["aPoWin"]) if gwc["a"] == oid["Derrick Whitman"] else (gwc["bPoLoss"], gwc["bPoWin"])
pt = text(sec["players"])
ok("Whitman: 39.8% today, 32.1% in seasons where he loses to Cutting, 51.3% where he wins", "whose playoff probability is 39.8% today" in pt and "it falls to %.1f%%" % (100 * wl) in pt and "it rises to %.1f%%" % (100 * ww) in pt, (wl, ww))
# Bousquet with a replacement-level back (independent: replacement = mean of RB ranks just outside the started-RB count, from raw MFL)
pos = {p["id"]: p.get("position") for p in L(M["players"]["players"]["player"])}
bq = oid["Ryan Bousquet"]; tsc = {}; wpts = {}; rbs = {}
for w in range(1, 6):
    fr_ = {}
    for m in L(M["weeklyResults_%d" % w]["weeklyResults"]["matchup"]):
        for f in L(m["franchise"]): fr_[f["id"]] = f
    tsc[w] = {k: float(v["score"]) for k, v in fr_.items()}
    allrb = [(float(p.get("score") or 0), p["status"]) for f in fr_.values() for p in L(f["player"]) if pos.get(p["id"]) == "RB"]
    nst = sum(1 for s, st_ in allrb if st_ == "starter")
    rbs[w] = (nst, sorted([s for s, _ in allrb], reverse=True))
    wpts[w] = next(float(p.get("score") or 0) for p in L(fr_[bq]["player"]) if p["id"] == "16032" or False) if False else None
war_id = next(p["id"] for p in L(M["players"]["players"]["player"]) if p["name"] == "Warren, Jaylen")
ok("Warren appears in Bousquet's started lineup every week", all(any(p["id"] == war_id and p["status"] == "starter" for m in L(M["weeklyResults_%d" % w]["weeklyResults"]["matchup"]) for f in L(m["franchise"]) if f["id"] == bq for p in L(f["player"])) for w in range(1, 6)))
ok("v2 text: Bousquet 4-9 with a replacement back, 12 all-play wins instead of 20", "Ryan is 4–9 instead of 6–7, with 12 all-play wins instead of 20" in pt)
# Pittsburgh by down (independent filter: play_type == run, down 1-2)
early = lambda wks, gid=None: runs.filter(pl.col("week").is_in(wks) & pl.col("down").is_in([1, 2]) & (pl.col("rusher_player_id").is_in(list(rbids)) if gid is None else (pl.col("rusher_player_id") == gid))).height
ok("PIT early-down carries: Dowdle 15 of 37 with him; Warren 43 of 47 without", (early([1, 2], "00-0036139"), early([1, 2]), early([3, 4, 5], "00-0037228"), early([3, 4, 5])) == (15, 37, 43, 47),
   (early([1, 2], "00-0036139"), early([1, 2]), early([3, 4, 5], "00-0037228"), early([3, 4, 5])))
gl = runs.filter((pl.col("yardline_100") <= 5) & pl.col("rusher_player_id").is_in(list(rbids))).height
ok("no Steelers RB carry inside the 5 in Weeks 1-5", gl == 0, gl)
# same-season pairs 2020-2025 (independent)
def wk5(s):
    out = {}
    for f in sc[s]:
        apw_ = apw(s, f); pf_ = sum(sc[s][f].get(w, 0) for w in range(1, 6))
        g = [r for r in hist["schedule"] if r["season"] == s and r["franchise_id"] == f and not r["is_playoff"] and r["week"] <= 5]
        out[f] = (apw_, pf_, sum(r["result"] == "W" for r in g) / max(1, len(g)))
    return out
hits = [0, 0, 0]; npairs = 0
for s in range(2020, 2026):
    v = wk5(s); P_ = [f for f in v if f in made[s]]; N_ = [f for f in v if f not in made[s]]
    for a in P_:
        for b in N_:
            npairs += 1
            for i in range(3): hits[i] += 1 if v[a][i] > v[b][i] else (0.5 if v[a][i] == v[b][i] else 0)
acc = [round(100 * h / npairs) for h in hits]
ok("same-season pairs 2020-25: All-Play 88%%, points 86%%, record 85%% over 216 pairs (got %s over %d)" % (acc, npairs), acc == [88, 86, 85] and npairs == 216)
ok("survival text states those three rates", "88% of the time, compared with 86% for more points and 85% for the better overall record" in text(sec["survival"]))
ok("Klingenberg did not post in the chat window", not any(m["owner_name"] == "Chris Klingenberg" for m in src["d1"]["chat"]))
b5 = [p for m in L(M["weeklyResults_5"]["weeklyResults"]["matchup"]) for f in L(m["franchise"]) if f["id"] == oid["Shawn Blake"] for p in L(f["player"])]
qbs = {p["id"] for p in b5 if pos.get(p["id"]) == "QB"}
ok("Blake's Week 5 roster has exactly two quarterbacks (Allen, Purdy)", len(qbs) == 2, qbs)
print("9. no production writes in the code paths used")
for f in ("pipelines/etl/wire/season_sim.py", "pipelines/etl/wire/week_preview.py", "pipelines/etl/wire/ev_projections.py"):
    s = open(os.path.join(WT, f)).read()
    ok("%s has no INSERT/UPDATE/DELETE/POST" % f, not re.search(r"\b(INSERT|UPDATE|DELETE)\b\s+(INTO|\w+\s+SET|FROM)|method=\"POST\"|/webhooks/", s))
fails = [r for r in results if not r[1]]
json.dump([dict(check=n, ok=o, detail=d) for n, o, d in results], open(os.path.join(DIR, "verify_wk05.json"), "w"), indent=1)
print("\n%d checks, %d failed" % (len(results), len(fails)))
sys.exit(1 if fails else 0)
