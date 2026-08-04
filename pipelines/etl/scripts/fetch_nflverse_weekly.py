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
from lib.nflverse_seasons import available_seasons  # noqa: E402


# ---------------------------------------------------------------
# Column mapping — nflverse returns many columns; we select a
# subset and fold them into our wide schema. Nullable columns
# simply return None for positions that don't have the stat.
# ---------------------------------------------------------------

# ── COMPANION-TABLE ROUTING ────────────────────────────────────────────────
# nfl_player_weekly is at EXACTLY 100 columns, which is D1's hard per-table cap
# — `ALTER TABLE ... ADD COLUMN` on it now fails outright with
# "too many columns on sqlite_altertab_nfl_player_weekly: SQLITE_ERROR".
# Every column added from 2026-08-04 onward therefore lands in the 1:1
# companion table nfl_player_weekly_ext (worker/migrations/0114), which shares
# the (season, week, gsis_id) key. Add new columns to PLAYERSTATS_MAP as usual
# and list them here; upsert_player_weekly() splits the write automatically.
PK_COLS = ["season", "week", "gsis_id"]
EXT_COLS = {
    "def_tackles_with_assist",
    "pass_first_downs",
    "rush_first_downs",
    "rec_first_downs",
    "kickoff_returns",
    "kickoff_return_yards",
    "punt_returns",
    "punt_return_yards",
    "punt_return_tds",
    "special_teams_tds",
}

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
    # receiving_air_yards also lives NATIVELY in nflverse weekly (verified
    # 2026-07-02 — JJ wk1 2025 = 69). The PFR advstats fetcher nominally owns
    # this column but PFR's payload has no such field, so it no-oped forever
    # (COALESCE(NULL, existing)) and the column sat empty in D1. The weekly
    # fetcher is the real owner; feeds AY-share / WOPR / RACR on the workbench.
    "receiving_air_yards":       ["receiving_air_yards"],

    # ── FIRST DOWNS — UPS `FD 1-999 = *0.2`, ALL positions, continuous since
    # 2011 (the 2021 `1C`→`FD` rename was cosmetic). These were never mapped,
    # so first downs were entirely absent from D1 and UPS scoring could not be
    # reproduced for any offensive player. Adding them takes offensive
    # reconstruction MAE from 2.234 → 0.264 pts/player-week.
    #
    # UPS credits the QB for PASSING first downs too (confirmed — not
    # ball-carrier-only): Drake Maye 2025 = 238 passing + 50 rushing FD = 57.6
    # pts/season that were previously invisible.
    #
    # Keep the three SEPARATE — do not pre-sum them. UPS `FD` scoring wants all
    # of them, but FDPRR (receiving first downs per route run) is a
    # receiving-only route-efficiency metric and must never include rushing FDs.
    # (Claude 2026-08-04.)
    "pass_first_downs": ["passing_first_downs"],
    "rush_first_downs": ["rushing_first_downs"],
    "rec_first_downs":  ["receiving_first_downs"],

    # ── RETURN GAME — UPS `KY *.025` / `UY *.05` / `KO` / `PR` ─────────────
    # Never previously mapped, so a pure return specialist looked like a player
    # who scored from nothing: Charlie Jones 12.1 UPS pts in 2025 wk9 with zero
    # offensive stats in this table. Stored verbatim (no pre-summing) so the
    # scoring layer applies the UPS rates.
    #
    # ⚠️ special_teams_tds is a MIXED bucket, not "return TDs" — 2025 has WR 16,
    # RB 4, CB 3, DE 3, DT 1, SAF 1, and the defensive entries are blocked-kick
    # / muffed-punt recoveries that UPS scores under BLF/BLP/FR instead. It is
    # captured for reconciliation only. nflverse has NO kickoff_return_tds
    # column, and return-TD DISTANCE (the 6-vs-7 tier) is not in this feed
    # either; both need PBP. See migration 0117.
    "kickoff_returns":      ["kickoff_returns"],
    "kickoff_return_yards": ["kickoff_return_yards"],
    "punt_returns":         ["punt_returns"],
    "punt_return_yards":    ["punt_return_yards"],
    "punt_return_tds":      ["pt_return_tds"],
    "special_teams_tds":    ["special_teams_tds"],

    # IDP
    # ── TACKLE SEMANTICS — read before touching these three lines. ──────────
    # The NFL gamebook records THREE DISJOINT tackle credits, and nflverse
    # parses each into its own column (verified at PBP level: across all 702
    # `tackle_with_assist` plays in 2025 the twa player appears as solo_tackle_N
    # zero times and as assist_tackle_N zero times — no overlap in any
    # direction):
    #   "(A)"              → A    = def_tackles_solo        unassisted tackle
    #   "(A, B)"  comma    → A    = def_tackles_with_assist  A MADE it, with help
    #                        B    = def_tackle_assists
    #   "(A; B)"  semicolon→ both = def_tackle_assists
    #
    # Therefore, for UPS scoring:
    #     MFL TK  =  def_tackles_solo + def_tackles_with_assist
    #     MFL AS  =  def_tackles_ast   (nflverse def_tackle_assists)
    # and official-combined (== PFR `comb`) = all three summed. Corroborated:
    # Bobby Wagner 2023 PFR 183 = 77 solo + 19 twa + 87 assists, exactly.
    #
    # HISTORY OF THE BUG (Claude 2026-08-04): `def_tackles_ast` was bound to
    # `def_tackles_with_assist` — a TACKLE count — while the real assist column
    # `def_tackle_assists` was absent from the alias list entirely, so pick()
    # could never reach it. That put a tackle count in the assist bucket (2025:
    # 702 instead of 17,056) and left TK short by twa. The two errors CANCELLED
    # in the derived total below (solo+ast == solo+twa == correct TK), which is
    # why the table looked plausible for two years. Fixing the alias ALONE
    # breaks that cancellation and is strictly worse than the bug: 2025 IDP MAE
    # 0.81 → 1.63, league IDP points +36.2%. Both lines and the derivation must
    # move together.
    #
    # Single-alias lists are deliberate. Every removed alias ("solo_tackles",
    # "tackles_solo", "assist_tackles", "tackles_assists", "def_tackles",
    # "total_tackles", "tackles") resolves in ZERO seasons 1999-2025, and
    # "tackles_for_loss_assist" is a different stat (assisted TFL). Per the
    # repo's no-fail-open rule a never-matching alias is not harmless — it is a
    # silent mis-binding landmine waiting for the next upstream rename.
    "def_tackles_solo":        ["def_tackles_solo"],         # NOT the MFL TK count on its own
    "def_tackles_with_assist": ["def_tackles_with_assist"],  # tackle MADE with help → scores as TK
    "def_tackles_ast":         ["def_tackle_assists"],       # the real assist count → scores as AS
    # def_tackles_total is DERIVED below (official combined), never sourced.
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


def pos_group_of(position) -> str:
    # nflreadpy can hand back a float NaN for a missing position → guard the .upper().
    p = (position if isinstance(position, str) else "").upper()
    if p in {"QB"}: return "QB"
    if p in {"RB", "FB"}: return "RB"
    if p in {"WR"}: return "WR"
    if p in {"TE"}: return "TE"
    if p in {"K", "PK"}: return "PK"
    # UPS scores punters SEPARATELY from kickers (PN pays PI *4 per punt inside
    # the 20 and an ANY net-average tier; PK pays FG *.1/yd + XP). Collapsing P
    # into PK — as this did until 2026-08-04 — makes the two indistinguishable
    # downstream. src_weekly already carries PK and PN as distinct groups.
    if p in {"P", "PN"}: return "PN"
    if p in {"DE", "DT", "NT", "DL", "EDGE", "DEF"}: return "DL"
    if p in {"OLB", "ILB", "MLB", "LB"}: return "LB"
    # "SAF" is how nflverse spells safety. Its absence here sent 6,772 rows
    # (1,545 in 2025 alone — 36% of all DBs) through the fall-through below as
    # pos_group='SAF', so every consumer filtering pos_group='DB' silently lost
    # more than a third of the defensive backs.
    if p in {"CB", "SS", "FS", "S", "SAF", "DB"}: return "DB"
    # Terminal bucket. The old `return p` leaked raw nflverse labels into
    # pos_group — 15,015 rows of OT/G/C/LS/OL — making the column look like it
    # held a controlled vocabulary when it did not.
    #
    # ⚠️ pos_group here is NFLVERSE's positional view, and it does NOT always
    # agree with MFL's. MFL classifies edge rushers (Brian Burns, Byron Young,
    # Jonathon Cooper, Micah Parsons …) as DE while nflverse calls them LB —
    # 830 player-weeks in 2025. UPS pays DL tackles 1.5 and LB tackles 1.0, so
    # ANY UPS SCORING MUST KEY OFF THE MFL POSITION (src_weekly.pos_group), never
    # off this column. This column is for NFL-side filtering and display only.
    return "OTHER"


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
        # A float NaN is truthy, so `if not gsis` lets it through → it lands as a
        # NULL gsis_id and trips the D1 NOT NULL constraint. Require a real string.
        if not isinstance(gsis, str) or not gsis.strip():
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
        # Derive def_tackles_total = OFFICIAL COMBINED tackles, i.e. all three
        # disjoint gamebook credits summed. This reconciles to PFR `comb` within
        # 0.0-1.0% in every season 2018-2025.
        #
        # ⚠️ def_tackles_total IS NOT A UPS SCORING INPUT. UPS pays TK and AS at
        # different per-position rates (DT/DE 1.5/0.5, CB/S 1.3/0.8, LB 1.0/0.5),
        # so the scoring layer must compute:
        #       TK = def_tackles_solo + def_tackles_with_assist
        #       AS = def_tackles_ast
        # and must never read def_tackles_total as "tackles". Note that existing
        # UI consumers override the stored total with solo (worker/src/index.js
        # :9429/:9821/:11009/:11092) and label it "Solo tackles" — the model
        # layer is the first real consumer of the raw column, so this definition
        # is pinned here on purpose. (Claude 2026-08-04; was solo+ast, which
        # equalled TK only by accident of the mis-binding described above.)
        solo = out.get("def_tackles_solo")
        twa  = out.get("def_tackles_with_assist")
        ast  = out.get("def_tackles_ast")
        if solo is not None or twa is not None or ast is not None:
            out["def_tackles_total"] = (solo or 0) + (twa or 0) + (ast or 0)
        rows_to_insert.append(out)
        count += 1

    if not rows_to_insert:
        return 0

    # nfl_player_weekly sits at D1's hard 100-column cap, so every column added
    # after 2026-08-04 lands in the 1:1 companion table nfl_player_weekly_ext
    # (migration 0114). Split the row here: PK cols go to both, EXT_COLS go only
    # to the companion, everything else stays in the main table.
    all_cols  = list(rows_to_insert[0].keys())
    main_cols = [c for c in all_cols if c not in EXT_COLS]
    ext_cols  = PK_COLS + [c for c in all_cols if c in EXT_COLS]

    cols = main_cols
    row_tuples = [tuple(r[c] for c in cols) for r in rows_to_insert]

    # Only keep ext rows carrying at least one NONZERO payload value.
    #
    # This must be truthiness, not `is not None`. nflverse returns 0 (not NULL)
    # for "no first downs / no returns / no assisted tackles", so an
    # `is not None` test admits every player-week in the league and the table
    # fills with all-zero rows — 2,300 of them landed in 2025 from an earlier
    # run before this was tightened. They are harmless to read (COALESCE gives 0
    # either way) but they contradict the coverage contract documented in
    # backfill_tackle_semantics.py, where an ABSENT row means "recorded none of
    # these events", and they burn D1 writes on nothing.
    ext_payload = [c for c in ext_cols if c not in PK_COLS]
    ext_tuples = [
        tuple(r[c] for c in ext_cols)
        for r in rows_to_insert
        if any(r.get(c) for c in ext_payload)
    ]

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

    if not args.skip_d1 and ext_tuples:
        print(f"  [weekly] D1 ext: writing {len(ext_tuples)} rows "
              f"({', '.join(ext_payload)}) ...", file=sys.stderr)
        with D1Writer(
            table="nfl_player_weekly_ext", cols=ext_cols,
            pk_cols=PK_COLS,
        ) as w:
            for r in ext_tuples:
                w.add(r)

    return count


def upsert_snaps(db: sqlite3.Connection, df, args) -> int:
    if df is None or df.empty:
        return 0
    count = 0
    rows_to_insert = []
    for row in df.to_dict(orient="records"):
        pfr = pick(row, SNAP_MAP["pfr_id"])
        if not isinstance(pfr, str) or not pfr.strip():   # float NaN is truthy — require a real id
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
    # Companion table — nfl_player_weekly is at D1's 100-column cap, so all
    # columns added from 2026-08-04 live here. Mirrors worker/migrations/0114.
    db.execute("""
        CREATE TABLE IF NOT EXISTS nfl_player_weekly_ext (
          season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL,
          def_tackles_with_assist INTEGER,
          pass_first_downs INTEGER, rush_first_downs INTEGER, rec_first_downs INTEGER,
          kickoff_returns INTEGER, kickoff_return_yards INTEGER,
          punt_returns INTEGER, punt_return_yards INTEGER, punt_return_tds INTEGER,
          special_teams_tds INTEGER,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (season, week, gsis_id)
        )
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_nflweekly_ext_player ON nfl_player_weekly_ext (gsis_id, season)")
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
    seasons = available_seasons(seasons)
    if not seasons:
        print("no available nflverse seasons in range — nothing to fetch", file=sys.stderr)
        sys.exit(0)
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
