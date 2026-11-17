#!/usr/bin/env python3
"""POTENTIAL-POINTS GATE TEST -- a small pp/eff gap warns; a records / points-for / all-play gap still refuses.

WHY (Keith 2026-11-17)
======================
The live standings sync refuses to write unless every figure matches MFL's leagueStandings. Potential points
(pp) and efficiency (eff) come from MFL's per-week optimal lineups, and MFL's own season totals for them can
lag or disagree with those weekly values for days after a stat correction. On 2026-11-17 three such figures
(0005 pp 1.7 off, 0011 pp 28.8 off = 1.3%, 0011 eff 1.1 off) blocked the whole week-10 write although records,
points-for and all-play matched exactly, so the site's standings stayed on week 9.

WHAT IS PROVEN HERE (main(), end to end; network stubbed, D1 writes RECORDED not executed)
===========================================================================================
1. Everything matches MFL: writes, no warning (unchanged behaviour).
2. Records, points-for and all-play match, pp (and eff) off by under 2%: writes, with a WARNING naming each figure.
3. A pp gap over 2%: still refuses, nothing written.
4. Records disagree (h2h wins), points-for disagrees, all-play disagrees, divisional record disagrees:
   each still refuses, nothing written (also when pp is off by a small amount at the same time).
5. compare_to_mfl_standings(): hard vs soft split.

    python3 pipelines/etl/scripts/test_live_sync_potential_points_gate.py
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


def league_standings(played, tweak=None):
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
    for row in out:
        if tweak:
            tweak(row)
    return {"leagueStandings": {"franchise": out}}


PLAYERS = {"players": {"player": [{"id": "p%s" % f, "name": "Player, %s" % f, "position": "LB", "team": "DET"}
                                  for f in FIDS]}}


def run_main(weeks, flag_for, tweak=None):
    def fake_fetch_mfl(season, league_id, server, type_name, extra=None):
        if type_name == "league":
            return copy.deepcopy(LEAGUE)
        if type_name == "leagueStandings":
            return league_standings(sorted(weeks), tweak)
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
    return rc, executed, rows_by_table, buf.getvalue()


fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


WEEKS = {1, 2, 3}
REG = lambda wk, a: "1"      # noqa: E731  (every week is regular season)


def bump(field, delta, only="0002"):
    def tweak(row):
        if row["id"] == only:
            row[field] = ("%.2f" % (float(row[field]) + delta)) if field in ("pf", "pp") else str(int(float(row[field]) + delta))
    return tweak


def eff_bump(delta, only="0002"):
    def tweak(row):
        if row["id"] == only:
            row["eff"] = "%.1f" % (float(row["eff"]) + delta)
    return tweak


def both(*tw):
    def tweak(row):
        for t in tw:
            t(row)
    return tweak


print("1. everything matches: writes, no warning")
rc, executed, rows, out = run_main(WEEKS, REG)
check("exit 0 and D1 written", rc == 0 and executed != [], f"rc={rc} executed={executed}")
check("no warning", "WARNING" not in out, out[-300:])

print("2. records / points-for / all-play match, pp and eff a little off: writes with a WARNING")
rc, executed, rows, out = run_main(WEEKS, REG, both(bump("pp", 3.0), eff_bump(-0.9)))
check("exit 0 and D1 written", rc == 0 and executed != [], f"rc={rc} executed={executed}")
check("warning names 0002 pp and eff", "WARNING" in out and "0002 pp:" in out and "0002 eff:" in out, out[-500:])
check("not a refusal", "refusing to write" not in out, out[-300:])
check("src_standings written for all four franchises", len(rows.get("src_standings", [])) == 4, str(len(rows.get("src_standings", []))))

print("3. a pp gap over 2% still refuses")
rc, executed, rows, out = run_main(WEEKS, REG, bump("pp", 60.0))
check("exit non-zero, refusing, nothing written", rc == 1 and "refusing to write" in out and executed == [] and "0002 pp:" in out, f"rc={rc} out={out[-300:]}")

print("4. a real disagreement still refuses (even with a small pp gap alongside)")
for label, tweak in (("h2h wins", bump("h2hw", 1)), ("h2h losses", bump("h2hl", 1)), ("divisional wins", bump("divw", 1)),
                     ("points-for", bump("pf", 5.0)), ("all-play", lambda r: r.update(all_play_wlt="0-0-0") if r["id"] == "0002" else None)):
    for extra in (None, bump("pp", 1.0)):
        rc, executed, rows, out = run_main(WEEKS, REG, both(tweak, extra) if extra else tweak)
        check(f"{label}{' + small pp gap' if extra else ''}: refuses, nothing written", rc == 1 and "refusing to write" in out and executed == [], f"rc={rc} out={out[-300:]}")

print("5. compare_to_mfl_standings(): hard vs soft")
row = {"franchise_id": "0001", "h2h_w": 2, "h2h_l": 1, "div_w": 0, "div_l": 0, "pf": 500.0, "pp": 600.0, "eff": 83.3,
       "allplay_w": 5, "allplay_l": 4, "allplay_t": 0}
ls = {"0001": {"id": "0001", "h2hw": "2", "h2hl": "1", "divw": "0", "divl": "0", "pf": "500.00", "pp": "610.00", "eff": "82.0", "all_play_wlt": "5-4-0"}}
hard, soft = mod.compare_to_mfl_standings([row], ls)
check("pp 1.6% off and eff 1.3 off: soft only", hard == [] and {s[1] for s in soft} == {"pp", "eff"}, f"{hard} {soft}")
ls["0001"]["pp"] = "700.00"
hard, soft = mod.compare_to_mfl_standings([row], ls)
check("pp 14% off: hard", any(h[1] == "pp" for h in hard), f"{hard} {soft}")
ls["0001"]["pp"] = "610.00"; ls["0001"]["h2hw"] = "3"
hard, soft = mod.compare_to_mfl_standings([row], ls)
check("h2h wins off: hard", any(h[1] == "h2h_w" for h in hard), f"{hard}")

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILURE(S)'}")
sys.exit(1 if fails else 0)
