#!/usr/bin/env python3
"""Snapshot live MFL state for the 2026 auction bid sheet (Layer 1).

Pulls 8 MFL endpoints into one timestamped JSON snapshot:
  rosters, salaries, salaryAdjustments, transactions,
  freeAgents, futureDraftPicks, league, rules

Read-only on prod league 74598; writes go nowhere — snapshots are local
JSON only, by design (Layer 7 UI reads them).

Run:
  python3 pipelines/etl/scripts/snapshot_mfl_state.py
  python3 pipelines/etl/scripts/snapshot_mfl_state.py --league-id 25625  # test league
  python3 pipelines/etl/scripts/snapshot_mfl_state.py --mode auction
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import date
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent  # pipelines/etl
sys.path.insert(0, str(SCRIPT_DIR))  # for sibling mfl_api
sys.path.insert(0, str(ETL_ROOT))  # for lib.state_store

from mfl_api import APIKEY, build_export_url, fetch_json  # noqa: E402
from lib.state_store import StateSnapshot, now_iso_utc  # noqa: E402

logger = logging.getLogger(__name__)

# Per memory `site_audit_governance.md`: tier-2 test league = 25625@www48
# Prod league = 74598@www48 (read-only)
DEFAULT_LEAGUE_ID = "74598"
DEFAULT_SERVER = "48"

# Endpoints that REJECT APIKEY (older leagues): TYPE=league, TYPE=rules
# (mirrors get_metadata_rawjson() in mfl_api.py)
NO_APIKEY_TYPES = {"league", "rules"}


def _fetch(server: str, season: int, params: dict) -> dict | None:
    if APIKEY and params.get("TYPE") not in NO_APIKEY_TYPES and "APIKEY" not in params:
        params["APIKEY"] = APIKEY
    url = build_export_url(server, season, params)
    return fetch_json(url)


def fetch_rosters(server, season, league_id):
    return _fetch(server, season, {"TYPE": "rosters", "L": league_id, "JSON": "1", "FRANCHISE": ""})


def fetch_salaries(server, season, league_id):
    return _fetch(server, season, {"TYPE": "salaries", "L": league_id, "JSON": "1"})


def fetch_salary_adjustments(server, season, league_id):
    return _fetch(server, season, {"TYPE": "salaryAdjustments", "L": league_id, "JSON": "1"})


def fetch_transactions(server, season, league_id):
    return _fetch(server, season, {"TYPE": "transactions", "L": league_id, "JSON": "1"})


def fetch_free_agents(server, season, league_id):
    return _fetch(server, season, {"TYPE": "freeAgents", "L": league_id, "JSON": "1"})


def fetch_future_draft_picks(server, season, league_id):
    return _fetch(server, season, {"TYPE": "futureDraftPicks", "L": league_id, "JSON": "1"})


def fetch_league_meta(server, season, league_id):
    return _fetch(server, season, {"TYPE": "league", "L": league_id, "JSON": "1"})


def fetch_rules(server, season, league_id):
    return _fetch(server, season, {"TYPE": "rules", "L": league_id, "JSON": "1"})


ENDPOINTS = (
    ("rosters", fetch_rosters),
    ("salaries", fetch_salaries),
    ("salary_adjustments", fetch_salary_adjustments),
    ("transactions", fetch_transactions),
    ("free_agents", fetch_free_agents),
    ("future_draft_picks", fetch_future_draft_picks),
    ("league_meta", fetch_league_meta),
    ("rules", fetch_rules),
)


def snapshot(server: str, season: int, league_id: str, mode: str) -> StateSnapshot:
    snap = StateSnapshot(
        league_id=league_id,
        season=season,
        server=server,
        timestamp_utc=now_iso_utc(),
        mode=mode,
    )
    for field_name, fn in ENDPOINTS:
        try:
            data = fn(server, season, league_id)
            if data is None:
                snap.fetch_errors.append(f"{field_name}: returned None")
            else:
                setattr(snap, field_name, data)
        except Exception as e:
            snap.fetch_errors.append(f"{field_name}: {type(e).__name__}: {e}")
            logger.exception("Endpoint %s failed", field_name)
    return snap


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-id", default=DEFAULT_LEAGUE_ID,
                    help=f"MFL league ID (default {DEFAULT_LEAGUE_ID} prod; use 25625 for test)")
    ap.add_argument("--server", default=DEFAULT_SERVER,
                    help="MFL server number (e.g. '48' for www48)")
    ap.add_argument("--season", type=int, default=date.today().year)
    ap.add_argument("--mode", choices=["auction", "idle"], default="idle")
    ap.add_argument("--output-dir", default=str(ETL_ROOT / "data" / "snapshots"))
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    snap = snapshot(args.server, args.season, args.league_id, args.mode)
    out_path = snap.save(Path(args.output_dir))

    populated = snap.populated_endpoints()
    n_errors = len(snap.fetch_errors)
    print(f"Saved snapshot to {out_path}")
    print(f"  Endpoints populated: {len(populated)}/{len(ENDPOINTS)} ({', '.join(populated)})")
    if n_errors:
        print(f"  Errors ({n_errors}):")
        for e in snap.fetch_errors:
            print(f"    - {e}")
    return 0 if n_errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
