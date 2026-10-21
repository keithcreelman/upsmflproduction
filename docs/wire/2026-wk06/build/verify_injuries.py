#!/usr/bin/env python3
"""Independent check of the Injury Report segment. Shares NO code with injury_wk07.py: it re-reads
the raw saved inputs, recomputes points per game, position ranks and every best legal lineup with a
different algorithm (fill each position's minimum, then the best remaining flex-eligible players
under the maximums -- optimal here because every slot counts equally), and compares each printed
claim in injury_claims.json; then checks every number on the segment is a registered claim.

    python3 verify_injuries.py <article.html>
"""
import html as H, json, os, re, sys

D = os.path.dirname(os.path.abspath(__file__))
L = lambda n: json.load(open(os.path.join(D, n)))
claims = L("injury_claims.json")
players = {p["id"]: p for p in L("players.json")["players"]["player"]}
score = {}
for w in range(1, 7):
    for r in L("ps%d.json" % w)["playerScores"]["playerScore"]:
        if r.get("score") not in (None, ""):
            score.setdefault(r["id"], {})[w] = float(r["score"])
bye = {t["id"]: int(t["bye_week"]) for t in L("byes.json")["nflByeWeeks"]["team"]}
nv = L("nflverse.json")
feed = {r["id"]: r for r in L("inj_now.json")["injuries"]["injury"]}
roster = {f["id"]: f.get("player", []) for f in L("rosters.json")["rosters"]["franchise"]}
res = []


def ok(name, cond, detail=""):
    res.append((name, bool(cond), str(detail)[:300]))
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  -- " + str(detail)[:300]))


def games(pid):
    t = players[pid].get("team")
    g = {int(w) for w in nv["played"].get(pid, [])} | {w for w, v in score.get(pid, {}).items() if v != 0}
    return sorted(w for w in g if bye.get(t) != w)


def ppg(pid):
    g = games(pid)
    return sum(score.get(pid, {}).get(w, 0.0) for w in g) / len(g) if g else 0.0


GRP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN", "DT": "DL", "DE": "DL", "LB": "LB", "CB": "DB", "S": "DB"}


def lineup(pool):
    by = {}
    for p in pool:
        by.setdefault(GRP.get(players[p]["position"]), []).append(p)
    for k in by:
        by[k].sort(key=lambda x: -ppg(x))
    total, chosen = 0.0, set()
    for side, mins, maxs, n in (("off", {"QB": 1, "RB": 2, "WR": 2, "TE": 1}, {"QB": 2, "RB": 5, "WR": 5, "TE": 4}, 9),
                                ("idp", {"DL": 2, "LB": 2, "DB": 2}, {"DL": 3, "LB": 3, "DB": 3}, 7)):
        take = {k: by.get(k, [])[:m] for k, m in mins.items()}
        rest = sorted([p for k in mins for p in by.get(k, [])[mins[k]:maxs[k]]], key=lambda x: -ppg(x))
        flex = rest[:n - sum(mins.values())]
        for p in [p for v in take.values() for p in v] + flex:
            chosen.add(p)
            total += ppg(p)
    for k in ("PK", "PN"):
        chosen.add(by[k][0])
        total += ppg(by[k][0])
    return round(total, 1), chosen


pool = lambda f: [p["id"] for p in roster[f] if p["status"] in ("ROSTER", "INJURED_RESERVE")]
healthy = {f: lineup(pool(f)) for f in roster}
by_pos = {}
for pid, p in players.items():
    if pid in score and p.get("position") in GRP:
        by_pos.setdefault(p["position"], []).append(pid)
rank_tot = {pid: 1 + sum(1 for q in ids if sum(score[q].values()) > sum(score[pid].values())) for ids in by_pos.values() for pid in ids}

print("Injury Report: independent recomputation")
checked = 0
for key, c in claims.items():
    parts = key.split(":")
    if parts[0] == "inj" and len(parts) == 3 and parts[1].isdigit():
        pid, what = parts[1], parts[2]
        own = next(f for f in roster if any(p["id"] == pid for p in roster[f]))
        if what == "ppg":
            ok("%s PPG %s" % (key, c["value"]), abs(round(ppg(pid), 1) - c["value"]) < 1e-9, round(ppg(pid), 2)); checked += 1
        elif what == "g":
            ok("%s games %s" % (key, c["value"]), len(games(pid)) == c["value"], len(games(pid))); checked += 1
        elif what == "rkp":
            ok("%s position rank %s" % (key, c["value"]), rank_tot.get(pid) == c["value"], rank_tot.get(pid)); checked += 1
        elif what in ("w4", "w5", "w6"):
            ok("%s week score" % key, abs(score[pid].get(int(what[1]), 0) - c["value"]) < 1e-9, score[pid].get(int(what[1]))); checked += 1
        elif what == "lu1":
            ok("%s healthy lineup %s" % (key, c["value"]), healthy[own][0] == c["value"], healthy[own][0]); checked += 1
        elif what == "lu2":
            w = lineup([p for p in pool(own) if p != pid])[0]
            ok("%s lineup without %s" % (key, c["value"]), w == c["value"], w); checked += 1
        elif what == "drop":
            w = lineup([p for p in pool(own) if p != pid])[0]
            ok("%s drop %s" % (key, c["value"]), abs(round(healthy[own][0] - w, 1) - c["value"]) < 1e-9, healthy[own][0] - w); checked += 1
        elif what in ("rk1", "rk2"):
            tot = {f: healthy[f][0] for f in roster}
            if what == "rk2":
                tot[own] = lineup([p for p in pool(own) if p != pid])[0]
            r = 1 + sum(1 for f in roster if f != own and tot[f] > tot[own])
            ok("%s league rank %s" % (key, c["value"]), r == c["value"], r); checked += 1
mc = "14109"
ok("McLaurin is outside Blake's best healthy lineup", mc not in healthy["0010"][1])
ok("Blake's healthy lineup %s a week, the same without McLaurin" % claims["inj:blake:lu"]["value"],
   healthy["0010"][0] == claims["inj:blake:lu"]["value"] == lineup([p for p in pool("0010") if p != mc])[0])
wk7pool = [p["id"] for p in roster["0010"] if p["status"] == "ROSTER" and bye.get(players[p["id"]]["team"]) != 7
           and (feed.get(p["id"]) or {}).get("status") not in ("IR", "Out", "Doubtful", "Suspended", "IR-R", "PUP")]
ok("Blake's best Week 7 lineup %s (byes and MFL Out/IR removed)" % claims["inj:blake:wk7"]["value"], lineup(wk7pool)[0] == claims["inj:blake:wk7"]["value"], lineup(wk7pool)[0])
qbs = [p for p in wk7pool if players[p]["position"] == "QB"]
ok("Brock Purdy is the only quarterback available to Blake in Week 7", [players[q]["name"] for q in qbs] == ["Purdy, Brock"], [players[q]["name"] for q in qbs])
ok("McLaurin 2026 line: 9.7 a game in 5 games", round(ppg(mc), 1) == 9.7 and len(games(mc)) == 5)
ok("McLaurin MFL status Out, knee, expected Feb 15, 2027", feed[mc]["status"] == "Out" and feed[mc]["details"] == "Knee" and feed[mc]["exp_return"] == "Feb 15, 2027")
ok("Washington is not in the Week 7 official-report data as fetched", not any(r.get("7", {}).get("team") == "WAS" for r in nv["report"].values()))
# every number on the segment is a registered claim
doc = open(sys.argv[1], encoding="utf-8").read()
seg = re.search(r'<section class="wire-sec" id="injuries"[\s\S]*?</section>', doc).group(0)
txt = re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", seg)))
txt = re.sub(r"\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{1,2}:\d{2} (AM|PM) ET", " ", txt)
txt = re.sub(r"Feb 15, 2027|\bWeek \d{1,2}\b|\bWeeks \d+[–-]\d+\b|\b20\d\d\b|\bWR\d|\bRB\d|\bTE\d|\bQB\d|\bDL\d|\bLB\d|\bDB\d", " ", txt)
shown = set()
for c in claims.values():
    for x in re.findall(r"(?<![\w.])[-+−]?\d[\d,]*(?:\.\d+)?", H.unescape(re.sub(r"<[^>]+>", "", str(c["shown"])))):
        shown.add(x.replace(",", "").lstrip("+-−"))
stray = sorted({x for x in re.findall(r"(?<![\w.])[-+−]?\d[\d,]*(?:\.\d+)?", txt) if x.replace(",", "").lstrip("+-−") not in shown})
ok("every number in the Injury Report is a registered claim", not stray, stray[:20])
ok("every injury claim names a source", all(str(c["source"]).strip() for c in claims.values()))
bad = [n for n, o, _ in res if not o]
print("\n%d checks (%d per-claim recomputations), %d failed" % (len(res), checked, len(bad)))
json.dump([dict(check=n, ok=o, detail=d) for n, o, d in res], open(os.path.join(D, "verify_injuries.json"), "w"), indent=1)
sys.exit(1 if bad else 0)
