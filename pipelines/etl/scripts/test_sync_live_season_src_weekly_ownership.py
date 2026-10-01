#!/usr/bin/env python3
"""src_weekly OWNERSHIP TEST -- the standings sync must never write src_weekly.

WHAT HAPPENED (2026-09-29, the thing this test exists for)
==========================================================
scripts/sync_live_season_weekly.sh runs two scripts and retries each one
independently:
  - sync_live_weekly_scores_to_d1.py  writes src_weekly from MFL's whole
    TYPE=playerScores universe (starters, bench, taxi, free agents);
  - sync_live_season_from_mfl_to_d1.py  (standings) ALSO wrote src_weekly, from
    weeklyResults -- ACTIVE rosters only -- through build_sql(), which opens
    with `DELETE FROM src_weekly WHERE season = 2026`.
The weekly script landed week 3 at 05:00:28Z (3,631 rows). The standings
script's D1 auth failed until 10:01:17Z, then it deleted the season and wrote
1,073 rows. Every free agent and taxi player lost all of his 2026 weeks; the
leaderboard precompute was rebuilt from that on 09-30 and the mobile Players
market showed Chase McLaughlin 0.0 (MFL: 42.1), Matthew Golden 0.0 (50.7), and
241 of the 481 players it returned wrong.

WHAT IS PROVEN HERE
===================
1. END TO END -- main() is run for real against a canned two-team MFL league
   (every network call stubbed, every D1 write RECORDED instead of executed).
   No executed SQL may mention src_weekly; the tables this script does own
   (standings set + src_players/src_adddrop/src_trades) must still be written.
   On the pre-fix script this fails: it executes
   `DELETE FROM src_weekly WHERE season = 2026;`.
2. The starter-sum gate still works: a franchise whose starters don't add up to
   MFL's team score still blocks the per-player tables (rows are still BUILT
   for that check even though src_weekly is never written).
3. per_player_write_plan() names exactly the three tables this script owns.

Usage:
  python3 pipelines/etl/scripts/test_sync_live_season_src_weekly_ownership.py
"""
from __future__ import annotations

import copy
import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("standings_sync", HERE / "sync_live_season_from_mfl_to_d1.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

LEAGUE = {"league": {
    "divisions": {"division": [{"id": "01", "name": "East"}]},
    "franchises": {"franchise": [
        {"id": "0001", "name": "Alpha", "division": "01", "logo": ""},
        {"id": "0002", "name": "Bravo", "division": "01", "logo": ""},
    ]},
}}
WEEK1 = {"weeklyResults": {"week": "1", "matchup": [{
    "regularSeason": "1",
    "franchise": [
        {"id": "0001", "score": "100.0", "opt_pts": "110.0", "result": "W", "isHome": "1",
         "starters": "11,12", "player": [
             {"id": "11", "status": "starter", "score": "60.0"},
             {"id": "12", "status": "starter", "score": "40.0"},
             {"id": "13", "status": "nonstarter", "score": "5.0"},
         ]},
        {"id": "0002", "score": "90.0", "opt_pts": "100.0", "result": "L", "isHome": "0",
         "starters": "21,22", "player": [
             {"id": "21", "status": "starter", "score": "50.0"},
             {"id": "22", "status": "starter", "score": "40.0"},
         ]},
    ],
}]}}
WEEK_UNPLAYED = {"weeklyResults": {"week": "2", "matchup": []}}
STANDINGS = {"leagueStandings": {"franchise": [
    {"id": "0001", "h2hw": "1", "h2hl": "0", "divw": "1", "divl": "0", "pf": "100.0", "pp": "110.0",
     "eff": "90.9", "all_play_wlt": "1-0-0", "salary": "$299000.00"},
    {"id": "0002", "h2hw": "0", "h2hl": "1", "divw": "0", "divl": "1", "pf": "90.0", "pp": "100.0",
     "eff": "90.0", "all_play_wlt": "0-1-0", "salary": "$280000.00"},
]}}
PLAYERS = {"players": {"player": [
    {"id": "11", "name": "One, QB", "position": "QB", "team": "BUF"},
    {"id": "12", "name": "Two, RB", "position": "RB", "team": "DET"},
    {"id": "13", "name": "Three, WR", "position": "WR", "team": "SEA"},
    {"id": "21", "name": "Four, TE", "position": "TE", "team": "ARI"},
    {"id": "22", "name": "Five, LB", "position": "LB", "team": "SF"},
    # A free agent MFL scores but no weeklyResults lists -- exactly the player
    # src_weekly lost on 2026-09-29.
    {"id": "99", "name": "Free, Agent", "position": "PK", "team": "MIA"},
]}}
TRANSACTIONS = {"transactions": {"transaction": []}}


def run_main(week1):
    def fake_fetch_mfl(season, league_id, server, type_name, extra=None):
        if type_name == "league":
            return copy.deepcopy(LEAGUE)
        if type_name == "leagueStandings":
            return copy.deepcopy(STANDINGS)
        if type_name == "weeklyResults":
            return copy.deepcopy(week1 if str((extra or {}).get("W")) == "1" else WEEK_UNPLAYED)
        if type_name == "players":
            return copy.deepcopy(PLAYERS)
        if type_name == "transactions":
            return copy.deepcopy(TRANSACTIONS)
        raise AssertionError(f"unexpected MFL export {type_name}")

    executed = []
    mod.fetch_mfl = fake_fetch_mfl
    mod.fetch_owner_map = lambda seasons: ({"0001": "Owner A", "0002": "Owner B"}, 2025)
    mod.d1_execute_file = lambda sql, label: executed.append((label, sql))
    old_argv = sys.argv
    sys.argv = ["sync_live_season_from_mfl_to_d1.py", "--season", "2026"]
    try:
        rc = mod.main()
    finally:
        sys.argv = old_argv
    return rc, executed


fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


print("1. end to end: main() never touches src_weekly")
rc, executed = run_main(WEEK1)
labels = [lbl for lbl, _ in executed]
weekly_sql = [(lbl, sql.splitlines()[0]) for lbl, sql in executed if "src_weekly" in sql]
check("main() exits 0 on a clean week", rc == 0, f"rc={rc}")
check("no executed SQL mentions src_weekly", not weekly_sql, f"executed: {weekly_sql}")
check("standings tables still written",
      all(t in labels for t in ("src_franchises", "src_schedule", "src_franchise_weekly_score", "src_standings")),
      f"labels={labels}")
check("its own per-player tables still written, players first",
      labels[-3:] == ["src_players", "src_adddrop", "src_trades"], f"labels={labels}")

print("2. the starter-sum gate still blocks the per-player tables")
bad = copy.deepcopy(WEEK1)
bad["weeklyResults"]["matchup"][0]["franchise"][0]["player"][0]["score"] = "59.0"   # starters now sum to 99 != 100
rc_bad, executed_bad = run_main(bad)
labels_bad = [lbl for lbl, _ in executed_bad]
check("a starter-sum mismatch returns non-zero", rc_bad == 1, f"rc={rc_bad}")
check("...and writes none of the per-player tables",
      not any(t in labels_bad for t in ("src_players", "src_adddrop", "src_trades")), f"labels={labels_bad}")
check("...and still no src_weekly", not any("src_weekly" in sql for _, sql in executed_bad))

print("3. per_player_write_plan names exactly the tables this script owns")
plan = mod.per_player_write_plan(2026, [], [], [])
check("labels", [lbl for lbl, _ in plan] == ["src_players", "src_adddrop", "src_trades"],
      f"{[lbl for lbl, _ in plan]}")
check("no src_weekly anywhere in the plan", not any("src_weekly" in (sql or "") for _, sql in plan))

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILURE(S)'}")
sys.exit(1 if fails else 0)
