"""Facts for the Week 6 editorial rewrite. Everything the narrative says with a number comes from here:
each fact is computed from the committed build inputs and registered, with its source, in narrative_claims.json.
Inputs: wr6.json (MFL weeklyResults W6), st.json (MFL leagueStandings), lg_min.json, players.json, ps1-6.json,
injury_wk07.json / injury_claims.json (the validated injury analysis), cf_sim.json, and tables parsed from the draft."""
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

wr = L("wr6.json")["weeklyResults"]
players = {p["id"]: p for p in L("players.json")["players"]["player"]}
st = {f["id"]: f for f in L("st.json")["leagueStandings"]["franchise"]}
nm = lambda pid: players[pid]["name"]


def pretty(name):                       # "Walker III, Kenneth" -> "Kenneth Walker III"
    last, _, first = name.partition(", ")
    return (first + " " + last).strip()


# ---- week 6 lineups ----
team = {}
games = []
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
    """Best legal lineup from {pid: points}: fill each position's minimum, then the best remaining
    flex-eligible players under the maximums. Same rule as verify_injuries.py (equal-weight slots)."""
    by = {}
    for p in pool:
        by.setdefault(GRP.get(players[p]["position"]), []).append(p)
    for k in by:
        by[k].sort(key=lambda x: -pool[x])
    tot, chosen = 0.0, set()
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
    pool = {p: v["s"] for p, v in t["pl"].items()}
    t["best"], t["chosen"] = best(pool)
    assert abs(t["best"] - t["opt"]) < 0.051, (f, t["best"], t["opt"])        # solver reproduces MFL's own optimal lineup


def without(f, pid):
    return best({p: v["s"] for p, v in team[f]["pl"].items() if p != pid})[0]


wins = {f: 0 for f in team}
res = []
for a, b in games:
    w, l = (a, b) if team[a]["score"] > team[b]["score"] else (b, a)
    wins[w] += 1
    res.append((w, l, round(team[w]["score"] - team[l]["score"], 1)))
order = sorted(team, key=lambda f: -team[f]["score"])
rank6 = {f: i + 1 for i, f in enumerate(order)}
ap6 = {f: sum(1 for g in team if g != f and team[g]["score"] < team[f]["score"]) for f in team}
flips = [(w, l) for a, b in games for (w, l) in ((a, b), (b, a)) if team[w]["score"] < team[l]["score"] and team[w]["best"] > team[l]["score"]]


# ---- the registry: a fact is only a claim once it has a source ----
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
MFLW6 = "MFL weeklyResults W6 (committed: wr6.json)"
MFLST = "MFL leagueStandings (committed: st.json)"
OPT = "MFL weeklyResults W6 optimal lineup (reproduced by the legal-lineup solver in rewrite_facts.py)"
for f, t in team.items():
    g = TAG[f]
    F.add("sc_" + g, f1(t["score"]), MFLW6)
    F.add("opt_" + g, f1(t["opt"]), OPT)
    F.add("left_" + g, f1(t["opt"] - t["score"]), OPT)
    s = st[f]
    F.add("rec_" + g, "%s–%s" % (s["h2hw"], s["h2hl"]), MFLST)
    w, l, _ = s["all_play_wlt"].split("-")
    F.add("ap_" + g, "%s–%s" % (w, l), MFLST)
    F.add("pf_" + g, "{:,.1f}".format(float(s["pf"])), MFLST)
    F.add("ap6_" + g, "%d–%d" % (ap6[f], 11 - ap6[f]), MFLW6 + " (each score against the other eleven)")
    F.add("wins6_" + g, str(wins[f]), MFLW6)
margin = {}
for w, l, m in res:
    margin[(TAG[w], TAG[l])] = m
    F.add("m_%s_%s" % (TAG[w], TAG[l]), f1(m), MFLW6)
r97 = [f for f in st if (st[f]["h2hw"], st[f]["h2hl"]) == ("9", "7")]
assert sorted(OWN[f] for f in r97) == ["Chris Klingenberg", "Eric Mannila", "Keith Creelman", "Shawn Blake"]
F.add("r97", "9–7", MFLST)
F.add("rec_leader10", "10–6", MFLST)
assert (st["0002"]["h2hw"], st["0002"]["h2hl"]) == ("10", "6") and (st["0004"]["h2hw"], st["0004"]["h2hl"]) == ("8", "8")
F.add("r88", "8–8", MFLST)
F.add("hi6", "10–6", MFLST)

# ---- tables in the draft: odds, Heat Check ----
SRC_ART = subprocess.check_output(["git", "show", "f4bc54fa:site/wire/articles/2026/2026-wk06-ups-center.html"], cwd=D).decode()


def sec(html, sid):
    """The whole <section id=sid>...</section>, balanced (the Division desk nests <section> elements)."""
    start = re.search(r'<section class="wire-sec" id="%s"' % sid, html).start()
    depth, pos = 0, start
    for m in re.finditer(r"<(/?)section\b", html[start:]):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return html[start:start + m.end() + len(">") + html[start + m.end():].index(">")]
    raise AssertionError(sid)


def rows(html):
    out = []
    for tr in re.findall(r"<tr>([\s\S]*?)</tr>", html):
        cells = [H.unescape(re.sub(r"<[^>]+>", " ", c)).strip() for c in re.findall(r"<t[dh][^>]*>([\s\S]*?)</t[dh]>", tr)]
        out.append([re.sub(r"\s+", " ", c) for c in cells])
    return out


odds = {r[0].split("  ")[-1] if False else r[0]: r[1:] for r in rows(sec(SRC_ART, "odds"))[1:]}
heat = sec(SRC_ART, "heat")
tabs = re.findall(r"<table>[\s\S]*?</table>", heat)
h1 = {r[0].split(" ")[0] + " " + r[0].split(" ")[1]: r[1:] for r in rows(tabs[0])[1:]}
h2 = {r[0]: r[1:] for r in rows(tabs[1])[1:]}
ODS = "Playoff Picture table = committed forecast (docs/wire/auto/2026-wk06-ups-center, 10,000 seasons through Week 6)"
for f in team:
    o = odds[OWN[f]]
    for i, k in enumerate(("po", "bye", "div", "title")):
        F.add("%s_%s" % (k, TAG[f]), o[i], ODS)
    F.add("wve_" + TAG[f], h2[OWN[f]][2].replace("−", "−"), "Heat Check table: head-to-head wins minus the wins each week's all-play rate predicts")
    F.add("bench_" + TAG[f], h2[OWN[f]][0], "Heat Check table: best possible lineup minus lineup started, per week, season")
    F.add("blw_" + TAG[f], h2[OWN[f]][1], "Heat Check table: losses the best lineup would have won, of all losses")
    F.add("hc_" + TAG[f], h1[OWN[f]][0].split(" ")[0], "Heat Check table: All-Play, Weeks 4–6")
F.add("sims", "10,000", ODS)

# ---- the injury analysis ----
inj = L("injury_wk07.json")
icl = L("injury_claims.json")
ISRC = "injury_wk07.json: MFL playerScores W1-6 (league 74598 scoring), MFL injury feed Wed Oct 21 8:01 AM ET, nflverse"
case = {c["player"]: c for c in inj["cases"]}
for pl_, tg in (("Lamar Jackson", "lj"), ("Edgerrin Cooper", "ec"), ("Mike Evans", "me"), ("Travis Etienne", "te"),
                ("Jaxson Dart", "jd"), ("Tyler Warren", "tw"), ("Mason Graham", "mg"), ("Jalen Hurts", "jh")):
    c = case[pl_]
    F.add(tg + "_ppg", f1(c["ppg"]), ISRC)
    F.add(tg + "_drop", f1(c["lineupDrop"]), ISRC)
    F.add(tg + "_lu1", f1(c["lineupHealthy"]), ISRC)
    F.add(tg + "_lu2", f1(c["lineupWithout"]), ISRC)
    F.add(tg + "_rep", f1(c["replacement"]["ppg"]), ISRC)
    if c["bestFreeAgent"]:
        F.add(tg + "_fa", f1(c["bestFreeAgent"]["ppg"]), ISRC)
        F.add(tg + "_fabeat", f1(c["bestFreeAgent"]["beatsReplacementBy"]), ISRC)
mc = {c["pid"]: c for c in inj["blake"]["candidates"]}["14109"]
F.add("mc_ppg", f1(mc["ppg"]), ISRC)
F.add("mc_rkp", str(mc["rankPPG"]), ISRC)
F.add("blake_lu", icl["inj:blake:lu"]["shown"], ISRC)
F.add("blake_wk7", icl["inj:blake:wk7"]["shown"], ISRC)
F.add("blake_wk7gap", icl["inj:blake:wk7gap"]["shown"], ISRC)
F.add("blake_cfpo", icl["inj:blake:cfpo"]["shown"], "cf_sim.json: same simulation, inputs and seed, McLaurin listed healthy")
F.add("blake_po_gap", f1(round(float(icl["inj:blake:cfpo"]["shown"].rstrip("%")) - float(odds["Shawn Blake"][0].rstrip("%")), 1)),
      "cf_sim.json minus the Playoff Picture")
F.add("smith_ppg", f1({c["pid"]: c for c in inj["blake"]["candidates"]}["15282"]["ppg"]), ISRC)

# ---- player-level facts (Week 6) ----
def pid_of(fid, last):
    hits = [p for p in team[fid]["pl"] if players[p]["name"].startswith(last)]
    assert len(hits) == 1, (fid, last, hits)
    return hits[0]


def pts(fid, last, key):
    p = pid_of(fid, last)
    F.add(key, f1(team[fid]["pl"][p]["s"]), MFLW6)
    return p


P = {}
P["law"] = pts("0006", "Lawrence, Trevor", "law")
P["ber"] = pts("0006", "Bernard, Germie", "ber")
P["sho"] = pts("0002", "Shough, Tyler", "sho")
P["nab"] = pts("0011", "Nabers, Malik", "nab")
P["lam"] = pts("0011", "Lamb, CeeDee", "lam")
P["bij"] = pts("0011", "Robinson, Bijan", "bij")
P["str"] = pts("0005", "Stroud, C.J.", "stroud")
P["wal"] = pts("0005", "Walker III, Kenneth", "walker")
P["pen"] = pts("0005", "Penix", "penix")
P["mcc"] = pts("0009", "McCaffrey", "mcc")
P["jsn"] = pts("0009", "Smith-Njigba", "jsn")
P["may"] = pts("0004", "Maye, Drake", "maye")
P["dsm"] = pts("0010", "Smith, DeVonta", "dsmith")
P["sha"] = pts("0010", "Shaheed", "shaheed")
P["mcl"] = pts("0010", "McLaurin", "mclaurin_w6")
P["bos"] = pts("0010", "Boston", "boston")
P["jac"] = pts("0010", "Jackson, D'Marco", "djack")
P["mye"] = pts("0008", "Mayer", "mayer")
P["oko"] = pts("0008", "Okonkwo", "okonkwo")
P["dig"] = pts("0008", "Diggs", "diggs")
P["nac"] = pts("0008", "Nacua", "nacua")
P["kal"] = pts("0005", "Allen, Keenan", "kallen")
P["mta"] = pts("0005", "Taylor, Mason", "mtaylor")
P["jjo"] = pts("0005", "Johnson, Juwan", "jjohnson")
P["mck"] = pts("0005", "McConkey", "mcconkey")
P["coo"] = pts("0002", "Cooper Jr., Omar", "ocooper")
P["naj"] = pts("0001", "Harris, Najee", "najee")
P["wll"] = pts("0001", "Waller", "waller")
P["lloy"] = pts("0007", "Lloyd, MarShawn", "lloyd")
P["bth"] = pts("0007", "Thomas Jr., Brian", "bthomas")
P["gol"] = pts("0003", "Golden", "golden")
P["ska"] = pts("0003", "Skattebo", "skattebo")
P["dmo"] = pts("0003", "Moore, D.J.", "djmoore")
for a, b in (("law", "ber"),):
    pass
F.add("bear_swept_tot", f1(team["0009"]["score"]), MFLW6)

# "what if he is not there": the lineup that was actually started, with that player replaced by the best
# LEGAL bench option (Week 6 points, hindsight). Not a re-optimized lineup.
MINS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "DL": 2, "LB": 2, "DB": 2, "PK": 1, "PN": 1}
MAXS = {"QB": 2, "RB": 5, "WR": 5, "TE": 4, "DL": 3, "LB": 3, "DB": 3, "PK": 1, "PN": 1}


def legal(ids):
    c = {}
    for p in ids:
        g = GRP.get(players[p]["position"]); c[g] = c.get(g, 0) + 1
    off = sum(c.get(k, 0) for k in ("QB", "RB", "WR", "TE")); idp = sum(c.get(k, 0) for k in ("DL", "LB", "DB"))
    return off == 9 and idp == 7 and all(MINS[k] <= c.get(k, 0) <= MAXS[k] for k in MINS)


def swap_out(fid, pid):
    t = team[fid]
    start = [p for p, v in t["pl"].items() if v["st"] == "starter"]
    assert pid in start and legal(start)
    rest = [p for p in start if p != pid]
    cands = [(t["pl"][b]["s"], b) for b, v in t["pl"].items() if v["st"] != "starter" and legal(rest + [b])]
    gain, b = max(cands)
    return round(t["score"] - t["pl"][pid]["s"] + gain, 1), b


nol, nol_b = swap_out("0006", P["law"]); F.add("cros_nolaw", f1(nol), "derived: Cross's started lineup, Lawrence replaced by the best legal bench option (hindsight)")
nos, nos_b = swap_out("0002", P["sho"]); F.add("whit_nosho", f1(nos), "derived: Whitman's started lineup, Shough replaced by the best legal bench option (hindsight)")
non, non_b = swap_out("0011", P["nab"]); F.add("mann_nonab", f1(non), "derived: Mannila's started lineup, Nabers replaced by the best legal bench option (hindsight)")
print("replacements:", pretty(nm(nol_b)), pretty(nm(nos_b)), pretty(nm(non_b)))
c6, w6, m6, g6, b6 = (team[x]["score"] for x in ("0006", "0002", "0011", "0003", "0010"))
assert nol > team["0003"]["score"] and nol < team["0010"]["score"]               # Cross: still beats Gerardi, loses to Blake
F.add("cros_nolaw_gera", f1(nol - team["0003"]["score"]), "derived: Cross without Lawrence minus Gerardi's Week 6 score")
F.add("cros_nolaw_blak", f1(team["0010"]["score"] - nol), "derived: Blake's Week 6 score minus Cross without Lawrence")
F.add("cros_law_share", f1(100 * team["0006"]["pl"][P["law"]]["s"] / c6) + "%", "derived: Lawrence / Cross's Week 6 score")
F.add("cros_law_ber", f1(team["0006"]["pl"][P["law"]]["s"] + team["0006"]["pl"][P["ber"]]["s"]), "derived: Lawrence plus Bernard, Week 6")
assert nos - team["0005"]["score"] > 0 and all(nos > team[x]["score"] for x in ("0005", "0004", "0006"))   # sweep survives
F.add("whit_nosho_emar", f1(nos - team["0005"]["score"]), "derived: Whitman without Shough minus Eric Martel's Week 6 score")
assert all(non > team[x]["score"] for x in ("0007", "0001", "0008"))            # Mannila sweep survives
F.add("mann_nonab_min", f1(non - max(team[x]["score"] for x in ("0007", "0001", "0008"))), "derived: Mannila without Nabers minus the best of his three opponents")
F.add("emar_trio", f1(sum(team["0005"]["pl"][P[k]]["s"] for k in ("str", "wal", "pen"))), "derived: Stroud + Walker + Penix, Week 6")
F.add("bear_duo", f1(team["0009"]["pl"][P["mcc"]]["s"] + team["0009"]["pl"][P["jsn"]]["s"]), "derived: McCaffrey + Smith-Njigba, Week 6")
F.add("mann_stars", f1(team["0011"]["pl"][P["lam"]]["s"] + team["0011"]["pl"][P["bij"]]["s"]), "derived: Lamb + Robinson, Week 6")
# Blake: Smith + Shaheed in for Boston + McLaurin
sw = team["0010"]["pl"][P["dsm"]]["s"] + team["0010"]["pl"][P["sha"]]["s"] - team["0010"]["pl"][P["bos"]]["s"] - team["0010"]["pl"][P["mcl"]]["s"]
F.add("blak_swap_pair", f1(team["0010"]["pl"][P["dsm"]]["s"] + team["0010"]["pl"][P["sha"]]["s"]), "derived: Smith + Shaheed, Week 6")
F.add("blak_swap_gain", f1(sw), "derived: Smith + Shaheed minus Boston + McLaurin, Week 6")
assert team["0010"]["score"] + sw > team["0006"]["score"] and team["0010"]["score"] + sw < team["0004"]["score"]
F.add("blak_swap_tot", f1(team["0010"]["score"] + sw), "derived: Blake's Week 6 score with that swap")
# Martel: Allen + Taylor in for Johnson + McConkey
sw2 = sum(team["0005"]["pl"][P[k]]["s"] for k in ("kal", "mta")) - sum(team["0005"]["pl"][P[k]]["s"] for k in ("jjo", "mck"))
assert abs(team["0005"]["score"] + sw2 - team["0005"]["opt"]) < 0.051
F.add("emar_swap_gain", f1(sw2), "derived: Keenan Allen + Mason Taylor minus Juwan Johnson + Ladd McConkey, Week 6")
F.add("emar_miss", f1(team["0002"]["score"] - team["0005"]["opt"] + 2 * 0 if False else team["0005"]["opt"] - team["0002"]["score"]), "derived: Eric Martel's best lineup minus Whitman's Week 6 score")
F.add("whit_left", f1(team["0002"]["opt"] - team["0002"]["score"]), OPT)
F.add("josh_miss", f1(team["0011"]["score"] - team["0007"]["opt"]), "derived: Mannila's score minus Josh Martel's best lineup")
F.add("n_flips", str(len(flips)), "derived: games lost by a team whose best lineup beats the winner's actual score")
F.add("n_games", "18", MFLW6)
for tg, fid in (("kc", "0008"), ("bous", "0001"), ("jmar", "0007")):
    F.add("klin_opp_" + tg, f1(team[fid]["opt"]), OPT)
assert all(team[x]["opt"] > team["0012"]["score"] for x in ("0008", "0001", "0007"))
F.add("keit_trio", f1(sum(team["0008"]["pl"][P[k]]["s"] for k in ("mye", "oko", "dig"))), "derived: Mayer + Okonkwo + Diggs, Week 6")
# zero starters
zero = [(f, p) for f in team for p, v in team[f]["pl"].items() if v["st"] == "starter" and v["s"] <= 0.2]
F.add("n_zero", str(len(zero)), "derived: starters who scored 0.2 or less in Week 6")
print("zero starters:", [(OWN[f], players[p]["name"], team[f]["pl"][p]["s"]) for f, p in zero])

# ---- Week 5 (published, Elias-final) ----
W5 = subprocess.check_output(["git", "show", "origin/main:site/wire/articles/2026/2026-wk05-ups-center.html"], cwd=D).decode()
w5t = re.search(r"Every Week 5 result[\s\S]*?</table>", W5).group(0)
SHORT = {"K. Creelman": "0008", "B. Dunn": "0009", "B. Cutting": "0004", "S. Blake": "0010", "R. Bousquet": "0001", "E. Martel": "0005",
         "D. Whitman": "0002", "C. Klingenberg": "0012", "E. Mannila": "0011", "B. Cross": "0006", "M. Gerardi": "0003", "J. Martel": "0007"}
w5 = {}
for r in rows(w5t)[1:]:
    for cell in (r[0], r[1]):
        m = re.match(r"(.+?) ([\d.]+)$", cell)
        if m and m.group(1) in SHORT:
            w5.setdefault(SHORT[m.group(1)], float(m.group(2)))
assert len(w5) == 12, w5
drops = sorted(((w5[f] - team[f]["score"], f) for f in team), reverse=True)
W5SRC = "Week 5 UPS Center as published (Elias-final)"
F.add("keit_w5", f1(w5["0008"]), W5SRC)
F.add("bear_w5", f1(w5["0009"]), W5SRC)
F.add("keit_drop", f1(w5["0008"] - team["0008"]["score"]), "derived: Week 5 score minus Week 6 score")
print("biggest drops:", [(OWN[f], round(d, 1)) for d, f in drops[:3]])
F.add("keit_drop_rank_ok", "yes" if drops[0][1] == "0008" else "no", "derived")
F.add("bear_wk35", "32–1", "Week 5 UPS Center as published: 32–1 against the field over Weeks 3 to 5")
F.add("bear_4wk", "43–1", "derived: 32–1 over Weeks 3–5 (published) plus 11–0 in Week 6")
F.add("nacua_w5", "41.7", W5SRC)
F.add("nacua_w6_proj", "31.4", "Above and below expectations table (MFL projection saved before kickoff)")
F.add("chat_josh", "41", "D1 ups_discord_messages window Thu Oct 15 8:15 PM ET - Wed Oct 21 10:05 AM ET (owner posts, bots excluded)")
F.add("chat_total", "163", "D1 ups_discord_messages window Thu Oct 15 8:15 PM ET - Wed Oct 21 10:05 AM ET")
F.add("dog_pound_games", "9", "derived: Bousquet, Josh Martel and Keith Creelman each played Bear, Klingenberg and Mannila")
assert all(wins[x] == 0 for x in ("0001", "0007", "0008")) and all(wins[x] == 3 for x in ("0009", "0011", "0012"))
F.add("dog_pound_wins", "0", MFLW6)
F.add("bye_week", "7", "MFL nflByeWeeks (committed: byes.json)")
F.add("n_board", "20", "injury_wk07.json: 19 cases plus McLaurin")

# ---- the common baseline: Weeks 1-6 for every team (D1 weekly scores and games, committed as season_weeks.json) ----
SW = L("season_weeks.json")
WSRC = "D1 weekly team scores and games, Weeks 1-6 (committed: season_weeks.json); reconciled to MFL standings (all-play, points for, head-to-head)"
wsc = {}
for r in SW["scores"]:
    wsc.setdefault(r["franchise_id"], {})[r["week"]] = r["team_score"]
wgm = {}
for g in SW["games"]:
    wgm.setdefault((g["franchise_id"], g["week"]), []).append(g["result"])
assert all(sorted(v) == [1, 2, 3, 4, 5, 6] for v in map(lambda d: sorted(d), wsc.values()))
for f in wsc:                               # the weekly data must reproduce MFL's own standings
    assert abs(sum(wsc[f].values()) - float(st[f]["pf"])) < 0.06
    assert str(sum(wgm[(f, w)].count("W") for w in range(1, 7))) == st[f]["h2hw"]
    assert str(sum(1 for w in range(1, 7) for g in wsc if g != f and wsc[g][w] < wsc[f][w])) == st[f]["all_play_wlt"].split("-")[0]
assert all(wsc[f][6] == team[f]["score"] for f in team)


def wap(f, w):
    return (sum(1 for g in wsc if g != f and wsc[g][w] < wsc[f][w]), sum(1 for g in wsc if g != f and wsc[g][w] > wsc[f][w]))


def wrank(f, w):
    return 1 + sum(1 for g in wsc if wsc[g][w] > wsc[f][w])


ORD = {1: "1st", 2: "2nd", 3: "3rd"}
ordn = lambda n: ORD.get(n, "%dth" % n)
BEAR = "0009"
for w in range(1, 7):
    a = wap(BEAR, w)
    F.add("bw%d_sc" % w, f1(wsc[BEAR][w]), WSRC)
    F.add("bw%d_rk" % w, ordn(wrank(BEAR, w)), WSRC)
    F.add("bw%d_ap" % w, "%d–%d" % a, WSRC)
    F.add("bw%d_h2h" % w, "%d–%d" % (wgm[(BEAR, w)].count("W"), wgm[(BEAR, w)].count("L")), WSRC)
avg = {f: sum(v.values()) / 6 for f, v in wsc.items()}
second = sorted(avg, key=avg.get)[-2]
assert second == "0010"
F.add("bear_avg", f1(avg[BEAR]), WSRC + ": points for / 6")
F.add("blak_avg", f1(avg[second]), WSRC + ": points for / 6")
F.add("bear_avg_gap", f1(round(avg[BEAR], 1) - round(avg[second], 1)), "derived: Bear's Weeks 1-6 average minus the next best")
F.add("bear_pf", "{:,.1f}".format(sum(wsc[BEAR].values())), WSRC)
F.add("bear_w26", "%d–%d" % tuple(map(sum, zip(*[wap(BEAR, w) for w in range(2, 7)]))), WSRC + ": Weeks 2-6 all-play")
F.add("bear_w36", "%d–%d" % tuple(map(sum, zip(*[wap(BEAR, w) for w in range(3, 7)]))), WSRC + ": Weeks 3-6 all-play")
F.add("bear_w46", "%d–%d" % tuple(map(sum, zip(*[wap(BEAR, w) for w in range(4, 7)]))), WSRC + ": Weeks 4-6 all-play (the Heat Check window)")
assert F["bear_w46"] == F["hc_bear"] and F["bear_w36"] == "43–1" and F["bear_w26"] == "53–2"
assert [wrank(BEAR, w) for w in range(1, 7)] == [9, 2, 1, 2, 1, 1]
assert [wap(BEAR, w) for w in (3, 5, 6)] == [(11, 0)] * 3
