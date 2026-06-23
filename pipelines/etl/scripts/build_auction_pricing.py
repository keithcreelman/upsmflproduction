#!/usr/bin/env python3
"""Expected FA-auction price per player: low / median / top-10% (in $K).

Method (dynasty-SF lens):
  1. Join every SF-era FA win (2022-2025) to the player's DYNASTY-SF positional
     rank AS-OF that auction (dynasty_adp_history.csv). Deep/unranked players →
     an 'unranked' band per position (the $1-4K fodder).
  2. Per (position, dynasty-rank band) build the winning-$ distribution →
     low = p25, median = p50, top10 = p90 (min sample 4, else merge upward).
  3. Apply to TODAY's players (current DynastyProcess ecr_2qb → SF pos rank) to
     project each one's low/median/top10 price.

Outputs docs/auction/data/pricing.json (bands + per-player projections).
"""
from __future__ import annotations
import csv, io, json, re, sqlite3, urllib.request, collections, statistics
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
DB = "/tmp/ups_auction_canon.db"
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")

# dynasty-SF positional rank bands (inclusive upper bound; None = open)
BANDS = {
    "QB": [3, 6, 10, 16, 28], "RB": [4, 10, 20, 36], "WR": [6, 15, 30, 50],
    "TE": [3, 8, 16], "DEFAULT": [12, 30],
}


def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"}), timeout=30).read()


def nkey(name):
    s = (name or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def band_of(pos, rank):
    if rank is None: return "unranked"
    edges = BANDS.get(pos, BANDS["DEFAULT"])
    lo = 1
    for e in edges:
        if rank <= e: return f"{lo}-{e}"
        lo = e + 1
    return f"{lo}+"


def pct(vals, p):
    if not vals: return None
    s = sorted(vals); i = min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))
    return s[i]


def main():
    # ---- dynasty rank lookup per (season, name) ----
    dyn = collections.defaultdict(dict)
    with open(DATA / "dynasty_adp_history.csv") as f:
        for r in csv.DictReader(f):
            m = re.match(r"([A-Z]+)(\d+)", r["sf_pos_rank"] or "")
            if m: dyn[int(r["season"])][nkey(r["player"])] = (r["pos"], int(m.group(2)))

    # ---- historical SF wins → (pos, band) → [win_k] ----
    c = sqlite3.connect(DB)
    dist = collections.defaultdict(list)
    for s, pid, nm, pos, amt in c.execute(
        "SELECT season,player_id,player_name,position,bid_amount FROM transactions_auction "
        "WHERE auction_type='FreeAgent' AND finalbid_ind=1 AND season>=2022"):
        info = dyn.get(s, {}).get(nkey(nm))
        dpos, drank = (info if info else ((pos or "?").upper(), None))
        dist[(dpos, band_of(dpos, drank))].append(amt / 1000)

    # build the band table with sample-merge fallback
    def quote(pos, band, vals):
        return {"n": len(vals), "low": pct(vals, 25), "median": pct(vals, 50),
                "top10": pct(vals, 90), "max": max(vals)}
    bands = {}
    for (pos, band), vals in dist.items():
        bands.setdefault(pos, {})[band] = quote(pos, band, vals)
    # position-wide fallback distribution
    poswide = {pos: [v for b in bands[pos] for v in dist[(pos, b)]] for pos in bands}

    def project(pos, rank):
        band = band_of(pos, rank)
        q = bands.get(pos, {}).get(band)
        if q and q["n"] >= 4: return {**q, "band": band, "basis": "band"}
        # merge: use the position-wide distribution filtered to <= this rank's typical range
        pv = poswide.get(pos)
        if pv:
            qq = quote(pos, band, pv); qq.update(band=band, basis="pos-wide", n=len(pv)); return qq
        return {"low": 1, "median": 2, "top10": 4, "max": 4, "band": band, "basis": "fodder", "n": 0}

    # ---- TODAY's players (current DynastyProcess SF ranks) → projections ----
    data = get("https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv").decode("utf-8", "ignore")
    recs = list(csv.DictReader(io.StringIO(data)))
    bypos = collections.defaultdict(list)
    for r in recs:
        try: bypos[r["pos"]].append((float(r["ecr_2qb"]), r))
        except (ValueError, KeyError): pass
    proj = []
    for pos, lst in bypos.items():
        lst.sort(key=lambda x: x[0])
        for i, (e, r) in enumerate(lst, 1):
            p = project(pos, i)
            proj.append({"player": r["player"], "pos": pos, "dyn_sf_pos_rank": f"{pos}{i}",
                         "age": r.get("age"), "low_k": p["low"], "median_k": p["median"],
                         "top10_k": p["top10"], "band": p["band"], "n": p["n"]})
    proj.sort(key=lambda x: -(x["median_k"] or 0))

    out = {"meta": {"method": "winning bids by dynasty-SF rank band, SF era 2022-2025; low=p25 median=p50 top10=p90"},
           "bands": bands, "projections": proj}
    (DATA / "pricing.json").write_text(json.dumps(out, indent=2))
    print(f"wrote {(DATA / 'pricing.json').relative_to(REPO)} ({len(proj)} player projections)")
    print("\n=== band table (median $K by position × dynasty-SF rank band) ===")
    for pos in ["QB", "RB", "WR", "TE"]:
        bs = bands.get(pos, {})
        print(f"  {pos}: " + "  ".join(f"{b}:${q['median']:.0f}K(n{q['n']})" for b, q in sorted(bs.items())))
    print("\n=== top projected prices (today's dynasty SF) ===")
    print(f"  {'player':<22}{'rank':>6}{'low':>6}{'med':>6}{'top10':>7}")
    for p in proj[:16]:
        print(f"  {p['player'][:21]:<22}{p['dyn_sf_pos_rank']:>6}{('$'+str(p['low_k'])+'K'):>6}{('$'+str(p['median_k'])+'K'):>6}{('$'+str(p['top10_k'])+'K'):>7}")


if __name__ == "__main__":
    main()
