#!/usr/bin/env python3
"""Build the MFL import payload for the contract unification — the WRITE that
turns the proposal (docs/contract_unification_<date>.csv) into MFL's canonical
contractStatus + completed contractInfo. READ-ONLY itself: it only emits a
payload + a per-player diff; the actual write happens via POST
/admin/import-salaries (run with dry_run=true first).

Emits ONLY players whose contractStatus or contractInfo would change (MFL import
is APPEND=1 — untouched players are preserved). salary + contractYear are carried
through from current MFL unchanged. Matched by player name (+ position to
disambiguate duplicates like the two Justin Jeffersons).

Outputs: --payload <json> (rows for import-salaries) and --diff <md>.
MFL-API-native; no local DB.
"""
import argparse, csv, json, re, sys, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LEAGUE = "74598"
SERVER = "https://www48.myfantasyleague.com"
YEAR = "2026"


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def latest_csv():
    cands = sorted((REPO / "docs").glob("contract_unification_2*.csv"))  # date-stamped, not overrides
    return cands[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=None)
    ap.add_argument("--payload", default="/tmp/unification_payload.json")
    ap.add_argument("--diff", default="/tmp/unification_diff.md")
    ap.add_argument("--write", action="store_true", help="set dry_run=false (REAL write)")
    a = ap.parse_args()

    csv_path = Path(a.csv) if a.csv else latest_csv()
    prop_rows = list(csv.DictReader(open(csv_path)))

    players = {p["id"]: p for p in fetch(f"{SERVER}/{YEAR}/export?TYPE=players&L={LEAGUE}&DETAILS=0&JSON=1")["players"]["player"]}
    # current MFL roster state, keyed by player id
    cur = {}
    for f in as_list(fetch(f"{SERVER}/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            cur[str(p["id"])] = {
                "salary": str(p.get("salary", "") or ""),
                "contractStatus": str(p.get("contractStatus", "") or ""),
                "contractYear": str(p.get("contractYear", "") or ""),
                "contractInfo": str(p.get("contractInfo", "") or ""),
            }
    # prior season — restore salary + contractYear for the wiped (blank) players.
    prev = {}
    for f in as_list(fetch(f"{SERVER}/{int(YEAR)-1}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            prev[str(p["id"])] = {"salary": str(p.get("salary", "") or ""), "contractYear": str(p.get("contractYear", "") or "")}

    # proposal index: (name, pos) -> row
    prop_by_name = {}
    for r in prop_rows:
        prop_by_name.setdefault(r["player"], []).append(r)

    rows, diff = [], []
    skipped = []
    for pid, c in cur.items():
        meta = players.get(pid, {})
        name, pos = meta.get("name", ""), meta.get("position", "")
        cands = prop_by_name.get(name, [])
        pr = None
        if len(cands) == 1:
            pr = cands[0]
        elif len(cands) > 1:
            pr = next((x for x in cands if x.get("pos") == pos), None)
        if not pr:
            skipped.append(name or pid)
            continue
        new_status = pr["proposed_type"].rstrip("?").strip()  # drop the "?" uncertainty marker
        new_ci = (pr.get("proposed_contractInfo") or c["contractInfo"]).strip()
        # restore salary + roll contractYear forward for the wiped (blank) players
        salary, cy = c["salary"], c["contractYear"]
        if not salary and pid in prev:
            salary = prev[pid]["salary"]
            pcy = prev[pid]["contractYear"]
            cy = str(max(0, int(pcy) - 1)) if pcy.isdigit() else cy
        status_chg = new_status != c["contractStatus"]
        ci_chg = new_ci != c["contractInfo"]
        if not (status_chg or ci_chg):
            continue
        if not (salary and new_ci):  # import-salaries requires both
            skipped.append(f"{name} (missing salary/contractInfo)")
            continue
        rows.append({
            "id": pid,
            "salary": salary,
            "contractStatus": new_status,
            "contractYear": cy,
            "contractInfo": new_ci,
        })
        bits = []
        if status_chg:
            bits.append(f"status `{c['contractStatus'] or '(blank)'}` → `{new_status}`")
        if ci_chg:
            bits.append(f"contractInfo `{c['contractInfo'] or '(blank)'}` → `{new_ci}`")
        diff.append(f"- **{name}** [{pos}] — " + "; ".join(bits))

    payload = {"season": YEAR, "league_id": LEAGUE, "dry_run": (not a.write), "rows": rows}
    Path(a.payload).write_text(json.dumps(payload, indent=2))
    diff.sort()
    md = [f"# Contract unification — WRITE dry-run preview", "",
          f"Source: `{csv_path.name}` · {len(rows)} of {len(cur)} players would change · {len(skipped)} unmatched/skipped.",
          f"\nMFL import is **APPEND=1** — the {len(cur) - len(rows)} unchanged players are untouched.\n",
          "## Per-player changes", *diff]
    if skipped:
        md += [f"\n## Skipped ({len(skipped)})", "_unmatched name, or missing salary/contractInfo_", *[f"- {s}" for s in sorted(skipped)[:40]]]
    Path(a.diff).write_text("\n".join(md))
    print(f"payload: {a.payload} ({len(rows)} rows) · diff: {a.diff} · skipped: {len(skipped)}")
    for line in diff[:12]:
        print("  " + line)


if __name__ == "__main__":
    main()
