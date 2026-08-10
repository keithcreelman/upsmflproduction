#!/usr/bin/env python3
"""Print the /admin/adds/stamp-ww-contracts dry-run response. Read-only."""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dryrun.json"

try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:
    print(f"::error::could not read the dry-run response: {exc}")
    sys.exit(1)

for key in ("ok", "dry_run", "transactions_seen", "written_count", "skipped_count"):
    if key in payload:
        print(f"{key} = {payload[key]}")

print()
print("--- WOULD WRITE ---")
for row in payload.get("written") or []:
    print(json.dumps(row))

print()
print("--- NEEDS INPUT (could not establish price) ---")
for row in payload.get("needs_input") or []:
    print(json.dumps(row))

print()
print("--- SKIPPED (already has a contract, or not eligible) ---")
for row in payload.get("skipped") or []:
    print(json.dumps(row))
