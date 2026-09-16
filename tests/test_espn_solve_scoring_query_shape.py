#!/usr/bin/env python3
"""Guard the join shape in scripts/espn_solve_scoring.py against regressing
back to the version that read 4.5M D1 rows per run.

WHAT THIS DOES. Static source check, no D1 connection. The real fix was
verified live on prod 2026-08-28 — 4,501,580 rows read -> 14,731 (305x),
output diffed row-for-row against the unfixed query (2,371 rows, every
column, identical) — this file exists to keep that fix from silently
regressing, not to re-derive it.

WHY BOTH CHANGES MATTER, NOT JUST ONE.
  1. LOWER(n.display_name) = LOWER(f.full_name) could use NO index on either
     side (nfl_player_names had none at all), so it scanned the whole
     ~25,764-row table per outer row. Fixed by n.display_name_lower, a
     VIRTUAL GENERATED + indexed column added on nfl_player_names (migration
     0144, the UPS/MFL side of this shared D1 instance).
  2. That index alone was NOT enough. A plain JOIN let SQLite reorder the
     joins back to searching nfl_player_weekly by (season=?, week=?) alone --
     BEFORE n was resolved, so w.gsis_id could not be bound -- pulling in
     every player active that NFL week regardless of name match. CROSS JOIN
     pins this join's position (SQLite's documented mechanism for exactly
     this) so nfl_player_weekly is only ever reached through n.gsis_id, on
     its own primary key (season, week, gsis_id).
  Losing either change alone reintroduces the cost -- confirmed empirically:
  the CROSS-JOIN-only variant (index in place, JOIN not CROSS JOIN) still
  cost 4,501,580 rows, because the planner reordered away from the index.
"""
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = (REPO / "scripts" / "espn_solve_scoring.py").read_text()

# The fix's own explanatory comments quote the OLD broken form in prose (SQL
# `--` comments), which would otherwise make "the bad pattern is gone" check
# fail against its own documentation. Strip SQL comment lines before matching
# -- the same discipline this repo's JS tests use for the same reason.
SQL_CODE = "\n".join(
    line for line in SRC.splitlines() if not line.strip().startswith("--")
)

FAILURES = []


def check(name, cond, why=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(name + (f" -- {why}" if why else ""))
        print(f"  FAIL {name}" + (f"\n         {why}" if why else ""))


def main():
    print("the unindexed comparison is gone")
    check(
        "no LOWER(n.display_name) = LOWER(f.full_name)",
        not re.search(r"LOWER\(\s*n\.display_name\s*\)\s*=\s*LOWER\(\s*f\.full_name\s*\)", SQL_CODE),
        "reintroduces the 25,764-row-per-outer-row scan this file exists to prevent",
    )
    check(
        "uses n.display_name_lower = LOWER(f.full_name)",
        bool(re.search(r"n\.display_name_lower\s*=\s*LOWER\(\s*f\.full_name\s*\)", SRC)),
        "the fix must actually USE the new indexed column, not just avoid the old form",
    )

    print("\nnfl_player_weekly is joined via CROSS JOIN, not JOIN")
    check(
        "CROSS JOIN nfl_player_weekly is present",
        bool(re.search(r"CROSS JOIN\s+nfl_player_weekly\s+w", SRC)),
        "without CROSS JOIN, SQLite reorders back to searching w by (season, week) "
        "alone -- verified live: same cost as before the fix, 4,501,580 rows",
    )
    check(
        "no plain JOIN nfl_player_weekly remains (only the CROSS JOIN form)",
        not re.search(r"(?<!CROSS )JOIN\s+nfl_player_weekly\s+w", SRC),
        "a second, unpinned join to the same table would reintroduce the regression",
    )

    print(f"\n{len(FAILURES)} FAILED" if FAILURES else "\nall passed")
    sys.exit(1 if FAILURES else 0)


if __name__ == "__main__":
    main()
