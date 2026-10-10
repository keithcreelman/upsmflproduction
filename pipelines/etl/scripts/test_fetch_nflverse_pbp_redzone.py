#!/usr/bin/env python3
"""Red-zone rules of fetch_nflverse_pbp.py on hand-built plays (migration 0169).

    python3 pipelines/etl/scripts/test_fetch_nflverse_pbp_redzone.py

No network, no D1: nflreadpy.load_pbp is replaced by the plays below and the
run writes to an in-memory SQLite with --skip-d1. Each case is a defect the
2026-10-10 audit found on the real 2026 play-by-play.
"""
import argparse
import sqlite3
import sys
import types
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))

import pandas as pd

NAN = float("nan")
base = dict(season=2026, season_type="REG", week=1, posteam="AAA", down=1, td_team=None, two_point_attempt=0, sack=0,
            qb_scramble=0, complete_pass=0, pass_touchdown=0, rush_touchdown=0, touchdown=0, air_yards=None,
            passer_player_id=None, receiver_player_id=None, rusher_player_id=None, yards_gained=0)
PLAYS = pd.DataFrame([
    # QB1 completes a TD pass to WR1 from the 10; it reached the end zone.
    {**base, "play_type": "pass", "yardline_100": 10, "passer_player_id": "QB1", "receiver_player_id": "WR1",
     "complete_pass": 1, "pass_touchdown": 1, "touchdown": 1, "td_team": "AAA", "air_yards": 10},
    # QB1 sacked at the 15: a sack, NOT an attempt; no target.
    {**base, "play_type": "pass", "yardline_100": 15, "passer_player_id": "QB1", "sack": 1},
    # QB1 throws it away at the 12: an attempt with NO receiver (pandas NaN) — never a 'nan' player.
    {**base, "play_type": "pass", "yardline_100": 12, "passer_player_id": "QB1", "receiver_player_id": NAN},
    # A two-point try to WR1 from the 2: not a red-zone play at all.
    {**base, "play_type": "pass", "yardline_100": 2, "passer_player_id": "QB1", "receiver_player_id": "WR1",
     "complete_pass": 1, "two_point_attempt": 1},
    # RB1 carries from the 4 and fumbles; the defense returns it for a TD (touchdown=1, rush_touchdown=0).
    {**base, "play_type": "run", "yardline_100": 4, "rusher_player_id": "RB1", "touchdown": 1, "td_team": "BBB"},
    # QB1 scrambles from the 8: a carry (the box score counts it), and a team scramble.
    {**base, "play_type": "run", "yardline_100": 8, "rusher_player_id": "QB1", "qb_scramble": 1},
    # A deep shot to WR1 from the 40 that reached the end zone: an end-zone target, not a red-zone one.
    {**base, "play_type": "pass", "yardline_100": 40, "passer_player_id": "QB1", "receiver_player_id": "WR1", "air_yards": 40},
])

import nflreadpy
nflreadpy.load_pbp = lambda seasons=None: PLAYS.copy()
import fetch_nflverse_pbp as F

db = sqlite3.connect(":memory:")
F.ensure_table(db)
db.execute("CREATE TABLE nfl_team_weekly (season INTEGER, week INTEGER, team TEXT, fourth_down_total INTEGER, fourth_down_go INTEGER,"
           " fourth_down_punt INTEGER, fourth_down_fg INTEGER, stall_punts INTEGER, team_punts INTEGER, PRIMARY KEY (season, week, team))")
F.process_season(db, 2026, argparse.Namespace(skip_d1=True, skip_local=False), do_redzone=True, do_fg=False, do_punts=False, do_team=False)
db.row_factory = sqlite3.Row
P = {r["gsis_id"]: dict(r) for r in db.execute("SELECT * FROM nfl_player_redzone")}
T = dict(db.execute("SELECT * FROM nfl_team_weekly WHERE team = 'AAA'").fetchone())

fails = 0
def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"   got {got!r}, want {want!r}"))

check("no row for a missing receiver ('nan')", sorted(P), ["QB1", "RB1", "WR1"])
check("QB attempts exclude the sack and the 2-pt try", P["QB1"]["pass_att_i20"], 2)
check("QB completions inside the 20 are stored", P["QB1"]["pass_cmp_i20"], 1)
check("QB inside-20 TDs from pass_touchdown", P["QB1"]["pass_tds_i20"], 1)
check("the sack is counted on its own", P["QB1"]["sacks_i20"], 1)
check("a scramble is a QB carry", P["QB1"]["rush_att_i20"], 1)
check("WR targets inside the 20 exclude the 2-pt try", P["WR1"]["targets_i20"], 1)
check("end-zone targets count the deep shot from the 40", P["WR1"]["targets_ez"], 2)
check("a defensive return TD is not the runner's TD", P["RB1"]["rush_tds_i20"], 0)
check("RB inside-5 carry counted", P["RB1"]["rush_att_i5"], 1)
check("team: attempts / sacks / carries / scrambles", (T["rz_pass_att"], T["rz_sacks"], T["rz_carries"], T["rz_scrambles"]), (2, 1, 2, 1))
check("team: targets need a receiver; end zone from anywhere", (T["rz_targets"], T["ez_targets"], T["ez_targets_i20"], T["i5_carries"]), (1, 2, 1, 1))
check("team red-zone totals never touch the 4th-down columns", T["fourth_down_total"], None)

# The team's red-zone play mix (the leaderboard's "Tm RZ Pass%"): dropbacks =
# attempts + sacks + scrambles; plays = attempts + sacks + carries (scrambles
# are carries). Nothing is attributed to "the QB on the field".
check("team red-zone mix: 4 dropbacks of 5 plays", (T["rz_pass_att"] + T["rz_sacks"] + T["rz_scrambles"], T["rz_pass_att"] + T["rz_sacks"] + T["rz_carries"]), (4, 5))
check("no per-QB 'plays with him at QB' column", [c for c in P["QB1"] if c.startswith("rz_qb_")], [])

print(f"\n{'FAILED ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
