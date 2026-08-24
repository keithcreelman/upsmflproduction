#!/usr/bin/env python3
"""Render the cap-free backfill audit. Read-only; never prints the key."""
import json, sys
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/bf.json"))
if not d.get("ok"):
    print("ERROR:", json.dumps(d)[:500]); raise SystemExit(1)
def usd(v):
    if v is None: return "—"
    return ("-$" if v < 0 else "$") + f"{abs(int(v)):,}"
print("AUDIT ONLY — nothing written.")
print("seasons on record:", ", ".join(f"{s['season']}({s['rows']})" for s in d.get("seasons_available", [])))
inj = d.get("injuries_feed") or {}
print(f"injuries feed: known={inj.get('known')} rows={inj.get('rows_seen')} {inj.get('error') or ''}")
print(f"rows examined: {d.get('rows_examined')}   retirees found: {d.get('retirees_found')}")
c = d.get("counts") or {}
print(f"correct={c.get('correct')}  OVERCHARGED={c.get('overcharged')}  UNDERCHARGED={c.get('undercharged')}  unpriceable={c.get('unpriceable')}")
m = d.get("dollars") or {}
print()
print(f"  owed back to owners : {usd(m.get('owed_back_to_owners'))}")
print(f"  still owed by owners: {usd(m.get('still_owed_by_owners'))}")
print(f"  net                 : {usd(m.get('net'))}")
f = d.get("findings") or []
if not f:
    print("\nNo retirees among the recorded drops — nothing to reprice.")
    raise SystemExit(0)
print()
h = f"{'SEASON':<8}{'PLAYER':<24}{'FRANCHISE':<20}{'CHARGED':>10}{'CORRECT':>11}{'DELTA':>11}  VERDICT"
print(h); print("-"*len(h))
for r in sorted(f, key=lambda x: abs(x.get("delta") or 0), reverse=True):
    print(f"{str(r.get('season')):<8}{str(r.get('player_name'))[:23]:<24}{str(r.get('franchise'))[:19]:<20}"
          f"{usd(r.get('charged')):>10}{usd(r.get('correct')):>11}{usd(r.get('delta')):>11}  {r.get('verdict')}")
    if r.get("verdict") == "UNPRICEABLE":
        print(f"         reason: {r.get('reason')}")
