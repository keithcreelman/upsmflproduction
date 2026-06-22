#!/usr/bin/env python3
"""Aggregate per-player EPA / efficiency from nflfastR PBP → nfl_player_epa.

EPA, CPOE and success are PRECOMPUTED inside the play-by-play (nflfastR's
`epa`, `cpoe`, `success` columns) — this is pure aggregation, no modeling.
For each (season, gsis_id), REG season only, we store SUMS + counts (not
means) so the worker can re-aggregate exactly over any multi-season window:

  pass_*  passer_player_id on play_type=='pass'  (QB) — incl CPOE
  rush_*  rusher_player_id on play_type=='run'
  rec_*   receiver_player_id on play_type=='pass' (target; play EPA → receiver)

Source : nflreadpy.load_pbp(seasons)
Writes : local mfl_database.db (if present) + D1 nfl_player_epa
         (dual-write; UPSERT by season+gsis_id)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_epa.py --seasons 2014-2025
  python3 pipelines/etl/scripts/fetch_nflverse_epa.py --seasons 2024,2025 --skip-d1
  python3 pipelines/etl/scripts/fetch_nflverse_epa.py --seasons 2025 --skip-local

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

DDL = """
CREATE TABLE IF NOT EXISTS nfl_player_epa (
  season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
  pass_plays INTEGER, pass_epa_sum REAL, pass_cpoe_sum REAL, pass_cpoe_n INTEGER, pass_succ_sum REAL,
  rush_plays INTEGER, rush_epa_sum REAL, rush_succ_sum REAL,
  rec_tgt INTEGER, rec_epa_sum REAL, rec_succ_sum REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, gsis_id)
);
"""

COLS = ["season", "gsis_id",
        "pass_plays", "pass_epa_sum", "pass_cpoe_sum", "pass_cpoe_n", "pass_succ_sum",
        "rush_plays", "rush_epa_sum", "rush_succ_sum",
        "rec_tgt", "rec_epa_sum", "rec_succ_sum"]


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
    pbp = nfl.load_pbp(seasons)
    df = pbp.to_pandas() if hasattr(pbp, "to_pandas") else pbp
    df.columns = [c.lower() for c in df.columns]
    if "season_type" in df.columns:
        df = df[df["season_type"] == "REG"]

    acc: dict[tuple, dict] = {}

    def bump(season, gsis, **kw) -> None:
        if not isinstance(gsis, str) or not gsis.strip():
            return
        d = acc.setdefault((int(season), gsis), {})
        for f, v in kw.items():
            d[f] = d.get(f, 0) + v

    # ── pass plays (passer + receiver share the play's EPA) ──
    pas = df[(df["play_type"] == "pass") & df["epa"].notna()].copy()
    pas["success"] = pas["success"].fillna(0)
    gp = pas[pas["passer_player_id"].notna()].groupby(["season", "passer_player_id"]).agg(
        n=("epa", "size"), epa=("epa", "sum"), succ=("success", "sum"))
    for (season, gsis), r in gp.iterrows():
        bump(season, gsis, pass_plays=int(r["n"]), pass_epa_sum=float(r["epa"]), pass_succ_sum=float(r["succ"]))
    gpc = pas[pas["cpoe"].notna() & pas["passer_player_id"].notna()].groupby(["season", "passer_player_id"]).agg(
        csum=("cpoe", "sum"), cn=("cpoe", "size"))
    for (season, gsis), r in gpc.iterrows():
        bump(season, gsis, pass_cpoe_sum=float(r["csum"]), pass_cpoe_n=int(r["cn"]))
    gr = pas[pas["receiver_player_id"].notna()].groupby(["season", "receiver_player_id"]).agg(
        n=("epa", "size"), epa=("epa", "sum"), succ=("success", "sum"))
    for (season, gsis), r in gr.iterrows():
        bump(season, gsis, rec_tgt=int(r["n"]), rec_epa_sum=float(r["epa"]), rec_succ_sum=float(r["succ"]))

    # ── run plays (rusher) ──
    run = df[(df["play_type"] == "run") & df["epa"].notna() & df["rusher_player_id"].notna()].copy()
    run["success"] = run["success"].fillna(0)
    gru = run.groupby(["season", "rusher_player_id"]).agg(
        n=("epa", "size"), epa=("epa", "sum"), succ=("success", "sum"))
    for (season, gsis), r in gru.iterrows():
        bump(season, gsis, rush_plays=int(r["n"]), rush_epa_sum=float(r["epa"]), rush_succ_sum=float(r["succ"]))

    rows = []
    for (season, gsis), d in acc.items():
        rows.append((
            int(season), str(gsis),
            int(d.get("pass_plays", 0)), round(d.get("pass_epa_sum", 0.0), 4),
            round(d.get("pass_cpoe_sum", 0.0), 4), int(d.get("pass_cpoe_n", 0)), round(d.get("pass_succ_sum", 0.0), 2),
            int(d.get("rush_plays", 0)), round(d.get("rush_epa_sum", 0.0), 4), round(d.get("rush_succ_sum", 0.0), 2),
            int(d.get("rec_tgt", 0)), round(d.get("rec_epa_sum", 0.0), 4), round(d.get("rec_succ_sum", 0.0), 2),
        ))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2014-2025", help="e.g. 2014-2025 or 2024 or 2018,2019")
    ap.add_argument("--skip-d1", action="store_true")
    ap.add_argument("--skip-local", action="store_true")
    args = ap.parse_args()
    seasons = parse_seasons(args.seasons)
    seasons = available_seasons(seasons)
    if not seasons:
        print("no available nflverse seasons in range — nothing to fetch", file=sys.stderr)
        sys.exit(0)
    print(f"loading PBP for {seasons} (big download)…", file=sys.stderr)
    rows = compute(seasons)
    print(f"  {len(rows)} (season,gsis) EPA rows", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if not args.skip_local and LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            f"""INSERT INTO nfl_player_epa ({', '.join(COLS)})
                VALUES ({', '.join('?' for _ in COLS)})
                ON CONFLICT(season, gsis_id) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in COLS if c not in ('season', 'gsis_id'))}""",
            rows,
        )
        db.commit(); db.close()
        print("  wrote local nfl_player_epa", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="nfl_player_epa", cols=COLS, pk_cols=["season", "gsis_id"], chunk_size=120) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
