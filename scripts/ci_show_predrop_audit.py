#!/usr/bin/env python3
"""Why is pre_drop_aav null on every 2026 drop row?"""
import json, sys
raw = open(sys.argv[1]).read(); i = raw.find("[")
data = json.loads(raw[i:])
rows = []
for b in (data if isinstance(data, list) else [data]):
    rows += (b or {}).get("results", []) or []
print(f"rows: {len(rows)}\n")
h = f"{'PLAYER':<22}{'BASIS':<28}{'taxi':<6}{'status':<16}{'CL':<4}{'cy':<4}{'TCV':>9}{'AAV':>9}{'earned':>9}  contract_info"
print(h); print("-"*len(h))
for r in rows:
    print(f"{str(r.get('player_name'))[:21]:<22}{str(r.get('penalty_basis'))[:27]:<28}"
          f"{str(r.get('pre_drop_taxi')):<6}{str(r.get('pre_drop_contract_status') or '—')[:15]:<16}"
          f"{str(r.get('pre_drop_contract_length') or '—'):<4}{str(r.get('pre_drop_contract_year') or '—'):<4}"
          f"{str(r.get('pre_drop_tcv') or '—'):>9}{str(r.get('pre_drop_aav') or '—'):>9}"
          f"{str(r.get('earned_to_date') or '—'):>9}  {str(r.get('ci') or '(none)')[:58]}")
n_ci = sum(1 for r in rows if r.get("ci"))
n_aav = sum(1 for r in rows if r.get("pre_drop_aav"))
n_taxi = sum(1 for r in rows if str(r.get("pre_drop_taxi")) == "1")
print()
print(f"with contract_info: {n_ci}/{len(rows)}   with AAV: {n_aav}/{len(rows)}   flagged taxi: {n_taxi}/{len(rows)}")
print("If contract_info is empty everywhere, the PRE-DROP SNAPSHOT LOOKUP is what failed —")
print("not the AAV parse. AAV/TCV/CL are all derived from that string.")
from collections import Counter
print("\nsnapshot_source:", Counter(str(r.get('snapshot_source')) for r in rows).most_common())
