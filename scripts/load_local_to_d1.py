#!/usr/bin/env python3
"""Phase 3 loader — copies MFL source tables from local SQLite to D1.

For each target table we:
  1. DELETE existing rows (idempotent re-runs)
  2. Write chunked multi-row INSERTs to worker/.tmp/d1_load/<table>_<n>.sql
  3. wrangler d1 execute --remote --file=<chunk>.sql
  4. Write a summary row into src_load_manifest

Run from the repo root:
    python3 scripts/load_local_to_d1.py

Subset flag (skip big tables during iteration):
    python3 scripts/load_local_to_d1.py --only contracts,adddrop,trades
    python3 scripts/load_local_to_d1.py --only weekly    # the big one (~279k rows)

Dry-run (row counts only, no D1 writes):
    python3 scripts/load_local_to_d1.py --dry-run
"""

from __future__ import annotations
import argparse
import os
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = REPO_ROOT / "worker"
TMP_DIR = WORKER_DIR / ".tmp" / "d1_load"
LOCAL_DB = Path("/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db")

CHUNK_SIZE = 200  # rows per INSERT statement — D1 caps single-statement size at ~100KB; trades/comments push us near the ceiling at higher counts


def sql_escape(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:
            return "NULL"
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def build_insert(table: str, cols: list[str], rows: list[tuple]) -> str:
    col_list = ", ".join(cols)
    value_tuples = []
    for row in rows:
        vals = ", ".join(sql_escape(v) for v in row)
        value_tuples.append(f"({vals})")
    newline_join = ",\n"
    # OR IGNORE absorbs rare dupes on composite PKs (e.g. ~200 duplicate
    # (season, week, player_id) rows in player_weeklyscoringresults where
    # a player appeared on two franchises in the same week).
    return f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES\n{newline_join.join(value_tuples)};\n"


def wrangler_execute(sql_path: Path, db: str) -> None:
    cmd = [
        "npx", "--yes", "wrangler@latest", "d1", "execute", db,
        "--remote", "--file", str(sql_path),
    ]
    res = subprocess.run(cmd, cwd=WORKER_DIR, env={**os.environ}, capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(f"[d1 execute FAILED] {sql_path.name}\nSTDERR:\n{res.stderr[:2000]}\nSTDOUT:\n{res.stdout[:500]}\n")
        raise SystemExit(res.returncode)


def reset_table(table: str, db_name: str) -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    p = TMP_DIR / f"{table}__reset.sql"
    p.write_text(f"DELETE FROM {table};\n")
    wrangler_execute(p, db_name)


def load_table(
    local_db: sqlite3.Connection,
    src_sql: str,
    dst_table: str,
    dst_cols: list[str],
    db_name: str,
) -> int:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    reset_table(dst_table, db_name)

    total = 0
    chunk_idx = 0
    chunk: list[tuple] = []

    def flush():
        nonlocal chunk_idx, total
        if not chunk:
            return
        chunk_idx += 1
        sql = build_insert(dst_table, dst_cols, chunk)
        path = TMP_DIR / f"{dst_table}__{chunk_idx:04d}.sql"
        path.write_text(sql)
        wrangler_execute(path, db_name)
        total += len(chunk)
        print(f"  [{dst_table}] chunk {chunk_idx}: +{len(chunk)} (total {total})", flush=True)
        chunk.clear()

    cur = local_db.execute(src_sql)
    src_keys = [d[0] for d in cur.description]
    if len(src_keys) != len(dst_cols):
        raise SystemExit(
            f"column count mismatch for {dst_table}: src has {len(src_keys)} "
            f"({src_keys}) vs dst expects {len(dst_cols)}"
        )
    for row in cur:
        chunk.append(row)
        if len(chunk) >= CHUNK_SIZE:
            flush()
    flush()
    print(f"  [{dst_table}] DONE: {total} rows", flush=True)
    return total


def record_manifest(db_name: str, rows_by_table: dict[str, int]) -> None:
    import socket
    source_host = socket.gethostname()
    lines = []
    for tbl, n in rows_by_table.items():
        lines.append(
            f"INSERT INTO src_load_manifest (src_table, row_count, source_host) VALUES ("
            f"{sql_escape(tbl)}, {n}, {sql_escape(source_host)});"
        )
    p = TMP_DIR / "_manifest.sql"
    p.write_text("\n".join(lines) + "\n")
    wrangler_execute(p, db_name)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="ups-mfl-db")
    ap.add_argument("--only", help="comma-separated subset: contracts,adddrop,trades,weekly,drafts")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}")
    conn = sqlite3.connect(str(LOCAL_DB))

    plan = [
        ("contracts", "src_contracts",
         """
         SELECT season, player_id, franchise_id, team_name, salary, contract_year,
                contract_length, contract_status, contract_info, tcv, aav,
                extension_flag, year_values_json, source_detail, generated_at_utc
         FROM contract_history_snapshots
         """,
         ["season","player_id","franchise_id","team_name","salary","contract_year",
          "contract_length","contract_status","contract_info","tcv","aav",
          "extension_flag","year_values_json","source_detail","generated_at_utc"]),
        ("adddrop", "src_adddrop",
         """
         SELECT season, txn_index, player_id, move_type, franchise_id,
                franchise_name, method, salary, unix_timestamp, datetime_et
         FROM transactions_adddrop
         """,
         ["season","txn_index","player_id","move_type","franchise_id",
          "franchise_name","method","salary","unix_timestamp","datetime_et"]),
        ("trades", "src_trades",
         """
         SELECT transactionid, season, txn_index, trade_group_id, franchise_id,
                franchise_name, asset_role, asset_type, player_id, player_name,
                comments, unix_timestamp, datetime_et
         FROM transactions_trades
         """,
         ["transactionid","season","txn_index","trade_group_id","franchise_id",
          "franchise_name","asset_role","asset_type","player_id","player_name",
          "comments","unix_timestamp","datetime_et"]),
        ("weekly", "src_weekly",
         """
         SELECT season, week, player_id, pos_group, status, score, is_reg,
                roster_franchise_id, roster_franchise_name, pos_rank, overall_rank
         FROM player_weeklyscoringresults
         WHERE is_reg = 1
         """,
         ["season","week","player_id","pos_group","status","score","is_reg",
          "roster_franchise_id","roster_franchise_name","pos_rank","overall_rank"]),
        ("drafts", "src_draft_picks",
         """
         SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
                franchise_id, franchise_name, player_id, player_name,
                unix_timestamp, datetime_et, 'legacy' AS source
         FROM draftresults_legacy
         UNION ALL
         SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
                franchise_id, franchise_name, player_id, player_name,
                unix_timestamp, datetime_et, 'mfl' AS source
         FROM draftresults_mfl
         """,
         ["season","draftpick_round","draftpick_roundorder","draftpick_overall",
          "franchise_id","franchise_name","player_id","player_name",
          "unix_timestamp","datetime_et","source"]),
    ]

    selected = set((args.only or "").split(",")) if args.only else None

    if args.dry_run:
        for flag, _, src_sql, _ in plan:
            if selected and flag not in selected:
                continue
            n = conn.execute(f"SELECT COUNT(*) FROM ({src_sql})").fetchone()[0]
            print(f"{flag}: {n} rows")
        return

    if TMP_DIR.exists():
        shutil.rmtree(TMP_DIR)
    TMP_DIR.mkdir(parents=True, exist_ok=True)

    rows_by_table: dict[str, int] = {}
    for flag, label, src_sql, dst_cols in plan:
        if selected and flag not in selected:
            continue
        print(f"Loading {flag} → {label}")
        n = load_table(conn, src_sql, label, dst_cols, args.db)
        rows_by_table[label] = n

    print("Recording manifest...")
    record_manifest(args.db, rows_by_table)

    print("Done. Summary:")
    for tbl, n in rows_by_table.items():
        print(f"  {tbl}: {n}")


if __name__ == "__main__":
    main()
