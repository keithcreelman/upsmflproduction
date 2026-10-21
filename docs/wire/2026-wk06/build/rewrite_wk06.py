#!/usr/bin/env python3
"""Editorial rewrite of the UPS Center Week 6 draft (Keith, 2026-10-21): Week 5's show format, Week 6's validated data.

  python3 rewrite_wk06.py <out_article.html>

Reads the draft as committed at f4bc54fa (automation draft + the Injury Report), keeps its tables as supporting material,
and replaces the narrative. Every number in the new prose comes from rewrite_facts.F and is written, with its source, to
narrative_claims.json. No simulation is rerun; no data is refetched."""
import html as H, json, os, re, sys

D = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, D)
import rewrite_facts as R                      # noqa: E402  (prints its replacement/zero-starter diagnostics)

F, team, OWN, TAG, players, P = R.F, R.team, R.OWN, R.TAG, R.players, R.P
SRC = R.SRC_ART
sec, rows = R.sec, R.rows
f1 = R.f1

# ---- more facts the prose needs ----
for f in team:
    F.add("wvea_" + TAG[f], R.h2[OWN[f]][2].lstrip("+−-"), "Heat Check table, absolute value")
    F.add("hl_" + TAG[f], f1(R.inj["healthyLineups"][f]["ppg"]), R.ISRC)
bbtxt = sec(SRC, "bb")


def proj(name):
    for li in re.findall(r"<li[\s\S]*?</li>", bbtxt):
        if name in li:
            m = re.search(r"([\d.]+)\s*<i>&rarr;</i>\s*([\d.]+)", li)
            return m.group(1), m.group(2)
    raise AssertionError(name)


F.add("golden_proj", proj("Matthew Golden")[0], "Above and below expectations table (MFL projection saved before kickoff)")
F.add("lloyd_proj", proj("MarShawn Lloyd")[0], "Above and below expectations table (MFL projection saved before kickoff)")
F.add("holani", f1(team["0006"]["pl"][R.pid_of("0006", "Holani")]["s"]), R.MFLW6)
F.add("coleman", f1(team["0011"]["pl"][R.pid_of("0011", "Coleman, Keon")]["s"]), R.MFLW6)
F.add("mann_w5_stars", "18.7", "Week 5 UPS Center as published: Lamb and Robinson combined for 18.7")
F.add("rodgers_note", "Aaron Rodgers", "name")
sv = {r[0]: r[2:] for r in rows(sec(SRC, "survival"))[1:]}
SVS = "Survival Line table (D1 history 2017-2025; docs/wire/auto/2026-wk06-ups-center)"
for f in ("0007", "0003", "0006"):
    a, b = sv[OWN[f]]
    F.add("svap_" + TAG[f], a.replace("/", " of "), SVS)
    F.add("svw_" + TAG[f], b.replace("/", " of "), SVS)
F.add("dog09", "0–9", "derived: Bousquet, Josh Martel and Keith Creelman against Bear, Klingenberg and Mannila, Week 6")
F.add("w6_gap_emar", "255.4", "derived")
# the rankings the prose names in words are asserted here
pf = {f: float(R.st[f]["pf"]) for f in team}
assert sorted(pf, key=lambda f: -pf[f])[:3] == ["0009", "0010", "0005"]                 # Bear, Blake, Eric Martel
assert pf["0011"] > pf["0012"] and pf["0008"] > pf["0011"]                                # among the 9-7s: Blake, Keith, Mannila, Klingenberg? checked below
nine7 = sorted(("0010", "0008", "0011", "0012"), key=lambda f: -pf[f])
assert nine7 == ["0010", "0008", "0011", "0012"], nine7
aps = {f: int(R.st[f]["all_play_wlt"].split("-")[0]) for f in team}
assert max(("0010", "0008", "0011", "0012"), key=lambda f: aps[f]) == "0010" and min(("0010", "0008", "0011", "0012"), key=lambda f: aps[f]) == "0011"
assert aps["0012"] - aps["0008"] == 1
wve = {f: float(R.h2[OWN[f]][2].replace("−", "-")) for f in team}
assert min(wve, key=wve.get) == "0010" and max(wve, key=wve.get) == "0011"
hl = {f: R.inj["healthyLineups"][f]["ppg"] for f in team}
rk = {f: 1 + sum(1 for g in hl if hl[g] > hl[f]) for f in team}
assert (rk["0009"], rk["0010"], rk["0004"], rk["0002"]) == (1, 2, 3, 5)
bye_sorted = sorted(team, key=lambda f: -float(R.odds[OWN[f]][1].rstrip("%")))
assert bye_sorted[:4] == ["0009", "0005", "0004", "0010"] and R.odds[OWN["0002"]][1] == "3.4%"
tt = {f: float(R.odds[OWN[f]][3].rstrip("%")) for f in team}
assert sorted(tt, key=tt.get)[-2:] == ["0004", "0009"]                                      # Bear best, Cutting second

reading = [r[0] for r in R.rows(R.tabs[0])[1:]]
assert [r for r in reading if "Dominant" in r] == ["Bear Dunn Dominant"]                      # only Bear reads Dominant
# Mayer alone does not flip a game for Keith
mayer_gain = team["0008"]["pl"][P["mye"]]["s"] - min(v["s"] for p, v in team["0008"]["pl"].items() if v["st"] == "starter"
                                                      and players[p]["position"] in ("QB", "WR", "RB"))
assert team["0008"]["score"] + mayer_gain < team["0012"]["score"]
# Smith alone does not flip the Cross game for Blake
assert team["0010"]["score"] + team["0010"]["pl"][P["dsm"]]["s"] - team["0010"]["pl"][P["bos"]]["s"] < team["0006"]["score"]
# Bear's opponents' best lineups all fall short
assert all(team[x]["opt"] < team["0009"]["score"] for x in ("0007", "0001", "0008"))
# Cutting's mid-ladder facts used in the prose
assert R.inj["healthyLineups"]["0004"]["rank"] == 3 and R.inj["healthyLineups"]["0010"]["rank"] == 2 and R.inj["healthyLineups"]["0002"]["rank"] == 5

ci = {c["player"]: c for c in R.inj["cases"]}
assert ci["Edgerrin Cooper"]["injury"]["expReturn"] == "Feb 15, 2027" and ci["Travis Etienne"]["injury"]["expReturn"] == "Nov 8, 2026"
assert ci["Jaxson Dart"]["injury"]["expReturn"] == "Jan 17, 2027"
assert ci["Lamar Jackson"]["replacement"]["player"] == "Aaron Rodgers" and ci["Edgerrin Cooper"]["replacement"]["player"] == "Akeem Davis-Gaither"
assert ci["Mike Evans"]["replacement"]["player"] == "Rhamondre Stevenson" and ci["Mike Evans"]["bestFreeAgent"]["player"] == "Tre Tucker"
assert ci["Travis Etienne"]["replacement"]["player"] == "TreVeyon Henderson" and ci["Jaxson Dart"]["replacement"]["player"] == "Justin Herbert"
assert ci["Jaxson Dart"]["bestFreeAgent"]["player"] == "Drew Lock" and ci["Jaxson Dart"]["bestFreeAgent"]["games"] == 2
assert [o for o in ci["Travis Etienne"]["otherInjuriesAtPosition"]] == ["Saquon Barkley", "Trey Benson", "Will Shipley"]
assert ["Foyesade Oluokun", 7] in ci["Edgerrin Cooper"]["byePressure"] and ["Mike Evans", 8] in ci["Mike Evans"]["byePressure"]
assert (ci["Lamar Jackson"]["rankHealthy"], ci["Lamar Jackson"]["rankWithout"]) == (3, 3) and (ci["Edgerrin Cooper"]["rankHealthy"], ci["Edgerrin Cooper"]["rankWithout"]) == (5, 7)
assert (ci["Mike Evans"]["rankHealthy"], ci["Mike Evans"]["rankWithout"]) == (9, 10) and (ci["Travis Etienne"]["rankHealthy"], ci["Travis Etienne"]["rankWithout"]) == (6, 7)
assert (ci["Jaxson Dart"]["rankHealthy"], ci["Jaxson Dart"]["rankWithout"]) == (8, 10)
assert max(ci.values(), key=lambda c: c["lineupDrop"])["player"] == "Tyler Warren" and sorted(c["lineupDrop"] for c in ci.values())[-2] == ci["Mason Graham"]["lineupDrop"]
assert ci["Tyler Warren"]["owner"] == "Brian Cross" and ci["Mason Graham"]["owner"] == "Matt Gerardi"

# ---- chat ----
Q = json.load(open(os.path.join(D, "chat_quotes.json")))
CH = Q["channel"]
QS = {}


def rcpt(mid):
    q = Q["quotes"][mid]
    F.claims["nar:quote:" + mid] = {"shown": q["text"], "source": "D1 ups_discord_messages (archived #the-coffee-shop), verbatim by message id %s" % mid, "value": q["text"]}
    return ('<a class="rcpt" href="https://discord.com/channels/%s/%s/%s" target="_blank" rel="noopener" title="%s &middot; #%s &middot; %s">&ldquo;%s&rdquo;</a>'
            % (CH["guild"], CH["channel_id"], mid, q["owner"], CH["name"], q["when"].replace(",", ","), H.escape(q["text"], quote=False)))


for key, mid in (("q_blake", "1561522953680851149"), ("q_cutting", "1561459943553630411"), ("q_bousquet", "1561432958588686430"),
                 ("q_josh", "1561433803342221474"), ("q_cross", "1561522868435816449")):
    F[key] = rcpt(mid)
sup = Q["supplied"]
for k, who in (("commish", "UPS Commish"), ("blake", "Shawn Blake")):
    F.claims["nar:supplied:" + k] = {"shown": sup[k], "source": "supplied by the editor (Keith) 2026-10-21; not yet in the archived chat", "value": sup[k]}
F["q_commish"] = "&ldquo;%s&rdquo;" % H.escape(sup["commish"], quote=False)
F["q_blake_pron"] = "&ldquo;%s&rdquo;" % H.escape(sup["blake"], quote=False)

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


def det(summary, inner):
    return '<div class="wire-fig"><details><summary>%s</summary>%s</details></div>' % (summary, inner)


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


NINE = '<div class="tablebox"><table><thead><tr><th>Team</th><th>Record</th><th>All-Play</th><th>Points for</th><th>Wins vs expected</th><th>Week 6</th></tr></thead><tbody>%s</tbody></table></div>'
nine_rows = "".join('<tr><td>%s</td><td class="num">{rec_%s}</td><td class="num">{ap_%s}</td><td class="num">{pf_%s}</td><td class="num">{wve_%s}</td><td class="num">{sc_%s}, {wins6_%s}&ndash;{loss6_%s}</td></tr>'
                    % (OWN[f], *([TAG[f]] * 7)) for f in ("0010", "0008", "0012", "0011"))
for f in team:
    F.add("loss6_" + TAG[f], str(3 - R.wins[f]), R.MFLW6)

# ======================================================================= the sections
S = []

# 1 -- The Big Story
BEAR_ROWS = "".join('<tr><td>Week %d</td><td class="num">{bw%d_sc}</td><td class="num">{bw%d_rk}</td><td class="num">{bw%d_ap}</td><td class="num">{bw%d_h2h}</td></tr>' % ((w,) * 5) for w in range(1, 7))
BEAR_TAB = ('<div class="tablebox"><table><thead><tr><th>Bear Dunn</th><th>Score</th><th>League rank</th><th>All-Play</th><th>Head-to-head</th></tr></thead><tbody>'
            + BEAR_ROWS + '<tr><td><b>Weeks 1&ndash;6</b></td><td class="num"><b>{bear_avg} avg</b></td><td class="num"></td><td class="num"><b>{ap_bear}</b></td><td class="num"><b>{rec_bear}</b></td></tr></tbody></table></div>'
            '<p class="caption">Season to date, Weeks 1 to 6. League rank is Bear&rsquo;s score among the 12 teams that week.</p>')
S.append(wrap("story", "The Big Story", label(1, "The Big Story", "Bear Dunn is lapping the league") + desk(
    ("Stuart", "Six weeks in, the question in this league is no longer whether anyone can catch Bear Dunn. It is what anyone is playing for. Start with the whole season, Weeks 1 to 6: Bear is {rec_bear}, {ap_bear} against the field, and averages {bear_avg} a week, {bear_avg_gap} more than the next-best team, Shawn Blake, at {blak_avg}.")) + BEAR_TAB + desk(
    ("Rich", "Has Bear been dominant since Week 1? Almost. Week 1 was the one miss: {bw1_sc}, {bw1_rk} in the league and {bw1_ap} against the field. Since then it is {bear_w26} over Weeks 2 to 6, and never lower than second in scoring. Week 6 itself was {bw6_sc}, the best score of the week, a 3&ndash;0 week and {bw6_ap} against the field."),
    ("Stuart", "And the stretch everyone is going to talk about?"),
    ("Rich", "That is a separate measurement, a streak and not the season. Over the last four weeks, Weeks 3 to 6, Bear is {bear_w36} against the field, with a clean 11&ndash;0 in Weeks 3, 5 and 6."),
    ("Rich", "On the standings page, the next two teams in the Dog Pound, Bear&rsquo;s division, Chris Klingenberg and Eric Mannila, are both {r97}. The forecast gives Bear {div_bear} to win the division and {po_bear} to make the playoffs, so the division is close to settled."),
    ("Stuart", "Then what is left?"),
    ("Rich", "The bye. The top two seeds skip the first round, and Bear is at {bye_bear} to take one. The other one is open: Eric Martel {bye_emar}, Brian Cutting {bye_cutt}, Shawn Blake {bye_blak}. Nobody else is above {bye_whit}."),
    ("Kenny", "In Week 6, Bear&rsquo;s biggest margin, {m_bear_jmar}, came against Josh Martel. Josh scored {sc_jmar}, the lowest score of the week, and also made {chat_josh} of the {chat_total} owner posts in the chat since last Thursday night, more than any other owner. Rich says correlation is not our department."),
    ("Stuart", "So one bye is spoken for, three teams are chasing the other, and the middle of the league is getting squeezed."))))

# 2 -- The Middle Gets Squeezed
S.append(wrap("middle", "The Middle Gets Squeezed", label(2, "The Middle Gets Squeezed", "four teams at {r97}") + desk(
    ("Stuart", "Below Bear the standings pile up. Eric Martel is {rec_emar}, Derrick Whitman is {hi6}, Brian Cutting is {r88}, and there are exactly four teams at {r97}: Shawn Blake, Keith Creelman, Chris Klingenberg and Eric Mannila."),
    ("Rich", "Same record, four different teams. The table shows how different.")) + NINE % nine_rows + '<p class="caption">Record, All-Play, points for and wins vs expected are season to date, Weeks 1 to 6. The last column is Week 6 alone.</p>' + desk(
    ("Rich", "Over Weeks 1 to 6, Blake is the strongest of the four on everything except the record: {ap_blak} in All-Play and {pf_blak} points, second only to Bear. His record is {wvea_blak} wins short of what his weekly scores predict, the largest gap in the league. Mannila is the mirror image. {ap_mann} in All-Play is the worst of the four, and the record is {wvea_mann} wins better than the scores predict, the most in the league."),
    ("Stuart", "And Week 6 shows how that happens. Mannila and Klingenberg each went 3&ndash;0."),
    ("Rich", "Against the same three teams. In Week 6, Ryan Bousquet, Keith Creelman and Josh Martel each played Bear, Mannila and Klingenberg, and the three of them went {dog09}. Mannila scored {sc_mann}, sixth in the league that week, and Klingenberg {sc_klin}, seventh. Their All-Play for Week 6 was {ap6_mann} and {ap6_klin}. Neither scored like a team that sweeps. Both swept."),
    ("Stuart", "So who is actually good?"),
    ("Rich", "Blake, first. Mannila, last. Between them, Chris Klingenberg is one All-Play win ahead of Keith Creelman, and Creelman is ahead on points. Keith also leads Maddie Mondays, which is why {po_keit} to make the playoffs is a better number than the All-Play record suggests: a division title is the way in.")) +
    det("Full standings after Week 6, and the Week 6 forecast graded", inner("landscape"))))

# 3 -- Playoff Picture
S.append(wrap("odds", "Playoff Picture", label(3, "Playoff Picture", "updated after Week 6") + desk(
    ("Stuart", "{sims} simulated seasons, run fresh through Week 6. Rich, start with the part nobody is arguing about."),
    ("Rich", "Bear: {po_bear} to make the playoffs, {bye_bear} for a bye and {title_bear} for the title, the best title odds in the league. With the Dog Pound at {div_bear} for Bear, Klingenberg ({po_klin}) and Mannila ({po_mann}) are playing for a wild card, and wild cards go by All-Play. That is why Mannila, who is {r97} with the worst All-Play of the four, is at {po_mann} while Klingenberg, same record, is at {po_klin}."),
    ("Stuart", "Legion of Boom is the strange one. Derrick Whitman is {hi6}, a game ahead of Shawn Blake, and the forecast gives Blake the division, {div_blak} to {div_whit}."),
    ("Rich", "The forecast plays each team&rsquo;s best lineup every week. Built from 2026 points per game with everyone healthy, Blake&rsquo;s best lineup is {hl_blak} a week, second only to Bear&rsquo;s {hl_bear}. Whitman&rsquo;s is {hl_whit}, fifth. Whitman has the record and records count in a division race, so he keeps {div_whit}. But the 0&ndash;3 week was more a lineup problem than a talent problem, and the forecast is betting on talent."),
    ("Stuart", "And Outlast PG Time?"),
    ("Rich", "Eric Martel {div_emar}, Brian Cutting {div_cutt}. Martel is {rec_emar} and Cutting is {r88}, but Cutting&rsquo;s best healthy lineup, {hl_cutt} a week, is third in the league, and the forecast has Cutting at {po_cutt} to make the playoffs and {title_cutt} to win the title, second only to Bear. Last week the forecast said good roster, bad Sundays. It still does."),
    ("Stuart", "Keith Creelman?"),
    ("Rich", "Keith Creelman is at {div_keit} to win Maddie Mondays and {po_keit} to make the playoffs, almost all of it through the division, which goes by record. Ryan Bousquet is at {div_bous} to win it. So Blake ({po_blak}) and Keith are the favorites for the next spots, Whitman ({po_whit}) and Klingenberg ({po_klin}) are close to coin flips, and Bousquet ({po_bous}) needs a run.")) +
    inner("odds")))

# 4 -- Heat Check
S.append(wrap("heat", "Heat Check", label(4, "Heat Check", "season to date, Weeks 1&ndash;6, and Weeks 4&ndash;6") + desk(
    ("Stuart", "Heat Check asks who is rising, who is cooling, and whether the record agrees. It compares every team over the same two windows: the season to date, Weeks 1 to 6, and the recent stretch, Weeks 4 to 6. Start at the top. Bear Dunn is {ap_bear} on the season and {hc_bear} over Weeks 4 to 6, the only team the chart calls Dominant, and first in scoring over Weeks 4 to 6 after ranking third in Weeks 1 to 3."),
    ("Rich", "Shawn Blake is the opposite case. Holding, {hc_blak} over Weeks 4 to 6, third in scoring over those weeks, {ap_blak} on the season, and a best lineup that ranks second in the league. Then 0&ndash;3 in Week 6 with {left_blak} points left on the bench. Losses this season that his best lineup would have won: {blw_blak}. The scores say contender. The results say otherwise."),
    ("Stuart", "Eric Mannila and Chris Klingenberg are the mirror. Mannila is Rising: tenth in scoring over Weeks 1 to 3, sixth over Weeks 4 to 6. Klingenberg is Holding, {hc_klin} over Weeks 4 to 6, and slid from seventh in scoring to ninth. Both are {r97}."),
    ("Rich", "Season to date, their records are better than their scores: {wvea_mann} wins better for Mannila, {wvea_klin} for Klingenberg. You still have to win the games you play. But those {r97} records carry more luck than Blake&rsquo;s."),
    ("Stuart", "Then there is Keith Creelman&rsquo;s fall, week to week. {keit_w5} in Week 5, {sc_keit} in Week 6, a drop of {keit_drop}, the biggest in the league."),
    ("Rich", "Puka Nacua was the Week 5 engine with {nacua_w5}. In Week 6 he scored {nacua} against a projection of {nacua_w6_proj}."),
    ("Stuart", "Eric Martel is Cooling: first in scoring over Weeks 1 to 3, fifth over Weeks 4 to 6, though {rec_emar} and {ap_emar} on the season still look sturdy. And at the bottom, Josh Martel is Sinking: {hc_jmar} against the field over Weeks 4 to 6, {ap_jmar} on the season, and {sc_jmar} in Week 6. The Survival Line has the rest.")) +
    det("The Heat Check tables", inner("heat", drop_gap=True))))

# 5 -- Week 6 in Brief
zeros = "Cam Skattebo and D.J. Moore for Matt Gerardi, Brian Thomas Jr. for Josh Martel, Darren Waller and Najee Harris for Ryan Bousquet, and Juwan Johnson for Eric Martel"
S.append(wrap("brief", "Week 6 in Brief", label(5, "Week 6 in Brief", "Boomer, the plays, every result") + desk(
    ("Stuart", "Boomer, give us the week."),
    ("Boomer", "Thanks, Stu! Trevor Lawrence! 24-of-41 for 306 yards, four touchdowns, one interception and 11 more on the ground: {law} UPS points for Brian Cross, the biggest score of the week!"),
    ("Boomer", "Tyler Shough! {sho} points for Derrick Whitman, and Whitman swept all three games!"),
    ("Boomer", "Malik Nabers! 12 catches on 15 targets for 165 yards, {nab} points for Eric Mannila, and look at that, another sweep!"),
    ("Boomer", "Now Eric Martel. C.J. Stroud {stroud}. Kenneth Walker III {walker}. Michael Penix Jr. {penix}. That is {emar_trio} points from three players, and Martel LOST to Derrick Whitman!"),
    ("Boomer", "Bear Dunn? Christian McCaffrey {mcc}, Jaxon Smith-Njigba {jsn}, {bear_duo} from two players, and that is how you get to {sc_bear}!"),
    ("Boomer", "And Brian Cutting got {maye} from Drake Maye, which brings us to the chat."),
    ("Kenny", "Sunday, 3:24 PM, Brian Cutting: {q_cutting} The answer, Brian, is no. Drake Maye has the receipts."),
    ("Rich", "Boomer, you left out the other end of the week. Count the starters who scored 0.2 or less: {n_zero}. " + zeros.capitalize()[:1] + zeros[1:] + ". Juwan Johnson started in the same lineup as Stroud, Walker and Penix."),
    ("Boomer", "Zeros do not make the highlight reel, Rich."),
    ("Kenny", "Sunday, 1:37 PM, Ryan Bousquet: {q_bousquet}. The final count was {najee} UPS points. He was right."),
    ("Boomer", "Two plays made the board. Both are below, with the NFL highlights."),
    ("Rich", "One more thing before the results. In {n_flips} of the {n_games} games, the losing side&rsquo;s best possible lineup would have beaten the winner&rsquo;s actual score. That is the next segment.")) +
    inner("plays") + h3("Every Week 6 result") + inner("desk")))

# 6 -- Who Actually Won the Week
S.append(wrap("weeks", "Who Actually Won the Week", label(6, "Who Actually Won the Week", "the lineups that decided games") + desk(
    ("Stuart", "Points say who scored. Lineups say who decided. Rich, how many games did decisions change?"),
    ("Rich", "Games where decisions changed the result: {n_flips} of {n_games}, if you build each loser&rsquo;s best lineup from the same roster. That is hindsight. Nobody has that lineup on Sunday morning. But it shows where decisions mattered and where nothing could have helped."),
    ("Stuart", "Start with Shawn Blake, who went 0&ndash;3 with {sc_blak}."),
    ("Rich", "Blake&rsquo;s best lineup was {opt_blak}, which beats both Brian Cutting ({sc_cutt}) and Brian Cross ({sc_cros}). The big pieces were on the bench: DeVonta Smith with {dsmith} and Rashid Shaheed with {shaheed}. Smith and Shaheed in for Denzel Boston and Terry McLaurin is {blak_swap_gain} points, which is enough to flip the Cross game, lost by {m_cros_blak}. Smith alone would not have done it."),
    ("Kenny", "Sunday, 7:34 PM, Shawn Blake explained it himself: {q_blake}. D&rsquo;Marco Jackson scored {djack}."),
    ("Stuart", "In fairness, Smith had not played in either of the previous two games."),
    ("Rich", "Right. DeVonta Smith missed Weeks 4 and 5, so the caution had a reason. McLaurin, started Monday night while healthy, is a different story, and it is next."),
    ("Stuart", "Keith Creelman had the same problem from the other side. Michael Mayer scored {mayer} on Keith&rsquo;s bench."),
    ("Rich", "He was one of three. Chigoziem Okonkwo ({okonkwo}) and Stefon Diggs ({diggs}) sat there too, {keit_trio} between them. Keith&rsquo;s best lineup, {opt_keit}, would have beaten Chris Klingenberg ({sc_klin}) but not Eric Mannila ({sc_mann}). Mayer alone would not have flipped anything."),
    ("Stuart", "The closest call was Eric Martel."),
    ("Rich", "{sc_emar} against Whitman&rsquo;s {sc_whit}. Martel&rsquo;s best lineup, {opt_emar}, wins by {emar_miss}. Juwan Johnson ({jjohnson}) and Ladd McConkey ({mcconkey}) started while Keenan Allen ({kallen}) and Mason Taylor ({mtaylor}) sat, a swing of {emar_swap_gain}. Whitman left {whit_left} of his own on the bench, Omar Cooper Jr. ({ocooper}) among it, so the margin was never going to be fair."),
    ("Stuart", "And Chris Klingenberg?"),
    ("Rich", "Klingenberg won three games with {sc_klin}, and every opponent could have beaten that. Keith&rsquo;s best lineup was {klin_opp_kc}, Ryan Bousquet&rsquo;s {klin_opp_bous}, Josh Martel&rsquo;s {klin_opp_jmar}. Josh missed Eric Mannila&rsquo;s {sc_mann} by {josh_miss}."),
    ("Stuart", "And the games lineups could not touch?"),
    ("Rich", "Anyone who played Bear. No opponent&rsquo;s best lineup came within reach of {sc_bear}.")) +
    det("Projected versus actual: every start, graded", inner("bb"))))

# 7 -- Player and Team Stories
S.append(wrap("players", "Player and Team Stories", label(7, "Player and Team Stories", "what changed and what happens next") + desk(
    ("Stuart", "Four stories, and the first one threw for four touchdowns.")) +
    h3("1. Brian Cross rides Trevor Lawrence") + desk(
    ("Stuart", "Brian Cross is {rec_cros}, and had a good week anyway: {law} from Trevor Lawrence, {ber} from Germie Bernard, and a 2&ndash;1 record."),
    ("Rich", "Lawrence and Bernard supplied {cros_law_ber} of Cross&rsquo;s {sc_cros}. Lawrence alone was {cros_law_share} of the score. Replace him with the best legal option on the bench, George Holani at {holani}, and Cross scores {cros_nolaw}. That still beats Matt Gerardi, by {cros_nolaw_gera}, but loses to Shawn Blake by {cros_nolaw_blak}. Lawrence turned 1&ndash;2 into 2&ndash;1."),
    ("Kenny", "Sunday, 7:34 PM, Brian Cross, on the subject of the couch: {q_cross} By his account he promoted Germie Bernard from the taxi squad. Bernard scored {ber}, Brian. It was a pretty good day."),
    ("Rich", "A good week does not undo {rec_cros}. Cross is at {po_cros} to make the playoffs.")) +
    h3("2. Derrick Whitman gets Tyler Shough") + desk(
    ("Stuart", "Derrick Whitman is {hi6}, went 3&ndash;0 with {sc_whit}, and the quarterback behind it was Tyler Shough with {sho}."),
    ("Rich", "In the Week 5 report, four of Whitman&rsquo;s seven wins rested on Shough. This week he decided none. Put the best legal bench option in his place, Omar Cooper Jr., and Whitman scores {whit_nosho} and still sweeps; the closest game is still a win by {whit_nosho_emar}. What Shough bought was margin."),
    ("Stuart", "So Whitman is real?"),
    ("Rich", "Whitman is the cleanest case in the middle. This season the record is within {wvea_whit} wins of what the scores deserve, and a best lineup of {hl_whit} is fifth in the league. The forecast has Whitman at {po_whit} because Blake is better on paper, not because Whitman is lucky.")) +
    h3("3. Eric Mannila gets Malik Nabers") + desk(
    ("Stuart", "Eric Mannila went 3&ndash;0 on 12 catches, 15 targets and 165 yards from Malik Nabers, {nab} points."),
    ("Rich", "Last week&rsquo;s report found that CeeDee Lamb and Bijan Robinson supplied about a third of Mannila&rsquo;s edge, and that when they combined for {mann_w5_stars} Mannila lost all three games. This week they combined for {mann_stars}. Nabers supplied the cover. Take him out for the best legal bench option, Keon Coleman at {coleman}, and Mannila still scores {mann_nonab}, at least {mann_nonab_min} ahead of every opponent. Nabers made the sweep comfortable. He did not make it possible."),
    ("Stuart", "Mannila&rsquo;s trouble is at quarterback, which comes up in the injuries.")) +
    h3("4. Terry McLaurin, and the Blake problem that is not the one you think") + desk(
    ("Stuart", "Monday night. Terry McLaurin caught one pass for 27 yards for Shawn Blake, scored {mclaurin_w6} UPS points and left the game at San Francisco hurt."),
    ("Rich", "Let&rsquo;s be clear about what this is not. It is not a lineup mistake. McLaurin was healthy when Blake started him and he was hurt in the game. The question is how much the loss hurts, and whether Blake has the depth."),
    ("Stuart", "Start with the status."),
    ("Rich", "MFL&rsquo;s injury feed, updated Wed Oct 21, 8:01 AM ET, lists McLaurin Out with a knee injury, expected back Feb 15, 2027. That is MFL&rsquo;s listing, not an NFL designation. Washington&rsquo;s Week 7 report was not in the official data when we checked at 9:47 AM ET, and Washington is on its bye in Week 7 anyway."),
    ("Stuart", "So how much does he matter?"),
    ("Rich", "He averages {mc_ppg} a game, {mc_rkp}th among receivers in points per game, and he is not in Blake&rsquo;s best healthy lineup. DeVonta Smith ({smith_ppg} a game) and Drake London hold the receiver spots, with Denzel Boston and Brenton Strange in the flex spots. Blake&rsquo;s best lineup is {blake_lu} a week with McLaurin or without him, second in the league either way."),
    ("Kenny", "In the Coffee Shop, the bot attached a footnote to the McLaurin news. UPS Commish: {q_commish} Shawn Blake: {q_blake_pron}"),
    ("Kenny", "The model still has no projection for Shawn&rsquo;s final decision. It does have Blake at {po_blak} to make the playoffs."),
    ("Rich", "And that number barely moves. Run the same simulation, same inputs and same seed with McLaurin healthy and Blake is at {blake_cfpo}. The gap is {blake_po_gap} points. What moves Blake&rsquo;s season is the calendar. In Week 7, Josh Allen, Bhayshul Tuten and Brenton Strange are on their bye, and so is Washington. Brock Purdy is the only quarterback on the active roster, and the best lineup Blake can field is {blake_wk7}, {blake_wk7gap} below normal."),
    ("Stuart", "So is Blake in trouble?"),
    ("Rich", "Not from McLaurin. From a bye week. Blake is one of four teams at {r97}, and Blake&rsquo;s {ap_blak} All-Play this season is the best of the four.")))) 

# 8 -- Injury Watch
S.append(wrap("injuries", "Injury Watch", label(8, "Injury Watch", "who is hurt and what it changes") + desk(
    ("Rich", "We checked every starter-caliber injury on every roster, {n_board} of them. &ldquo;Starter-caliber&rdquo; means a player belongs in his team&rsquo;s best legal lineup when healthy, based on 2026 scoring, not that he started last week. Most change nothing. Five change a race. Terry McLaurin, the one everybody asked about, is in the Blake story above: depth enough."),
    ("Stuart", "Start with the contenders."),
    ("Rich", "Brian Cutting&rsquo;s Lamar Jackson ({lj_ppg} a game) is MFL-listed Questionable with an ankle injury; officially he was Out for Week 6. Aaron Rodgers ({lj_rep} a game) steps in, and Cutting&rsquo;s best lineup goes from {lj_lu1} to {lj_lu2}, a loss of {lj_drop}. It stays third in the league. Workable."),
    ("Rich", "Derrick Whitman&rsquo;s Edgerrin Cooper ({ec_ppg} a game) is on MFL injured reserve with an Achilles injury, expected back Feb 15, 2027. Akeem Davis-Gaither ({ec_rep}) steps in, Whitman&rsquo;s lineup goes from {ec_lu1} to {ec_lu2}, and the rank slides from fifth to seventh. Linebacker Foyesade Oluokun is on his bye in Week 7."),
    ("Rich", "Chris Klingenberg&rsquo;s Mike Evans ({me_ppg} a game) is MFL-listed Questionable with an Achilles injury; officially he was Questionable and played. Rhamondre Stevenson ({me_rep}) is next, the lineup goes from {me_lu1} to {me_lu2}, and Evans has his bye in Week 8. Free agent Tre Tucker ({me_fa} a game) is {me_fabeat} better than Stevenson, a waiver look for a team at {po_klin}."),
    ("Rich", "Keith Creelman&rsquo;s Travis Etienne ({te_ppg} a game) is on MFL injured reserve with a hamstring injury, expected back Nov 8, 2026. TreVeyon Henderson ({te_rep}) steps in and the lineup goes from {te_lu1} to {te_lu2}, sixth to seventh. Saquon Barkley, Trey Benson and Will Shipley are also on the MFL injury list at running back."),
    ("Stuart", "And Mannila?"),
    ("Rich", "Eric Mannila&rsquo;s Jaxson Dart ({jd_ppg} a game) is on MFL injured reserve with a meniscus injury, expected back Jan 17, 2027. Justin Herbert ({jd_rep}) is next and the lineup goes from {jd_lu1} to {jd_lu2}, eighth to tenth. Free agent Drew Lock averages {jd_fa} in two games, {jd_fabeat} better than Herbert. At {po_mann}, that needs a waiver look."),
    ("Rich", "The two biggest losses in the league are on the two bottom teams. Brian Cross loses tight end Tyler Warren ({tw_drop} a week) and Matt Gerardi loses Mason Graham ({mg_drop}). Neither moves a season at {po_cros} and {po_gera}."),
    ("Stuart", "Every status here is MFL&rsquo;s listing as of Wed Oct 21, 8:01 AM ET. Official Week 7 designations had not posted for most teams when we checked at 9:47 AM ET; only New England and Chicago were in. They are not the same thing, and we will refresh before publication.")) +
    det("Full injury board: all {n_board} starter-caliber injuries".replace("{n_board}", "20"), inner("injuries"))))

# 9 -- Survival Line
S.append(wrap("survival", "The Survival Line", label(9, "The Survival Line", "what a Week 6 position has meant") + desk(
    ("Stuart", "Now the bottom. Josh Martel and Matt Gerardi are both {rec_jmar}, Brian Cross is {rec_cros}, and the forecast gives them {po_jmar}, {po_gera} and {po_cros}."),
    ("Rich", "History agrees. For Josh Martel and Matt Gerardi, {svap_jmar} teams in the same All-Play spot went on to make the playoffs, and {svw_jmar} with the same win total. For Cross, {svap_cros} and {svw_cros}."),
    ("Stuart", "Josh Martel first."),
    ("Rich", "Last in scoring in Week 6, at {sc_jmar}, {ap6_jmar} in All-Play for the week, {hc_jmar} over Weeks 4 to 6 and {ap_jmar} on the season. The best lineup, {opt_jmar}, missed Mannila by {josh_miss}, so {left_jmar} points were left on the bench."),
    ("Kenny", "Sunday, 1:40 PM, Josh Martel: {q_josh}. MarShawn Lloyd, projected {lloyd_proj}, scored {lloyd}. The committee has reviewed the evidence."),
    ("Stuart", "Matt Gerardi?"),
    ("Rich", "{sc_gera} and 0&ndash;3, with the best bargain of the week: Matthew Golden, projected {golden_proj}, scored {golden}. Cam Skattebo and D.J. Moore both scored {skattebo}."),
    ("Stuart", "And Brian Cross, who just got a gift?"),
    ("Rich", "Lawrence changed Cross&rsquo;s week, not his season: {sc_cros} and 2&ndash;1, against {cros_nolaw} and 1&ndash;2 without him. Cross is still {rec_cros} with {po_cros}. Teams in that spot do not get out of it on one good week.")) +
    det("The Survival Line table", inner("survival"))))

# 10 -- Elias
S.append(wrap("elias", "Elias changes", label(10, "Elias changes") + desk(
    ("Stuart", "Not yet Elias-final. The official Week 6 stat changes had not posted when this report was written (checked Wed Oct 21, 10:06 AM ET). The scores above are the ones MFL showed Wednesday morning."),
    ("Rich", "Same as last week: if Elias moves a UPS score, the report is corrected here, and the league hears about it only if an All-Play record changes. The Elias segment is the one piece still to come."))))

# ======================================================================= assemble
head, rest = SRC.split('<section class="wire-sec" id="open"', 1)
tail = rest[rest.rindex("</section>") + len("</section>"):]
head = head.replace('<div class="wire-eyebrow">Week 6 recap</div>', '<div class="wire-eyebrow">Week 6</div>')
head = head.replace("Kenny Mayne in the Coffee Shop", "Kenny Mayne with receipts from the league chat")
head = re.sub(r'<p class="wire-dek">[\s\S]*?</p>',
              '<p class="wire-dek">Bear Dunn is lapping the league, four teams are stuck at {r97}, and Terry McLaurin&rsquo;s injury turns out to be the smaller problem on Shawn Blake&rsquo;s roster.</p>', head)
tail = re.sub(r"<b>Sources\.</b>[\s\S]*?</div>", "<b>Sources.</b> MFL scores, standings, schedules, transactions, injury feed and Elias posts; the league&rsquo;s D1 copies, checked against MFL; MFL projections as saved before each kickoff; nflverse expected points and official injury reports; the archived league Discord.</div>", tail, count=1)
tail = re.sub(r"<b>Status\.</b>[\s\S]*?</div>", "<b>Status.</b> Automated draft (ups_center_auto.py), generated Wed Oct 21, 10:05 AM ET, rewritten by the editor. Not published.</div>", tail, count=1)
tail = re.sub(r"<b>Editor review\.</b>[\s\S]*?</div>", "<b>Still to come.</b> The Elias segment: the official Week 6 stat changes had not posted when this report was written.</div>", tail, count=1)
body = "".join(S)

# render the facts into the prose only (the page shell, CSS and runtime are never touched)
def render(s):
    return re.sub(r"\{(\w+)\}", lambda m: str(F[m.group(1)]), s)


head = render(head)
body = render(body)
article = head + body + tail
out = sys.argv[1]
open(out, "w", encoding="utf-8").write(article)
used = {k for k in F.used}
claims = {k: v for k, v in F.claims.items() if k.startswith("nar:quote:") or k.startswith("nar:supplied:") or k[4:] in used}
json.dump(claims, open(os.path.join(D, "narrative_claims.json"), "w"), indent=1, ensure_ascii=False, sort_keys=True)
print("wrote", out, len(article), "bytes;", len(claims), "narrative claims")
