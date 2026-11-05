#!/usr/bin/env python3
"""The story-format UPS Center draft (Keith 2026-11-05: Week 8's hand-built story edition "needs to be my
new template"). Six segments, each a story first and its tables second:

  1 The Big Story            the week's strongest data-backed story (ups_center_story_data.big_story);
                             with none, the old opening desk
  2 Division Week            one chapter per division (or crossover) plus a swept / split / shut-out table
  3 Elias                    news-style, only when Elias moved a score or an All-Play game (or a gap while
                             the league office has not posted)
  4 Playoff Picture          a story over the odds table
  5 The Plays That Made the Week   plays + above/below bargains and busts; the full ledger is collapsed
  6 The Season So Far        Heat Check + Survival Line + landscape as one story; tables collapsed

Same rules as the legacy format (ups_center_issue.py): every printed number is a registered claim with a
source, the validator recomputes each by separate code, a postgame projection is never used, the output is
always status: draft. Prose is plain templates (no model call), so every sentence is reproducible.

Editor review. The story text is written from the data and needs no box. The one thing the job will not
write is Kenny's Coffee Shop jokes (owner dossier): ONE box, `coffee:kenny`, lists the verbatim, linked
candidate lines by division (local review copy only; raw chat stays off the public repo). The editor weaves
chosen lines into the chapters as `lt kenny` blocks and removes the box. The box keeps check item 7's
publication gate, so nothing can publish without a human pass. The old `stories:leads` box is gone: the
stories are written, not pointed at.
"""
import html
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_issue as I  # noqa: E402
import ups_center_story_data as SD  # noqa: E402
import ups_center_stories as STORIES  # noqa: E402
import chat_exclusions  # noqa: E402

e = html.escape
WORDS = {0: "none", 1: "one", 2: "two", 3: "three", 4: "four"}
SEGMENTS = ["bigstory", "divweek", "elias", "odds", "plays", "season"]


def join(names):
    names = list(names)
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + (", and " if len(names) > 2 else " and ") + names[-1]


def finish_label(n):
    return {1: "Champion", 2: "Lost the final", 3: "Third"}.get(n) or "Finished " + I.Issue._ord(n)


class StoryIssue(I.Issue):
    format_name = "story"

    # ------------------------------------------------------------ claim helpers (same keys and values as the tables use)
    def rec_c(self, f):
        st = self.ctx["mfl"]["standings"][f]
        return self.L.put("rec:" + f, "%d-%d" % (st["h2hw"], st["h2hl"]), "MFL leagueStandings", I.wl(st["h2hw"], st["h2hl"]))

    def ap_c(self, f):
        aw, al = self.ctx["mfl"]["standings"][f]["allplay"].split("-")[:2]
        return self.L.put("ap:" + f, "%s-%s" % (aw, al), "MFL leagueStandings", I.wl(aw, al))

    def wkap_c(self, f):
        wk = self.week_allplay()[f]
        return self.L.put("wkap:" + f, "%d-%d" % wk, "MFL weeklyResults W%d (all-play)" % self.week, I.wl(*wk))

    def wkrec_c(self, f):
        r = self.week_records()[f]
        return self.L.put("wkrec:" + f, "%d-%d" % (r[0], r[1]), "MFL weeklyResults W%d (head-to-head games)" % self.week, I.wl(*r))

    def odds_fresh(self):
        return bool((self.ctx.get("forecast") or {}).get("sim")) and not any(
            g in ("odds:missing", "odds:stale", "odds:inconsistent") for g, _ in self.forecast_problems())

    def odds_text(self):
        """(sim, source, {fid: shown}) once for the whole issue."""
        if not hasattr(self, "_odds"):
            sim = self.ctx["forecast"]["sim"]
            teams = sim["teams"]
            src = "season_sim live wk%02d (%s runs, %s)" % (self.week, sim["runs"], sim["generatedAtUtc"])
            div = {}
            for d in sorted({t["division"] for t in teams.values()}):
                div.update(self.display({f: t["div"] for f, t in teams.items() if t["division"] == d}))
            self._odds = (sim, src, div, self.display({f: t["title"] for f, t in teams.items()}))
        return self._odds

    @staticmethod
    def display(vals):
        import season_sim
        return season_sim.display_percentages(vals)

    def po(self, f):
        sim, src, _, _ = self.odds_text()
        return self.L.put("odds:po:" + f, round(100 * sim["teams"][f]["po"], 1), src, "%.1f%%" % (100 * sim["teams"][f]["po"]))

    def bye(self, f):
        sim, src, _, _ = self.odds_text()
        return self.L.put("odds:bye:" + f, round(100 * sim["teams"][f]["bye"], 1), src, "%.1f%%" % (100 * sim["teams"][f]["bye"]))

    def dv(self, f):
        sim, src, div, _ = self.odds_text()
        return self.L.put("odds:div:" + f, float(div[f]), src + ", largest-remainder by division", div[f] + "%")

    def ti(self, f):
        sim, src, _, title = self.odds_text()
        return self.L.put("odds:title:" + f, float(title[f]), src + ", largest-remainder", title[f] + "%")

    def div_names(self):
        """{division id: name}: the name the week's games use for an all-division game; else 'Division <id>'."""
        if not hasattr(self, "_divn"):
            names = {}
            for pot in self.pack.get("pots", []):
                if len(pot.get("divisions") or []) == 1:
                    ids = {self.ctx["d1"]["franchises"][self.fid[g[k]]]["division"] for g in pot["games"] for k in ("winner", "loser")}
                    if len(ids) == 1:
                        names[ids.pop()] = self.pretty(pot["divisions"][0])
            self._divn = names
        return self._divn

    @staticmethod
    def pretty(tag):
        t = tag.title() if tag.isupper() else tag
        return re.sub(r"\b(Of|The|For)\b", lambda m: m.group(1).lower(), t)

    def div_of(self, f):
        d = self.ctx["d1"]["franchises"][f]["division"]
        return self.div_names().get(d) or "Division " + str(d)

    @staticmethod
    def table(head, rows, cls=""):
        return '<div class="tablebox"><table><thead><tr>%s</tr></thead><tbody>%s</tbody></table></div>' % (
            "".join("<th>%s</th>" % h for h in head), "".join(rows))

    @staticmethod
    def row(cells, bold=False):
        return "<tr>" + "".join("<td%s>%s</td>" % (' class="num"' if i else "", ("<b>%s</b>" % c) if bold else c)
                                for i, c in enumerate(cells)) + "</tr>"

    # ------------------------------------------------------------ 1. the Big Story
    def seg_big(self):
        story = SD.big_story(self.ctx)
        if not story:
            s = self.ctx["mfl"]["scores"]
            top = max(s, key=s.get)
            return self.section("bigstory", "The Big Story", 1, "The Big Story <small>&mdash; %s led the week</small>" % e(self.owner[top]),
                                self.desk(self.open_lines()))
        f, best = story["fid"], story["direction"] == "best"
        me, n, ahead = self.owner[f], story["pool"], story["ahead"]
        src = self.ctx["archive"]["source"]
        s = self.ctx["mfl"]["scores"]
        first, last = story["seasons"][0], story["seasons"][-1]
        better, worse = ("better", "best") if best else ("worse", "worst")
        n_c = self.L.put("arch:n", n, src)
        ahead_c = self.L.put("arch:ahead:" + f, ahead, src)
        pct_c = self.L.put("arch:pct:cur:" + f, round(int(self.ctx["mfl"]["standings"][f]["allplay"].split("-")[0]) / float(
            sum(int(x) for x in self.ctx["mfl"]["standings"][f]["allplay"].split("-")[:2])), 3), src,
            ("%.3f" % (int(self.ctx["mfl"]["standings"][f]["allplay"].split("-")[0]) / float(
                sum(int(x) for x in self.ctx["mfl"]["standings"][f]["allplay"].split("-")[:2])))).lstrip("0"))

        def ref(x):                                           # an archived team-season: name, record, pct, finish
            k = "%d:%s" % (x["season"], x["fid"])
            ap = self.L.put("arch:ap:" + k, "%d-%d" % (x["w"], x["l"]), src, I.wl(x["w"], x["l"]))
            pc = self.L.put("arch:pct:" + k, round(x["pct"], 3), src, ("%.3f" % x["pct"]).lstrip("0"))
            return "%s&rsquo;s %d team" % (e(x["owner"] or "an unnamed owner"), x["season"]), ap, pc

        top = s[f] == max(s.values())
        note = (", the best score of the week" if top else "") + (", and beat all eleven teams in All-Play"
                                                                 if top and self.week_allplay()[f][1] == 0 else "")
        lines = [("Stuart", "%s scored %s in Week %d%s. %s is %s overall and %s in All-Play through Week %d, a %s start than all but %s earlier team%s in the league archive." % (
            e(me), self.score(f), self.week, note, e(me), self.rec_c(f), self.ap_c(f), self.week, better, ahead_c, "" if ahead == 1 else "s"))]
        P = SD.pool(self.ctx["archive"], self.week)
        mypct = int(self.ctx["mfl"]["standings"][f]["allplay"].split("-")[0]) / float(
            sum(int(x) for x in self.ctx["mfl"]["standings"][f]["allplay"].split("-")[:2]))
        ahead_rows = sorted([x for x in P if (x["pct"] > mypct + 1e-12 if best else x["pct"] < mypct - 1e-12)],
                            key=lambda x: (-x["pct"] if best else x["pct"], x["season"]))
        if ahead == 0:
            lead = "No earlier team had a %s All-Play record at this point." % better
        else:
            parts = []
            for x in ahead_rows[:4]:
                nm, ap, _ = ref(x)
                parts.append("%s, which was %s" % (nm, ap))
            lead = "%s had a %s All-Play record at this point: %s." % (WORDS.get(ahead, str(ahead)).capitalize() if ahead < 5 else ahead,
                                                                        better, join(parts))
        lines.append(("Rich", "Here is what %s means. Since %d, %s teams have reached Week %d with a full record in the league archive. %s" % (
            self.ap_c(f), first, n_c, self.week, lead)))
        behind = [x for x in story["table"] if not x.get("current")]
        nxt = [ref(x) for x in behind[ahead:ahead + 3]] if ahead < len(behind) else []
        txt = "That is %s for %s." % (pct_c, e(me))
        if ahead_rows:
            nm, ap, pc = ref(ahead_rows[0])
            txt += " The %s start in the archive, %s, was %s." % (worse, nm, pc)
        if nxt:
            txt += " After %s, the next %s starts are %s." % (e(me), "best" if best else "worst",
                                                              join("%s at %s" % (nm, ap) for nm, ap, _ in nxt))
        lines.append(("Stuart", txt))
        champs = sum(1 for x in behind if x["final"] == 1)
        ru = sum(1 for x in behind if x["final"] == 2)
        kk = self.L.put("arch:tablek", len(behind), src)
        if behind and best:
            c1 = "%s won the title" % (self.L.put("arch:champs", champs, src) if champs else "none")
            c2 = "%s lost the final" % (self.L.put("arch:runnerup", ru, src) if ru else "none")
            lines.append(("Rich", "A great start is not a title. Of the %s earlier teams in the table, %s and %s." % (kk, c1, c2)))
        own = SD.own_history(self.ctx, me, self.week)
        tail = []
        if own:
            hb, hw = own
            b = self.L.put("arch:ownbest:" + f, "%d:%d-%d" % (hb["season"], hb["w"], hb["l"]), src, I.wl(hb["w"], hb["l"]))
            w_ = self.L.put("arch:ownworst:" + f, "%d:%d-%d" % (hw["season"], hw["w"], hw["l"]), src, I.wl(hw["w"], hw["l"]))
            tail.append("In the archive, %s&rsquo;s best start was %s in %d and the worst was %s in %d." % (e(me), b, hb["season"], w_, hw["season"]))
        if self.odds_fresh() and best:
            sim = self.odds_text()[0]
            others = sorted((g for g in sim["teams"] if g != f), key=lambda g: (-sim["teams"][g]["title"], g))
            tail.append("The forecast gives %s a %s chance at the first-round bye and a %s chance at the title; the next best title odds belong to %s at %s." % (
                e(me), self.bye(f), self.ti(f), e(self.owner[others[0]]), self.ti(others[0])))
        if tail:
            lines.append(("Stuart", " ".join(tail)))
        rows = []
        for x in story["table"]:
            if x.get("current"):
                rows.append(self.row(["2026 &middot; %s" % e(me), self.ap_c(f), pct_c, "In progress"], bold=True))
            else:
                nm, ap, pc = ref(x)
                k = "%d:%s" % (x["season"], x["fid"])
                end = "Not recorded"
                if x["final"]:
                    end = self.L.put("arch:final:" + k, x["final"], src, finish_label(x["final"]))
                rows.append(self.row(["%d &middot; %s" % (x["season"], e(x["owner"] or "unnamed")), ap, pc, end]))
        excl = story["excluded"]
        cap = ('<p class="caption">All-Play counts every team&rsquo;s weekly score against all eleven others, Weeks 1&ndash;%d of the regular season. '
               'Source: the league archive of weekly results, %d&ndash;%d, plus the %d standings.%s The finish is the archive&rsquo;s final standing.</p>' % (
                   self.week, first, last, self.season,
                   (" %s %s left out because %s." % (join(sorted(excl)), "is" if len(excl) == 1 else "are",
                                                     "its archived weekly scores conflict with themselves"
                                                     if set(excl.values()) == {"archived weekly scores conflict with themselves"}
                                                     else "its archived weekly results are incomplete")) if excl else ""))
        head = "%s All-Play starts through Week %d, %d&ndash;%d" % ("Best" if best else "Worst", self.week, first, self.season)
        sub = "%s is on a historic pace" % me if best else "%s is off to a historically bad start" % me
        return self.section("bigstory", "The Big Story", 1, "The Big Story <small>&mdash; %s</small>" % e(sub),
                            self.desk(lines) + self.table([head, "Through Week %d" % self.week, "Pct", "How the season ended"], rows) + cap)

    # ------------------------------------------------------------ 2. Division Week
    def team_lines(self, gs, teams, voice0=0):
        s = self.ctx["mfl"]["scores"]
        out = []
        for i, f in enumerate(teams):
            wins = [l for (w, l) in gs if w == f]
            losses = [w for (w, l) in gs if l == f]
            parts = []
            if wins:
                parts.append("beat " + ", ".join("%s by %s" % (e(self.owner[l]), self.margin(f, l)) for l in wins))
            if losses:
                parts.append("lost to " + ", ".join("%s by %s" % (e(self.owner[w]), self.margin(w, f)) for w in losses))
            txt = "%s scored %s and went %s: %s." % (e(self.owner[f]), self.score(f), I.wl(len(wins), len(losses)), "; ".join(parts))
            if losses and self.F.get("f.team.%s.best_available" % f) is not None and self.F.get("f.team.%s.could_have_won" % f) == "yes":
                txt += " The best available lineup, %s, would have won a game %s lost." % (
                    self.fact("f.team.%s.best_available" % f), e(self.owner[f]))
            out.append(("Stuart" if (i + voice0) % 2 == 0 else "Rich", txt))
        return out

    def seg_div(self):
        s = self.ctx["mfl"]["scores"]
        chapters, trows = [], []
        fresh = self.odds_fresh()
        for k, pot in enumerate(self.pack["pots"]):
            gs = [(self.fid[g["winner"]], self.fid[g["loser"]]) for g in pot["games"]]
            teams = sorted({f for g in gs for f in g}, key=lambda f: -s[f])
            name = self.pretty(pot["tag"])
            lines = self.team_lines(gs, teams, voice0=k)
            if fresh:
                divs = {self.ctx["d1"]["franchises"][f]["division"] for f in teams}
                if len(divs) == 1:
                    sim = self.odds_text()[0]
                    lead = max(teams, key=lambda f: (sim["teams"][f]["div"], f))
                    lines.append(("Stuart" if len(lines) % 2 == 0 else "Rich", "%s is %s to win the division, the best chance of the three." % (
                        e(self.owner[lead]), self.dv(lead))))
            who, txt = lines[0]
            lines[0] = (who, "<b>%s.</b> %s" % (e(name), txt))
            chapters.append(self.desk(lines))
            cells = {"Swept": [], "Split": [], "Shut out": []}
            for f in teams:
                w_ = sum(1 for g in gs if g[0] == f)
                l_ = sum(1 for g in gs if g[1] == f)
                cells["Swept" if l_ == 0 else "Shut out" if w_ == 0 else "Split"].append("%s %s" % (e(self.owner[f]), self.score(f)))
            trows.append(self.row([e(name)] + [", ".join(cells[c]) or "&mdash;" for c in ("Swept", "Split", "Shut out")]))
        gap = self.kenny_gap()
        cap = ('<p class="caption">Week %d scores%s. A team is Swept when it won every game it played in the group, Shut out when it won none and '
               'Split otherwise. Chat lines, once an editor chooses them, are owner posts in the league Discord, linked to the message.</p>' % (
                   self.week, " after Elias corrections" if (self.ctx.get("eliasReport") or {}).get("teams") else ""))
        return self.section("divweek", "Division Week", 2, "Division Week <small>&mdash; every game, one chapter per division</small>",
                            "".join(chapters) + gap + self.table(["Division", "Swept", "Split", "Shut out"], trows) + cap)

    def kenny_gap(self):
        chat = self.ctx["d1"]["chat"]
        excluded = chat_exclusions.excluded_ids()
        cands, flagged = {}, 0
        for m in chat:
            txt = " ".join((m["content"] or "").split())
            if m.get("withheld") or chat_exclusions.reason(m["message_id"], txt, excluded):
                flagged += 1
                continue
            if not txt or re.match(r"^https?://\S+$", txt) or "<@" in txt or len(txt) < 12:
                continue
            fid = self.fid.get(m["owner_name"])
            url = "https://discord.com/channels/%s/%s/%s" % (I.GUILD, m["channel_id"], m["message_id"])
            self.L.put("quote:" + m["message_id"], txt, "D1 ups_discord_messages", txt)
            cands.setdefault(self.div_of(fid) if fid else "Other", []).append(
                '<li><b>%s</b>, %s: <a class="rcpt" href="%s" target="_blank" rel="noopener">&ldquo;%s&rdquo;</a></li>' % (
                    e(m["owner_name"]), I.et_clock(m["posted_at_unix"]), url, e(txt)))
        total = sum(len(v) for v in cands.values())
        if self.local:
            listing = "".join("<p style=\"font-weight:700;margin:.5rem 0 0\">%s</p><ol style=\"font-weight:400;margin:.2rem 0 0 1rem\">%s</ol>" % (
                e(d), "".join(v[:12])) for d, v in sorted(cands.items())) or " No usable owner messages in the window."
        else:
            listing = " %s candidate line(s) are listed, verbatim, linked and grouped by division, in the local review copy only (raw chat " \
                      "stays off the public repo)." % self.L.put("count:candidates", total, "D1 ups_discord_messages window (usable lines)")
            for k in [k for k in self.L.claims if k.startswith("quote:")]:
                del self.L.claims[k]
        return self.gap("coffee:kenny", "coffee", "Kenny Mayne&rsquo;s lines are an editor&rsquo;s job (owner dossier). Choose from the verbatim "
                        "candidates, weave each into the chapter it belongs to as a <code>lt kenny</code> line with its link, then remove this "
                        "box. %d message(s) ruled out by an editor or touching family, health or similar were withheld and must not be "
                        "used.%s" % (flagged, listing))

    # ------------------------------------------------------------ 3. Elias
    def seg_elias_story(self):
        rep = self.ctx.get("eliasReport") or {}
        posts = self.ctx["mfl"].get("elias") or []
        official = rep.get("officialChanges")
        n_official = len(official) if isinstance(official, list) else (official or len(posts))
        if not posts and not n_official:
            return self.section("elias", "Elias", 3, "Elias", self.gap(
                "elias:not-posted", "elias", "Elias has not posted official Week %d changes yet. The Thursday and Friday runs re-check and "
                "will update this draft." % self.week))
        moved = {t["fid"]: t for t in rep.get("teams") or []}
        apch = {c["fid"]: c for c in rep.get("allplayChanges") or []}
        if not moved and not apch:
            return ""                                   # corrections only: nothing moved, nothing to tell
        pub = (self.ctx.get("scoresPublished") or {})
        src_e = "elias.py check (MFL site news, Official Statistics Changes) vs scores_published_%d_wk%02d" % (self.season, self.week)
        fids = sorted(set(moved) | set(apch), key=lambda f: (-abs((moved.get(f) or {}).get("delta", 0)), f))
        lines = []
        pl = [p for p in rep.get("players") or [] if p.get("status") == "starter"]
        bits = []
        for p in pl:
            ch = (p.get("elias") or [{}])[0]
            d = self.L.put("elias:delta:" + p["pid"], round(p["delta"], 1), src_e, "%+.1f" % p["delta"])
            fr = self.L.put("elias:stat:%s:from" % p["pid"], ch.get("from"), src_e, "%d" % ch["from"]) if ch.get("from") is not None else ""
            to = self.L.put("elias:stat:%s:to" % p["pid"], ch.get("to"), src_e, "%d" % ch["to"]) if ch.get("to") is not None else ""
            what = "%s went from %s to %s" % (e(ch.get("stat", "a stat").lower()), fr, to) if fr and to else "a stat changed"
            bits.append("%s&rsquo;s %s, a change of %s for %s" % (e(p["player"]), what, d.replace("-", "&minus;"), e(self.owner[p["fid"]])))
        n_c = self.L.put("elias:count", n_official, src_e)
        lines.append(("Stuart", "The league office posted %s official stat changes for Week %d, and %s: %s." % (
            n_c, self.week, "one touched a UPS starter" if len(bits) == 1 else "%d touched UPS starters" % len(bits), "; ".join(bits)) if bits else
            "The league office posted %s official stat changes for Week %d." % (n_c, self.week)))
        mv = []
        for f in sorted(moved, key=lambda f: -moved[f]["delta"]):
            b = self.L.put("elias:before:" + f, round(moved[f]["before"], 1), src_e)
            mv.append("%s went from %s to %s" % (e(self.owner[f]), b, self.score(f)))
        if mv:
            lines.append(("Rich", join(mv) + ". Every number in this issue already counts the corrected scores."))
        if apch:
            ch = []
            for f in sorted(apch):
                b, a = apch[f]["before"], apch[f]["after"]
                wb = self.L.put("elias:wkapBefore:" + f, "%d-%d" % (b["w"], b["l"]), src_e, I.wl(b["w"], b["l"]))
                ch.append("%s&rsquo;s Week %d All-Play went from %s to %s" % (e(self.owner[f]), self.week, wb, self.wkap_c(f)))
            lines.append(("Stuart", "That moved an All-Play game: %s. Their season records moved with it: %s." % (join(ch), join(
                "%s is %s, not %s" % (e(self.owner[f]), self.ap_c(f), self.L.put(
                    "elias:apBefore:" + f, self.season_before(f, apch[f]), src_e, I.wl(*self.season_before(f, apch[f]).split("-"))))
                for f in sorted(apch)))))
        flips = rep.get("resultsFlipped")
        if flips == 0:
            lines.append(("Rich", "No head-to-head result flipped."))
        elif flips:
            lines.append(("Rich", "%s head-to-head result(s) flipped." % self.L.put("elias:flipped", flips, src_e)))
        rows = []
        for f in fids:
            mvd = moved.get(f)
            before = self.L.put("elias:before:" + f, round(mvd["before"], 1), src_e) if mvd else self.score(f)
            ch = ("%+.1f" % mvd["delta"]).replace("-", "&minus;") if mvd else "0.0"
            if mvd:
                self.L.put("elias:delta:" + f, round(mvd["delta"], 1), src_e, ch)
            ap = ("%s &rarr; %s" % (self.L.put("elias:wkapBefore:" + f, "%d-%d" % (apch[f]["before"]["w"], apch[f]["before"]["l"]), src_e,
                                              I.wl(apch[f]["before"]["w"], apch[f]["before"]["l"])), self.wkap_c(f))) if f in apch else "unchanged"
            rows.append(self.row([e(self.owner[f]), before, self.score(f), ch, ap]))
        cap = ('<p class="caption">Source: MFL site news, Official Statistics Changes (%s items for Week %d), compared with the scores frozen when the recap was '
               'built.%s</p>' % (n_c, self.week, " The league message goes out because an All-Play record changed." if apch else ""))
        return self.section("elias", "Elias", 3, "Elias <small>&mdash; %s</small>" % ("a correction moved the board" if apch else "a score moved"),
                            self.desk(lines) + self.table(["Team", "Published", "After Elias", "Change", "Week %d All-Play" % self.week], rows) + cap)

    def season_before(self, f, ch):
        """'w-l' season All-Play before Elias: now, minus the week's All-Play change."""
        aw, al = (int(x) for x in self.ctx["mfl"]["standings"][f]["allplay"].split("-")[:2])
        wa = self.week_allplay()[f]
        return "%d-%d" % (aw - wa[0] + ch["before"]["w"], al - wa[1] + ch["before"]["l"])

    # ------------------------------------------------------------ 4. Playoff Picture (story intro over the table)
    def odds_lead(self, teams, src, order, div_shown, title_shown):
        by_div = {}
        for f in teams:
            by_div.setdefault(teams[f]["division"], []).append(f)
        fav = {d: max(fs, key=lambda f: (teams[f]["div"], f)) for d, fs in by_div.items()}
        favs = sorted(fav.values(), key=lambda f: (-teams[f]["div"], f))
        lines = [("Stuart", "Here is the shape of it. %s division favorites: %s." % (
            WORDS.get(len(favs), str(len(favs))).capitalize(),
            join("%s at %s to win %s" % (e(self.owner[f]), self.dv(f), e(self.div_of(f))) for f in favs)))]
        rest = [f for f in order if f not in favs]
        wild = [f for f in rest if teams[f]["po"] >= 0.08]
        low = [f for f in rest if teams[f]["po"] < 0.08]
        if wild:
            lines.append(("Rich", "Then the wild-card road: %s." % join(
                "%s is %s to make the playoffs with a %s chance of winning the division" % (e(self.owner[f]), self.po(f), self.dv(f)) for f in wild)))
        if low:
            lines.append(("Stuart", "And the bottom: %s." % join("%s at %s" % (e(self.owner[f]), self.po(f)) for f in low)))
        return lines

    # ------------------------------------------------------------ 5. Plays
    def seg_story_plays(self):
        gaps, lists, caption, proven = self.bb_parts()
        cards = self.play_cards(linked_only=True)
        rows = []
        for tid in ("t.bb.off.bargain", "t.bb.idp.bargain"):
            rows += [("bargain", tid, r) for r in proven.get(tid, [])]
        for tid in ("t.bb.off.bust", "t.bb.idp.bust"):
            rows += [("bust", tid, r) for r in proven.get(tid, [])]

        def d(r):
            return abs(float(r[4].replace("+", "").replace("-", "").replace("−", "")))

        def nm(r):
            return re.sub(r"\s*\(.*$", "", r[0])

        def one(r, tail=""):
            fid = self.fid[r[1]]
            return "%s was projected for %s and scored %s for %s%s" % (e(nm(r)), I.n1(r[2]), I.n1(r[3]), e(r[1]), tail)
        bargains = sorted([x for x in rows if x[0] == "bargain"], key=lambda x: (-d(x[2]), nm(x[2])))
        busts = sorted([x for x in rows if x[0] == "bust"], key=lambda x: (-d(x[2]), nm(x[2])))
        lines = []
        if bargains:
            r = bargains[0][2]
            use = (" (%s)" % e(re.sub(r"\s*\([\d.]+\)$", "", r[5]))) if len(r) > 5 and r[5] else ""
            lines.append(("Stuart", "Start with the number nobody had. %s%s. That is %s, the biggest bargain of the week." % (one(r), use, e(r[4]))))
        if len(bargains) > 1:
            r = bargains[1][2]
            f = self.fid[r[1]]
            rec = self.week_records()[f]
            lines.append(("Rich", "%s. %s went %s%s." % (one(r), e(r[1]), self.wkrec_c(f),
                                                         ", so a bargain is not a guarantee" if rec[0] == 0 else "")))
        if busts:
            r = busts[0][2]
            f = self.fid[r[1]]
            lines.append(("Stuart", "Now the other side. %s, a gap of %s; %s scored %s and went %s." % (
                one(r), e(r[4]).replace("-", "&minus;"), e(r[1]), self.score(f), self.wkrec_c(f))))
        if len(busts) > 1:
            r = busts[1][2]
            f = self.fid[r[1]]
            lines.append(("Rich", "%s, a gap of %s; %s scored %s." % (one(r), e(r[4]).replace("-", "&minus;"), e(r[1]), self.score(f))))
        idp = [x for x in bargains if x[1] == "t.bb.idp.bargain"]
        if idp:
            r = idp[0][2]
            lines.append(("Stuart", "On defense, %s." % one(r)))
        return self.section("plays", "The Plays That Made the Week", 5,
                            "The Plays That Made the Week <small>&mdash; the bargains, the busts, and who they carried</small>",
                            self.desk(lines) + gaps + '<div class="reel">%s</div>' % "".join(cards)
                            + '<details class="wire-more"><summary>The full projection ledger</summary><div class="bb">%s</div>%s</details>' % (lists, caption))

    # ------------------------------------------------------------ 6. The Season So Far
    def seg_story_season(self):
        H = STORIES.heat(self.ctx)
        S = STORIES.survival(self.ctx)
        g_land, land = self.seg_landscape(bare=True)
        g_heat, heat = self.seg_heat(bare=True)
        g_surv, surv = self.seg_survival(bare=True)
        lines = []
        if H:
            src = "D1 src_franchise_weekly_score + src_schedule, weeks 1-%d" % self.week
            first, last = STORIES.windows(self.week)
            w_last = "Weeks %d&ndash;%d" % (last[0], last[-1]) if len(last) > 1 else "Week %d" % last[0]
            w_first = ("Weeks %d&ndash;%d" % (first[0], first[-1]) if len(first) > 1 else "Week %d" % first[0]) if first else ""
            a3 = lambda f: self.L.put("heat:ap3:" + f, "%d-%d" % H[f]["ap3"], src, I.wl(*H[f]["ap3"]))
            dom = sorted([f for f in H if H[f]["label"] == "Dominant"], key=lambda f: (-H[f]["ap3"][0], f))
            rest = sorted([f for f in H if f not in dom], key=lambda f: (-H[f]["ap3"][0], f))
            if dom:
                t1 = "Treat the last three weeks as their own season. In %s, the Dominant teams in All-Play are %s." % (
                    w_last, join("%s at %s" % (e(self.owner[f]), a3(f)) for f in dom[:3]))
            else:
                t1 = "Treat the last three weeks as their own season. In %s, no team was Dominant." % w_last
            t1 += " The next best are %s." % join("%s at %s" % (e(self.owner[f]), a3(f)) for f in rest[:2])
            lines.append(("Stuart", t1))
            rk = lambda f, k: self.L.put("heat:%s:%s" % (k, f), H[f][k], src, self._ord(H[f][k]))
            moves = [(f, H[f]["rkFirst"] - H[f]["rkLast"]) for f in H if H[f]["rkFirst"] is not None]
            up = [f for f, m in sorted(moves, key=lambda x: (-x[1], x[0])) if m >= 4][:2]
            down = [f for f, m in sorted(moves, key=lambda x: (x[1], x[0])) if m <= -4][:2]
            mv = ["%s %s from %s in scoring in %s to %s in %s" % (e(self.owner[f]), "climbed", rk(f, "rkFirst"), w_first, rk(f, "rkLast"), w_last) for f in up]
            mv += ["%s %s from %s to %s" % (e(self.owner[f]), "fell", rk(f, "rkFirst"), rk(f, "rkLast")) for f in down]
            if mv:
                lines.append(("Rich", "The movers. %s." % join(mv)))
        if S:
            rows, meta = S
            sim_ok = self.odds_fresh()
            comp = lambda m, n_: m / float(n_) if n_ else None
            gap_ = sorted([f for f in rows if comp(*rows[f]["apHist"]) is not None and comp(*rows[f]["winHist"]) is not None
                           and rows[f]["apHist"][1] >= 5 and rows[f]["winHist"][1] >= 5],
                          key=lambda f: (-abs(comp(*rows[f]["apHist"]) - comp(*rows[f]["winHist"])), f))
            hs = "D1 weeks 1-%d of %d-%d + /api/playoff-bracket" % (self.week, meta["firstAp"], meta["lastAp"])
            hv = lambda f, k: self.L.put("hist:%s:%s" % (k, f), rows[f][("apHist" if k.startswith("ap") else "winHist")][0 if k.endswith("Made") else 1], hs)
            if gap_:
                f = gap_[0]
                tail = (" The forecast lands at %s." % self.po(f)) if sim_ok else ""
                lines.append(("Stuart", "Then ask what history says. %s is where the two histories disagree most: %s of %s teams with the same All-Play rank made the playoffs, "
                                        "but %s of %s with the same win total did.%s" % (e(self.owner[f]), hv(f, "apMade"), hv(f, "apN"), hv(f, "winMade"), hv(f, "winN"), tail)))
            if sim_ok:
                sim = self.odds_text()[0]
                low = sorted(rows, key=lambda f: (sim["teams"][f]["po"], f))[:2]
                lines.append(("Rich", "At the bottom, %s." % "; ".join("%s is %s of %s by All-Play rank and %s of %s by wins, with a %s forecast" % (
                    e(self.owner[f]), hv(f, "apMade"), hv(f, "apN"), hv(f, "winMade"), hv(f, "winN"), self.po(f)) for f in low)))
        if H:
            src = "D1 src_franchise_weekly_score + src_schedule, weeks 1-%d" % self.week
            lk = sorted(H, key=lambda f: (-H[f]["luck"], f))
            lu, un = lk[0], lk[-1]
            bn = max(H, key=lambda f: (H[f]["bench"], f))
            sg = lambda v: ("%+.1f" % v).replace("-", "&minus;")
            lines.append(("Stuart", "And luck. %s is %s wins over what the All-Play rate predicts, the most in the league, and %s is %s, the fewest. %s leaves %s points on the bench every week, the most, and %s of %s losses would have been wins with the best lineup." % (
                e(self.owner[lu]), self.L.put("heat:luck:" + lu, H[lu]["luck"], src, sg(H[lu]["luck"])), e(self.owner[un]),
                self.L.put("heat:luck:" + un, H[un]["luck"], src, sg(H[un]["luck"])), e(self.owner[bn]),
                self.L.put("heat:bench:" + bn, H[bn]["bench"], src, "%.1f" % H[bn]["bench"]),
                self.L.put("heat:lostBest:" + bn, H[bn]["lostBest"], src), self.L.put("heat:losses:" + bn, H[bn]["losses"], src))))
        return self.section("season", "The Season So Far", 6, "The Season So Far <small>&mdash; who is real, who is rising, and what history says</small>",
                            self.desk(lines) + g_land + g_heat + g_surv +
                            '<details class="wire-more"><summary>The standings, Heat Check and Survival Line tables</summary>%s%s%s</details>' % (land, heat, surv))

    # ------------------------------------------------------------ assembly
    def segments(self):
        segs = [self.seg_big(), self.seg_div(), self.seg_elias_story(), self.seg_odds(), self.seg_story_plays(), self.seg_story_season()]
        segs = [x for x in segs if x]
        n = [0]

        def bump(m):
            n[0] += 1
            return '<span class="seg">%d</span>' % n[0]
        return [re.sub(r'<span class="seg">\d+</span>', bump, x, count=1) for x in segs]


def check_structure(doc):
    """Problems with the page's markup: unbalanced <div>s (Week 8's plays ledger closed the page wrapper and un-styled
    the last segment) or <details>. [] when sound."""
    body = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", doc[doc.index("<body"):])
    out = []
    for tag in ("div", "details", "section", "table"):
        o, c = len(re.findall(r"<%s\b" % tag, body)), len(re.findall(r"</%s>" % tag, body))
        if o != c:
            out.append("<%s> opens %d, closes %d" % (tag, o, c))
    return out
