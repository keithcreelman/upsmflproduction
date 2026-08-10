#!/usr/bin/env python3
"""Print the /admin/salary-row-probe response. Read-only."""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/salrow.json"

with open(path, encoding="utf-8") as fh:
    payload = json.load(fh)

print("ok =", payload.get("ok"))
print("pid =", payload.get("pid"))
print("roster_player_count =", payload.get("roster_player_count"))
print()
print("--- raw row ---")
print(json.dumps(payload.get("row"), indent=2))
