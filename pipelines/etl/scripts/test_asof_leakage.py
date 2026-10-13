#!/usr/bin/env python3
"""LEAKAGE TEST — the single highest-value test in the projection system.

Phase 0 task 0.6. See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §4.4.

WHAT IT PROVES
==============
That a feature row keyed (season=S, week=W) is a function of weeks < W ONLY.

This is worth a dedicated test because the failure it guards against is silent
and flattering: reading a completed-season aggregate mid-season does not crash,
does not look wrong, and inflates precisely the metric the system is judged on —
it tells the model, at Week 5, the season-end usage of exactly the players whose
roles were about to expand. Backtested lead-time would be fabricated.

THREE INDEPENDENT CHECKS
========================
A. STRUCTURAL — capture every SQL the builder issues and assert each carries the
   as-of predicate for its table and references no week >= W. Catches a query
   that bypasses AsOfContext entirely.

B. INDEPENDENT RECOMPUTE — for a sample of players, recompute features straight
   from the sources with explicit `week BETWEEN lo AND hi` bounds, by a code
   path that shares nothing with the builder, and require exact equality. A
   leaking builder disagrees here.

C. FUTURE-ONLY PLAYERS — any player whose FIRST appearance is in week >= W must
   have no history at W. If future rows leak in, these light up. This is the
   check that most directly simulates truncation: for these players, weeks < W
   genuinely do not exist.

READS PRODUCTION D1 — OPT-IN ONLY
=================================
Every read goes to the production database (wrangler d1 execute --remote). It
only runs with --allow-prod-d1 (or UPS_ALLOW_PROD_D1_READS=1); otherwise it prints
SKIPPED and exits 0, so a glob run of test_*.py never touches production. On
2026-10-13 three unattended runs read 642M production rows in one day (about
two-thirds of all D1 reads), almost all from check C's single UNION/JOIN query.
Check C now uses four plain reads joined in Python (about 116k rows for 2024),
and the feature build runs once and is shared by all three checks. See #1239;
test_asof_leakage_offline_default.py proves a default run makes no D1 call.

Usage:
  python3 pipelines/etl/scripts/test_asof_leakage.py --allow-prod-d1
  python3 pipelines/etl/scripts/test_asof_leakage.py --allow-prod-d1 --season 2024 --week 6
"""
from __future__ import annotations
import argparse
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib import asof  # noqa: E402
from lib.asof import AsOfContext, MANIFEST, WEEK, WEEK_PREGAME  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_player_week_features as B  # noqa: E402


def check_structural(season: int, week: int) -> tuple[list[str], list]:
    """A. Every SQL issued must carry the as-of predicate and no future week.

    Returns (violations, the built rows). Checks B and C reuse those rows: a
    feature build issues hundreds of production reads, so it runs once.
    """
    seen: list[str] = []
    orig = AsOfContext.run

    def spy(self, sql, *a, **kw):
        seen.append(sql)
        return orig(self, sql, *a, **kw)

    AsOfContext.run = spy
    try:
        rows = B.build_week(season, week)
    finally:
        AsOfContext.run = orig

    fails = []
    for sql in seen:
        tables = set(re.findall(r"\bFROM\s+([a-z_][a-z0-9_]*)", sql, re.I)) \
            | set(re.findall(r"\bJOIN\s+([a-z_][a-z0-9_]*)", sql, re.I))
        grains = set()
        for t in tables:
            if t not in MANIFEST:
                fails.append(f"UNDECLARED SOURCE '{t}' in: {sql[:110]}…")
                continue
            grains.add(MANIFEST[t].grain)
            if MANIFEST[t].grain == WEEK and "week <" not in sql:
                fails.append(f"NO AS-OF PREDICATE for week-grain '{t}': {sql[:110]}…")
            if MANIFEST[t].grain == WEEK_PREGAME and "week <=" not in sql:
                fails.append(f"NO AS-OF PREDICATE for pregame '{t}': {sql[:110]}…")
        # A WEEK_PREGAME source legitimately reads week = W — the line for this
        # week is published before kickoff — so the future-literal rule relaxes
        # by exactly one week for those queries and no further.
        cap = week if WEEK_PREGAME in grains else week - 1
        for m in re.finditer(r"week\s*(<=|>=|<|>|=)\s*(\d+)", sql):
            op, n = m.group(1), int(m.group(2))
            bad = (op in ("<=", "=") and n > cap) \
                or (op in (">=", ">") and n > cap) \
                or (op == "<" and n > cap + 1)
            if bad:
                fails.append(f"FUTURE WEEK LITERAL 'week {op} {n}' "
                             f"(target W{week}, cap W{cap}): {sql[:110]}…")
    print(f"  A. structural — {len(seen)} queries issued, {len(fails)} violations")
    return fails, rows


def check_recompute(season: int, week: int, rows: list, sample: int = 25) -> list[str]:
    """B. Recompute from source with explicit bounds; require exact equality."""
    idx = {c: i for i, c in enumerate(B.COLS)}
    hi, lo3 = week - 1, max(1, week - 3)

    # Independent path: raw SQL, explicit bounds, no AsOfContext involved.
    ctx = AsOfContext(season=season, week=week)
    truth = {r["gsis_id"]: r for r in ctx.run(
        f"SELECT gsis_id, SUM(routes) rt, SUM(routes_tgt) tg"
        f" FROM nfl_player_routes_weekly"
        f" WHERE season = {season} AND week BETWEEN {lo3} AND {hi}"
        f" GROUP BY gsis_id")}

    withr = [r for r in rows if r[idx["routes_l3"]]][:sample]
    fails = []
    for r in withr:
        g = r[idx["gsis_id"]]
        exp = (truth.get(g) or {}).get("rt")
        got = r[idx["routes_l3"]]
        if (exp or 0) != (got or 0):
            fails.append(f"routes_l3 mismatch {g}: builder={got} independent={exp}")
    print(f"  B. independent recompute — {len(withr)} players checked, "
          f"{len(fails)} mismatches")
    return fails


def first_weeks(ctx: AsOfContext, season: int) -> dict[str, int]:
    """Each player's first week this season across EVERY week-grain source.

    Four plain reads joined here in Python. The old version was one UNION query
    that joined nfl_player_snaps to ff_player_ids ON pfr_id: ff_player_ids has
    no index on pfr_id, so each snap row scanned the whole id table, about 214M
    rows read per run. These four read about 116k (season 2024, 2026-10-13).
    Same result: nfl_player_snaps has no NULL/'NA' pfr_id rows, and a pfr_id
    mapped to more than one gsis_id credits each of them, exactly as the JOIN did.
    """
    first: dict[str, int] = {}

    def keep(g, wk):
        if g and wk is not None and (g not in first or wk < first[g]):
            first[g] = wk

    for table in ("nfl_player_weekly", "nfl_player_routes_weekly"):
        for r in ctx.run(f"SELECT gsis_id, MIN(week) wk FROM {table}"
                         f" WHERE season = {season} GROUP BY gsis_id"):
            keep(r["gsis_id"], r["wk"])
    snap_first = {r["pfr_id"]: r["wk"] for r in ctx.run(
        f"SELECT pfr_id, MIN(week) wk FROM nfl_player_snaps"
        f" WHERE season = {season} GROUP BY pfr_id")}
    for r in ctx.run("SELECT pfr_id, gsis_id FROM ff_player_ids"
                     " WHERE pfr_id IS NOT NULL AND pfr_id <> 'NA'"
                     " AND gsis_id LIKE '00-%'"):
        keep(r["gsis_id"], snap_first.get(r["pfr_id"]))
    return first


def check_future_only(season: int, week: int, rows: list) -> list[str]:
    """C. A player whose first appearance is week >= W must have no history."""
    ctx = AsOfContext(season=season, week=week)
    # "First appearance" must be computed across EVERY week-grain source, not
    # just the box score. The participation universe is strictly broader: a
    # player can run routes with zero box-score stats and be absent from
    # nfl_player_weekly that week. An earlier version of this check used only
    # nfl_player_weekly and flagged 00-0036165 as a leak for carrying
    # routes_l1=11 at W6 — he had genuinely run 11 routes in W5 and simply
    # recorded no targets, so no player_stats row existed. The builder was
    # right; the test's premise was wrong.
    firsts = {g for g, wk in first_weeks(ctx, season).items() if wk >= week}
    if not firsts:
        print("  C. future-only players — none exist this week (vacuous)")
        return []

    idx = {c: i for i, c in enumerate(B.COLS)}
    hist = ["routes_l1", "routes_l3", "routes_l4", "routes_std",
            "targets_l1", "targets_l3", "targets_std",
            "off_snaps_l3", "carries_l4", "ups_ppg_std"]
    fails = []
    checked = 0
    for r in rows:
        if r[idx["gsis_id"]] not in firsts:
            continue
        checked += 1
        for c in hist:
            v = r[idx[c]]
            if v:
                fails.append(
                    f"LEAK: {r[idx['gsis_id']]} first plays in week >= {week} "
                    f"but has {c}={v}")
    if checked == 0:
        # Not a pass. The builder's universe is drawn from sources already
        # filtered to weeks < W, so a player who debuts at/after W has no rows
        # to carry history on and cannot fire this check. Say so plainly rather
        # than let "0 leaks" read as evidence — zero findings over zero subjects
        # is exactly the shape of a fail-open.
        print(f"  C. future-only players — VACUOUS: {len(firsts)} players debut "
              f"at/after W{week} but none are in the builder's output, so this "
              f"check proves nothing here. Checks A and B carry the weight.")
        return fails
    print(f"  C. future-only players — {checked} checked "
          f"({len(firsts)} debut at/after W{week}), {len(fails)} leaks")
    return fails


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2024)
    ap.add_argument("--week", type=int, default=6)
    ap.add_argument("--allow-prod-d1", action="store_true",
                    help="required: every read goes to the production D1 database")
    args = ap.parse_args()

    if not (args.allow_prod_d1 or os.environ.get("UPS_ALLOW_PROD_D1_READS") == "1"):
        print("SKIPPED — test_asof_leakage.py reads the PRODUCTION D1 database "
              "(hundreds of queries). Not run. To run it on purpose:\n"
              "  python3 pipelines/etl/scripts/test_asof_leakage.py --allow-prod-d1")
        sys.exit(0)

    print(f"AS-OF LEAKAGE TEST — season {args.season}, week {args.week}")
    print(f"  (a feature row for W{args.week} must be a function of "
          f"weeks < {args.week} only)\n")

    fails, rows = check_structural(args.season, args.week)
    fails += check_recompute(args.season, args.week, rows)
    fails += check_future_only(args.season, args.week, rows)

    print()
    if fails:
        print(f"FAILED — {len(fails)} violation(s):")
        for f in fails[:25]:
            print("  " + f)
        sys.exit(1)
    print("PASSED — no leakage detected on any of the three checks")


if __name__ == "__main__":
    main()
