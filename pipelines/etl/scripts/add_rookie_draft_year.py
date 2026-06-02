#!/usr/bin/env python3
"""Append one season's rookie-draft picks to site/rookies/rookie_draft_history.json.

SSOT = MFL `draftResults` (the actual native rookie draft). For a just-completed
draft there is no NFL performance yet, so only the core identity/contract fields
are filled; the enrichment columns (points/ppg/tier/...) are left null until the
nightly builder re-runs after the season produces data.

Usage:  python3 add_rookie_draft_year.py 2026
"""
import json
import sys
import urllib.request
from datetime import datetime, timezone

WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE = "74598"  # stable for 2017+
PATH = "site/rookies/rookie_draft_history.json"

# Fallback position -> pos_group when the learned map (from existing rows) misses
# a position (e.g. CB/S that didn't appear in prior drafts).
FALLBACK_GROUP = {
    "QB": "offense", "RB": "offense", "WR": "offense", "TE": "offense",
    "PK": "offense", "PN": "offense",
    "DL": "defense", "DE": "defense", "DT": "defense", "LB": "defense",
    "CB": "defense", "S": "defense", "DB": "defense",
}


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (ups-etl)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def mfl(typ, year, extra=""):
    return fetch(f"{WORKER}/api/mfl-export?TYPE={typ}&L={LEAGUE}&YEAR={year}&JSON=1{extra}")


def rookie_salary(rd, slot):
    """§A1 schedule (verified vs existing data): R1 = $16K−slot×$1K floored at
    $5K; R2 = $5K; R3–R5 = $2K; R6 = $1K. 3-year flat deal."""
    if rd == 1:
        return max(5000, 16000 - slot * 1000)
    if rd == 2:
        return 5000
    if rd <= 5:
        return 2000
    return 1000


def main():
    year = int(sys.argv[1]) if len(sys.argv) > 1 else 2026
    d = json.load(open(PATH))
    picks = d["picks"]
    schema_keys = list(picks[0].keys())

    # franchise_id -> owner_name from the most-recent existing rows (owners are
    # the best available proxy for the current season; commish can correct).
    owner_by_fid = {}
    posgrp, possub = {}, {}
    for p in sorted(picks, key=lambda x: x["season"]):
        if p.get("owner_name"):
            owner_by_fid[p["franchise_id"]] = p["owner_name"]
        if p.get("position"):
            posgrp.setdefault(p["position"], p.get("pos_group"))
            possub.setdefault(p["position"], p.get("pos_subgroup"))

    # Current franchise NAMES for the target season (may differ from prior years).
    lg = mfl("league", year)
    frs = lg["league"]["franchises"]["franchise"]
    name_by_fid = {f["id"].zfill(4): f.get("name") for f in (frs if isinstance(frs, list) else [frs])}

    # Player identity for the target season.
    pl = mfl("players", year)
    pmap = {p["id"]: p for p in pl["players"]["player"]}

    # SSOT: the native rookie draft results.
    dr = mfl("draftResults", year)
    units = dr["draftResults"]["draftUnit"]
    units = units if isinstance(units, list) else [units]

    new_rows = []
    for u in units:
        dps = u.get("draftPick", [])
        dps = dps if isinstance(dps, list) else [dps]
        for pk in dps:
            pid = pk.get("player")
            if not pid:
                continue
            rd = int(pk["round"])
            slot = int(pk["pick"])
            fid = str(pk["franchise"]).zfill(4)
            overall = (rd - 1) * 12 + slot
            pinfo = pmap.get(pid, {})
            pos = pinfo.get("position")
            row = {k: None for k in schema_keys}
            row.update({
                "season": year, "round": rd, "slot": slot,
                "pick_label": f"{rd}.{slot:02d}", "pick_overall": overall,
                "franchise_id": fid, "franchise_name": name_by_fid.get(fid),
                "owner_name": owner_by_fid.get(fid), "owner_active": True,
                "player_id": pid, "player_name": pinfo.get("name"),
                "position": pos, "pos_subgroup": possub.get(pos, pos),
                "pos_group": posgrp.get(pos) or FALLBACK_GROUP.get(pos),
                "profile_url": f"https://www48.myfantasyleague.com/{year}/player?L={LEAGUE}&P={pid}",
                "icon_url": f"https://www48.myfantasyleague.com/player_photos_2014/{pid}_thumb.jpg",
                "salary": rookie_salary(rd, slot), "years_of_data": 0,
            })
            new_rows.append(row)

    # Replace any existing rows for this season, then re-sort.
    d["picks"] = [p for p in picks if str(p["season"]) != str(year)] + new_rows
    d["picks"].sort(key=lambda x: (x["season"], x["pick_overall"]))
    d["meta"]["n_rows"] = len(d["picks"])
    d["meta"]["seasons"] = sorted(set(p["season"] for p in d["picks"]))
    d["meta"]["generated_at_utc"] = datetime.now(timezone.utc).isoformat()

    json.dump(d, open(PATH, "w"), indent=2)
    miss = [r["pick_label"] for r in new_rows if not r["player_name"]]
    print(f"Added {len(new_rows)} {year} picks; total {len(d['picks'])}; "
          f"seasons end {d['meta']['seasons'][-3:]}")
    if miss:
        print(f"  WARN missing player_name for: {miss}")


if __name__ == "__main__":
    main()
