#!/usr/bin/env python3
"""Cap-penalty DRY-RUN for the contractStatus migration. READ-ONLY.

For every active 2026 contract, recomputes the penalty-relevant classification
(the exemption/loaded/rookie gates that decide cap-hit money) under BOTH the
current OLD contractStatus and the proposed NEW canonical value, using the SAME
hardened semantic predicates the worker/FO now use. Then it reports every player
whose classification CHANGES — those are the only contracts whose cap treatment
moves — so a human can confirm each change is a correction, not a regression.

If a player's gates are identical old→new, their cap penalty is unchanged.
MFL-API-native; no local DB.
"""
import csv, json, re, sys, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LEAGUE, SERVER, YEAR = "74598", "https://www48.myfantasyleague.com", "2026"


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


# --- the hardened gates (mirror worker/index.js + roster_workbench.js) ---
def ww_drop_exempt(status, salary):      # WW pickup <= $4K = cap-free drop
    return bool(re.search(r"(^|-)WW($|-)", status, re.I)) and salary <= 4000


def loaded(status):                       # counts toward the Loaded X/5 cap
    s = status.lower()
    return bool(re.search(r"(^|-)(fl|bl)$", s)) or "-fl" in s or "-bl" in s


def cap_free_1yr(status, cy, salary):     # 1-yr vet/WW under $5K = $0 cap-free cut
    u = status.upper()
    return (u.startswith("VET") or u == "VETERAN" or "WW" in u) and cy <= 1 and 0 < salary < 5000


def is_rookie(status):                    # rookie treatment (ERA pool, round-2 exemption)
    return bool(re.search(r"rookie", status, re.I)) or status.upper() == "R"


def is_tag(status):
    return bool(re.search(r"tag", status, re.I))


GATES = {"WW_drop_exempt": ww_drop_exempt, "loaded": loaded, "cap_free_1yr_cut": cap_free_1yr, "rookie": is_rookie, "tag": is_tag}


def gates_for(status, salary, cy):
    return {
        "WW_drop_exempt": ww_drop_exempt(status, salary),
        "loaded": loaded(status),
        "cap_free_1yr_cut": cap_free_1yr(status, cy, salary),
        "rookie": is_rookie(status),
        "tag": is_tag(status),
    }


def main():
    cands = sorted((REPO / "docs").glob("contract_unification_2*.csv"))
    prop_rows = list(csv.DictReader(open(cands[-1])))
    prop = {}
    for r in prop_rows:
        prop.setdefault(r["player"], []).append(r)
    players = {p["id"]: p for p in fetch(f"{SERVER}/{YEAR}/export?TYPE=players&L={LEAGUE}&DETAILS=0&JSON=1")["players"]["player"]}
    cur = []
    for f in as_list(fetch(f"{SERVER}/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            cur.append((str(p["id"]), p))

    changes, identical, unmatched = [], 0, 0
    delta_count = {g: 0 for g in GATES}
    for pid, p in cur:
        meta = players.get(pid, {})
        name, pos = meta.get("name", pid), meta.get("position", "")
        cands2 = prop.get(name, [])
        pr = cands2[0] if len(cands2) == 1 else next((x for x in cands2 if x.get("pos") == pos), None)
        if not pr:
            unmatched += 1
            continue
        old_status = (p.get("contractStatus", "") or "")
        new_status = pr["proposed_type"].rstrip("?").strip()
        salary = int(p["salary"]) if str(p.get("salary", "")).isdigit() else 0
        cy = int(p["contractYear"]) if str(p.get("contractYear", "")).isdigit() else 99
        go, gn = gates_for(old_status, salary, cy), gates_for(new_status, salary, cy)
        if go == gn:
            identical += 1
            continue
        diffs = {g: (go[g], gn[g]) for g in GATES if go[g] != gn[g]}
        for g in diffs:
            delta_count[g] += 1
        changes.append({"name": name, "pos": pos, "old": old_status or "(blank)", "new": new_status,
                        "salary": salary, "cy": cy, "diffs": diffs})

    out = ["# Cap-penalty dry-run — OLD vs NEW contractStatus", "",
           f"{identical} contracts: cap treatment **UNCHANGED**. {len(changes)} **change** (review below). {unmatched} unmatched.",
           "",
           "Gates that move (a change = that exemption/flag flips):",
           *[f"- **{g}**: {n} player(s)" for g, n in delta_count.items() if n],
           "", "## Changed contracts — confirm each is a correction"]
    for c in sorted(changes, key=lambda c: c["name"].lower()):
        ds = "; ".join(f"{g}: {a}→{b}" for g, (a, b) in c["diffs"].items())
        out.append(f"- **{c['name']}** [{c['pos']}] `{c['old']}`→`{c['new']}` (${c['salary']}, cy{c['cy']}): {ds}")
    rep = "\n".join(out)
    print(rep)
    (REPO / "docs" / "cap_penalty_dryrun.md").write_text(rep) if "--save" in sys.argv else None


if __name__ == "__main__":
    main()
