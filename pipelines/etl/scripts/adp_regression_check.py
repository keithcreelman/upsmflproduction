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


def main() -> int:
    adp = fetch_adp_board()
    problems = []
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
