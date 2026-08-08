#!/usr/bin/env python3
"""Print flags_readable and the two FA-report flag values from a health-summary
response. Read-only diagnostic.

Lives in a file rather than inline in the workflow because nesting Python
inside a YAML `run:` block inside a shell heredoc has broken three separate
workflows on 2026-08-08. Stop doing that.

Usage: ci_check_health_summary.py <health-summary-json>
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/hs.json"

try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"::error::could not read the health-summary response: {exc}")
    sys.exit(1)

print("flags_readable:", payload.get("flags_readable"))

by_key = {}
for row in payload.get("flags") or []:
    if isinstance(row, dict) and row.get("key"):
        by_key[str(row["key"])] = row

for key in ("AUCTION_NIGHTLY_NUDGE_ENABLED", "AUCTION_FAA_ENABLED"):
    row = by_key.get(key, {})
    print(f"  {key}: value={row.get('value')} unknown={row.get('unknown')}")
