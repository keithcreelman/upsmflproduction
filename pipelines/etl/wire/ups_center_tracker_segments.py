#!/usr/bin/env python3
"""The page's trackers and the trade story's extra chapters (Keith 2026-11-18), as one mixin for StoryIssue:

  trade_round_trip()   the two Cross-Martel deals told as one story, the Addison injury, the cap argument, and the pick-range chapter
  pick_visual()        "where the picks could land": the four traded 2027 picks over the twelve draft slots, from the simulation's own
                       postseason-bracket finishes (season_sim slot shares), never the seed odds relabelled
  seg_qb_bet()         Cross vs. Josh Martel: two $50 bets, the quarterback total shown week by week with headshots
  seg_hall()           the Hall of Shame watch: All-Play percentage below .200 qualifies

Every number printed is a registered claim (`tk:*`); ups_center_validate re-derives each from the snapshot's raw data (ctx["trackers"],
ctx["forecast"], ctx["mfl"]), never from this module.
"""
import html
from datetime import datetime, timezone

import season_sim as SIM
import ups_center_issue as I
import ups_center_trackers as TK

e = html.escape
SRC_MFL = "MFL public exports (transactions, salaryAdjustments, rosters, playerScores, nflSchedule)"


def money(x):
    return "${:,.0f}".format(x)


def jn(items):
    items = list(items)
    return items[0] if len(items) == 1 else ", ".join(items[:-1]) + (", and " if len(items) > 2 else " and ") + items[-1]


class TrackerSegments:
    # ------------------------------------------------------------------------------------------- shared helpers
    def tk_data(self):
        return self.ctx.get("trackers") or {}

    def tk_missing(self, gid, section, what):
        return self.gap(gid, section, "%s could not be built from MFL's feeds (%s). Fix the feed or leave it out." % (
            what, "; ".join((self.tk_data().get("errors") or ["no tracker data in the snapshot"])[:2])))

    def tk_name(self, fid):
        return e(self.owner[fid])

    def cap_money(self, x, side_key, idx):
        """a cap-space asset of the PRIOR trade, registered against its own raw token (claim tk:capspace:prior:<side>:<n>)."""
        return self.L.put("tk:capspace:prior:%s:%d" % (side_key, idx), x["amount"], SRC_MFL + " (the earlier trade)", money(x["amount"]))

    def cap_name(self, x, side_key, idx):
        return "%s of cap space" % self.cap_money(x, side_key, idx)

    @staticmethod
    def mname(x):
        """'Jalen Hurts' from either 'Jalen Hurts' or MFL's 'Hurts, Jalen'."""
        n = x["name"] if isinstance(x, dict) else str(x)
        return n.split(", ")[-1] + " " + n.split(", ")[0] if ", " in n else n

    def asset_words(self, x, side_key, idx, sender=None):
        if x["kind"] == "player":
            return e(self.mname(x))
        if x["kind"] == "pick":
            own = ("his own " if x.get("origin") == sender else "%s&rsquo;s " % e(self.owner[x["origin"]])) if x.get("origin") in self.owner else ""
            return "%s%d %s-round pick" % (own, x["year"], self.ORDW.get(x["round"], str(x["round"])))
        if x["kind"] == "bb":
            return self.cap_name(x, side_key, idx)
        return e(str(x.get("token")))

    def assets_phrase(self, gave, side_key, sender=None):
        """picks of one year and origin collapse: 'his own 2027 first-round and second-round picks'."""
        bbi = {id(y): i for i, y in enumerate([y for y in gave if y["kind"] == "bb"])}
        parts, used = [], set()
        for x in gave:
            if id(x) in used:
                continue
            if x["kind"] == "pick":
                same = [y for y in gave if y["kind"] == "pick" and y.get("origin") == x.get("origin") and y["year"] == x["year"]]
                if len(same) > 1:
                    used |= {id(y) for y in same}
                    own = ("his own " if x.get("origin") == sender else "%s&rsquo;s " % e(self.owner[x["origin"]])) if x.get("origin") in self.owner else ""
                    parts.append("%s%d %s picks" % (own, x["year"], " and ".join("%s-round" % self.ORDW.get(y["round"], str(y["round"])) for y in sorted(same, key=lambda y: y["round"]))))
                    continue
            parts.append(self.asset_words(x, side_key, bbi.get(id(x), 0), sender))
        return jn(parts)

    # ------------------------------------------------------------------------------------------- the trade, told as one story
    def trade_round_trip(self, tr, src):
        """Short lines for the printed trade (Keith 2026-11-19): the April deal in one sentence, Addison's injury and what Cross said, the cap cost once.
        [] when the earlier deal is not in the snapshot."""
        T = (self.tk_data().get("trade") or {})
        prior, praw = T.get("prior"), T.get("priorRaw")
        if not prior or not praw:
            return []
        a, b = tr["a"], tr["b"]
        pa, pb = prior["a"], prior["b"]
        if {pa, pb} != {a, b}:
            return []
        lines = []
        day = datetime.fromtimestamp(tr["timestamp"], I.ET).strftime("%A")
        picks_back = [x for x in prior["a_gave"] + prior["b_gave"] if x["kind"] == "pick"]
        cross = pa if any(x["kind"] == "pick" for x in prior["a_gave"]) else pb       # the team that sent picks in April
        other = pb if cross == pa else pa
        sent, got = (prior["a_gave"], prior["b_gave"]) if cross == pa else (prior["b_gave"], prior["a_gave"])
        s_key = "a" if cross == pa else "b"
        now_other = tr["a_gave"] if other == a else tr["b_gave"]
        now_cross = tr["a_gave"] if cross == a else tr["b_gave"]
        returned = [x for x in now_other if x["kind"] == "pick" and any(x.get("origin") == p.get("origin") and x.get("year") == p.get("year")
                                                                        and x.get("round") == p.get("round") for p in picks_back)]
        if len(returned) != len([x for x in sent if x["kind"] == "pick"]):
            return []
        players_got = [x for x in got if x["kind"] == "player"]
        lines.append(("Stuart", "%s had given %s %s in April for %s. %s&rsquo;s trade brought both picks back." % (
            self.sn(cross), self.sn(other), self.assets_phrase([x for x in sent if x["kind"] == "pick"], s_key, sender=cross),
            jn(e(self.mname(x)) for x in players_got) or "his April package", day)))
        notes = (self.tk_data().get("notes") or {})
        ad = notes.get("addison")
        incoming = [x for x in now_other if x["kind"] == "player"]
        outgoing = [x for x in now_cross if x["kind"] == "player"]
        bb_out = [x for x in now_cross if x["kind"] == "bb"]
        ros = T.get("roster") or {}
        if ad and incoming and outgoing and bb_out and all(str(x["id"]) in ros for x in incoming + outgoing):
            inc, out = incoming[0], max(outgoing, key=lambda x: x["salary"])
            iname, oname = e(self.mname(inc)), e(self.mname(out))
            ichat = (notes.get("crossChat") or {}).get("mid")
            clink = ('<a class="srcl" href="https://discord.com/channels/%s/%s/%s" target="_blank" rel="noopener">said himself</a>' % (I.GUILD, (notes.get("bet") or {}).get("channel_id", ""), ichat)) if ichat else "said himself"
            lines.append(("Stuart", "%s is hurt. %s <a class=\"srcl\" href=\"%s\" target=\"_blank\" rel=\"noopener\">Source: %s, %s</a>. %s %s that he wanted draft capital, not immediate help." % (
                iname, e(ad["text"]), e(ad["url"]), e(ad["outlet"]), e(ad["date"]), self.sn(cross), clink)))
            st = ros[str(inc["id"])].get("status")
            if st == "ROSTER":
                sal_out = self.L.put("tk:cap:salary:out", out["salary"], SRC_MFL + " (rosters)", money(out["salary"]))
                sal_in = self.L.put("tk:cap:salary:in", inc["salary"], SRC_MFL + " (rosters)", money(inc["salary"]))
                space = self.L.put("tk:cap:space", bb_out[0]["amount"], SRC_MFL + " (the trade's cap-space token)", money(bb_out[0]["amount"]))
                extra = self.L.put("tk:cap:extra", out["salary"] - inc["salary"] - bb_out[0]["amount"], SRC_MFL + " (computed: salary taken on - salary given up - cap space received)",
                                   money(out["salary"] - inc["salary"] - bb_out[0]["amount"]))
                lines.append(("Rich", "With %s on %s&rsquo;s active roster, %s gives up %s&rsquo;s %s salary, takes on %s&rsquo;s %s salary, and receives %s of cap space. That makes %s an additional %s of 2026 cap cost for %s. "
                                       "%s still owns %s&rsquo;s contract; %s is the current cap effect, not his total cost." % (
                                           iname.split(" ")[-1], self.sn(cross), self.sn(other), iname.split(" ")[-1], sal_in, oname.split(" ")[-1], sal_out, space,
                                           oname.split(" ")[-1], extra, self.sn(other), self.sn(other), oname.split(" ")[-1], extra)))
            else:
                lines.append(("Rich", "%s is no longer on %s&rsquo;s active roster, so the cap effect of the trade needs a fresh calculation." % (iname.split(" ")[-1], self.sn(cross))))
        return lines

    # ------------------------------------------------------------------------------------------- pick ranges
    def pick_rows(self, tr):
        """[(label_html, fid, round, direction_html)] for the traded 2027 picks; picks whose original franchise's slot shares are missing are skipped."""
        sim = ((self.ctx.get("forecast") or {}).get("sim") or {})
        rows, seen = [], set()
        T = (self.tk_data().get("trade") or {})
        a, b = tr["a"], tr["b"]
        for side, gave, to in ((a, tr["a_gave"], b), (b, tr["b_gave"], a)):
            for x in gave:
                if x["kind"] != "pick" or x.get("origin") not in self.owner:
                    continue
                rows.append({"fid": x["origin"], "year": x["year"], "round": x["round"], "from": side, "to": to})
        return rows, sim

    def lab(self, r, n):
        return self.L.put("tk:slotlabel:%d:%d" % (r, n), r * 100 + n, "league draft order (canon A1)", "%d.%02d" % (r, n))

    def ranges(self, rounds, lo, hi):
        return " / ".join("%s&ndash;%s" % (self.lab(r, lo), self.lab(r, hi)) for r in rounds)

    def pick_visual(self, tr):
        rows, sim = self.pick_rows(tr)
        teams = (sim or {}).get("teams") or {}
        if not rows or not sim or not all((teams.get(r["fid"]) or {}).get("slot") for r in rows):
            return ""
        runs = sim.get("runs")
        src = "season_sim --through-week %s, %s runs, generated %s UTC (draft slots from each simulated postseason bracket finish, canon A1)" % (
            sim.get("throughWeek"), runs, sim.get("generatedAtUtc"))
        runs_c = self.L.put("tk:runs", runs, src, "{:,}".format(runs))
        # group the traded picks by original franchise (Cross's first and second share one set of slots)
        groups = {}
        for r in rows:
            groups.setdefault(r["fid"], []).append(r)
        head = ""
        for i in range(1, 13):
            head += '<span class="pk-n">%s</span>' % self.L.put("tk:slotno:%d" % i, i, "league draft order (canon A1)", str(i))
        out = ['<div class="pickrange" role="group" aria-label="Where the traded 2027 picks could land">',
               '<div class="pk-bands"><span class="pk-band pk-ht">Hawk Tuah side</span><span class="pk-band pk-ch">Championship side</span></div>',
               '<div class="pk-scale"><span class="pk-lab">Slot</span>%s</div>' % head]
        for fid, rs in sorted(groups.items(), key=lambda kv: (min(r["round"] for r in kv[1]), kv[0])):
            share = teams[fid]["slot"]
            disp = SIM.display_percentages({str(i + 1): share[i] for i in range(12)}, 1)
            hawk = sum(share[:6])
            side_d = SIM.display_percentages({"h": hawk, "c": 1 - hawk}, 1)
            allh = abs(hawk - 1) < 1e-9 or abs(hawk) < 1e-9
            cells = ""
            for i in range(12):
                v = share[i]
                if v <= 0:
                    cells += '<span class="pk-c pk-0" aria-label="no runs"></span>'
                    continue
                shown = self.L.put("tk:slot:%s:%d" % (fid, i + 1), float(disp[str(i + 1)]), src, disp[str(i + 1)])
                heat = min(1.0, v / 0.35)
                cells += '<span class="pk-c" style="--h:%.2f" title="%s%%">%s</span>' % (heat, shown, shown)
            rounds = sorted(r["round"] for r in rs)
            rl = "- and ".join("%s" % self.ORDW.get(x, str(x)) for x in rounds)
            who = self.owner[fid]
            dirs = jn(sorted({("back to %s" % self.sn(r["to"])) if r["to"] == fid else ("to %s" % self.sn(r["to"])) for r in rs}))
            if allh:
                if hawk > 0.5:
                    side_txt = "Hawk Tuah side in all %s runs (%s)" % (runs_c, self.ranges(rounds, 1, 6))
                else:
                    side_txt = "championship side in all %s runs (%s)" % (runs_c, self.ranges(rounds, 7, 12))
            else:
                hs = self.L.put("tk:side:%s:h" % fid, float(side_d["h"]), src, side_d["h"])
                cs = self.L.put("tk:side:%s:c" % fid, float(side_d["c"]), src, side_d["c"])
                side_txt = "%s%% Hawk Tuah side (%s) &middot; %s%% championship side (%s)" % (hs, self.ranges(rounds, 1, 6), cs, self.ranges(rounds, 7, 12))
            out.append('<div class="pk-row"><div class="pk-who"><b>%s&rsquo;s 2027 %s-round pick%s</b> <span class="pk-dir">%s</span></div>'
                       '<div class="pk-side">%s</div><div class="pk-strip">%s</div></div>' % (
                           e(who), rl, "s" if len(rs) > 1 else "", dirs, side_txt, cells))
        out.append('<p class="caption">Estimates, not predictions: shares of %s simulated seasons on the rosters after this trade (forecast generated %s, MFL data through Week %d). A season&rsquo;s slot comes from that team&rsquo;s own postseason bracket finish; the Hawk Tuah winner takes the first slot and the UPS champion the last. A blank cell is a slot the team never reached. Shares are rounded; the model moves every week.</p>' % (
                       runs_c, I.et_clock(int(datetime.strptime(sim["generatedAtUtc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())),
                       int(sim.get("throughWeek") or self.week)))
        out.append("</div>")
        return "".join(out)

    def pick_lines(self, tr):
        """The visual's conclusion in the dialogue (Keith 2026-11-19): the two most likely adjacent slots of the returned first and of the first that was
        sent, and the top slot's small chance. Estimates from the simulation, never a predicted slot."""
        rows, sim = self.pick_rows(tr)
        teams = (sim or {}).get("teams") or {}
        if not rows or not all((teams.get(r["fid"]) or {}).get("slot") for r in rows):
            return []
        cf = next((r["to"] for r in rows if r["to"] == r["fid"]), None)
        back = sorted([r for r in rows if r["to"] == r["fid"]], key=lambda r: r["round"])
        sent = sorted([r for r in rows if r["from"] == cf and r["fid"] != cf], key=lambda r: r["round"])
        if not cf or not back or not sent or back[0]["round"] != sent[0]["round"]:
            return []
        runs = sim.get("runs")
        src = "season_sim --through-week %s, %s runs, generated %s UTC (draft slots from each simulated postseason bracket finish, canon A1)" % (sim.get("throughWeek"), runs, sim.get("generatedAtUtc"))
        runs_c = self.L.put("tk:runs", runs, src, "{:,}".format(runs))
        day = datetime.strptime(sim["generatedAtUtc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(I.ET).strftime("%B %-d")

        def top2(fid, rnd):
            share = teams[fid]["slot"]
            disp = SIM.display_percentages({str(i + 1): share[i] for i in range(12)}, 1)
            idx = sorted(sorted(range(12), key=lambda i: -share[i])[:2])
            vals = [self.L.put("tk:slot:%s:%d" % (fid, i + 1), float(disp[str(i + 1)]), src, disp[str(i + 1)]) for i in idx]
            tot = round(float(disp[str(idx[0] + 1)]) + float(disp[str(idx[1] + 1)]), 1)
            tot_c = self.L.put("tk:slotsum:%s:%d:%d" % (fid, idx[0] + 1, idx[1] + 1), tot, src, "%.1f" % tot)
            return [self.lab(rnd, i + 1) for i in idx], vals, tot_c, idx
        rl, rv, rt, ridx = top2(back[0]["fid"], back[0]["round"])
        sl, sv, st_, sidx = top2(sent[0]["fid"], sent[0]["round"])
        first = self.ORDW.get(back[0]["round"], str(back[0]["round"]))
        own1 = self.L.put("tk:slot:%s:1" % cf, float(SIM.display_percentages({str(i + 1): teams[cf]["slot"][i] for i in range(12)}, 1)["1"]), src,
                          SIM.display_percentages({str(i + 1): teams[cf]["slot"][i] for i in range(12)}, 1)["1"])
        text = ("In the draft&rsquo;s %s simulation of %s seasons, %s&rsquo;s returned %s-round pick lands at %s in %s%% of runs and %s in %s%%, %s%% combined." % (
            day, runs_c, self.sn(cf), first, rl[0], rv[0], rl[1], rv[1], rt))
        if len(back) > 1:
            text += " His returned %s-round pick follows the same positions, %s or %s." % (self.ORDW.get(back[1]["round"], str(back[1]["round"])), self.lab(back[1]["round"], ridx[0] + 1), self.lab(back[1]["round"], ridx[1] + 1))
        text += (" The %s %s-round pick that %s sent to %s lands at %s in %s%% and %s in %s%%, %s%% combined. %s&rsquo;s own first reaches %s in only %s%%. "
                 "That supports his case that he improved his first, and it is a gentle reminder to anyone getting excited about a top pick. These are estimates; they get rechecked if the forecast cutoff changes." % (
                     e(self.owner[sent[0]["fid"]]), first, self.sn(cf), self.sn(sent[0]["to"]), sl[0], sv[0], sl[1], sv[1], st_, self.sn(cf), self.lab(back[0]["round"], 1), own1))
        return [("Rich", text)]

    # ------------------------------------------------------------------------------------------- Cross vs. Josh Martel
    def seg_qb_bet(self):
        if "trackers" not in self.ctx:
            return ""                                  # an older snapshot: this build has no tracker data at all
        T = self.tk_data()
        q = T.get("qb")
        notes = T.get("notes") or {}
        if not q or not (notes.get("bet") or {}):
            return self.section("qbbet", "The QB bet", 0, "Side bet", self.tk_missing("tracker:qb", "qbbet", "The Cross-Josh quarterback bet"))
        sides = q["sides"]
        cf, jf = notes["bet"]["cross"]["fid"], notes["bet"]["josh"]["fid"]
        rows = {p: {int(w): v for w, v in r.items()} for p, r in q["scores"].items()}
        through = int(T.get("through") or self.week)
        game_teams = {int(w): set(ts) for w, ts in q["gameTeams"].items()}
        team_of = {p: q["players"][p]["team"] for p in q["players"]}

        def status(p, w):
            return "missed" if team_of[p] in game_teams.get(w, set()) else "bye"
        table = TK.qb_table(rows, sides, through, status)
        src = SRC_MFL + " (playerScores W=ALL; nflSchedule for byes)"
        nm = lambda p: q["players"][p]["name"].split(", ")[-1] + " " + q["players"][p]["name"].split(", ")[0]
        last = lambda p: q["players"][p]["name"].split(", ")[0]
        done = [r for r in table if r["state"] == "done"]
        fin = done[-1]
        ca, ja = fin["cum"]["cross"], fin["cum"]["josh"]
        pair_c = lambda s, p: self.L.put("tk:qb:cum:%s" % s, fin["cum"][s], src, "%.1f" % fin["cum"][s])
        lead = fin["lead"]
        lead_c = self.L.put("tk:qb:lead", abs(lead), src, "%.1f" % abs(lead))
        lines = []
        tm = notes["bet"].get("terms") or {}
        un = notes["bet"].get("unchanged") or {}
        link = lambda m: "https://discord.com/channels/%s/%s/%s" % (I.GUILD, self.chat_channel(m["mid"]), m["mid"])
        stake = self.L.put("tk:bet:stake", (notes["bet"].get("stake") or 0), "bet terms, Discord (linked)", money(notes["bet"].get("stake") or 0))
        lines.append(("Stuart", "%s and %s have two separate %s bets. The first is whether the Long Haulers make the playoffs. The second is whether Jalen Hurts and Trevor Lawrence "
                                "outscore Caleb Williams and Lamar Jackson in total UPS fantasy points through Week %d. Cross <a class=\"srcl\" href=\"%s\" target=\"_blank\" rel=\"noopener\">set out the terms in the chat on %s</a>, "
                                "and on %s he <a class=\"srcl\" href=\"%s\" target=\"_blank\" rel=\"noopener\">said they were riding it out with no changes</a>. No quarterback is substituted. "
                                "Both bets are unsettled." % (e(self.owner[cf]), e(self.owner[jf]), stake, TK.QB_THROUGH, link(tm), e(tm.get("date", "")), e(un.get("date", "")), link(un))))
        if lead >= 0:
            lines.append(("Rich", "After Week %d, %s&rsquo;s pair has %s points and %s&rsquo;s has %s. %s leads by %s. The count is every UPS point the four quarterbacks score, started or not, and it follows them through trades: "
                                   "Jackson moved teams earlier and Lawrence moved after Week 10, and neither changes whose total the points go to." % (
                                       through, self.sn(cf), pair_c("cross", None), self.sn(jf), pair_c("josh", None), self.sn(cf), lead_c)))
        else:
            lines.append(("Rich", "After Week %d, %s&rsquo;s pair has %s points and %s&rsquo;s has %s. %s leads by %s." % (
                through, self.sn(cf), pair_c("cross", None), self.sn(jf), pair_c("josh", None), self.sn(jf), lead_c)))
        po = self.po(cf)
        lines.append(("Stuart", "The playoff bet: the forecast gives the Long Haulers odds of %s to make the field. It settles when the official playoff field is set." % po))
        lines += self.qb_lead_story(table, q, nm, last, src)
        # ---- the visual: two labelled sides with headshots and the pair totals
        def head(p):
            ph = (q.get("photos") or {}).get(p) or {}
            url, fb = ph.get("url"), ph.get("fallbackUrl")
            alt = "%s, %s quarterback" % (nm(p), q["players"][p]["team"])
            img = ('<img class="qb-head" src="%s" alt="%s" loading="lazy" width="96" height="70"%s onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;delete this.dataset.fallback;}'
                   'else{this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'qb-head qb-head-none\'}))}">' % (
                       e(url), e(alt), (' data-fallback="%s"' % e(fb)) if fb else "")) if url else '<div class="qb-head qb-head-none" role="img" aria-label="%s"></div>' % e(alt)
            return '<figure class="qb-fig">%s<figcaption>%s</figcaption></figure>' % (img, e(nm(p)))
        def side(s, fid, tot):
            return ('<div class="qb-side qb-%s"><div class="qb-owner">%s<small>%s</small></div><div class="qb-heads">%s</div><div class="qb-total">%s<small>points through Week %d</small></div></div>' % (
                s, e(self.owner[fid]), e(self.team[fid]), "".join(head(p) for p in sides[s]), tot, through))
        vis = '<div class="qb-vs" role="group" aria-label="Quarterback bet: two sides">%s<div class="qb-mid">vs.</div>%s</div>' % (
            side("cross", cf, self.L.put("tk:qb:cum:cross", ca, src, "%.1f" % ca)), side("josh", jf, self.L.put("tk:qb:cum:josh", ja, src, "%.1f" % ja)))
        # ---- the week-by-week record
        order = sides["cross"] + sides["josh"]
        th = "".join('<th scope="col">%s</th>' % e(last(p)) for p in sides["cross"]) + '<th scope="col" class="qb-pair">Cross QBs</th>' \
             + "".join('<th scope="col">%s</th>' % e(last(p)) for p in sides["josh"]) + '<th scope="col" class="qb-pair">Josh QBs</th><th scope="col">Cross total</th><th scope="col">Josh total</th><th scope="col">Lead</th>'
        body = []
        for r in table:
            w = r["week"]
            if r["state"] == "pending":
                body.append('<tr class="qb-pend"><th scope="row">%s</th><td colspan="9">pending</td></tr>' % self.L.put("tk:qb:wk:%d" % w, w, "NFL schedule", "Wk %d" % w))
                continue
            cells = []
            for s in ("cross", "josh"):
                for p in sides[s]:
                    kind, sc = r["pids"][p]
                    if kind == "played":
                        cells.append('<td>%s</td>' % self.L.put("tk:qb:%s:%d" % (p, w), sc, src, "%.1f" % sc))
                    elif kind == "bye":
                        cells.append('<td class="qb-na" title="NFL bye week">BYE</td>')
                    else:
                        cells.append('<td class="qb-na" title="no score: his team played and he did not">OUT</td>')
                cells.append('<td class="qb-pair">%s</td>' % self.L.put("tk:qb:pair:%s:%d" % (s, w), r["pair"][s], src, "%.1f" % r["pair"][s]))
            lead_w = r["lead"]
            cells.append("<td>%s</td><td>%s</td><td class=\"qb-lead\">%s</td>" % (
                self.L.put("tk:qb:cumw:cross:%d" % w, r["cum"]["cross"], src, "%.1f" % r["cum"]["cross"]),
                self.L.put("tk:qb:cumw:josh:%d" % w, r["cum"]["josh"], src, "%.1f" % r["cum"]["josh"]),
                self.L.put("tk:qb:leadw:%d" % w, lead_w, src, "%+.1f" % lead_w).replace("-", "&minus;")))
            body.append('<tr><th scope="row">%s</th>%s</tr>' % (self.L.put("tk:qb:wk:%d" % w, w, "NFL schedule", "Wk %d" % w), "".join(cells)))
        # column order: Hurts, Lawrence, Cross QBs, Williams, Jackson, Josh QBs, cum, cum, lead
        tbl = ('<div class="qb-scroll"><table class="qb-table"><caption class="sr">Week-by-week UPS points for the four quarterbacks, the pair totals, the cumulative totals and the lead (Cross minus Josh Martel)</caption>'
               '<thead><tr><th scope="col">Week</th>%s</tr></thead><tbody>%s</tbody></table></div>' % (th, "".join(body)))
        cap = ('<p class="caption">UPS fantasy points from MFL&rsquo;s full player-score export, started or not, regular season and playoffs through Week %d. OUT = the quarterback&rsquo;s team played and he has no score; BYE = his team had no game; '
               'a posted 0.0 means he played and scored zero. Points follow each quarterback through fantasy trades. Rechecked after every Elias change; the totals are provisional until Week %d is final.</p>' % (TK.QB_THROUGH, TK.QB_THROUGH))
        ev = self.qb_events(notes, q, nm)
        body_html = self.desk(lines) + vis + ev + tbl + cap
        return self.section("qbbet", "The QB bet", 0, "Side bet &middot; Cross vs. Josh Martel", body_html)

    def chat_channel(self, mid):
        m = next((x for x in self.ctx["d1"]["chat"] if x["message_id"] == mid), None)
        if m:
            return m["channel_id"]
        return ((self.tk_data().get("notes") or {}).get("bet") or {}).get("channel_id", "")

    def qb_events(self, notes, q, nm):
        evs = notes.get("events") or []
        if not evs:
            return ""
        items = []
        for ev in sorted(evs, key=lambda x: (x["week"], x["pid"])):
            if ev["pid"] not in q["players"]:
                continue
            items.append('<li><b>%s</b>, <span class="qb-wk">Week %d</span>: %s <a class="srcl" href="%s" target="_blank" rel="noopener">%s, %s</a></li>' % (
                e(nm(ev["pid"])), ev["week"], e(ev["text"]), e(ev["url"]), e(ev["outlet"]), e(ev["date"])))
        start = int((((notes.get("bet") or {}).get("terms") or {}).get("ts")) or 0)
        for p, mv in sorted((q.get("moves") or {}).items(), key=lambda kv: kv[0]):
            for m in mv:
                if m["from"] in self.owner and m["to"] in self.owner and m["timestamp"] >= start:
                    d = datetime.fromtimestamp(m["timestamp"], I.ET)
                    items.append('<li><b>%s</b>, fantasy trade on %s: %s to %s. The points still count for the same bet side.</li>' % (
                        e(nm(p)), d.strftime("%B %-d"), self.sn(m["from"]), self.sn(m["to"])))
        return '<ul class="qb-events">%s</ul><p class="caption">Status checked %s from each team&rsquo;s own page or an AP report; no return date is given unless the team gave one.</p>' % ("".join(items), e(datetime.strptime(notes.get("checkedOn", "2000-01-01"), "%Y-%m-%d").strftime("%B %-d")))

    def qb_lead_story(self, table, q, nm, last, src):
        """How the lead changed, not a row of numbers: who led first, when the lead flipped and why, and the two weeks that moved it most.
        Every figure is the table's own claim (same keys), so the sentence and the table cannot disagree."""
        done = [r for r in table if r["state"] == "done"]
        if len(done) < 2:
            return []
        sides = q["sides"]
        who = {"cross": "Cross", "josh": "Josh Martel"}

        def state(p, r):
            k = r["pids"][p][0]
            return {"played": "scored", "bye": "was on a bye", "missed": "was out", "pending": "has not played"}[k]

        def why(w, s):
            """the other side's quarterbacks that week, in words"""
            r = done[w - 1]
            o = "josh" if s == "cross" else "cross"
            bits = [e(last(p)) + " " + {"bye": "on a bye", "missed": "out", "pending": "not yet played"}[r["pids"][p][0]] for p in sides[o] if r["pids"][p][0] != "played"]
            return jn(bits)

        def pair(s, w):
            return self.L.put("tk:qb:pair:%s:%d" % (s, w), done[w - 1]["pair"][s], src, "%.1f" % done[w - 1]["pair"][s])
        out = []
        leads = [r["lead"] for r in done]
        flips = [r["week"] for i, r in enumerate(done) if i and (leads[i] > 0) != (leads[i - 1] > 0) and leads[i] != 0]
        first = "cross" if leads[0] > 0 else "josh"
        if flips:
            w = flips[0]
            new = "cross" if leads[w - 1] > 0 else "josh"
            wy = why(w, new)
            out.append("%s led after Week 1. %s took the lead in Week %d%s." % (who[first], who[new], w, (", with %s" % wy) if wy else ""))
        swings = sorted([(abs(done[i]["lead"] - (done[i - 1]["lead"] if i else 0.0)), done[i]["week"], done[i]["lead"] - (done[i - 1]["lead"] if i else 0.0)) for i in range(len(done))], reverse=True)[:2]
        for _, w, d in sorted(swings, key=lambda t: t[1]):
            if flips and w == flips[0]:
                continue
            s = "cross" if d > 0 else "josh"
            o = "josh" if s == "cross" else "cross"
            ch = self.L.put("tk:qb:swing:%d" % w, round(abs(d), 1), src, "%.1f" % abs(d))
            wy = why(w, s)
            out.append("Week %d moved the lead by %s toward %s: %s&rsquo;s pair scored %s to %s&rsquo;s %s%s." % (w, ch, who[s], who[s], pair(s, w), who[o], pair(o, w), (", with %s" % wy) if wy else ""))
        return [("Rich", " ".join(out))] if out else []

    # ------------------------------------------------------------------------------------------- Hall of Shame
    def seg_hall(self):
        if "trackers" not in self.ctx:
            return ""
        T = self.tk_data()
        reg, weeks = T.get("regWeeks"), T.get("allWeeks")
        st = self.ctx["mfl"]["standings"]
        if not reg or not weeks:
            return self.section("hall", "Hall of Shame watch", 0, "Hall of Shame watch", self.tk_missing("tracker:hall", "hall", "The Hall of Shame watch"))
        through = int(T.get("through") or self.week)
        try:
            ap = TK.hall_allplay({f: m["allplay"] for f, m in st.items()}, len(st), reg, through, T.get("playoffScores"))
        except ValueError as exc:
            return self.section("hall", "Hall of Shame watch", 0, "Hall of Shame watch", self.gap("tracker:hall", "hall", "The Hall of Shame watch could not be counted (%s)." % TK.plain(exc)))
        rows = TK.hall_rows(ap, len(st), weeks, through)
        src = "MFL leagueStandings (all_play_wlt; playoff weeks from weeklyResults team scores if MFL stops counting them) + league settings (endWeek)"
        watch = sorted([f for f, r in rows.items() if r["pct"] < 0.300], key=lambda f: (rows[f]["pct"], f))
        if not watch:
            return ""
        r0 = rows[watch[0]]
        games_c = self.L.put("tk:hos:games", r0["games"], src, str(r0["games"]))
        safe_c = self.L.put("tk:hos:safe", r0["safe"], src, str(r0["safe"]))
        left_c = self.L.put("tk:hos:left", r0["left"], src, str(r0["left"]))
        weeks_c = self.L.put("tk:hos:weeks", weeks, src, str(weeks))
        line_c = self.L.put("tk:hos:line", TK.HALL_LINE, src, ".200")
        lines = [("Stuart", "The Hall of Shame takes any team whose final All-Play percentage, counted through all %s weeks and playoffs included, is below %s. With twelve teams, each team has %s comparisons, so %s wins is the fewest that stays at or above %s with no ties. "
                  "After Week %d, %s comparisons remain for each team." % (weeks_c, line_c, games_c, safe_c, line_c, through, left_c)),
                 ("Rich", "This is All-Play arithmetic, not playoff odds. A tie counts as half a win. The list updates after each completed week from MFL&rsquo;s official standings, so an Elias change that moves a score moves it too; a team is inducted only when Week %d ends below the line." % weeks)]
        scale = max([rows[f]["w"] + rows[f]["left"] for f in watch] + [rows[watch[0]]["safe"]])
        bars = []
        for f in watch:
            r = rows[f]
            w_c = self.L.put("tk:hos:%s:w" % f, r["w"], src, str(r["w"]))
            if r["status"] == "safe":
                state, note, need = "safe", "Safe", ""
            else:
                n_c = self.L.put("tk:hos:%s:need" % f, r["need"], src, str(r["need"]))
                state = r["status"]
                note = {"candidate": "Candidate", "locked": "Cannot escape", "inducted": "Inducted"}[r["status"]]
                need = "needs %s more in the next %s comparisons" % (n_c, left_c)
            rec = self.L.put("tk:hos:%s:rec" % f, "%d-%d-%d" % (r["w"], r["l"], r["t"]), src, "%d-%d-%d" % (r["w"], r["l"], r["t"]))
            wp = 100.0 * r["w"] / scale
            needp = 100.0 * min(r["need"], r["left"]) / scale
            leftp = 100.0 * max(0, r["left"] - r["need"]) / scale
            linep = 100.0 * r["safe"] / scale
            bars.append('<div class="hos-row hos-%s"><div class="hos-head"><span class="hos-name">%s</span><span class="hos-state">%s</span></div>'
                        '<div class="hos-track" role="img" aria-label="%s has %d All-Play wins; %d are needed to stay out of the Hall of Shame and %d comparisons remain">'
                        '<span class="hos-w" style="width:%.2f%%"></span><span class="hos-need" style="left:%.2f%%;width:%.2f%%"></span><span class="hos-left" style="left:%.2f%%;width:%.2f%%"></span>'
                        '<span class="hos-line" style="left:%.2f%%"></span></div>'
                        '<div class="hos-nums"><span>%s wins</span><span>%s</span><span>record %s</span></div></div>' % (
                            state, e(self.owner[f]), note, e(self.owner[f]), r["w"], r["safe"], r["left"], wp, wp, needp, wp + needp, leftp, linep,
                            w_c, need or "no more wins needed", rec))
        legend = ('<p class="caption">Bar = current All-Play wins (solid), wins still needed to reach the safe line (striped), then the remaining comparisons; the vertical line is the safe line. '
                  'Teams below .300 All-Play are listed. Candidate = can still finish below the line; inducted = the season ended below it. Source: MFL standings and league settings; any playoff week MFL does not count is counted from that week&rsquo;s official team scores.</p>')
        return self.section("hall", "Hall of Shame watch", 0, "Hall of Shame watch", self.desk(lines) + '<div class="hos">%s</div>' % "".join(bars) + legend + self.hall_history_block(T))

    def hall_history_block(self, T):
        raw = T.get("hallHistory")
        if raw is None:
            return self.gap("tracker:hallhist", "hall", "The previous Hall of Shame seasons could not be read from src_standings.allplay_historical_*.")
        hist = TK.hall_history(raw)
        if not hist:
            return ""
        fn = (T.get("notes") or {}).get("hallHistoryNotes") or {}               # owner-of-record footnotes (league_context D.2)
        src = "D1 src_standings.allplay_historical_* (league-canonical: regular season through 2016, full season from 2017) + src_franchises"
        body = []
        for h in hist:
            rec = self.L.put("tk:hh:%d:%s:rec" % (h["season"], h["owner"]), "%d-%d-%d" % (h["w"], h["l"], h["t"]), src, "%d&ndash;%d" % (h["w"], h["l"]) if not h["t"] else "%d&ndash;%d&ndash;%d" % (h["w"], h["l"], h["t"]))
            pct = self.L.put("tk:hh:%d:%s:pct" % (h["season"], h["owner"]), h["pct"], src, ".%03d" % round(h["pct"] * 1000))
            wk = self.L.put("tk:hh:%d:%s:weeks" % (h["season"], h["owner"]), h["weeks"], src, str(h["weeks"]))
            body.append(self.row([str(h["season"]), e(h["owner"]) + ("&dagger;" if str(h["season"]) in fn else ""), rec, pct, wk]))
        tbl = self.table(["Season", "Owner of record", "All-Play", "Percentage", "Weeks counted"], body)
        owners = {}
        for h in hist:
            owners[h["owner"]] = owners.get(h["owner"], 0) + 1
        twice = [o for o, n in owners.items() if n == 2]
        low = min(hist, key=lambda h: h["pct"])
        bits = []
        if twice:
            bits.append("%s appears twice" % jn(e(o) for o in twice))
        lowpct = self.L.put("tk:hh:%d:%s:pct" % (low["season"], low["owner"]), low["pct"], src, ".%03d" % round(low["pct"] * 1000))
        if str(low["season"]) in fn:                                             # the owner of record did not manage the whole season: name the franchise's year, not the person
            bits.append("The %d franchise&rsquo;s %s is the lowest of these %s" % (low["season"], lowpct, self.word(len(hist))))
        else:
            bits.append("%s&rsquo;s %s in %d is the lowest of these %s" % (e(low["owner"]), lowpct, low["season"], self.word(len(hist))))
        cap = ('<p class="caption">Previous seasons below .200, from the league&rsquo;s canonical All-Play record: the regular season through 2016 and the full season from 2017, so each season counts the weeks the league actually counted. '
               'Weeks counted = comparisons divided by eleven. Owner of record = the owner who built the auction roster (league rule). Source: src_standings.allplay_historical_*.</p>'
               + "".join('<p class="caption">&dagger; %s: %s</p>' % (e(y), e(txt)) for y, txt in sorted(fn.items())))
        return '<h3 class="hos-sub">Previous Hall of Shame seasons</h3>' + self.desk([("Stuart", "%s." % ". ".join(bits))]) + tbl + cap
