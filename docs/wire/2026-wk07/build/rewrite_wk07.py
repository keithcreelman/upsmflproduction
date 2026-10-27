#!/usr/bin/env python3
"""Editorial rewrite of the UPS Center Week 7 draft (Keith, route 1, 2026-10-27): Week 6's show format, Week 7's validated data.

  python3 rewrite_wk07.py <out_article.html>

Reads the automated draft as committed at 04c043b2, keeps its tables as supporting material, and replaces the narrative.
Every number in the new prose comes from rewrite_facts.F and is written, with its source, to narrative_claims.json.
No simulation is rerun; no data is refetched."""
import html as H, json, os, re, sys

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)
import rewrite_facts as R                      # noqa: E402

F, team, OWN, TAG, players, P = R.F, R.team, R.OWN, R.TAG, R.players, R.P
SRC = R.SRC_ART
sec, rows = R.sec, R.rows
f1 = R.f1
inj = R.inj

# ---- more facts the prose needs ----
F.add("n_flips", str(len(R.flips)), "derived: games lost by a team whose best lineup beats the winner's actual score")
F.add("n_games", "18", R.MFLW7)
zero = [(f, p) for f in team for p, v in team[f]["pl"].items() if v["st"] == "starter" and v["s"] <= 0.2]
assert sorted(players[p]["name"] for f, p in zero) == ["Ferguson, Jake", "Graham, Mason", "Otton, Cade", "White, Keion"]
F.add("n_zero", str(len(zero)), "derived: starters who scored 0.2 or less in Week 7")
F.add("chat_total", "37", "league chat: owner posts Thu Oct 22, 8:15 PM ET to Tue Oct 27, 10:00 AM ET (draft's Coffee Shop table)")
F.add("chat_josh", "13", "league chat: Josh Martel's posts in that window (draft's Coffee Shop table)")
F.add("bear_pf", "{:,.1f}".format(sum(R.wsc["0009"].values())), R.WSRC)
for f in team:
    F.add("wvea_" + TAG[f], R.h2[OWN[f]][2].lstrip("+\u2212-"), "Heat Check table, absolute value")
F.add("martel_diff", "3", "derived: Eric Martel 14–5 vs Brian Cutting 11–8")
assert (R.st["0005"]["h2hw"], R.st["0004"]["h2hw"]) == ("14", "11")
inj_by = {c["player"]: c for c in inj["cases"]}
ds = inj_by["DeVonta Smith"]
assert ds["owner"] == "Shawn Blake" and ds["injury"]["mfl"] == "Questionable" and ds["injury"]["expReturn"] == "Nov 1, 2026"
F.add("ds_ppg", f1(ds["ppg"]), R.ISRC)
F.add("ds_drop", f1(ds["lineupDrop"]), R.ISRC)
F.add("ds_rep", f1(ds["replacement"]["ppg"]), R.ISRC)
F.add("ds_lu1", f1(ds["lineupHealthy"]), R.ISRC)
F.add("ds_lu2", f1(ds["lineupWithout"]), R.ISRC)
F.add("ds_fa", f1(ds["bestFreeAgent"]["ppg"]), R.ISRC)
assert ds["replacement"]["player"] == "Brenton Strange" and ds["bestFreeAgent"]["player"] == "Darius Cooper" and ds["bestFreeAgent"]["ppg"] < ds["replacement"]["ppg"]
assert ds["recent"] == ["DNP", "21.1", "DNP"] and (ds["rankHealthy"], ds["rankWithout"]) == (4, 4)
F.add("ds_w6", "21.1", R.ISRC + "; his Week 6 score for Blake")
lj = inj_by["Lamar Jackson"]
assert lj["owner"] == "Brian Cutting" and lj["injury"]["mfl"] == "Questionable" and lj["recent"] == ["DNP", "DNP", "DNP"] and (lj["rankHealthy"], lj["rankWithout"]) == (2, 3)
F.add("lj_ppg", f1(lj["ppg"]), R.ISRC)
F.add("lj_drop", f1(lj["lineupDrop"]), R.ISRC)
F.add("lj_lu2", f1(lj["lineupWithout"]), R.ISRC)
F.add("lj_rep", f1(lj["replacement"]["ppg"]), R.ISRC)
assert lj["replacement"]["player"] == "Aaron Rodgers"
tr = inj_by["Tavius Robinson"]
assert tr["owner"] == "Matt Gerardi" and tr["injury"]["mfl"] == "IR" and (tr["rankHealthy"], tr["rankWithout"]) == (7, 7)
F.add("tr_drop", f1(tr["lineupDrop"]), R.ISRC)
dsa = inj_by["Deebo Samuel"]
assert dsa["owner"] == "Matt Gerardi" and dsa["injury"]["mfl"] == "Questionable"
F.add("gera_hl", f1(inj["healthyLineups"]["0003"]["ppg"]), R.ISRC)
F.add("gera_hlrk", R.ordn(inj["healthyLineups"]["0003"]["rank"]), R.ISRC)
wa = inj_by["Tyler Warren"]
assert wa["owner"] == "Brian Cross" and wa["replacement"]["player"] == "Cade Otton"
F.add("cros_hl", f1(inj["healthyLineups"]["0006"]["ppg"]), R.ISRC)
F.add("cros_hlrk", R.ordn(inj["healthyLineups"]["0006"]["rank"]), R.ISRC)
assert inj["healthyLineups"]["0006"]["rank"] == 11 and inj["healthyLineups"]["0007"]["rank"] == 12
# survival
sv = {r[0]: r[1:] for r in rows(sec(SRC, "survival"))[1:]}
SVS = "Survival Line table (D1 history 2017-2025; docs/wire/auto/2026-wk07-ups-center)"
for f in ("0007", "0003", "0006", "0001"):
    a, b = sv[OWN[f]][1], sv[OWN[f]][2]
    F.add("svap_" + TAG[f], a.replace("/", " of "), SVS)
    F.add("svw_" + TAG[f], b.replace("/", " of "), SVS)
# the rankings the prose names in words are asserted here
pf = {f: float(R.st[f]["pf"]) for f in team}
assert sorted(pf, key=lambda f: -pf[f])[:4] == ["0009", "0005", "0010", "0004"]                       # Bear, Martel, Blake, Cutting
aps = {f: int(R.st[f]["all_play_wlt"].split("-")[0]) for f in team}
assert aps["0010"] == aps["0004"] == 48 and aps["0002"] == 49
wve = {f: float(R.h2[OWN[f]][2].replace("−", "-")) for f in team}
assert min(wve, key=wve.get) == "0010" and max(wve, key=wve.get) == "0011"
assert max(team, key=lambda f: float(R.h2[OWN[f]][0])) == "0004"                                          # Cutting leaves the most per week
hl = {f: inj["healthyLineups"][f]["rank"] for f in team}
assert (hl["0009"], hl["0004"], hl["0005"], hl["0010"]) == (1, 2, 3, 4)
tt = {f: float(R.odds[OWN[f]][3].rstrip("%")) for f in team}
assert sorted(tt, key=tt.get)[-2:] == ["0009", "0004"] and tt["0004"] > tt["0009"] and abs(tt["0004"] - tt["0009"]) < 0.5
by = {f: float(R.odds[OWN[f]][1].rstrip("%")) for f in team}
assert sorted(by, key=by.get, reverse=True)[:4] == ["0009", "0005", "0004", "0010"]
assert R.odds["Eric Martel"][2] == "64.0%" and R.odds["Brian Cutting"][2] == "36.0%"
assert all(team[x]["opt"] < team["0005"]["opt"] for x in team if x != "0005")                            # Martel's best lineup is the week's highest
assert team["0005"]["opt"] > team["0009"]["score"] and team["0009"]["score"] == max(t["score"] for t in team.values())
assert team["0006"]["score"] == min(t["score"] for t in team.values()) and R.wins["0006"] == 0
assert R.margin[("mann", "blak")] == 0.8
assert min(m for _, _, m in R.res) == 0.8 and max(R.res, key=lambda r: r[2])[:2] == ("0009", "0003")
assert (F["rec_blak"], F["rec6_blak"]) == ("9–10", "9–7")
assert sorted(((OWN[f], R.wins[f]) for f in team if R.wins[f] == 0)) == [("Brian Cross", 0), ("Matt Gerardi", 0), ("Shawn Blake", 0)]
assert sorted(((OWN[f], R.wins[f]) for f in team if R.wins[f] == 3)) == [("Bear Dunn", 3), ("Brian Cutting", 3), ("Chris Klingenberg", 3), ("Eric Martel", 3)]
F.add("ap_ties", "48–29", "MFL leagueStandings: Blake and Cutting are both 48–29 in All-Play")
mag = {f: R.f1(team[f]["opt"] - team[f]["score"]) for f in team}
wk6_po = {f: float(F["po6_" + TAG[f]].rstrip("%")) for f in team}
F.add("blake_po_drop", f1(wk6_po["0010"] - float(F["po_blak"].rstrip("%"))), "derived: Week 6 forecast minus Week 7 forecast, playoff odds")
F.add("blake_div_drop", f1(float(F["div6_blak"].rstrip("%")) - float(F["div_blak"].rstrip("%"))), "derived: Week 6 forecast minus Week 7 forecast, division odds")
F.add("blake_bye_drop", f1(float(F["bye6_blak"].rstrip("%")) - float(F["bye_blak"].rstrip("%"))), "derived: Week 6 forecast minus Week 7 forecast, bye odds")
F.add("cutt_title_up", f1(float(F["title_cutt"].rstrip("%")) - float(F["title6_cutt"].rstrip("%"))), "derived: Week 7 forecast minus Week 6 forecast, title odds")


F.add("bates", "17.2", R.MFLW7 + ": Jessie Bates on Mannila's bench")
assert abs(team["0011"]["pl"][R.pid_of("0011", "Bates")]["s"] - 17.2) < 0.01 and team["0011"]["pl"][R.pid_of("0011", "Bates")]["st"] != "starter"
F.add("bear_vs_whit_opt", f1(team["0009"]["score"] - team["0002"]["opt"]), "derived: Bear's Week 7 score minus Whitman's best lineup")
assert team["0002"]["opt"] < team["0009"]["score"] and all(team[x]["opt"] < team["0002"]["opt"] for x in ("0003", "0010"))
F.add("emar_min_margin", "60", "derived: Martel's smallest Week 7 margin was 60.7 (against Keith Creelman)")
assert min(R.margin[("emar", t)] for t in ("keit", "jmar", "bous")) >= 60
F.add("burrow_line", "22-of-30 for 292 yards and four touchdowns, plus 12 on the ground", "automated draft, Plays of the Week (nflverse box score)")
F.add("mcbride_line", "10 catches on 13 targets for 111 yards and a touchdown", "automated draft, Plays of the Week (nflverse box score)")
F.add("zeros_txt", "Keion White for Eric Mannila, Mason Graham for Matt Gerardi, Cade Otton for Brian Cross and Jake Ferguson for Ryan Bousquet", "derived: the four starters at 0.0")
for k in ("gera", "jmar", "cros", "bous"):
    F.add("hc_" + k, R.h1[OWN[R.FID[k]]][1].split(" (")[0] if False else R.h1[OWN[R.FID[k]]][1].split(" ")[0], "Heat Check table: All-Play, Weeks 5-7")
for k in ("cutt", "blak", "bear", "klin", "keit", "emar", "whit", "mann"):
    F.add("hc_" + k, R.h1[OWN[R.FID[k]]][1].split(" ")[0], "Heat Check table: All-Play, Weeks 5-7")
_nvj = json.load(open(os.path.join(D, "nflverse.json")))
_ljid = [p for p in players if players[p]["name"].startswith("Jackson, Lamar")][0]
F.add("lj_last", str(max(_nvj["played"][_ljid])), "nflverse.json: the last week Lamar Jackson played")

# Pollard / Willis histories from the committed weekly results (status and points by week)
def hist(pid, fid):
    out = {}
    for w in range(1, 8):
        for m in json.load(open(os.path.join(D, "wr%d.json" % w)))["weeklyResults"]["matchup"]:
            for fr in m["franchise"]:
                for q in fr["player"]:
                    if q["id"] == pid and fr["id"] == fid:
                        out[w] = (q["status"], q.get("score"))
    return out


_hp = hist(P["pol"], "0002")
assert [_hp[w][0] for w in range(1, 8)] == ["starter"] * 4 + ["nonstarter", "starter", "nonstarter"], _hp
_prev = max(float(_hp[w][1]) for w in range(1, 7))
assert _prev == 13.6
F.add("pol_prev", f1(_prev), "MFL weeklyResults W1-W6: Pollard's best score for Whitman before Week 7")
F.add("pol_lead", f1(float(_hp[7][1]) - _prev), "derived: Week 7 minus his previous best")
_hw = hist(P["wls"], "0003")
assert [_hw[w][0] for w in (1, 2, 3, 4, 5, 7)] == ["starter", "nonstarter", "nonstarter", "nonstarter", "starter", "nonstarter"]
assert _hw[6][1] in (None, "") and R._nv["played"][P["wls"]] == [1, 2, 3, 4, 5, 7]       # Miami's bye was Week 6
assert players[P["wls"]]["team"] == "MIA"
F.add("willis_rank", "sixth", "derived: Willis's 33.6 is the sixth-biggest player score of the week among every rostered player")
assert sorted((v["s"] for t in team.values() for v in t["pl"].values()), reverse=True)[:6][-1] == team["0003"]["pl"][P["wls"]]["s"]
assert sorted((v["s"] for t in team.values() for v in t["pl"].values()), reverse=True)[1] == team["0002"]["pl"][P["pol"]]["s"]
assert R._nv["report"]["17121"]["7"]["practice_status"] == "Full Participation in Practice" and R._nv["report"]["17121"]["7"]["practice_primary_injury"] == "Knee"

assert R.rank7["0003"] == 10 and R.rank7["0001"] == 11 and R.rank7["0006"] == 12
assert max((v["s"], p) for p, v in team["0006"]["pl"].items())[1] == P["gor"]
assert team["0001"]["opt"] < team["0004"]["score"] and team["0001"]["opt"] < team["0005"]["score"]
_el = json.load(open(os.path.join(D, "elias_2026_wk06.json")))
assert _el["resultsFlipped"] == 0 and _el["allplayChanged"] is False and len(_el["teams"]) == 3
_et = {t["fid"]: t for t in _el["teams"]}
for k, fid in (("cros", "0006"), ("blak", "0010"), ("jmar", "0007")):
    t = _et[fid]
    F.add("elias_" + k, "%s%.1f (%.1f to %.1f)" % ("+" if t["delta"] > 0 else "&minus;", abs(t["delta"]), t["before"], t["after"]), "elias.py check --season 2026 --week 6, Tue Oct 27 12:21 PM ET (elias_2026_wk06.json)")

# ---- chat ----
Q = json.load(open(os.path.join(D, "chat_quotes.json")))
CH = Q["channel"]
ex = {m["message_id"] for m in json.load(open(os.path.join(D, "../../../../site/wire/data/chat_exclusions.json")))["messages"]} if os.path.exists(os.path.join(D, "../../../../site/wire/data/chat_exclusions.json")) else set()
assert not (set(Q["quotes"]) & ex)


def rcpt(mid):
    q = Q["quotes"][mid]
    F.claims["nar:quote:" + mid] = {"shown": q["text"], "source": "archived #the-coffee-shop, verbatim by Discord message id %s (local review copy of the automated draft)" % mid, "value": q["text"]}
    return ('<a class="rcpt" href="https://discord.com/channels/%s/%s/%s" target="_blank" rel="noopener" title="%s &middot; #%s &middot; %s">&ldquo;%s&rdquo;</a>'
            % (CH["guild"], CH["channel_id"], mid, q["owner"], CH["name"], q["when"], H.escape(q["text"], quote=False)))


for key, mid in (("q_blake1", "1564242435893231741"), ("q_blake2", "1564242967143907449"), ("q_josh", "1564243352172503122"),
                 ("q_keith", "1564243079505117225"), ("q_cutt", "1563641371536138356"), ("q_josh2", "1564242602583392350")):
    F[key] = rcpt(mid)

# ---- html helpers ----


def desk(*lines):
    return '<div class="desk-lines" style="margin-bottom:1rem">%s</div>' % "".join(
        '<div class="lt %s"><div class="who">%s</div><p>%s</p></div>' % (w.lower(), w, t) for w, t in lines)


def label(n, title, sub=""):
    return '<div class="label" style="break-after:avoid;page-break-after:avoid"><span class="seg">%d</span> %s%s</div>' % (
        n, title, " <small>&mdash; %s</small>" % sub if sub else "")


def h3(t):
    return '<h3 style="font-family:var(--display);font-size:1.15rem;margin:1.4rem 0 .5rem;break-after:avoid;page-break-after:avoid">%s</h3>' % t


def wrap(sid, title, body):
    return '<section class="wire-sec" id="%s" data-title="%s">%s</section>' % (sid, title, body)


def det(summary, inner_html):
    return '<div class="wire-fig"><details><summary>%s</summary>%s</details></div>' % (summary, inner_html)


def inner(sid, drop_desk=True, drop_gap=False):
    s = sec(SRC, sid)
    s = re.sub(r'^<section[^>]*>', "", s)
    s = re.sub(r"</section>$", "", s)
    s = re.sub(r'<div class="label"[\s\S]*?</div>', "", s, count=1)
    if drop_desk:
        s = re.sub(r'<div class="desk-lines" style="margin-bottom:1rem">[\s\S]*?</div></div>(?=<)', "", s, count=1) if 'class="desk-lines"' in s[:200] else s
    if drop_gap:
        s = re.sub(r'<div class="editor-gap"[\s\S]*?</div>', "", s)
    return s


def record_block(ids, note):
    out = ['<div style="border:1px solid var(--line-2);border-radius:10px;background:var(--surface);padding:.2rem .8rem;margin:.2rem 0 .4rem">']
    for i, f in enumerate(ids):
        g = TAG[f]
        out.append('<div style="padding:.5rem 0;border-top:%s"><div style="font-weight:700">%s <span style="font-weight:400;color:var(--ink-mute)">{rec_%s}</span></div>'
                   '<div style="font-size:.86rem;line-height:1.5;font-variant-numeric:tabular-nums">All-Play {ap_%s} &middot; Points for {pf_%s} &middot; Wins vs expected {wve_%s}<br>Week 7: {sc_%s}, went {wins7_%s}&ndash;{loss7_%s}</div></div>'
                   % ("0" if i == 0 else "1px solid var(--line)", OWN[f], g, g, g, g, g, g, g))
    out.append("</div>")
    return "".join(out) + '<p class="caption">%s</p>' % note


# ======================================================================= the sections
S = []
GRID = "display:grid;grid-template-columns:1.25fr 1fr .8fr 1fr .9fr;gap:.2rem .5rem;align-items:baseline;padding:.3rem .1rem;border-top:1px solid var(--line);font-size:.88rem"
HEAD = GRID + ";border-top:0;font-size:.68rem;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-mute);font-family:var(--display)"
cell = lambda s, b=False: '<span style="font-variant-numeric:tabular-nums;white-space:nowrap%s">%s</span>' % (";font-weight:700" if b else "", s)
BEAR_ROWS = "".join('<div style="%s">%s</div>' % (GRID, "".join(cell(x) for x in ("Week %d" % w, "{bw%d_sc}" % w, "{bw%d_rk}" % w, "{bw%d_ap}" % w, "{bw%d_h2h}" % w))) for w in range(1, 8))
BEAR_TAB = ('<div style="border:1px solid var(--line-2);border-radius:10px;background:var(--surface);padding:.45rem .7rem;margin:.2rem 0 .4rem">'
            '<div style="%s">%s</div>' % (HEAD, "".join(cell(x) for x in ("Bear", "Score", "Rank", "All-Play", "H2H")))
            + BEAR_ROWS + '<div style="%s">%s</div></div>' % (GRID, "".join(cell(x, True) for x in ("Wks 1&ndash;7", "{bear_avg}", "", "{ap_bear}", "{rec_bear}")))
            + '<p class="caption">Season to date, Weeks 1 to 7; the last row is the seven-week average score, All-Play and head-to-head record. Rank is Bear&rsquo;s score among the 12 teams that week.</p>')

# 1 -- The Big Story
S.append(wrap("story", "The Big Story", label(1, "The Big Story", "Cutting catches Bear in the title odds") + desk(
    ("Stuart", "Seven weeks in, the forecast has a tie at the top. Brian Cutting is at {title_cutt} to win the title and Bear Dunn is at {title_bear}. A week ago it was {title6_bear} for Bear and {title6_cutt} for Cutting."),
    ("Rich", "Which looks wrong, because Bear is {rec_bear} and Cutting is {rec_cutt}. Start with Bear, Weeks 1 to 7: {ap_bear} against the field, {bear_avg} a week, {bear_avg_gap} more than the next-best team. Week 7 was {bw7_sc}, the best score of the week, 3&ndash;0 and 11&ndash;0 against the field."))
    + BEAR_TAB + desk(
    ("Stuart", "So why does the forecast like Cutting so much?"),
    ("Rich", "Because the forecast does not play the record. It plays each team&rsquo;s best lineup every week, built from 2026 points per game with everyone healthy. Bear&rsquo;s is {hl_bear} a week. Cutting&rsquo;s is {hl_cutt}, second in the league, ahead of Eric Martel ({hl_emar}) and Shawn Blake ({hl_blak}). Cutting&rsquo;s roster is better than his {rec_cutt}."),
    ("Stuart", "Is it?"),
    ("Rich", "Both things are true. This season Cutting has left {bench_cutt} points a week on the bench, the most in the league, and in {blw_cutt} of his losses the best lineup from his own roster would have won. In Week 7 it was Bucky Irving ({irving}) and Deshaun Watson ({watson}), {cutt_bench_two} between them. He swept anyway, with {sc_cutt}."),
    ("Kenny", "Saturday, 3:52 PM, Brian Cutting: {q_cutt} Lamar Jackson ({lj_ppg} a game) has not played since Week {lj_last}, and MFL lists him Questionable with an ankle injury. Without Jackson, Aaron Rodgers ({lj_rep}) steps in and Cutting&rsquo;s best lineup drops {lj_drop}, to {lj_lu2}, third in the league. He is staying afloat."),
    ("Stuart", "And the bye?"),
    ("Rich", "The first one is spoken for. Bear is at {bye_bear}. The second is Eric Martel at {bye_emar}, Brian Cutting at {bye_cutt} and Shawn Blake at {bye_blak}. Nobody else is above {bye_whit}."),
    ("Rich", "Martel and Cutting are in the same division, Outlast PG Time, with Brian Cross. Martel is {rec_emar}, Cutting is {rec_cutt}, three games behind, and the forecast gives Martel {div_emar} to win it and Cutting {div_cutt}. The division winner takes a top seed. That race is the bye."),
    ("Kenny", "Monday, 7:41 AM, Josh Martel: {q_josh2} The forecast agrees, mostly: Bear is at {title_bear} to win the title, and Cutting, who is {rec_cutt}, is at {title_cutt}. Josh is {rec_jmar}."))))

# 2 -- The Blake Slide
S.append(wrap("middle", "The Blake Slide", label(2, "The Blake Slide", "0&ndash;6 over two weeks") + desk(
    ("Stuart", "Shawn Blake went 0&ndash;3 in Week 6 and 0&ndash;3 in Week 7. He was {rec6_blak} before Week 6 started and he is {rec_blak} now."),
    ("Rich", "That is six losses in a row, and the second week was close. Blake scored {sc_blak}, {blake_wk7_rk} in the league, and lost to Eric Mannila&rsquo;s {sc_mann} by {blake_loss_mann}. It was the closest game of the week."),
    ("Stuart", "So is Blake bad?"),
    ("Rich", "The scores say no. Over Weeks 1 to 7 Blake is {ap_blak} in All-Play, level with Cutting and one win behind Whitman, and his {pf_blak} points for are third in the league, behind Bear and Eric Martel. His record is {wvea_blak} wins short of what his weekly scores predict, the largest gap in the league. Mannila is the mirror image, {wvea_mann} wins better.")
    ) + record_block(("0010", "0011", "0004", "0002"), "Season to date, Weeks 1 to 7. The last line of each box is Week 7 alone.").replace("</div></div>", "</div></div>") + desk(
    ("Rich", "Week 7 gave the 0.8 a size. Three bench players would each have won that game by themselves. Rico Dowdle ({dowdle}) in for Derrick Henry ({dhenry}) is {blake_dow_gain} more and {blake_dow_lu}. Byron Young ({byoung_de}) in for Will Anderson ({wanderson}) is {blake_byo_gain} more and {blake_byo_lu}. AJ Barner ({barner}) in for Denzel Boston ({boston}) is {blake_bar_gain} more and {blake_bar_lu}. Mannila scored {sc_mann}. That is hindsight; nobody has it on Sunday morning."),
    ("Kenny", "Monday, 7:43 AM, Shawn Blake: {q_blake2} His seven IDP starters scored {blake_idp}, {blake_idp_rk} of the 12 teams. He was right. The fill-ins were great: Blake Corum scored {corum} and Devaughn Vele {vele}."),
    ("Kenny", "The team that beat him got {mann_idp} from its seven IDP starters, {mann_idp_rk} in the league, and won anyway. That is the same Mannila who is {wvea_mann} wins better than his scores."),
    ("Kenny", "Monday, 7:40 AM, Shawn Blake: {q_blake1} The week finished 0&ndash;3 for Blake, and {ap7_blak} in All-Play."),
    ("Stuart", "Is he in a great spot?"),
    ("Rich", "Less great than a week ago. Blake is at {po_blak} to make the playoffs, down from {po6_blak}. His division odds fell from {div6_blak} to {div_blak}, and he is now a coin flip with Derrick Whitman ({div_whit}) in Legion of Boom. His bye odds fell from {bye6_blak} to {bye_blak}. Blake&rsquo;s title odds are {title_blak}."))
    + det("Full standings after Week 7, and the Week 7 forecast graded", inner("landscape"))))

# 3 -- Playoff Picture
S.append(wrap("odds", "Playoff Picture", label(3, "Playoff Picture", "updated after Week 7") + desk(
    ("Stuart", "{sims} simulated seasons, run fresh through Week 7. Bear first."),
    ("Rich", "Bear: {po_bear} to make the playoffs, {bye_bear} for a bye, {div_bear} to win the Dog Pound and {title_bear} for the title. With the division spoken for, Chris Klingenberg ({po_klin}) and Eric Mannila ({po_mann}) are playing for a wild card, and wild cards go by All-Play."),
    ("Stuart", "Klingenberg is {rec_klin}, a game better than Mannila&rsquo;s {rec_mann}. Why is he only at {po_klin}?"),
    ("Rich", "Because his scores are not {rec_klin} scores. Klingenberg is {ap_klin} in All-Play, and his best lineup, {hl_klin} a week, is {hlrk_klin} in the league. Mannila is {ap_mann} and {po_mann}. Both swept in Week 6. In Week 7 Klingenberg did it again, 3&ndash;0 with {sc_klin}, fourth in the league, while Mannila went {wins7_mann}&ndash;{loss7_mann}."),
    ("Stuart", "Maddie Mondays?"),
    ("Rich", "Keith Creelman is at {div_keit} to win it and {po_keit} to make the playoffs, almost all of it through the division. Ryan Bousquet is at {div_bous} to win it and {po_bous} to make the playoffs. Josh Martel is {po_jmar}."),
    ("Stuart", "And Whitman?"),
    ("Rich", "Whitman is {rec_whit}, {po_whit} to make the playoffs and {title_whit} for the title. His division is a coin flip with Blake, {div_whit} to {div_blak}, and Matt Gerardi is at {div_gera}.")) +
    inner("odds")))

# 4 -- Heat Check
S.append(wrap("heat", "Heat Check", label(4, "Heat Check", "season to date, Weeks 1&ndash;7, and Weeks 5&ndash;7") + desk(
    ("Stuart", "Heat Check compares every team over the same two windows: the season to date, Weeks 1 to 7, and the recent stretch, Weeks 5 to 7. Start at the top. Bear Dunn is {ap_bear} on the season and {bear_w57} against the field over Weeks 5 to 7, a streak and not the season: three weeks, three 11&ndash;0 weeks."),
    ("Rich", "Brian Cutting is the other mover at the top. Holding, {hc_cutt} over Weeks 5 to 7, and his scoring rank moved from fifth over Weeks 1 to 4 to second. We covered his bench in the Big Story."),
    ("Stuart", "Then the other direction."),
    ("Rich", "Shawn Blake, third in scoring over Weeks 1 to 4 and sixth over Weeks 5 to 7. Blake is Holding, 16&ndash;17 over the recent stretch, which is why the 0&ndash;6 over two weeks reads worse than the scoring does. His record is {wvea_blak} wins short of his scores, the largest gap in the league."),
    ("Stuart", "Josh Martel and Matt Gerardi are the bottom of the page."),
    ("Rich", "Both Sinking. Josh Martel is {hc_jmar} against the field over Weeks 5 to 7 and {ap_jmar} on the season. Gerardi is {hc_gera} over Weeks 5 to 7 and {ap_gera} on the season. Brian Cross is Holding at {hc_cros} over the recent stretch; his Week 7 is below."),
    ("Kenny", "Eric Mannila is {wvea_mann} wins better than his scores, the most in the league. Mannila scored {sc_mann}, seventh in the week, and went {wins7_mann}&ndash;{loss7_mann}.")
    ) + det("The Heat Check tables", inner("heat", drop_gap=True))))

# 5 -- Week 7 in Brief
zeros = "Keion White for Eric Mannila, Mason Graham for Matt Gerardi, Cade Otton for Brian Cross and Jake Ferguson for Ryan Bousquet"
S.append(wrap("brief", "Week 7 in Brief", label(5, "Week 7 in Brief", "Boomer, the plays, every result") + desk(
    ("Stuart", "Boomer, give us the week."),
    ("Boomer", "Thanks, Stu! Joe Burrow! {burrow_line}: {burrow} UPS points for Bear Dunn, the best score of the week by a player in a lineup!"),
    ("Boomer", "Jaxon Smith-Njigba! {jsn} for Bear! And Bear Dunn finished with {sc_bear}, and 11&ndash;0 against the field!"),
    ("Boomer", "Trey McBride! {mcbride_line}, {mcbride} points for Eric Martel! And Eric Martel&rsquo;s best lineup was {opt_emar}!"),
    ("Boomer", "Drake Maye {maye} for Brian Cutting! Bo Nix {nix} for Ryan Bousquet! And Ryan Bousquet went 1&ndash;2!"),
    ("Rich", "Boomer, the biggest score of the week from a player was Burrow&rsquo;s {burrow}. The second-biggest was Tony Pollard&rsquo;s {pollard}, and he was on Derrick Whitman&rsquo;s bench. The sixth-biggest was Malik Willis&rsquo;s {willis}, on Matt Gerardi&rsquo;s."),
    ("Boomer", "Benches do not make the highlight reel, Rich."),
    ("Rich", "Then the zeros should not either. Count the starters who scored 0.2 or less: {n_zero}. {zeros_txt}."),
    ("Kenny", "Saturday, 3:52 PM, Brian Cutting: {q_cutt} On Sunday Drake Maye gave him {maye}. Jackson was still out."),
    ("Boomer", "Two plays made the board. Both are below."),
    ("Rich", "One more thing before the results. In {n_flips} of the {n_games} games, the losing side&rsquo;s best possible lineup would have beaten the winner&rsquo;s actual score. That is the next segment.")) +
    inner("plays", drop_gap=True) + h3("Every Week 7 result") + inner("desk")))

# 6 -- Who Actually Won the Week
S.append(wrap("weeks", "Who Actually Won the Week", label(6, "Who Actually Won the Week", "the lineups that decided games") + desk(
    ("Stuart", "Points say who scored. Lineups say who decided. Rich, how many games did decisions change?"),
    ("Rich", "{n_flips} of {n_games}, if you build each loser&rsquo;s best lineup from the same roster. That is hindsight. Nobody has that lineup on Sunday morning. It shows where decisions mattered, and where nothing could have."),
    ("Stuart", "Start with the biggest."),
    ("Rich", "Derrick Whitman. His best lineup was {opt_whit}, and he started {sc_whit}, so {left_whit} points sat on the bench, the most of any team. He lost to Chris Klingenberg by {whit_loss_klin}. Put Tony Pollard ({pollard}) in for Aaron Jones ({ajones}) and Whitman scores {whit_pol}, which wins that game by {whit_pol_klin} and also beats Eric Mannila. Add Omar Cooper Jr. ({ocooper}) for Nico Collins ({ncollins}) and it is {whit_both}, still {whit_pol_bear} short of Bear."),
    ("Stuart", "Matt Gerardi."),
    ("Rich", "Gerardi started Patrick Mahomes ({mahomes}) and Bryce Young ({byoung}) at quarterback, {gera_qb_pair} together, with Malik Willis ({willis}) on the bench. Willis in for Young is {gera_willis_lu}, which beats Mannila by {gera_willis_mann}. Gerardi went 0&ndash;3."),
    ("Stuart", "And Shawn Blake?"),
    ("Rich", "The 0.8. Blake&rsquo;s best lineup was {opt_blak}, which beats Mannila but not Klingenberg ({sc_klin}) or Bear. That is in the Blake Slide."),
    ("Stuart", "The fourth flip is Mannila over Whitman."),
    ("Rich", "Mannila&rsquo;s best lineup was {opt_mann}, against Whitman&rsquo;s {sc_whit}. Whitman won by {m_whit_mann}. Mannila&rsquo;s bench had safety Jessie Bates at {bates}."),
    ("Stuart", "Eric Martel swept, but his best lineup was bigger than anyone&rsquo;s."),
    ("Rich", "{opt_emar} against the {sc_emar} he started. Geno Smith ({genosmith}) and Mason Taylor ({mtaylor}) sat; together that is {emar_bench_two}. His best lineup is {emar_miss_bear} above Bear&rsquo;s actual {sc_bear}. Martel did not play Bear in Week 7, and he beat Keith Creelman, Josh Martel and Ryan Bousquet by {emar_min_margin} or more, so none of it changed a game."),
    ("Stuart", "And the games lineups could not touch?"),
    ("Rich", "Anyone who played Bear. His opponents&rsquo; best lineups were {opt_gera}, {opt_whit} and {opt_blak}. Whitman&rsquo;s {opt_whit} was the closest, and it still falls {bear_vs_whit_opt} short.")) +
    det("Projected versus actual: every start, graded", inner("bb"))))

# 7 -- Player and Team Stories
S.append(wrap("players", "Player and Team Stories", label(7, "Player and Team Stories", "what changed and what happens next") + desk(
    ("Stuart", "Four stories, and the first one is a bench.")) +
    h3("1. Derrick Whitman and the {pollard} on his bench") + desk(
    ("Stuart", "Tony Pollard scored {pollard} in Week 7, the second-biggest player score of the week behind Joe Burrow&rsquo;s {burrow}. He was on Derrick Whitman&rsquo;s bench."),
    ("Rich", "Whitman started him in Weeks 1 to 4 and in Week 6, and benched him in Weeks 5 and 7. Before Sunday his best week for Whitman was {pol_prev}. Pollard beat that by {pol_lead}. Aaron Jones started in his place and scored {ajones}."),
    ("Rich", "It was not only the one slot. Omar Cooper Jr. scored {ocooper} on the bench while Nico Collins ({ncollins}) and Garrett Wilson ({gwilson}) started at receiver. The two Whitman started instead, Jones and Collins, gave him {whit_started_two}. The two who sat gave {whit_bench_two}."),
    ("Stuart", "And where does that leave Whitman?"),
    ("Rich", "{rec_whit} and leading Legion of Boom by two games over Shawn Blake, which the forecast does not care about: Whitman {div_whit}, Blake {div_blak}. The reason is on the roster. Blake&rsquo;s best healthy lineup is {hl_blak} a week, {hlrk_blak}. Whitman&rsquo;s is {hl_whit}, {hlrk_whit}. He has the record and the forecast has a coin flip."))
    + h3("2. Matt Gerardi&rsquo;s quarterback room") + desk(
    ("Stuart", "Matt Gerardi is {rec_gera}, went 0&ndash;3 with {sc_gera} and scored the third-lowest total of the week, above only Ryan Bousquet and Brian Cross."),
    ("Rich", "Gerardi started Patrick Mahomes ({mahomes}) and Bryce Young ({byoung}) in the two quarterback spots. Malik Willis scored {willis} on his bench, the {willis_rank}-biggest player score of the week. Gerardi started Willis in Weeks 1 and 5 and benched him in Weeks 2, 3, 4 and 7. Miami was on its bye in Week 6."),
    ("Stuart", "And the zero?"),
    ("Rich", "Mason Graham. He has not played an NFL game since Week 3. Gerardi started him in Week 4, benched him in Weeks 5 and 6, and started him again in Week 7. He scored 0.0 both times. MFL lists no injury for him. The NFL&rsquo;s Week 7 practice report lists a knee and full participation."),
    ("Stuart", "Is it the roster?"),
    ("Rich", "No. Gerardi&rsquo;s best healthy lineup is {gera_hl} a week, {gera_hlrk} in the league, and his best lineup this week was {opt_gera}, {left_gera} more than he started. {rec_gera} and {po_gera} to make the playoffs. It is the Sinking line in the Heat Check."))
    + h3("3. Brian Cross, and the lowest score of the week") + desk(
    ("Stuart", "Last week&rsquo;s report called Week 7 Brian Cross&rsquo;s problem."),
    ("Rich", "It was. Cross scored {sc_cros}, the lowest score of the week and {cros_drop} fewer than the {cros_w6} that ranked {cros_w6_rk} in Week 6. Last week&rsquo;s report put his Week 7 lineup at {cros_wk7_est} if Tyler Warren sat, from 2026 points per game. Warren did not play. Cross finished {cros_wk7_est_gap} below that estimate."),
    ("Rich", "Trevor Lawrence was on his bye, so Cam Ward started at quarterback and scored {ward}. Cade Otton started at tight end and scored {otton}, with Gunnar Helm on the bench at {helm}. Ollie Gordon II was the best player on the roster this week with {gordon}."),
    ("Stuart", "Was it a lineup problem?"),
    ("Rich", "No. Cross&rsquo;s best possible lineup from the same roster was {opt_cros}, the lowest in the league, {left_cros} better than what he started. His best healthy lineup, with everyone back, is {cros_hl} a week, {cros_hlrk} in the league. He is {rec_cros} and {po_cros} to make the playoffs."))
    + h3("4. What is new on the injury list") + desk(
    ("Stuart", "The rule: an injury makes this report when it is new or newly relevant, and when it changes a team&rsquo;s outlook."),
    ("Rich", "DeVonta Smith is the one. MFL lists him Questionable with a hamstring injury, expected back Nov 1, and the official Week 7 report had him Out. He scored {ds_w6} for Blake in Week 6 and did not play in Week 7. He averages {ds_ppg} a game."),
    ("Rich", "Blake&rsquo;s best healthy lineup is {ds_lu1} with Smith and {ds_lu2} without him, a drop of {ds_drop}, which is a waiver or trade look. His replacement is Brenton Strange at {ds_rep}. The best available free agent receiver, at {ds_fa}, is no help. The rank holds at {hlrk_blak}, but this is the second receiver Blake is short of after Terry McLaurin, who is still out."),
    ("Rich", "Gerardi has two. Tavius Robinson moved to injured reserve with a pectoral injury, a drop of {tr_drop} that leaves his rank at {gera_hlrk}. Deebo Samuel was upgraded from Out to Questionable. Older injuries on the list, among them Jalen Hurts, Tyler Warren and Jaxson Dart, are unchanged since last week&rsquo;s report and are not repeated here."))))

# 8 -- Survival Line
S.append(wrap("survival", "The Survival Line", label(8, "The Survival Line", "what a Week 7 position has meant") + desk(
    ("Stuart", "Now the bottom. Josh Martel is {rec_jmar}, Matt Gerardi is {rec_gera}, Brian Cross is {rec_cros}, and the forecast gives them {po_jmar}, {po_gera} and {po_cros}."),
    ("Rich", "History agrees. For Josh Martel and Matt Gerardi, {svap_jmar} teams in the same All-Play spot went on to make the playoffs, and {svw_jmar} with the same win total. For Cross, {svap_cros} and {svw_cros}."),
    ("Stuart", "And Ryan Bousquet?"),
    ("Rich", "{rec_bous}, {po_bous} to make the playoffs, and it runs through Maddie Mondays: {div_bous} to win it, behind Keith Creelman&rsquo;s {div_keit}. {svap_bous} teams in his All-Play spot made it, {svw_bous} with his win total. Week 7 was {sc_bous}, 1&ndash;2, and his best lineup, {opt_bous}, would not have changed it: he still loses to Eric Martel and Brian Cutting."),
    ("Kenny", "Josh Martel posted {chat_josh} of the {chat_total} owner posts in the chat since Thursday night, more than anyone. Monday, 7:43 AM, Keith Creelman: {q_keith} He is {rec_keit} and {div_keit} to win Maddie Mondays."),
    ("Kenny", "One minute later, 7:44 AM, Josh Martel: {q_josh} Keith&rsquo;s score ranked in the top six in {keit_top6} of 7 weeks, and {keit_rk7} in Week 7. Josh Martel is {rec_jmar}."),
    ("Stuart", "So the committee has reviewed the evidence.")) +
    det("The Survival Line table", inner("survival"))))

# 9 -- Elias
S.append(wrap("elias", "Elias changes", label(9, "Elias changes") + desk(
    ("Stuart", "Week 7 is not Elias-final. The official Week 7 stat changes had not posted when this report was written (checked Tue Oct 27, 12:34 PM ET). The scores above are the ones MFL showed Tuesday morning."),
    ("Rich", "Week 6 did post. Elias moved three player scores and three team scores: Brian Cross {elias_cros}, Shawn Blake {elias_blak} and Josh Martel {elias_jmar}. No result flipped and no All-Play record changed. This report uses the Elias-final Week 6 numbers, so a few Week 6 figures here are 1.3 or 0.5 away from last week&rsquo;s report."),
    ("Rich", "Same as before: if Elias moves a UPS score in Week 7, the report is corrected here, and the league hears about it only if an All-Play record changes."))))

# ======================================================================= assemble
head, rest = SRC.split('<section class="wire-sec" id="open"', 1)
tail = rest[rest.rindex("</section>") + len("</section>"):]
head = head.replace('<div class="wire-eyebrow">Week 7 recap</div>', '<div class="wire-eyebrow">Week 7</div>')
head = head.replace("Kenny Mayne in the Coffee Shop", "Kenny Mayne with receipts from the league chat")
head = re.sub(r'<p class="wire-dek">[\s\S]*?</p>',
              '<p class="wire-dek">Brian Cutting has caught Bear Dunn in the title odds, Shawn Blake is 0&ndash;6 over two weeks, and Derrick Whitman left the second-biggest player score of the week on his bench.</p>', head)
tail = re.sub(r"<b>Sources\.</b>[\s\S]*?</div>", "<b>Sources.</b> MFL scores, standings, schedules, transactions, injury feed and Elias posts; the league&rsquo;s D1 copies, checked against MFL; MFL projections as saved before each kickoff; nflverse expected points and official injury reports; the archived league Discord.</div>", tail, count=1)
tail = re.sub(r"<b>Status\.</b>[\s\S]*?</div>", "<b>Status.</b> Automated draft (ups_center_auto.py), generated Tue Oct 27, 10:00 AM ET, rewritten by the editor. Not published.</div>", tail, count=1)
tail = re.sub(r"<b>Editor review\.</b>[\s\S]*?</div>", "<b>Still to come.</b> The Elias segment for Week 7: the official stat changes had not posted when this report was written.</div>", tail, count=1)
body = "".join(S)


def render(x):
    return re.sub(r"\{(\w+)\}", lambda m: str(F[m.group(1)]), x)


head = render(head)
body = render(body)
article = head + body + tail
out = sys.argv[1]
open(out, "w", encoding="utf-8").write(article)
used = {k for k in F.used}
claims = {k: v for k, v in F.claims.items() if k.startswith("nar:quote:") or k.startswith("nar:supplied:") or k[4:] in used}
json.dump(claims, open(os.path.join(D, "narrative_claims.json"), "w"), indent=1, ensure_ascii=False, sort_keys=True)
print("wrote", out, len(article), "bytes;", len(claims), "narrative claims")
