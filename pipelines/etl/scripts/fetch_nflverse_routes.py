#!/usr/bin/env python3
"""Aggregate per-player ROUTE participation from nflverse → nfl_player_routes.

Routes are not published directly (PFF-only); the accepted open-data proxy is
"pass-snap routes": the player was on the field (participation
`offense_players`) for a QB dropback. This slightly OVERCOUNTS true routes —
a WR/TE kept in to pass-block still counts — but it's the standard tradeoff
(TPRR/YPRR built on it track the PFF versions closely for WR/TE).

Rows are kept for ROUTE-RUNNING positions only (WR/TE/RB/FB by the player's
modal `offense_positions` label, which is ;-aligned with `offense_players` —
verified 0 misalignments across 2k sampled plays). Without the filter every
OL/QB "wins" the routes column at ~700 (on field for every dropback) and the
table triples in size with rows no fantasy query would ever join. Early
seasons (2016 verified) have NO `offense_positions` column — those players
fall back to their `load_players()` roster position for the filter.

GRAIN (changed 2026-08-04 — Claude): the primary output is now
`nfl_player_routes_weekly`, keyed (season, week, gsis_id). The legacy
season-grain `nfl_player_routes` is DERIVED from it by summation
(season_rows_from_weekly), so Σ weekly == season holds by construction and the
two grains cannot drift. Both tables are written; /api/player-routes and the
workbench see identical season numbers (verified on 2025: routes 98,506,
team_dropbacks 206,150, targets 16,622, rec yards 121,833 — all exact matches
against the pre-existing stored values).

WHY WEEKLY EXISTS AT ALL — this is a LEAKAGE fix, not a convenience. The season
table holds COMPLETED full-season totals. Reading it while generating a
historical Week 5 prediction hands the model route volume that includes Weeks
6-18 — i.e. it reveals, at Week 5, the season-end usage of exactly the players
whose roles were about to expand. The season table is therefore permitted ONLY
as a `season <= target_season - 1` prior; same-season as-of-week features must
read the weekly table. See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.1.

For each (season, week, gsis_id), REG season only, we store SUMS ONLY (not
rates) so any window — week, month, season, multi-season — re-aggregates
exactly:

  routes         : REG dropback plays where the player appears in
                   participation `offense_players`
  team_dropbacks : GAME-ALIGNED Route% denominator — the sum over games of
                   his team's dropbacks in games he appeared in (a player
                   traded mid-season, or who missed weeks, gets the correct
                   denominator; a season-total-of-primary-team would not).
                   Only dropbacks present in the participation feed count,
                   keeping numerator and denominator on the same play set.
  routes_tgt     : his targets (pbp receiver_player_id) on those plays
  routes_rec_yds : receiving yards on those plays

Dropback detection: the participation frame has NO dropback/pass indicator
(verified 2016-2025, nflreadpy 0.1.5 — cols are formation/personnel/players
only), so we JOIN nflreadpy.load_pbp on (nflverse_game_id==game_id, play_id)
for `qb_dropback == 1`, `season_type == 'REG'`, `receiver_player_id`,
`receiving_yards`. A runtime check still probes for an indicator column and
prints a diagnostic in case a future participation release grows one.
qb_dropback includes sacks + scrambles — routes ARE run on those, so that's
correct for route counting. Weeks are stored as-is (fantasy 1-17 filtering
happens at query time elsewhere), same convention as nfl_player_epa.

Source : nflreadpy.load_participation(seasons=[yr]) + load_pbp(seasons=[yr])
         participation exists 2016+ only (floor enforced).
Writes : local mfl_database.db (if present) + D1 nfl_player_routes
         (dual-write; UPSERT by season+gsis_id)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_routes.py --seasons 2016-2025
  python3 pipelines/etl/scripts/fetch_nflverse_routes.py --seasons 2023,2024 --skip-d1
  python3 pipelines/etl/scripts/fetch_nflverse_routes.py --seasons 2025 --skip-local

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

PARTICIPATION_FLOOR = 2016  # nflverse participation feed starts 2016

DDL = """
CREATE TABLE IF NOT EXISTS nfl_player_routes (
  season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
  routes INTEGER, team_dropbacks INTEGER, routes_tgt INTEGER, routes_rec_yds INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_routes_gsis ON nfl_player_routes (gsis_id);
CREATE TABLE IF NOT EXISTS nfl_player_routes_weekly (
  season INTEGER NOT NULL, week INTEGER NOT NULL, gsis_id TEXT NOT NULL, team TEXT,
  routes INTEGER, team_dropbacks INTEGER, routes_tgt INTEGER, routes_rec_yds INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, week, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_routes_weekly_gsis ON nfl_player_routes_weekly (gsis_id, season);
CREATE INDEX IF NOT EXISTS idx_nfl_routes_weekly_sw ON nfl_player_routes_weekly (season, week);
"""

COLS = ["season", "gsis_id", "routes", "team_dropbacks", "routes_tgt", "routes_rec_yds"]
WEEKLY_COLS = ["season", "week", "gsis_id", "team",
               "routes", "team_dropbacks", "routes_tgt", "routes_rec_yds"]

# Columns a future participation release might use as a dropback/pass flag —
# probed at runtime; today's feed has none, so we join PBP instead.
_DROPBACK_CANDIDATES = ("qb_dropback", "is_dropback", "dropback", "is_pass", "pass")

# Route-running positions (participation `offense_positions` vocabulary).
# QB + OL (T/G/C) are on the field for every dropback but don't run routes;
# defensive/ST labels on offense are gadget snaps — all excluded.
ROUTE_POS = {"WR", "TE", "RB", "FB", "HB"}

_PLAYERS_POS: dict[str, str] | None = None  # lazy gsis→position (load_players)


def _players_pos_map() -> dict[str, str]:
    """gsis_id → roster position from nflverse load_players (fallback for
    seasons whose participation feed has no offense_positions column)."""
    global _PLAYERS_POS
    if _PLAYERS_POS is None:
        import nflreadpy as nfl
        pl = nfl.load_players()
        pldf = pl.to_pandas() if hasattr(pl, "to_pandas") else pl
        pldf.columns = [c.lower() for c in pldf.columns]
        idc = "gsis_id" if "gsis_id" in pldf.columns else "player_id"
        pldf = pldf[pldf[idc].notna() & pldf["position"].notna()]
        _PLAYERS_POS = dict(zip(pldf[idc], pldf["position"]))
        print(f"  players-table position fallback loaded ({len(_PLAYERS_POS)} ids)",
              file=sys.stderr)
    return _PLAYERS_POS


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-"); out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def compute_season(year: int) -> list[tuple]:
    """One season → list of (season, gsis, routes, team_dropbacks, tgt, rec_yds)."""
    import nflreadpy as nfl

    part = nfl.load_participation(seasons=[year])
    pdf = part.to_pandas() if hasattr(part, "to_pandas") else part
    pdf.columns = [c.lower() for c in pdf.columns]
    print(f"  [{year}] participation: {len(pdf)} plays; cols: {sorted(pdf.columns.tolist())}",
          file=sys.stderr)
    if pdf.empty:
        print(f"  [{year}] WARNING: empty participation frame — skipping season", file=sys.stderr)
        return []

    flag = next((c for c in _DROPBACK_CANDIDATES if c in pdf.columns), None)
    if flag:
        print(f"  [{year}] participation HAS a dropback indicator ('{flag}') — using it directly",
              file=sys.stderr)
    else:
        print(f"  [{year}] no dropback indicator in participation — joining PBP for qb_dropback",
              file=sys.stderr)

    # PBP is needed regardless for season_type/receiver/receiving_yards.
    pbp = nfl.load_pbp(seasons=[year])
    bdf = pbp.to_pandas() if hasattr(pbp, "to_pandas") else pbp
    bdf.columns = [c.lower() for c in bdf.columns]
    bdf = bdf[["game_id", "play_id", "week", "season_type", "qb_dropback",
               "receiver_player_id", "receiving_yards"]]
    bdf = bdf[bdf["season_type"] == "REG"]  # REG only, all weeks kept (like nfl_player_epa)
    # The participation frame may carry its own `week`; a plain merge would then
    # yield week_x/week_y and silently break the weekly key. Rename PBP's copy
    # so the column we group on is unambiguous regardless of upstream schema.
    bdf = bdf.rename(columns={"week": "pbp_week"})

    if flag:
        pdf = pdf[pdf[flag].fillna(0).astype(float) == 1.0]
        j = pdf.merge(bdf, left_on=["nflverse_game_id", "play_id"],
                      right_on=["game_id", "play_id"], how="inner")
    else:
        db = bdf[bdf["qb_dropback"].fillna(0) == 1]
        j = pdf.merge(db, left_on=["nflverse_game_id", "play_id"],
                      right_on=["game_id", "play_id"], how="inner")
    j = j[j["possession_team"].notna() & (j["possession_team"] != "")]
    # Drop plays with no on-field data BEFORE the team_dropbacks tally so the
    # Route% numerator and denominator are built from the same play set.
    n_empty = int((j["offense_players"].fillna("") == "").sum())
    j = j[j["offense_players"].fillna("") != ""]
    print(f"  [{year}] REG dropback plays with participation: {len(j)}"
          + (f" ({n_empty} dropped: empty offense_players)" if n_empty else ""),
          file=sys.stderr)
    if j.empty:
        print(f"  [{year}] WARNING: dropback join produced 0 rows — check game_id/play_id keys",
              file=sys.stderr)
        return []

    # ── team dropbacks per (game, team) — the Route% denominator pieces ──
    team_db = j.groupby(["game_id", "possession_team"]).size().to_dict()

    off = j["offense_players"].fillna("").tolist()
    offpos = j["offense_positions"].fillna("").tolist() if "offense_positions" in j.columns \
        else [""] * len(j)
    gids = j["game_id"].tolist()
    teams = j["possession_team"].tolist()
    weeks = j["pbp_week"].tolist()
    recv = j["receiver_player_id"].tolist()
    ryds = j["receiving_yards"].fillna(0).tolist()

    # ── pass 1: modal position per player (players ;-aligned with positions) ──
    pos_tally: dict[str, dict[str, int]] = {}
    all_gsis: set[str] = set()
    misaligned = 0
    for players, positions in zip(off, offpos):
        pl = [x.strip() for x in players.split(";") if x.strip()]
        all_gsis.update(pl)
        ps = [x.strip() for x in positions.split(";") if x.strip()]
        if len(pl) != len(ps):
            misaligned += 1
            continue
        for gsis, pos in zip(pl, ps):
            t = pos_tally.setdefault(gsis, {})
            t[pos] = t.get(pos, 0) + 1
    keep = {g for g, t in pos_tally.items() if max(t, key=t.get) in ROUTE_POS}
    # Fallback for players never seen with an aligned participation position
    # (whole seasons pre-~2017 lack offense_positions): roster position.
    no_pos = all_gsis - set(pos_tally)
    fell_back = 0
    if no_pos:
        pmap = _players_pos_map()
        fb = {g for g in no_pos if pmap.get(g) in ROUTE_POS}
        fell_back = len(fb)
        keep |= fb
    print(f"  [{year}] position filter: {len(keep)} route-runners kept of "
          f"{len(all_gsis)} offense players "
          f"({fell_back} via players-table fallback; {misaligned} plays misaligned/no pos list)",
          file=sys.stderr)

    # ── pass 2: accumulate at (week, gsis) grain ──
    # WEEKLY IS NOW THE PRIMARY GRAIN. The season table is derived by summing
    # these rows (see season_rows_from_weekly), so the two can never drift and
    # Σ weekly == season holds by construction — which is the acceptance gate
    # for the leakage fix in docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.1.
    routes: dict[tuple, int] = {}        # (week, gsis) → routes
    tgt: dict[tuple, int] = {}           # (week, gsis) → targets on route plays
    rec_yds: dict[tuple, float] = {}     # (week, gsis) → receiving yards
    gkey: dict[tuple, tuple] = {}        # (week, gsis) → (game_id, team)

    for players, gid, team, wk, rid, yds in zip(off, gids, teams, weeks, recv, ryds):
        try:
            wk = int(wk)
        except (TypeError, ValueError):
            continue  # no week on the play → cannot place it in time; drop
        for gsis in players.split(";"):
            gsis = gsis.strip()
            if not gsis or gsis not in keep:
                continue
            k = (wk, gsis)
            routes[k] = routes.get(k, 0) + 1
            gkey[k] = (gid, team)
            if isinstance(rid, str) and gsis == rid:
                # target credited only when the receiver is listed on-field
                # (he ran a route); unlisted-receiver targets (<1%, feed
                # glitches) are dropped to keep TPRR internally consistent.
                tgt[k] = tgt.get(k, 0) + 1
                rec_yds[k] = rec_yds.get(k, 0) + float(yds)

    rows = []
    for (wk, gsis), n in routes.items():
        gid, team = gkey[(wk, gsis)]
        rows.append((year, wk, gsis, team, int(n), int(team_db.get((gid, team), 0)),
                     int(tgt.get((wk, gsis), 0)),
                     int(round(rec_yds.get((wk, gsis), 0.0)))))
    n_players = len({r[2] for r in rows})
    n_weeks = len({r[1] for r in rows})
    print(f"  [{year}] {len(rows)} player-week route rows "
          f"({n_players} players across {n_weeks} weeks)", file=sys.stderr)
    return rows


def season_rows_from_weekly(weekly: list[tuple]) -> list[tuple]:
    """Roll the weekly rows up to the legacy (season, gsis) season table.

    Deriving rather than recomputing guarantees Σ weekly == season exactly.
    team_dropbacks stays GAME-ALIGNED — summing his team's dropbacks in each
    game he appeared in — which is the same definition the season table always
    used, so /api/player-routes and the workbench see no change.
    """
    agg: dict[tuple, list] = {}
    for season, _wk, gsis, _team, rt, tdb, tg, ry in weekly:
        a = agg.setdefault((season, gsis), [0, 0, 0, 0])
        a[0] += rt
        a[1] += tdb
        a[2] += tg
        a[3] += ry
    return [(s, g, a[0], a[1], a[2], a[3]) for (s, g), a in agg.items()]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2016-2025", help="e.g. 2016-2025 or 2024 or 2023,2024")
    ap.add_argument("--skip-d1", action="store_true")
    ap.add_argument("--skip-local", action="store_true")
    args = ap.parse_args()
    seasons = parse_seasons(args.seasons)
    seasons = available_seasons(seasons, floor=PARTICIPATION_FLOOR)
    if not seasons:
        print("no available nflverse seasons in range — nothing to fetch", file=sys.stderr)
        sys.exit(0)

    weekly: list[tuple] = []
    failed: list[int] = []
    for yr in seasons:
        print(f"loading participation + PBP for {yr}…", file=sys.stderr)
        try:
            weekly += compute_season(yr)
        except Exception as e:  # per-season isolation: one missing year ≠ dead run
            failed.append(yr)
            print(f"  [{yr}] FAILED: {e}", file=sys.stderr)
    if failed:
        print(f"  seasons with no data / errors: {failed}", file=sys.stderr)
    if not weekly:
        sys.exit("no rows")

    # Season rows are DERIVED from weekly, so Σ weekly == season by
    # construction and the two grains cannot drift.
    rows = season_rows_from_weekly(weekly)
    print(f"  {len(weekly)} (season,week,gsis) weekly rows "
          f"→ {len(rows)} (season,gsis) season rows", file=sys.stderr)

    # Self-check the rollup identity before writing anything. A mismatch means
    # the derivation is broken; refuse rather than publish two grains that
    # disagree (the leakage fix is only trustworthy if they reconcile).
    if sum(r[4] for r in weekly) != sum(r[2] for r in rows):
        sys.exit("FATAL: Σ weekly routes != Σ season routes — refusing to write")

    if not args.skip_local and LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            f"""INSERT INTO nfl_player_routes ({', '.join(COLS)})
                VALUES ({', '.join('?' for _ in COLS)})
                ON CONFLICT(season, gsis_id) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in COLS if c not in ('season', 'gsis_id'))}""",
            rows,
        )
        db.executemany(
            f"""INSERT INTO nfl_player_routes_weekly ({', '.join(WEEKLY_COLS)})
                VALUES ({', '.join('?' for _ in WEEKLY_COLS)})
                ON CONFLICT(season, week, gsis_id) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in WEEKLY_COLS
                             if c not in ('season', 'week', 'gsis_id'))}""",
            weekly,
        )
        db.commit(); db.close()
        print("  wrote local nfl_player_routes + _weekly", file=sys.stderr)

    if not args.skip_d1:
        # ~40 bytes of SQL per row (8 narrow cols), so 1,000 rows is ~40KB —
        # under D1's 100KB per-statement cap. D1Writer shells out to `npx
        # wrangler` once per chunk (~3.5s of process startup), so chunk size,
        # not payload, dominates wall clock: 56k weekly rows is 56 invocations
        # here versus 280 at the old default.
        with D1Writer(table="nfl_player_routes_weekly", cols=WEEKLY_COLS,
                      pk_cols=["season", "week", "gsis_id"], chunk_size=1000) as w:
            for t in weekly:
                w.add(t)
        with D1Writer(table="nfl_player_routes", cols=COLS, pk_cols=["season", "gsis_id"],
                      chunk_size=200) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
