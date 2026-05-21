#!/usr/bin/env python3
"""v5: cap-free zone framing + D10 sub-tiers + position-normalized
+ Cleon Ca$h per-year spend.

Built from the v4 clean cohort (n=663 contested wins, July+, $1K out).
"""
import csv
import json
import statistics
from collections import defaultdict, Counter
from pathlib import Path

ROOT = Path("/tmp/mfl_auction")

# Load clean lot-level
rows = list(csv.DictReader(open(ROOT / "csv_clean" / "lot_level_clean.csv")))
for r in rows:
    r["year"] = int(r["year"])
    r["win_k"] = int(r["win_k"])
    r["total_bids"] = int(r["total_bids"])
    r["forced"] = int(r["forced"])
    r["overtakes"] = int(r["overtakes"])
    r["duration_hrs"] = float(r["duration_hrs"])

# ── 1) Cap-free zone framing ──
def zone(k):
    if k <= 4: return "cap_free"   # $2-$4K, no penalty if cut
    if k <= 9: return "commit_low" # $5-$9K, real commit but recoverable
    if k <= 17: return "commit_mid"# $10-$17K, real money
    return "marquee"               # $18K+

zone_buckets = ["cap_free", "commit_low", "commit_mid", "marquee"]
zone_labels = {
    "cap_free": "$2-$4K (cap-free)",
    "commit_low": "$5-$9K (low commit)",
    "commit_mid": "$10-$17K (mid commit)",
    "marquee": "$18K+ (marquee)",
}
zone_by_year = defaultdict(Counter)
for r in rows:
    zone_by_year[r["year"]][zone(r["win_k"])] += 1

print("=== ZONE DISTRIBUTION BY YEAR (contested wins, $1K out) ===")
print(f"{'Year':6s}|" + " ".join(f"{zone_labels[z]:>22s}" for z in zone_buckets) + " | Total")
for y in sorted(zone_by_year):
    row = zone_by_year[y]
    total = sum(row.values())
    cells = " ".join(f"{row[z]:4d} ({100*row[z]/total:4.1f}%)" + " "*(11) for z in zone_buckets)
    print(f"{y:6d}|" + cells + f" | {total}")
print()

# ── 2) Sub-divide D10 (top 67 wins by $K) ──
sorted_by_win = sorted(rows, key=lambda r: r["win_k"], reverse=True)
top67 = sorted_by_win[:67]   # D10 = top 10% = 67 lots
print(f"=== D10 (TOP 10%) SUB-TIERS ===")
print(f"D10 has {len(top67)} lots, win-$ range ${top67[-1]['win_k']}K-${top67[0]['win_k']}K\n")
# Sub-deciles
top67_sorted_asc = sorted(top67, key=lambda r: r["win_k"])
print("Sub-tier breakdown:")
SUB_CHUNK = 7  # ~10 sub-deciles inside D10
for i in range(0, len(top67_sorted_asc), SUB_CHUNK):
    chunk = top67_sorted_asc[i:i+SUB_CHUNK]
    lo, hi = chunk[0]["win_k"], chunk[-1]["win_k"]
    mean = sum(r["win_k"] for r in chunk) / len(chunk)
    print(f"  D10.{i//SUB_CHUNK+1}: ${lo:3d}K - ${hi:3d}K  (n={len(chunk):2d}, mean=${mean:5.1f}K)")
print()

# Top 20 individual lots — these are the headline-money tier
print("=== TOP 20 LOTS BY WIN $ (the actual headliners) ===")
for r in sorted_by_win[:20]:
    print(f"  {r['year']} ${r['win_k']:3d}K  {r['player']:25s} ({r['pos']:3s} {r['nfl']:3s})  {r['nominator']:18s} → {r['winner']:18s}  {r['total_bids']}b/{r['duration_hrs']:5.1f}h")
print()

# ── 3) Position-normalized: percentile within position ──
by_pos = defaultdict(list)
for r in rows:
    by_pos[r["pos"]].append(r["win_k"])

print("=== POSITION WIN-$ DISTRIBUTION ===")
print(f"{'Pos':5s}| n   | median | p75 | p90 | p95 | max")
for pos in sorted(by_pos, key=lambda p: -len(by_pos[p])):
    vs = sorted(by_pos[pos])
    n = len(vs)
    if n < 5: continue
    p50 = vs[n//2]
    p75 = vs[3*n//4]
    p90 = vs[int(0.9*n)]
    p95 = vs[int(0.95*n)] if n >= 20 else vs[-1]
    print(f"{pos:5s}|{n:4d} | {p50:6d} | {p75:3d} | {p90:3d} | {p95:3d} | {max(vs):3d}")
print()

# Per-position thresholds: 90th percentile = "notable" for that position
print("=== PER-POSITION 90TH-PERCENTILE THRESHOLD ===")
print(f"(if a winning bid hits this number for that position, it's top-10% rare)")
thresholds = {}
for pos in by_pos:
    vs = sorted(by_pos[pos])
    n = len(vs)
    if n < 5: continue
    p90 = vs[int(0.9*n)]
    thresholds[pos] = p90
    print(f"  {pos}: ${p90}K (n={n})")
print()

# Position-normalized examples — show same-$ player at different positions
print("=== POSITION-RELATIVE 'NOTABLE' EXAMPLES ===")
example_amounts = [10, 12, 15, 20, 30]
print(f"Same dollar amount, different headline value by position:")
print(f"{'$K':4s}|" + " ".join(f"{p:>5s}-rare?" for p in ["QB","RB","WR","TE","LB","DB","DL"]))
for amt in example_amounts:
    cells = []
    for p in ["QB","RB","WR","TE","LB","DB","DL"]:
        thr = thresholds.get(p, 999)
        marker = "YES" if amt >= thr else "no"
        cells.append(f"{marker:>11s}")
    print(f"${amt:3d}K|" + " ".join(cells))
print()

# ── 4) Cleon Ca$h spending pattern ──
cleon = [r for r in rows if r["winner"] == "Cleon Ca$h"]
print(f"=== CLEON CA$H — {len(cleon)} contested wins across 7 yrs ===\n")

# Per-year breakdown
spend_by_year = defaultdict(list)
for r in cleon:
    spend_by_year[r["year"]].append(r)

print(f"{'Year':6s}| Wins | Total $K | Avg $K | Median $K | Max win")
for y in sorted(spend_by_year):
    ws = spend_by_year[y]
    total = sum(r["win_k"] for r in ws)
    avg = total / len(ws)
    med = statistics.median([r["win_k"] for r in ws])
    biggest = max(ws, key=lambda r: r["win_k"])
    print(f"{y:6d}|{len(ws):5d} | {total:8d} | {avg:6.1f} | {med:9.1f} | ${biggest['win_k']}K {biggest['player']} ({biggest['pos']})")
print()

# Per-year top 5 big spends
print("=== CLEON CA$H BIGGEST SPENDS PER YEAR ===")
for y in sorted(spend_by_year):
    ws = sorted(spend_by_year[y], key=lambda r: -r["win_k"])
    print(f"\n{y}:")
    for r in ws[:5]:
        print(f"  ${r['win_k']:3d}K  {r['player']:25s} ({r['pos']:3s} {r['nfl']:3s})  — {r['total_bids']} bids, {r['duration_hrs']:.1f}h")

# All-time biggest Cleon bets
print()
print("=== CLEON ALL-TIME TOP 10 SPENDS ===")
all_cleon = sorted(cleon, key=lambda r: -r["win_k"])
for r in all_cleon[:10]:
    print(f"  {r['year']} ${r['win_k']:3d}K  {r['player']:25s} ({r['pos']:3s} {r['nfl']:3s})  {r['nominator']:18s} → Cleon  {r['total_bids']}b/{r['duration_hrs']:.1f}h")

# Cleon's zone profile vs league
print()
print("=== CLEON'S ZONE PROFILE VS LEAGUE ===")
cleon_zones = Counter(zone(r["win_k"]) for r in cleon)
league_zones = Counter(zone(r["win_k"]) for r in rows)
cn = len(cleon); ln = len(rows)
print(f"{'Zone':25s}| Cleon | %     | League | %")
for z in zone_buckets:
    cp = 100 * cleon_zones[z] / cn if cn else 0
    lp = 100 * league_zones[z] / ln if ln else 0
    delta = cp - lp
    direction = "↑" if delta > 2 else ("↓" if delta < -2 else "=")
    print(f"{zone_labels[z]:25s}| {cleon_zones[z]:5d} | {cp:4.1f}%| {league_zones[z]:6d} | {lp:4.1f}%  {direction} {abs(delta):4.1f}pp")

# Per-franchise zone profile compact
print()
print("=== ALL FRANCHISES: ZONE-MIX SIGNATURE ===")
by_fr = defaultdict(list)
for r in rows:
    by_fr[r["winner"]].append(r)
print(f"{'Franchise':22s}| n   | %cap_free | %low | %mid | %marquee | total_$K")
for fr in sorted(by_fr, key=lambda f: -sum(r["win_k"] for r in by_fr[f])):
    ws = by_fr[fr]
    if len(ws) < 5: continue
    total = sum(r["win_k"] for r in ws)
    zc = Counter(zone(r["win_k"]) for r in ws)
    print(f"{fr:22s}|{len(ws):4d} | {100*zc['cap_free']/len(ws):8.1f}% | {100*zc['commit_low']/len(ws):4.1f}% | {100*zc['commit_mid']/len(ws):4.1f}% | {100*zc['marquee']/len(ws):7.1f}% | {total:7d}")

# Write Cleon CSV
OUT = ROOT / "csv_clean"
with (OUT / "cleon_wins.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["year","win_k","player","pos","nfl","total_bids","forced","overtakes","duration_hrs","nominator"])
    w.writeheader()
    for r in sorted(cleon, key=lambda r: (r["year"], -r["win_k"])):
        w.writerow({k: r.get(k, "") for k in w.fieldnames})

# Write position-normalized CSV
with (OUT / "position_thresholds.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["position","n","median_k","p75_k","p90_k","p95_k","max_k"])
    for pos in sorted(by_pos):
        vs = sorted(by_pos[pos])
        n = len(vs)
        if n < 5: continue
        w.writerow([
            pos, n,
            vs[n//2],
            vs[3*n//4],
            vs[int(0.9*n)],
            vs[int(0.95*n)] if n >= 20 else vs[-1],
            max(vs),
        ])

# Write zone-by-year CSV
with (OUT / "zone_by_year.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["year"] + [zone_labels[z] for z in zone_buckets] + ["total"])
    for y in sorted(zone_by_year):
        row = zone_by_year[y]
        w.writerow([y] + [row[z] for z in zone_buckets] + [sum(row.values())])

print(f"\nWrote {OUT}/cleon_wins.csv ({len(cleon)} rows)")
print(f"Wrote {OUT}/position_thresholds.csv")
print(f"Wrote {OUT}/zone_by_year.csv")
