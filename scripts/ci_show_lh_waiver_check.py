#!/usr/bin/env python3
"""Long Haulers (fid 0006) waiver-claim diagnostic, 2026-08-13. Read-only.

Keith: LH says he submitted a waiver claim today; nothing shows on MFL.
Prints (a) MFL's pendingWaivers export as read by the commish session — full
league visibility, so any currently-queued claim for ANY franchise shows up,
(b) every transaction for fid 0006 in the last 10 days, and (c) fid 0006's
current roster, so a claimed target's presence/absence can be cross-checked.

Never prints the cookie. Usage: ci_show_lh_waiver_check.py <pending.json> <tx.json> <roster.json>
"""
import json
import sys
from datetime import datetime, timezone, timedelta

ET = timezone(timedelta(hours=-4))
LH_FID = "0006"


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except Exception as exc:  # noqa: BLE001
        print(f"  !! could not read {path}: {exc}")
        return None
    try:
        return json.loads(raw)
    except Exception:  # noqa: BLE001
        print(f"  !! {path} is not JSON. First 400 chars:")
        print("  " + raw[:400].replace("\n", "\n  "))
        return None


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def stamp(ts):
    try:
        n = int(str(ts).strip())
    except Exception:  # noqa: BLE001
        return f"(unparsable {ts!r})"
    dt = datetime.fromtimestamp(n, tz=timezone.utc)
    return f"{n}  ET={dt.astimezone(ET).strftime('%Y-%m-%d %H:%M:%S %a')}"


print("=" * 78)
print("PENDING WAIVERS (commish session — should show ALL franchises' queued claims)")
print("=" * 78)
pending = load(sys.argv[1] if len(sys.argv) > 1 else "/tmp/pending.json")
if pending is not None:
    print(json.dumps(pending, indent=1)[:4000])
    blob = json.dumps(pending)
    print()
    print(f'contains "0006"? {"0006" in blob}')
    print(f'raw pendingWaivers block empty? {pending == {"pendingWaivers": {}} or pending.get("pendingWaivers") in (None, {}, "")}')

print()
print("=" * 78)
print(f"ALL TRANSACTIONS FOR FRANCHISE {LH_FID}, last 10 days")
print("=" * 78)
tx = load(sys.argv[2] if len(sys.argv) > 2 else "/tmp/tx.json")
if tx is not None:
    txs = as_list((tx.get("transactions") or {}).get("transaction"))
    lh_txs = [t for t in txs if str(t.get("franchise", "")).strip() == LH_FID]
    print(f"total transactions league-wide (10 days): {len(txs)}")
    print(f"transactions for {LH_FID}: {len(lh_txs)}")
    for t in sorted(lh_txs, key=lambda t: int(t.get("timestamp", 0) or 0)):
        print(f"  {stamp(t.get('timestamp'))}  type={t.get('type')}  transaction={t.get('transaction')!r}")
    if not lh_txs:
        print("  (none)")
    print()
    print("For comparison — every BBID_WAIVER award league-wide today, all franchises:")
    for t in txs:
        if str(t.get("type", "")).upper() == "BBID_WAIVER":
            print(f"  {stamp(t.get('timestamp'))}  franchise={t.get('franchise')}  transaction={t.get('transaction')!r}")

print()
print("=" * 78)
print(f"CURRENT ROSTER, franchise {LH_FID}")
print("=" * 78)
roster = load(sys.argv[3] if len(sys.argv) > 3 else "/tmp/roster_0006.json")
if roster is not None:
    fr = ((roster.get("rosters") or {}).get("franchise"))
    frs = as_list(fr)
    if frs:
        players = as_list((frs[0] or {}).get("player"))
        print(f"roster size: {len(players)}")
        for p in players[:60]:
            print(f"  pid={p.get('id')}  status={p.get('status')}  salary={p.get('salary')}  contractStatus={p.get('contractStatus')}")
    else:
        print("  (no franchise block found)")
