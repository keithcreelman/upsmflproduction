#!/usr/bin/env python3
"""Load 2011 (and future years) historical league lineage data into D1.

Tables populated:
  - mfl_franchise_history       (per-season team name + owner)
  - mfl_historical_auctions     (initial auction wins, normalized bids)
  - mfl_historical_transactions (combined MFL + src_adddrop)
  - mfl_trade_event + mfl_trade_asset (multi-asset trades from src_trades)
  - mfl_cap_penalty_event + mfl_cap_penalty_player (forum-parsed)

Usage:
  python3 pipelines/etl/scripts/load_historical_lineage.py --season 2011
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORKER = ROOT / "worker"
DATA = ROOT / "data" / "mfl-historical"
FORUM_DIR = ROOT / "services/rulebook/sources/rules/mfl_message_boards"

sys.path.insert(0, str(ROOT / "pipelines" / "etl"))
from lib.d1_io import D1Writer  # noqa: E402


def wrangler_query(sql: str) -> list[dict]:
    cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
           "--remote", "--command", sql, "--json"]
    res = subprocess.run(cmd, cwd=str(WORKER), capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"wrangler query failed: {res.stderr[:500]}")
    out = res.stdout
    return json.loads(out[out.find("["):])[0]["results"]


def short_hash(s: str, n: int = 10) -> str:
    return hashlib.md5(s.encode()).hexdigest()[:n]


def load_year(season: int):
    year_dir = DATA / str(season)
    print(f"\n=== Loading historical lineage for {season} ===", file=sys.stderr)

    league = json.loads((year_dir / "league.json").read_text())["league"]
    league_id = league["id"]
    auction = json.loads((year_dir / "auctionResults.json").read_text())["auctionResults"]
    txn_doc = json.loads((year_dir / "transactions.json").read_text())
    rosters = json.loads((year_dir / "rosters.json").read_text())["rosters"]

    franchises_mfl = {f["id"]: f["name"]
                      for f in league["franchises"]["franchise"]}

    # ── 1. Franchise history (combine src_adddrop + MFL current name)
    src_names = wrangler_query(
        f"SELECT DISTINCT franchise_name FROM src_adddrop WHERE season={season} "
        f"AND franchise_name != ''"
    )
    src_franchise_names = sorted({r["franchise_name"] for r in src_names})
    # Best-effort mapping: pair src names with MFL franchise IDs by exact match
    # or by the documented alias (Raining Bullets ↔ Bad Newz Kennels for f0008).
    # Aliases captured here can be extended as we discover more.
    KNOWN_ALIASES = {
        # season → { src_name → mfl_franchise_id }
        2011: {"Raining Bullets": "0008"},  # historical → current = Bad Newz Kennels
    }
    aliases = KNOWN_ALIASES.get(season, {})

    name_to_id = {name.lower(): fid for fid, name in franchises_mfl.items()}
    rows_franchise = []
    for fid, mfl_name in franchises_mfl.items():
        # Find what this franchise was called in src_adddrop for this season
        season_name = mfl_name  # default
        # Check aliases
        for src_name, target_fid in aliases.items():
            if target_fid == fid:
                season_name = src_name
                break
        # Verify via src_adddrop
        if season_name.lower() in [n.lower() for n in src_franchise_names]:
            source = "src_adddrop"
        elif mfl_name.lower() in [n.lower() for n in src_franchise_names]:
            source = "mfl_api"
            season_name = mfl_name
        else:
            source = "mfl_api"
        notes = ""
        if season_name != mfl_name:
            notes = f"Renamed to '{mfl_name}' in MFL after {season}"
        rows_franchise.append((season, fid, season_name, None, source, notes))

    print(f"  Franchise history rows: {len(rows_franchise)}", file=sys.stderr)
    write_chunked("mfl_franchise_history",
                  ["season","franchise_id","team_name","owner_name","source","notes"],
                  ["season","franchise_id"], rows_franchise)

    # ── 2. Auctions
    rows_auctions = []
    for a in auction["auctionUnit"]["auction"]:
        bid = int(a["winningBid"])
        # Normalize: round to nearest $1K (handles Ray Rice $59,009 → $59,000)
        normalized = round(bid / 1000) * 1000
        notes = "" if bid == normalized else f"raw bid={bid}, normalized to ${normalized}"
        rows_auctions.append((
            season, league_id, a["player"], a["franchise"],
            bid, normalized,
            int(a.get("timeStarted", 0)) or None,
            int(a.get("lastBidTime", 0)) or None,
            "INAUGURAL" if season == 2011 else "FA_AUCTION",
            None, None,
            "mfl_api", notes,
        ))
    print(f"  Auction rows: {len(rows_auctions)}", file=sys.stderr)
    write_chunked("mfl_historical_auctions",
                  ["season","league_id","player_id","franchise_id",
                   "winning_bid","normalized_bid","time_started","last_bid_time",
                   "auction_type","contract_length","contract_info","source","notes"],
                  ["season","league_id","player_id"], rows_auctions)

    # ── 3. Transactions (MFL + src_adddrop)
    cutoff_low = int(datetime(season, 8, 1).timestamp())
    cutoff_hi = int(datetime(season + 1, 3, 1).timestamp())
    txns = txn_doc["transactions"]["transaction"]
    txns_valid = [t for t in txns if t.get("franchise") and t.get("transaction")
                  and cutoff_low <= int(t.get("timestamp", "0")) <= cutoff_hi]

    rows_txns = []
    for t in txns_valid:
        ts = int(t["timestamp"])
        ttype = t["type"]
        fid = t["franchise"]
        txn_str = t["transaction"]
        # Parse player_in / player_out from the pipe-delimited string
        player_in, player_out, salary = parse_mfl_txn_string(txn_str, ttype)
        uid = short_hash(f"{season}|{ts}|{fid}|{ttype}|{txn_str}")
        rows_txns.append((
            season, uid, ttype, ts,
            datetime.fromtimestamp(ts).isoformat(),
            fid, player_in, player_out, salary,
            "mfl_api", txn_str,
        ))

    # Also load src_adddrop to capture transactions MFL might have lost
    # and to cross-reference (different transaction key system, but covers
    # the same events for 2011 — flag as "src_adddrop" source for traceability)
    src_addrop = wrangler_query(
        f"SELECT season, txn_index, player_id, move_type, franchise_id, "
        f"franchise_name, method, salary, unix_timestamp, datetime_et "
        f"FROM src_adddrop WHERE season={season}"
    )
    # Build franchise_name → franchise_id from our just-loaded history (incl. aliases)
    name_to_fid = {n.lower(): fid for fid, n in franchises_mfl.items()}
    for src_name, fid in aliases.items():
        name_to_fid[src_name.lower()] = fid
    # Add any leftover src names by trying loose match
    for r in src_addrop:
        sn = (r.get("franchise_name") or "").lower()
        if sn and sn not in name_to_fid:
            for mfl_name, fid in name_to_fid.items():
                if sn == mfl_name or sn.replace("'", "") == mfl_name.replace("'", ""):
                    name_to_fid[sn] = fid
                    break

    for r in src_addrop:
        sn = (r.get("franchise_name") or "").lower()
        fid = name_to_fid.get(sn) or r.get("franchise_id") or ""
        ts = int(r.get("unix_timestamp", 0) or 0)
        if ts == 0: continue
        ttype_src = r["move_type"] + "_" + (r.get("method") or "UNKNOWN")
        player_in = r["player_id"] if r["move_type"] == "ADD" else None
        player_out = r["player_id"] if r["move_type"] == "DROP" else None
        salary = int(r["salary"]) if r.get("salary") is not None else None
        uid = short_hash(f"src|{season}|{ts}|{fid}|{r['txn_index']}|{r['move_type']}|{r['player_id']}")
        rows_txns.append((
            season, uid, ttype_src, ts,
            r.get("datetime_et"),
            fid, player_in, player_out, salary,
            "src_adddrop", f"{r.get('move_type')}|{r.get('method')}|{r.get('player_id')}|{r.get('salary') or ''}",
        ))

    print(f"  Transaction rows: {len(rows_txns)} (mfl + src_adddrop combined)", file=sys.stderr)
    write_chunked("mfl_historical_transactions",
                  ["season","txn_uid","type","ts_unix","ts_iso","franchise_id",
                   "player_in_id","player_out_id","salary","source","raw_payload"],
                  ["season","txn_uid"], rows_txns)

    # ── 4. Trades (from src_trades)
    src_trades = wrangler_query(
        f"SELECT season, trade_group_id, franchise_id, franchise_name, "
        f"asset_role, asset_type, player_id, comments, unix_timestamp, datetime_et "
        f"FROM src_trades WHERE season={season} ORDER BY unix_timestamp, trade_group_id"
    )
    # Group by (ts, frozenset of franchises) to form trade groups
    # The src_trades trade_group_id may be reliable; use it as the group key
    groups = defaultdict(list)
    for r in src_trades:
        key = (r["unix_timestamp"], r.get("trade_group_id") or "")
        groups[key].append(r)

    rows_trade_event = []
    rows_trade_asset = []
    for (ts, gid), rows in groups.items():
        franchises_in_trade = sorted({(r.get("franchise_id") or
                                        name_to_fid.get((r.get("franchise_name") or "").lower(),"?"))
                                       for r in rows})
        franchise_csv = ",".join(franchises_in_trade)
        trade_id = f"{season}_{ts}_{short_hash(franchise_csv, 6)}"
        comments = next((r.get("comments") for r in rows if r.get("comments")), "") or ""
        rows_trade_event.append((
            trade_id, season, int(ts),
            datetime.fromtimestamp(int(ts)).isoformat(),
            franchise_csv, comments, "src_trades",
        ))
        for i, r in enumerate(rows, 1):
            fid = r.get("franchise_id") or name_to_fid.get((r.get("franchise_name") or "").lower(),"")
            rows_trade_asset.append((
                trade_id, i, fid,
                r["asset_role"], r["asset_type"],
                r.get("player_id") if r["asset_type"] == "PLAYER" else None,
                None if r["asset_type"] == "PLAYER" else (r.get("player_id") or "future_pick"),
            ))

    print(f"  Trade events: {len(rows_trade_event)}; trade assets: {len(rows_trade_asset)}",
          file=sys.stderr)
    write_chunked("mfl_trade_event",
                  ["trade_id","season","ts_unix","ts_iso","franchises_csv","comments","source"],
                  ["trade_id"], rows_trade_event)
    write_chunked("mfl_trade_asset",
                  ["trade_id","asset_seq","franchise_id","asset_role","asset_type",
                   "player_id","pick_descriptor"],
                  ["trade_id","asset_seq"], rows_trade_asset)

    # ── 5. Cap penalties (forum-parsed)
    forum_text = (FORUM_DIR / "manual" / f"{season}_messageboard.txt").read_text()
    cap_events, cap_players = parse_cap_penalties(forum_text, season, name_to_fid)
    print(f"  Cap-penalty events: {len(cap_events)}; player items: {len(cap_players)}",
          file=sys.stderr)
    write_chunked("mfl_cap_penalty_event",
                  ["event_id","season","franchise_id","total_cut_amount","cap_hit_amount",
                   "cap_hit_pct","post_date","is_final","source","source_citation","raw_text"],
                  ["event_id"], cap_events)
    write_chunked("mfl_cap_penalty_player",
                  ["event_id","player_id","player_text","contract_length",
                   "salary_per_yr","total_value"],
                  ["event_id","player_text"], cap_players)


def parse_mfl_txn_string(s: str, ttype: str):
    """Decode pipe-delimited MFL transaction string.

    Examples (varies by type):
      AUCTION_WON:  "5848|57000"  (player|bid)
      BBID_WAIVER:  "10355|15000.00|0000"  (player_added|salary|player_dropped or 0000)
      FREE_AGENT:   "9787,|8686,"  (added,|dropped,)
      LOAD_ROSTERS: "|7921,9652,"  (|drops_csv,)
    Returns (player_in, player_out, salary).
    """
    if not s: return (None, None, None)
    if ttype == "AUCTION_WON":
        parts = s.split("|")
        player = parts[0] if parts and parts[0] else None
        salary = None
        if len(parts) > 1 and parts[1]:
            try: salary = int(float(parts[1]))
            except: pass
        return (player, None, salary)
    if ttype.startswith("BBID") or ttype == "WAIVER":
        # player_added|salary|player_dropped
        parts = s.split("|")
        added = parts[0] if parts and parts[0] else None
        salary = None
        if len(parts) > 1 and parts[1]:
            try: salary = int(float(parts[1]))
            except: pass
        dropped = parts[2] if len(parts) > 2 and parts[2] not in ("", "0000") else None
        return (added, dropped, salary)
    if ttype in ("FREE_AGENT", "LOAD_ROSTERS"):
        # added,|dropped, OR |dropped, (load_rosters often has empty add side)
        parts = s.split("|")
        adds = [p for p in (parts[0] if parts else "").split(",") if p] if parts else []
        drops = [p for p in (parts[1] if len(parts) > 1 else "").split(",") if p] if len(parts) > 1 else []
        # Squash to single-row: take first add + first drop (multiple-asset moves
        # are rare in this format and fall to raw_payload for full audit)
        return (adds[0] if adds else None, drops[0] if drops else None, None)
    if ttype == "IR":
        return (None, s.strip("|"), None)
    return (None, None, None)


def parse_cap_penalties(text: str, season: int, name_to_fid: dict):
    """Parse forum cap-hit posts into team events + per-player items.

    The Jan 8, 2012 post in 2011_messageboard.txt is the canonical final tally.
    Format: 'Team - $XK Cut @ 20% = $YK (Player A 2 yrs $8K per yr, Player B 1 yr $5K)'
    """
    events = []
    items = []
    # Find the final-tally section (after "CURRENT CAP PENALTIES FOR EACH ROSTER")
    # Allow digits (R-11) in team names; don't require end-of-line (forum
    # lines often have a trailing TAB + date timestamp on the same line)
    pattern = re.compile(
        r"^([A-Za-z0-9'\- ]+?)\s*[-–]\s*\$?(\d+(?:\.\d+)?)K?\s*[Cc]ut\s*@\s*(\d+)%\s*=\s*\$?(\d+(?:\.\d+)?)K?\s*\(([^)]+)\)",
        re.MULTILINE,
    )
    # "$0" rows like "BTNH -  $0" or "R-11 - $0"
    zero_pattern = re.compile(
        r"^([A-Za-z0-9'\- ]+?)\s*[-–]\s*\$?0K?\s*$",
        re.MULTILINE,
    )

    # Approximate post date: 2012-01-08 per forum
    post_date = f"{season+1}-01-08"

    for m in pattern.finditer(text):
        team_raw = m.group(1).strip()
        total_cut_k = float(m.group(2))
        pct = int(m.group(3))
        cap_hit_k = float(m.group(4))
        players_blob = m.group(5)
        fid = match_team_to_fid(team_raw, name_to_fid)
        if not fid: continue
        total_cut = int(total_cut_k * 1000)
        cap_hit = int(cap_hit_k * 1000)
        event_id = f"{season}_{fid}_{post_date}_final"
        events.append((
            event_id, season, fid, total_cut, cap_hit,
            pct / 100.0, post_date, 1, "forum_manual",
            f"manual/{season}_messageboard.txt", m.group(0),
        ))
        # Parse each player
        for player_text in re.split(r",\s*", players_blob):
            ptext = player_text.strip()
            if not ptext: continue
            length_yr, salary, total = parse_player_contract_line(ptext)
            items.append((event_id, None, ptext, length_yr, salary, total))

    for m in zero_pattern.finditer(text):
        team_raw = m.group(1).strip()
        # Skip if already matched in pattern above
        fid = match_team_to_fid(team_raw, name_to_fid)
        if not fid: continue
        # Only insert zero-events for teams not already in events
        if any(e[2] == fid for e in events): continue
        event_id = f"{season}_{fid}_{post_date}_final"
        events.append((event_id, season, fid, 0, 0, 0.20, post_date, 1,
                       "forum_manual", f"manual/{season}_messageboard.txt", m.group(0)))

    return events, items


def parse_player_contract_line(text: str):
    """Parse 'Brandon Pettigrew 2 yrs $8K per yr' → (length=2, salary=8000, total=16000).

    Variants:
      'Player Name 2 yrs $8K per yr'
      'Player Name 1 yr $5K'
      'Player Name 3 Yrs $9K per yr'
      'Player Name 1 yr $25K'
    """
    m = re.search(r"(\d+)\s*[Yy][Rr][Ss]?\s*\$?(\d+(?:\.\d+)?)K?", text)
    if not m: return (None, None, None)
    length = int(m.group(1))
    salary = int(float(m.group(2)) * 1000)
    return (length, salary, length * salary)


def match_team_to_fid(team_text: str, name_to_fid: dict) -> str | None:
    """Loose match: forum may say 'CTown' instead of 'C-Town Chivalry', etc."""
    t = team_text.lower().replace("'", "").replace("-", "").replace(".", "").strip()
    # Direct hits
    for name, fid in name_to_fid.items():
        n = name.lower().replace("'", "").replace("-", "").replace(".", "").strip()
        if t == n: return fid
        if t in n or n in t: return fid
    # Aliases for forum shortenings
    aliases = {
        "wtdd": "wetter than dutch dikes",
        "ctown": "c-town chivalry",
        "btnh": "btnh",
        "fat cat": "the fat cat",
        "bad newz kennels": "bad newz kennels",
        "raining bullets": "bad newz kennels",  # historical alias
    }
    if t in aliases:
        return name_to_fid.get(aliases[t])
    return None


def write_chunked(table, cols, pk_cols, rows):
    if not rows:
        print(f"    [skip] {table}: 0 rows", file=sys.stderr)
        return
    with D1Writer(table=table, cols=cols, pk_cols=pk_cols) as w:
        for r in rows:
            w.add(tuple(r))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    args = ap.parse_args()
    load_year(args.season)
    print(f"\nDONE: {args.season} loaded into D1 canonical tables.", file=sys.stderr)


if __name__ == "__main__":
    main()
