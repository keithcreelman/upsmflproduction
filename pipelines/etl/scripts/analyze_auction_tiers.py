#!/usr/bin/env python3
"""Segment-level FA-auction analysis for the War Room tier study.

Computes, from the per-bid transactions_auction (FreeAgent only, 2019+):
  - $-bucket distribution of WINS ($1K / $2-4K / $5-9K / $10-17K / $18K+) per year
  - how LATE each bucket lands (% through that year's auction window)
  - the $4K (cap-free cut ceiling) analysis: who wins at $4K, and how often $4K
    was an opening/early proxy vs laddered
  - SF-era marquee wins ($18K+) joined to the player's MFL ADP AT auction time
    (overall + positional rank) — shows the marquee pool has been low-ADP QBs
  - per-year total FA spend + this year's league cap room (room to $300K)

Writes docs/auction/data/segments.json (the agents read this) + prints a summary.
Reads the in-repo archived DB by default (see build_auction_intel.resolve_db).
"""
from __future__ import annotations
import argparse, collections, datetime, json, sqlite3, sys, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "docs" / "auction" / "data" / "segments.json"
LEAGUE = "74598"
CAP_CEILING = 300000


def jget(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ups-worker", "Accept": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=30))


def bucket(k):
    if k <= 1: return "$1K"
    if k <= 4: return "$2-4K"
    if k <= 9: return "$5-9K"
    if k <= 17: return "$10-17K"
    return "$18K+"


def dparse(s):
    try: return datetime.date.fromisoformat(str(s)[:10])
    except Exception: return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="/tmp/ups_auction_canon.db")
    ap.add_argument("--no-adp", action="store_true", help="skip the MFL ADP join (network)")
    args = ap.parse_args()
    c = sqlite3.connect(args.db); c.row_factory = sqlite3.Row
    Q = "auction_type='FreeAgent' AND season>=2019"
    BUCKETS = ["$1K", "$2-4K", "$5-9K", "$10-17K", "$18K+"]

    wins = [dict(r) for r in c.execute(
        f"SELECT season,player_id,player_name,position,bid_amount,owner_name FROM transactions_auction WHERE {Q} AND finalbid_ind=1")]
    byyr = collections.defaultdict(list)
    for w in wins:
        w["d"] = dparse(w.get("date_et")) if "date_et" in w else None
        byyr[w["season"]].append(w)
    # date_et isn't in the SELECT above; re-pull dates
    dmap = {(r["season"], r["player_id"]): dparse(r["date_et"]) for r in c.execute(
        f"SELECT season,player_id,date_et FROM transactions_auction WHERE {Q} AND finalbid_ind=1")}
    for w in wins: w["d"] = dmap.get((w["season"], w["player_id"]))

    # ---- bucket distribution + day-position ----
    bucket_dist = {}
    pos_through = collections.defaultdict(list)   # bucket -> [% through window]
    spend_by_year = {}
    for yr in sorted(byyr):
        ws = byyr[yr]; n = len(ws)
        cc = collections.Counter(bucket(w["bid_amount"] / 1000) for w in ws)
        bucket_dist[yr] = {b: round(cc[b] / n, 3) for b in BUCKETS}
        spend_by_year[yr] = round(sum(w["bid_amount"] for w in ws))
        ds = [w["d"] for w in ws if w["d"]]
        if ds:
            start, end = min(ds), max(ds); span = max((end - start).days, 1)
            for w in ws:
                if w["d"]: pos_through[bucket(w["bid_amount"] / 1000)].append((w["d"] - start).days / span * 100)
    N = len(wins); allc = collections.Counter(bucket(w["bid_amount"] / 1000) for w in wins)
    bucket_dist["ALL"] = {b: round(allc[b] / N, 3) for b in BUCKETS}
    day_by_bucket = {b: {"n": len(v), "mean_pct_through": round(sum(v) / len(v), 1),
                         "last_third_share": round(sum(1 for x in v if x > 66) / len(v), 3)}
                     for b, v in pos_through.items() if v}

    # ---- $4K analysis ----
    lots = collections.defaultdict(list)
    for r in c.execute(f"""SELECT season,player_id,bid_sequence,bid_amount,finalbid_ind,forced_bid_ind,
        owner_name,franchise_forcing_owner_name,seconds_since_start FROM transactions_auction
        WHERE {Q} ORDER BY season,player_id,bid_sequence"""):
        lots[(r["season"], r["player_id"])].append(dict(r))
    end4k = open4k = 0; goto4k = collections.Counter(); opener = collections.Counter()
    for evs in lots.values():
        fin = [e for e in evs if e["finalbid_ind"]]
        if not fin or fin[0]["bid_amount"] / 1000 != 4: continue
        end4k += 1
        hit = [e for e in evs if e["bid_amount"] >= 4000]
        if not hit: continue
        h = hit[0]
        actor = h["franchise_forcing_owner_name"] if (h["forced_bid_ind"] and h["franchise_forcing_owner_name"]) else h["owner_name"]
        goto4k[actor] += 1
        early = (h["bid_sequence"] is not None and h["bid_sequence"] <= 2) or (h["seconds_since_start"] is not None and h["seconds_since_start"] <= 7200)
        if early: open4k += 1; opener[actor] += 1
    dollar4k = {"wins_at_4k": end4k, "opening_proxy_n": open4k,
                "opening_proxy_share": round(open4k / max(end4k, 1), 3),
                "by_owner": [{"owner": o, "wins": n, "opening_proxy": opener[o]} for o, n in goto4k.most_common(8)]}

    # ---- marquee ($18K+) ADP-at-auction join (SF era) ----
    marquee = []
    if not args.no_adp:
        mk = [w for w in wins if w["season"] >= 2022 and w["bid_amount"] >= 18000]
        adp_year = {}
        for yr in sorted(set(w["season"] for w in mk)):
            try:
                a = jget(f"https://api.myfantasyleague.com/{yr}/export?TYPE=adp&PERIOD=ALL&FCOUNT=12&IS_PPR=1&IS_KEEPER=0&JSON=1")
                pl = jget(f"https://www48.myfantasyleague.com/{yr}/export?TYPE=players&L={LEAGUE}&JSON=1")
                pos = {str(p["id"]): (p.get("position") or "").upper() for p in pl["players"]["player"]}
                rows = [(str(x["id"]), float(x["averagePick"]), int(x["rank"])) for x in a["adp"]["player"]]
                bypos = collections.defaultdict(list)
                for pid, apk, ovr in rows: bypos[pos.get(pid, "?")].append((apk, pid))
                prank = {}
                for p, lst in bypos.items():
                    lst.sort()
                    for i, (apk, pid) in enumerate(lst, 1): prank[pid] = i
                adp_year[yr] = {"ovr": {pid: ovr for pid, apk, ovr in rows}, "prank": prank, "pos": pos}
            except Exception as e:
                print(f"  (adp {yr} failed: {e})", file=sys.stderr)
        for w in sorted(mk, key=lambda x: -x["bid_amount"]):
            yr = w["season"]; pid = str(w["player_id"]); ay = adp_year.get(yr, {})
            pos = (w["position"] or ay.get("pos", {}).get(pid, "?"))
            marquee.append({"season": yr, "win_k": round(w["bid_amount"] / 1000), "player": w["player_name"],
                            "pos": pos, "ovr_adp": ay.get("ovr", {}).get(pid), "pos_adp": ay.get("prank", {}).get(pid),
                            "winner": w["owner_name"]})

    # ---- this year's league cap room (room to $300K) ----
    league_room = None
    try:
        st = jget(f"https://upsmflproduction.keith-creelman.workers.dev/api/mfl-league-state?L={LEAGUE}")
        committed = collections.defaultdict(int)
        p2f, p2c = st.get("pid_to_fid", {}), st.get("pid_to_contract", {})
        for pid, ct in p2c.items():
            committed[p2f.get(pid)] += (ct.get("salary") or 0)
        rooms = {f["id"]: CAP_CEILING - committed.get(f["id"], 0) for f in st.get("franchises", [])}
        league_room = {"total_room": sum(rooms.values()), "by_fid": rooms,
                       "n_teams": len(rooms), "ceiling": CAP_CEILING}
    except Exception as e:
        print(f"  (league room failed: {e})", file=sys.stderr)

    out = {"meta": {"scope": "FreeAgent auctions only, 2019-2025", "n_wins": N},
           "bucket_dist": bucket_dist, "day_by_bucket": day_by_bucket, "dollar4k": dollar4k,
           "marquee_adp": marquee, "spend_by_year": spend_by_year, "league_room_now": league_room}
    OUT.write_text(json.dumps(out, indent=2))
    print(f"wrote {OUT.relative_to(REPO)}", file=sys.stderr)
    print(json.dumps({"bucket_ALL": bucket_dist["ALL"], "day_by_bucket": day_by_bucket,
                      "dollar4k_top": dollar4k["by_owner"][:3], "spend_by_year": spend_by_year,
                      "total_room_now": (league_room or {}).get("total_room")}, indent=1))


if __name__ == "__main__":
    main()
