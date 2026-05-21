#!/usr/bin/env python3
"""Sub-$4K distribution + clean averages with $1K wins removed.

Per Keith 2026-05-20:
> "remove the 1K wins as i asked from the beginning... A true figure is
>  looking at the players 4K and less how is that distribution changing?"

Two cohorts:
  CONTESTED = lots with >=2 bids AND winning_bid > $1K (the "real" auctions)
  ALL_WON = every lot that resolved (contested or not), to compute distribution

For the sub-$4K bucket analysis, we look at ALL_WON to see how the
low-dollar cluster is shifting year over year.
"""
import csv
import json
import statistics
from collections import defaultdict, Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/tmp/mfl_auction")
players = json.load(open(ROOT / "players.json"))
pid_to = {}
plist = players.get("players", {}).get("player", [])
for p in plist:
    pid = str(p.get("id", ""))
    name = p.get("name", "")
    if "," in name:
        last, first = name.split(",", 1)
        name = f"{first.strip()} {last.strip()}"
    pid_to[pid] = {
        "name": name, "pos": p.get("position", ""), "team": p.get("team", ""),
    }
league = json.load(open(ROOT / "league_2025.json"))
fid_to = {f["id"]: f["name"] for f in league["league"]["franchises"]["franchise"]}

YEARS = list(range(2019, 2026))

def load(year, tt):
    j = json.loads((ROOT / f"mfl_txn_{year}_{tt}.json").read_text())
    txns = j.get("transactions", {}).get("transaction", [])
    if isinstance(txns, dict):
        txns = [txns]
    return txns

def parse_field(s):
    parts = (s or "").split("|")
    pid = parts[0] if len(parts) > 0 else ""
    note = parts[2] if len(parts) > 2 else ""
    try:
        amt = int(parts[1]) if len(parts) > 1 else None
    except Exception:
        amt = None
    return pid, amt, note

# Build EVERY lot (including 1-bid) with winning dollar amount, then partition
all_lots = []
for y in YEARS:
    init = load(y, "AUCTION_INIT")
    bids = load(y, "AUCTION_BID")
    won  = load(y, "AUCTION_WON")
    events = defaultdict(list)
    for tx in init:
        pid, _, note = parse_field(tx.get("transaction", ""))
        if not pid: continue
        events[pid].append({
            "ts": int(tx.get("timestamp", 0)),
            "fid": str(tx.get("franchise", "")).zfill(4),
            "type": "INIT", "note": note,
        })
    for tx in bids:
        pid, _, note = parse_field(tx.get("transaction", ""))
        if not pid: continue
        events[pid].append({
            "ts": int(tx.get("timestamp", 0)),
            "fid": str(tx.get("franchise", "")).zfill(4),
            "type": "BID", "note": note,
        })
    won_by_pid = {}
    for tx in won:
        pid, amt, _ = parse_field(tx.get("transaction", ""))
        if pid:
            won_by_pid[pid] = {
                "ts": int(tx.get("timestamp", 0)),
                "fid": str(tx.get("franchise", "")).zfill(4),
                "amt": amt,
            }
    for pid, evs in events.items():
        evs.sort(key=lambda e: e["ts"])
        first = evs[0]
        first_dt = datetime.fromtimestamp(first["ts"], tz=timezone.utc)
        if first_dt.month < 7: continue   # July+ uniform filter
        if pid not in won_by_pid: continue  # unresolved
        n_forced = sum(1 for ev in evs if ev["type"] == "BID" and "forced bid increase" in (ev["note"] or "").lower())
        n_overtake = sum(1 for ev in evs if ev["type"] == "BID" and "forced bid increase" not in (ev["note"] or "").lower() and "nomination" not in (ev["note"] or "").lower())
        info = pid_to.get(pid, {})
        win_dollars = won_by_pid[pid]["amt"] or 0
        all_lots.append({
            "year": y,
            "pid": pid,
            "player": info.get("name") or f"#{pid}",
            "pos": info.get("pos", ""),
            "nfl": info.get("team", ""),
            "win_dollars": win_dollars,
            "win_k": win_dollars // 1000,
            "total_bids": len(evs),
            "forced": n_forced,
            "overtakes": n_overtake,
            "nominator_fid": first["fid"],
            "nominator": fid_to.get(first["fid"], first["fid"]),
            "winner_fid": won_by_pid[pid]["fid"],
            "winner": fid_to.get(won_by_pid[pid]["fid"], won_by_pid[pid]["fid"]),
            "duration_hrs": round((won_by_pid[pid]["ts"] - first["ts"]) / 3600, 2),
            "self_nom": first["fid"] == won_by_pid[pid]["fid"],
        })

# Buckets
def bucket(k):
    if k <= 1: return "$1K"
    if k <= 4: return "$2-$4K"
    if k <= 10: return "$5-$10K"
    if k <= 25: return "$11-$25K"
    if k <= 50: return "$26-$50K"
    return "$51K+"

BUCKETS = ["$1K", "$2-$4K", "$5-$10K", "$11-$25K", "$26-$50K", "$51K+"]

# Distribution by year + bucket
dist = defaultdict(lambda: Counter())
for l in all_lots:
    dist[l["year"]][bucket(l["win_k"])] += 1

print("=== DISTRIBUTION BY YEAR & WIN BUCKET (all resolved lots, July+) ===")
print(f"{'Year':6s}|" + " ".join(f"{b:>10s}" for b in BUCKETS) + " |  Total")
for y in YEARS:
    row = dist[y]
    total = sum(row.values())
    cells = " ".join(f"{row[b]:5d} ({100*row[b]/total:4.1f}%)" if total else "  -  " for b in BUCKETS)
    print(f"{y:6d}|" + cells + f" |  {total}")
print()

# Specifically sub-$4K share (= $1K + $2-$4K)
print("=== SUB-$4K SHARE BY YEAR ===")
print(f"{'Year':6s}| $1K wins | $2-$4K wins | $4K+ wins | sub-$4K total | sub-$4K % of all")
for y in YEARS:
    row = dist[y]
    k1 = row["$1K"]; k2_4 = row["$2-$4K"]
    sub = k1 + k2_4
    total = sum(row.values())
    above = total - sub
    print(f"{y:6d}| {k1:8d} | {k2_4:11d} | {above:9d} | {sub:13d} | {round(100*sub/total,1) if total else 0:14.1f}%")
print()

# Now the CLEAN cohort: exclude $1K wins entirely, keep contested only
clean_lots = [l for l in all_lots if l["win_dollars"] > 1000 and l["total_bids"] >= 2]
print(f"=== CLEAN COHORT (>$1K AND ≥2 bids): n={len(clean_lots)} ===")
print()

# Per-year clean averages
print(f"{'Year':6s}| n   | avg_dur | med_dur | avg_bids | avg_forced | avg_ot | avg_win_$K | med_win_$K")
for y in YEARS:
    ls = [l for l in clean_lots if l["year"] == y]
    if not ls:
        print(f"{y:6d}|  0 |   -   |   -   |    -    |    -     |   -   |    -      |    -    ")
        continue
    durs = [min(l["duration_hrs"], 48.0) for l in ls]
    durs_raw = [l["duration_hrs"] for l in ls]
    bids = [l["total_bids"] for l in ls]
    forced = [l["forced"] for l in ls]
    ot = [l["overtakes"] for l in ls]
    wks = [l["win_k"] for l in ls]
    print(f"{y:6d}|{len(ls):4d} | {sum(durs)/len(durs):6.2f} | {statistics.median(durs_raw):6.2f} | {sum(bids)/len(bids):7.2f} | {sum(forced)/len(forced):9.2f} | {sum(ot)/len(ot):5.2f} | {sum(wks)/len(wks):9.2f} | {statistics.median(wks):8.2f}")

# All-time clean
ls = clean_lots
durs = [min(l["duration_hrs"], 48.0) for l in ls]
bids = [l["total_bids"] for l in ls]
forced = [l["forced"] for l in ls]
ot = [l["overtakes"] for l in ls]
wks = [l["win_k"] for l in ls]
print(f"ALL   |{len(ls):4d} | {sum(durs)/len(durs):6.2f} | {statistics.median([l['duration_hrs'] for l in ls]):6.2f} | {sum(bids)/len(bids):7.2f} | {sum(forced)/len(forced):9.2f} | {sum(ot)/len(ot):5.2f} | {sum(wks)/len(wks):9.2f} | {statistics.median(wks):8.2f}")

# Deciles on clean cohort
print()
print("=== CLEAN COHORT DECILES (win $K, duration, bids, forced, overtakes) ===")
def deciles(vals, label):
    vs = sorted(vals)
    n = len(vs)
    print(f"\n{label}:")
    for d in range(10):
        lo = int(d*n/10); hi = int((d+1)*n/10)
        chunk = vs[lo:hi]
        if not chunk: continue
        print(f"  D{d+1:2d}: {chunk[0]:>7.1f} - {chunk[-1]:>7.1f}  (n={len(chunk):3d}, mean={sum(chunk)/len(chunk):>6.2f})")

deciles([l["win_k"] for l in ls], "win_$K")
deciles([l["duration_hrs"] for l in ls], "duration_hrs (raw)")
deciles([l["total_bids"] for l in ls], "total_bids")
deciles([l["forced"] for l in ls], "forced")
deciles([l["overtakes"] for l in ls], "overtakes")

# Write the new lot_level CSV (clean)
OUT = ROOT / "csv_clean"
OUT.mkdir(exist_ok=True)
with (OUT / "lot_level_clean.csv").open("w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["year","pid","player","pos","nfl","win_dollars","win_k","total_bids","forced","overtakes","duration_hrs","nominator","winner","self_nom"])
    w.writeheader()
    for l in clean_lots:
        w.writerow({k: l.get(k, "") for k in w.fieldnames})

# Per-year summary CSV with $1K-excluded numbers
with (OUT / "per_year_clean.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["year","clean_lots","avg_dur_capped48","median_dur_raw","avg_total_bids","avg_forced","avg_overtakes","avg_win_k","median_win_k"])
    for y in YEARS:
        ls = [l for l in clean_lots if l["year"] == y]
        if not ls:
            w.writerow([y,0,0,0,0,0,0,0,0])
            continue
        durs = [min(l["duration_hrs"], 48.0) for l in ls]
        wks = [l["win_k"] for l in ls]
        w.writerow([
            y, len(ls),
            round(sum(durs)/len(durs), 2),
            round(statistics.median([l["duration_hrs"] for l in ls]), 2),
            round(sum(l["total_bids"] for l in ls)/len(ls), 2),
            round(sum(l["forced"] for l in ls)/len(ls), 2),
            round(sum(l["overtakes"] for l in ls)/len(ls), 2),
            round(sum(wks)/len(wks), 2),
            round(statistics.median(wks), 2),
        ])

# Distribution-by-bucket CSV
with (OUT / "win_buckets_by_year.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["year"] + BUCKETS + ["total"])
    for y in YEARS:
        row = dist[y]
        total = sum(row.values())
        w.writerow([y] + [row[b] for b in BUCKETS] + [total])

print(f"\nWrote {OUT}/lot_level_clean.csv ({len(clean_lots)} rows)")
print(f"Wrote {OUT}/per_year_clean.csv")
print(f"Wrote {OUT}/win_buckets_by_year.csv")
