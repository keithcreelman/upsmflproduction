#!/usr/bin/env python3
"""PLAYOFF-FLAG TEST -- the live season sync never guesses MFL's regularSeason flag.

WHY (Keith 2026-10-09)
======================
The standings race module fails closed on a malformed playoff flag (F3), but it
could never see one: this sync read `regularSeason` with safe_int(..., 1), so a
matchup with no flag (or a garbled one) was written to D1 as is_playoff = 0 --
regular season -- and every reader after that saw a valid-looking 0. Once a guess
is written as 0/1 nobody downstream can tell it was a guess, so the sync itself
has to refuse.

WHAT IS PROVEN HERE
===================
1. regular_season_flag(): "1" -> 1, "0" -> 0, the same as integers; missing,
   None, "", "x", "2", "00" and "1.0" -> None (never a default).
2. main(), end to end against a canned four-team league (network stubbed, D1
   writes RECORDED, not executed):
   a. every flag present: the run writes, Week 15 ("0") as is_playoff = 1 and
      Weeks 1-14 as 0, in both src_schedule and src_franchise_weekly_score;
   b. ONE Week-3 matchup without a usable flag (each malformed value in turn):
      the run exits non-zero with REFUSE naming the week and the two franchises,
      and NOTHING is written to D1 -- not even the weeks that were fine.

    python3 pipelines/etl/scripts/test_live_sync_playoff_flag.py
"""
from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("standings_sync", HERE / "sync_live_season_from_mfl_to_d1.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FIDS = ["0001", "0002", "0003", "0004"]
LEAGUE = {"league": {
    "divisions": {"division": [{"id": "01", "name": "East"}, {"id": "02", "name": "West"}]},
    "franchises": {"franchise": [{"id": f, "name": "Team " + f, "division": "01" if f < "0003" else "02", "logo": ""}
                                 for f in FIDS]},
}}
PAIRS = [("0001", "0003"), ("0002", "0004")]
SCORES = {"0001": 180.0, "0002": 200.0, "0003": 150.0, "0004": 170.0}
ABSENT = object()


def weekly_results(week, flag_for):
    matchups = []
    for a, b in PAIRS:
        fr = []
        for me, them in ((a, b), (b, a)):
            s = SCORES[me] + week
            res = "W" if s > SCORES[them] + week else "L"
            fr.append({"id": me, "score": "%.1f" % s, "opt_pts": "%.1f" % (s + 10), "result": res,
                       "isHome": "1" if me == a else "0", "starters": "p%s" % me,
                       "player": [{"id": "p%s" % me, "status": "starter", "score": "%.1f" % s}]})
        m = {"franchise": fr}
        flag = flag_for(week, a)
        if flag is not ABSENT:
            m["regularSeason"] = flag
        matchups.append(m)
    return {"weeklyResults": {"week": str(week), "matchup": matchups}}


def league_standings(played):
    """MFL's own leagueStandings over every played week, computed independently of the script
    (the sync refuses to write when its standings disagree with MFL's)."""
    out = []
    for f in FIDS:
        w = l = apw = apl = 0
        pf = 0.0
        for wk in played:
            sc = {g: SCORES[g] + wk for g in FIDS}
            pf += sc[f]
            opp = [b if a == f else a for a, b in PAIRS if f in (a, b)][0]
            w += sc[f] > sc[opp]; l += sc[f] < sc[opp]
            for g in FIDS:
                if g != f:
                    apw += sc[f] > sc[g]; apl += sc[f] < sc[g]
        pp = pf + 10 * len(played)
        out.append({"id": f, "h2hw": str(w), "h2hl": str(l), "divw": "0", "divl": "0", "pf": "%.2f" % pf,
                    "pp": "%.2f" % pp, "eff": "%.1f" % (pf / pp * 100), "all_play_wlt": "%d-%d-0" % (apw, apl),
                    "salary": "$300000.00"})
    return {"leagueStandings": {"franchise": out}}


PLAYERS = {"players": {"player": [{"id": "p%s" % f, "name": "Player, %s" % f, "position": "LB", "team": "DET"}
                                  for f in FIDS]}}


def run_main(weeks, flag_for):
    def fake_fetch_mfl(season, league_id, server, type_name, extra=None):
        if type_name == "league":
            return copy.deepcopy(LEAGUE)
        if type_name == "leagueStandings":
            return league_standings(sorted(weeks))
        if type_name == "weeklyResults":
            wk = int((extra or {}).get("W"))
            return weekly_results(wk, flag_for) if wk in weeks else {"weeklyResults": {"week": str(wk), "matchup": []}}
        if type_name == "players":
            return copy.deepcopy(PLAYERS)
        if type_name == "transactions":
            return {"transactions": {"transaction": []}}
        raise AssertionError(f"unexpected MFL export {type_name}")

    executed, rows_by_table = [], {}
    real_build_sql = mod.build_sql

    def recording_build_sql(table, cols, rows, pk_cols):
        rows_by_table[table] = copy.deepcopy(rows)
        return real_build_sql(table, cols, rows, pk_cols)

    mod.fetch_mfl = fake_fetch_mfl
    mod.fetch_owner_map = lambda seasons: ({f: "Owner " + f for f in FIDS}, 2025)
    mod.d1_execute_file = lambda sql, label: executed.append(label)
    mod.build_sql = recording_build_sql
    old_argv = sys.argv
    sys.argv = ["sync_live_season_from_mfl_to_d1.py", "--season", "2026", "--max-week", "17"]
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            try:
                rc = mod.main()
            except SystemExit as e:
                rc = e.code
    finally:
        sys.argv = old_argv
        mod.build_sql = real_build_sql
    return rc, executed, rows_by_table


fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


print("1. regular_season_flag() recognizes exactly \"1\" / \"0\"")
for raw, want in (("1", 1), ("0", 0), (1, 1), (0, 0), (" 1 ", 1)):
    check(f"{raw!r} -> {want}", mod.regular_season_flag({"regularSeason": raw}) == want)
check("missing -> None", mod.regular_season_flag({}) is None)
for raw in (None, "", "x", "2", "00", "1.0", "-1", "true"):
    check(f"{raw!r} -> None (never defaulted)", mod.regular_season_flag({"regularSeason": raw}) is None)

WEEKS = set(range(1, 16))                 # the sync stops at the first unplayed week, so weeks are contiguous
print("2a. every flag present: written, Week 15 as a playoff week")
rc, executed, rows = run_main(WEEKS, lambda wk, a: "0" if wk == 15 else "1")
check("exit 0", rc in (0, None), f"rc={rc!r}")
check("src_schedule and src_franchise_weekly_score written",
      "src_schedule" in executed and "src_franchise_weekly_score" in executed, str(executed))
for table in ("src_schedule", "src_franchise_weekly_score"):
    flags = {(r["week"], r["is_playoff"]) for r in rows.get(table, [])}
    check(f"{table}: weeks 1-14 is_playoff 0, week 15 is_playoff 1",
          flags == {(w, 0) for w in range(1, 15)} | {(15, 1)}, str(sorted(flags)))

print("2b. one Week-3 matchup without a usable flag: REFUSE, nothing written")
for label, bad in (("missing", ABSENT), ("None", None), ('""', ""), ('"x"', "x"), ('"2"', "2"), ('"00"', "00")):
    rc, executed, rows = run_main(WEEKS, lambda wk, a: bad if (wk, a) == (3, "0002") else ("0" if wk == 15 else "1"))
    msg = str(rc)
    check(f"regularSeason {label}: refused (non-zero exit naming week 3, 0002-0004)",
          rc not in (0, None) and "REFUSE" in msg and "week 3 0002-0004" in msg, msg[:300])
    check(f"regularSeason {label}: zero D1 writes", executed == [], str(executed))

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILURE(S)'}")
sys.exit(1 if fails else 0)
