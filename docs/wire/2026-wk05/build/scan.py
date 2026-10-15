import json, collections, statistics as S
from core import *
R = json.load(open("player_weeks.json"))
POSG = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN", "DE": "DL", "DT": "DL", "LB": "LB", "CB": "DB", "S": "DB"}
# league-wide starters per position-group per week (observed)
starters = collections.Counter((r["week"], POSG.get(r["pos"], r["pos"])) for r in R if r["status"] == "starter")
S_n = {g: round(S.mean([starters[(w, g)] for w in WEEKS])) for g in {g for (_, g) in starters}}
print("avg league starters per group:", S_n)
# replacement = mean of rostered players ranked S+1..S+6 at the group that week (players whose NFL team played)
repl = {}
for w in WEEKS:
    for g, n in S_n.items():
        sc = sorted([r["ups"] or 0 for r in R if r["week"] == w and POSG.get(r["pos"], r["pos"]) == g and r["teamgame"] and r["fid"]], reverse=True)
        pool = sc[n:n + 6]
        repl[(w, g)] = sum(pool) / len(pool) if pool else 0
print("replacement (wk5):", {g: round(repl[(5, g)], 1) for g in S_n})
by = collections.defaultdict(list)
for r in R: by[r["pid"]].append(r)
cands = []
for pid, ws in by.items():
    ws.sort(key=lambda r: r["week"]); g = POSG.get(ws[0]["pos"], ws[0]["pos"])
    cur = next((r["fid"] for r in reversed(ws) if r["fid"]), None)
    st = [r for r in ws if r["status"] == "starter"]
    par = sum((r["ups"] or 0) - repl[(r["week"], g)] for r in st)
    swings = []
    for r in st:
        for gm in TW[(r["week"], r["fid"])]["games"]:
            if gm["result"] == "W" and (r["ups"] or 0) - repl[(r["week"], g)] > gm["margin"]:
                swings.append((r["week"], owner(gm["opp"]), gm["margin"]))
    played = [r for r in ws if (r["snaps"] or 0) > 0]
    def avg(rs, k): v = [r[k] for r in rs if r[k] is not None]; return sum(v) / len(v) if v else None
    early = [r for r in played if r["week"] <= 2]; late = [r for r in played if r["week"] >= 3]
    teamstart = sum(p["score"] for r in st for p in TW[(r["week"], r["fid"])]["players"] if p["status"] == "starter" and p["pid"] == pid)
    tot_team = sum(TW[(r["week"], r["fid"])]["score"] for r in st)
    cands.append(dict(pid=pid, name=ws[0]["name"], pos=ws[0]["pos"], g=g, team=ws[-1]["nflteam"], owner=owner(cur) if cur else "FA",
        ups=[r["ups"] for r in ws], status=["S" if r["status"] == "starter" else ("b" if r["status"] else "-") for r in ws],
        started_pts=sum(r["ups"] or 0 for r in st), share=(teamstart / tot_team if tot_team else 0), par=par, swings=swings,
        snap=[r["snappct"] for r in ws], tgt=[r["targets"] for r in ws], car=[r["carries"] for r in ws], ts=[r["target_share"] for r in ws],
        inact=[r["week"] for r in ws if r["teamgame"] and not (r["snaps"] or 0)], rst=[r["rstatus"] for r in ws], inj=[r["inj"] for r in ws],
        snap_e=avg(early, "snappct"), snap_l=avg(late, "snappct"), ups_e=avg(early, "ups"), ups_l=avg(late, "ups"),
        tgt_e=avg(early, "targets"), tgt_l=avg(late, "targets"), car_e=avg(early, "carries"), car_l=avg(late, "carries")))
json.dump(cands, open("cands.json", "w"), indent=0)
def show(title, rows, n=15):
    print("\n== " + title)
    for c in rows[:n]:
        print("  %-22s %-3s %-4s %-17s par %+6.1f sw %d share %.2f | ups %s %s | snap %s | tgt %s | car %s | inact %s rst %s" % (
            c["name"][:22], c["pos"], c["team"], c["owner"][:17], c["par"], len(c["swings"]), c["share"],
            [round(x, 1) if x is not None else None for x in c["ups"]], "".join(c["status"]),
            [round(x * 100) if x is not None else None for x in c["snap"]], c["tgt"], c["car"], c["inact"], c["rst"]))
show("PAR leaders (started)", sorted(cands, key=lambda c: -c["par"]))
show("Most matchup swings", sorted(cands, key=lambda c: (-len(c["swings"]), -c["par"])))
show("Snap-share risers (wk1-2 -> wk3-5, >=15 pts)", sorted([c for c in cands if c["snap_e"] is not None and c["snap_l"] is not None and c["snap_l"] - c["snap_e"] >= 0.15], key=lambda c: -(c["snap_l"] - c["snap_e"])))
show("Snap-share fallers (>=15 pts)", sorted([c for c in cands if c["snap_e"] is not None and c["snap_l"] is not None and c["snap_e"] - c["snap_l"] >= 0.15], key=lambda c: (c["snap_l"] - c["snap_e"])))
show("UPS ppg risers (wk3-5 vs 1-2, +8)", sorted([c for c in cands if c["ups_e"] is not None and c["ups_l"] is not None and c["ups_l"] - c["ups_e"] >= 8], key=lambda c: -(c["ups_l"] - c["ups_e"])))
show("UPS ppg fallers (-8)", sorted([c for c in cands if c["ups_e"] is not None and c["ups_l"] is not None and c["ups_e"] - c["ups_l"] >= 8], key=lambda c: (c["ups_l"] - c["ups_e"])))
show("Returned after missing games (inactive early, active later)", [c for c in cands if c["inact"] and max(c["inact"]) < 5 and any(x for x in c["snap"][max(c["inact"]):])])
show("Missed recent games (inactive in wk4 or wk5)", sorted([c for c in cands if any(w in (4, 5) for w in c["inact"]) and c["owner"] != "FA"], key=lambda c: -c["par"]), 25)
show("Single-game extremes (>=15 targets, >=25 carries, >=40 UPS)", [c for c in cands if any((t or 0) >= 15 for t in c["tgt"]) or any((x or 0) >= 25 for x in c["car"]) or any((x or 0) >= 40 for x in c["ups"])], 25)
