#!/usr/bin/env python3
"""Summarize MFL's pendingWaivers + BBID_WAIVER transaction log. Read-only.

Answers three questions that decide how the mobile Claims screen should
detect an already-processed waiver round:

  1. Does MFL's pendingWaivers export STILL return a round that has already
     been processed? (If yes, "MFL echoes stale rounds" is confirmed and a
     signature comparison against that export can never detect a run.)
  2. Does each pendingWaivers round carry a submission `timestamp`?
  3. Do BBID_WAIVER transactions cluster at run boundaries league-wide, so
     the transaction log can be used as a "a run happened at T" marker
     that works whether the owner won or LOST?

Never prints the cookie. Usage: ci_dump_waiver_logs.py <pending.json> <bbid.json>
"""
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta

ET = timezone(timedelta(hours=-4))  # EDT in August


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
    return f"{n}  {dt.isoformat()}  ET={dt.astimezone(ET).strftime('%Y-%m-%d %H:%M:%S %a')}"


print("=" * 78)
print("Q1/Q2 — pendingWaivers: does MFL still hold the processed round? timestamps?")
print("=" * 78)
pending = load(sys.argv[1] if len(sys.argv) > 1 else "/tmp/pending.json")
if pending is not None:
    print("RAW (first 2000 chars):")
    print("  " + json.dumps(pending)[:2000].replace("\n", "\n  "))
    print()
    root = (
        pending.get("pendingWaivers")
        or pending.get("pendingwaivers")
        or pending.get("pending_waivers")
    )
    if root is None:
        print("  -> NO pendingWaivers block present.")
    elif isinstance(root, dict) and not root:
        print("  -> pendingWaivers block is EMPTY {} — MFL is holding nothing.")
    else:
        rounds = as_list(root.get("blindBidWaiverRequest") or root.get("blindbidwaiverrequest"))
        if not rounds:
            print(f"  -> block present but no blindBidWaiverRequest. Keys: {list(root.keys())}")
        for r in rounds:
            if not isinstance(r, dict):
                continue
            print(f"  round={r.get('round')!r}")
            print(f"    addsDrops = {r.get('addsDrops') or r.get('addsdrops')!r}")
            ts = r.get("timestamp")
            print(f"    timestamp = {stamp(ts) if ts else '(ABSENT)'}")
            extra = {k: v for k, v in r.items() if k not in ("round", "addsDrops", "addsdrops", "timestamp")}
            if extra:
                print(f"    other fields = {extra}")

print()
print("=" * 78)
print("Q3 — BBID_WAIVER transaction log: do awards cluster at run boundaries?")
print("=" * 78)
bbid = load(sys.argv[2] if len(sys.argv) > 2 else "/tmp/bbid.json")
if bbid is not None:
    txs = as_list((bbid.get("transactions") or {}).get("transaction"))
    print(f"  {len(txs)} BBID_WAIVER transaction(s) returned")
    by_ts = defaultdict(list)
    for t in txs:
        if isinstance(t, dict):
            by_ts[str(t.get("timestamp"))].append(t)
    print(f"  {len(by_ts)} distinct timestamp(s) — each distinct value is a candidate run marker")
    print()
    for ts in sorted(by_ts, key=lambda s: int(s) if s.isdigit() else 0, reverse=True):
        group = by_ts[ts]
        print(f"  RUN? {stamp(ts)}   ({len(group)} award(s) league-wide)")
        for t in group[:12]:
            print(f"       franchise={t.get('franchise')!r}  transaction={t.get('transaction')!r}")
        if len(group) > 12:
            print(f"       ... and {len(group) - 12} more")
        print()
