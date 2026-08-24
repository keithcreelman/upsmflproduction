#!/usr/bin/env python3
"""Do the Aug 15 waiver adds carry a thread, or only a parent?

discord_message_id  = the message written INTO the thread (the move card)
discord_parent_message_id = the summary card in the channel
A row with a parent but NO message id means the parent posted and the thread
content never did. Both present means the thread exists and Discord's UI is
simply not showing it where we looked.
"""
import json, sys
raw = open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/adds.json").read()
i = raw.find("[")
try:
    data = json.loads(raw[i:])
except Exception as e:
    print("!! could not parse:", e); print(raw[:900]); raise SystemExit(1)
rows = []
for blk in (data if isinstance(data, list) else [data]):
    rows += (blk or {}).get("results", []) or []
print(f"rows since 2026-08-12: {len(rows)}\n")
hdr = f"{'DATE':<12}{'FRANCHISE':<20}{'PLAYER':<22}{'posted':<8}{'msg_id':<22}{'parent_id':<22}"
print(hdr); print("-" * len(hdr))
for r in rows:
    d = str(r.get("added_at_iso") or "")[:10]
    print(f"{d:<12}{str(r.get('franchise_name'))[:19]:<20}{str(r.get('player_name'))[:21]:<22}"
          f"{str(r.get('discord_posted')):<8}{str(r.get('discord_message_id') or '—'):<22}"
          f"{str(r.get('discord_parent_message_id') or '—'):<22}")
print()
by = {}
for r in rows:
    d = str(r.get("added_at_iso") or "")[:10]
    m = bool(r.get("discord_message_id")); p = bool(r.get("discord_parent_message_id"))
    a, b, c = by.get(d, (0, 0, 0))
    by[d] = (a + 1, b + (1 if m else 0), c + (1 if p else 0))
print(f"{'DATE':<12}{'rows':<7}{'with msg (thread)':<20}{'with parent'}")
for d in sorted(by):
    n, m, p = by[d]
    print(f"{d:<12}{n:<7}{m:<20}{p}")
