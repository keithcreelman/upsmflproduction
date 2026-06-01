#!/usr/bin/env python3
"""Before/after audit CSV for the contract unification write (Keith review).

BEFORE = the unification proposal's current_* columns (pre-write state we mapped
FROM) + before-salary/cy from the latest pre-write daily snapshot.
AFTER  = live MFL now (what the write produced; verified 339/339 canonical).

Outputs docs/contract_unification_before_after.csv:
franchise, player, pos, before_status, after_status, before_salary, after_salary,
before_contractYear, after_contractYear, before_contractInfo, after_contractInfo,
status_changed, contractInfo_changed, salary_changed.
MFL-API-native (+ local snapshot for before-salary).
"""
import csv, json, re, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LEAGUE, SERVER, YEAR = "74598", "https://www48.myfantasyleague.com", "2026"


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def latest_pre_write_snapshot():
    snaps = sorted((REPO / "data" / "mfl-snapshots").glob("2026-*"))
    for d in reversed(snaps):
        if (d / "rosters.json").exists():
            return d
    return None


def main():
    csvp = sorted((REPO / "docs").glob("contract_unification_2*.csv"))[-1]
    prop = {}
    for r in csv.DictReader(open(csvp)):
        prop.setdefault(r["player"], []).append(r)

    players = {p["id"]: p for p in fetch(f"{SERVER}/{YEAR}/export?TYPE=players&L={LEAGUE}&DETAILS=0&JSON=1")["players"]["player"]}
    nid = {}
    for pid, p in players.items():
        nid.setdefault(p.get("name", ""), []).append((pid, p.get("position", "")))

    # AFTER — live MFL
    after = {}
    for f in as_list(fetch(f"{SERVER}/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            after[str(p["id"])] = p

    # BEFORE salary/cy — latest pre-write snapshot
    before_snap = {}
    snap = latest_pre_write_snapshot()
    if snap:
        for f in as_list(json.load(open(snap / "rosters.json"))["rosters"]["franchise"]):
            for p in as_list(f.get("player")):
                before_snap[str(p["id"])] = p

    rows = []
    for name, cands in prop.items():
        for pr in cands:
            pos = pr.get("pos", "")
            pid_cands = nid.get(name, [])
            pid = (pid_cands[0][0] if len(pid_cands) == 1
                   else next((i for i, pp in pid_cands if pp == pos), pid_cands[0][0] if pid_cands else None))
            if not pid:
                continue
            aft = after.get(pid, {})
            bsnap = before_snap.get(pid, {})
            bstatus = pr["current_type"] if pr["current_type"] != "(blank)" else ""
            astatus = aft.get("contractStatus", "")
            bci = pr["current_contractInfo"]
            aci = aft.get("contractInfo", "")
            bsal = str(bsnap.get("salary", "") or "")
            asal = str(aft.get("salary", "") or "")
            bcy = str(bsnap.get("contractYear", "") or "")
            acy = str(aft.get("contractYear", "") or "")
            rows.append({
                "franchise": pr["franchise"], "player": name, "pos": pos,
                "before_status": bstatus or "(blank)", "after_status": astatus,
                "before_salary": bsal or "(blank)", "after_salary": asal,
                "before_contractYear": bcy or "(blank)", "after_contractYear": acy,
                "before_contractInfo": bci or "(blank)", "after_contractInfo": aci,
                "status_changed": "Y" if bstatus != astatus else "",
                "contractInfo_changed": "Y" if (bci or "") != (aci or "") else "",
                "salary_changed": "Y" if bsal != asal else "",
            })
    rows.sort(key=lambda r: (r["franchise"], r["player"]))
    out = REPO / "docs" / "contract_unification_before_after.csv"
    with open(out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
    chg = sum(1 for r in rows if r["status_changed"] or r["contractInfo_changed"] or r["salary_changed"])
    print(f"wrote {out} — {len(rows)} players, {chg} changed (before snapshot: {snap.name if snap else 'none'})")


if __name__ == "__main__":
    main()
