#!/usr/bin/env python3
"""ACCEPTANCE GATE: reproduce realized UPS IDP points from what D1 actually stores.

WHY THIS EXISTS
---------------
The 2026-08-04 tackle investigation established that aggregate column sums are
sufficient to DETECT a data defect and insufficient to DIAGNOSE one. The
proposed alias-only fix looked ~95% effective on 2025 aggregates and would in
fact have made the database WORSE than the bug it repaired (2025 IDP MAE
0.81 -> 1.63). Only points-level reconstruction against src_weekly caught it.

So: points-level reconstruction against src_weekly is the standing acceptance
gate for every Phase 0 data-remediation item.

Note that pipelines/etl/scripts/validate_scoring_alignment.py reads nflverse
DIRECTLY and never touches D1 — it therefore CANNOT detect a regression in the
stored table. This script deliberately reads only D1, which is what the model
will consume.

THE TEST
--------
"Pure-tackle weeks": src_weekly IDP rows where every non-tackle defensive event
is zero (sacks, TFL, QB hits, passes defended, INTs, fumble recoveries, forced
fumbles, defensive TDs). On those weeks the UPS score must equal exactly

    TK * tk_rate + AS * as_rate

with, per UPS 2025 mfl_scoring_rules:
    DL (DT|DE): TK 1.5  AS 0.5
    DB (CB|S):  TK 1.3  AS 0.8
    LB:         TK 1.0  AS 0.5
and the corrected tackle semantics (see worker/migrations/0114):
    TK = nfl_player_weekly.def_tackles_solo + nfl_player_weekly_ext.def_tackles_with_assist
    AS = nfl_player_weekly.def_tackles_ast

GATE: mean |gap| < 0.10 UPS points per player-week, per position.

Do NOT tighten this to zero. A small negative residual survives in every season
(return yardage, distance-scaled defensive TDs, blocked kicks credited to the
blocker, and MFL's 1-decimal rounding are all still unmodelled). See
docs/MODEL_RESEARCH_AND_DATA_AUDIT.md Appendix C.

CAVEAT: src_weekly.pos_group labels drift — 2023 and earlier use 'CB+S'/'DT+DE'
where 2024+ use 'DB'/'DL', and UPS ran a single IDP slot before 2024 so earlier
seasons carry LB rows almost exclusively. The season filter here normalises the
labels; a naive `IN ('DL','LB','DB')` silently returns LB-only rows for 2023.

Usage:
  python3 pipelines/etl/scripts/validate_ups_idp_reconstruction.py --season 2025
  python3 pipelines/etl/scripts/validate_ups_idp_reconstruction.py --season 2018-2025
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path

WORKER = Path(__file__).resolve().parents[3] / "worker"
GATE = 0.10

# Cohorts smaller than this are reported but EXCLUDED from the pass/fail verdict.
# UPS ran a single IDP starter slot before 2024, so pre-2018 DL and DB cohorts
# are 13-30 player-weeks — two outliers move the mean by a full point. Reporting
# those as FAIL is noise; reporting them as PASS would be a fail-open. They are
# reported as INSUFFICIENT and counted separately, so a run can never claim a
# clean pass while silently resting on empty cohorts.
MIN_N = 100

# UPS IDP rates are ERA-DEPENDENT. The 2018 rebalance (confirmed in
# mfl_scoring_rules and docs/league_context_v1.md §4) raised DL and DB tackle
# scoring while LB stayed flat:
#     DB (CB,S): AS 0.5 -> 0.8, TK 1.0 -> 1.3
#     DL (DT,DE): TK 1.0 -> 1.5
# Applying 2025 rates to a 2015 season would manufacture a fake gap, so the
# rates are selected by season here rather than hardcoded.
RATES_2018_PLUS = {"DL": (1.5, 0.5), "DB": (1.3, 0.8), "LB": (1.0, 0.5)}
RATES_PRE_2018 = {"DL": (1.0, 0.5), "DB": (1.0, 0.5), "LB": (1.0, 0.5)}


def rates_for(season: int) -> dict:
    return RATES_2018_PLUS if season >= 2018 else RATES_PRE_2018

SQL = """
WITH idp AS (
  SELECT
    w.season, w.week, w.player_id, w.score,
    CASE
      WHEN w.pos_group IN ('DL','DT+DE','DT','DE') THEN 'DL'
      WHEN w.pos_group IN ('DB','CB+S','CB','S')   THEN 'DB'
      WHEN w.pos_group = 'LB'                      THEN 'LB'
    END AS pos,
    COALESCE(n.def_tackles_solo,0) + COALESCE(x.def_tackles_with_assist,0) AS tk,
    COALESCE(n.def_tackles_ast,0) AS asst,
    -- Return game (UPS KY *.025 / UY *.05 / PR). NOT filtered out by the
    -- pure-tackle predicate below, because returns are not defensive stats —
    -- so a gunner or return-specialist DB lands in the cohort carrying points
    -- the tackle terms cannot explain. Before these columns existed (migration
    -- 0117) that showed up as an unexplained DB residual. Punt-return TDs are
    -- credited at the 6-point tier; the 50+ yard 7-point tier needs the return
    -- DISTANCE, which is only in PBP (Appendix C item C10), as are kickoff
    -- return TDs (nflverse has no kickoff_return_tds column at all).
    COALESCE(x.kickoff_return_yards,0)*0.025
      + COALESCE(x.punt_return_yards,0)*0.05
      + COALESCE(x.punt_return_tds,0)*6.0 AS ret_pts
  FROM src_weekly w
  -- IDENTITY JOIN — ff_player_ids FIRST, player_id_crosswalk only as fallback.
  -- The crosswalk is built from MFL's CURRENT player list, so it covers just
  -- 6.3% of 2014 src_weekly rows, 53.5% of 2020 and 80.6% of 2022 (vs 99.7% in
  -- 2025). Using it for historical work would silently cap the usable backtest
  -- at 2023+ AND bias every earlier season toward long-career players — the
  -- exact population whose breakouts we are trying to predict. ff_player_ids
  -- carries 99.6-100% in every season 2014-2025.
  --
  -- The LIKE '00-%' guard is NOT cosmetic: ff_player_ids stores R's missing
  -- value as the literal STRING "NA" (4,740 of 12,468 rows are "NA" or a
  -- college/PFR-style short id like "MEN516487"). "NA" passes IS NOT NULL and
  -- passes != '', so an unguarded join reports 100% coverage while silently
  -- matching garbage. Fail closed on the format.
  LEFT JOIN ff_player_ids f ON f.mfl_id = CAST(w.player_id AS TEXT)
  LEFT JOIN player_id_crosswalk c ON c.mfl_player_id = w.player_id
  JOIN nfl_player_weekly n
    ON n.gsis_id = CASE
         WHEN COALESCE(f.gsis_id,'') LIKE '00-%' THEN f.gsis_id
         WHEN COALESCE(c.gsis_id,'') LIKE '00-%' THEN c.gsis_id
       END
   AND n.season = w.season AND n.week = w.week
  LEFT JOIN nfl_player_weekly_ext x
    ON x.gsis_id = n.gsis_id AND x.season = n.season AND x.week = n.week
  WHERE w.season = {season}
    AND COALESCE(n.def_sacks,0)=0     AND COALESCE(n.def_tfl,0)=0
    AND COALESCE(n.def_qb_hits,0)=0   AND COALESCE(n.def_pass_def,0)=0
    AND COALESCE(n.def_ints,0)=0      AND COALESCE(n.def_fr,0)=0
    AND COALESCE(n.def_ff,0)=0        AND COALESCE(n.def_tds,0)=0
)
SELECT pos, COUNT(*) AS n,
       ROUND(AVG(score),4) AS actual,
       ROUND(AVG(tk),4) AS avg_tk, ROUND(AVG(asst),4) AS avg_as,
       ROUND(AVG(score - (tk*{tk} + asst*{az} + ret_pts)),4) AS gap,
       ROUND(AVG(ABS(score - (tk*{tk} + asst*{az} + ret_pts))),4) AS abs_gap,
       SUM(CASE WHEN ABS(score - (tk*{tk} + asst*{az} + ret_pts)) < 0.05 THEN 1 ELSE 0 END) AS exact
FROM idp WHERE pos = '{pos}' GROUP BY pos
"""


def d1(sql: str):
    r = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json",
         "--command", sql],
        cwd=WORKER, capture_output=True, text=True, timeout=300)
    i = r.stdout.find("[")
    if i < 0:
        sys.exit(f"D1 query failed:\n{r.stdout[:500]}\n{r.stderr[:500]}")
    return json.loads(r.stdout[i:])[0].get("results", [])


def parse_seasons(s: str) -> list[int]:
    if "-" in s:
        a, b = s.split("-")
        return list(range(int(a), int(b) + 1))
    return [int(p) for p in s.split(",") if p.strip()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2025")
    args = ap.parse_args()

    failures = 0
    checked = 0
    thin = 0
    print(f"{'season':>6} {'pos':>4} {'n':>6} {'actual':>8} {'TK':>6} {'AS':>6} "
          f"{'gap':>8} {'|gap|':>8} {'exact%':>7}  gate")
    print("-" * 78)
    for season in parse_seasons(args.season):
        for pos, (tk, az) in rates_for(season).items():
            rows = d1(SQL.format(season=season, pos=pos, tk=tk, az=az))
            if not rows:
                print(f"{season:>6} {pos:>4} {'—':>6}   (no rows — pos not scored this season)")
                continue
            r = rows[0]
            n = r["n"]
            if not n:
                continue
            ok = abs(r["abs_gap"]) < GATE
            if n < MIN_N:
                thin += 1
                verdict = f"n/a (n<{MIN_N})"
            else:
                checked += 1
                failures += (not ok)
                verdict = "PASS" if ok else "FAIL"
            print(f"{season:>6} {pos:>4} {n:>6} {r['actual']:>8.3f} {r['avg_tk']:>6.2f} "
                  f"{r['avg_as']:>6.2f} {r['gap']:>8.4f} {r['abs_gap']:>8.4f} "
                  f"{100.0*r['exact']/n:>6.1f}%  {verdict}")

    print("-" * 78)
    if thin:
        print(f"NOTE: {thin} cohort(s) had n < {MIN_N} and were EXCLUDED from the "
              f"verdict — they are neither passed nor failed. Pre-2018 DL/DB\n"
              f"      cohorts are tiny because UPS ran a single IDP starter slot; "
              f"do not read them as validation.")
    if not checked:
        sys.exit("NO COHORT MET THE SAMPLE FLOOR — refusing to report a pass on "
                 "insufficient evidence")
    if failures:
        sys.exit(f"GATE FAILED: {failures}/{checked} qualifying cohorts over "
                 f"{GATE} pts/player-week")
    print(f"GATE PASSED: all {checked} qualifying cohorts under {GATE} pts/player-week")


if __name__ == "__main__":
    main()
