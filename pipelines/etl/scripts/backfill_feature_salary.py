#!/usr/bin/env python3
"""Backfill model_player_week_features.mfl_salary from src_contracts.

Split out of migration 0122 because doing it inline killed D1:

    "D1 DB exceeded its CPU time limit and was reset"

A correlated-subquery UPDATE across 245,000 feature rows exceeds D1's
per-invocation CPU budget, and because statements share a transaction the ALTER
rolled back with it — the migration errored while leaving NO column behind,
which reads deceptively like a partial success. Bulk updates of this size have to be chunked.

⚠️ AND D1Writer IS THE WRONG TOOL FOR IT. Its upsert is
`INSERT ... ON CONFLICT DO UPDATE`, and SQLite validates NOT NULL while
CONSTRUCTING the candidate row — before the uniqueness conflict is detected. So
updating a subset of columns on a table with a NOT NULL column that has no
default fails outright:
    NOT NULL constraint failed: model_player_week_features.as_of_ts
even though every target row already exists. Plain chunked UPDATE statements are
the right instrument.

WHY SALARY IS IN THE FEATURE STORE AT ALL
-----------------------------------------
The Breakout Radar's "not yet established" clause tested season-to-date PPG
against the position's 24th-best — a PERFORMANCE test standing in for a COST
test. It let known stars having a poor season qualify, so Ezekiel Elliott, Chris
Godwin, Michael Pittman, Tony Pollard and Kirk Cousins all appeared in the
caught list. None was ever a cheap acquisition; they were reverting to form.

Salary measures what the spec actually means: a player whose projected value has
moved while his PRICE has not.

NULL MEANS FRINGE, AND THAT IS MEASURED
---------------------------------------
src_contracts holds ~600 players/season (12 franchises x ~50); src_weekly
carries ~1,700. The ~35% without a contract row are not a data defect:

    2024 WR/TE/RB/QB weeks 5-17
      has salary : 2,929 player-weeks, avg 10.98 UPS
      no salary  : 1,419 player-weeks, avg  2.73 UPS

A 4x scoring gap spread evenly across all 13 franchise ids — minimum-cost,
recently-added and deep-bench players, not a franchise-specific extract failure.
Left NULL here rather than zero-filled: "no contract row" and "a contract worth
zero" are different claims. The radar decides how to read it, and says so.

Usage:
  python3 pipelines/etl/scripts/backfill_feature_salary.py --seasons 2016-2025
  python3 pipelines/etl/scripts/backfill_feature_salary.py --seasons 2024 --dry-run
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402
from lib.d1_io import wrangler_execute  # noqa: E402

WORKER = Path(__file__).resolve().parents[3] / "worker"
PER_STMT = 400          # gsis ids per UPDATE ... IN (...) list
STMTS_PER_FILE = 60     # keep each wrangler invocation under D1's CPU budget


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2016-2025")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    import tempfile
    total = 0
    for season in parse_seasons(args.seasons):
        ctx = AsOfContext(season=season, week=1)
        rows = ctx.run(
            "SELECT f.gsis_id gs, c.salary sal FROM src_contracts c"
            " JOIN ff_player_ids f ON f.mfl_id = CAST(c.player_id AS TEXT)"
            f" WHERE c.season = {season} AND c.salary IS NOT NULL"
            "   AND COALESCE(f.gsis_id,'') LIKE '00-%'")
        if not rows:
            print(f"[{season}] no contract rows — skipping", file=sys.stderr)
            continue

        # Salary is per (season, player) — identical across all his weeks — so
        # group by VALUE and update every week of every player at that salary in
        # one statement. ~600 players collapse to a few hundred statements.
        by_sal = {}
        for r in rows:
            by_sal.setdefault(int(r["sal"]), []).append(r["gs"])

        stmts = []
        for sal, gs in by_sal.items():
            for i in range(0, len(gs), PER_STMT):
                ids = ",".join("'" + g.replace("'", "''") + "'"
                               for g in gs[i:i + PER_STMT])
                stmts.append(f"UPDATE model_player_week_features SET mfl_salary="
                             f"{sal} WHERE season={season} AND gsis_id IN ({ids});")
        print(f"[{season}] {len(rows)} salaried players, {len(by_sal)} distinct "
              f"salaries -> {len(stmts)} UPDATE statements", file=sys.stderr,
              flush=True)
        if args.dry_run:
            continue

        # Chunked into several files: one giant transaction is what tripped
        # "D1 DB exceeded its CPU time limit" when this backfill lived inside
        # migration 0122.
        for i in range(0, len(stmts), STMTS_PER_FILE):
            with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as fh:
                fh.write("\n".join(stmts[i:i + STMTS_PER_FILE]))
                path = Path(fh.name)
            wrangler_execute(path, worker_cwd=WORKER)
            path.unlink(missing_ok=True)
        total += len(stmts)
        print(f"[{season}] written", file=sys.stderr, flush=True)

    print(f"DONE: {'would run' if args.dry_run else 'ran'} {total} statements",
          file=sys.stderr)


if __name__ == "__main__":
    main()
