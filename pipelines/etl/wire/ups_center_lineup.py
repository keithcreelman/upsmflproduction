#!/usr/bin/env python3
"""Was a lineup call wrong, or was it just a bad day? (Keith 2026-10-27)

A lineup that scored more after the games is HINDSIGHT. The UPS Center may say a bench player outscored a starter, and it may
say what the best lineup was, but it may only call a start a miss when the information the manager had says so:

  - judge each hindsight change (a bench player in, a starter out) by MFL's PREGAME projections for both players;
  - a projection counts only if it was captured before that player's own NFL kickoff (wire_data.pregame_projections is the
    kickoff-strict source; a capture after kickoff is not what the manager saw and is never presented as pregame evidence);
  - if both players have one: the bench player must out-project the starter by MORE than MARGIN to be a "miss"; otherwise the
    start was "reasonable" and the gap is scoring variance, not a decision;
  - if either lacks one: "unknown". The report says so and does not call it a mistake. Nothing is inferred or invented.

Pure functions, no network: the data layer hands in rows and projections.
    python3 ups_center_lineup.py   # self-check
"""
import html as _html

MARGIN = 1.0            # points: a pregame edge of one point or less is a coin flip, not a miss (as the bench verdicts do)

MINS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1, "DL": 2, "LB": 2, "DB": 2, "PK": 1, "PN": 1}
MAXS = {"QB": 2, "RB": 5, "WR": 5, "TE": 4, "DL": 3, "LB": 3, "DB": 3, "PK": 1, "PN": 1}
OFF_N, IDP_N = 9, 7
SIDE = {"QB": "QB", "RB": "FLEX", "WR": "FLEX", "TE": "FLEX", "DL": "IDP", "LB": "IDP", "DB": "IDP", "PK": "PK", "PN": "PN"}


def best_lineup(pool):
    """pool: {pid: (points, pos_group)} -> (points, {pid}): the best legal UPS lineup (9 offense, 7 IDP, a kicker, a punter):
    fill each position's minimum, then the best remaining flex-eligible players under the maximums."""
    by = {}
    for pid, (pts, g) in pool.items():
        by.setdefault(g, []).append(pid)
    for g in by:
        by[g].sort(key=lambda p: (-pool[p][0], p))
    chosen = set()
    for mins, n in (({"QB": 1, "RB": 2, "WR": 2, "TE": 1}, OFF_N), ({"DL": 2, "LB": 2, "DB": 2}, IDP_N)):
        take = [p for g, m in mins.items() for p in by.get(g, [])[:m]]
        rest = sorted([p for g, m in mins.items() for p in by.get(g, [])[m:MAXS[g]]], key=lambda p: (-pool[p][0], p))
        chosen |= set(take + rest[:n - len(take)])
    for g in ("PK", "PN"):
        if by.get(g):
            chosen.add(by[g][0])
    return round(sum(pool[p][0] for p in chosen), 1), chosen


def judge(rows, pregame, missing=None, margin=MARGIN):
    """rows: [{pid, name, pos_group, status ('starter' | other), score}] for ONE franchise-week.
    pregame: {pid: {value, captured, kickoff}} kickoff-strict only (the caller must not pass a capture taken after kickoff);
    missing: {pid: reason}. Returns {actual, best, swaps: [{out, in, gain, verdict, ...}], summary}."""
    missing = missing or {}
    if any(not r.get("pos_group") for r in rows):          # a player we cannot place makes the best lineup unreproducible
        return {"actual": None, "best": None, "swaps": [], "summary": "unknown", "unplaced": True}
    pool = {str(r["pid"]): (float(r["score"] or 0.0), r["pos_group"]) for r in rows}
    info = {str(r["pid"]): r for r in rows}
    starters = {p for p, r in info.items() if r["status"] == "starter"}
    actual = round(sum(pool[p][0] for p in starters), 1)
    best, chosen = best_lineup(pool)
    risers = sorted(chosen - starters, key=lambda p: (-pool[p][0], p))
    displaced = sorted(starters - chosen, key=lambda p: (pool[p][0], p))
    swaps, used = [], set()
    for rp in risers:                                   # pair each riser with the lowest-scoring displaced starter on his side of the card
        cand = [d for d in displaced if d not in used and SIDE.get(pool[d][1]) == SIDE.get(pool[rp][1])] or \
               [d for d in displaced if d not in used]
        if not cand:
            continue
        d = cand[0]
        used.add(d)
        a, b = pregame.get(rp), pregame.get(d)
        if a and b:
            verdict = "miss" if a["value"] > b["value"] + margin else "reasonable"
        else:
            verdict = "unknown"
        swaps.append({"out": {"pid": d, "name": info[d]["name"], "score": pool[d][0], "proj": b["value"] if b else None},
                      "in": {"pid": rp, "name": info[rp]["name"], "score": pool[rp][0], "proj": a["value"] if a else None},
                      "gain": round(pool[rp][0] - pool[d][0], 1), "verdict": verdict,
                      "why": None if verdict != "unknown" else "; ".join(
                          "%s: %s" % (info[x]["name"], missing.get(x, "no pregame projection")) for x in (rp, d) if x not in pregame)})
    kinds = {s["verdict"] for s in swaps}
    summary = ("none" if not swaps else "miss" if "miss" in kinds else
               "reasonable" if kinds == {"reasonable"} else "unknown" if kinds == {"unknown"} else "partial")
    return {"actual": actual, "best": best, "swaps": swaps, "summary": summary}


def sentence(j, best_text, fmt=lambda x: "%.1f" % x):
    """The one sentence the desk may print about a team that lost a game its hindsight lineup would have won. Never blames a
    start the projections supported, and says plainly when there is no pregame number. Returns (text, [numbers used])."""
    nums = []
    base = "His best lineup in hindsight, %s, would have won a game he lost." % best_text
    s, sw = j["summary"], j["swaps"]
    if s == "miss":
        m = max((x for x in sw if x["verdict"] == "miss"), key=lambda x: (x["in"]["proj"] - x["out"]["proj"], x["gain"]))
        nums += [m["in"]["proj"], m["out"]["proj"]]
        return base + " MFL&rsquo;s pregame projections favored %s (%s) over %s (%s), so that call went against the projections." % (
            _html.escape(m["in"]["name"]), fmt(m["in"]["proj"]), _html.escape(m["out"]["name"]), fmt(m["out"]["proj"])), nums
    if s == "reasonable":
        return base + " MFL&rsquo;s pregame projections favored his starters at every spot, so the gap is scoring variance, not a lineup decision.", nums
    unk = len([x for x in sw if x["verdict"] == "unknown"])
    if s == "partial":
        nums += [unk, len(sw)]
        return base + (" Where MFL has a pregame projection for both players it favored his starters; for %d of %d changes it has none "
                       "for one of them (a capture counts only before the player&rsquo;s own kickoff), so this report does not call those a mistake.") % (
            unk, len(sw)), nums
    tail = " (a capture counts only before the player&rsquo;s own kickoff), so this report does not judge the lineup."
    if len(sw) > 1:
        nums.append(len(sw))
        return base + " For none of the %d changes does MFL have a pregame projection for both players%s" % (len(sw), tail), nums
    return base + " MFL does not have a pregame projection for both players in the change%s" % tail, nums

if __name__ == "__main__":
    rows = [dict(pid=str(i), name="P%d" % i, pos_group=g, status=st, score=sc) for i, (g, st, sc) in enumerate([
        ("QB", "starter", 10), ("QB", "starter", 9), ("RB", "starter", 5), ("RB", "starter", 5), ("RB", "starter", 4),
        ("WR", "starter", 5), ("WR", "starter", 5), ("WR", "starter", 5), ("TE", "starter", 3), ("WR", "bench", 30),
        ("DL", "starter", 3), ("DL", "starter", 3), ("LB", "starter", 3), ("LB", "starter", 3), ("DB", "starter", 3), ("DB", "starter", 3),
        ("PK", "starter", 5), ("PN", "starter", 5)])]
    j = judge(rows, {})
    assert j["summary"] == "unknown" and j["swaps"][0]["in"]["name"] == "P9", j
    print("ok")
