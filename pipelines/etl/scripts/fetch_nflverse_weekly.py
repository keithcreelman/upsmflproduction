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
import sqlite3
import sys
from pathlib import Path

LOCAL_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")


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
    "pass_sacks":        ["sacks", "passing_sacks"],
    "pass_sack_yds":     ["sack_yards", "passing_sack_yards"],
    "pass_long":         ["passing_long"],
    "pass_2pt":          ["passing_2pt_conversions"],

    # IDP
    "def_tackles_solo":  ["def_tackles_solo", "solo_tackles", "tackles_solo"],
    "def_tackles_ast":   ["def_tackles_with_assist", "assist_tackles", "tackles_assists", "tackles_for_loss_assist"],
    "def_tackles_total": ["def_tackles", "total_tackles", "tackles"],
    "def_tfl":           ["def_tackles_for_loss", "tfl", "tackles_for_loss"],
    "def_qb_hits":       ["def_qb_hits", "qb_hits"],
    "def_sacks":         ["def_sacks", "sacks_total"],
    "def_sack_yds":      ["def_sack_yards", "sack_yards_defensive"],
    "def_ff":            ["def_fumbles_forced", "forced_fumbles", "fumbles_forced"],
    "def_fr":            ["def_fumble_recoveries", "fumble_recoveries"],
    "def_ints":          ["def_interceptions", "interceptions_defensive"],
    "def_pass_def":      ["def_pass_defended", "passes_defended"],
    "def_tds":           ["def_tds", "defensive_tds"],

    # Kicking (PK)
    "fg_att":            ["fg_att", "fga"],
    "fg_made":           ["fg_made", "fgm"],
    "fg_long":           ["fg_long"],
    "fg_att_0_39":       ["fg_att_0_39", "fg_att_short"],
    "fg_made_0_39":      ["fg_made_0_39", "fg_made_short"],
    "fg_att_40_49":      ["fg_att_40_49"],
    "fg_made_40_49":     ["fg_made_40_49"],
    "fg_att_50plus":     ["fg_att_50plus", "fg_att_long"],
    "fg_made_50plus":    ["fg_made_50plus", "fg_made_long"],
    "xp_att":            ["pat_att", "xp_att"],
    "xp_made":           ["pat_made", "xp_made"],

    # Punting
    "punts":             ["punts"],
    "punt_yds":          ["punt_yards"],
    "punt_long":         ["punt_long"],
    "punt_inside20":     ["punts_inside_twenty", "punts_inside_20"],
    "punt_net_avg":      ["punt_net_avg", "punt_avg_net"],
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
    # Diagnostic: punt / def-fumble-recovery columns that exist
    punt_cols = [c for c in df.columns if "punt" in c.lower()]
    fr_cols   = [c for c in df.columns if "fumble" in c.lower() and ("rec" in c.lower() or "fr" in c.lower())]
    if punt_cols: print(f"  punt-related columns: {punt_cols}", file=sys.stderr)
    if fr_cols:   print(f"  fumble-recovery-related columns: {fr_cols}", file=sys.stderr)
    if not punt_cols: print(f"  WARNING: no punt columns in load_player_stats — punter weekly data absent", file=sys.stderr)
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


def upsert_player_weekly(db: sqlite3.Connection, df) -> int:
    if df is None or df.empty:
        return 0
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_weekly AS
        SELECT * FROM (SELECT 0 AS _placeholder) WHERE 0
    """)  # no-op if table doesn't exist yet — the migration defines it
    # For local sqlite, ensure the real table exists by reading schema from migration if missing
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
                    if col in {"def_sacks", "punt_net_avg"}:
                        out[col] = float(v)
                    elif col in {"team", "opponent", "position"}:
                        out[col] = str(v)
                    else:
                        out[col] = int(float(v))
                except (ValueError, TypeError):
                    out[col] = None
        rows_to_insert.append(out)
        count += 1

    if not rows_to_insert:
        return 0

    cols = list(rows_to_insert[0].keys())
    placeholders = ",".join("?" for _ in cols)
    col_list = ",".join(cols)
    update_cols = ",".join(f"{c}=excluded.{c}" for c in cols if c not in {"season", "week", "gsis_id"})
    sql = f"""
        INSERT INTO nfl_player_weekly ({col_list})
        VALUES ({placeholders})
        ON CONFLICT(season, week, gsis_id)
        DO UPDATE SET {update_cols}
    """
    db.executemany(sql, [[r[c] for c in cols] for r in rows_to_insert])
    db.commit()
    return count


def upsert_snaps(db: sqlite3.Connection, df) -> int:
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
    placeholders = ",".join("?" for _ in cols)
    col_list = ",".join(cols)
    update_cols = ",".join(f"{c}=excluded.{c}" for c in cols if c not in {"season", "week", "gsis_id"})
    sql = f"""
        INSERT INTO nfl_player_snaps ({col_list})
        VALUES ({placeholders})
        ON CONFLICT(season, week, pfr_id)
        DO UPDATE SET {update_cols}
    """
    db.executemany(sql, [[r[c] for c in cols] for r in rows_to_insert])
    db.commit()
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
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}")
    db = sqlite3.connect(str(LOCAL_DB))
    ensure_tables(db)

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    if not args.skip_playerstats:
        df_ps = fetch_playerstats(seasons)
        n = upsert_player_weekly(db, df_ps)
        print(f"  nfl_player_weekly: {n} rows upserted", file=sys.stderr)

    if not args.skip_snaps:
        df_sn = fetch_snaps(seasons)
        if df_sn is not None:
            n = upsert_snaps(db, df_sn)
            print(f"  nfl_player_snaps:  {n} rows upserted", file=sys.stderr)
        else:
            print("  (snaps skipped — no seasons >= 2012)", file=sys.stderr)


if __name__ == "__main__":
    main()
