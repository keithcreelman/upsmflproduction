#!/usr/bin/env python3
"""Story discovery for the automated UPS Center draft (Builder B, Keith 2026-10-14).

Week 5 was rebuilt by hand around a Heat Check (who is hot over the last three
weeks against the season) and a Survival Line (what a team's position after
Week N has meant in past seasons). This module computes both, deterministically,
from the sources snapshot alone (ctx["history"], see ups_center_sources.
season_history), plus a short list of story LEADS for the editor. It writes no
prose: the issue shows the tables, and the leads go in an EDITOR REVIEW box,
because choosing and telling the stories is the editor's job.

Pure: no network, no D1, no clock. Same snapshot in, same output out.

Definitions (the Week 5 issue's, generalized to any week N):
  * windows       last = weeks N-2..N; first = weeks 1..N-3 (empty before Week 4,
                  when there is no rank movement to read)
  * all-play      each week, wins = teams outscored, losses = teams that outscored
                  you; ties count half where a share is needed
  * scoring rank  points per week in a window, 1 = most; tied teams share the
                  higher rank
  * reading       Dominant: at least 28 of every 33 all-play games in the last
                  window; Sinking: 5 of 33 or fewer; Rising / Cooling: scoring rank
                  moved four or more places; otherwise Holding (applied in order)
  * bench         best possible lineup minus the lineup started, per week
  * best-lineup losses   head-to-head losses where the best possible lineup
                  outscored the opponent's actual score
  * wins vs expected     head-to-head wins minus the wins each week's all-play
                  rate would give for that week's games
  * survival      all-play rank after Week N in pairs (1-2 ... 11-12), past seasons
                  from 2017; win totals after Week N in five buckets scaled to the
                  number of decisions (exactly Week 5's "10 or more ... 3 or fewer"
                  at 13 decisions), past seasons from 2021 with the same number of
                  decisions; "made it" = in the playoff field (bracket API path is
                  not HAWK)
"""
DOMINANT, SINKING = 28 / 33.0, 5 / 33.0


def _weeks(rows, value="team_score"):
    out = {}
    for r in rows:
        out.setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r[value] or 0)
    return out


def allplay(scores):
    """{fid: score} -> {fid: (wins, losses, ties)} for one week."""
    out = {}
    for f, s in scores.items():
        w = sum(1 for g, x in scores.items() if g != f and s > x)
        lo = sum(1 for g, x in scores.items() if g != f and s < x)
        out[f] = (w, lo, len(scores) - 1 - w - lo)
    return out


def ranks(values):
    """{fid: value} -> {fid: rank}, 1 = highest; tied values share the higher rank."""
    return {f: 1 + sum(1 for g in values if values[g] > values[f]) for f in values}


def windows(week):
    return list(range(1, week - 2)), list(range(max(1, week - 2), week + 1))


def heat(ctx):
    """{fid: row} for the Heat Check, or None without history."""
    hist = ctx.get("history")
    if not hist:
        return None
    n = hist["week"]
    sc, opt = _weeks(hist["seasonScores"]), _weeks(hist["seasonScores"], "team_opt_pts")
    weeks = sorted(w for w in sc if w <= n)
    fids = sorted(sc[n])
    first, last = windows(n)
    ap = {w: allplay(sc[w]) for w in weeks}
    rk_last = ranks({f: sum(sc[w][f] for w in last) / len(last) for f in fids})
    rk_first = ranks({f: sum(sc[w][f] for w in first) / len(first) for f in fids}) if first else None
    games = {}
    for g in hist["seasonGames"]:
        games.setdefault((int(g["week"]), g["franchise_id"]), []).append((g["opponent_franchise_id"], g["result"]))
    rows = {}
    for f in fids:
        a3 = (sum(ap[w][f][0] for w in last), sum(ap[w][f][1] for w in last))
        tot = (sum(ap[w][f][0] for w in weeks), sum(ap[w][f][1] for w in weeks))
        share = a3[0] / float(a3[0] + a3[1]) if sum(a3) else 0.0
        move = (rk_first[f] - rk_last[f]) if rk_first else 0
        label = ("Dominant" if share >= DOMINANT - 1e-9 else "Sinking" if share <= SINKING + 1e-9 else
                 "Rising" if move >= 4 else "Cooling" if move <= -4 else "Holding")
        wins = losses = lost_best = 0
        expected = 0.0
        for w in weeks:
            gs = games.get((w, f), [])
            a = ap[w][f]
            expected += (a[0] + 0.5 * a[2]) / float(len(sc[w]) - 1) * len(gs)
            for opp, res in gs:
                wins += 1.0 if res == "W" else 0.5 if res == "T" else 0.0
                if res == "L":
                    losses += 1
                    lost_best += 1 if opt[w][f] > sc[w][opp] else 0
        rows[f] = {"ap3": a3, "ap": tot, "rkFirst": rk_first[f] if rk_first else None, "rkLast": rk_last[f], "label": label,
                   "bench": round(sum(opt[w][f] - sc[w][f] for w in weeks) / len(weeks), 1), "losses": losses,
                   "lostBest": lost_best, "luck": round(wins - expected, 1), "wins": wins}
    return rows


def win_buckets(decisions):
    """Five win buckets scaled to `decisions`; exactly 10+/8-9/6-7/4-5/3- at 13."""
    c = [int(round(k * decisions / 13.0)) for k in (10, 8, 6, 4)]
    return [("%d or more" % c[0], c[0], decisions), ("%d–%d" % (c[1], c[0] - 1), c[1], c[0] - 1),
            ("%d–%d" % (c[2], c[1] - 1), c[2], c[1] - 1), ("%d–%d" % (c[3], c[2] - 1), c[3], c[2] - 1),
            ("%d or fewer" % (c[3] - 1), 0, c[3] - 1)]


def ap_pair(rank):
    lo = rank if rank % 2 else rank - 1
    return "%d–%d" % (lo, lo + 1)


def survival(ctx):
    """{fid: row} for the Survival Line, or None without history."""
    hist = ctx.get("history")
    if not hist:
        return None
    n = hist["week"]
    sc = _weeks(hist["seasonScores"])
    weeks = sorted(w for w in sc if w <= n)
    fids = sorted(sc[n])
    cur_ap = {f: sum(allplay(sc[w])[f][0] + 0.5 * allplay(sc[w])[f][2] for w in weeks) for f in fids}
    cur_rank = ranks(cur_ap)
    rec = {}
    for g in hist["seasonGames"]:
        d = rec.setdefault(g["franchise_id"], [0.0, 0])
        d[0] += 1.0 if g["result"] == "W" else 0.5 if g["result"] == "T" else 0.0
        d[1] += 1
    decisions = max(d[1] for d in rec.values())
    buckets = win_buckets(decisions)
    # past all-play rank groups
    past = {}
    for r in hist["pastScores"]:
        past.setdefault(int(r["season"]), {}).setdefault(int(r["week"]), {})[r["franchise_id"]] = float(r["team_score"])
    ap_groups = {}
    for s, wk in past.items():
        tot = {}
        for w, scores in wk.items():
            for f, (wn, _, t) in allplay(scores).items():
                tot[f] = tot.get(f, 0.0) + wn + 0.5 * t
        rk = ranks(tot)
        field = set(hist["made"][str(s)])
        for f in tot:
            m, k = ap_groups.get(ap_pair(rk[f]), (0, 0))
            ap_groups[ap_pair(rk[f])] = (m + (f in field), k + 1)
    # past win buckets (same number of decisions only)
    prec = {}
    for r in hist["pastResults"]:
        d = prec.setdefault((int(r["season"]), r["franchise_id"]), [0.0, 0])
        d[0] += 1.0 if r["result"] == "W" else 0.5 if r["result"] == "T" else 0.0
        d[1] += 1
    w_groups = {}
    for (s, f), (wn, dn) in prec.items():
        if dn != decisions:
            continue
        lab = next(b[0] for b in buckets if b[1] <= wn <= b[2])
        m, k = w_groups.get(lab, (0, 0))
        w_groups[lab] = (m + (f in set(hist["made"][str(s)])), k + 1)
    rows = {}
    for f in fids:
        wins = rec.get(f, [0.0, 0])[0]
        lab = next(b[0] for b in buckets if b[1] <= wins <= b[2])
        rows[f] = {"apRank": cur_rank[f], "apGroup": ap_pair(cur_rank[f]), "apHist": ap_groups.get(ap_pair(cur_rank[f]), (0, 0)),
                   "wins": wins, "decisions": decisions, "winGroup": lab, "winHist": w_groups.get(lab, (0, 0))}
    meta = {"firstAp": hist["firstAp"], "lastAp": max(past) if past else None, "firstWins": hist["firstWins"],
            "lastWins": max((s for s, _ in prec), default=None), "decisions": decisions}
    return rows, meta


def leads(h, s, owner):
    """Deterministic story leads for the editor: [(id, kind, data)]. The issue renders the
    text and registers every number; this only decides what is worth a look."""
    out = []
    if not h:
        return out
    top = max(h, key=lambda f: (h[f]["ap3"][0], -h[f]["ap3"][1], f))
    out.append(("hot", top, {}))
    moves = [(f, h[f]["rkFirst"] - h[f]["rkLast"]) for f in h if h[f]["rkFirst"] is not None]
    for f, mv in sorted(moves, key=lambda x: (-x[1], x[0]))[:2]:
        if mv >= 4:
            out.append(("riser", f, {}))
    for f, mv in sorted(moves, key=lambda x: (x[1], x[0]))[:2]:
        if mv <= -4:
            out.append(("faller", f, {}))
    bench = max(h, key=lambda f: (h[f]["bench"], f))
    out.append(("bench", bench, {}))
    unlucky = min(h, key=lambda f: (h[f]["luck"], f))
    if h[unlucky]["luck"] <= -1.0:
        out.append(("unlucky", unlucky, {}))
    if s:
        rows, meta = s
        low = sorted(f for f in rows if rows[f]["winGroup"].endswith("or fewer"))
        if low:
            out.append(("survival", low[0], {"teams": low}))
    return out
