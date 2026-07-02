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

For each (season, gsis_id), REG season only, we store SUMS ONLY (not rates)
so the worker can re-aggregate exactly over any multi-season window:

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
"""

COLS = ["season", "gsis_id", "routes", "team_dropbacks", "routes_tgt", "routes_rec_yds"]

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
    bdf = bdf[["game_id", "play_id", "season_type", "qb_dropback",
               "receiver_player_id", "receiving_yards"]]
    bdf = bdf[bdf["season_type"] == "REG"]  # REG only, all weeks kept (like nfl_player_epa)

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

    # ── pass 2: accumulate ──
    routes: dict[str, int] = {}          # gsis → routes
    tgt: dict[str, int] = {}             # gsis → targets on route plays
    rec_yds: dict[str, float] = {}       # gsis → receiving yards on route plays
    games_seen: dict[str, set] = {}      # gsis → {(game_id, team)} he appeared in

    for players, gid, team, rid, yds in zip(off, gids, teams, recv, ryds):
        key = (gid, team)
        for gsis in players.split(";"):
            gsis = gsis.strip()
            if not gsis or gsis not in keep:
                continue
            routes[gsis] = routes.get(gsis, 0) + 1
            games_seen.setdefault(gsis, set()).add(key)
            if isinstance(rid, str) and gsis == rid:
                # target credited only when the receiver is listed on-field
                # (he ran a route); unlisted-receiver targets (<1%, feed
                # glitches) are dropped to keep TPRR internally consistent.
                tgt[gsis] = tgt.get(gsis, 0) + 1
                rec_yds[gsis] = rec_yds.get(gsis, 0) + float(yds)

    rows = []
    for gsis, n in routes.items():
        tdb = sum(team_db.get(k, 0) for k in games_seen[gsis])
        rows.append((year, gsis, int(n), int(tdb), int(tgt.get(gsis, 0)),
                     int(round(rec_yds.get(gsis, 0.0)))))
    print(f"  [{year}] {len(rows)} players with routes", file=sys.stderr)
    return rows


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

    rows: list[tuple] = []
    failed: list[int] = []
    for yr in seasons:
        print(f"loading participation + PBP for {yr}…", file=sys.stderr)
        try:
            rows += compute_season(yr)
        except Exception as e:  # per-season isolation: one missing year ≠ dead run
            failed.append(yr)
            print(f"  [{yr}] FAILED: {e}", file=sys.stderr)
    if failed:
        print(f"  seasons with no data / errors: {failed}", file=sys.stderr)
    print(f"  {len(rows)} (season,gsis) route rows total", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if not args.skip_local and LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            f"""INSERT INTO nfl_player_routes ({', '.join(COLS)})
                VALUES ({', '.join('?' for _ in COLS)})
                ON CONFLICT(season, gsis_id) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in COLS if c not in ('season', 'gsis_id'))}""",
            rows,
        )
        db.commit(); db.close()
        print("  wrote local nfl_player_routes", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="nfl_player_routes", cols=COLS, pk_cols=["season", "gsis_id"],
                      chunk_size=200) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
