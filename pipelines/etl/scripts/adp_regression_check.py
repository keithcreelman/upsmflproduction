#!/usr/bin/env python3
"""Regression check for trade_grader.fetch_adp_board() — run this before merging
ANY change to the ADP consensus formula (here or in its 3 JS mirrors:
site/stats_workbench/stats_workbench.html adpBlend(), site/m/views/stats.js
adpbBlend(), site/auction/auction_hub.js faOffVal()).

Why this exists: on 2026-07-13 a real bug (averaging FantasyCalc and KeepTradeCut
redraft VALUES directly, despite their scales being incompatible for mid-tier
players) shipped, got a first "fix" that was still wrong (#683), and only the
second fix (#684, rank-consensus) actually matched independent external sources.
See docs/auction/adp_sources_reference.md for the full methodology writeup.

Benchmarks below are cross-checked against REAL external sites at the time they
were added (not just internal self-consistency) — see each comment for the source
and date. If a benchmark starts failing after a legitimate formula change, that's
expected (re-verify against the cited external source and update the benchmark,
don't just loosen the tolerance) — if it fails with NO formula change, that's a
live-data drift worth a quick sanity look, not necessarily a bug.

Usage:
  python3 pipelines/etl/scripts/adp_regression_check.py
"""
from __future__ import annotations
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from trade_grader import fetch_adp_board  # noqa: E402

# (name, pos, mfl_id, expected_pos_rank, tolerance, source note)
BENCHMARKS = [
    ("George Kittle", "TE", "13299", 9, 1,
     "Regression anchor — his fc/ktc/ffcAdp ranks already agree with each other, "
     "so this number should be stable across any correctly-designed formula "
     "change. Verified 2026-07-13."),
    ("Kyle Pitts", "TE", "15329", 7, 2,
     "FantasyData had him TE8/ADP92 on 2026-07-13 (fetched directly, "
     "fantasydata.com/nfl/adp/te). The pre-2026-07-13 'TE6' figure was itself "
     "inflated by the KTC redraft-scale bug documented in adp_sources_reference.md "
     "— do not treat TE6 as the target if this ever needs re-verifying."),
    ("Parker Washington", "WR", "16192", 42, 5,
     "FantasyData had him WR39/ADP85.0 on 2026-07-13 (fetched directly, "
     "fantasydata.com/nfl/adp/wr); our own ffcAdp independently said pick ~72. "
     "The original bug reported him at WR91."),
]


def check_degeneracy(problems: list) -> None:
    """Is the board a real consensus, or one source wearing three hats?

    The worker computes this on every /api/adp-board response. Read it as:
    `leader` (the source the consensus agrees with most) must equal
    `expected_leader` (the source that agrees most with the OTHER sources) — a
    genuine centroid always lands closest to the least-outlying source. Until
    2026-07-21 it did not: the shipped raw-value average had leader=KTC while
    expected=FantasyCalc, because KTC's value curve is ~4.6x flatter than
    DynastyProcess's past rank 100 and so dominated the sum. That inversion IS
    the degeneracy, and it is the thing this check exists to catch.

    Note the naive test — "rho(consensus, KTC) > 0.985" — does NOT work here.
    Every source pair already correlates 0.960-0.979, so a 3-source centroid
    correlates ~0.99 with all three BY CONSTRUCTION. A high rho is normal; the
    ORDERING of those rhos is the signal.
    """
    import json as _json
    import urllib.request as _ur
    import os as _os
    base = _os.environ.get("UPS_WORKER_BASE",
                           "https://upsmflproduction.keith-creelman.workers.dev").rstrip("/")
    try:
        req = _ur.Request(base + "/api/adp-board",
                          headers={"User-Agent": "ups-adp-regression", "Accept": "application/json"})
        d = _json.loads(_ur.urlopen(req, timeout=60).read())
    except Exception as e:
        print(f"[SKIP] degeneracy check — board fetch failed ({e})")
        return
    dg = d.get("degeneracy")
    if not dg:
        problems.append("board response carries no `degeneracy` block — the blend "
                        "must emit one so a regression can never be silent")
        return
    status = "FAIL" if dg.get("inverted") else "OK"
    print(f"[{status}] degeneracy: leader={dg.get('leader')} expected={dg.get('expected_leader')} "
          f"spread={dg.get('spread')} max_rho={dg.get('max_rho')} "
          f"panels={dg.get('independent_panels')}/{dg.get('value_sources')}")
    print(f"        rho vs source: {dg.get('rho_vs_source')}")
    print(f"        mean pairwise: {dg.get('mean_pairwise_agreement')}")
    if dg.get("inverted"):
        problems.append(
            f"degeneracy INVERTED — consensus is closest to '{dg.get('leader')}', but "
            f"'{dg.get('expected_leader')}' agrees most with the other sources. One "
            f"source's value scale is driving the board.")
    if (dg.get("independent_panels") or 0) < 2:
        problems.append("fewer than 2 independent panels behind the consensus — "
                        "the board is effectively single-source")


def main() -> int:
    adp = fetch_adp_board()
    problems = []
    check_degeneracy(problems)
    print()
    for name, pos, mfl_id, expected, tol, note in BENCHMARKS:
        row = adp.get(mfl_id)
        if row is None:
            problems.append(f"{name} ({pos}): mfl_id {mfl_id} not found in board at all")
            continue
        if row["pos"] != pos:
            problems.append(f"{name}: expected pos {pos}, got {row['pos']} — "
                             f"mfl_id may be stale/wrong")
            continue
        actual = row["pos_rank"]
        delta = abs(actual - expected)
        status = "OK" if delta <= tol else "FAIL"
        print(f"[{status}] {name:20} {pos}{actual:<4} (expected {pos}{expected} +/-{tol})")
        print(f"        {note}")
        if delta > tol:
            problems.append(f"{name}: got {pos}{actual}, expected {pos}{expected} +/-{tol}")

    print()
    if problems:
        print(f"FAILED — {len(problems)} benchmark(s) out of tolerance:")
        for p in problems:
            print(f"  - {p}")
        print()
        print("If this follows an intentional formula change: re-verify each failing "
              "player against a real external ADP source (see docs/auction/"
              "adp_sources_reference.md for accessible sources), then update the "
              "benchmark's expected value AND the note citing the new source/date. "
              "Do not just widen the tolerance.")
        return 1
    print(f"All {len(BENCHMARKS)} benchmarks within tolerance.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
