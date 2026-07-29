"""Merge O=102 (spine) with the AUCTION_* transaction log (detail) -> D1 SQL.

O=102 is the SPINE because it's the only source covering 2012-2013 and it
uniquely carries the winner's PROXY bid. The transaction log supplies what
O=102 can't: the opening bid, the runner-up, bid counts, and exact unix
timestamps (2014+ for bids, 2019+ for nominations).

Per-field provenance:
  winning_bid, proxy_bid, winner_fid  -> O=102 (all seasons)
  started_at_unix                     -> tx log if available, else O=102
                                         (2016's O=102 start is epoch-0 junk)
  last_bid_at_unix                    -> tx log WON ts if available, else O=102
  opening_bid, runner_up_fid,
  total_bids, distinct_bidders,
  lead_changes                        -> tx log ONLY (2014+; NULL for 2012-13)
"""
import collections
import datetime
import json
import os
import re
import sys

SP = os.path.dirname(os.path.abspath(__file__))
TXCACHE = os.path.join(SP, "auction_cache")
TEST_FROM, TEST_TO = 1782921600, 1784995200

o102 = json.load(open(os.path.join(SP, "o102_parsed.json")))
print(f"o102 rows: {len(o102)}", file=sys.stderr)


def txload(season, t):
    p = os.path.join(TXCACHE, f"{season}_{t}.json")
    return json.load(open(p)) if os.path.exists(p) else []


def month(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).month


# (season, pid) -> O=102's own reported auction start, when MFL gave us a
# real one (not the 2016 epoch-0 sentinel, already filtered out by parse_dt).
o102_start_by_pid = {}
for r in o102:
    if r["started_unix"]:
        o102_start_by_pid[(r["season"], r["player_id"])] = r["started_unix"]


def parse_tx(tx, kind):
    parts = str(tx.get("transaction") or "").split("|")
    try:
        price = int(parts[1]) if len(parts) > 1 and parts[1].strip() else 0
    except ValueError:
        price = 0
    return {"pid": parts[0].strip() if parts else "", "price": price,
            "fid": str(tx.get("franchise") or "").zfill(4),
            "ts": int(tx.get("timestamp") or 0), "kind": kind}


# ── build tx-log cycles keyed (season, pid) -> list of cycle dicts ─────────
cycles = collections.defaultdict(list)
for season in range(2012, 2027):
    evs_by_pid = collections.defaultdict(list)
    for t, k in (("AUCTION_INIT", "init"), ("AUCTION_BID", "bid")):
        for raw in txload(season, t):
            e = parse_tx(raw, k)
            if e["pid"] and e["ts"]:
                evs_by_pid[e["pid"]].append(e)
    wins_by_pid = collections.defaultdict(list)
    for raw in txload(season, "AUCTION_WON"):
        e = parse_tx(raw, "won")
        if e["pid"] and e["ts"]:
            wins_by_pid[e["pid"]].append(e)

    for pid, wl in wins_by_pid.items():
        evs = sorted(evs_by_pid.get(pid, []), key=lambda r: r["ts"])
        prev = 0
        o102_floor = o102_start_by_pid.get((season, pid))
        for w in sorted(wl, key=lambda r: r["ts"]):
            end = w["ts"]
            # ── CYCLE SCOPING (load-bearing; this bug has bitten three times) ──
            # A player can be nominated in the May ERA *and* the Jul/Aug FAA in
            # the same season. Scoping only on "after the previous win" lets a
            # May ERA nomination anchor a July FAA win -> Derrick Henry 2024
            # reported as a 1,835-hour (76-day) auction. Restrict the cycle to
            # the month window matching THIS win's auction kind.
            emo = month(end)
            win_months = (7, 8, 9) if emo >= 7 else (5, 6)
            # Even within the same month window, an abandoned/orphaned bid
            # cluster can sit in MFL's append-only log ahead of the real
            # auction, with no win to show it was abandoned -> DeAndre Levy
            # 2015 had an orphaned $5,000 bid on Aug 8 that never led anywhere,
            # 4 days before the real Aug 12-14 bidding war that won him,
            # reported as a 145.6h auction instead of the real ~29h. Trust
            # O=102's OWN reported start as the floor when MFL gave us a valid
            # one for this (season, pid) and it falls inside this win's cycle
            # -- MFL's own report already excludes cruft like this. Buffer 90s
            # for O=102's minute-only precision vs. the tx log's exact second.
            floor = prev
            if o102_floor and prev < o102_floor <= end:
                floor = max(prev, o102_floor - 90)
            cyc = [e for e in evs
                   if floor < e["ts"] <= end and month(e["ts"]) in win_months]
            inits = [e for e in cyc if e["kind"] == "init"]
            bids = [e for e in cyc if e["kind"] == "bid"]
            holders = ([inits[0]["fid"]] if inits else []) + [b["fid"] for b in bids]
            holders = [h for h in holders if h]
            # runner-up = the last franchise other than the winner to hold the lead
            runner = None
            for h in reversed(holders):
                if h != w["fid"]:
                    runner = h
                    break
            # opening bid: the nomination price. 2019+ the INIT carries it;
            # 2014-18 the first AUCTION_BID *is* the $1k nomination.
            opening = inits[0]["price"] if inits else (bids[0]["price"] if bids else None)
            cycles[(season, pid)].append({
                "won_ts": end, "winner_fid": w["fid"], "price": w["price"],
                "start_ts": (cyc[0]["ts"] if cyc else None),
                "opening_bid": opening, "runner_up_fid": runner,
                "total_bids": ((1 if inits else 0) + len(bids)) or None,
                "distinct_bidders": (len(set(holders)) or None),
                "lead_changes": sum(1 for a, b in zip(holders, holders[1:]) if a != b),
                "used": False,
            })
            prev = end

print(f"tx cycles: {sum(len(v) for v in cycles.values())}", file=sys.stderr)


def esc(v):
    if v is None or v == "":
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"


def num(v):
    return "NULL" if v in (None, "") else str(int(v))


rows_sql = []
stats = collections.Counter()
for r in o102:
    season, pid = r["season"], r["player_id"]
    # pick the tx cycle whose WON time is closest to O=102's last-bid time
    best = None
    cand = [c for c in cycles.get((season, pid), []) if not c["used"]]
    if cand:
        if r["last_bid_unix"]:
            best = min(cand, key=lambda c: abs(c["won_ts"] - r["last_bid_unix"]))
        else:
            best = cand[0]
        best["used"] = True

    start = (best["start_ts"] if best and best["start_ts"] else r["started_unix"])
    end = (best["won_ts"] if best else r["last_bid_unix"])
    if not end:
        stats["skipped_no_end"] += 1
        continue
    # ERA (May/Jun) vs FAA (Jul/Aug) — classify on the close
    mo = datetime.datetime.fromtimestamp(end, datetime.UTC).month
    kind = "ERA" if mo <= 6 else "FAA"
    is_test = 1 if (season == 2026 and TEST_FROM <= end < TEST_TO) else 0
    dur = round((end - start) / 3600.0, 2) if (start and end and end >= start) else None

    src = "o102+txlog" if best else "o102"
    stats[src] += 1
    stats[f"kind_{kind}"] += 1

    rows_sql.append(
        "(" + ",".join([
            str(season), esc(r["league_id"]), esc(pid), num(end),
            esc(r["player_label"]), esc(r["position"]),
            num(r["winning_bid"]), num(r["proxy_bid"]),
            num(best["opening_bid"] if best else None),
            esc(r["winner_fid"]), esc(r["winner_team_label"]),
            esc(best["runner_up_fid"] if best else None),
            num(start),
            "NULL" if dur is None else str(dur),
            num(best["total_bids"] if best else None),
            num(best["distinct_bidders"] if best else None),
            num(best["lead_changes"] if best else None),
            esc(kind), str(is_test), esc(src),
        ]) + ")"
    )

print(f"rows to insert: {len(rows_sql)}", file=sys.stderr)
for k, v in sorted(stats.items()):
    print(f"  {k}: {v}", file=sys.stderr)

DDL = """
CREATE TABLE IF NOT EXISTS ups_auction_history (
  season             INTEGER NOT NULL,
  league_id          TEXT    NOT NULL,
  player_id          TEXT    NOT NULL,
  won_at_unix        INTEGER NOT NULL,
  player_label       TEXT,
  position           TEXT,
  winning_bid        INTEGER,
  proxy_bid          INTEGER,
  opening_bid        INTEGER,
  winner_fid         TEXT,
  winner_team_label  TEXT,
  runner_up_fid      TEXT,
  started_at_unix    INTEGER,
  duration_hours     REAL,
  total_bids         INTEGER,
  distinct_bidders   INTEGER,
  lead_changes       INTEGER,
  auction_kind       TEXT,
  is_test            INTEGER NOT NULL DEFAULT 0,
  source             TEXT,
  created_at_utc     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season, league_id, player_id, won_at_unix)
);
CREATE INDEX IF NOT EXISTS idx_auction_hist_season ON ups_auction_history(season, auction_kind);
CREATE INDEX IF NOT EXISTS idx_auction_hist_winner ON ups_auction_history(season, winner_fid);
CREATE INDEX IF NOT EXISTS idx_auction_hist_dur ON ups_auction_history(duration_hours);
"""

COLS = ("season,league_id,player_id,won_at_unix,player_label,position,winning_bid,"
        "proxy_bid,opening_bid,winner_fid,winner_team_label,runner_up_fid,"
        "started_at_unix,duration_hours,total_bids,distinct_bidders,lead_changes,"
        "auction_kind,is_test,source")

out = [DDL, "DELETE FROM ups_auction_history;"]
B = 100
for i in range(0, len(rows_sql), B):
    out.append(f"INSERT OR REPLACE INTO ups_auction_history ({COLS}) VALUES\n"
               + ",\n".join(rows_sql[i:i + B]) + ";")

open(os.path.join(SP, "load_auction_history.sql"), "w").write("\n".join(out) + "\n")
print("wrote load_auction_history.sql", file=sys.stderr)
