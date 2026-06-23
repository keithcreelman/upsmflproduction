#!/usr/bin/env python3
"""Contract-aware auction strategy model (re-run of the value model).

Layers the UPS CONTRACT mechanics onto the price model (pricing.json):
  - WIN-NOW value (redraft rank, FantasyCalc) vs ASSET value (dynasty-SF rank).
  - DEAL TYPE per player, with its true forward cost:
      cut-free dart   ($1-4K, 1-yr) ........ $0 downside (§D2) — pure win-now
      1-yr rental     (older, redraft>dynasty) expires clean / flip for assets
                                              penalty-free (§D3); bounded bet
      multi-year build(young, dynasty-strong) worth a MYAC; asset + flip value
      anchor          (top in BOTH) ......... pay up, build around
  The point (per league rules): a high price is NOT dead money if the deal is
  short or tradeable — so re-toolers can rent/flip, not just "pay dynasty".

Outputs docs/auction/data/strategy.json (+ a printed summary).
"""
from __future__ import annotations
import csv, io, json, re, urllib.request, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"}), timeout=30).read()


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    return re.sub(r"\s+", " ", SUFFIX.sub("", s.replace(".", "").replace("'", "").replace("-", " "))).strip()


def grade(rank):
    if rank is None: return "—"
    if rank <= 6: return "A"
    if rank <= 12: return "B"
    if rank <= 24: return "C"
    return "D"


def main():
    pricing = json.loads((DATA / "pricing.json").read_text())
    proj = pricing["projections"]

    # current REDRAFT win-now rank (FantasyCalc SF redraft), by name
    fc = json.loads(get("https://api.fantasycalc.com/values/current?isDynasty=false&numQbs=2&numTeams=12&ppr=1"))
    rr = collections.defaultdict(list)
    for r in fc:
        p = r.get("player") or {}
        rr[(p.get("position") or "?")].append((r.get("value") or 0, nkey(p.get("name"))))
    redraft_rank = {}
    for pos, lst in rr.items():
        lst.sort(key=lambda x: -x[0])
        for i, (v, k) in enumerate(lst, 1): redraft_rank[k] = (pos, i)

    out = []
    for p in proj:
        nm = nkey(p["player"])
        dyn = int(re.sub(r"\D", "", p["dyn_sf_pos_rank"]) or 999)
        rdr = redraft_rank.get(nm)
        rdr_rank = rdr[1] if rdr else None
        age = None
        try: age = float(p.get("age"))
        except (TypeError, ValueError): pass
        med = p["median_k"] or 0
        # deal type
        if med <= 4:
            deal, cost = "cut-free dart", "$0 downside — cut anytime (1-yr ≤$4K, §D2)"
        elif age is not None and age <= 26 and dyn <= 18:
            deal, cost = "multi-year build", "worth a MYAC; young asset holds value + flips for picks"
        elif age is not None and age >= 28 and rdr_rank is not None and (dyn > (rdr_rank + 4)):
            deal, cost = "1-yr rental / flip", "expires clean at roll-forward, or trade penalty-free (§D3) — bounded"
        elif dyn <= 8 and rdr_rank is not None and rdr_rank <= 8:
            deal, cost = "anchor", "pay up; elite in both lenses — build around"
        else:
            deal, cost = "1-yr / situational", "keep it 1-yr; redraft bet with trade optionality"
        # price confidence, straight off the pricing basis:
        #   model     = the player's own dynasty-rank band has real auction samples
        #   projected = elite tier that never hit the auction (QB1-6, RB1-4, WR1-6,
        #               TE1-3) — priced UP the monotonic ladder toward the position
        #               record; a defensible estimate, but expect real bid variance
        basis = p.get("basis") or "model"
        conf = "model" if basis == "model" else "projected"
        out.append({
            "player": p["player"], "pos": p["pos"], "age": p.get("age"),
            "dyn_sf_rank": p["dyn_sf_pos_rank"], "redraft_rank": (rdr[0] + str(rdr[1])) if rdr else None,
            "win_now": grade(rdr_rank), "asset": grade(dyn),
            "low_k": p["low_k"], "median_k": p["median_k"], "top10_k": p["top10_k"],
            "price_confidence": conf, "deal_type": deal, "true_cost": cost,
        })
    out.sort(key=lambda x: -(x["median_k"] or 0))
    (DATA / "strategy.json").write_text(json.dumps({"meta": {"basis": "pricing.json bands + FantasyCalc redraft + contract deal-typing"}, "players": out}, indent=2))
    print(f"wrote {(DATA / 'strategy.json').relative_to(REPO)} ({len(out)} players)")

    counts = collections.Counter(p["deal_type"] for p in out)
    print("\ndeal-type mix:", dict(counts))
    print("\n=== sample: top projected, with contract lens (win-now / asset) ===")
    print(f"  {'player':<22}{'dynSF':>6}{'redr':>6}{'WN':>3}{'AS':>3}{'med$':>6}  deal")
    for p in out[:18]:
        print(f"  {p['player'][:21]:<22}{p['dyn_sf_rank']:>6}{str(p['redraft_rank'] or '-'):>6}{p['win_now']:>3}{p['asset']:>3}{('$'+str(p['median_k'])+'K'):>6}  {p['deal_type']}")
    print("\n=== reliable WIN-NOW value (modeled price, strong redraft, <=$20K) — real rentals/darts ===")
    wn = sorted([p for p in out if p["win_now"] in ("A", "B") and (p["median_k"] or 0) <= 20 and p["price_confidence"] == "model"], key=lambda x: (x["median_k"] or 0))
    for p in wn[:10]:
        print(f"  {p['player'][:21]:<22}{(p['redraft_rank'] or '-'):>6} WN:{p['win_now']} AS:{p['asset']} ${p['median_k']}K  {p['deal_type']}")
    proj_elite = [p for p in out if p["price_confidence"] == "projected"]
    print(f"\n  ({len(proj_elite)} elite players are PROJECTED-priced — they never hit the auction, so the price is extrapolated UP the ladder toward the position record; expect real bid variance if one surfaces.)")


if __name__ == "__main__":
    main()
