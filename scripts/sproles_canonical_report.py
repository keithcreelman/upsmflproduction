#!/usr/bin/env python3
"""Pull Sproles' full 2011 lineage from canonical D1 tables.

Demonstrates the canonical data model end-to-end:
  - mfl_historical_auctions   (was he bought? — no for Sproles)
  - mfl_historical_transactions (BBID pickup events)
  - mfl_trade_event + mfl_trade_asset (the trade detail)
  - mfl_franchise_history     (team-name resolution per season)
"""
from __future__ import annotations
import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

WORKER = Path(__file__).resolve().parents[1] / "worker"
SPROLES_GSIS = "7942"  # Sproles' MFL player_id (constant across seasons)


def q(sql):
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    res = subprocess.run(cmd, cwd=str(WORKER), capture_output=True, text=True)
    if res.returncode != 0: sys.exit(res.stderr[:500])
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def player_name(pid):
    if not pid: return ""
    r = q(f"SELECT display_name FROM dim_player_bio WHERE gsis_id IS NOT NULL "
          f"AND gsis_id LIKE '%{pid}%' LIMIT 1")
    if r: return r[0].get("display_name") or ""
    return ""


def main():
    print("=" * 78)
    print(f" DARREN SPROLES — 2011 CANONICAL LINEAGE  (player_id={SPROLES_GSIS})")
    print("=" * 78)

    # 1. Auction
    print("\n[1] AUCTION (mfl_historical_auctions, season=2011):")
    rows = q(f"SELECT a.franchise_id, fh.team_name, a.winning_bid, a.normalized_bid, a.notes "
             f"FROM mfl_historical_auctions a "
             f"LEFT JOIN mfl_franchise_history fh ON fh.season=a.season AND fh.franchise_id=a.franchise_id "
             f"WHERE a.player_id='{SPROLES_GSIS}' AND a.season=2011")
    if not rows:
        print("    (no auction record — Sproles was NOT bought in the inaugural 2011 auction)")
    else:
        for r in rows:
            print(f"    f{r['franchise_id']} {r['team_name']} | bid=${r['winning_bid']} norm=${r['normalized_bid']}")

    # 2. Transactions
    print("\n[2] TRANSACTIONS (mfl_historical_transactions, season=2011):")
    rows = q(f"SELECT t.ts_iso, t.type, t.franchise_id, fh.team_name, t.player_in_id, "
             f"t.player_out_id, t.salary, t.source, t.raw_payload "
             f"FROM mfl_historical_transactions t "
             f"LEFT JOIN mfl_franchise_history fh ON fh.season=t.season AND fh.franchise_id=t.franchise_id "
             f"WHERE t.season=2011 AND (t.player_in_id='{SPROLES_GSIS}' OR t.player_out_id='{SPROLES_GSIS}') "
             f"ORDER BY t.ts_unix")
    if not rows:
        print("    (none)")
    for r in rows:
        side = "IN " if r["player_in_id"] == SPROLES_GSIS else "OUT"
        sal = f"${r['salary']:,}" if r['salary'] else ""
        print(f"    {r['ts_iso']} | f{r['franchise_id']} {r['team_name']:20} | "
              f"{r['type']:25} {side} {sal:8} | src={r['source']:13} payload={r['raw_payload'][:40]}")

    # 3. Trades involving Sproles
    print("\n[3] TRADES (mfl_trade_event + mfl_trade_asset, asset_type=PLAYER):")
    rows = q(f"SELECT te.ts_iso, te.trade_id, ta.franchise_id, fh.team_name, "
             f"ta.asset_role, te.comments "
             f"FROM mfl_trade_asset ta "
             f"JOIN mfl_trade_event te ON te.trade_id=ta.trade_id "
             f"LEFT JOIN mfl_franchise_history fh ON fh.season=te.season AND fh.franchise_id=ta.franchise_id "
             f"WHERE te.season=2011 AND ta.player_id='{SPROLES_GSIS}'")
    if not rows:
        print("    (no trades involving Sproles in 2011)")
    for r in rows:
        print(f"    {r['ts_iso']} | trade_id={r['trade_id']}")
        print(f"      f{r['franchise_id']} {r['team_name']:20} {r['asset_role']}")
        if r['comments']:
            print(f"      comment: \"{r['comments'][:100]}\"")

    # Also print all assets in any trade Sproles was part of
    print("\n[4] FULL ASSET LIST FOR SPROLES TRADES:")
    trade_ids = q(f"SELECT DISTINCT te.trade_id FROM mfl_trade_asset ta "
                  f"JOIN mfl_trade_event te ON te.trade_id=ta.trade_id "
                  f"WHERE te.season=2011 AND ta.player_id='{SPROLES_GSIS}'")
    for tid_row in trade_ids:
        tid = tid_row["trade_id"]
        print(f"\n    Trade {tid}:")
        assets = q(f"SELECT ta.franchise_id, fh.team_name, ta.asset_role, ta.asset_type, "
                   f"ta.player_id, ta.pick_descriptor "
                   f"FROM mfl_trade_asset ta "
                   f"LEFT JOIN mfl_trade_event te ON te.trade_id=ta.trade_id "
                   f"LEFT JOIN mfl_franchise_history fh ON fh.season=te.season AND fh.franchise_id=ta.franchise_id "
                   f"WHERE ta.trade_id='{tid}' "
                   f"ORDER BY ta.franchise_id, ta.asset_role")
        for a in assets:
            label = a['player_id'] if a['asset_type'] == 'PLAYER' else (a.get('pick_descriptor') or 'pick')
            print(f"      f{a['franchise_id']} {a['team_name']:20} {a['asset_role']:11} {a['asset_type']:18} {label}")

    # 5. End-of-season state from rosters.json (reads file directly — that's
    # the source-of-truth for EOS contracts)
    print("\n[5] END-OF-SEASON 2011 STATE (from MFL rosters.json):")
    ros = json.loads((Path("data/mfl-historical/2011/rosters.json")).read_text())
    for fr in ros["rosters"]["franchise"]:
        plist = fr.get("player", [])
        if isinstance(plist, dict): plist = [plist]
        for p in plist:
            if p["id"] == SPROLES_GSIS:
                print(f"    f{fr['id']} | salary=${p.get('salary')} | "
                      f"contractYear={p.get('contractYear')} | "
                      f"status={p.get('status')} | "
                      f"contractStatus={p.get('contractStatus')}")

    print("\n" + "=" * 78)
    print(" SUMMARY")
    print("=" * 78)
    print("""
 Sproles was NOT in the inaugural 2011 auction (didn't appear in MFL
 auctionResults). He was picked up via BBID waiver by Blake Bombers
 (f0010) on Sep 14, 2011 for $5,000. On Nov 11, 2011 he was traded to
 Wetter Than Dutch Dikes (f0001) straight up for Eli Manning (player
 7391). WTDD invoked the trade-pickup extension rule (1-year contract
 acquired via trade can be extended within 2 weeks). The +$10K bump
 produced a 2-yr extension at $5K Y1 / $15K Y2.

 EOS reflects the rolled-forward state: $15,000, CY1 (1 year remaining),
 status=ROSTER, contractStatus=Extension Used.

 Roll-forward note: Keith confirmed contracts roll forward at season end
 BEFORE the next year's auction. So the "CY1 / $15K" you see is what
 would carry into 2012 — the 2011 ACTUAL season ended with the 2-yr
 extension active (CY2 originally, with Y1 already consumed).
""")


if __name__ == "__main__":
    main()
