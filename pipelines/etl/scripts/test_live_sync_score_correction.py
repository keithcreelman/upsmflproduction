#!/usr/bin/env python3
"""SCORE-CORRECTION TEST -- a stat correction inside an already-synced week must
reach D1.

WHAT HAPPENED (2026 Week 4, the thing this test exists for)
===========================================================
The Tuesday 01:00 run (2026-10-06 05:00Z) synced weeks 1-4 and recorded
"max_week=4". Elias's Week 4 changes posted Wed Oct 7, 11:32 PM ET; MFL applied
them (Eric Martel 251.2 -> 250.2, now below Shawn Blake's 250.9), so MFL's
all-play became Martel 34-10, Blake 32-12. D1 -- and /api/standings and every
standings page -- kept 35-9 / 31-13: nothing fired after Tuesday, and the
wrapper's only state was the week number, which a correction never changes.

WHAT IS PROVEN HERE
===================
1. sync_live_season_from_mfl_to_d1.main(), end to end against a canned
   four-team league (network stubbed, D1 writes RECORDED, not executed):
   a. the initial Week 4 sync writes Martel-like team A at 251.2 and the
      pre-correction all-play;
   b. after A's Week 4 score drops to 250.2 (same week number), a run handed
      the first run's fingerprint does NOT skip -- it rewrites
      src_franchise_weekly_score (250.2) and src_standings (A loses one
      all-play win to B, B gains it; head-to-head unchanged);
   c. a rerun with the new fingerprint writes nothing;
   d. --standings-only writes exactly the four standings tables;
   e. the fingerprint moves on a bench-only (potential points) correction and
      on two offsetting corrections, where a sum would not.
2. scripts/sync_live_season_weekly.sh (the real wrapper, stub sync scripts):
   a. refresh mode, state "4 fpA", MFL now fpB at week 4 -> re-synced, state
      "4 fpB", exit 0, ONE pass, and --skip-if-fingerprint fpA was passed
      (the pre-fix wrapper logged "no new week yet" and recorded nothing);
   b. refresh mode, unchanged -> exit 0, state untouched, one pass;
   c. Tuesday mode, a new week -> recorded as before;
   d. a legacy state file ("4", no fingerprint) -> no skip flag, then recorded;
   e. a failing sync -> exit 1, state untouched.
3. The installer's plist fires Tuesday 01:00 AND Thursday/Friday 08:00.

Usage:
  python3 pipelines/etl/scripts/test_live_sync_score_correction.py
"""
from __future__ import annotations

import contextlib
import copy
import importlib.util
import io
import os
import plistlib
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
spec = importlib.util.spec_from_file_location("standings_sync", HERE / "sync_live_season_from_mfl_to_d1.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

FIDS = ["0001", "0002", "0003", "0004"]          # A (Martel-like), B (Blake-like), C, D
LEAGUE = {"league": {
    "divisions": {"division": [{"id": "01", "name": "East"}, {"id": "02", "name": "West"}]},
    "franchises": {"franchise": [
        {"id": "0001", "name": "Alpha", "division": "01", "logo": ""},
        {"id": "0002", "name": "Bravo", "division": "01", "logo": ""},
        {"id": "0003", "name": "Charlie", "division": "02", "logo": ""},
        {"id": "0004", "name": "Delta", "division": "02", "logo": ""},
    ]},
}}
PAIRS = [("0001", "0003"), ("0002", "0004")]       # never divisional, so div records stay 0
WEEKS = {                                          # week -> {fid: score}
    1: {"0001": 180.0, "0002": 200.0, "0003": 150.0, "0004": 170.0},
    2: {"0001": 210.0, "0002": 160.0, "0003": 190.0, "0004": 175.0},
    3: {"0001": 199.5, "0002": 201.5, "0003": 160.0, "0004": 230.0},
    # Week 4 as Tuesday's sync saw it: A 251.2 just above B 250.9.
    4: {"0001": 251.2, "0002": 250.9, "0003": 181.4, "0004": 207.0},
}


def weekly_results(week, scores, opt_bonus=None):
    matchups = []
    for a, b in PAIRS:
        fr = []
        for me, them in ((a, b), (b, a)):
            s = scores[me]
            res = "W" if s > scores[them] else ("L" if s < scores[them] else "T")
            fr.append({"id": me, "score": "%.1f" % s, "opt_pts": "%.1f" % (s + 10 + (opt_bonus or {}).get(me, 0)),
                       "result": res, "isHome": "1" if me == a else "0", "starters": "p%s" % me,
                       "player": [{"id": "p%s" % me, "status": "starter", "score": "%.1f" % s}]})
        matchups.append({"regularSeason": "1", "franchise": fr})
    return {"weeklyResults": {"week": str(week), "matchup": matchups}}


def league_standings(weeks, opt_bonus=None):
    """MFL's own leagueStandings, computed independently of the script."""
    out = []
    for f in FIDS:
        w = l = t = apw = apl = apt = 0
        pf = pp = 0.0
        for wk, sc in weeks.items():
            pf += sc[f]
            pp += sc[f] + 10 + ((opt_bonus or {}).get(f, 0) if wk == 4 else 0)
            opp = [b if a == f else a for a, b in PAIRS if f in (a, b)][0]
            w += sc[f] > sc[opp]; l += sc[f] < sc[opp]; t += sc[f] == sc[opp]
            for g in FIDS:
                if g != f:
                    apw += sc[f] > sc[g]; apl += sc[f] < sc[g]; apt += sc[f] == sc[g]
        out.append({"id": f, "h2hw": str(w), "h2hl": str(l), "divw": "0", "divl": "0", "pf": "%.2f" % pf,
                    "pp": "%.2f" % pp, "eff": "%.1f" % (pf / pp * 100), "all_play_wlt": "%d-%d-%d" % (apw, apl, apt),
                    "salary": "$300000.00"})
    return {"leagueStandings": {"franchise": out}}


PLAYERS = {"players": {"player": [{"id": "p%s" % f, "name": "Player, %s" % f, "position": "LB", "team": "DET"}
                                  for f in FIDS]}}


def run_main(weeks, extra_args=(), opt_bonus=None):
    def fake_fetch_mfl(season, league_id, server, type_name, extra=None):
        if type_name == "league":
            return copy.deepcopy(LEAGUE)
        if type_name == "leagueStandings":
            return league_standings(weeks, opt_bonus)
        if type_name == "weeklyResults":
            wk = int((extra or {}).get("W"))
            if wk in weeks:
                return weekly_results(wk, weeks[wk], opt_bonus if wk == 4 else None)
            return {"weeklyResults": {"week": str(wk), "matchup": []}}
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
    sys.argv = ["sync_live_season_from_mfl_to_d1.py", "--season", "2026", *extra_args]
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            rc = mod.main()
    finally:
        sys.argv = old_argv
        mod.build_sql = real_build_sql
    out = buf.getvalue()
    fp = [ln.split("=", 1)[1] for ln in out.splitlines() if ln.startswith("SYNC_FINGERPRINT=")]
    return rc, executed, rows_by_table, (fp[-1] if fp else None), out


fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


def week4(rows, fid):
    return [r["team_score"] for r in rows["src_franchise_weekly_score"] if r["week"] == 4 and r["franchise_id"] == fid][0]


def ap(rows, fid):
    r = [x for x in rows["src_standings"] if x["franchise_id"] == fid][0]
    return (r["allplay_w"], r["allplay_l"], r["allplay_t"]), (r["h2h_w"], r["h2h_l"], r["h2h_t"])


print("1. a Week 4 correction after the initial Week 4 sync reaches D1")
rc1, ex1, rows1, fp1, _ = run_main(WEEKS)
check("initial sync exits 0 and prints a fingerprint", rc1 == 0 and bool(fp1), f"rc={rc1} fp={fp1}")
check("initial sync writes A's Week 4 at 251.2", week4(rows1, "0001") == 251.2, str(week4(rows1, "0001")))
(a_ap1, a_h1), (b_ap1, b_h1) = ap(rows1, "0001"), ap(rows1, "0002")

corrected = copy.deepcopy(WEEKS)
corrected[4]["0001"] = 250.2                       # Elias: A drops below B, same week number
rc2, ex2, rows2, fp2, out2 = run_main(corrected, ["--skip-if-fingerprint", fp1])
check("the corrected run is not skipped", rc2 == 0 and "src_standings" in ex2, f"rc={rc2} executed={ex2}")
check("the fingerprint moved", fp2 and fp2 != fp1, f"{fp1} -> {fp2}")
check("src_franchise_weekly_score now has 250.2", rows2 and week4(rows2, "0001") == 250.2,
      str(rows2 and week4(rows2, "0001")))
(a_ap2, a_h2), (b_ap2, b_h2) = ap(rows2, "0001"), ap(rows2, "0002")
check("A's all-play loses exactly one win to B", a_ap2 == (a_ap1[0] - 1, a_ap1[1] + 1, a_ap1[2]), f"{a_ap1} -> {a_ap2}")
check("B's all-play gains exactly that win", b_ap2 == (b_ap1[0] + 1, b_ap1[1] - 1, b_ap1[2]), f"{b_ap1} -> {b_ap2}")
check("head-to-head unchanged for both", a_h2 == a_h1 and b_h2 == b_h1, f"A {a_h1}->{a_h2} B {b_h1}->{b_h2}")

rc3, ex3, rows3, fp3, out3 = run_main(corrected, ["--skip-if-fingerprint", fp2])
check("a rerun with the new fingerprint writes nothing", rc3 == 0 and ex3 == [] and fp3 == fp2,
      f"rc={rc3} executed={ex3}")
check("...and says so", "nothing written" in out3)

rc4, ex4, _, _, _ = run_main(corrected, ["--standings-only"])
check("--standings-only writes exactly the four standings tables",
      rc4 == 0 and ex4 == ["src_franchises", "src_schedule", "src_franchise_weekly_score", "src_standings"],
      f"rc={rc4} executed={ex4}")

_, _, _, fp_bench, _ = run_main(corrected, opt_bonus={"0003": 1.5})
check("a bench-only (potential points) correction moves the fingerprint", fp_bench and fp_bench != fp2)
offset = copy.deepcopy(corrected)
offset[4]["0003"] += 1.0
offset[4]["0004"] -= 1.0                           # team-score total unchanged
_, _, _, fp_off, _ = run_main(offset)
check("two offsetting corrections move the fingerprint (no sums)", fp_off and fp_off != fp2)

print("2. the wrapper re-syncs on a fingerprint change, not just a new week")
WRAPPER = REPO / "scripts" / "sync_live_season_weekly.sh"
STUB = """import os, sys
open(os.environ["STUB_LOG"], "a").write(os.path.basename(__file__) + " " + " ".join(sys.argv[1:]) + "\\n")
if os.environ.get("STUB_RC", "0") != "0":
    print("boom"); sys.exit(int(os.environ["STUB_RC"]))
print("SYNC_FINGERPRINT=" + os.environ["STUB_FP"])
print("SYNC_RESULT week_nums=[1] max_week=" + os.environ["STUB_WEEK"])
"""


def run_wrapper(state, mode, fp, week, rc="0"):
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        for name in ("standings.py", "weekly.py"):
            (td / name).write_text(STUB)
        (td / "state").mkdir()
        if state is not None:
            for label in ("standings", "weekly"):
                (td / "state" / f"last_week_{label}_2026.txt").write_text(state + "\n")
        env = dict(os.environ, UPSMFL_LIVE_SYNC_SCRIPT=str(td / "standings.py"),
                   UPSMFL_LIVE_WEEKLY_SCRIPT=str(td / "weekly.py"), UPSMFL_LIVE_SYNC_STATE_DIR=str(td / "state"),
                   UPSMFL_LIVE_SYNC_MODE=mode, UPSMFL_LIVE_SYNC_MAX_ATTEMPTS="3", UPSMFL_LIVE_SYNC_RETRY_SLEEP="0",
                   STUB_LOG=str(td / "calls.log"), STUB_FP=fp, STUB_WEEK=str(week), STUB_RC=rc)
        p = subprocess.run(["/bin/bash", str(WRAPPER)], env=env, capture_output=True, text=True, timeout=60)
        calls = (td / "calls.log").read_text().splitlines() if (td / "calls.log").exists() else []
        states = {label: (td / "state" / f"last_week_{label}_2026.txt").read_text().strip()
                  for label in ("standings", "weekly") if (td / "state" / f"last_week_{label}_2026.txt").exists()}
        return p.returncode, calls, states, p.stdout + p.stderr


rc, calls, states, log = run_wrapper("4 fpA", "refresh", "fpB", 4)
check("refresh + changed fingerprint: exit 0", rc == 0, log[-600:])
check("...one pass per script", len(calls) == 2, str(calls))
check("...handed the recorded fingerprint", all("--skip-if-fingerprint fpA" in c for c in calls), str(calls))
check("...and recorded the new one", states == {"standings": "4 fpB", "weekly": "4 fpB"}, str(states))
check("...logged as a correction", "stat corrections" in log, log[-600:])

rc, calls, states, log = run_wrapper("4 fpB", "refresh", "fpB", 4)
check("refresh + unchanged: exit 0, one pass, state untouched",
      rc == 0 and len(calls) == 2 and states == {"standings": "4 fpB", "weekly": "4 fpB"}, f"rc={rc} {calls} {states}")

rc, calls, states, log = run_wrapper("4 fpB", "await-new-week", "fpC", 5)
check("Tuesday mode + new week: recorded", rc == 0 and states == {"standings": "5 fpC", "weekly": "5 fpC"},
      f"rc={rc} {states}")

rc, calls, states, log = run_wrapper("4", "refresh", "fpB", 4)
check("legacy state file: no skip flag, then recorded",
      rc == 0 and all("--skip-if-fingerprint" not in c for c in calls)
      and states == {"standings": "4 fpB", "weekly": "4 fpB"}, f"rc={rc} {calls} {states}")

rc, calls, states, log = run_wrapper("4 fpA", "refresh", "fpB", 4, rc="1")
check("a failing sync: exit 1, state untouched", rc == 1 and states == {"standings": "4 fpA", "weekly": "4 fpA"},
      f"rc={rc} {states}")

print("3. the installer fires after Elias, not only on Tuesday")
p = subprocess.run(["/bin/bash", str(REPO / "scripts" / "install_live_season_sync_cron.sh"), "--print-plist"],
                   capture_output=True, timeout=30)
intervals = plistlib.loads(p.stdout)["StartCalendarInterval"] if p.returncode == 0 else []
check("Tuesday 01:00, Thursday 08:00 and Friday 08:00",
      [(d["Weekday"], d["Hour"]) for d in intervals] == [(2, 1), (4, 8), (5, 8)], str(intervals))

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILURE(S)'}")
sys.exit(1 if fails else 0)
