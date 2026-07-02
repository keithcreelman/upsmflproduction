#!/usr/bin/env python3
"""Aggregate per-player FTN charting flags → nfl_player_ftn.

FTN Data hand-charts every play (2022+) with flags nflfastR can't derive
from the gamebook: play action, screens, blitzes, out-of-pocket throws,
throwaways, contested / catchable balls. The charting file is PLAY-level
and carries no player ids, so we JOIN it to nflfastR PBP on
(nflverse_game_id, nflverse_play_id) == (game_id, play_id) to attribute
each play to a passer / receiver. REG season only. For each
(season, gsis_id) we store SUMS ONLY (never rates) so the worker can
re-aggregate exactly over any multi-season window:

  QB (passer_player_id, charted qb_dropback plays):
    dropbacks, pa_dropbacks (is_play_action), screen_att (is_screen_pass),
    blitz_dropbacks (n_blitzers >= 1), oop_throws (is_qb_out_of_pocket),
    throwaways (is_throw_away)
  Receiver (receiver_player_id, charted targets):
    tgt_charted, contested_tgt (is_contested_ball),
    contested_rec (contested AND pbp complete_pass == 1),
    catchable_tgt (is_catchable_ball), screen_tgt (is_screen_pass)

A QB who also draws targets merges into ONE row per (season, gsis_id).

Source : nflreadpy.load_ftn_charting(seasons=[yr]) + nflreadpy.load_pbp(seasons=[yr])
Writes : local mfl_database.db (if present) + D1 nfl_player_ftn
         (dual-write; UPSERT by season+gsis_id)

Usage:
  python3 pipelines/etl/scripts/fetch_nflverse_ftn.py --seasons 2022-2025
  python3 pipelines/etl/scripts/fetch_nflverse_ftn.py --seasons 2024 --skip-d1
  python3 pipelines/etl/scripts/fetch_nflverse_ftn.py --seasons 2025 --skip-local

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

FTN_FLOOR = 2022  # FTN charting only exists 2022+

DDL = """
CREATE TABLE IF NOT EXISTS nfl_player_ftn (
  season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
  dropbacks INTEGER, pa_dropbacks INTEGER, screen_att INTEGER,
  blitz_dropbacks INTEGER, oop_throws INTEGER, throwaways INTEGER,
  tgt_charted INTEGER, contested_tgt INTEGER, contested_rec INTEGER,
  catchable_tgt INTEGER, screen_tgt INTEGER,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (season, gsis_id)
);
CREATE INDEX IF NOT EXISTS idx_nfl_player_ftn_gsis ON nfl_player_ftn (gsis_id);
"""

COLS = ["season", "gsis_id",
        "dropbacks", "pa_dropbacks", "screen_att", "blitz_dropbacks", "oop_throws", "throwaways",
        "tgt_charted", "contested_tgt", "contested_rec", "catchable_tgt", "screen_tgt"]

# FTN flag columns we consume — verified against the live file at runtime.
FTN_FLAGS = ["is_play_action", "is_screen_pass", "is_qb_out_of_pocket",
             "is_throw_away", "is_contested_ball", "is_catchable_ball"]
FTN_BLITZ = "n_blitzers"


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-"); out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return out


def _pick(df, candidates: list[str], what: str) -> str:
    """Return the first candidate column present, or die printing the real ones."""
    for c in candidates:
        if c in df.columns:
            return c
    sys.exit(f"FTN schema drift: no {what} column among {candidates}; "
             f"actual columns: {list(df.columns)}")


def _flag01(s):
    """Robust bool-ish column → 0/1 int (bool, 0/1 numeric, or 'TRUE'/'FALSE' strings)."""
    import pandas as pd
    if s.dtype == bool:
        return s.astype("int64")
    def one(v):
        if v is None or (isinstance(v, float) and v != v):
            return 0
        if isinstance(v, str):
            return 1 if v.strip().upper() in ("TRUE", "T", "1", "Y", "YES") else 0
        return 1 if v else 0
    return pd.Series([one(v) for v in s], index=s.index, dtype="int64")


def compute(seasons: list[int]) -> list[tuple]:
    import nflreadpy as nfl
    import pandas as pd

    acc: dict[tuple, dict] = {}

    def bump(season, gsis, **kw) -> None:
        if not isinstance(gsis, str) or not gsis.strip():
            return
        d = acc.setdefault((int(season), gsis), {})
        for f, v in kw.items():
            d[f] = d.get(f, 0) + v

    for yr in seasons:
        print(f"season {yr}: loading FTN charting + PBP…", file=sys.stderr)
        ftn = nfl.load_ftn_charting(seasons=[yr])
        ftn = ftn.to_pandas() if hasattr(ftn, "to_pandas") else ftn
        ftn.columns = [c.lower() for c in ftn.columns]
        print(f"  FTN columns: {list(ftn.columns)}", file=sys.stderr)

        gkey = _pick(ftn, ["nflverse_game_id", "game_id"], "game join-key")
        pkey = _pick(ftn, ["nflverse_play_id", "play_id"], "play join-key")
        for c in FTN_FLAGS:
            _pick(ftn, [c], f"flag {c}")
        _pick(ftn, [FTN_BLITZ], "blitzer count")
        print(f"  join keys: ({gkey}, {pkey}) → pbp (game_id, play_id)", file=sys.stderr)

        keep = [gkey, pkey, FTN_BLITZ] + FTN_FLAGS
        f = ftn[keep].copy()
        f[pkey] = pd.to_numeric(f[pkey], errors="coerce").astype("Int64")
        for c in FTN_FLAGS:
            f[c] = _flag01(f[c])
        f["_blitzed"] = (pd.to_numeric(f[FTN_BLITZ], errors="coerce").fillna(0) >= 1).astype("int64")

        pbp = nfl.load_pbp(seasons=[yr])
        pbp = pbp.to_pandas() if hasattr(pbp, "to_pandas") else pbp
        pbp.columns = [c.lower() for c in pbp.columns]
        pcols = ["game_id", "play_id", "season", "season_type", "qb_dropback",
                 "passer_player_id", "receiver_player_id", "complete_pass"]
        missing = [c for c in pcols if c not in pbp.columns]
        if missing:
            sys.exit(f"PBP schema drift: missing {missing}")
        p = pbp[pcols].copy()
        p = p[p["season_type"] == "REG"]
        p["play_id"] = pd.to_numeric(p["play_id"], errors="coerce").astype("Int64")

        # inner join → only CHARTED plays count, so every stored denominator
        # (dropbacks / tgt_charted) matches the charted numerators exactly.
        m = p.merge(f, left_on=["game_id", "play_id"], right_on=[gkey, pkey], how="inner")
        print(f"  joined {len(m)} charted REG plays "
              f"({len(m)}/{len(p)} = {len(m)/max(len(p),1):.0%} of REG pbp)", file=sys.stderr)

        # ── QB: charted dropbacks by passer ──
        db = m[(pd.to_numeric(m["qb_dropback"], errors="coerce").fillna(0) == 1)
               & m["passer_player_id"].notna()]
        gq = db.groupby(["season", "passer_player_id"]).agg(
            n=("play_id", "size"), pa=("is_play_action", "sum"), scr=("is_screen_pass", "sum"),
            bl=("_blitzed", "sum"), oop=("is_qb_out_of_pocket", "sum"), ta=("is_throw_away", "sum"))
        for (season, gsis), r in gq.iterrows():
            bump(season, gsis, dropbacks=int(r["n"]), pa_dropbacks=int(r["pa"]),
                 screen_att=int(r["scr"]), blitz_dropbacks=int(r["bl"]),
                 oop_throws=int(r["oop"]), throwaways=int(r["ta"]))

        # ── Receiver: charted targets ──
        tgt = m[m["receiver_player_id"].notna()].copy()
        tgt["_comp"] = (pd.to_numeric(tgt["complete_pass"], errors="coerce").fillna(0) == 1).astype("int64")
        tgt["_crec"] = tgt["is_contested_ball"] * tgt["_comp"]
        gr = tgt.groupby(["season", "receiver_player_id"]).agg(
            n=("play_id", "size"), ct=("is_contested_ball", "sum"), cr=("_crec", "sum"),
            cb=("is_catchable_ball", "sum"), scr=("is_screen_pass", "sum"))
        for (season, gsis), r in gr.iterrows():
            bump(season, gsis, tgt_charted=int(r["n"]), contested_tgt=int(r["ct"]),
                 contested_rec=int(r["cr"]), catchable_tgt=int(r["cb"]), screen_tgt=int(r["scr"]))

    rows = []
    for (season, gsis), d in acc.items():
        rows.append((
            int(season), str(gsis),
            int(d.get("dropbacks", 0)), int(d.get("pa_dropbacks", 0)), int(d.get("screen_att", 0)),
            int(d.get("blitz_dropbacks", 0)), int(d.get("oop_throws", 0)), int(d.get("throwaways", 0)),
            int(d.get("tgt_charted", 0)), int(d.get("contested_tgt", 0)), int(d.get("contested_rec", 0)),
            int(d.get("catchable_tgt", 0)), int(d.get("screen_tgt", 0)),
        ))
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2022-2025", help="e.g. 2022-2025 or 2024 or 2023,2024")
    ap.add_argument("--skip-d1", action="store_true")
    ap.add_argument("--skip-local", action="store_true")
    args = ap.parse_args()
    seasons = parse_seasons(args.seasons)
    seasons = available_seasons(seasons, floor=FTN_FLOOR)
    if not seasons:
        print("no available FTN seasons in range (2022+ only) — nothing to fetch", file=sys.stderr)
        sys.exit(0)
    rows = compute(seasons)
    print(f"  {len(rows)} (season,gsis) FTN rows", file=sys.stderr)
    if not rows:
        sys.exit("no rows")

    if not args.skip_local and LOCAL_DB.exists():
        db = sqlite3.connect(str(LOCAL_DB)); db.executescript(DDL)
        db.executemany(
            f"""INSERT INTO nfl_player_ftn ({', '.join(COLS)})
                VALUES ({', '.join('?' for _ in COLS)})
                ON CONFLICT(season, gsis_id) DO UPDATE SET
                  {', '.join(f'{c}=excluded.{c}' for c in COLS if c not in ('season', 'gsis_id'))}""",
            rows,
        )
        db.commit(); db.close()
        print("  wrote local nfl_player_ftn", file=sys.stderr)

    if not args.skip_d1:
        with D1Writer(table="nfl_player_ftn", cols=COLS, pk_cols=["season", "gsis_id"], chunk_size=120) as w:
            for t in rows:
                w.add(t)


if __name__ == "__main__":
    main()
