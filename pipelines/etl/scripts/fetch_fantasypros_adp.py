#!/usr/bin/env python3
"""FantasyPros redraft ADP → the STARTABILITY rank that drives expected price.

The existing redraft source (FantasyFootballCalculator, in adp_history.csv) is 1QB
PPR — it ranks startable NFL QBs very deep (Sam Darnold QB35) because you don't draft
backup QBs in 1QB. In a SUPERFLEX league that's the wrong signal for "is he an NFL
starter." FantasyPros ranks Darnold QB27 (a real startable QB). This scrapes the
FantasyPros ADP pages (qb/rb/wr/te × year), where positional rank = table order,
and maps fp-id → mfl_id via the D1 crosswalk.

Output: docs/auction/data/fpros_adp_history.csv (season, mfl_id, name, pos, fp_pos_rank, fp_id).
"""
from __future__ import annotations
import csv, json, re, subprocess, sys, time, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
POS = ["qb", "rb", "wr", "te"]
YEARS = range(2022, 2027)            # 2022-2025 calibration + 2026 current
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
ROW = re.compile(r'fp-id-(\d+)" fp-player-name="([^"]+)"')


def d1(sql):
    res = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        raise RuntimeError(res.stderr[-1500:])
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def fetch(pos, year):
    u = f"https://www.fantasypros.com/nfl/adp/{pos}.php?year={year}"
    req = urllib.request.Request(u, headers={"User-Agent": UA, "Accept": "text/html"})
    try:
        html = urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "ignore")
    except Exception as e:
        print(f"  ({pos} {year} fetch failed: {e})")
        return []
    seen, rows = set(), []
    for fp, name in ROW.findall(html):
        if fp in seen:           # the page repeats names in mobile/echo blocks; first occurrence = rank
            continue
        seen.add(fp); rows.append((fp, name))
    return rows


def main():
    fp2mfl = {str(r["fantasypros_id"]): str(r["mfl_id"])
              for r in d1("SELECT mfl_id, fantasypros_id FROM ff_player_ids WHERE fantasypros_id IS NOT NULL")}
    out = []
    for year in YEARS:
        for pos in POS:
            rows = fetch(pos, year)
            for i, (fp, name) in enumerate(rows, 1):
                out.append({"season": year, "mfl_id": fp2mfl.get(fp, ""), "name": name,
                            "pos": pos.upper(), "fp_pos_rank": i, "fp_id": fp})
            print(f"  {year} {pos.upper()}: {len(rows)} players", flush=True)
            time.sleep(0.4)
    # ── DESTRUCTIVE-WRITE GUARD (added 2026-07-21) ────────────────────────────
    # This script used to overwrite fpros_adp_history.csv unconditionally. The
    # FantasyPros ADP pages are now JS-rendered/paywalled and the ROW regex above
    # matches NOTHING (verified 2026-07-21: 0 rows for every year × position), so a
    # routine re-run silently replaced 2,000 rows of historical calibration data
    # with a bare header. A fetcher must never be able to delete history because a
    # scrape target changed its markup. Refuse to shrink the file by more than
    # SHRINK_TOL; pass --force to overwrite deliberately.
    dest = DATA / "fpros_adp_history.csv"
    SHRINK_TOL = 0.5
    prior = 0
    if dest.exists():
        with open(dest, newline="") as f:
            prior = max(0, sum(1 for _ in f) - 1)
    if prior and len(out) < prior * SHRINK_TOL and "--force" not in sys.argv:
        print(f"\nREFUSING TO WRITE: scrape produced {len(out)} rows but "
              f"{dest.name} already holds {prior}. The FantasyPros scrape is very "
              f"likely broken (their ADP pages are JS-rendered/paywalled — see "
              f"docs/auction/adp_sources_reference.md §2). Existing history left "
              f"untouched. Re-run with --force only if the shrink is intended.")
        return 1
    with open(dest, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["season", "mfl_id", "name", "pos", "fp_pos_rank", "fp_id"])
        w.writeheader(); w.writerows(out)
    matched = sum(1 for r in out if r["mfl_id"])
    print(f"\nwrote {dest.relative_to(REPO)} ({len(out)} rows, {matched} matched to mfl_id)")

    print("\n=== validate (2025 QB ranks) ===")
    for nm in ["Josh Allen", "Lamar Jackson", "Sam Darnold", "Aaron Rodgers", "Joe Flacco", "Geno Smith"]:
        r = next((x for x in out if x["season"] == 2025 and x["pos"] == "QB" and x["name"] == nm), None)
        print(f"  {nm:<16} → {('QB' + str(r['fp_pos_rank'])) if r else 'not found'}")
    print("\n=== 2026 (current) availability ===")
    for pos in ["QB", "RB", "WR", "TE"]:
        n = sum(1 for x in out if x["season"] == 2026 and x["pos"] == pos)
        print(f"  {pos}: {n} players")
    return 0


if __name__ == "__main__":
    sys.exit(main())
