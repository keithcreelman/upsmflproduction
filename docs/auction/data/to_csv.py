#!/usr/bin/env python3
"""Convert agent's cached MFL auction analysis into 3 CSVs.

Inputs:
  /tmp/mfl_auction/result.json          (aggregate output from analyze.py)
  /tmp/mfl_auction/mfl_txn_*.json       (raw per-year per-trans-type)

Outputs:
  /tmp/mfl_auction/csv/per_year_summary.csv
  /tmp/mfl_auction/csv/deciles_long.csv
  /tmp/mfl_auction/csv/lot_level.csv

Re-runs the lot-level scan against raw transactions to ensure the
lot-level CSV is consistent with the aggregate numbers.
"""
import csv
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path("/tmp/mfl_auction")
OUT = ROOT / "csv"
OUT.mkdir(exist_ok=True)

# ── Load aggregate output ──
result = json.loads((ROOT / "result.json").read_text())

# ── CSV 1: per-year summary ──
with (OUT / "per_year_summary.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow([
        "year", "league_id", "fa_total_lots", "qualifying_lots_2plus_bids",
        "pct_lots_contested", "avg_duration_capped48_hrs", "avg_duration_raw_hrs",
        "median_duration_raw_hrs", "avg_total_bids", "avg_forced_increases",
        "avg_overtakes",
    ])
    for y, v in result["per_year"].items():
        fa_total = v["fa_total"]
        qual = v["qualifying"]
        w.writerow([
            y, "74598", fa_total, qual,
            round(100 * qual / fa_total, 1) if fa_total else 0,
            v["avg_dur_capped"], v["avg_dur_raw"], v["median_dur_raw"],
            v["avg_bids"], v["avg_forced"], v["avg_ot"],
        ])
    # All-time row
    g = result["global"]
    total_fa = sum(v["fa_total"] for v in result["per_year"].values())
    total_qual = result["n_records"]
    w.writerow([
        "ALL", "—", total_fa, total_qual,
        round(100 * total_qual / total_fa, 1) if total_fa else 0,
        round(g["duration_hrs_capped48"]["mean"], 2),
        round(g["duration_hrs_raw"]["mean"], 2),
        round(g["duration_hrs_raw"]["median"], 2),
        round(g["total_bids"]["mean"], 2),
        round(g["forced"]["mean"], 2),
        round(g["overtakes"]["mean"], 2),
    ])

# ── CSV 2: deciles in long format ──
with (OUT / "deciles_long.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["metric", "decile", "range_low", "range_high", "lot_count",
                "pct_of_total", "mean", "cumulative_lot_pct"])
    for metric, buckets in result["deciles"].items():
        total_n = sum(b["n"] for b in buckets)
        cum = 0
        for b in buckets:
            cum += b["n"]
            w.writerow([
                metric, b["decile"], b["lo"], b["hi"], b["n"],
                round(100 * b["n"] / total_n, 1) if total_n else 0,
                round(b["mean"], 2),
                round(100 * cum / total_n, 1) if total_n else 0,
            ])

# ── CSV 3: lot-level — re-derive from raw transactions ──
YEARS = list(range(2019, 2026))

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

lot_rows = []
for y in YEARS:
    init = load(y, "AUCTION_INIT")
    bids = load(y, "AUCTION_BID")
    won  = load(y, "AUCTION_WON")
    # Group events by player_id
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
        if len(evs) < 2:
            continue  # nomination-only — skip per Keith
        # FA vs ERA: pre-2023 is all FA; 2023+ filter June starters as ERA
        evs.sort(key=lambda e: e["ts"])
        first = evs[0]
        first_dt = datetime.fromtimestamp(first["ts"], tz=timezone.utc)
        if y >= 2023 and first_dt.month <= 6:
            continue  # ERA-window
        # Classify each event
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
            continue  # no resolution
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

lot_rows.sort(key=lambda r: (r["year"], r["player_id"]))
with (OUT / "lot_level.csv").open("w", newline="") as f:
    w = csv.writer(f)
    w.writerow(list(lot_rows[0].keys()) if lot_rows else [])
    for r in lot_rows:
        w.writerow(list(r.values()))

# Print summary
print(f"Wrote {OUT}/per_year_summary.csv")
print(f"Wrote {OUT}/deciles_long.csv")
print(f"Wrote {OUT}/lot_level.csv ({len(lot_rows)} rows)")
