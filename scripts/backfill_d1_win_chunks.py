#!/usr/bin/env python3
"""Surgical win_chunks backfill — local SQLite → D1 src_weekly.

Why this exists (not just the full loader):
  - scripts/load_local_to_d1.py --only weekly does a DELETE+INSERT on
    all 279K src_weekly rows. At 200 rows/chunk × ~3 sec/chunk that's
    ~70 min. Painful when we only need to update one column on ~24K
    rows (the subset where status='starter').
  - This script generates UPDATE statements for only the non-NULL
    win_chunks rows in the local DB, chunked into VALUES-tuples for
    minimum round-trips. Estimated total: ~5-10 min.

Usage:
    python3 scripts/backfill_d1_win_chunks.py --dry-run    # row counts only
    python3 scripts/backfill_d1_win_chunks.py              # actually push
    python3 scripts/backfill_d1_win_chunks.py --limit 1000 # smoke test
"""

from __future__ import annotations
import argparse
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO_ROOT / "worker"
TMP_DIR = WORKER_DIR / ".tmp" / "win_chunks_backfill"

_DEFAULT_DB = Path(
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL_Scripts/Datastorage/mfl_database.db"
)
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

# D1 caps a single .sql file at ~10 MB; each UPDATE statement is ~110 B
# (season, week, pid, win_chunks). 500 statements ≈ 55 KB.
# Verified 2026-05-13: D1 does NOT support UPDATE...FROM (VALUES ...)
# (returns SQLITE_ERROR near "("). Fall back to one UPDATE per row.
CHUNK_SIZE = 500


def sql_num(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:  # NaN
            return "NULL"
        return str(v)
    return f"'{str(v)}'"


def fetch_rows(conn: sqlite3.Connection, limit: int | None) -> list[tuple]:
    """Pull (season, week, player_id, win_chunks) for every row in the
    local DB where win_chunks is set. Local DB has these for status='starter'
    rows only — verified 2026-05-13."""
    sql = """
        SELECT season, week, player_id, win_chunks
        FROM player_weeklyscoringresults
        WHERE win_chunks IS NOT NULL
        ORDER BY season DESC, week, player_id
    """
    if limit:
        sql += f" LIMIT {int(limit)}"
    cur = conn.execute(sql)
    return list(cur.fetchall())


def write_chunk_files(rows: list[tuple], tmp_dir: Path) -> list[Path]:
    """Build one .sql file per CHUNK_SIZE rows; each row = one UPDATE.
    The composite WHERE key is (season, week, player_id). D1's libsql
    variant rejects UPDATE...FROM (VALUES ...) with SQLITE_ERROR near "("
    so we use the boring per-row form."""
    tmp_dir.mkdir(parents=True, exist_ok=True)
    # Clean prior runs so chunk numbering stays consistent.
    for old in tmp_dir.glob("win_chunks_*.sql"):
        old.unlink()

    paths: list[Path] = []
    for i in range(0, len(rows), CHUNK_SIZE):
        chunk = rows[i : i + CHUNK_SIZE]
        lines = []
        for r in chunk:
            season, week, pid, wc = r
            lines.append(
                "UPDATE src_weekly SET win_chunks = {} "
                "WHERE season = {} AND week = {} AND player_id = {};".format(
                    sql_num(wc), sql_num(season), sql_num(week), sql_num(pid)
                )
            )
        out = tmp_dir / f"win_chunks_{i // CHUNK_SIZE:04d}.sql"
        out.write_text("\n".join(lines) + "\n")
        paths.append(out)
    return paths


def run_chunk(path: Path) -> tuple[bool, str]:
    """Push one chunk file through wrangler d1 execute --remote."""
    cmd = [
        "npx", "wrangler", "d1", "execute", "ups-mfl-db",
        "--remote", f"--file={path}"
    ]
    proc = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True)
    ok = proc.returncode == 0
    tail = (proc.stderr or proc.stdout).strip().splitlines()
    return ok, "\n".join(tail[-3:])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true",
                    help="Show row count + estimated chunks, no D1 writes.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap on number of rows to backfill (smoke test).")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        print(f"ERROR: local DB not found at {LOCAL_DB}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(f"file:{LOCAL_DB}?mode=ro", uri=True)
    rows = fetch_rows(conn, args.limit)
    n = len(rows)
    chunks_est = (n + CHUNK_SIZE - 1) // CHUNK_SIZE
    print(f"Local rows with win_chunks: {n:,}")
    print(f"Chunks to push (size={CHUNK_SIZE}): {chunks_est}")
    if args.dry_run:
        print("Dry-run — nothing written.")
        return 0
    if not n:
        print("Nothing to push.")
        return 0

    paths = write_chunk_files(rows, TMP_DIR)
    print(f"Wrote {len(paths)} chunk file(s) under {TMP_DIR}")

    failures: list[tuple[Path, str]] = []
    start = time.time()
    for idx, p in enumerate(paths, 1):
        t0 = time.time()
        ok, tail = run_chunk(p)
        dt = time.time() - t0
        if ok:
            print(f"  [{idx:>4}/{len(paths)}] {p.name}  ok  ({dt:.1f}s)")
        else:
            failures.append((p, tail))
            print(f"  [{idx:>4}/{len(paths)}] {p.name}  FAIL  ({dt:.1f}s)\n{tail}")

    elapsed = time.time() - start
    print(f"\nDone in {elapsed:.0f}s. OK: {len(paths) - len(failures)}/{len(paths)}.")
    if failures:
        print("Failures:")
        for p, tail in failures[:5]:
            print(f"  {p.name}: {tail}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
