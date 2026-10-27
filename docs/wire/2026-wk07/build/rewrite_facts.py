"""Facts for the Week 7 editorial rewrite (Keith's route 1, 2026-10-27). Everything the narrative says with a number comes from here:
each fact is computed from the committed build inputs and registered, with its source, in narrative_claims.json.
Inputs: wr1-7.json (MFL weeklyResults), st.json / st6.json (MFL leagueStandings, Weeks 7 and 6), lg_min.json, players.json,
ps1-7.json, injury_wk08.json (the validated injury analysis), nflverse.json, sim6.json (the committed Week 6 forecast), and tables parsed
from the automated draft (docs/wire/auto/2026-wk07-ups-center)."""
import html as H, json, os, re, subprocess

D = os.path.dirname(os.path.abspath(__file__))
L = lambda n: json.load(open(os.path.join(D, n)))

OWN = {"0001": "Ryan Bousquet", "0002": "Derrick Whitman", "0003": "Matt Gerardi", "0004": "Brian Cutting",
       "0005": "Eric Martel", "0006": "Brian Cross", "0007": "Josh Martel", "0008": "Keith Creelman",
       "0009": "Bear Dunn", "0010": "Shawn Blake", "0011": "Eric Mannila", "0012": "Chris Klingenberg"}
TAG = {"0001": "bous", "0002": "whit", "0003": "gera", "0004": "cutt", "0005": "emar", "0006": "cros",
       "0007": "jmar", "0008": "keit", "0009": "bear", "0010": "blak", "0011": "mann", "0012": "klin"}
FID = {v: k for k, v in TAG.items()}
GRP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN", "DT": "DL", "DE": "DL",
       "LB": "LB", "CB": "DB", "S": "DB"}
IDPPOS = ("DT", "DE", "LB", "CB", "S")

wr = L("wr7.json")["weeklyResults"]
players = {p["id"]: p for p in L("players.json")["players"]["player"]}
st = {f["id"]: f for f in L("st.json")["leagueStandings"]["franchise"]}
st6 = {f["id"]: f for f in L("st6.json")["leagueStandings"]["franchise"]}
nm = lambda pid: players[pid]["name"]


def pretty(name):
    last, _, first = name.partition(", ")
    return (first + " " + last).strip()


# ---- week 7 lineups ----
team, games = {}, []
for m in wr["matchup"]:
    a, b = m["franchise"]
    games.append((a["id"], b["id"]))
    for f in (a, b):
        if f["id"] not in team:
            team[f["id"]] = {"score": float(f["score"]), "opt": float(f["opt_pts"]),
                             "pl": {p["id"]: {"s": float(p.get("score") or 0), "st": p["status"], "should": p.get("shouldStart") == "1"}
                                    for p in f["player"]}}
assert len(team) == 12 and len(games) == 18


def best(pool):
    """Best legal lineup from {pid: points}: fill each position's minimum, then the best remaining flex-eligible
    players under the maximums (equal-weight slots)."""
    by = {}
    for p in pool:
        by.setdefault(GRP.get(players[p]["position"]), []).append(p)
    for k in by:
        by[k].sort(key=lambda x: -pool[x])
    chosen = set()
    for mins, n in (({"QB": 1, "RB": 2, "WR": 2, "TE": 1}, 9), ({"DL": 2, "LB": 2, "DB": 2}, 7)):
        maxs = {"QB": 2, "RB": 5, "WR": 5, "TE": 4, "DL": 3, "LB": 3, "DB": 3}
        take = [p for k, m in mins.items() for p in by.get(k, [])[:m]]
        rest = sorted([p for k, m in mins.items() for p in by.get(k, [])[m:maxs[k]]], key=lambda x: -pool[x])
        take += rest[:n - len(take)]
        chosen |= set(take)
    for k in ("PK", "PN"):
        if by.get(k):
            chosen.add(by[k][0])
    return round(sum(pool[p] for p in chosen), 1), chosen


for f, t in team.items():
    t["best"], t["chosen"] = best({p: v["s"] for p, v in t["pl"].items()})
    assert abs(t["best"] - t["opt"]) < 0.051, (f, t["best"], t["opt"])        # solver reproduces MFL's own optimal lineup

wins = {f: 0 for f in team}
res = []
for a, b in games:
    w, l = (a, b) if team[a]["score"] > team[b]["score"] else (b, a)
    wins[w] += 1
    res.append((w, l, round(team[w]["score"] - team[l]["score"], 1)))
order = sorted(team, key=lambda f: -team[f]["score"])
rank7 = {f: i + 1 for i, f in enumerate(order)}
ap7 = {f: sum(1 for g in team if g != f and team[g]["score"] < team[f]["score"]) for f in team}
flips = [(w, l) for a, b in games for (w, l) in ((a, b), (b, a)) if team[w]["score"] < team[l]["score"] and team[w]["best"] > team[l]["score"]]


class Facts(dict):
    def __init__(s):
        super().__init__()
        s.claims, s.used = {}, set()

    def add(s, key, shown, source, value=None):
        assert key not in s, key
        s[key] = shown
        s.claims["nar:" + key] = {"shown": shown, "source": source, "value": shown if value is None else value}
        return shown

    def __getitem__(s, k):
        s.used.add(k)
        return super().__getitem__(k)


F = Facts()
f1 = lambda x: "%.1f" % x
MFLW7 = "MFL weeklyResults W7 (committed: wr7.json)"
MFLST = "MFL leagueStandings (committed: st.json)"
OPT = "MFL weeklyResults W7 optimal lineup (reproduced by the legal-lineup solver in rewrite_facts.py)"
for f, t in team.items():
    g = TAG[f]
    F.add("sc_" + g, f1(t["score"]), MFLW7)
    F.add("opt_" + g, f1(t["opt"]), OPT)
    F.add("left_" + g, f1(t["opt"] - t["score"]), OPT)
    s = st[f]
    F.add("rec_" + g, "%s–%s" % (s["h2hw"], s["h2hl"]), MFLST)
    F.add("rec6_" + g, "%s–%s" % (st6[f]["h2hw"], st6[f]["h2hl"]), "MFL leagueStandings after Week 6 (committed: st6.json)")
    w, l, _ = s["all_play_wlt"].split("-")
    F.add("ap_" + g, "%s–%s" % (w, l), MFLST)
    F.add("pf_" + g, "{:,.1f}".format(float(s["pf"])), MFLST)
    F.add("ap7_" + g, "%d–%d" % (ap7[f], 11 - ap7[f]), MFLW7 + " (each score against the other eleven)")
    F.add("wins7_" + g, str(wins[f]), MFLW7)
    F.add("loss7_" + g, str(3 - wins[f]), MFLW7)
margin = {}
for w, l, m in res:
    margin[(TAG[w], TAG[l])] = m
    F.add("m_%s_%s" % (TAG[w], TAG[l]), f1(m), MFLW7)

# ---- season weeks 1-7, MFL weeklyResults; must reproduce MFL's own standings ----
SW = L("season_weeks.json")
WSRC = "MFL weeklyResults Weeks 1-7 (committed: season_weeks.json); reconciled to MFL standings (all-play, points for, head-to-head)"
wsc, wgm = {}, {}
for r in SW["scores"]:
    wsc.setdefault(r["franchise_id"], {})[r["week"]] = r["team_score"]
for g in SW["games"]:
    wgm.setdefault((g["franchise_id"], g["week"]), []).append(g["result"])
for f in wsc:
    assert sorted(wsc[f]) == [1, 2, 3, 4, 5, 6, 7]
    assert abs(sum(wsc[f].values()) - float(st[f]["pf"])) < 0.06, f
    assert str(sum(wgm[(f, w)].count("W") for w in range(1, 8))) == st[f]["h2hw"], f
    assert str(sum(1 for w in range(1, 8) for g in wsc if g != f and wsc[g][w] < wsc[f][w])) == st[f]["all_play_wlt"].split("-")[0], f
assert all(wsc[f][7] == team[f]["score"] for f in team)


def wap(f, w):
    return (sum(1 for g in wsc if g != f and wsc[g][w] < wsc[f][w]), sum(1 for g in wsc if g != f and wsc[g][w] > wsc[f][w]))


def wrank(f, w):
    return 1 + sum(1 for g in wsc if wsc[g][w] > wsc[f][w])


ORD = {1: "1st", 2: "2nd", 3: "3rd"}
ordn = lambda n: ORD.get(n, "%dth" % n)
BEAR = "0009"
for w in range(1, 8):
    a = wap(BEAR, w)
    F.add("bw%d_sc" % w, f1(wsc[BEAR][w]), WSRC)
    F.add("bw%d_rk" % w, ordn(wrank(BEAR, w)), WSRC)
    F.add("bw%d_ap" % w, "%d–%d" % a, WSRC)
    F.add("bw%d_h2h" % w, "%d–%d" % (wgm[(BEAR, w)].count("W"), wgm[(BEAR, w)].count("L")), WSRC)
avg = {f: sum(v.values()) / 7 for f, v in wsc.items()}
second = sorted(avg, key=avg.get)[-2]
F.add("bear_avg", f1(avg[BEAR]), WSRC + ": points for / 7")
F.add("second_avg", f1(avg[second]), WSRC + ": points for / 7, second best team")
F.add("bear_avg_gap", f1(round(avg[BEAR], 1) - round(avg[second], 1)), "derived: Bear's Weeks 1-7 average minus the next best")
F.add("bear_w27", "%d–%d" % tuple(map(sum, zip(*[wap(BEAR, w) for w in range(2, 8)]))), WSRC + ": Weeks 2-7 all-play")
F.add("bear_w57", "%d–%d" % tuple(map(sum, zip(*[wap(BEAR, w) for w in range(5, 8)]))), WSRC + ": Weeks 5-7 all-play (the Heat Check window)")
F.add("bear_w37", "%d–%d" % tuple(map(sum, zip(*[wap(BEAR, w) for w in range(3, 8)]))), WSRC + ": Weeks 3-7 all-play")
assert [wrank(BEAR, w) for w in range(1, 8)] == [9, 2, 1, 2, 1, 1, 1]
assert [wap(BEAR, w) for w in (5, 6, 7)] == [(11, 0)] * 3
F.add("top_run", "three", "derived: Bear led the league in scoring in Weeks 5, 6 and 7")

# ---- tables in the draft: odds, Heat Check, Survival ----
SRC_ART = subprocess.check_output(["git", "show", "04c043b2:site/wire/articles/2026/2026-wk07-ups-center.html"], cwd=D).decode()


def sec(html, sid):
    """The whole <section id=sid>...</section>, balanced."""
    start = re.search(r'<section class="wire-sec" id="%s"' % sid, html).start()
    depth = 0
    for m in re.finditer(r"<(/?)section\b", html[start:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return html[start:start + m.end() + html[start + m.end():].index(">") + 1]
    raise AssertionError(sid)


def rows(html):
    out = []
    for tr in re.findall(r"<tr>([\s\S]*?)</tr>", html):
        cells = [H.unescape(re.sub(r"<[^>]+>", " ", c)).strip() for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", tr)]
        out.append([re.sub(r"\s+", " ", c) for c in cells])
    return out


odds = {r[0]: r[1:] for r in rows(sec(SRC_ART, "odds"))[1:]}
heat = sec(SRC_ART, "heat")
tabs = re.findall(r"<table>[\s\S]*?</table>", heat)
h1 = {" ".join(r[0].split(" ")[:2]) if r[0].split(" ")[0] != "Chris" else "Chris Klingenberg": r for r in rows(tabs[0])[1:]}
h2 = {r[0]: r[1:] for r in rows(tabs[1])[1:]}
ODS = "Playoff Picture table = committed forecast (docs/wire/auto/2026-wk07-ups-center, 10,000 seasons through Week 7)"
sim7 = L("../../../../site/wire/data/season_sim_2026_live_wk07.json") if False else None
for f in team:
    o = odds[OWN[f]]
    for i, k in enumerate(("po", "bye", "div", "title")):
        F.add("%s_%s" % (k, TAG[f]), o[i], ODS)
    F.add("wve_" + TAG[f], h2[OWN[f]][2], "Heat Check table: head-to-head wins minus the wins each week's all-play rate predicts")
    F.add("bench_" + TAG[f], h2[OWN[f]][0], "Heat Check table: best possible lineup minus lineup started, per week, season")
    F.add("blw_" + TAG[f], h2[OWN[f]][1], "Heat Check table: losses the best lineup would have won, of all losses")
F.add("sims", "10,000", ODS)
SRC6 = subprocess.check_output(["git", "show", "origin/main:site/wire/articles/2026/2026-wk06-ups-center.html"], cwd=D).decode()
odds6 = {r[0]: r[1:] for r in rows(sec(SRC6, "odds"))[1:]}
W6SRC = "Playoff Picture table as published in the Week 6 UPS Center"
for f in team:
    o6 = odds6[OWN[f]]
    for i, k in enumerate(("po", "bye", "div", "title")):
        F.add("%s6_%s" % (k, TAG[f]), o6[i], W6SRC)
inj = L("injury_wk08.json")
ISRC = "injury_wk08.json: MFL playerScores W1-7 (league 74598 scoring), MFL injury feed (updated %s), nflverse" % inj["sources"]["mflInjuryFeedUpdated"]
for f in team:
    F.add("hl_" + TAG[f], f1(inj["healthyLineups"][f]["ppg"]), ISRC)
    F.add("hlrk_" + TAG[f], ordn(inj["healthyLineups"][f]["rank"]), ISRC)

# ---- player-level facts (Week 7) ----
def pid_of(fid, last):
    hits = [p for p in team[fid]["pl"] if players[p]["name"].startswith(last)]
    assert len(hits) == 1, (fid, last, hits)
    return hits[0]


def pts(fid, last, key):
    p = pid_of(fid, last)
    F.add(key, f1(team[fid]["pl"][p]["s"]), MFLW7)
    return p


MINS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "DL": 2, "LB": 2, "DB": 2, "PK": 1, "PN": 1}
MAXS = {"QB": 2, "RB": 5, "WR": 5, "TE": 4, "DL": 3, "LB": 3, "DB": 3, "PK": 1, "PN": 1}


def legal(ids):
    c = {}
    for p in ids:
        g = GRP.get(players[p]["position"]); c[g] = c.get(g, 0) + 1
    off = sum(c.get(k, 0) for k in ("QB", "RB", "WR", "TE")); idp = sum(c.get(k, 0) for k in ("DL", "LB", "DB"))
    return off == 9 and idp == 7 and all(MINS[k] <= c.get(k, 0) <= MAXS[k] for k in MINS)


def starters(f):
    return [p for p, v in team[f]["pl"].items() if v["st"] == "starter"]


def swap(fid, out_pid, in_pid):
    """The started lineup with one starter replaced by one bench player (Week 7 points, hindsight); must be legal."""
    t = team[fid]
    s = starters(fid)
    assert out_pid in s and in_pid not in s and legal(s)
    new = [p for p in s if p != out_pid] + [in_pid]
    assert legal(new), (fid, nm(out_pid), nm(in_pid))
    return round(t["score"] - t["pl"][out_pid]["s"] + t["pl"][in_pid]["s"], 1)


def opp(fid):
    return [b if a == fid else a for a, b in games if fid in (a, b)]


P = {}
# Whitman: Pollard (38.3) sat; Aaron Jones (3.6) and Nico Collins (2.6) started
P["pol"] = pts("0002", "Pollard", "pollard")
P["ajo"] = pts("0002", "Jones, Aaron", "ajones")
P["ocoo"] = pts("0002", "Cooper Jr., Omar", "ocooper")
P["col"] = pts("0002", "Collins, Nico", "ncollins")
P["wil"] = pts("0002", "Wilson, Garrett", "gwilson")
P["love"] = pts("0002", "Love, Jordan", "love")
P["shou"] = pts("0002", "Shough", "shough")
P["tuck"] = pts("0002", "Tucker, Tre", "tucker")
w_pol = swap("0002", P["ajo"], P["pol"])
w_both = round(team["0002"]["score"] - team["0002"]["pl"][P["ajo"]]["s"] - team["0002"]["pl"][P["col"]]["s"] + team["0002"]["pl"][P["pol"]]["s"] + team["0002"]["pl"][P["ocoo"]]["s"], 1)
assert legal([p for p in starters("0002") if p not in (P["ajo"], P["col"])] + [P["pol"], P["ocoo"]])
F.add("whit_pol", f1(w_pol), "derived: Whitman's started lineup, Aaron Jones replaced by Tony Pollard (Week 7 points, hindsight)")
F.add("whit_pol_klin", f1(w_pol - team["0012"]["score"]), "derived: that lineup minus Klingenberg's Week 7 score")
assert w_pol > team["0012"]["score"] and w_pol > team["0011"]["score"] and w_pol < team["0009"]["score"]
F.add("whit_both", f1(w_both), "derived: Pollard for Jones and Omar Cooper Jr. for Nico Collins (Week 7 points, hindsight)")
assert w_both < team["0009"]["score"]
F.add("whit_pol_bear", f1(team["0009"]["score"] - w_both), "derived: Bear's Week 7 score minus that lineup")
F.add("whit_bench_two", f1(team["0002"]["pl"][P["pol"]]["s"] + team["0002"]["pl"][P["ocoo"]]["s"]), "derived: Pollard + Omar Cooper Jr., Week 7")
F.add("whit_started_two", f1(team["0002"]["pl"][P["ajo"]]["s"] + team["0002"]["pl"][P["col"]]["s"]), "derived: Aaron Jones + Nico Collins, Week 7")
F.add("whit_loss_klin", f1(margin[("klin", "whit")]), MFLW7)

# Gerardi: Willis (33.6) sat; Mahomes 7.6 and Young 2.6 started; Graham 0.0
P["wls"] = pts("0003", "Willis", "willis")
P["mah"] = pts("0003", "Mahomes", "mahomes")
P["yng"] = pts("0003", "Young, Bryce", "byoung")
P["gra"] = pts("0003", "Graham, Mason", "graham")
P["stb"] = pts("0003", "St. Brown", "stbrown")
g_w = swap("0003", P["yng"], P["wls"])
F.add("gera_willis_lu", f1(g_w), "derived: Gerardi's started lineup, Bryce Young replaced by Malik Willis (Week 7 points, hindsight)")
assert g_w > team["0011"]["score"] and g_w < team["0012"]["score"] and g_w < team["0009"]["score"]
F.add("gera_willis_mann", f1(g_w - team["0011"]["score"]), "derived: that lineup minus Mannila's Week 7 score")
F.add("gera_qb_pair", f1(team["0003"]["pl"][P["mah"]]["s"] + team["0003"]["pl"][P["yng"]]["s"]), "derived: Mahomes + Young, Week 7")
F.add("gera_loss_mann", f1(margin[("mann", "gera")]), MFLW7)
# Mason Graham: started Week 4 (0.0), benched Weeks 5 and 6, started again Week 7 (0.0); no NFL game since Week 3
_nv = json.load(open(os.path.join(D, "nflverse.json")))
assert _nv["played"]["17121"] == [1, 2, 3]
GR = {}
for w in range(4, 8):
    for m in json.load(open(os.path.join(D, "wr%d.json" % w)))["weeklyResults"]["matchup"]:
        for fr in m["franchise"]:
            for q in fr["player"]:
                if q["id"] == "17121":
                    GR[w] = (fr["id"], q["status"], q.get("score"))
assert GR[4][1] == "starter" and GR[5][1] == "nonstarter" and GR[6][1] == "nonstarter" and GR[7][1] == "starter" and all(v[0] == "0003" for v in GR.values())
assert GR[4][2] == "0.0" and GR[7][2] == "0.0"

# Blake: lost to Mannila by 0.8; each of these bench players alone would have won it
P["dow"] = pts("0010", "Dowdle", "dowdle")
P["bar"] = pts("0010", "Barner", "barner")
P["byo"] = pts("0010", "Young, Byron", "byoung_de")
P["hen"] = pts("0010", "Henry, Derrick", "dhenry")
P["bos"] = pts("0010", "Boston", "boston")
P["and"] = pts("0010", "Anderson, Will", "wanderson")
P["jud"] = pts("0010", "Judkins", "judkins")
P["cor"] = pts("0010", "Corum", "corum")
P["vel"] = pts("0010", "Vele", "vele")
P["hun"] = pts("0010", "Huntley", "huntley")
bl = {}
for key, (o, i) in {"dow": ("hen", "dow"), "bar": ("bos", "bar"), "byo": ("and", "byo")}.items():
    bl[key] = swap("0010", P[o], P[i])
    assert bl[key] > team["0011"]["score"], key
    F.add("blake_%s_lu" % key, f1(bl[key]), "derived: Blake's started lineup with one bench player in (Week 7 points, hindsight)")
    F.add("blake_%s_gain" % key, f1(team["0010"]["pl"][P[i]]["s"] - team["0010"]["pl"][P[o]]["s"]), "derived: bench player minus the starter he replaces")
assert all(bl[k] < team["0012"]["score"] for k in bl)           # none of the three beats Klingenberg
F.add("blake_loss_mann", f1(margin[("mann", "blak")]), MFLW7)
idp = {f: sum(v["s"] for p, v in t["pl"].items() if v["st"] == "starter" and players[p]["position"] in IDPPOS) for f, t in team.items()}
idp_rank = {f: 1 + sum(1 for g in idp if idp[g] > idp[f]) for f in team}
F.add("blake_idp", f1(idp["0010"]), MFLW7 + ": seven IDP starters")
F.add("blake_idp_rk", ordn(idp_rank["0010"]), MFLW7 + ": IDP starters' points, rank among 12 teams")
F.add("mann_idp", f1(idp["0011"]), MFLW7 + ": seven IDP starters")
F.add("mann_idp_rk", ordn(idp_rank["0011"]), MFLW7)
assert idp_rank["0010"] == 10 and idp_rank["0011"] == 12
F.add("blake_wk6", f1(wsc["0010"][6]), WSRC)
F.add("blake_wk6_rk", ordn(wrank("0010", 6)), WSRC)
F.add("blake_wk7_rk", ordn(wrank("0010", 7)), WSRC)
assert st6["0010"]["h2hw"] == "9" and st["0010"]["h2hw"] == "9" and st["0010"]["h2hl"] == "10"
F.add("blake_six", "0–6", "derived: Blake went 0–3 in Week 6 and 0–3 in Week 7 (MFL weeklyResults, committed)")
assert wgm[("0010", 6)].count("W") == 0 and wgm[("0010", 7)].count("W") == 0

# Martel: best lineup (312.9) would have beaten Bear's 277.0
P["gsm"] = pts("0005", "Smith, Geno", "genosmith")
P["mta"] = pts("0005", "Taylor, Mason", "mtaylor")
P["mcb"] = pts("0005", "McBride", "mcbride")
P["pen"] = pts("0005", "Penix", "penix")
F.add("emar_miss_bear", f1(team["0005"]["opt"] - team["0009"]["score"]), "derived: Martel's best lineup minus Bear's Week 7 score")
assert team["0005"]["opt"] > team["0009"]["score"]
F.add("emar_bench_two", f1(team["0005"]["pl"][P["gsm"]]["s"] + team["0005"]["pl"][P["mta"]]["s"]), "derived: Geno Smith + Mason Taylor, Week 7")
assert max(team, key=lambda f: team[f]["opt"] - team[f]["score"]) == "0002"
assert sorted(team, key=lambda f: -(team[f]["opt"] - team[f]["score"]))[1] == "0005"

# Cutting
P["iri"] = pts("0004", "Irving", "irving")
P["wat"] = pts("0004", "Watson", "watson")
P["may"] = pts("0004", "Maye", "maye")
P["flo"] = pts("0004", "Flowers", "flowers")
F.add("cutt_bench_two", f1(team["0004"]["pl"][P["iri"]]["s"] + team["0004"]["pl"][P["wat"]]["s"]), "derived: Bucky Irving + Deshaun Watson, Week 7")

# Cross: Week 6 -> Week 7
P["ward"] = pts("0006", "Ward", "ward")
P["otton"] = pts("0006", "Otton", "otton")
P["helm"] = pts("0006", "Helm", "helm")
P["gor"] = pts("0006", "Gordon", "gordon")
F.add("cros_w6", f1(wsc["0006"][6]), WSRC + " (Elias-final Week 6)")
F.add("cros_w6_rk", ordn(wrank("0006", 6)), WSRC)
F.add("cros_drop", f1(wsc["0006"][6] - wsc["0006"][7]), "derived: Week 6 score minus Week 7 score")
F.add("cros_wk7_est", "171.8", "Week 6 UPS Center as published: Cross's Week 7 lineup if Warren sits, from 2026 points per game")
F.add("cros_wk7_est_gap", f1(171.8 - team["0006"]["score"]), "derived: published estimate minus Week 7 score")
assert rank7["0006"] == 12 and team["0006"]["opt"] < min(team[f]["score"] for f in team if f != "0006") + 40
F.add("cros_w6_law", "39.7", "Week 6 UPS Center as published (Elias-final points unchanged for Lawrence)")

# Keith / chat receipts
kr = [wrank("0008", w) for w in range(1, 8)]
F.add("keit_top6", str(sum(1 for r in kr if r <= 6)), WSRC + ": Weeks in which Keith's score ranked in the top six")
assert kr == [4, 7, 5, 10, 2, 11, 6]
F.add("keit_rk7", ordn(kr[6]), WSRC)

# Bousquet
P["nix"] = pts("0001", "Nix", "nix")
P["fer"] = pts("0001", "Ferguson", "ferguson")
P["wal"] = pts("0001", "Waller", "waller")
# Burrow etc. (Boomer)
P["bur"] = pts("0009", "Burrow", "burrow")
P["jsn"] = pts("0009", "Smith-Njigba", "jsn")
P["hig"] = pts("0009", "Higgins", "higgins")
P["mye"] = pts("0004", "Maye", "maye2") if False else None
P["pru"] = pts("0008", "Prescott", "prescott")
P["con"] = pts("0008", "Concepcion", "concepcion")
P["gordon_unused"] = None
P["cou"] = pts("0011", "Cousins", "cousins")
P["lov"] = pts("0011", "Loveland", "loveland")
P["whk"] = pts("0011", "White, Keion", "kwhite")
P["fle"] = pts("0004", "Flowers", "flowers2") if False else None
print("facts ok; flips:", [(OWN[w], OWN[l]) for w, l in flips])
