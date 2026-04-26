#!/usr/bin/env python3
"""Parse metadata_rawrules JSON → mfl_scoring_rules in D1.

Each season's TYPE=rules export is a JSON of `positionRules[]` blocks. Each
block applies a list of `rule[]` items to a `positions` group (pipe-delim
position list, e.g., "QB|RB|WR|TE"). Each rule has event/range/points.

This script flattens those rules into one row per (season, position_group,
rule_index) and pushes to D1 so the worker can query scoring history.

Source: local mfl_database.db metadata_rawrules
Target: D1 mfl_scoring_rules

Usage:
  python3 pipelines/etl/scripts/sync_scoring_rules.py [--seasons 2010-2025]
"""
from __future__ import annotations
import argparse
import json
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)


def parse_seasons(spec: str | None) -> list[int] | None:
    if not spec:
        return None
    out = set()
    for piece in spec.split(","):
        piece = piece.strip()
        if not piece:
            continue
        if "-" in piece:
            a, b = piece.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(piece))
    return sorted(out)


def extract_rules(season: int, raw_json: str) -> list[tuple]:
    """Flatten one season's JSON into [(season, positions, idx, event, range, points), ...]."""
    data = json.loads(raw_json)
    blocks = data.get("rules", {}).get("positionRules", [])
    if isinstance(blocks, dict):
        blocks = [blocks]

    rows = []
    for block in blocks:
        positions = block.get("positions", "?")
        rules = block.get("rule", [])
        if isinstance(rules, dict):
            rules = [rules]
        for idx, r in enumerate(rules):
            event = r.get("event", {}).get("$t", "")
            rng   = r.get("range", {}).get("$t", "")
            pts   = r.get("points", {}).get("$t", "")
            rows.append((season, positions, idx, event, rng, pts))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", default=None,
                    help="Season filter (e.g., '2010-2025'); default = all")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}\n"
                 f"(set MFL_DB_PATH env var if DB lives elsewhere)")

    db = sqlite3.connect(str(LOCAL_DB), timeout=30)
    seasons = parse_seasons(args.seasons)

    if seasons:
        ph = ",".join("?" for _ in seasons)
        cur = db.execute(
            f"SELECT season, raw_json FROM metadata_rawrules WHERE season IN ({ph})",
            seasons,
        )
    else:
        cur = db.execute("SELECT season, raw_json FROM metadata_rawrules ORDER BY season")

    all_rows = []
    for season, raw in cur:
        rows = extract_rules(int(season), raw)
        all_rows.extend(rows)
        print(f"  {season}: {len(rows)} rules", file=sys.stderr)

    print(f"Total: {len(all_rows)} rule rows across "
          f"{len(set(r[0] for r in all_rows))} seasons", file=sys.stderr)

    if args.skip_d1:
        print("DONE: --skip-d1 set", file=sys.stderr)
        return

    print(f"Pushing to D1 mfl_scoring_rules...", file=sys.stderr)
    with D1Writer(
        table="mfl_scoring_rules",
        cols=["season", "position_group", "rule_index", "event_code", "range_raw", "points_raw"],
        pk_cols=["season", "position_group", "rule_index"],
    ) as w:
        for r in all_rows:
            w.add(r)

    print("DONE: D1 sync complete", file=sys.stderr)


if __name__ == "__main__":
    main()
