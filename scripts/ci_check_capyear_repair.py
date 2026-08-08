#!/usr/bin/env python3
"""Confirm the MFL half of the cap-year repair is genuinely done. Read-only.

Refuses on an unreadable feed rather than reporting "clean" — a failed read and
an absent row must never look the same when the answer gates a D1 write.
"""
import json
import sys

TARGETS = {
    "17254_1786195613": "Konata Mumpfield",
    "17205_1786195656": "KeAndre Lambert-Smith",
}

path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/adj.json"
try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"::error::could not parse salaryAdjustments: {exc}")
    sys.exit(1)

rows = (payload.get("salaryAdjustments") or {}).get("salaryAdjustment") or []
if isinstance(rows, dict):
    rows = [rows]

# An unreadable/short feed is NOT an empty one. 56 rows is the known-good count;
# anything far below that means the export failed, not that the league is clean.
if len(rows) < 20:
    print(f"::error::salaryAdjustments returned only {len(rows)} rows — unreadable, not empty. Refusing.")
    sys.exit(1)

print(f"  {len(rows)} adjustment row(s) on the 2026 cap")

still_there = []
for key, name in TARGETS.items():
    hits = [r for r in rows if key in str(r.get("description") or "")]
    state = "STILL PRESENT" if hits else "deleted"
    print(f"  {name:<24} {key}  {state}")
    if hits:
        still_there.append(f"{name} ({key})")

reversals = [r for r in rows if "ups_drop_capyear_fix" in str(r.get("description") or "")]
if reversals:
    print(f"::error::found {len(reversals)} offsetting reversal row(s) — option B was a hand-delete, so there should be none")
    sys.exit(1)

if still_there:
    print("::error::MFL still holds: " + ", ".join(still_there) + " — do not run the ledger step yet")
    sys.exit(1)

lh = [r for r in rows if str(r.get("franchise_id")) == "0006"]
total = sum(float(r.get("amount") or 0) for r in lh)
print(f"  fid 0006 The Long Haulers: {len(lh)} row(s), total ${total:,.0f}  (expected -15,000)")
print("  MFL half verified — safe to move the D1 ledger to 2027")
