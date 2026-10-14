#!/usr/bin/env python3
"""UPS Center Week 5 -- the analytical rebuild of automated draft #1244 (v2: Keith's 2026-10-14 writing review).

Reads facts.json (every computed fact + source) and the automated draft (for the
validated weekly segments it keeps: division desk, plays, above/below, Elias, the
Coffee Shop post counts). Every number printed in a NEW segment goes through the
ledger; build fails if any visible number is not registered (same rule as
ups_center_validate's numeric audit). Writes the article into the #1244 worktree.
"""
import html as H, json, os, re, sys
from datetime import datetime, timezone, timedelta
from core import TW, AP, FIDS, owner, pname, ppos, WEEKS

DIR = os.path.dirname(os.path.abspath(__file__))
WT = os.path.abspath(os.path.join(DIR, "..", "wt5"))
ART = os.path.join(WT, "site/wire/articles/2026/2026-wk05-ups-center.html")
AUTO = open(os.path.join(DIR, "auto_draft.html"), encoding="utf-8").read()
F = json.load(open(os.path.join(DIR, "facts.json")))
T, O = F["teams"], F["odds"]
GUILD, CHAN = "1057655884475531324", "1087157907419840644"
LOGO = {}
for m in re.finditer(r'<img src="(https://www48\.myfantasyleague\.com/[^"]+74598_franchise_logo(\d{4})\.[a-z]+)"', AUTO):
    LOGO[m.group(2)] = m.group(1)

# ------------------------------------------------------------------ ledger
CLAIMS = []          # (key, shown, source)
def n(key, value, fmt="%.1f", source=""):
    s = fmt % value
    CLAIMS.append((key, s, source)); return s
def pct(key, v, source="forecast"): return n(key, 100 * v, "%.1f", source) + "%"
def pp(key, v, source="forecast"):
    s = n(key, 100 * v, "%+.1f", source); return s.replace("-", "&minus;")
def rec(key, w, l, source="MFL"):
    return "%s&ndash;%s" % (n(key + ".w", w, "%d", source), n(key + ".l", l, "%d", source))
def e(s): return H.escape(s, quote=False)
def fid_of(o): return next(f for f in FIDS if owner(f) == o)

# ------------------------------------------------------------------ markup helpers
def lt(who, text):
    return '<div class="lt %s"><div class="who">%s</div><p>%s</p></div>' % (who.lower(), who, text)
def desk(*lines, mb=True):
    return '<div class="desk-lines"%s>%s</div>' % (' style="margin-bottom:1rem"' if mb else "", "".join(lt(w, t) for w, t in lines))
TH = ' style="padding:.45rem .3rem;font-size:.62rem;letter-spacing:.02em;white-space:normal;vertical-align:bottom;hyphens:auto"'
TD = ' style="padding:.4rem .3rem;white-space:normal;line-height:1.3;font-size:.8rem"'
TDN = ' class="num" style="padding:.4rem .3rem;text-align:right;font-size:.78rem;white-space:nowrap"'
def table(head, rows, caption=None, right=()):
    hs = "".join('<th%s>%s</th>' % (TH.replace('"padding', '"text-align:right;padding') if i in right else TH, h) for i, h in enumerate(head))
    body = "".join("<tr>%s</tr>" % "".join(('<td%s>%s</td>' % (TDN if i in right else TD, c)) for i, c in enumerate(r)) for r in rows)
    cap = '<p class="caption">%s</p>' % caption if caption else ""
    return '<div class="tablebox" style="margin:.4rem 0 1rem;break-inside:avoid;page-break-inside:avoid"><table style="min-width:0;font-size:.82rem"><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>%s' % (hs, body, cap)
def ini(f):
    first, last = owner(f).split(" ", 1)
    return "<b>%s. %s</b>" % (first[0], e(last))
def who(f, short=False):
    img = '<img src="%s" alt="" style="width:2.2rem;height:1.2rem;object-fit:contain;vertical-align:middle;margin-right:.35rem">' % LOGO[f] if f in LOGO and not short else ""
    return '%s<b>%s</b>' % (img, e(owner(f)))
def box(title, body):
    return '<div class="wire-note" style="border:1px solid var(--line-2);border-radius:10px;padding:.8rem .95rem;margin:.6rem 0 1rem;background:var(--surface);font-size:.92rem;line-height:1.5"><b>%s</b> %s</div>' % (title, body)
def editor(title, body):
    return ('<div class="wire-gap" style="border:2px dashed #c58a00;border-radius:10px;padding:.8rem .95rem;margin:.6rem 0 1rem;font-size:.92rem">'
            '<b>EDITOR REVIEW &mdash; %s</b> %s</div>' % (title, body))
def section(sid, num, title, sub, body):
    return ('<section class="wire-sec" id="%s" data-title="%s"><div class="label" style="break-after:avoid;page-break-after:avoid"><span class="seg">%d</span> %s%s</div>%s</section>'
            % (sid, title, num, title, (' <small>&mdash; %s</small>' % sub) if sub else "", body))
def h3(t): return '<h3 style="font-family:var(--display);font-size:1.15rem;margin:1.4rem 0 .5rem;break-after:avoid;page-break-after:avoid">%s</h3>' % t
def quote(mid, text, owner_, when):
    return ('<a class="rcpt" href="https://discord.com/channels/%s/%s/%s" target="_blank" rel="noopener" title="%s &middot; #the-coffee-shop &middot; %s">&ldquo;%s&rdquo;</a>'
            % (GUILD, CHAN, mid, e(owner_), when, e(text)))
def ord_(k): return {1: "1st", 2: "2nd", 3: "3rd"}.get(k, "%dth" % k)
def ordn(key, k, source="MFL"):
    n(key, k, "%d", source); return ord_(k)

# short handles
BEAR, BLAKE, EM, KC, CUT, WHIT, KLING, MAN, BOUS, GER, CROSS, JM = (fid_of(o) for o in (
    "Bear Dunn", "Shawn Blake", "Eric Martel", "Keith Creelman", "Brian Cutting", "Derrick Whitman", "Chris Klingenberg",
    "Eric Mannila", "Ryan Bousquet", "Matt Gerardi", "Brian Cross", "Josh Martel"))
apw = lambda f, ws: sum(AP[w][f][0] for w in ws)
apl = lambda f, ws: sum(AP[w][f][1] for w in ws)
by_odds = sorted(FIDS, key=lambda f: -O[f]["po"])
G6 = F["week6_games"]
kling_games = [i for i, g in enumerate(G6[:6]) if KLING in (g["a"], g["b"])]
assert len(kling_games) == 3

# ================================================================== v2 shared
sys.path.insert(0, os.path.join(WT, "pipelines/etl/wire"))
import season_sim as SS                                   # display_percentages (largest-remainder; documented)
V = F["v2"]; CONC = V["concentration"]; BQ = V["bousquet"]; PIT = V["pit"]
PRE = {t["franchiseId"]: t for t in json.load(open(os.path.join(DIR, "prefix", "season_sim_2026_live_wk05.json")))["teams"]}
SIM = json.load(open(os.path.join(WT, "site/wire/data/season_sim_2026_live_wk05.json")))
SIMT = {t["franchiseId"]: t for t in SIM["teams"]}
fix_max = max(abs(SIMT[f]["currentPlayoffOdds"] - PRE[f]["currentPlayoffOdds"]) for f in FIDS)
M = json.load(open(os.path.join(DIR, "mfl_2026.json")))
DIVNAME = {d["id"]: d["name"] for d in M["league"]["league"]["divisions"]["division"]}
def g6(a_owner, b_owner):
    return next(g for g in V["week6"] if {owner(g["a"]), owner(g["b"])} == {a_owner, b_owner})
def side(g, o):                       # (now, win, loss) for owner o in game g
    return (g["aNow"], g["aW"], g["aL"]) if owner(g["a"]) == o else (g["bNow"], g["bW"], g["bL"])
apw = lambda f, ws: sum(AP[w][f][0] for w in ws)
apl = lambda f, ws: sum(AP[w][f][1] for w in ws)
by_odds = sorted(FIDS, key=lambda f: -O[f]["po"])
assert [f for f in by_odds if O[f]["po"] >= 0.90] == [BEAR, CUT, BLAKE, EM], [owner(f) for f in by_odds if O[f]["po"] >= .9]
assert [f for f in by_odds if O[f]["po"] <= 0.0515] == [GER, CROSS, JM]
assert len([i for i, g in enumerate(V["week6"][:6]) if KLING in (g["a"], g["b"])]) == 3
assert BQ["warren_rise"] / BQ["rise"] > 1 / 3
DOWDLE_INJ = F["players"]["warren"]["dinj"]
assert DOWDLE_INJ["5"][0] == "Questionable" and DOWDLE_INJ["5"][2].startswith("Limited")

# ================================================================== 1. THE BIG STORY
story = desk(
    ("Stuart", "Five weeks down, and this league has started drawing lines. Bear Dunn went %s against the field in Week 1. Since then he is %s, and he is running away from everybody. "
     "Three teams are already 3&ndash;10, standing in a hole no team has climbed out of since this league went to thirteen games by Week 5. And the teams in between are finding out exactly which players their seasons depend on."
     % (rec("bear.ap1", AP[1][BEAR][0], AP[1][BEAR][1]), rec("bear.ap25", apw(BEAR, (2, 3, 4, 5)), apl(BEAR, (2, 3, 4, 5))))),
    ("Rich", "That last part matters most, because it never shows up in the standings. The contenders behind Bear are strong in different ways and exposed in different ways. Shawn Blake leans "
     "harder on two stars than anyone in the league, along with Eric Mannila. Eric Martel led the league in scoring over the first two weeks and ranks %s over the last three. Brian Cutting keeps losing games his own bench would have won. Bear&rsquo;s "
     "production is spread more evenly, which is one reason his lead looks so sturdy." % ordn("o.em.rk3", T[EM]["rk3"])),
    ("Stuart", "And then there is Ryan Bousquet, the team on the way up. He was last in scoring over the first two weeks and %s over the last three, and he has won four of his last five games. "
     "But more than a third of that climb belongs to Jaylen Warren, and the back Warren replaced, Rico Dowdle, was practicing again last week." % ordn("o.bou.rk3", T[BOUS]["rk3"])),
    ("Rich", "So the question is not who won Week 5. It is who is built to keep winning. Four teams are at 90%% or better to make the playoffs and three are at %s or lower, and Chris Klingenberg "
     "plays three of the six Week 6 games most likely to reshape the field." % pct("o.ger.po", O[GER]["po"])),
    ("Stuart", "This is the week the season turned into a playoff race."),
)

# ================================================================== 2. PLAYOFF PICTURE
meta = F["odds_meta"]
et = lambda iso: (datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) - timedelta(hours=4))
inputs_et = et("2026-10-14T01:56:56Z").strftime("%a %b %-d, %-I:%M %p ET")
wk3_et = et(meta["wk3_cutoff"]).strftime("%a %b %-d")
RUNS = "{:,}".format(meta["runs"]); CLAIMS.append(("meta.runs", RUNS, "season_sim runs"))
titles = SS.display_percentages({f: O[f]["title"] for f in FIDS})
assert abs(sum(O[f]["title"] for f in FIDS) - 1) < 1e-9 and abs(sum(float(x) for x in titles.values()) - 100) < 1e-9
for f in FIDS: CLAIMS.append(("o.%s.title" % f, titles[f], "forecast, largest-remainder"))
divs = {}
for f in FIDS: divs.setdefault(T[f]["div"], []).append(f)
div_rows = []; div_html = []
for d in sorted(divs, key=lambda d: -max(O[f]["div"] for f in divs[d])):
    raw = {f: O[f]["div"] for f in divs[d]}
    assert abs(sum(raw.values()) - 1) < 1e-9, (d, raw)            # every simulated season crowned exactly one champion
    shown = SS.display_percentages(raw)
    assert abs(sum(float(x) for x in shown.values()) - 100) < 1e-9
    for i, f in enumerate(sorted(divs[d], key=lambda f: -raw[f])):
        CLAIMS.append(("o.%s.div" % f, shown[f], "forecast, largest-remainder"))
        div_rows.append([ini(f), shown[f] + "%", pct("o.%s.bye" % f, O[f]["bye"])])
    div_html.append('<tr><td colspan="3" style="padding:.55rem .3rem .25rem;background:var(--surface-2,rgba(0,0,0,.04));font-size:.78rem"><b>%s</b> &middot; total %s%%</td></tr>'
                    % (e(DIVNAME[d]), n("o.div.%s.tot" % d, 100.0, "%.1f")) + "".join(
                        "<tr>%s</tr>" % "".join(('<td%s>%s</td>' % (TDN if j else TD, c)) for j, c in enumerate(r)) for r in div_rows[-3:]))
DIV_TABLE = ('<div class="tablebox" style="margin:.4rem 0 1rem;break-inside:avoid;page-break-inside:avoid"><table style="min-width:0;font-size:.82rem"><thead><tr>'
             + "".join('<th%s>%s</th>' % (TH if i == 0 else TH.replace('"padding', '"text-align:right;padding'), h) for i, h in enumerate(["Team", "Wins division", "First-round bye"]))
             + "</tr></thead><tbody>" + "".join(div_html) + "</tbody></table></div>")
field_rows = [[ini(f), pct("o.%s.po3" % f, O[f]["po"]), pp("o.%s.d2" % f, O[f]["po"] - O[f]["po_wk3"]), titles[f] + "%"] for f in by_odds]
gbk = g6("Ryan Bousquet", "Chris Klingenberg"); kn, kw, kl = side(gbk, "Chris Klingenberg"); bn_, bw_, bl_ = side(gbk, "Ryan Bousquet")
odds = (desk(
    ("Stuart", "Bear Dunn is about as close to a lock as this league gets in October: %s to make the playoffs and %s to take one of the two first-round byes. The fight is over who joins him."
     % (pct("o.bear.po", O[BEAR]["po"]), pct("o.bear.bye", O[BEAR]["bye"]))),
    ("Rich", "Three divisions have clear favorites: Bear wins his in %s of the simulated seasons, Shawn Blake wins his in %s, and Keith Creelman leads Ryan Bousquet %s to %s. "
     "The real race is Outlast PG Time, a coin flip: Eric Martel %s, Brian Cutting %s, even though Martel is %s and Cutting %s." % (
        SS.display_percentages({f: O[f]["div"] for f in divs[T[BEAR]["div"]]})[BEAR] + "%",
        SS.display_percentages({f: O[f]["div"] for f in divs[T[BLAKE]["div"]]})[BLAKE] + "%",
        SS.display_percentages({f: O[f]["div"] for f in divs[T[KC]["div"]]})[KC] + "%", SS.display_percentages({f: O[f]["div"] for f in divs[T[KC]["div"]]})[BOUS] + "%",
        SS.display_percentages({f: O[f]["div"] for f in divs[T[EM]["div"]]})[EM] + "%", SS.display_percentages({f: O[f]["div"] for f in divs[T[EM]["div"]]})[CUT] + "%",
        rec("em.rec", T[EM]["W"], T[EM]["L"]), rec("cut.rec", T[CUT]["W"], T[CUT]["L"]))),
    ("Stuart", "Hold on. A %s team is a coin flip for the division and has the second-best title odds in the league?" % rec("cut.recq", T[CUT]["W"], T[CUT]["L"])),
    ("Rich", "Because the forecast plays each team&rsquo;s best lineup every week, and Cutting&rsquo;s best lineup has averaged %s, second in the league. His record reflects the lineups he actually "
     "started. The forecast is betting that gap closes." % n("cut.opt", T[CUT]["optw"])),
    ("Stuart", "The biggest mover since our Week 3 odds is Shawn Blake, from %s to %s. He went %s over the last two weeks and traded for Derrick Henry on Oct 6, and Henry gave him %s in his first game. "
     "The biggest drop is Derrick Whitman&rsquo;s, from %s to %s, after a %s stretch and Jayden Reed&rsquo;s move to injured reserve." % (
        pct("o.blake.wk3", O[BLAKE]["po_wk3"]), pct("o.blake.po", O[BLAKE]["po"]), rec("blake.w45", T[BLAKE]["w45"], T[BLAKE]["l45"]),
        n("henry.wk5", F["players"]["ups"]["Derrick Henry"]["weeks"]["5"]["ups"]), pct("o.whit.wk3", O[WHIT]["po_wk3"]), pct("o.whit.po", O[WHIT]["po"]),
        rec("whit.w45", T[WHIT]["w45"], T[WHIT]["l45"]))),
    ("Rich", "And the middle gets sorted fast. Chris Klingenberg is at %s and plays Bousquet, Creelman and Josh Martel in Week 6. The Bousquet game matters most to both of them. In the simulated "
     "seasons where Klingenberg wins it, he makes the playoffs %s of the time; where he loses it, %s. For Bousquet, the same game is the difference between %s and %s." % (
        pct("o.kling.po", O[KLING]["po"]), pct("g.kw", kw), pct("g.kl", kl), pct("g.bw", bw_), pct("g.bl", bl_)))) +
    h3("Who makes the field") +
    table(["Team", "Playoffs", "Since Wk&nbsp;3", "Title"], field_rows, right=(1, 2, 3),
          caption="Probabilities updated after Week 5 (%s), %s simulated seasons. &ldquo;Since Wk 3&rdquo; is the change in percentage points from the odds in our Week 3 issue (%s); it includes a "
                  "correction to how division ties are broken, which moved no team&rsquo;s playoff probability by more than %s points. Title odds total 100.0%% across the league." % (
                      inputs_et, RUNS, wk3_et, n("fix.max", 100 * fix_max, "%.1f"))) +
    h3("Division races") +
    DIV_TABLE + '<p class="caption">One team wins each division in every simulated season, so each division totals 100.0%. Byes go to the two division winners with the best All-Play.</p>' +
    box("How the forecast works.", "Weeks 1&ndash;5 are fixed to the real results; the other %s games of each schedule are simulated from current rosters and weekly projections (RotoWire for "
        "offensive points, MFL as the backup and for defenders, kickers and punters, MFL for who plays). Each team keeps %s%% of its projected edge over an average team, calibrated to UPS "
        "2021&ndash;2025. Division titles follow MFL&rsquo;s order: record, division record, head-to-head, points, All-Play. It does not see trades or waiver moves after the cutoff and treats "
        "Questionable players as available. Single-game win chances are rough; they have not been tested game by game." % (
            n("meta.remaining", 37 - 13, "%d", "MFL schedule"), n("meta.keep", 100 * meta["regress"], "%d", "season_sim k"))))
assert sorted(FIDS, key=lambda f: -SIMT[f]["projectedEndingApPct"])[1] == CUT

# ================================================================== 3. HEAT CHECK
def label(f):
    t = T[f]; a3 = t["ap3"][0]
    if a3 >= 28: return "Dominant"
    if a3 <= 5: return "Sinking"
    if t["rk12"] - t["rk3"] >= 4: return "Rising"
    if t["rk3"] - t["rk12"] >= 4: return "Cooling"
    return "Holding"
LAB = {f: label(f) for f in FIDS}
import statistics as _st
assert max((sum(AP[w][f][0] for w in ws), f) for f in FIDS for ws in ((1, 2, 3), (2, 3, 4), (3, 4, 5)))[1] == BEAR
assert max(FIDS, key=lambda f: T[f]["ap3"][0]) == BEAR and T[EM]["rk12"] == 1 and max(FIDS, key=lambda f: T[f]["bench_w"]) == CUT
assert max(FIDS, key=lambda f: _st.pstdev(T[f]["weekly"])) == MAN and T[BEAR]["rk3"] == 1
heat_rows = [["%s<br><small><b>%s</b></small>" % (ini(f), LAB[f]), "%s<br><small>(%s)</small>" % (rec("ap3.%s" % f, T[f]["ap3"][0], T[f]["ap3"][1]), rec("ap.%s" % f, T[f]["apw"], T[f]["apl"])),
              "%s&nbsp;&rarr;&nbsp;%s" % (ordn("rk12.%s" % f, T[f]["rk12"]), ordn("rk3.%s" % f, T[f]["rk3"]))]
             for f in sorted(FIDS, key=lambda f: (-T[f]["ap3"][0], -T[f]["apw"]))]
lineup_rows = [[ini(f), n("bench.%s" % f, T[f]["bench_w"]), n("lost.%s" % f, T[f]["lost_best"], "%d") + " of " + n("L.%s" % f, T[f]["L"], "%d"),
                n("luck.%s" % f, T[f]["luck"], "%+.1f").replace("-", "&minus;")] for f in sorted(FIDS, key=lambda f: -T[f]["bench_w"])]
em, cut, ger, bou, man = T[EM], T[CUT], T[GER], T[BOUS], T[MAN]
heat = (desk(
    ("Stuart", "Bear&rsquo;s last three weeks are the best stretch anyone has put together this season: %s against the field and the league&rsquo;s top scoring average over Weeks 3 to 5, %s a week."
     % (rec("bear.ap3", T[BEAR]["ap3"][0], T[BEAR]["ap3"][1]), n("bear.ppw3", T[BEAR]["ppw3"]))),
    ("Rich", "And the team Bear just beat by %s is the one whose record is hiding a slide. Eric Martel led the league at %s a week over the first two weeks. Over the last three he is %s, at %s. He is still %s because of what he banked early."
     % (n("em.bear", 89.3), n("em.ppw12", em["ppw12"]), ordn("em.rk3", em["rk3"]), n("em.ppw3", em["ppw3"]), rec("em.rec2", em["W"], em["L"]))),
    ("Stuart", "And that slide is why his division is a coin flip with Brian Cutting, the reverse case: a team scoring like a contender and losing like an also-ran. Cutting has left %s points a "
     "week on his bench, the most in the league, and %s of his %s losses came in weeks when his best possible lineup would have won." % (n("cut.bench", cut["bench_w"]), n("cut.lost", cut["lost_best"], "%d"), n("cut.L", cut["L"], "%d"))),
    ("Rich", "That is the gap the forecast is betting closes: good roster, bad Sundays. Luck has not helped either. Cutting has %s fewer wins than his weekly all-play rates would predict, and only "
     "Chris Klingenberg, at %s, has been unluckier." % (n("cut.luck", -cut["luck"]), n("kl.luck", -T[KLING]["luck"]))),
    ("Stuart", "Two teams are climbing. Ryan Bousquet went from %s in scoring over the first two weeks to %s over the last three, and Eric Mannila from %s to %s." % (
        ordn("bou.rk12", bou["rk12"]), ordn("bou.rk3", bou["rk3"]), ordn("man.rk12", man["rk12"]), ordn("man.rk3", man["rk3"]))),
    ("Rich", "Mannila&rsquo;s climb comes with the biggest swings in the league: %s, %s, %s, %s and %s all-play wins, week by week. Those swings have an explanation, and it is two players. "
     "Going the other way, Matt Gerardi has fallen from %s to %s and won %s of %s all-play games over the last three weeks." % (
        *[n("man.apw%d" % i, v, "%d") for i, v in enumerate(man["apw_by_week"])],
        ordn("ger.rk12", ger["rk12"]), ordn("ger.rk3", ger["rk3"]), n("ger.ap3w", ger["ap3"][0], "%d"), n("ger.ap3n", ger["ap3"][0] + ger["ap3"][1], "%d"))),
    ("Stuart", "So who actually won Week 5, and how? Boomer.")) +
    table(["Team<br>Reading", "All-Play<br>Wks 3&ndash;5<br>(season)", "Scoring rank<br>Wks 1&ndash;2 &rarr; 3&ndash;5"], heat_rows, right=(1,),
          caption="Sorted by All-Play over Weeks 3&ndash;5; the full-season All-Play record is in parentheses. Reading, applied in order: <b>Dominant</b> = 28 or more of 33 all-play wins in Weeks 3&ndash;5; <b>Sinking</b> = 5 or fewer; "
                  "<b>Rising</b> / <b>Cooling</b> = scoring rank moved four or more places; otherwise <b>Holding</b>. Form describes; it does not predict.") +
    table(["Team", "Left on bench / wk", "Losses his best lineup would have won", "Wins vs expected"], lineup_rows, right=(1, 2, 3),
          caption="Bench points = MFL&rsquo;s best possible lineup from the same roster, known only after the games, minus the lineup started. Wins vs expected = head-to-head wins minus the wins "
                  "each week&rsquo;s all-play rate would give."))

# ================================================================== 4. WHO IS WINNING WEEKS (concentration first)
tpp = F["team_players"]
pw = json.load(open(os.path.join(DIR, "player_weeks.json")))
POS = {r["name"]: r["pos"] for r in pw}
def contributors(f):
    rows = sorted([(nm, v) for nm, v in tpp[f].items() if POS.get(nm) not in ("PK", "PN")], key=lambda kv: -kv[1]["par"])
    return rows, sum(v["par"] for _, v in rows if v["par"] > 0)
share = {f: (lambda r, t: 100 * (r[0][1]["par"] + r[1][1]["par"]) / t)(*contributors(f)) for f in FIDS}
order = sorted(FIDS, key=lambda f: -share[f])
assert order[:2] == [BLAKE, MAN] and abs(share[BLAKE] - CONC["Shawn Blake"]["top2_share"]) < 0.05
ww_rows = []
for f in order:
    rows, _ = contributors(f)
    (n1, v1), (n2, v2) = rows[0], rows[1]
    ww_rows.append([ini(f), "%s %s<br>%s %s" % (e(n1), n("ww.%s.p1" % f, v1["par"], "%+.0f"), e(n2), n("ww.%s.p2" % f, v2["par"], "%+.0f")),
                    n("ww.%s.top2" % f, share[f], "%.1f") + "%", n("ww.%s.sw" % f, max(len(v["sw"]) for _, v in rows), "%d")])
cb, cm, cbear = CONC["Shawn Blake"], CONC["Eric Mannila"], CONC["Bear Dunn"]
al, pu = cb["players"][0], cb["players"][1]; la, bi = cm["players"][0], cm["players"][1]; js_ = cbear["players"][0]
assert (al["name"], pu["name"], la["name"], bi["name"], js_["name"]) == ("Josh Allen", "Brock Purdy", "CeeDee Lamb", "Bijan Robinson", "Jaxon Smith-Njigba")
assert al["best_bench"] is None and pu["best_bench"] is None                       # no other QB on Blake's roster
lw = {k: la["weekly"][k] + bi["weekly"][k] for k in ("4", "5")}
k4, k5 = "4", "5"
wsw = {owner(f): (nm, v["sw"]) for f in FIDS for nm, v in tpp[f].items() if nm in ("Christian Watson", "Tyler Shough")}
assert len(wsw["Keith Creelman"][1]) == 4 and len(wsw["Derrick Whitman"][1]) == 4
weeks = (desk(
    ("Stuart", "Back to those two stars. No contender gets more of its advantage from two players than Shawn Blake: Josh Allen and Brock Purdy create %s of his "
     "entire edge over replacement. Eric Mannila is almost identical: CeeDee Lamb and Bijan Robinson supply %s." % (n("c.b", cb["top2_share"], "%.1f") + "%", n("c.m", cm["top2_share"], "%.1f") + "%")),
    ("Rich", "Edge over replacement is what a player scores beyond what an ordinary starter at his position gave that week. By that measure Allen is worth %s points a week to Blake and Purdy %s, and "
     "Blake has no third quarterback on his roster. So far one has covered for the other: Allen&rsquo;s %s in Week 3 came with Purdy&rsquo;s %s, and Blake still won two of three." % (
        n("c.al", al["per_week_edge"]), n("c.pu", pu["per_week_edge"]), n("c.al3", al["weekly"]["3"]), n("c.pu3", pu["weekly"]["3"]))),
    ("Stuart", "Mannila has had no such cover. In Week 4, Lamb and Robinson combined for %s and Mannila beat all eleven teams. In Week 5 they combined for %s, and he beat one team and lost all three "
     "of his games. His best bench receiver averages %s when he plays; his best bench back, %s." % (n("c.lb4", lw[k4]), n("c.lb5", lw[k5]), n("c.wr", la["best_bench"][0]), n("c.rb", bi["best_bench"][0]))),
    ("Rich", "Bear is built differently. His top two supply %s of his edge, well below Blake and Mannila, and when Jaxon Smith-Njigba had his worst game, %s in Week 4, Bear still beat ten of eleven teams. "
     "One bad week from one star does not sink him." % (n("c.bear", cbear["top2_share"], "%.1f") + "%", n("c.js4", js_["weekly"]["4"]))),
    ("Stuart", "And which players actually flipped results? Christian Watson gave Keith Creelman more than a replacement-level receiver would have in four matchups, and each time the extra production "
     "was bigger than Keith&rsquo;s winning margin. Put an ordinary receiver in his spot and those four wins become losses. Tyler Shough did the same four times for Derrick Whitman."),
    ("Rich", "So four of Keith&rsquo;s nine wins, and four of Whitman&rsquo;s seven, rest on one player each. For Keith, at %s to make the playoffs, that is a cushion he has earned. For Whitman, at %s, "
     "it is the margin he is living on." % (pct("o.kc.po2", O[KC]["po"]), pct("o.whit.po2", O[WHIT]["po"]))),
) + table(["Team", "Two biggest edges, Wks 1&ndash;5", "Top-two share", "Most wins swung by one player"], ww_rows, right=(2, 3),
          caption="Sorted by top-two share. Edge = started points minus replacement level (the average of the six rostered players just outside the league&rsquo;s starting pool at that position that "
                  "week), Weeks 1&ndash;5, credited to the team that started him; kickers and punters left out. Top-two share = the two biggest edges as a share of all positive edges on the team. "
                  "Results swung: matchups the team won where the player&rsquo;s edge was larger than the margin. More than one player can qualify in the same matchup, so these are swing "
                  "performances, not additive team wins."))
contenders = [f for f in FIDS if O[f]["po"] >= 0.6]
assert share[BEAR] < share[BLAKE] - 5 and share[BEAR] < share[MAN] - 5 and min(JS for JS in [_ for _ in [js_["weekly"][k] for k in js_["weekly"]] if _ is not None]) == js_["weekly"]["4"]
assert [AP[4][MAN][0], AP[5][MAN][0]] == [11, 1] and [g["result"] for g in TW[(5, MAN)]["games"]] == ["L", "L", "L"] and AP[4][BEAR][0] == 10
assert [g["result"] for g in TW[(3, BLAKE)]["games"]].count("W") == 2

# ================================================================== 5. PLAYER STORIES
P = F["players"]; w = P["warren"]; U = P["ups"]
wv = lambda k, i: w[k][str(i)]
pwi, pwo = PIT["with"], PIT["without"]
assert pwi["warren"]["gl_car"] == pwi["dowdle"]["gl_car"] == pwo["warren"]["gl_car"] == pwo["rb"]["gl_car"] == 0 and pwi["dowdle"]["rz_car"] == 1
assert sum(1 for v in PIT["first_rb_carry"].values() if v == "J.Warren") == 4
bx = w["wk5_box"]
pit_rows = [["Warren&rsquo;s share of RB carries on 1st and 2nd down", "%s of %s" % (n("t.e1", pwi["warren"]["early_car"], "%d"), n("t.e1n", pwi["rb"]["early_car"], "%d")),
             "%s of %s" % (n("t.e2", pwo["warren"]["early_car"], "%d"), n("t.e2n", pwo["rb"]["early_car"], "%d"))],
            ["Dowdle&rsquo;s carries on 1st and 2nd down", n("t.d1", pwi["dowdle"]["early_car"], "%d"), "out"],
            ["Warren&rsquo;s share of RB targets", "%s of %s" % (n("t.t1", pwi["warren"]["tgt"], "%d"), n("t.t1n", pwi["rb"]["tgt"], "%d")),
             "%s of %s" % (n("t.t2", pwo["warren"]["tgt"], "%d"), n("t.t2n", pwo["rb"]["tgt"], "%d"))],
            ["Short-yardage carries (2 yards or fewer to go): Warren of RB", "%s of %s" % (n("t.s1", pwi["warren"]["short_car"], "%d"), n("t.s1n", pwi["rb"]["short_car"], "%d")),
             "%s of %s" % (n("t.s2", pwo["warren"]["short_car"], "%d"), n("t.s2n", pwo["rb"]["short_car"], "%d"))],
            ["Red-zone carries: Warren / Dowdle", "%s / %s" % (n("t.r1w", pwi["warren"]["rz_car"], "%d"), n("t.r1d", pwi["dowdle"]["rz_car"], "%d")),
             "%s / out" % n("t.r2w", pwo["warren"]["rz_car"], "%d")],
            ["Carries inside the 5, any Steelers back", n("t.g1", pwi["rb"]["gl_car"], "%d"), n("t.g2", pwo["rb"]["gl_car"], "%d")],
            ["Warren&rsquo;s UPS points a game", n("t.p1", BQ["warren12"]), n("t.p2", BQ["warren3"])]]
pit = (h3("1. Ryan Bousquet&rsquo;s climb, and the Steelers&rsquo; backfield") + desk(
    ("Stuart", "Ryan Bousquet averaged %s points over the first two weeks and %s over the last three. He was %s after Week 3; he is %s since."
     % (n("bq.p12", BQ["ppw12"]), n("bq.p3", BQ["ppw3"]), rec("bq.r13", BQ["w13"].count("W"), BQ["w13"].count("L")), rec("bq.r45", BQ["w45"].count("W"), BQ["w45"].count("L")))),
    ("Rich", "Jaylen Warren is a big part of why. In the two games he shared the backfield with Rico Dowdle, Warren averaged %s points. In the three since Dowdle hurt his toe, %s. That %s-point jump "
     "is more than a third of Ryan&rsquo;s %s-point climb. And it has decided games: put a replacement-level back in Warren&rsquo;s spot and Ryan is %s instead of %s, with %s all-play wins instead of %s."
     % (n("bq.w12", BQ["warren12"]), n("bq.w3", BQ["warren3"]), n("bq.wr", BQ["warren_rise"]), n("bq.rise", BQ["rise"]),
        rec("bq.cf", *BQ["rec_cf"]), rec("bq.rec", *BQ["rec"]), n("bq.apcf", BQ["ap_cf"], "%d"), n("bq.ap", BQ["ap"], "%d"))),
    ("Stuart", "Which makes Dowdle&rsquo;s toe Ryan&rsquo;s problem. Ryan is at %s to make the playoffs, and his Week 6 game with Klingenberg is the difference between %s and %s. Dowdle was ruled "
     "out for Weeks 3 and 4, practiced on a limited basis before Week 5, was listed Questionable and still did not play." % (pct("o.bou.po", O[BOUS]["po"]), pct("g.bw2", bw_), pct("g.bl2", bl_))),
    ("Rich", "Here is what he would take back. When both backs were healthy, Dowdle had %s of the %s early-down carries and %s of the %s running-back targets. Without him the job became Warren&rsquo;s: "
     "%s of %s early-down carries. But Dowdle has not been a goal-line back. No Steelers running back has had a carry inside the 5 this season, and Dowdle&rsquo;s red-zone work was one carry. If he returns, the threat to "
     "Warren is volume on early downs and in the passing game, not touchdowns at the goal line. And Boomer&rsquo;s two long touchdowns explain most of Week 5&rsquo;s %s; Warren had no touches inside the 20." % (
        n("d.e", pwi["dowdle"]["early_car"], "%d"), n("d.en", pwi["rb"]["early_car"], "%d"), n("d.t", pwi["dowdle"]["tgt"], "%d"), n("d.tn", pwi["rb"]["tgt"], "%d"),
        n("w.e", pwo["warren"]["early_car"], "%d"), n("w.en", pwo["rb"]["early_car"], "%d"), n("w.ups5", wv("ups", 5)))),
    ("Stuart", "Shawn Blake hears the same news differently. Dowdle is on Blake&rsquo;s roster, but only as depth: %s and %s points from the bench in the two games he played, and Blake has never started "
     "him. For Blake, a healthy Dowdle is insurance. For Ryan, he could take back part of the job that has driven the climb." % (n("d.u1", w["dups"]["1"]), n("d.u2", w["dups"]["2"]))),
    ("Rich", "So watch Pittsburgh at Tampa Bay on Sunday at 1 PM, after Dowdle&rsquo;s practice reports Wednesday to Friday. The first drive comes first: Warren has taken the first running-back carry "
     "in four of five games. Then his snap share, his routes on passing downs, his carries and targets, and who gets the ball near the goal line. Our forecast already counts Dowdle as available."),
) + table(["", "With Dowdle, Wks 1&ndash;2", "Without, Wks 3&ndash;5"], pit_rows, right=(1, 2),
          caption="nflverse play-by-play; injury designations from the official NFL report. Route data for 2026 is not available yet."))
assert list(BQ["rec_cf"]) == [4, 9] and list(BQ["rec"]) == [6, 7]
assert all(wv("ups", i) is not None for i in WEEKS) and all(w["dstatus"][str(i)] == "nonstarter" for i in WEEKS)

gb = P["gibbs"]; gm = gb["me"]; ab = gb["above"]; rg = P["regression"]; GS = V["gibbs_share"]
hu, ro, wa = (U[x]["weeks"]["5"] for x in ("Tyler Huntley", "Aaron Rodgers", "Deshaun Watson"))
QBS = sorted({pname(p["pid"]) for (wk, f), tt in TW.items() if f == CUT for p in tt["players"] if ppos(p["pid"]) == "QB"})
assert len(QBS) == 7 and ab[0]["name"] == "Priest Holmes" and ab[1]["name"] == "Christian McCaffrey" and gb["rank"] == 3
gwc = g6("Derrick Whitman", "Brian Cutting"); wn, ww_, wl = side(gwc, "Derrick Whitman"); cn, cw, cl = side(gwc, "Brian Cutting")
cutting = (h3("2. Brian Cutting: the best player in the league, and the lineup around him") + desk(
    ("Stuart", "Brian Cutting has the most valuable player in the league by edge over replacement. Jahmyr Gibbs has %s points through Detroit&rsquo;s first five games: %s carries, %s yards, "
     "%s rushing touchdowns and %s catches." % (n("g.pts", gm["pts"]), n("g.car", gm["car"], "%d"), n("g.ryd", gm["rushyd"], "%d"), n("g.rtd", gm["rushtd"], "%d"), n("g.rec", gm["rec"], "%d"))),
    ("Rich", "History says that start is rare, and that it cools. Score every running back since 1999 by this year&rsquo;s UPS rules and only %s in %s (%s) and %s in %s (%s) had better first five "
     "games. The 25 best starts before this year kept about %s%% of their pace over the rest of the season. For Gibbs, that would still be %s points a game." % (
        e(ab[0]["name"]), ab[0]["season"], n("g.a0", ab[0]["pts"]), e(ab[1]["name"]), ab[1]["season"], n("g.a1", ab[1]["pts"]), n("rg.rb", rg["RB"]["mean"], "%d"),
        n("g.ppg80", gm["pts"] / 5 * rg["RB"]["mean"] / 100))),
    ("Stuart", "So how is the team with that player %s? The lineups. In Week 5, alongside Drake Maye, Cutting started Deshaun Watson, who scored %s. Lamar Jackson, whom Cutting traded for on Sep 29, "
     "was inactive for Baltimore, and the backup who came over in the same trade, Tyler Huntley, played every snap and scored %s on Cutting&rsquo;s bench. So did Aaron Rodgers. Seven quarterbacks "
     "have been on Cutting&rsquo;s roster in five weeks." % (rec("cut.rec2", T[CUT]["W"], T[CUT]["L"]), n("wa5", wa["ups"]), n("hu5", hu["ups"]))),
    ("Rich", "And Week 6 tests the rest of the roster. Cutting enters it without Gibbs, who has supplied %s of Cutting&rsquo;s starting points and %s of the team&rsquo;s edge over replacement; Detroit is on bye. He faces "
     "Derrick Whitman, whose playoff probability is %s today. In the simulated seasons where Whitman loses that game, it falls to %s; where he wins, it rises to %s. Cutting&rsquo;s own odds barely "
     "move: %s with a win, %s with a loss." % (n("gs.pts", GS["pts"], "%.1f") + "%", n("gs.edge", GS["edge"], "%.1f") + "%", pct("g.wn", wn), pct("g.wl", wl), pct("g.ww", ww_),
                                                pct("g.cw", cw), pct("g.cl", cl)))))
assert abs(hu["ups"] - 29.8) < .01 and abs(ro["ups"] - 29.8) < .01 and wa["status"] == "starter" and hu["status"] != "starter" and ro["status"] != "starter"
assert abs(wn - O[WHIT]["po"]) < 0.0006                       # the scenario run and the table are the same simulated seasons

js = P["jsn"]; jm_ = js["me"]; bow = P["bowers_span"]; bw = U["Brock Bowers"]["weeks"]
jsn_pts = sum(U["Jaxon Smith-Njigba"]["weeks"][str(i)]["ups"] for i in WEEKS)
bear = (h3("3. Bear Dunn&rsquo;s two pass catchers") + desk(
    ("Stuart", "Bear&rsquo;s run has two engines, and both catch passes. Jaxon Smith-Njigba has %s points in Seattle&rsquo;s five games: %s catches on %s targets, %s yards and %s touchdowns."
     % (n("j.pts", jsn_pts), n("j.rec", jm_["rec"], "%d"), n("j.tgt", jm_["tgt"], "%d"), n("j.yds", jm_["recyd"], "%d"), n("j.td", jm_["rectd"], "%d"))),
    ("Rich", "Rescore every receiver since 1999 from box scores under this year&rsquo;s rules, which puts Smith-Njigba&rsquo;s five games at %s, and only %s in %s started faster, with %s. The 25 best starts before "
     "this year kept about %s%% of their pace. For Smith-Njigba that would be about %s points a game." % (
        n("j.box", jm_["pts"]), e(js["above"][0]["name"]), js["above"][0]["season"], n("j.a0", js["above"][0]["pts"]), n("rg.wr", rg["WR"]["mean"], "%d"),
        n("j.ppg74", jsn_pts / 5 * rg["WR"]["mean"] / 100))),
    ("Stuart", "Then there is Brock Bowers, back from a knee injury in Week 3. He scored %s, %s and %s on %s, %s and %s targets. Bear did not trust the knee at first. In Week 3 he started Sam "
     "LaPorta at tight end, who scored %s, while Bowers&rsquo; %s sat on the bench. Bear won all three games anyway, and Bowers has started every week since." % (
        n("b.u3", bw["3"]["ups"]), n("b.u4", bw["4"]["ups"]), n("b.u5", bw["5"]["ups"]), n("b.t3", bw["3"]["tgt"], "%d"), n("b.t4", bw["4"]["tgt"], "%d"), n("b.t5", bw["5"]["tgt"], "%d"),
        n("b.lap", 9.1), n("b.u3b", bw["3"]["ups"]))),
    ("Rich", "Those three games are the best three-game run by any tight end this season, %s points better than Trey McBride&rsquo;s best. Go back to 1999, take every tight end season&rsquo;s best three "
     "straight games under this year&rsquo;s UPS rules, and only %s of %s seasons beat it." % (n("b.gap", bow["pts"] - bow["next2026"][0]), n("b.better", bow["rank"] - 1, "%d"), "{:,}".format(bow["n"]))),
    ("Stuart", "And a quiet Thursday night from Smith-Njigba at Denver would not break Bear; his top two carry a smaller share of his edge than Blake&rsquo;s or Mannila&rsquo;s. Bear is already all but "
     "in. What he is playing for now is a bye and the title."),
))
CLAIMS.append(("b.n", "{:,}".format(bow["n"]), "nflverse TE seasons"))
assert js["rank"] == 2 and js["above"][0]["name"] == "Wes Welker" and bow["rank2026"] == 1 and bow["next2026"][1] == "Trey McBride"
assert [bw[str(i)]["status"] for i in (3, 4, 5)] == ["nonstarter", "starter", "starter"] and all(bw[str(i)]["owner"] == "Bear Dunn" for i in (3, 4, 5))
lap3 = [p for p in TW[(3, BEAR)]["players"] if pname(p["pid"]) == "Sam LaPorta"][0]; assert lap3["status"] == "starter" and lap3["score"] == 9.1
assert [g["result"] for g in TW[(3, BEAR)]["games"]] == ["W", "W", "W"]

tg = P["targets"]; pk = U["Puka Nacua"]["weeks"]
import polars as _pl
_pb = _pl.read_parquet(os.path.join(DIR, "ps_2026.parquet")).filter((_pl.col("player_display_name") == "Puka Nacua") & (_pl.col("week") == 5)).to_dicts()[0]
_g = _pl.read_parquet(os.path.join(DIR, "sched_2026.parquet")).filter((_pl.col("week") == 5) & (_pl.col("home_team") == "LA")).to_dicts()[0]
assert (_pb["targets"], _pb["receptions"], _pb["receiving_yards"], _pb["receiving_tds"]) == (24, 17, 138, 1) and (_g["away_team"], _g["away_score"], _g["home_score"]) == ("BUF", 37, 34)
assert tg["more_than_24"] == [[2009, 14, "Brandon Marshall", 28]] and tg["y2026"] == [[5, "Puka Nacua", 24], [4, "CeeDee Lamb", 21], [5, "Malik Nabers", 20]]
assert U["CeeDee Lamb"]["weeks"]["5"]["tgt"] == 5 and U["CeeDee Lamb"]["weeks"]["4"]["owner"] == "Eric Mannila" and U["Malik Nabers"]["weeks"]["5"]["owner"] == "Eric Mannila"
targets = (h3("4. Twenty-four targets") + desk(
    ("Stuart", "Boomer showed you Monday night: Puka Nacua, %s targets, %s catches, %s yards and a touchdown, %s points for Keith Creelman, in the Rams&rsquo; %s&ndash;%s loss to Buffalo."
     % (n("p.tgt", 24, "%d"), n("p.rec", 17, "%d"), n("p.yds", 138, "%d"), n("p.ups", pk["5"]["ups"]), n("p.bills", 37, "%d"), n("p.rams", 34, "%d"))),
    ("Rich", "That almost never happens. In every season since 1999 with tracked targets, which is all but 2003 to 2008, only Brandon Marshall in 2009 saw more in a regular-season game: %s. "
     "This season has three 20-target games, and all three belong to UPS rosters: Nacua&rsquo;s, plus CeeDee Lamb&rsquo;s %s in Week 4 and Malik Nabers&rsquo; %s in Week 5, both for Eric Mannila."
     % (n("p.marsh", 28, "%d"), n("p.lamb", 21, "%d"), n("p.nab", 20, "%d"))),
    ("Stuart", "So does Keith get that again on Sunday?"),
    ("Rich", "Not that much. In the next game after a 20-target game, players averaged %s targets (%s cases). Lamb followed his %s with %s targets and %s points. Nacua missed Weeks 2 and 3 with "
     "a hip injury and has scored %s and %s since, so the role is real even if the volume falls back. And Keith needs it: his Week 6 game with Klingenberg is the difference between %s and %s." % (
        n("p.next", tg["next_mean"]), n("p.n", tg["next_n"], "%d"), n("p.lamb2", 21, "%d"), n("p.lamb_t", 5, "%d"), n("p.lamb_u", U["CeeDee Lamb"]["weeks"]["5"]["ups"]),
        n("p.u4", pk["4"]["ups"]), n("p.u5", pk["5"]["ups"]), pct("g.kcw", side(g6("Keith Creelman", "Chris Klingenberg"), "Keith Creelman")[1]),
        pct("g.kcl", side(g6("Keith Creelman", "Chris Klingenberg"), "Keith Creelman")[2]))),
))
players = desk(("Stuart", "Four stories are shaping this race, and the first one is a toe in Pittsburgh."), mb=True) + pit + cutting + bear + targets

# ================================================================== 6. THE SURVIVAL LINE
hist = F["history"]; grp_w = hist["h2h_groups"]; b17 = hist["bear2017"]; b3 = hist["bottom3"]; PR = V["pairs"]
cat = lambda p: ("Contender" if p >= .90 else "In the field" if p >= .60 else "In the race" if p >= .25 else "Needs a run" if p >= .08 else "Life support")
grp_ap = {lab: (m, nn) for lab, m, nn in hist["ap_groups"]}
def ap_group(rk): return next(lab for lab in grp_ap if int(lab.split("–")[0]) <= rk <= int(lab.split("–")[1]))
def w_group(wins):
    return next(lab for lab, m, nn in grp_w if (lab == "10 or more" and wins >= 10) or (lab == "3 or fewer" and wins <= 3) or ("–" in lab and int(lab.split("–")[0]) <= wins <= int(lab.split("–")[1])))
surv_rows = []
for f in by_odds:
    m, nn = grp_ap[ap_group(T[f]["aprk"])]; m2, nn2 = next((x[1], x[2]) for x in grp_w if x[0] == w_group(T[f]["W"]))
    surv_rows.append([ini(f), "<b>%s</b><br>%s" % (cat(O[f]["po"]), pct("s.%s.po" % f, O[f]["po"])),
                      "%s/%s" % (n("s.%s.m" % f, m, "%d"), n("s.%s.n" % f, nn, "%d")), "%s/%s" % (n("s.%s.m2" % f, m2, "%d"), n("s.%s.n2" % f, nn2, "%d"))])
gjk = g6("Josh Martel", "Chris Klingenberg"); jn, jw, jl = side(gjk, "Josh Martel")
assert grp_w[-1][1] == 0 and grp_w[-1][2] == 8 and b3 == [4, 24] and b17["apw"] == T[JM]["apw"] and b17["apl"] == T[JM]["apl"]
survival = (desk(
    ("Stuart", "Now the hard part. Matt Gerardi, Brian Cross and Josh Martel are all 3&ndash;10, with playoff probabilities of %s, %s and %s."
     % (pct("s.ger", O[GER]["po"]), pct("s.cross", O[CROSS]["po"]), pct("s.jm", O[JM]["po"]))),
    ("Rich", "And history agrees with the forecast. Since the league moved to thirteen decisions through Week 5 in 2021, %s teams have reached this point with three wins or fewer. None made the playoffs."
     % n("le3.n", grp_w[-1][2], "%d")),
    ("Stuart", "Is there any way out?"),
    ("Rich", "Not by record. By All-Play, a few have found one: since 2017, only %s of the %s teams ranked 10th through 12th in All-Play after Week 5 went on to make the playoffs. All-Play is the "
     "better guide this early; among comparable teams from 2020 to 2025, the team with the better All-Play standing after Week 5 became the playoff team %s%% of the time, compared with %s%% for more "
     "points and %s%% for the better overall record." % (n("b3.m", b3[0], "%d"), n("b3.n", b3[1], "%d"), n("pr.ap", 100 * PR["ap"][0], "%.0f"), n("pr.pf", 100 * PR["pf"][0], "%.0f"),
                                                          n("pr.h2h", 100 * PR["h2h"][0], "%.0f"))),
    ("Stuart", "And one of those four is the best story in this league&rsquo;s history book. Bear Dunn, 2017: %s in All-Play after Week 5, the exact record Josh Martel has now. He won his division, "
     "entered the playoffs as the %s seed and finished %s." % (rec("b17", b17["apw"], b17["apl"], "D1"), ordn("b17.seed", b17["seed"], "bracket"), ordn("b17.fin", b17["finish"], "bracket"))),
    ("Rich", "Josh would need that and more. His Week 6 game is against Klingenberg, and even a win only takes his playoff probability from %s to %s." % (pct("s.jm2", jn), pct("s.jmw", jw)))) +
    table(["Team", "Category, playoffs", "Made it from his All-Play rank, 2017&ndash;25", "Made it with his win total, 2021&ndash;25"], surv_rows, right=(2, 3),
          caption="Categories from this week&rsquo;s playoff probabilities: <b>Contender</b> 90%% or better, <b>In the field</b> 60&ndash;90, <b>In the race</b> 25&ndash;60, <b>Needs a run</b> 8&ndash;25, "
                  "<b>Life support</b> under 8; nobody is called eliminated until the math says so. &ldquo;Made it&rdquo; columns: teams in the same position after Week 5 who went on to make the playoffs, out of all such teams. History groups All-Play rank in pairs (1&ndash;2, 3&ndash;4 &hellip;; tied teams share the higher rank). "
                  "The All-Play vs record vs points comparison uses same-season pairs: every 2020&ndash;2025 playoff team against every non-playoff team from the same season (%s pairs), "
                  "standings after Week 5; ties count half." % n("pr.n", PR["ap"][1], "%d")))
assert PR["ap"][0] > PR["pf"][0] > PR["h2h"][0] and PR["ap"][1] == 216
# ================================================================== 7. WEEK 5 IN BRIEF (reused, validated weekly segments)
def compact(html_):
    html_ = html_.replace("<table>", '<table style="min-width:0">').replace('<table style="min-width:0">', '<table style="min-width:0;font-size:.8rem">')
    html_ = re.sub(r'<td class="fr"><img ([^>]*)>', r'<td class="fr" style="padding:.4rem .3rem;gap:.35rem;font-size:.85rem"><img \1 style="width:2.2rem;height:1.1rem">', html_)
    html_ = html_.replace('<td class="num">', '<td class="num" style="padding:.4rem .3rem">').replace("<th>", '<th style="padding:.45rem .3rem;font-size:.62rem;letter-spacing:.02em">')
    return html_
def auto_sec(sid):
    return re.search(r'<section class="wire-sec" id="%s"[\s\S]*?</section>' % sid, AUTO).group(0)
def inner(sec):
    return re.sub(r'^<section[^>]*><div class="label">[\s\S]*?</div>', "", sec)[:-len("</section>")]
desk_inner = compact(inner(auto_sec("desk"))); plays_inner = inner(auto_sec("plays"))
boomer_inner = inner(auto_sec("boomer"))
boom_lines = re.findall(r'<div class="lt boomer"><div class="who">Boomer</div><p>([\s\S]*?)</p></div>', boomer_inner)
brief = (desk(("Boomer", boom_lines[0]), ("Boomer", boom_lines[1]), ("Boomer", boom_lines[2] + " Stu, Rich, here is every game."), mb=True) +
         desk_inner + h3("Plays of the week") + plays_inner)
bb_sec = auto_sec("bb")
def trim_lists(sec, keep=3):
    return re.sub(r"<ol>([\s\S]*?)</ol>", lambda m: "<ol>%s</ol>" % "".join(re.findall(r"<li>[\s\S]*?</li>", m.group(1))[:keep]), sec)
bb_inner = inner(trim_lists(bb_sec))
coffee_auto = inner(auto_sec("coffee"))
post_table = re.search(r'<div class="tablebox">[\s\S]*</p>$', coffee_auto.strip()).group(0); post_table = compact(post_table)
elias_inner = inner(auto_sec("elias"))

# ================================================================== 7. WEEK 5 IN BRIEF (Boomer as connected highlights)
_pwk = lambda nm, wk: next(r for r in pw if r["name"] == nm and r["week"] == wk)
mg, gg, wk5w = _pwk("Drake Maye", 5), _pwk("Jahmyr Gibbs", 5), _pwk("Jaylen Warren", 5)
bur, bow5 = _pwk("Joe Burrow", 5), _pwk("Brock Bowers", 5)
res = lambda f: "%d&ndash;%d" % ([g["result"] for g in TW[(5, f)]["games"]].count("W"), [g["result"] for g in TW[(5, f)]["games"]].count("L"))
assert (mg["fid"], gg["fid"]) == (CUT, CUT) and mg["status"] == gg["status"] == "starter" and (gg["carries"], gg["targets"]) == (25, 6)
assert [g["result"] for g in TW[(5, KC)]["games"]] == ["W", "W", "W"] and [g["result"] for g in TW[(5, BOUS)]["games"]].count("W") == 2
assert AP[5][BEAR][0] == 11 and AP[3][BEAR][0] == 11 and max(TW[(5, f)]["score"] for f in FIDS) == TW[(5, BEAR)]["score"] and bur["fid"] == BEAR and bow5["status"] == "starter"
CLAIMS.append(("cut.res5", res(CUT), "MFL"))
games5 = sorted([(f, g) for f in FIDS for g in TW[(5, f)]["games"] if g["result"] == "W"], key=lambda x: -x[1]["margin"])
assert "Brian Cutting" in sorted({owner(f) for f in FIDS for g in TW[(5, f)]["games"] if g["result"] == "L" and TW[(5, f)]["opt"] > TW[(5, g["opp"])]["score"]})
assert len(games5) == sum(len(TW[(5, f)]["games"]) for f in FIDS) // 2 == 18
res_rows = [[ini(f) + " " + n("r5.%s%s.w" % (f, g["opp"]), TW[(5, f)]["score"]), ini(g["opp"]) + " " + n("r5.%s%s.l" % (f, g["opp"]), TW[(5, g["opp"])]["score"]),
             n("r5.%s%s.m" % (f, g["opp"]), g["margin"])] for f, g in games5]
import polars as _plq
_ot = _plq.read_parquet(os.path.join(DIR, "pbp_2026.parquet")).filter((_plq.col("week") == 5) & (_plq.col("home_team") == "LA"))
assert _ot["qtr"].max() == 5 and max(x for x in _ot["time_of_day"].to_list() if x) > "2026-10-13T03:31:00"        # Rams-Bills still on at 11:31 PM ET
assert (T[KC]["W"], T[WHIT]["W"]) == (9, 7)
assert [g for g in TW[(5, BEAR)]["games"] if g["opp"] == EM][0]["margin"] == 89.3
_lk = sorted(FIDS, key=lambda f: T[f]["luck"]); assert _lk[:2] == [KLING, CUT], [owner(f) for f in _lk[:2]]
bench_lost5 = sorted({owner(f) for f in FIDS for g in TW[(5, f)]["games"] if g["result"] == "L" and TW[(5, f)]["opt"] > TW[(5, g["opp"])]["score"]})
brief = (desk(
    ("Boomer", "Thanks, Stu! Brian Cutting got %s points from two players alone. Drake Maye threw four touchdowns, ran for another and scored %s. Jahmyr Gibbs added %s on %s carries and %s "
     "targets. That pair powered Cutting to a %s week, and now Cutting plays Week 6 without Gibbs." % (
        n("bm.pair", mg["ups"] + gg["ups"]), n("bm.maye", mg["ups"]), n("bm.gibbs", gg["ups"]), n("bm.gcar", gg["carries"], "%d"), n("bm.gtgt", gg["targets"], "%d"), res(CUT))),
    ("Boomer", "Keith Creelman answered Monday night with volume nobody could ignore. Puka Nacua saw %s targets, caught %s and turned them into %s points, and Keith swept all three of his games."
     % (n("bm.ptgt", 24, "%d"), n("bm.prec", 17, "%d"), n("bm.pups", U["Puka Nacua"]["weeks"]["5"]["ups"]))),
    ("Boomer", "In Pittsburgh, Jaylen Warren took a short pass %s yards and a handoff %s, both for touchdowns: %s points for Ryan Bousquet, who won two of three." % (
        n("bm.wtd1", w["wk5_tds"][0][0], "%d"), n("bm.wtd2", w["wk5_tds"][1][0], "%d"), n("bm.wups", wk5w["ups"]))),
    ("Boomer", "And the top score of the week was Bear Dunn&rsquo;s %s, with %s from Joe Burrow and %s from Brock Bowers. Bear beat all eleven teams for the second time in three weeks. "
     "Every Week 5 result is below. Back to the desk." % (n("bm.bear", TW[(5, BEAR)]["score"]), n("bm.bur", bur["ups"]), n("bm.bow", bow5["ups"]))),
    ("Rich", "One more thing from Week 5: %s teams lost a game that their best possible lineup would have won. Cutting was one of them, again." % n("bl5.n", len(bench_lost5), "%d")),
    mb=True) + h3("Plays of the week") + plays_inner + h3("Every Week 5 result") +
    table(["Winner", "Loser", "Margin"], res_rows, right=(2,), caption="Biggest margins first. Teams play two or three games a week with the same weekly score."))

# ================================================================== 9. COFFEE SHOP (a weekend, told in order of the story)
q = lambda mid, text, o, when: quote(mid, text, o, when)
assert [AP[x][JM][0] for x in (2, 3, 4, 5)] == [1, 1, 1, 2]
assert U["Malik Willis"]["weeks"]["5"]["status"] == "starter" and U["Malik Willis"]["weeks"]["5"]["owner"] == "Matt Gerardi"
assert sorted(TW[(5, f)]["score"] for f in FIDS)[0] == TW[(5, GER)]["score"] and [g["result"] for g in TW[(5, GER)]["games"]] == ["L", "L", "L"]
klg = [g for g in TW[(5, KLING)]["games"] if g["opp"] == EM][0]; assert klg["result"] == "W" and abs(klg["margin"] - 9.6) < 0.05
assert min(abs(g["margin"]) for (wk, f), t_ in TW.items() if wk == 5 for g in t_["games"]) == 9.6
staf = [p for p in TW[(5, KLING)]["players"] if pname(p["pid"]) == "Matthew Stafford"][0]; assert staf["score"] == 39.3 and staf["status"] == "starter"
coffee = (desk(("Rich", "The standings tell you who is in trouble. The chat tells you who knows it. Kenny."),) + desk(
    ("Kenny", "Thank you, Rich. Monday, 8:21 in the morning, Shawn Blake made an announcement: %s. Fair. Since Week 1, Bear is %s against the field. Three minutes later, Josh Martel checked in: %s. "
     "Josh, you have five. One in Week 2, one in Week 3, one in Week 4 and two this week. I checked, because despair is not an official scoring category. Bear once sat at %s in All-Play, the exact "
     "line Josh has now, and won his division. Josh is at %s to make the playoffs. I&rsquo;m not offering hope. I&rsquo;m just required to read all the numbers." % (
        q("1559179324681093275", "First week was a fluke. Bear has been unstoppable since then", "Shawn Blake", "Mon Oct 12, 8:21 AM ET"),
        rec("k.bear", apw(BEAR, (2, 3, 4, 5)), apl(BEAR, (2, 3, 4, 5))),
        q("1559180011083272243", "Not sure I have an all play win since week 1", "Josh Martel", "Mon Oct 12, 8:24 AM ET"),
        rec("k.b17", b17["apw"], b17["apl"], "D1"), pct("k.jm", O[JM]["po"]))),
    ("Kenny", "Matt Gerardi&rsquo;s weekend had gone wrong a day earlier. Sunday afternoon, Shawn Blake explained why Matt was starting Malik Willis: %s. Willis gave Matt&rsquo;s Gride %s, which was "
     "perfectly respectable. Gride finished with %s, the lowest score of the week, and lost all three. The emergency quarterback was not the emergency." % (
        q("1558921157116305433", "Forced to start this week. Bryce and Mahomes on bye", "Shawn Blake", "Sun Oct 11, 3:16 PM ET"),
        n("k.willis", U["Malik Willis"]["weeks"]["5"]["ups"]), n("k.ger", TW[(5, GER)]["score"]))),
    ("Kenny", "Monday night, with Matthew Stafford still playing for Chris Klingenberg, Eric Martel requested divine intervention: %s. The help went to the other roster. Stafford finished with %s, "
     "and Eric&rsquo;s HammerTime lost the closest game of the week by %s. Eric, the prayer was received. You may need the premium package next week." % (
        q("1559408224636117004", "🙏 for a pick or fumble 6", "Eric Martel", "Mon Oct 12, 11:31 PM ET"), n("k.staf", 39.3), n("k.margin", 9.6))),
    ("Kenny", "Which brings us back to Monday morning, and Bear Dunn&rsquo;s advice on Josh&rsquo;s rebuild: %s Klingenberg&rsquo;s Hawks are at %s to make the playoffs. Josh is at %s, and Josh plays "
     "the Hawks in Week 6. A win takes him to %s. Klingenberg did not post once between Thursday night and Tuesday morning. The standings are doing his talking." % (
        q("1559180424889114725", "Everyone has to rebuild sometimes. Rebuild or become Hawks in perpetuity.", "Bear Dunn", "Mon Oct 12, 8:26 AM ET"),
        pct("k.hawks", O[KLING]["po"]), pct("k.jm2", O[JM]["po"]), pct("k.jmw", jw)))))
assert re.search(r'Chris Klingenberg</td><td class="num">0</td>', AUTO), "Klingenberg posted in the window"
# ================================================================== assemble
S = [("story", "The Big Story", "where the season stands", story), ("odds", "Playoff Picture", "updated after Week 5", odds),
     ("heat", "Heat Check", "full season and the last three weeks", heat), ("brief", "Week 5 in Brief", "Boomer, the plays, every result", brief),
     ("weeks", "Who Is Winning Weeks?", "who the contenders depend on", weeks),
     ("players", "Player Stories", "what changed and what happens next", players), ("survival", "The Survival Line", "what a Week 5 position has meant", survival),
     ("bb", "Above and below expectations", "projection, opportunity and actual points", bb_inner),
     ("coffee", "Coffee Shop Talk", "Kenny Mayne reads the chat", coffee), ("elias", "Elias changes", "", elias_inner)]
body = "\n".join(section(sid, i + 1, t, sub, b) for i, (sid, t, sub, b) in enumerate(S))
head = AUTO[:AUTO.index('<section class="wire-sec"')]
head = head.replace("Automated UPS Center draft (ups_center_auto.py).", "UPS Center Week 5, analytical rebuild of automated draft #1244 (Keith's Week 5 brief, 2026-10-13).")
head = re.sub(r"engine: ups-center-auto[^\n]*", "engine: hand-authored rebuild (scratchpad build_wk05.py) on the automated draft's validated weekly segments; forecast season_sim_2026_live_wk05.json + week_preview_2026_wk06.json", head)
head = head.replace('<div class="wire-eyebrow">Week 5 recap</div>', '<div class="wire-eyebrow">Week 5</div>')
head = re.sub(r'<p class="wire-dek">[\s\S]*?</p>', '<p class="wire-dek">Bear Dunn is pulling away, three 3&ndash;10 teams are standing in historically dangerous territory, and the contenders in between '
              'are finding out which players their seasons depend on.</p>', head)
tail = AUTO[AUTO.rindex("</section>") + len("</section>"):]
tail = re.sub(r'<div class="wire-method">[\s\S]*?</details></div>', (
    '<div class="wire-method"><details><summary class="wire-mh">How this was built <span class="wire-method-count">&mdash; 5 notes</span></summary><div class="wire-method-body">'
    '<div><b>Sources.</b> MFL scores, standings, transactions and injury status; the league&rsquo;s D1 history (results through Week 5 of each past season); the league&rsquo;s playoff brackets; '
    'nflverse play-by-play, snap counts, injury reports and weekly stats 1999&ndash;2026; RotoWire projections via Sleeper and MFL projections for the forecast; the archived league Discord.</div>'
    '<div><b>History scoring.</b> Player comparisons across seasons use 2026 UPS rules applied to every season&rsquo;s box scores. That reproduces MFL&rsquo;s actual 2026 scores exactly in 81% of 952 player-games and within a point in 91%; '
    'box scores do not carry the 50-yard touchdown bonus or return yards. Target counts are missing from 2003&ndash;2008, so target comparisons skip those seasons.</div>'
    '<div><b>Routes.</b> Route participation for 2026 is not available in our sources yet, so role changes are measured by snaps, carries and targets.</div>'
    '<div><b>Forecast.</b> Division titles follow MFL&rsquo;s tiebreak order (record, division record, head-to-head, points, All-Play); every simulated season crowns exactly one winner per division. '
    'Division and title odds are rounded so each group totals exactly 100.0%.</div>'
    '<div><b>Status.</b> Draft for review. Not published or announced.</div></div></details></div>'), tail)
doc = head + body + "\n" + tail

# ================================================================== numeric audit
TIME_RE = re.compile(r"\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}\b|"
                     r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s*(20\d\d)?\b|\b(Week|Weeks|Wk|Wks)\s+\d{1,2}(\s*(&ndash;|–|and|to)\s*\d{1,2})?\b|\b(19|20)\d\d\b|\b\d{1,2}\s*PM\b")
NUM_RE = re.compile(r"(?<![\w.])[-+−]?\d[\d,]*(?:\.\d+)?")
auto_claims = json.load(open(os.path.join(WT, "docs/wire/auto/2026-wk05-ups-center/claims.json")))
auto_shown = set()
for c in auto_claims.values():
    for x in NUM_RE.findall(H.unescape(str(c["shown"]))): auto_shown.add(x.replace(",", "").lstrip("+-−"))
mine = set()
for _, s, _ in CLAIMS:
    for x in NUM_RE.findall(H.unescape(s)): mine.add(x.replace(",", "").lstrip("+-−"))
FIXED = {"100", "37", "13", "90", "60", "25", "8", "28", "33", "5", "1", "2", "3", "4", "6", "10", "12", "20", "24", "1999", "2009", "2002", "2017", "2021", "2025", "18", "11", "81", "952", "91", "50"}
def vis(sec):
    t = re.sub(r'<a class="rcpt"[^>]*>[\s\S]*?</a>', " ", sec)
    t = re.sub(r"<[^>]+>", " ", t); t = H.unescape(t)
    return TIME_RE.sub(" ", t)
bad = []
for sid, t, sub, b in S:
    reused = sid in ("bb", "elias")
    text = vis(b if sid not in ("brief", "coffee") else b.replace(desk_inner, "").replace(plays_inner, "").replace(post_table, ""))
    pool = auto_shown if reused else (mine | FIXED | (auto_shown if sid == "brief" else set()))   # brief reuses Boomer's validated box lines
    for x in NUM_RE.findall(text):
        k = x.replace(",", "").lstrip("+-−")
        if k not in pool: bad.append((sid, x))
for part in (desk_inner, plays_inner, post_table, bb_inner, elias_inner):
    for x in NUM_RE.findall(vis(part)):
        k = x.replace(",", "").lstrip("+-−")
        if k not in auto_shown and k not in {"1", "2", "3", "4", "5"}: bad.append(("reused", x))
if bad:
    print("UNREGISTERED NUMBERS:", sorted(set(bad))[:60]); sys.exit(1)
open(ART, "w", encoding="utf-8").write(doc)
json.dump([dict(key=k, shown=s, source=src) for k, s, src in CLAIMS], open(os.path.join(DIR, "claims_wk05.json"), "w"), indent=1)
words = {sid: len(vis(b).split()) for sid, t, sub, b in S}
print("written", ART, len(doc), "bytes; claims", len(CLAIMS), "; words by segment", words, "total", sum(words.values()))
