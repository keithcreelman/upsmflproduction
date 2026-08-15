#!/usr/bin/env python3
"""Render the IR announcement result. Never prints the API key."""
import json, sys
d = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ir.json"))
print("ok:", d.get("ok"), " dry_run:", d.get("dry_run"), " placing:", d.get("placing"))
print("roster says:", json.dumps(d.get("roster") or {}))
if not d.get("ok") and not d.get("dry_run"):
    print("\nERROR:", d.get("error") or (d.get("result") or {}).get("error"))
r = d.get("result") or {}
print("\nposted:", r.get("posted"), " gif:", r.get("gif"), " designation:", r.get("designation"))
if r.get("error"): print("error:", r.get("error"))
p = r.get("preview")
if p:
    print("\n----- MESSAGE -----")
    print(p)
    print("-------------------")
