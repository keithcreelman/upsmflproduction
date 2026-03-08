#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

from extension_lineage import build_extension_overlay, load_extension_lookup


def safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", required=True)
    parser.add_argument("--json-path", required=True)
    parser.add_argument("--season", type=int, default=0)
    args = parser.parse_args()

    json_path = Path(args.json_path)
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    eligibility = payload.get("eligibility") or []
    if not isinstance(eligibility, list):
        raise RuntimeError("Unexpected MYM dashboard shape: missing eligibility list")

    conn = sqlite3.connect(args.db_path)
    try:
        lookup_cache: Dict[int, Dict[str, Dict[str, str]]] = {}
        changed = 0
        touched = 0

        for row in eligibility:
            row_season = safe_int(row.get("season"), 0)
            if args.season and row_season != args.season:
                continue
            if row_season <= 0:
                continue
            if row_season not in lookup_cache:
                lookup_cache[row_season] = load_extension_lookup(conn, row_season)
            overlay = build_extension_overlay(row, lookup_cache[row_season])
            touched += 1
            for key, value in overlay.items():
                if row.get(key) != value:
                    row[key] = value
                    changed += 1

        meta = payload.get("meta") or {}
        meta["extension_overlay_refreshed_at_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        payload["meta"] = meta
        payload["eligibility"] = eligibility
        json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

        print(
            json.dumps(
                {
                    "json_path": str(json_path),
                    "rows_considered": touched,
                    "field_updates": changed,
                }
            )
        )
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
