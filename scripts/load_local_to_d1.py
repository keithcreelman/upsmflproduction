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
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR_DEFAULT = REPO_ROOT / "worker"
TMP_DIR_DEFAULT = WORKER_DIR_DEFAULT / ".tmp" / "d1_load"
# Keith 2026-04-23 — honor $MFL_DB_PATH so the same env var drives every
# fetcher + the sync step. Default kept for backwards compat on machines
# that already have the DB at the legacy path.
_DEFAULT_DB = Path("/Users/keithcreelman/Documents/mfl/Development/pipelines/etl/data/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

# Runtime overrides (set in main()) so the standalone copy installed in
# ~/Library/Scripts/ can point wrangler at an explicit config file
# without needing a full git checkout on disk.
WRANGLER_CONFIG: Path | None = None
WORKER_CWD: Path = WORKER_DIR_DEFAULT
TMP_DIR: Path = TMP_DIR_DEFAULT

CHUNK_SIZE = 200  # rows per INSERT statement — D1 caps single-statement size at ~100KB; trades/comments push us near the ceiling at higher counts

# Primary-key map used to drive UPSERT mode (Keith 2026-04-24 — incremental
# syncs, no more DELETE+INSERT wipe windows). Tables NOT in this map keep
# the legacy reset-then-insert behavior. Only populate for tables where the
# PK is stable and well-understood — incorrect PK here causes silent data
# loss as rows upsert onto each other.
PK_MAP: dict[str, list[str]] = {
    "nfl_player_weekly":          ["season", "week", "gsis_id"],
    "nfl_player_snaps":           ["season", "week", "pfr_id"],
    "nfl_player_redzone":         ["season", "week", "gsis_id"],
    "nfl_player_advstats_season": ["season", "gsis_id"],
    "nfl_team_weekly":            ["season", "week", "team"],
    "player_id_crosswalk":        ["mfl_player_id"],
}


def sql_escape(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:
            return "NULL"
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def build_insert(
    table: str,
    cols: list[str],
    rows: list[tuple],
    pk_cols: list[str] | None = None,
) -> str:
    """Build an INSERT (or UPSERT) SQL statement for a batch of rows.

    When `pk_cols` is provided we emit `INSERT ... ON CONFLICT DO UPDATE`
    so re-running the sync updates in place instead of requiring a
    DELETE+INSERT cycle (Keith 2026-04-24 — incremental syncs never
    leave D1 in a half-empty state mid-run).

    Without `pk_cols` we fall back to `INSERT OR IGNORE` (legacy;
    absorbs dupes but won't overwrite).
    """
    col_list = ", ".join(cols)
    value_tuples = []
    for row in rows:
        vals = ", ".join(sql_escape(v) for v in row)
        value_tuples.append(f"({vals})")
    newline_join = ",\n"
    values_sql = newline_join.join(value_tuples)

    if pk_cols:
        update_cols = [c for c in cols if c not in pk_cols]
        if update_cols:
            set_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)
            pk_list = ", ".join(pk_cols)
            return (
                f"INSERT INTO {table} ({col_list}) VALUES\n{values_sql}\n"
                f"ON CONFLICT ({pk_list}) DO UPDATE SET {set_clause};\n"
            )
        # Table is PK-only (unusual) — an INSERT OR IGNORE is effectively the same
        return f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES\n{values_sql};\n"

    return f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES\n{values_sql};\n"


def wrangler_execute(sql_path: Path, db: str, max_attempts: int = 4) -> None:
    """Run `wrangler d1 execute` with automatic retry on transient failures.

    D1 occasionally returns generic 5xx / network errors under load; they
    clear within seconds. A fixed number of retries with light backoff
    absorbs those without aborting a 30+ minute load run.
    """
    import time
    cmd = [
        "npx", "--yes", "wrangler@latest", "d1", "execute", db,
        "--remote", "--file", str(sql_path),
    ]
    if WRANGLER_CONFIG is not None:
        cmd.extend(["--config", str(WRANGLER_CONFIG)])
    for attempt in range(1, max_attempts + 1):
        res = subprocess.run(cmd, cwd=WORKER_CWD, env={**os.environ}, capture_output=True, text=True)
        if res.returncode == 0:
            if attempt > 1:
                sys.stderr.write(f"[d1 execute] recovered on attempt {attempt} for {sql_path.name}\n")
            return
        if attempt < max_attempts:
            sys.stderr.write(f"[d1 execute] transient fail on {sql_path.name} (attempt {attempt}/{max_attempts}), retrying...\n")
            time.sleep(2 * attempt)
            continue
        sys.stderr.write(
            f"[d1 execute FAILED after {max_attempts} attempts] {sql_path.name}\n"
            f"STDERR:\n{res.stderr[:2000]}\nSTDOUT:\n{res.stdout[:500]}\n"
        )
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
    pk_cols: list[str] | None = None,
    reset: bool = False,
) -> int:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    # Keith 2026-04-24: default is INCREMENTAL upsert — no DELETE. Pass
    # reset=True (or --reset on the CLI) to force a full-table wipe first.
    # Incremental mode means a partial/failed sync never leaves D1 in an
    # empty state — only changed rows get rewritten.
    if reset:
        reset_table(dst_table, db_name)

    total = 0
    chunk_idx = 0
    chunk: list[tuple] = []

    def flush():
        nonlocal chunk_idx, total
        if not chunk:
            return
        chunk_idx += 1
        sql = build_insert(dst_table, dst_cols, chunk, pk_cols=pk_cols)
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
    ap.add_argument("--wrangler-config", help="Path to wrangler.toml for standalone invocations")
    ap.add_argument("--worker-cwd", help="Directory to cd into before running wrangler (defaults to repo worker/)")
    ap.add_argument("--tmp-dir", help="Scratch dir for generated SQL chunks (defaults to <worker>/.tmp/d1_load)")
    ap.add_argument("--reset", action="store_true",
                    help="Wipe destination tables before loading. Default is incremental UPSERT "
                         "(Keith 2026-04-24 — no more empty-D1 mid-sync windows).")
    args = ap.parse_args()

    global WRANGLER_CONFIG, WORKER_CWD, TMP_DIR
    if args.wrangler_config:
        WRANGLER_CONFIG = Path(args.wrangler_config).resolve()
    if args.worker_cwd:
        WORKER_CWD = Path(args.worker_cwd).resolve()
    if args.tmp_dir:
        TMP_DIR = Path(args.tmp_dir).resolve()

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
                roster_franchise_id, roster_franchise_name, pos_rank, overall_rank,
                win_chunks
         FROM player_weeklyscoringresults
         """,
         ["season","week","player_id","pos_group","status","score","is_reg",
          "roster_franchise_id","roster_franchise_name","pos_rank","overall_rank",
          "win_chunks"]),
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
        ("baselines", "src_baselines",
         """
         SELECT season, pos_group, score_p50_pos, score_p80_pos,
                delta_win_pos, starter_sample_count
         FROM metadata_positionalwinprofile
         """,
         ["season","pos_group","score_p50_pos","score_p80_pos",
          "delta_win_pos","starter_sample_count"]),
        ("pointssummary", "src_pointssummary",
         """
         SELECT season, player_id, positional_grouping,
                games_played, points_total, ppg,
                reg_games, reg_points, reg_ppg,
                post_games, post_points, post_ppg,
                started_games, started_points, started_ppg,
                overall_rank, pos_rank, overall_ppg_rank, pos_ppg_rank
         FROM player_pointssummary
         """,
         ["season","player_id","positional_grouping",
          "games_played","points_total","ppg",
          "reg_games","reg_points","reg_ppg",
          "post_games","post_points","post_ppg",
          "started_games","started_points","started_ppg",
          "overall_rank","pos_rank","overall_ppg_rank","pos_ppg_rank"]),
        # Advanced Stats plumbing — populated by
        # pipelines/etl/scripts/build_player_id_crosswalk.py and
        # fetch_nflverse_weekly.py. These tables don't exist in the
        # local DB until the fetchers run, so the loader silently
        # no-ops any plan entry whose source table is empty.
        ("crosswalk", "player_id_crosswalk",
         """
         SELECT mfl_player_id, gsis_id, pfr_id, sleeper_id, espn_id,
                full_name, position, birth_date, confidence, match_score, source
         FROM player_id_crosswalk
         """,
         ["mfl_player_id","gsis_id","pfr_id","sleeper_id","espn_id",
          "full_name","position","birth_date","confidence","match_score","source"]),
        ("nflweekly", "nfl_player_weekly",
         """
         SELECT season, week, gsis_id, team, opponent, position, pos_group,
                rush_att, rush_yds, rush_tds, rush_long, rush_fumbles, rush_fumbles_lost,
                targets, receptions, rec_yds, rec_tds, rec_long, rec_fumbles, rec_fumbles_lost,
                pass_att, pass_cmp, pass_yds, pass_tds, pass_ints, pass_sacks, pass_sack_yds,
                pass_long, pass_2pt,
                def_tackles_solo, def_tackles_ast, def_tackles_total, def_tfl, def_qb_hits,
                def_sacks, def_sack_yds, def_ff, def_fr, def_ints, def_pass_def, def_tds,
                fg_att, fg_made, fg_long,
                fg_att_0_39, fg_made_0_39, fg_att_40_49, fg_made_40_49,
                fg_att_50plus, fg_made_50plus,
                fg_att_50_59, fg_made_50_59, fg_att_60plus, fg_made_60plus,
                fg_distance_sum_made, fg_made_pbp,
                xp_att, xp_made,
                punts, punt_yds, punt_long, punt_inside20, punt_net_avg, punt_tb,
                punt_spot_sum, punt_spot_count,
                starter_nfl, source,
                receiving_drops, receiving_broken_tackles,
                rushing_broken_tackles, passing_drops,
                rushing_yards_before_contact, rushing_yards_after_contact,
                receiving_rat, receiving_int, receiving_drop_pct,
                receiving_adot, receiving_air_yards,
                passing_bad_throws, passing_bad_throw_pct,
                passing_times_pressured, passing_pressure_pct,
                passing_hurries, passing_hits,
                passing_air_yards, passing_adot, passing_yards_after_catch,
                def_missed_tackles, def_missed_tackle_pct,
                def_completions_allowed, def_passer_rating_allowed,
                def_yards_allowed, def_pressures
         FROM nfl_player_weekly
         """,
         ["season","week","gsis_id","team","opponent","position","pos_group",
          "rush_att","rush_yds","rush_tds","rush_long","rush_fumbles","rush_fumbles_lost",
          "targets","receptions","rec_yds","rec_tds","rec_long","rec_fumbles","rec_fumbles_lost",
          "pass_att","pass_cmp","pass_yds","pass_tds","pass_ints","pass_sacks","pass_sack_yds",
          "pass_long","pass_2pt",
          "def_tackles_solo","def_tackles_ast","def_tackles_total","def_tfl","def_qb_hits",
          "def_sacks","def_sack_yds","def_ff","def_fr","def_ints","def_pass_def","def_tds",
          "fg_att","fg_made","fg_long",
          "fg_att_0_39","fg_made_0_39","fg_att_40_49","fg_made_40_49",
          "fg_att_50plus","fg_made_50plus",
          "fg_att_50_59","fg_made_50_59","fg_att_60plus","fg_made_60plus",
          "fg_distance_sum_made","fg_made_pbp",
          "xp_att","xp_made",
          "punts","punt_yds","punt_long","punt_inside20","punt_net_avg","punt_tb",
          "punt_spot_sum","punt_spot_count",
          "starter_nfl","source",
          "receiving_drops","receiving_broken_tackles",
          "rushing_broken_tackles","passing_drops",
          "rushing_yards_before_contact","rushing_yards_after_contact",
          "receiving_rat","receiving_int","receiving_drop_pct",
          "receiving_adot","receiving_air_yards",
          "passing_bad_throws","passing_bad_throw_pct",
          "passing_times_pressured","passing_pressure_pct",
          "passing_hurries","passing_hits",
          "passing_air_yards","passing_adot","passing_yards_after_catch",
          "def_missed_tackles","def_missed_tackle_pct",
          "def_completions_allowed","def_passer_rating_allowed",
          "def_yards_allowed","def_pressures"]),
        ("nflsnaps", "nfl_player_snaps",
         """
         SELECT season, week, pfr_id, team,
                off_snaps, off_snaps_team, off_snap_pct,
                def_snaps, def_snaps_team, def_snap_pct,
                st_snaps,  st_snaps_team,  st_snap_pct
         FROM nfl_player_snaps
         """,
         ["season","week","pfr_id","team",
          "off_snaps","off_snaps_team","off_snap_pct",
          "def_snaps","def_snaps_team","def_snap_pct",
          "st_snaps","st_snaps_team","st_snap_pct"]),
        ("nflredzone", "nfl_player_redzone",
         """
         SELECT season, week, gsis_id,
                rush_att_i20, rush_att_i10, rush_att_i5,
                rush_yds_i20, rush_tds_i20,
                targets_i20, targets_i10, targets_i5,
                targets_ez, rec_i20, rec_tds_i20,
                pass_att_i20, pass_tds_i20, pass_att_ez
         FROM nfl_player_redzone
         """,
         ["season","week","gsis_id",
          "rush_att_i20","rush_att_i10","rush_att_i5",
          "rush_yds_i20","rush_tds_i20",
          "targets_i20","targets_i10","targets_i5",
          "targets_ez","rec_i20","rec_tds_i20",
          "pass_att_i20","pass_tds_i20","pass_att_ez"]),
        ("nflteam", "nfl_team_weekly",
         """
         SELECT season, week, team,
                fourth_down_total, fourth_down_go,
                fourth_down_punt, fourth_down_fg,
                stall_punts, team_punts
         FROM nfl_team_weekly
         """,
         ["season","week","team",
          "fourth_down_total","fourth_down_go",
          "fourth_down_punt","fourth_down_fg",
          "stall_punts","team_punts"]),
        ("pfrseason", "nfl_player_advstats_season",
         """
         SELECT season, gsis_id, pfr_id,
                rec_adot, rec_ybc, rec_ybc_per_r, rec_yac, rec_yac_per_r,
                rec_brk_tkl, rec_per_br, rec_drops, rec_drop_pct,
                rec_int, rec_rat,
                rush_ybc, rush_ybc_per_a, rush_yac, rush_yac_per_a,
                rush_brk_tkl, rush_att_per_br,
                pass_iay, pass_iay_per_att, pass_cay, pass_cay_per_cmp,
                pass_yac, pass_yac_per_cmp,
                pass_bad_throws, pass_bad_throw_pct,
                pass_on_tgt, pass_on_tgt_pct,
                pass_drops, pass_drop_pct,
                pass_pressures, pass_pressure_pct,
                pass_times_blitzed, pass_times_hurried,
                pass_times_hit, pass_times_sacked, pass_pocket_time,
                def_adot, def_air_yards_completed, def_yac,
                def_targets, def_completions_allowed, def_cmp_pct,
                def_yards_allowed, def_yards_per_cmp, def_yards_per_tgt,
                def_tds_allowed, def_ints, def_rating_allowed,
                def_blitz, def_hurries, def_qb_knockdowns,
                def_sacks, def_pressures, def_combined_tackles,
                def_missed_tackles, def_missed_tackle_pct
         FROM nfl_player_advstats_season
         """,
         ["season","gsis_id","pfr_id",
          "rec_adot","rec_ybc","rec_ybc_per_r","rec_yac","rec_yac_per_r",
          "rec_brk_tkl","rec_per_br","rec_drops","rec_drop_pct",
          "rec_int","rec_rat",
          "rush_ybc","rush_ybc_per_a","rush_yac","rush_yac_per_a",
          "rush_brk_tkl","rush_att_per_br",
          "pass_iay","pass_iay_per_att","pass_cay","pass_cay_per_cmp",
          "pass_yac","pass_yac_per_cmp",
          "pass_bad_throws","pass_bad_throw_pct",
          "pass_on_tgt","pass_on_tgt_pct",
          "pass_drops","pass_drop_pct",
          "pass_pressures","pass_pressure_pct",
          "pass_times_blitzed","pass_times_hurried",
          "pass_times_hit","pass_times_sacked","pass_pocket_time",
          "def_adot","def_air_yards_completed","def_yac",
          "def_targets","def_completions_allowed","def_cmp_pct",
          "def_yards_allowed","def_yards_per_cmp","def_yards_per_tgt",
          "def_tds_allowed","def_ints","def_rating_allowed",
          "def_blitz","def_hurries","def_qb_knockdowns",
          "def_sacks","def_pressures","def_combined_tackles",
          "def_missed_tackles","def_missed_tackle_pct"]),
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
        pk_cols = PK_MAP.get(label)
        # Incremental mode: table in PK_MAP → UPSERT (no reset).
        # Legacy mode: no PK known → DELETE+INSERT.
        # --reset on the CLI forces reset for every table regardless.
        use_reset = bool(args.reset) or (pk_cols is None)
        mode = "upsert" if (pk_cols and not args.reset) else "reset+insert"
        print(f"Loading {flag} → {label} ({mode})")
        n = load_table(conn, src_sql, label, dst_cols, args.db,
                       pk_cols=pk_cols if not args.reset else None,
                       reset=use_reset)
        rows_by_table[label] = n

    print("Recording manifest...")
    record_manifest(args.db, rows_by_table)

    print("Done. Summary:")
    for tbl, n in rows_by_table.items():
        print(f"  {tbl}: {n}")


if __name__ == "__main__":
    main()
