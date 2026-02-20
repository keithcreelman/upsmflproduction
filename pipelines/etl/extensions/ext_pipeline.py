#!/usr/bin/env python3
"""
ext_pipeline.py — Extension module pipeline entrypoint.

Usage:
    Phase 0 (dry-run):
        MFL_LEAGUE_ID=74598 MFL_SEASON=2026 python ext_pipeline.py --dry-run

    Phase 0 (store raw payloads):
        MFL_LEAGUE_ID=74598 MFL_SEASON=2026 python ext_pipeline.py --store

    Phase 1 (raw ingestion -> dim tables + roster_snapshot):
        MFL_LEAGUE_ID=74598 MFL_SEASON=2026 python ext_pipeline.py --phase1

    Phase 2 (contract parsing -> roster_snapshot_parsed):
        MFL_LEAGUE_ID=74598 MFL_SEASON=2026 python ext_pipeline.py --phase2

Pipeline steps:
    1. Loads config (league_id, season, server from DB — never hard-coded).
    2. Runs schema migrations (idempotent).
    3. [--store/--phase1] Fetches raw JSON from MFL + stores.
    4. [--phase1] Extracts raw fields into dim_franchise, dim_player, roster_snapshot.
    5. [--phase2] Parses contract_info_raw -> roster_snapshot_parsed (NO API calls).
    6. Prints row counts for sanity checking.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# sys.path injection
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent / "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

from ext_config import load_ext_config, get_db_conn  # noqa: E402
from ext_db import run_migrations, verify_schema, store_raw_payload  # noqa: E402
from ext_extract import (  # noqa: E402
    extract_franchises,
    extract_players,
    extract_roster_snapshot,
    load_dim_franchise,
    load_dim_player,
    load_roster_snapshot,
)
from ext_http import (  # noqa: E402
    fetch_league_json,
    fetch_players_json,
    fetch_rosters_json,
    fetch_transactions_json,
)
from ext_parse import parse_contract_info, load_roster_snapshot_parsed  # noqa: E402
from ext_time import now_et, format_datetime_et  # noqa: E402

logger = logging.getLogger("ext_pipeline")


# ---------------------------------------------------------------------------
# Row-count extraction helpers (from raw JSON)
# ---------------------------------------------------------------------------

def _count_franchises(data: dict | None) -> int | None:
    """Count franchise entries in TYPE=league response."""
    if not data:
        return None
    try:
        franchises = data["league"]["franchises"]["franchise"]
        if isinstance(franchises, list):
            return len(franchises)
        return 1
    except (KeyError, TypeError):
        return None


def _count_players(data: dict | None) -> int | None:
    """Count player entries in TYPE=players response."""
    if not data:
        return None
    try:
        players = data["players"]["player"]
        if isinstance(players, list):
            return len(players)
        return 1
    except (KeyError, TypeError):
        return None


def _count_roster_players(data: dict | None) -> int | None:
    """Count total player entries across all franchises in TYPE=rosters response."""
    if not data:
        return None
    try:
        franchises = data["rosters"]["franchise"]
        if not isinstance(franchises, list):
            franchises = [franchises]
        total = 0
        for f in franchises:
            players = f.get("player", [])
            if isinstance(players, list):
                total += len(players)
            elif players:
                total += 1
        return total
    except (KeyError, TypeError):
        return None


def _count_transactions(data: dict | None) -> int | None:
    """Count transaction entries in TYPE=transactions response."""
    if not data:
        return None
    try:
        txns = data["transactions"]["transaction"]
        if isinstance(txns, list):
            return len(txns)
        return 1
    except (KeyError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_pipeline(dry_run: bool = True, phase1: bool = False) -> None:
    """
    Execute the extension pipeline.

    Args:
        dry_run: If True, fetch and report only (no DB writes).
        phase1:  If True, extract raw fields into dim tables + roster_snapshot.
                 Implies --store (raw payloads are always persisted in phase1).
    """
    # phase1 implies store
    store = (not dry_run) or phase1
    phase_label = "Phase 1 (Raw Ingestion)" if phase1 else "Phase 0"

    # --- Config ---
    print("=" * 60)
    print(f"UPS Extension Pipeline — {phase_label}")
    print("=" * 60)

    cfg = load_ext_config()

    # Explicit DB path resolution check (requirement 3)
    db_path_from_env = os.environ.get("MFL_DB_PATH", "").strip()
    if db_path_from_env:
        db_source = "MFL_DB_PATH env var"
    else:
        db_source = "fallback (mfl_config.json / hardcoded default)"

    print(f"  League ID : {cfg.league_id}")
    print(f"  Season    : {cfg.season}")
    print(f"  Server    : {cfg.server or '(not resolved — check league_years table)'}")
    print(f"  DB Path   : {cfg.db_path}")
    print(f"  DB Source : {db_source}")
    print(f"  Timezone  : {cfg.timezone}")
    print(f"  Mode      : {'phase1' if phase1 else ('store' if store else 'dry-run')}")
    print()

    # Fail-fast: if writing to DB and using fallback path, require explicit confirmation
    if store and not db_path_from_env:
        confirm_env = os.environ.get("MFL_CONFIRM_FALLBACK_DB", "").strip().lower()
        if confirm_env != "yes":
            print("SAFETY STOP: MFL_DB_PATH is not set. Writes would go to fallback DB:")
            print(f"  {cfg.db_path}")
            print()
            print("To proceed, either:")
            print("  1) Set MFL_DB_PATH explicitly, or")
            print("  2) Set MFL_CONFIRM_FALLBACK_DB=yes to acknowledge the fallback path.")
            sys.exit(1)
        else:
            print(f"  NOTE: Using fallback DB path (confirmed via MFL_CONFIRM_FALLBACK_DB=yes)")
            print()

    if cfg.server is None:
        print("ERROR: Could not resolve MFL server from league_years table.")
        print("       Ensure league_years has a row for season={}.".format(cfg.season))
        sys.exit(1)

    # --- DB connection + migrations ---
    conn = get_db_conn(cfg)

    print("Running schema migrations...")
    run_migrations(conn)

    schema_status = verify_schema(conn)
    all_ok = all(schema_status.values())
    for table, exists in schema_status.items():
        status = "OK" if exists else "MISSING"
        print(f"  {table}: {status}")
    if not all_ok:
        print("ERROR: Not all extension tables were created.")
        sys.exit(1)
    print()

    # --- Fetch raw data ---
    pull_timestamp = format_datetime_et(now_et())
    results = {}

    print("Fetching TYPE=league...")
    league_data = fetch_league_json(conn, cfg.season)
    franchise_count = _count_franchises(league_data)
    results["league"] = {
        "data": league_data,
        "row_count": franchise_count,
        "label": "franchises",
    }
    print(f"  -> {franchise_count or 0} franchises")

    print("Fetching TYPE=players (DETAILS=1)...")
    players_data = fetch_players_json(conn, cfg.season)
    player_count = _count_players(players_data)
    results["players"] = {
        "data": players_data,
        "row_count": player_count,
        "label": "players",
    }
    print(f"  -> {player_count or 0} players")

    print("Fetching TYPE=rosters...")
    rosters_data = fetch_rosters_json(conn, cfg.season)
    roster_player_count = _count_roster_players(rosters_data)
    results["rosters"] = {
        "data": rosters_data,
        "row_count": roster_player_count,
        "label": "roster players",
    }
    print(f"  -> {roster_player_count or 0} roster players")

    print("Fetching TYPE=transactions...")
    txn_data = fetch_transactions_json(conn, cfg.season)
    txn_count = _count_transactions(txn_data)
    results["transactions"] = {
        "data": txn_data,
        "row_count": txn_count,
        "label": "transactions",
    }
    print(f"  -> {txn_count or 0} transactions")
    print()

    # --- Store raw payloads ---
    if store:
        print("Storing raw payloads to ext_raw_payloads...")
        for pull_type, info in results.items():
            if info["data"] is not None:
                payload_str = json.dumps(info["data"], separators=(",", ":"))
                rowid = store_raw_payload(
                    conn=conn,
                    nfl_season=cfg.season,
                    pull_type=pull_type,
                    pulled_at=pull_timestamp,
                    row_count=info["row_count"],
                    payload_json=payload_str,
                )
                print(f"  {pull_type}: stored (rowid={rowid}, {info['row_count']} {info['label']})")
            else:
                print(f"  {pull_type}: SKIPPED (no data returned)")
        print()
    else:
        print("DRY RUN: Skipping raw payload storage.")
        print()

    # --- Phase 1: Extract raw fields into dim tables + roster_snapshot ---
    if phase1:
        print("=" * 60)
        print("Phase 1 — Raw Field Extraction")
        print("=" * 60)

        sanity_ok = True

        # --- dim_franchise ---
        print("Extracting dim_franchise...")
        if league_data:
            franchise_rows = extract_franchises(league_data)
            loaded = load_dim_franchise(conn, franchise_rows)
            match = loaded == franchise_count
            status = "MATCH" if match else "MISMATCH"
            print(f"  extracted: {len(franchise_rows)}, loaded: {loaded}, "
                  f"expected: {franchise_count} [{status}]")
            if not match:
                sanity_ok = False
        else:
            print("  SKIPPED (no league data)")
            sanity_ok = False

        # --- dim_player ---
        print("Extracting dim_player...")
        if players_data:
            player_rows = extract_players(players_data)
            loaded = load_dim_player(conn, player_rows)
            match = loaded == player_count
            status = "MATCH" if match else "MISMATCH"
            print(f"  extracted: {len(player_rows)}, loaded: {loaded}, "
                  f"expected: {player_count} [{status}]")
            if not match:
                sanity_ok = False
        else:
            print("  SKIPPED (no players data)")
            sanity_ok = False

        # --- roster_snapshot ---
        print("Extracting roster_snapshot...")
        if rosters_data:
            roster_rows = extract_roster_snapshot(rosters_data, cfg.season)
            loaded = load_roster_snapshot(conn, roster_rows)
            match = loaded == roster_player_count
            status = "MATCH" if match else "MISMATCH"
            print(f"  extracted: {len(roster_rows)}, loaded: {loaded}, "
                  f"expected: {roster_player_count} [{status}]")
            if not match:
                sanity_ok = False
        else:
            print("  SKIPPED (no rosters data)")
            sanity_ok = False

        # --- DB row count verification ---
        print()
        print("DB row count verification...")
        cur = conn.cursor()

        cur.execute("SELECT COUNT(*) FROM dim_franchise")
        db_franchise = cur.fetchone()[0]
        print(f"  dim_franchise:   {db_franchise} rows")

        cur.execute("SELECT COUNT(*) FROM dim_player")
        db_player = cur.fetchone()[0]
        print(f"  dim_player:      {db_player} rows")

        cur.execute(
            "SELECT COUNT(*) FROM roster_snapshot WHERE nfl_season = ?",
            (cfg.season,),
        )
        db_roster = cur.fetchone()[0]
        print(f"  roster_snapshot: {db_roster} rows (season={cfg.season})")

        print()
        if sanity_ok:
            print("Phase 1 SANITY CHECK: PASSED")
            print("  dim_franchise count == league franchise count")
            print("  dim_player count == players export count")
            print("  roster_snapshot count == roster export count")
        else:
            print("Phase 1 SANITY CHECK: FAILED — see mismatches above")

    # --- Summary ---
    print()
    print("=" * 60)
    print(f"{phase_label} Summary")
    print("=" * 60)
    for pull_type, info in results.items():
        count = info["row_count"] or 0
        status = "OK" if info["data"] is not None else "FAILED"
        print(f"  {pull_type:15s}  {count:>6} {info['label']:20s}  [{status}]")

    failed = [k for k, v in results.items() if v["data"] is None]
    if failed:
        print()
        print(f"WARNING: {len(failed)} pull(s) returned no data: {', '.join(failed)}")
        sys.exit(1)

    print()
    print(f"{phase_label} complete.")

    conn.close()


# ---------------------------------------------------------------------------
# Phase 2 — Contract Parsing (no API calls)
# ---------------------------------------------------------------------------

def run_phase2(cfg) -> None:
    """
    Phase 2: Parse contract_info_raw from roster_snapshot into
    roster_snapshot_parsed.

    Reads ONLY from roster_snapshot for cfg.season.
    Writes ONLY to roster_snapshot_parsed (INSERT OR REPLACE).
    NO API calls.
    """
    print("=" * 60)
    print("Phase 2 — Contract Parsing (Step 1 Derived Fields)")
    print("=" * 60)

    # Explicit DB path check (same safety as Phase 1)
    db_path_from_env = os.environ.get("MFL_DB_PATH", "").strip()
    if not db_path_from_env:
        confirm_env = os.environ.get("MFL_CONFIRM_FALLBACK_DB", "").strip().lower()
        if confirm_env != "yes":
            print("SAFETY STOP: MFL_DB_PATH is not set. Writes would go to fallback DB:")
            print(f"  {cfg.db_path}")
            print()
            print("To proceed, either:")
            print("  1) Set MFL_DB_PATH explicitly, or")
            print("  2) Set MFL_CONFIRM_FALLBACK_DB=yes to acknowledge the fallback path.")
            sys.exit(1)

    conn = get_db_conn(cfg)

    # Run migrations (idempotent — ensures roster_snapshot_parsed exists)
    print("Running schema migrations...")
    run_migrations(conn)
    print()

    # Read source rows from roster_snapshot
    cur = conn.cursor()
    cur.execute(
        """
        SELECT nfl_season, franchise_id, player_id,
               contract_status, contract_year, salary, contract_info_raw
        FROM roster_snapshot
        WHERE nfl_season = ?
        """,
        (cfg.season,),
    )
    source_rows = cur.fetchall()
    source_count = len(source_rows)
    print(f"Source: roster_snapshot has {source_count} rows for season={cfg.season}")

    if source_count == 0:
        print("ERROR: No rows in roster_snapshot for this season.")
        print("       Run --phase1 first to populate roster_snapshot.")
        conn.close()
        sys.exit(1)

    # Parse each row
    parsed_rows = []
    warn_count = 0

    for row in source_rows:
        nfl_season, franchise_id, player_id, contract_status, contract_year, salary, contract_info_raw = row

        result = parse_contract_info(contract_info_raw, salary, contract_year)

        # Build warnings string (NULL if no warnings)
        warnings_str = None
        if result["parse_warnings"]:
            warnings_str = "; ".join(result["parse_warnings"])
            warn_count += 1

        parsed_rows.append((
            nfl_season,
            franchise_id,
            player_id,
            contract_status,
            contract_year,
            salary,
            contract_info_raw,
            result["contract_length"],
            result["total_contract_value"],
            result["aav_current"],
            result["aav_future"],
            json.dumps(result["year_salary_breakdown"]),
            json.dumps(result["extension_history"]),
            result["contract_guarantee"],
            1 if result["no_extension_flag"] else 0,
            warnings_str,
        ))

    # Load into roster_snapshot_parsed
    print(f"Parsed {len(parsed_rows)} rows. Loading into roster_snapshot_parsed...")
    loaded = load_roster_snapshot_parsed(conn, parsed_rows)
    print(f"  Loaded: {loaded} rows")
    print()

    # Sync no_extension_flag from extension_blocks (source of truth)
    print("Syncing no_extension_flag from extension_blocks...")
    cur.execute(
        """
        UPDATE roster_snapshot_parsed
        SET no_extension_flag = CASE
          WHEN EXISTS (
            SELECT 1
            FROM extension_blocks b
            WHERE b.nfl_season = roster_snapshot_parsed.nfl_season
              AND b.player_id  = roster_snapshot_parsed.player_id
              AND b.block_type = 'NO_EXTENSION'
              AND b.active = 1
          ) THEN 1 ELSE 0 END
        WHERE nfl_season = ?
        """,
        (cfg.season,),
    )
    conn.commit()
    print("  Sync complete.")
    print()

    # --- Sanity checks ---
    print("=" * 60)
    print("Phase 2 — Sanity Checks")
    print("=" * 60)

    # Row count match
    cur.execute(
        "SELECT COUNT(*) FROM roster_snapshot_parsed WHERE nfl_season = ?",
        (cfg.season,),
    )
    db_parsed_count = cur.fetchone()[0]
    count_match = db_parsed_count == source_count
    print(f"  roster_snapshot:        {source_count} rows")
    print(f"  roster_snapshot_parsed: {db_parsed_count} rows")
    print(f"  Count match:           {'PASS' if count_match else 'FAIL'}")
    print(f"  Rows with warnings:    {warn_count}")
    print()

    # extension_blocks parity check (spec lock)
    cur.execute(
        """
        SELECT COUNT(*) AS blocked_count
        FROM extension_blocks
        WHERE nfl_season = ?
          AND block_type = 'NO_EXTENSION'
          AND active = 1
        """,
        (cfg.season,),
    )
    blocked_count = cur.fetchone()[0]

    cur.execute(
        """
        SELECT COUNT(*) AS parsed_flagged_count
        FROM roster_snapshot_parsed
        WHERE nfl_season = ?
          AND no_extension_flag = 1
        """,
        (cfg.season,),
    )
    parsed_flagged_count = cur.fetchone()[0]

    blocks_match = parsed_flagged_count == blocked_count
    print(f"  extension_blocks (active NO_EXTENSION): {blocked_count}")
    print(f"  parsed no_extension_flag=1 count:       {parsed_flagged_count}")
    print(f"  Block parity check:                     {'PASS' if blocks_match else 'FAIL'}")
    print()

    # Sample rows (5)
    print("=" * 60)
    print("Phase 2 — Sample Parsed Rows (5)")
    print("=" * 60)
    cur.execute(
        """
        SELECT rsp.player_id,
               dp.player_name,
               rsp.contract_info_raw,
               rsp.contract_length,
               rsp.contract_year,
               rsp.salary,
               rsp.total_contract_value,
               rsp.aav_current,
               rsp.aav_future,
               rsp.year_salary_breakdown_json,
               rsp.extension_history_json,
               rsp.no_extension_flag,
               rsp.parse_warnings
        FROM roster_snapshot_parsed rsp
        LEFT JOIN dim_player dp ON rsp.player_id = dp.player_id
        WHERE rsp.nfl_season = ?
          AND rsp.contract_info_raw IS NOT NULL
          AND rsp.contract_info_raw != ''
        ORDER BY rsp.salary DESC
        LIMIT 5
        """,
        (cfg.season,),
    )
    samples = cur.fetchall()
    for i, s in enumerate(samples, 1):
        (pid, pname, ci_raw, cl, cy, sal, tcv,
         aav_c, aav_f, ybd_json, eh_json, nef, pw) = s
        print(f"  [{i}] {pname or pid} (id={pid})")
        print(f"      contract_info_raw : {ci_raw[:80]}{'...' if ci_raw and len(ci_raw) > 80 else ''}")
        print(f"      contract_length   : {cl}")
        print(f"      contract_year     : {cy}")
        print(f"      salary            : {sal}")
        print(f"      TCV               : {tcv}")
        print(f"      AAV current/future: {aav_c} / {aav_f}")
        print(f"      year_breakdown    : {ybd_json}")
        print(f"      ext_history       : {eh_json}")
        print(f"      no_extension_flag : {nef}")
        if pw:
            print(f"      WARNINGS          : {pw}")
        print()

    # Final status
    if count_match and blocks_match:
        print("Phase 2 SANITY CHECK: PASSED")
    else:
        print("Phase 2 SANITY CHECK: FAILED — one or more checks failed")

    conn.close()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    )

    parser = argparse.ArgumentParser(
        description="UPS Extension Pipeline"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Fetch and report only; do not store to DB.",
    )
    parser.add_argument(
        "--store",
        action="store_true",
        default=False,
        help="Fetch AND store raw payloads to ext_raw_payloads table.",
    )
    parser.add_argument(
        "--phase1",
        action="store_true",
        default=False,
        help="Phase 1: store raw payloads + extract into dim tables + roster_snapshot.",
    )
    parser.add_argument(
        "--phase2",
        action="store_true",
        default=False,
        help="Phase 2: parse contract_info_raw -> roster_snapshot_parsed (no API calls).",
    )
    args = parser.parse_args()

    # Determine mode: phase2 > phase1 > store > dry-run (default)
    if args.phase2:
        cfg = load_ext_config()
        print(f"  League ID : {cfg.league_id}")
        print(f"  Season    : {cfg.season}")
        print(f"  Server    : {cfg.server or '(not resolved)'}")
        print(f"  DB Path   : {cfg.db_path}")
        print()
        run_phase2(cfg)
    elif args.phase1:
        run_pipeline(dry_run=False, phase1=True)
    elif args.store:
        run_pipeline(dry_run=False, phase1=False)
    elif args.dry_run:
        run_pipeline(dry_run=True, phase1=False)
    else:
        # Default: dry-run
        run_pipeline(dry_run=True, phase1=False)


if __name__ == "__main__":
    main()
