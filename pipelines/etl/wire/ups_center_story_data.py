#!/usr/bin/env python3
"""Pure story data for the story-format UPS Center draft (Keith 2026-11-05: "this needs to be my new template").

No network, no D1, no clock: the same snapshot in gives the same answer out. The validator recomputes
every number from ctx["archive"] with its own code (ups_center_validate._archive_truth), not from here.

Big Story rule (generic form of Week 8's Bear Dunn story, which Keith picked by hand):
  * the pool is every earlier team-season in the league archive that has all of weeks 1..N
    (ctx["archive"], see ups_center_sources.archive_history), compared on All-Play percentage through
    Week N, wins / (wins + losses), ties ignored;
  * a current team's place is how many pool teams are strictly better (best direction) or strictly
    worse (worst direction);
  * a team QUALIFIES when at most BIG_STORY_RANK_MAX - 1 pool teams beat it, or the same number are worse
    (top or bottom five all-time), and Week N is at least BIG_STORY_MIN_WEEK;
  * the story is the qualifier with the fewest teams ahead; a tie goes to the better current week score,
    then the lower franchise id;
  * with no qualifier, or no archive, the Big Story falls back to the old opening desk.
"""
BIG_STORY_RANK_MAX = 5
BIG_STORY_MIN_WEEK = 4
TOP_TABLE_ROWS = 5


def pool(archive, week):
    """[{season, fid, owner, w, l, pct, final}] for every archived team-season, All-Play through `week`."""
    by = {}
    for season, w, f, sc in archive["rows"]:
        if w <= week:
            by.setdefault(int(season), {}).setdefault(int(w), {})[f] = float(sc)
    out = []
    for season in sorted(by):
        rec = {}
        for scores in by[season].values():
            for f, x in scores.items():
                r = rec.setdefault(f, [0, 0])
                r[0] += sum(1 for g, y in scores.items() if g != f and x > y)
                r[1] += sum(1 for g, y in scores.items() if g != f and x < y)
        for f, (w_, l_) in sorted(rec.items()):
            out.append({"season": season, "fid": f, "owner": archive["owners"].get("%d:%s" % (season, f)),
                        "w": w_, "l": l_, "pct": w_ / float(w_ + l_) if w_ + l_ else 0.0,
                        "final": archive["final"].get("%d:%s" % (season, f))})
    return out


def current_ap(ctx):
    """{fid: (w, l)} All-Play of this season through the week, from the MFL standings."""
    out = {}
    for f, st in ctx["mfl"]["standings"].items():
        w, l = (int(x) for x in st["allplay"].split("-")[:2])
        out[f] = (w, l)
    return out


def big_story(ctx):
    """None, or {fid, direction ('best'|'worst'), ahead, pool, n, table: [row...]}."""
    arc = ctx.get("archive")
    week = int(ctx["week"])
    if not arc or not arc.get("rows") or week < BIG_STORY_MIN_WEEK:
        return None
    P = pool(arc, week)
    if not P:
        return None
    cur = current_ap(ctx)
    scores = ctx["mfl"]["scores"]
    best = None
    for f, (w, l) in sorted(cur.items()):
        if w + l == 0:
            continue
        pct = w / float(w + l)
        for direction, ahead in (("best", sum(1 for x in P if x["pct"] > pct + 1e-12)),
                                 ("worst", sum(1 for x in P if x["pct"] < pct - 1e-12))):
            if ahead >= BIG_STORY_RANK_MAX:
                continue
            key = (ahead, -scores[f], f)
            if best is None or key < best[0]:
                best = (key, f, direction, ahead)
    if not best:
        return None
    _, f, direction, ahead = best
    w, l = cur[f]
    me = {"season": None, "fid": f, "owner": None, "w": w, "l": l, "pct": w / float(w + l), "final": None, "current": True}
    rows = sorted(P + [me], key=lambda x: (-x["pct"] if direction == "best" else x["pct"], x["season"] is None, x["season"] or 0))
    return {"fid": f, "direction": direction, "ahead": ahead, "pool": len(P), "table": rows[:TOP_TABLE_ROWS],
            "seasons": sorted({x["season"] for x in P}), "excluded": arc.get("excluded") or {}, "week": week}


def own_history(ctx, owner, week):
    """(best, worst) prior archived All-Play starts of the same owner, or None with fewer than three seasons."""
    arc = ctx.get("archive")
    if not arc:
        return None
    mine = [x for x in pool(arc, week) if x["owner"] == owner]
    if len(mine) < 3:
        return None
    return (max(mine, key=lambda x: (x["pct"], -x["season"])), min(mine, key=lambda x: (x["pct"], x["season"])))
