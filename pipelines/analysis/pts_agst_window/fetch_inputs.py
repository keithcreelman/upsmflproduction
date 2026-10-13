#!/usr/bin/env python3
"""Fetch the backtest's inputs (READ-ONLY): MFL exports for league 74598 (GET) and two D1 reads
(SELECT) via wrangler. Layout written to <out>:
  mfl/players_<Y>.json, mfl/sched_<Y>_w<N>.json, mfl/scores_<Y>_w<N>.json      (Y = 2018..2026)
  d1/weekly_team_opp_<Y>.json (nfl_player_weekly season, week, gsis_id, team, opponent), d1/ff_player_ids.json
Usage: python3 fetch_inputs.py <out> [--through-week-2026 N]   (run wrangler from worker/)"""
import json, os, subprocess, sys, time, urllib.request
OUT = sys.argv[1]; W26 = int(sys.argv[sys.argv.index("--through-week-2026") + 1]) if "--through-week-2026" in sys.argv else 5
END = {2018: 16, 2019: 16, 2020: 16, 2021: 17, 2022: 17, 2023: 17, 2024: 17, 2025: 17, 2026: W26}
os.makedirs(OUT + "/mfl", exist_ok=True); os.makedirs(OUT + "/d1", exist_ok=True)
def get(url, path):
    if os.path.exists(path): return
    for i in range(5):
        try:
            data = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ups-backtest-readonly"}), timeout=60).read()
            json.loads(data); open(path, "wb").write(data); time.sleep(0.6); return
        except Exception: time.sleep(3 + 5 * i)
    raise SystemExit("failed " + url)
for y, last in END.items():
    get(f"https://www48.myfantasyleague.com/{y}/export?TYPE=players&L=74598&DETAILS=1&JSON=1", f"{OUT}/mfl/players_{y}.json")
    for w in range(1, last + 1):
        get(f"https://api.myfantasyleague.com/{y}/export?TYPE=nflSchedule&W={w}&JSON=1", f"{OUT}/mfl/sched_{y}_w{w}.json")
        get(f"https://www48.myfantasyleague.com/{y}/export?TYPE=playerScores&L=74598&W={w}&JSON=1", f"{OUT}/mfl/scores_{y}_w{w}.json")
def d1(sql, path):
    r = subprocess.run(["npx", "--yes", "wrangler@4.87.0", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql], capture_output=True, text=True, check=True)
    json.dump(json.loads(r.stdout)[0]["results"], open(path, "w"))
for y in END: d1(f"SELECT season, week, gsis_id, team, opponent, position FROM nfl_player_weekly WHERE season={y} AND week<=18", f"{OUT}/d1/weekly_team_opp_{y}.json")
d1("SELECT mfl_id, gsis_id, pfr_id, name, position, team FROM ff_player_ids", f"{OUT}/d1/ff_player_ids.json")
print("inputs ready in", OUT)
