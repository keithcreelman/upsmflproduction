#!/usr/bin/env python3
"""Stickiness + signal analysis for breakaway runs and receptions.

Pulls three tables from D1, then for each role+threshold combination:

  1) Stickiness: corr(rate_year_n, rate_year_{n+1}) across player-pairs
     with >= min-attempts in both seasons.
  2) Signal: corr(breakaway_rate, fpoe_per_g) — does a high breakaway
     rate predict OUTPERFORMANCE of expected fantasy points?

Reads from D1 only (no local SQLite). Prints a report. Optional:
write summary rows to metric_stickiness via the existing
build_stickiness_report.py path (NOT done here — keep this read-only).

Usage:
  python3 pipelines/etl/scripts/analyze_breakaway_signal.py
  python3 pipelines/etl/scripts/analyze_breakaway_signal.py --min-attempts 100
  python3 pipelines/etl/scripts/analyze_breakaway_signal.py --min-season 2020

Notes:
  - "rusher" role uses designed-run attempts; "receiver" uses receptions.
  - rate_N = plays_Nplus / attempts.
  - Only counts pairs of CONSECUTIVE seasons (year n and year n+1).
"""
from __future__ import annotations
import argparse
import json
import os
import statistics
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"


def wrangler_query(sql: str) -> list[dict]:
    """Run a SELECT against D1 and return rows as dicts."""
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    res = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True,
                         text=True)
    if res.returncode != 0:
        sys.exit(f"wrangler failed: {res.stderr[:1000]}")
    data = json.loads(res.stdout)
    return data[0]["results"]


def _pearson(xs, ys):
    if len(xs) < 3 or len(xs) != len(ys):
        return None
    mx = statistics.mean(xs); my = statistics.mean(ys)
    num = sum((xs[i]-mx)*(ys[i]-my) for i in range(len(xs)))
    dx = sum((v-mx)**2 for v in xs) ** 0.5
    dy = sum((v-my)**2 for v in ys) ** 0.5
    if dx == 0 or dy == 0: return None
    return num / (dx * dy)


def _spearman(xs, ys):
    if len(xs) < 3: return None
    def rank(vs):
        order = sorted(range(len(vs)), key=lambda i: vs[i])
        ranks = [0.0] * len(vs)
        for r, idx in enumerate(order):
            ranks[idx] = r + 1
        return ranks
    return _pearson(rank(xs), rank(ys))


THRESHOLDS = (15, 20, 40)


def fetch_data(min_season: int, max_season: int):
    print(f"Pulling D1 data {min_season}-{max_season}...", file=sys.stderr)
    breakaway = wrangler_query(
        f"SELECT season, gsis_id, role, attempts, yards, longest, "
        f"plays_15plus, plays_20plus, plays_40plus "
        f"FROM nfl_player_breakaway_season "
        f"WHERE season BETWEEN {min_season} AND {max_season}"
    )
    fpoe = wrangler_query(
        f"SELECT season, gsis_id, position, games, total_fp, fpoe_per_g, "
        f"rush_xfp, rush_fpoe, rec_xfp, rec_fpoe "
        f"FROM nfl_player_ff_opportunity_season "
        f"WHERE season BETWEEN {min_season} AND {max_season}"
    )
    # Per-season position from nfl_player_weekly is the SAFE source (full
    # 2018+ coverage with no NULLs). The crosswalk silently drops 60%+ of
    # pre-2022 players because gsis_ids haven't been backfilled there.
    pos_per_season = wrangler_query(
        f"SELECT season, gsis_id, position, COUNT(*) AS n "
        f"FROM nfl_player_weekly "
        f"WHERE season BETWEEN {min_season} AND {max_season} "
        f"  AND position IS NOT NULL AND position != '' "
        f"GROUP BY season, gsis_id, position"
    )
    print(f"  breakaway rows: {len(breakaway)}", file=sys.stderr)
    print(f"  ff_opportunity rows: {len(fpoe)}", file=sys.stderr)
    print(f"  per-season position rows: {len(pos_per_season)}", file=sys.stderr)
    return breakaway, fpoe, pos_per_season


def build_breakaway_index(breakaway: list[dict]) -> dict:
    """{(role, gsis_id): {season: row}}"""
    out: dict = defaultdict(dict)
    for r in breakaway:
        out[(r["role"], r["gsis_id"])][r["season"]] = r
    return out


def build_position_map(pos_per_season: list[dict], fpoe: list[dict]) -> dict:
    """(gsis_id, season) -> position. Per-season MODE from
    nfl_player_weekly (a player can switch positions year-to-year — TE→FB
    moves, etc.). Falls back to ff_opportunity's per-season position.

    Returned as a flat dict keyed by (gsis_id, season). Consumers should
    look up using the season they care about; for "career position" lookups,
    take the most recent season available."""
    # Build {(gsis_id, season): {position: count}}
    by_key: dict = defaultdict(lambda: defaultdict(int))
    for r in pos_per_season:
        if not r.get("position"): continue
        by_key[(r["gsis_id"], r["season"])][r["position"]] += r.get("n") or 1
    # MODE per (gsis_id, season)
    pos: dict = {}
    for k, counts in by_key.items():
        pos[k] = max(counts.items(), key=lambda kv: kv[1])[0]
    # Fill gaps from ff_opportunity (mostly historical)
    for r in fpoe:
        key = (r["gsis_id"], r["season"])
        if key not in pos and r.get("position"):
            pos[key] = r["position"]
    return pos


def build_fpoe_index(fpoe: list[dict]) -> dict:
    """{(gsis_id, season): row}"""
    return {(r["gsis_id"], r["season"]): r for r in fpoe}


def derive_breakaway_rates(row: dict) -> dict:
    att = row.get("attempts") or 0
    if att <= 0:
        return {}
    out = {"attempts": att, "yards_per_attempt": (row.get("yards") or 0) / att}
    for n in THRESHOLDS:
        out[f"rate_{n}plus"] = (row.get(f"plays_{n}plus") or 0) / att
    return out


# ─────────────────────────────────────────────────────────────────────────────
def _pos_at(position_map: dict, gsis_id: str, season: int) -> str | None:
    """Look up position for (gsis, season). Falls back to nearest season
    if exact match missing (handles partial-year players)."""
    if (gsis_id, season) in position_map:
        return position_map[(gsis_id, season)]
    # Walk backward up to 3 yrs, then forward
    for delta in (1, 2, 3, -1, -2, -3):
        if (gsis_id, season + delta) in position_map:
            return position_map[(gsis_id, season + delta)]
    return None


def stickiness(idx: dict, role: str, position_map: dict, target_pos: list[str],
               min_attempts: int) -> dict:
    """Return {metric: [(v0, v1, gsis_id, season_n), ...]} for the given role+pos."""
    pairs: dict = defaultdict(list)
    for (r_role, gsis_id), by_season in idx.items():
        if r_role != role:
            continue
        seasons = sorted(by_season)
        for i in range(len(seasons) - 1):
            yn, yn1 = seasons[i], seasons[i + 1]
            if yn1 != yn + 1:
                continue
            # Position check uses the EARLIER season (when we'd be making
            # the projection forward).
            if target_pos and _pos_at(position_map, gsis_id, yn) not in target_pos:
                continue
            r0, r1 = by_season[yn], by_season[yn1]
            if (r0.get("attempts") or 0) < min_attempts: continue
            if (r1.get("attempts") or 0) < min_attempts: continue
            m0 = derive_breakaway_rates(r0)
            m1 = derive_breakaway_rates(r1)
            if not m0 or not m1: continue
            for k in m0:
                if k in m1:
                    pairs[k].append((float(m0[k]), float(m1[k]), gsis_id, yn))
    return pairs


def correlation_to_fpoe(idx: dict, fpoe_idx: dict, role: str,
                        position_map: dict, target_pos: list[str],
                        min_attempts: int) -> dict:
    """Per-season correlation: breakaway_rate vs fpoe_per_g (and total_fp/g)."""
    paired: dict = defaultdict(list)  # metric -> [(rate, fpoe), ...]
    for (r_role, gsis_id), by_season in idx.items():
        if r_role != role:
            continue
        for season, brk_row in by_season.items():
            if target_pos and _pos_at(position_map, gsis_id, season) not in target_pos:
                continue
            if (brk_row.get("attempts") or 0) < min_attempts:
                continue
            f = fpoe_idx.get((gsis_id, season))
            if not f: continue
            fpg = f.get("fpoe_per_g")
            tfp = f.get("total_fp")
            games = f.get("games") or 0
            tfp_per_g = (tfp / games) if (tfp is not None and games > 0) else None
            if fpg is None and tfp_per_g is None:
                continue
            rates = derive_breakaway_rates(brk_row)
            for n in THRESHOLDS:
                rate = rates.get(f"rate_{n}plus")
                if rate is None: continue
                if fpg is not None:
                    paired[f"rate_{n}plus_vs_fpoe_per_g"].append((rate, fpg))
                if tfp_per_g is not None:
                    paired[f"rate_{n}plus_vs_fp_per_g"].append((rate, tfp_per_g))
            ypa = rates.get("yards_per_attempt")
            if ypa is not None and fpg is not None:
                paired["yards_per_attempt_vs_fpoe_per_g"].append((ypa, fpg))
    return paired


def fmt_corr(c):
    return f"{c:>+7.3f}" if c is not None else f"{'—':>7}"


def report_stickiness(label: str, pairs: dict):
    print(f"\n=== STICKINESS — {label} ===")
    print(f"  {'metric':<22} {'pearson':>9} {'spearman':>9} {'n':>5}")
    print(f"  {'-'*22} {'-'*9} {'-'*9} {'-'*5}")
    sortable = []
    for metric, plist in pairs.items():
        xs = [p[0] for p in plist]; ys = [p[1] for p in plist]
        if len(xs) < 5:
            sortable.append((metric, None, None, len(xs)))
            continue
        if len(set(xs)) <= 1 or len(set(ys)) <= 1:
            sortable.append((metric, None, None, len(xs)))
            continue
        sortable.append((metric, _pearson(xs, ys), _spearman(xs, ys), len(xs)))
    sortable.sort(key=lambda t: (t[1] is None, -(t[1] or 0)))
    for m, pe, sp, n in sortable:
        print(f"  {m:<22} {fmt_corr(pe)} {fmt_corr(sp)} {n:>5}")


def report_correlation(label: str, paired: dict):
    print(f"\n=== SIGNAL CORRELATION — {label} ===")
    print(f"  {'comparison':<38} {'pearson':>9} {'spearman':>9} {'n':>5}")
    print(f"  {'-'*38} {'-'*9} {'-'*9} {'-'*5}")
    sortable = []
    for metric, plist in paired.items():
        xs = [p[0] for p in plist]; ys = [p[1] for p in plist]
        if len(xs) < 5:
            sortable.append((metric, None, None, len(xs)))
            continue
        if len(set(xs)) <= 1 or len(set(ys)) <= 1:
            sortable.append((metric, None, None, len(xs)))
            continue
        sortable.append((metric, _pearson(xs, ys), _spearman(xs, ys), len(xs)))
    sortable.sort(key=lambda t: (t[1] is None, -(t[1] or 0)))
    for m, pe, sp, n in sortable:
        print(f"  {m:<38} {fmt_corr(pe)} {fmt_corr(sp)} {n:>5}")


def parse_args():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-season", type=int, default=2018)
    ap.add_argument("--max-season", type=int, default=2025)
    ap.add_argument("--min-rush-attempts", type=int, default=100,
                    help="Min designed carries in BOTH seasons (default 100)")
    ap.add_argument("--min-receptions", type=int, default=30,
                    help="Min receptions in BOTH seasons (default 30)")
    return ap.parse_args()


def main():
    args = parse_args()
    breakaway, fpoe, pos_per_season = fetch_data(args.min_season, args.max_season)
    pos_map = build_position_map(pos_per_season, fpoe)
    brk_idx = build_breakaway_index(breakaway)
    fpoe_idx = build_fpoe_index(fpoe)

    # ── RB rushing
    rb_pos = ["RB", "FB"]
    rb_pairs = stickiness(brk_idx, "rusher", pos_map, rb_pos, args.min_rush_attempts)
    report_stickiness(f"RB rushing (min {args.min_rush_attempts} carries / season)",
                      rb_pairs)
    rb_corr = correlation_to_fpoe(brk_idx, fpoe_idx, "rusher", pos_map, rb_pos,
                                   args.min_rush_attempts)
    report_correlation(f"RB rushing (n=player-seasons)", rb_corr)

    # ── WR receiving
    wr_pairs = stickiness(brk_idx, "receiver", pos_map, ["WR"], args.min_receptions)
    report_stickiness(f"WR receiving (min {args.min_receptions} catches / season)",
                      wr_pairs)
    wr_corr = correlation_to_fpoe(brk_idx, fpoe_idx, "receiver", pos_map, ["WR"],
                                   args.min_receptions)
    report_correlation("WR receiving", wr_corr)

    # ── TE receiving
    te_pairs = stickiness(brk_idx, "receiver", pos_map, ["TE"], args.min_receptions)
    report_stickiness(f"TE receiving (min {args.min_receptions} catches / season)",
                      te_pairs)
    te_corr = correlation_to_fpoe(brk_idx, fpoe_idx, "receiver", pos_map, ["TE"],
                                   args.min_receptions)
    report_correlation("TE receiving", te_corr)

    # ── RB receiving (pass-catching backs)
    rb_rec_pairs = stickiness(brk_idx, "receiver", pos_map, rb_pos, 20)
    report_stickiness(f"RB receiving (min 20 catches / season)", rb_rec_pairs)
    rb_rec_corr = correlation_to_fpoe(brk_idx, fpoe_idx, "receiver", pos_map, rb_pos, 20)
    report_correlation("RB receiving", rb_rec_corr)


if __name__ == "__main__":
    main()
