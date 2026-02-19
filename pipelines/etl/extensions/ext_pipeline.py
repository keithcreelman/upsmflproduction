#!/usr/bin/env python3
"""
ext_pipeline.py — Extension module dry-run entrypoint (Phase 0).

Usage:
    MFL_LEAGUE_ID=74598 MFL_SEASON=2026 python ext_pipeline.py [--dry-run]

What it does:
    1. Loads config (league_id, season, server from DB — never hard-coded).
    2. Runs schema migrations (idempotent).
    3. Fetches raw JSON from MFL: TYPE=league, TYPE=players, TYPE=rosters.
    4. Stores raw payloads in ext_raw_payloads table.
    5. Prints row counts for sanity checking.

Flags:
    --dry-run   Fetch and report row counts but do NOT store to DB.
                (Default behavior for Phase 0 safety.)
"""
from __future__ import annotations

import argparse
import json
import logging
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
from ext_http import (  # noqa: E402
    fetch_league_json,
    fetch_players_json,
    fetch_rosters_json,
    fetch_transactions_json,
)
from ext_time import now_et, format_datetime_et  # noqa: E402

logger = logging.getLogger("ext_pipeline")


# ---------------------------------------------------------------------------
# Row-count extraction helpers
# ---------------------------------------------------------------------------

def _count_franchises(data: dict | None) -> int | None:
    """Count franchise entries in TYPE=league response."""
    if not data:
        return None
    try:
        franchises = data["league"]["franchises"]["franchise"]
        if isinstance(franchises, list):
            return len(franchises)
        return 1  # single franchise (unlikely but safe)
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

def run_pipeline(dry_run: bool = True) -> None:
    """Execute the Phase 0 dry-run pipeline."""

    # --- Config ---
    print("=" * 60)
    print("UPS Extension Pipeline — Phase 0")
    print("=" * 60)

    cfg = load_ext_config()
    print(f"  League ID : {cfg.league_id}")
    print(f"  Season    : {cfg.season}")
    print(f"  Server    : {cfg.server or '(not resolved — check league_years table)'}")
    print(f"  DB Path   : {cfg.db_path}")
    print(f"  Timezone  : {cfg.timezone}")
    print(f"  Dry Run   : {dry_run}")
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

    # --- Store raw payloads (unless dry-run) ---
    if dry_run:
        print("DRY RUN: Skipping raw payload storage.")
    else:
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

    # --- Summary ---
    print()
    print("=" * 60)
    print("Phase 0 Summary")
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
    print("Phase 0 complete. All pulls returned data.")

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
        description="UPS Extension Pipeline — Phase 0 (dry-run)"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=True,
        help="Fetch and report only; do not store to DB (default).",
    )
    parser.add_argument(
        "--store",
        action="store_true",
        default=False,
        help="Fetch AND store raw payloads to ext_raw_payloads table.",
    )
    args = parser.parse_args()

    # --store overrides --dry-run
    dry_run = not args.store

    run_pipeline(dry_run=dry_run)


if __name__ == "__main__":
    main()
