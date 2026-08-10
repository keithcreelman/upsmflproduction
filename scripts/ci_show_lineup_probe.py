#!/usr/bin/env python3
"""Print the /admin/lineup-probe response. Read-only diagnostic.

Lives in a file, NOT inline in the workflow. Nesting Python inside a YAML
`run:` block has now broken four workflows in this repo (2026-08-08 x3,
2026-08-10). The quoting has too many layers to survive. Stop doing it.

Usage: ci_show_lineup_probe.py <probe-json>
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/probe.json"

try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"::error::could not read the probe response: {exc}")
    sys.exit(1)

for key in ("ok", "fid", "week_requested", "roster_player_count",
            "mfl_status", "raw_len", "error", "roster_ok"):
    if key in payload:
        print(f"{key} = {payload[key]}")

print()
print("--- RAW HEAD ---")
print((payload.get("raw_head") or "")[:5000])
