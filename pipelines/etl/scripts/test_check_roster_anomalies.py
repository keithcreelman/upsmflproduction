#!/usr/bin/env python3
"""ROSTER-DROP TEST — proves the 2026-08-06 disappearance would now be caught.

WHAT HAPPENED (the thing this test exists for)
==============================================
Will Levis (16149, F0006 The Long Haulers), Tank Bigsby (16164) and Zach
Charbonnet (16169, both F0001 L.A. Looks) silently left their rosters on
2026-08-06 at 17:11:06 / 17:12:05 / 17:12:25 UTC via MFL LOAD_ROSTERS
transactions with by_commish=1 and an EMPTY added side. The nightly check ran
clean that morning and would never have caught it — it looked only for contract
regressions and for players no transaction mentioned at all, and a LOAD_ROSTERS
mentions its victims by construction. The commissioner found it by eye.

WHAT IS PROVEN HERE
===================
1. INCIDENT REPLAY — the real committed 2026-08-06 snapshot, with exactly those
   three players removed and the three REAL LOAD_ROSTERS transactions (copied
   verbatim from the live MFL export) appended, flags exactly those three.
2. UNEXPLAINED VARIANT — the same three removals with no transaction at all
   flag as UNEXPLAINED.
2b. REVERTED-IN-WINDOW — the three were restored at 00:30 UTC the same night, so
   the roster diff alone sees nothing. The transaction log still does, and says
   so as a warning.
3. FALSE-POSITIVE CONTROL — the real 2026-08-05 -> 2026-08-06 pair, in which
   Daiyan Henley (16280) left F0010 by a legitimate FREE_AGENT drop, flags
   NOTHING.
4. EXPLANATIONS THAT MUST WORK (trade) AND MUST NOT (taxi, IR, a stale
   free-agent drop from outside the window, another franchise's auction).
5. NO FAIL-OPEN — seven ways an input can be bad, each of which must produce an
   UNREADABLE INPUT alert and a non-zero exit, and none of which may print a
   clean "0 roster drop(s)" summary.
6. BACKTEST — every consecutive pair of committed snapshots, to show the new
   check does not cry wolf on ordinary league days.

Usage:
  python3 pipelines/etl/scripts/test_check_roster_anomalies.py
  python3 pipelines/etl/scripts/test_check_roster_anomalies.py --no-backtest
"""
from __future__ import annotations
import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAP_DIR = REPO_ROOT / "data" / "mfl-snapshots"
CHECK = REPO_ROOT / "pipelines" / "etl" / "scripts" / "check_roster_anomalies.py"

BASE = "2026-08-06"          # last clean snapshot before the incident
PRIOR = "2026-08-05"
FIXTURE_FILES = ("rosters.json", "transactions.json", "league.json", "_snapshot_meta.json")

# The three real drops, verbatim from https://www48.myfantasyleague.com/2026/
# export?TYPE=transactions&L=74598&JSON=1 (fetched 2026-08-06). Kept as data so
# the test keeps proving the real incident long after it scrolls out of the log.
INCIDENT_TXS = [
    {"by_commish": "1", "transaction": "|16149,", "type": "LOAD_ROSTERS",
     "franchise": "0006", "timestamp": "1786036266"},
    {"by_commish": "1", "transaction": "|16164,", "franchise": "0001",
     "type": "LOAD_ROSTERS", "timestamp": "1786036325"},
    {"franchise": "0001", "type": "LOAD_ROSTERS", "by_commish": "1",
     "transaction": "|16169,", "timestamp": "1786036345"},
]
INCIDENT_VICTIMS = {"16149": "0006", "16164": "0001", "16169": "0001"}
LATER_TS = "1786036400"      # just after the incident, for synthetic txs


# ── fixture plumbing ────────────────────────────────────────────────────────
def make_pair(tmp: Path, name: str, prev: str = BASE, curr: str = BASE):
    """Copy two real snapshots into a scratch snap-dir so tests can mutate them."""
    root = tmp / name
    for label, src in (("2000-01-01", prev), ("2000-01-02", curr)):
        dst = root / label
        dst.mkdir(parents=True)
        for f in FIXTURE_FILES:
            shutil.copyfile(SNAP_DIR / src / f, dst / f)
    return root, root / "2000-01-01", root / "2000-01-02"


def drop_players(snap: Path, victims: dict):
    """Remove {pid: fid} from a fixture's rosters.json — the disappearance itself."""
    data = json.loads((snap / "rosters.json").read_text())
    for fr in data["rosters"]["franchise"]:
        fr["player"] = [p for p in fr["player"]
                        if not (p["id"] in victims and victims[p["id"]] == fr["id"])]
    (snap / "rosters.json").write_text(json.dumps(data, indent=2, sort_keys=True))


def add_txs(snap: Path, txs: list):
    data = json.loads((snap / "transactions.json").read_text())
    data["transactions"]["transaction"] = list(data["transactions"]["transaction"]) + txs
    (snap / "transactions.json").write_text(json.dumps(data, indent=2, sort_keys=True))


def run(snap_dir: Path, prev="2000-01-01", curr="2000-01-02", report=None):
    cmd = [sys.executable, str(CHECK), "--snap-dir", str(snap_dir),
           "--prev", prev, "--curr", curr, "--no-network"]
    if report:
        cmd += ["--report", str(report)]
    p = subprocess.run(cmd, capture_output=True, text=True)
    return p.returncode, p.stdout + p.stderr


def drops_from(report: Path) -> list:
    return json.loads(report.read_text())["roster_drops"]


# ── the checks ──────────────────────────────────────────────────────────────
def check_incident_replay(tmp: Path) -> list:
    """The real 2026-08-06 drops, with the real LOAD_ROSTERS transactions."""
    fails = []
    root, _, curr = make_pair(tmp, "incident")
    drop_players(curr, INCIDENT_VICTIMS)
    add_txs(curr, INCIDENT_TXS)
    report = tmp / "incident.json"
    rc, out = run(root, report=report)
    drops = drops_from(report)

    got = {d["pid"]: d for d in drops}
    if set(got) != set(INCIDENT_VICTIMS):
        fails.append(f"INCIDENT REPLAY flagged {sorted(got)}, expected "
                     f"{sorted(INCIDENT_VICTIMS)}")
    for pid, fid in INCIDENT_VICTIMS.items():
        d = got.get(pid)
        if not d:
            continue
        if d["fid"] != fid:
            fails.append(f"INCIDENT REPLAY: {pid} blamed on F{d['fid']}, expected F{fid}")
        if d["kind"] != "LOAD_ROSTERS":
            fails.append(f"INCIDENT REPLAY: {pid} kind={d['kind']}, expected LOAD_ROSTERS")
        if not (d["transaction"] or {}).get("by_commish"):
            fails.append(f"INCIDENT REPLAY: {pid} lost the by_commish flag")
        if "UTC" not in (d["transaction"] or {}).get("when", ""):
            fails.append(f"INCIDENT REPLAY: {pid} has no UTC timestamp in the alert")
        # Recovery has to be possible straight from the alert.
        for field in ("salary", "contractStatus", "contractInfo"):
            if not d["last_known"].get(field):
                fails.append(f"INCIDENT REPLAY: {pid} alert is missing last-known {field}")
    if rc == 0:
        fails.append("INCIDENT REPLAY exited 0 — the run would have stayed green")
    if "BULK COMMISSIONER IMPORT" not in out:
        fails.append("INCIDENT REPLAY: alert text never says it was a bulk import")
    for pid in INCIDENT_VICTIMS:
        if f"({pid})" not in out:
            fails.append(f"INCIDENT REPLAY: player {pid} missing from the printed alerts")
    if "F0006" not in out or "The Long Haulers" not in out:
        fails.append("INCIDENT REPLAY: alert lacks franchise id + name")
    return fails


def check_unexplained_variant(tmp: Path) -> list:
    """Same three gone, and this time not even a transaction to point at."""
    fails = []
    root, _, curr = make_pair(tmp, "unexplained")
    drop_players(curr, INCIDENT_VICTIMS)
    report = tmp / "unexplained.json"
    rc, out = run(root, report=report)
    drops = drops_from(report)
    if {d["pid"] for d in drops} != set(INCIDENT_VICTIMS):
        fails.append(f"UNEXPLAINED VARIANT flagged {sorted(d['pid'] for d in drops)}")
    if any(d["kind"] != "UNEXPLAINED" for d in drops):
        fails.append("UNEXPLAINED VARIANT: a drop with no transaction was not UNEXPLAINED")
    if rc == 0:
        fails.append("UNEXPLAINED VARIANT exited 0")
    return fails


def check_reverted_within_window(tmp: Path) -> list:
    """The real drops WERE reverted the same night — the log must still say so.

    Levis/Bigsby/Charbonnet were removed at 17:11-17:12 UTC and restored at
    00:30 UTC, both inside one nightly window. A pure roster diff sees nothing.
    """
    fails = []
    root, _, curr = make_pair(tmp, "reverted")
    add_txs(curr, INCIDENT_TXS)      # rosters deliberately UNCHANGED (restored)
    report = tmp / "reverted.json"
    rc, out = run(root, report=report)
    rep = json.loads(report.read_text())
    if rep["roster_drops"]:
        fails.append("REVERTED: a restored player was reported as still gone")
    if {r["pid"] for r in rep["reverted_bulk_drops"]} != set(INCIDENT_VICTIMS):
        fails.append(f"REVERTED: log-side check found "
                     f"{sorted(r['pid'] for r in rep['reverted_bulk_drops'])}, "
                     f"expected {sorted(INCIDENT_VICTIMS)}")
    if "::warning::Silent bulk roster import" not in out:
        fails.append("REVERTED: no warning emitted for the reverted bulk import")
    if rc != 0:
        fails.append("REVERTED: an already-reverted import turned the run red — advisory only")
    return fails


def check_false_positive_control(tmp: Path) -> list:
    """Daiyan Henley's real FREE_AGENT drop must stay silent."""
    fails = []
    root, _, _ = make_pair(tmp, "control", prev=PRIOR, curr=BASE)
    report = tmp / "control.json"
    rc, out = run(root, report=report)
    drops = drops_from(report)
    if drops:
        fails.append(f"FALSE-POSITIVE CONTROL flagged {[d['pid'] for d in drops]} on the "
                     f"real {PRIOR} -> {BASE} pair (Henley 16280 left by FREE_AGENT)")
    if "16280" in out:
        fails.append("FALSE-POSITIVE CONTROL: Henley 16280 appears in the output")
    return fails


def check_explanations(tmp: Path) -> list:
    """What may excuse a departure, and what may never."""
    fails = []
    victim = {"16149": "0006"}

    cases = [
        # (label, transactions to append, expected number of drops)
        ("FREE_AGENT drop by that franchise", [
            {"franchise": "0006", "type": "FREE_AGENT", "transaction": "|16149,",
             "timestamp": LATER_TS}], 0),
        ("TRADE (side 1 gave him up)", [
            {"type": "TRADE", "franchise": "0006", "franchise2": "0003",
             "franchise1_gave_up": "16149,", "franchise2_gave_up": "13592,",
             "comments": "", "expires": LATER_TS, "timestamp": LATER_TS}], 0),
        ("TRADE (side 2 gave him up)", [
            {"type": "TRADE", "franchise": "0003", "franchise2": "0006",
             "franchise1_gave_up": "13592,", "franchise2_gave_up": "16149,",
             "comments": "", "expires": LATER_TS, "timestamp": LATER_TS}], 0),
        # A taxi demotion / IR move keeps the player IN the rosters export
        # (status TAXI_SQUAD / INJURED_RESERVE), so it can never explain a
        # disappearance. Accepting it would reopen the 2026-08-06 hole.
        ("TAXI demote must NOT excuse", [
            {"franchise": "0006", "type": "TAXI", "demoted": "16149,", "promoted": "",
             "timestamp": LATER_TS}], 1),
        ("IR deactivate must NOT excuse", [
            {"franchise": "0006", "type": "IR", "deactivated": "16149,", "activated": "",
             "by_commish": "1", "timestamp": LATER_TS}], 1),
        ("another franchise's FREE_AGENT drop must NOT excuse", [
            {"franchise": "0003", "type": "FREE_AGENT", "transaction": "|16149,",
             "timestamp": LATER_TS}], 1),
        ("another franchise's AUCTION_WON must NOT excuse", [
            {"franchise": "0003", "type": "AUCTION_WON", "transaction": "16149|5000|",
             "timestamp": LATER_TS}], 1),
        # The log is the whole season. A drop from March says nothing about a
        # player who was on the roster in yesterday's snapshot.
        ("stale pre-window FREE_AGENT drop must NOT excuse", [
            {"franchise": "0006", "type": "FREE_AGENT", "transaction": "|16149,",
             "timestamp": "1772934921"}], 1),
        # A bulk import AFTER a legitimate drop is still a bulk mutation.
        ("LOAD_ROSTERS after a legitimate drop is still reported", [
            {"franchise": "0006", "type": "FREE_AGENT", "transaction": "|16149,",
             "timestamp": LATER_TS},
            {"franchise": "0006", "type": "LOAD_ROSTERS", "transaction": "|16149,",
             "by_commish": "1", "timestamp": str(int(LATER_TS) + 60)}], 1),
    ]
    for i, (label, txs, expected) in enumerate(cases):
        root, _, curr = make_pair(tmp, f"expl{i}")
        drop_players(curr, victim)
        add_txs(curr, txs)
        report = tmp / f"expl{i}.json"
        rc, _ = run(root, report=report)
        n = len(drops_from(report))
        if n != expected:
            fails.append(f"EXPLANATION [{label}]: got {n} drop(s), expected {expected}")
        if (rc != 0) != bool(expected):
            fails.append(f"EXPLANATION [{label}]: exit {rc} disagrees with {expected} drop(s)")
    return fails


def check_no_fail_open(tmp: Path) -> list:
    """Every unreadable input must ALERT — never 'no drops', never 'all dropped'."""
    fails = []

    def broken(name, mutate, prev=BASE, curr=BASE):
        root, p, c = make_pair(tmp, name, prev=prev, curr=curr)
        mutate(root, p, c)
        return root

    empty_roster = {"rosters": {"franchise": [
        {"id": "0001", "player": []}, {"id": "0002", "player": []}]}}

    cases = {
        "curr rosters.json missing":
            lambda r, p, c: (c / "rosters.json").unlink(),
        "curr rosters.json empty file":
            lambda r, p, c: (c / "rosters.json").write_text(""),
        "curr rosters.json is not JSON":
            lambda r, p, c: (c / "rosters.json").write_text("<html>503</html>"),
        "curr rosters.json has franchises but no players":
            lambda r, p, c: (c / "rosters.json").write_text(json.dumps(empty_roster)),
        "curr rosters.json lost a whole franchise":
            lambda r, p, c: _drop_franchise(c, "0006"),
        "one franchise came back empty":
            lambda r, p, c: _empty_franchise(c, "0006"),
        "curr transactions.json is not JSON":
            lambda r, p, c: (c / "transactions.json").write_text("{nope"),
        "curr transactions.json missing":
            lambda r, p, c: (c / "transactions.json").unlink(),
        "curr transactions.json is an empty log":
            lambda r, p, c: (c / "transactions.json").write_text(
                json.dumps({"transactions": {"transaction": []}})),
        "transaction log went backwards in time":
            lambda r, p, c: _truncate_log(c, 1780000000),
    }
    for label, mutate in cases.items():
        root = broken(re.sub(r"\W+", "_", label), mutate)
        rc, out = run(root)
        if rc == 0:
            fails.append(f"NO-FAIL-OPEN [{label}]: exited 0 (silent pass)")
        if "UNREADABLE INPUT" not in out:
            fails.append(f"NO-FAIL-OPEN [{label}]: no UNREADABLE INPUT alert")
        if "roster drop(s)" in out:
            fails.append(f"NO-FAIL-OPEN [{label}]: printed a drop SUMMARY off a bad input "
                         "— that reads as a verdict")
        if "ROSTER DROP" in out:
            fails.append(f"NO-FAIL-OPEN [{label}]: reported drops off an unreadable input "
                         "— the 'everybody was dropped' failure mode")

    # ...and the degenerate case: not enough snapshots to compare at all.
    lonely = tmp / "lonely"
    (lonely / "2000-01-01").mkdir(parents=True)
    for f in FIXTURE_FILES:
        shutil.copyfile(SNAP_DIR / BASE / f, lonely / "2000-01-01" / f)
    p = subprocess.run([sys.executable, str(CHECK), "--snap-dir", str(lonely), "--no-network"],
                       capture_output=True, text=True)
    if p.returncode == 0 or "UNREADABLE INPUT" not in p.stdout:
        fails.append("NO-FAIL-OPEN [single snapshot dir]: treated 'nothing to compare' "
                     f"as a pass (exit {p.returncode})")

    # A name lookup that cannot reach MFL must not suppress the finding.
    root, _, curr = make_pair(tmp, "offline")
    drop_players(curr, INCIDENT_VICTIMS)
    report = tmp / "offline.json"
    rc, out = run(root, report=report)          # run() always passes --no-network
    if len(drops_from(report)) != 3 or rc == 0:
        fails.append("NO-FAIL-OPEN [offline]: dropping the player-name lookup changed "
                     "the findings")
    return fails


def _drop_franchise(snap: Path, fid: str):
    data = json.loads((snap / "rosters.json").read_text())
    data["rosters"]["franchise"] = [f for f in data["rosters"]["franchise"] if f["id"] != fid]
    (snap / "rosters.json").write_text(json.dumps(data))


def _empty_franchise(snap: Path, fid: str):
    data = json.loads((snap / "rosters.json").read_text())
    for f in data["rosters"]["franchise"]:
        if f["id"] == fid:
            f["player"] = []
    (snap / "rosters.json").write_text(json.dumps(data))


def _truncate_log(snap: Path, before_ts: int):
    data = json.loads((snap / "transactions.json").read_text())
    data["transactions"]["transaction"] = [
        t for t in data["transactions"]["transaction"] if int(t["timestamp"]) < before_ts]
    (snap / "transactions.json").write_text(json.dumps(data))


def check_backtest(tmp: Path) -> list:
    """Every consecutive committed pair — a check that is red on ordinary days is unread."""
    dates = sorted(p.name for p in SNAP_DIR.iterdir()
                   if p.is_dir() and re.match(r"\d{4}-\d{2}-\d{2}$", p.name)
                   and (p / "rosters.json").exists() and (p / "transactions.json").exists())
    hits, skipped = {}, 0
    for prev, curr in zip(dates, dates[1:]):
        report = tmp / f"bt_{curr}.json"
        run(SNAP_DIR, prev=prev, curr=curr, report=report)
        if not report.exists():           # unreadable-input refusal, not a drop verdict
            skipped += 1
            continue
        for d in drops_from(report):
            hits.setdefault(f"{prev}->{curr}", []).append(f"F{d['fid']}/{d['pid']} [{d['kind']}]")
    pairs = len(dates) - 1
    print(f"  backtest: {pairs} pair(s), {skipped} refused as unreadable, "
          f"{sum(len(v) for v in hits.values())} drop(s) on {len(hits)} day(s)")
    for day, ds in sorted(hits.items()):
        print(f"    {day}  {len(ds)}: {', '.join(ds)}")
    # The findings themselves are NOT asserted away — every historical hit was
    # reviewed and is a real event of exactly the kind this check exists for:
    #   2026-04-24 / 2026-05-22  bulk commissioner LOAD_ROSTERS imports
    #                            (the 05-22 one is the post-rookie-draft load)
    #   2026-07-17 / 2026-07-19  the FAA test-residue purge — players that sat
    #                            on a roster for one day and vanished with no
    #                            transaction at all. Genuinely unexplained.
    # What is asserted is the noise FLOOR: a check that lights up on ordinary
    # league days stops being read, and then the next silent drop is missed too.
    noisy = 100.0 * len(hits) / pairs if pairs else 0.0
    print(f"    -> {noisy:.1f}% of days flag anything")
    if noisy > 10.0:
        return [f"BACKTEST: {len(hits)}/{pairs} days flag a drop ({noisy:.1f}%) — "
                "too noisy to be read"]
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-backtest", action="store_true")
    args = ap.parse_args()

    print("ROSTER-DROP TEST — would the 2026-08-06 silent LOAD_ROSTERS drops be caught?\n")
    fails = []
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for label, fn in (("incident replay", check_incident_replay),
                          ("unexplained variant", check_unexplained_variant),
                          ("reverted inside the window", check_reverted_within_window),
                          ("false-positive control (Henley)", check_false_positive_control),
                          ("explanation rules", check_explanations),
                          ("no fail-open", check_no_fail_open)):
            got = fn(tmp)
            print(f"  {'FAIL' if got else 'ok  '}  {label}")
            fails += got
        if not args.no_backtest:
            fails += check_backtest(tmp)

    print()
    if fails:
        print(f"FAILED — {len(fails)} violation(s):")
        for f in fails:
            print("  " + f)
        sys.exit(1)
    print("PASSED — the incident is detected, Henley is not, and no input can fail open")


if __name__ == "__main__":
    main()
