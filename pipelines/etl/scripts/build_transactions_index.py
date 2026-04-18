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

        # Historical franchise-name map keyed by (season, franchise_id).
        # rosters_weekly.team_name and transactions_trades.franchise_name have
        # been backfilled with CURRENT names, so they misrepresent old trades
        # (e.g., "The Long Haulers" for a May 2024 trade that was actually
        # Josh Lima's "Main Event Mafia"). The franchises table is the truth.
        fmap: dict = {}
        for r in conn.execute("SELECT season, franchise_id, team_name, owner_name FROM franchises").fetchall():
            fmap[(int(r[0]), safe_str(r[1]))] = {"team_name": r[2], "owner_name": r[3]}
        max_season = conn.execute("SELECT MAX(season) FROM franchises").fetchone()[0]

        def resolve_franchise(season, fid, fallback=""):
            season = int(season) if season is not None else None
            fid = safe_str(fid)
            if season is not None:
                hit = fmap.get((season, fid))
                if hit:
                    return hit["team_name"] or fallback
            # Fall forward to latest known name
            hit = fmap.get((max_season, fid))
            return (hit["team_name"] if hit else "") or fallback

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
                "franchise_name": resolve_franchise(r[0], fid, fallback=r[5]),
                "role": r[6],
                "relinquished": [],
                "acquired": [],
            })
            asset_role = safe_str(r[7]).upper()
            # Resolve future-pick origin franchise id → name using trade-season context
            fdp_from_id = safe_str(r[17])
            fdp_from_name = resolve_franchise(r[0], fdp_from_id, fallback=fdp_from_id) if fdp_from_id else ""
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
                "fdp_from_franchise": fdp_from_id,
                "fdp_from_franchise_name": fdp_from_name,
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

        # Add/drop events keyed by "addrop_{season}_{txn_index}"
        adddrop_by_link: dict = {}
        ad_rows = conn.execute(
            """SELECT season, txn_index, datetime_et, franchise_id, player_id,
                      move_type, method, salary
               FROM transactions_adddrop ORDER BY season, txn_index"""
        ).fetchall()
        # Group by (season, txn_index) — a DROP/ADD txn is typically one franchise + one player,
        # but in MFL a DROP and ADD for the same pid share the waiver context.
        for r in ad_rows:
            key = f"addrop_{r[0]}_{r[1]}"
            pid = safe_str(r[4])
            player_info = pmap.get(pid) or {}
            adddrop_by_link[key] = {
                "type": "ADDDROP",
                "season": r[0],
                "txn_index": r[1],
                "datetime": r[2],
                "franchise_id": r[3],
                "franchise_name": resolve_franchise(r[0], r[3], fallback=r[3]),
                "player_id": pid,
                "player_name": player_info.get("name"),
                "position": player_info.get("position"),
                "move_type": r[5],
                "method": r[6],
                "salary": r[7],
            }

        # Cap adjustments keyed by "adj_{season}_{pid}_{source_id}"
        adj_by_link: dict = {}
        from pathlib import Path as _Path
        SAL_ADJ_DIR = _Path("/Users/keithcreelman/Documents/mfl/Codex/_worktrees/rulebook-mobile-preview/site/reports/salary_adjustments")
        for yr in range(2012, 2027):
            p = SAL_ADJ_DIR / f"salary_adjustments_{yr}.json"
            if not p.exists():
                continue
            try:
                d = json.loads(p.read_text())
            except Exception:
                continue
            for row in d.get("rows", []) or []:
                source_id = safe_str(row.get("source_id"))
                if not source_id:
                    continue
                link = f"adj_{row.get('adjustment_season')}_{row.get('player_id')}_{source_id}"
                adj_by_link[link] = {
                    "type": "CAP_ADJUSTMENT",
                    "adjustment_season": row.get("adjustment_season"),
                    "source_season": row.get("source_season"),
                    "adjustment_type": row.get("adjustment_type"),
                    "franchise_id": row.get("franchise_id"),
                    "franchise_name": resolve_franchise(
                        row.get("adjustment_season"), row.get("franchise_id"),
                        fallback=row.get("franchise_name") or row.get("franchise_id"),
                    ),
                    "player_id": row.get("player_id"),
                    "player_name": row.get("player_name"),
                    "amount": row.get("amount"),
                    "direction": row.get("direction"),
                    "description": row.get("description"),
                    "transaction_datetime": row.get("transaction_datetime_et"),
                    "pre_drop_contract_info": row.get("pre_drop_contract_info"),
                    "pre_drop_salary": row.get("pre_drop_salary"),
                    "pre_drop_contract_length": row.get("pre_drop_contract_length"),
                    "pre_drop_tcv": row.get("pre_drop_tcv"),
                    "drop_method": row.get("drop_method"),
                    "source_id": source_id,
                }

        payload = {
            "meta": {
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "trade_count": len(out_groups),
                "adddrop_count": len(adddrop_by_link),
                "adj_count": len(adj_by_link),
            },
            "trades_by_link": by_link,
            "adddrop_by_link": adddrop_by_link,
            "adj_by_link": adj_by_link,
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
