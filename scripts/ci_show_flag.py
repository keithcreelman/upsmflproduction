#!/usr/bin/env python3
"""Print one feature flag's effective value from /admin/commish-settings. Read-only.

Lives in a file rather than inline in the workflow because nesting Python inside
a YAML `run:` block inside a shell heredoc is how two workflows got corrupted on
2026-08-08. The quoting has too many layers to survive; stop doing it.

Usage: ci_show_flag.py <settings-json> <FLAG_KEY>
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/flags.json"
want = sys.argv[2] if len(sys.argv) > 2 else ""

try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"::error::could not read the settings response: {exc}")
    sys.exit(1)

flags = payload.get("flags") or payload.get("feature_flags") or []
if isinstance(flags, dict):
    flags = [{"key": k, "value": v} for k, v in flags.items()]
if not isinstance(flags, list) or not flags:
    # A response we cannot read is NOT "the flag is off" — say so rather than
    # letting a failed read look like a confirmed disarm.
    print(f"::error::no flags in the response — cannot confirm {want} state")
    sys.exit(1)

for entry in flags:
    if not isinstance(entry, dict):
        continue
    if want and want not in str(entry.get("key", "")):
        continue
    print(f"  {entry.get('key')} = {entry.get('value')}  (source: {entry.get('source', '?')})")
    if want:
        break
else:
    print(f"::error::{want} not present in the response — cannot confirm its state")
    sys.exit(1)
