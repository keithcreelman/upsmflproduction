#!/usr/bin/env python3
"""Auction value model — predicts winning bids from ADP + scarcity context.

Single source of truth for UPS MFL auction projections. The previous v1
(ADP × spend pool) and v2 (compression curves) are gone — neither captured
the real driver of auction prices: scarcity of elite talent in the pool.

Method:
  1. Compute historical median winning bid per (position, era, rank-in-pool)
     from transactions_auction 2022-2025 (SF era).
  2. For each 2026 FA, find their rank within position-pool (by ADP), look
     up the historical median for that rank, apply an ADP-quality premium
     when their ADP is materially better than the historical median for
     that rank (= scarcity bonus).
  3. Apply TE Premium multiplier for 2025+ TE.
  4. For IDP/K/P (ADP doesn't differentiate them), use prior-year auction
     bids directly: rank by last year's price, use that price.

Era detection mirrors metadata_starters + scoring rules:
  PRE_SF        2010-2021  — original (QB=1, TE 1.0 PPR)
  SF_NO_TE_PREM 2022-2024  — superflex (QB 1-2), TE still 1.0 PPR
  SF_TE_PREM    2025+      — superflex + TE 1.5 PPR

Run modes:
  python3 build_auction_value_model.py --report
  python3 build_auction_value_model.py --calibrate    # show historical curves
  python3 build_auction_value_model.py --top-n 50     # detail top-50 FAs
"""
from __future__ import annotations
import argparse
import math
import os
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path
from statistics import median

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
DB_PATH = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

CAP_PER_TEAM = 300_000.49
TARGET_LEFTOVER_PER_TEAM = 7_500
DEFAULT_RESTRUCTURE_POOL = 50_000

# ---------------------------------------------------------------
# Era detection
# ---------------------------------------------------------------
SF_START      = 2022   # QB superflex (verified from metadata_starters)
TE_PREM_START = 2025   # TE 1.5 PPR (verified from metadata_rawrules)


def era_for(season: int) -> str:
    if season >= TE_PREM_START: return "SF_TE_PREM"
    if season >= SF_START:      return "SF_NO_TE_PREM"
    return "PRE_SF"


# ---------------------------------------------------------------
# Rank buckets
# ---------------------------------------------------------------
# Auction prices have a sharp top-heavy curve. Bucket so each tier has enough
# historical samples for a stable median.
RANK_BUCKETS = [
    (1, 1, "rk1"),
    (2, 2, "rk2"),
    (3, 3, "rk3"),
    (4, 4, "rk4"),       # split out from rk4-6 to handle elite-scarcity scenarios
    (5, 6, "rk5-6"),
    (7, 10, "rk7-10"),
    (11, 15, "rk11-15"),
    (16, 25, "rk16-25"),
    (26, 999, "rk26+"),
]


def bucket_for_rank(rank: int) -> str:
    for lo, hi, label in RANK_BUCKETS:
        if lo <= rank <= hi:
            return label
    return "rk26+"


# ---------------------------------------------------------------
# Historical calibration
# ---------------------------------------------------------------

def load_historical_rank_bids(conn: sqlite3.Connection
                              ) -> dict[tuple[str, str], dict]:
    """Returns {(position, bucket): {"bids": [...], "median_bid": float,
                                     "median_adp": float|None}}.

    Pulls transactions_auction joined to auction_player_value_model_v1 for ADP.
    Uses 2022-2025 (SF era). Per (position, season), ranks players by
    winning_bid descending, assigns to bucket, stores stats.
    """
    rows = conn.execute("""
        SELECT t.season, t.position, t.player_id, t.player_name, t.bid_amount,
               v.normalized_adp
        FROM transactions_auction t
        LEFT JOIN auction_player_value_model_v1 v
          ON v.season = t.season AND v.player_id = t.player_id
        WHERE t.auction_event_type='WON' AND t.finalbid_ind=1
          AND t.season BETWEEN 2022 AND 2025
          AND t.bid_amount IS NOT NULL
          AND t.position IN ('QB','RB','WR','TE','DE','DT','LB','S','CB','PK','PN')
        ORDER BY t.season, t.position, t.bid_amount DESC
    """).fetchall()

    # Build per-(season, position) ranking
    by_sp: dict[tuple, list] = defaultdict(list)
    for season, pos, pid, name, bid, adp in rows:
        by_sp[(season, pos)].append((bid, adp))

    # Now bucket and aggregate
    by_pos_bucket: dict[tuple, dict] = defaultdict(lambda: {"bids": [], "adps": []})
    for (season, pos), entries in by_sp.items():
        for rank, (bid, adp) in enumerate(entries, 1):
            bkt = bucket_for_rank(rank)
            by_pos_bucket[(pos, bkt)]["bids"].append(bid)
            if adp is not None and adp > 0:
                by_pos_bucket[(pos, bkt)]["adps"].append(adp)

    out = {}
    for key, d in by_pos_bucket.items():
        bids = d["bids"]
        adps = d["adps"]
        out[key] = {
            "n": len(bids),
            "median_bid": median(bids) if bids else 0,
            "median_adp": median(adps) if adps else None,
            "max_bid": max(bids) if bids else 0,
        }
    return out


def historical_position_totals(conn: sqlite3.Connection) -> dict[str, float]:
    """Average per-season position spend over 2022-2025 SF era."""
    rows = conn.execute("""
        SELECT season, position, SUM(bid_amount) AS spent
        FROM transactions_auction
        WHERE auction_event_type='WON' AND finalbid_ind=1
          AND season BETWEEN 2022 AND 2025
          AND position IN ('QB','RB','WR','TE','DE','DT','LB','S','CB','PK','PN')
        GROUP BY season, position
    """).fetchall()
    by_pos = defaultdict(list)
    for season, pos, spent in rows:
        by_pos[pos].append(spent)
    return {pos: sum(vals)/len(vals) for pos, vals in by_pos.items()}


# ---------------------------------------------------------------
# Bid prediction
# ---------------------------------------------------------------

# TE Premium boost — first season was 2025. Top-rank TEs got hit hardest
# (Bowers/McBride). Apply a multiplier on top of historical baseline (which
# includes 2025 itself, so the multiplier is small).
TE_PREMIUM_BOOST = {
    "rk1": 1.20, "rk2": 1.15, "rk3": 1.10,
    "rk4-6": 1.05,
}

# Quality premium scaling. When a player's ADP is materially better than
# the historical median for their rank, bid scales up. Capped tightly to
# avoid extrapolation into nonsense (e.g. Allen ADP 1.0 vs historical median 50).
QUALITY_PREMIUM_MAX = 1.20   # cap individual bid bump
QUALITY_PREMIUM_SLOPE = 0.15 # how aggressively ADP gap maps to bid bump

# Elite cluster decay: even when 4 elite QBs are all at top-2 ADP, only
# ONE team can win each. Real auctions: the team that wants Allen most
# wins him at ~$70K, Burrow goes for less because that team's already out,
# Lamar even less, Mahomes drops off because QB-needy teams are exhausted.
# Steeper than initial estimate based on Keith's 2026-04-26 calibration.
ELITE_CLUSTER_DECAY = [1.00, 0.75, 0.55, 0.35, 0.25]


# Elite cluster: when N players within a position have ADP <= ELITE_ADP_THRESHOLD,
# treat them all as "co-equal top-tier" rather than declining rank-by-rank.
# 2026 QB: Allen/Burrow/Lamar/Mahomes all at ADP 1-2 — historical rank
# bucketing under-prices ranks 2-4 because typically those are mediocre players.
ELITE_ADP_THRESHOLD = 5.0


def predict_bid(adp: float, rank: int, position: str, season: int,
                hist: dict, elite_cluster_size: int = 0,
                cluster_rank: int = 0) -> int:
    """Predict winning bid for a single FA.

    `elite_cluster_size` = how many position-mates also have ADP <= threshold.
    `cluster_rank` = rank within the elite cluster (1=best ADP among elites).
    When elite_cluster_size >= 2, ALL cluster members use rk1 bucket but
    apply ELITE_CLUSTER_DECAY by cluster_rank (best gets full price, rest
    step down — only one team can win each player).

    Returns predicted bid in dollars, integer (rounded to $1k MFL increment).
    """
    pos = (position or "").upper()

    # Elite cluster handling
    in_cluster = adp <= ELITE_ADP_THRESHOLD and elite_cluster_size >= 2
    if in_cluster:
        bkt = "rk1"
    else:
        bkt = bucket_for_rank(rank)
    key = (pos, bkt)

    if key not in hist or hist[key]["median_bid"] == 0:
        return 1000  # MFL minimum bid

    base = hist[key]["median_bid"]
    median_adp = hist[key]["median_adp"]

    # ADP quality premium — when player ADP is BETTER (lower) than historical
    # median for their rank, bid scales up
    if median_adp and adp > 0 and adp < median_adp:
        ratio = median_adp / adp   # >1 means player is better than typical
        premium = 1.0 + QUALITY_PREMIUM_SLOPE * (ratio - 1.0)
        premium = min(premium, QUALITY_PREMIUM_MAX)
        base *= premium

    # Elite cluster decay — within cluster, ranks 1/2/3/4 get 1.0/0.85/0.70/0.55
    if in_cluster and cluster_rank > 0:
        decay_idx = min(cluster_rank - 1, len(ELITE_CLUSTER_DECAY) - 1)
        base *= ELITE_CLUSTER_DECAY[decay_idx]

    # TE Premium boost (2025+)
    if pos == "TE" and era_for(season) == "SF_TE_PREM":
        base *= TE_PREMIUM_BOOST.get(bkt, 1.0)

    # Round to nearest $1k (MFL bid increment), floor at $1k minimum
    bid = max(1000, round(base / 1000) * 1000)
    return bid


# ---------------------------------------------------------------
# Cap state from live rosters
# ---------------------------------------------------------------

def load_franchise_cap_state(conn: sqlite3.Connection, season: int) -> list:
    """Returns [(fid, team_name, roster_size, locked, available), ...]."""
    week = conn.execute(
        "SELECT MAX(week) FROM rosters_current WHERE season = ?", (season,)
    ).fetchone()[0] or 1
    rows = conn.execute("""
        SELECT
          r.franchise_id,
          COALESCE(f.franchise_name, '?') AS team_name,
          COUNT(*) AS roster_size,
          SUM(r.salary) AS total_salary
        FROM rosters_current r
        LEFT JOIN metadata_franchise f
          ON f.franchise_id = r.franchise_id
         AND f.season = (SELECT MAX(season) FROM metadata_franchise)
        WHERE r.season = ? AND r.week = ?
        GROUP BY r.franchise_id
        ORDER BY total_salary DESC
    """, (season, week)).fetchall()
    return [(fid, name, n, locked, CAP_PER_TEAM - locked) for fid, name, n, locked in rows]


# ---------------------------------------------------------------
# Report
# ---------------------------------------------------------------

def cmd_calibrate(conn: sqlite3.Connection) -> None:
    """Show fitted historical bid curves per position."""
    hist = load_historical_rank_bids(conn)
    print(f"\n{'='*72}")
    print("  HISTORICAL RANK-ANCHORED BIDS (SF era 2022-2025)")
    print(f"{'='*72}")
    print(f"  {'pos':<4} {'bucket':<10} {'n':>4} {'med_bid':>9} {'max':>8} {'med_adp':>8}")
    print(f"  {'-'*4} {'-'*10} {'-'*4} {'-'*9} {'-'*8} {'-'*8}")
    for pos in ['QB','RB','WR','TE','DE','DT','LB','S','CB','PK','PN']:
        for _, _, bkt in RANK_BUCKETS:
            key = (pos, bkt)
            if key not in hist: continue
            d = hist[key]
            adp_s = f"{d['median_adp']:.1f}" if d['median_adp'] else "—"
            print(f"  {pos:<4} {bkt:<10} {d['n']:>4} ${d['median_bid']:>8,.0f} "
                  f"${d['max_bid']:>7,.0f} {adp_s:>8}")
        print()


def load_fa_pool(conn: sqlite3.Connection, season: int) -> list[dict]:
    """Returns [{"name", "pos", "adp", ...}, ...] sorted by position then ADP."""
    rows = conn.execute("""
        SELECT player_name, position, normalized_adp AS adp
        FROM early_projection_auction_pool_values
        WHERE projection_season = ?
        ORDER BY position, COALESCE(normalized_adp, 999)
    """, (season,)).fetchall()
    return [{"name": r[0], "pos": (r[1] or "?").upper(), "adp": r[2] or 999} for r in rows]


def cmd_report(conn: sqlite3.Connection, args) -> None:
    season = args.season
    print(f"\n{'='*78}")
    print(f"  AUCTION VALUE REPORT — {season}")
    print(f"{'='*78}")
    print(f"  Era: {era_for(season)}\n")

    # ---- 1. Load historical baseline + 2026 FA pool ----
    hist = load_historical_rank_bids(conn)
    fa_pool = load_fa_pool(conn, season)
    if not fa_pool:
        sys.exit(f"No FA pool found for {season}. Run build_early_projection.py first.")
    print(f"  Free agents in pool: {len(fa_pool)}")

    # ---- 2. Predict bids ----
    # Sort each position by ADP, assign rank, predict
    by_pos = defaultdict(list)
    for fa in fa_pool:
        by_pos[fa["pos"]].append(fa)
    for pos, players in by_pos.items():
        players.sort(key=lambda p: p["adp"])
        # Detect elite cluster: players with ADP <= ELITE_ADP_THRESHOLD
        elite_cluster = [i for i, p in enumerate(players) if p["adp"] <= ELITE_ADP_THRESHOLD]
        elite_cluster_size = len(elite_cluster)
        # Map player index → cluster rank (1-indexed within cluster)
        cluster_rank_map = {idx: ci + 1 for ci, idx in enumerate(elite_cluster)}
        for rank, p in enumerate(players, 1):
            p["rank"] = rank
            p["cluster_rank"] = cluster_rank_map.get(rank - 1, 0)
            p["bid"] = predict_bid(
                p["adp"], rank, pos, season, hist,
                elite_cluster_size=elite_cluster_size,
                cluster_rank=p["cluster_rank"],
            )

    # ---- 3. Cap state (compute first so we can budget-normalize) ----
    franchises = load_franchise_cap_state(conn, season)
    total_cap = sum(CAP_PER_TEAM for _ in franchises)
    total_locked = sum(r[3] for r in franchises)
    total_available_raw = total_cap - total_locked
    total_available = total_available_raw + args.restructure_pool
    target_spend = total_available - (TARGET_LEFTOVER_PER_TEAM * len(franchises))

    # ---- 4. Position totals + budget normalization ----
    pos_total = {p: sum(x["bid"] for x in by_pos[p]) for p in by_pos}
    hist_avg = historical_position_totals(conn)
    raw_grand_total = sum(pos_total.values())

    # If raw exceeds target, scale TIER-WEIGHTED — top bids absorb more
    # of the cut than mid-tier (preserves the realistic "top guys come down
    # to fit budget" pattern, vs flat-rescale which compresses everything).
    # Tiers: $30k+ scaled most, $10-30k less, $5-10k least, <$5k untouched.
    if raw_grand_total > target_spend:
        excess = raw_grand_total - target_spend
        tiers = [
            (30_000, 999_999, 1.5),  # top tier: 1.5× the share of cut
            (10_000, 30_000,  1.0),  # mid tier: baseline
            ( 5_000, 10_000,  0.5),  # low tier: half share
        ]
        # Compute weighted total
        weighted_total = 0
        for plist in by_pos.values():
            for p in plist:
                for lo, hi, w in tiers:
                    if lo <= p["bid"] < hi:
                        weighted_total += p["bid"] * w
                        break
        if weighted_total > 0:
            cut_per_dollar = excess / weighted_total
            for plist in by_pos.values():
                for p in plist:
                    for lo, hi, w in tiers:
                        if lo <= p["bid"] < hi:
                            new_bid = p["bid"] * (1 - cut_per_dollar * w)
                            p["bid"] = max(5_000, round(new_bid / 1000) * 1000)
                            break
        # Recompute totals
        pos_total = {p: sum(x["bid"] for x in by_pos[p]) for p in by_pos}

    grand_total = sum(pos_total.values())

    # ---- Position rollup (post-normalization) ----
    print(f"\n{'─'*78}")
    print(f"  POSITION SPEND ROLLUP (final, after budget fit)")
    print(f"{'─'*78}")
    print(f"  {'pos':<5} {'count':>6} {'predicted':>12} {'4yr_avg':>11} {'Δ':>11}")
    print(f"  {'-'*5} {'-'*6} {'-'*12} {'-'*11} {'-'*11}")
    for pos in ['QB','RB','WR','TE','DE','DT','LB','S','CB','PK','PN']:
        if pos not in by_pos: continue
        n = len(by_pos[pos])
        pred = pos_total[pos]
        h = hist_avg.get(pos, 0)
        delta = pred - h
        print(f"  {pos:<5} {n:>6} ${pred:>11,.0f} ${h:>10,.0f} {delta:>+11,.0f}")
    print(f"  {'-'*5} {'-'*6} {'-'*12} {'-'*11}")
    print(f"  {'TOTAL':<5} {sum(len(v) for v in by_pos.values()):>6} ${grand_total:>11,.0f}")

    # ---- 5. Print cap state ----
    print(f"\n{'─'*78}")
    print(f"  FRANCHISE CAP STATE — {len(franchises)} teams (LIVE rosters)")
    print(f"{'─'*78}")
    print(f"  {'fid':<5} {'team':<22} {'roster':>6} {'locked':>11} {'available':>11}")
    print(f"  {'-'*5} {'-'*22} {'-'*6} {'-'*11} {'-'*11}")
    for fid, name, n, locked, avail in franchises:
        print(f"  {fid:<5} {(name or '?')[:21]:<22} {n:>6} "
              f"${locked:>10,.0f} ${avail:>10,.0f}")

    print(f"\n{'─'*78}")
    print(f"  CAP VALIDATION")
    print(f"{'─'*78}")
    print(f"  Cap per team:                  ${CAP_PER_TEAM:>13,.2f}")
    print(f"  Total cap (× {len(franchises)}):                ${total_cap:>13,.0f}")
    print(f"  Total locked:                  ${total_locked:>13,.0f}  "
          f"({total_locked/total_cap*100:5.1f}%)")
    print(f"  Available (raw):               ${total_available_raw:>13,.0f}")
    if args.restructure_pool:
        print(f"  + restructure pool:            ${args.restructure_pool:>13,.0f}")
    print(f"  Total available:               ${total_available:>13,.0f}")
    print(f"  Target spend (5-10K reserve):  ${target_spend:>13,.0f}")
    print(f"  Raw model bids (pre-budget):   ${raw_grand_total:>13,.0f}")
    print(f"  Final predicted bids:          ${grand_total:>13,.0f}  "
          f"({grand_total/total_available*100:5.1f}% of available)")
    leftover = total_available - grand_total
    avg_left = leftover / len(franchises)
    print(f"  Implied leftover per team:     ${avg_left:>13,.0f}  (target: $5-10K avg, "
          f"but cap-tight teams may spend less)")

    # Reality check: total spend should be in the $1.0-1.4M range based on
    # historical SF-era totals ($853K-$1,270K). Outside that, flag.
    if grand_total > total_available:
        print(f"\n  ⚠️  OVERSPEND: ${grand_total - total_available:,.0f} above available cap")
    elif grand_total < 950_000:
        print(f"\n  ⚠️  LOW: ${grand_total:,.0f} is below historical SF-era floor "
              f"(~$850-1,270K range)")
    elif grand_total > 1_400_000:
        print(f"\n  ℹ️   HIGH: ${grand_total:,.0f} above historical SF-era ceiling — "
              f"reasonable for unprecedented elite-FA year")
    else:
        print(f"\n  ✅  HEALTHY: ${grand_total:,.0f} total within SF-era historical range "
              f"(${950}K - $1,270K)")

    # ---- 5. Top-N detailed list ----
    all_predicted = sorted(
        (p for plist in by_pos.values() for p in plist),
        key=lambda x: -x["bid"],
    )
    print(f"\n{'─'*78}")
    print(f"  TOP {args.top_n} FREE AGENTS — predicted bids")
    print(f"{'─'*78}")
    print(f"  {'#':>3} {'name':<24} {'pos':<5} {'adp':>6} {'rk':>4} {'bid':>9}")
    cumulative = 0
    for i, p in enumerate(all_predicted[:args.top_n], 1):
        cumulative += p["bid"]
        print(f"  {i:>3} {(p['name'] or '?')[:23]:<24} {p['pos']:<5} "
              f"{p['adp']:>6.1f} {p['rank']:>4} ${p['bid']:>8,.0f}")
    pct_of_avail = cumulative / total_available * 100
    print(f"  {'─'*3} {'─'*24} {'─'*5} {'─'*6} {'─'*4} {'─'*9}")
    print(f"  Top {args.top_n} cumulative: ${cumulative:,.0f}  "
          f"({pct_of_avail:.1f}% of available)")

    # ---- 6. By position ----
    if args.by_position is not None:
        thr = args.by_position
        print(f"\n{'─'*78}")
        print(f"  ALL PLAYERS BY POSITION  (predicted bid >= ${thr:,})")
        print(f"{'─'*78}")
        for pos in ['QB','RB','WR','TE','DE','DT','LB','S','CB','PK','PN']:
            if pos not in by_pos: continue
            filtered = [p for p in by_pos[pos] if p["bid"] >= thr]
            if not filtered: continue
            print(f"\n  {pos}  ({len(filtered)} players, ${sum(x['bid'] for x in filtered):,.0f} total)")
            print(f"  {'#':>3} {'name':<24} {'adp':>6} {'rk':>4} {'bid':>9}")
            for i, p in enumerate(filtered, 1):
                print(f"  {i:>3} {(p['name'] or '?')[:23]:<24} "
                      f"{p['adp']:>6.1f} {p['rank']:>4} ${p['bid']:>8,.0f}")

    print(f"\n{'='*78}\n")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--report", action="store_true", help="Run the full report (default)")
    ap.add_argument("--calibrate", action="store_true",
                    help="Show fitted historical curves only")
    ap.add_argument("--top-n", type=int, default=30)
    ap.add_argument("--by-position", type=int, default=None, metavar="MIN_BID",
                    help="Show all players by position with predicted bid >= MIN_BID")
    ap.add_argument("--restructure-pool", type=int, default=DEFAULT_RESTRUCTURE_POOL,
                    help=f"Extra cap from restructures (default ${DEFAULT_RESTRUCTURE_POOL:,})")
    args = ap.parse_args()

    if not DB_PATH.exists():
        sys.exit(f"DB missing at {DB_PATH}")

    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA busy_timeout=30000")

    if args.calibrate:
        cmd_calibrate(conn)
    else:
        cmd_report(conn, args)


if __name__ == "__main__":
    main()
