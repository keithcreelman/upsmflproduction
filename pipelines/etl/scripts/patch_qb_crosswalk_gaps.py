#!/usr/bin/env python3
"""Patch missing MFL → gsis_id crosswalk rows.

Background (Keith 2026-04-25): the YoY stickiness audit found ~514 of 1205
QB-yoy rows in `yoy_player_signals` couldn't be joined to NFL stats because
their `mfl_player_id` had no row in `player_id_crosswalk` (or the row had
NULL `gsis_id`). The unmatched set includes ~10 HOFers/big-name retirees
(Brees, Matt Ryan, Roethlisberger, Luck, Cam, Fitzpatrick, Eli, Alex Smith,
Foles, Bortles) — collectively ~60-80 high-quality QB-seasons of training
data the regression model is silently dropping.

Strategy:
  1. Build a mapping from MFL `players.raw_json` JSON blob (which has
     name + birth_date) to nflverse gsis_id by joining on
     normalized name + birth_date.
  2. nflverse master list comes from
     https://github.com/nflverse/nflverse-data/releases/download/players/players.csv
     (cached at /tmp/nflverse_players.csv if recent).
  3. UPSERT into player_id_crosswalk for any MFL player_id that:
       - currently has no crosswalk row, OR
       - has a crosswalk row with NULL gsis_id
  4. Stamp source='patch_qb_gaps_2026-04-25', confidence='exact_birthdate'
     so future runs of build_player_id_crosswalk.py respect manual fixes.

Usage:
  python3 pipelines/etl/scripts/patch_qb_crosswalk_gaps.py             # dry-run
  python3 pipelines/etl/scripts/patch_qb_crosswalk_gaps.py --apply     # write to DB
  python3 pipelines/etl/scripts/patch_qb_crosswalk_gaps.py --positions QB,RB,WR,TE
"""
from __future__ import annotations
import argparse
import csv
import json
import os
import re
import sqlite3
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

DB_DEFAULT = os.getenv(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
)
NFLVERSE_PLAYERS_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/players/players.csv"
)
CACHE_PATH = Path("/tmp/nflverse_players.csv")
CACHE_MAX_AGE_HOURS = 72


def _normalize_name(s: str) -> str:
    """Lowercase, strip punctuation/suffixes, collapse spaces."""
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[.,'’]", "", s)
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\b", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _normalize_mfl_name(name: str) -> str:
    """MFL stores names as 'Last, First M.'. Flip to 'first last' then normalize."""
    if not name:
        return ""
    if "," in name:
        last, first = name.split(",", 1)
        flipped = f"{first.strip()} {last.strip()}"
    else:
        flipped = name
    return _normalize_name(flipped)


def _parse_mfl_birthdate(raw_json_str: str | None) -> str | None:
    """MFL birthdate in raw_json is a unix timestamp string. Return YYYY-MM-DD."""
    if not raw_json_str:
        return None
    try:
        raw = json.loads(raw_json_str.replace("'", '"')) if raw_json_str.startswith("{") else None
    except Exception:
        # MFL JSON sometimes has Python-repr quoting; try ast.literal_eval
        try:
            import ast
            raw = ast.literal_eval(raw_json_str)
        except Exception:
            return None
    if not raw:
        return None
    bd = raw.get("birthdate")
    if not bd:
        return None
    try:
        ts = int(str(bd))
        # Pre-1970 birthdays come back as negative; that's fine.
        d = datetime.fromtimestamp(ts, tz=timezone.utc).date()
        return d.isoformat()
    except Exception:
        return None


def fetch_nflverse_players() -> list[dict]:
    """Pull nflverse master player list, with light disk cache."""
    if CACHE_PATH.exists():
        age_hours = (datetime.now().timestamp() - CACHE_PATH.stat().st_mtime) / 3600
        if age_hours < CACHE_MAX_AGE_HOURS:
            print(f"  using cached {CACHE_PATH} (age={age_hours:.1f}h)", file=sys.stderr)
        else:
            print(f"  cache stale ({age_hours:.1f}h) — refreshing", file=sys.stderr)
            with urllib.request.urlopen(NFLVERSE_PLAYERS_URL) as r:
                CACHE_PATH.write_bytes(r.read())
    else:
        print(f"  downloading {NFLVERSE_PLAYERS_URL}", file=sys.stderr)
        with urllib.request.urlopen(NFLVERSE_PLAYERS_URL) as r:
            CACHE_PATH.write_bytes(r.read())
    rows = []
    with CACHE_PATH.open() as f:
        rdr = csv.DictReader(f)
        for r in rdr:
            rows.append(r)
    print(f"  loaded {len(rows)} nflverse player rows", file=sys.stderr)
    return rows


def build_nflverse_index(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """Index nflverse players by (normalized_display_name, birth_date)."""
    idx = {}
    for r in rows:
        nm = _normalize_name(r.get("display_name") or "")
        bd = (r.get("birth_date") or "").strip()
        if nm and bd:
            idx[(nm, bd)] = r
    return idx


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db-path", default=DB_DEFAULT)
    ap.add_argument("--positions", default="QB",
                    help="Comma-separated MFL positions to patch (default: QB).")
    ap.add_argument("--apply", action="store_true",
                    help="Write changes to the DB. Without this it's a dry-run.")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap on rows to attempt (debugging).")
    args = ap.parse_args()

    positions = [p.strip().upper() for p in args.positions.split(",") if p.strip()]
    print(f"Patching crosswalk for positions: {positions}")
    print(f"DB: {args.db_path}")
    print(f"Mode: {'APPLY' if args.apply else 'DRY-RUN'}\n")

    db = sqlite3.connect(args.db_path, timeout=30)
    db.execute("PRAGMA busy_timeout=30000")

    # Load nflverse master list, build (name, birth_date) index
    print("[1/4] Loading nflverse player master list...")
    nflverse = fetch_nflverse_players()
    nv_idx = build_nflverse_index(nflverse)
    # Position-position fallback: if exact (name, bd) match misses, try
    # (name, position) with same display_name and any birth_date
    nv_by_name_pos: dict[tuple[str, str], list[dict]] = {}
    for r in nflverse:
        nm = _normalize_name(r.get("display_name") or "")
        pos = (r.get("position") or "").upper()
        if nm and pos:
            nv_by_name_pos.setdefault((nm, pos), []).append(r)

    # Find MFL players who need patching: positions filter + (no crosswalk row OR null gsis_id)
    print("\n[2/4] Identifying MFL players missing gsis_id...")
    placeholders = ",".join("?" for _ in positions)
    mfl_rows = db.execute(f"""
        SELECT p.player_id, p.name, p.position, p.raw_json
          FROM players p
          LEFT JOIN player_id_crosswalk x
            ON CAST(p.player_id AS TEXT) = CAST(x.mfl_player_id AS TEXT)
         WHERE p.position IN ({placeholders})
           AND (x.gsis_id IS NULL OR x.gsis_id = '')
         GROUP BY p.player_id
    """, positions).fetchall()
    print(f"  {len(mfl_rows)} MFL {'/'.join(positions)} players need patching")

    if args.limit:
        mfl_rows = mfl_rows[: args.limit]

    # Match
    print("\n[3/4] Matching by (normalized_name, birth_date)...")
    matched = []
    unmatched = []
    for mfl_id, mfl_name, mfl_pos, mfl_raw in mfl_rows:
        norm = _normalize_mfl_name(mfl_name)
        bd = _parse_mfl_birthdate(mfl_raw)
        if not norm:
            unmatched.append((mfl_id, mfl_name, mfl_pos, "no_normalized_name"))
            continue

        match = nv_idx.get((norm, bd)) if bd else None
        confidence = "exact_birthdate"
        if not match:
            # Fallback: same (name, position), any birth_date — only if a UNIQUE candidate
            cands = nv_by_name_pos.get((norm, mfl_pos), [])
            if len(cands) == 1:
                match = cands[0]
                confidence = "exact_name_position"
        if not match:
            unmatched.append((mfl_id, mfl_name, mfl_pos, f"no_match (norm='{norm}' bd='{bd}')"))
            continue

        matched.append({
            "mfl_id": mfl_id,
            "mfl_name": mfl_name,
            "mfl_pos": mfl_pos,
            "gsis_id": match.get("gsis_id"),
            "pfr_id": match.get("pfr_id") or None,
            "espn_id": match.get("espn_id") or None,
            "full_name": match.get("display_name"),
            "position": match.get("position"),
            "birth_date": match.get("birth_date"),
            "confidence": confidence,
        })

    print(f"  matched: {len(matched)}")
    print(f"  unmatched: {len(unmatched)}")

    # Show top-impact matches (sample by name to give Keith confidence)
    print(f"\n  Sample of matches (first 25):")
    for m in matched[:25]:
        print(f"    MFL {m['mfl_id']:>6} {m['mfl_name']:<30} → "
              f"gsis={m['gsis_id']:<14} {m['full_name']} ({m['confidence']})")

    if unmatched and len(unmatched) <= 20:
        print(f"\n  Unmatched samples:")
        for mid, nm, pos, reason in unmatched[:20]:
            print(f"    MFL {mid:>6} {nm:<30} ({pos})  reason: {reason}")
    elif unmatched:
        print(f"\n  Unmatched ({len(unmatched)}, showing first 10):")
        for mid, nm, pos, reason in unmatched[:10]:
            print(f"    MFL {mid:>6} {nm:<30} ({pos})  reason: {reason}")

    # Apply
    print(f"\n[4/4] Writing to player_id_crosswalk...")
    if not args.apply:
        print("  DRY-RUN: nothing written. Re-run with --apply to commit.")
        return

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cur = db.cursor()
    inserted = 0
    updated = 0
    for m in matched:
        existing = cur.execute(
            "SELECT mfl_player_id, gsis_id FROM player_id_crosswalk "
            "WHERE CAST(mfl_player_id AS TEXT) = CAST(? AS TEXT)",
            (m["mfl_id"],)
        ).fetchone()
        if existing is None:
            cur.execute("""
                INSERT INTO player_id_crosswalk
                  (mfl_player_id, gsis_id, pfr_id, espn_id, full_name, position,
                   birth_date, confidence, match_score, source, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                int(m["mfl_id"]) if str(m["mfl_id"]).isdigit() else m["mfl_id"],
                m["gsis_id"], m["pfr_id"], m["espn_id"], m["full_name"], m["position"],
                m["birth_date"], m["confidence"], 1.0,
                "patch_qb_crosswalk_gaps_20260425", now,
            ))
            inserted += 1
        else:
            # Only update if existing gsis_id is NULL/empty — never clobber a real id
            cur.execute("""
                UPDATE player_id_crosswalk
                   SET gsis_id = ?, pfr_id = COALESCE(pfr_id, ?),
                       espn_id = COALESCE(espn_id, ?),
                       full_name = COALESCE(NULLIF(full_name, ''), ?),
                       position = COALESCE(NULLIF(position, ''), ?),
                       birth_date = COALESCE(NULLIF(birth_date, ''), ?),
                       confidence = ?,
                       match_score = MAX(COALESCE(match_score, 0), 1.0),
                       source = ?,
                       updated_at = ?
                 WHERE CAST(mfl_player_id AS TEXT) = CAST(? AS TEXT)
                   AND (gsis_id IS NULL OR gsis_id = '')
            """, (
                m["gsis_id"], m["pfr_id"], m["espn_id"], m["full_name"],
                m["position"], m["birth_date"], m["confidence"],
                "patch_qb_crosswalk_gaps_20260425", now, m["mfl_id"],
            ))
            updated += cur.rowcount
    db.commit()
    print(f"  inserted: {inserted} new rows")
    print(f"  updated:  {updated} existing rows (NULL gsis_id → patched)")
    db.close()


if __name__ == "__main__":
    main()
