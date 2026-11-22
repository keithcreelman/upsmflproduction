#!/usr/bin/env python3
"""BLIND-BID WAIVER TEST: a processed BBID_WAIVER drop is a legitimate departure.

WHAT WENT WRONG
===============
MFL writes a processed blind-bid waiver claim as

    {"type": "BBID_WAIVER", "franchise": "0005", "transaction": "16655,|2000|16280,"}

i.e. `addedCSV|bid|droppedCSV`. The drop is in the THIRD pipe segment. The J3
check did not list BBID_WAIVER as a departure type, and its drop parser read
only the second segment (the bid). Every blind-bid drop therefore became an
"UNEXPLAINED ROSTER DROP" and the daily run went red: 13 flags on
2026-11-18 -> 19, 3 on 19 -> 20 and 1 on 20 -> 21. A check that is red on
ordinary waiver days is one nobody reads, so a real silent drop would be missed.

WHAT IS PROVEN HERE (offline, committed snapshots only, no network)
==================================================================
1. PARSER: the drop side of a BBID_WAIVER is the third segment, and the bid
   amount is never read as a player id. Other types keep their two-segment
   reading.
2. REAL DAYS: the committed 2026-11-18..21 snapshot pairs produce 0 roster
   drops and exit 0 (they produced 17 before the fix).
3. STILL CATCHES: a synthetic unexplained drop on the real 2026-11-21 snapshot
   still flags as UNEXPLAINED and turns the run red.
4. BBID IS NOT A BLANKET EXCUSE: another franchise's BBID drop, a BBID that only
   ADDS the player, a bid amount equal to the player id, a BBID from before the
   window, and a LOAD_ROSTERS after a BBID drop all still flag.

The 2026-08-02 / 08-06 incident protections are covered by
test_check_roster_anomalies.py, which must keep passing alongside this file.

Usage:
  python3 pipelines/etl/scripts/test_check_roster_anomalies_bbid.py
"""
from __future__ import annotations
import importlib.util
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[2]
SNAP_DIR = REPO_ROOT / "data" / "mfl-snapshots"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


chk = _load("check_roster_anomalies", HERE / "check_roster_anomalies.py")
# Fixture plumbing (copy a real pair, drop a player, append transactions, run
# the CLI with --no-network) is shared with the incident test, not duplicated.
base = _load("test_check_roster_anomalies", HERE / "test_check_roster_anomalies.py")

# The three red days, as committed. Before the fix: 13 + 3 + 1 = 17 flags.
RED_PAIRS = [("2026-11-18", "2026-11-19", 13),
             ("2026-11-19", "2026-11-20", 3),
             ("2026-11-20", "2026-11-21", 1)]
# 2026-11-21: F0005 claimed 16655 for a 2000 bid and dropped 16280.
REAL_BBID = {"franchise": "0005", "type": "BBID_WAIVER",
             "transaction": "16655,|2000|16280,", "timestamp": "0"}


def check_parser() -> list:
    fails = []
    got = chk.dropped_side(REAL_BBID)
    if got != {"16280"}:
        fails.append(f"PARSER: BBID drop side read as {sorted(got)}, expected ['16280']")
    if chk.transaction_players(REAL_BBID) != {"16655", "16280"}:
        fails.append(f"PARSER: BBID players read as "
                     f"{sorted(chk.transaction_players(REAL_BBID))} — the bid 2000 is not a player")
    no_drop = {"type": "BBID_WAIVER", "transaction": "16655,|1000|"}
    if chk.dropped_side(no_drop):
        fails.append("PARSER: a BBID with an empty drop side produced drops")
    if chk.dropped_side({"type": "BBID_WAIVER", "transaction": "16655,|1000"}):
        fails.append("PARSER: a truncated BBID field fell back to reading the bid")
    if "BBID_WAIVER" not in chk.LEGIT_DEPARTURE_TYPES:
        fails.append("PARSER: BBID_WAIVER is not a legitimate departure type")
    # The fix must not widen what explains a departure.
    for ty in ("TAXI", "IR", "AUCTION_WON", "AUCTION_BID", "AUCTION_INIT", "LOAD_ROSTERS"):
        if ty in chk.LEGIT_DEPARTURE_TYPES:
            fails.append(f"PARSER: {ty} must never be a legitimate departure type")
    # Unchanged two-segment types.
    if chk.dropped_side({"type": "FREE_AGENT", "transaction": "|16149,"}) != {"16149"}:
        fails.append("PARSER: FREE_AGENT drop side changed")
    if chk.dropped_side({"type": "LOAD_ROSTERS", "transaction": "|16169,"}) != {"16169"}:
        fails.append("PARSER: LOAD_ROSTERS drop side changed")
    return fails


def check_real_days(tmp: Path) -> list:
    fails = []
    for prev, curr, was in RED_PAIRS:
        report = tmp / f"real_{curr}.json"
        rc, out = base.run(SNAP_DIR, prev=prev, curr=curr, report=report)
        if not report.exists():
            fails.append(f"REAL {prev}->{curr}: no report (exit {rc}): {out[-300:]}")
            continue
        drops = base.drops_from(report)
        if drops:
            fails.append(f"REAL {prev}->{curr}: {len(drops)} drop(s) (was {was} before the "
                         f"fix): {[(d['fid'], d['pid']) for d in drops]}")
        if rc != 0:
            fails.append(f"REAL {prev}->{curr}: exit {rc}, expected 0")
    return fails


def _victim(prev: str, curr: str, fid: str) -> str:
    """A player on `fid` in BOTH real snapshots, so removing him is a pure drop."""
    a = chk.load_rosters(SNAP_DIR / prev)[fid]
    b = chk.load_rosters(SNAP_DIR / curr)[fid]
    return sorted(set(a) & set(b))[0]


def check_still_catches(tmp: Path) -> list:
    """A real roster minus one player, no transaction: must flag and go red."""
    fails = []
    prev, curr = "2026-11-20", "2026-11-21"
    pid = _victim(prev, curr, "0006")
    root, _, c = base.make_pair(tmp, "synthetic", prev=prev, curr=curr)
    base.drop_players(c, {pid: "0006"})
    report = tmp / "synthetic.json"
    rc, out = base.run(root, report=report)
    drops = base.drops_from(report)
    if [(d["fid"], d["pid"], d["kind"]) for d in drops] != [("0006", pid, "UNEXPLAINED")]:
        fails.append(f"SYNTHETIC: expected F0006/{pid} UNEXPLAINED, got "
                     f"{[(d['fid'], d['pid'], d['kind']) for d in drops]}")
    if rc == 0:
        fails.append("SYNTHETIC: an unexplained drop exited 0 — the run would stay green")
    if "UNEXPLAINED ROSTER DROP" not in out:
        fails.append("SYNTHETIC: no UNEXPLAINED ROSTER DROP alert printed")
    return fails


def check_bbid_limits(tmp: Path) -> list:
    """BBID excuses only its own franchise's drop, inside the window."""
    fails = []
    prev, curr = "2026-11-20", "2026-11-21"
    pid = _victim(prev, curr, "0006")
    prev_txs = chk.read_transactions(SNAP_DIR / prev)
    curr_txs = chk.read_transactions(SNAP_DIR / curr)
    floor = chk.transaction_window(prev_txs, curr_txs, prev, curr)
    inside = str(max(int(t["timestamp"]) for t in curr_txs) + 60)
    stale = str(floor - 86400)

    def bbid(fid, field, ts=inside):
        return {"franchise": fid, "type": "BBID_WAIVER", "transaction": field, "timestamp": ts}

    cases = [
        ("own franchise BBID drop excuses", [bbid("0006", f"16655,|1000|{pid},")], 0),
        ("own franchise BBID, victim among several drops", [
            bbid("0006", f"16655,16594,|1000|15271,{pid},")], 0),
        ("another franchise's BBID drop must NOT excuse", [
            bbid("0003", f"16655,|1000|{pid},")], 1),
        ("a BBID that only ADDS the player must NOT excuse", [
            bbid("0006", f"{pid},|1000|")], 1),
        ("a bid amount equal to the player id must NOT excuse", [
            bbid("0006", f"16655,|{pid}|")], 1),
        ("a BBID from before the window must NOT excuse", [
            bbid("0006", f"16655,|1000|{pid},", ts=stale)], 1),
        ("LOAD_ROSTERS after a BBID drop is still reported", [
            bbid("0006", f"16655,|1000|{pid},"),
            {"franchise": "0006", "type": "LOAD_ROSTERS", "transaction": f"|{pid},",
             "by_commish": "1", "timestamp": str(int(inside) + 60)}], 1),
    ]
    for i, (label, txs, expected) in enumerate(cases):
        root, _, c = base.make_pair(tmp, f"bbid{i}", prev=prev, curr=curr)
        base.drop_players(c, {pid: "0006"})
        base.add_txs(c, txs)
        report = tmp / f"bbid{i}.json"
        rc, _ = base.run(root, report=report)
        n = len(base.drops_from(report))
        if n != expected:
            fails.append(f"BBID [{label}]: got {n} drop(s), expected {expected}")
        if (rc != 0) != bool(expected):
            fails.append(f"BBID [{label}]: exit {rc} disagrees with {expected} drop(s)")
    return fails


def main():
    print("BBID WAIVER TEST — are blind-bid drops explained, and is nothing else?\n")
    fails = []
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for label, fn in (("parser", lambda: check_parser()),
                          ("real 2026-11-18..21 days are clean", lambda: check_real_days(tmp)),
                          ("synthetic unexplained drop still flags", lambda: check_still_catches(tmp)),
                          ("BBID is not a blanket excuse", lambda: check_bbid_limits(tmp))):
            got = fn()
            print(f"  {'FAIL' if got else 'ok  '}  {label}")
            fails += got
    print()
    if fails:
        print(f"FAILED — {len(fails)} violation(s):")
        for f in fails:
            print("  " + f)
        sys.exit(1)
    print("PASSED — blind-bid drops are explained; unexplained and bulk drops still flag")


if __name__ == "__main__":
    main()
