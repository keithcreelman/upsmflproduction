#!/usr/bin/env python3
"""Build 2026 ADP consensus from multiple REAL sources.

Source list (Keith 2026-04-25 — the laundry list):

  1. KeepTradeCut dynasty SF rankings
       https://keeptradecut.com/dynasty-rankings?format=2&filters=QB|WR|RB|TE|RDP&teamCount=12
       Crowd-sourced player VALUES (not ranks) — 500+ players. Dynasty bias.

  2. FantasyPros dynasty SF expert consensus (ECR)
       https://www.fantasypros.com/nfl/rankings/dynasty-superflex.php
       Embeds JSON in `var ecrData = {...};`

  3. FantasyPros REDRAFT SF expert consensus
       https://www.fantasypros.com/nfl/rankings/superflex-cheatsheets.php
       Closest to AUCTION-relevant ranking — ranks players for THIS season
       only, not lifetime dynasty value.

  4. (TODO) Sleeper trade values — they expose JSON via their app API
  5. (TODO) FantasyFootballCalculator 2QB ADP
       https://fantasyfootballcalculator.com/api/v1/adp/2qb
       Currently only has 2025-Sept-1 data; updates Aug-Sept each year.
  6. (TODO) MFL cross-league real (non-mock) — currently dominated by
       2026 rookie draft IDs in April 2026. Useful by Aug.

The script:
  - Pulls each source
  - Normalizes player names (strip Jr/Sr/II/III, periods)
  - Joins to mfl player_id via the `players` table for downstream linking
  - Computes a consensus rank weighted by source intent (REDRAFT-heavy
    for 2026 auction prep)
  - Writes `adp_consensus_2026` table with columns:
      mfl_player_id, name, position, ktc_pos_rank, ktc_value,
      fp_dynasty_ovr, fp_redraft_ovr, fp_redraft_pos_rank, consensus_rank,
      consensus_pos_rank, sources_count, fetched_at_utc

Usage:
  python3 pipelines/etl/scripts/build_adp_consensus.py
  python3 pipelines/etl/scripts/build_adp_consensus.py --write   # persists to DB
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

DB_DEFAULT = os.getenv(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/"
    "Desktop/MFL_Scripts/Datastorage/mfl_database.db",
)

KTC_URL = "https://keeptradecut.com/dynasty-rankings?format=2&filters=QB|WR|RB|TE|RDP&teamCount=12"
FP_DYN_URL = "https://www.fantasypros.com/nfl/rankings/dynasty-superflex.php"
FP_RED_URL = "https://www.fantasypros.com/nfl/rankings/superflex-cheatsheets.php"


def fetch(url: str) -> str:
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; ADP-aggregator/1.0)"}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_ktc(html: str) -> list[dict]:
    """KTC embeds the ranking array in `var playersArray = [...]`."""
    m = re.search(r"var playersArray = (\[.*?\]);", html, re.DOTALL)
    if not m:
        return []
    arr = json.loads(m.group(1))
    out = []
    for i, p in enumerate(sorted(arr, key=lambda x: -x.get("superflexValues", {}).get("value", 0))):
        sf = p.get("superflexValues", {})
        out.append({
            "name": p.get("playerName"),
            "position": p.get("position"),
            "team": p.get("team"),
            "ktc_overall": i + 1,
            "ktc_pos_rank": sf.get("positionalRank"),
            "ktc_value": sf.get("value"),
        })
    return out


def parse_fp(html: str) -> list[dict]:
    """FantasyPros embeds `var ecrData = {...};`."""
    m = re.search(r"var ecrData = ({.*?});", html, re.DOTALL)
    if not m:
        return []
    data = json.loads(m.group(1))
    out = []
    for p in data.get("players", []):
        out.append({
            "name": p.get("player_name"),
            "position": p.get("player_position_id"),
            "team": p.get("player_team_id"),
            "rank": p.get("rank_ecr"),
            "rank_avg": p.get("rank_ave"),
            "pos_rank": p.get("pos_rank"),
        })
    return out


def normalize_name(n: str) -> str:
    if not n:
        return ""
    n = n.replace("II", "").replace("III", "").replace("Sr.", "").replace("Jr.", "")
    n = n.replace(".", "").strip()
    n = re.sub(r"\s+", " ", n)
    return n.lower()


def build_mfl_lookup(conn: sqlite3.Connection) -> dict[str, str]:
    """Map normalized player name → MFL player_id from the players table."""
    out: dict[str, str] = {}
    for pid, name in conn.execute(
        "SELECT player_id, name FROM players "
        "WHERE season=(SELECT MAX(season) FROM players) GROUP BY player_id"
    ):
        # MFL uses "Last, First" — flip to "First Last" for matching
        if name and "," in name:
            last, first = name.split(",", 1)
            flipped = f"{first.strip()} {last.strip()}"
        else:
            flipped = name or ""
        out[normalize_name(flipped)] = pid
    return out


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS adp_consensus (
          season               INTEGER NOT NULL,
          mfl_player_id        TEXT,
          name                 TEXT NOT NULL,
          position             TEXT,
          team                 TEXT,
          ktc_overall          INTEGER,
          ktc_pos_rank         INTEGER,
          ktc_value            INTEGER,
          fp_dynasty_overall   INTEGER,
          fp_dynasty_avg       REAL,
          fp_redraft_overall   INTEGER,
          fp_redraft_avg       REAL,
          consensus_rank       INTEGER,
          consensus_pos_rank   INTEGER,
          sources_count        INTEGER,
          fetched_at_utc       TEXT NOT NULL,
          PRIMARY KEY (season, name, position)
        )
    """)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_adp_consensus_pos "
        "ON adp_consensus (season, position, consensus_pos_rank)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_adp_consensus_pid "
        "ON adp_consensus (mfl_player_id)"
    )
    conn.commit()


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db-path", default=DB_DEFAULT)
    ap.add_argument("--season", type=int, default=2026)
    ap.add_argument("--write", action="store_true",
                    help="Persist to adp_consensus table")
    ap.add_argument("--top", type=int, default=50,
                    help="Print top-N QBs (default 50)")
    args = ap.parse_args()

    print("Fetching real ADP sources (no mock data)...", file=sys.stderr)
    print("  [1/3] KeepTradeCut dynasty SF...", file=sys.stderr)
    ktc = parse_ktc(fetch(KTC_URL))
    print(f"        {len(ktc)} players", file=sys.stderr)

    print("  [2/3] FantasyPros dynasty SF (ECR)...", file=sys.stderr)
    fpd = parse_fp(fetch(FP_DYN_URL))
    print(f"        {len(fpd)} players", file=sys.stderr)

    print("  [3/3] FantasyPros REDRAFT SF (2026 ECR)...", file=sys.stderr)
    fpr = parse_fp(fetch(FP_RED_URL))
    print(f"        {len(fpr)} players", file=sys.stderr)

    if not (ktc or fpd or fpr):
        sys.exit("No sources returned data — check network / source URL changes")

    # Index sources by normalized name
    ktc_by = {normalize_name(p["name"]): p for p in ktc}
    fpd_by = {normalize_name(p["name"]): p for p in fpd}
    fpr_by = {normalize_name(p["name"]): p for p in fpr}

    # Union of all names
    all_names: set[str] = set(ktc_by) | set(fpd_by) | set(fpr_by)

    # Connect DB for player_id lookup
    conn = sqlite3.connect(args.db_path, timeout=30.0)
    conn.execute("PRAGMA busy_timeout=30000")
    mfl_lookup = build_mfl_lookup(conn)

    # Build consensus rows. Consensus rank = REDRAFT primary, then dynasty,
    # then KTC overall as fallback. For 2026 AUCTION the redraft ranking is
    # the closest analog to "what should we pay this year".
    rows = []
    for n in all_names:
        ktc_p = ktc_by.get(n)
        fpd_p = fpd_by.get(n)
        fpr_p = fpr_by.get(n)
        # Pick the displayable name from whichever source has it
        disp = (fpr_p or fpd_p or ktc_p)["name"]
        position = (fpr_p or fpd_p or ktc_p).get("position")
        team = (fpr_p or fpd_p or ktc_p).get("team")
        ktc_ovr = ktc_p["ktc_overall"] if ktc_p else None
        ktc_pos_rank = ktc_p["ktc_pos_rank"] if ktc_p else None
        ktc_val = ktc_p["ktc_value"] if ktc_p else None
        fpd_ovr = fpd_p["rank"] if fpd_p else None
        fpd_avg = fpd_p["rank_avg"] if fpd_p else None
        fpr_ovr = fpr_p["rank"] if fpr_p else None
        fpr_avg = fpr_p["rank_avg"] if fpr_p else None
        sources = sum(x is not None for x in (ktc_p, fpd_p, fpr_p))
        rows.append({
            "name": disp, "position": position, "team": team,
            "ktc_overall": ktc_ovr, "ktc_pos_rank": ktc_pos_rank, "ktc_value": ktc_val,
            "fp_dynasty_overall": fpd_ovr, "fp_dynasty_avg": fpd_avg,
            "fp_redraft_overall": fpr_ovr, "fp_redraft_avg": fpr_avg,
            "sources_count": sources,
            "norm": n,
            "mfl_player_id": mfl_lookup.get(n),
        })

    # Consensus overall rank — sort by fp_redraft when present, else fp_dynasty,
    # else ktc_overall + 200 offset (so KTC-only dynasty entries don't outrank
    # a redraft-ranked player).
    def sort_key(r):
        if r["fp_redraft_overall"] is not None:
            return (0, r["fp_redraft_overall"])
        if r["fp_dynasty_overall"] is not None:
            return (1, r["fp_dynasty_overall"])
        if r["ktc_overall"] is not None:
            return (2, r["ktc_overall"])
        return (9, 9999)

    rows.sort(key=sort_key)
    for i, r in enumerate(rows):
        r["consensus_rank"] = i + 1

    # Per-position consensus rank
    by_pos_count: dict[str, int] = defaultdict(int)
    for r in rows:
        if r["position"]:
            by_pos_count[r["position"]] += 1
            r["consensus_pos_rank"] = by_pos_count[r["position"]]

    # Print top QBs
    print()
    print(f"=== 2026 SF QB CONSENSUS (top {args.top}) ===")
    print(f"  {'rank':<5}{'name':<26}{'pos':<5}{'team':<5}"
          f"{'KTC_pos':>9}{'FPdyn':>7}{'FPred':>7}{'mfl_id':>10}")
    qb_n = 0
    for r in rows:
        if r.get("position") != "QB":
            continue
        qb_n += 1
        if qb_n > args.top:
            break
        print(f"  QB{qb_n:<3}{r['name'][:25]:<26}{(r['position'] or ''):<5}{(r['team'] or '')[:4]:<5}"
              f"{(r['ktc_pos_rank'] or '—'):>9}{(r['fp_dynasty_overall'] or '—'):>7}"
              f"{(r['fp_redraft_overall'] or '—'):>7}{(r['mfl_player_id'] or '—'):>10}")

    if args.write:
        ensure_table(conn)
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        conn.execute("DELETE FROM adp_consensus WHERE season = ?", (args.season,))
        conn.executemany(
            """
            INSERT INTO adp_consensus (
              season, mfl_player_id, name, position, team,
              ktc_overall, ktc_pos_rank, ktc_value,
              fp_dynasty_overall, fp_dynasty_avg,
              fp_redraft_overall, fp_redraft_avg,
              consensus_rank, consensus_pos_rank, sources_count, fetched_at_utc
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            [(args.season, r["mfl_player_id"], r["name"], r.get("position"), r.get("team"),
              r["ktc_overall"], r["ktc_pos_rank"], r["ktc_value"],
              r["fp_dynasty_overall"], r["fp_dynasty_avg"],
              r["fp_redraft_overall"], r["fp_redraft_avg"],
              r["consensus_rank"], r.get("consensus_pos_rank"),
              r["sources_count"], now) for r in rows]
        )
        conn.commit()
        n_total = len(rows)
        n_matched = sum(1 for r in rows if r["mfl_player_id"])
        print(f"\nWrote {n_total} rows to adp_consensus (season={args.season}); "
              f"{n_matched} matched to MFL player_id")

    conn.close()


if __name__ == "__main__":
    main()
