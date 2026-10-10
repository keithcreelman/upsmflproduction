#!/usr/bin/env python3
"""EPA definition of fetch_nflverse_epa.py on hand-built plays (settled 2026-10-10).

    python3 pipelines/etl/scripts/test_fetch_nflverse_epa.py

A player's EPA plays are his box-score plays — attempts + sacks (spikes are
attempts), carries (kneels included), targets — and two-point tries are left
out. Success = the share of those same plays with EPA above zero, on the same
EPA column (qb_epa for a passer). No network: nflreadpy is stubbed.
"""
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))
import pandas as pd
import nflreadpy

base = dict(season=2026, season_type="REG", week=1, two_point_attempt=0, cpoe=None,
            passer_player_id=None, receiver_player_id=None, rusher_player_id=None)
PLAYS = pd.DataFrame([
    {**base, "play_type": "pass", "passer_player_id": "QB1", "receiver_player_id": "WR1", "epa": 1.0, "qb_epa": 1.0, "cpoe": 10.0, "success": 1},
    # the receiver fumbles after the catch: the play's epa is -2.0, the passer is charged qb_epa +0.5
    {**base, "play_type": "pass", "passer_player_id": "QB1", "receiver_player_id": "WR1", "epa": -2.0, "qb_epa": 0.5, "cpoe": -5.0, "success": 0},
    {**base, "play_type": "pass", "passer_player_id": "QB1", "epa": -1.5, "qb_epa": -1.5, "success": 0},           # a sack: a dropback
    {**base, "play_type": "qb_spike", "passer_player_id": "QB1", "epa": -0.2, "qb_epa": -0.2, "success": 0},       # a spike is an attempt
    {**base, "play_type": "pass", "passer_player_id": "QB1", "receiver_player_id": "WR1", "epa": 0.9, "qb_epa": 0.9,
     "two_point_attempt": 1, "success": 1},                                                                          # a two-point try: out
    {**base, "play_type": "run", "rusher_player_id": "RB1", "epa": 0.4, "qb_epa": 0.4, "success": 1},
    {**base, "play_type": "run", "rusher_player_id": "RB1", "epa": 0.0, "qb_epa": 0.0, "success": 0},               # exactly 0 is not a success
    {**base, "play_type": "run", "rusher_player_id": "RB1", "epa": 1.1, "qb_epa": 1.1, "two_point_attempt": 1, "success": 1},  # out
    {**base, "play_type": "qb_kneel", "rusher_player_id": "QB1", "epa": -0.3, "qb_epa": -0.3, "success": 0},       # a kneel is a carry
    {**base, "play_type": "run", "rusher_player_id": "QB1", "epa": None, "qb_epa": None, "success": None},          # no EPA: not counted
])
nflreadpy.load_pbp = lambda seasons=None: PLAYS.copy()
def _nosched(*a, **k): raise RuntimeError("offline")
nflreadpy.load_schedules = _nosched
import fetch_nflverse_epa as E

rows = {r[1]: dict(zip(E.COLS, r)) for r in E.compute([2026])}
fails = 0
def check(name, got, want):
    global fails
    ok = got == want
    fails += 0 if ok else 1
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"   got {got!r}, want {want!r}"))

q, w, r = rows["QB1"], rows["WR1"], rows["RB1"]
check("passer plays = 2 attempts + 1 sack + 1 spike (no two-point try)", q["pass_plays"], 4)
check("passer EPA uses qb_epa", round(q["pass_epa_sum"], 4), round(1.0 + 0.5 - 1.5 - 0.2, 4))
check("passer Success = qb_epa > 0 on those plays (the fumbled catch counts for him)", q["pass_succ_sum"], 2.0)
check("CPOE over the plays that have one", (round(q["pass_cpoe_sum"], 4), q["pass_cpoe_n"]), (5.0, 2))
check("receiver: 2 targets, the play's epa, no two-point try", (w["rec_tgt"], round(w["rec_epa_sum"], 4), w["rec_succ_sum"]), (2, -1.0, 1.0))
check("rusher: 2 carries; 0.0 EPA is not a success; the two-point run is out", (r["rush_plays"], round(r["rush_epa_sum"], 4), r["rush_succ_sum"]), (2, 0.4, 1.0))
check("a kneel is a QB carry; a play with no EPA isn't counted", (q["rush_plays"], round(q["rush_epa_sum"], 4)), (1, -0.3))

print(f"\n{'FAILED ' + str(fails) if fails else 'all passed'}")
sys.exit(1 if fails else 0)
