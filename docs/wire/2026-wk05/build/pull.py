#!/usr/bin/env python3
"""Week 5 analysis dataset: pulled ONCE (MFL API + small D1 tables), cached to JSON.
D1 reads are logged with meta.rows_read (docs/D1_QUERY_RULES.md)."""
import json, os, subprocess, sys, time, urllib.request
OUT = os.path.dirname(os.path.abspath(__file__))
REPO = "/Users/keithcreelman/Code/MFL/upsmflproduction"
MFL = "https://www48.myfantasyleague.com/2026/export?TYPE=%s&L=74598&JSON=1%s"
def mfl(t, extra=""):
    for i in range(6):
        try:
            req = urllib.request.Request(MFL % (t, extra), headers={"User-Agent": "ups-wire-wk5"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429: time.sleep(10 * (i + 1)); continue
            raise
    raise SystemExit("MFL 429 persisted: " + t)
def d1(sql):
    p = subprocess.run(["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
                       cwd=os.path.join(REPO, "worker"), capture_output=True, text=True)
    j = json.loads(p.stdout)
    rows, meta = j[0]["results"], j[0].get("meta", {})
    print("  D1 rows_read=%s returned=%d :: %s" % (meta.get("rows_read"), len(rows), sql[:90]), file=sys.stderr)
    return rows
def save(name, obj):
    json.dump(obj, open(os.path.join(OUT, name + ".json"), "w"))
mfl_data = {"pulledAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
for w in range(1, 6):
    mfl_data["weeklyResults_%d" % w] = mfl("weeklyResults", "&W=%d" % w); time.sleep(1.2)
for t, extra in (("leagueStandings", ""), ("schedule", ""), ("league", ""), ("rosters", ""), ("injuries", ""),
                 ("transactions", "&TRANS_TYPE=*"), ("players", "&DETAILS=1")):
    mfl_data[t] = mfl(t, extra); time.sleep(1.2)
save("mfl_2026", mfl_data)
hist = {}
hist["meta"] = d1("SELECT * FROM src_league_season_meta")
hist["fws"] = d1("SELECT season, week, franchise_id, team_score, team_opt_pts, is_playoff FROM src_franchise_weekly_score")
hist["schedule"] = d1("SELECT season, week, franchise_id, opponent_franchise_id, result, team_score, opponent_score, is_divisional, is_playoff FROM src_schedule")
hist["final"] = d1("SELECT * FROM src_final_standings")
hist["franchises"] = d1("SELECT season, franchise_id, owner_name, team_name, division FROM src_franchises")
hist["standings"] = d1("SELECT season, franchise_id, owner_name, division, div_w, div_l, h2h_w, h2h_l, h2h_t, allplay_w, allplay_l, allplay_t, allplay_pct, pf, pp FROM src_standings")
save("hist", hist)
print("done", {k: len(v) for k, v in hist.items()}, file=sys.stderr)
