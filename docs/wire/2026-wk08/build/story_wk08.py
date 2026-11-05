#!/usr/bin/env python3
"""Week 8 story build (Keith, 2026-11-05: story-driven approach, Timing 1).
  python3 story_wk08.py <base.html> <out.html>
base = the automated draft with its editor boxes resolved (Elias folded in, Kenny's three lines in).
Adds two story segments built from alltime_start.json (alltime_start.py), keeps the draft's tables, and renumbers segments.
Every number below is from alltime_start.json or the draft's own tables (Week 8 scores, odds)."""
import json, os, re, sys
D = os.path.dirname(os.path.abspath(__file__))
A = json.load(open(os.path.join(D, "alltime_start.json")))
base, out = sys.argv[1], sys.argv[2]
t = open(base).read()

top = A["top8"][:4]
assert [(x["season"], x["owner"], x["w"], x["l"]) for x in top] == [(2018, "Josh Martel", 84, 4), (2013, "Derrick Whitman", 73, 15), (2015, "Derrick Whitman", 72, 16), (2021, "Josh Martel", 70, 18)]
assert A["team_seasons"] == 180 and A["n_at_or_below_250"] == 13 and A["n_wk7_below_182"] == 3 and A["n_wk7_tied_182"] == 1
assert round(78 / 88, 3) == 0.886 and round(84 / 88, 3) == 0.955
fin = {2018: "Lost the final", 2013: "Champion", 2015: "Third", 2021: "Third"}
assert [x["final"] for x in top] == [2, 1, 3, 3]
bear_old = {x["season"]: (x["w"], x["l"]) for x in A["bottom8"] if x["owner"] == "Bear Dunn"}
assert bear_old == {2021: (22, 66), 2017: (21, 67)}
josh_prev = {x["season"]: (x["w"], x["l"]) for x in A["bottom8"] if x["owner"] == "Josh Martel"}
assert josh_prev == {2022: (23, 65)}

L = lambda who, txt: '<div class="lt %s"><div class="who">%s</div><p>%s</p></div>' % (who.lower(), who, txt)
row = lambda cells: "<tr>" + "".join("<td%s>%s</td>" % (' class="num"' if i else "", c) for i, c in enumerate(cells)) + "</tr>"
def table(head, rows): return '<div class="tablebox"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % ("".join("<th>%s</th>" % h for h in head), "".join(rows))

big = (
 '<section class="wire-sec" id="bigstory" data-title="The Big Story"><div class="label"><span class="seg">1</span> The Big Story <small>&mdash; Bear Dunn is on a historic pace</small></div>'
 '<div class="desk-lines">'
 + L("Stuart", "Bear Dunn scored 307.6 in Week 8, the best score of the week, and beat all eleven teams in All-Play. He swept both games: Eric Mannila by 89.5 and Chris Klingenberg by 78.4. He is 19&ndash;2 overall and 78&ndash;10 in All-Play.")
 + L("Rich", "Here is what 78&ndash;10 means. Since 2011, 180 teams have reached Week 8 with a full record in the league archive. Exactly one had a better All-Play record at this point: Josh Martel&rsquo;s 2018 team, which was 84&ndash;4.")
 + L("Stuart", "That is .886 for Bear. Martel&rsquo;s 2018 start was .955. After Bear, the next-best starts are Derrick Whitman&rsquo;s 2013 team at 73&ndash;15 and his 2015 team at 72&ndash;16, then Martel again in 2021 at 70&ndash;18.")
 + '</div>'
 + table(["Best All-Play starts through Week 8, 2011&ndash;2026", "Through Week 8", "Pct", "How the season ended"],
         [row(["2018 &middot; Josh Martel", "84&ndash;4", ".955", "Lost the final"]), row(["<b>2026 &middot; Bear Dunn</b>", "<b>78&ndash;10</b>", "<b>.886</b>", "<b>In progress</b>"]),
          row(["2013 &middot; Derrick Whitman", "73&ndash;15", ".830", "Champion"]), row(["2015 &middot; Derrick Whitman", "72&ndash;16", ".818", "Third"]), row(["2021 &middot; Josh Martel", "70&ndash;18", ".795", "Third"])])
 + '<p class="caption">All-Play counts every team&rsquo;s weekly score against all eleven others, Weeks 1&ndash;8 of the regular season. Source: the league archive of weekly results, 2011&ndash;2025, plus the 2026 standings. 2010 is left out because its archived weekly scores conflict with themselves. The finish is the archive&rsquo;s final standing.</p>'
 '<div class="desk-lines">'
 + L("Rich", "And 2018 is the part worth sitting with. That team finished 25&ndash;1 with a 155&ndash;21 All-Play record, the best full season in the archive, and still lost the final. A great start is not a title.")
 + L("Stuart", "Bear knows both ends of this. In 2017 he was 21&ndash;67 in All-Play at this point, and in 2021 he was 22&ndash;66. Now he is 78&ndash;10, with a 99.8% chance at the first-round bye and a 39.3% chance at the title in the forecast. The next best title odds belong to Brian Cutting at 23.2%.")
 + '</div></section>'
)

B = "https://discord.com/channels/1057655884475531324/1087157907419840644/"
def rcpt(mid, who, when, q): return '<a class="rcpt" href="%s%s" target="_blank" rel="noopener" title="%s &middot; #the-coffee-shop &middot; %s">&ldquo;%s&rdquo;</a>' % (B, mid, who, when, q)
CROSS1 = rcpt("1566568815964455043", "Brian Cross", "Sun Nov 1, 4:45 PM ET", "Trevor Lawrence is up for sale !!")
CROSS2 = rcpt("1566607668976689325", "Brian Cross", "Sun Nov 1, 7:19 PM ET", "#My Taxi Squad ..")
BEAR = rcpt("1566566446878957589", "Bear Dunn", "Sun Nov 1, 4:35 PM ET", "Ryan, did Burrow ever have a game like this for you?")
KEITH = rcpt("1566083255793614949", "Keith Creelman", "Sat Oct 31, 9:35 AM ET", "6.4 &gt; the 2.7 I&#x27;m currently getting")

div_week = (
 '<section class="wire-sec" id="divweek" data-title="Division Week"><div class="label"><span class="seg">2</span> Division Week <small>&mdash; four triangles, four sweeps, one playoff race</small></div>'
 '<div class="desk-lines">'
 + L("Stuart", "Every game in Week 8 was played inside a division: four triangles of three teams, twelve games in all, and the same script in each one. One team swept. One split. One went home with nothing.")
 + L("Rich", "<b>Dog Pound.</b> Bear Dunn is the sweep, and you know that part. The pain is on the other side. Eric Mannila got 38.5 from Tyler Allgeier and 36.3 from Kirk Cousins and went 0&ndash;2 anyway. He lost to Chris Klingenberg by 11.1, and his best possible lineup, 244.5, would have won that game. Klingenberg split, and he is 13&ndash;8 overall but 1&ndash;5 against his own division. Everything he has won, he has won somewhere else.")
 + L("Kenny", "Sunday, 4:35 PM, Bear Dunn: " + BEAR + " Bear scored 307.6 this week and posted three times.")
 + L("Stuart", "<b>Outlast PG Time.</b> Eric Martel scored 243.5, with 35.5 from Ja&rsquo;Marr Chase on 11 catches, and beat Brian Cutting by 39.6 and Brian Cross by 61.7. That makes him 6&ndash;0 against his own division. Cutting beat Cross by 22.1 and is 12&ndash;9, and the forecast gives him a better title chance, 23.2%, than Martel, 18.6%. Cross is 0&ndash;6 inside the division and 0.0% to make the playoffs.")
 + L("Kenny", "Sunday, 4:45 PM, Brian Cross: " + CROSS1 + " Then, at 7:19 PM: " + CROSS2 + " Two hours and thirty-four minutes. Prediction: the sale sign is back up by Wednesday.")
 + L("Rich", "<b>Legion of Boom.</b> Shawn Blake scored 210.7 and beat Matt Gerardi by 24.1 and Derrick Whitman by 44.5. Gerardi beat Whitman by 20.4, behind 35.0 from Patrick Mahomes, so Whitman went 0&ndash;2 with the lowest score of the week, 166.2. Blake and Whitman are both 11&ndash;10, and the division is Blake&rsquo;s at 79.9% to Whitman&rsquo;s 20.0%. Blake&rsquo;s scoring rank has slid from second to seventh over the last three weeks, and he is still the one leading.")
 + L("Stuart", "<b>Maddie Mondays.</b> Josh Martel scored 218.5 and swept Keith Creelman by 35.0 and Ryan Bousquet by 4.2, the closest game of the week. Bousquet beat Creelman by 30.8. Everyone in the division is 3&ndash;3 against it, so the overall record decides it: Creelman leads at 10&ndash;11, Bousquet is 8&ndash;13 and Martel is 6&ndash;15.")
 + L("Rich", "Which makes Martel the story. Through Week 7 he was 14&ndash;63 in All-Play, tied for the fourth-worst start since 2011. This is the same owner who started 2018 at 84&ndash;4. Week 8 took him to 22&ndash;66, and 13 earlier teams were at that mark or worse by now, so he has climbed out of the all-time basement. It is still the worst start of his own career in the archive, one game under his 23&ndash;65 in 2022. He also led the chat this week with 17 posts.")
 + L("Kenny", "Saturday, 9:35 AM, Keith Creelman: " + KEITH)
 + '</div>'
 + table(["Division", "Swept (2&ndash;0)", "Split (1&ndash;1)", "Shut out (0&ndash;2)"],
         [row(["Dog Pound", "Bear Dunn 307.6", "Chris Klingenberg 229.2", "Eric Mannila 218.1"]), row(["Outlast PG Time", "Eric Martel 243.5", "Brian Cutting 203.9", "Brian Cross 181.8"]),
          row(["Legion of Boom", "Shawn Blake 210.7", "Matt Gerardi 186.6", "Derrick Whitman 166.2"]), row(["Maddie Mondays", "Josh Martel 218.5", "Ryan Bousquet 214.3", "Keith Creelman 183.5"])])
 + '<p class="caption">Week 8 scores after Elias corrections. Josh Martel&rsquo;s All-Play history uses the league archive of weekly results, 2011&ndash;2025 (2010 is left out because its archived scores conflict with themselves). Chat lines are owner posts in the league Discord, linked to the message.</p></section>'
)

elias = (
 '<section class="wire-sec" id="eliasnews" data-title="Elias: Half a Point"><div class="label"><span class="seg">3</span> Elias <small>&mdash; half a point moved the board</small></div>'
 '<div class="desk-lines">'
 + L("Stuart", "Breaking, and it is small. The league office posted 23 official stat changes for Week 8, and two of them touched a UPS starter. Tuli Tuipulotu picked up a second quarterback hit, which is a half point for Josh Martel. Dane Belton lost a tackle and gained an assist, and that cost Keith Creelman half a point.")
 + L("Rich", "Half a point, and it changed the table. Martel went from 218.0 to 218.5. Eric Mannila scored 218.1. Before the correction Mannila was ahead of Martel by a tenth. Now Martel is ahead by four tenths.")
 + L("Stuart", "That swapped one All-Play game between them. Martel&rsquo;s Week 8 All-Play went from 7&ndash;4 to 8&ndash;3, and Mannila&rsquo;s from 8&ndash;3 to 7&ndash;4. Their season All-Play records moved with it: Martel is 22&ndash;66, not 21&ndash;67, and Mannila is 41&ndash;47, not 42&ndash;46. Their Week 8 scoring ranks swapped too, Martel fourth and Mannila fifth.")
 + L("Rich", "Nobody&rsquo;s result flipped. Creelman&rsquo;s 183.5 is still above Cross&rsquo;s 181.8, so his All-Play did not move. Every number in this issue already counts the corrected scores.")
 + '</div>'
 + table(["Team", "Published Tue", "After Elias", "Change", "Week 8 All-Play"],
         [row(["Josh Martel", "218.0", "218.5", "+0.5", "7&ndash;4 &rarr; 8&ndash;3"]), row(["Eric Mannila", "218.1", "218.1", "0.0", "8&ndash;3 &rarr; 7&ndash;4"]), row(["Keith Creelman", "184.0", "183.5", "-0.5", "unchanged"])])
 + '<p class="caption">Source: MFL site news, Official Statistics Changes (23 items for Week 8), compared with the scores frozen when the recap was built. The league message goes out because an All-Play record changed.</p></section>'
)

def grab(id_):
    a = t.index('<section class="wire-sec" id="%s"' % id_)
    return t[a:t.index('</section>', a) + len('</section>')]
def strip_label(s):
    s = re.sub(r'<div class="label">.*?</div>', '', s, count=1, flags=re.S)
    s = re.sub(r'<div class="desk-lines".*?</div></div>(?=<)', '', s, count=1, flags=re.S)
    return re.sub(r'^<section[^>]*>|</section>$', '', s)

plays_src, bb_src = grab("plays"), grab("bb")
reel = plays_src[plays_src.index('<div class="reel">'):plays_src.rindex('</section>')]
assert 'editor-gap' not in reel
# the source wraps the reel in an outer div; slicing from the inner div leaves one stray </div>
while reel.count('</div>') > reel.count('<div'):
    k = reel.rindex('</div>'); reel = reel[:k] + reel[k + 6:]
bb_tables = bb_src[bb_src.index('<h3>'):bb_src.rindex('</section>')]
while bb_tables.count('</div>') > bb_tables.count('<div'):  # source wrapper's closing div
    k = bb_tables.rindex('</div>'); bb_tables = bb_tables[:k] + bb_tables[k + 6:]
plays = (
 '<section class="wire-sec" id="plays" data-title="The Plays That Made the Week"><div class="label"><span class="seg">5</span> The Plays That Made the Week <small>&mdash; the bargains, the busts, and who they carried</small></div>'
 '<div class="desk-lines">'
 + L("Stuart", "Start with the number nobody had. Joe Burrow was projected for 15.6 and scored 54.4 for Bear Dunn: 38-of-48 for 462 yards, five touchdowns, three interceptions and a rushing score. That is +38.8, the biggest bargain of the week. Tee Higgins added 42.3 against a 19.3 projection.")
 + L("Rich", "Bargains do not guarantee wins. Tyler Allgeier was projected for 4.7 and scored 38.5 for Eric Mannila, the second-biggest bargain of the week, and Mannila went 0&ndash;2. Harold Fannin, Josh Martel&rsquo;s tight end, was projected for 9.3 and put up 32.6 on 10 catches for 154 yards. Shawn Blake got 31.5 from Bhayshul Tuten against a 9.4 projection.")
 + L("Stuart", "Now the other side. Brian Cutting started Lamar Jackson and Zay Flowers, projected for 16.4 and 16.1, and got 0.0 and 0.0 from them. That is 32.5 projected points that never showed up, and Cutting still scored 203.9 and split. Eric Martel&rsquo;s Michael Penix Jr. went from 14.6 projected to -0.9, and Martel still scored 243.5.")
 + L("Rich", "Keith Creelman was not so lucky. Jacoby Brissett was projected for 15.5 and scored 1.1, and Parker Washington was projected for 18.4 and scored 4.0. Together that is 28.8 points under projection, in a week Creelman scored 183.5 and lost both games.")
 + L("Stuart", "On defense, Quinnen Williams gave Blake 17.5 on a 4.3 projection, and Chris Klingenberg&rsquo;s linebackers Alex Anzalone and CJ Allen beat their projections by 10.9 and 10.1. Klingenberg scored 229.2, third best of the week.")
 + '</div>' + reel
 + '<details class="wire-more"><summary>The full projection ledger</summary>' + bb_tables + '</details></section>'
)

heat_src, surv_src, land_src = grab("heat"), grab("survival"), grab("landscape")
season = (
 '<section class="wire-sec" id="season" data-title="The Season So Far"><div class="label"><span class="seg">6</span> The Season So Far <small>&mdash; who is real, who is rising, and what history says</small></div>'
 '<div class="desk-lines">'
 + L("Stuart", "Treat the last three weeks as their own season. In Weeks 6&ndash;8, Bear Dunn is 33&ndash;0 in All-Play and Eric Martel is 29&ndash;4. Those are the only two Dominant teams in the league. The next best are Chris Klingenberg at 22&ndash;11 and Brian Cutting at 21&ndash;12.")
 + L("Rich", "The movers. Klingenberg climbed from eighth in scoring in Weeks 1&ndash;5 to fourth in Weeks 6&ndash;8. Shawn Blake fell from second to seventh and is 13&ndash;20 over the stretch. Keith Creelman went from fifth to eighth, and Brian Cross from ninth to twelfth.")
 + L("Stuart", "Then ask what history says about where everyone sits after Week 8. The Survival Line looks at past seasons: of teams with Bear&rsquo;s All-Play rank at this point, 19 of 20 made the playoffs; Martel&rsquo;s group, 19 of 20; Cutting&rsquo;s, 15 of 16; Blake&rsquo;s, 15 of 16.")
 + L("Rich", "Keith Creelman is where the two histories disagree. Only 7 of 19 teams with his All-Play rank made it. But 8 of 12 teams with his win total did. His record says he is fine. His scoring says history is not so sure. The forecast lands in between at 76.1%.")
 + L("Stuart", "At the bottom, Matt Gerardi is 1 of 17 by All-Play rank and 0 of 7 by wins, and Brian Cross is 3 of 18 and 0 of 7. Their odds are 0.1% and 0.0%. Josh Martel is 3 of 18 and 4 of 20, and 2.2%.")
 + L("Rich", "And luck. Eric Mannila is +1.9 wins over what his All-Play rate predicts, the most in the league, and Shawn Blake is -2.0, the fewest. Brian Cutting leaves 42.0 points on his bench every week, also the most, and 5 of his 9 losses would have been wins with the best lineup.")
 + '</div>'
 + '<details class="wire-more"><summary>The standings, Heat Check and Survival Line tables</summary>' + strip_label(land_src) + strip_label(heat_src) + strip_label(surv_src) + '</details></section>'
)

pre = t[:t.index('<section class="wire-sec" id="open"')]
post = t[t.index('<div class="wire-method">'):]
odds = grab("odds")
a = odds.index('<div class="desk-lines"'); b = odds.index('<div class="tablebox">', a)
intro = ('<div class="desk-lines">'
 + L("Stuart", "Here is the shape of it. Four division leaders: Bear Dunn at 99.9% to win Dog Pound, Eric Martel at 84.8%, Shawn Blake at 79.9% and Keith Creelman at 75.5%. Creelman&rsquo;s is the soft one, with Ryan Bousquet at 22.3% and Josh Martel at 2.2% sharing the rest.")
 + L("Rich", "Then the wild-card road. Brian Cutting is 95.7% to make the playoffs with only a 15.2% chance of winning his division, so he gets in the other way. Chris Klingenberg is 69.9% with a 0.1% division chance, and he is counting entirely on a wild card. Derrick Whitman is 35.1%, Bousquet 22.4% and Eric Mannila 10.2%.")
 + L("Stuart", "And the bottom: Josh Martel is at 2.2%, Matt Gerardi at 0.1% and Brian Cross at 0.0%.")
 + '</div>')
odds = odds[:a] + intro + odds[b:]
body = big + "\n" + div_week + "\n" + elias + "\n" + odds + "\n" + plays + "\n" + season
t = pre + body + "\n" + post
n = 0
def bump(m):
    global n
    n += 1
    return '<span class="seg">%d</span>' % n
t = re.sub(r'<span class="seg">\d+</span>', bump, t)
assert 'editor-gap' not in t and 'id="coffee"' not in t and 'id="elias"' not in t
open(out, "w").write(t)
print("segments:", re.findall(r'data-title="([^"]*)"', t)[:10])
