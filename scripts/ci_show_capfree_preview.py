#!/usr/bin/env python3
"""Render /admin/drops/capfree-preview. Read-only; never prints the API key."""
import json, sys

d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/cf.json"))
if not d.get("ok"):
    print("ROUTE ERROR:", json.dumps(d)[:600]); raise SystemExit(1)

def usd(v):
    if v is None: return "—"
    return ("-$" if v < 0 else "$") + f"{abs(int(v)):,}"

print("season", d.get("season"), "league", d.get("league_id"), "| DRY RUN:", d.get("dry_run"))
inj = d.get("injuries_feed") or {}
print(f"injuries feed: known={inj.get('known')} rows={inj.get('rows_seen')} {inj.get('error') or ''}")
c = d.get("counts") or {}
print()
print("ROUTING:", " ".join(f"{k.replace('route_','')}={v}" for k, v in c.items() if k.startswith("route_")))
print(f"rows examined: {c.get('rows_examined')}   would be HELD from charge cron: {c.get('would_be_held')}")
print(f"D2a unreadable on a cap-free row: {c.get('d2a_unreadable')}   rows whose money changes: {c.get('money_changes')}")
print(f"TOTAL MONEY DELTA: {usd(d.get('money_delta_total'))}")
print()

rows = d.get("rows") or []
interesting = [r for r in rows if r.get("route") in ("auto", "pending", "unknown")] or rows[:12]
hdr = f"{'PLAYER':<24}{'POS':<5}{'FRANCHISE':<20}{'NFL':<12}{'ROUTE':<9}{'TODAY':>11}{'WOULD':>11}{'DELTA':>11}"
print(hdr); print("-" * len(hdr))
for r in interesting:
    t = r.get("today") or {}; w = r.get("would") or {}
    print(f"{str(r.get('player_name'))[:23]:<24}{str(r.get('position') or '?'):<5}"
          f"{str(r.get('franchise'))[:19]:<20}{str(r.get('nfl_designation'))[:11]:<12}"
          f"{str(r.get('route')):<9}{usd(t.get('penalty_amount')):>11}"
          f"{usd(w.get('charge')):>11}{usd(r.get('delta')):>11}")

for r in rows:
    if r.get("route") in ("auto", "pending", "unknown"):
        print()
        print("=" * 78)
        print(f"{r.get('player_name')} — route={r.get('route')}  basis would be: {(r.get('would') or {}).get('basis')}")
        d2 = (r.get("would") or {}).get("d2a") or {}
        if d2.get("known"):
            print(f"  D2a: AAV {usd(d2.get('aav'))} x {d2.get('years_served')} served = {usd(d2.get('owed_for_service'))}"
                  f"  minus paid {usd(d2.get('actually_paid'))}  ->  {usd(d2.get('settlement'))}")
        else:
            print(f"  D2a BLOCKED: {d2.get('reason')}")
        ev = r.get("evidence") or {}
        for s in (ev.get("sources") or []):
            print(f"  [{s.get('source')}] {str(s.get('headline'))[:78]}")
            if s.get("url"): print(f"      {s.get('url')}")
        if ev and not (ev.get("sources") or []):
            print(f"  (no retirement language found; sources_known={ev.get('sources_known')} {ev.get('sources_error') or ''})")
