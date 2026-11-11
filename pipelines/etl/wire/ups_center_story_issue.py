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
import json
import os
from datetime import datetime
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_issue as I  # noqa: E402
import ups_center_story_data as SD  # noqa: E402
import ups_center_stories as STORIES  # noqa: E402
import ups_center_story_triggers as TRG  # noqa: E402
import ups_center_prob as PROB  # noqa: E402
import chat_exclusions  # noqa: E402

e = html.escape
WORDS = {0: "none", 1: "one", 2: "two", 3: "three", 4: "four"}
SEGMENTS = ["bigstory", "divweek", "elias", "odds", "plays", "season"]


def trade_list(assets):
    return [x for x in assets if x["kind"] in ("player", "pick", "bb")]


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
            div_cells, div_lr, title_cells, title_lr = self.odds_cells(teams, src)
            self._odds = (sim, src, (div_cells, div_lr), (title_cells, title_lr))
        return self._odds

    @staticmethod
    def display(vals):
        import season_sim
        return season_sim.display_percentages(vals)

    def po(self, f):
        sim, src, _, _ = self.odds_text()
        return e(self.prob_claim("odds:po:" + f, sim["teams"][f]["po"], "po", f, src))

    def bye(self, f):
        sim, src, _, _ = self.odds_text()
        return e(self.prob_claim("odds:bye:" + f, sim["teams"][f]["bye"], "bye", f, src))

    def dv(self, f):
        sim, src, (cells, lr), _ = self.odds_text()
        return e(self.L.put("odds:div:" + f, cells[f][1], src + ", largest-remainder by division", cells[f][0], raw=round(100 * sim["teams"][f]["div"], 4), lr=lr[f]))

    def ti(self, f):
        sim, src, _, (cells, lr) = self.odds_text()
        return e(self.L.put("odds:title:" + f, cells[f][1], src + ", largest-remainder", cells[f][0], raw=round(100 * sim["teams"][f]["title"], 4), lr=lr[f]))

    def div_names(self):
        """{division id: name}: the name the week's games use for an all-division game; else 'Division <id>'."""
        if not hasattr(self, "_divn"):
            names = {}
            for pot in self.pack.get("pots", []):
                if len(pot.get("divisions") or []) == 1:
                    ids = {self.ctx["d1"]["franchises"][self.fid[g[k]]]["division"] for g in pot["games"] for k in ("winner", "loser")}
                    if len(ids) == 1:
                        names[ids.pop()] = self.pretty(pot["divisions"][0])
            if len(names) < len({r["division"] for r in self.ctx["d1"]["franchises"].values()}):
                # a crossover week names no single division: read the names from the season's other recap packs (triangle weeks 1, 4, 8, ...)
                import glob
                root = os.path.join(HERE, "..", "..", "..", "site", "wire", "packs", str(self.season))
                for path in sorted(glob.glob(os.path.join(root, "%d-wk*-recap.pack.json" % self.season))):
                    try:
                        pk = json.load(open(path))
                    except (OSError, ValueError):
                        continue
                    for pot in pk.get("pots", []):
                        if len(pot.get("divisions") or []) == 1:
                            ids = {self.ctx["d1"]["franchises"][self.fid[g[k]]]["division"] for g in pot["games"] for k in ("winner", "loser")
                                   if g[k] in self.fid}
                            if len(ids) == 1:
                                names.setdefault(ids.pop(), self.pretty(pot["divisions"][0]))
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

    # ------------------------------------------------------------ shared pieces
    ORDW = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", 6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth",
            10: "tenth", 11: "eleventh", 12: "twelfth"}

    def heat(self):
        if not hasattr(self, "_heat"):
            self._heat = STORIES.heat(self.ctx)
        return self._heat

    def heat_src(self):
        return "D1 src_franchise_weekly_score + src_schedule, weeks 1-%d" % self.week

    def ordw(self, f, k):
        """Print the scoring rank as a word ('eighth'); register the claim as the tables print it ('8th')."""
        H = self.heat()
        self.L.put("heat:%s:%s" % (k, f), H[f][k], self.heat_src(), self._ord(H[f][k]))
        return self.ORDW.get(H[f][k], self._ord(H[f][k]))

    def word(self, n):
        return {0: "none", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine",
                10: "ten", 11: "eleven", 12: "twelve"}.get(n, str(n))

    def sn(self, f):
        """Surname when it is unique in the league (the hand edit's second mention), else the full name."""
        last = self.owner[f].split(" ")[-1]
        return e(last) if sum(1 for o in self.owner.values() if o.split(" ")[-1] == last) == 1 else e(self.owner[f])

    POS = {"QB": "quarterback", "RB": "running back", "WR": "receiver", "TE": "tight end", "DL": "lineman", "LB": "linebacker", "DB": "defensive back"}

    def posword(self, r, plural=False):
        m = re.search(r"\((\w+),", r[0])
        w = self.POS.get(m.group(1)) if m else None
        return (w + ("s" if plural else "")) if w else None

    def box_prose(self, b):
        """'38-of-48 for 462, 5 TD, 3 INT; 3 carries for 10 and 1 TD' -> '38-of-48 for 462 yards, five touchdowns, three interceptions and a
        rushing score'. Falls back to the raw line. Every digit printed is in the registered box line."""
        b = I.tidy_box(b)
        out = []
        for part in [x.strip() for x in b.split(";")]:
            m = re.match(r"^(\d+-of-\d+) for (\d+)((?:, \d+ (?:TD|INT))*)$", part)
            if m:
                out.append("%s for %s yards" % (m.group(1), m.group(2)))
                for n_, k in re.findall(r"(\d+) (TD|INT)", m.group(3)):
                    out.append("%s %s" % (self.word(int(n_)), ("touchdown" if k == "TD" else "interception") + ("" if int(n_) == 1 else "s")))
                continue
            m = re.match(r"^\d+ carr(?:y|ies) for \d+(?: and (\d+) TD)?$", part)
            if m:
                out.append("a rushing score" if m.group(1) == "1" else ("%s rushing scores" % self.word(int(m.group(1)))) if m.group(1) else "")
                continue
            return b
        out = [x for x in out if x]
        return (", ".join(out[:-1]) + " and " + out[-1]) if len(out) > 1 else (out[0] if out else b)

    def week_rank(self, f):
        s = self.ctx["mfl"]["scores"]
        return 1 + sum(1 for g in s if s[g] > s[f])

    def week_rank_c(self, f):
        k = self.week_rank(f)
        self.L.put("wkrank:" + f, k, "MFL weeklyResults W%d" % self.week, self._ord(k))
        return self.ORDW.get(k, self._ord(k))

    def div_rec(self, f):
        """Head-to-head record against the team's own division this season (D1 src_schedule), as 'w-l'."""
        div = self.ctx["d1"]["franchises"]
        w = l = 0
        for g in self.ctx["d1"]["regGames"]:
            if g["franchise_id"] == f and div[g["opponent_franchise_id"]]["division"] == div[f]["division"]:
                w += float(g["team_score"]) > float(g["opponent_score"])
                l += float(g["team_score"]) < float(g["opponent_score"])
        return w, l

    def divrec_c(self, f):
        w, l = self.div_rec(f)
        return self.L.put("divrec:" + f, "%d-%d" % (w, l), "D1 src_schedule, same-division games", I.wl(w, l))

    def posts(self, owner):
        return sum(1 for m in self.ctx["d1"]["chat"] if m["owner_name"] == owner)

    def posts_c(self, owner):
        return self.L.put("posts:" + owner, self.posts(owner), "D1 ups_discord_messages window")

    def proven_rows(self):
        if not hasattr(self, "_proven"):
            self._bbgaps, self._bblists, self._bbcap, self._proven = self.bb_parts()
        return self._proven

    def rows_for(self, f, kind):
        """Proven bargain / bust rows of one team, biggest first (kind: 'bargain' | 'bust')."""
        out = []
        for tid in ("t.bb.off.%s" % kind, "t.bb.idp.%s" % kind):
            out += [r for r in self.proven_rows().get(tid, []) if self.fid[r[1]] == f]
        return sorted(out, key=lambda r: -abs(float(r[4].replace("+", "").replace("-", "").replace("−", ""))))

    @staticmethod
    def pname(r):
        return re.sub(r"\s*\(.*$", "", r[0])

    # ------------------------------------------------------------ 1. the Big Story
    def story_allplay_start(self, story, evidence=(), headline=None):
        """The all-time-start story (Week 8's Bear Dunn). When this trigger is in a merged group it supplies the body and the
        table (it carries the history); the group's other triggers become evidence sentences. Returns (subtitle, html)."""
        f, best = story["fid"], story["direction"] == "best"
        self._big = f
        me, n, ahead = self.owner[f], story["pool"], story["ahead"]
        src = self.ctx["archive"]["source"]
        s = self.ctx["mfl"]["scores"]
        arc = self.ctx["archive"]
        first, last = story["seasons"][0], story["seasons"][-1]
        better, worse = ("better", "best") if best else ("worse", "worst")
        n_c = self.L.put("arch:n", n, src)
        ahead_c = self.L.put("arch:ahead:" + f, ahead, src)
        aw, al = (int(x) for x in self.ctx["mfl"]["standings"][f]["allplay"].split("-")[:2])
        mypct = aw / float(aw + al)
        pct_c = self.L.put("arch:pct:cur:" + f, round(mypct, 3), src, ("%.3f" % mypct).lstrip("0"))

        def ref(x):                                           # an archived team-season: name, record, pct
            k = "%d:%s" % (x["season"], x["fid"])
            ap = self.L.put("arch:ap:" + k, "%d-%d" % (x["w"], x["l"]), src, I.wl(x["w"], x["l"]))
            pc = self.L.put("arch:pct:" + k, round(x["pct"], 3), src, ("%.3f" % x["pct"]).lstrip("0"))
            return ap, pc

        top = s[f] == max(s.values())
        note = (", the best score of the week" if top else "") + (", and beat all eleven teams in All-Play"
                                                                 if top and self.week_allplay()[f][1] == 0 else "")
        games = [g for g in self.ctx["mfl"]["games"] if f in (g["a"], g["b"])]
        won = [(g["b"] if g["a"] == f else g["a"]) for g in games if (g["as"] > g["bs"]) == (g["a"] == f)]
        sweep = ""
        if len(games) >= 2 and len(won) == len(games):
            won = sorted(won, key=lambda o: -(s[f] - s[o]))
            sweep = " %s swept %s games: %s." % (e(me), "both" if len(games) == 2 else "all %d" % len(games),
                                                 join("%s by %s" % (e(self.owner[o]), self.margin(f, o)) for o in won))
        lines = [("Stuart", "%s scored %s in Week %d%s.%s %s is %s overall and %s in All-Play." % (
            e(me), self.score(f), self.week, note, sweep, e(me), self.rec_c(f), self.ap_c(f)))]
        P = SD.pool(arc, self.week)
        ahead_rows = sorted([x for x in P if (x["pct"] > mypct + 1e-12 if best else x["pct"] < mypct - 1e-12)],
                            key=lambda x: (-x["pct"] if best else x["pct"], x["season"]))
        if ahead == 0:
            lead = "No earlier team had a %s All-Play record at this point." % better
        else:
            parts = []
            for x in ahead_rows[:4]:
                parts.append("%s&rsquo;s %d team, which was %s" % (e(x["owner"] or "an unnamed owner"), x["season"], ref(x)[0]))
            lead = "%s had a %s All-Play record at this point: %s." % (
                ("Exactly one" if ahead == 1 else self.word(ahead).capitalize()), better, join(parts))
        lines.append(("Rich", "Here is what %s means. Since %d, %s teams have reached Week %d with a full record in the league archive. %s" % (
            self.ap_c(f), first, n_c, self.week, lead)))
        behind = [x for x in story["table"] if not x.get("current")]
        txt = "That is %s for %s." % (pct_c, e(me))
        if ahead_rows:
            txt += " %s&rsquo;s %d start was %s." % (e(ahead_rows[0]["owner"] or "An unnamed owner"), ahead_rows[0]["season"], ref(ahead_rows[0])[1])
        nxt = behind[ahead:ahead + 3]
        if nxt:
            seen, items = [], []
            for x in nxt:
                ap = ref(x)[0]
                if seen and seen[-1] == x["owner"]:
                    items.append("the %d team at %s" % (x["season"], ap))
                elif x["owner"] in seen:
                    items.append("%s again in %d at %s" % (e(x["owner"]), x["season"], ap))
                else:
                    items.append("%s&rsquo;s %d team at %s" % (e(x["owner"] or "an unnamed owner"), x["season"], ap))
                seen.append(x["owner"])
            body = (items[0] + (" and " + items[1] if len(items) > 1 else "")) + (", then " + items[2] if len(items) > 2 else "")
            txt += " After %s, the next %s starts are %s." % (e(me), "best" if best else "worst", body)
        lines.append(("Stuart", txt))
        # the previous best start: how it ended (Week 8: 2018's 84-4 start, 25-1, 155-21, lost the final)
        x = ahead_rows[0] if ahead_rows else None
        if x and x["final"]:
            k = "%d:%s" % (x["season"], x["fid"])
            full = arc.get("full", {}).get(k)
            rec = ap_full = ""
            if full:
                rec = self.L.put("arch:fullrec:" + k, "%d-%d" % tuple(full["rec"]), src, I.wl(*full["rec"]))
                ap_full = self.L.put("arch:fullap:" + k, "%d-%d" % tuple(full["ap"]), src, I.wl(*full["ap"]))
                bestfull = SD.full_season_best(self.ctx) == k
                self.L.put("arch:fullbest:" + k, bestfull, src, "")
            end = {1: "went on to win the title", 2: "still lost the final", 3: "still finished third"}.get(
                x["final"]) or "still finished " + self.ORDW.get(x["final"], self._ord(x["final"]))
            self.L.put("arch:final:" + k, x["final"], src, finish_label(x["final"]))
            t = "And %d is the part worth sitting with. That team " % x["season"]
            t += ("finished %s with a %s All-Play record%s, " % (rec, ap_full, ", the best full season in the archive" if bestfull else "")) if full else ""
            t += "%s%s. %s" % ("and " if full and not end.startswith("and") else "", end,
                               "A great start is not a title." if x["final"] != 1 else "A great start can end in a title.")
            if not full:
                t = "And %d is the part worth sitting with. That team %s. %s" % (x["season"], end, "A great start is not a title." if x["final"] != 1 else "")
            lines.append(("Rich", t))
        # the owner's own history, then the forecast
        mine = SD.own_starts(self.ctx, me, self.week)
        low = [y for y in mine if y["pct"] <= 0.30][:2]
        tail = []
        if best and low:
            low = sorted(low, key=lambda y: y["season"])
            tail.append("%s knows both ends of this. In %d the start was %s in All-Play at this point%s." % (
                e(me), low[0]["season"], ref(low[0])[0], (", and in %d %s" % (low[1]["season"], ref(low[1])[0])) if len(low) > 1 else ""))
        elif mine and len(mine) >= 3:
            hb = max(mine, key=lambda y: (y["pct"], -y["season"]))
            hw = min(mine, key=lambda y: (y["pct"], y["season"]))
            tail.append("In the archive, %s&rsquo;s best start was %s in %d and the worst was %s in %d." % (
                e(me), ref(hb)[0], hb["season"], ref(hw)[0], hw["season"]))
        if self.odds_fresh() and best:
            sim = self.odds_text()[0]
            others = sorted((g for g in sim["teams"] if g != f), key=lambda g: (-sim["teams"][g]["title"], g))
            tail.append("%s with a %s chance at the first-round bye and a %s chance at the title in the forecast. The next best title odds belong to %s at %s." % (
                ("Now it is %s" % self.ap_c(f)) if (best and low) else "The forecast gives %s" % e(me), self.bye(f), self.ti(f),
                e(self.owner[others[0]]), self.ti(others[0])))
            if not (best and low):
                tail[-1] = "The forecast gives %s a %s chance at the first-round bye and a %s chance at the title; the next best title odds belong to %s at %s." % (
                    e(me), self.bye(f), self.ti(f), e(self.owner[others[0]]), self.ti(others[0]))
        if tail:
            lines.append(("Stuart", " ".join(tail)))
        for ev in evidence:
            if ev["trigger"] != "allplay_start":
                ln = self.evidence_line(ev)
                if ln:
                    lines.insert(1, ln)
        rows = []
        for x in story["table"]:
            if x.get("current"):
                rows.append(self.row(["2026 &middot; %s" % e(me), self.ap_c(f), pct_c, "In progress"], bold=True))
            else:
                ap, pc = ref(x)
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
        return sub, self.desk(lines) + self.table([head, "Through Week %d" % self.week, "Pct", "How the season ended"], rows) + cap

    # ------------------------------------------------------------ 1. the Big Story: the phase-aware picker and its story builders
    def seg_big(self):
        pk = TRG.pick(self.ctx, self.ctx.get("priorLeads"))
        self._pick = pk
        lead = pk["lead"]
        if lead:
            self._big = lead["fid"]
            group = [lead["headline"]] + lead["evidence"]
            ap = next((x for x in group if x["trigger"] == "allplay_start"), None)
            if ap:                                         # the history story carries the body and the table
                sub, body = self.story_allplay_start(ap["data"]["story"], evidence=[x for x in group if x is not ap])
            else:
                sub, body = getattr(self, "story_" + lead["headline"]["trigger"])(lead["headline"], lead["evidence"])
        else:
            sub, body = getattr(self, "story_fallback_" + pk["fallback"])()
        # the other all-time story (Week 9: Eric Martel's score leads, Bear Dunn's start still gets Week 8's treatment and top-5 table)
        other = next((x for x in pk["support"] if x["trigger"] == "allplay_start" and (not lead or x["fid"] != lead["fid"])), None)
        block = ""
        if other:
            same = [x for x in pk["support"] if x["fid"] == other["fid"] and x is not other]
            sub2, body2 = self.story_allplay_start(other["data"]["story"], evidence=same)
            self._big = lead["fid"] if lead else other["fid"]
            block = self.desk([("Rich", "<b>The other story this week:</b> %s.</b>" % sub2)]).replace("</b>.</b>", "</b>") + body2
        # a big executed trade always appears: as the lead, as evidence, or as its own support story (Keith 2026-11-11)
        trade = None
        pool = ([lead["headline"]] + lead["evidence"] if lead else []) + pk["support"]
        trade = next((x for x in pool if x["trigger"] == "big_trade"), None)
        if not trade and (self.ctx.get("tradeInfo") or []):
            cand = TRG.REGISTRY[[t["id"] for t in TRG.REGISTRY].index("big_trade")]["fn"](TRG.Env(self.ctx))
            trade = ({"trigger": "big_trade", "kind": "stakes", "fid": cand[0]["fid"], "s": cand[0]["s"], "adj": cand[0]["s"], "data": cand[0]["data"]} if cand else None)
        tblock = ""
        if trade and not (lead and lead["headline"] is trade):
            sub3, body3 = self.story_big_trade(trade)
            tblock = self.desk([("Rich", "<b>Also this week, a big trade:</b> %s.</b>" % sub3)]).replace("</b>.</b>", "</b>") + body3
        sup = block + tblock + self.support_lines([x for x in pk["support"] if x is not other and x is not trade and x["trigger"] != "big_trade"
                                                   and not (other and x["fid"] == other["fid"] and x["trigger"] == "streak")])
        h = lead["headline"] if lead else None
        self.big_pick = {"phase": pk["phase"], "fid": lead["fid"] if lead else None, "trigger": h["trigger"] if h else "fallback_" + pk["fallback"],
                         "s": round(h["s"], 4) if h else None, "evidence": [x["trigger"] for x in (lead["evidence"] if lead else [])],
                         "support": [{"fid": x["fid"], "trigger": x["trigger"], "s": round(x["adj"], 3)} for x in pk["support"]]}
        import re as _re
        first = _re.sub(r"<[^>]+>", "", (_re.search(r'<div class="lt \w+"><div class="who">\w+</div><p>(.*?)</p>', body, _re.S) or [None, ""])[1])
        first = html.unescape(first)
        sent = _re.split(r"(?<=[.!?])\s", first)[0] if first else ""
        self.dek = ("%s Week %d recap, built from the league&rsquo;s own data; an editor has not reviewed it." % (e(sent), self.week)) if sent else None
        return self.section("bigstory", "The Big Story", 1, "The Big Story <small>&mdash; %s</small>" % sub, body + sup)

    def support_lines(self, support):
        lines = [self.evidence_line(x) for x in support if x["trigger"] != "elias_flip"]
        lines = [x for x in lines if x]
        return self.desk([(("Rich" if i % 2 == 0 else "Stuart"), t) for i, (_, t) in enumerate(lines)]) if lines else ""

    def evidence_line(self, ev):
        """One sentence about a fired trigger that is not the headline: ('Stuart', text) or None."""
        f, d, t = ev["fid"], ev["data"], ev["trigger"]
        me = e(self.owner[f])
        src = "D1 archive + season scores (ups_center_story_triggers)"
        if t == "week_score":
            r = d["ranks"]
            sr = "trig:recn"
            return ("Stuart", "%s scored %s in Week %d: the %s-highest single-week score and the %s-best share of the league average among the %s team-weeks since 2011 (playoffs and this season included)." % (
                me, self.score(f), self.week, self.L.put("trig:recraw:" + f, r["raw_rank"], src, self._ord(r["raw_rank"])),
                self.L.put("trig:recshare:" + f, r["share_rank"], src, self._ord(r["share_rank"])), self.L.put(sr, r["n"], src, "{:,}".format(r["n"]))))
        if t == "streak":
            k = d["kind"]
            L = self.L.put("trig:streak:%s:%s" % (k, f), d["L"], src)
            reached = d["reached"]
            kk = self.L.put("trig:streakk:%s:%s" % (k, f), len(reached), src)
            names = []
            for i, (season, fid, longest) in enumerate(reached[:3]):
                owner = (self.ctx["archive"].get("owners") or {}).get("%d:%s" % (season, fid)) or "an unnamed owner"
                self.L.put("trig:streaktop:%s:%s:%d" % (k, f, i), {"owner": owner, "season": season, "L": longest}, src, str(longest))
                names.append("%s in %d (%s weeks)" % (e(owner), season, longest))
            what = ("beaten at least nine of the eleven other teams in each of the last %s weeks" if k == "dom" else
                    "been outscored by at least nine of the eleven other teams in each of the last %s weeks") % L
            if not reached:
                tail = "No regular-season team since 2011 has had a streak that long."
            elif len(reached) <= 3:
                tail = "Only %s regular-season %s since 2011 %s had a streak that long: %s." % (
                    self.word(len(reached)), "team" if len(reached) == 1 else "teams", "has" if len(reached) == 1 else "have", join(names))
            else:
                tail = "%s regular-season teams since 2011 have had a streak that long, the longest %s." % (kk, names[0])
            return ("Rich", "%s has %s. %s" % (me, what, tail))
        if t == "allplay_start":
            st = d["story"]
            ah = self.L.put("arch:ahead:" + f, st["ahead"], self.ctx["archive"]["source"], str(st["ahead"]))
            return ("Stuart", "%s is %s in All-Play, a %s start than all but %s earlier %s in the league archive." % (
                me, self.ap_c(f), "better" if st["direction"] == "best" else "worse", self.word(st["ahead"]) if st["ahead"] <= 12 else ah,
                "team" if st["ahead"] == 1 else "teams")) if st["ahead"] > 0 else ("Stuart", "%s is %s in All-Play, the %s start in the league archive." % (
                    me, self.ap_c(f), "best" if st["direction"] == "best" else "worst"))
        if t == "luck_gap":
            H = self.heat()
            if not H:
                return None
            return ("Rich", "%s is %s wins %s what the All-Play rate predicts." % (me, self.L.put("heat:luck:" + f, H[f]["luck"], self.heat_src(), ("%+.1f" % H[f]["luck"]).replace("-", "&minus;")).lstrip("+&minus;"),
                                                                                    "above" if H[f]["luck"] > 0 else "below"))
        if t == "odds_swing" and self.odds_fresh():
            return ("Stuart", "%s&rsquo;s playoff odds moved from %s to %s since %s." % (me, self.odds_base(f, d), self.po(f), d["basis"]))
        if t == "division_decider" and self.odds_fresh():
            r = d["runner"]
            return ("Rich", "In %s, %s is %s to win the division and %s is %s." % (e(self.div_of(f)), me, self.dv(f), e(self.owner[r]), self.dv(r)))
        if t == "bubble" and self.odds_fresh():
            return ("Rich", "The last playoff spot is a coin flip: %s is %s and %s is %s to make the playoffs." % (
                e(self.owner[d["sixth"]]), self.po(d["sixth"]), e(self.owner[d["seventh"]]), self.po(d["seventh"])))
        if t == "elias_flip":
            return ("Stuart", "An Elias correction %s, covered below." % ("flipped a result" if d.get("flipped") else "moved an All-Play game"))
        return None

    def odds_base(self, f, d):
        sim, src, _, _ = self.odds_text()
        prev = (self.ctx.get("forecast") or {}).get("prevSim") or {}
        if d["basis"] == "last week" and prev.get("teams", {}).get(f):
            v = prev["teams"][f]["po"]
            return e(self.L.put("odds:prevpo:" + f, PROB.value(v), "season_sim live wk%02d" % (self.week - 1), PROB.text(v), raw=round(100 * v, 4)))
        v = sim["teams"][f].get("prePo")
        return e(self.L.put("odds:prepo:" + f, PROB.value(v), "season_sim preseason forecast (%s)" % src, PROB.text(v), raw=round(100 * v, 4)))

    def small_sample(self):
        return "Through %s week%s that is a small sample, so read it as a first look, not a verdict." % (self.word(self.week), "" if self.week == 1 else "s") if self.week <= 4 else ""

    def rec_entry(self, x, i, measure):
        """Register one ranked team-week (a row of the record tables): its owner, season, week, score and share. Returns (score text, pct text)."""
        src = "league archive weekly scores (regular season) + this season's weeks (ups_center_story_triggers.week_pool)"
        v = {"owner": x["owner"], "season": x["season"], "week": x["week"], "score": round(x["score"], 1), "pct": round(100 * x["ratio"], 1)}
        self.L.put("trig:%stop:%d" % (measure, i), v, src, "%.1f %.1f" % (x["score"], 100 * x["ratio"]))
        return "%.1f" % x["score"], "%.1f%%" % (100 * x["ratio"])

    def rec_ranks(self, d):
        """The week-score ranking sentences and tables (raw record and share of the league average, both). Returns (lines, tables html)."""
        r = d["ranks"]
        me = r["me"]
        f = me["fid"]
        src = "league archive weekly scores (regular season) + this season's weeks (ups_center_story_triggers.week_pool)"
        n_c = self.L.put("trig:recn", r["n"], src, "{:,}".format(r["n"]))
        raw_c = self.L.put("trig:recraw:" + f, r["raw_rank"], src, self._ord(r["raw_rank"]))
        sh_c = self.L.put("trig:recshare:" + f, r["share_rank"], src, self._ord(r["share_rank"]))
        pct = self.L.put("trig:ratio:" + f, round(100 * me["ratio"], 1), src, "%.1f" % (100 * me["ratio"]))
        avg = self.L.put("trig:avg:" + f, round(me["score"] / me["ratio"], 1), src, "%.1f" % (me["score"] / me["ratio"]))
        ordw = lambda k: "highest" if k == 1 else ("%s-highest" % self.ORDW.get(k, self._ord(k)))
        ordb = lambda k: "best" if k == 1 else ("%s-best" % self.ORDW.get(k, self._ord(k)))
        owner = e(me["owner"])
        t1 = "%s scored %s in Week %d, the %s single-week score in league history (every week with all twelve teams scored, %d&ndash;%d so far, playoffs included: %s team-weeks)." % (
            owner, self.score(f), self.week, ordw(r["raw_rank"]), r["first_season"], self.season, n_c)
        prev = [x for x in r["raw_top"] if not (x["cur"] and x["week"] == self.week and x["fid"] == f)]
        if r["raw_rank"] == 1 and prev:
            pv = r["raw_top"][1]
            sc_, _ = self.rec_entry(pv, 1, "raw")
            t1 += " The previous record was %s by %s in Week %d of %d%s." % (sc_, e(pv["owner"]), pv["week"], pv["season"], ", a playoff week" if pv.get("extra") else "")
        elif r["raw_rank"] > 1:
            ab = r["raw_top"][:r["raw_rank"] - 1]
            t1 += " Ahead of it: %s." % join("%s by %s in Week %d of %d%s" % (self.rec_entry(x, i, "raw")[0], e(x["owner"]), x["week"], x["season"], ", a playoff week" if x.get("extra") else "") for i, x in enumerate(ab))
        lines = [("Stuart", t1)]
        ahead = r["share_top"][:max(0, r["share_rank"] - 1)]
        t2 = "Scoring has risen across the eras, so here is the other measure. %s was %s%% of that week&rsquo;s league average of %s." % (self.score(f), pct, avg)
        if ahead:
            parts = []
            for i, x in enumerate(ahead):
                sc_, p_ = self.rec_entry(x, i, "share")
                parts.append("%s in %d (%s%s%s)" % (e(x["owner"]), x["season"], ("Week %d, a playoff week, " % x["week"]) if x.get("extra") else "", p_,
                                                   ", the best share ever" if i == 0 else ""))
            t2 += " Only %s team-week%s since %d %s posted a bigger share: %s." % (
                self.word(len(ahead)), "" if len(ahead) == 1 else "s", r["first_season"], "has" if len(ahead) == 1 else "have", join(parts))
        else:
            t2 += " No team-week since %d has posted a bigger share: it is the best on record." % r["first_season"]
        lines.append(("Rich", t2))
        npart = len((self.ctx.get("archive") or {}).get("partial") or [])
        part = (" %s week%s with fewer than twelve teams scored %s left out." % (self.L.put("trig:recpartial", npart, src), "" if npart == 1 else "s", "is" if npart == 1 else "are")) if npart else ""
        cap = ('<p class="caption">Every week with all twelve teams scored, %d&ndash;%d so far, playoffs included (%s team-weeks).%s Share = a team&rsquo;s score divided by that '
               'week&rsquo;s league average, so eras can be compared.%s</p>' % (
                   r["first_season"], self.season, n_c, part, (" %s is left out because its archived weekly scores conflict with themselves." % join(sorted(
                       (self.ctx.get("archive") or {}).get("excluded") or {}))) if (self.ctx.get("archive") or {}).get("excluded") else ""))

        def tbl(measure, rows_, head):
            body = []
            for i, x in enumerate(rows_):
                sc_, p_ = self.rec_entry(x, i, measure)
                cur = x["cur"] and x["week"] == self.week and x["fid"] == f
                body.append(self.row(["%s &middot; %s, Week %d%s" % (x["season"], e(x["owner"] or "unnamed"), x["week"], " (playoffs)" if x.get("extra") else ""), sc_, p_], bold=cur))
            return self.table([head, "Score", "Share of average"], body)
        tables = tbl("raw", r["raw_top"], "Highest single-week scores") + tbl("share", r["share_top"], "Highest share of the league average")
        return lines, tables + cap

    def story_week_score(self, head, evidence):
        f, d = head["fid"], head["data"]
        me = e(self.owner[f])
        s = self.ctx["mfl"]["scores"]
        games = [g for g in self.ctx["mfl"]["games"] if f in (g["a"], g["b"])]
        won = sorted([(g["b"] if g["a"] == f else g["a"]) for g in games if (g["as"] > g["bs"]) == (g["a"] == f)], key=lambda o: -(s[f] - s[o]))
        lines, tables = self.rec_ranks(d)
        if won:
            allw = len(won) == len(games)
            lines.append(("Stuart", "%s %s: %s." % (me, ("won both games" if len(games) == 2 else "won all %s games" % self.word(len(games))) if allw and len(games) >= 2 else "won",
                                                    join("%s by %s" % (e(self.owner[o]), self.margin(f, o)) for o in won))))
        for ev in evidence:
            ln = self.evidence_line(ev)
            if ln:
                lines.append(ln)
        ss = self.small_sample()
        if ss:
            lines.append(("Rich", ss))
        r = d["ranks"]
        return ("%s set the league&rsquo;s single-week scoring record" % e(self.owner[f]) if r["raw_rank"] == 1 else "%s had the week" % e(self.owner[f])), self.desk(lines) + tables

    def story_big_trade(self, head, evidence=()):
        """A big executed trade, facts only (MFL's public transaction export): what moved each way, the salary on each side, the contract years
        left, how rare the size is among the league's trades since 2010, and how the playoff / division / title odds moved when the forecast was
        rerun on the post-trade rosters. Never the offer's comment (owners' trade messages are private)."""
        d = head["data"]
        tr = d["trade"]
        a, b = tr["a"], tr["b"]
        src = "MFL public transactions + rosters exports (trade of %s)" % datetime.fromtimestamp(tr["timestamp"], I.ET).strftime("%b %d, %Y")
        when = I.et_clock(tr["timestamp"])
        yr = lambda n: "%s year%s" % (n, "" if str(n) == "1" else "s")

        def desc(x):
            if x["kind"] == "player":
                return "%s (%s)" % (e(x["name"]), e(x.get("pos") or ""))
            if x["kind"] == "pick":
                own = ("%s&rsquo;s " % e(self.owner[x["origin"]])) if x.get("origin") in self.owner else ""
                return "%s%d %s-round pick" % (own, x["year"], self.ORDW.get(x["round"], str(x["round"])))
            return "$%s of blind-bid money" % "{:,.0f}".format(x.get("amount", 0))
        na, nb = len(trade_list(tr["a_gave"])), len(trade_list(tr["b_gave"]))
        n_a = self.L.put("trade:na", na, src)
        n_b = self.L.put("trade:nb", nb, src)
        sal_a = self.L.put("trade:sal:a", tr["a_salary"], src, "${:,.0f}".format(tr["a_salary"]))
        sal_b = self.L.put("trade:sal:b", tr["b_salary"], src, "${:,.0f}".format(tr["b_salary"]))
        lines = [("Stuart", "%s executed a trade between %s and %s. %s sent %s to %s, and %s sent %s to %s." % (
            when, e(self.owner[a]), e(self.owner[b]), e(self.owner[a]), join(desc(x) for x in tr["a_gave"]), e(self.owner[b]),
            e(self.owner[b]), join(desc(x) for x in tr["b_gave"]), e(self.owner[a])))]
        lines.append(("Rich", "That is %s assets going one way and %s the other. The players %s sent carry %s in salary, and the players %s sent carry %s." % (
            n_a, n_b, e(self.owner[a]), sal_a, e(self.owner[b]), sal_b)))
        n = d["assets"]
        rk = self.L.put("trade:rk", d["rank"], "league archive transactions_trades (2010&ndash;2025 trade groups)")
        pool = self.L.put("trade:rn", d["pool"], "league archive transactions_trades (2010&ndash;2025 trade groups)", "{:,}".format(d["pool"]))
        self.L.put("trade:n", n, src)
        lines.append(("Stuart", "Only %s of the %s trades in league history since 2010 moved %s assets or more." % (rk, pool, self.word(n) if n <= 12 else n)))
        if self.odds_fresh() and d["deltas"]:
            sim = self.odds_text()[0]
            pre = (self.ctx.get("forecastPre") or {}).get("teams") or {}
            moves = []
            for f in (a, b):
                parts = []
                for k, lab in (("po", "playoff"), ("div", "division"), ("title", "title")):
                    dv_ = d["deltas"].get(f, {}).get(k, 0.0)
                    if abs(dv_) >= 1.0:
                        before = e(self.L.put("odds:pre:%s:%s" % (k, f), PROB.value(pre[f][k]), "season_sim before the trade (%s)" % (self.ctx.get("forecastPre") or {}).get("generatedAtUtc"),
                                              PROB.text(pre[f][k]), raw=round(100 * pre[f][k], 4)))
                        after = {"po": self.po, "div": self.dv, "title": self.ti}[k](f)
                        moves.append("%s&rsquo;s %s odds went from %s to %s" % (e(self.owner[f]), lab, before, after))
            if moves:
                lines.append(("Rich", "The trade moved the forecast, which was rerun on the post-trade rosters: %s." % join(moves)))
            else:
                lines.append(("Rich", "The forecast, rerun on the post-trade rosters, moved neither team&rsquo;s playoff, division or title odds by a full point."))
        lines += [x for x in (self.evidence_line(ev) for ev in evidence) if x]
        rows = []
        for side, gave, recv in ((a, tr["a_gave"], b), (b, tr["b_gave"], a)):
            for x in gave:
                if x["kind"] == "player":
                    s_ = self.L.put("trade:asset:" + x["id"], x["salary"], src, "${:,.0f}".format(x["salary"]))
                    y_ = self.L.put("trade:yrs:" + x["id"], int(x["years"]), src, str(x["years"])) if x.get("years") else "&mdash;"
                    rows.append(self.row([e(self.owner[recv]), "%s (%s, %s)" % (e(x["name"]), e(x.get("pos") or ""), e(x.get("team") or "")), s_, y_]))
                else:
                    rows.append(self.row([e(self.owner[recv]), desc(x), "&mdash;", "&mdash;"]))
        table = self.table(["Receives", "Player or pick", "Salary", "Years left"], rows)
        cap = ('<p class="caption">Source: MFL&rsquo;s public transaction and roster exports; salary and years left are the players&rsquo; current MFL contracts. '
               'The trade was executed after this issue&rsquo;s build began, so the Playoff Picture below is the forecast rerun on the post-trade rosters.</p>')
        return "%s and %s made a big trade" % (e(self.owner[a]), e(self.owner[b])), self.desk(lines) + table + cap

    def story_streak(self, head, evidence):
        f, d = head["fid"], head["data"]
        me = e(self.owner[f])
        ln = self.evidence_line(head)
        lines = [("Stuart", "%s: %s" % (me, ln[1][len(me) + 1:].strip())), ]
        lines[0] = ("Stuart", ln[1])
        for ev in evidence:
            x = self.evidence_line(ev)
            if x:
                lines.append(x)
        ss = self.small_sample()
        if ss:
            lines.append(("Rich", ss))
        return "%s is on a %s" % (self.owner[f], "dominant run" if d["kind"] == "dom" else "cold run"), self.desk(lines)

    def story_luck_gap(self, head, evidence):
        f = head["fid"]
        lines = [self.evidence_line(head), ("Stuart", "%s is %s overall and %s in All-Play." % (e(self.owner[f]), self.rec_c(f), self.ap_c(f)))]
        lines += [x for x in (self.evidence_line(ev) for ev in evidence) if x]
        return "%s&rsquo;s record is %s the scores" % (self.owner[f], "ahead of" if head["data"]["gap"] > 0 else "behind"), self.desk([x for x in lines if x])

    def story_division_decider(self, head, evidence):
        f, d = head["fid"], head["data"]
        lead, run = d["lead"], d["runner"]
        lines = [("Stuart", "%s leads %s at %s overall, with %s at %s. The forecast gives %s a %s chance to win the division and %s %s." % (
            e(self.owner[lead]), e(self.div_of(lead)), self.rec_c(lead), e(self.owner[run]), self.rec_c(run), e(self.owner[lead]), self.dv(lead),
            e(self.owner[run]), self.dv(run)))]
        lines += [x for x in (self.evidence_line(ev) for ev in evidence) if x]
        return "%s is the race to watch" % self.div_of(lead), self.desk(lines)

    def story_bubble(self, head, evidence):
        d = head["data"]
        lines = [("Stuart", "The last playoff spot comes down to %s and %s: %s and %s in All-Play, %s and %s to make the playoffs." % (
            e(self.owner[d["sixth"]]), e(self.owner[d["seventh"]]), self.ap_c(d["sixth"]), self.ap_c(d["seventh"]),
            self.po(d["sixth"]) if self.odds_fresh() else "&mdash;", self.po(d["seventh"]) if self.odds_fresh() else "&mdash;"))]
        lines += [x for x in (self.evidence_line(ev) for ev in evidence) if x]
        return "the last playoff spot is a coin flip", self.desk(lines)

    def story_odds_swing(self, head, evidence):
        f, d = head["fid"], head["data"]
        lines = [("Stuart", "%s&rsquo;s playoff odds moved from %s to %s since %s, %s points." % (
            e(self.owner[f]), self.odds_base(f, d), self.po(f), d["basis"], self.L.put("trig:move:" + f, round(abs(d["move"]), 1), "season_sim files", "%.1f" % abs(d["move"]))))]
        lines += [x for x in (self.evidence_line(ev) for ev in evidence) if x]
        ss = self.small_sample()
        if ss:
            lines.append(("Rich", ss))
        return "%s&rsquo;s odds %s" % (self.owner[f], "jumped" if d["move"] > 0 else "fell"), self.desk(lines)

    def story_elias_flip(self, head, evidence):
        f = head["fid"]
        lines = [("Stuart", "An Elias correction changed the board this week; the details are below."),
                 ("Rich", "%s is %s overall and %s in All-Play after the correction." % (e(self.owner[f]), self.rec_c(f), self.ap_c(f)))]
        return "Elias changed the week", self.desk(lines)

    def story_fallback_early(self):
        """Nothing rare yet (small sample): the first look: who leads and who trails in All-Play, with the sample size said."""
        st = self.ctx["mfl"]["standings"]
        ap = lambda f: (lambda a, b: a / float(a + b) if a + b else 0.0)(*(int(x) for x in st[f]["allplay"].split("-")[:2]))
        order = sorted(st, key=lambda f: (-ap(f), f))
        s = self.ctx["mfl"]["scores"]
        top = max(s, key=s.get)
        lines = [("Stuart", "%s leads the league in All-Play at %s after Week %d, and %s had the best score of the week, %s." % (
            e(self.owner[order[0]]), self.ap_c(order[0]), self.week, e(self.owner[top]), self.score(top)))]
        lines.append(("Rich", "At the other end, %s is %s in All-Play. %s" % (e(self.owner[order[-1]]), self.ap_c(order[-1]), self.small_sample())))
        if self.odds_fresh():
            sim = self.odds_text()[0]
            lines.append(("Stuart", "The forecast has %s at %s to make the playoffs and %s at %s." % (
                e(self.owner[max(sim["teams"], key=lambda f: (sim["teams"][f]["po"], f))]), self.po(max(sim["teams"], key=lambda f: (sim["teams"][f]["po"], f))),
                e(self.owner[min(sim["teams"], key=lambda f: (sim["teams"][f]["po"], f))]), self.po(min(sim["teams"], key=lambda f: (sim["teams"][f]["po"], f))))))
        return "the first look", self.desk(lines)

    def story_fallback_middle(self):
        st = self.ctx["mfl"]["standings"]
        ap = lambda f: (lambda a, b: a / float(a + b) if a + b else 0.0)(*(int(x) for x in st[f]["allplay"].split("-")[:2]))
        order = sorted(st, key=lambda f: (-ap(f), f))
        lines = [("Stuart", "%s leads the league in All-Play at %s after Week %d, with %s next at %s." % (
            e(self.owner[order[0]]), self.ap_c(order[0]), self.week, e(self.owner[order[1]]), self.ap_c(order[1]))),
                 ("Rich", "The last playoff spot sits between %s (%s) and %s (%s) in All-Play." % (
                     e(self.owner[order[5]]), self.ap_c(order[5]), e(self.owner[order[6]]), self.ap_c(order[6])))]
        return "the race so far", self.desk(lines)

    def story_fallback_late(self):
        return self.story_fallback_middle()

    # ------------------------------------------------------------ 2. Division Week
    def worst_lines(self, wa):
        """The bottom-of-the-history angle for one team (Week 8: Josh Martel). Rich voice."""
        f = wa["fid"]
        me = self.owner[f]
        arc = self.ctx["archive"]
        src = arc["source"] + " (previous week's All-Play = standings minus this week's games)"
        first = min(r[0] for r in arc["rows"])
        pw, pl = wa["prev"]
        prev = self.L.put("arch:prev:" + f, "%d-%d" % (pw, pl), src, I.wl(pw, pl))
        below = self.L.put("arch:prevbelow:" + f, wa["below"], src)
        tied = wa["tied"]
        rank = self.ORDW.get(wa["below"] + 1, self._ord(wa["below"] + 1))
        t = "Which makes %s the story. Through Week %d, %s was %s in All-Play, %s%s-worst start since %d." % (
            e(me), self.week - 1, self.sn(f), prev, "tied for the " if tied else "the ", rank, first)
        mine = SD.own_starts(self.ctx, me, self.week)
        good = max(mine, key=lambda y: (y["pct"], -y["season"])) if mine else None
        if good and good["pct"] >= 0.70:
            k = "%d:%s" % (good["season"], good["fid"])
            ap = self.L.put("arch:ap:" + k, "%d-%d" % (good["w"], good["l"]), arc["source"], I.wl(good["w"], good["l"]))
            t += " This is the same owner who started %d at %s." % (good["season"], ap)
        nw, nl = wa["now"]
        now = self.ap_c(f)
        k_ = self.L.put("arch:atbelow:" + f, wa["at_or_below"], src)
        t += " Week %d took %s to %s, and %s earlier teams were at that mark or worse by now%s." % (
            self.week, self.sn(f), now, k_, ", so the climb has left the all-time basement" if wa["improved"] else "")
        worst = min(mine, key=lambda y: (y["pct"], y["season"])) if mine else None
        if worst and nw / float(nw + nl) < worst["pct"] - 1e-12:
            k = "%d:%s" % (worst["season"], worst["fid"])
            ap = self.L.put("arch:ap:" + k, "%d-%d" % (worst["w"], worst["l"]), arc["source"], I.wl(worst["w"], worst["l"]))
            d = worst["w"] - nw
            t += " It is still the worst start of that owner&rsquo;s career in the archive, %s %s under the %s in %d." % (
                self.word(d) if d <= 4 else d, "game" if d == 1 else "games", ap, worst["season"])
        if self.posts(me) > 0 and all(self.posts(me) > self.posts(o) for o in self.fid if o != me):
            t += " %s also led the chat this week with %s posts." % (self.sn(f), self.posts_c(me))
        return [("Rich", t)]

    def team_line(self, f, gs, closest, big_team, bargains):
        """One team's paragraph in its division chapter."""
        s = self.ctx["mfl"]["scores"]
        wins = [l for (w, l) in gs if w == f]
        losses = [w for (w, l) in gs if l == f]
        if f == big_team and not losses:
            return "%s is the sweep, and you know that part. The pain is on the other side." % e(self.owner[f])
        parts = []
        if wins:
            parts.append("beat " + ", ".join("%s by %s%s" % (e(self.owner[l]), self.margin(f, l), ", the closest game of the week"
                                                             if self.mkey(f, l) == closest else "") for l in wins))
        if losses:
            parts.append("lost to " + ", ".join("%s by %s" % (e(self.owner[w]), self.margin(w, f)) for w in losses))
        shut = not wins and bool(losses)
        if shut and len(bargains) >= 2:
            a, b = bargains[0], bargains[1]
            head = "%s got %s from %s and %s from %s and went %s anyway." % (
                e(self.owner[f]), I.n1(a[3]), e(self.pname(a)), I.n1(b[3]), e(self.pname(b)), self.wkrec_c(f))
            tail = "%s %s." % (e(self.owner[f]), "; ".join(parts))
            txt = head + " " + tail
        else:
            card = next((c for c in self.pack.get("playcards", []) if c["owner"] == self.owner[f]), None)
            withp = ""
            if card and f != big_team:
                m = re.search(r"(\d+) catches", card["boxLine"])
                self.L.put("pts:" + card["player"], round(float(card["score"]), 1), "pack playcard (src_weekly)")
                withp = ", with %s from %s%s" % (I.n1(card["score"]), e(card["player"]), (" on %s catches" % m.group(1)) if m else "")
                if m:
                    self.L.put("box:" + card["player"], I.tidy_box(card["boxLine"]), "pack playcard (nflverse box score)")
            if wins and not losses or not withp:
                txt = "%s scored %s%s and went %s: %s." % (e(self.owner[f]), self.score(f), withp, self.wkrec_c(f), "; ".join(parts))
            else:
                txt = "%s scored %s%s, and went %s: %s." % (e(self.owner[f]), self.score(f), withp, self.wkrec_c(f), "; ".join(parts))
        if self.week_rank(f) == len(s):
            txt += " That was the lowest score of the week."
        dw, dl = self.div_rec(f)
        if shut and dw == 0 and dl >= 4:
            txt += " %s is %s inside the division%s." % (e(self.owner[f]), self.divrec_c(f), (
                " and %s to make the playoffs" % self.po(f)) if self.odds_fresh() else "")
        if shut and self.F.get("f.team.%s.best_available" % f) is not None and self.F.get("f.team.%s.could_have_won" % f) == "yes":
            txt += " The best possible lineup, %s, would have won %s." % (
                self.fact("f.team.%s.best_available" % f), "that game" if len(losses) == 1 else "a game")
        return txt

    def mkey(self, a, b):
        s = self.ctx["mfl"]["scores"]
        return round(abs(s[a] - s[b]), 1)

    def seg_div(self):
        s = self.ctx["mfl"]["scores"]
        fresh = self.odds_fresh()
        H = self.heat()
        games = self.games_sorted()
        closest = games[0][0] if games else None
        big = getattr(self, "_big", None)
        wa = SD.worst_angle(self.ctx, skip=big)
        picks = self.kenny_weave()                      # {chapter name: [lt kenny html]}
        chapters, trows = [], []
        pots = self.pack["pots"]
        intra = pots and all(len(p.get("divisions") or []) == 1 and len(p["games"]) == 3 for p in pots)
        intro = ""
        if intra:
            kp = self.L.put("divweek:pots", len(pots), "pack pots")
            kg = self.L.put("divweek:games", sum(len(p["games"]) for p in pots), "pack pots")
            intro = self.desk([("Stuart", "Every game in Week %d was played inside a division: %s triangles of three teams, %s games in all, and "
                                          "the same script in each one. One team swept. One split. One went home with nothing." % (
                                              self.week, self.word(len(pots)), self.word(sum(len(p["games"]) for p in pots))))])
        used = set()
        for k, pot in enumerate(pots):
            gs = [(self.fid[g["winner"]], self.fid[g["loser"]]) for g in pot["games"]]
            teams = sorted({f for g in gs for f in g}, key=lambda f: -s[f])
            name = self.pretty(pot["tag"])
            lines = []
            for i, f in enumerate(teams):
                txt = self.team_line(f, gs, closest, big, self.rows_for(f, "bargain"))
                st = self.ctx["mfl"]["standings"][f]
                dw, dl = self.div_rec(f)
                if dw + dl and dl == 0 and dw >= 3 and any(w_ == f for w_, _ in gs):
                    txt += " That makes %s %s against the division." % (e(self.owner[f]), self.divrec_c(f))
                if (st["h2hw"] + st["h2hl"]) and st["h2hw"] / float(st["h2hw"] + st["h2hl"]) >= 0.55 and dw + dl >= 4 and dw / float(dw + dl) <= 0.25:
                    txt += " %s is %s overall but %s against the division. Everything won has been won somewhere else." % (
                        e(self.owner[f]), self.rec_c(f), self.divrec_c(f))
                lines.append(("Stuart" if (i + k) % 2 == 0 else "Rich", txt))
            # equal division records, shared overall record, forecast contrasts, slides
            recs = {f: self.div_rec(f) for f in teams}
            if len(set(recs.values())) == 1 and sum(recs[teams[0]]) >= 4:
                ov = sorted(teams, key=lambda f: (-self.ctx["mfl"]["standings"][f]["h2hw"], f))
                lines.append(("Stuart" if len(lines) % 2 == 0 else "Rich", "Everyone in the division is %s against it, so the overall record decides: %s." % (
                    self.divrec_c(teams[0]), join("%s %s %s" % (e(self.owner[f]), "leads at" if j == 0 else "is", self.rec_c(f)) for j, f in enumerate(ov)))))
            same = [(a, b) for a in teams for b in teams if a < b and self.ctx["mfl"]["standings"][a]["h2hw"] == self.ctx["mfl"]["standings"][b]["h2hw"]
                    and self.ctx["mfl"]["standings"][a]["h2hl"] == self.ctx["mfl"]["standings"][b]["h2hl"]]
            sweeper = [f for f in teams if all(w == f for (w, l) in gs if f in (w, l))]
            if fresh:
                sim = self.odds_text()[0]
                if same:
                    a, b = sorted(same[0], key=lambda f: -sim["teams"][f]["div"])
                    lines.append(("Rich", "%s and %s are both %s, and the division is %s&rsquo;s at %s to %s&rsquo;s %s." % (
                        e(self.owner[a]), e(self.owner[b]), self.rec_c(a), self.sn(a), self.dv(a), self.sn(b), self.dv(b))))
                    if H and H[a]["rkFirst"] is not None and H[a]["rkFirst"] - H[a]["rkLast"] <= -4:
                        lines[-1] = ("Rich", lines[-1][1] + " %s&rsquo;s scoring rank has slid from %s to %s over the last three weeks, and %s is still the one leading." % (
                            self.sn(a), self.ordw(a, "rkFirst"), self.ordw(a, "rkLast"), self.sn(a)))
                elif sweeper:
                    sw = sweeper[0]
                    better = [f for f in teams if f != sw and sim["teams"][f]["title"] > sim["teams"][sw]["title"] + 1e-9 and sim["teams"][f]["title"] >= 0.05]
                    if better:
                        o = max(better, key=lambda f: sim["teams"][f]["title"])
                        lines.append(("Stuart", "%s is %s, and the forecast gives %s a better title chance, %s, than %s, %s." % (
                            e(self.owner[o]), self.rec_c(o), self.sn(o), self.ti(o), self.sn(sw), self.ti(sw))))
                    else:
                        divs = {self.ctx["d1"]["franchises"][f]["division"] for f in teams}
                        if len(divs) == 1:
                            lead = max(teams, key=lambda f: (sim["teams"][f]["div"], f))
                            lines.append(("Stuart", "%s is %s to win the division." % (e(self.owner[lead]), self.dv(lead))))
            if wa and wa["fid"] in teams and self.ctx.get("archive"):
                lines += self.worst_lines(wa)
                used.add(wa["fid"])
            who, txt = lines[0]
            lines[0] = (who, "<b>%s.</b> %s" % (e(name), txt))
            chapters.append(self.desk(lines) + "".join(picks.pop(name, [])))
            cells = {"Swept": [], "Split": [], "Shut out": []}
            for f in teams:
                w_ = sum(1 for g in gs if g[0] == f)
                l_ = sum(1 for g in gs if g[1] == f)
                cells["Swept" if l_ == 0 else "Shut out" if w_ == 0 else "Split"].append("%s %s" % (e(self.owner[f]), self.score(f)))
            trows.append(self.row([e(name)] + [", ".join(cells[c]) or "&mdash;" for c in ("Swept", "Split", "Shut out")]))
        extra = "".join(h for hs in picks.values() for h in hs)
        self._worst_unplaced = wa if wa and wa["fid"] not in used else None
        gap = self.kenny_gap() if not self.ctx.get("kennyPicks") else ""
        cap = ('<p class="caption">Week %d scores%s. A team is Swept when it won every game it played in the group, Shut out when it won none and '
               'Split otherwise. Josh-style history lines use the league archive of weekly results (%s). Chat lines are owner posts in the league Discord, linked to the message.</p>' % (
                   self.week, " after Elias corrections" if (self.ctx.get("eliasReport") or {}).get("teams") else "",
                   "2010 is left out because its archived scores conflict with themselves" if "2010" in ((self.ctx.get("archive") or {}).get("excluded") or {}) else "all archived seasons used"))
        cap = cap.replace("Josh-style history lines use", "History lines use")
        wide, narrow = (games[-1], games[0]) if games else (None, None)
        sweeps = sum(1 for k_, pot_ in enumerate(pots) for f_ in {f for g in pot_["games"] for f in (self.fid[g["winner"]], self.fid[g["loser"]])}
                     if all(self.fid[g["winner"]] == f_ for g in pot_["games"] if f_ in (self.fid[g["winner"]], self.fid[g["loser"]])))
        title = ("%s games, %s sweeps, the widest margin %s and the closest %s" % (self.word(sum(len(p_["games"]) for p_ in pots)), self.word(sweeps),
                                                                              self.margin(wide[1], wide[2]), self.margin(narrow[1], narrow[2]))) if wide else "every game, one chapter per division"
        self.L.put("divweek:sweeps", sweeps, "pack pots (teams that won every game they played in the group)")
        self.L.put("divweek:gamesn", sum(len(p_["games"]) for p_ in pots), "pack pots")
        return self.section("divweek", "Division Week", 2, "Division Week <small>&mdash; %s</small>" % title,
                            intro + "".join(chapters) + extra + gap + self.table(["Division", "Swept", "Split", "Shut out"], trows) + cap)

    # ------------------------------------------------------------ Kenny: committed picks (message ids), woven into chapters
    def kenny_weave(self):
        """{chapter name: [html]} from ctx["kennyPicks"]: [{"id": message id, "frame": bool, "note": text}, ...]. The editor chooses
        ids (and writes the joke, which may not contain digits); the job writes the factual frame and links the quote."""
        picks = (self.ctx.get("kennyPicks") or {}).get("picks") or []
        if not picks:
            return {}
        chat = {m["message_id"]: m for m in self.ctx["d1"]["chat"]}
        out, by_owner = {}, {}
        for p in picks:
            m = chat.get(str(p["id"]))
            if not m:
                raise ValueError("Kenny pick %s is not in the chat window" % p["id"])
            by_owner.setdefault(m["owner_name"], []).append((p, m))
        for owner, items in by_owner.items():
            parts = []
            for j, (p, m) in enumerate(items):
                txt = " ".join((m["content"] or "").split())
                if chat_exclusions.reason(m["message_id"], txt, chat_exclusions.excluded_ids()):
                    raise ValueError("Kenny pick %s may not be used: %s" % (p["id"], chat_exclusions.reason(m["message_id"], txt)))
                self.L.put("quote:" + m["message_id"], txt, "D1 ups_discord_messages", txt)
                d = datetime.fromtimestamp(int(m["posted_at_unix"]), I.ET)
                clock = "%d:%02d %s" % ((d.hour % 12) or 12, d.minute, "AM" if d.hour < 12 else "PM")
                url = "https://discord.com/channels/%s/%s/%s" % (I.GUILD, m["channel_id"], m["message_id"])
                q = '<a class="rcpt" href="%s" target="_blank" rel="noopener" title="%s &middot; #%s &middot; %s">&ldquo;%s&rdquo;</a>' % (
                    url, e(owner), e(m["channel_name"]), I.et_clock(m["posted_at_unix"]), e(txt))
                parts.append(("%s, %s, %s: %s" % (d.strftime("%A"), clock, e(owner), q)) if j == 0 else ("Then, at %s: %s" % (clock, q)))
            tailp = []
            fid = self.fid.get(owner)
            if any(p.get("frame") for p, _ in items) and fid:
                n = self.posts(owner)
                tailp.append("%s scored %s this week and posted %s." % (e(owner), self.score(fid), (
                    "once" if n == 1 else "%s times" % (self.word(n) if n <= 4 else self.posts_c(owner))) if n <= 4 else "%s times" % self.posts_c(owner)))
                self.posts_c(owner)
            for p, _ in items:
                if p.get("note"):
                    tailp.append(e(p["note"]))
            out.setdefault(self.chapter_of(owner), []).append(self.lt("Kenny", " ".join(parts + tailp)))
        return {k: ['<div class="desk-lines">%s</div>' % "".join(v)] for k, v in out.items()}

    def chapter_of(self, owner):
        for pot in self.pack["pots"]:
            if any(owner in (g["winner"], g["loser"]) for g in pot["games"]):
                return self.pretty(pot["tag"])
        return "Other"

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
            self.L.put("quoteid:" + m["message_id"], m["message_id"], "D1 ups_discord_messages (message id shown to the editor)")
            cands.setdefault(self.div_of(fid) if fid else "Other", []).append(
                '<li><b>%s</b>, %s (id %s): <a class="rcpt" href="%s" target="_blank" rel="noopener">&ldquo;%s&rdquo;</a></li>' % (
                    e(m["owner_name"]), I.et_clock(m["posted_at_unix"]), m["message_id"], url, e(txt)))
        total = sum(len(v) for v in cands.values())
        if self.local:
            listing = "".join("<p style=\"font-weight:700;margin:.5rem 0 0\">%s</p><ol style=\"font-weight:400;margin:.2rem 0 0 1rem\">%s</ol>" % (
                e(d), "".join(v[:12])) for d, v in sorted(cands.items())) or " No usable owner messages in the window."
        else:
            listing = " %s candidate line(s) are listed, verbatim, linked and grouped by division, in the local review copy only (raw chat " \
                      "stays off the public repo)." % self.L.put("count:candidates", total, "D1 ups_discord_messages window (usable lines)")
            for k in [k for k in self.L.claims if k.startswith("quote:") or k.startswith("quoteid:")]:
                del self.L.claims[k]
        return self.gap("coffee:kenny", "coffee", "Kenny Mayne&rsquo;s lines are an editor&rsquo;s job (owner dossier). Pick the lines by adding "
                        "their message ids to <code>site/wire/data/kenny_picks_%d_wk%02d.json</code> "
                        "(<code>{\"picks\": [{\"id\": \"...\", \"frame\": true, \"note\": \"joke, no digits\"}]}</code>); the job then weaves each into its "
                        "division&rsquo;s chapter with the link and removes this box. %d message(s) ruled out by an editor or touching family, health "
                        "or similar were withheld and must not be used.%s" % (self.season, self.week, flagged, listing))

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
        src_e = "elias.py check (MFL site news, Official Statistics Changes) vs scores_published_%d_wk%02d" % (self.season, self.week)
        s = self.ctx["mfl"]["scores"]
        pub = (self.ctx.get("scoresPublished") or {}).get("teams") or {}
        half = lambda d: "half a point" if abs(abs(d) - 0.5) < 1e-9 else None
        n_c = self.L.put("elias:count", n_official, src_e)
        bits = []
        for p in [p for p in rep.get("players") or [] if p.get("status") == "starter"]:
            d = self.L.put("elias:delta:" + p["pid"], round(p["delta"], 1), src_e, "%+.1f" % p["delta"])
            acts = []
            for ch in p.get("elias") or []:
                diff = int(round(ch["to"] - ch["from"]))
                fr = self.L.put("elias:stat:%s:%s:from" % (p["pid"], ch["stat"]), ch["from"], src_e, "%d" % ch["from"])
                to = self.L.put("elias:stat:%s:%s:to" % (p["pid"], ch["stat"]), ch["to"], src_e, "%d" % ch["to"])
                nm = ch["stat"].lower()
                nm1 = nm[:-1] if nm.endswith("s") and abs(diff) == 1 else nm
                one = lambda d_: ("%s %s" % ("an" if nm1[0] in "aeiou" else "a", nm1)) if abs(d_) == 1 else "%s %s" % (self.word(abs(d_)), nm1)
                acts.append("picked up a second %s" % nm1 if diff == 1 and ch["from"] == 1 else
                            "gained %s" % one(diff) if diff > 0 else "lost %s" % one(diff))
            amt = half(p["delta"]) or ("%s points" % d.replace("-", "&minus;").lstrip("+"))
            acts_s = " and ".join(acts) if acts else "had a stat changed"
            owner = e(self.owner[p["fid"]])
            bits.append("%s %s, which is %s for %s" % (e(p["player"]), acts_s, amt, owner)
                        if p["delta"] > 0 else "%s %s, and that cost %s %s" % (e(p["player"]), acts_s, owner, amt))
        lines = [("Stuart", "Breaking, and it is small. The league office posted %s official stat changes for Week %d, and %s touched a UPS starter. %s." % (
            n_c, self.week, self.word(len(bits)) if bits else "none", ". ".join(b[0].upper() + b[1:] for b in bits)) if bits else
            "The league office posted %s official stat changes for Week %d." % (n_c, self.week))]
        mv = sorted(moved, key=lambda f: -moved[f]["delta"])
        swapped = [f for f in apch]
        if swapped and len(swapped) == 2:
            m_ = next((f for f in swapped if f in moved), swapped[0])
            o_ = next(f for f in swapped if f != m_)
            gb = self.L.put("elias:gap:before:" + m_, round(abs(s[o_] - pub.get(m_, s[m_])), 1), src_e)
            ga = self.L.put("elias:gap:after:" + m_, round(abs(s[o_] - s[m_]), 1), src_e)
            hb = self.L.put("elias:before:" + m_, round(moved[m_]["before"], 1), src_e) if m_ in moved else self.score(m_)
            up = moved[m_]["delta"] > 0 if m_ in moved else True
            tenths = lambda v: ("%s tenth%s" % ("a" if round(v * 10) == 1 else self.word(int(round(v * 10))), "" if round(v * 10) == 1 else "s")) if v < 0.95 else None
            lines.append(("Rich", "%s, and it changed the table. %s went from %s to %s. %s scored %s. Before the correction %s was %s %s by %s. Now %s is %s by %s." % (
                (half(moved[m_]["delta"]) or "A correction").capitalize() if m_ in moved else "A correction", e(self.owner[m_]), hb, self.score(m_),
                e(self.owner[o_]), self.score(o_), e(self.owner[o_] if up else self.owner[m_]), "ahead of", e(self.owner[m_] if up else self.owner[o_]), tenths(float(gb)) or gb,
                e(self.owner[m_] if up else self.owner[o_]), "ahead", tenths(float(ga)) or ga)))
        elif mv:
            lines.append(("Rich", "%s." % join("%s went from %s to %s" % (e(self.owner[f]), self.L.put("elias:before:" + f, round(moved[f]["before"], 1), src_e), self.score(f)) for f in mv)))
        if apch:
            ch = []
            order = sorted(apch, key=lambda f: (f not in moved, f))
            for f in order:
                b = apch[f]["before"]
                wb = self.L.put("elias:wkapBefore:" + f, "%d-%d" % (b["w"], b["l"]), src_e, I.wl(b["w"], b["l"]))
                ch.append("%s&rsquo;s Week %d All-Play went from %s to %s" % (e(self.owner[f]), self.week, wb, self.wkap_c(f)))
            sea = "; ".join("%s is %s, not %s" % (e(self.owner[f]), self.ap_c(f), self.L.put(
                "elias:apBefore:" + f, self.season_before(f, apch[f]), src_e, I.wl(*self.season_before(f, apch[f]).split("-")))) for f in order)
            t = "That swapped one All-Play game between them. %s. Their season All-Play records moved with it: %s." % (
                (ch[0] + ", and " + ch[1].replace("&rsquo;s Week %d All-Play went" % self.week, "&rsquo;s went")) if len(ch) == 2 else "; ".join(ch), sea) if len(order) == 2 \
                else "That moved All-Play games: %s. Season records moved with it: %s." % ("; ".join(ch), sea)
            rk = {c["fid"]: c for c in rep.get("rankChanges") or []}
            if rk and set(rk) == set(order):
                t += " Their Week %d scoring ranks %s too, %s." % (self.week, "swapped" if len(rk) == 2 else "moved", join(
                    "%s %s" % (e(self.owner[f]).split(" ")[-1] if False else e(self.owner[f]), self.L.put("elias:rank:" + f, rk[f]["after"], src_e, self._ord(rk[f]["after"]).replace("th", "th")) and self.ORDW.get(rk[f]["after"], str(rk[f]["after"])))
                    for f in order))
            lines.append(("Stuart", t))
        flips = rep.get("resultsFlipped")
        tailr = []
        if flips == 0:
            tailr.append("Nobody&rsquo;s result flipped.")
        elif flips:
            tailr.append("%s head-to-head result(s) flipped." % self.L.put("elias:flipped", flips, src_e))
        for f in [f for f in mv if f not in apch]:
            d = moved[f]["delta"]
            order_ = sorted(s, key=lambda g: -s[g])
            i = order_.index(f)
            nb = order_[i + 1] if d < 0 and i + 1 < len(order_) else (order_[i - 1] if d > 0 and i > 0 else None)
            if nb:
                tailr.append("%s&rsquo;s %s is still %s %s&rsquo;s %s, so the All-Play did not move." % (
                    e(self.owner[f]), self.score(f), "above" if d < 0 else "below", e(self.owner[nb]), self.score(nb)))
        tailr.append("Every number in this issue already counts the corrected scores.")
        lines.append(("Rich", " ".join(tailr)))
        rows = []
        order = [f for f in sorted(apch, key=lambda f: (f not in moved, f))] + [f for f in mv if f not in apch]
        for f in order:
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
        small = all(abs(t["delta"]) <= 0.5 + 1e-9 for t in moved.values())
        return self.section("elias", "Elias", 3, "Elias <small>&mdash; %s</small>" % (
            "half a point moved the board" if apch and small else "a correction moved the board" if apch else "a score moved"),
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
        t = "Here is the shape of it. %s division leaders: %s." % (self.word(len(favs)).capitalize(), join(
            "%s at %s to win %s" % (e(self.owner[f]), self.dv(f), e(self.div_of(f))) if j == 0 else "%s at %s" % (e(self.owner[f]), self.dv(f))
            for j, f in enumerate(favs)))
        soft = min(favs, key=lambda f: (teams[f]["div"], f))
        mates = sorted([g for g in by_div[teams[soft]["division"]] if g != soft], key=lambda g: -teams[g]["div"])
        if teams[soft]["div"] < 0.8 and teams[mates[0]]["div"] >= 0.2:
            t += " %s&rsquo;s is the soft one, with %s sharing the rest." % (e(self.owner[soft]), join(
                "%s at %s" % (e(self.owner[g]), self.dv(g)) for g in mates if teams[g]["div"] > 0))
        lines = [("Stuart", t)]
        rest = [f for f in order if f not in favs]
        wild = [f for f in rest if teams[f]["po"] >= 0.08]
        low = [f for f in rest if teams[f]["po"] < 0.08]
        if wild:
            lead = wild[:2]
            parts = []
            for f in lead:
                if teams[f]["po"] >= 0.5 and teams[f]["div"] < 0.5:
                    parts.append("%s is %s to make the playoffs with only a %s chance of winning the division, so %s gets in the other way" % (
                        e(self.owner[f]), self.po(f), self.dv(f), self.sn(f)) if teams[f]["div"] >= 0.01 else
                                 "%s is %s with a %s division chance, and %s is counting entirely on a wild card" % (e(self.owner[f]), self.po(f), self.dv(f), self.sn(f)))
                else:
                    parts.append("%s is %s" % (e(self.owner[f]), self.po(f)))
            rem = wild[2:]
            t2 = "Then the wild-card road. %s." % ". ".join(parts)
            if rem:
                t2 += " %s." % join(("%s is %s" if j == 0 else "%s %s") % (e(self.owner[f]) if j == 0 else self.sn(f), self.po(f)) for j, f in enumerate(rem))
            lines.append(("Rich", t2.replace(". .", ".")))
        if low:
            lines.append(("Stuart", "And the bottom: %s." % join("%s is at %s" % (e(self.owner[f]), self.po(f)) if j == 0 else "%s at %s" % (e(self.owner[f]), self.po(f))
                                                                for j, f in enumerate(low))))
        return lines

    # ------------------------------------------------------------ 5. Plays
    def seg_story_plays(self):
        proven = self.proven_rows()
        gaps, lists, caption = self._bbgaps, self._bblists, self._bbcap
        cards = self.play_cards(linked_only=True)
        boxes = {c["player"]: c["boxLine"] for c in self.pack.get("playcards", [])}

        def dd(r):
            return abs(float(r[4].replace("+", "").replace("-", "").replace("−", "")))
        off_b = sorted(proven.get("t.bb.off.bargain", []), key=lambda r: (-dd(r), r[0]))
        idp_b = sorted(proven.get("t.bb.idp.bargain", []), key=lambda r: (-dd(r), r[0]))
        allb = sorted(off_b + idp_b, key=lambda r: (-dd(r), r[0]))
        ordn = {0: "biggest", 1: "second-biggest", 2: "third-biggest"}

        def use(r):
            nm = self.pname(r)
            bl = boxes.get(nm)
            if bl:
                self.L.put("box:" + nm, I.tidy_box(bl), "pack playcard (nflverse box score)")
                return I.tidy_box(bl)
            u = r[5] if len(r) > 5 and r[5] else ""
            return re.sub(r"\s*\([\d.]+\)$", "", u)

        def box_phrase(r):
            b = use(r)
            if not b:
                return ""
            m = re.match(r"(\d+) catches on (\d+) targets for (\d+)(.*)$", b)
            return " on %s catches for %s yards" % (m.group(1), m.group(3)) if m else (": " + b)
        lines = []
        if allb:
            r = allb[0]
            f = self.fid[r[1]]
            seg = "Start with the number nobody had. %s was projected for %s and scored %s for %s%s. That is %s, the biggest bargain of the week." % (
                e(self.pname(r)), I.n1(r[2]), I.n1(r[3]), e(r[1]), (": " + e(self.box_prose(use(r)))) if use(r) else "", e(r[4]))
            mates = [x for x in allb[1:] if x[1] == r[1]]
            if mates:
                seg += " %s added %s against a %s projection." % (e(self.pname(mates[0])), I.n1(mates[0][3]), I.n1(mates[0][2]))
            lines.append(("Stuart", seg))
        rest = [x for x in allb[1:] if not (allb and x[1] == allb[0][1])][:3]
        if rest:
            r = rest[0]
            f = self.fid[r[1]]
            t = "Bargains do not guarantee wins. %s was projected for %s and scored %s for %s, the second-biggest bargain of the week, and %s went %s." % (
                e(self.pname(r)), I.n1(r[2]), I.n1(r[3]), e(r[1]), e(r[1]), self.wkrec_c(f)) if self.week_records()[f][0] == 0 else \
                "%s was projected for %s and scored %s for %s, another big bargain." % (e(self.pname(r)), I.n1(r[2]), I.n1(r[3]), e(r[1]))
            for r2 in rest[1:3]:
                pw = self.posword(r2)
                who = ("%s, %s&rsquo;s %s," % (e(self.pname(r2)), e(r2[1]), pw)) if pw else e(self.pname(r2))
                if pw:
                    t += " %s was projected for %s and put up %s%s." % (who, I.n1(r2[2]), I.n1(r2[3]), e(box_phrase(r2)) if box_phrase(r2).startswith(" on") else "")
                else:
                    t += " %s got %s from %s against a %s projection." % (e(r2[1]), I.n1(r2[3]), e(self.pname(r2)), I.n1(r2[2]))
            lines.append(("Rich", t))
        # busts: the combined-miss framing per team
        by_owner = {}
        for tid in ("t.bb.off.bust", "t.bb.idp.bust"):
            for r in proven.get(tid, []):
                by_owner.setdefault(self.fid[r[1]], []).append(r)
        short = lambda rows: round(sum(float(r[2]) - float(r[3]) for r in rows), 1)
        groups = sorted([(f, rows) for f, rows in by_owner.items() if len(rows) >= 2], key=lambda x: (-short(x[1]), x[0]))

        def miss_line(f, rows):
            rows = sorted(rows, key=lambda r: float(r[2]) - float(r[3]), reverse=True)[:2]
            tot = self.L.put("miss:" + f, {"rows": [[self.pname(r), float(r[2]), float(r[3])] for r in rows], "short": short(rows)},
                             "pack t.bb busts (projection captured before kickoff)", I.n1(short(rows)))
            return rows, tot
        s = self.ctx["mfl"]["scores"]
        used_owner = set()
        if groups:
            f, rows = groups[0]
            rows, tot = miss_line(f, rows)
            lines.append(("Stuart", "Now the other side. %s started %s and %s, projected for %s and %s, and got %s and %s from them. That is %s projected points that never showed up, and %s still scored %s and went %s." % (
                e(self.owner[f]), e(self.pname(rows[0])), e(self.pname(rows[1])), I.n1(rows[0][2]), I.n1(rows[1][2]), I.n1(rows[0][3]), I.n1(rows[1][3]),
                tot, e(self.owner[f]), self.score(f), self.wkrec_c(f))))
            used_owner.add(f)
        winners = sorted([(r, f) for f, rows in by_owner.items() for r in rows if f not in used_owner and self.week_records()[f][0] > 0
                          and self.week_records()[f][1] == 0], key=lambda x: -(float(x[0][2]) - float(x[0][3])))
        if winners:
            r, f = winners[0]
            lines.append(("Rich", "%s&rsquo;s %s went from %s projected to %s, and %s still scored %s." % (
                e(self.owner[f]), e(self.pname(r)), I.n1(r[2]), I.n1(r[3]).replace("-", "&minus;"), e(self.owner[f]), self.score(f))))
            used_owner.add(f)
        losers = [(f, rows) for f, rows in groups[1:] if self.week_records()[f][0] == 0 and f not in used_owner]
        if losers:
            f, rows = losers[0]
            rows, tot = miss_line(f, rows)
            lines.append(("Rich", "%s was not so lucky. %s was projected for %s and scored %s, and %s was projected for %s and scored %s. Together that is %s points under projection, in a week %s scored %s and lost %s." % (
                e(self.owner[f]), e(self.pname(rows[0])), I.n1(rows[0][2]), I.n1(rows[0][3]), e(self.pname(rows[1])), I.n1(rows[1][2]), I.n1(rows[1][3]),
                tot, e(self.owner[f]), self.score(f), "both games" if len(self.ctx["mfl"]["games"]) and self.week_records()[f][1] == 2 else "every game")))
        elif groups[1:] and False:
            pass
        # defense
        if idp_b:
            r = idp_b[0]
            t = "On defense, %s gave %s %s on a %s projection" % (e(self.pname(r)), e(r[1]), I.n1(r[3]), I.n1(r[2]))
            owners = {}
            for x in idp_b[1:]:
                owners.setdefault(x[1], []).append(x)
            pair = next(((o, xs) for o, xs in owners.items() if len(xs) >= 2), None)
            if pair:
                o, xs = pair
                f = self.fid[o]
                pl = self.posword(xs[0], True) if self.posword(xs[0]) == self.posword(xs[1]) else None
                t += ", and %s&rsquo;s %s %s and %s beat their projections by %s and %s. %s scored %s, %s best of the week" % (
                    e(o), pl or "defenders", e(self.pname(xs[0])), e(self.pname(xs[1])), e(xs[0][4]).lstrip("+"), e(xs[1][4]).lstrip("+"), self.sn(f), self.score(f), self.week_rank_c(f))
            lines.append(("Stuart", t + "."))
        return self.section("plays", "The Plays That Made the Week", 5,
                            "The Plays That Made the Week <small>&mdash; the bargains, the busts, and who they carried</small>",
                            self.desk(lines) + gaps + '<div class="reel">%s</div>' % "".join(cards)
                            + '<details class="wire-more"><summary>The full projection ledger</summary><div class="bb">%s</div>%s</details>' % (lists, caption))

    # ------------------------------------------------------------ 6. The Season So Far
    def seg_story_season(self):
        H = self.heat()
        S = STORIES.survival(self.ctx)
        g_land, land = self.seg_landscape(bare=True)
        g_heat, heat = self.seg_heat(bare=True)
        g_surv, surv = self.seg_survival(bare=True)
        lines = []
        src = self.heat_src()
        if H:
            first, last = STORIES.windows(self.week)
            w_last = "Weeks %d&ndash;%d" % (last[0], last[-1]) if len(last) > 1 else "Week %d" % last[0]
            w_first = ("Weeks %d&ndash;%d" % (first[0], first[-1]) if len(first) > 1 else "Week %d" % first[0]) if first else ""
            a3 = lambda f: self.L.put("heat:ap3:" + f, "%d-%d" % H[f]["ap3"], src, I.wl(*H[f]["ap3"]))
            dom = sorted([f for f in H if H[f]["label"] == "Dominant"], key=lambda f: (-H[f]["ap3"][0], f))
            rest = sorted([f for f in H if f not in dom], key=lambda f: (-H[f]["ap3"][0], f))
            if dom:
                t1 = "Treat the last three weeks as their own season. In %s, %s." % (w_last, join(
                    "%s is %s in All-Play" % (e(self.owner[f]), a3(f)) if j == 0 else "%s is %s" % (e(self.owner[f]), a3(f)) for j, f in enumerate(dom[:3])))
                t1 += " Those are the only %s Dominant teams in the league." % self.word(len(dom)) if len(dom) <= 4 else ""
            else:
                t1 = "Treat the last three weeks as their own season. In %s, no team was Dominant." % w_last
            t1 += " The next best are %s." % join("%s at %s" % (e(self.owner[f]), a3(f)) for f in rest[:2])
            lines.append(("Stuart", t1))
            moves = [(f, H[f]["rkFirst"] - H[f]["rkLast"]) for f in H if H[f]["rkFirst"] is not None]
            up = [f for f, m in sorted(moves, key=lambda x: (-x[1], x[0])) if m >= 3][:2]
            down = [f for f, m in sorted(moves, key=lambda x: (x[1], H[x[0]]["rkFirst"], x[0])) if m <= -3][:3]
            mv = []
            for f in up:
                mv.append("%s climbed from %s in scoring in %s to %s in %s" % (e(self.owner[f]), self.ordw(f, "rkFirst"), w_first, self.ordw(f, "rkLast"), w_last))
            tail_dn = []
            for j, f in enumerate(down):
                if j == 0:
                    mv.append("%s fell from %s to %s and is %s over the stretch" % (e(self.owner[f]), self.ordw(f, "rkFirst"), self.ordw(f, "rkLast"), a3(f)))
                else:
                    tail_dn.append((f, "%s from %s to %s" % ("went" if not tail_dn else "", self.ordw(f, "rkFirst"), self.ordw(f, "rkLast"))))
            if tail_dn:
                mv.append(", and ".join(("%s %s" % (e(self.owner[f]) if i == 0 else self.sn(f), t_.strip())) for i, (f, t_) in enumerate(tail_dn)))
            if mv:
                lines.append(("Rich", "The movers. %s." % ". ".join(mv)))
        if S:
            rows, meta = S
            sim_ok = self.odds_fresh()
            hs = "D1 weeks 1-%d of %d-%d + /api/playoff-bracket" % (self.week, meta["firstAp"], meta["lastAp"])
            hv = lambda f, k: self.L.put("hist:%s:%s" % (k, f), rows[f]["apHist"][0 if k == "apMade" else 1] if k.startswith("ap") else rows[f]["winHist"][0 if k == "winMade" else 1], hs)
            rate = lambda m_n: (m_n[0] / float(m_n[1])) if m_n[1] else None
            if sim_ok:
                sim = self.odds_text()[0]
                top = sorted(rows, key=lambda f: (-sim["teams"][f]["po"], f))[:4]
                lines.append(("Stuart", "Then ask what history says about where everyone sits after Week %d. The Survival Line looks at past seasons: of teams with %s All-Play rank at this point, %s of %s made the playoffs; %s" % (
                    self.week, "%s&rsquo;s" % e(self.owner[top[0]]), hv(top[0], "apMade"), hv(top[0], "apN"),
                    "; ".join("%s&rsquo;s group, %s of %s" % (e(self.owner[f]), hv(f, "apMade"), hv(f, "apN")) for f in top[1:]) + ".")))
            cand = [f for f in rows if rate(rows[f]["apHist"]) is not None and rate(rows[f]["winHist"]) is not None and rows[f]["apHist"][1] >= 5
                    and rows[f]["winHist"][1] >= 5 and rate(rows[f]["winHist"]) - rate(rows[f]["apHist"]) >= 0.25 and rate(rows[f]["winHist"]) >= 0.6]
            if cand:
                f = min(cand, key=lambda f: (rate(rows[f]["apHist"]), f))
                lo, hi = rate(rows[f]["apHist"]), rate(rows[f]["winHist"])
                mid = sim_ok and lo <= sim["teams"][f]["po"] <= hi
                tail = (" The forecast %s at %s." % ("lands in between" if mid else "lands", self.po(f))) if sim_ok else ""
                lines.append(("Rich", "%s is where the two histories disagree. Only %s of %s teams with that All-Play rank made it. But %s of %s teams with that win total did. "
                                      "The record says %s is fine. The scoring says history is not so sure.%s" % (
                                          e(self.owner[f]), hv(f, "apMade"), hv(f, "apN"), hv(f, "winMade"), hv(f, "winN"), e(self.owner[f]), tail)))
            if sim_ok:
                low = sorted(sorted(rows, key=lambda f: (sim["teams"][f]["po"], f))[:3], key=lambda f: ((rows[f]["apHist"][0] / float(rows[f]["apHist"][1])) if rows[f]["apHist"][1] else 0, f))
                f1, f2, f3 = low
                hh = lambda f: "%s of %s by All-Play rank and %s of %s by wins" % (hv(f, "apMade"), hv(f, "apN"), hv(f, "winMade"), hv(f, "winN"))
                hs_ = lambda f: "%s of %s and %s of %s" % (hv(f, "apMade"), hv(f, "apN"), hv(f, "winMade"), hv(f, "winN"))
                lines.append(("Stuart", "At the bottom, %s is %s, and %s is %s. Their odds are %s and %s. %s is %s, and %s." % (
                    e(self.owner[f1]), hh(f1), e(self.owner[f2]), hs_(f2), self.po(f1), self.po(f2), e(self.owner[f3]), hs_(f3), self.po(f3))))
        if H:
            lk = sorted(H, key=lambda f: (-H[f]["luck"], f))
            lu, un = lk[0], lk[-1]
            bn = max(H, key=lambda f: (H[f]["bench"], f))
            sg = lambda v: ("%+.1f" % v).replace("-", "&minus;")
            lines.append(("Rich", "And luck. %s is %s wins over what the All-Play rate predicts, the most in the league, and %s is %s, the fewest. %s leaves %s points on the bench every week, %s the most, and %s of %s losses would have been wins with the best lineup." % (
                e(self.owner[lu]), self.L.put("heat:luck:" + lu, H[lu]["luck"], src, sg(H[lu]["luck"])), e(self.owner[un]),
                self.L.put("heat:luck:" + un, H[un]["luck"], src, sg(H[un]["luck"])), e(self.owner[bn]),
                self.L.put("heat:bench:" + bn, H[bn]["bench"], src, "%.1f" % H[bn]["bench"]), "also" if bn in (lu, un) or True else "",
                self.L.put("heat:lostBest:" + bn, H[bn]["lostBest"], src), self.L.put("heat:losses:" + bn, H[bn]["losses"], src))))
        wu = getattr(self, "_worst_unplaced", None)
        if wu and self.ctx.get("archive"):
            lines = self.worst_lines(wu) + lines
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
