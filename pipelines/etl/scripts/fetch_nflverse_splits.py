#!/usr/bin/env python3
"""Game-script / home-road opportunity splits from nflfastR PBP → nfl_player_splits.

Each player OPPORTUNITY (target / carry / dropback) is bucketed TWO ways —
two independent bucket families living in the same table:

  script : margin at the snap from the OFFENSE's point of view
           (posteam_score - defteam_score, pre-play):
             'lead'    margin > +7
             'neutral' -7 .. +7
             'trail'   margin < -7
  venue  : 'home' (posteam == home_team) / 'road'

Every opportunity lands in exactly one bucket of EACH family, so for a
given player home+road totals == lead+neutral+trail totals.

Opportunity attribution (REG season only):
  target   receiver_player_id on play_type=='pass'  → targets, rec_yds
  carry    rusher_player_id   on play_type=='run'   → rush_att, rush_yds
  dropback passer_player_id   on qb_dropback==1     → pass_att (throws,
           i.e. dropbacks minus sacks), pass_yds

Rows are (season, gsis_id, bucket) SUMS — plays (all his opportunities in
the bucket), targets, rec_yds, rush_att, rush_yds, pass_att, pass_yds —
plus `games` (distinct game_ids with >=1 opportunity in the bucket) so
per-game rates are possible.

Source : nflreadpy.load_pbp(seasons)
Writes : local mfl_database.db (if present) + D1 nfl_player_splits
         (dual-write; UPSERT by season+gsis_id+bucket)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_splits.py --seasons 2014-2025
  python3 pipelines/etl/scripts/fetch_nflverse_splits.py --seasons 2024,2025 --skip-d1
  python3 pipelines/etl/scripts/fetch_nflverse_splits.py --seasons 2025 --skip-local

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
CREATE TABLE IF NOT EXISTS nfl_player_splits (
  season INTEGER NOT NULL, gsis_id TEXT NOT NULL, bucket TEXT NOT NULL,
  games INTEGER, plays INTEGER,
  targets INTEGER, rec_yds INTEGER,
  rush_att INTEGER, rush_yds INTEGER,
  pass_att INTEGER, pass_yds INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, gsis_id, bucket)
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_splits_gsis ON nfl_player_splits (gsis_id);
"""

COLS = ["season", "gsis_id", "bucket",
        "games", "plays",
        "targets", "rec_yds",
        "rush_att", "rush_yds",
        "pass_att", "pass_yds"]

METRICS = ["targets", "rec_yds", "rush_att", "rush_yds", "pass_att", "pass_yds"]


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
    import numpy as np
    import pandas as pd

    pbp = nfl.load_pbp(seasons)
    df = pbp.to_pandas() if hasattr(pbp, "to_pandas") else pbp
    df.columns = [c.lower() for c in df.columns]
    if "season_type" in df.columns:
        df = df[df["season_type"] == "REG"]

    # ── bucket every play once per family ──
    # score_differential is nflfastR's pre-snap posteam_score - defteam_score;
    # fall back to the raw columns if it's ever missing.
    if "score_differential" in df.columns:
        margin = df["score_differential"]
    else:
        margin = df["posteam_score"] - df["defteam_score"]
    df = df.assign(
        _script=np.select(
            [margin > 7, margin < -7, margin.notna()],
            ["lead", "trail", "neutral"], default=None),
        _venue=np.where(df["posteam"].isna(), None,
                        np.where(df["posteam"] == df["home_team"], "home", "road")),
    )

    def opps(sub: "pd.DataFrame", gsis_col: str, **metric_src) -> "pd.DataFrame":
        """One row per opportunity with all METRICS columns (0 where n/a)."""
        out = pd.DataFrame({
            "season": sub["season"].astype(int),
            "game_id": sub["game_id"],
            "gsis": sub[gsis_col],
            "_script": sub["_script"],
            "_venue": sub["_venue"],
        })
        for m in METRICS:
            src = metric_src.get(m)
            out[m] = src.to_numpy() if src is not None else 0
        return out

    frames = []

    # target: receiver on pass plays (receiving_yards only set on completions)
    tgt = df[(df["play_type"] == "pass") & df["receiver_player_id"].notna()]
    frames.append(opps(tgt, "receiver_player_id",
                       targets=pd.Series(1, index=tgt.index),
                       rec_yds=tgt["receiving_yards"].fillna(0)))

    # carry: rusher on run plays
    car = df[(df["play_type"] == "run") & df["rusher_player_id"].notna()]
    frames.append(opps(car, "rusher_player_id",
                       rush_att=pd.Series(1, index=car.index),
                       rush_yds=car["rushing_yards"].fillna(0)))

    # dropback: passer on qb_dropback (throws + sacks; scrambles have no
    # passer_player_id and are already counted as the QB's carries).
    # pass_att counts THROWS (dropbacks minus sacks); plays counts all dropbacks.
    drp = df[(df["qb_dropback"] == 1) & df["passer_player_id"].notna()]
    frames.append(opps(drp, "passer_player_id",
                       pass_att=(1 - drp["sack"].fillna(0)).clip(lower=0),
                       pass_yds=drp["passing_yards"].fillna(0)))

    opp = pd.concat(frames, ignore_index=True)
    opp = opp[opp["gsis"].apply(lambda g: isinstance(g, str) and bool(g.strip()))]

    # explode into the two bucket families, then aggregate
    long = pd.concat([
        opp.assign(bucket=opp["_script"]),
        opp.assign(bucket=opp["_venue"]),
    ], ignore_index=True)
    long = long[long["bucket"].notna()]

    g = long.groupby(["season", "gsis", "bucket"]).agg(
        games=("game_id", "nunique"),
        plays=("game_id", "size"),
        **{m: (m, "sum") for m in METRICS},
    ).reset_index()

    rows = []
    for r in g.itertuples(index=False):
        rows.append((
            int(r.season), str(r.gsis), str(r.bucket),
            int(r.games), int(r.plays),
            int(r.targets), int(round(r.rec_yds)),
            int(r.rush_att), int(round(r.rush_yds)),
            int(round(r.pass_att)), int(round(r.pass_yds)),
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
    print(f"  {len(rows)} (season,gsis,bucket) split rows", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if not args.skip_local and LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            f"""INSERT INTO nfl_player_splits ({', '.join(COLS)})
                VALUES ({', '.join('?' for _ in COLS)})
                ON CONFLICT(season, gsis_id, bucket) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in COLS if c not in ('season', 'gsis_id', 'bucket'))}""",
            rows,
        )
        db.commit(); db.close()
        print("  wrote local nfl_player_splits", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="nfl_player_splits", cols=COLS, pk_cols=["season", "gsis_id", "bucket"], chunk_size=150) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
