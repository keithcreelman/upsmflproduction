#!/usr/bin/env python3
"""Build the rest-of-season projection file the Front Office reads (Keith 2026-10-30).

    python pipelines/etl/scripts/build_ros_projections.py --allow-prod-d1 --out /tmp/ros.json
    python pipelines/etl/scripts/build_ros_projections.py --allow-prod-d1 --season 2026 --out /tmp/ros.json

RULINGS (2026-10-30, recorded on #1433)
    Source: the UPS Center forecast projection, season_sim.prepare(injuries=True, ev_offense=True): RotoWire via Sleeper
    for offense, MFL deciding who plays, MFL for DL/LB/DB/K/P. Every position uses it. The window is the first week MFL
    has not completed through MFL's endWeek, read from league settings.

WHAT A PLAYER'S NUMBER IS
    Projected points per remaining league week: the sum over the window divided by the number of weeks. A week with no
    projection (bye, or a listed absence) counts as 0; that is the definition the 2026-10-28 backtest measured, and it
    matches season PPG's per-scored-week basis closely enough to compare. A player with no projection in ANY week gets
    null, never 0.

NO PRODUCTION D1 BY DEFAULT (docs/D1_QUERY_RULES.md)
    The Sleeper-to-MFL id crosswalk is one production D1 read (about 2.9k rows, no writes). Without --allow-prod-d1 or
    UPS_ALLOW_PROD_D1_READS=1 this prints SKIPPED, makes no call and exits 0.

EXIT CODES ARE MEANINGFUL (this runs unattended)
    0 + "SKIPPED"          no opt-in; nothing read.
    0 + "OUTSIDE"          no week left in the window; nothing written.
    0 + "wrote"            the file passed its checks.
    1                      MFL's completed week was unreadable, or coverage failed. Nothing is written, so a bad run can
                           never replace the last good file.
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, "..", "wire")))

import lineup_engine as LE  # noqa: E402

VERSION = 1
GROUPS = ("QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN")
MIN_GROUP_COVERAGE = 0.8      # share of rostered players at a position with a number (2026-10-28 file: lowest 0.88, DL)
LABEL = "UPS Center projection"
SOURCES = {"offense": "RotoWire weekly projections (via Sleeper), UPS-scored; MFL decides who plays",
           "idp_k_p": "MFL projectedScores (league 74598 scoring)"}


class BuildError(Exception):
    pass


def window(through_week, end_week):
    """[first week not completed .. endWeek], or [] when nothing is left."""
    return list(range(through_week + 1, end_week + 1))


def player_row(pid, proj, weeks):
    per = [proj.get(w, {}).get(pid) for w in weeks]
    per = [None if v is None else round(float(v), 1) for v in per]
    have = sum(1 for v in per if v is not None)
    return {"ppg": round(sum(v for v in per if v) / len(weeks), 2) if have else None, "projWeeks": have, "w": per}


def build_payload(season, through_week, end_week, proj, pos, rostered, ev_coverage, as_of):
    weeks = window(through_week, end_week)
    if not weeks:
        raise BuildError("no weeks left")
    players = {}
    for pid in sorted(set().union(*[set(proj.get(w) or {}) for w in weeks]) | set(rostered)):
        if LE.pos_group(pos.get(pid) or "") not in GROUPS:
            continue
        row = player_row(pid, proj, weeks)
        if row["projWeeks"] == 0 and pid not in rostered:
            continue
        players[pid] = row
    return {"version": VERSION, "season": season, "throughWeek": through_week, "weeks": [weeks[0], weeks[-1]],
            "nWeeks": len(weeks), "asOf": as_of, "label": LABEL, "sources": SOURCES,
            "rule": "points per remaining week; a week with no projection (bye, listed absence) counts as 0",
            "sleeperUpdatedAt": (ev_coverage or {}).get("sleeperUpdatedAt"), "players": players}


def check_coverage(payload, pos, rostered, ev_coverage):
    """Refuse a file that would look like the ruled source without being it."""
    if not ev_coverage or not ev_coverage.get("rotowirePoints"):
        raise BuildError("no RotoWire points applied: the file would be MFL-only under the ruled label")
    totals, have = {}, {}
    for pid in rostered:
        g = LE.pos_group(pos.get(pid) or "")
        if g not in GROUPS:
            continue
        totals[g] = totals.get(g, 0) + 1
        row = payload["players"].get(pid)
        if row and row["ppg"] is not None:
            have[g] = have.get(g, 0) + 1
    missing = [g for g in GROUPS if g not in totals]
    if missing:
        raise BuildError("no rostered players at %s" % ",".join(missing))
    low = ["%s %d/%d" % (g, have.get(g, 0), totals[g]) for g in GROUPS if have.get(g, 0) / totals[g] < MIN_GROUP_COVERAGE]
    if low:
        raise BuildError("coverage under %.0f%%: %s" % (MIN_GROUP_COVERAGE * 100, ", ".join(low)))
    return {g: "%d/%d" % (have.get(g, 0), totals[g]) for g in GROUPS}


def completed_week(doc):
    """MFL's weeklyResults with no W answers with the last COMPLETED week. Anything else fails closed."""
    try:
        wk = int(doc["weeklyResults"]["week"])
    except (KeyError, TypeError, ValueError):
        raise BuildError("MFL weeklyResults has no readable week")
    if wk < 0:
        raise BuildError("MFL weeklyResults week %d" % wk)
    return wk


def build(season, cache_dir):
    import season_sim as sim
    sim.LIVE_SEASON = season
    through = completed_week(sim.fetch(sim.MFL % (season, "weeklyResults", ""), cache_dir))
    prep = sim.prepare(season, cache_dir, injuries=True, ev_offense=True)
    as_of = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if not window(through, prep["end"]):
        return None, None
    payload = build_payload(season, through, prep["end"], prep["proj"], prep["pos"], prep["rostered"], prep["evCoverage"], as_of)
    return payload, check_coverage(payload, prep["pos"], prep["rostered"], prep["evCoverage"])


def allowed(args):
    return bool(args.allow_prod_d1 or os.environ.get("UPS_ALLOW_PROD_D1_READS") == "1")


def main(argv=None, builder=build):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--season", type=int, default=datetime.now(timezone.utc).year)
    ap.add_argument("--out", required=True)
    ap.add_argument("--allow-prod-d1", action="store_true", help="read the id crosswalk from production D1 (about 2.9k rows)")
    args = ap.parse_args(argv)
    if not allowed(args):
        print("SKIPPED: needs --allow-prod-d1 or UPS_ALLOW_PROD_D1_READS=1 (one production D1 read). Nothing was read or written.")
        return 0
    with tempfile.TemporaryDirectory() as cache_dir:
        try:
            payload, coverage = builder(args.season, cache_dir)
        except BuildError as e:
            print("FAILED: %s. Nothing was written." % e, file=sys.stderr)
            return 1
    if payload is None:
        print("OUTSIDE the window: no week left in %d. Nothing was written." % args.season)
        return 0
    tmp = args.out + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, separators=(",", ":"))
    os.replace(tmp, args.out)
    print("wrote %s: %d players, Weeks %d-%d (%d weeks), through Week %d; coverage %s" % (
        args.out, len(payload["players"]), payload["weeks"][0], payload["weeks"][1], payload["nWeeks"], payload["throughWeek"], coverage))
    return 0


if __name__ == "__main__":
    sys.exit(main())
