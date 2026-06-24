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


def band_lo_hi(band):
    if band == "unranked": return (9999, 9999)
    if band.endswith("+"): lo = int(band[:-1]); return (lo, 9999)
    a, b = band.split("-"); return (int(a), int(b))


def band_mid(band):
    lo, hi = band_lo_hi(band)
    return lo + 3 if hi >= 9999 else (lo + hi) / 2


# Rank-1 marquee MEDIAN per position. Elite dynasty-SF ranks (QB1-6, RB1-4, WR1-6,
# TE1-3) have NEVER hit the FA auction, so there is no band data — and the FA-auction
# RECORD under-anchors them, because elites command the CONTRACT/EXTENSION market, not
# the FA block (Keith's comps: Julio/AJ Green/Arian Foster extended mid-high $60s;
# Herbert FA $51K; an elite SF QB above all of them). So we anchor rank-1 explicitly to
# the contract-market ceiling: QB1 the highest (SF scarcity), RB1/WR1 mid-high $60s, TE1
# lower. The monotonic ladder cascades everyone down from these to the auction-data bands.
ELITE_ANCHOR_K = {"QB": 75, "RB": 68, "WR": 66, "TE": 38}
ELITE_CEIL_FRAC = 0.85   # fallback for any position without an explicit anchor
ELITE_BAND_MULT = 1.35


def ladder_price(ladder, rank):
    """Piecewise-linear price along a monotonic (rank, median) ladder."""
    if rank <= ladder[0][0]: return ladder[0][1]
    if rank >= ladder[-1][0]: return ladder[-1][1]
    for i in range(len(ladder) - 1):
        x0, y0 = ladder[i]; x1, y1 = ladder[i + 1]
        if x0 <= rank <= x1:
            return y0 + (y1 - y0) * (rank - x0) / (x1 - x0)
    return ladder[-1][1]


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

    # ---- per-position MONOTONIC price ladder ----
    # Anchor a smooth (rank → median) curve on the reliable bands (n>=4), then
    # prepend an ELITE rank-1 anchor priced ABOVE the richest band toward the
    # position's record. price(rank) is non-increasing in rank by construction,
    # so a better dynasty-SF rank can never be cheaper than a worse one.
    ladders = {}
    for pos, bs in bands.items():
        pv = poswide.get(pos, [])
        pos_max = max(pv) if pv else 4
        anchors = sorted(
            [(band_mid(b), q["median"]) for b, q in bs.items()
             if b != "unranked" and q["n"] >= 4 and q["median"] is not None],
            key=lambda x: x[0])
        if not anchors:
            ladders[pos] = None
            continue
        richest = anchors[0][1]
        # explicit contract-market anchor for the position, else the record-fraction fallback
        elite = ELITE_ANCHOR_K.get(pos) or max(round(pos_max * ELITE_CEIL_FRAC), round(richest * ELITE_BAND_MULT))
        elite = max(elite, round(richest * ELITE_BAND_MULT))   # never below the richest reliable band
        ladder = [(1.0, elite)] + [a for a in anchors if a[0] > 1.0]
        for i in range(1, len(ladder)):  # enforce non-increasing
            if ladder[i][1] > ladder[i - 1][1]:
                ladder[i] = (ladder[i][0], ladder[i - 1][1])
        ladders[pos] = (ladder, pos_max)

    def project(pos, rank):
        band = band_of(pos, rank)
        bs = bands.get(pos, {})
        q = bs.get(band)
        info = ladders.get(pos)
        if info:
            ladder, pos_max = info
            med = round(ladder_price(ladder, rank))
            within = bool(q and q["n"] >= 4)  # this rank's own band has real samples
            if within:
                # keep the band's empirical spread; clamp it around the smooth median
                lo = round(min(q["low"], med)); t10 = round(max(q["top10"], med))
                return {"low": lo, "median": med, "top10": t10, "max": round(q["max"]),
                        "band": band, "basis": "model", "n": q["n"]}
            # elite / sparse tier: projected off the ladder (no direct comps)
            lo = max(1, round(med * 0.70))
            t10 = round(min(pos_max * 1.10, med * 1.40))
            return {"low": lo, "median": med, "top10": max(t10, med + 3), "max": pos_max,
                    "band": band, "basis": "projected", "n": 0}
        # no reliable bands at all → position-wide / fodder
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
                         "top10_k": p["top10"], "band": p["band"], "basis": p["basis"], "n": p["n"]})
    # enforce per-position monotonicity on ALL three quote levels by dynasty rank.
    # median is already non-increasing via the ladder; this clamps low/top10 so the
    # band-boundary empirical edges can't invert (a better rank's range edge dipping
    # below a worse rank's) — purely cosmetic, but keeps the whole range honest.
    byp = collections.defaultdict(list)
    for p in proj:
        byp[p["pos"]].append((int(re.sub(r"\D", "", p["dyn_sf_pos_rank"]) or 999), p))
    for pos, lst in byp.items():
        lst.sort(key=lambda x: x[0])
        prev = None
        for _, p in lst:
            if prev:
                for k in ("low_k", "median_k", "top10_k"):
                    if p[k] is not None and prev[k] is not None:
                        p[k] = min(p[k], prev[k])
            prev = p
    proj.sort(key=lambda x: -(x["median_k"] or 0))

    out = {"meta": {"method": "monotonic price ladder by dynasty-SF rank: reliable bands (n>=4, SF era 2022-2025; low=p25 median=p50 top10=p90) anchor a smooth curve; elite ranks with no auction history are projected UP toward the position record (rank-1 median = 0.85x record or 1.35x richest band). price is non-increasing in rank."},
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
