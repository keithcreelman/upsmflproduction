#!/usr/bin/env python3
"""J4 — Contract reconciliation-on-read (flag-only, never overwrites).

Per docs/CONTRACT_AUTOMATION_PLAN.md: MFL is the canonical contract store; this
nightly check reads MFL and flags anything that drifted, so re-pollution or
inconsistency surfaces instead of rotting silently. Two checks on every active
contract:

  1. VOCAB DRIFT — contractStatus is not a canonical value (Rookie-{Draft,FAA,
     WW,MYM}, Vet-{FAA,ERA,WW,MYM,Ext1,Ext2} ±-FL/-BL, Tag). A non-canonical
     value means a write path re-emitted old vocab — `::error::` (red run).
  2. INCONSISTENCY — contractStatus disagrees with contractInfo (an extension
     label with no Ext token; a -FL/-BL suffix with a flat/single-year schedule;
     a Tag label with no Tag token) — `::warning::` (advisory).

MFL-API-native; no writes. Mirrors the hardened semantic predicates.
"""
import argparse, json, re, sys, urllib.request
from pathlib import Path

LEAGUE, SERVER = "74598", "https://www48.myfantasyleague.com"
CANON = re.compile(r"^(Rookie-(Draft|FAA|WW|MYM)|Vet-(FAA|ERA|WW|MYM|Ext1|Ext2))(-FL|-BL)?$|^Tag$")


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def year_schedule(ci):
    return [int(x) for x in re.findall(r"Y\d+\s*-\s*(\d+)", ci or "")]


def schedule_is_perfectly_flat(ci):
    # A loaded (-FL/-BL) label is authoritative; only flag it as inconsistent when
    # the multi-year schedule is PERFECTLY flat (all years equal) — mild loading is fine.
    ys = year_schedule(ci)
    return len(ys) >= 2 and len(set(ys)) == 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2026")
    ap.add_argument("--report")
    a = ap.parse_args()

    players = {p["id"]: p.get("name", p["id"]) for p in fetch(f"{SERVER}/{a.year}/export?TYPE=players&L={LEAGUE}&DETAILS=0&JSON=1")["players"]["player"]}
    drift, inconsistent = [], []
    n = 0
    for f in as_list(fetch(f"{SERVER}/{a.year}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            n += 1
            name = players.get(str(p["id"]), p["id"])
            status = str(p.get("contractStatus", "") or "")
            ci = str(p.get("contractInfo", "") or "")
            if not CANON.match(status):
                drift.append((name, status))
                continue
            # consistency (only when status is canonical)
            if "Ext" in status and not re.search(r"Ext\s*:", ci):
                inconsistent.append((name, status, "extension label but no 'Ext:' token in contractInfo"))
            if re.search(r"-(FL|BL)$", status) and schedule_is_perfectly_flat(ci):
                inconsistent.append((name, status, "loaded suffix but contractInfo schedule is perfectly flat"))
            if status == "Tag" and "Tag" not in ci:
                inconsistent.append((name, status, "Tag label but no 'Tag' token in contractInfo"))

    for name, status in drift:
        print(f"::error::Contract vocab drift — {name}: contractStatus {status!r} is not canonical (a write path re-emitted old vocab).")
    for name, status, why in inconsistent:
        print(f"::warning::Contract inconsistency — {name} [{status}]: {why}.")

    report = {"year": a.year, "checked": n, "vocab_drift": [{"player": x[0], "status": x[1]} for x in drift],
              "inconsistencies": [{"player": x[0], "status": x[1], "why": x[2]} for x in inconsistent]}
    if a.report:
        Path(a.report).write_text(json.dumps(report, indent=2))
    print(f"\nReconcile {a.year}: {n} contracts · {len(drift)} vocab-drift · {len(inconsistent)} inconsistent.")
    return 1 if drift else 0  # drift fails the run (notify); inconsistencies are advisory


if __name__ == "__main__":
    sys.exit(main())
