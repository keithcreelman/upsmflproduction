#!/usr/bin/env python3
"""Fetch nflverse weekly box score + snap counts into local DB.

Lands in two tables that 0006_advanced_stats_schema.sql creates:
  - nfl_player_weekly  (box score, 1999+ coverage, all positions)
  - nfl_player_snaps   (snap counts, 2012+ coverage — earlier seasons
                        simply have no rows, UI renders "—")

Scope decisions (Keith 2026-04-22):
  - Backfill to 2011 where data exists, document gaps.
  - No PFF → no pressure / coverage grade columns.
  - Single wide table for box score, sparse nullable columns for
    stats that don't apply to that position.

Dependencies:
  pip install nflreadpy pandas

Usage:
  # First-time backfill — all seasons we have data for
  python3 pipelines/etl/scripts/fetch_nflverse_weekly.py --seasons 2011-2025

  # In-season weekly refresh (last 2 seasons; incremental upsert)
  python3 pipelines/etl/scripts/fetch_nflverse_weekly.py --seasons 2024-2025

  # Specific seasons
  python3 pipelines/etl/scripts/fetch_nflverse_weekly.py --seasons 2023,2024

  # Skip snaps (if nflverse snap endpoint is flaky)
  python3 pipelines/etl/scripts/fetch_nflverse_weekly.py --seasons 2011-2025 --skip-snaps
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

# Honor $MFL_DB_PATH like every other ETL script in the repo. Default
# kept as the legacy Desktop path for backwards compat on machines
# that already have it there. (Keith 2026-04-25 — finally made every
# script consistent.)
_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

# Dual-write D1 path. Local SQLite stays primary until verified.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402


# ---------------------------------------------------------------
# Column mapping — nflverse returns many columns; we select a
# subset and fold them into our wide schema. Nullable columns
# simply return None for positions that don't have the stat.
# ---------------------------------------------------------------

# Mapping: dict of { our_col: nflverse_col_candidates }
# First candidate present in the DF wins. Lets us tolerate upstream
# renames (nflreadpy has shuffled cols across versions).
PLAYERSTATS_MAP = {
    # ids + context
    "gsis_id":   ["player_id", "gsis_id"],
    "team":      ["recent_team", "team"],
    "opponent":  ["opponent_team", "opponent"],
    "position":  ["position"],

    # rushing
    "rush_att":          ["carries", "rushing_attempts"],
    "rush_yds":          ["rushing_yards"],
    "rush_tds":          ["rushing_tds"],
    "rush_long":         ["rushing_long"],
    "rush_fumbles":      ["rushing_fumbles"],
    "rush_fumbles_lost": ["rushing_fumbles_lost"],

    # receiving
    "targets":           ["targets"],
    "receptions":        ["receptions"],
    "rec_yds":           ["receiving_yards"],
    "rec_tds":           ["receiving_tds"],
    "rec_long":          ["receiving_long"],
    "rec_fumbles":       ["receiving_fumbles"],
    "rec_fumbles_lost":  ["receiving_fumbles_lost"],

    # passing
    "pass_att":          ["attempts", "passing_attempts"],
    "pass_cmp":          ["completions", "passing_completions"],
    "pass_yds":          ["passing_yards"],
    "pass_tds":          ["passing_tds"],
    "pass_ints":         ["interceptions", "passing_interceptions"],
    # QB sack-suffered counts. nflreadpy/nflverse have renamed this
    # multiple times across releases — alias broadly so we match
    # whichever flavor is current. Diagnostic below prints what
    # actually came back from the dataframe so future renames are
    # caught faster (Keith 2026-04-25 — pass_sacks was silent-NULL
    # because none of our 3 prior aliases matched current schema).
    "pass_sacks":        ["sacks_suffered", "times_sacked", "sacks", "sack",
                          "passing_sacks", "sack_count"],
    "pass_sack_yds":     ["sack_yards_lost", "sack_yards_suffered",
                          "sack_yards", "sack_yds", "passing_sack_yards"],
    "pass_long":         ["passing_long"],
    "pass_2pt":          ["passing_2pt_conversions"],
    # passing_air_yards + passing_yards_after_catch live in nflverse weekly,
    # NOT in PFR pass advstats payload (verified 2026-04-26 — diagnostic
    # showed PFR pass has no air_yards or yac columns at all). Aliased here
    # so the weekly fetcher populates them from the right source.
    "passing_air_yards":         ["passing_air_yards"],
    "passing_yards_after_catch": ["passing_yards_after_catch"],

    # IDP
    "def_tackles_solo":  ["def_tackles_solo", "solo_tackles", "tackles_solo"],
    "def_tackles_ast":   ["def_tackles_with_assist", "assist_tackles", "tackles_assists", "tackles_for_loss_assist"],
    "def_tackles_total": ["def_tackles", "total_tackles", "tackles"],
    "def_tfl":           ["def_tackles_for_loss", "tfl", "tackles_for_loss"],
    "def_qb_hits":       ["def_qb_hits", "qb_hits"],
    "def_sacks":         ["def_sacks", "sacks_total"],
    "def_sack_yds":      ["def_sack_yards", "sack_yards_defensive"],
    "def_ff":            ["def_fumbles_forced", "forced_fumbles", "fumbles_forced"],
    # nflverse renamed: def_fumble_recovery_opp = defender recovered an
    # opponent's fumble (the IDP-scoring stat). Keep legacy aliases for
    # older payloads.
    # nflverse 2025 payload exposes this as `fumble_recovery_opp` (no
    # `def_` prefix) — the legacy `def_fumble_recovery_opp` alias was
    # silent-NULL. Adding the bare name as the primary alias.
    "def_fr":            ["fumble_recovery_opp", "def_fumble_recovery_opp",
                          "def_fumble_recoveries", "fumble_recoveries"],
    "def_ints":          ["def_interceptions", "interceptions_defensive"],
    "def_pass_def":      ["def_pass_defended", "passes_defended"],
    "def_tds":           ["def_tds", "defensive_tds"],

    # Kicking (PK) — totals only. FG distance buckets (0-39/40-49/50-59/
    # 60+) are PBP-derived in fetch_nflverse_pbp.py; do NOT alias them
    # here or this fetcher will UPSERT them to NULL whenever it runs after
    # PBP (race condition discovered 2026-04-26 — punter + FG bucket cols
    # were being silently clobbered).
    "fg_att":            ["fg_att", "fga"],
    "fg_made":           ["fg_made", "fgm"],
    "fg_long":           ["fg_long"],
    "xp_att":            ["pat_att", "xp_att"],
    "xp_made":           ["pat_made", "xp_made"],

    # Punting — INTENTIONALLY EMPTY. nflverse weekly does not include
    # punter stats (diagnostic confirmed: only 'punt_returns' and
    # 'punt_return_yards' are present, no actual punter cols). All punter
    # data — punts, punt_yds, punt_long, punt_inside20, punt_net_avg,
    # punt_inside5/10/15, punt_spot_*, punt_net_yds_sum, punt_inside20_pbp
    # — is owned by fetch_nflverse_pbp.py. Aliasing them here just causes
    # the weekly fetcher to overwrite them with NULL.
}

SNAP_MAP = {
    # nflverse load_snap_counts() keys on pfr_player_id — the column
    # stored in nfl_player_snaps is therefore pfr_id, NOT gsis_id.
    # (Earlier revisions of this fetcher mis-labeled the column as
    # gsis_id; migration 0009 renames it and this mapping updates to
    # match. The Worker JOINs via crosswalk.pfr_id accordingly.)
    "pfr_id":         ["pfr_player_id", "player_id"],
    "team":           ["team"],
    "off_snaps":      ["offense_snaps"],
    "off_snap_pct":   ["offense_pct"],
    "def_snaps":      ["defense_snaps"],
    "def_snap_pct":   ["defense_pct"],
    "st_snaps":       ["st_snaps", "special_teams_snaps"],
    "st_snap_pct":    ["st_pct", "special_teams_pct"],
}

BOX_COLS = ["season", "week", "gsis_id"] + list(PLAYERSTATS_MAP.keys() - {"gsis_id"}) + ["pos_group", "starter_nfl", "source"]
SNAP_COLS = ["season", "week", "gsis_id"] + list(SNAP_MAP.keys() - {"gsis_id"})


def pos_group_of(position: str) -> str:
    p = (position or "").upper()
    if p in {"QB"}: return "QB"
    if p in {"RB", "FB"}: return "RB"
    if p in {"WR"}: return "WR"
    if p in {"TE"}: return "TE"
    if p in {"K", "PK"}: return "PK"
    if p in {"P"}: return "PK"
    if p in {"DE", "DT", "NT", "DL", "EDGE", "DEF"}: return "DL"
    if p in {"OLB", "ILB", "MLB", "LB"}: return "LB"
    if p in {"CB", "SS", "FS", "S", "DB"}: return "DB"
    return p


def pick(row, candidates):
    for c in candidates:
        if c in row and row[c] is not None and str(row[c]) != "":
            return row[c]
    return None


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


def fetch_playerstats(seasons: list[int]):
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit("FATAL: nflreadpy not installed. Run: pip install nflreadpy pandas")
    print(f"  fetching nflverse player_stats for {seasons[0]}-{seasons[-1]} ({len(seasons)} seasons)...", file=sys.stderr)
    df = nfl.load_player_stats(seasons=seasons)
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    print(f"  got {len(df)} player-week rows", file=sys.stderr)
    # Diagnostic — print what nflverse currently calls each of the
    # historically-renamed fields. Saves the next debug round-trip
    # when nflreadpy ships another rename. (Keith 2026-04-25.)
    punt_cols   = [c for c in df.columns if "punt" in c.lower()]
    fr_cols     = [c for c in df.columns if "fumble" in c.lower() and ("rec" in c.lower() or "fr" in c.lower())]
    sack_cols   = [c for c in df.columns if "sack" in c.lower()]
    tackle_cols = [c for c in df.columns if "tackle" in c.lower() or "_tk" in c.lower()]
    air_cols    = [c for c in df.columns if "air_yards" in c.lower() or "yards_after_catch" in c.lower() or "yac" in c.lower() or "adot" in c.lower()]
    if punt_cols:   print(f"  punt-related columns: {punt_cols}", file=sys.stderr)
    if fr_cols:     print(f"  fumble-recovery-related columns: {fr_cols}", file=sys.stderr)
    if sack_cols:   print(f"  sack-related columns: {sack_cols}", file=sys.stderr)
    if tackle_cols: print(f"  tackle-related columns: {tackle_cols}", file=sys.stderr)
    if air_cols:    print(f"  air_yards/yac/adot columns: {air_cols}", file=sys.stderr)
    if not punt_cols: print(f"  WARNING: no punt columns in load_player_stats — punter weekly data absent", file=sys.stderr)
    if not sack_cols: print(f"  WARNING: no sack columns in load_player_stats — pass_sacks/pass_sack_yds will be NULL", file=sys.stderr)
    return df


def fetch_snaps(seasons: list[int]):
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit(1)
    s2012plus = [s for s in seasons if s >= 2012]
    if not s2012plus:
        print("  (no seasons >= 2012 requested — skipping snaps)", file=sys.stderr)
        return None
    print(f"  fetching nflverse snap_counts for {s2012plus[0]}-{s2012plus[-1]}...", file=sys.stderr)
    df = nfl.load_snap_counts(seasons=s2012plus)
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    print(f"  got {len(df)} snap rows", file=sys.stderr)
    return df


def upsert_player_weekly(db: sqlite3.Connection, df, args) -> int:
    if df is None or df.empty:
        return 0
    count = 0
    rows_to_insert = []
    for row in df.to_dict(orient="records"):
        gsis = pick(row, PLAYERSTATS_MAP["gsis_id"])
        if not gsis:
            continue
        out = {
            "season": int(row.get("season") or 0),
            "week": int(row.get("week") or 0),
            "gsis_id": gsis,
            "pos_group": pos_group_of(pick(row, ["position"])),
            "starter_nfl": None,
            "source": "nflverse",
        }
        for col, candidates in PLAYERSTATS_MAP.items():
            if col == "gsis_id":
                continue
            v = pick(row, candidates)
            if v is None or str(v) == "":
                out[col] = None
            else:
                try:
                    if col in {"def_sacks"}:
                        out[col] = float(v)
                    elif col in {"team", "opponent", "position"}:
                        out[col] = str(v)
                    else:
                        out[col] = int(float(v))
                except (ValueError, TypeError):
                    out[col] = None
        # Derive def_tackles_total = solo + ast (nflverse aliases for the total
        # silently miss; both solo and ast populate reliably). Keith 2026-04-26.
        solo = out.get("def_tackles_solo")
        ast  = out.get("def_tackles_ast")
        if solo is not None or ast is not None:
            out["def_tackles_total"] = (solo or 0) + (ast or 0)
        rows_to_insert.append(out)
        count += 1

    if not rows_to_insert:
        return 0

    cols = list(rows_to_insert[0].keys())
    row_tuples = [tuple(r[c] for c in cols) for r in rows_to_insert]

    if not args.skip_local:
        try:
            placeholders = ",".join("?" for _ in cols)
            col_list = ",".join(cols)
            update_cols = ",".join(f"{c}=excluded.{c}" for c in cols if c not in {"season", "week", "gsis_id"})
            sql = f"""
                INSERT INTO nfl_player_weekly ({col_list})
                VALUES ({placeholders})
                ON CONFLICT(season, week, gsis_id)
                DO UPDATE SET {update_cols}
            """
            db.executemany(sql, row_tuples)
            db.commit()
            print(f"  [weekly] local: upserted {count} rows", file=sys.stderr)
        except sqlite3.OperationalError as e:
            print(f"  [weekly] local: FAILED ({e})", file=sys.stderr)

    if not args.skip_d1 and row_tuples:
        print(f"  [weekly] D1: writing {len(row_tuples)} rows ...", file=sys.stderr)
        # Wide table (~55 cols) — keep chunk_size at the default 80 which
        # the d1_io chunker tested at ~46KB/statement, well under D1's
        # 100KB cap.
        with D1Writer(
            table="nfl_player_weekly", cols=cols,
            pk_cols=["season","week","gsis_id"],
        ) as w:
            for r in row_tuples:
                w.add(r)

    return count


def upsert_snaps(db: sqlite3.Connection, df, args) -> int:
    if df is None or df.empty:
        return 0
    count = 0
    rows_to_insert = []
    for row in df.to_dict(orient="records"):
        pfr = pick(row, SNAP_MAP["pfr_id"])
        if not pfr:
            continue
        out = {
            "season": int(row.get("season") or 0),
            "week": int(row.get("week") or 0),
            "pfr_id": pfr,
        }
        for col, candidates in SNAP_MAP.items():
            if col == "pfr_id":
                continue
            v = pick(row, candidates)
            if v is None or str(v) == "":
                out[col] = None
            elif col.endswith("_pct"):
                try: out[col] = float(v)
                except (ValueError, TypeError): out[col] = None
            elif col == "team":
                out[col] = str(v)
            else:
                try: out[col] = int(float(v))
                except (ValueError, TypeError): out[col] = None
        # Add team-snap denominators later from team rollups (Phase 3)
        out.setdefault("off_snaps_team", None)
        out.setdefault("def_snaps_team", None)
        out.setdefault("st_snaps_team", None)
        rows_to_insert.append(out)
        count += 1

    if not rows_to_insert:
        return 0

    cols = list(rows_to_insert[0].keys())
    row_tuples = [tuple(r[c] for c in cols) for r in rows_to_insert]

    if not args.skip_local:
        try:
            placeholders = ",".join("?" for _ in cols)
            col_list = ",".join(cols)
            update_cols = ",".join(f"{c}=excluded.{c}" for c in cols if c not in {"season", "week", "pfr_id"})
            sql = f"""
                INSERT INTO nfl_player_snaps ({col_list})
                VALUES ({placeholders})
                ON CONFLICT(season, week, pfr_id)
                DO UPDATE SET {update_cols}
            """
            db.executemany(sql, row_tuples)
            db.commit()
            print(f"  [snaps] local: upserted {count} rows", file=sys.stderr)
        except sqlite3.OperationalError as e:
            print(f"  [snaps] local: FAILED ({e})", file=sys.stderr)

    if not args.skip_d1 and row_tuples:
        print(f"  [snaps] D1: writing {len(row_tuples)} rows ...", file=sys.stderr)
        with D1Writer(
            table="nfl_player_snaps", cols=cols,
            pk_cols=["season","week","pfr_id"],
        ) as w:
            for r in row_tuples:
                w.add(r)

    return count


def ensure_tables(db: sqlite3.Connection) -> None:
    # Create the same schema as worker/migrations/0006_advanced_stats_schema.sql
    # locally so this script works standalone on fresh machines.
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_weekly (
          season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL,
          team TEXT, opponent TEXT, position TEXT, pos_group TEXT,
          rush_att INTEGER, rush_yds INTEGER, rush_tds INTEGER, rush_long INTEGER,
          rush_fumbles INTEGER, rush_fumbles_lost INTEGER,
          targets INTEGER, receptions INTEGER, rec_yds INTEGER, rec_tds INTEGER,
          rec_long INTEGER, rec_fumbles INTEGER, rec_fumbles_lost INTEGER,
          pass_att INTEGER, pass_cmp INTEGER, pass_yds INTEGER, pass_tds INTEGER,
          pass_ints INTEGER, pass_sacks INTEGER, pass_sack_yds INTEGER,
          pass_long INTEGER, pass_2pt INTEGER,
          def_tackles_solo INTEGER, def_tackles_ast INTEGER, def_tackles_total INTEGER,
          def_tfl INTEGER, def_qb_hits INTEGER, def_sacks REAL, def_sack_yds INTEGER,
          def_ff INTEGER, def_fr INTEGER, def_ints INTEGER, def_pass_def INTEGER,
          def_tds INTEGER,
          fg_att INTEGER, fg_made INTEGER, fg_long INTEGER,
          fg_att_0_39 INTEGER, fg_made_0_39 INTEGER,
          fg_att_40_49 INTEGER, fg_made_40_49 INTEGER,
          fg_att_50plus INTEGER, fg_made_50plus INTEGER,
          xp_att INTEGER, xp_made INTEGER,
          punts INTEGER, punt_yds INTEGER, punt_long INTEGER,
          punt_inside20 INTEGER, punt_net_avg REAL,
          starter_nfl INTEGER, source TEXT DEFAULT 'nflverse',
          PRIMARY KEY (season, week, gsis_id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_nflweekly_player ON nfl_player_weekly (gsis_id, season)")
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_snaps (
          season INTEGER NOT NULL, week INTEGER NOT NULL, pfr_id TEXT NOT NULL,
          team TEXT,
          off_snaps INTEGER, off_snaps_team INTEGER, off_snap_pct REAL,
          def_snaps INTEGER, def_snaps_team INTEGER, def_snap_pct REAL,
          st_snaps INTEGER, st_snaps_team INTEGER, st_snap_pct REAL,
          PRIMARY KEY (season, week, pfr_id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_nflsnaps_player ON nfl_player_snaps (pfr_id, season)")
    db.commit()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2011-2025",
                    help='Season list: "2011-2025" or "2023,2024" (default: 2011-2025)')
    ap.add_argument("--skip-snaps", action="store_true")
    ap.add_argument("--skip-playerstats", action="store_true")
    ap.add_argument("--skip-local", action="store_true",
                    help="Skip the local SQLite UPSERT — useful when iCloud is holding the DB lock")
    ap.add_argument("--skip-d1", action="store_true",
                    help="Skip the D1 dual-write — useful for local-only debug runs")
    args = ap.parse_args()

    if not args.skip_local and not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}")
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

    if not args.skip_playerstats:
        df_ps = fetch_playerstats(seasons)
        n = upsert_player_weekly(db, df_ps, args)
        print(f"  nfl_player_weekly: {n} rows upserted", file=sys.stderr)

    if not args.skip_snaps:
        df_sn = fetch_snaps(seasons)
        if df_sn is not None:
            n = upsert_snaps(db, df_sn, args)
            print(f"  nfl_player_snaps:  {n} rows upserted", file=sys.stderr)
        else:
            print("  (snaps skipped — no seasons >= 2012)", file=sys.stderr)

    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: nflverse weekly fetch (local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
