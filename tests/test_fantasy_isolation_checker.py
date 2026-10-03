#!/usr/bin/env python3
"""Guard the fixes to scripts/check_fantasy_isolation.py against regressing
back to the state a code review found on 2026-08-28.

WHAT THIS DOES. Static + behavioral checks against the checker's own
find_violations() and SCAN_KINDS, using the exact real cases the review
confirmed live — not synthetic guesses. Each fix has a positive case (the
real bug, now caught) and a control (a legitimate exemption that must still
hold, so the fix isn't a blunt instrument that breaks the thing it was
protecting).
"""
import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location(
    "check_fantasy_isolation", REPO / "scripts" / "check_fantasy_isolation.py"
)
cfi = importlib.util.module_from_spec(_spec)
sys.modules["check_fantasy_isolation"] = cfi  # dataclasses needs this registered first
_spec.loader.exec_module(cfi)

FAILURES = []


def check(name, cond, why=""):
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(name + (f" -- {why}" if why else ""))
        print(f"  FAIL {name}" + (f"\n         {why}" if why else ""))


def n_violations(src, filename="scripts/example.py"):
    return len(cfi.find_violations(src, filename))


print("SCAN_KINDS now covers the standalone fantasy scripts")
check(
    "scripts/cbs_*.py and scripts/espn_*.py are in SCAN_KINDS",
    any(
        set(k.patterns) & {"scripts/cbs_*.py", "scripts/espn_*.py"}
        for k in cfi.SCAN_KINDS
    ),
    "18 real CBS scripts + 2 ESPN scripts wrote to/read D1 with zero isolation coverage",
)
check(
    "scripts/yahoo_*.py is NOT in SCAN_KINDS (matches zero files today)",
    not any("scripts/yahoo_*.py" in k.patterns for k in cfi.SCAN_KINDS),
    "an empty glob is a refusal in this checker (collect()'s own docstring) -- "
    "a speculative pattern for a file that doesn't exist yet breaks every CI run",
)

print("\nCOLUMN_SHAPED_RE no longer exempts a real protected table")
check(
    "DELETE FROM ups_injury_status is caught",
    n_violations('conn.execute("DELETE FROM " + "ups_injury_status")\n') > 0,
)
check(
    "DELETE FROM ups_transactions is still caught (no regression)",
    n_violations('conn.execute("DELETE FROM " + "ups_transactions")\n') > 0,
)
check(
    "a real column named mfl_id is still exempt (the rule's original purpose)",
    n_violations('conn.execute("INSERT INTO fantasy_player_crosswalk (mfl_id) VALUES (?)")\n') == 0,
    "the loose-net exemption exists so a legitimate column doesn't false-positive -- must still work",
)

print("\nNEGATION_RE no longer excuses live code, only prose")
check(
    "a negated boolean guarding a real write is caught",
    n_violations('if not dry_run: loader.execute("DELETE FROM ups_transactions WHERE id=1")\n') > 0,
    "single-line guard, the exact shape the review verified live -- the negation "
    "word must sit in prose (a comment/docstring), not anywhere earlier on the "
    "SAME line as a real write",
)
check(
    "a genuine prohibition comment is still exempt",
    n_violations('# NEVER: DELETE FROM ups_transactions is banned\n') == 0,
)
check(
    "the real 0132-0139 SQL migration header prohibitions are still exempt",
    n_violations(
        '-- NEVER `wrangler d1 migrations apply` -- corrupts contracts\n',
        "worker/migrations/0132_fantasy_control_and_raw.sql",
    ) == 0,
    "the exemption's actual documented purpose -- must not regress",
)

print("\ncheck_cross_contamination is wired into cli.py, not dead code")
CLI_SRC = (REPO / "pipelines" / "fantasy" / "cli.py").read_text()
check(
    "cli.py calls qchecks.check_cross_contamination",
    "qchecks.check_cross_contamination(" in CLI_SRC,
)
check(
    "the call passes loader.query, a live D1 read -- not the in-memory bundle",
    "check_cross_contamination(loader.query)" in CLI_SRC,
    "every other check in run_all() works on `bundle`; this one needs live D1 state",
)

print("\nCI path filters use NAME-based migration matching, not stale numbers")
LINT_YML = (REPO / ".github" / "workflows" / "lint-fantasy-isolation.yml").read_text()
check(
    "lint-fantasy-isolation.yml watches worker/migrations/*_fantasy_*.sql",
    "worker/migrations/*_fantasy_*.sql" in LINT_YML,
)
check(
    "no stale 0127*-0132* numeric list remains",
    "0127*.sql" not in LINT_YML and "0131*.sql" not in LINT_YML,
    "those numbers matched 1 of 8 real fantasy migrations and collided with 2 unrelated real UPS migrations",
)
check(
    "lint-fantasy-isolation.yml also watches the new scripts/ globs",
    "scripts/cbs_*.py" in LINT_YML and "scripts/espn_*.py" in LINT_YML,
    "the CI trigger must cover the same files SCAN_KINDS now scans, or an edit "
    "to one of the 20 newly-covered scripts would never re-run this job",
)

print(f"\n{len(FAILURES)} FAILED" if FAILURES else "\nall passed")
sys.exit(1 if FAILURES else 0)
