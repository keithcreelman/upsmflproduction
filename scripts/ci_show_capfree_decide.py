#!/usr/bin/env python3
"""Render a capfree-decide DRY RUN. Writes nothing; never prints the key."""
import json, sys
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/dec.json"))
def usd(v):
    if v is None: return "—"
    return ("-$" if v < 0 else "$") + f"{abs(int(v)):,}"
if not d.get("ok"):
    print("REFUSED:", d.get("error"))
    print(" ", d.get("message", ""))
    raise SystemExit(0)
print(f"{d.get('player_name')}  ({d.get('franchise')})")
print(f"decision tested : {d.get('decision')}   dry_run={d.get('dry_run')}")
print()
print(f"  §D1 penalty as computed today : {usd(d.get('penalty_before'))}")
print(f"  amount after this decision    : {usd(d.get('penalty_after'))}")
print(f"  basis after                   : {d.get('basis_after')}")
print(f"  direction                     : {d.get('settlement_direction')}")
s = d.get("d2a") or {}
print()
if s.get("known"):
    print(f"  §D2a: AAV {usd(s.get('aav'))} × {s.get('years_served')} served = {usd(s.get('owed_for_service'))}")
    print(f"        minus actually paid {usd(s.get('actually_paid'))}")
    print(f"        = {usd(s.get('settlement'))}")
else:
    print(f"  §D2a UNAVAILABLE: {s.get('reason')}")
before, after = d.get("penalty_before"), d.get("penalty_after")
if before is not None and after is not None:
    print()
    print(f"  SWING vs today: {usd(after - before)}")
print()
print(" ", d.get("message", ""))
