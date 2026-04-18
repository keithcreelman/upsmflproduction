#!/usr/bin/env python3
"""
Build an index of all trades (and their associated asset moves) so the
roster_lineage.html page can hyperlink trade events to a detail view.

For each (season, txn_index) pair in transactions_trades, emit:
  - trade_group_id
  - datetime
  - SENDER franchise + all assets given up
  - RECEIVER franchise + all assets received
  - reverse side (what the receiver gave up)

Because MFL trades are multi-asset (players + picks + cap) and multi-franchise,
we group by trade_group_id so both sides' full asset list is visible.

Output: /site/reports/transactions_index.json

Usage:
  python3 build_transactions_index.py
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = os.environ.get(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
)
DEFAULT_OUT = "/Users/keithcreelman/Documents/mfl/Codex/_worktrees/rulebook-mobile-preview/site/reports/transactions_index.json"


def safe_str(x) -> str:
    return "" if x is None else str(x).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-path", default=DEFAULT_DB)
    ap.add_argument("--out-path", default=DEFAULT_OUT)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    try:
        # Build player name map for human-readable asset labels
        pmap = {}
        for r in conn.execute("SELECT player_id, name, position FROM players WHERE season=(SELECT MAX(season) FROM players)").fetchall():
            pmap[safe_str(r[0])] = {"name": r[1], "position": r[2]}

        # All trades grouped by trade_group_id (one or more players, picks per side)
        rows = conn.execute(
            """SELECT season, txn_index, trade_group_id, datetime_et, franchise_id,
                      franchise_name, franchise_role, asset_role, asset_type,
                      player_id, player_name,
                      asset_draftpick_season, asset_draftpick_round, asset_draftpick_roundorder,
                      asset_draftpick_future_year, asset_draftpick_future_round, asset_draftpick_future_roundorder,
                      asset_draftpick_future_franchiseid,
                      asset_capadjustment
               FROM transactions_trades
               ORDER BY season, txn_index, franchise_role, asset_role"""
        ).fetchall()

        groups: dict = {}
        for r in rows:
            gid = safe_str(r[2])
            if not gid:
                gid = f"{r[0]}_{r[1]}"
            g = groups.setdefault(gid, {
                "trade_group_id": gid,
                "season": r[0],
                "txn_index": r[1],
                "datetime": r[3],
                "sides": {},
            })
            fid = safe_str(r[4])
            side = g["sides"].setdefault(fid, {
                "franchise_id": fid,
                "franchise_name": r[5],
                "role": r[6],
                "relinquished": [],
                "acquired": [],
            })
            asset_role = safe_str(r[7]).upper()
            asset = {
                "asset_type": r[8],
                "player_id": r[9],
                "player_name": (pmap.get(safe_str(r[9])) or {}).get("name") if r[9] else r[10],
                "position": (pmap.get(safe_str(r[9])) or {}).get("position") if r[9] else None,
                # Current-year draft pick fields
                "dp_season": r[11],
                "dp_round": r[12],
                "dp_slot": r[13],
                # Future pick fields
                "fdp_year": r[14],
                "fdp_round": r[15],
                "fdp_slot": r[16],
                "fdp_from_franchise": r[17],
                "cap_amount": r[18],
            }
            if asset_role == "RELINQUISH":
                side["relinquished"].append(asset)
            elif asset_role == "ACQUIRE":
                side["acquired"].append(asset)

        # Flatten sides back to array for UI consumption
        out_groups = []
        for gid, g in groups.items():
            g["sides"] = list(g["sides"].values())
            out_groups.append(g)
        out_groups.sort(key=lambda x: (x["season"] or 0, x["txn_index"] or 0))

        # Also build a simple lookup by link_txn_id used in roster_lineage.json
        # (format: "{season}_{txn_index}")
        by_link = {}
        for g in out_groups:
            key = f"{g['season']}_{g['txn_index']}"
            by_link[key] = g

        payload = {
            "meta": {
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "trade_count": len(out_groups),
            },
            "trades_by_link": by_link,
        }
        out_path = Path(args.out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2))
        print(json.dumps({
            "ok": True, "trade_count": len(out_groups),
            "out_path": str(out_path),
            "size_bytes": out_path.stat().st_size,
        }, indent=2))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
