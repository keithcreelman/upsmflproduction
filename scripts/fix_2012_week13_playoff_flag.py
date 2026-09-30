#!/usr/bin/env python3
"""One-off correction: 2012 Week 13 was a REGULAR-season week, not a playoff week.

MFL's 2012 league (L=37227, www45) has lastRegularSeasonWeek = 13 and every
playoff bracket starts in Week 14. The local mfl_database.db flagged all of
2012 Week 13 as is_playoff = 1 in weeklyresults, and load_local_to_d1.py copied
that into D1: src_schedule (24 rows), src_franchise_weekly_score (12 rows) and
src_league_season_meta (2012 last_regular_season_week 12, reg_weeks 12,
playoff_weeks 4 instead of 13 / 13 / 3).

Order matters. The local rows are fixed FIRST, so a later load_local_to_d1.py
run cannot push the bad flag back (and that loader now refuses to load any
playoff flag that disagrees with its FIRST_POSTSEASON_WEEK table).

Dry run by default. With --apply:
  1. Local: consistent sqlite backup next to the DB, then ONE transaction that
     must touch exactly the expected rows or it rolls back.
  2. D1: records a Time Travel bookmark (the restore point), then ONE
     multi-statement command. D1 runs a multi-statement command atomically
     (probed 2026-09-29: a failing second statement rolled back the first).
  3. Re-reads both sides and writes a before/after record (--record).
Idempotent: a side already corrected is reported and left alone.
"""

import argparse
import datetime
import json
import os
import sqlite3
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKER = os.path.join(REPO, "worker")
D1_NAME = "ups-mfl-db"
LOCAL_EXPECTED = 301   # weeklyresults rows (player-level) for 2012 Week 13
SCHED_EXPECTED = 24    # src_schedule: 12 games, one row per side
SCORE_EXPECTED = 12    # src_franchise_weekly_score: one row per franchise
META_BEFORE = {"last_regular_season_week": 12, "reg_weeks": 12, "playoff_weeks": 4}
META_AFTER = {"last_regular_season_week": 13, "reg_weeks": 13, "playoff_weeks": 3}


def wrangler(args):
    res = subprocess.run(["npx", "wrangler"] + args, cwd=WORKER, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit("wrangler %s failed:\n%s" % (" ".join(args[:3]), res.stderr[-2000:]))
    return res.stdout


def d1(sql):
    out = wrangler(["d1", "execute", D1_NAME, "--remote", "--json", "--command", sql])
    return json.loads(out[out.index("["):])[-1]["results"]


def d1_state():
    return {
        "src_schedule": d1("SELECT season, week, franchise_id, opponent_franchise_id, result, team_score, "
                           "opponent_score, is_playoff FROM src_schedule WHERE season = 2012 AND week = 13 "
                           "ORDER BY franchise_id"),
        "src_franchise_weekly_score": d1("SELECT season, week, franchise_id, team_score, is_playoff "
                                         "FROM src_franchise_weekly_score WHERE season = 2012 AND week = 13 "
                                         "ORDER BY franchise_id"),
        "src_league_season_meta": d1("SELECT season, last_regular_season_week, total_weeks, reg_weeks, "
                                     "playoff_weeks FROM src_league_season_meta WHERE season = 2012"),
    }


def local_state(con):
    return {
        "weeklyresults_2012_wk13": [list(r) for r in con.execute(
            "SELECT is_playoff, COUNT(*) FROM weeklyresults WHERE season = 2012 AND week = 13 "
            "GROUP BY is_playoff")],
        "metadata_leaguedetails_2012_last_regular_season_week": con.execute(
            "SELECT last_regular_season_week FROM metadata_leaguedetails WHERE season = 2012").fetchone()[0],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--local-db", required=True, help="path to mfl_database.db (the load_local_to_d1.py source)")
    ap.add_argument("--apply", action="store_true", help="write; without it this only reports")
    ap.add_argument("--record", help="write the before/after record JSON here")
    args = ap.parse_args()
    if not os.path.exists(args.local_db):
        sys.exit("local DB not found: %s" % args.local_db)
    if args.record and os.path.exists(args.record):
        # A rerun on already-corrected data would replace the original record
        # (true before-state, backup path, restore point) with a no-op one.
        sys.exit("REFUSE: record %s already exists; pass a new path" % args.record)

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    record = {"when": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
              "localDb": args.local_db}

    con = sqlite3.connect("file:%s?mode=ro" % args.local_db, uri=True)
    local_before = local_state(con)
    d1_before = d1_state()
    record["before"] = {"local": local_before, "d1": d1_before}

    local_todo = dict(local_before["weeklyresults_2012_wk13"]).get(1, 0)
    sched_todo = sum(1 for r in d1_before["src_schedule"] if r["is_playoff"] == 1)
    score_todo = sum(1 for r in d1_before["src_franchise_weekly_score"] if r["is_playoff"] == 1)
    meta = d1_before["src_league_season_meta"][0]
    meta_todo = all(meta[k] == v for k, v in META_BEFORE.items())
    meta_done = all(meta[k] == v for k, v in META_AFTER.items())
    print("local weeklyresults 2012 wk13 flagged playoff: %d (expect %d or 0)" % (local_todo, LOCAL_EXPECTED))
    print("D1 src_schedule flagged: %d, src_franchise_weekly_score flagged: %d, meta %s"
          % (sched_todo, score_todo, {k: meta[k] for k in META_BEFORE}))
    for got, want, name in ((local_todo, LOCAL_EXPECTED, "local"), (sched_todo, SCHED_EXPECTED, "src_schedule"),
                            (score_todo, SCORE_EXPECTED, "src_franchise_weekly_score")):
        if got not in (0, want):
            sys.exit("REFUSE: %s has %d flagged rows, expected %d or 0 -- state is not what this fix was built for"
                     % (name, got, want))
    if not (meta_todo or meta_done):
        sys.exit("REFUSE: src_league_season_meta 2012 is neither the known-bad nor the corrected value: %s" % meta)
    if local_before["metadata_leaguedetails_2012_last_regular_season_week"] != 13:
        sys.exit("REFUSE: local metadata_leaguedetails says 2012 last regular week is not 13")

    if not args.apply:
        print("dry run -- nothing written. Re-run with --apply.")
        return

    # ---- 1. local: take the write lock FIRST, back up under it, then one transaction.
    # Locking first means a busy DB fails fast with nothing written (no orphan
    # backup), and no other writer can change the DB between backup and update.
    if local_todo:
        w = sqlite3.connect(args.local_db, timeout=30)
        w.isolation_level = None
        try:
            w.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as exc:
            sys.exit("REFUSE: could not take the local write lock (%s) -- another process is writing "
                     "%s. Nothing was changed; rerun when it is free." % (exc, args.local_db))
        try:
            flagged = w.execute("SELECT COUNT(*) FROM weeklyresults WHERE season = 2012 AND week = 13 "
                                "AND is_playoff = 1").fetchone()[0]
            if flagged != LOCAL_EXPECTED:
                raise RuntimeError("under the lock %d rows are flagged, expected %d" % (flagged, LOCAL_EXPECTED))
            backup = os.path.join(os.path.dirname(args.local_db),
                                  "mfl_database.pre_2012wk13_playoff_fix_%s.db" % stamp)
            reader, dst = sqlite3.connect("file:%s?mode=ro" % args.local_db, uri=True), sqlite3.connect(backup)
            reader.backup(dst)   # a SEPARATE connection: backing up from `w` itself hangs
            reader.close()
            n_src = w.execute("SELECT COUNT(*) FROM weeklyresults").fetchone()[0]
            n_dst = dst.execute("SELECT COUNT(*) FROM weeklyresults").fetchone()[0]
            ok = dst.execute("PRAGMA quick_check").fetchone()[0]
            dst.close()
            if n_src != n_dst or ok != "ok":
                raise RuntimeError("backup %s failed verification (rows %d vs %d, quick_check %s)"
                                   % (backup, n_src, n_dst, ok))
            record["localBackup"] = backup
            print("local backup verified (taken under the write lock):", backup)
            cur = w.execute("UPDATE weeklyresults SET is_playoff = 0 "
                            "WHERE season = 2012 AND week = 13 AND is_playoff = 1")
            if cur.rowcount != LOCAL_EXPECTED:
                raise RuntimeError("local update touched %d rows, expected %d" % (cur.rowcount, LOCAL_EXPECTED))
            w.execute("COMMIT")
            print("local: %d rows corrected in one transaction" % cur.rowcount)
        except Exception as exc:
            if w.in_transaction:
                w.execute("ROLLBACK")
            sys.exit("local transaction rolled back, nothing changed: %s" % exc)
        finally:
            w.close()
    else:
        print("local: already corrected")

    # ---- 2. D1: restore point, then one atomic multi-statement command
    if sched_todo or score_todo or meta_todo:
        tt = wrangler(["d1", "time-travel", "info", D1_NAME, "--json"])
        record["d1TimeTravelBookmark"] = json.loads(tt[tt.index("{"):])["bookmark"]
        print("D1 restore point (Time Travel bookmark):", record["d1TimeTravelBookmark"])
        d1("UPDATE src_schedule SET is_playoff = 0 WHERE season = 2012 AND week = 13 AND is_playoff = 1; "
           "UPDATE src_franchise_weekly_score SET is_playoff = 0 WHERE season = 2012 AND week = 13 AND is_playoff = 1; "
           "UPDATE src_league_season_meta SET last_regular_season_week = 13, reg_weeks = 13, playoff_weeks = 3 "
           "WHERE season = 2012 AND last_regular_season_week = 12 AND reg_weeks = 12 AND playoff_weeks = 4")
        print("D1: correction applied in one command")
    else:
        print("D1: already corrected")

    # ---- 3. verify both sides
    local_after, d1_after = local_state(con), d1_state()
    record["after"] = {"local": local_after, "d1": d1_after}
    problems = []
    if dict(local_after["weeklyresults_2012_wk13"]).get(1, 0):
        problems.append("local still has playoff-flagged 2012 wk13 rows")
    if any(r["is_playoff"] for r in d1_after["src_schedule"]) or len(d1_after["src_schedule"]) != SCHED_EXPECTED:
        problems.append("src_schedule not fully corrected")
    if any(r["is_playoff"] for r in d1_after["src_franchise_weekly_score"]) or \
            len(d1_after["src_franchise_weekly_score"]) != SCORE_EXPECTED:
        problems.append("src_franchise_weekly_score not fully corrected")
    if not all(d1_after["src_league_season_meta"][0][k] == v for k, v in META_AFTER.items()):
        problems.append("src_league_season_meta 2012 not corrected")
    record["verified"] = not problems
    if args.record:
        with open(args.record, "w", encoding="utf-8") as f:
            json.dump(record, f, indent=1)
            f.write("\n")
        print("record written:", args.record)
    if problems:
        sys.exit("VERIFY FAILED: " + "; ".join(problems))
    print("verified: local and D1 both show 2012 Week 13 as regular season")


if __name__ == "__main__":
    main()
