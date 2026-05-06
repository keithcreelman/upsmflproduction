#!/usr/bin/env python3
"""Build the 2011 player lineage table from MFL + forum data.

Sources:
  - data/mfl-historical/2011/auctionResults.json — initial dynasty auction wins
  - data/mfl-historical/2011/transactions.json   — all in-season + offseason events
  - data/mfl-historical/2011/rosters.json        — end-of-season roster + contract state
  - data/mfl-historical/2011/players.json        — player_id → name/position/team
  - data/mfl-historical/2011/league.json         — franchise_id → team name
  - services/rulebook/sources/rules/mfl_message_boards/manual/2011_messageboard.txt
      — forum cap-hit lists (Nov 6 mid-season + Jan 8 final)

Output: per-franchise lineage report with:
  - Auction wins (player + bid + initial contract length where parseable from forum)
  - In-season add/drop activity
  - Offseason cuts (with cap penalties)
  - End-of-season roster

Highlights weird items: trades w/ outliers, cap-hit-eligible cuts, dispersal teams,
playoff-period FA pickups that got force-unloaded post-Week 13.
"""
from __future__ import annotations
import json
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data" / "mfl-historical" / "2011"
FORUM = ROOT / "services/rulebook/sources/rules/mfl_message_boards/manual/2011_messageboard.txt"


def load_json(name):
    with open(DATA / name) as f:
        return json.load(f)


def main():
    league = load_json("league.json")["league"]
    auction = load_json("auctionResults.json")["auctionResults"]
    txn_doc = load_json("transactions.json")
    rosters = load_json("rosters.json")["rosters"]
    players_doc = load_json("players.json")["players"]

    # Build lookups
    franchises = {f["id"]: f["name"]
                  for f in league["franchises"]["franchise"]}
    players = {p["id"]: p for p in players_doc["player"]}

    def pname(pid):
        p = players.get(str(pid).zfill(4)) or players.get(str(pid))
        if not p: return f"<{pid}>"
        return f"{p.get('name','?')} ({p.get('position','?')} {p.get('team','?')})"

    # Auction wins by franchise
    auction_by_team = defaultdict(list)
    for a in auction["auctionUnit"]["auction"]:
        auction_by_team[a["franchise"]].append({
            "player_id": a["player"], "bid": int(a["winningBid"]),
            "ts": int(a["lastBidTime"]),
        })

    # Transactions — filter to valid 2011 only
    txns = txn_doc["transactions"]["transaction"]
    cutoff_low = int(datetime(2011, 8, 1).timestamp())
    cutoff_hi  = int(datetime(2012, 3, 1).timestamp())
    txns = [t for t in txns if t.get("franchise") and t.get("transaction")
            and cutoff_low <= int(t.get("timestamp", "0")) <= cutoff_hi]

    # End-of-season rosters (with current contract data per player)
    eos = {}
    for fr in rosters["franchise"]:
        plist = fr.get("player", [])
        if isinstance(plist, dict): plist = [plist]
        eos[fr["id"]] = plist

    # Forum cap-hit parser — extract per-team cut lists from Nov 6 + Jan 8 posts
    forum_text = FORUM.read_text()
    cuts = parse_cap_hit_cuts(forum_text)

    # ── Output
    print("=" * 86)
    print(" UPS DYNASTY 2011 — PER-FRANCHISE LINEAGE")
    print("=" * 86)
    print(f"League: {league['name']} (id={league['id']}, cap=${int(float(league['salaryCapAmount'])):,})")
    print(f"Roster size: {league['rosterSize']}, lastRegSeasonWeek: {league['lastRegularSeasonWeek']}")
    print(f"Total auctions: {len(auction['auctionUnit']['auction'])}")
    print(f"Total in-season + offseason transactions: {len(txns)}")
    print()

    # Identify dispersal teams (no LOAD_ROSTERS in offseason window)
    dec24 = int(datetime(2011, 12, 24, 23, 59, 59).timestamp())
    teams_with_postw16_action = {t["franchise"] for t in txns
                                  if int(t["timestamp"]) > dec24}
    dispersal_teams = set(franchises.keys()) - teams_with_postw16_action
    print(">>> DISPERSAL TEAMS (no post-Week-16 LOAD_ROSTERS — left league after 2011):")
    for fid in sorted(dispersal_teams):
        print(f"    f{fid}  {franchises[fid]}")
    print()

    # Per-franchise breakdown
    for fid in sorted(franchises):
        team = franchises[fid]
        is_disp = fid in dispersal_teams
        print(f"\n{'─'*86}")
        flag = " [DISPERSAL]" if is_disp else ""
        print(f" f{fid}  {team}{flag}")
        print('─' * 86)

        # Auction wins
        auc = sorted(auction_by_team.get(fid, []), key=lambda x: -x["bid"])
        spent = sum(a["bid"] for a in auc)
        print(f"\n AUCTION ({len(auc)} wins, spent ${spent:,}):")
        # Top 8 + bottom 3
        top = auc[:8]
        for a in top:
            dt = datetime.fromtimestamp(a["ts"]).strftime("%m/%d %H:%M")
            print(f"   ${a['bid']:>5,}  {pname(a['player_id'])}  ({dt})")
        if len(auc) > 11:
            print(f"   ... ({len(auc) - 11} more middle picks omitted)")
        for a in auc[-3:] if len(auc) > 11 else []:
            dt = datetime.fromtimestamp(a["ts"]).strftime("%m/%d %H:%M")
            print(f"   ${a['bid']:>5,}  {pname(a['player_id'])}  ({dt})")

        # Transaction summary
        team_txns = [t for t in txns if t["franchise"] == fid]
        type_counts = defaultdict(int)
        for t in team_txns:
            type_counts[t["type"]] += 1
        print(f"\n TRANSACTIONS: {len(team_txns)} total")
        for ttype, n in sorted(type_counts.items(), key=lambda x: -x[1]):
            print(f"   {ttype:32} {n}")

        # Forum cuts
        team_key = team_to_forum_key(team)
        forum_cuts = cuts.get(team_key, [])
        if forum_cuts:
            total_cap_hit = sum(c.get("cap_hit", 0) for c in forum_cuts)
            print(f"\n FORUM-DOCUMENTED CUTS (cap-hit-eligible): ${total_cap_hit:,}")
            for c in forum_cuts:
                print(f"   ${c.get('cap_hit', 0):>4,}  {c['player_text']}")
        else:
            print(f"\n FORUM CUTS: none documented (or no cap hit incurred)")

        # End-of-season roster size + sample
        eos_roster = eos.get(fid, [])
        print(f"\n END-OF-SEASON ROSTER: {len(eos_roster)} players")
        # Highest-paid 5
        eos_sorted = sorted(eos_roster, key=lambda p: -float(p.get("salary", 0) or 0))
        for p in eos_sorted[:5]:
            sal = int(float(p.get("salary", 0) or 0))
            cy = p.get("contractYear", "?")
            cs = p.get("contractStatus", "?")
            print(f"   ${sal:>5,}  CY{cy}/{cs}  {pname(p['id'])}")

    # WEIRD ITEMS section
    print(f"\n\n{'='*86}")
    print(" WEIRD ITEMS / FLAGS FOR REVIEW")
    print('='*86)
    flag_weird_items(auction, txns, franchises, players, dispersal_teams)


def team_to_forum_key(name):
    """Normalize forum team names (which vary in casing/abbreviation)."""
    n = name.lower().replace("'", "").replace(".", "")
    aliases = {
        "wetter than dutch dikes": "wtdd",
        "wetter than dutch dikes ": "wtdd",
        "d-town diddlers": "d-town",
        "the fat cat": "the fat cat",
        "pure greatness": "pure greatness",
        "btnh": "btnh",
        "murrays madmen": "murrays madmen",
        "r-11": "r-11",
        "bad newz kennels": "bad newz kennels",
        "c-town chivalry": "ctown",
        "blake bombers": "blake bombers",
        "the baster": "the baster",
        "white power": "white power",
    }
    return aliases.get(n, n)


def parse_cap_hit_cuts(text):
    """Parse the Jan 8 final cap-penalty post into per-team cut lists.

    Section header line 297-326: "CURRENT CAP PENALTIES FOR EACH ROSTER"
    Each team's line: 'Bad Newz Kennels - $16K Cut @ 20% = $3.2K (Brandon Pettigrew 2 yrs $8K per yr)'
    """
    out = defaultdict(list)
    pattern = re.compile(
        r"^([A-Za-z'\- ]+?)\s*[-–]\s*\$?(\d+)K?\s*[Cc]ut\s*@\s*\d+%\s*=\s*\$?([\d.]+)K?\s*\((.+)\)\s*$",
        re.MULTILINE,
    )
    for m in pattern.finditer(text):
        team_raw = m.group(1).strip().lower().replace("'", "")
        # gross_cut_k = int(m.group(2))   # gross cut amount (in K)
        cap_hit_k = float(m.group(3))     # cap hit (in K)
        players_blob = m.group(4)
        for player_text in re.split(r",\s*", players_blob):
            out[team_to_forum_key(team_raw)].append({
                "cap_hit": int(cap_hit_k * 1000),
                "player_text": player_text.strip(),
            })
    return out


def flag_weird_items(auction, txns, franchises, players, dispersal_teams):
    flags = []
    bids = sorted(auction["auctionUnit"]["auction"],
                  key=lambda a: -int(a["winningBid"]))

    # Top 10 highest bids
    flags.append("Top 10 highest auction bids:")
    for a in bids[:10]:
        team = franchises.get(a["franchise"], "?")
        p = players.get(a["player"], {})
        flags.append(f"  ${int(a['winningBid']):>5,}  {p.get('name','?')} ({p.get('position','?')}) → {team}")

    # Bottom 10 ($1K) bids — fillers
    flags.append("\n$1,000 auction wins (cap-conserving picks): " +
                 str(sum(1 for a in bids if int(a['winningBid']) == 1000)))

    # Trades involving draft picks (proxy for dispersal-related deals)
    trade_txns = [t for t in txns if t["type"] == "TRADE"]
    flags.append(f"\nTrade transactions: {len(trade_txns)}")
    for t in trade_txns[:10]:
        dt = datetime.fromtimestamp(int(t["timestamp"])).strftime("%Y-%m-%d %H:%M")
        team = franchises.get(t["franchise"], "?")
        flags.append(f"  {dt}  {team}: {t.get('transaction','')[:100]}")

    # All post-Week-16 transactions (already identified as the 8 LOAD_ROSTERS)
    dec24 = int(datetime(2011, 12, 24, 23, 59, 59).timestamp())
    post16 = sorted([t for t in txns if int(t["timestamp"]) > dec24],
                    key=lambda t: int(t["timestamp"]))
    flags.append(f"\nPOST-WEEK-16 EVENTS ({len(post16)}):")
    for t in post16:
        dt = datetime.fromtimestamp(int(t["timestamp"])).strftime("%Y-%m-%d %H:%M")
        team = franchises.get(t["franchise"], "?")
        pids = (t.get("transaction", "") or "").strip("|").split(",")
        pids = [p for p in pids if p]
        names = [players.get(pid, {}).get("name", f"<{pid}>") for pid in pids]
        flags.append(f"  {dt}  f{t['franchise']} {team}: {t['type']} → {', '.join(names)}")

    # Disparity in auction spend
    spent_by_team = defaultdict(int)
    for a in auction["auctionUnit"]["auction"]:
        spent_by_team[a["franchise"]] += int(a["winningBid"])
    flags.append(f"\nAUCTION SPEND BY TEAM:")
    for fid, total in sorted(spent_by_team.items(), key=lambda x: -x[1]):
        disp = "  [DISPERSAL]" if fid in dispersal_teams else ""
        flags.append(f"  ${total:>7,}  f{fid} {franchises[fid]}{disp}")

    print("\n".join(flags))


if __name__ == "__main__":
    main()
