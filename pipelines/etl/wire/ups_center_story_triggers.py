#!/usr/bin/env python3
"""The Big Story picker: a phase-aware, ranked, pluggable table of storyline triggers (Keith 2026-11-05).

The data chooses the story; the calendar only changes which triggers may lead and how stakes are weighed.
Spec: the storyline catalog (S1-S21) written for PR #1438. Pure: no network, no clock, no D1.

Each trigger is a function registered with @trigger(...). It looks at the snapshot and returns candidates
[{"fid", "s", "data"}], where `s` is a SURPRISE score, lower = bigger:
    p  = the share of comparable past observations at least that extreme (archive 2011-2025, this season left out)
    s  = 1 - (1 - p) ** 12      the chance a random league week produces something this rare
A trigger FIRES when its adjusted s <= FIRE (0.15, about one week in seven). To add a storyline: write a
function, decorate it, and add a story builder named story_<id> to ups_center_story_issue.StoryIssue.

Ranking (pick):
  1. phase gating: EARLY (weeks 1-4) lets only single-week facts and odds-vs-preseason lead; every trigger has a
     minimum week and an allowed-phase list;
  2. phase weights: from week 11 stakes triggers count double (s x 0.5), rarity triggers 1.5 times worse (s x 1.5);
  3. repeat ledger: the same team and trigger as last week's lead has s x 3 unless the new s is 30% better;
  4. merge by subject: triggers about one team are ONE story: the lowest s heads it, the rest become evidence lines;
  5. nothing fires: a phase-specific fallback story (never the legacy opening desk), with small-sample wording early.
"""
import math

FIRE = 0.15
PHASES = (("early", 1, 4), ("middle", 5, 10), ("late", 11, 14), ("playoffs", 15, 99))
REGISTRY = []


def phase_of(week):
    return next(name for name, lo, hi in PHASES if lo <= week <= hi)


def surprise(p):
    p = min(max(p, 0.0), 1.0)
    return 1 - (1 - p) ** 12


def trigger(tid, kind, min_week=1, phases=("early", "middle", "late", "playoffs")):
    """kind: 'rarity' (history rank), 'stakes' (odds / standings) or 'single' (one-week fact)."""
    def deco(fn):
        REGISTRY.append({"id": tid, "kind": kind, "min_week": min_week, "phases": phases, "fn": fn})
        return fn
    return deco


# ------------------------------------------------------------------ shared derived data
class Env:
    """Lazily derived tables, built once per pick."""

    def __init__(self, ctx):
        self.ctx = ctx
        self.week = int(ctx["week"])
        h = ctx.get("history") or {}
        self.scores = {}                                   # {week: {fid: score}} this season, weeks <= N
        for r in h.get("seasonScores") or []:
            if int(r["week"]) <= self.week:
                self.scores.setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r["team_score"])
        if self.week not in self.scores:
            self.scores[self.week] = dict(ctx["mfl"]["scores"])
        self.games = h.get("seasonGames") or []
        arc = ctx.get("archive") or {}
        self.past = {}                                     # {(season, week): {fid: score}}
        for season, w, f, x in arc.get("rows") or []:
            self.past.setdefault((int(season), int(w)), {})[f] = float(x)
        self.fresh = bool((ctx.get("forecast") or {}).get("sim"))
        sim = (ctx.get("forecast") or {}).get("sim") or {}
        self.sim = sim.get("teams") or {}

    @staticmethod
    def allplay(week_scores):
        return {f: (sum(1 for g, y in week_scores.items() if g != f and x > y), sum(1 for g, y in week_scores.items() if g != f and x < y))
                for f, x in week_scores.items()}

    def dominance_streak(self, f, scores, upto, kind):
        """Consecutive weeks ending at `upto` in which f beat >= 9 of 11 (dom) or <= 2 (fut)."""
        n = 0
        for w in range(upto, 0, -1):
            ws = scores.get(w)
            if not ws or f not in ws:
                break
            wn = sum(1 for g, y in ws.items() if g != f and ws[f] > y)
            if (kind == "dom" and wn >= 9) or (kind == "fut" and wn <= 2):
                n += 1
            else:
                break
        return n

    def past_ratios(self):
        out = []
        for (season, w), ws in self.past.items():
            avg = sum(ws.values()) / len(ws)
            out += [x / avg for x in ws.values()]
        return out

    def past_team_seasons_streaks(self, kind):
        """[(season, fid, longest streak)] for every past team-season."""
        by_season = {}
        for (season, w), ws in self.past.items():
            by_season.setdefault(season, {})[w] = ws
        out = []
        for season, weeks in by_season.items():
            for f in {f for ws in weeks.values() for f in ws}:
                out.append((season, f, max(self.dominance_streak(f, weeks, w, kind) for w in sorted(weeks))))
        return out

    def past_streaks(self, kind):
        """[length of the streak ending at each past team-week]."""
        out = []
        by_season = {}
        for (season, w), ws in self.past.items():
            by_season.setdefault(season, {})[w] = ws
        for season, weeks in by_season.items():
            for w in sorted(weeks):
                for f in weeks[w]:
                    out.append(self.dominance_streak(f, weeks, w, kind))
        return out


def week_pool(ctx):
    """Every regular-season team-week in the league archive (past seasons, 2010 and incomplete weeks left out) plus this season's weeks so far:
    [{season, week, fid, owner, score, ratio}], ratio = score / that week's league average. Playoff weeks are not in it."""
    arc = ctx.get("archive") or {}
    by = {}
    for season, w, f, x in arc.get("rows") or []:
        by.setdefault((int(season), int(w)), {})[f] = float(x)
    names = {}
    out = []
    for (season, w), ws in sorted(by.items()):
        avg = sum(ws.values()) / len(ws)
        for f, x in sorted(ws.items()):
            out.append({"season": season, "week": w, "fid": f, "owner": (arc.get("owners") or {}).get("%d:%s" % (season, f)), "score": x, "ratio": x / avg, "cur": False})
    xby = {}
    for season, w, f, x in arc.get("extra") or []:             # playoff / consolation weeks in which all 12 teams scored
        xby.setdefault((int(season), int(w)), {})[f] = float(x)
    for (season, w), ws in sorted(xby.items()):
        avg = sum(ws.values()) / len(ws)
        for f, x in sorted(ws.items()):
            out.append({"season": season, "week": w, "fid": f, "owner": (arc.get("owners") or {}).get("%d:%s" % (season, f)), "score": x, "ratio": x / avg,
                        "cur": False, "extra": True})
    week = int(ctx["week"])
    cur = {}
    for r in (ctx.get("history") or {}).get("seasonScores") or []:
        if int(r["week"]) <= week:
            cur.setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r["team_score"])
    cur[week] = {f: float(x) for f, x in ctx["mfl"]["scores"].items()}
    season = int(ctx["season"])
    for w, ws in sorted(cur.items()):
        avg = sum(ws.values()) / len(ws)
        for f, x in sorted(ws.items()):
            out.append({"season": season, "week": w, "fid": f, "owner": ctx["d1"]["franchises"][f]["owner_name"], "score": x, "ratio": x / avg, "cur": True})
    return out


def score_ranks(ctx):
    """For the week's best score: raw rank, share-of-average rank, pool size, and the top-5 lists on both measures."""
    pool = week_pool(ctx)
    week = int(ctx["week"])
    me = max((r for r in pool if r["cur"] and r["week"] == week), key=lambda r: (r["score"], r["fid"]))
    key_raw = lambda r: (-r["score"], r["season"], r["week"], r["fid"])
    key_sh = lambda r: (-round(r["ratio"], 9), r["season"], r["week"], r["fid"])
    raw = sorted(pool, key=key_raw)
    share = sorted(pool, key=key_sh)
    return {"me": me, "n": len(pool), "raw_rank": 1 + sum(1 for r in pool if r["score"] > me["score"] + 1e-9),
            "share_rank": 1 + sum(1 for r in pool if r["ratio"] > me["ratio"] + 1e-9), "raw_top": raw[:5], "share_top": share[:5],
            "first_season": min(r["season"] for r in pool)}


def week_avg(env):
    ws = env.scores[env.week]
    return sum(ws.values()) / len(ws)


# ------------------------------------------------------------------ the triggers
@trigger("allplay_start", "rarity", min_week=4, phases=("middle", "late", "playoffs"))
def t_allplay_start(env):
    import ups_center_story_data as SD
    st = SD.big_story(env.ctx)
    if not st:
        return []
    p = (st["ahead"] + 1) / float(st["pool"] + 1)
    return [{"fid": st["fid"], "s": surprise(p), "p": p, "n": st["pool"], "data": {"story": st},
             "raw": "%s All-Play start, %d earlier team-seasons %s" % ("best" if st["direction"] == "best" else "worst", st["ahead"],
                                                                       "better" if st["direction"] == "best" else "worse")}]


@trigger("week_score", "rarity", min_week=1)
def t_week_score(env):
    """The week's best score, ranked two ways over every regular-season team-week since the archive begins: the raw score (a league record) and
    its share of that week's league average (scoring has risen over the years, so both are shown). p = the better of the two ranks / pool size."""
    if not (env.ctx.get("archive") or {}).get("rows"):
        return []
    r = score_ranks(env.ctx)
    me = r["me"]
    p = min(r["raw_rank"], r["share_rank"]) / float(r["n"])
    return [{"fid": me["fid"], "s": surprise(p), "p": p, "n": r["n"],
             "raw": "best score %.1f: #%d by points and #%d by share of the week's average (%d%%) among %s team-weeks" % (
                 me["score"], r["raw_rank"], r["share_rank"], round(100 * me["ratio"]), "{:,}".format(r["n"])),
             "data": {"ratio": me["ratio"], "avg": me["score"] / me["ratio"], "ranks": r}}]


@trigger("streak", "rarity", min_week=4, phases=("middle", "late", "playoffs"))
def t_streak(env):
    out = []
    for kind in ("dom", "fut"):
        best = max(env.scores[env.week], key=lambda f: (env.dominance_streak(f, env.scores, env.week, kind), f))
        L = env.dominance_streak(best, env.scores, env.week, kind)
        if L < 4:
            continue
        past = env.past_streaks(kind)
        if not past:
            continue
        k = sum(1 for x in past if x >= L)
        longest = env.past_team_seasons_streaks(kind)             # [(season, fid, longest streak)] for every past team-season
        reached = sorted([x for x in longest if x[2] >= L], key=lambda x: (-x[2], x[0], x[1]))
        out.append({"fid": best, "s": surprise(k / float(len(past))), "p": k / float(len(past)), "n": len(past),
                    "raw": "%d straight weeks %s" % (L, "beating 9+ of 11 teams" if kind == "dom" else "losing to 9+ of 11 teams"),
                    "data": {"kind": kind, "L": L, "k": k, "n": len(past), "reached": reached}})
    return out


@trigger("luck_gap", "rarity", min_week=6, phases=("middle", "late", "playoffs"))
def t_luck(env):
    if not env.games:
        return []
    out = []
    games = {}
    for g in env.games:
        if int(g["week"]) <= env.week:
            games.setdefault((int(g["week"]), g["franchise_id"]), []).append(g["result"])
    best = None
    for f in env.scores[env.week]:
        won = exp = var = 0.0
        for w, ws in env.scores.items():
            if f not in ws:
                continue
            wn = sum(1 for g, y in ws.items() if g != f and ws[f] > y) + 0.5 * sum(1 for g, y in ws.items() if g != f and ws[f] == y)
            pr = wn / float(len(ws) - 1)
            for res in games.get((w, f), []):
                won += 1.0 if res == "W" else 0.5 if res == "T" else 0.0
                exp += pr
                var += pr * (1 - pr)
        if var > 0:
            z = (won - exp) / math.sqrt(var)
            if best is None or abs(z) > abs(best[1]):
                best = (f, z, won - exp)
    if best and abs(best[1]) >= 2.5:
        p = 0.5 * math.erfc(abs(best[1]) / math.sqrt(2))
        out.append({"fid": best[0], "s": surprise(p), "p": p, "n": None, "raw": "z = %.1f (%+.1f wins vs the weekly scores' expectation)" % (best[1], best[2]),
                    "data": {"z": best[1], "gap": best[2]}})
    return out


@trigger("division_decider", "stakes", min_week=5, phases=("middle", "late", "playoffs"))
def t_division(env):
    """Uncalibrated (no archived odds): the closer a division's top two are in the forecast, the smaller s."""
    if not env.fresh:
        return []
    by = {}
    for f, t in env.sim.items():
        by.setdefault(t["division"], []).append(f)
    best = None
    for d, fs in by.items():
        fs = sorted(fs, key=lambda f: (-env.sim[f]["div"], f))
        lead, run = fs[0], fs[1]
        if env.sim[lead]["div"] < 0.85 and env.sim[run]["div"] >= 0.15:
            gap = env.sim[lead]["div"] - env.sim[run]["div"]
            s = 0.10 + 0.05 * min(1.0, max(0.0, gap) / 0.7)      # close pairs are common: never stronger than a rare event
            if best is None or s < best["s"]:
                best = {"fid": lead, "s": s, "p": None, "n": None, "raw": "division odds %.1f%% vs %.1f%% (s from the gap; uncalibrated)" % (
                    100 * env.sim[lead]["div"], 100 * env.sim[run]["div"]), "data": {"lead": lead, "runner": run, "division": d}}
    return [best] if best else []


@trigger("bubble", "stakes", min_week=9, phases=("middle", "late", "playoffs"))
def t_bubble(env):
    """The last playoff spot: the 6th and 7th All-Play lines. p = share of past season-weeks (week >= 9) with a gap this small."""
    ws_all = env.scores
    tot = {}
    for w, ws in ws_all.items():
        for f, (a, b) in env.allplay(ws).items():
            t = tot.setdefault(f, [0, 0])
            t[0] += a
            t[1] += b
    if len(tot) < 7:
        return []
    order = sorted(tot, key=lambda f: -tot[f][0] / float(sum(tot[f]) or 1))
    pct = lambda f: tot[f][0] / float(sum(tot[f]) or 1)
    gap = pct(order[5]) - pct(order[6])
    gaps = []
    by = {}
    for (season, w), ws in env.past.items():
        by.setdefault(season, {})[w] = ws
    for season, weeks in by.items():
        run = {}
        for w in sorted(weeks):
            for f, (a, b) in env.allplay(weeks[w]).items():
                t = run.setdefault(f, [0, 0])
                t[0] += a
                t[1] += b
            if w >= 9 and len(run) >= 7:
                o = sorted(run, key=lambda f: -run[f][0] / float(sum(run[f]) or 1))
                gaps.append(run[o[5]][0] / float(sum(run[o[5]])) - run[o[6]][0] / float(sum(run[o[6]])))
    if not gaps:
        return []
    k = sum(1 for x in gaps if x <= gap + 1e-12)
    return [{"fid": order[5], "s": surprise(k / float(len(gaps))), "p": k / float(len(gaps)), "n": len(gaps),
             "raw": "6th vs 7th All-Play gap %.3f" % gap, "data": {"sixth": order[5], "seventh": order[6], "gap": gap, "k": k, "n": len(gaps)}}]


@trigger("odds_swing", "stakes", min_week=1)
def t_odds_swing(env):
    """A team's playoff odds moved 25+ points since last week (20+ against the preseason forecast when there is no prior file)."""
    fc = env.ctx.get("forecast") or {}
    if not env.fresh:
        return []
    prev = (fc.get("prevSim") or {}).get("teams")
    best = None
    for f, t in env.sim.items():
        if prev and f in prev:
            base, basis, floor = prev[f]["po"], "last week", 25.0
        elif t.get("prePo") is not None and env.week <= 4:
            base, basis, floor = t["prePo"], "the preseason forecast", 20.0
        else:
            continue
        move = 100 * (t["po"] - base)
        if abs(move) >= floor and (best is None or abs(move) > abs(best[1])):
            best = (f, move, basis, base, floor)
    if not best:
        return []
    f, move, basis, base, floor = best
    s = max(0.05, 0.15 * (1 - (abs(move) - floor) / 35.0))
    return [{"fid": f, "s": s, "p": None, "n": None, "raw": "playoff odds %+.1f pts vs %s (fixed thresholds; uncalibrated)" % (move, basis),
             "data": {"move": move, "basis": basis, "base": base}}]


def trade_assets(tr):
    return [x for x in tr["a_gave"] + tr["b_gave"] if x["kind"] in ("player", "pick", "bb")]


def trade_deltas(env, tr):
    """{fid: {kind: points moved}} between the forecast built before the trade and the one rerun on the post-trade rosters."""
    pre = ((env.ctx.get("forecastPre") or {}).get("teams")) or {}
    out = {}
    for f in env.sim:
        if f in pre:
            out[f] = {k: 100 * (env.sim[f][k] - pre[f][k]) for k in ("po", "bye", "div", "title")}
    return out


@trigger("big_trade", "stakes", min_week=1)
def t_big_trade(env):
    """A big executed trade (assets moved, salary moved, the playoff / division / title odds it changed). Rarity: the share of the league's
    trades since 2010 (archive) that moved this many assets. Stakes: the largest odds move on the post-trade forecast rerun. s = the smaller."""
    info = env.ctx.get("tradeInfo") or []
    if not info:
        return []
    sizes = (env.ctx.get("archive") or {}).get("tradeSizes") or []
    best = None
    for tr in info:
        n = len(trade_assets(tr))
        rk = sum(1 for x in sizes if x >= n)
        s_r = surprise(rk / float(len(sizes))) if sizes else 1.0
        d = trade_deltas(env, tr)
        m, who = 0.0, tr["a"]
        for f in (tr["a"], tr["b"]):
            for k, v in (d.get(f) or {}).items():
                if abs(v) > m:
                    m, who = abs(v), f
        s_s = max(0.03, 0.15 * (1 - (m - 5.0) / 30.0)) if m >= 5.0 else 1.0
        s = min(s_r, s_s)
        if best is None or s < best["s"]:
            best = {"fid": who, "s": s, "p": rk / float(len(sizes)) if sizes else None, "n": len(sizes),
                    "raw": "%d assets moved, $%s and $%s of salary, largest odds move %.1f points" % (n, "{:,.0f}".format(tr["a_salary"]), "{:,.0f}".format(tr["b_salary"]), m),
                    "data": {"trade": tr, "assets": n, "rank": rk, "pool": len(sizes), "deltas": d, "move": m, "s_rarity": s_r, "s_stakes": s_s}}
    return [best]


@trigger("elias_flip", "single", min_week=1)
def t_elias(env):
    rep = env.ctx.get("eliasReport") or {}
    if rep.get("resultsFlipped"):
        fids = [g["a"] for g in rep.get("games") or [] if g.get("flipped")]
        return [{"fid": (fids or [None])[0], "s": 0.12, "p": None, "n": None, "raw": "%d result(s) flipped by Elias" % rep["resultsFlipped"],
                 "data": {"flipped": rep["resultsFlipped"]}}] if fids else []
    if rep.get("allplayChanged"):
        ch = rep.get("allplayChanges") or []
        return [{"fid": ch[0]["fid"], "s": 0.14, "p": None, "n": None, "raw": "an All-Play game moved by Elias (no result flipped)", "data": {"allplay": True}}] if ch else []
    return []


# ------------------------------------------------------------------ ranking
def adjusted(t, cand, env, prior):
    s = cand["s"]
    ph = phase_of(env.week)
    if env.week >= 11:
        s *= 0.5 if t["kind"] == "stakes" else 1.5 if t["kind"] == "rarity" else 1.0
    last = next((x for x in prior or [] if x.get("week") == env.week - 1), None)
    if last and last.get("fid") == cand["fid"] and last.get("trigger") == t["id"] and s > 0.7 * last.get("s", 1.0):
        s *= 3
    return s


def evaluate(ctx, prior=None):
    env = Env(ctx)
    ph = phase_of(env.week)
    out = []
    for t in REGISTRY:
        if env.week < t["min_week"] or ph not in t["phases"]:
            if not (ph == "early" and t["id"] in ("week_score", "odds_swing", "elias_flip")):
                continue
        for cand in t["fn"](env) or []:
            if cand["fid"] is None:
                continue
            out.append({"trigger": t["id"], "kind": t["kind"], "fid": cand["fid"], "s": cand["s"], "adj": adjusted(t, cand, env, prior),
                        "data": cand["data"]})
    return sorted(out, key=lambda x: (x["adj"], x["trigger"], x["fid"])), env


def pick(ctx, prior=None):
    """{"phase", "lead", "support": [...], "fired": [...], "fallback": phase name or None}. lead = the merged story of the
    lowest-s subject: {"fid", "headline": trigger dict, "evidence": [other triggers about the same team]}."""
    ranked, env = evaluate(ctx, prior)
    fired = [x for x in ranked if x["adj"] <= FIRE]
    ph = phase_of(env.week)
    if not fired:
        return {"phase": ph, "lead": None, "support": [], "fired": [], "fallback": "early" if ph == "early" else "middle" if ph == "middle" else "late",
                "considered": ranked[:5]}
    top = fired[0]
    group = [x for x in fired if x["fid"] == top["fid"]]
    rest = [x for x in fired if x["fid"] != top["fid"]]
    return {"phase": ph, "lead": {"fid": top["fid"], "headline": group[0], "evidence": group[1:]}, "support": rest[:3], "fired": fired,
            "fallback": None, "considered": ranked[:5]}


def trace(ctx, prior=None):
    """EVERY trigger evaluated this week, fired or not, with the reasoning: [{trigger, kind, fid, raw, p, n, s, gate, weight, ledger, adj,
    fired, group, rank}] plus {"why_winner", "why_runner_up"}. Used by the preview's picker page; pick() is the production path."""
    env = Env(ctx)
    ph = phase_of(env.week)
    names = {f: r["owner_name"] for f, r in ctx["d1"]["franchises"].items()}
    rows = []
    for t in REGISTRY:
        gate = None
        if env.week < t["min_week"]:
            gate = "blocked: needs week %d or later" % t["min_week"]
        elif ph not in t["phases"] and not (ph == "early" and t["id"] in ("week_score", "odds_swing", "elias_flip")):
            gate = "blocked: not allowed to lead in the %s phase" % ph
        try:
            cands = t["fn"](env) or []
        except Exception as exc:                              # a trigger the inputs cannot support
            cands = []
            gate = gate or "no input: %s" % type(exc).__name__
        if not cands:
            rows.append({"trigger": t["id"], "kind": t["kind"], "fid": None, "raw": "no candidate", "p": None, "n": None, "s": None, "gate": gate or
                         ("needs a forecast file for this week" if t["kind"] == "stakes" else "nothing passed this trigger's own threshold"),
                         "weight": 1.0, "ledger": 1.0, "adj": None, "fired": False})
            continue
        for c in cands:
            w = 1.0
            if env.week >= 11:
                w = 0.5 if t["kind"] == "stakes" else 1.5 if t["kind"] == "rarity" else 1.0
            adj = adjusted(t, c, env, prior)
            led = adj / (c["s"] * w) if c["s"] and w else 1.0
            rows.append({"trigger": t["id"], "kind": t["kind"], "fid": c["fid"], "owner": names.get(c["fid"]), "raw": c.get("raw"), "p": c.get("p"), "n": c.get("n"),
                         "s": c["s"], "gate": gate, "weight": w, "ledger": round(led, 2), "adj": adj, "fired": gate is None and adj <= FIRE})
    fired = sorted([r for r in rows if r["fired"]], key=lambda r: (r["adj"], r["trigger"]))
    for i, r in enumerate(fired):
        r["rank"] = i + 1
    for r in rows:
        r.setdefault("rank", None)
        r["group"] = (names.get(r["fid"]) if r.get("fid") and r["fired"] else None)
    win = fired[0] if fired else None
    why_w = why_r = None
    if win:
        ev = [r["trigger"] for r in fired[1:] if r["fid"] == win["fid"]]
        why_w = "%s's %s had the lowest adjusted surprise score of the %d trigger(s) that fired (s = %.3f)%s." % (
            win["owner"], win["trigger"], len(fired), win["adj"], (", and %s merged into the same story as evidence" % ", ".join(ev)) if ev else "")
        other = [r for r in fired[1:] if r["fid"] != win["fid"]]
        if other:
            o = other[0]
            why_r = "%s's %s fired (s = %.3f) but its score was higher than %.3f, so it is a supporting beat, not the lead." % (o["owner"], o["trigger"], o["adj"], win["adj"])
        else:
            cand = sorted([r for r in rows if r["s"] is not None and not r["fired"]], key=lambda r: r["adj"] if r["adj"] is not None else 9)
            if cand:
                o = cand[0]
                why_r = "The nearest other trigger, %s%s, did not fire: %s." % (o["trigger"], (" for " + o["owner"]) if o.get("owner") else "",
                                                                             o["gate"] or "its adjusted score %.3f is above the %.2f line" % (o["adj"], FIRE))
    else:
        cand = sorted([r for r in rows if r["s"] is not None], key=lambda r: r["adj"] if r["adj"] is not None else 9)
        why_w = "Nothing fired, so the %s-phase fallback story runs." % ph
        if cand:
            o = cand[0]
            why_r = "Closest: %s%s at s = %.3f%s." % (o["trigger"], (" for " + o["owner"]) if o.get("owner") else "", o["adj"] if o["adj"] is not None else o["s"],
                                                      (" (" + o["gate"] + ")") if o["gate"] else ", above the %.2f line" % FIRE)
    return {"phase": ph, "week": env.week, "rows": rows, "why_winner": why_w, "why_runner_up": why_r}
