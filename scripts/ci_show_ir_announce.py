#!/usr/bin/env python3
"""Render the IR announcement result. Never prints the API key."""
import json, sys
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ir.json"))
print("ok:", d.get("ok"), " dry_run:", d.get("dry_run"), " placing:", d.get("placing"))
print("roster says:", json.dumps(d.get("roster") or {}))
r = d.get("result") or {}
if not d.get("ok") and not d.get("dry_run"):
    print("\nERROR:", d.get("error") or r.get("error")); raise SystemExit(0)
print("\nposted:", r.get("posted"), " gif:", r.get("gif"), " designation:", r.get("designation"))
if r.get("message_id"): print("parent message:", r.get("message_id"))
if r.get("thread_id"):  print("thread:", r.get("thread_id"), " detail posted:", r.get("thread_posted"))
if r.get("error"): print("error:", r.get("error"))
e = r.get("parent_embed") or {}
if e:
    print("\n----- PARENT EMBED -----")
    print("title      :", e.get("title"))
    print("description:", e.get("description"))
    print("color      :", hex(e.get("color")) if isinstance(e.get("color"), int) else e.get("color"))
    print("thumbnail  :", (e.get("thumbnail") or {}).get("url", "—"))
    for f in e.get("fields") or []:
        print(f"  • {f.get('name')}: {f.get('value')}")
    print("------------------------")
if r.get("thread_name"): print("thread name:", r.get("thread_name"))
if r.get("gif_url"):     print("gif (posted INTO the thread as an embed image):", r.get("gif_url")[:100])
