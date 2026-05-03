#!/usr/bin/env python3
"""Per-(player, season, role) and per-(team, season) advanced PBP aggs.

Two NEW tables (do NOT touch nfl_player_weekly / nfl_player_advstats_season —
see Lurking Rule in handoff plan):

  nfl_player_pbp_season   — n_plays, epa_per_play, cpoe (QB pass), success_rate
                            keyed by (season, gsis_id, role)
                            role ∈ {'passer','rusher','receiver'}

  nfl_team_pbp_season     — proe, neutral_pass_rate, sec_per_play (pace),
                            off_epa_per_play, def_epa_per_play
                            keyed by (season, team)

Source: nflreadpy.load_pbp(). Uses `xpass` directly (already in PBP) so PROE
is just mean(pass - xpass) on neutral plays.

Neutral game state for PROE: qtr ≤ 3 AND |score_differential| ≤ 7,
and qb_dropback flag set (filters out kneels / spikes / special teams).

Pace (sec_per_play): mean delta in `game_seconds_remaining` between
consecutive same-team offensive snaps within the same drive, clipped to
[5, 60] seconds (excludes scoring stops / timeouts).

Run:
  python3 pipelines/etl/scripts/fetch_nflverse_pbp_advanced.py --seasons 2011-2025
  python3 pipelines/etl/scripts/fetch_nflverse_pbp_advanced.py --seasons 2024 --skip-d1

Override DB path with $MFL_DB_PATH.
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

PLAYER_TABLE = "nfl_player_pbp_season"
PLAYER_COLS = ["season", "gsis_id", "position", "role",
               "n_plays", "epa_per_play", "cpoe", "success_rate"]
PLAYER_PK = ["season", "gsis_id", "role"]

TEAM_TABLE = "nfl_team_pbp_season"
TEAM_COLS = ["season", "team", "proe", "neutral_pass_rate", "sec_per_play",
             "off_epa_per_play", "def_epa_per_play"]
TEAM_PK = ["season", "team"]


def parse_seasons(spec: str) -> list[int]:
    out = set()
    for piece in spec.split(","):
        piece = piece.strip()
        if not piece:
            continue
        if "-" in piece:
            a, b = piece.split("-", 1)
            out.update(range(int(a), int(b) + 1))
        else:
            out.add(int(piece))
    return sorted(out)


def ensure_tables(db: sqlite3.Connection) -> None:
    db.execute(f"""
        CREATE TABLE IF NOT EXISTS {PLAYER_TABLE} (
          season         INTEGER NOT NULL,
          gsis_id        TEXT    NOT NULL,
          position       TEXT,
          role           TEXT    NOT NULL,
          n_plays        INTEGER,
          epa_per_play   REAL,
          cpoe           REAL,
          success_rate   REAL,
          PRIMARY KEY (season, gsis_id, role)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_pbp_player_season ON {PLAYER_TABLE} (gsis_id, season)")
    db.execute(f"""
        CREATE TABLE IF NOT EXISTS {TEAM_TABLE} (
          season              INTEGER NOT NULL,
          team                TEXT    NOT NULL,
          proe                REAL,
          neutral_pass_rate   REAL,
          sec_per_play        REAL,
          off_epa_per_play    REAL,
          def_epa_per_play    REAL,
          PRIMARY KEY (season, team)
        )
    """)
    db.execute(f"CREATE INDEX IF NOT EXISTS idx_team_pbp_season ON {TEAM_TABLE} (team, season)")
    db.commit()


def process_season(db: sqlite3.Connection, season: int, args) -> tuple[int, int]:
    try:
        import nflreadpy as nfl
        import pandas as pd
        import numpy as np
    except Exception as e:
        sys.exit(f"FATAL: import failed: {type(e).__name__}: {e}")

    print(f"  loading PBP for {season}...", file=sys.stderr)
    df = nfl.load_pbp(seasons=[season])
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()

    # REG + POST only
    df = df[df["season_type"].isin(["REG", "POST"])]

    # ---- Per-player aggregation (passer / rusher / receiver) ----
    player_rows: list[tuple] = []

    def _agg_role(role: str, id_col: str, *,
                  cpoe_role: bool = False) -> None:
        sub = df[df[id_col].notna()].copy()
        if sub.empty:
            return
        sub["epa"] = pd.to_numeric(sub["epa"], errors="coerce")
        sub["success"] = pd.to_numeric(sub["success"], errors="coerce")
        if cpoe_role:
            sub["cpoe"] = pd.to_numeric(sub["cpoe"], errors="coerce")
        grp = sub.groupby(id_col, dropna=True)
        for pid, g in grp:
            n = len(g)
            epa_mean = g["epa"].mean()
            succ = g["success"].mean()
            cpoe_mean = g["cpoe"].mean() if cpoe_role else None
            player_rows.append((
                season, str(pid), None, role,
                int(n),
                float(epa_mean) if pd.notna(epa_mean) else None,
                float(cpoe_mean) if cpoe_role and pd.notna(cpoe_mean) else None,
                float(succ) if pd.notna(succ) else None,
            ))

    _agg_role("passer", "passer_player_id", cpoe_role=True)
    _agg_role("rusher", "rusher_player_id")
    _agg_role("receiver", "receiver_player_id")

    # ---- Per-team aggregation ----
    team_rows: list[tuple] = []

    # Off / Def EPA per play (all situations, all play types incl runs/passes;
    # exclude special teams). qb_dropback covers passes + sacks + scrambles.
    epa_plays = df[df["play_type"].isin(["pass", "run"])].copy()
    epa_plays["epa"] = pd.to_numeric(epa_plays["epa"], errors="coerce")

    off_epa = epa_plays.groupby("posteam")["epa"].mean()
    def_epa = epa_plays.groupby("defteam")["epa"].mean()

    # Neutral game-state for PROE: qtr ≤ 3, |score_differential| ≤ 7,
    # play_type in (pass, run), not a kneel/spike, xpass present.
    neut = df[
        (df["qtr"].fillna(0) <= 3) &
        (df["score_differential"].abs() <= 7) &
        (df["play_type"].isin(["pass", "run"]))
    ].copy()
    if "qb_kneel" in neut.columns:
        neut = neut[neut["qb_kneel"].fillna(0) == 0]
    if "qb_spike" in neut.columns:
        neut = neut[neut["qb_spike"].fillna(0) == 0]
    neut["pass"] = pd.to_numeric(neut["pass"], errors="coerce")
    neut["xpass"] = pd.to_numeric(neut["xpass"], errors="coerce")
    neut_with_xpass = neut[neut["xpass"].notna() & neut["pass"].notna()]

    proe_by_team = (neut_with_xpass.groupby("posteam")
                    .apply(lambda g: (g["pass"] - g["xpass"]).mean()))
    npr_by_team = neut.groupby("posteam")["pass"].mean()

    # Pace: per (game, posteam, drive) sequential plays. delta = prev_gsr - curr_gsr.
    # Clip to [5, 60] secs to drop scoring stops / timeouts / commercial breaks.
    pace_df = df[df["play_type"].isin(["pass", "run"])].copy()
    pace_df = pace_df.sort_values(["game_id", "posteam", "drive", "play_id"])
    pace_df["gsr"] = pd.to_numeric(pace_df["game_seconds_remaining"], errors="coerce")
    pace_df["prev_gsr"] = pace_df.groupby(["game_id", "posteam", "drive"])["gsr"].shift(1)
    pace_df["delta"] = pace_df["prev_gsr"] - pace_df["gsr"]
    pace_df = pace_df[(pace_df["delta"] >= 5) & (pace_df["delta"] <= 60)]
    pace_by_team = pace_df.groupby("posteam")["delta"].mean()

    # Build team rows
    teams = sorted(set(off_epa.index) | set(def_epa.index) |
                   set(proe_by_team.index) | set(pace_by_team.index))
    for team in teams:
        if not team:
            continue
        team_rows.append((
            season, str(team),
            float(proe_by_team.get(team)) if pd.notna(proe_by_team.get(team)) else None,
            float(npr_by_team.get(team)) if pd.notna(npr_by_team.get(team)) else None,
            float(pace_by_team.get(team)) if pd.notna(pace_by_team.get(team)) else None,
            float(off_epa.get(team)) if pd.notna(off_epa.get(team)) else None,
            float(def_epa.get(team)) if pd.notna(def_epa.get(team)) else None,
        ))

    # ---- Local UPSERT ----
    if not args.skip_local:
        try:
            db.executemany(f"""
                INSERT INTO {PLAYER_TABLE}
                  (season, gsis_id, position, role, n_plays,
                   epa_per_play, cpoe, success_rate)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(season, gsis_id, role) DO UPDATE SET
                  position     = excluded.position,
                  n_plays      = excluded.n_plays,
                  epa_per_play = excluded.epa_per_play,
                  cpoe         = excluded.cpoe,
                  success_rate = excluded.success_rate
            """, player_rows)
            db.executemany(f"""
                INSERT INTO {TEAM_TABLE}
                  (season, team, proe, neutral_pass_rate, sec_per_play,
                   off_epa_per_play, def_epa_per_play)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(season, team) DO UPDATE SET
                  proe              = excluded.proe,
                  neutral_pass_rate = excluded.neutral_pass_rate,
                  sec_per_play      = excluded.sec_per_play,
                  off_epa_per_play  = excluded.off_epa_per_play,
                  def_epa_per_play  = excluded.def_epa_per_play
            """, team_rows)
            db.commit()
        except sqlite3.OperationalError as e:
            print(f"  [pbp_adv {season}] local: FAILED ({e})", file=sys.stderr)

    # ---- D1 dual-write ----
    if not args.skip_d1:
        with D1Writer(table=PLAYER_TABLE, cols=PLAYER_COLS, pk_cols=PLAYER_PK) as w:
            for r in player_rows:
                w.add(r)
        with D1Writer(table=TEAM_TABLE, cols=TEAM_COLS, pk_cols=TEAM_PK) as w:
            for r in team_rows:
                w.add(r)

    print(f"  {season}: player_rows={len(player_rows)} team_rows={len(team_rows)}",
          file=sys.stderr)
    return len(player_rows), len(team_rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025")
    ap.add_argument("--skip-local", action="store_true")
    ap.add_argument("--skip-d1", action="store_true")
    args = ap.parse_args()

    if not args.skip_local and not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}\n"
                 f"(set MFL_DB_PATH env var if DB lives elsewhere)")
    print(f"DB: {LOCAL_DB}", file=sys.stderr)
    db = sqlite3.connect(str(LOCAL_DB), timeout=30)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=30000")
    except sqlite3.DatabaseError:
        pass
    if not args.skip_local:
        try:
            ensure_tables(db)
        except sqlite3.OperationalError as e:
            print(f"  [schema] local ensure FAILED ({e}) — continuing in D1-only mode",
                  file=sys.stderr)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    p_total = 0
    t_total = 0
    for s in seasons:
        p, t = process_season(db, s, args)
        p_total += p
        t_total += t

    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: player_rows={p_total} team_rows={t_total} across {len(seasons)} seasons "
          f"(local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
