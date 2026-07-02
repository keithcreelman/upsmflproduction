#!/usr/bin/env python3
"""Aggregate per-player Next Gen Stats (weekly) → nfl_player_ngs.

NGS publishes WEEKLY AVERAGES (avg_separation, avg_time_to_throw, …), so we
store DENOMINATOR-WEIGHTED SUMS + the denominator count, not means. The
worker recovers the mean as metric_sum / denom_n, and multi-season
re-aggregation stays EXACT (sum the sums, sum the counts) — averaging the
weekly averages would weight a 2-target week the same as a 12-target week.

  rec_*  weighted by targets        : avg_separation, avg_cushion,
                                      avg_yac_above_expectation
  rush_* weighted by rush_attempts  : efficiency,
                                      percent_attempts_gte_eight_defenders;
                                      rush_yards_over_expected is already a
                                      per-week TOTAL (verified: weekly sums
                                      == NGS's own week-0 aggregate row) so
                                      it is summed directly, unweighted
  pass_* weighted by attempts       : avg_time_to_throw, aggressiveness,
                                      completion_percentage_above_expectation

CRITICAL filters: week >= 1 (week 0 is NGS's season-aggregate row — keeping
it would double-count every metric) and season_type == 'REG'.

Source : nflreadpy.load_nextgen_stats(seasons, stat_type) — 2016+ only
Writes : local mfl_database.db (if present) + D1 nfl_player_ngs
         (dual-write; UPSERT by season+gsis_id)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_ngs.py --seasons 2016-2025
  python3 pipelines/etl/scripts/fetch_nflverse_ngs.py --seasons 2024 --skip-d1
  python3 pipelines/etl/scripts/fetch_nflverse_ngs.py --seasons 2025 --skip-local

Override the local DB path with $MFL_DB_PATH (CI sets it to a temp file).
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402
from lib.nflverse_seasons import available_seasons  # noqa: E402

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

NGS_FLOOR = 2016  # Next Gen Stats coverage starts 2016

DDL = """
CREATE TABLE IF NOT EXISTS nfl_player_ngs (
  season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
  rec_tgt_n INTEGER, sep_sum REAL, cush_sum REAL, yacoe_sum REAL,
  rush_att_n INTEGER, ryoe_sum REAL, eff_sum REAL, box8_sum REAL,
  pass_att_n INTEGER, tt_sum REAL, agg_sum REAL, cpae_sum REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_ngs_gsis ON nfl_player_ngs (gsis_id);
"""

COLS = ["season", "gsis_id",
        "rec_tgt_n", "sep_sum", "cush_sum", "yacoe_sum",
        "rush_att_n", "ryoe_sum", "eff_sum", "box8_sum",
        "pass_att_n", "tt_sum", "agg_sum", "cpae_sum"]

# stat_type → (denominator col, [(output field, source col, weighted?)])
# weighted=True  → add source×denominator to the sum
# weighted=False → source is already a weekly TOTAL; add it directly
SPECS = {
    "receiving": ("targets", [
        ("sep_sum",   "avg_separation",              True),
        ("cush_sum",  "avg_cushion",                 True),
        ("yacoe_sum", "avg_yac_above_expectation",   True),
    ]),
    "rushing": ("rush_attempts", [
        ("ryoe_sum",  "rush_yards_over_expected",    False),
        ("eff_sum",   "efficiency",                  True),
        ("box8_sum",  "percent_attempts_gte_eight_defenders", True),
    ]),
    "passing": ("attempts", [
        ("tt_sum",    "avg_time_to_throw",           True),
        ("agg_sum",   "aggressiveness",              True),
        ("cpae_sum",  "completion_percentage_above_expectation", True),
    ]),
}
DENOM_OUT = {"receiving": "rec_tgt_n", "rushing": "rush_att_n", "passing": "pass_att_n"}


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-"); out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def compute(seasons: list[int]) -> list[tuple]:
    import nflreadpy as nfl

    acc: dict[tuple, dict] = {}
    skipped = {t: 0 for t in SPECS}

    def bump(season, gsis, **kw) -> None:
        if not isinstance(gsis, str) or not gsis.strip():
            return
        d = acc.setdefault((int(season), gsis), {})
        for f, v in kw.items():
            d[f] = d.get(f, 0) + v

    for stat_type, (denom_col, metrics) in SPECS.items():
        for yr in seasons:
            raw = nfl.load_nextgen_stats(seasons=[yr], stat_type=stat_type)
            df = raw.to_pandas() if hasattr(raw, "to_pandas") else raw
            df.columns = [c.lower() for c in df.columns]

            # runtime column-name diagnostic — NGS schemas have drifted before
            need = {"week", "player_gsis_id", denom_col} | {src for _, src, _ in metrics}
            missing = sorted(need - set(df.columns))
            if missing:
                sys.exit(
                    f"nfl_player_ngs: {stat_type} {yr} is MISSING columns {missing}\n"
                    f"  available: {sorted(df.columns)}"
                )
            if yr == seasons[0]:
                print(f"  [{stat_type}] cols ok: denom={denom_col}, "
                      f"metrics={[src for _, src, _ in metrics]}", file=sys.stderr)

            # week 0 = NGS's own season-aggregate row (double-counts); REG only
            df = df[df["week"] >= 1]
            if "season_type" in df.columns:
                df = df[df["season_type"] == "REG"]

            for r in df.itertuples(index=False):
                denom = getattr(r, denom_col)
                if denom is None or denom != denom or denom <= 0:  # NaN-safe
                    skipped[stat_type] += 1
                    continue
                vals = [getattr(r, src) for _, src, _ in metrics]
                if any(v is None or v != v for v in vals):  # any metric NaN →
                    skipped[stat_type] += 1                  # skip whole row so
                    continue                                 # sums match denom_n
                add = {DENOM_OUT[stat_type]: int(denom)}
                for (out, _src, weighted), v in zip(metrics, vals):
                    add[out] = float(v) * denom if weighted else float(v)
                bump(yr, r.player_gsis_id, **add)
            print(f"  [{stat_type}] {yr}: {len(df)} weekly REG rows", file=sys.stderr)

    for t, n in skipped.items():
        if n:
            print(f"  [{t}] skipped {n} weekly rows (missing denominator or metric)",
                  file=sys.stderr)

    rows = []
    for (season, gsis), d in acc.items():
        rows.append((
            season, gsis,
            int(d.get("rec_tgt_n", 0)), round(d.get("sep_sum", 0.0), 4),
            round(d.get("cush_sum", 0.0), 4), round(d.get("yacoe_sum", 0.0), 4),
            int(d.get("rush_att_n", 0)), round(d.get("ryoe_sum", 0.0), 4),
            round(d.get("eff_sum", 0.0), 4), round(d.get("box8_sum", 0.0), 4),
            int(d.get("pass_att_n", 0)), round(d.get("tt_sum", 0.0), 4),
            round(d.get("agg_sum", 0.0), 4), round(d.get("cpae_sum", 0.0), 4),
        ))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2016-2025", help="e.g. 2016-2025 or 2024 or 2018,2019")
    ap.add_argument("--skip-d1", action="store_true")
    ap.add_argument("--skip-local", action="store_true")
    args = ap.parse_args()
    seasons = parse_seasons(args.seasons)
    seasons = available_seasons(seasons, floor=NGS_FLOOR)
    if not seasons:
        print("no available nflverse NGS seasons in range — nothing to fetch", file=sys.stderr)
        sys.exit(0)
    print(f"loading Next Gen Stats for {seasons}…", file=sys.stderr)
    rows = compute(seasons)
    print(f"  {len(rows)} (season,gsis) NGS rows", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if not args.skip_local and LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            f"""INSERT INTO nfl_player_ngs ({', '.join(COLS)})
                VALUES ({', '.join('?' for _ in COLS)})
                ON CONFLICT(season, gsis_id) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in COLS if c not in ('season', 'gsis_id'))}""",
            rows,
        )
        db.commit(); db.close()
        print("  wrote local nfl_player_ngs", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="nfl_player_ngs", cols=COLS, pk_cols=["season", "gsis_id"], chunk_size=120) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
