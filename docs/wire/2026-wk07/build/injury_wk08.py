#!/usr/bin/env python3
"""Week 8 injury impact for the UPS Center Week 7 issue (Keith's rules of 2026-10-21, applied again 2026-10-27).

"Starter-caliber" is NOT "was in last week's lineup": a player is starter-caliber when he is in his
franchise's BEST LEGAL LINEUP built from 2026 points per game (UPS scoring, MFL playerScores),
with every rostered player assumed healthy. For each starter-caliber player with a current injury:
position rank, PPG, recent weeks, expected lineup slot, the next-best rostered replacement, the
lineup points and league-rank difference (healthy vs without him), whether the depth holds or a
waiver/trade look is needed (with the best free agent at the position), and Week 7-9 bye /
injury pressure at the position.

Inputs (all read-only, saved beside this script with fetch times in fetched_at.json):
  MFL: rosters, playerScores W1-6 (league 74598 scoring), injuries (feed timestamp), players,
       nflByeWeeks, league (starter rules)
  nflverse: player_stats 2026 (games played), injuries 2026 (official reports, weeks 6-7)
"""
import itertools, json, os, sys
from datetime import datetime, timezone

D = os.path.dirname(os.path.abspath(__file__))
J = lambda n: json.load(open(os.path.join(D, n)))
OWN = {'0001': 'Ryan Bousquet', '0002': 'Derrick Whitman', '0003': 'Matt Gerardi', '0004': 'Brian Cutting',
       '0005': 'Eric Martel', '0006': 'Brian Cross', '0007': 'Josh Martel', '0008': 'Keith Creelman',
       '0009': 'Bear Dunn', '0010': 'Shawn Blake', '0011': 'Eric Mannila', '0012': 'Chris Klingenberg'}
WEEKS = range(1, 8)
NEXT = 8
P = {p["id"]: p for p in J("players.json")["players"]["player"]}
S = {}
for w in WEEKS:
    for r in J("ps%d.json" % w)["playerScores"]["playerScore"]:
        if r.get("score") not in (None, ""):
            S.setdefault(r["id"], {})[w] = float(r["score"])
BYE = {t["id"]: int(t["bye_week"]) for t in J("byes.json")["nflByeWeeks"]["team"]}
INJ_FEED = J("inj_now.json")["injuries"]
INJ = {r["id"]: r for r in INJ_FEED.get("injury", [])}
FEED_AT = datetime.fromtimestamp(int(INJ_FEED["timestamp"]), timezone.utc)
ROST = {f["id"]: f.get("player", []) for f in J("rosters.json")["rosters"]["franchise"]}
rostered = {p["id"] for ps in ROST.values() for p in ps}
nv = J("nflverse.json")            # {"played": {mfl_id: [weeks]}, "report": {mfl_id: {week: {...}}}, "fetchedAt"}

GROUP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN", "DT": "DL", "DE": "DL",
         "LB": "LB", "CB": "DB", "S": "DB"}


def team_of(pid):
    return P.get(pid, {}).get("team")


def played(pid):
    """Weeks the player actually played: an nflverse stat row, or a non-zero MFL score (IDP/K/P rows
    nflverse may not carry); never a week his team was on bye."""
    w = set(int(x) for x in nv["played"].get(pid, []))
    w |= {k for k, v in S.get(pid, {}).items() if v != 0}
    return sorted(x for x in w if BYE.get(team_of(pid)) != x)


def ppg(pid):
    g = played(pid)
    return (sum(S.get(pid, {}).get(w, 0.0) for w in g) / len(g)) if g else 0.0


def total(pid):
    return sum(S.get(pid, {}).values())


# position ranks among every NFL player at the MFL position (total points; PPG among >= 3 games)
by_pos = {}
for pid, p in P.items():
    if p.get("position") in GROUP and pid in S:
        by_pos.setdefault(p["position"], []).append(pid)
RANK_TOT, RANK_PPG = {}, {}
for pos, ids in by_pos.items():
    for i, pid in enumerate(sorted(ids, key=lambda x: -total(x)), 1):
        RANK_TOT[pid] = i
    for i, pid in enumerate(sorted([x for x in ids if len(played(x)) >= 3], key=lambda x: -ppg(x)), 1):
        RANK_PPG[pid] = i

OFF = {"QB": (1, 2), "RB": (2, 5), "WR": (2, 5), "TE": (1, 4)}
IDP = {"DL": (2, 3), "LB": (2, 3), "DB": (2, 3)}


def best_lineup(pool):
    """pool: [pid]. Best legal UPS lineup by PPG: 9 offense (QB 1-2, RB/WR 2-5, TE 1-4), 7 IDP
    (DL/LB/DB 2-3), 1 PK, 1 PN. Returns (points, {pid: slot}) or (None, {}) if no legal lineup."""
    g = {}
    for pid in pool:
        g.setdefault(GROUP.get(P.get(pid, {}).get("position")), []).append(pid)
    for k in g:
        g[k].sort(key=lambda x: (-ppg(x), x))
    best = None
    for q, r, w, t in itertools.product(range(1, 3), range(2, 6), range(2, 6), range(1, 5)):
        if q + r + w + t != 9:
            continue
        cnt = {"QB": q, "RB": r, "WR": w, "TE": t}
        if any(len(g.get(k, [])) < n for k, n in cnt.items()):
            continue
        val = sum(ppg(x) for k, n in cnt.items() for x in g[k][:n])
        if best is None or val > best[0]:
            best = (val, cnt)
    bi = None
    for a, b, c in itertools.product(range(2, 4), repeat=3):
        if a + b + c != 7:
            continue
        cnt = {"DL": a, "LB": b, "DB": c}
        if any(len(g.get(k, [])) < n for k, n in cnt.items()):
            continue
        val = sum(ppg(x) for k, n in cnt.items() for x in g[k][:n])
        if bi is None or val > bi[0]:
            bi = (val, cnt)
    if not best or not bi or not g.get("PK") or not g.get("PN"):
        return None, {}
    slots = {}
    for cnt, mins in ((best[1], OFF), (bi[1], IDP)):
        for k, n in cnt.items():
            for i, x in enumerate(g[k][:n]):
                if i < mins[k][0]:
                    slots[x] = "%s%d" % (k, i + 1)
                else:
                    slots[x] = "Superflex QB" if k == "QB" else ("Flex" if k in OFF else "IDP flex")
    slots[g["PK"][0]] = "PK"
    slots[g["PN"][0]] = "PN"
    return round(best[0] + bi[0] + ppg(g["PK"][0]) + ppg(g["PN"][0]), 1), slots


def pool_of(fid, include_ir=True):
    return [p["id"] for p in ROST[fid] if p["status"] == "ROSTER" or (include_ir and p["status"] == "INJURED_RESERVE")]


def wk8_out(pid):
    """Unavailable in Week 8: bye, or MFL IR/Out/Doubtful/Suspended/PUP (Questionable = assumed to play, flagged)."""
    if BYE.get(team_of(pid)) == NEXT:
        return "bye"
    st = (INJ.get(pid) or {}).get("status", "")
    return st if st in ("IR", "Out", "Doubtful", "Suspended", "IR-R", "PUP") else None


def current_injury(pid):
    """A designation that is CURRENT, not a lapsed MFL leftover: MFL IR/PUP, or an MFL Out/Doubtful/
    Questionable corroborated by the official Week 6 or 7 report, a missed Week 6 game, or an
    in-game Week 6 exit (played, but with a Week 7 designation the Week 6 report did not have)."""
    r = INJ.get(pid)
    if not r:
        return None
    st = r.get("status")
    if st in ("IR", "IR-R", "PUP"):
        return {"status": st, "why": "MFL injured-reserve designation"}
    rep = nv["report"].get(pid, {})
    w6, w7 = rep.get("7"), rep.get("8")
    team_played_6 = BYE.get(team_of(pid)) != 7
    missed6 = team_played_6 and 7 not in played(pid)
    if st in ("Out", "Doubtful") and team_played_6 and 7 in played(pid) and "7" in rep and not (w6 or {}).get("report_status"):
        return {"status": st, "why": "played in Week 7 and is now listed %s by MFL (injured in or after the game)" % st}
    if w7:
        return {"status": st, "why": "official Week 8 report: %s" % (w7.get("practice_status") or w7.get("report_status") or "listed")}
    if missed6:
        return {"status": st, "why": "did not play in Week 7" + (" (official Week 7 status: %s)" % w6["report_status"] if w6 and w6.get("report_status") else "")}
    if w6 and w6.get("report_status"):
        return {"status": st, "why": "official Week 7 status %s, played; still listed by MFL" % w6["report_status"]}
    if st in ("Out", "Doubtful") and team_played_6 and 7 in played(pid) and not w6:
        return {"status": st, "why": "played in Week 7 and is now listed %s by MFL (injured in or after the game)" % st}
    return None


def fmt_recent(pid):
    out = []
    for w in (5, 6, 7):
        if BYE.get(team_of(pid)) == w:
            out.append("bye")
        elif w not in played(pid):
            out.append("DNP")
        else:
            out.append("%.1f" % S[pid].get(w, 0.0))
    return out


def free_agent(pos):
    grp = [pid for pid, p in P.items() if GROUP.get(p.get("position")) == GROUP.get(pos) and pid not in rostered
           and len(played(pid)) >= 2 and not wk8_out(pid) and not current_injury(pid)]
    grp.sort(key=lambda x: -ppg(x))
    return grp[0] if grp else None


def name(pid):
    n = P.get(pid, {}).get("name", pid)
    if ", " in n:
        last, first = n.split(", ", 1)
        n = first + " " + last
    return n


healthy = {f: best_lineup(pool_of(f)) for f in ROST}
order = sorted(ROST, key=lambda f: -(healthy[f][0] or 0))
RANK = {f: i for i, f in enumerate(order, 1)}

cases = []
for fid in sorted(ROST):
    pts, slots = healthy[fid]
    for pid in slots:
        ci = current_injury(pid)
        if not ci:
            continue
        pool = [x for x in pool_of(fid) if x != pid]
        pts2, slots2 = best_lineup(pool)
        totals = dict((f, healthy[f][0] or 0) for f in ROST)
        totals[fid] = pts2 or 0
        rank2 = 1 + sum(1 for f in ROST if f != fid and totals[f] > totals[fid])
        entering = [x for x in slots2 if x not in slots]
        moved = {x: (slots[x], slots2[x]) for x in slots2 if x in slots and slots[x] != slots2[x]}
        pos = P[pid]["position"]
        same = [x for x in pool_of(fid) if GROUP.get(P[x]["position"]) == GROUP[pos] and x != pid]
        bye_p = sorted({(name(x), BYE.get(team_of(x))) for x in same + [pid] if x in slots and BYE.get(team_of(x)) in (8, 9, 10)}, key=lambda z: z[1])
        more_inj = [name(x) for x in same if (current_injury(x) or wk8_out(x) not in (None, "bye"))]
        fa = free_agent(pos)
        repl = entering[0] if entering else None
        drop = round((pts or 0) - (pts2 or 0), 1)
        fa_gain = round(ppg(fa) - ppg(repl), 1) if fa and repl else None
        cases.append({
            "fid": fid, "owner": OWN[fid], "pid": pid, "player": name(pid), "pos": pos, "nfl": team_of(pid),
            "injury": {"mfl": INJ[pid].get("status"), "details": INJ[pid].get("details"), "expReturn": INJ[pid].get("exp_return"),
                       "corroboration": ci["why"]},
            "rankPoints": RANK_TOT.get(pid), "rankPPG": RANK_PPG.get(pid), "ppg": round(ppg(pid), 1), "games": len(played(pid)),
            "recent": fmt_recent(pid), "slot": slots[pid],
            "replacement": repl and {"player": name(repl), "pos": P[repl]["position"], "nfl": team_of(repl), "ppg": round(ppg(repl), 1),
                                     "games": len(played(repl)), "recent": fmt_recent(repl), "slot": slots2[repl],
                                     "wk7": wk8_out(repl) or ("Questionable" if (INJ.get(repl) or {}).get("status") == "Questionable" else "available")},
            "slotChanges": {name(x): v for x, v in moved.items()},
            "lineupHealthy": pts, "lineupWithout": pts2, "lineupDrop": drop, "rankHealthy": RANK[fid], "rankWithout": rank2,
            "bestFreeAgent": fa and {"player": name(fa), "pos": P[fa]["position"], "nfl": team_of(fa), "ppg": round(ppg(fa), 1),
                                     "games": len(played(fa)), "beatsReplacementBy": fa_gain},
            "byePressure": bye_p, "otherInjuriesAtPosition": more_inj,
            "verdict": ("enough depth" if drop < 3.0 else "weaker but workable" if drop < 6.0 else "needs a waiver/trade look"),
        })

out = {"generatedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
       "sources": {"mflInjuryFeedUpdated": FEED_AT.strftime("%Y-%m-%dT%H:%M:%SZ"), "fetchedAt": J("fetched_at.json"),
                   "nflverseFetchedAt": nv.get("fetchedAt")},
       "rule": "starter-caliber = in the franchise's best legal lineup by 2026 PPG with everyone healthy; verdict: lineup drop "
               "< 3.0 PPG enough depth, 3.0-6.0 weaker but workable, >= 6.0 needs a waiver/trade look",
       "healthyLineups": {f: {"owner": OWN[f], "ppg": healthy[f][0], "rank": RANK[f]} for f in ROST},
       "cases": sorted(cases, key=lambda c: -c["lineupDrop"])}
json.dump(out, open(os.path.join(D, "injury_wk08.json"), "w"), indent=1)
for c in out["cases"]:
    r = c["replacement"] or {}
    print("%-18s %-22s %-3s %-12s rk %s/%s ppg %.1f %s slot %-12s -> %s (%.1f, %s) drop %.1f rank %d->%d [%s] FA %s" % (
        c["owner"], c["player"], c["pos"], c["injury"]["mfl"] + " " + (c["injury"]["details"] or ""), c["rankPoints"], c["rankPPG"],
        c["ppg"], c["recent"], c["slot"], r.get("player"), r.get("ppg", 0), r.get("wk7"), c["lineupDrop"], c["rankHealthy"],
        c["rankWithout"], c["verdict"], c["bestFreeAgent"] and "%s %.1f" % (c["bestFreeAgent"]["player"], c["bestFreeAgent"]["ppg"])))


