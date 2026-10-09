#!/usr/bin/env python3
"""Render a weekly UPS Center DRAFT in the real show format from a pack + a sources snapshot.

WHY (Keith 2026-10-08): "an alert does not create an issue ... create or update one
reviewable draft PR and rendered preview for that week in the actual UPS Center
format -- opening, rundown, division coverage, player features, above/below
expectations, standings, prior-preview audit, Coffee Shop and corrections where
supported. A generic wire render or an alert alone does not meet this request."

What this produces is the same .uc markup as the hand-built Weeks 1-4 (desk cards,
the division game deck, play cards, bust/bargain lists, tables), written from
facts by plain templates -- no model call, so every sentence is reproducible.

Three rules the output keeps:
  1. Every value printed is registered in a claims LEDGER with its source, and
     ups_center_validate.py re-checks each against the independently fetched
     snapshot (ups_center_sources.py). A number that is not a claim fails validation.
  2. Where the data cannot support a section -- no verified highlight link, no
     pregame projection, no published preview to grade, Coffee Shop jokes, Elias not
     yet posted -- the draft carries a visible EDITOR REVIEW box and a gap record
     instead of a figure. A postgame projection is never used.
  3. It is always status: draft. Nothing here publishes or posts.
"""
import hashlib
import html
import json
import os
import re
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wire  # noqa: E402  (style_sha, runtime, STYLE_BANNER)

ET = ZoneInfo("America/New_York")
GUILD = "1057655884475531324"
e = html.escape
OFF, IDP = {"QB", "RB", "WR", "TE"}, {"DL", "LB", "DB"}
import chat_exclusions  # noqa: E402  (ruled-out ids + the never-material pattern)
SENSITIVE = chat_exclusions.PATTERN


def tidy_box(s):
    """nflverse box lines say '1 carries', '1 catches on 1 targets'."""
    s = re.sub(r"\b1 catches on 1 targets\b", "1 catch on 1 target", s)
    s = re.sub(r"\b1 carries\b", "1 carry", s)
    s = re.sub(r"\b1 catches\b", "1 catch", s)
    return re.sub(r"\b1 targets\b", "1 target", s)


def n1(v):
    return "%.1f" % float(v)


def wl(w, l):
    return "%d&ndash;%d" % (int(w), int(l))


def et_clock(ts, with_day=True):
    d = datetime.fromtimestamp(int(ts), ET)
    t = "%d:%02d %s" % ((d.hour % 12) or 12, d.minute, "AM" if d.hour < 12 else "PM")
    return ("%s %s %d, %s ET" % (d.strftime("%a"), d.strftime("%b"), d.day, t)) if with_day else t


def short_et(ts):
    d = datetime.fromtimestamp(int(ts), ET)
    return "%s %d:%02d %s" % (d.strftime("%a"), (d.hour % 12) or 12, d.minute, "AM" if d.hour < 12 else "PM")


class Ledger:
    """claims: key -> {value, shown, source}. `shown` is the exact text printed."""

    def __init__(self):
        self.claims = {}

    def put(self, key, value, source, shown=None):
        shown = shown if shown is not None else (n1(value) if isinstance(value, float) else str(value))
        prev = self.claims.get(key)
        if prev and prev["value"] != value:
            raise ValueError("claim %s registered twice with different values: %r vs %r" % (key, prev["value"], value))
        self.claims[key] = {"value": value, "shown": shown, "source": source}
        return shown

    def digest(self):
        return hashlib.sha256(json.dumps(self.claims, sort_keys=True).encode()).hexdigest()[:12]


class Issue:
    def __init__(self, pack, ctx, local_candidates=False):
        # local_candidates: list raw chat lines for the editor. ONLY for the local review copy --
        # the committed draft lives on a branch of a public repo, and unchosen chat must not.
        self.pack, self.ctx, self.local = pack, ctx, local_candidates
        self.season, self.week = int(pack["season"]), int(pack["week"])
        self.F = {f["id"]: f["value"] for f in pack["facts"]}
        self.T = {t["id"]: t for t in pack["tables"]}
        self.L = Ledger()
        self.gaps = []
        fr = ctx["d1"]["franchises"]
        self.owner = {fid: r["owner_name"] for fid, r in fr.items()}
        self.fid = {r["owner_name"]: fid for fid, r in fr.items()}
        self.team = {fid: r["team_name"] for fid, r in fr.items()}
        self.logo = {fid: r["logo"] for fid, r in fr.items()}

    # ------------------------------------------------------------ claims
    def score(self, fid):
        return self.L.put("score:" + fid, round(self.ctx["mfl"]["scores"][fid], 1), "MFL weeklyResults W%d" % self.week)

    def margin(self, w, l):
        m = round(self.ctx["mfl"]["scores"][w] - self.ctx["mfl"]["scores"][l], 1)
        return self.L.put("margin:%s:%s" % (w, l), m, "MFL weeklyResults W%d" % self.week)

    def fact(self, fid_key, shown=None):
        v = self.F[fid_key]
        return self.L.put("fact:" + fid_key, v, "pack " + fid_key,
                          shown if shown is not None else (n1(v) if isinstance(v, float) else str(v)))

    def gap(self, gid, section, why):
        self.gaps.append({"id": gid, "section": section, "why": why})
        return ('<div class="editor-gap" data-editor-gap="%s" style="border:2px dashed #b4690e;background:#fff4e0;'
                'color:#5a3500;padding:.7rem .9rem;margin:.6rem 0;border-radius:8px;font:600 .9rem/1.4 system-ui">'
                'EDITOR REVIEW &mdash; %s</div>' % (e(gid), why))

    # ------------------------------------------------------------ markup
    @staticmethod
    def lt(who, text):
        return '<div class="lt %s"><div class="who">%s</div><p>%s</p></div>' % (who.lower(), who, text)

    def desk(self, lines, mb=False):
        lines = [x for x in lines if x and x[1]]
        if not lines:
            return ""
        return '<div class="desk-lines"%s>%s</div>' % (' style="margin-bottom:1rem"' if mb else "",
                                                        "".join(self.lt(w, t) for w, t in lines))

    @staticmethod
    def section(sid, title, seg, label, body):
        return ('<section class="wire-sec" id="%s" data-title="%s"><div class="label"><span class="seg">%d</span> %s</div>%s'
                '</section>' % (sid, e(title), seg, label, body))

    def fr_cell(self, fid):
        return '<td class="fr"><img src="%s" alt="%s">%s</td>' % (self.logo[fid], e(self.team[fid]), e(self.owner[fid]))

    # ------------------------------------------------------------ derived week facts (from MFL games)
    def week_records(self):
        rec = {fid: [0, 0] for fid in self.owner}
        for g in self.ctx["mfl"]["games"]:
            w, l = (g["a"], g["b"]) if g["as"] > g["bs"] else (g["b"], g["a"])
            rec[w][0] += 1
            rec[l][1] += 1
        return rec

    def week_allplay(self):
        s = self.ctx["mfl"]["scores"]
        return {f: (sum(1 for o in s if o != f and s[o] < s[f]), sum(1 for o in s if o != f and s[o] > s[f])) for f in s}

    def games_sorted(self):
        out = []
        for g in self.ctx["mfl"]["games"]:
            w, l = (g["a"], g["b"]) if g["as"] > g["bs"] else (g["b"], g["a"])
            out.append((round(abs(g["as"] - g["bs"]), 1), w, l))
        return sorted(out)

    # ------------------------------------------------------------ 1. opening desk
    def seg_open(self):
        s = self.ctx["mfl"]["scores"]
        top = max(s, key=s.get)
        ap = self.week_allplay()
        games = self.games_sorted()
        close_m, close_w, close_l = games[0]
        big_m, big_w, big_l = games[-1]
        rec = self.week_records()
        sweep = [f for f, (w, l) in rec.items() if l == 0 and w > 0]
        winless = [f for f, (w, l) in rec.items() if w == 0 and l > 0]
        lines = []
        perfect = ", and beat all eleven teams in all-play" if ap[top][1] == 0 else ""
        lines.append(("Stuart", "Week %d at the desk, Rich. %s put up %s, the best score of the week%s. The closest game was "
                      "%s over %s, by %s." % (self.week, self.owner[top], self.score(top), perfect,
                                              self.owner[close_w], self.owner[close_l], self.margin(close_w, close_l))))
        rb = (self.ctx["d1"].get("recordBook") or {}).get("combinedGames") or []
        rich = []
        if rb and rb[0].get("rank") and rb[0]["rank"] <= 3:
            r = rb[0]
            comb = self.L.put("record:combined", round(r["combined"], 1), "D1 src_schedule record book (regular-season "
                                                                               "head-to-head games, 2012 and 2020 on)")
            rank = {1: "highest", 2: "second-highest", 3: "third-highest"}[r["rank"]]
            pair = "%s and %s" % (self.owner[r["franchiseId"]], self.owner[r["opponentId"]])
            rich.append("%s combined for %s, the %s total in any UPS regular-season head-to-head game on record." % (
                pair, comb, rank))
        if sweep:
            names = [self.owner[f] for f in sorted(sweep, key=lambda f: -s[f])]
            rich.append("%s %s every game." % (", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1],
                                               "won" if len(names) > 1 else "won"))
        if winless:
            names = [self.owner[f] for f in sorted(winless, key=lambda f: -s[f])]
            rich.append("%s did not win one." % (", ".join(names[:-1]) + (" and " if len(names) > 1 else "") + names[-1]))
        lines.append(("Rich", " ".join(rich)))
        lines.append(("Stuart", "The biggest margin of the week was %s over %s, by %s. Boomer, take it away." % (
            self.owner[big_w], self.owner[big_l], self.margin(big_w, big_l))))
        return self.section("open", "Opening desk", 1, "Opening desk", self.desk(lines))

    # ------------------------------------------------------------ 2. Boomer
    def seg_boomer(self):
        perf = self.T["t.performers"]["rows"][:5]
        cards = {c["player"]: c for c in self.pack.get("playcards", [])}
        lines = []
        for i, (player, pos, owner, pts) in enumerate(perf):
            fid = self.fid[owner]
            shown = self.L.put("pts:" + player, round(float(pts), 1), "pack t.performers (src_weekly)")
            box = cards.get(player, {}).get("boxLine")
            boxs = (" %s." % e(self.L.put("box:" + player, tidy_box(box), "pack playcard (nflverse box score)"))) if box else ""
            r = self.week_records()[fid]
            lead = "Thanks, Stu! " if i == 0 else ""
            lines.append(("Boomer", "%s%s, %s for %s: %s UPS points.%s %s went %s this week." % (
                lead, e(player), pos, e(owner), shown, boxs, e(owner), wl(r[0], r[1]))))
        lines.append(("Boomer", "Stu, Rich, that is your division desk. I am out."))
        return self.section("boomer", "Boomer’s Three-Minute Rundown", 2, "Boomer’s Three-Minute Rundown", self.desk(lines))

    # ------------------------------------------------------------ 3. division desk
    def seg_desk(self):
        pages = []
        s = self.ctx["mfl"]["scores"]
        for pot in self.pack["pots"]:
            gs = [(self.fid[g["winner"]], self.fid[g["loser"]]) for g in pot["games"]]
            feat = min(gs, key=lambda wl_: s[wl_[0]] - s[wl_[1]])
            teams = sorted({f for g in gs for f in g}, key=lambda f: -s[f])
            lines = []
            for i, f in enumerate(teams):
                wins = [l for (w, l) in gs if w == f]
                losses = [w for (w, l) in gs if l == f]
                parts = []
                if wins:
                    parts.append("beat " + ", ".join("%s by %s" % (self.owner[l], self.margin(f, l)) for l in wins))
                if losses:
                    parts.append("lost to " + ", ".join("%s by %s" % (self.owner[w], self.margin(w, f)) for w in losses))
                txt = "%s scored %s and went %s: %s." % (self.owner[f], self.score(f), wl(len(wins), len(losses)),
                                                         "; ".join(parts))
                ba = self.F.get("f.team.%s.best_available" % f)
                if losses and ba is not None and self.F.get("f.team.%s.could_have_won" % f) == "yes":
                    txt += " His best available lineup, %s, would have won a game he lost." % self.fact(
                        "f.team.%s.best_available" % f)
                lines.append(("Stuart" if i % 2 == 0 else "Rich", txt))
            sweeper = [f for f in teams if all(w == f for (w, l) in gs if f in (w, l))]
            if sweeper and sweeper[0] == feat[0]:
                head = "%s swept, and the closest of it was %s by %s." % (
                    self.owner[feat[0]], self.owner[feat[1]], self.margin(*feat))
            else:
                head = ("%s swept; " % self.owner[sweeper[0]] if sweeper else "") + "%s over %s by %s." % (
                    self.owner[feat[0]], self.owner[feat[1]], self.margin(*feat))
            pages.append('<section class="division wire-gamepage" data-title="%s">%s<h2 class="headline">%s</h2>%s</section>' % (
                e(pot["tag"]), self.face(*feat), e(head), self.desk(lines)))
        body = ('<div class="wire-gamedeck" data-wire-gamedeck><nav class="wire-gamedeck-rail" data-wire-gamerail '
                'aria-label="Divisions"></nav>%s</div>' % "".join(pages))
        return self.section("desk", "Division desk", 3, "Division desk", body)

    def face(self, w, l):
        def side(fid):
            return ('<div class="side"><div class="plate"><img src="%s" alt="%s"></div><div><div class="nm">%s</div>'
                    '<div class="rec">%s</div></div></div>') % (self.logo[fid], e(self.team[fid]), e(self.owner[fid]),
                                                               e(self.team[fid]))
        return ('<div class="face">%s<div class="final"><div class="k">Final</div><div class="n">%s <span class="l">: %s</span>'
                '</div><div class="m">margin %s</div></div>%s</div>') % (side(w), self.score(w), self.score(l),
                                                                         self.margin(w, l), side(l))

    # ------------------------------------------------------------ 4. plays
    def seg_plays(self):
        cards, out = self.pack.get("playcards", []), []
        for c in cards:
            fid = self.fid[c["owner"]]
            link = self.ctx.get("links", {}).get(c["player"]) or {"verified": False}
            watch = ('<a class="wire-play-watch" href="%s" target="_blank" rel="noopener">Watch verified NFL highlights '
                     '&#8599;</a>' % e(link["url"])) if link.get("verified") else self.gap(
                "plays:" + c["player"], "plays", "No verified highlight link for %s (%s); add one or leave it out."
                % (e(c["player"]), e(link.get("why", "not checked"))))
            shown = self.L.put("pts:" + c["player"], round(float(c["score"]), 1), "pack playcard (src_weekly)")
            out.append('<article class="play"><div class="div">Week %d play of the week</div><div class="top"><img class="head" '
                       'src="%s" alt="%s"><div class="crest"><div class="plate"><img src="%s" alt="%s"></div><div class="pts">'
                       '%s<small>UPS points &middot; %s</small></div></div></div><div class="body"><div class="pname">%s</div>'
                       '<div class="pmeta">%s &middot; %s</div><p class="box">%s</p>%s</div></article>' % (
                           self.week, e(c["playerPhotoUrl"]), e(c["player"]), self.logo[fid], e(self.team[fid]), shown,
                           e(c["owner"]), e(c["player"]), e(c["position"]), e(c["nflMatchup"]), e(self.L.put("box:" + c["player"], tidy_box(c["boxLine"]),
                                                                   "pack playcard (nflverse box score)")), watch))
        if not out:
            out.append(self.gap("plays:none", "plays", "The pack has no play cards this week."))
        return self.section("plays", "Plays of the Week", 4, "Plays of the Week <small>&mdash; with player headshots</small>",
                            '<div class="reel">%s</div>' % "".join(out))

    # ------------------------------------------------------------ 5. above / below
    def seg_bb(self):
        ev = self.ctx["evidence"]
        prov = {(r["player"], r["fid"]): r for r in ev["ranked"]}
        lists, missing, proven = [], [], {}
        for tid, title in (("t.bb.off.bust", 'Offense <span class="down">busts</span>'),
                           ("t.bb.off.bargain", 'Offense <span class="up">bargains</span>'),
                           ("t.bb.idp.bust", 'Defense <span class="down">busts</span>'),
                           ("t.bb.idp.bargain", 'Defense <span class="up">bargains</span>')):
            rows = self.T.get(tid, {}).get("rows") or []
            lis, proven[tid] = [], []
            for r in rows:
                bare = re.sub(r"\s*\([^)]*\)$", "", r[0])
                owner, proj, pts, diff = r[1], float(r[2]), float(r[3]), r[4]
                p = prov.get((bare, self.fid[owner]))
                if not p or abs(float(p["proj"]) - proj) > 0.05 or not (int(p["captured"]) < int(p["kickoff"])):
                    missing.append(bare)                                   # never print an unproven projection
                    continue
                self.L.put("proj:%s" % p["player_id"], {"value": round(proj, 1), "captured": int(p["captured"]),
                                                        "kickoff": int(p["kickoff"])},
                           "D1 ups_player_projections (%s)" % ev["basis"], n1(proj))
                self.L.put("pts:" + bare, round(pts, 1), "pack %s (src_weekly)" % tid)
                self.L.put("diff:%s" % p["player_id"], diff, "pack %s" % tid, diff)
                proven[tid].append(r)
                usage = re.sub(r"\s*\([\d.]+\)$", "", r[5]) if len(r) > 5 else ""
                if usage:
                    self.L.put("usage:" + bare, usage, "pack %s (nflverse ffopportunity usage)" % tid)
                stamp = "MFL proj. %s ET &middot; kickoff %s ET" % (short_et(p["captured"]), short_et(p["kickoff"]))
                small = (e(usage) + " &middot; " if usage else "") + stamp
                lis.append('<li><img src="%s" alt="%s"><span class="bn"><b>%s</b><small class="xu">%s</small></span>'
                           '<span class="bp">%s <i>&rarr;</i> %s</span><span class="bg %s">%s</span></li>' % (
                               self.logo[self.fid[owner]], e(owner), e(re.sub(r"\(([^,]+), [A-Z]{2,3}\)$",
                                                                               r"(\1, %s)" % owner, r[0])), small,
                               n1(proj), n1(pts), "down" if diff.startswith("-") else "", e(diff)))
            lists.append('<article class="bbl" style="min-width:0"><h3>%s <small class="hx">Projected &rarr; scored</small></h3>'
                         '<ol>%s</ol></article>' % (title, "".join(lis)))
        body = ""
        if not ev["ranked"]:
            body += self.gap("bb:no-evidence", "bb", "No starter has a projection captured before his own kickoff this week, "
                             "so busts and bargains are not graded. Do not substitute a postgame projection.")
        if missing:
            body += self.gap("bb:unproven", "bb", "Left off the lists because their listed projection could not be matched "
                             "to a pregame capture: %s." % e(", ".join(missing)))
        caps = sorted({int(r["captured"]) for r in ev["ranked"]})
        basis = ("each player&rsquo;s FIRST saved MFL projection (later saves were overwritten after the games and are "
                 "not used)" if ev["basis"] == "first_pregame_fallback" else "each player&rsquo;s last MFL projection "
                 "saved before his own kickoff")
        offidp = [r for r in ev["ranked"] if r.get("pos_group") in OFF | IDP]
        n_grad = self.L.put("count:graded", len(offidp), "D1 evidence (starters graded)")
        n_un = self.L.put("count:ungraded", len([r for r in ev["unranked"] if r.get("pos_group") in OFF | IDP]),
                          "D1 evidence (starters not graded)")
        cap_txt = ", ".join(et_clock(c) for c in caps[:3]) + (" and later" if len(caps) > 3 else "")
        caption = ('<p class="caption">Started players only. Projection source: %s, captured %s; every row shows its '
                   'capture time and the player&rsquo;s own kickoff, and every capture came first. %s offensive and '
                   'defensive starters graded; %s not graded for want of a pregame capture. Largest gaps among graded '
                   'starters, not every starter.</p>' % (basis, cap_txt, n_grad, n_un))
        lead = []
        ob, og = proven.get("t.bb.off.bust"), proven.get("t.bb.off.bargain")      # only rows with pregame proof
        if og:
            lead.append(("Stuart", "The biggest bargain: %s for %s, projected %s, scored %s." % (
                e(re.sub(r"\s*\(.*$", "", og[0][0])), e(og[0][1]), n1(og[0][2]), n1(og[0][3]))))
        if ob:
            lead.append(("Rich", "The biggest bust: %s for %s, projected %s, scored %s." % (
                e(re.sub(r"\s*\(.*$", "", ob[0][0])), e(ob[0][1]), n1(ob[0][2]), n1(ob[0][3]))))
        return self.section("bb", "Above and below expectations", 5,
                            "Above and below expectations <small>&mdash; projection, opportunity and actual points</small>",
                            self.desk(lead, mb=True) + body + '<div class="bb">%s</div>' % "".join(lists) + caption)

    # ------------------------------------------------------------ 6. landscape
    def canon_order(self):
        """§F.1: division leaders take places 1-2, the rest of the field interleaves, then everyone else --
        all on All-Play %, Overall, season PF (worker/src/seeding.js). H2H only if needed (gap if so)."""
        st = self.ctx["mfl"]["standings"]

        def pct(w, l):
            return round(w / (w + l), 6) if (w + l) else 0.0

        def key(f):
            aw, al = (int(x) for x in st[f]["allplay"].split("-")[:2])
            return (-pct(aw, al), -pct(st[f]["h2hw"], st[f]["h2hl"]), -round(st[f]["pf"], 1), self.owner[f])
        leaders = [r["franchise_id"] for r in self.ctx["site"]["standings"] if r["is_division_leader"]]
        tie = {}
        for f in st:
            tie.setdefault(key(f)[:3], []).append(f)
        h2h_needed = [v for v in tie.values() if len(v) > 1]
        L = sorted(leaders, key=key)
        pool = sorted([f for f in st if f not in leaders], key=key)
        return L[:2] + sorted(L[2:] + pool[:2], key=key) + pool[2:], set(leaders), h2h_needed

    def seg_landscape(self):
        st = self.ctx["mfl"]["standings"]
        order, leaders, h2h_needed = self.canon_order()
        site = [r["franchise_id"] for r in self.ctx["site"]["standings"]]
        body = ""
        if h2h_needed:
            body += self.gap("landscape:h2h", "landscape", "Teams tied on all-play, overall and points for need the "
                             "head-to-head step; check the order by hand.")
        if site != order:
            body += self.gap("landscape:site-order", "landscape", "The league standings page currently shows a different "
                             "order (%s) from the league&rsquo;s seeding rule used here (%s). Do not publish until they match."
                             % (e(", ".join(self.owner[f] for f in site)), e(", ".join(self.owner[f] for f in order))))
        rows = []
        for f in order:
            aw, al = st[f]["allplay"].split("-")[:2]
            self.L.put("rec:" + f, "%d-%d" % (st[f]["h2hw"], st[f]["h2hl"]), "MFL leagueStandings", wl(st[f]["h2hw"], st[f]["h2hl"]))
            self.L.put("ap:" + f, "%s-%s" % (aw, al), "MFL leagueStandings", wl(aw, al))
            self.L.put("pf:" + f, round(st[f]["pf"], 1), "MFL leagueStandings", "{:,.1f}".format(st[f]["pf"]))
            wk = self.week_allplay()[f]
            self.L.put("wkap:" + f, "%d-%d" % wk, "MFL weeklyResults W%d (all-play)" % self.week, wl(*wk))
            rows.append('<tr>%s<td class="sub">%s</td><td class="num">%s</td><td class="num">%s</td><td class="num">%s</td>'
                        '<td class="num">%s</td></tr>' % (self.fr_cell(f), "leader" if f in leaders else "",
                                                          wl(st[f]["h2hw"], st[f]["h2hl"]), wl(*wk), wl(aw, al),
                                                          "{:,.1f}".format(st[f]["pf"])))
        top = order[0]
        lead = [("Stuart", "%s leads the field at %s against everyone, %s overall." % (
            self.owner[top], wl(*st[top]["allplay"].split("-")[:2]), wl(st[top]["h2hw"], st[top]["h2hl"])))]
        table = ('<div class="tablebox"><table><thead><tr><th>Franchise</th><th>Division</th><th>Record</th>'
                 '<th>Week %d all-play</th><th>All-play</th><th>Points for</th></tr></thead><tbody>%s</tbody></table></div>'
                 '<p class="caption">In the same order as the league standings page: the current playoff field first '
                 '(division leaders take the top two places), then everyone else; every place goes by all-play percentage, '
                 'then overall record, then points for, then head-to-head.</p>' % (self.week, "".join(rows)))
        audit = self.prior_preview_audit()
        return self.section("landscape", "League landscape", 6, "League landscape <small>&mdash; standings after week %d"
                            "</small>" % self.week, self.desk(lead, mb=True) + body + table + audit)

    def prior_preview_audit(self):
        g = self.T.get("t.grade.games")
        if not g:
            return self.gap("landscape:preview-audit", "landscape", "No preview was published for Week %d, so there is "
                            "nothing to grade." % self.week)
        rows = ""
        for i, r in enumerate(g["rows"]):
            self.L.put("grade:%d" % i, {"game": r[0], "fav": r[1], "final": r[2], "called": r[3]},
                       "pack t.grade.games (preview_grade.py)", "%s %s %s" % (r[1], r[2], r[3]))
            rows += '<tr><td>%s</td><td>%s</td><td class="num">%s</td><td class="%s">%s</td></tr>' % (
                e(r[0]), e(r[1]), e(r[2]).replace("-", "&ndash;"), "up" if r[3] == "yes" else "down", r[3])
        fav = self.fact("f.grade.favorites")
        return ('<div class="tablebox"><table><thead><tr><th>Week %d matchup</th><th>Our favorite</th><th>Final</th>'
                '<th>Called it?</th></tr></thead><tbody>%s</tbody></table></div><p class="caption">Last week&rsquo;s '
                'published preview, graded against the final scores: favorites won %s of %d.</p>' % (
                    self.week, rows, fav, len(g["rows"])))

    # ------------------------------------------------------------ 7. Coffee Shop
    def seg_coffee(self):
        chat = self.ctx["d1"]["chat"]
        posts = {o: 0 for o in self.fid}
        for m in chat:
            posts[m["owner_name"]] = posts.get(m["owner_name"], 0) + 1
        total = self.L.put("posts:total", sum(posts.values()), "D1 ups_discord_messages window")
        box = "".join('<tr>%s<td class="num">%s</td></tr>' % (
            self.fr_cell(self.fid[o]), self.L.put("posts:" + o, posts[o], "D1 ups_discord_messages window"))
            for o in sorted(posts, key=lambda o: (-posts[o], o)))
        cands, flagged = [], 0
        excluded = chat_exclusions.excluded_ids()
        for m in chat:
            txt = " ".join((m["content"] or "").split())
            if m.get("withheld") or chat_exclusions.reason(m["message_id"], txt, excluded):
                flagged += 1                                     # never shown; counted so the editor knows
                continue
            if not txt or re.match(r"^https?://\S+$", txt) or "<@" in txt or len(txt) < 12:
                continue
            url = "https://discord.com/channels/%s/%s/%s" % (GUILD, m["channel_id"], m["message_id"])
            self.L.put("quote:" + m["message_id"], txt, "D1 ups_discord_messages", txt)
            cands.append('<li><b>%s</b>, %s: <a class="rcpt" href="%s" target="_blank" rel="noopener">&ldquo;%s&rdquo;</a></li>'
                         % (e(m["owner_name"]), et_clock(m["posted_at_unix"]), url, e(txt)))
        if self.local:
            listing = ("<ol style=\"font-weight:400;margin:.5rem 0 0 1rem\">%s</ol>" % "".join(cands[:40])) if cands \
                else " No usable owner messages in the window."
        else:
            listing = (" %s candidate line(s) are listed, verbatim and linked, in the local review copy only (raw chat "
                       "stays off the public repo)." % self.L.put("count:candidates", len(cands),
                                                                  "D1 ups_discord_messages window (usable lines)"))
            for k in [k for k in self.L.claims if k.startswith("quote:")]:
                del self.L.claims[k]
        gap = self.gap("coffee:kenny", "coffee", "Kenny Mayne&rsquo;s lines are an editor&rsquo;s job: choose from the "
                       "verbatim candidates and follow the owner dossier. %d message(s) ruled out by an editor or touching "
                       "family, health or similar were withheld and must not be used.%s" % (flagged, listing))
        intro = self.desk([("Rich", "Before we close, the chat. Owners posted %s times between %s and %s. Kenny." % (
            total, et_clock(self.ctx["chatWindow"]["since"]), et_clock(self.ctx["chatWindow"]["until"])))], mb=True)
        table = ('<div class="tablebox"><table><thead><tr><th>Owner</th><th>Posts</th></tr></thead><tbody>%s</tbody></table>'
                 '</div><p class="caption">Owner posts in the archived league Discord channels in that window; bot posts '
                 'excluded.</p>' % box)
        return self.section("coffee", "Coffee Shop Talk", 7, "Coffee Shop Talk <small>&mdash; Kenny Mayne reads the chat</small>",
                            intro + gap + table)

    # ------------------------------------------------------------ 8. corrections
    def seg_elias(self):
        posts = self.ctx["mfl"].get("elias") or []
        rep = self.ctx.get("eliasReport")
        if not posts:
            return self.section("elias", "Elias changes", 8, "Elias changes", self.gap(
                "elias:not-posted", "elias", "Elias has not posted official Week %d changes yet. The Thursday and Friday "
                "runs re-check and will update this draft." % self.week))
        moved = (rep or {}).get("teams") or []
        if not moved:
            note = ("Elias posted %s official stat change(s) for Week %d; none moved a UPS team score from the numbers "
                    "in this draft." % (self.L.put("elias:count", len(posts), "MFL site news"), self.week))
            return self.section("elias", "Elias changes", 8, "Elias changes", self.desk([("Rich", note)]))
        rows = "".join('<tr>%s<td class="num">%s</td><td class="num">%s</td></tr>' % (
            self.fr_cell(t["fid"]), self.L.put("elias:before:" + t["fid"], round(t["before"], 1), "scores_published"),
            self.score(t["fid"])) for t in moved)
        return self.section("elias", "Elias changes", 8, "Elias changes <small>&mdash; official corrections</small>",
                            self.desk([("Rich", "Elias moved %d team score(s) after the first scores; every number in this "
                                                "draft uses the corrected ones." % len(moved))], mb=True)
                            + '<div class="tablebox"><table><thead><tr><th>Owner</th><th>First</th><th>Corrected</th></tr>'
                              '</thead><tbody>%s</tbody></table></div>' % rows)

    # ------------------------------------------------------------ assembly
    def render(self, generated_at):
        segs = [self.seg_open(), self.seg_boomer(), self.seg_desk(), self.seg_plays(), self.seg_bb(), self.seg_landscape(),
                self.seg_coffee(), self.seg_elias()]
        sha, combined = wire.style_sha()
        runtime = wire.read(wire.RUNTIME_JS)
        aid = "%d-wk%02d-ups-center" % (self.season, self.week)
        s = self.ctx["mfl"]["scores"]
        top = max(s, key=s.get)
        dek = ("%s led Week %d with %s. Automated draft from the league&rsquo;s own data, awaiting the editor." % (
            e(self.owner[top]), self.week, self.score(top)))
        gaps_note = ('<div><b>Editor review.</b> %d item(s) are marked EDITOR REVIEW in this draft and must be resolved '
                     'before publication.</div>' % len(self.gaps)) if self.gaps else ""
        method = ('<div class="wire-method"><details><summary class="wire-mh">How this was built <span class="wire-method-count">'
                  '&mdash; 3 notes</span></summary><div class="wire-method-body"><div><b>Sources.</b> MFL scores, standings, '
                  'schedules, transactions and Elias posts; the league&rsquo;s D1 copies, checked against MFL; MFL projections '
                  'as saved before each kickoff; nflverse expected points; the archived league Discord.</div><div><b>Status.'
                  '</b> Automated draft (ups_center_auto.py), generated %s. Not published.</div>%s</div></details></div>' % (
                      et_clock(generated_at), gaps_note))
        meta = ("<!--wire-meta\n  Automated UPS Center draft (ups_center_auto.py). Rebuild the index with: python "
                "pipelines/etl/wire/wire.py index\n  familyId: weekly\n  season: %d\n  week: %d\n  status: draft\n  "
                "publishedAt:\n  tags: ups-center\n  heroValue:\n  heroLabel:\n  order:\n  featured: no\n  leadTable:\n-->\n"
                "<!--wire-provenance\n  pack: %d-wk%02d-recap\n  packGeneratedAtUtc: %s\n  engine: ups-center-auto "
                "(ups_center_issue.py); claims %s; gaps %d\n-->\n" % (self.season, self.week, self.season, self.week,
                                                                      self.pack["generatedAtUtc"], self.L.digest(),
                                                                      len(self.gaps)))
        doc = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-'
               'width, initial-scale=1">\n<title>UPS Center: Week %d</title>\n%s<style data-wire-style="tokens+article" '
               'data-wire-style-sha="sha256-%s">\n%s%s</style>\n</head>\n<body>\n\n<div class="wire-page">\n<div class="wire-'
               'wrap uc">\n<div class="wire-topbar">\n    <nav class="wire-topnav" aria-label="Wire sections">\n      <button '
               'class="wire-navlink" data-wire-goto="/" type="button">Front Page</button>\n      <button class="wire-navlink" '
               'data-wire-goto="/f/weekly" type="button">The Week</button>\n    </nav>\n    <span class="wire-topbar-title">UPS '
               'Center</span>\n  </div>\n\n  <header class="wire-hero mast">\n    <div class="wire-eyebrow">Week %d recap</div>\n'
               '    <h1 class="brand">UPS <span>CENTER</span></h1>\n    <p class="show">At the desk: Stuart, Rich &amp; Boomer '
               '&middot; Kenny Mayne in the Coffee Shop</p>\n    <p class="wire-dek">%s</p>\n  </header>\n<nav class="wire-rail" '
               'data-wire-rail data-wire-rail-named aria-label="Segments"></nav>\n\n%s\n\n%s\n</div>\n</div>\n<script '
               'data-wire-runtime>\n%s</script>\n</body>\n</html>\n' % (
                   self.week, meta, sha, wire.STYLE_BANNER, combined, self.week, dek, "\n".join(segs), method, runtime))
        return {"id": aid, "html": doc, "claims": self.L.claims, "claimsDigest": self.L.digest(), "gaps": self.gaps}


def render(pack, ctx, generated_at=None, local_candidates=False):
    return Issue(pack, ctx, local_candidates).render(int(generated_at or datetime.now(timezone.utc).timestamp()))
