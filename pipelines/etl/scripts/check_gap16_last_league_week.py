#!/usr/bin/env python3
"""check_gap16_last_league_week.py -- GAP-16: no stored week after the league's last week.

The June 2026 archive (data/db-archives/mfl_database_2026-06-05.db.gz) stores
weeks 17-22 (before 2021) and 18-22 (2021 on) of playerscores_weekly, and
some post-season weeks of rosters_weekly, as COPIES of the final league week:
MFL's playerScores / rosters exports with W= past the season return the last
week again. Summing every stored week inflates season totals (Vick 2010:
554.5 instead of MFL's 396.1). Any source or backfill must stop at the
league's last week: 16 through 2020, 17 from 2021 (docs/league_context_v1.md).

Read-only. Two checks:
  archive  --archive DB                   offline: rows past the last week in the
                                          June archive, and whether each copies the
                                          final week
  d1       --allow-prod-d1 [--out FILE]   opt-in, budgeted SELECTs: D1's own
                                          src_league_season_meta.total_weeks and any
                                          src_weekly / src_franchise_weekly_score row
                                          past the last week (per-season index seeks,
                                          so a clean table reads ~0 rows)
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SEASONS = list(range(2010, 2026))
D1_DB = "ups-mfl-db"
D1_OPT_IN_ENV = "UPS_ALLOW_PROD_D1_READS"


def last_league_week(season: int) -> int:
    """The league's last scored week: 16 through 2020, 17 from 2021."""
    return 17 if season >= 2021 else 16


def archive_check(path: Path) -> dict:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    out = {}
    for s in SEASONS:
        last = last_league_week(s)
        past, copies = con.execute(
            "SELECT COUNT(*), SUM(CASE WHEN b.score IS a.score THEN 1 ELSE 0 END) "
            "FROM playerscores_weekly a LEFT JOIN playerscores_weekly b "
            "ON b.season = a.season AND b.week = ? AND b.player_id = a.player_id "
            "WHERE a.season = ? AND a.week > ?", (last, s, last)).fetchone()
        r_past, r_copies = con.execute(
            "SELECT COUNT(*), SUM(CASE WHEN EXISTS (SELECT 1 FROM rosters_weekly b WHERE b.season = a.season "
            "AND b.week = ? AND b.player_id = a.player_id AND b.franchise_id = a.franchise_id) THEN 1 ELSE 0 END) "
            "FROM rosters_weekly a WHERE a.season = ? AND a.week > ?", (last, s, last)).fetchone()
        out[s] = {"last_week": last, "playerscores_past": past, "playerscores_copies": copies or 0,
                  "rosters_past": r_past, "rosters_copies": r_copies or 0}
    return out


def d1_sql() -> list[tuple[str, str]]:
    def seeks(table: str) -> str:
        # Index seeks on the (season, week, ...) primary key: season IN (...) AND week > last.
        # D1 caps compound SELECTs at a few terms, so group seasons by their last week.
        by_last = {}
        for s in SEASONS:
            by_last.setdefault(last_league_week(s), []).append(str(s))
        return " UNION ALL ".join(
            f"SELECT season, COUNT(*) AS n FROM {table} WHERE season IN ({', '.join(ss)}) AND week > {last} "
            f"GROUP BY season" for last, ss in sorted(by_last.items()))
    return [
        ("season_meta", "SELECT season, last_regular_season_week, total_weeks FROM src_league_season_meta "
                        "WHERE season BETWEEN 2010 AND 2025"),
        ("src_weekly_past_last_week", seeks("src_weekly")),
        ("src_franchise_weekly_score_past_last_week", seeks("src_franchise_weekly_score")),
    ]


def wrangler_json(sql: str) -> list:
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB, "--remote", "--json", "--command", sql],
        cwd=REPO_ROOT / "worker", capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        raise RuntimeError(f"wrangler failed: {(res.stderr or res.stdout)[-800:]}")
    return json.loads(res.stdout)


def d1_check(args, runner=wrangler_json) -> int:
    if not (args.allow_prod_d1 or os.environ.get(D1_OPT_IN_ENV) == "1"):
        print("SKIPPED: production D1 read not opted in (pass --allow-prod-d1). Nothing was read.")
        return 0
    spent, result = 0, {"reads": []}
    for name, sql in d1_sql():
        assert sql.lstrip().upper().startswith("SELECT")
        plan = [r.get("detail") for r in runner("EXPLAIN QUERY PLAN " + sql)[0]["results"]]
        if any(p.startswith("SCAN src_") for p in plan):
            print(f"STOP: {name} would scan a table: {plan}")
            return 1
        if spent >= args.max_rows_read:
            print(f"STOP: budget {args.max_rows_read} reached")
            return 1
        res = runner(sql)[0]
        n = int((res.get("meta") or {}).get("rows_read") or 0)
        spent += n
        result["reads"].append({"name": name, "rows_read": n, "plan": sorted(set(plan)), "rows": res["results"]})
        print(f"{name}: rows_read {n}")
    result["total_rows_read"] = spent
    meta = {r["season"]: r for r in result["reads"][0]["rows"]}
    result["total_weeks_disagree"] = [s for s in SEASONS if (meta.get(s) or {}).get("total_weeks") != last_league_week(s)]
    result["past_last_week"] = {r["name"]: [x for x in r["rows"] if x["n"]] for r in result["reads"][1:]}
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=1))
    print(json.dumps({"total_rows_read": spent, "total_weeks_disagree": result["total_weeks_disagree"],
                      "past_last_week": result["past_last_week"]}, indent=1))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("archive")
    a.add_argument("--archive", type=Path, required=True)
    a.add_argument("--out", type=Path)
    d = sub.add_parser("d1")
    d.add_argument("--allow-prod-d1", action="store_true")
    d.add_argument("--max-rows-read", type=int, default=5_000)
    d.add_argument("--out", type=Path)
    args = ap.parse_args(argv)
    if args.cmd == "archive":
        res = archive_check(args.archive)
        if args.out:
            args.out.write_text(json.dumps(res, indent=1))
        for s, r in res.items():
            print(s, r)
        return 0
    return d1_check(args)


if __name__ == "__main__":
    sys.exit(main())
