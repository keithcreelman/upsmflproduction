#!/usr/bin/env python3
"""All-play through Week 8 for every team-season 2010-2025 (June archive DB, regular season only).
Writes alltime_start.json: the facts the Week 8 Big Story and the Josh Martel segment quote.
Input: ~/Downloads/mfl_database.db (read-only). Each week, every team's score is compared with every other team's."""
import collections, json, os, sqlite3, sys
DB = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/Downloads/mfl_database.db")
c = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
S = collections.defaultdict(dict)
for s, w, f, sc in c.execute("select distinct season,week,franchise_id,team_score from weeklyresults where team_score is not null and is_playoff=0"):
    S[(s, w)][f] = sc
own = {(s, f): o for s, f, o in c.execute("select season,franchise_id,owner_name from standings")}
fin = {(y, f): ff for y, f, ff in c.execute("select year,franchise_id,final_finish from metadata_finalstandings")}
def ap(upto):
    out = []
    for s in range(2011, 2026):  # 2010 omitted: its archive scores conflict (24 duplicate rows)
        r = collections.defaultdict(lambda: [0, 0])
        for w in range(1, upto + 1):
            d = S[(s, w)]
            for f, x in d.items():
                for g, y in d.items():
                    if g != f and x != y:
                        r[f][0 if x > y else 1] += 1
        for f, (a, b) in r.items():
            out.append(dict(season=s, fid=f, owner=own.get((s, f)), w=a, l=b, pct=a / (a + b), final=fin.get((s, f))))
    return sorted(out, key=lambda x: -x["pct"])
w8, w7 = ap(8), ap(7)
full = c.execute("select season,owner_name,allplay_w,allplay_l from standings").fetchall()
fullbest = sorted(((w * 1.0 / (w + l), s, o, w, l) for s, o, w, l in full), reverse=True)[:3]
json.dump(dict(team_seasons=len(w8), top8=w8[:5], bottom8=w8[-16:], josh_wk8=[x for x in w8 if x["owner"] == "Josh Martel"],
               bear_2026=dict(w=78, l=10, pct=78 / 88), josh_2026=dict(w=22, l=66, pct=22 / 88), josh_thru7=dict(w=14, l=63, pct=14 / 77),
               n_at_or_below_250=sum(1 for x in w8 if x["pct"] <= 0.25 + 1e-9),
               n_wk7_below_182=sum(1 for x in w7 if x["pct"] < 14 / 77 - 1e-9), n_wk7_tied_182=sum(1 for x in w7 if abs(x["pct"] - 14 / 77) < 1e-9),
               full_best=fullbest), open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "alltime_start.json"), "w"), indent=1)
print("ok", len(w8))
