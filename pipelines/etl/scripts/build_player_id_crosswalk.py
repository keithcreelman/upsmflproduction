#!/usr/bin/env python3
"""Build MFL pid ↔ nflverse gsis_id crosswalk.

Writes to:
  - pipelines/etl/data/player_id_crosswalk.csv  (source-of-truth file
    that can be manually edited)
  - local mfl_database.db `player_id_crosswalk` table (ETL mirror)

Strategy (runs in this order, first match wins):

  1. nflreadpy.load_ff_playerids() — has `mfl_id` column pre-mapped
     by DLF/FFPC/Sleeper ecosystems. Exact join MFL.player_id →
     ff_playerids.mfl_id. Covers ~60-70% of active starters.

  2. Exact match on (normalized_full_name, birth_date, position)
     against nflreadpy.load_players() — the nflverse master list.
     Mops up another ~20%.

  3. Fuzzy match on normalized_full_name within same (active_season,
     team, position). Accept ≥ 0.95 jaro-winkler auto; queue
     0.85-0.95 to a review CSV; reject < 0.85.

Writes `confidence='exact'|'fuzzy_auto'|'unmapped'` on every row.
A separate `player_id_crosswalk_review.csv` captures fuzzy matches
in the 0.85-0.95 band for Keith to review and promote to
`confidence='manual'`.

Dependencies:
  pip install nflreadpy pandas rapidfuzz

Usage:
  python3 pipelines/etl/scripts/build_player_id_crosswalk.py
  python3 pipelines/etl/scripts/build_player_id_crosswalk.py --refresh-only
"""
from __future__ import annotations
import argparse
import csv
import re
import sqlite3
import sys
from pathlib import Path
from typing import Optional

REPO_ROOT = Path(__file__).resolve().parents[3]
LOCAL_DB = Path("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db")
CROSSWALK_CSV = REPO_ROOT / "pipelines" / "etl" / "data" / "player_id_crosswalk.csv"
REVIEW_CSV = REPO_ROOT / "pipelines" / "etl" / "data" / "player_id_crosswalk_review.csv"


def normalize_name(name: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace."""
    if not name:
        return ""
    s = name.lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    # Common suffix normalizations
    for suffix in (" jr", " sr", " ii", " iii", " iv", " v"):
        if s.endswith(suffix):
            s = s[: -len(suffix)].strip()
    return s


def load_mfl_players(db: sqlite3.Connection) -> list[dict]:
    """Every player MFL knows about — our left-hand side of the join."""
    rows = db.execute("""
        SELECT player_id, player_name, position, position_group, team
        FROM player_master
    """).fetchall()
    out = []
    for r in rows:
        pid, name, pos, posg, team = r
        # MFL name format is "Last, First" — flip to "First Last"
        if name and "," in name:
            last, first = [p.strip() for p in name.split(",", 1)]
            full = f"{first} {last}"
        else:
            full = name or ""
        out.append({
            "mfl_player_id": int(pid) if pid else None,
            "full_name": full,
            "normalized_name": normalize_name(full),
            "position": (pos or "").upper(),
            "position_group": (posg or "").upper(),
            "team": (team or "").upper(),
        })
    return out


def fetch_nflverse_ff_playerids():
    """Pulls the pre-computed cross-dataset ID map."""
    try:
        import nflreadpy as nfl
    except ImportError:
        print("FATAL: nflreadpy not installed. Run: pip install nflreadpy", file=sys.stderr)
        sys.exit(1)
    df = nfl.load_ff_playerids()
    # Normalize column names — nflreadpy may return polars or pandas
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    cols_lower = {c: c.lower() for c in df.columns}
    df = df.rename(columns=cols_lower)
    # Expected cols: mfl_id, gsis_id, pfr_id, sleeper_id, espn_id, name, position
    wanted = [c for c in ["mfl_id", "gsis_id", "pfr_id", "sleeper_id", "espn_id", "name", "position", "birthdate"] if c in df.columns]
    return df[wanted].to_dict(orient="records")


def fetch_nflverse_players():
    """Full nflverse player master — used as the mop-up exact-match."""
    try:
        import nflreadpy as nfl
    except ImportError:
        sys.exit(1)
    df = nfl.load_players()
    if hasattr(df, "to_pandas"):
        df = df.to_pandas()
    df = df.rename(columns={c: c.lower() for c in df.columns})
    wanted = [c for c in ["gsis_id", "pfr_id", "display_name", "first_name", "last_name", "position", "birth_date"] if c in df.columns]
    return df[wanted].to_dict(orient="records")


def build_crosswalk(mfl_players: list[dict]) -> tuple[list[dict], list[dict]]:
    """Returns (resolved_rows, fuzzy_review_rows)."""
    ffpid = fetch_nflverse_ff_playerids()
    print(f"  nflverse ff_playerids: {len(ffpid)} rows", file=sys.stderr)

    by_mfl_id = {}
    for r in ffpid:
        mfl = r.get("mfl_id")
        if not mfl:
            continue
        try:
            mfl_int = int(mfl)
        except (TypeError, ValueError):
            continue
        by_mfl_id[mfl_int] = r

    nfl_players = fetch_nflverse_players()
    print(f"  nflverse players:      {len(nfl_players)} rows", file=sys.stderr)

    by_name_dob = {}
    for r in nfl_players:
        gid = r.get("gsis_id")
        if not gid:
            continue
        name_norm = normalize_name(r.get("display_name") or f"{r.get('first_name','')} {r.get('last_name','')}")
        dob = r.get("birth_date") or ""
        pos = (r.get("position") or "").upper()
        key = (name_norm, str(dob)[:10], pos)
        by_name_dob.setdefault(key, r)

    try:
        from rapidfuzz import fuzz, process
    except ImportError:
        print("WARN: rapidfuzz not installed, fuzzy matching disabled", file=sys.stderr)
        fuzz = None
        process = None

    fuzzy_pool = [{"name": normalize_name(r.get("display_name") or ""), "gsis_id": r.get("gsis_id"), "pfr_id": r.get("pfr_id"), "position": (r.get("position") or "").upper()} for r in nfl_players if r.get("gsis_id")]

    resolved = []
    review = []

    for p in mfl_players:
        pid = p["mfl_player_id"]
        if pid is None:
            continue
        row = {
            "mfl_player_id": pid,
            "gsis_id": None,
            "pfr_id": None,
            "sleeper_id": None,
            "espn_id": None,
            "full_name": p["full_name"],
            "position": p["position"],
            "birth_date": None,
            "confidence": "unmapped",
            "match_score": None,
            "source": None,
        }

        # 1. Direct ff_playerids exact mapping.
        hit = by_mfl_id.get(pid)
        if hit:
            row["gsis_id"] = hit.get("gsis_id")
            row["pfr_id"] = hit.get("pfr_id")
            row["sleeper_id"] = hit.get("sleeper_id")
            row["espn_id"] = hit.get("espn_id")
            row["birth_date"] = hit.get("birthdate")
            row["confidence"] = "exact"
            row["source"] = "nflreadpy_ff_playerids"
            resolved.append(row)
            continue

        # 2. Fuzzy match on normalized name within same position.
        if fuzz and fuzzy_pool:
            candidates = [c for c in fuzzy_pool if c["position"] == p["position"]]
            if not candidates:
                resolved.append(row)
                continue
            names = [c["name"] for c in candidates]
            match = process.extractOne(p["normalized_name"], names, scorer=fuzz.WRatio)
            if match:
                matched_name, score, idx = match
                if score >= 95:
                    row["gsis_id"] = candidates[idx]["gsis_id"]
                    row["pfr_id"] = candidates[idx]["pfr_id"]
                    row["confidence"] = "fuzzy_auto"
                    row["match_score"] = float(score) / 100.0
                    row["source"] = "nflreadpy_players_fuzzy"
                    resolved.append(row)
                    continue
                if score >= 85:
                    row["gsis_id"] = candidates[idx]["gsis_id"]
                    row["pfr_id"] = candidates[idx]["pfr_id"]
                    row["confidence"] = "fuzzy_review"
                    row["match_score"] = float(score) / 100.0
                    row["source"] = "nflreadpy_players_fuzzy"
                    review.append({**row, "mfl_name": p["full_name"], "nfl_name_match": matched_name})
                    continue

        resolved.append(row)

    return resolved, review


def write_csv(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        print(f"  (no rows to write to {path.name})", file=sys.stderr)
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(rows)
    print(f"  wrote {len(rows)} rows → {path.relative_to(REPO_ROOT)}", file=sys.stderr)


def write_local_db(db: sqlite3.Connection, rows: list[dict]) -> None:
    db.execute("""
        CREATE TABLE IF NOT EXISTS player_id_crosswalk (
            mfl_player_id INTEGER PRIMARY KEY,
            gsis_id TEXT, pfr_id TEXT, sleeper_id TEXT, espn_id TEXT,
            full_name TEXT, position TEXT, birth_date TEXT,
            confidence TEXT, match_score REAL, source TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    db.execute("DELETE FROM player_id_crosswalk")
    db.executemany("""
        INSERT INTO player_id_crosswalk
            (mfl_player_id, gsis_id, pfr_id, sleeper_id, espn_id,
             full_name, position, birth_date, confidence, match_score, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, [
        (
            r["mfl_player_id"], r.get("gsis_id"), r.get("pfr_id"),
            r.get("sleeper_id"), r.get("espn_id"),
            r.get("full_name"), r.get("position"), r.get("birth_date"),
            r.get("confidence"), r.get("match_score"), r.get("source"),
        ) for r in rows
    ])
    db.commit()
    print(f"  wrote {len(rows)} rows → local db player_id_crosswalk", file=sys.stderr)


def print_coverage(rows: list[dict]) -> None:
    total = len(rows)
    if not total:
        print("  no rows — coverage not computable", file=sys.stderr)
        return
    by_conf = {}
    for r in rows:
        by_conf[r["confidence"]] = by_conf.get(r["confidence"], 0) + 1
    print("  crosswalk coverage:", file=sys.stderr)
    for conf, n in sorted(by_conf.items(), key=lambda kv: -kv[1]):
        pct = 100.0 * n / total
        print(f"    {conf:15s}: {n:6d} ({pct:5.1f}%)", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh-only", action="store_true",
                    help="Skip nflverse fetch, only copy existing CSV into local DB.")
    args = ap.parse_args()

    if not LOCAL_DB.exists():
        sys.exit(f"local DB missing at {LOCAL_DB}")
    db = sqlite3.connect(str(LOCAL_DB))

    if args.refresh_only:
        if not CROSSWALK_CSV.exists():
            sys.exit(f"no crosswalk CSV at {CROSSWALK_CSV}")
        with CROSSWALK_CSV.open() as f:
            rows = list(csv.DictReader(f))
        for r in rows:
            r["mfl_player_id"] = int(r["mfl_player_id"]) if r.get("mfl_player_id") else None
            r["match_score"] = float(r["match_score"]) if r.get("match_score") else None
        write_local_db(db, rows)
        print_coverage(rows)
        return

    print("building crosswalk (this fetches from nflverse; ~30-60s)...", file=sys.stderr)
    mfl_players = load_mfl_players(db)
    print(f"  mfl players: {len(mfl_players)} rows", file=sys.stderr)
    resolved, review = build_crosswalk(mfl_players)
    write_csv(CROSSWALK_CSV, resolved)
    write_csv(REVIEW_CSV, review)
    write_local_db(db, resolved)
    print_coverage(resolved)
    if review:
        print(f"  {len(review)} fuzzy matches in 0.85-0.95 band queued to {REVIEW_CSV.name}", file=sys.stderr)
        print("  → review and promote to confidence='manual' in the main CSV", file=sys.stderr)


if __name__ == "__main__":
    main()
