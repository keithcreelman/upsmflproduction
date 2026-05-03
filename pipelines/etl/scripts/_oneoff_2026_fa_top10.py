#!/usr/bin/env python3
"""ONE-OFF / THROWAWAY — 2026 FA top 10 per position.

Hand-calibrated SF-era logic for Keith's iteration during the bid-sheet build.
NOT part of the new Phase-3 pipeline; this gets replaced by `era_weights.py`
+ `signal_lib.py` once those land. Underscored filename = throwaway.

Reads (read-only):
  - prod snapshot from snapshot_mfl_state.py (74598)
  - local SQLite: transactions_auction (winning bids), adp_consensus, player_id_crosswalk
  - nflverse depth charts (starting QBs)

Honors invariants from memory `auction_calibration_invariants.md`:
  - Rule 1: NFL-starter QB floor (Goff/Murray/Stafford/etc all $12K min)
  - Rule 2: Top RB/WR ceiling under QB cluster pressure ($58K cap)
  - Rule 3: Smooth cluster→non-cluster gap (starter decay from cluster_min)
  - SF-era ordering invariant (top WR ≤ smallest cluster QB)
  - TE-talent-weak rule for 2026 (Pitts ~$22K not $28K)
"""
from __future__ import annotations

import json
import os
import sqlite3
import statistics
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAP_PATH = REPO_ROOT / "pipelines" / "etl" / "data" / "snapshots" / "state_snapshot_74598_latest.json"
DB_PATH = Path(os.environ.get("MFL_DB_PATH") or
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/"
    "Desktop/MFL_Scripts/Datastorage/mfl_database.db")
CACHE_DIR = REPO_ROOT / "pipelines" / "etl" / "data" / "cache"
DEPTH_CHART_CACHE = CACHE_DIR / "nfl_depth_chart_starters_2025.json"

CAP_PER_TEAM = 300_000

# --- Calibration -----------------------------------------------------
RANK_BUCKETS = [
    (1, 1, "rk1"),
    (2, 2, "rk2"),
    (3, 3, "rk3"),
    (4, 4, "rk4"),
    (5, 6, "rk5-6"),
    (7, 10, "rk7-10"),
    (11, 15, "rk11-15"),
    (16, 25, "rk16-25"),
    (26, 999, "rk26+"),
]

# QB cluster decay (cluster only). Softer than deprecated [1.00, 0.75, 0.55, ...].
# Tuned 2026-04-29 vs Keith anchors (Allen 80-90, Lamar 65-75, Burrow 65-75).
SF_CLUSTER_DECAY = [1.00, 0.92, 0.85, 0.70, 0.55]

# QB density boost — when 3+ elite QBs FA simultaneously, top tier gets a
# scarcity premium on the rk1 base. Tuned to Allen anchor 80-90 post-normalize.
SF_QB_DENSITY_BOOST = 1.15

# Non-cluster STARTER QB curve — fraction of smallest cluster QB bid.
# Tuned 2026-04-29 vs Keith anchors (Prescott 40-50, Mahomes 35-45, Goff 15-22).
NON_CLUSTER_STARTER_DECAY = [0.75, 0.65, 0.40, 0.32, 0.27, 0.22, 0.20, 0.18, 0.15, 0.12]

# NFL-starter floor for QBs (Section 6 + Keith Rule 1).
NFL_STARTER_FLOOR_QB = 12_000

# Per-position-rank ceilings (in $K). Top RB/WR shouldn't all stack at the
# same ceiling — rank-2 should already be a step down. Keith anchors:
# Taylor 43-58 (rk1), Saquon 38-50 (rk2), so rk1=$58K rk2=$50K.
TOP_RB_CEILINGS_K = {1: 58, 2: 50, 3: 44, 4: 38, 5: 30}
# WR rk2 lowered further to $40K per Keith 2026-04-30 ("Pickens meaningfully
# less than ARSB"). ARSB rk1 stays $58K (anchor target $52K).
TOP_WR_CEILINGS_K = {1: 58, 2: 40, 3: 36, 4: 28, 5: 22}
TOP_TE_CEILINGS_K = {1: 22, 2: 17, 3: 12, 4: 8, 5: 6}

# QB cluster pressure → drainage on OTHER positions' top quartile.
# VALIDATED 2026-04-29 against 15 seasons of transactions_auction.
# Only fires when QB cluster total ≥ threshold in SF era.
CLUSTER_DRAINAGE_THRESHOLD = 200_000
CLUSTER_DRAINAGE_FACTORS = {
    "RB": 1.00,   # NO drainage: data shows r=+0.38 — RB rides with QB
    "WR": 0.75,   # 25% off (Keith 2026-04-30 refined: ARSB $52K target lands
                  # here; 35% was too aggressive for the elite top-1).
    "TE": 0.85,   # softened from data's 37% (sample too small) — Keith Pitts
                  # anchor 18-24 lands at 0.85.
}

# Cluster threshold tuned for consensus_rank. Allen=1, Lamar=2, Burrow=4
# all qualify; Prescott=18 and Mahomes=24 do not.
ELITE_ADP_THRESHOLD = 5.0
QUALITY_PREMIUM_MAX = 1.20
QUALITY_PREMIUM_SLOPE = 0.15

# Expected-tag hand-list: players currently in MFL's freeAgents endpoint
# whom Keith expects to be tagged before FA Auction starts. Excluded from
# the FA pool so they don't distort the curve. Currently-tagged players
# (CMC, T.Lawrence, Brissett) are already excluded by the live MFL data.
# Keep this empty until a tag is actually placed (Keith 2026-04-30).
EXPECTED_TAGS: set[str] = set()

# TE Premium boost — REDUCED (Keith: 2026 TE FA pool talent doesn't drive prices).
TE_PREMIUM_BOOST = {"rk1": 1.00, "rk2": 0.95, "rk3": 0.95, "rk4": 1.00, "rk5-6": 1.00}

# Target = 97% of available cap, cap penalties + adjustments included.
TARGET_PCT_OF_AVAILABLE = 0.97


def bucket_for_rank(rank: int) -> str:
    for lo, hi, label in RANK_BUCKETS:
        if lo <= rank <= hi:
            return label
    return "rk26+"


# --- NFL depth chart: starting QBs (cached) -------------------------
def load_nfl_starting_qb_gsis_ids() -> set[str]:
    """Return set of gsis_ids for NFL Week-1 starting QBs (latest 2025 snapshot)."""
    if DEPTH_CHART_CACHE.exists():
        return set(json.loads(DEPTH_CHART_CACHE.read_text()))
    import nflreadpy
    import polars as pl
    df = nflreadpy.load_depth_charts(seasons=[2025])
    qbs = df.filter(pl.col("pos_abb") == "QB")
    latest = qbs.group_by("team").agg(pl.col("dt").max())
    starters = (qbs.join(latest, on=["team", "dt"], how="inner")
                  .filter(pl.col("pos_rank") == 1)
                  .select(["gsis_id"]))
    ids = [r["gsis_id"] for r in starters.iter_rows(named=True) if r["gsis_id"]]
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    DEPTH_CHART_CACHE.write_text(json.dumps(ids))
    return set(ids)


# --- Load prod snapshot --------------------------------------------
snap = json.loads(SNAP_PATH.read_text())
fa_ids = {str(p["id"]) for p in snap["free_agents"]["freeAgents"]["leagueUnit"]["player"]}

# Live cap state — Section 6.F formula
total_active_committed = 0.0
total_ir_refund = 0.0
for f in snap["rosters"]["rosters"]["franchise"]:
    pls = f.get("player", [])
    if not isinstance(pls, list):
        pls = [pls]
    for p in pls:
        s = p.get("status", "")
        sal = float(p.get("salary") or 0)
        if s == "TAXI_SQUAD":
            continue
        if s in ("INJURED_RESERVE", "IR"):
            total_active_committed += sal
            total_ir_refund += sal * 0.5
        else:
            total_active_committed += sal

adj_block = snap["salary_adjustments"].get("salaryAdjustments", {})
adj_entries = adj_block.get("salaryAdjustment", [])
if not isinstance(adj_entries, list):
    adj_entries = [adj_entries]
total_net_adjustments = sum(float(e.get("amount") or 0) for e in adj_entries)

cap_ceiling_total = 12 * CAP_PER_TEAM
total_available = (cap_ceiling_total - total_active_committed
                   + total_ir_refund + total_net_adjustments)
TARGET_TOTAL = int(total_available * TARGET_PCT_OF_AVAILABLE)

print(f"Cap ceiling (12 × $300K):     ${cap_ceiling_total:>12,.0f}")
print(f"  − active roster commit:    ${total_active_committed:>12,.0f}")
print(f"  + IR cap relief (50%):     ${total_ir_refund:>+12,.0f}")
print(f"  + net salary adjustments:  ${total_net_adjustments:>+12,.0f}")
print(f"  = available cap:           ${total_available:>12,.0f}")
print(f"Target spend ({TARGET_PCT_OF_AVAILABLE*100:.0f}% of available): "
      f"${TARGET_TOTAL:>12,}\n")

# --- Load NFL starting QBs ------------------------------------------
nfl_starter_gsis = load_nfl_starting_qb_gsis_ids()
print(f"NFL starting QBs from depth chart: {len(nfl_starter_gsis)}\n")

# --- Historical winning-bid curve ------------------------------------
conn = sqlite3.connect(DB_PATH)
rows = conn.execute("""
    SELECT season, position, bid_amount FROM transactions_auction
    WHERE auction_event_type='WON' AND finalbid_ind=1
      AND season BETWEEN 2022 AND 2025
      AND bid_amount IS NOT NULL
      AND position IN ('QB','RB','WR','TE','DE','DT','LB','S','CB','PK','PN')
""").fetchall()

by_sp = defaultdict(list)
for s, pos, bid in rows:
    by_sp[(s, pos)].append(bid)

by_pos_bucket = defaultdict(list)
for (s, pos), bids in by_sp.items():
    for rank, b in enumerate(sorted(bids, reverse=True), 1):
        by_pos_bucket[(pos, bucket_for_rank(rank))].append(b)

hist_median = {k: statistics.median(v) for k, v in by_pos_bucket.items()}

# --- Build mfl→gsis map for FA QBs ----------------------------------
xwalk = dict(conn.execute("""
    SELECT mfl_player_id, gsis_id FROM player_id_crosswalk
    WHERE gsis_id IS NOT NULL
""").fetchall())

def is_nfl_starter_qb(mfl_pid):
    g = xwalk.get(int(mfl_pid)) if str(mfl_pid).isdigit() else None
    return g in nfl_starter_gsis

# --- 2026 FA pool ---------------------------------------------------
# Use adp_consensus.consensus_rank — wider coverage than the stale
# early_projection_auction_pool_values (Prescott, Pitts, etc. are missing
# from the projection table because it was built before they hit FA).
# Sorting FAs within position by consensus_rank gives a stable FA-pool rank.
ranked_rows = conn.execute("""
    SELECT mfl_player_id, name, position, consensus_rank
    FROM adp_consensus
    WHERE season=2026 AND consensus_rank IS NOT NULL
      AND position IN ('QB','RB','WR','TE')
""").fetchall()

fa_offense = []
filtered_expected_tag = []
for pid, name, pos, c_rank in ranked_rows:
    pid_str = str(pid)
    if pid_str not in fa_ids:
        continue
    if pid_str in EXPECTED_TAGS:
        filtered_expected_tag.append((pid, name, pos))
        continue
    fa_offense.append({
        "id": pid, "name": name, "pos": pos, "adp": c_rank,
        "nfl_starter": is_nfl_starter_qb(pid) if pos == "QB" else False,
    })

if filtered_expected_tag:
    print(f"Filtered EXPECTED_TAGS (Keith's anticipated tag list):")
    for pid, name, pos in filtered_expected_tag:
        print(f"  pid={pid} {name} ({pos}) — excluded from FA pool")
    print()

# IDP/K/PN: prior-year bids by rank
def_rows = conn.execute("""
    SELECT player_id, player_name, position, bid_amount
    FROM transactions_auction
    WHERE auction_event_type='WON' AND finalbid_ind=1 AND season=2025
      AND position IN ('DE','DT','LB','S','CB','PK','PN')
    ORDER BY position, bid_amount DESC
""").fetchall()
fa_defense = []
seen_def = set()
for pid, name, pos, bid in def_rows:
    if str(pid) in fa_ids and (pid, pos) not in seen_def:
        seen_def.add((pid, pos))
        fa_defense.append({"id": pid, "name": name, "pos": pos, "prior_bid": bid})

# --- Group + rank ---------------------------------------------------
by_pos = defaultdict(list)
for p in fa_offense: by_pos[p["pos"]].append(p)
for pos in ("QB","RB","WR","TE"):
    by_pos[pos].sort(key=lambda x: x["adp"])
    for r, p in enumerate(by_pos[pos], 1):
        p["rank"] = r

for p in fa_defense:
    by_pos[p["pos"]].append(p)
for pos in ("DE","DT","LB","S","CB","PK","PN"):
    by_pos[pos].sort(key=lambda x: -x.get("prior_bid", 0))
    for r, p in enumerate(by_pos[pos], 1):
        p["rank"] = r

# --- Detect QB elite cluster -----------------------------------------
qb_cluster = [(i, p) for i, p in enumerate(by_pos["QB"]) if p["adp"] <= ELITE_ADP_THRESHOLD]
qb_cluster_size = len(qb_cluster)
qb_cluster_idx = {i for i, _ in qb_cluster}
qb_cluster_rank_map = {i: ci+1 for ci, (i, _) in enumerate(qb_cluster)}

# Median ADP per (pos, bucket) for ADP quality premium
median_adp = {}
for pos in ("QB","RB","WR","TE"):
    by_bkt = defaultdict(list)
    for r, p in enumerate(by_pos[pos], 1):
        by_bkt[bucket_for_rank(r)].append(p["adp"])
    for bkt, adps in by_bkt.items():
        median_adp[(pos, bkt)] = statistics.median(adps)


def predict_qb_bid(p, cluster_min_bid):
    """QB pricing: cluster decay for in-cluster, smooth taper for non-cluster
    starters, rank-bucket median (with floor) for backups."""
    idx = p["rank"] - 1
    if idx in qb_cluster_idx and qb_cluster_size >= 2:
        # Cluster member
        cr = qb_cluster_rank_map[idx]
        base = hist_median.get(("QB", "rk1"), 1000) * SF_QB_DENSITY_BOOST
        decay = SF_CLUSTER_DECAY[min(cr-1, len(SF_CLUSTER_DECAY)-1)]
        return max(1000, round(base * decay / 1000) * 1000)

    if p["nfl_starter"]:
        # Non-cluster starter — smooth taper from cluster_min
        # Rank within non-cluster starters
        nc_starters = [q for q in by_pos["QB"]
                       if (by_pos["QB"].index(q) not in qb_cluster_idx) and q["nfl_starter"]]
        nc_starters.sort(key=lambda x: x["adp"])
        try:
            nc_rank = nc_starters.index(p) + 1
        except ValueError:
            nc_rank = 99
        decay_idx = min(nc_rank - 1, len(NON_CLUSTER_STARTER_DECAY) - 1)
        scaled = cluster_min_bid * NON_CLUSTER_STARTER_DECAY[decay_idx]
        return max(NFL_STARTER_FLOOR_QB, round(scaled / 1000) * 1000)

    # Backup QB — rank-bucket median
    base = hist_median.get(("QB", bucket_for_rank(p["rank"])), 1000)
    return max(1000, round(base / 1000) * 1000)


def predict_skill_bid(p, pos):
    bkt = bucket_for_rank(p["rank"])
    base = hist_median.get((pos, bkt), 1000)
    adp = p["adp"]
    med = median_adp.get((pos, bkt))
    if med and adp and adp < med:
        ratio = med / adp
        prem = min(1.0 + QUALITY_PREMIUM_SLOPE * (ratio - 1.0), QUALITY_PREMIUM_MAX)
        base *= prem
    if pos == "TE":
        base *= TE_PREMIUM_BOOST.get(bkt, 1.0)
    return max(1000, round(base / 1000) * 1000)


def predict_def_bid(p, pos):
    base = hist_median.get((pos, bucket_for_rank(p["rank"])), 1000)
    return max(1000, round(base / 1000) * 1000)


# --- Compute cluster bids first to get cluster_min ------------------
# Approximate cluster_min using cluster decay.
# Cluster_min = QB rk1 historical × smallest cluster decay seen.
qb_rk1_base = hist_median.get(("QB", "rk1"), 50_000) * SF_QB_DENSITY_BOOST
cluster_min_decay = SF_CLUSTER_DECAY[min(qb_cluster_size-1, len(SF_CLUSTER_DECAY)-1)] if qb_cluster_size else 1.0
cluster_min_bid = qb_rk1_base * cluster_min_decay

# Compute all bids
for pos in ("QB",):
    for p in by_pos[pos]:
        p["bid"] = predict_qb_bid(p, cluster_min_bid)
for pos in ("RB","WR","TE"):
    for p in by_pos[pos]:
        p["bid"] = predict_skill_bid(p, pos)
for pos in ("DE","DT","LB","S","CB","PK","PN"):
    for p in by_pos[pos]:
        p["bid"] = predict_def_bid(p, pos)

# --- Apply per-rank ceilings — by FA-POOL ADP rank, not bid-sort rank
def apply_per_rank_ceilings(pos, ceilings_k: dict[int, int]):
    """Cap each player by their FA-pool ADP rank (p['rank']), not by current
    bid order. Otherwise rk2-by-ADP can catch the rk1 ceiling if its bid
    happens to be higher post-normalize."""
    for p in by_pos[pos]:
        cap_k = ceilings_k.get(p["rank"])
        if cap_k is not None and p["bid"] > cap_k * 1000:
            p["bid"] = cap_k * 1000

apply_per_rank_ceilings("RB", TOP_RB_CEILINGS_K)
apply_per_rank_ceilings("WR", TOP_WR_CEILINGS_K)
apply_per_rank_ceilings("TE", TOP_TE_CEILINGS_K)

# --- Cluster cap drainage (Keith Rule 4 — VALIDATED 2026-04-29) -----
# Trigger: 3+ elite QBs FA simultaneously in SF era ⇒ drain other positions'
# top quartile per the historical signal. Per-position factors validated
# against 2011-2025 transactions_auction (memory `auction_calibration_invariants.md`).
qb_cluster_total = sum(by_pos["QB"][i]["bid"] for i in qb_cluster_idx)
print(f"QB cluster total (top {qb_cluster_size}): ${qb_cluster_total:,}")
if qb_cluster_size >= 3:
    print(f"  Cluster size ≥ 3 in SF era — applying position-specific drainage:")
    for pos, factor in CLUSTER_DRAINAGE_FACTORS.items():
        if factor >= 0.99: continue
        # Apply only to TOP-1 (validation was strongest at top-1, fades at top-3+)
        if not by_pos[pos]: continue
        top_p = max(by_pos[pos], key=lambda x: x["bid"])
        new_bid = max(1000, round(top_p["bid"] * factor / 1000) * 1000)
        print(f"    {pos} top1 ({top_p.get('name','?')}): "
              f"${top_p['bid']:,} × {factor} = ${new_bid:,}  "
              f"({int((1-factor)*100)}% off)")
        top_p["bid"] = new_bid

# --- Budget normalize (tier-weighted, symmetric) --------------------
all_p = [p for plist in by_pos.values() for p in plist]
raw_total = sum(p["bid"] for p in all_p)
delta = TARGET_TOTAL - raw_total
print(f"\nRaw total: ${raw_total:,}; target: ${TARGET_TOTAL:,}; delta: ${delta:+,}")
if abs(delta) > 1000:
    tiers = [
        (30_000, 999_999, 1.5),
        (10_000, 30_000, 1.0),
        (5_000, 10_000, 0.5),
        (1_000, 5_000, 0.2),
    ]
    weighted = sum(p["bid"] * w for p in all_p
                   for lo, hi, w in tiers if lo <= p["bid"] < hi)
    if weighted > 0:
        adj_per = delta / weighted
        for p in all_p:
            for lo, hi, w in tiers:
                if lo <= p["bid"] < hi:
                    new_bid = p["bid"] * (1 + adj_per * w)
                    p["bid"] = max(1_000, round(new_bid / 1000) * 1000)
                    break
    new_total = sum(p["bid"] for p in all_p)
    print(f"After tier-weighted normalize: ${new_total:,}")

# Re-apply ceilings post-normalize (so upscale doesn't push past Keith's caps)
apply_per_rank_ceilings("RB", TOP_RB_CEILINGS_K)
apply_per_rank_ceilings("WR", TOP_WR_CEILINGS_K)
apply_per_rank_ceilings("TE", TOP_TE_CEILINGS_K)

# --- SF-era invariant (FINAL): top non-cluster RB/WR/TE ≤ smallest cluster QB
if qb_cluster_size >= 3:
    qb_cluster_bids = [by_pos["QB"][i]["bid"] for i in qb_cluster_idx]
    min_qb = min(qb_cluster_bids)
    for pos in ("RB", "WR", "TE"):
        if not by_pos[pos]: continue
        top_p = max(by_pos[pos], key=lambda x: x["bid"])
        if top_p["bid"] >= min_qb:
            new_bid = max(1000, ((min_qb - 1000) // 1000) * 1000)
            print(f"  invariant clamp: {top_p['name']} {pos} ${top_p['bid']:,} -> ${new_bid:,}")
            top_p["bid"] = new_bid

# --- Monotonic-by-FA-rank enforcement (skill positions only) --------
# Drainage hits top-1 only. Without this, a heavily-drained rk1 can drop
# below rk2's untouched ceiling. Skip QB — its starter-floor logic creates
# legitimate "starter > backup at lower ADP" inversions that aren't bugs.
for pos in ("RB", "WR", "TE"):
    by_rank = sorted(by_pos[pos], key=lambda p: p["rank"])
    for i in range(1, len(by_rank)):
        if by_rank[i]["bid"] > by_rank[i-1]["bid"]:
            new_bid = max(1000, ((by_rank[i-1]["bid"] - 1000) // 1000) * 1000)
            print(f"  monotonic clamp: {by_rank[i]['name']} {pos} rk{by_rank[i]['rank']} "
                  f"${by_rank[i]['bid']:,} -> ${new_bid:,} (was above rk{by_rank[i-1]['rank']})")
            by_rank[i]["bid"] = new_bid

# --- Anchors check ---------------------------------------------------
ANCHORS = {
    "Josh Allen": (80, 90),
    "Lamar Jackson": (65, 75),
    "Joe Burrow": (65, 75),
    "Patrick Mahomes II": (35, 45),
    "Dak Prescott": (40, 50),
    "Jared Goff": (15, 22),
    "Jonathan Taylor": (43, 58),
    "Saquon Barkley": (38, 50),
    "Amon-Ra St. Brown": (50, 54),  # narrowed Keith 2026-04-30: ~$52K target
    "Kyle Pitts Sr.": (18, 24),
    "Travis Kelce": (14, 18),
}

def anchor_marker(name, bid_k):
    """Match anchors using FULL anchor string (or comma-flipped form),
    anchored to start-of-name or preceded by space — prevents false
    positive like 'Hines-Allen, Josh' matching anchor 'Josh Allen'."""
    if not name: return ""
    nlo = name.lower()

    def at_word_boundary(haystack: str, needle: str) -> bool:
        idx = haystack.find(needle)
        if idx < 0: return False
        return idx == 0 or haystack[idx - 1] == " "

    matched = None
    for anchor_name in ANCHORS:
        a_lo = anchor_name.lower()
        toks = anchor_name.split()
        flipped = (", ".join([toks[-1]] + toks[:-1]).lower()
                   if len(toks) >= 2 else a_lo)
        if at_word_boundary(nlo, a_lo) or at_word_boundary(nlo, flipped):
            matched = anchor_name
            break
    if not matched: return ""
    lo, hi = ANCHORS[matched]
    if lo <= bid_k <= hi: return " ✓"
    if bid_k < lo: return f" ↑ (anchor {lo}-{hi})"
    return f" ↓ (anchor {lo}-{hi})"

# --- Print top 10 per position ---------------------------------------
def fmt_row(p, show_adp=True):
    name = (p["name"] or "?")[:27]
    adp_str = f"{p.get('adp', 999):>6.1f}" if show_adp else "    —"
    starter = " ✓ NFL" if p.get("nfl_starter") else ""
    bid_k = p["bid"] // 1000
    marker = anchor_marker(p.get("name", ""), bid_k)
    return f"  {name:<28}{adp_str}{p['rank']:>4} ${p['bid']:>8,}{starter}{marker}"

print()
for pos in ("QB","RB","WR","TE","DE","DT","LB","S","CB","PK","PN"):
    if not by_pos[pos]:
        continue
    print(f"=== Top 10 FA {pos} ===")
    print(f"  {'name':<28}{'adp':>6}{'rk':>4}{'bid':>10}")
    show_adp = pos in ("QB","RB","WR","TE")
    for p in sorted(by_pos[pos], key=lambda x: -x["bid"])[:10]:
        print(fmt_row(p, show_adp))
    pos_total = sum(p["bid"] for p in by_pos[pos])
    print(f"  ({len(by_pos[pos])} players, ${pos_total:,} total)\n")

print(f"Grand total: ${sum(p['bid'] for p in all_p):,}")
print(f"League cap available: ${total_available:,.0f}  "
      f"({sum(p['bid'] for p in all_p)/total_available*100:.1f}% of available)")
conn.close()
