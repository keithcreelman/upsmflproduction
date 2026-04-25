#!/usr/bin/env python3
"""Fetch PFR advanced stats at SEASON granularity from nflverse-data releases.

Weekly PFR payloads don't expose ADOT, air yards, YBC/YAC-per-reception, or
bad-throw detail. Those only live in the season-level CSVs:

  https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats/
    advstats_season_rec.csv
    advstats_season_rush.csv
    advstats_season_pass.csv
    advstats_season_def.csv

We download the four CSVs, join by pfr_id → gsis_id (player_id_crosswalk),
and upsert into nfl_player_advstats_season (one row per player-season).

DB path: honors $MFL_DB_PATH; defaults to
/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db
(the path the rest of the fetchers use). Override on the new Mac via:
  export MFL_DB_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL_Scripts/Datastorage/mfl_database.db"

Dependencies: stdlib only (urllib + csv). No pandas / nflreadpy required.

Usage:
  python3 pipelines/etl/scripts/fetch_pfr_season_advstats.py --seasons 2018-2025
  python3 pipelines/etl/scripts/fetch_pfr_season_advstats.py --seasons 2024,2025
"""
from __future__ import annotations
import argparse
import csv
import io
import os
import sqlite3
import sys
import urllib.request
from pathlib import Path

DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or DEFAULT_DB)

BASE_URL = "https://github.com/nflverse/nflverse-data/releases/download/pfr_advstats"


def parse_seasons(spec: str) -> set[int]:
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
    return out


def build_pfr_to_gsis(db: sqlite3.Connection) -> dict[str, str]:
    rows = db.execute("""
        SELECT pfr_id, gsis_id FROM player_id_crosswalk
         WHERE pfr_id IS NOT NULL AND gsis_id IS NOT NULL
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def ensure_table(db: sqlite3.Connection) -> None:
    # Mirror of worker/migrations/0014_pfr_season_advstats.sql so the
    # script works standalone on fresh machines.
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_advstats_season (
          season  INTEGER NOT NULL,
          gsis_id TEXT    NOT NULL,
          pfr_id  TEXT,
          rec_adot REAL, rec_ybc INTEGER, rec_ybc_per_r REAL,
          rec_yac INTEGER, rec_yac_per_r REAL,
          rec_brk_tkl INTEGER, rec_per_br REAL,
          rec_drops INTEGER, rec_drop_pct REAL, rec_int INTEGER, rec_rat REAL,
          rush_ybc INTEGER, rush_ybc_per_a REAL,
          rush_yac INTEGER, rush_yac_per_a REAL,
          rush_brk_tkl INTEGER, rush_att_per_br REAL,
          pass_iay INTEGER, pass_iay_per_att REAL,
          pass_cay INTEGER, pass_cay_per_cmp REAL,
          pass_yac INTEGER, pass_yac_per_cmp REAL,
          pass_bad_throws INTEGER, pass_bad_throw_pct REAL,
          pass_on_tgt INTEGER, pass_on_tgt_pct REAL,
          pass_drops INTEGER, pass_drop_pct REAL,
          pass_pressures INTEGER, pass_pressure_pct REAL,
          pass_times_blitzed INTEGER, pass_times_hurried INTEGER,
          pass_times_hit INTEGER, pass_times_sacked INTEGER,
          pass_pocket_time REAL,
          def_adot REAL, def_air_yards_completed INTEGER, def_yac INTEGER,
          def_targets INTEGER, def_completions_allowed INTEGER,
          def_cmp_pct REAL, def_yards_allowed INTEGER,
          def_yards_per_cmp REAL, def_yards_per_tgt REAL,
          def_tds_allowed INTEGER, def_ints INTEGER,
          def_rating_allowed REAL, def_blitz INTEGER,
          def_hurries INTEGER, def_qb_knockdowns INTEGER,
          def_sacks REAL, def_pressures INTEGER,
          def_combined_tackles INTEGER,
          def_missed_tackles INTEGER, def_missed_tackle_pct REAL,
          PRIMARY KEY (season, gsis_id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_advseason_pfr_id "
               "ON nfl_player_advstats_season (pfr_id)")
    db.commit()


def _download_csv(stat_type: str) -> list[dict]:
    url = f"{BASE_URL}/advstats_season_{stat_type}.csv"
    print(f"  downloading {url} ...", file=sys.stderr)
    with urllib.request.urlopen(url) as r:
        body = r.read().decode("utf-8", errors="replace")
    rdr = csv.DictReader(io.StringIO(body))
    rows = list(rdr)
    print(f"  got {len(rows)} rows", file=sys.stderr)
    return rows


def _i(v):
    if v is None or v == "" or v == "NA":
        return None
    try:
        f = float(v)
        if f != f:
            return None
        return int(f)
    except (ValueError, TypeError):
        return None


def _f(v):
    if v is None or v == "" or v == "NA":
        return None
    try:
        f = float(v)
        if f != f:
            return None
        return f
    except (ValueError, TypeError):
        return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2018-2025",
                    help='Season list: "2018-2025" or "2024,2025"')
    ap.add_argument("--skip-rec", action="store_true")
    ap.add_argument("--skip-rush", action="store_true")
    ap.add_argument("--skip-pass", action="store_true")
    ap.add_argument("--skip-def", action="store_true")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}\n"
                 f"(set MFL_DB_PATH env var if DB lives elsewhere)")
    print(f"DB: {LOCAL_DB}", file=sys.stderr)
    db = sqlite3.connect(str(LOCAL_DB), timeout=30)
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("PRAGMA busy_timeout=30000")
    except sqlite3.DatabaseError:
        pass
    ensure_table(db)

    wanted_seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {sorted(wanted_seasons)}", file=sys.stderr)

    pfr_to_gsis = build_pfr_to_gsis(db)
    print(f"Crosswalk: {len(pfr_to_gsis)} pfr_id → gsis_id mappings", file=sys.stderr)
    if not pfr_to_gsis:
        sys.exit("no crosswalk — run build_player_id_crosswalk.py first")

    # Accumulator: (season, gsis_id) → dict of column assignments.
    # Merge across 4 stat types so each player-season ends up with one
    # consolidated row.
    merged: dict[tuple[int, str], dict] = {}

    def row_for(season: int, gsis: str) -> dict:
        k = (season, gsis)
        if k not in merged:
            merged[k] = {}
        return merged[k]

    if not args.skip_rec:
        print("[rec]", file=sys.stderr)
        for r in _download_csv("rec"):
            s = _i(r.get("season"))
            if s is None or s not in wanted_seasons:
                continue
            pfr = r.get("pfr_id")
            gsis = pfr_to_gsis.get(str(pfr)) if pfr else None
            if not gsis:
                continue
            d = row_for(s, gsis)
            d["pfr_id"] = pfr
            d["rec_adot"] = _f(r.get("adot"))
            d["rec_ybc"] = _i(r.get("ybc"))
            d["rec_ybc_per_r"] = _f(r.get("ybc_r"))
            d["rec_yac"] = _i(r.get("yac"))
            d["rec_yac_per_r"] = _f(r.get("yac_r"))
            d["rec_brk_tkl"] = _i(r.get("brk_tkl"))
            d["rec_per_br"] = _f(r.get("rec_br"))
            d["rec_drops"] = _i(r.get("drop"))
            d["rec_drop_pct"] = _f(r.get("drop_percent"))
            d["rec_int"] = _i(r.get("int"))
            d["rec_rat"] = _f(r.get("rat"))

    if not args.skip_rush:
        print("[rush]", file=sys.stderr)
        for r in _download_csv("rush"):
            s = _i(r.get("season"))
            if s is None or s not in wanted_seasons:
                continue
            pfr = r.get("pfr_id")
            gsis = pfr_to_gsis.get(str(pfr)) if pfr else None
            if not gsis:
                continue
            d = row_for(s, gsis)
            d["pfr_id"] = pfr
            d["rush_ybc"] = _i(r.get("ybc"))
            d["rush_ybc_per_a"] = _f(r.get("ybc_att"))
            d["rush_yac"] = _i(r.get("yac"))
            d["rush_yac_per_a"] = _f(r.get("yac_att"))
            d["rush_brk_tkl"] = _i(r.get("brk_tkl"))
            d["rush_att_per_br"] = _f(r.get("att_br"))

    if not args.skip_pass:
        print("[pass]", file=sys.stderr)
        for r in _download_csv("pass"):
            s = _i(r.get("season"))
            if s is None or s not in wanted_seasons:
                continue
            pfr = r.get("pfr_id")
            gsis = pfr_to_gsis.get(str(pfr)) if pfr else None
            if not gsis:
                continue
            d = row_for(s, gsis)
            d["pfr_id"] = pfr
            d["pass_iay"] = _i(r.get("intended_air_yards"))
            d["pass_iay_per_att"] = _f(r.get("intended_air_yards_per_pass_attempt"))
            d["pass_cay"] = _i(r.get("completed_air_yards"))
            d["pass_cay_per_cmp"] = _f(r.get("completed_air_yards_per_completion"))
            d["pass_yac"] = _i(r.get("pass_yards_after_catch"))
            d["pass_yac_per_cmp"] = _f(r.get("pass_yards_after_catch_per_completion"))
            d["pass_bad_throws"] = _i(r.get("bad_throws"))
            d["pass_bad_throw_pct"] = _f(r.get("bad_throw_pct"))
            d["pass_on_tgt"] = _i(r.get("on_tgt_throws"))
            d["pass_on_tgt_pct"] = _f(r.get("on_tgt_pct"))
            d["pass_drops"] = _i(r.get("drops"))
            d["pass_drop_pct"] = _f(r.get("drop_pct"))
            d["pass_pressures"] = _i(r.get("times_pressured"))
            d["pass_pressure_pct"] = _f(r.get("pressure_pct"))
            d["pass_times_blitzed"] = _i(r.get("times_blitzed"))
            d["pass_times_hurried"] = _i(r.get("times_hurried"))
            d["pass_times_hit"] = _i(r.get("times_hit"))
            # season-level pass file does NOT separately expose times_sacked;
            # we pull that from weekly payload on nfl_player_weekly.pass_sacks.
            d["pass_pocket_time"] = _f(r.get("pocket_time"))

    if not args.skip_def:
        print("[def]", file=sys.stderr)
        for r in _download_csv("def"):
            s = _i(r.get("season"))
            if s is None or s not in wanted_seasons:
                continue
            pfr = r.get("pfr_id")
            gsis = pfr_to_gsis.get(str(pfr)) if pfr else None
            if not gsis:
                continue
            d = row_for(s, gsis)
            d["pfr_id"] = pfr
            d["def_adot"] = _f(r.get("dadot"))
            d["def_air_yards_completed"] = _i(r.get("air"))
            d["def_yac"] = _i(r.get("yac"))
            d["def_targets"] = _i(r.get("tgt"))
            d["def_completions_allowed"] = _i(r.get("cmp"))
            d["def_cmp_pct"] = _f(r.get("cmp_percent"))
            d["def_yards_allowed"] = _i(r.get("yds"))
            d["def_yards_per_cmp"] = _f(r.get("yds_cmp"))
            d["def_yards_per_tgt"] = _f(r.get("yds_tgt"))
            d["def_tds_allowed"] = _i(r.get("td"))
            d["def_ints"] = _i(r.get("int"))
            d["def_rating_allowed"] = _f(r.get("rat"))
            d["def_blitz"] = _i(r.get("bltz"))
            d["def_hurries"] = _i(r.get("hrry"))
            d["def_qb_knockdowns"] = _i(r.get("qbkd"))
            d["def_sacks"] = _f(r.get("sk"))
            d["def_pressures"] = _i(r.get("prss"))
            d["def_combined_tackles"] = _i(r.get("comb"))
            d["def_missed_tackles"] = _i(r.get("m_tkl"))
            d["def_missed_tackle_pct"] = _f(r.get("m_tkl_percent"))

    if not merged:
        print("No rows to upsert. (Check --seasons range vs nflverse coverage.)", file=sys.stderr)
        return

    # Flat column order — keep in sync with ensure_table() above.
    COLS = [
        "season", "gsis_id", "pfr_id",
        "rec_adot", "rec_ybc", "rec_ybc_per_r", "rec_yac", "rec_yac_per_r",
        "rec_brk_tkl", "rec_per_br", "rec_drops", "rec_drop_pct",
        "rec_int", "rec_rat",
        "rush_ybc", "rush_ybc_per_a", "rush_yac", "rush_yac_per_a",
        "rush_brk_tkl", "rush_att_per_br",
        "pass_iay", "pass_iay_per_att", "pass_cay", "pass_cay_per_cmp",
        "pass_yac", "pass_yac_per_cmp",
        "pass_bad_throws", "pass_bad_throw_pct",
        "pass_on_tgt", "pass_on_tgt_pct",
        "pass_drops", "pass_drop_pct",
        "pass_pressures", "pass_pressure_pct",
        "pass_times_blitzed", "pass_times_hurried",
        "pass_times_hit", "pass_times_sacked", "pass_pocket_time",
        "def_adot", "def_air_yards_completed", "def_yac",
        "def_targets", "def_completions_allowed", "def_cmp_pct",
        "def_yards_allowed", "def_yards_per_cmp", "def_yards_per_tgt",
        "def_tds_allowed", "def_ints", "def_rating_allowed",
        "def_blitz", "def_hurries", "def_qb_knockdowns",
        "def_sacks", "def_pressures", "def_combined_tackles",
        "def_missed_tackles", "def_missed_tackle_pct",
    ]
    placeholders = ",".join("?" for _ in COLS)
    update_cols = [c for c in COLS if c not in ("season", "gsis_id")]
    update_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)

    rows = []
    for (season, gsis), d in merged.items():
        row = [season, gsis, d.get("pfr_id")]
        for c in COLS[3:]:
            row.append(d.get(c))
        rows.append(row)

    sql = f"""
        INSERT INTO nfl_player_advstats_season ({",".join(COLS)})
        VALUES ({placeholders})
        ON CONFLICT(season, gsis_id) DO UPDATE SET {update_clause}
    """
    db.executemany(sql, rows)
    db.commit()
    print(f"DONE: upserted {len(rows)} player-season rows "
          f"across {len(set(r[0] for r in rows))} seasons", file=sys.stderr)


if __name__ == "__main__":
    main()
