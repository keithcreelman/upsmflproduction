#!/usr/bin/env python3
"""Actionable breakaway-driven 2026 target/fade list.

Cross-references 2024 + 2025 breakaway-rate data with fantasy-points-over-
expected (fpoe) and current MFL salaries to surface four buckets:

  [1] CONFIRMED ELITES   — top-quartile breakaway rate in BOTH 2024 + 2025
                            (highest-confidence repeat candidates)
  [2] POSITIVE REGRESSION — elite 2025 rate but underperformed fpoe
                            (skill signal says they'll catch up)
  [3] NEGATIVE REGRESSION — high 2025 fpoe with weak breakaway signal
                            (overperformed without the underlying skill)
  [4] EMERGING            — small-sample 2025 with elite rate
                            (rookie/year-2 sleepers)

Uses per-season position from nfl_player_weekly (NOT crosswalk —
crosswalk has 60% miss-rate pre-2022). Salary from src_contracts (2025
contracts roll into 2026 for un-expired deals).

Usage:
  python3 pipelines/etl/scripts/target_breakaway_picks.py
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_DIR = REPO_ROOT / "worker"

# Config
ROLE_THRESHOLDS = {
    # role -> (position list, breakaway-rate column, min attempts/season)
    "rb_rush":  (["RB", "FB"],              "rate_20plus", 100),
    "wr_rec":   (["WR"],                    "rate_15plus", 30),
    "te_rec":   (["TE"],                    "rate_20plus", 30),
}


def wrangler_query(sql: str) -> list[dict]:
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    res = subprocess.run(cmd, cwd=str(WORKER_DIR), capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"wrangler failed: {res.stderr[:1000]}")
    return json.loads(res.stdout)[0]["results"]


def pull_data():
    print("Pulling D1 data...", file=sys.stderr)
    breakaway = wrangler_query(
        "SELECT season, gsis_id, role, attempts, yards, longest, "
        "plays_15plus, plays_20plus, plays_40plus "
        "FROM nfl_player_breakaway_season WHERE season >= 2018"
    )
    fpoe = wrangler_query(
        "SELECT season, gsis_id, position, games, total_fp, fpoe_per_g "
        "FROM nfl_player_ff_opportunity_season WHERE season >= 2018"
    )
    weekly_pos = wrangler_query(
        "SELECT season, gsis_id, position, COUNT(*) AS n FROM nfl_player_weekly "
        "WHERE season >= 2018 AND position IS NOT NULL AND position != '' "
        "GROUP BY season, gsis_id, position"
    )
    xwalk = wrangler_query(
        "SELECT gsis_id, mfl_player_id, full_name FROM player_id_crosswalk "
        "WHERE gsis_id IS NOT NULL"
    )
    contracts = wrangler_query(
        "SELECT season, player_id, salary, team_name FROM src_contracts "
        "WHERE season = 2025 AND salary > 0"
    )
    print(f"  breakaway: {len(breakaway)}, fpoe: {len(fpoe)}, "
          f"weekly_pos: {len(weekly_pos)}, xwalk: {len(xwalk)}, "
          f"contracts: {len(contracts)}", file=sys.stderr)
    return breakaway, fpoe, weekly_pos, xwalk, contracts


def build_pos_map(weekly_pos):
    """{(gsis_id, season): MODE position}"""
    by_key = defaultdict(lambda: defaultdict(int))
    for r in weekly_pos:
        by_key[(r["gsis_id"], r["season"])][r["position"]] += r["n"] or 1
    return {k: max(v.items(), key=lambda kv: kv[1])[0] for k, v in by_key.items()}


def derive_rate(row, key):
    att = row.get("attempts") or 0
    if att <= 0: return None
    plays = row.get(key.replace("rate_", "plays_")) or 0
    return plays / att


def percentile(values, p):
    """p in 0-100. Returns the value at that percentile."""
    if not values: return None
    s = sorted(values)
    idx = (p / 100) * (len(s) - 1)
    lo = int(idx); hi = min(lo + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def fmt_money(v):
    if v is None: return "—"
    return f"${v:,}"


def name_for(gsis_id, xwalk_idx):
    return xwalk_idx.get(gsis_id, {}).get("full_name") or "?"


def salary_for(gsis_id, xwalk_idx, salary_idx):
    mfl = xwalk_idx.get(gsis_id, {}).get("mfl_player_id")
    if mfl is None: return None
    return (salary_idx.get(str(mfl)) or {}).get("salary")


def team_for(gsis_id, xwalk_idx, salary_idx):
    mfl = xwalk_idx.get(gsis_id, {}).get("mfl_player_id")
    if mfl is None: return None
    return (salary_idx.get(str(mfl)) or {}).get("team_name")


def section(title):
    print(f"\n{'═' * 78}")
    print(f" {title}")
    print('═' * 78)


def main():
    breakaway, fpoe, weekly_pos, xwalk, contracts = pull_data()
    pos_map = build_pos_map(weekly_pos)
    xwalk_idx = {r["gsis_id"]: r for r in xwalk}
    # Coerce contracts.player_id (TEXT) to match crosswalk.mfl_player_id (INTEGER)
    salary_idx = {str(r["player_id"]): r for r in contracts}
    fpoe_idx = {(r["gsis_id"], r["season"]): r for r in fpoe}

    # Index breakaway: {(role, gsis): {season: row}}
    brk_idx = defaultdict(dict)
    for r in breakaway:
        brk_idx[(r["role"], r["gsis_id"])][r["season"]] = r

    # ── Compute per-bucket rosters
    for bucket_label, (positions, rate_col, min_att) in ROLE_THRESHOLDS.items():
        role = "rusher" if "rush" in bucket_label else "receiver"
        # 1) Build the universe — players with the position in 2025 (or 2024 if 2025 missing)
        # 2) Compute 2024 + 2025 breakaway rate + fpoe_per_g
        pos_label = "/".join(positions)
        section(f"=== {bucket_label.upper()} ({pos_label}, "
                f"{rate_col}, min {min_att} {role[:-1] + 's'}) ===")

        rows_for_thresholds = []  # (gsis, name, salary, team, rate24, rate25, att24, att25, fpoe25, fp25_pg)
        for (r_role, gsis_id), by_season in brk_idx.items():
            if r_role != role:
                continue
            pos25 = pos_map.get((gsis_id, 2025))
            pos24 = pos_map.get((gsis_id, 2024))
            if pos25 not in positions and pos24 not in positions:
                continue
            r24 = by_season.get(2024)
            r25 = by_season.get(2025)
            rate24 = derive_rate(r24, rate_col) if r24 and (r24.get("attempts") or 0) >= min_att else None
            rate25 = derive_rate(r25, rate_col) if r25 and (r25.get("attempts") or 0) >= min_att else None
            f25 = fpoe_idx.get((gsis_id, 2025)) or {}
            fpoe25 = f25.get("fpoe_per_g")
            tfp = f25.get("total_fp")
            games = f25.get("games") or 0
            fp25_pg = (tfp / games) if (tfp is not None and games > 0) else None
            att24 = (r24 or {}).get("attempts") or 0
            att25 = (r25 or {}).get("attempts") or 0
            sal = salary_for(gsis_id, xwalk_idx, salary_idx)
            team = team_for(gsis_id, xwalk_idx, salary_idx)
            rows_for_thresholds.append({
                "gsis_id": gsis_id,
                "name": name_for(gsis_id, xwalk_idx),
                "salary": sal,
                "team": team,
                "rate24": rate24, "rate25": rate25,
                "att24": att24, "att25": att25,
                "fpoe25": fpoe25, "fp25_pg": fp25_pg,
            })

        # Compute thresholds (top quartile) on 2025 rate among players meeting min_att
        rate25_pop = [x["rate25"] for x in rows_for_thresholds if x["rate25"] is not None]
        rate24_pop = [x["rate24"] for x in rows_for_thresholds if x["rate24"] is not None]
        fpoe_pop = [x["fpoe25"] for x in rows_for_thresholds if x["fpoe25"] is not None]
        fp_pop = [x["fp25_pg"] for x in rows_for_thresholds if x["fp25_pg"] is not None]
        rate25_p75 = percentile(rate25_pop, 75) or 0
        rate25_p90 = percentile(rate25_pop, 90) or 0
        rate24_p75 = percentile(rate24_pop, 75) or 0
        rate25_p25 = percentile(rate25_pop, 25) or 0
        fpoe_p25 = percentile(fpoe_pop, 25) or 0
        fpoe_p75 = percentile(fpoe_pop, 75) or 0
        fp_p75 = percentile(fp_pop, 75) or 0

        print(f" 2025 {rate_col} thresholds: p75={rate25_p75:.4f}  p90={rate25_p90:.4f}")
        print(f" 2025 fpoe_per_g thresholds: p25={fpoe_p25:+.2f}  p75={fpoe_p75:+.2f}")

        # [1] CONFIRMED ELITES — both years top quartile
        confirmed = [x for x in rows_for_thresholds
                     if x["rate24"] is not None and x["rate25"] is not None
                     and x["rate24"] >= rate24_p75 and x["rate25"] >= rate25_p75]
        confirmed.sort(key=lambda x: -(x["rate25"] or 0))
        print(f"\n [1] CONFIRMED ELITES ({len(confirmed)} players — top-quartile in BOTH 2024 + 2025)")
        print(f"     {'name':<22} {'team':<10} {'salary':>9}   {'r24':>7} {'r25':>7}  "
              f"{'att24':>5} {'att25':>5}  {'fpoe25':>7}")
        for x in confirmed:
            print(f"     {x['name'][:22]:<22} {(x['team'] or '?')[:10]:<10} "
                  f"{fmt_money(x['salary']):>9}   "
                  f"{x['rate24']:>7.4f} {x['rate25']:>7.4f}  "
                  f"{x['att24']:>5} {x['att25']:>5}  "
                  f"{(x['fpoe25'] if x['fpoe25'] is not None else 0):>+7.2f}")

        # [2] POSITIVE REGRESSION — elite 2025 rate AND fpoe in bottom quartile
        pos_reg = [x for x in rows_for_thresholds
                   if x["rate25"] is not None and x["fpoe25"] is not None
                   and x["rate25"] >= rate25_p75 and x["fpoe25"] <= fpoe_p25]
        pos_reg.sort(key=lambda x: -(x["rate25"] or 0))
        print(f"\n [2] POSITIVE REGRESSION ({len(pos_reg)} players — top-quartile rate, bottom-quartile fpoe)")
        print(f"     They broke long plays but didn't get fantasy credit. "
              f"Volume / situation should catch up.")
        print(f"     {'name':<22} {'team':<10} {'salary':>9}   {'r25':>7} "
              f"{'att25':>5}  {'fpoe25':>7} {'fp/g':>6}")
        for x in pos_reg:
            print(f"     {x['name'][:22]:<22} {(x['team'] or '?')[:10]:<10} "
                  f"{fmt_money(x['salary']):>9}   "
                  f"{x['rate25']:>7.4f} {x['att25']:>5}  "
                  f"{x['fpoe25']:>+7.2f} "
                  f"{(x['fp25_pg'] if x['fp25_pg'] is not None else 0):>6.1f}")

        # [3] NEGATIVE REGRESSION — high 2025 fpoe AND rate in bottom quartile
        neg_reg = [x for x in rows_for_thresholds
                   if x["rate25"] is not None and x["fpoe25"] is not None
                   and x["rate25"] <= rate25_p25 and x["fpoe25"] >= fpoe_p75]
        neg_reg.sort(key=lambda x: -(x["fpoe25"] or 0))
        print(f"\n [3] NEGATIVE REGRESSION ({len(neg_reg)} players — bottom-quartile rate, top-quartile fpoe)")
        print(f"     Got 2025 production WITHOUT the breakaway signal. Likely fades.")
        print(f"     {'name':<22} {'team':<10} {'salary':>9}   {'r25':>7} "
              f"{'att25':>5}  {'fpoe25':>7} {'fp/g':>6}")
        for x in neg_reg:
            print(f"     {x['name'][:22]:<22} {(x['team'] or '?')[:10]:<10} "
                  f"{fmt_money(x['salary']):>9}   "
                  f"{x['rate25']:>7.4f} {x['att25']:>5}  "
                  f"{x['fpoe25']:>+7.2f} "
                  f"{(x['fp25_pg'] if x['fp25_pg'] is not None else 0):>6.1f}")

        # [4] EMERGING — small sample 2025 with elite rate (below min_att, but >= half)
        # Re-pull these from raw breakaway since they were filtered out above
        emerging = []
        for (r_role, gsis_id), by_season in brk_idx.items():
            if r_role != role:
                continue
            pos25 = pos_map.get((gsis_id, 2025))
            if pos25 not in positions:
                continue
            r25 = by_season.get(2025)
            if not r25: continue
            att = r25.get("attempts") or 0
            if att < min_att / 3 or att >= min_att:
                # Below 1/3 is too noisy; >= min_att is already in main set
                continue
            rate = derive_rate(r25, rate_col)
            if rate is None or rate < rate25_p90: continue
            emerging.append({
                "gsis_id": gsis_id,
                "name": name_for(gsis_id, xwalk_idx),
                "salary": salary_for(gsis_id, xwalk_idx, salary_idx),
                "team": team_for(gsis_id, xwalk_idx, salary_idx),
                "rate25": rate, "att25": att,
            })
        emerging.sort(key=lambda x: -(x["rate25"] or 0))
        print(f"\n [4] EMERGING ({len(emerging)} players — small-sample 2025 with elite rate)")
        print(f"     Below volume threshold but above-90th-pct rate. Sleeper sample.")
        print(f"     {'name':<22} {'team':<10} {'salary':>9}   {'r25':>7} {'att25':>5}")
        for x in emerging[:20]:
            print(f"     {x['name'][:22]:<22} {(x['team'] or '?')[:10]:<10} "
                  f"{fmt_money(x['salary']):>9}   "
                  f"{x['rate25']:>7.4f} {x['att25']:>5}")


if __name__ == "__main__":
    main()
