#!/usr/bin/env python3
"""Fetch nflverse PFR weekly advanced rec + rush stats.

Pulls two separate nflverse endpoints and merges them into
nfl_player_weekly:

  load_pfr_advstats(stat_type="rec") provides:
    - receiving_drops
    - receiving_broken_tackles
    - passing_drops  (drops by this QB's receivers, when row is a QB)

  load_pfr_advstats(stat_type="rush") provides:
    - rushing_broken_tackles              (RB's actual broken tackles)
    - rushing_yards_before_contact        (YBC — yards at the LoS before
                                           first contact)
    - rushing_yards_after_contact         (YAC — yards gained after
                                           contact, classic RB power
                                           stat)

Keith 2026-04-23: Rico Dowdle 2025 showed BrTkl=3 in the popup but
PFR's season page lists 34 forced missed tackles. Root cause was this
fetcher only pulling the rec payload — the rec endpoint has a
rushing_broken_tackles column that's always NULL. Actual values come
from the rush payload.

What's still NOT in this payload: routes_run (PFF/NGS-subscription
metric; no free source). See governance doc.

Dependencies:
  pip install nflreadpy pandas

Usage:
  python3 pipelines/etl/scripts/fetch_pfr_advstats.py --seasons 2018-2025
  python3 pipelines/etl/scripts/fetch_pfr_advstats.py --seasons 2024,2025
"""
from __future__ import annotations
import argparse
import os
import sqlite3
import sys
from pathlib import Path

# Honor $MFL_DB_PATH like every other ETL script (Keith 2026-04-25).
_DEFAULT_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
LOCAL_DB = Path(os.environ.get("MFL_DB_PATH") or _DEFAULT_DB)

# Dual-write D1 path. Local SQLite stays primary until verified.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402


def _dual_write_d1(table: str, pk_cols: list[str], augment_cols: list[str],
                   rows: list[tuple], skip_d1: bool, label: str = "") -> bool:
    """Push the same rows that just went to local SQLite up to D1.

    Local UPDATE row format is (augment_cols..., *pk_cols) — reorder
    here to (pk_cols..., augment_cols...) which is what D1Writer +
    UPSERT-by-PK expect. Returns True if D1 wrote, False if skipped.
    """
    if skip_d1 or not rows:
        return False
    d1_cols = list(pk_cols) + list(augment_cols)
    pk_n = len(pk_cols)
    aug_n = len(augment_cols)
    d1_rows = [tuple(list(r[aug_n:aug_n+pk_n]) + list(r[:aug_n])) for r in rows]
    print(f"  [{label}] D1: writing {len(d1_rows)} rows ...", file=sys.stderr)
    with D1Writer(table=table, cols=d1_cols, pk_cols=pk_cols) as w:
        for r in d1_rows:
            w.add(r)
    return True


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


def build_pfr_to_gsis(db: sqlite3.Connection) -> dict[str, str]:
    rows = db.execute("""
        SELECT pfr_id, gsis_id FROM player_id_crosswalk
         WHERE pfr_id IS NOT NULL AND gsis_id IS NOT NULL
    """).fetchall()
    return {r[0]: r[1] for r in rows}


def _load(stat_type: str, seasons: list[int]):
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit("FATAL: nflreadpy not installed. Run: pip install nflreadpy pandas")
    print(f"  loading PFR {stat_type} advstats {seasons[0]}-{seasons[-1]}...", file=sys.stderr)
    df = nfl.load_pfr_advstats(seasons=seasons, stat_type=stat_type)
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    print(f"  got {len(df)} rows", file=sys.stderr)
    return df


def _col_int(row, *names):
    for n in names:
        if n in row and row[n] is not None:
            try:
                v = float(row[n])
                if v != v:  # NaN
                    continue
                return int(v)
            except (ValueError, TypeError):
                continue
    return None


def _col_float(row, *names):
    """Like _col_int but preserves decimal — for rates / ADOT / ratings."""
    for n in names:
        if n in row and row[n] is not None:
            try:
                v = float(row[n])
                if v != v:
                    continue
                return v
            except (ValueError, TypeError):
                continue
    return None


def upsert_rec_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict, args, verbose: bool = False) -> int:
    if df is None or df.empty:
        return 0
    rows = []
    skipped = 0
    unmapped = {}
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1; continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1
            if verbose:
                key = str(pfr)
                if key not in unmapped:
                    unmapped[key] = {"name": row.get("pfr_player_name") or "?", "count": 0}
                unmapped[key]["count"] += 1
            continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week: continue
        rec_drops    = _col_int(row, "receiving_drop", "receiving_drops")
        rec_brtkl    = _col_int(row, "receiving_broken_tackles")
        pass_drops   = _col_int(row, "passing_drops")
        rec_rat      = _col_float(row, "receiving_rat", "receiving_rating")
        rec_int      = _col_int(row, "receiving_int", "receiving_ints")
        rec_drop_pct = _col_float(row, "receiving_drop_pct")
        rec_adot     = _col_float(row, "receiving_adot", "adot")
        rec_ay       = _col_int(row, "receiving_air_yards", "air_yards")
        if all(x is None for x in (rec_drops, rec_brtkl, pass_drops, rec_rat, rec_int, rec_drop_pct, rec_adot, rec_ay)):
            continue
        rows.append((rec_drops, rec_brtkl, pass_drops, rec_rat, rec_int, rec_drop_pct, rec_adot, rec_ay, season, week, gsis))

    if verbose and unmapped:
        print(f"  [rec] unmapped pfr_ids ({len(unmapped)} distinct players):", file=sys.stderr)
        top = sorted(unmapped.items(), key=lambda kv: -kv[1]["count"])[:30]
        for pfr_id, info in top:
            print(f"    {pfr_id:12s}  {info['count']:3d} rows  {info['name']}", file=sys.stderr)
        if len(unmapped) > 30:
            print(f"    ...and {len(unmapped) - 30} more", file=sys.stderr)

    if not rows:
        print(f"  [rec] nothing to upsert (skipped {skipped} unmapped)", file=sys.stderr)
        return 0
    if not args.skip_local:
        try:
            db.executemany(
                """
                UPDATE nfl_player_weekly
                   SET receiving_drops          = COALESCE(?, receiving_drops),
                       receiving_broken_tackles = COALESCE(?, receiving_broken_tackles),
                       passing_drops            = COALESCE(?, passing_drops),
                       receiving_rat            = COALESCE(?, receiving_rat),
                       receiving_int            = COALESCE(?, receiving_int),
                       receiving_drop_pct       = COALESCE(?, receiving_drop_pct),
                       receiving_adot           = COALESCE(?, receiving_adot),
                       receiving_air_yards      = COALESCE(?, receiving_air_yards)
                 WHERE season = ? AND week = ? AND gsis_id = ?
                """,
                rows,
            )
            db.commit()
            print(f"  [rec] local: updated {len(rows)} rows", file=sys.stderr)
        except sqlite3.OperationalError as e:
            print(f"  [rec] local: FAILED ({e})", file=sys.stderr)
    _dual_write_d1(
        "nfl_player_weekly", ["season","week","gsis_id"],
        ["receiving_drops","receiving_broken_tackles","passing_drops",
         "receiving_rat","receiving_int","receiving_drop_pct",
         "receiving_adot","receiving_air_yards"],
        rows, args.skip_d1, label="rec",
    )
    return len(rows)


def upsert_pass_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict, args) -> int:
    """QB advanced from stat_type='pass': bad throws, pressures, air yards, ADOT."""
    if df is None or df.empty:
        return 0
    rows = []
    skipped = 0
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1; continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1; continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week: continue
        bad_throws = _col_int(row, "passing_bad_throws", "bad_throws")
        bad_pct    = _col_float(row, "passing_bad_throw_pct", "bad_throw_pct")
        pressured  = _col_int(row, "passing_times_pressured", "times_pressured", "pressured")
        pr_pct     = _col_float(row, "times_pressured_pct", "passing_pressure_pct", "pressure_pct")
        hurries    = _col_int(row, "passing_hurries", "hurries")
        hits       = _col_int(row, "passing_hits", "hits")
        ay         = _col_int(row, "passing_air_yards")
        adot       = _col_float(row, "passing_adot", "adot")
        pyac       = _col_int(row, "passing_yards_after_catch", "yards_after_catch")
        if all(x is None for x in (bad_throws, bad_pct, pressured, pr_pct, hurries, hits, ay, adot, pyac)):
            continue
        rows.append((bad_throws, bad_pct, pressured, pr_pct, hurries, hits, ay, adot, pyac, season, week, gsis))

    if not rows:
        print(f"  [pass] nothing to upsert (skipped {skipped} unmapped)", file=sys.stderr)
        return 0
    if not args.skip_local:
        try:
            db.executemany(
                """
                UPDATE nfl_player_weekly
                   SET passing_bad_throws        = COALESCE(?, passing_bad_throws),
                       passing_bad_throw_pct     = COALESCE(?, passing_bad_throw_pct),
                       passing_times_pressured   = COALESCE(?, passing_times_pressured),
                       passing_pressure_pct      = COALESCE(?, passing_pressure_pct),
                       passing_hurries           = COALESCE(?, passing_hurries),
                       passing_hits              = COALESCE(?, passing_hits),
                       passing_air_yards         = COALESCE(?, passing_air_yards),
                       passing_adot              = COALESCE(?, passing_adot),
                       passing_yards_after_catch = COALESCE(?, passing_yards_after_catch)
                 WHERE season = ? AND week = ? AND gsis_id = ?
                """,
                rows,
            )
            db.commit()
            print(f"  [pass] local: updated {len(rows)} rows", file=sys.stderr)
        except sqlite3.OperationalError as e:
            print(f"  [pass] local: FAILED ({e})", file=sys.stderr)
    _dual_write_d1(
        "nfl_player_weekly", ["season","week","gsis_id"],
        ["passing_bad_throws","passing_bad_throw_pct","passing_times_pressured",
         "passing_pressure_pct","passing_hurries","passing_hits",
         "passing_air_yards","passing_adot","passing_yards_after_catch"],
        rows, args.skip_d1, label="pass",
    )
    return len(rows)


def upsert_def_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict, args) -> int:
    """IDP advanced from stat_type='def': missed tackles, rating allowed, pressures."""
    if df is None or df.empty:
        return 0
    rows = []
    skipped = 0
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1; continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1; continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week: continue
        mt        = _col_int(row, "def_missed_tackles", "missed_tackles")
        mt_pct    = _col_float(row, "def_missed_tackle_pct", "missed_tackle_pct")
        cmp_allow = _col_int(row, "def_completions_allowed", "completions_allowed")
        rat       = _col_float(row, "def_passer_rating_allowed", "passer_rating_allowed")
        yds_allow = _col_int(row, "def_yards_allowed", "yards_allowed")
        pressures = _col_int(row, "def_pressures", "pressures")
        if all(x is None for x in (mt, mt_pct, cmp_allow, rat, yds_allow, pressures)):
            continue
        rows.append((mt, mt_pct, cmp_allow, rat, yds_allow, pressures, season, week, gsis))

    if not rows:
        print(f"  [def] nothing to upsert (skipped {skipped} unmapped)", file=sys.stderr)
        return 0
    if not args.skip_local:
        try:
            db.executemany(
                """
                UPDATE nfl_player_weekly
                   SET def_missed_tackles        = COALESCE(?, def_missed_tackles),
                       def_missed_tackle_pct     = COALESCE(?, def_missed_tackle_pct),
                       def_completions_allowed   = COALESCE(?, def_completions_allowed),
                       def_passer_rating_allowed = COALESCE(?, def_passer_rating_allowed),
                       def_yards_allowed         = COALESCE(?, def_yards_allowed),
                       def_pressures             = COALESCE(?, def_pressures)
                 WHERE season = ? AND week = ? AND gsis_id = ?
                """,
                rows,
            )
            db.commit()
            print(f"  [def] local: updated {len(rows)} rows", file=sys.stderr)
        except sqlite3.OperationalError as e:
            print(f"  [def] local: FAILED ({e})", file=sys.stderr)
    _dual_write_d1(
        "nfl_player_weekly", ["season","week","gsis_id"],
        ["def_missed_tackles","def_missed_tackle_pct","def_completions_allowed",
         "def_passer_rating_allowed","def_yards_allowed","def_pressures"],
        rows, args.skip_d1, label="def",
    )
    return len(rows)


def upsert_rush_weekly(db: sqlite3.Connection, df, pfr_to_gsis: dict, args, verbose: bool = False) -> int:
    if df is None or df.empty:
        return 0
    rows = []
    skipped = 0
    unmapped = {}
    for row in df.to_dict(orient="records"):
        pfr = row.get("pfr_player_id") or row.get("pfr_id")
        if not pfr:
            skipped += 1; continue
        gsis = pfr_to_gsis.get(str(pfr))
        if not gsis:
            skipped += 1
            if verbose:
                key = str(pfr)
                if key not in unmapped:
                    unmapped[key] = {
                        "name": row.get("pfr_player_name") or "?",
                        "count": 0,
                    }
                unmapped[key]["count"] += 1
            continue
        season = int(row.get("season") or 0)
        week = int(row.get("week") or 0)
        if not season or not week: continue
        rush_brtkl = _col_int(row, "rushing_broken_tackles")
        rush_ybc   = _col_int(row, "rushing_yards_before_contact", "rushing_ybc")
        rush_yac   = _col_int(row, "rushing_yards_after_contact", "rushing_yac")
        if rush_brtkl is None and rush_ybc is None and rush_yac is None:
            continue
        rows.append((rush_brtkl, rush_ybc, rush_yac, season, week, gsis))

    if verbose and unmapped:
        print(f"  [rush] unmapped pfr_ids ({len(unmapped)} distinct players):", file=sys.stderr)
        top = sorted(unmapped.items(), key=lambda kv: -kv[1]["count"])[:30]
        for pfr_id, info in top:
            print(f"    {pfr_id:12s}  {info['count']:3d} rows  {info['name']}", file=sys.stderr)
        if len(unmapped) > 30:
            print(f"    ...and {len(unmapped) - 30} more", file=sys.stderr)

    if not rows:
        print(f"  [rush] nothing to upsert (skipped {skipped} unmapped)", file=sys.stderr)
        return 0
    if not args.skip_local:
        try:
            db.executemany(
                """
                UPDATE nfl_player_weekly
                   SET rushing_broken_tackles        = COALESCE(?, rushing_broken_tackles),
                       rushing_yards_before_contact  = COALESCE(?, rushing_yards_before_contact),
                       rushing_yards_after_contact   = COALESCE(?, rushing_yards_after_contact)
                 WHERE season = ? AND week = ? AND gsis_id = ?
                """,
                rows,
            )
            db.commit()
            print(f"  [rush] local: updated {len(rows)} rows (skipped {skipped} unmapped)", file=sys.stderr)
        except sqlite3.OperationalError as e:
            print(f"  [rush] local: FAILED ({e})", file=sys.stderr)
    _dual_write_d1(
        "nfl_player_weekly", ["season","week","gsis_id"],
        ["rushing_broken_tackles","rushing_yards_before_contact","rushing_yards_after_contact"],
        rows, args.skip_d1, label="rush",
    )
    return len(rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2018-2025",
                    help='Season list: "2018-2025" (default; PFR rec advstats start 2018)')
    ap.add_argument("--skip-rec", action="store_true", help="Skip the rec stat_type fetch")
    ap.add_argument("--skip-rush", action="store_true", help="Skip the rush stat_type fetch")
    ap.add_argument("--skip-pass", action="store_true", help="Skip the pass stat_type fetch (QB adv)")
    ap.add_argument("--skip-def", action="store_true", help="Skip the def stat_type fetch (IDP adv)")
    ap.add_argument("--verbose", action="store_true",
                    help="Print top-30 unmapped pfr_id + name list at end (diagnostic for crosswalk gaps)")
    ap.add_argument("--skip-local", action="store_true",
                    help="Skip the local SQLite UPDATE — useful when iCloud is holding the DB lock")
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

    seasons = parse_seasons(args.seasons)
    print(f"Target seasons: {seasons}", file=sys.stderr)

    pfr_to_gsis = build_pfr_to_gsis(db)
    print(f"  crosswalk: {len(pfr_to_gsis)} pfr_id → gsis_id mappings", file=sys.stderr)
    if not pfr_to_gsis:
        sys.exit("no crosswalk — run build_player_id_crosswalk.py first")

    total = 0
    if not args.skip_rec:
        df_rec = _load("rec", seasons)
        total += upsert_rec_weekly(db, df_rec, pfr_to_gsis, args, verbose=args.verbose)
    if not args.skip_rush:
        df_rush = _load("rush", seasons)
        total += upsert_rush_weekly(db, df_rush, pfr_to_gsis, args, verbose=args.verbose)
    if not args.skip_pass:
        df_pass = _load("pass", seasons)
        total += upsert_pass_weekly(db, df_pass, pfr_to_gsis, args)
    if not args.skip_def:
        df_def = _load("def", seasons)
        total += upsert_def_weekly(db, df_def, pfr_to_gsis, args)

    local_status = "skipped" if args.skip_local else "ok"
    d1_status = "skipped" if args.skip_d1 else "ok"
    print(f"DONE: {total} player-week rows updated (local={local_status}, d1={d1_status})", file=sys.stderr)


if __name__ == "__main__":
    main()
