#!/usr/bin/env python3
"""Print the /admin/adds/stamp-ww-contracts dry-run response. Read-only.

Field names match finalizeWaiverContracts' REAL return shape (verified by
reading worker/src/index.js directly, not guessed): ok, dry_run, season,
league_id, count, rows[], needs_input_count, needs_input[], message.
Each row in rows[] carries: id, player_name, bid_k, before{...}, and the
proposed contractStatus/contractYear/contractInfo/salary to write.
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/dryrun.json"

try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:
    print(f"::error::could not read the dry-run response: {exc}")
    sys.exit(1)

for key in ("ok", "dry_run", "season", "league_id", "count",
            "needs_input_count", "message", "error"):
    if key in payload:
        print(f"{key} = {payload[key]}")

print()
print("--- WOULD WRITE (rows) ---")
for row in payload.get("rows") or []:
    print(json.dumps(row))

print()
print("--- NEEDS INPUT (price could not be established) ---")
for row in payload.get("needs_input") or []:
    print(json.dumps(row))
