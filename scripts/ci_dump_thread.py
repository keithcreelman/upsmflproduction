#!/usr/bin/env python3
"""Print what actually landed in a Discord thread. CI diagnostic, read-only.

Lives in a file rather than inline in the workflow because nesting Python inside
a YAML `run:` block inside a shell heredoc is exactly how the workflow got
corrupted on 2026-08-08 — three layers of quoting do not survive the trip.

Usage: ci_dump_thread.py <path-to-discord-messages-json>
"""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/msgs.json"

try:
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
except Exception as exc:  # noqa: BLE001 — diagnostic: surface anything
    print("  could not read/parse the Discord response: %s" % exc)
    sys.exit(0)

# Discord returns a LIST on success and an OBJECT on error. Never let an error
# object fall through as "no messages" — in a diagnostic, "the thread is empty"
# and "the request failed" must not look the same.
if isinstance(data, dict):
    print("  DISCORD ERROR: " + json.dumps(data)[:400])
    sys.exit(0)

if not isinstance(data, list):
    print("  unexpected response shape: %s" % type(data).__name__)
    sys.exit(0)

print("  %d message(s) in thread" % len(data))
for msg in reversed(data):  # Discord returns newest-first; read oldest-first
    embeds = msg.get("embeds") or []
    first = embeds[0] if embeds else {}
    if first.get("image"):
        kind = "GIF"
    elif embeds:
        kind = "embed"
    else:
        kind = "text"
    body = (msg.get("content") or "").replace("\n", " | ").strip()
    if not body and embeds:
        body = (first.get("title") or first.get("description") or "").replace("\n", " | ").strip()
    print("   [%-5s] %s" % (kind, body[:170]))
