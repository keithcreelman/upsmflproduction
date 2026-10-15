#!/usr/bin/env python3
"""UPS Center Week 5 -- the analytical rebuild of automated draft #1244.

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

# ================================================================== 1. THE BIG STORY
top4 = [f for f in by_odds if O[f]["po"] >= 0.90]
assert top4 == [BEAR, CUT, BLAKE, EM], [owner(f) for f in top4]
h3t = F["history"]["h2h_groups"][-1]
story = desk(
    ("Stuart", "Thirteen games into a 37-game season, Rich, the league has split into three groups. At the top, Bear Dunn. "
     "He lost eight of eleven all-play games in Week 1. Since then he is %s against the field, and our forecast gives him a %s chance at the playoffs "
     "and %s at a first-round bye." % (rec("bear.ap2_5", apw(BEAR, (2, 3, 4, 5)), apl(BEAR, (2, 3, 4, 5))), pct("o.bear.po", O[BEAR]["po"]), pct("o.bear.bye", O[BEAR]["bye"]))),
    ("Rich", "Three more teams sit at 90%% or better: Brian Cutting %s, Shawn Blake %s, Eric Martel %s. Cutting is the strange one. He is %s, "
     "and he has the second-best title chance in the league, %s, behind only Bear&rsquo;s %s." % (
        pct("o.cut.po", O[CUT]["po"]), pct("o.blake.po", O[BLAKE]["po"]), pct("o.em.po", O[EM]["po"]), rec("cut.rec", T[CUT]["W"], T[CUT]["L"]),
        pct("o.cut.title", O[CUT]["title"]), pct("o.bear.title", O[BEAR]["title"]))),
    ("Stuart", "At the bottom, three teams at 3&ndash;10: Matt Gerardi, Brian Cross and Josh Martel, at %s, %s and %s. Since 2021, when this league started playing "
     "thirteen games by Week 5, %s teams have had three wins or fewer at this point. %s made the playoffs." % (
        pct("o.ger.po", O[GER]["po"]), pct("o.cross.po", O[CROSS]["po"]), pct("o.jm.po", O[JM]["po"]), n("h.le3.n", h3t[2], "%d", "D1 src_schedule 2021-2025"),
        "None" if h3t[1] == 0 else n("h.le3.made", h3t[1], "%d"))),
    ("Rich", "That leaves the middle: Keith Creelman at %s, Chris Klingenberg at %s, Derrick Whitman at %s, chasing the last two places. "
     "Klingenberg plays three games in Week 6, and all three are among the six with the most at stake. The numbers tell us who is pulling away. "
     "The rest of the show is why." % (pct("o.kc.po", O[KC]["po"]), pct("o.kling.po", O[KLING]["po"]), pct("o.whit.po", O[WHIT]["po"]))),
)

# ================================================================== 2. PLAYOFF PICTURE
meta = F["odds_meta"]
et = lambda iso: (datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) - timedelta(hours=4))
RUNS = "{:,}".format(meta["runs"]); CLAIMS.append(("meta.runs", RUNS, "season_sim runs"))
inputs_et = et(meta["inputs"]).strftime("%a %b %-d, %-I:%M %p ET")
wk3_et = et(meta["wk3_cutoff"]).strftime("%a %b %-d, %-I:%M %p ET")
moves = sorted(FIDS, key=lambda f: -abs(O[f]["po"] - O[f]["po_wk3"]))
reason = {
    BLAKE: "%s in Weeks 4 and 5 and %s against the field; traded for Derrick Henry on Oct 6, and Henry scored %s for him in Week 5. Both division rivals slipped: Whitman went %s, Gerardi %s." % (
        rec("blake.w45", T[BLAKE]["w45"], T[BLAKE]["l45"]), rec("blake.ap45", T[BLAKE]["ap45"][0], T[BLAKE]["ap45"][1]),
        n("henry.wk5", F["players"]["ups"]["Derrick Henry"]["weeks"]["5"]["ups"]), rec("whit.w45", T[WHIT]["w45"], T[WHIT]["l45"]), rec("ger.w45", T[GER]["w45"], T[GER]["l45"])),
    WHIT: "%s and %s against the field in Weeks 4 and 5, and Jayden Reed went on injured reserve (neck; MFL lists his return as Feb 15, 2027, after the season)." % (
        rec("whit.w45b", T[WHIT]["w45"], T[WHIT]["l45"]), rec("whit.ap45", T[WHIT]["ap45"][0], T[WHIT]["ap45"][1])),
    KLING: "Only %s in Weeks 4 and 5, but %s against the field, and Whitman, the team just ahead of him in the wild-card race, lost more ground." % (
        rec("kling.w45", T[KLING]["w45"], T[KLING]["l45"]), rec("kling.ap45", T[KLING]["ap45"][0], T[KLING]["ap45"][1])),
    JM: "%s and %s against the field in Weeks 4 and 5; Lamar Jackson traded away on Sep 29; De&rsquo;Von Achane on injured reserve with a torn ACL (MFL: back Feb 15, 2027); Caleb Williams out three straight games with a hamstring." % (
        rec("jm.w45", T[JM]["w45"], T[JM]["l45"]), rec("jm.ap45", T[JM]["ap45"][0], T[JM]["ap45"][1])),
}
assert set(moves[:4]) == {BLAKE, WHIT, KLING, JM}, [owner(f) for f in moves[:4]]
mv_lines = "".join("<li>%s: %s &rarr; %s (%s). %s</li>" % (
    who(f, True), pct("o.%s.wk3" % f, O[f]["po_wk3"]), pct("o.%s.po2" % f, O[f]["po"]), pp("o.%s.d" % f, O[f]["po"] - O[f]["po_wk3"]), reason[f]) for f in moves[:4])
odds_rows = [[ini(f), pct("o.%s.po3" % f, O[f]["po"]), pp("o.%s.d2" % f, O[f]["po"] - O[f]["po_wk3"]), pct("o.%s.div" % f, O[f]["div"])] for f in by_odds]
win_rows = [[ini(f), pct("o.%s.bye" % f, O[f]["bye"]), pct("o.%s.title" % f, O[f]["title"]), pp("o.%s.dt" % f, O[f]["title"] - O[f]["title_wk3"])]
            for f in sorted(FIDS, key=lambda f: -O[f]["title"])]
g6items = []
for g in G6[:4]:
    a, b = g["a"], g["b"]; fav = a if g["pA"] >= .5 else b
    g6items.append("<li><b>%s vs %s</b>: %s favored at %s. Playoff odds with a win / a loss: %s %s / %s, %s %s / %s.</li>" % (
        e(owner(a)), e(owner(b)), e(owner(fav)), pct("g.%s%s.p" % (a, b), max(g["pA"], 1 - g["pA"])),
        e(owner(a).split()[-1]), pct("g.%s%s.aw" % (a, b), g["aW"]), pct("g.%s%s.al" % (a, b), g["aL"]),
        e(owner(b).split()[-1]), pct("g.%s%s.bw" % (a, b), g["bW"]), pct("g.%s%s.bl" % (a, b), g["bL"])))
odds = (desk(
    ("Stuart", "These are current odds, Rich, run after Monday night&rsquo;s game, and they are the first we have published since the Week 3 issue on Sep 30. "
     "Week 4 went out without them. The forecast is still run by hand, that issue was a catch-up finished the day Week 5 kicked off, and the only forecast the builder had on file "
     "was the one run after Week 2, so we left odds out rather than print stale ones."),
    ("Rich", "The biggest moves since Week 3 are below, and the reasons are what happened on the field and on the injury report. The model re-runs the whole season "
     "on today&rsquo;s rosters; it does not split a move into luck and strength.")) +
    h3("Making it") +
    table(["Team", "Playoffs", "Since Wk&nbsp;3", "Wins division"], odds_rows, right=(1, 2, 3),
          caption="Chance in %s simulated seasons. &ldquo;Since Wk 3&rdquo; is the change in percentage points from the odds in our Week 3 issue (cutoff %s)." % (RUNS, wk3_et)) +
    h3("Winning it") +
    table(["Team", "First-round bye", "Title", "Title since Wk&nbsp;3"], win_rows, right=(1, 2, 3), caption="Byes go to the top two seeds, which must be division winners.") +
    h3("The four biggest moves since Week 3") + '<ul style="margin:.2rem 0 1rem 1.1rem;line-height:1.55">%s</ul>' % mv_lines +
    h3("Week 6: where the odds move most") +
    '<ul style="margin:.2rem 0 .4rem 1.1rem;line-height:1.55">%s</ul>' % "".join(g6items) +
    '<p class="caption">The four Week 6 games whose result moves playoff odds the most, from the same simulated seasons. Single-game chances have not been tested against past seasons, so treat them as rough.</p>' +
    box("How these odds are made.", "Data through Week 5, Monday night included. Inputs fetched %s; %s simulated seasons. Weeks 1&ndash;5 are fixed to the real results and the other "
        "%s games of each team&rsquo;s schedule are simulated from current rosters and weekly projections: RotoWire&rsquo;s projected stat lines (via Sleeper) scored with UPS rules for "
        "offense, with MFL&rsquo;s projections as the backup for anyone RotoWire does not project and for defenders, kickers and punters, and MFL deciding who plays. Each team keeps %s%% of its "
        "projected edge over an average team, calibrated to UPS 2021&ndash;2025. Seeds follow the league rule: All-Play %%, then overall record, then points. It does not know about trades or "
        "waiver moves after the cutoff, it starts every team&rsquo;s best projected lineup, and it counts Questionable players as available (Rico Dowdle included). On MFL&rsquo;s own offensive "
        "projections instead, four teams&rsquo; playoff odds move by ten points or more; RotoWire has tested as the more accurate source, so it is the one we print." % (
            inputs_et, RUNS, n("meta.remaining", 37 - 13, "%d", "MFL schedule"), n("meta.keep", 100 * meta["regress"], "%d", "season_sim k"))))

# ================================================================== 3. HEAT CHECK
def label(f):
    t = T[f]; a3 = t["ap3"][0]
    if a3 >= 28: return "Dominant"
    if a3 <= 5: return "Sinking"
    if t["rk12"] - t["rk3"] >= 4: return "Rising"
    if t["rk3"] - t["rk12"] >= 4: return "Cooling"
    return "Holding"
LAB = {f: label(f) for f in FIDS}
assert max(FIDS, key=lambda f: T[f]["ap3"][0]) == BEAR and T[EM]["rk12"] == 1 and max(FIDS, key=lambda f: T[f]["bench_w"]) == CUT
import statistics as _st
assert max(FIDS, key=lambda f: _st.pstdev(T[f]["weekly"])) == MAN
heat_rows = [[ini(f), "%s<br>%s" % (rec("ap.%s" % f, T[f]["apw"], T[f]["apl"]), rec("ap3.%s" % f, T[f]["ap3"][0], T[f]["ap3"][1])),
              "%s &rarr; %s" % (ordn("rk12.%s" % f, T[f]["rk12"]), ordn("rk3.%s" % f, T[f]["rk3"])), "<b>%s</b>" % LAB[f]]
             for f in sorted(FIDS, key=lambda f: -T[f]["apw"])]
lineup_rows = [[ini(f), n("bench.%s" % f, T[f]["bench_w"]), n("luck.%s" % f, T[f]["luck"], "%+.1f").replace("-", "&minus;"),
                n("lost.%s" % f, T[f]["lost_best"], "%d")] for f in sorted(FIDS, key=lambda f: -T[f]["bench_w"])]
em, wh, ger, bou, man, cut = T[EM], T[WHIT], T[GER], T[BOUS], T[MAN], T[CUT]
heat = (desk(
    ("Stuart", "Two views of every team: the whole season, and the last three weeks. Three weeks is long enough to show a direction and short enough that one huge Sunday "
     "cannot hide in it. It describes form. It does not predict it."),
    ("Rich", "Bear first. Over Weeks 3 to 5 he is %s against the field, the best three-week stretch in the league, and he went from %s in scoring over the first two weeks to %s."
     % (rec("bear.ap3", T[BEAR]["ap3"][0], T[BEAR]["ap3"][1]), ordn("bear.rk12", T[BEAR]["rk12"]), ordn("bear.rk3", T[BEAR]["rk3"]))),
    ("Stuart", "Eric Martel is the record that is hiding a slide. He led the league in scoring over the first two weeks at %s a week; over the last three he is %s at %s. "
     "He is still %s, and still %s to make the playoffs." % (n("em.ppw12", em["ppw12"]), ordn("em.rk3", em["rk3"]), n("em.ppw3", em["ppw3"]), rec("em.rec", em["W"], em["L"]), pct("o.em.po3", O[EM]["po"]))),
    ("Rich", "Matt Gerardi has fallen the hardest: %s in scoring early, %s now, and %s against the field across the last three weeks. Derrick Whitman went from %s to %s."
     % (ordn("ger.rk12", ger["rk12"]), ordn("ger.rk3", ger["rk3"]), rec("ger.ap3", ger["ap3"][0], ger["ap3"][1]), ordn("whit.rk12", wh["rk12"]), ordn("whit.rk3", wh["rk3"]))),
    ("Stuart", "Going the other way: Ryan Bousquet, %s to %s in scoring, and Eric Mannila, %s to %s. Mannila&rsquo;s weeks have been %s, %s, %s, %s and %s wins against the field. "
     "Nobody in the league swings harder." % (ordn("bou.rk12", bou["rk12"]), ordn("bou.rk3", bou["rk3"]), ordn("man.rk12", man["rk12"]), ordn("man.rk3", man["rk3"]),
                                             *[n("man.apw%d" % i, v, "%d") for i, v in enumerate(man["apw_by_week"])])),
    ("Rich", "And Brian Cutting. His best possible lineup has averaged %s a week, %s in the league. He has left %s a week on his bench, the most of anyone, and %s of his %s "
     "losses were games his best lineup would have won." % (n("cut.opt", cut["optw"]), ordn("cut.rkopt", cut["rkopt"]), n("cut.bench", cut["bench_w"]), n("cut.lost", cut["lost_best"], "%d"),
                                                             n("cut.L", cut["L"], "%d")))) +
    table(["Team", "All-Play: season, then Wks&nbsp;3&ndash;5", "Scoring rank: Wks 1&ndash;2 &rarr; 3&ndash;5", "Reading"], heat_rows, right=(1,),
          caption="Reading, applied in order: <b>Dominant</b> = 28 or more of 33 all-play wins in Weeks 3&ndash;5; <b>Sinking</b> = 5 or fewer; <b>Rising</b> / <b>Cooling</b> = scoring rank moved four or more places between Weeks 1&ndash;2 and Weeks 3&ndash;5; otherwise <b>Holding</b>.") +
    table(["Team", "Left on bench / wk", "Wins vs expected", "Losses his best lineup wins"], lineup_rows, right=(1, 2, 3),
          caption="Bench points = MFL&rsquo;s best possible lineup from the same roster (known only after the games) minus the lineup started. Wins vs expected = actual head-to-head wins minus the wins each week&rsquo;s all-play rate would give."))

# ================================================================== 4. WHO IS WINNING WEEKS
tpp = F["team_players"]
pw = json.load(open(os.path.join(DIR, "player_weeks.json")))
POS = {r["name"]: r["pos"] for r in pw}
def contributors(f):
    rows = [(nm, v) for nm, v in tpp[f].items() if POS.get(nm) not in ("PK", "PN")]
    rows.sort(key=lambda kv: -kv[1]["par"])
    pos_total = sum(v["par"] for _, v in rows if v["par"] > 0)
    return rows, pos_total
ww_rows = []
for f in sorted(FIDS, key=lambda f: -O[f]["po"]):
    rows, tot = contributors(f)
    (n1, v1), (n2, v2) = rows[0], rows[1]
    started = sum(v["pts"] for v in tpp[f].values())
    ww_rows.append([ini(f), "%s %s<br>%s %s" % (e(n1), n("ww.%s.p1" % f, v1["par"], "%+.0f"), e(n2), n("ww.%s.p2" % f, v2["par"], "%+.0f")),
                    n("ww.%s.top2" % f, 100 * (v1["par"] + v2["par"]) / tot, "%.1f") + "%",
                    n("ww.%s.sw" % f, max(len(v["sw"]) for _, v in rows), "%d")])
allp = [(f, nm, v) for f in FIDS for nm, v in contributors(f)[0]]
mostsw = sorted(allp, key=lambda x: (-len(x[2]["sw"]), -x[2]["par"]))[:2]
toppar = sorted(allp, key=lambda x: -x[2]["par"])[:3]
mrows, mtot = contributors(MAN); brows, btot = contributors(BLAKE); bearrows, beartot = contributors(BEAR)
weeks = (desk(
    ("Stuart", "Who is actually winning these weeks? Not just who scored. We measure each starter against a replacement-level player at his position that week: the average of the six "
     "rostered players just outside the league&rsquo;s starting pool. Kickers and punters are left out."),
    ("Rich", "The biggest edges this season: %s, %s for %s; %s, %s for %s; %s, %s for %s." % tuple(
        x for f, nm, v in toppar for x in (e(nm), n("ww.top.%s" % nm, v["par"], "%+.1f"), e(owner(f))))),
    ("Stuart", "A matchup swing is a win the player&rsquo;s edge over replacement was bigger than the winning margin: put a replacement in his slot and that game flips. "
     "Two players lead the league with %s each: %s for %s and %s for %s. Swings overlap, so they do not add up to wins." % (
        n("ww.maxsw", len(mostsw[0][2]["sw"]), "%d"), e(mostsw[0][1]), e(owner(mostsw[0][0])), e(mostsw[1][1]), e(owner(mostsw[1][0])))),
    ("Rich", "Concentration risk: two teams lean hardest on two players. Shawn Blake&rsquo;s quarterbacks, %s and %s, are %s of his team&rsquo;s whole edge over replacement; "
     "Eric Mannila&rsquo;s %s and %s are %s of his. Bear&rsquo;s top two are %s. Lose one of those players and Blake or Mannila loses more than anyone else would." % (
        e(brows[0][0]), e(brows[1][0]), n("ww.blake.share", 100 * (brows[0][1]["par"] + brows[1][1]["par"]) / btot, "%.1f") + "%",
        e(mrows[0][0]), e(mrows[1][0]), n("ww.man.share", 100 * (mrows[0][1]["par"] + mrows[1][1]["par"]) / mtot, "%.1f") + "%",
        n("ww.bear.share", 100 * (bearrows[0][1]["par"] + bearrows[1][1]["par"]) / beartot, "%.1f") + "%"))) +
    table(["Team", "Two biggest edges", "Top-two share", "Most swings, one player"], ww_rows, right=(2, 3),
          caption="Edge = started points minus replacement level, Weeks 1&ndash;5, credited to whichever team started him that week. Top-two share = the two biggest edges as a share of every positive edge on the team. Most swings = the most matchup swings by one player on the team."))
top2share = {f: (lambda r, t: (r[0][1]["par"] + r[1][1]["par"]) / t)(*contributors(f)) for f in FIDS}
assert sorted(top2share, key=top2share.get)[-2:] == [MAN, BLAKE], [owner(f) for f in sorted(top2share, key=top2share.get)[-2:]]
assert {brows[0][0], brows[1][0]} == {"Josh Allen", "Brock Purdy"}
assert {owner(mostsw[0][0]), owner(mostsw[1][0])} == {"Keith Creelman", "Derrick Whitman"} and len(mostsw[1][2]["sw"]) == len(mostsw[0][2]["sw"])

# ================================================================== 5. PLAYER STORIES
P = F["players"]; w = P["warren"]; U = P["ups"]
wv = lambda k, i: w[k][str(i)]
shared = (1, 2); without = (3, 4, 5)
w_sh = sum(wv("ups", i) for i in shared) / 2; w_wo = sum(wv("ups", i) for i in without) / 3
car_sh = sum(wv("car", i) for i in shared); rb_sh = sum(wv("rbcar", i) for i in shared)
car_wo = sum(wv("car", i) for i in without); rb_wo = sum(wv("rbcar", i) for i in without)
pit_rows = [["%d" % i, "%s / %s" % (n("w.snap%d" % i, 100 * wv("snap", i), "%.0f") + "%", (n("d.snap%d" % i, 100 * w["dsnap"][str(i)], "%.0f") + "%") if w["dsnap"][str(i)] else "out"),
             "%s/%s" % (n("w.car%d" % i, wv("car", i), "%d"), n("w.rbcar%d" % i, wv("rbcar", i), "%d")), n("w.tgt%d" % i, wv("tgt", i), "%d"), n("w.ups%d" % i, wv("ups", i))] for i in WEEKS]
bx = w["wk5_box"]
pit = (h3("1. Pittsburgh&rsquo;s backfield: Jaylen Warren&rsquo;s job and Rico Dowdle&rsquo;s toe") + desk(
    ("Stuart", "This one runs through two UPS teams. Jaylen Warren is Ryan Bousquet&rsquo;s running back. Rico Dowdle, the Steelers back who shared the job with him, sits on Shawn Blake&rsquo;s bench."),
    ("Rich", "What changed: Dowdle hurt his toe and was ruled out for Weeks 3 and 4. He was listed Questionable for Week 5 after limited practice, and still did not play. In the two games they shared, "
     "Warren had %s of the %s running-back carries; in the three without Dowdle he had %s of %s, and his snap share went to %s, %s and %s."
     % (n("w.car_sh", car_sh, "%d"), n("w.rb_sh", rb_sh, "%d"), n("w.car_wo", car_wo, "%d"), n("w.rb_wo", rb_wo, "%d"),
        n("w.s3", 100 * wv("snap", 3), "%.0f") + "%", n("w.s4", 100 * wv("snap", 4), "%.0f") + "%", n("w.s5", 100 * wv("snap", 5), "%.0f") + "%")),
    ("Stuart", "For Bousquet it has been worth %s UPS points a game without Dowdle, against %s with him. Two of those wins were matchup swings: Week 3 over Brian Cross by %s and Week 5 over Derrick Whitman by %s."
     % (n("w.wo", w_wo), n("w.sh", w_sh), n("w.sw3", 1.9), n("w.sw5", 17.4))),
    ("Rich", "Be careful with Week 5&rsquo;s %s. Warren carried %s times for %s yards and caught %s of %s targets for %s, but the points came from two long plays: an %s-yard catch-and-run "
     "and a %s-yard run, both touchdowns. He had %s touches inside the 20. The workload is real. The total will not repeat on schedule."
     % (n("w.ups5b", wv("ups", 5)), n("bx.car", bx["carries"], "%d"), n("bx.ryd", bx["rushing_yards"], "%d"), n("bx.rec", bx["receptions"], "%d"), n("bx.tgt", bx["targets"], "%d"),
        n("bx.yds", bx["receiving_yards"], "%d"), n("bx.td1", w["wk5_tds"][0][0], "%d"), n("bx.td2", w["wk5_tds"][1][0], "%d"), "no" if w["wk5_rz"] == 0 else n("bx.rz", w["wk5_rz"], "%d"))),
    ("Stuart", "What happens next is not settled, and we will not pretend it is. Week 1, with both healthy, Dowdle played %s of the snaps and Warren %s. Week 2 it flipped: Warren %s, Dowdle %s. "
     "Pittsburgh is at Tampa Bay on Sunday at 1 PM. Watch Dowdle&rsquo;s practice reports Wednesday to Friday, his game status Friday, and the first-half snap split. "
     "Our forecast already counts him as available, because MFL still lists him Questionable."
     % (n("d.s1", 100 * w["dsnap"]["1"], "%.0f") + "%", n("w.s1", 100 * wv("snap", 1), "%.0f") + "%", n("w.s2", 100 * wv("snap", 2), "%.0f") + "%", n("d.s2", 100 * w["dsnap"]["2"], "%.0f") + "%")),
    ("Rich", "For Blake, Dowdle is depth: %s and %s points from the bench in the two games he played. For Bousquet, at %s to make the playoffs, Warren has been %s of his team&rsquo;s starting points." % (
        n("d.u1", w["dups"]["1"]), n("d.u2", w["dups"]["2"]), pct("o.bou.po", O[BOUS]["po"]), n("w.share", 100 * tpp[BOUS]["Jaylen Warren"]["pts"] / sum(v["pts"] for v in tpp[BOUS].values()), "%.0f") + "%")),
) + table(["Wk", "Snaps: Warren / Dowdle", "Warren carries / all RB", "Warren tgts", "Warren pts"], pit_rows, right=(2, 3, 4),
          caption="nflverse play-by-play and snap counts; injury designations from the official NFL report. Week 6 practice reports begin Wednesday."))
assert abs(w_wo - 26.2) < 0.05 and abs(w_sh - 9.9) < 0.05
sw = tpp[BOUS]["Jaylen Warren"]["sw"]; assert [round(x[2], 1) for x in sw] == [1.9, 17.4] and [x[1] for x in sw] == ["Brian Cross", "Derrick Whitman"]

gb = P["gibbs"]; gm = gb["me"]; ab = gb["above"]
QBS = sorted({pname(p["pid"]) for (wk, f), tt in TW.items() if f == CUT for p in tt["players"] if ppos(p["pid"]) == "QB"})
N_QB = {7: "Seven", 6: "Six", 5: "Five", 8: "Eight"}[len(QBS)]
hu, ro, wa = (U[x]["weeks"]["5"] for x in ("Tyler Huntley", "Aaron Rodgers", "Deshaun Watson"))
rg = P["regression"]
GCW = next(g for g in G6 if {g["a"], g["b"]} == {WHIT, CUT}); WHIT_LOSS = GCW["aL"] if GCW["a"] == WHIT else GCW["bL"]
cutting = (h3("2. Pure Greatness: a 6&ndash;7 title contender") + desk(
    ("Stuart", "Brian Cutting has the league&rsquo;s most valuable player by our measure. Jahmyr Gibbs has %s UPS points through Detroit&rsquo;s first five games: %s carries for %s yards and %s touchdowns, "
     "plus %s catches. Score every running back since 1999 by this year&rsquo;s UPS rules and only two started better: %s in %s with %s, and %s in %s with %s."
     % (n("g.pts", gm["pts"]), n("g.car", gm["car"], "%d"), n("g.ryd", gm["rushyd"], "%d"), n("g.rtd", gm["rushtd"], "%d"), n("g.rec", gm["rec"], "%d"),
        e(ab[0]["name"]), ab[0]["season"], n("g.a0", ab[0]["pts"]), e(ab[1]["name"]), ab[1]["season"], n("g.a1", ab[1]["pts"]))),
    ("Rich", "How unusual, and how likely to last? The 25 best five-game starts by running backs before this year kept about %s%% of that pace for the rest of their seasons. "
     "At that rate he is a %s-a-game back instead of a %s-a-game one." % (n("rg.rb", rg["RB"]["mean"], "%d"), n("g.ppg80", gm["pts"] / 5 * rg["RB"]["mean"] / 100), n("g.ppg", gm["pts"] / 5))),
    ("Stuart", "So why %s? The lineups. In Week 5 Cutting started Deshaun Watson, who scored %s, while Tyler Huntley scored %s and Aaron Rodgers %s on his bench. Huntley came over with Lamar Jackson in "
     "the Sep 29 trade with Josh Martel, and Jackson did not play Sunday. %s quarterbacks have been on Cutting&rsquo;s roster in five weeks." % (
        rec("cut.rec2", T[CUT]["W"], T[CUT]["L"]), n("wa5", wa["ups"]), n("hu5", hu["ups"]), n("ro5", ro["ups"]), N_QB)),
    ("Rich", "The forecast does not care who he started. It projects his best lineup every week, which is why he is %s to make the playoffs and %s for the title. Two things to watch: "
     "Detroit has a bye in Week 6, so no Gibbs, and Cutting plays Derrick Whitman, whom a loss would leave at %s." % (
        pct("o.cut.po2", O[CUT]["po"]), pct("o.cut.title2", O[CUT]["title"]), pct("g6.whit.loss", WHIT_LOSS))))
)
assert ab[0]["name"] == "Priest Holmes" and ab[1]["name"] == "Christian McCaffrey" and gb["rank"] == 3
assert len(QBS) == 7, QBS

js = P["jsn"]; jm_ = js["me"]; bow = P["bowers_span"]; bw = U["Brock Bowers"]["weeks"]
bear = (h3("3. Bear Dunn&rsquo;s receivers: Jaxon Smith-Njigba and Brock Bowers") + desk(
    ("Stuart", "Bear&rsquo;s run has two engines. Jaxon Smith-Njigba has %s UPS points in Seattle&rsquo;s five games: %s catches on %s targets, %s yards, %s touchdowns, and %s%% of the Seahawks&rsquo; targets a game on average. "
     "Score every receiver since 1999 the same way, from box scores under this year&rsquo;s rules, and only %s in %s had a better first five games: %s to Smith-Njigba&rsquo;s %s."
     % (n("j.pts", sum(U["Jaxon Smith-Njigba"]["weeks"][str(i)]["ups"] for i in WEEKS)), n("j.rec", jm_["rec"], "%d"), n("j.tgt", jm_["tgt"], "%d"),
        n("j.yds", jm_["recyd"], "%d"), n("j.td", jm_["rectd"], "%d"), n("j.ts", 100 * jm_["ts"], "%.0f"), e(js["above"][0]["name"]), js["above"][0]["season"], n("j.a0", js["above"][0]["pts"]), n("j.box", jm_["pts"]))),
    ("Rich", "Brock Bowers missed the first two weeks with a knee injury. In three games back he has %s, %s and %s points on %s, %s and %s targets. That is the best three-game run by any tight end this season, "
     "%s points clear of %s, and %s of the %s tight-end seasons since 1999 have had a better three-game run. Bear started him for the last two of those games. The %s in the first one came off his bench."
     % (n("b.u3", bw["3"]["ups"]), n("b.u4", bw["4"]["ups"]), n("b.u5", bw["5"]["ups"]), n("b.t3", bw["3"]["tgt"], "%d"), n("b.t4", bw["4"]["tgt"], "%d"), n("b.t5", bw["5"]["tgt"], "%d"),
        n("b.gap", bow["pts"] - bow["next2026"][0]), e(bow["next2026"][1]), n("b.rank", bow["rank"] - 1, "%d"), "{:,}".format(bow["n"]), n("b.u3b", bw["3"]["ups"]))),
    ("Stuart", "What happens next: the 25 best five-game receiver starts before this year kept about %s%% of their pace. Smith-Njigba plays Thursday night at Denver. And Bear is %s for a first-round bye." % (
        n("rg.wr", rg["WR"]["mean"], "%d"), pct("o.bear.bye2", O[BEAR]["bye"]))),
))
CLAIMS.append(("b.n", "{:,}".format(bow["n"]), "nflverse TE seasons"))
assert js["rank"] == 2 and js["above"][0]["name"] == "Wes Welker" and bow["rank2026"] == 1
assert [bw[str(i)]["status"] for i in (3, 4, 5)] == ["nonstarter", "starter", "starter"] and all(bw[str(i)]["owner"] == "Bear Dunn" for i in (3, 4, 5))

tg = P["targets"]; pk = U["Puka Nacua"]["weeks"]
import polars as _pl
_pb = _pl.read_parquet(os.path.join(DIR, "ps_2026.parquet")).filter((_pl.col("player_display_name") == "Puka Nacua") & (_pl.col("week") == 5)).to_dicts()[0]
_g = _pl.read_parquet(os.path.join(DIR, "sched_2026.parquet")).filter((_pl.col("week") == 5) & (_pl.col("home_team") == "LA")).to_dicts()[0]
assert (_pb["targets"], _pb["receptions"], _pb["receiving_yards"], _pb["receiving_tds"]) == (24, 17, 138, 1) and (_g["away_team"], _g["away_score"], _g["home_score"]) == ("BUF", 37, 34)
targets = (h3("4. Twenty-four targets") + desk(
    ("Stuart", "Monday night, Puka Nacua was targeted %s times for Keith Creelman and caught %s for %s yards and a touchdown: %s UPS points in a %s&ndash;%s loss to Buffalo. "
     "In every season with target data, %s, 2009 on, one player has been targeted more in a regular-season game: Brandon Marshall, %s, in 2009."
     % (n("p.tgt", pk["5"]["tgt"], "%d"), n("p.rec", 17, "%d"), n("p.yds", 138, "%d"), n("p.ups", pk["5"]["ups"]), n("p.bills", 37, "%d"), n("p.rams", 34, "%d"), "1999&ndash;2002 and", n("p.marsh", 28, "%d"))),
    ("Rich", "There have been three 20-target games this season, and all three were on UPS rosters: Nacua&rsquo;s, CeeDee Lamb&rsquo;s %s in Week 4 and Malik Nabers&rsquo; %s in Week 5. Eric Mannila owns the other two."
     % (n("p.lamb", 21, "%d"), n("p.nab", 20, "%d"))),
    ("Stuart", "Now the part owners will not like. %s earlier 20-target games in that history were followed by another game, and in it the same player averaged %s targets. Lamb followed his %s with %s targets and %s points. "
     "Nacua missed Weeks 2 and 3 with a hip injury and has %s and %s points since he came back. The Rams host Arizona on Sunday." % (
        n("p.n", tg["next_n"], "%d"), n("p.next", tg["next_mean"]), n("p.lamb2", 21, "%d"), n("p.lamb_t", 5, "%d"), n("p.lamb_u", U["CeeDee Lamb"]["weeks"]["5"]["ups"]),
        n("p.u4", pk["4"]["ups"]), n("p.u5", pk["5"]["ups"]))),
))
assert tg["more_than_24"] == [[2009, 14, "Brandon Marshall", 28]] and tg["y2026"] == [[5, "Puka Nacua", 24], [4, "CeeDee Lamb", 21], [5, "Malik Nabers", 20]]
assert U["CeeDee Lamb"]["weeks"]["5"]["tgt"] == 5 and pk["5"]["owner"] == "Keith Creelman"
assert U["CeeDee Lamb"]["weeks"]["4"]["owner"] == "Eric Mannila" and U["Malik Nabers"]["weeks"]["5"]["owner"] == "Eric Mannila"

players = desk(("Rich", "Four stories, picked from a scan of every rostered player for role changes, returns from injury, unusual usage and swings in UPS games. "
                "Each answers the same questions: what changed, why, how unusual it is, who it helped in this league, and what to watch next."),) + pit + cutting + bear + targets

# ================================================================== 6. THE SURVIVAL LINE
hist = F["history"]
cat = lambda p: ("Contender" if p >= .90 else "In the field" if p >= .60 else "In the race" if p >= .25 else "Needs a run" if p >= .08 else "Life support")
grp_ap = {lab: (m, nn) for lab, m, nn in hist["ap_groups"]}
def ap_group(rk): return next(lab for lab in grp_ap if int(lab.split("–")[0]) <= rk <= int(lab.split("–")[1]))
grp_w = hist["h2h_groups"]
def w_group(wins):
    return next(lab for lab, m, nn in grp_w if (lab == "10 or more" and wins >= 10) or (lab == "3 or fewer" and wins <= 3) or ("–" in lab and int(lab.split("–")[0]) <= wins <= int(lab.split("–")[1])))
surv_rows = []
for f in by_odds:
    g = ap_group(T[f]["aprk"]); m, nn = grp_ap[g]
    wg = w_group(T[f]["W"]); m2, nn2 = next((x[1], x[2]) for x in grp_w if x[0] == wg)
    surv_rows.append([ini(f), "<b>%s</b><br>%s" % (cat(O[f]["po"]), pct("s.%s.po" % f, O[f]["po"])),
                      "%s/%s" % (n("s.%s.m" % f, m, "%d"), n("s.%s.n" % f, nn, "%d")), "%s/%s" % (n("s.%s.m2" % f, m2, "%d"), n("s.%s.n2" % f, nn2, "%d"))])
b17 = hist["bear2017"]; auc = hist["auc"]; b3 = hist["bottom3"]
survival = (desk(
    ("Stuart", "What has a Week 5 position meant in this league? We rebuilt every season&rsquo;s standings as they stood after Week 5, using nothing from later in those seasons, and checked who made the playoffs. "
     "The comparable seasons are 2017 to 2025, the years with today&rsquo;s format: four division winners and two wild cards, seeded by All-Play. Only 2021 on had thirteen head-to-head games by Week 5, like this year."),
    ("Rich", "The finding: All-Play at Week 5 has sorted the eventual playoff teams from the rest a little better than record or points. Compare a playoff team with a non-playoff team from 2020 to 2025, and "
     "the one with the better All-Play was the playoff team %s%% of the time; better record, %s%%; more points, %s%%." % (n("auc.ap", 100 * auc["ap"], "%.0f"), n("auc.h2h", 100 * auc["h2h"], "%.0f"), n("auc.pf", 100 * auc["pf"], "%.0f"))),
    ("Stuart", "Since 2017, teams ranked 10th to 12th in All-Play after Week 5 have made it %s times in %s. One of them was Bear Dunn in 2017, at %s against the field, the exact line Josh Martel has today. "
     "That Bear team won its division, went in as the %s seed and finished %s. It is the best comeback in the sample, and it is one."
     % (n("b3.m", b3[0], "%d"), n("b3.n", b3[1], "%d"), rec("b17", b17["apw"], b17["apl"], "D1"), ordn("b17.seed", b17["seed"], "bracket"), ordn("b17.fin", b17["finish"], "bracket"))),
    ("Rich", "And the hard line: since 2021, teams with three wins or fewer after Week 5 are %s for %s. Gerardi, Cross and Josh Martel are on <b>life support</b>, not finished. Nobody is eliminated until the math says so."
     % (n("le3.m", grp_w[-1][1], "%d"), n("le3.n", grp_w[-1][2], "%d")))) +
    table(["Team", "Category, playoff odds", "Made it from his All-Play rank, 2017&ndash;25", "Made it with his win total, 2021&ndash;25"], surv_rows, right=(2, 3),
          caption="Categories come from this week&rsquo;s playoff odds: <b>Contender</b> 90%% or better, <b>In the field</b> 60&ndash;90, <b>In the race</b> 25&ndash;60, <b>Needs a run</b> 8&ndash;25, "
                  "<b>Life support</b> under 8. History groups: All-Play rank after Week 5 in pairs (1&ndash;2, 3&ndash;4 &hellip;; tied teams share the higher rank), and head-to-head wins after Week 5. "
                  "Samples are small (%s team-seasons and %s); read them as history, not a forecast." % (n("h.nm", hist["n_modern"], "%d"), n("h.n13", hist["n_h13"], "%d"))))
assert b17["apw"] == T[JM]["apw"] and b17["apl"] == T[JM]["apl"]

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

# ================================================================== 9. COFFEE SHOP
q = lambda mid, text, o, when: quote(mid, text, o, when)
bl = T[BLAKE]
coffee = (desk(("Rich", "Before we close, the chat. Owners posted %s times between Thursday night and Tuesday morning. Kenny." % n("posts", 101, "%d", "automated draft post count")),) +
    desk(("Kenny", "Thank you, Rich. I read all %s. Let&rsquo;s start with Shawn Blake, Monday at 8:21 in the morning: %s "
          "He is right. Since Week 1, Bear is %s against the field." % (n("posts2", 101, "%d"), q("1559179324681093275", "First week was a fluke. Bear has been unstoppable since then", "Shawn Blake", "Mon Oct 12, 8:21 AM ET"),
                                                                       rec("k.bear", apw(BEAR, (2, 3, 4, 5)), apl(BEAR, (2, 3, 4, 5))))),
         ("Kenny", "Three minutes later, Josh Martel: %s Josh, you have %s. One, one, one and two. You also have Bear&rsquo;s 2017 line, %s, and that team won its division. I&rsquo;m not saying. I&rsquo;m just reading."
          % (q("1559180011083272243", "Not sure I have an all play win since week 1", "Josh Martel", "Mon Oct 12, 8:24 AM ET"), n("k.jm", apw(JM, (2, 3, 4, 5)), "%d"), rec("k.b17", b17["apw"], b17["apl"], "D1"))),
         ("Kenny", "Sunday, 3:16, on Matt Gerardi&rsquo;s quarterbacks: %s Malik Willis scored %s for Gride, which was fine. Gride scored %s, the lowest of the week, and lost all three."
          % (q("1558921157116305433", "Forced to start this week. Bryce and Mahomes on bye", "Shawn Blake", "Sun Oct 11, 3:16 PM ET"), n("k.willis", U["Malik Willis"]["weeks"]["5"]["ups"]), n("k.ger", TW[(5, GER)]["score"]))),
         ("Kenny", "Monday, 11:31 at night, Eric Martel, needing help: %s The help went the other way. Matthew Stafford scored %s for Chris Klingenberg and HammerTime lost by %s, the closest game of the week."
          % (q("1559408224636117004", "🙏 for a pick or fumble 6", "Eric Martel", "Mon Oct 12, 11:31 PM ET"), n("k.staf", 39.3), n("k.margin", 9.6))),
         ("Kenny", "And Bear, on Josh Martel trading Lamar Jackson: %s The Hawks, for the record, are %s to make the playoffs. Josh is at %s."
          % (q("1559180424889114725", "Everyone has to rebuild sometimes. Rebuild or become Hawks in perpetuity.", "Bear Dunn", "Mon Oct 12, 8:26 AM ET"), pct("k.hawks", O[KLING]["po"]), pct("k.jm", O[JM]["po"])))) +
    post_table)
assert apw(JM, (2, 3, 4, 5)) == 5 and [AP[x][JM][0] for x in (2, 3, 4, 5)] == [1, 1, 1, 2]
assert U["Malik Willis"]["weeks"]["5"]["status"] == "starter" and U["Malik Willis"]["weeks"]["5"]["owner"] == "Matt Gerardi"
assert sorted(TW[(5, f)]["score"] for f in FIDS)[0] == TW[(5, GER)]["score"] and [g["result"] for g in TW[(5, GER)]["games"]] == ["L", "L", "L"]
klg = [g for g in TW[(5, KLING)]["games"] if g["opp"] == EM][0]; assert klg["result"] == "W" and abs(klg["margin"] - 9.6) < 0.05
assert min(abs(g["margin"]) for (wk, f), t in TW.items() if wk == 5 for g in t["games"]) == 9.6
staf = [p for p in TW[(5, KLING)]["players"] if pname(p["pid"]) == "Matthew Stafford"][0]; assert staf["score"] == 39.3 and staf["status"] == "starter"

# ================================================================== assemble
S = [("story", "The Big Story", "a third of the season is gone", story), ("odds", "Playoff Picture", "current odds, run after Week 5", odds),
     ("heat", "Heat Check", "full season and the last three weeks", heat), ("weeks", "Who Is Winning Weeks?", "edges over replacement and matchup swings", weeks),
     ("players", "Player Stories", "what changed and what happens next", players), ("survival", "The Survival Line", "what a Week 5 position has meant", survival),
     ("brief", "Week 5 in Brief", "Boomer, every game, the plays", brief), ("bb", "Above and below expectations", "projection, opportunity and actual points", bb_inner),
     ("coffee", "Coffee Shop Talk", "Kenny Mayne reads the chat", coffee), ("elias", "Elias changes", "", elias_inner)]
body = "\n".join(section(sid, i + 1, t, sub, b) for i, (sid, t, sub, b) in enumerate(S))
head = AUTO[:AUTO.index('<section class="wire-sec"')]
head = head.replace("Automated UPS Center draft (ups_center_auto.py).", "UPS Center Week 5, analytical rebuild of automated draft #1244 (Keith's Week 5 brief, 2026-10-13).")
head = re.sub(r"engine: ups-center-auto[^\n]*", "engine: hand-authored rebuild (scratchpad build_wk05.py) on the automated draft's validated weekly segments; forecast season_sim_2026_live_wk05.json + week_preview_2026_wk06.json", head)
head = head.replace('<div class="wire-eyebrow">Week 5 recap</div>', '<div class="wire-eyebrow">Week 5</div>')
head = re.sub(r'<p class="wire-dek">[\s\S]*?</p>', '<p class="wire-dek">A third of the season is gone and the league is splitting in three: Bear Dunn and three 90% teams at the top, three 3&ndash;10 teams on life support, and a crowded middle. '
              'Current playoff odds, who is hot, the players behind it, and what history says a Week 5 position is worth.</p>', head)
tail = AUTO[AUTO.rindex("</section>") + len("</section>"):]
tail = re.sub(r'<div class="wire-method">[\s\S]*?</details></div>', (
    '<div class="wire-method"><details><summary class="wire-mh">How this was built <span class="wire-method-count">&mdash; 4 notes</span></summary><div class="wire-method-body">'
    '<div><b>Sources.</b> MFL scores, standings, transactions and injury status; the league&rsquo;s D1 history (results through Week 5 of each past season); the league&rsquo;s playoff brackets; '
    'nflverse play-by-play, snap counts, injury reports and weekly stats 1999&ndash;2026; RotoWire projections via Sleeper and MFL projections for the forecast; the archived league Discord.</div>'
    '<div><b>History scoring.</b> Player comparisons across seasons use 2026 UPS rules applied to every season&rsquo;s box scores. That reproduces MFL&rsquo;s actual 2026 scores exactly in 81% of 952 player-games and within a point in 91%; '
    'box scores do not carry the 50-yard touchdown bonus or return yards. Target counts are missing from 2003&ndash;2008, so target comparisons skip those seasons.</div>'
    '<div><b>Routes.</b> Route participation for 2026 is not available in our sources yet, so role changes are measured by snaps, carries and targets.</div>'
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
FIXED = {"37", "13", "90", "60", "25", "8", "28", "33", "5", "1", "2", "3", "4", "6", "10", "12", "20", "24", "1999", "2009", "2002", "2017", "2021", "2025", "18", "11", "81", "952", "91", "50"}
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
