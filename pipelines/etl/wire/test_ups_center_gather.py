#!/usr/bin/env python3
"""The REAL ups_center_sources.gather(), with only its network and D1 calls replaced by the recorded Week 7 data.
   python3 pipelines/etl/wire/test_ups_center_gather.py

Proves the scheduled build's new inputs flow through the job's own code (Keith 2026-10-27):
  - the week's roster rows are read from D1 ONCE in the full build and serve both the bust/bargain evidence and the lineup
    analysis (no second src_weekly query), and the pregame lookup also runs once for everybody;
  - the probe gather (the D1-vs-MFL check) neither reads the bench nor fetches the schedule;
  - the standings, divisions and MFL schedule become the clinching engine's input and the flags land in the context and in
    run.json; the whole thing then renders and validates.
"""
import copy
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_auto as AUTO        # noqa: E402
import ups_center_issue as ISSUE      # noqa: E402
import ups_center_sources as SRC      # noqa: E402
import ups_center_validate as VAL     # noqa: E402

FX = os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "ups_center_auto")
REC = json.load(open(os.path.join(FX, "2026_wk07", "context.json")))
PACK = json.load(open(os.path.join(FX, "2026_wk07", "pack.json")))
SCHED = json.load(open(os.path.join(FX, "mfl_schedule_2026.json")))
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:400]))
    if not cond:
        fails += 1


def last_first(name):
    first, _, last = name.partition(" ")
    return "%s, %s" % (last or first, first) if last else name


CALLS = {"d1": [], "pregame": 0, "schedule": 0, "starter": 0}


def fake_get(url):
    if "TYPE=weeklyResults" in url:
        return {"weeklyResults": {"matchup": [{"franchise": [{"id": g["a"], "score": str(g["as"]), "result": g["ar"]},
                                                              {"id": g["b"], "score": str(g["bs"]), "result": g["br"]}]} for g in REC["mfl"]["games"]]}}
    if "TYPE=leagueStandings" in url:
        return {"leagueStandings": {"franchise": [{"id": f, "h2hw": str(s["h2hw"]), "h2hl": str(s["h2hl"]), "h2ht": str(s["h2ht"]),
                                                   "all_play_wlt": s["allplay"], "pf": str(s["pf"])} for f, s in REC["mfl"]["standings"].items()]}}
    if "TYPE=transactions" in url:
        return {"transactions": {"transaction": REC["mfl"]["trades"]}}
    if "TYPE=schedule" in url:
        CALLS["schedule"] += 1
        return SCHED
    if "/api/standings" in url:
        return {"rows": REC["site"]["standings"], "regular_season": {"through_week": 7, "last_regular_season_week": 16}}
    raise AssertionError("unexpected fetch: " + url)


def fake_d1(sql, retries=1):
    CALLS["d1"].append(sql)
    if "FROM src_franchise_weekly_score" in sql:
        return [{"franchise_id": f, "score": s} for f, s in REC["d1"]["teamScores"].items()]
    if "FROM src_standings" in sql:
        return list(REC["d1"]["standings"].values())
    if "FROM src_franchises" in sql:
        return list(REC["d1"]["franchises"].values())
    if "FROM src_schedule" in sql:
        return REC["d1"]["regGames"]
    if "FROM ups_player_projections" in sql:
        return list(REC["d1"]["projections"].values())
    if "FROM src_adddrop" in sql:
        return REC["d1"]["adds"]
    if "FROM ups_discord_messages" in sql:
        return copy.deepcopy(REC["d1"]["chat"])
    if "FROM src_players WHERE season" in sql and "player_id" not in sql.split("WHERE")[1].split("%")[0]:
        return list(REC["d1"]["players"].values())
    if "FROM src_weekly" in sql:
        CALLS["starter"] += 1
        rows = []
        for fid, lu in REC["lineups"].items():
            for r in lu:
                rows.append({"fid": fid, "player_id": r["pid"], "pos_group": r["pos_group"], "status": "starter" if r["status"] == "starter" else "nonstarter",
                             "score": r["score"], "player_name": last_first(r["name"]), "nfl_team": "XXX"})
        return [r for r in rows if r["status"] == "starter"] if "w.status = 'starter'" in sql else rows
    raise AssertionError("unexpected D1 query: " + sql[:120])


def fake_pregame(season, week, ids):
    CALLS["pregame"] += 1
    return copy.deepcopy(REC["pregame"]["proj"]), copy.deepcopy(REC["pregame"]["missing"])


saved = (SRC._get, SRC.D.d1, SRC.D.pregame_projections, SRC.D.record_book, SRC.E._get, SRC.E.official_changes, SRC.week_timing,
         SRC.season_history, SRC.verify_highlight)
SRC._get, SRC.D.d1, SRC.D.pregame_projections = fake_get, fake_d1, fake_pregame
SRC.D.record_book = lambda s, w: REC["d1"]["recordBook"]
SRC.E._get, SRC.E.official_changes = (lambda url: {}), (lambda s, w, raw=None: REC["mfl"]["elias"])
SRC.week_timing = lambda s, w: REC["timing"]
SRC.season_history = lambda s, w: REC["history"]
SRC.verify_highlight = lambda player, video: REC["links"].get(player, {"url": None, "verified": False, "why": "recorded"})
try:
    print("the probe gather (D1 == MFL check)")
    probe = SRC.gather(2026, 7, now=1793300000, chat_since=1792700000)
    n_probe_weekly = len([q for q in CALLS["d1"] if "FROM src_weekly" in q])
    check("it reads the starters once and has no bench, pregame lookup, schedule or clinch work",
          n_probe_weekly == 1 and "lineups" not in probe and "clinch" not in probe and CALLS["pregame"] == 1 and CALLS["schedule"] == 0, (n_probe_weekly, CALLS))
    CALLS["d1"].clear()
    CALLS.update(pregame=0, schedule=0, starter=0)
    print("the full build gather")
    ctx = SRC.gather(2026, 7, now=1793300000, chat_since=1792700000, pack=PACK, history=True)
finally:
    (SRC._get, SRC.D.d1, SRC.D.pregame_projections, SRC.D.record_book, SRC.E._get, SRC.E.official_changes, SRC.week_timing,
     SRC.season_history, SRC.verify_highlight) = saved

weekly = [q for q in CALLS["d1"] if "FROM src_weekly" in q]
check("the week's rows (starters AND bench) come from ONE src_weekly read, the only one in the whole gather",
      len(weekly) == 1 and "w.status = 'starter'" not in weekly[0] and "w.season = 2026 AND w.week = 7" in weekly[0], weekly)
check("the pregame projections are looked up ONCE, for every rostered player", CALLS["pregame"] == 1)
check("the evidence the bust/bargain lists use is built from the same rows (no second read)", ctx["evidence"]["basis"] == "last_pregame"
      and len(ctx["evidence"]["ranked"]) + len(ctx["evidence"]["unranked"]) == sum(1 for lu in REC["lineups"].values() for r in lu if r["status"] == "starter"))
check("the lineups cover all 12 franchises, starters and bench, as the recorded rows",
      set(ctx["lineups"]) == set(REC["lineups"]) and all(len(ctx["lineups"][f]) == len(REC["lineups"][f]) for f in REC["lineups"])
      and {r["pid"] for r in ctx["lineups"]["0010"] if r["status"] == "starter"} == {r["pid"] for r in REC["lineups"]["0010"] if r["status"] == "starter"})
check("the pregame projections arrive as the lookup returned them", ctx["pregame"]["proj"] == REC["pregame"]["proj"])
check("the MFL schedule was fetched once, and the standings, divisions and schedule became the engine's input: it ran with the schedule",
      CALLS["schedule"] == 1 and ctx["clinch"]["status"] == "ok" and ctx["clinch"]["schedule"] is True and len(ctx["clinch"]["byFid"]) == 12, ctx["clinch"])
check("the engine's flags equal the recorded ones (nobody clinched or eliminated after Week 7)", ctx["clinch"]["byFid"] == REC["clinch"]["byFid"])
ctx["forecast"] = copy.deepcopy(REC["forecast"])          # the job's own forecast step writes these files; recorded here
res = ISSUE.render(copy.deepcopy(PACK), ctx, generated_at=1793300000)
val = VAL.validate(res, ctx, copy.deepcopy(PACK))
check("the gathered context renders and validates, with the Playoff Picture", val["ok"] and "99.96%" in res["html"] and "100.0%" not in res["html"], val["errors"][:3])
run = AUTO.run_record(2026, 7, "2026-wk07-ups-center", ctx, 1793300000, "abc")
check("run.json carries the clinch flags for the post-build check", run["clinch"]["byFid"] == ctx["clinch"]["byFid"] and "chat" not in json.dumps(run))

print()
print("ALL PASS" if not fails else "%d FAILURE(S)" % fails)
sys.exit(1 if fails else 0)
