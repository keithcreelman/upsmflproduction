#!/usr/bin/env python3
"""build_player_id_map.build() on hand-built ids — missing, conflicting and changed IDs.

    python3 pipelines/etl/scripts/test_build_player_id_map.py
No network: the MFL players, DynastyProcess rows and nflverse master are inline.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent)); sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import build_player_id_map as M

MFL = [  # MFL players export rows (birthdate = unix seconds)
    {"id": "100", "name": "Two, Lineages", "position": "WR", "espn_id": "9001", "birthdate": "946684800", "draft_year": "2021", "draft_round": "1"},
    {"id": "101", "name": "Dp, Only", "position": "RB", "birthdate": "946684800", "draft_year": "2022", "draft_round": "3"},
    {"id": "102", "name": "Routes, Disagree", "position": "TE", "espn_id": "9002", "birthdate": "946684800"},
    {"id": "103", "name": "Wrong, Era", "position": "CB", "espn_id": "9003", "birthdate": "1020297600", "draft_year": "2026", "draft_round": "5"},
    {"id": "104", "name": "Nobody, Knows", "position": "DT"},
    {"id": "105", "name": "Bio, Typo", "position": "LB", "espn_id": "9005", "birthdate": "978307200", "draft_year": "2023", "draft_round": "2"},
    {"id": "106", "name": "Dup, One", "position": "S"}, {"id": "107", "name": "Dup, Two", "position": "S"},
    {"id": "108", "name": "Na, Gsis", "position": "QB"},
    {"id": "109", "name": "Reviewed, Manual", "position": "DE"},
    {"id": "9999", "name": "Team, Def", "position": "Def"},
]
FF = [  # DynastyProcess rows
    {"mfl_id": 100, "gsis_id": "00-0000100", "espn_id": 9001}, {"mfl_id": 101, "gsis_id": "00-0000101"},
    {"mfl_id": 102, "gsis_id": "00-0000102"}, {"mfl_id": 103, "gsis_id": "00-0026836", "espn_id": 9003},
    {"mfl_id": 105, "gsis_id": "00-0000105", "espn_id": 9005},
    {"mfl_id": 106, "gsis_id": "00-0000106"}, {"mfl_id": 107, "gsis_id": "00-0000106"},
    {"mfl_id": 108, "gsis_id": "NA"},
]
NPL = [  # nflverse master
    {"gsis_id": "00-0000100", "espn_id": "9001", "birth_date": "2000-01-01", "draft_year": 2021, "draft_round": 1, "position": "WR"},
    {"gsis_id": "00-0000101", "birth_date": "2000-01-01", "draft_year": 2022, "draft_round": 3, "position": "RB", "pfr_id": "DpOn00"},
    {"gsis_id": "00-0000102", "birth_date": "2000-01-01", "position": "TE"},
    {"gsis_id": "00-0000999", "espn_id": "9002", "birth_date": "2000-01-01", "position": "TE"},
    {"gsis_id": "00-0026836", "espn_id": "9003", "birth_date": "1986-03-01", "draft_year": 2009, "draft_round": 4, "position": "WR", "rookie_season": 2009},
    {"gsis_id": "00-0000105", "espn_id": "9005", "birth_date": "2001-06-15", "draft_year": 2023, "draft_round": 2, "position": "LB"},
    {"gsis_id": "00-0000106", "position": "S"},
    {"gsis_id": "00-0000109", "position": "DE", "pfr_id": "RevMa00"},
]
OVR = {"109": {"mfl_id": "109", "action": "accept", "gsis_id": "00-0000109", "reason": "reviewed"}}
rows = {r["mfl_id"]: r for r in M.build(MFL, FF, NPL, OVR)}
fails = 0
def check(name, got, want):
    global fails
    ok = got == want; fails += 0 if ok else 1
    print(("  ok   " if ok else "  FAIL ") + name + ("" if ok else f"   got {got!r}, want {want!r}"))
s = lambda k: (rows[k]["status"], rows[k]["accepted"], rows[k]["gsis_id"])
check("two lineages agree -> verified", s("100"), ("verified", 1, "00-0000100"))
check("one DP route, bio consistent -> single_route, with nflverse pfr", (s("101"), rows["101"]["pfr_id"]), (("single_route", 1, "00-0000101"), "DpOn00"))
check("DP and ESPN point at different players -> id_disagree, NOT accepted", s("102")[:2], ("id_disagree", 0))
check("IDs agree but the NFL id is a 2009 draftee for a 2026 rookie -> id_suspect, NOT accepted", s("103")[:2], ("id_suspect", 0))
check("no ID route at all -> unmapped (never a name match)", s("104"), ("unmapped", 0, None))
check("IDs agree, birthdate typo -> bio_flag, accepted", s("105")[:2], ("bio_flag", 1))
check("one NFL id claimed by two MFL ids -> neither accepted", (s("106")[:2], s("107")[:2]), (("dup_claim", 0), ("dup_claim", 0)))
check("DynastyProcess's literal 'NA' is not an id", s("108")[:2], ("unmapped", 0))
check("a reviewed override wins", (s("109"), rows["109"]["pfr_id"]), (("override_accept", 1, "00-0000109"), "RevMa00"))
check("team/defense rows are not players", "9999" in rows, False)
# CHANGED id: DynastyProcess re-points 101 to a new gsis next week — the rebuild follows the routes, no stale value survives
FF2 = [dict(r, gsis_id="00-0000777") if r["mfl_id"] == 101 else r for r in FF]
NPL2 = NPL + [{"gsis_id": "00-0000777", "birth_date": "2000-01-01", "draft_year": 2022, "draft_round": 3, "position": "RB"}]
r2 = {r["mfl_id"]: r for r in M.build(MFL, FF2, NPL2, {})}
check("a changed upstream id is picked up on the next build", (r2["101"]["gsis_id"], r2["101"]["accepted"]), ("00-0000777", 1))
print(f"\n{'FAILED ' + str(fails) if fails else 'all passed'}"); sys.exit(1 if fails else 0)
