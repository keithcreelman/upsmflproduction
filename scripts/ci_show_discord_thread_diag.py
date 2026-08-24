#!/usr/bin/env python3
"""Why did the Aug 15 waiver post get parent cards but no threads?

The poster leaves rows UNPOSTED when thread creation fails, so a retry can reuse
the parent. This prints whether rows are still pending and, on a LIVE run, the
per-run stage/error Discord actually returned. Never prints the API key.
"""
import json, sys

p = sys.argv[1] if len(sys.argv) > 1 else "/tmp/resp.json"
try:
    d = json.load(open(p))
except Exception as e:
    print("!! not JSON:", e)
    print(open(p).read()[:600]); raise SystemExit(1)

print("ok:", d.get("ok"), " dry_run:", d.get("dry_run"), " target:", d.get("target"))
print("channel_id:", d.get("channel_id"))
print("message:", d.get("message", ""))
print("run_count:", d.get("run_count"), " move_count:", d.get("move_count"))
print()

runs = d.get("runs") or d.get("results") or []
if not runs:
    print("NO RUNS RETURNED — if message says 'No unposted adds', every row is already")
    print("marked posted, which means the thread failure did NOT leave them pending.")
for r in runs:
    plan = r.get("plan") or {}
    print("-" * 72)
    print(" franchise:", r.get("franchise_name") or r.get("franchise_id"))
    print(" thread_name:", plan.get("thread_name") or r.get("thread_name"))
    for k in ("ok", "stage", "error", "note", "parent_message_id", "parent_reused",
              "parent_recorded", "parent_record_error", "thread_id", "thread_reused",
              "posted_count"):
        if k in r:
            print(f"   {k}: {r[k]}")
print()
print("READ THIS: a `stage: thread_create` with an `error` is Discord's own refusal —")
print("code 50013 = missing permissions, 50024/160004 = invalid channel type for a")
print("message thread (i.e. forum), 429 = rate limited.")
