#!/usr/bin/env python3
"""FA-only pricing CSV: strategy.json minus everyone currently rostered.

A player is a free agent for the upcoming auction if their UPS contract has
expired (they are not on any active roster, taxi, or IR in the live league).
We fetch the live MFL rosters (L=74598, 2026) + the players export to map IDs →
names, then emit the contract-aware price/deal rows for the unrostered players.

Outputs docs/auction/data/fa_pricing.csv.
"""
from __future__ import annotations
import csv, json, re, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
LEAGUE = "74598"
YEAR = 2026
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def jget(u):
    req = urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())


def nkey(name):
    s = (name or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def main():
    strat = json.loads((DATA / "strategy.json").read_text())["players"]

    # live rostered player IDs (active + taxi + IR — anyone under contract)
    ro = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")
    rostered_ids = set()
    for f in ro["rosters"]["franchise"]:
        pl = f.get("player", [])
        if isinstance(pl, dict): pl = [pl]
        for p in pl:
            rostered_ids.add(str(p.get("id")))

    # player id → normalized name
    players = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=players&L={LEAGUE}&JSON=1")
    rostered_names = {nkey(p.get("name")) for p in players["players"]["player"]
                      if str(p.get("id")) in rostered_ids}

    cols = ["player", "pos", "age", "dyn_sf_rank", "redraft_rank", "win_now", "asset",
            "low_k", "median_k", "top10_k", "price_confidence", "deal_type", "true_cost"]
    fas = [p for p in strat if nkey(p["player"]) not in rostered_names]
    fas.sort(key=lambda x: -(x["median_k"] or 0))

    with open(DATA / "fa_pricing.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for p in fas:
            w.writerow(p)
    print(f"wrote {(DATA / 'fa_pricing.csv').relative_to(REPO)} "
          f"({len(fas)} FAs of {len(strat)} priced; {len(rostered_names)} rostered)")
    print("\n=== top FA prices (median $K) ===")
    print(f"  {'player':<22}{'rank':>6}{'redr':>6}{'med$':>6}  conf       deal")
    for p in fas[:16]:
        print(f"  {p['player'][:21]:<22}{p['dyn_sf_rank']:>6}{str(p['redraft_rank'] or '-'):>6}"
              f"{('$'+str(p['median_k'])+'K'):>6}  {p['price_confidence']:<10} {p['deal_type']}")


if __name__ == "__main__":
    main()
