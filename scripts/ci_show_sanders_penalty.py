#!/usr/bin/env python3
"""Print any drop_events row for Jatavian Sanders. Read-only."""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/sanders.json"

with open(path, encoding="utf-8") as fh:
    payload = json.load(fh)

rows = (payload[0].get("results") or []) if payload else []
print(f"{len(rows)} row(s) found\n")
for r in rows:
    print(json.dumps(r, indent=2))
    print()
