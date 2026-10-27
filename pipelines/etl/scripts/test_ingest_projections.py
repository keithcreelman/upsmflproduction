#!/usr/bin/env python3
"""Offline tests: a projection is frozen at its player's own kickoff (Keith 2026-10-27).
   python3 pipelines/etl/scripts/test_ingest_projections.py
No network, no D1: MFL's schedule and player list and the D1 calls are stubbed. The kickoff slots are 2026 Week 7's real ones."""
import calendar
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ingest_projections as ING      # noqa: E402

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:300]))
    if not cond:
        fails += 1


def utc(s):
    return calendar.timegm(datetime.strptime(s, "%Y-%m-%d %H:%M").timetuple())


# Week 7 2026: Thursday night, the 1 PM ET window (17:00Z), 4:05 / 4:25 PM, Sunday night, Monday night; two teams on bye
SLOTS = {"THU": utc("2026-10-23 00:15"), "EARLY": utc("2026-10-25 17:00"), "LATE": utc("2026-10-25 20:05"), "SNF": utc("2026-10-26 00:20"), "MNF": utc("2026-10-27 00:15")}
KICK = {"T%02d" % i: v for i, v in enumerate([SLOTS["THU"]] * 2 + [SLOTS["EARLY"]] * 10 + [SLOTS["LATE"]] * 6 + [SLOTS["SNF"]] * 2 + [SLOTS["MNF"]] * 2)}
KICK = {k: v for k, v in KICK.items()}
for i in range(len(KICK), 22):
    KICK["T%02d" % i] = SLOTS["LATE"]
TEAMS = {"p_thu": "T00", "p_early": "T05", "p_late": "T13", "p_mnf": "T21", "p_bye": "BYE", "p_unknown": ""}
PROJ = {pid: 10.0 for pid in TEAMS}

print("which projections may a run write")
now = utc("2026-10-25 18:04")                     # the real Week 7 capture time: Sunday 2:04 PM ET, after the 1 PM kickoffs
keep, frozen = ING.split_by_kickoff(PROJ, TEAMS, KICK, now)
check("2:04 PM ET Sunday: the 1 PM game, Thursday's game and the bye are frozen; the 4 PM and Monday night players are still writable",
      sorted(keep) == ["p_late", "p_mnf"] and frozen == ["p_bye", "p_early", "p_thu", "p_unknown"], (sorted(keep), frozen))
keep, frozen = ING.split_by_kickoff(PROJ, TEAMS, KICK, utc("2026-10-25 13:00"))
check("9 AM ET Sunday: every Sunday and Monday player is writable; Thursday's player and the byes (no game this week, week already "
      "under way) are frozen", sorted(keep) == ["p_early", "p_late", "p_mnf"] and frozen == ["p_bye", "p_thu", "p_unknown"], (sorted(keep), frozen))
keep, frozen = ING.split_by_kickoff(PROJ, TEAMS, KICK, utc("2026-10-22 16:00"))
check("Thursday afternoon, before the first kickoff: everyone is writable, byes included", len(keep) == len(PROJ) and not frozen)
keep, frozen = ING.split_by_kickoff(PROJ, TEAMS, KICK, SLOTS["EARLY"])
check("the kickoff second itself is still pregame (now <= kickoff)", "p_early" in keep)
keep, frozen = ING.split_by_kickoff(PROJ, TEAMS, KICK, SLOTS["EARLY"] + 1)
check("one second after his kickoff he is frozen", "p_early" in frozen)
keep, frozen = ING.split_by_kickoff(PROJ, TEAMS, KICK, utc("2026-10-27 06:00"))
check("after the last game everyone is frozen", not keep and len(frozen) == len(PROJ))

print("what main() sends to D1")
sent, state = [], {}
real = (ING.fetch, ING.fetch_kickoffs, ING.fetch_player_teams, ING.d1_file, ING.d1_count, ING.resolve, ING.datetime)


class FakeDT(datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime.fromtimestamp(state["now"], tz)


def run_main(now_s, argv=("--season", "2026", "--week", "7")):
    state["now"] = now_s
    sent.clear()
    ING.fetch, ING.fetch_kickoffs, ING.fetch_player_teams = (lambda s, w: dict(PROJ)), (lambda s, w: KICK), (lambda s: TEAMS)
    ING.d1_file = lambda sql: sent.append(sql)
    ING.d1_count = lambda s, w: (len(PROJ), 3)
    ING.datetime = FakeDT
    sys.argv = ["ingest_projections.py", *argv]
    try:
        return ING.main()
    finally:
        (ING.fetch, ING.fetch_kickoffs, ING.fetch_player_teams, ING.d1_file, ING.d1_count, ING.resolve, ING.datetime) = real


import io
import contextlib
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = run_main(utc("2026-10-25 18:04"))
ids = set(re.findall(r"\(2026,7,'(\w+)'", "".join(sent)))
check("a late Sunday run upserts ONLY the players whose game has not started", rc == 0 and ids == {"p_late", "p_mnf"}, (rc, ids, buf.getvalue()[-200:]))
check("and says how many it froze", "4 frozen" in buf.getvalue(), buf.getvalue())
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = run_main(utc("2026-10-27 06:00"))
check("a run after the last game writes nothing and exits clean (not a failed capture)", rc == 0 and not sent and "nothing written" in buf.getvalue(), (rc, sent))

print("fail closed")
def boom(*a, **k):
    raise OSError("network down")
ING._mfl_json_real = ING._mfl_json
ING._mfl_json = boom
for fn, args in ((ING.fetch_kickoffs, (2026, 7)), (ING.fetch_player_teams, (2026,))):
    try:
        fn(*args)
        check(fn.__name__ + " refuses when MFL is unreadable", False)
    except SystemExit as e:
        check(fn.__name__ + " refuses when MFL is unreadable (exit message names the refusal)", "REFUSING" in str(e))
ING._mfl_json = ING._mfl_json_real

print("the schedule")
wf = open(os.path.join(HERE, "..", "..", "..", ".github", "workflows", "ingest-projections.yml")).read()
crons = re.findall(r'cron: "([^"]+)"', wf)
check("the workflow adds a Thursday 20:00 UTC run and Sunday 11:00, 13:00 and 15:00 UTC runs (GitHub starts runs late)",
      {"0 20 * * 4", "0 11 * * 0", "0 13 * * 0", "0 15 * * 0", "0 12 * * 3", "0 12 * * 5"} == set(crons), crons)

print()
print("ALL PASS" if not fails else "%d FAILURE(S)" % fails)
sys.exit(1 if fails else 0)
