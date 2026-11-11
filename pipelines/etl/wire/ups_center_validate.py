#!/usr/bin/env python3
"""Check a UPS Center draft against its sources (Keith 2026-10-08: "Validate every score,
record, projection timestamp, quote link and derived claim against its source").

validate(result, ctx, pack) takes ups_center_issue.render()'s output and the snapshot
from ups_center_sources.gather(), which was fetched independently of the pack:

  score / margin / week all-play   MFL weeklyResults for the week
  record / all-play / points for   MFL leagueStandings
  projection                       D1 ups_player_projections: the value, its capture
                                   time, and that the capture came BEFORE the player's
                                   own kickoff (MFL nflSchedule). A postgame capture fails.
  quote                            D1 ups_discord_messages by message id, verbatim; the
                                   link must point at that message; sensitive lines fail
  post counts                      recounted from the same window
  pack facts                       equal to the pack the draft was built from
  every number on the page         must be the printed form of a registered claim
  every gap                        must have its visible EDITOR REVIEW box

check_editor_draft(html, ctx, scores_published) re-checks a draft an editor has
taken over (the automation never overwrites one): its quotes, and whether MFL's
scores have moved since the draft's numbers were frozen -- the changed claims.
"""
import html as H
import re
from datetime import datetime, timezone

import chat_exclusions
import season_sim  # display_percentages, the rounding the Playoff Picture prints
import ups_center_prob as PROB  # 100% / 0% only for a clinched / eliminated outcome

TIME_RE = re.compile(r"\bW(?:ee)?ks?\.?\s+\d{1,2}(?:\s*[–-]\s*\d{1,2})?\b|\b(?:19|20)\d\d\s*[–-]\s*(?:19|20)\d\d\b|"
                     r"\b\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)\b|\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s+"
                     r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}\b|\bWeek\s+\d{1,2}\b|\b20\d\d\b|"
                     r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2}\b")
NUM_RE = re.compile(r"(?<![\w.])[-+−]?\d[\d,]*(?:\.\d+)?")
SPELLED_OK = {"eleven"}


def visible_text(doc):
    body = doc[doc.index("<body"):]
    body = re.sub(r"<script[\s\S]*?</script>", " ", body)
    body = re.sub(r"<style[\s\S]*?</style>", " ", body)
    body = re.sub(r'<a class="rcpt"[^>]*>[\s\S]*?</a>', " ", body)          # quotes are checked on their own
    return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", body)))


def _close(a, b, tol=0.05):
    return abs(float(a) - float(b)) <= tol


def _unwrap(shown):
    """Remove the ONE pair of quote marks the renderer wraps a quote in -- never the
    message's own (a post that itself starts and ends with curly quotes stays verbatim)."""
    s = shown.strip()
    return s[1:-1] if len(s) >= 2 and s[0] == "\u201c" and s[-1] == "\u201d" else s


PLAYOFF_FIELD, PLAYOFF_BYES = 6, 2    # league_context F.1


def forecast_inconsistent(ctx, week):
    """Independent of ups_center_issue.forecast_inconsistencies: works in whole simulated seasons.
    Each stored probability is count/runs rounded to four decimals, so up to 10,000 runs the counts
    are recovered exactly and every total must match exactly; above that, to the stored precision."""
    fc = ctx.get("forecast") or {}
    sim, prev = fc.get("sim") or {}, fc.get("preview") or {}
    runs, teams = sim.get("runs"), sim.get("teams") or {}
    if not isinstance(runs, int) or runs <= 0 or not teams:
        return ["no simulated-season count or no teams"]
    n = {f: {k: int(round(t[k] * runs)) for k in ("po", "bye", "div", "title")} for f, t in teams.items()}
    slack = lambda terms: 0 if runs <= 10000 else int(terms * runs * 0.00005) + 1
    out = []
    for k, want in (("po", PLAYOFF_FIELD), ("bye", PLAYOFF_BYES), ("title", 1)):
        if abs(sum(x[k] for x in n.values()) - want * runs) > slack(len(n)):
            out.append("%s seasons total %d, expected %d" % (k, sum(x[k] for x in n.values()), want * runs))
    by_div = {}
    for f, t in teams.items():
        by_div.setdefault(t["division"], []).append(f)
    for d, fs in sorted(by_div.items()):
        if abs(sum(n[f]["div"] for f in fs) - runs) > slack(len(fs)):
            out.append("division %s titles total %d of %d seasons" % (d, sum(n[f]["div"] for f in fs), runs))
    for f, x in sorted(n.items()):
        if not (x["bye"] <= x["div"] <= x["po"] and x["title"] <= x["po"]):
            out.append("%s bye %d / division %d / playoffs %d / title %d out of order" % (f, x["bye"], x["div"], x["po"], x["title"]))
    try:
        taken = datetime.strptime(str(prev.get("inputsAtUtc") or prev.get("generatedAtUtc")), "%Y-%m-%dT%H:%M:%SZ")
        taken = taken.replace(tzinfo=timezone.utc).timestamp()
    except ValueError:
        taken = 0
    current = (prev.get("throughWeek") == week and prev.get("week") == week + 1
               and taken >= ctx["timing"]["finalAt"])      # a stale preview is the issue's own blocker
    if current:
        tot = prev.get("scenarioTotals") or {}
        for f, x in sorted(n.items()):
            c = tot.get(f) or {}
            got = (c.get("runs"), c.get("playoff"), c.get("division"), c.get("bye"))
            if runs <= 10000 and got != (runs, x["po"], x["div"], x["bye"]):
                out.append("%s scenario cells %s, forecast %s" % (f, got, (runs, x["po"], x["div"], x["bye"])))
    return out


RULES = {"dom": 28, "of": 33, "sink": 5, "c90": 90, "c60": 60, "c25": 25, "c8": 8}


def _season_truth(ctx):
    """Builder B, recomputed here WITHOUT ups_center_stories: {(kind, fid): value} for every Heat Check
    and Survival Line number, straight from ctx["history"] (D1 rows + the bracket API's fields)."""
    h = ctx.get("history")
    if not h:
        return {}
    n = int(h["week"])
    score, opt = {}, {}
    for r in h["seasonScores"]:
        score[(int(r["week"]), r["franchise_id"])] = float(r["team_score"])
        opt[(int(r["week"]), r["franchise_id"])] = float(r["team_opt_pts"] or 0)
    weeks = sorted({w for w, _ in score})
    fids = sorted({f for _, f in score})
    def ap_week(w, f):
        mine = score[(w, f)]
        others = [score[(w, g)] for g in fids if g != f]
        return sum(x < mine for x in others), sum(x > mine for x in others), sum(x == mine for x in others)
    last = [w for w in weeks if w >= n - 2]
    first = [w for w in weeks if w <= n - 3]
    def rank_in(ws):
        ppw = {f: sum(score[(w, f)] for w in ws) / len(ws) for f in fids}
        return {f: 1 + sum(ppw[g] > ppw[f] for g in fids) for f in fids}
    rl, rf = rank_in(last), (rank_in(first) if first else {})
    res = {}
    for g in h["seasonGames"]:
        res.setdefault((int(g["week"]), g["franchise_id"]), []).append((g["opponent_franchise_id"], g["result"]))
    out = {}
    for f in fids:
        a3 = [ap_week(w, f) for w in last]
        at = [ap_week(w, f) for w in weeks]
        out[("ap3", f)] = "%d-%d" % (sum(x[0] for x in a3), sum(x[1] for x in a3))
        out[("ap", f)] = "%d-%d" % (sum(x[0] for x in at), sum(x[1] for x in at))
        out[("rkLast", f)] = rl[f]
        if rf:
            out[("rkFirst", f)] = rf[f]
        out[("bench", f)] = round(sum(opt[(w, f)] - score[(w, f)] for w in weeks) / len(weeks), 1)
        losses = [(w, o) for w in weeks for o, r in res.get((w, f), []) if r == "L"]
        out[("losses", f)] = len(losses)
        out[("lostBest", f)] = sum(opt[(w, f)] > score[(w, o)] for w, o in losses)
        won = sum(1.0 if r == "W" else 0.5 if r == "T" else 0.0 for w in weeks for _, r in res.get((w, f), []))
        exp = sum((ap_week(w, f)[0] + 0.5 * ap_week(w, f)[2]) / (len(fids) - 1) * len(res.get((w, f), [])) for w in weeks)
        out[("luck", f)] = round(won - exp, 1)
    # survival history
    made = {int(s): set(v) for s, v in h["made"].items()}
    def pair(rk):
        return (rk + 1) // 2
    ap_tot = {f: sum(ap_week(w, f)[0] + 0.5 * ap_week(w, f)[2] for w in weeks) for f in fids}
    my_pair = {f: pair(1 + sum(ap_tot[g] > ap_tot[f] for g in fids)) for f in fids}
    past = {}
    for r in h["pastScores"]:
        past.setdefault(int(r["season"]), {}).setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r["team_score"])
    grp = {}
    for s, wk in past.items():
        tot = {}
        for w, sc in wk.items():
            for f, x in sc.items():
                tot[f] = tot.get(f, 0.0) + sum(y < x for g, y in sc.items() if g != f) + 0.5 * sum(y == x for g, y in sc.items() if g != f)
        for f in tot:
            k = pair(1 + sum(tot[g] > tot[f] for g in tot))
            m, c = grp.get(k, (0, 0))
            grp[k] = (m + (f in made[s]), c + 1)
    dec = {}
    for g in h["seasonGames"]:
        d = dec.setdefault(g["franchise_id"], [0.0, 0])
        d[0] += 1.0 if g["result"] == "W" else 0.5 if g["result"] == "T" else 0.0
        d[1] += 1
    games = max(d[1] for d in dec.values())
    cuts = [int(round(k * games / 13.0)) for k in (10, 8, 6, 4)]
    def band(wins):
        return sum(wins < c for c in cuts)            # 0 = top band ... 4 = bottom band
    pres = {}
    for r in h["pastResults"]:
        d = pres.setdefault((int(r["season"]), r["franchise_id"]), [0.0, 0])
        d[0] += 1.0 if r["result"] == "W" else 0.5 if r["result"] == "T" else 0.0
        d[1] += 1
    wgrp = {}
    for (s, f), (wn, dn) in pres.items():
        if dn == games:
            m, c = wgrp.get(band(wn), (0, 0))
            wgrp[band(wn)] = (m + (f in made[s]), c + 1)
    for f in fids:
        out[("apMade", f)], out[("apN", f)] = grp.get(my_pair[f], (0, 0))
        out[("winMade", f)], out[("winN", f)] = wgrp.get(band(dec.get(f, [0.0])[0]), (0, 0))
    return out


def _archive_truth(ctx):
    """Story format (2026-11-05): every `arch:*` number recomputed from ctx["archive"]["rows"] (weekly scores) with code
    that shares nothing with ups_center_story_data. {key-suffix: value}; direction-dependent counts are {"either": (best, worst)}."""
    arc, wk = ctx.get("archive"), int(ctx["week"])
    if not arc:
        return {}
    sc = {}
    for season, w, f, x in arc["rows"]:
        if w <= wk:
            sc.setdefault((int(season), int(w)), {})[f] = float(x)
    tally = {}
    for (season, w), d in sc.items():
        for f, x in d.items():
            t = tally.setdefault((season, f), [0, 0])
            for g, y in d.items():
                if g != f:
                    t[0] += x > y
                    t[1] += x < y
    out = {"n": len(tally)}
    full = arc.get("full") or {}
    fpct = {k: v["ap"][0] / float(sum(v["ap"])) for k, v in full.items() if sum(v["ap"])}
    bestfull = max(fpct, key=lambda k: (fpct[k], k)) if fpct else None
    for k, v in full.items():
        out["fullrec:" + k] = "%d-%d" % tuple(v["rec"])
        out["fullap:" + k] = "%d-%d" % tuple(v["ap"])
        out["fullbest:" + k] = (k == bestfull)
    pcts = {k: v[0] / float(v[0] + v[1]) for k, v in tally.items()}
    for (season, f), (a, b) in tally.items():
        k = "%d:%s" % (season, f)
        out["ap:" + k] = "%d-%d" % (a, b)
        out["pct:" + k] = round(pcts[(season, f)], 3)
        if k in arc["final"]:
            out["final:" + k] = arc["final"][k]
    for f, st in ctx["mfl"]["standings"].items():
        a, b = (int(x) for x in st["allplay"].split("-")[:2])
        p = a / float(a + b) if a + b else 0.0
        out["pct:cur:" + f] = round(p, 3)
        out["ahead:" + f] = {"either": (sum(1 for q in pcts.values() if q > p + 1e-12), sum(1 for q in pcts.values() if q < p - 1e-12))}
        s_ = ctx["mfl"]["scores"]
        wkw, wkl = sum(1 for g in s_ if g != f and s_[f] > s_[g]), sum(1 for g in s_ if g != f and s_[f] < s_[g])
        pw, pl = a - wkw, b - wkl
        out["prev:" + f] = "%d-%d" % (pw, pl)
        if pw + pl and wk > 1:
            pp = pw / float(pw + pl)
            prior = {}
            for (season, w), d in sc.items():
                if w <= wk - 1:
                    for g, x in d.items():
                        t = prior.setdefault((season, g), [0, 0])
                        for h, y in d.items():
                            if h != g:
                                t[0] += x > y
                                t[1] += x < y
            ppct = [t[0] / float(t[0] + t[1]) for t in prior.values() if t[0] + t[1]]
            out["prevbelow:" + f] = sum(1 for q in ppct if q < pp - 1e-12)
        out["atbelow:" + f] = sum(1 for q in pcts.values() if q <= p + 1e-12)
        owner = ctx["d1"]["franchises"][f]["owner_name"]
        mine = sorted(((pcts[k], k[0]) for k in pcts if arc["owners"].get("%d:%s" % k) == owner), key=lambda x: (x[0], x[1]))
        if len(mine) >= 3:
            hi = max(mine, key=lambda x: (x[0], -x[1]))
            lo = mine[0]
            for tag, (pc, season) in (("ownbest", hi), ("ownworst", lo)):
                key = [k for k in tally if k[0] == season and pcts[k] == pc and arc["owners"].get("%d:%s" % k) == owner][0]
                out["%s:%s" % (tag, f)] = "%d:%d-%d" % (season, tally[key][0], tally[key][1])
    return out


def _trig_truth(ctx):
    """Big Story trigger numbers (ups_center_story_triggers), recomputed here from the archive rows and this season's scores."""
    wk = int(ctx["week"])
    cur = {}
    for r in (ctx.get("history") or {}).get("seasonScores") or []:
        if int(r["week"]) <= wk:
            cur.setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r["team_score"])
    cur[wk] = {f: float(x) for f, x in ctx["mfl"]["scores"].items()}
    arc = ctx.get("archive") or {}
    past = {}
    for season, w, f, x in arc.get("rows") or []:
        past.setdefault(int(season), {}).setdefault(int(w), {})[f] = float(x)
    out = {}
    # every regular-season team-week: past seasons (archive) + this season's weeks so far, ranked by points and by share of that week's average
    tw = []
    for season, weeks in past.items():
        for w, ws in weeks.items():
            a_ = sum(ws.values()) / len(ws)
            tw += [(x, x / a_, season, w, "past:" + season_f) for season_f, x in ws.items()]
    for w, ws in cur.items():
        a_ = sum(ws.values()) / len(ws)
        tw += [(x, x / a_, int(ctx["season"]), w, "cur:" + f_) for f_, x in ws.items()]
    avg = sum(cur[wk].values()) / len(cur[wk])
    owners = {f_: r["owner_name"] for f_, r in ctx["d1"]["franchises"].items()}
    aown = (arc.get("owners") or {})
    out["recn"] = len(tw)
    for f, x in cur[wk].items():
        out["ratio:" + f] = round(100 * x / avg, 1)
        out["avg:" + f] = round(avg, 1)
        out["recraw:" + f] = 1 + sum(1 for t in tw if t[0] > x + 1e-9)
        out["recshare:" + f] = 1 + sum(1 for t in tw if t[1] > x / avg + 1e-9)

    def who(t):
        kind, _, fid = t[4].partition(":")
        return owners.get(fid) if kind == "cur" else aown.get("%d:%s" % (t[2], fid))
    byraw = sorted(tw, key=lambda t: (-t[0], t[2], t[3], t[4].partition(":")[2]))
    bysh = sorted(tw, key=lambda t: (-round(t[1], 9), t[2], t[3], t[4].partition(":")[2]))
    for i, t in enumerate(byraw[:5]):
        out["rawtop:%d" % i] = {"owner": who(t), "season": t[2], "week": t[3], "score": round(t[0], 1), "pct": round(100 * t[1], 1)}
    for i, t in enumerate(bysh[:5]):
        out["sharetop:%d" % i] = {"owner": who(t), "season": t[2], "week": t[3], "score": round(t[0], 1), "pct": round(100 * t[1], 1)}

    def streak(weeks, f, upto, kind):
        n = 0
        for w in range(upto, 0, -1):
            if w not in weeks or f not in weeks[w]:
                break
            beat = sum(1 for g, y in weeks[w].items() if g != f and weeks[w][f] > y)
            if (beat >= 9) if kind == "dom" else (beat <= 2):
                n += 1
            else:
                break
        return n
    for kind in ("dom", "fut"):
        pst = [streak(weeks, f, w, kind) for weeks in past.values() for w in weeks for f in weeks[w]]
        for f in cur[wk]:
            L = streak(cur, f, wk, kind)
            out["streak:%s:%s" % (kind, f)] = L
            out["streakk:%s:%s" % (kind, f)] = sum(1 for q in pst if q >= L)
            out["streakn:%s:%s" % (kind, f)] = len(pst)
    fc = ctx.get("forecast") or {}
    teams = (fc.get("sim") or {}).get("teams") or {}
    prev = (fc.get("prevSim") or {}).get("teams") or {}
    for f, t in teams.items():
        base = prev[f]["po"] if f in prev else t.get("prePo")
        if base is not None:
            out["move:" + f] = round(abs(100 * (t["po"] - base)), 1)
    return out


def _table_counts(ctx, truth):
    """champs / runnerup / tablek for both directions of the Big Story table: {"champs": {(k, c)...}}."""
    arc, wk = ctx.get("archive"), int(ctx["week"])
    if not arc:
        return {}
    res = {}
    keys = sorted(((float(truth["pct:" + k]), k) for k in (kk[len("pct:"):] for kk in truth if kk.startswith("pct:") and ":cur:" not in kk
                                                          and not kk.startswith("pct:cur"))), key=lambda x: x[0])
    for f in ctx["mfl"]["standings"]:
        me = truth.get("pct:cur:" + f)
        if me is None:
            continue
        for tag, order in (("best", sorted([x for x in keys], key=lambda x: -x[0])), ("worst", keys)):
            merged = sorted(order + [(me, None)], key=lambda x: (-x[0] if tag == "best" else x[0], x[1] is not None))[:5]
            others = [k for _, k in merged if k]
            fin = [truth.get("final:" + k) for k in others]
            res.setdefault(f, []).append((len(others), sum(1 for x in fin if x == 1), sum(1 for x in fin if x == 2)))
    return res


def _elias_check(rest, v, ctx, bad, key):
    rep, pub = ctx.get("eliasReport") or {}, ctx.get("scoresPublished") or {}
    s, st = ctx["mfl"]["scores"], ctx["mfl"]["standings"]
    what, _, tail = rest.partition(":")
    if what == "count":
        off = rep.get("officialChanges")
        want = len(off) if isinstance(off, list) else off
        if v != want and v != len(ctx["mfl"].get("elias") or []):
            bad(key, "page %s, Elias report %s" % (v, want))
        return
    if what == "flipped":
        if v != rep.get("resultsFlipped"):
            bad(key, "page %s, report %s" % (v, rep.get("resultsFlipped")))
        return
    if what == "stat":
        pid, _, rest2 = tail.partition(":")
        stat, _, side = rest2.rpartition(":")
        pl = [p for p in rep.get("players") or [] if p.get("pid") == pid]
        ch = next((c for c in (pl[0].get("elias") or []) if c.get("stat") == stat), {}) if pl else {}
        if not pl or ch.get(side) != v:
            bad(key, "Elias report has %r" % ch)
        return
    if what == "rank":
        r = [c for c in rep.get("rankChanges") or [] if c["fid"] == tail]
        if not r or r[0]["after"] != v:
            bad(key, "Elias report has %r" % r)
        return
    if what == "gap":
        side, _, mover = tail.partition(":")
        teams0 = (pub or {}).get("teams") or {}
        ch = {c["fid"]: c for c in rep.get("allplayChanges") or []}
        other = [f for f in ch if f != mover]
        if mover not in teams0 or not other:
            bad(key, "cannot recompute the gap")
            return
        o = other[0]
        want = abs(s[o] - (teams0[mover] if side == "before" else s[mover]))
        if abs(round(want, 1) - v) > 0.05:
            bad(key, "page %s, recomputed %.1f" % (v, want))
        return
    if what == "delta" and tail not in s:                         # a player's fantasy change
        pl = [p for p in rep.get("players") or [] if p.get("pid") == tail]
        if not pl or abs(round(pl[0]["delta"], 1) - v) > 0.05:
            bad(key, "Elias report has %r" % pl[:1])
        return
    teams = pub.get("teams")
    if not teams or tail not in teams:
        bad(key, "no frozen published scores to check against")
        return
    f = tail
    if what == "before":
        if abs(teams[f] - v) > 0.05:
            bad(key, "page %s, frozen published score %s" % (v, teams[f]))
    elif what == "delta":
        if abs(round(s[f] - teams[f], 1) - v) > 0.05:
            bad(key, "page %s, MFL minus published %s" % (v, round(s[f] - teams[f], 1)))
    elif what in ("wkapBefore", "apBefore"):
        old = dict(s)
        old.update(teams)
        w0 = sum(1 for o in old if o != f and old[o] < old[f])
        l0 = sum(1 for o in old if o != f and old[o] > old[f])
        if what == "wkapBefore":
            want = "%d-%d" % (w0, l0)
        else:
            w1 = sum(1 for o in s if o != f and s[o] < s[f])
            l1 = sum(1 for o in s if o != f and s[o] > s[f])
            a, b = (int(x) for x in st[f]["allplay"].split("-")[:2])
            want = "%d-%d" % (a - w1 + w0, b - l1 + l0)
        if v != want:
            bad(key, "page %s, recomputed %s" % (v, want))
    else:
        bad(key, "unknown elias claim")


def validate(res, ctx, pack):
    errors, warnings, n = [], [], {}
    s, st = ctx["mfl"]["scores"], ctx["mfl"]["standings"]
    facts = {f["id"]: f["value"] for f in pack["facts"]}
    chat = {m["message_id"]: m for m in ctx["d1"]["chat"]}
    projections = ctx["d1"]["projections"]
    kick = ctx["timing"]["kickoffs"]
    basis = ctx["evidence"]["basis"]

    def bad(key, why):
        errors.append("%s: %s" % (key, why))

    for key, c in res["claims"].items():
        kind, _, rest = key.partition(":")
        v = c["value"]
        n[kind] = n.get(kind, 0) + 1
        if kind == "score":
            if rest not in s or not _close(v, s[rest]):
                bad(key, "draft says %s, MFL says %s" % (v, s.get(rest)))
        elif kind == "margin":
            w, l = rest.split(":")
            if not (s[w] > s[l] and _close(v, s[w] - s[l])):
                bad(key, "draft says %s beat %s by %s; MFL %s-%s" % (w, l, v, s[w], s[l]))
        elif kind == "wkap":
            w = sum(1 for o in s if o != rest and s[o] < s[rest])
            l = sum(1 for o in s if o != rest and s[o] > s[rest])
            if v != "%d-%d" % (w, l):
                bad(key, "draft %s, recomputed %d-%d" % (v, w, l))
        elif kind == "rec":
            if v != "%d-%d" % (st[rest]["h2hw"], st[rest]["h2hl"]):
                bad(key, "draft %s, MFL %d-%d" % (v, st[rest]["h2hw"], st[rest]["h2hl"]))
        elif kind == "ap":
            if not st[rest]["allplay"].startswith(v + "-"):
                bad(key, "draft %s, MFL %s" % (v, st[rest]["allplay"]))
        elif kind == "pf":
            if not _close(v, st[rest]["pf"]):
                bad(key, "draft %s, MFL %s" % (v, st[rest]["pf"]))
        elif kind == "proj":
            row = projections.get(rest)
            if not row:
                bad(key, "no D1 projection row")
                continue
            if basis == "first_pregame_fallback":
                want, cap = row["first_projected"], row["first_captured_at"]
            else:
                want, cap = v["value"], v["captured"]          # last-pregame may come from a frozen record
            team = (ctx["d1"]["players"].get(rest) or {}).get("nfl_team")
            if want is None or not _close(v["value"], want):
                bad(key, "printed projection %s, D1 %s" % (v["value"], want))
            if cap is None or int(cap) != int(v["captured"]):
                bad(key, "capture time %s does not match D1 %s" % (v["captured"], cap))
            if team not in kick or int(kick[team]) != int(v["kickoff"]):
                bad(key, "kickoff %s does not match MFL nflSchedule for %s" % (v["kickoff"], team))
            if not int(v["captured"]) < int(v["kickoff"]):
                bad(key, "POSTGAME projection: captured %s, kickoff %s" % (v["captured"], v["kickoff"]))
        elif kind == "quote":
            m = chat.get(rest)
            if not m:
                bad(key, "message not in ups_discord_messages for the window")
            elif " ".join((m["content"] or "").split()) != v:
                bad(key, "quote is not verbatim")
            elif chat_exclusions.reason(rest, v):
                bad(key, "quote may not be used: %s" % chat_exclusions.reason(rest, v))
        elif kind == "posts":
            cnt = len(ctx["d1"]["chat"]) if rest == "total" else sum(1 for m in ctx["d1"]["chat"] if m["owner_name"] == rest)
            if v != cnt:
                bad(key, "draft %s, recount %s" % (v, cnt))
        elif kind == "fact":
            if facts.get(rest) != v:
                bad(key, "pack has %r" % facts.get(rest))
        elif kind == "record":
            rb = (ctx["d1"].get("recordBook") or {}).get("combinedGames") or []
            if not rb or not _close(v, rb[0]["combined"]):
                bad(key, "record book %r" % rb[:1])
        elif kind == "grade":
            fav = re.sub(r"\s*\(\d+%\)$", "", v["fav"])
            other = [o for o in v["game"].split(" vs ") if o != fav]
            byname = {r["owner_name"]: f for f, r in ctx["d1"]["franchises"].items()}
            try:
                a, b = (float(x) for x in v["final"].split("-"))
                fa, fb = byname[fav], byname[other[0]]
            except (ValueError, KeyError, IndexError):
                bad(key, "cannot read %r" % v)
                continue
            if not (_close(a, s[fa]) and _close(b, s[fb])):
                bad(key, "graded final %s, MFL %s-%s" % (v["final"], s[fa], s[fb]))
            if (v["called"] == "yes") != (s[fa] > s[fb]):
                bad(key, "'called it' is %s but MFL has %s %s-%s" % (v["called"], fav, s[fa], s[fb]))
        elif kind == "odds":
            # Builder A: every printed probability equals the job's forecast file under the documented rounding.
            sim = ((ctx.get("forecast") or {}).get("sim") or {})
            teams = sim.get("teams") or {}
            what, _, fid = rest.partition(":")
            flags = (ctx.get("clinch") or {}).get("byFid") or {}
            if what == "floor":
                if v != PROB.FLOOR_PCT:
                    bad(key, "the smallest printed probability is %s, page %s" % (PROB.FLOOR_PCT, v))
            elif what == "runs":
                if v != sim.get("runs"):
                    bad(key, "forecast runs %s, page %s" % (sim.get("runs"), v))
            elif fid not in teams:
                bad(key, "no forecast row for %s" % fid)
            elif what in ("prevpo", "prepo"):
                fc_ = ctx.get("forecast") or {}
                base = ((fc_.get("prevSim") or {}).get("teams") or {}).get(fid, {}).get("po") if what == "prevpo" else teams[fid].get("prePo")
                if base is None or abs(PROB.value(base) - v) > 1e-9 or c.get("shown") != PROB.text(base):
                    bad(key, "forecast base %s prints %s, page %s" % (base, PROB.text(base) if base is not None else None, c.get("shown")))
            elif what in ("po", "bye"):
                want_t, want_v = PROB.single(teams[fid][what], what, flags.get(fid))
                if abs(want_v - v) > 1e-9 or c.get("shown") != want_t:
                    bad(key, "forecast %s %.4f prints %s, page %s (%s)" % (what, teams[fid][what], want_t, c.get("shown"), v))
            elif what == "div":
                grp = {f: t_["div"] for f, t_ in teams.items() if t_["division"] == teams[fid]["division"]}
                cells = PROB.group_cells(grp, season_sim.display_percentages(grp), {f for f in grp if PROB.certain("div", flags.get(f))[0]},
                                         {f for f in grp if PROB.certain("div", flags.get(f))[1]})
                if abs(cells[fid][1] - v) > 1e-9 or c.get("shown") != cells[fid][0]:
                    bad(key, "division odds %s (%s) do not match the forecast's rounding and certainty rule (%s)" % (v, c.get("shown"), cells[fid][0]))
            elif what == "title":
                tp = {f: t_["title"] for f, t_ in teams.items()}
                cells = PROB.group_cells(tp, season_sim.display_percentages(tp), set(), {f for f in tp if PROB.certain("title", flags.get(f))[1]})
                if abs(cells[fid][1] - v) > 1e-9 or c.get("shown") != cells[fid][0]:
                    bad(key, "title odds %s (%s) do not match the forecast's rounding and certainty rule (%s)" % (v, c.get("shown"), cells[fid][0]))
            else:
                bad(key, "unknown odds claim")
        elif kind in ("heat", "hist"):
            truth = n.setdefault("_season_truth", _season_truth(ctx))
            what, _, fid = rest.partition(":")
            if (what, fid) not in truth:
                bad(key, "no %s value for %s in the season snapshot" % (what, fid))
            elif truth[(what, fid)] != v:
                bad(key, "page %r, recomputed %r" % (v, truth[(what, fid)]))
        elif kind == "rule":
            if RULES.get(rest) != v:
                bad(key, "definition %s is %s, page %s" % (rest, RULES.get(rest), v))
        elif kind == "elias":
            _elias_check(rest, v, ctx, bad, key)
        elif kind == "trig":
            truth = n.setdefault("_trig_truth", _trig_truth(ctx))
            if rest not in truth:
                bad(key, "no recomputed value for %s" % rest)
            elif isinstance(truth[rest], dict):
                if not (isinstance(v, dict) and all(v.get(k) == truth[rest][k] or (isinstance(v.get(k), float) and abs(v[k] - truth[rest][k]) < 0.05) for k in truth[rest])):
                    bad(key, "page %r, recomputed %r" % (v, truth[rest]))
            elif abs(float(truth[rest]) - float(v)) > 0.05:
                bad(key, "page %r, recomputed %r" % (v, truth[rest]))
        elif kind == "quoteid":
            if rest not in chat or chat[rest]["message_id"] != v:
                bad(key, "message id is not in the chat window")
        elif kind == "divweek":
            if rest == "sweeps":
                want = sum(1 for p_ in pack["pots"] for o_ in {x for g in p_["games"] for x in (g["winner"], g["loser"])}
                           if all(g["winner"] == o_ for g in p_["games"] if o_ in (g["winner"], g["loser"])))
            else:
                want = len(pack["pots"]) if rest == "pots" else sum(len(p["games"]) for p in pack["pots"])
            if v != want:
                bad(key, "page %s, pack %s" % (v, want))
        elif kind == "divrec":
            div = ctx["d1"]["franchises"]
            w_ = sum(1 for g in ctx["d1"]["regGames"] if g["franchise_id"] == rest and div[g["opponent_franchise_id"]]["division"] == div[rest]["division"]
                     and float(g["team_score"]) > float(g["opponent_score"]))
            l_ = sum(1 for g in ctx["d1"]["regGames"] if g["franchise_id"] == rest and div[g["opponent_franchise_id"]]["division"] == div[rest]["division"]
                     and float(g["team_score"]) < float(g["opponent_score"]))
            if v != "%d-%d" % (w_, l_):
                bad(key, "page %s, D1 games %d-%d" % (v, w_, l_))
        elif kind == "wkrank":
            if v != 1 + sum(1 for o in s if s[o] > s[rest]):
                bad(key, "page %s, MFL rank %d" % (v, 1 + sum(1 for o in s if s[o] > s[rest])))
        elif kind == "miss":
            tot = 0.0
            for name, proj, pts in v["rows"]:
                pc = res["claims"].get("pts:" + name)
                if not pc or abs(float(pc["value"]) - float(pts)) > 0.05:
                    bad(key, "%s scored %s on the page, claim %s" % (name, pts, pc and pc["value"]))
                if not any(c["value"].get("value") is not None and abs(c["value"]["value"] - float(proj)) < 0.05 for k2, c in res["claims"].items()
                           if k2.startswith("proj:") and isinstance(c["value"], dict)):
                    bad(key, "%s projection %s is not a registered pregame projection" % (name, proj))
                tot += float(proj) - float(pts)
            if abs(round(tot, 1) - v["short"]) > 0.05:
                bad(key, "page %s, summed %.1f" % (v["short"], tot))
        elif kind == "wkrec":
            g = ctx["mfl"]["games"]
            w_ = sum(1 for x in g if (x["a"] if x["as"] > x["bs"] else x["b"]) == rest)
            l_ = sum(1 for x in g if (x["b"] if x["as"] > x["bs"] else x["a"]) == rest)
            if v != "%d-%d" % (w_, l_):
                bad(key, "page %s, MFL games %d-%d" % (v, w_, l_))
        elif kind == "arch":
            truth = n.setdefault("_arch_truth", _archive_truth(ctx))
            if not truth:
                bad(key, "no archive in the snapshot")
            elif rest in ("champs", "runnerup", "tablek"):
                idx = {"tablek": 0, "champs": 1, "runnerup": 2}[rest]
                counts = n.setdefault("_arch_tables", _table_counts(ctx, truth))
                if not any(v in [c[idx] for c in cs] for cs in counts.values()):
                    bad(key, "page %s, recomputed table counts %s" % (v, sorted({c[idx] for cs in counts.values() for c in cs})))
            elif rest not in truth:
                bad(key, "no archive value for %s" % rest)
            elif isinstance(truth[rest], dict):
                if v not in truth[rest]["either"]:
                    bad(key, "page %s, recomputed %s" % (v, truth[rest]["either"]))
            elif truth[rest] != v:
                bad(key, "page %r, recomputed %r" % (v, truth[rest]))
        elif kind in ("pts", "diff", "count"):
            pass                                                 # pack-internal; covered by the pack build's own checks
        else:
            warnings.append("unchecked claim kind %s" % key)

    doc = res["html"]
    # every number a reader sees is a registered claim
    shown = set()
    for c in res["claims"].values():
        for x in NUM_RE.findall(str(c["shown"])):
            shown.add(x.replace(",", "").lstrip("+-−"))
    text = TIME_RE.sub(" ", visible_text(doc))
    stray = sorted({x for x in NUM_RE.findall(text) if x.replace(",", "").lstrip("+-−") not in shown})
    if stray:
        errors.append("numbers on the page that are not registered claims: %s" % ", ".join(stray[:20]))
    # Keith 2026-10-27 and 2026-11-10: no probability prints as a decimal certainty (100.0% / 0.0%); "100%" / "0%" can only come from a
    # clinched / eliminated claim, which the odds checks above verify against the engine's flags.
    certain_txt = re.findall(r"(?<![\d.])(?:100\.0|0\.0)%", text)
    if certain_txt:
        errors.append("a probability prints as %s: nothing is certain unless the engine says it is clinched or eliminated" % certain_txt[0])
    # every quote link points at its own message
    for href, inner in re.findall(r'<a class="rcpt" href="([^"]+)"[^>]*>([\s\S]*?)</a>', doc):
        mid = href.rstrip("/").split("/")[-1]
        m = chat.get(mid)
        if not m or not href.endswith("/%s/%s" % (m["channel_id"], mid)):
            errors.append("quote link %s does not resolve to its message" % href)
        elif _unwrap(H.unescape(re.sub(r"<[^>]+>", "", inner))) != " ".join((m["content"] or "").split()):
            errors.append("quote link %s text differs from the message" % href)
    # highlight links only if verified
    for href in re.findall(r'<a class="wire-play-watch" href="([^"]+)"', doc):
        if not any(l.get("verified") and l.get("url") == H.unescape(href) for l in ctx.get("links", {}).values()):
            errors.append("highlight link %s was not verified" % href)
    # every gap is visible
    for g in res["gaps"]:
        if 'data-editor-gap="%s"' % H.escape(g["id"]) not in doc:
            errors.append("gap %s has no EDITOR REVIEW box" % g["id"])
    # Builder A: the Playoff Picture is shown with registered odds, or blocked by a visible odds gap -- never absent
    if not any(k.startswith("odds:") for k in res["claims"]) and not any(g["id"].startswith("odds:") for g in res["gaps"]):
        errors.append("no playoff odds and no odds blocker: the Playoff Picture cannot silently disappear")
    if 'id="odds"' not in doc:
        errors.append("the Playoff Picture segment is missing")
    if any(k.startswith("odds:po:") for k in res["claims"]):
        for why in forecast_inconsistent(ctx, ctx["week"]):
            errors.append("odds printed from an inconsistent forecast: " + why)
    # every printed number traces to a source
    unsourced = sorted(k for k, c in res["claims"].items() if not str(c.get("source") or "").strip())
    if unsourced:
        errors.append("claims with no source: %s" % ", ".join(unsourced[:20]))
    if "status: draft" not in doc:
        errors.append("article is not status: draft")
    for k in ("_season_truth", "_arch_truth", "_arch_tables", "_trig_truth"):
        n.pop(k, None)
    # markup must balance: Week 8's plays ledger closed the page wrapper and un-styled the last segment
    body = re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", doc[doc.index("<body"):])
    for tag in ("div", "details", "section", "table"):
        o, c = len(re.findall(r"<%s\b" % tag, body)), len(re.findall(r"</%s>" % tag, body))
        if o != c:
            errors.append("unbalanced markup: <%s> opens %d, closes %d" % (tag, o, c))
    if res.get("format") == "story":
        ids = re.findall(r'<section class="wire-sec" id="([^"]+)"', doc)
        want = ["bigstory", "divweek", "elias", "odds", "plays", "season"]
        if [i for i in ids if i in want] != [i for i in want if i in ids] or "bigstory" not in ids or "divweek" not in ids \
                or "odds" not in ids or "plays" not in ids or "season" not in ids:
            errors.append("story format segments are %s" % ids)
        if "stories:leads" in [g["id"] for g in res["gaps"]]:
            errors.append("the story format never carries the old story-leads box")
    return {"ok": not errors, "publishable": not errors and not res["gaps"], "errors": errors, "warnings": warnings,
            "checkedClaims": n, "gaps": res["gaps"]}


def check_editor_draft(doc, ctx, scores_published):
    """For a draft an editor owns: quotes still verbatim, and MFL scores that moved since
    the draft's numbers were frozen (the changed claims an Elias update produces)."""
    chat = {m["message_id"]: m for m in ctx["d1"]["chat"]}
    errors, changed = [], []
    for href, inner in re.findall(r'<a class="rcpt" href="([^"]+)"[^>]*>([\s\S]*?)</a>', doc):
        mid = href.rstrip("/").split("/")[-1]
        m = chat.get(mid)
        said = H.unescape(re.sub(r"<[^>]+>", "", inner)).strip("“”\" ")
        if m and said not in " ".join((m["content"] or "").split()):
            errors.append("quote %s is no longer verbatim" % mid)
    for fid, before in sorted((scores_published or {}).items()):
        now = ctx["mfl"]["scores"].get(fid)
        if now is not None and not _close(before, now):
            changed.append({"claim": "score:" + fid, "was": before, "now": now})
    return {"ok": not errors, "errors": errors, "changedClaims": changed}
