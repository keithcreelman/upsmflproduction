#!/usr/bin/env python3
"""Re-run the 7-year FA Auction analysis with a CONSISTENT
month filter applied to ALL years.

Per Keith 2026-05-20:
> "I don't want May data. You excluded it for some years not all."

New rule: FA Auction = lots whose FIRST event is in JULY or later, every
year. Anything starting May or June is NOT FA Auction (it's ERA / early
offseason / commish-restart). This is uniform across 2019-2025.

Output:
  /tmp/mfl_auction/csv_strict/per_year_summary.csv
  /tmp/mfl_auction/csv_strict/deciles_long.csv
  /tmp/mfl_auction/csv_strict/lot_level.csv
  /tmp/mfl_auction/csv_strict/diff_vs_original.md
"""
import csv
import json
import statistics
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

YEARS = list(range(2019, 2026))
ROOT = Path("/tmp/mfl_auction")
OUT = ROOT / "csv_strict"
OUT.mkdir(exist_ok=True)

def load(year, tt):
    p = ROOT / f"mfl_txn_{year}_{tt}.json"
    j = json.loads(p.read_text())
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

# Build per-lot records
lot_rows = []
excluded_by_month = defaultdict(int)   # year -> count
included_by_year = defaultdict(int)
all_fa_total_by_year = defaultdict(int)

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
            "type": "INIT",
            "note": note,
            "amount": parse_field(tx.get("transaction", ""))[1],
            "by_commish": str(tx.get("by_commish", "")) == "1",
        })
    for tx in bids:
        pid, amt, note = parse_field(tx.get("transaction", ""))
        if not pid: continue
        events[pid].append({
            "ts": int(tx.get("timestamp", 0)),
            "fid": str(tx.get("franchise", "")).zfill(4),
            "type": "BID",
            "note": note,
            "amount": amt,
            "by_commish": str(tx.get("by_commish", "")) == "1",
        })

    won_by_pid = {}
    for tx in won:
        pid, amt, _ = parse_field(tx.get("transaction", ""))
        if not pid: continue
        won_by_pid[pid] = {
            "ts": int(tx.get("timestamp", 0)),
            "fid": str(tx.get("franchise", "")).zfill(4),
            "amount": amt,
        }

    for pid, evs in events.items():
        evs.sort(key=lambda e: e["ts"])
        first = evs[0]
        first_dt = datetime.fromtimestamp(first["ts"], tz=timezone.utc)
        # ── STRICT MONTH FILTER (applies to ALL years) ──
        # FA Auction always runs in JULY or later. May/June lots are
        # ERA / early-offseason / commish-restart and excluded.
        if first_dt.month < 7:
            excluded_by_month[y] += 1
            continue
        # Now tracking FA-eligible lots (any bid count)
        all_fa_total_by_year[y] += 1
        # Require ≥2 events for the qualifying cohort
        if len(evs) < 2:
            continue
        included_by_year[y] += 1

        n_forced = 0
        n_overtake = 0
        for ev in evs:
            note_l = (ev["note"] or "").lower()
            if ev["type"] == "INIT" or "nomination" in note_l:
                continue
            if "forced bid increase" in note_l:
                n_forced += 1
            else:
                n_overtake += 1
        w_event = won_by_pid.get(pid)
        if not w_event:
            continue
        duration_hrs = round((w_event["ts"] - first["ts"]) / 3600, 2)
        commish_flag = any(ev["by_commish"] for ev in evs)
        lot_rows.append({
            "year": y,
            "player_id": pid,
            "nominator_fid": first["fid"],
            "winner_fid": w_event["fid"],
            "winning_bid_dollars": w_event["amount"],
            "first_bid_at_utc": first_dt.strftime("%Y-%m-%d %H:%M:%S"),
            "won_at_utc": datetime.fromtimestamp(w_event["ts"], tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "duration_hrs_raw": duration_hrs,
            "duration_hrs_capped48": min(duration_hrs, 48.0),
            "total_bids": len(evs),
            "forced_increases": n_forced,
            "overtakes": n_overtake,
            "by_commish": int(commish_flag),
        })

# ── Per-year CSV ──
def avg(xs): return round(sum(xs) / len(xs), 2) if xs else 0
def med(xs): return round(statistics.median(xs), 2) if xs else 0

per_year = {}
for y in YEARS:
    rs = [r for r in lot_rows if r["year"] == y]
    durs_capped = [r["duration_hrs_capped48"] for r in rs]
    durs_raw    = [r["duration_hrs_raw"]    for r in rs]
    bids        = [r["total_bids"]          for r in rs]
    forced      = [r["forced_increases"]    for r in rs]
    ot          = [r["overtakes"]           for r in rs]
    per_year[y] = {
        "fa_total":    all_fa_total_by_year[y],
        "qualifying":  len(rs),
        "excluded_pre_july": excluded_by_month[y],
        "avg_dur_capped": avg(durs_capped),
        "avg_dur_raw":    avg(durs_raw),
        "median_dur_raw": med(durs_raw),
        "avg_bids":       avg(bids),
        "avg_forced":     avg(forced),
        "avg_ot":         avg(ot),
    }

with (OUT / "per_year_summary.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow([
        "year","league_id","fa_total_lots","qualifying_lots_2plus_bids","excluded_pre_july",
        "pct_lots_contested","avg_duration_capped48_hrs","avg_duration_raw_hrs",
        "median_duration_raw_hrs","avg_total_bids","avg_forced_increases","avg_overtakes",
    ])
    for y in YEARS:
        v = per_year[y]
        fa = v["fa_total"]; q = v["qualifying"]
        w.writerow([
            y, "74598", fa, q, v["excluded_pre_july"],
            round(100 * q / fa, 1) if fa else 0,
            v["avg_dur_capped"], v["avg_dur_raw"], v["median_dur_raw"],
            v["avg_bids"], v["avg_forced"], v["avg_ot"],
        ])
    # All-time row
    rs_all = lot_rows
    fa_all = sum(per_year[y]["fa_total"] for y in YEARS)
    q_all  = len(rs_all)
    w.writerow([
        "ALL","—", fa_all, q_all, sum(excluded_by_month.values()),
        round(100*q_all/fa_all, 1) if fa_all else 0,
        avg([r["duration_hrs_capped48"] for r in rs_all]),
        avg([r["duration_hrs_raw"]    for r in rs_all]),
        med([r["duration_hrs_raw"]    for r in rs_all]),
        avg([r["total_bids"]          for r in rs_all]),
        avg([r["forced_increases"]    for r in rs_all]),
        avg([r["overtakes"]           for r in rs_all]),
    ])

# ── Deciles CSV ──
def deciles(values, key=None):
    vs = sorted(values)
    n = len(vs)
    out = []
    for d in range(10):
        lo = int(d * n / 10)
        hi = int((d + 1) * n / 10)
        chunk = vs[lo:hi]
        if not chunk:
            out.append({"decile": d+1, "lo": 0, "hi": 0, "n": 0, "mean": 0})
            continue
        out.append({
            "decile": d+1,
            "lo": round(chunk[0], 2),
            "hi": round(chunk[-1], 2),
            "n": len(chunk),
            "mean": round(sum(chunk)/len(chunk), 2),
        })
    return out

with (OUT / "deciles_long.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["metric","decile","range_low","range_high","lot_count","pct_of_total","mean","cumulative_lot_pct"])
    for metric_name, vals in [
        ("duration_hrs_raw",     [r["duration_hrs_raw"]    for r in lot_rows]),
        ("duration_hrs_capped48",[r["duration_hrs_capped48"] for r in lot_rows]),
        ("total_bids",           [r["total_bids"]          for r in lot_rows]),
        ("forced",               [r["forced_increases"]    for r in lot_rows]),
        ("overtakes",            [r["overtakes"]           for r in lot_rows]),
    ]:
        bucks = deciles(vals)
        total = sum(b["n"] for b in bucks)
        cum = 0
        for b in bucks:
            cum += b["n"]
            w.writerow([
                metric_name, b["decile"], b["lo"], b["hi"], b["n"],
                round(100*b["n"]/total, 1) if total else 0,
                b["mean"],
                round(100*cum/total, 1) if total else 0,
            ])

# ── Lot-level CSV ──
lot_rows.sort(key=lambda r: (r["year"], r["player_id"]))
with (OUT / "lot_level.csv").open("w", newline="") as f:
    if lot_rows:
        w = csv.DictWriter(f, fieldnames=list(lot_rows[0].keys()))
        w.writeheader()
        for r in lot_rows:
            w.writerow(r)

# Print summary so I can see at a glance
print(f"Total qualifying (FA ≥2-bid, July+): {len(lot_rows)}")
print(f"Total FA-eligible (July+, any bids): {sum(per_year[y]['fa_total'] for y in YEARS)}")
print(f"Total excluded pre-July: {sum(excluded_by_month.values())}")
print()
print("Per year:")
print("year   | excl  | FA total | qual | %cont | avg_dur_capped | med_dur | avg_bids | avg_forced | avg_ot")
for y in YEARS:
    v = per_year[y]
    pct = round(100*v["qualifying"]/v["fa_total"],1) if v["fa_total"] else 0
    print(f"{y}   | {v['excluded_pre_july']:4d}  | {v['fa_total']:8d} | {v['qualifying']:4d} | {pct:5.1f} | {v['avg_dur_capped']:14.2f} | {v['median_dur_raw']:7.2f} | {v['avg_bids']:8.2f} | {v['avg_forced']:10.2f} | {v['avg_ot']:6.2f}")

# All-time
all_d = [r["duration_hrs_capped48"] for r in lot_rows]
all_dr = [r["duration_hrs_raw"] for r in lot_rows]
all_b = [r["total_bids"] for r in lot_rows]
all_f = [r["forced_increases"] for r in lot_rows]
all_ot = [r["overtakes"] for r in lot_rows]
print(f"\nALL    | {sum(excluded_by_month.values()):4d}  | {sum(per_year[y]['fa_total'] for y in YEARS):8d} | {len(lot_rows):4d} | {round(100*len(lot_rows)/sum(per_year[y]['fa_total'] for y in YEARS),1):5.1f} | {avg(all_d):14.2f} | {med(all_dr):7.2f} | {avg(all_b):8.2f} | {avg(all_f):10.2f} | {avg(all_ot):6.2f}")

# Spot-check: any May/June lots in lot_rows?
may_june = [r for r in lot_rows if int(r["first_bid_at_utc"][5:7]) < 7]
print(f"\nMay/June lots in final dataset: {len(may_june)} (should be 0)")

# Top 10 longest
longest = sorted(lot_rows, key=lambda r: -r["duration_hrs_raw"])[:10]
print(f"\nTop 10 longest lots (post-filter):")
print("year | pid    | hrs   | bids | forced | ot | by_commish")
for r in longest:
    print(f"{r['year']} | {r['player_id']:6s} | {r['duration_hrs_raw']:5.1f} | {r['total_bids']:4d} | {r['forced_increases']:6d} | {r['overtakes']:2d} | {r['by_commish']}")
