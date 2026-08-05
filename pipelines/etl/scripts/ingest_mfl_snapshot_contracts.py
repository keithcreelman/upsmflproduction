#!/usr/bin/env python3
"""Load MFL roster/salary from the nightly snapshot into src_contracts.

    python3 pipelines/etl/scripts/ingest_mfl_snapshot_contracts.py --season 2026 --dry-run
    python3 pipelines/etl/scripts/ingest_mfl_snapshot_contracts.py --season 2026

WHY
    data/mfl-snapshots/YYYY-MM-DD/ is written nightly by .github/workflows/
    mfl-daily-snapshot.yml and committed to git -- but NOTHING ever ingests it.
    src_contracts therefore stops at 2025, so the model has no 2026 salary and
    the Breakout Radar cannot define "cheap" by cost for the current season.

STRUCTURAL FIELDS ONLY -- THIS IS DELIBERATE
    The snapshot carries exactly seven per-player fields: id, salary,
    contractYear, contractStatus, contractInfo, status, drafted. Five
    src_contracts columns are NOT among them:

        tcv, aav, contract_length, extension_flag, year_values_json

    They ARE recoverable by parsing the contractInfo annotation
    ("CL 2| TCV 30K| AAV 15K| Y1-15K, Y2-15K"), and this script deliberately
    does NOT do that. Canon: derive cap math from structured data, never from
    notes -- contractInfo is a fallback for VERIFYING a number, not a source for
    one. They are written NULL, because "the source does not say" and "the value
    is zero" are different claims.

    Note the existing table has ZERO nulls in tcv/aav today (it uses 0), so these
    rows are the first to distinguish the two. The columns are nullable by
    migration 0035, and NULL is what canon asks for.

VERIFIED BEFORE WRITING
    contract_year is YEARS REMAINING in both the snapshot and src_contracts, so
    it copies straight across. Checked against the 358 players present in both
    2025 src_contracts and the 2026 snapshot: 202 decrement by exactly one
    season, and every exception is an extension or re-signing that reset the
    term (14860 Veteran cy=1 -> Vet-Ext1 cy=1; 16181 Rookie cy=1 -> Vet-Ext2
    cy=2). No unexplained drift.

⚠️ CONTRACT STATUS VOCABULARY CHANGED BETWEEN SEASONS
    2025 src_contracts uses {BL, FL, Rookie, Tag, Veteran, WW}. The 2026 snapshot
    uses the compound scheme {Vet-FAA, Rookie-Draft, Vet-Ext1, Vet-Ext2-BL,
    Rookie-MYM, Vet-ERA, ...}. Stored VERBATIM -- never normalised on the way in,
    per "don't substitute defaults for MFL data fields" -- but anything comparing
    contract_status ACROSS seasons must normalise first or it will silently find
    zero matches. The run prints the vocabulary it saw for exactly this reason.
"""
from __future__ import annotations
import argparse
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
SNAP_DIR = REPO / "data" / "mfl-snapshots"

COLS = ["season", "player_id", "franchise_id", "team_name", "salary",
        "contract_year", "contract_length", "contract_status", "contract_info",
        "tcv", "aav", "extension_flag", "year_values_json",
        "source_detail", "generated_at_utc"]
PK = ["season", "player_id"]


def _i(v):
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return None


def _s(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def load_snapshot(day: str | None):
    days = sorted(p for p in SNAP_DIR.iterdir() if p.is_dir()) if SNAP_DIR.is_dir() else []
    if not days:
        raise SystemExit(f"REFUSING: no snapshots under {SNAP_DIR}")
    path = (SNAP_DIR / day) if day else days[-1]
    if not path.is_dir():
        raise SystemExit(f"REFUSING: snapshot {path} does not exist")

    rosters = path / "rosters.json"
    league = path / "league.json"
    for f in (rosters, league):
        if not f.is_file():
            raise SystemExit(f"REFUSING: {f} missing — snapshot is incomplete, "
                             f"and an incomplete snapshot is not an empty one")

    # STALENESS GUARD. Snapshots are committed to git and land in whatever
    # checkout you are standing in, so "newest on disk" is NOT "newest that
    # exists" — a git worktree branched before last night's commit silently
    # serves yesterday's roster. This bit on the first run: the worktree offered
    # 2026-08-04 (502 players) while main already had 2026-08-05 (504).
    # An out-of-date snapshot is not an error, but it must never be quiet.
    if not day:
        try:
            age = (datetime.now(timezone.utc).date()
                   - datetime.strptime(path.name, "%Y-%m-%d").date()).days
        except ValueError:
            age = None
        if age is not None and age >= 1:
            print(f"  ⚠️ newest snapshot on disk is {path.name} — {age} day(s) old. "
                  f"If a newer one exists on another branch, `git pull` first or "
                  f"pass --day explicitly.", file=sys.stderr)
            if age > 7:
                raise SystemExit(
                    f"REFUSING: snapshot {path.name} is {age} days old. Contract "
                    f"state moves daily; pass --day {path.name} to override.")
    return path, json.loads(rosters.read_text()), json.loads(league.read_text())


def build(season: int, day: str | None):
    path, rost, lg = load_snapshot(day)
    names = {f["id"]: f.get("name", "") for f in lg["league"]["franchises"]["franchise"]}

    franchises = rost.get("rosters", {}).get("franchise")
    if not franchises:
        raise SystemExit(f"REFUSING: {path}/rosters.json has no franchises — "
                         f"unreadable, not empty")

    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    src = f"mfl_snapshot_{path.name}"
    rows, statuses, no_salary = [], Counter(), 0

    for f in franchises:
        fid = f.get("id")
        ps = f.get("player") or []
        if isinstance(ps, dict):
            ps = [ps]
        for p in ps:
            pid = _s(p.get("id"))
            if not pid:
                continue
            sal = _i(p.get("salary"))
            if sal is None:
                no_salary += 1
            statuses[_s(p.get("contractStatus")) or "(none)"] += 1
            rows.append((
                season, pid, fid, names.get(fid, ""),
                sal,
                _i(p.get("contractYear")),
                None,                              # contract_length  — not in source
                _s(p.get("contractStatus")),       # verbatim, never normalised
                _s(p.get("contractInfo")),         # raw annotation, unparsed
                None,                              # tcv              — not in source
                None,                              # aav              — not in source
                None,                              # extension_flag   — not in source
                None,                              # year_values_json — not in source
                src, stamp,
            ))
    return rows, statuses, no_salary, path.name


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--day", help="snapshot dir name, e.g. 2026-08-05 (default: newest)")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows, statuses, no_salary, day = build(args.season, args.day)
    if not rows:
        raise SystemExit("REFUSING: snapshot produced 0 player rows")

    print(f"snapshot {day}: {len(rows)} rostered players, "
          f"{len({r[2] for r in rows})} franchises", file=sys.stderr)
    if no_salary:
        print(f"  ⚠️ {no_salary} player(s) had an unparseable salary — stored NULL",
              file=sys.stderr)
    print("  contract_status vocabulary in this snapshot "
          "(stored verbatim; normalise before comparing across seasons):",
          file=sys.stderr)
    for k, v in statuses.most_common():
        print(f"      {k:<22}{v}", file=sys.stderr)
    print("  NULL by design: contract_length, tcv, aav, extension_flag, "
          "year_values_json", file=sys.stderr)

    if args.dry_run:
        print("(dry run — nothing written)", file=sys.stderr)
        return 0

    with D1Writer(table="src_contracts", cols=COLS, pk_cols=PK, chunk_size=200) as w:
        for r in rows:
            w.add(r)
    print(f"written {len(rows)} rows to src_contracts season={args.season}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
