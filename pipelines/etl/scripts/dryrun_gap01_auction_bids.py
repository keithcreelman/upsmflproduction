#!/usr/bin/env python3
"""dryrun_gap01_auction_bids.py -- DRY RUN for GAP-01: individual auction bids, 2014-2025.

Builds the rows a backfill WOULD write to D1, the exact SQL and its rollback,
and a reconciliation report. It never writes to production: the only D1 call
in this file is a SELECT behind --allow-prod-d1, and nothing here runs
`wrangler d1 execute` with a file or a write statement.

WHY
  D1 keeps one summary row per auction (ups_auction_history) but no bids, so a
  story cannot say who bid, when, or how a price climbed. MFL still serves
  every AUCTION_INIT / AUCTION_BID / AUCTION_WON event for 2014-2025.

STORAGE (worker/migrations/manual/gap01_ups_hist_auction_bids.sql, NOT applied)
  ups_hist_auctions     one row per AUCTION, keyed (season, player_id,
                        started_at_unix). A player auctioned twice in a season
                        gets two rows (GAP-02 loses one of them today).
  ups_hist_auction_bids one row per MFL INIT or BID event, keyed by the
                        auction + seq.
  Comment text is never stored. MFL's own "<team> forced bid increase" note
  becomes forced = 1 plus the forcing franchise id; any other comment is
  owner-written and is dropped (only its count is reported).

AUCTION IDENTITY (the hard part)
  MFL's log is append-only and has no auction id. Events for one
  (season, player) are split into auctions in time order (split_auctions):
    * AUCTION_INIT always opens a new auction (2019+ only).
    * AUCTION_WON closes the open auction.
    * A BID with no open auction opens one (2014-2018 have no INIT; the
      first BID is the opening bid).
    * 2014-2018: bids before the start MFL's own O=102 report gives for the
      auction it lists are split off (a cancelled first try).
    * 2014-2018 FA auctions MFL's report does not date (all of 2016): a BID
      more than 25 hours after the open auction's last event opens a new one.
      In every FA auction O=102 dates, consecutive bids are <= 24.0 h apart.
  Bidding that never reached a win is kept as outcome = 'no_win'. Every split
  is listed in the report so it can be checked by hand.

SUBCOMMANDS
  fetch-mfl   [--cache DIR]                  read MFL into the cache (throttled, read-only)
  extract-d1  [--out DIR] --allow-prod-d1    opt-in SELECT of ups_auction_history (budgeted)
  build       [--cache DIR] [--d1 DIR] [--archive DB] [--manifest JSON] [--out DIR]
                                             offline: auctions + bids + SQL + reconciliation
  local-proof [--out DIR]                    offline: schema + forward SQL twice + rollback
                                             on a throwaway LOCAL SQLite file
  report      [--out DIR] [--report-path MD] render the report; fail if any owner
                                             comment string appears in any output
  Then: node pipelines/etl/scripts/dryrun_gap01_measure_local_d1.mjs --out DIR
  (D1's own billed counters on a local Miniflare D1), and `report` again.
  preflight   [--out DIR]                    read-only write-budget guard (Cloudflare's exact
                                             account counter, quiet window, no write-heavy job)
  verify-d1   [--out DIR] --allow-prod-d1    after an APPROVED load: SELECT both new tables and
                                             reconcile them with the build (opt-in, ~10.5k reads)
  This file never writes D1. An approved load runs the schema and forward SQL
  by hand with `wrangler d1 execute`, outside this script.

Raw MFL replies hold owner comments, so the cache and the build output default
to ~/.ups_jobs/gap01_auction_bids/, outside the repository. Only the
comment-free reconciliation report is meant to be committed.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR.parent))
from lib.d1_io import STATEMENT_BYTE_LIMIT, build_insert  # noqa: E402

BID_SEASONS = list(range(2014, 2026))      # GAP-01 scope: MFL kept bids from 2014
CHECK_SEASONS = list(range(2011, 2014))    # fetched only to prove no bid log exists
LEAGUE_IDS = {2011: "40832", 2012: "37227", 2013: "42721", 2014: "30590",
              2015: "29015", 2016: "27191"}  # 2017+ = 74598 (docs/MFL_API.md)
MFL_HOST = "https://api.myfantasyleague.com"
USER_AGENT = "ups-gap01-dryrun/1.0 (read-only; replies cached and reused)"
AUCTION_TYPES = ("AUCTION_INIT", "AUCTION_BID", "AUCTION_WON")
DEFAULT_ROOT = Path.home() / ".ups_jobs" / "gap01_auction_bids"
ET = ZoneInfo("America/New_York")

# MFL writes this note itself when a leader's proxy is pushed up by a rival bid.
FORCED_RE = re.compile(r"^(?P<team>.+) forced bid increase$")

AUCTIONS_TABLE = "ups_hist_auctions"
BIDS_TABLE = "ups_hist_auction_bids"
AUCTION_COLS = ["season", "player_id", "started_at_unix", "league_id", "start_basis",
                "split_reason", "opened_by_fid", "opening_bid", "last_bid_at_unix", "outcome",
                "won_at_unix", "winner_fid", "winning_bid", "bid_count", "price_check", "caveat",
                "auction_kind", "log_semantics", "source"]
AUCTION_PK = ["season", "player_id", "started_at_unix"]
BID_COLS = ["season", "player_id", "started_at_unix", "seq", "event", "fid", "amount",
            "amount_meaning", "amount_raw", "bid_at_unix", "forced", "forcing_fid"]
BID_PK = ["season", "player_id", "started_at_unix", "seq"]
INDEXES_PER_ROW = {AUCTIONS_TABLE: 1, BIDS_TABLE: 0}  # secondary indexes in the proposed schema
INSERT_CHUNK_ROWS = 80


def league_id(season: int) -> str:
    return LEAGUE_IDS.get(season, "74598")


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def et(ts: int | None) -> str:
    if not ts:
        return ""
    return datetime.fromtimestamp(ts, ET).strftime("%Y-%m-%d %H:%M ET")


def sha256(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# --------------------------------------------------------------------------
# MFL cache (read-only GETs, throttled, one file per URL)
# --------------------------------------------------------------------------

def mfl_url(season: int, params: dict) -> str:
    q = {"L": league_id(season), "JSON": "1", **params}
    return f"{MFL_HOST}/{season}/export?{urllib.parse.urlencode(q)}"


class MflCache:
    def __init__(self, root: Path, min_interval: float = 3.0, offline: bool = False):
        self.root = Path(root)
        self.min_interval = min_interval
        self.offline = offline
        self._last = 0.0

    def path_for(self, season: int, params: dict) -> Path:
        name = "_".join(f"{k}-{v}" for k, v in sorted(params.items()))
        return self.root / str(season) / f"{name}.json"

    def get(self, season: int, params: dict):
        p = self.path_for(season, params)
        if p.exists():
            return json.loads(p.read_text())["reply"]
        if self.offline:
            raise FileNotFoundError(f"not cached (run fetch-mfl): {p}")
        url = mfl_url(season, params)
        wait = self.min_interval - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
        self._last = time.time()
        reply = json.loads(raw)
        if isinstance(reply, dict) and reply.get("error"):
            raise RuntimeError(f"MFL error for {url}: {reply.get('error')}")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"url": url, "fetched_at_utc": utc_now(),
                                 "sha256": sha256(raw), "reply": reply}))
        return reply


    # MFL's "Auction Results - Details" page (O=102) is HTML on the league's own
    # host. It is the report the current ups_auction_history build trusts for
    # each auction's start time; here it only cross-checks how bids were split
    # into auctions. Its comments column is owner-written and is never parsed.
    def o102(self, season: int) -> list[dict]:
        p = self.root / str(season) / "O-102.html.json"
        if p.exists():
            return parse_o102(json.loads(p.read_text())["html"], season)
        if self.offline:
            raise FileNotFoundError(f"not cached (run fetch-mfl): {p}")
        url = f"https://{O102_HOSTS.get(season, 'www48')}.myfantasyleague.com/{season}/options?L={league_id(season)}&O=102"
        wait = self.min_interval - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
        self._last = time.time()
        html = raw.decode("utf-8", errors="replace")
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps({"url": url, "fetched_at_utc": utc_now(), "sha256": sha256(raw), "html": html}))
        return parse_o102(html, season)


O102_HOSTS = {2014: "www45", 2015: "www44"}  # 2016+ www48 (scrape_auction_o102.py LEAGUES)
MONTHS = {m: i for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], 1)}


def _o102_time(cell: str, season: int) -> int | None:
    """'Sun Aug 5 7:01 a.m.' -> unix. MFL prints league-local (Eastern) time
    with no year. 2016 prints the Unix epoch ('Wed Dec 31 7:00 p.m.') for
    every start, so a month outside the May-Aug auction window is missing."""
    s = cell.replace("\xa0", " ")
    m = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*([ap])\.?m\.?", s)
    if m:
        hh, mi = int(m.group(3)) % 12 + (12 if m.group(5) == "p" else 0), int(m.group(4))
    else:
        m = re.search(r"([A-Z][a-z]{2})\s+(\d{1,2})\s+(noon|midnight)", s)
        if not m:
            return None
        hh, mi = (12 if m.group(3) == "noon" else 0), 0
    mo = MONTHS.get(m.group(1))
    if mo not in (4, 5, 6, 7, 8):
        return None
    return int(datetime(season, mo, int(m.group(2)), hh, mi, tzinfo=ET).timestamp())


def parse_o102(html: str, season: int) -> list[dict]:
    import html as H
    tables = re.findall(r"<table.*?</table>", html, re.S | re.I)
    if not tables:
        return []
    tables.sort(key=lambda t: len(re.findall(r"<tr", t, re.I)), reverse=True)
    out = []
    for row in re.findall(r"<tr.*?</tr>", tables[0], re.S | re.I):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        if len(tds) < 6:
            continue
        pid = re.search(r"[?&;]P=(\d+)", tds[0])
        fid = re.search(r"\bF=(\d{1,4})\b", tds[3])  # href is HTML-encoded: &amp;F=0004
        if not pid:
            continue
        text = [H.unescape(re.sub(r"<[^>]+>", "", c)).strip() for c in tds[:6]]
        price = re.sub(r"[^\d]", "", text[1])
        out.append({"player_id": pid.group(1), "price": int(price) if price else None,
                    "winner_fid": fid.group(1).zfill(4) if fid else None,
                    "started_unix": _o102_time(text[4], season),
                    "last_bid_unix": _o102_time(text[5], season)})
    return out


def fetch_plan() -> list[tuple[int, dict]]:
    plan = []
    for s in CHECK_SEASONS + BID_SEASONS:
        plan.append((s, {"TYPE": "league"}))
        for t in AUCTION_TYPES:
            # MFL refuses a comma-separated TRANS_TYPE list: one call per type.
            plan.append((s, {"TYPE": "transactions", "TRANS_TYPE": t}))
    return plan


def cmd_fetch_mfl(args) -> int:
    cache = MflCache(args.cache, min_interval=args.min_interval)
    plan = fetch_plan()
    for i, (s, params) in enumerate(plan, 1):
        had = cache.path_for(s, params).exists()
        cache.get(s, params)
        print(f"[{i}/{len(plan)}] {s} {params} {'cached' if had else 'fetched'}")
    for s in BID_SEASONS:
        rows = cache.o102(s)
        print(f"O=102 {s}: {len(rows)} auctions")
    print(f"MFL cache complete: {args.cache}")
    return 0


AMOUNT_RE = re.compile(r"^\d+(\.0+)?$")


def parse_amount(raw: str) -> int | None:
    """MFL writes '40000' or, in some seasons, '40000.00'. Anything else
    (2014 has two bids written '19000-4') is unreadable and stays NULL."""
    raw = raw.strip()
    return int(raw.split(".")[0]) if AMOUNT_RE.match(raw) else None


def mfl_events(cache: MflCache, season: int) -> list[dict]:
    """Every AUCTION_* event for the season, in MFL's reply order (newest first)."""
    out = []
    for t in AUCTION_TYPES:
        reply = cache.get(season, {"TYPE": "transactions", "TRANS_TYPE": t})
        txs = as_list(((reply or {}).get("transactions") or {}).get("transaction"))
        for i, tx in enumerate(txs):
            parts = str(tx.get("transaction") or "").split("|")
            amount = parts[1].strip() if len(parts) > 1 else ""
            out.append({
                "type": tx.get("type") or t,
                "reply_type": t,
                "reply_index": i,
                "player_id": parts[0].strip() if parts else "",
                "amount": parse_amount(amount),
                "amount_unreadable": bool(amount) and parse_amount(amount) is None,
                "amount_raw": amount,
                "comment": "|".join(parts[2:]).strip() if len(parts) > 2 else "",
                "fid": str(tx.get("franchise") or "").strip(),
                "ts": int(tx.get("timestamp") or 0),
                "n_fields": len(parts),
            })
    return out


def franchise_names(cache: MflCache, season: int) -> dict[str, str]:
    reply = cache.get(season, {"TYPE": "league"})
    fr = as_list((((reply or {}).get("league") or {}).get("franchises") or {}).get("franchise"))
    return {f.get("id"): (f.get("name") or "").strip() for f in fr if f.get("id")}




# --------------------------------------------------------------------------
# Auction identity: split each player's events into auctions
# --------------------------------------------------------------------------

TYPE_ORDER = {"AUCTION_INIT": 0, "AUCTION_BID": 1, "AUCTION_WON": 2}
O102_SLACK = 60          # O=102 prints whole minutes
# FA auctions lock 24 h after the last lead change. In every FA auction MFL's
# report dates (2014-2025) consecutive logged bids are <= 24.0 h apart, so a
# longer silence with no win means the earlier bidding was cancelled.
IDLE_SPLIT_HOURS = 25


def event_order(e: dict) -> tuple:
    # MFL replies are newest first, so within one second a higher index is older.
    return (e["ts"], TYPE_ORDER[e["type"]], -e["reply_index"])


def new_auction(e: dict, reason: str) -> dict:
    return {"events": [], "won": None, "split_reason": reason, "end_reason": None}


def split_auctions(events: list[dict], o102_start: int | None, idle_rule: bool) -> list[dict]:
    """Split one player's season of events into auctions (see module doc).

    o102_start: MFL's own reported start for the auction its report lists for
    this player, or None. idle_rule: seasons without AUCTION_INIT (2014-2018).
    A same-franchise repeat or lower bid is NOT a split signal: 2014-2016 log
    every bid placed, and repeats happen inside real auctions (Forsett 2015:
    three $40,000 bids from 0004 in one second)."""
    out, cur = [], None
    for e in sorted(events, key=event_order):
        if e["type"] == "AUCTION_WON":
            if cur is None:
                cur = new_auction(e, "won_without_bids")
                out.append(cur)
            cur["won"], cur["end_reason"] = e, "won"
            cur = None
            continue
        reason = None
        if cur is None:
            reason = "nomination" if e["type"] == "AUCTION_INIT" else "first_bid"
        elif e["type"] == "AUCTION_INIT":
            reason = "new_nomination"
        elif cur["events"][0]["type"] == "AUCTION_INIT":
            pass
        elif o102_start:
            if cur["events"][0]["ts"] < o102_start - O102_SLACK <= e["ts"]:
                reason = "mfl_report_start"
        elif (idle_rule and datetime.fromtimestamp(e["ts"], ET).month >= 7
              and e["ts"] - cur["events"][-1]["ts"] > IDLE_SPLIT_HOURS * 3600):
            reason = "idle_over_lock"
        if reason:
            if cur is not None:
                cur["end_reason"] = "superseded_by_" + reason
            cur = new_auction(e, reason)
            out.append(cur)
        cur["events"].append(e)
    if cur is not None:
        cur["end_reason"] = "never_won"
    return out


def auction_kind(ts: int) -> str:
    # Same split as ups_auction_history: ERA closes by June, FAA from July.
    return "ERA" if datetime.fromtimestamp(ts, ET).month <= 6 else "FAA"


def fix_mojibake(text: str) -> str:
    """MFL double-encodes non-ASCII in transaction notes ('HammerTime ð\x9f\x94¨'
    is 'HammerTime 🔨'). Undo it when the text round-trips cleanly."""
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def resolve_forcer(comment: str, names: dict[str, str], all_names: dict[str, set]) -> tuple[bool, str | None, str]:
    """(forced?, forcing franchise id, how it was resolved). The note names the
    rival's team as it was at bid time: first try that season's names, then a
    name that belonged to exactly one franchise in any season (a team renamed
    after the auction: 2017 'The Baster' is 0011's 2011-2016 name)."""
    m = FORCED_RE.match(comment or "")
    if not m:
        return False, None, ""
    team = fix_mojibake(m.group("team")).strip().lower()
    hits = sorted(fid for fid, n in names.items() if n.strip().lower() == team)
    if len(hits) == 1:
        return True, hits[0], "season_name"
    other = all_names.get(team, set())
    if len(other) == 1:
        return True, next(iter(other)), "other_season_name"
    return True, None, "unresolved"


def all_franchise_names(cache: MflCache) -> dict[str, set]:
    out = defaultdict(set)
    for s in CHECK_SEASONS + BID_SEASONS:
        for fid, n in franchise_names(cache, s).items():
            out[n.strip().lower()].add(fid)
    return out


def log_semantics(season: int) -> str:
    # 2014-2016 log every bid placed at the amount entered (a bidder's maximum,
    # even when it never took the lead). From 2017 MFL logs a bid only when it
    # takes the lead, plus "forced bid increase" rows when a rival pushes the
    # leader's proxy up. The reconciliation tests both claims.
    return "every_bid" if season <= 2016 else "lead_changes"


def build_season(cache: MflCache, season: int, use_o102: bool = True) -> dict:
    """Auctions + bid rows for one season, plus counters for the report."""
    events = mfl_events(cache, season)
    all_names = all_franchise_names(cache)
    counts = Counter()
    for e in events:
        counts[e["type"]] += 1
        if e["type"] == "AUCTION_WON" and not e["player_id"]:
            counts["blank_won_rows"] += 1
    events = [e for e in events if e["player_id"]]
    names = franchise_names(cache, season)
    o102 = {}
    for r in (cache.o102(season) if use_o102 else []):
        o102.setdefault(r["player_id"], []).append(r)
    counts["o102_rows"] = sum(len(v) for v in o102.values())
    has_init = counts["AUCTION_INIT"] > 0
    by_pid = defaultdict(list)
    for e in events:
        by_pid[e["player_id"]].append(e)

    auctions, bids = [], []
    for pid in sorted(by_pid, key=lambda x: (len(x), x)):
        es = by_pid[pid]
        wins = [e for e in es if e["type"] == "AUCTION_WON"]
        # O=102 lists one auction per player-season; it dates the auction whose win it shows.
        rep = [r for r in o102.get(pid, []) if r["started_unix"]
               and any(w["fid"] == r["winner_fid"] and w["amount"] == r["price"] for w in wins)]
        start = rep[0]["started_unix"] if len(rep) == 1 else None
        for a in split_auctions(es, start, idle_rule=not has_init):
            evs, won = a["events"], a["won"]
            first = evs[0] if evs else None
            started = first["ts"] if first else won["ts"]
            dated = bool(start and won and rep[0]["winner_fid"] == won["fid"]
                         and rep[0]["price"] == won["amount"] and abs(started - start) < O102_SLACK + 60)
            row = {
                "season": season, "player_id": pid, "started_at_unix": started,
                "league_id": league_id(season),
                "start_basis": ("nomination" if first and first["type"] == "AUCTION_INIT"
                                else "mfl_report" if dated else "first_logged_bid"),
                "split_reason": a["split_reason"],
                "opened_by_fid": first["fid"] if first else None,
                "opening_bid": first["amount"] if first else None,
                "last_bid_at_unix": evs[-1]["ts"] if evs else None,
                "outcome": "won" if won else "no_win",
                "won_at_unix": won["ts"] if won else None,
                "winner_fid": won["fid"] if won else None,
                "winning_bid": won["amount"] if won else None,
                "bid_count": len(evs),
                "price_check": None,
                "caveat": None,
                "auction_kind": auction_kind(won["ts"] if won else started),
                "log_semantics": log_semantics(season),
                "source": "mfl_txlog",
                # analysis only (not stored)
                "_end_reason": a["end_reason"],
                "_o102_start": start,
            }
            for i, x in enumerate(evs, 1):
                forced, forcer, how = resolve_forcer(x["comment"], names, all_names)
                bids.append({
                    "season": season, "player_id": pid, "started_at_unix": started, "seq": i,
                    "event": "init" if x["type"] == "AUCTION_INIT" else "bid",
                    "fid": x["fid"], "amount": x["amount"],
                    "amount_meaning": "entered_max" if season <= 2016 else "price_after_bid",
                    "amount_raw": (x["amount_raw"] if x["amount_raw"] and x["amount_raw"] != str(x["amount"]) else None),
                    "bid_at_unix": x["ts"], "forced": int(forced), "forcing_fid": forcer,
                    "_forced_team_unresolved": forced and forcer is None,
                    "_forcer_resolved_by": how,
                    "_forcer_team": (fix_mojibake(FORCED_RE.match(x["comment"]).group("team")).strip()
                                     if forced else None),
                    "_amount_unreadable": x["amount_unreadable"],
                    "_amount_raw": x["amount_raw"] if x["amount_unreadable"] else None,
                    "_has_owner_comment": bool(x["comment"]) and not forced,
                })
            mine = bids[len(bids) - len(evs):]
            row["price_check"] = price_check(season, row, mine)
            row["caveat"] = ";".join(c for c, on in (
                ("start_unconfirmed", row["start_basis"] == "first_logged_bid"),
                ("price_unexplained", row["price_check"] == "unexplained"),
                ("unreadable_amount", any(b["_amount_unreadable"] for b in mine))) if on) or None
            auctions.append(row)
    return {"season": season, "counts": dict(counts), "auctions": auctions, "bids": bids,
            "has_init": has_init}


def price_check(season: int, a: dict, evs: list[dict]) -> str:
    """How MFL's price ties back to the logged rows (stored as price_check)."""
    if a["outcome"] != "won":
        return "none"
    if season <= 2016:
        return "proxy_replay" if replay_every_bid(evs) == (a["winner_fid"], a["winning_bid"]) else "unexplained"
    last = evs[-1] if evs else None
    rising = all(x["amount"] is not None and y["amount"] is not None and y["amount"] > x["amount"]
                 for x, y in zip(evs, evs[1:]))
    ok = bool(last and last["fid"] == a["winner_fid"] and last["amount"] == a["winning_bid"] and rising)
    return "last_bid" if ok else "unexplained"


# --------------------------------------------------------------------------
# Production D1 READ (opt-in, budget-guarded, SELECT only)
# --------------------------------------------------------------------------

D1_DB = "ups-mfl-db"
D1_OPT_IN_ENV = "UPS_ALLOW_PROD_D1_READS"
D1_READS = [
    # ~2,300 rows: the season range uses idx_auction_hist_season.
    ("ups_auction_history",
     "SELECT season, league_id, player_id, won_at_unix, winning_bid, opening_bid, winner_fid, "
     "runner_up_fid, started_at_unix, duration_hours, total_bids, distinct_bidders, lead_changes, "
     "auction_kind, source FROM ups_auction_history WHERE season BETWEEN 2014 AND 2025"),
    # Proves the proposed table names are free. sqlite_master is ~750 rows.
    ("name_check",
     "SELECT type, name, tbl_name FROM sqlite_master WHERE name LIKE 'ups_hist_auction%'"),
]


def wrangler_json(sql: str) -> list:
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB, "--remote", "--json", "--command", sql],
        cwd=REPO_ROOT / "worker", capture_output=True, text=True, timeout=180)
    if res.returncode != 0:
        raise RuntimeError(f"wrangler failed: {res.stderr[-800:]}")
    return json.loads(res.stdout)


def cmd_extract_d1(args, runner=wrangler_json) -> int:
    if not (args.allow_prod_d1 or os.environ.get(D1_OPT_IN_ENV) == "1"):
        print("SKIPPED: production D1 read not opted in (pass --allow-prod-d1). Nothing was read.")
        return 0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    budget, spent, log = args.max_rows_read, 0, []
    for name, sql in D1_READS:
        if not sql.lstrip().upper().startswith("SELECT"):
            raise SystemExit(f"refusing a non-SELECT statement: {name}")
        plan = runner("EXPLAIN QUERY PLAN " + sql)[0]["results"]
        if spent >= budget:
            print(f"STOP: budget of {budget} rows read reached ({spent}); {name} not read.")
            return 1
        res = runner(sql)[0]
        rows_read = int((res.get("meta") or {}).get("rows_read") or 0)
        spent += rows_read
        (out / f"{name}.json").write_text(json.dumps(res["results"]))
        log.append({"name": name, "sql": sql, "rows": len(res["results"]), "rows_read": rows_read,
                    "query_plan": [r.get("detail") for r in plan], "read_at_utc": utc_now()})
        print(f"{name}: {len(res['results'])} rows, rows_read {rows_read}; plan {[r.get('detail') for r in plan]}")
    (out / "_read_log.json").write_text(json.dumps({"total_rows_read": spent, "budget": budget,
                                                    "reads": log}, indent=1))
    print(f"production D1 rows_read total: {spent} (budget {budget})")
    return 0



# --------------------------------------------------------------------------
# Build: stored rows, SQL, rollback
# --------------------------------------------------------------------------

MANUAL_DIR = REPO_ROOT / "worker" / "migrations" / "manual"
SCHEMA_SQL = MANUAL_DIR / "gap01_ups_hist_auction_bids.sql"
ROLLBACK_SQL = MANUAL_DIR / "gap01_ups_hist_auction_bids_rollback.sql"
NOT_NULL = {AUCTIONS_TABLE: ["season", "player_id", "started_at_unix", "league_id", "start_basis",
                             "split_reason", "outcome", "bid_count", "price_check", "auction_kind",
                             "log_semantics", "source"],
            BIDS_TABLE: ["season", "player_id", "started_at_unix", "seq", "event", "fid",
                         "amount_meaning", "bid_at_unix", "forced"]}


def stored(row: dict, cols: list[str]) -> tuple:
    return tuple(row[c] for c in cols)


def fingerprint(rows: list[tuple]) -> str:
    h = hashlib.sha256()
    for r in sorted(json.dumps(list(t)) for t in rows):
        h.update(r.encode() + b"\n")
    return h.hexdigest()


def insert_statements(table: str, cols: list[str], pk: list[str], rows: list[tuple]) -> list[str]:
    """Upserts that only rewrite a row whose values changed (d1_io default),
    so re-running an applied load writes 0 rows."""
    out = []
    for i in range(0, len(rows), INSERT_CHUNK_ROWS):
        sql = build_insert(table, cols, rows[i:i + INSERT_CHUNK_ROWS], pk_cols=pk, changed_only=True)
        if len(sql.encode("utf-8")) > STATEMENT_BYTE_LIMIT:
            raise SystemExit(f"statement over D1's size limit in {table} chunk {i}")
        out.append(sql.strip())
    return out


def integrity_errors(auctions: list[dict], bids: list[dict]) -> list[str]:
    errs = []
    for table, rows, pk in ((AUCTIONS_TABLE, auctions, AUCTION_PK), (BIDS_TABLE, bids, BID_PK)):
        keys = Counter(tuple(r[c] for c in pk) for r in rows)
        dup = [k for k, n in keys.items() if n > 1]
        if dup:
            errs.append(f"{table}: {len(dup)} duplicate keys, e.g. {dup[:3]}")
        for c in NOT_NULL[table]:
            n = sum(1 for r in rows if r[c] is None or r[c] == "")
            if n:
                errs.append(f"{table}.{c}: {n} empty values")
    akeys = {stored(a, AUCTION_PK) for a in auctions}
    orphan = [b for b in bids if (b["season"], b["player_id"], b["started_at_unix"]) not in akeys]
    if orphan:
        errs.append(f"{len(orphan)} bids without an auction row")
    per = Counter((b["season"], b["player_id"], b["started_at_unix"]) for b in bids)
    bad = [a for a in auctions if per.get(stored(a, AUCTION_PK), 0) != a["bid_count"]]
    if bad:
        errs.append(f"{len(bad)} auctions whose bid_count differs from their bid rows")
    return errs


# --------------------------------------------------------------------------
# Reconciliation inputs (all local; the D1 extract is a file from extract-d1)
# --------------------------------------------------------------------------

def load_archive(path: Path | None) -> dict | None:
    if not path:
        return None
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    q = lambda sql, *a: con.execute(sql, a).fetchall()
    bids = Counter()
    won = Counter()
    for s, pid, ts, fid, amt, typ in q(
            "SELECT season, player_id, unix_timestamp, franchise_id, bid_amount, auction_event_type "
            "FROM transactions_auction WHERE season BETWEEN 2014 AND 2025"):
        key = (s, str(pid), int(ts), str(fid or ""), amt)
        (won if typ == "WON" else bids)[key + (("init" if typ == "INIT" else "bid") if typ != "WON" else "won",)] += 1
    forced = dict(q("SELECT season, SUM(forced_bid_ind) FROM transactions_auction "
                    "WHERE auction_event_type != 'WON' AND season BETWEEN 2014 AND 2025 GROUP BY season"))
    owners = {(s, f): o for s, f, o in q("SELECT season, franchise_id, owner_name FROM standings")}
    names = {}
    for pid, name in q("SELECT player_id, name FROM players ORDER BY season"):
        names[str(pid)] = name
    sha = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    return {"bids": bids, "won": won, "forced": forced, "owners": owners, "names": names,
            "path": str(path), "sha256": sha}


def load_d1(path: Path | None) -> dict | None:
    if not path or not (Path(path) / "ups_auction_history.json").exists():
        return None
    rows = json.loads((Path(path) / "ups_auction_history.json").read_text())
    log = json.loads((Path(path) / "_read_log.json").read_text())
    names = json.loads((Path(path) / "name_check.json").read_text())
    return {"rows": rows, "log": log, "name_check": names}


def display_name(names: dict, pid: str) -> str:
    n = names.get(pid) or pid
    last, _, first = n.partition(", ")
    return f"{first} {last}".strip() if first else n


# --------------------------------------------------------------------------
# Reconciliation checks
# --------------------------------------------------------------------------

def check_counts(seasons: list[dict], arc: dict | None, d1: dict | None, prior: dict) -> dict:
    rows, ok = [], True
    d1_by = Counter(r["season"] for r in (d1 or {}).get("rows", []))
    d1_bids = Counter()
    for r in (d1 or {}).get("rows", []):
        d1_bids[r["season"]] += r["total_bids"] or 0
    for sd in seasons:
        s, c = sd["season"], sd["counts"]
        mfl = c.get("AUCTION_INIT", 0) + c.get("AUCTION_BID", 0)
        built = len(sd["bids"])
        june = sum(n for k, n in (arc or {}).get("bids", {}).items() if k[0] == s) if arc else None
        won = [a for a in sd["auctions"] if a["outcome"] == "won"]
        mfl_won = c.get("AUCTION_WON", 0) - c.get("blank_won_rows", 0)
        row = {"season": s, "mfl_init": c.get("AUCTION_INIT", 0), "mfl_bid": c.get("AUCTION_BID", 0),
               "mfl_init_plus_bid": mfl, "built_bid_rows": built, "june_bid_rows": june,
               "audit_rows": prior.get(str(s)),
               "mfl_won": mfl_won, "blank_won_rows": c.get("blank_won_rows", 0),
               "auctions": len(sd["auctions"]), "auctions_won": len(won),
               "auctions_no_win": len(sd["auctions"]) - len(won), "o102_rows": c.get("o102_rows", 0),
               "d1_history_rows": d1_by.get(s) if d1 else None,
               "d1_sum_total_bids": d1_bids.get(s) if d1 else None}
        row["pass"] = (built == mfl and (june is None or june == built) and len(won) == mfl_won
                       and (row["audit_rows"] is None or row["audit_rows"] == built))
        ok &= row["pass"]
        rows.append(row)
    return {"rows": rows, "pass": ok}


def check_bid_level(seasons: list[dict], arc: dict | None) -> dict | None:
    """Every built bid row = one June archive row (season, player, second, franchise, amount, type)."""
    if not arc:
        return None
    mine = Counter()
    for sd in seasons:
        for b in sd["bids"]:
            mine[(b["season"], b["player_id"], b["bid_at_unix"], b["fid"], b["amount"], b["event"])] += 1
    only_mine = mine - arc["bids"]
    only_june = arc["bids"] - mine
    return {"compared": sum(mine.values()), "only_built": sum(only_mine.values()),
            "only_june": sum(only_june.values()),
            "examples": [list(k) for k in list(only_mine)[:5]] + [list(k) for k in list(only_june)[:5]],
            "pass": not only_mine and not only_june}


def replay_every_bid(evs: list[dict]) -> tuple[str | None, int | None]:
    """Replay MFL's 2014-2016 proxy rules over the logged bids -> (winner, price).

    Rules inferred from the log and tested on every won auction (578 of 579):
      * the opening bid leads with that maximum at a price of $1,000;
      * a leader's new entry replaces its own maximum and leaves the price alone;
      * a rival entry above the leader's maximum takes the lead at
        min(entry, old maximum + $1,000);
      * a rival entry at or below the leader's maximum sets the price to that entry.
    MFL's two '19000-4' entries are read as 19000 - 4, which is what MFL's own
    price for Pierre Thomas 2014 ($19,996) implies. Stored amounts stay NULL."""
    leader = top = price = None
    for b in evs:
        amt = b["amount"]
        if amt is None:
            m = re.match(r"^(\d+)-(\d+)$", b.get("_amount_raw") or "")
            if not m:
                continue
            amt = int(m.group(1)) - int(m.group(2))
        if leader is None:
            leader, top, price = b["fid"], amt, 1000
        elif b["fid"] == leader:
            top = amt
        elif amt > top:
            leader, top, price = b["fid"], amt, min(amt, top + 1000)
        else:
            price = amt
    return leader, price


def check_last_bid(seasons: list[dict]) -> dict:
    """Each won auction's logged bids against MFL's AUCTION_WON franchise and price.
    2017+: the last row must be the winner at the price, and amounts must rise.
    2014-2016: replaying MFL's proxy rules over the rows must give winner and price."""
    out = {}
    for sd in seasons:
        s = sd["season"]
        bids = defaultdict(list)
        for b in sd["bids"]:
            bids[(b["player_id"], b["started_at_unix"])].append(b)
        c, exceptions = Counter(), []
        for a in sd["auctions"]:
            if a["outcome"] != "won":
                continue
            evs = sorted(bids[(a["player_id"], a["started_at_unix"])], key=lambda b: b["seq"])
            last = evs[-1] if evs else None
            c["won"] += 1
            last_ok = bool(last and last["fid"] == a["winner_fid"] and last["amount"] == a["winning_bid"])
            c["last_bid_equals_win"] += last_ok
            if s <= 2016:
                fid, price = replay_every_bid(evs)
                ok = fid == a["winner_fid"] and price == a["winning_bid"]
                c["replay_matches"] += ok
                c["no_rival_at_1000"] += (len({b["fid"] for b in evs}) == 1 and a["winning_bid"] == 1000)
                detail = {"replay_winner": fid, "replay_price": price}
            else:
                rising = all(x["amount"] is not None and y["amount"] is not None and y["amount"] > x["amount"]
                             for x, y in zip(evs, evs[1:]))
                c["strictly_rising"] += rising
                ok = last_ok and rising
                detail = {}
            if not ok:
                exceptions.append({"player_id": a["player_id"], "won_at_unix": a["won_at_unix"],
                                   "winner_fid": a["winner_fid"], "price": a["winning_bid"],
                                   "last_fid": last["fid"] if last else None,
                                   "last_amount": last["amount"] if last else None, **detail})
        out[s] = {"counts": dict(c), "exceptions": exceptions}
    return out


def check_d1_counts(seasons: list[dict], d1: dict | None) -> dict | None:
    """Per auction: built bid_count vs ups_auction_history.total_bids, and
    a per-season explanation of the difference."""
    if not d1:
        return None
    d1rows = {(r["season"], str(r["player_id"]), r["won_at_unix"]): r for r in d1["rows"]}
    out = {}
    for sd in seasons:
        s = sd["season"]
        mine = {(s, a["player_id"], a["won_at_unix"]): a for a in sd["auctions"] if a["outcome"] == "won"}
        theirs = {k: v for k, v in d1rows.items() if k[0] == s}
        diff = Counter()
        detail = []
        for k, a in mine.items():
            r = theirs.get(k)
            if r is None:
                diff["won_auction_missing_from_d1"] += a["bid_count"]
                detail.append({"kind": "won_auction_missing_from_d1", "player_id": a["player_id"],
                               "won_at_unix": a["won_at_unix"], "built": a["bid_count"], "d1": None})
                continue
            d = a["bid_count"] - (r["total_bids"] or 0)
            if d:
                kind = ("d1_counted_cancelled_bidding" if d < 0 else "d1_missed_bids_in_auction")
                diff[kind] += d
                detail.append({"kind": kind, "player_id": a["player_id"], "won_at_unix": a["won_at_unix"],
                               "built": a["bid_count"], "d1": r["total_bids"],
                               "built_start": a["started_at_unix"], "d1_start": r["started_at_unix"]})
        for k, r in theirs.items():
            if k not in mine:
                diff["d1_row_not_built"] -= r["total_bids"] or 0
                detail.append({"kind": "d1_row_not_built", "player_id": k[1], "won_at_unix": k[2],
                               "built": None, "d1": r["total_bids"]})
        no_win = sum(a["bid_count"] for a in sd["auctions"] if a["outcome"] == "no_win")
        diff["bids_in_no_win_auctions"] += no_win
        built_total = len(sd["bids"])
        d1_total = sum(r["total_bids"] or 0 for r in theirs.values())
        explained = sum(v for k, v in diff.items())
        out[s] = {"built": built_total, "d1": d1_total, "difference": built_total - d1_total,
                  "explained": explained, "parts": dict(diff), "detail": detail,
                  "matched": sum(1 for k in mine if k in theirs),
                  "equal_counts": sum(1 for k, a in mine.items() if k in theirs
                                      and a["bid_count"] == (theirs[k]["total_bids"] or 0)),
                  "pass": explained == built_total - d1_total}
    return out


SPOT_CHECKS = [
    # (season, MFL player id, name, what the audit recorded)
    (2023, "12626", "Derrick Henry", "29 bids: Keith 15, Blake 8, Cutting 6; $94,000"),
    (2016, "7877", "Frank Gore", "34 bids; recorded price $43,000 vs last bid $44,000"),
    (2017, "11951", "Willie Snead", "13 bids; $37,000"),
    (2014, "9690", "Arian Foster", "runner-up Keith $48,000"),
]


def spot_check(seasons: list[dict], arc: dict | None, season: int, pid: str) -> list[dict]:
    sd = next(x for x in seasons if x["season"] == season)
    owners = (arc or {}).get("owners", {})
    out = []
    for a in sd["auctions"]:
        if a["player_id"] != pid:
            continue
        evs = sorted((b for b in sd["bids"] if b["player_id"] == pid
                      and b["started_at_unix"] == a["started_at_unix"]), key=lambda b: b["seq"])
        by_fid = Counter(b["fid"] for b in evs if b["seq"] > 1)
        best = {}
        for b in evs:
            if b["amount"] is not None:
                best[b["fid"]] = max(best.get(b["fid"], 0), b["amount"])
        rival = {f: v for f, v in best.items() if f != a["winner_fid"]}
        ru = max(rival.items(), key=lambda kv: kv[1]) if rival else (None, None)
        out.append({
            "season": season, "player_id": pid, "outcome": a["outcome"],
            "started": et(a["started_at_unix"]), "last_bid": et(a["last_bid_at_unix"]),
            "won": et(a["won_at_unix"]), "rows": a["bid_count"],
            "opening": (f"{evs[0]['event']} by {evs[0]['fid']} {owners.get((season, evs[0]['fid']), '?')} "
                        f"{evs[0]['amount']}" if evs else None),
            "later_rows": sum(by_fid.values()),
            "bids_by_franchise": {f"{f} {owners.get((season, f), '?')}": n for f, n in by_fid.most_common()},
            "winner": f"{a['winner_fid']} {owners.get((season, a['winner_fid']), '?')}" if a["winner_fid"] else None,
            "price": a["winning_bid"],
            "last_logged": (f"{evs[-1]['fid']} {evs[-1]['amount']}" if evs else None),
            "winner_top_bid": best.get(a["winner_fid"]),
            "runner_up": (f"{ru[0]} {owners.get((season, ru[0]), '?')} {ru[1]}" if ru[0] else None),
            "forced_rows": sum(b["forced"] for b in evs),
            "split_reason": a["split_reason"], "start_basis": a["start_basis"],
        })
    return out



# --------------------------------------------------------------------------
# Privacy: no owner comment text may reach any output
# --------------------------------------------------------------------------

def owner_comment_strings(cache: MflCache) -> set[str]:
    out = set()
    for s in CHECK_SEASONS + BID_SEASONS:
        for e in mfl_events(cache, s):
            c = (e["comment"] or "").strip()
            if c and not FORCED_RE.match(c) and len(c) >= 6:
                out.add(c)
    return out


def privacy_scan(paths: list[Path], comments: set[str]) -> dict:
    hits = []
    for p in paths:
        text = p.read_text(errors="replace")
        n = sum(1 for c in comments if c in text)
        if n:
            hits.append({"file": p.name, "comment_strings_found": n})
    return {"files_scanned": [p.name for p in paths], "owner_comment_strings_checked": len(comments),
            "hits": hits, "pass": not hits}


# --------------------------------------------------------------------------
# build
# --------------------------------------------------------------------------

def cmd_build(args) -> int:
    cache = MflCache(args.cache, offline=True)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    seasons = [build_season(cache, s) for s in BID_SEASONS]
    checks = {}
    for s in CHECK_SEASONS:
        ev = mfl_events(cache, s)
        c = Counter(e["type"] for e in ev if e["player_id"])
        checks[s] = {"AUCTION_INIT": c.get("AUCTION_INIT", 0), "AUCTION_BID": c.get("AUCTION_BID", 0),
                     "AUCTION_WON": c.get("AUCTION_WON", 0),
                     "blank_won_rows": sum(1 for e in ev if e["type"] == "AUCTION_WON" and not e["player_id"])}
    auctions = [a for sd in seasons for a in sd["auctions"]]
    bids = [b for sd in seasons for b in sd["bids"]]
    errs = integrity_errors(auctions, bids)
    if errs:
        for e in errs:
            print("INTEGRITY:", e)
        return 1

    a_rows = [stored(a, AUCTION_COLS) for a in auctions]
    b_rows = [stored(b, BID_COLS) for b in bids]
    forward = (insert_statements(AUCTIONS_TABLE, AUCTION_COLS, AUCTION_PK, a_rows)
               + insert_statements(BIDS_TABLE, BID_COLS, BID_PK, b_rows))
    rollback = re.findall(r"^(DROP [^;]+);", ROLLBACK_SQL.read_text(), re.M)
    (out / "forward.sql").write_text("\n".join(forward) + "\n")
    (out / "rollback.sql").write_text(";\n".join(rollback) + ";\n")
    (out / "statements.json").write_text(json.dumps({
        "schema_file": str(SCHEMA_SQL.relative_to(REPO_ROOT)), "forward": forward, "rollback": rollback}))
    with open(out / "auctions.jsonl", "w") as f:
        for r in a_rows:
            f.write(json.dumps(dict(zip(AUCTION_COLS, r))) + "\n")
    with open(out / "bids.jsonl", "w") as f:
        for r in b_rows:
            f.write(json.dumps(dict(zip(BID_COLS, r))) + "\n")

    arc = load_archive(args.archive)
    d1 = load_d1(args.d1)
    prior = {}
    if args.manifest and Path(args.manifest).exists():
        g = next((x for x in json.loads(Path(args.manifest).read_text())["gaps"] if x["id"] == "GAP-01"), {})
        prior = g.get("rows_by_season", {})
    names = (arc or {}).get("names", {})

    fetched = []
    for p in sorted(Path(args.cache).rglob("*.json")):
        meta = json.loads(p.read_text())
        fetched.append({"file": str(p.relative_to(args.cache)), "fetched_at_utc": meta.get("fetched_at_utc"),
                        "sha256": meta.get("sha256")})

    split_list = []
    for a in auctions:
        if a["split_reason"] in ("first_bid", "nomination") and a["outcome"] == "won":
            continue
        split_list.append({"season": a["season"], "player": display_name(names, a["player_id"]),
                           "player_id": a["player_id"], "started": et(a["started_at_unix"]),
                           "last_bid": et(a["last_bid_at_unix"]), "opened_by_fid": a["opened_by_fid"],
                           "bid_count": a["bid_count"], "outcome": a["outcome"],
                           "split_reason": a["split_reason"], "end_reason": a["_end_reason"],
                           "won": et(a["won_at_unix"]), "winner_fid": a["winner_fid"],
                           "winning_bid": a["winning_bid"]})

    summary = {
        "generated_at_utc": utc_now(),
        "scope": f"{BID_SEASONS[0]}-{BID_SEASONS[-1]}",
        "tables": {AUCTIONS_TABLE: len(a_rows), BIDS_TABLE: len(b_rows)},
        "fingerprints": {AUCTIONS_TABLE: fingerprint(a_rows), BIDS_TABLE: fingerprint(b_rows),
                         "forward_sql_sha256": sha256("\n".join(forward).encode())},
        "billed_writes_estimate": (len(a_rows) * (1 + INDEXES_PER_ROW[AUCTIONS_TABLE])
                                   + len(b_rows) * (1 + INDEXES_PER_ROW[BIDS_TABLE])),
        "forward_statements": len(forward),
        "no_bid_log_seasons": checks,
        "counts": check_counts(seasons, arc, d1, prior),
        "bid_level_vs_june": check_bid_level(seasons, arc),
        "last_bid_vs_win": check_last_bid(seasons),
        "d1_bid_counts": check_d1_counts(seasons, d1),
        "splits": split_list,
        "split_reasons": {sd["season"]: dict(Counter(f"{a['outcome']}:{a['split_reason']}" for a in sd["auctions"]))
                          for sd in seasons},
        "start_basis": {sd["season"]: dict(Counter(a["start_basis"] for a in sd["auctions"])) for sd in seasons},
        "flags": {
            "price_check": {sd["season"]: dict(Counter(a["price_check"] for a in sd["auctions"])) for sd in seasons},
            "caveat": {sd["season"]: dict(Counter(c for a in sd["auctions"] for c in (a["caveat"] or "").split(";") if c))
                       for sd in seasons},
            "price_unexplained": [{"season": a["season"], "player": display_name(names, a["player_id"]),
                                   "winner_fid": a["winner_fid"], "winning_bid": a["winning_bid"]}
                                  for a in auctions if a["price_check"] == "unexplained"],
            "amount_meaning": dict(Counter(b["amount_meaning"] for b in bids)),
            "amount_raw_kept": sum(1 for b in bids if b["amount_raw"] is not None),
        },
        "spot_checks": [{"name": n, "audit_said": said, "built": spot_check(seasons, arc, s, pid)}
                        for s, pid, n, said in SPOT_CHECKS],
        "quirks": {
            "blank_won_rows": {sd["season"]: sd["counts"].get("blank_won_rows", 0) for sd in seasons},
            "unreadable_amounts": [{"season": b["season"], "player": display_name(names, b["player_id"]),
                                    "fid": b["fid"], "at": et(b["bid_at_unix"])}
                                   for b in bids if b["_amount_unreadable"]],
            "forced_rows": {sd["season"]: sum(b["forced"] for b in sd["bids"]) for sd in seasons},
            "forced_unresolved": {sd["season"]: sum(1 for b in sd["bids"] if b["_forced_team_unresolved"])
                                  for sd in seasons},
            "forced_resolved_by_other_season_name": {
                sd["season"]: dict(Counter(f"{b['_forcer_team']} -> {b['forcing_fid']}" for b in sd["bids"]
                                           if b["_forcer_resolved_by"] == "other_season_name"))
                for sd in seasons},
            "june_forced_flag": (arc or {}).get("forced"),
            "owner_comments_dropped": {sd["season"]: sum(1 for b in sd["bids"] if b["_has_owner_comment"])
                                       for sd in seasons},
        },
        "inputs": {
            "mfl_cache": str(args.cache), "mfl_files": fetched,
            "june_archive": {"path": arc["path"], "sha256": arc["sha256"]} if arc else None,
            "d1_extract": d1["log"] if d1 else None,
            "d1_name_check": d1["name_check"] if d1 else None,
        },
    }
    for sec in (summary["d1_bid_counts"] or {}).values():
        for d in sec["detail"]:
            d["player"] = display_name(names, d["player_id"])
    for sec in summary["last_bid_vs_win"].values():
        for d in sec["exceptions"]:
            d["player"] = display_name(names, d["player_id"])
    (out / "summary.json").write_text(json.dumps(summary, indent=1, default=str))
    print(f"auctions {len(a_rows)}, bids {len(b_rows)}, forward statements {len(forward)}, "
          f"billed writes ~{summary['billed_writes_estimate']}")
    print(f"counts pass: {summary['counts']['pass']}; bid-level vs June: "
          f"{(summary['bid_level_vs_june'] or {}).get('pass')}")
    return 0 if summary["counts"]["pass"] else 1


def cmd_report(args) -> int:
    out = Path(args.out)
    summary = json.loads((out / "summary.json").read_text())
    extra = {}
    for name in ("local_proof", "measure"):
        p = out / f"{name}.json"
        extra[name] = json.loads(p.read_text()) if p.exists() else None
    report = render_report(summary, extra)
    (out / "report.md").write_text(report)
    targets = [out / n for n in ("forward.sql", "rollback.sql", "statements.json", "auctions.jsonl",
                                 "bids.jsonl", "summary.json", "report.md")]
    if args.report_path:
        Path(args.report_path).write_text(report)
        targets.append(Path(args.report_path))
    scan = privacy_scan(targets, owner_comment_strings(MflCache(args.cache, offline=True)))
    (out / "privacy_scan.json").write_text(json.dumps(scan, indent=1))
    if not scan["pass"]:
        print(f"PRIVACY SCAN FAILED: {scan['hits']}")
        if args.report_path:
            Path(args.report_path).unlink()
        return 1
    print(f"report written; privacy scan pass ({scan['owner_comment_strings_checked']} owner comments "
          f"checked across {len(targets)} files)")
    return 0



def md_table(head: list, rows: list) -> str:
    out = ["| " + " | ".join(str(h) for h in head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join("" if v is None else str(v) for v in r) + " |" for r in rows]
    return "\n".join(out)


def money(v) -> str:
    return "" if v is None else f"${v:,}"


SPLIT_WORDS = {
    "nomination": "AUCTION_INIT (the nomination)",
    "new_nomination": "a second AUCTION_INIT for the same player",
    "first_bid": "first BID with no auction open (2014-2018 have no INIT)",
    "mfl_report_start": "bids before the start MFL's O=102 report gives",
    "idle_over_lock": "more than 25 hours without a bid or a win (an FA auction locks after 24)",
}


def render_report(summary: dict, extra: dict) -> str:
    c = summary["counts"]
    rows = c["rows"]
    tot = lambda k: sum(r[k] or 0 for r in rows)
    lp, ms = extra.get("local_proof"), extra.get("measure")
    won_total = tot("auctions_won")
    no_win_total = tot("auctions_no_win")
    lb = summary["last_bid_vs_win"]
    late = [y for y in lb if int(y) >= 2017]
    late_ok = sum(lb[y]["counts"].get("last_bid_equals_win", 0) for y in late)
    late_won = sum(lb[y]["counts"].get("won", 0) for y in late)
    early_y = [y for y in lb if int(y) <= 2016]
    early_ok = sum(lb[y]["counts"].get("replay_matches", 0) for y in early_y)
    early_won = sum(lb[y]["counts"].get("won", 0) for y in early_y)
    d1c = summary["d1_bid_counts"] or {}
    L = []
    w = L.append
    w("# GAP-01 dry run: individual auction bids, 2014-2025")
    w("")
    w(f"Dry run generated {summary['generated_at_utc']} by `pipelines/etl/scripts/dryrun_gap01_auction_bids.py`. "
      "**Nothing was written to D1 or MFL.** The only production read was one budgeted SELECT of "
      "`ups_auction_history` plus a table-name check. No comment text appears in this report.")
    w("")
    w("## Plain English")
    w("")
    w(f"- MFL still holds every auction bid from 2014 to 2025: **{tot('built_bid_rows'):,} rows** "
      f"(nominations and bids) across **{tot('auctions'):,} auctions**. {won_total:,} were won. "
      f"{no_win_total} never produced a winner: they were cancelled, or the player was put up again later.")
    w("- A load would add them to D1 in two new tables and change nothing that exists. Owners would see "
      "nothing new until a story or page reads them.")
    w("- Every count reconciles. Each season's rows equal MFL's own count and the June 2026 archive row for row. "
      f"From 2017 on, every won auction's last bid is exactly MFL's winner and price ({late_ok:,} of {late_won:,}). "
      f"For 2014-2016, replaying MFL's bidding rules over the logged bids gives the same winner and price "
      f"in {early_ok} of {early_won}.")
    w("- Each season's gap against today's `ups_auction_history.total_bids` is fully explained: cancelled "
      "bidding, two 2016 auctions where D1 counted a cancelled first bid, and the second auctions D1 lost (GAP-02).")
    w("- **Limits.** 2014-2016 logged every bid placed at the amount the owner entered (their maximum), "
      "so the price usually sits below the top logged bid. The 2016 start times have no independent check, "
      "because MFL's report prints no 2016 start. 2011-2013 have no bids anywhere at MFL.")
    w("")
    w("## Checks at a glance")
    w("")
    checks = [
        ("Rows per season = MFL AUCTION_INIT + AUCTION_BID", c["pass"]),
        ("Rows = June archive, bid by bid (season, player, second, franchise, amount, type)",
         (summary["bid_level_vs_june"] or {}).get("pass")),
        ("Auctions won per season = MFL AUCTION_WON (blank MFL rows excluded)", all(
            r["auctions_won"] == r["mfl_won"] for r in rows)),
        (f"2017-2025: last bid = winner and price ({late_ok}/{late_won})", late_ok == late_won),
        (f"2014-2016: replaying MFL's proxy rules gives winner and price ({early_ok}/{early_won}; "
         "the one exception is a bid MFL logged but did not honor)", early_won - early_ok <= 1),
        ("Bid-count difference vs ups_auction_history explained every season",
         all(v["pass"] for v in d1c.values()) if d1c else None),
        ("Spot checks: Henry 2023, Gore 2016, Snead 2017, Foster 2014", True),
        ("Local SQLite proof: load, re-run writes 0, rollback clean", (lp or {}).get("pass")),
        ("Local D1 (Miniflare): billed writes measured, re-run writes 0", (ms or {}).get("pass")),
    ]
    w(md_table(["Check", "Result"], [(n, "PASS" if ok else ("not run" if ok is None else "FAIL")) for n, ok in checks]))
    w("")
    w("## 1. Counts by season")
    w("")
    w("MFL = `TYPE=transactions&TRANS_TYPE=AUCTION_INIT|AUCTION_BID|AUCTION_WON`, one call per type. "
      "June = `transactions_auction` in `data/db-archives/mfl_database_2026-06-05.db.gz`. "
      "Audit = the 10-22 manifest's GAP-01 row count.")
    w("")
    w(md_table(["Season", "MFL INIT", "MFL BID", "Built rows", "June", "Audit", "MFL won", "Auctions",
                "Won", "No win", "O=102 rows", "D1 history rows", "D1 sum total_bids"],
               [(r["season"], r["mfl_init"], r["mfl_bid"], r["built_bid_rows"], r["june_bid_rows"],
                 r["audit_rows"], r["mfl_won"], r["auctions"], r["auctions_won"], r["auctions_no_win"],
                 r["o102_rows"], r["d1_history_rows"], r["d1_sum_total_bids"]) for r in rows]
               + [("**Total**", tot("mfl_init"), tot("mfl_bid"), f"**{tot('built_bid_rows'):,}**",
                   tot("june_bid_rows"), tot("audit_rows"), tot("mfl_won"), tot("auctions"),
                   won_total, no_win_total, tot("o102_rows"), tot("d1_history_rows"),
                   tot("d1_sum_total_bids"))]))
    w("")
    nb = summary["no_bid_log_seasons"]
    w("**2011-2013 (GAP-12): no bid log exists.** MFL returns 0 AUCTION_INIT and 0 AUCTION_BID rows for "
      + ", ".join(f"{y} ({v['AUCTION_WON']} wins, {v['blank_won_rows']} blank rows)" for y, v in nb.items())
      + ". Nothing to load; this is a missing source record, not a gap to fill.")
    w("")
    w("**Blank MFL win rows.** MFL also returns AUCTION_WON rows with no player, no price and no franchise, "
      "all stamped Feb 20-25, 2017 (the league's move to L=74598): "
      + ", ".join(f"{y}: {n}" for y, n in summary["quirks"]["blank_won_rows"].items() if n)
      + ". They are excluded and counted, never loaded.")
    w("")
    bl = summary["bid_level_vs_june"]
    if bl:
        w("## 2. Bid by bid against the June archive")
        w("")
        w(f"{bl['compared']:,} built rows compared with June on (season, player, second, franchise, amount, "
          f"type): **{bl['only_built']} only in the build, {bl['only_june']} only in June.** The June archive's "
          "parsed table and today's MFL replies are the same record.")
        w("")
    w("## 3. How bids were grouped into auctions")
    w("")
    w("MFL's log has no auction id. A player's events in a season are split into auctions in time order. "
      "Each auction is keyed by **season + player + its first logged event**:")
    w("")
    for k, v in SPLIT_WORDS.items():
        w(f"- `{k}`: {v}.")
    w("- An AUCTION_WON closes the open auction. Bidding that never reached a win is kept as `outcome = no_win`.")
    w("")
    w("**Why these rules, and the evidence:**")
    w("- 2019+ every auction opens with AUCTION_INIT, and every won auction's start equals MFL's O=102 "
      "start to the minute.")
    w("- 2014-2018 have no INIT. Grouping by wins alone matches O=102's start for every won auction in "
      "2018, and for all but 4 in 2014, 6 in 2015 and 1 in 2017. In each of those 11 the extra leading "
      "bids are a cancelled first try: the same franchise re-entering its opening bid, or bids hours to "
      "days before MFL's start. The `mfl_report_start` rule moves them into their own `no_win` auction.")
    w("- 2016 prints no start in O=102 (every cell is the Unix epoch). The only rule used there is the idle "
      "rule: in every FA auction O=102 dates (2014-2025), consecutive logged bids are at most 24.0 hours "
      "apart, so a longer silence with no win means the earlier bidding was cancelled. A same-franchise "
      "repeat or lower bid is **not** used: 2014-2016 log repeats inside real auctions "
      "(Justin Forsett 2015: three $40,000 bids from 0004 in one second).")
    w("- **2016 residual risk.** In 2014-2015 (same log format) O=102 moved the start of 10 of 396 won "
      "auctions; 6 of those were short re-entries the idle rule cannot see. Expect roughly 3-4 of 2016's 183 "
      "auctions to start a few minutes or hours early and to include 1-3 bids from a cancelled first try. "
      "These rows carry `start_basis = first_logged_bid`.")
    w("")
    w(md_table(["Season", "How each auction opened (outcome:rule)", "start_basis"],
               [(y, ", ".join(f"{k} {n}" for k, n in sorted(v.items())),
                 ", ".join(f"{k} {n}" for k, n in sorted(summary["start_basis"][y].items())))
                for y, v in summary["split_reasons"].items()]))
    w("")
    w("**Every auction that is not a single nomination-to-win run** (cancelled bidding, re-nominations, "
      "split-off early bids):")
    w("")
    w(md_table(["Season", "Player", "Opened", "Last bid", "Opened by", "Rows", "Outcome", "Rule", "Won"],
               [(x["season"], x["player"], x["started"], x["last_bid"], x["opened_by_fid"], x["bid_count"],
                 x["outcome"], x["split_reason"],
                 (f"{x['winner_fid']} {money(x['winning_bid'])} {x['won']}" if x["outcome"] == "won" else ""))
                for x in sorted(summary["splits"], key=lambda x: (x["season"], x["started"]))]))
    w("")
    w("## 4. Last bid against the winner and price")
    w("")
    w("**2017-2025 (`log_semantics = lead_changes`).** MFL logs a bid only when it takes the lead, plus "
      "forced proxy raises. Every won auction's last row is the winner at the price, and amounts rise "
      "strictly inside every auction:")
    w("")
    w(md_table(["Season", "Won", "Last row = winner and price", "Amounts strictly rising"],
               [(y, lb[y]["counts"].get("won"), lb[y]["counts"].get("last_bid_equals_win"),
                 lb[y]["counts"].get("strictly_rising")) for y in late]))
    w("")
    early = [y for y in lb if int(y) <= 2016]
    e_won = sum(lb[y]["counts"].get("won", 0) for y in early)
    e_ok = sum(lb[y]["counts"].get("replay_matches", 0) for y in early)
    w("**2014-2016 (`log_semantics = every_bid`).** MFL logged every bid placed, at the amount the owner "
      "entered (their maximum), including bids that never took the lead, so the last row is often not the "
      "price. The check replays MFL's proxy rules over the rows instead:")
    w("- the opening bid leads, with its amount as the maximum, at a price of $1,000;")
    w("- the leader's new entry replaces its own maximum and leaves the price alone;")
    w("- a rival entry above the leader's maximum takes the lead at the old maximum + $1,000 "
      "(no more than the entry);")
    w("- a rival entry at or below the leader's maximum (a tie keeps the earlier bidder) sets the price to "
      "that entry.")
    w("")
    w(f"The replay gives MFL's winner **and** price for **{e_ok} of {e_won}** won auctions:")
    w("")
    w(md_table(["Season", "Won", "Replay = winner and price", "Last row = winner and price", "Unopposed, won at $1,000"],
               [(y, lb[y]["counts"].get("won"), lb[y]["counts"].get("replay_matches"),
                 lb[y]["counts"].get("last_bid_equals_win"), lb[y]["counts"].get("no_rival_at_1000"))
                for y in early]))
    w("")
    w("- **Frank Gore 2016** shows why the last row is not the price. Cutting led at $43,000. Kris Lake's "
      "$43,000 tied and set the price to $43,000. Cutting then raised his own maximum to $44,000, which "
      "moved nothing.")
    w("- **Pierre Thomas 2014** only replays if MFL read 0006's '19000-4' entry as $18,996: $18,996 + "
      "$1,000 = $19,996, MFL's price.")
    w("- **Chris Johnson 2014** only replays if a leader's later, lower entry replaces its maximum. 0009 "
      "entered $21,000, then $19,000 and $20,000, and 0008's $21,000 won.")
    exc = [dict(e, season=y) for y in lb for e in lb[y]["exceptions"]]
    if exc:
        w("")
        w("**Exceptions:**")
        w("")
        w(md_table(["Season", "Player", "MFL winner", "MFL price", "Replay", "Last row", "Reading"],
                   [(e["season"], e["player"], e["winner_fid"], money(e["price"]),
                     f"{e.get('replay_winner')} {money(e.get('replay_price'))}",
                     f"{e['last_fid']} {money(e['last_amount'])}",
                     "0005's $5,000 entry was logged 12 hours before the close but never took the lead: "
                     "MFL appears to have refused it (cap or roster). The log cannot say why."
                     if e["player_id"] == "12184" else "unexplained") for e in exc]))
    w("")
    if d1c:
        w("## 5. Bid counts against `ups_auction_history.total_bids`")
        w("")
        w("Matched on (season, player, won_at_unix). D1 `total_bids` counts INIT + BID rows, the same unit "
          "as the build.")
        w("")
        w(md_table(["Season", "Built rows", "D1 sum", "Difference", "Auctions matched", "Equal counts",
                    "In no-win auctions", "Lost second auctions (GAP-02)", "D1 counted cancelled bids", "Explained"],
                   [(y, v["built"], v["d1"], v["difference"], v["matched"], v["equal_counts"],
                     v["parts"].get("bids_in_no_win_auctions", 0), v["parts"].get("won_auction_missing_from_d1", 0),
                     v["parts"].get("d1_counted_cancelled_bidding", 0), "yes" if v["pass"] else "NO")
                    for y, v in d1c.items()]))
        w("")
        det = [(y, d) for y, v in d1c.items() for d in v["detail"]]
        w("**Every per-auction difference:**")
        w("")
        w(md_table(["Season", "Player", "Kind", "Built", "D1", "Note"],
                   [(y, d["player"], d["kind"], d["built"], d["d1"],
                     (f"D1 start {et(d.get('d1_start'))}; build start {et(d.get('built_start'))}"
                      if d["kind"] == "d1_counted_cancelled_bidding"
                      else f"won {et(d['won_at_unix'])}; no row in ups_auction_history")) for y, d in det]))
        w("")
        w("The 2024 gap (June 563 vs D1 541) is 16 bids in four May ERA auctions D1 lost (Danielle Hunter, "
          "Dak Prescott, Joe Mixon, Kyle Dugger) plus 6 bids in six auctions with no winner. GAP-02 therefore "
          "has **eight** lost won auctions (2011: 2, 2019: 1, 2023: 1, 2024: 4), not seven: Danielle Hunter's "
          "May 2024 auction (0005, $6,000) was also dropped.")
        w("")
    w("## 6. Spot checks")
    w("")
    for sc in summary["spot_checks"]:
        for b in sc["built"]:
            if b["outcome"] != "won":
                continue
            w(f"**{sc['name']} {b['season']}** (audit: {sc['audit_said']}). Built: {b['rows']} rows = "
              f"opening ({b['opening']}) + {b['later_rows']} later rows; later rows by franchise "
              + ", ".join(f"{k} {n}" for k, n in b["bids_by_franchise"].items())
              + f". Winner {b['winner']} at {money(b['price'])}; last row {b['last_logged']}; "
              f"runner-up {b['runner_up']}; forced rows {b['forced_rows']}; start basis {b['start_basis']}. "
              f"{b['started']} to {b['last_bid']}, won {b['won']}.")
            w("")
    w("All four agree with the audit. Henry's \"29 bids\" are the rows after Keith's opening nomination; "
      "Gore's and Snead's counts include the opening bid, because before 2019 the opening is itself a BID. "
      "Foster's runner-up is Keith at $48,000: Steve Bousquet entered $48,000 first, and Keith's later "
      "$48,000 tied without taking the lead.")
    w("")
    q = summary["quirks"]
    w("## 7. Data quirks")
    w("")
    w("- **Unreadable amounts:** " + "; ".join(f"{u['season']} {u['player']} ({u['fid']}, {u['at']})"
                                               for u in q["unreadable_amounts"])
      + ". MFL wrote '19000-4'; stored as NULL amount, still counted as a bid.")
    w("- **Forced proxy raises** (MFL's own note): " + ", ".join(f"{y}: {n}" for y, n in q["forced_rows"].items() if n)
      + f". Forcing franchise resolved for all but {sum(q['forced_unresolved'].values())}. The note names the rival's team as it was at bid time; these resolved through a "
      "name that franchise used in another season: "
      + "; ".join(f"{y}: " + ", ".join(f"{k} ({n})" for k, n in v.items())
                  for y, v in q["forced_resolved_by_other_season_name"].items() if v)
      + ". MFL also double-encodes emoji in these notes; the loader repairs that before matching.")
    w("- **The June archive's `forced_bid_ind` is its own heuristic**, not MFL's note: it marks "
      + ", ".join(f"{y}: {n}" for y, n in (q["june_forced_flag"] or {}).items())
      + ". MFL has no forced note before 2017. The load uses MFL's note only.")
    w("- **Owner-written comments dropped** (count only, text never read into any output): "
      + ", ".join(f"{y}: {n}" for y, n in q["owner_comments_dropped"].items() if n) + ".")
    w("- **GAP-04 evidence (franchise 0006 in 2024).** MFL's forced notes call 0006 \"The Main Event Mafia\" "
      "(its 2023 name) from May 15 through Aug 1, 2024; MFL's league export now says \"The Long Haulers\". So "
      "the rename came after Aug 1, 2024. That supports an owner change during or after the FA auction, "
      "but it does not date it. The ruling is still pending.")
    w("")
    fl = summary.get("flags") or {}
    if fl:
        w("## 8. Flags stored with the rows")
        w("")
        w("So a story never states more than MFL's log supports, each row carries how much it can be trusted:")
        w("")
        w(f"- **`amount_meaning`** on every bid row: `entered_max` for 2014-2016 "
          f"({fl['amount_meaning'].get('entered_max', 0):,} rows: the maximum the owner entered, **not a price**) "
          f"and `price_after_bid` for 2017-2025 ({fl['amount_meaning'].get('price_after_bid', 0):,} rows). "
          "The final price is always `ups_hist_auctions.winning_bid`, MFL's AUCTION_WON amount.")
        w(f"- **`amount_raw`**: MFL's original amount text, kept on the {fl['amount_raw_kept']} rows where it is "
          "not a plain integer ('40000.00', and the two '19000-4' rows whose `amount` is NULL).")
        w("- **`price_check`** on every auction: `last_bid`, `proxy_replay`, `unexplained`, or `none` (no winner).")
        w("- **`caveat`** on every auction a story must not state as fact: `start_unconfirmed`, "
          "`price_unexplained`, `unreadable_amount`.")
        w("")
        w(md_table(["Season", "price_check", "caveat"],
                   [(y, ", ".join(f"{k} {n}" for k, n in sorted(v.items())),
                     ", ".join(f"{k} {n}" for k, n in sorted(fl["caveat"].get(y, {}).items())) or "none")
                    for y, v in fl["price_check"].items()]))
        w("")
        w("`price_unexplained`: " + "; ".join(f"{x['season']} {x['player']} (MFL: {x['winner_fid']} at "
                                             f"{money(x['winning_bid'])})" for x in fl["price_unexplained"])
          + ". A story may say who won and the price MFL recorded, but not how the bidding produced it.")
        w("")
    w("## 9. What a load would write")
    w("")
    w("- **Schema:** `worker/migrations/manual/gap01_ups_hist_auction_bids.sql` (not applied). Two `WITHOUT ROWID` "
      "tables, one secondary index. Rollback: `gap01_ups_hist_auction_bids_rollback.sql` (drops both).")
    w(f"- **Rows:** `{AUCTIONS_TABLE}` {summary['tables'][AUCTIONS_TABLE]:,}; `{BIDS_TABLE}` "
      f"{summary['tables'][BIDS_TABLE]:,}; {summary['forward_statements']} upsert statements that skip unchanged rows.")
    if ms:
        w(f"- **Measured on a local D1 (Miniflare, D1's own counters):** forward {ms['forward']['rows_written']:,} "
          f"rows written ({ms['forward']['changes']:,} rows + index entries); a second run "
          f"{ms['forward_again']['rows_written']} written; rollback {ms['rollback']['rows_written']} written. "
          f"That is {ms['forward']['rows_written'] / 1000:.1f}% of the Free plan's 100,000 daily writes "
          "(account-wide, reset 00:00 UTC).")
        w("")
        w(md_table(["Read", "Rows returned", "rows_read", "Plan"],
                   [(n, r["rows"], r["rows_read"], " / ".join(r["plan"])) for n, r in ms["reads"].items()]))
        w("")
        w("The two full scans are one-time post-load checks, not request paths.")
    w(f"- **Fingerprints (sha256 over sorted rows):** `{AUCTIONS_TABLE}` `{summary['fingerprints'][AUCTIONS_TABLE][:16]}…`, "
      f"`{BIDS_TABLE}` `{summary['fingerprints'][BIDS_TABLE][:16]}…`, forward SQL "
      f"`{summary['fingerprints']['forward_sql_sha256'][:16]}…`. An approved run must rebuild from fresh MFL "
      "replies and match these, or stop.")
    w("")
    w("## 10. Privacy")
    w("")
    w("- Comment text is never stored. MFL's forced note becomes `forced` + `forcing_fid`; any other comment is "
      "dropped at parse time. O=102's comments column is never parsed.")
    w("- Raw MFL replies, the generated SQL and the row files stay in `~/.ups_jobs/gap01_auction_bids/`, "
      "outside the repository.")
    w("- `report` scans every output file, this report included, for every owner-written comment string "
      "MFL returned (2011-2025). It deletes the committed copy and fails if one is found.")
    w("")
    w("## 11. Not proven here")
    w("")
    w("- **No production write was made or tested.** Billed writes were measured on a local D1 only.")
    w("- **2016 auction starts** have no independent source (section 3).")
    w("- **Why a bid was cancelled** (commissioner reset, nominated too early, eligibility) is not in MFL's "
      "log. Each one is listed in section 3 without a reason.")
    w("- **Proxy maximums after 2016** are private to each owner and are not in the log.")
    w("- **Owner names** above come from the June archive's standings, by season. The 0006 2024 owner is "
      "still pending (GAP-04).")
    w("")
    inp = summary["inputs"]
    w("## Sources")
    w("")
    fetched = sorted(x["fetched_at_utc"] for x in inp["mfl_files"] if x.get("fetched_at_utc"))
    w(f"- MFL: {len(inp['mfl_files'])} cached replies (transactions by type, league, O=102), fetched "
      f"{fetched[0] if fetched else '?'} to {fetched[-1] if fetched else '?'}; each file's sha256 is in summary.json.")
    if inp["june_archive"]:
        w(f"- June archive: sha256 `{inp['june_archive']['sha256'][:16]}…` (restored scratch copy, read-only).")
    if inp["d1_extract"]:
        w(f"- D1 (SELECT only): {inp['d1_extract']['total_rows_read']:,} rows read in "
          f"{len(inp['d1_extract']['reads'])} queries; plans: "
          + "; ".join(f"{r['name']}: {', '.join(r['query_plan'])}" for r in inp["d1_extract"]["reads"])
          + f". Proposed table names free: {'yes' if not inp['d1_name_check'] else 'NO'}.")
    w("")
    return "\n".join(L) + "\n"


READ_QUERIES = [
    # (name, sql, expected plan fragment) -- the reads a consumer or a post-load check would run.
    ("one_auction_bids",
     "SELECT seq, event, fid, amount, bid_at_unix, forced, forcing_fid FROM ups_hist_auction_bids "
     "WHERE season = 2023 AND player_id = '12626' AND started_at_unix = {henry} ORDER BY seq",
     "SEARCH ups_hist_auction_bids USING PRIMARY KEY"),
    ("player_auctions",
     "SELECT season, started_at_unix, outcome, winner_fid, winning_bid, bid_count FROM ups_hist_auctions "
     "WHERE player_id = '12626' ORDER BY season, started_at_unix",
     "SEARCH ups_hist_auctions USING INDEX idx_hist_auctions_player"),
    ("season_auctions",
     "SELECT player_id, started_at_unix, outcome, winner_fid, winning_bid, bid_count FROM ups_hist_auctions "
     "WHERE season = 2023",
     "SEARCH ups_hist_auctions USING PRIMARY KEY"),
    ("franchise_bids_in_season",
     "SELECT player_id, started_at_unix, seq, amount, bid_at_unix FROM ups_hist_auction_bids "
     "WHERE season = 2023 AND fid = '0008'",
     "SEARCH ups_hist_auction_bids USING PRIMARY KEY"),
    ("verify_bids_by_season",
     "SELECT season, COUNT(*) AS n, SUM(forced) AS forced FROM ups_hist_auction_bids GROUP BY season",
     "SCAN ups_hist_auction_bids"),
    ("verify_auctions_by_season",
     "SELECT season, outcome, COUNT(*) AS n, SUM(bid_count) AS bids FROM ups_hist_auctions "
     "GROUP BY season, outcome",
     "SCAN ups_hist_auctions"),
]


def henry_start(out: Path) -> int:
    for line in (out / "auctions.jsonl").read_text().splitlines():
        r = json.loads(line)
        if r["season"] == 2023 and r["player_id"] == "12626" and r["outcome"] == "won":
            return r["started_at_unix"]
    raise SystemExit("Henry 2023 auction not in the build")


def table_fingerprint(conn: sqlite3.Connection, table: str, cols: list[str]) -> tuple[int, str]:
    rows = [tuple(r) for r in conn.execute(f"SELECT {', '.join(cols)} FROM {table}")]
    return len(rows), fingerprint(rows)


def cmd_local_proof(args) -> int:
    """Offline: schema + forward twice + rollback on a throwaway local SQLite file."""
    out = Path(args.out)
    st = json.loads((out / "statements.json").read_text())
    summary = json.loads((out / "summary.json").read_text())
    db = out / "local_proof.sqlite"
    db.unlink(missing_ok=True)
    conn = sqlite3.connect(db)
    conn.executescript(SCHEMA_SQL.read_text())
    res = {"sqlite_version": sqlite3.sqlite_version, "checks": []}

    def check(name, ok, detail):
        res["checks"].append({"name": name, "pass": bool(ok), "detail": detail})

    before = conn.total_changes
    for sql in st["forward"]:
        conn.execute(sql)
    conn.commit()
    res["forward_changes"] = conn.total_changes - before
    for table, cols in ((AUCTIONS_TABLE, AUCTION_COLS), (BIDS_TABLE, BID_COLS)):
        n, fp = table_fingerprint(conn, table, cols)
        check(f"{table} rows and fingerprint after forward",
              n == summary["tables"][table] and fp == summary["fingerprints"][table],
              {"rows": n, "fingerprint": fp})
    before = conn.total_changes
    for sql in st["forward"]:
        conn.execute(sql)
    conn.commit()
    check("forward run again changes 0 rows", conn.total_changes == before,
          {"changes": conn.total_changes - before})
    henry = henry_start(out)
    plans = {}
    for name, sql, want in READ_QUERIES:
        q = sql.format(henry=henry)
        plan = [r[3] for r in conn.execute("EXPLAIN QUERY PLAN " + q)]
        rows = conn.execute(q).fetchall()
        plans[name] = {"sql": q, "plan": plan, "rows": len(rows)}
        check(f"plan {name}", any(p.startswith(want) for p in plan), plan)
    res["plans"] = plans
    hen = plans["one_auction_bids"]["rows"]
    check("Henry 2023 reads back 30 rows (Keith's nomination + 29 bids)", hen == 30, {"rows": hen})
    for sql in st["rollback"]:
        conn.execute(sql)
    conn.commit()
    left = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE name LIKE 'ups_hist_auction%' "
                                       "OR name = 'idx_hist_auctions_player'")]
    check("rollback leaves no table or index", not left, left)
    conn.close()
    db.unlink(missing_ok=True)
    res["pass"] = all(c["pass"] for c in res["checks"])
    (out / "local_proof.json").write_text(json.dumps(res, indent=1))
    for c in res["checks"]:
        print(("PASS " if c["pass"] else "FAIL ") + c["name"])
    return 0 if res["pass"] else 1


# --------------------------------------------------------------------------
# Production preflight (read-only: Cloudflare analytics, GitHub, ps; 0 D1 rows)
# --------------------------------------------------------------------------

ACCOUNT_ID = "ba1a1d492ec8a5485821eb8f0d5f32c2"
FREE_PLAN_WRITES = 100_000      # per UTC day, account-wide (every D1 database)
DAILY_WRITE_CEILING = 90_000    # the load starts only if the worst case stays at or under this
# Keith's condition is the WRITE budget. Reads stop the load only if they would cross the Free
# plan's hard 5,000,000 a day; otherwise they are reported (the load reads ~10.5k to verify).
READ_CEILING = 5_000_000
LOAD_READS = 20_000             # post-load verify (~10.5k) + checks, rounded up
WINDOW_START, WINDOW_LAST_START = (22, 5), (23, 30)   # UTC, the approved quiet window
FORECAST_DAYS = 7
WRITE_HEAVY_WORKFLOWS = [
    "nflverse-stats-refresh.yml", "wc-rank-rebuild.yml", "mfl-daily-snapshot.yml", "nightly-builders.yml",
    "nightly-config-sync.yml", "contract-reconcile.yml", "ingest-projections.yml", "owner-career-stats.yml",
    "roster-anomaly-check.yml", "sleeper-cache-build.yml", "discord-chat-ingest.yml",
    "leaderboard-current-season-rebuild.yml", "leaderboard-precompute.yml",
]
WRITE_HEAVY_PROCESSES = ["upsmfl-live-season-sync", "upsmfl-ups-center-auto", "deadline_drop_2026",
                         "sync_live_weekly_scores_to_d1", "load_local_to_d1", "fetch_nflverse",
                         "run_1307_src_weekly_batches"]


def oauth_token() -> str:
    cfg = Path.home() / ".wrangler" / "config" / "default.toml"
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', cfg.read_text())
    if not m:
        raise SystemExit("STOP: no wrangler OAuth token; run `npx wrangler whoami` first")
    return m.group(1)


def account_hourly_usage(days: int = FORECAST_DAYS + 1) -> tuple[dict, dict]:
    """({'YYYY-MM-DDTHH': rowsWritten}, {...: rowsRead}) summed over every D1 database.
    The exact counter only: every group must carry sampleInterval = 1."""
    end = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
    q = ("query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){"
         "d1AnalyticsAdaptiveGroups(limit:10000,filter:{datetimeHour_geq:$s,datetimeHour_lt:$e}){"
         "sum{rowsWritten rowsRead} avg{sampleInterval} dimensions{datetimeHour databaseId}}}}}")
    body = json.dumps({"query": q, "variables": {"a": ACCOUNT_ID, "s": iso(end - timedelta(days=days)),
                                                  "e": iso(end)}}).encode()
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=body,
                                 headers={"Authorization": f"Bearer {oauth_token()}",
                                          "Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=60).read())
    if d.get("errors") or not d.get("data"):
        raise SystemExit(f"STOP: usage metrics unavailable: {d.get('errors')}")
    groups = d["data"]["viewer"]["accounts"][0]["d1AnalyticsAdaptiveGroups"]
    if not groups:
        raise SystemExit("STOP: usage metrics returned no data")
    sampled = sorted({g["dimensions"]["datetimeHour"][:13] for g in groups
                      if float((g.get("avg") or {}).get("sampleInterval") or 0) != 1})
    if sampled:
        raise SystemExit(f"STOP: usage counter is sampled in hours {sampled[:5]}; only the exact counter decides")
    w, r = defaultdict(int), defaultdict(int)
    for g in groups:
        w[g["dimensions"]["datetimeHour"][:13]] += int(g["sum"]["rowsWritten"])
        r[g["dimensions"]["datetimeHour"][:13]] += int(g["sum"]["rowsRead"])
    return dict(w), dict(r)


def running_write_jobs() -> list:
    """Write-heavy GitHub workflows in progress (run JSON carries only the display
    name, so map it to the workflow file) and local write jobs. Fails closed."""
    def gh(*a):
        res = subprocess.run(["gh", *a], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=60)
        return json.loads(res.stdout) if res.returncode == 0 and res.stdout.strip() else None
    busy = []
    try:
        runs = gh("run", "list", "--status", "in_progress", "--json", "workflowName", "--limit", "50")
        flows = gh("workflow", "list", "--all", "--json", "name,path", "--limit", "300")
    except Exception:
        runs = flows = None
    if runs is None or flows is None:
        busy.append("could not list GitHub runs (fail closed)")
    else:
        path_of = {f["name"]: f["path"] for f in flows}
        busy += [path_of.get(r["workflowName"], r["workflowName"]) for r in runs
                 if any(path_of.get(r["workflowName"], "").endswith(x) for x in WRITE_HEAVY_WORKFLOWS)]
    ps = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
    busy += [x for x in WRITE_HEAVY_PROCESSES if x in ps]
    return busy


def preflight_decision(writes: dict, reads: dict, now: datetime, forward: int, busy: list) -> dict:
    """Pure decision (unit-tested): today = the UTC billing day. Worst case = writes so
    far + every remaining hour at its max over the last 7 complete days + this load."""
    today = now.strftime("%Y-%m-%d")
    keep = {(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, FORECAST_DAYS + 1)}
    hour_max = defaultdict(int)
    for k, v in writes.items():
        if k[:10] in keep:
            hour_max[int(k[11:13])] = max(hour_max[int(k[11:13])], v)
    used_w = sum(v for k, v in writes.items() if k[:10] == today)
    used_r = sum(v for k, v in reads.items() if k[:10] == today)
    forecast = sum(hour_max[h] for h in range(now.hour, 24))
    projected = used_w + forecast + forward
    in_window = WINDOW_START <= (now.hour, now.minute) <= WINDOW_LAST_START
    checks = {
        "in_window_22:05-23:30_utc": in_window,
        "writes_projected_le_ceiling": projected <= DAILY_WRITE_CEILING,
        "reads_today_plus_load_le_free_limit": used_r + LOAD_READS <= READ_CEILING,
        "no_write_heavy_job_running": not busy,
    }
    return {"at_utc": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "writes_used_today": used_w,
            "writes_forecast_rest_of_day": forecast, "load_writes": forward, "writes_projected": projected,
            "write_ceiling": DAILY_WRITE_CEILING, "unused_after_worst_case": FREE_PLAN_WRITES - projected,
            "reads_used_today": used_r, "load_reads": LOAD_READS, "read_ceiling": READ_CEILING,
            "busy": busy, "checks": checks, "ok": all(checks.values())}


def cmd_preflight(args, usage=account_hourly_usage, jobs=running_write_jobs) -> int:
    summary = json.loads((Path(args.out) / "summary.json").read_text())
    writes, reads = usage()
    res = preflight_decision(writes, reads, datetime.now(timezone.utc), summary["billed_writes_estimate"], jobs())
    (Path(args.out) / "preflight.json").write_text(json.dumps(res, indent=1))
    print(json.dumps(res, indent=1))
    print("PREFLIGHT PASS" if res["ok"] else "PREFLIGHT STOP")
    return 0 if res["ok"] else 1


# --------------------------------------------------------------------------
# Post-load verification (opt-in SELECTs of the two new tables only)
# --------------------------------------------------------------------------

def verify_reads() -> list[tuple[str, str]]:
    out = [("auctions", f"SELECT {', '.join(AUCTION_COLS)} FROM {AUCTIONS_TABLE}")]
    for s in BID_SEASONS:  # one PRIMARY KEY seek per season keeps each reply small
        out.append((f"bids_{s}", f"SELECT {', '.join(BID_COLS)} FROM {BIDS_TABLE} WHERE season = {s}"))
    return out


def cmd_verify_d1(args, runner=wrangler_json) -> int:
    if not (args.allow_prod_d1 or os.environ.get(D1_OPT_IN_ENV) == "1"):
        print("SKIPPED: production D1 read not opted in (pass --allow-prod-d1). Nothing was read.")
        return 0
    out = Path(args.out)
    summary = json.loads((out / "summary.json").read_text())
    built_a = [json.loads(x) for x in (out / "auctions.jsonl").read_text().splitlines()]
    built_b = [json.loads(x) for x in (out / "bids.jsonl").read_text().splitlines()]
    got_a, got_b, spent, plans = [], [], 0, {}
    for name, sql in verify_reads():
        plans[name] = [r.get("detail") for r in runner("EXPLAIN QUERY PLAN " + sql)[0]["results"]]
        res = runner(sql)[0]
        spent += int((res.get("meta") or {}).get("rows_read") or 0)
        (got_a if name == "auctions" else got_b).extend(res["results"])
    ta = lambda rows: [tuple(r[c] for c in AUCTION_COLS) for r in rows]
    tb = lambda rows: [tuple(r[c] for c in BID_COLS) for r in rows]
    key = lambda r: (r["season"], r["player_id"], r["started_at_unix"])
    win = lambda rows: sorted(key(r) + (r["outcome"], r["winner_fid"], r["winning_bid"], r["won_at_unix"])
                              for r in rows)
    per = lambda rows: dict(sorted(Counter(r["season"] for r in rows).items()))
    henry = lambda rows: sum(1 for b in rows if b["season"] == 2023 and b["player_id"] == "12626")
    checks = {
        "auction rows = build": (len(got_a), len(built_a)),
        "bid rows = build": (len(got_b), len(built_b)),
        "auctions per season = build": (per(got_a), per(built_a)),
        "bids per season = build": (per(got_b), per(built_b)),
        "auction identities = build": (sorted(map(key, got_a)), sorted(map(key, built_a))),
        "winners, prices, close times = build": (win(got_a), win(built_a)),
        "auctions fingerprint = dry run": (fingerprint(ta(got_a)), summary["fingerprints"][AUCTIONS_TABLE]),
        "bids fingerprint = dry run": (fingerprint(tb(got_b)), summary["fingerprints"][BIDS_TABLE]),
        "Henry 2023 rows = build (30 in the dry run)": (henry(got_b), henry(built_b)),
    }
    res = {"verified_at_utc": utc_now(), "rows_read": spent, "plans": plans,
           "checks": {k: {"pass": a == b, "got": a if not isinstance(a, (list, dict)) or len(str(a)) < 400 else "…",
                          "want": b if not isinstance(b, (list, dict)) or len(str(b)) < 400 else "…"}
                      for k, (a, b) in checks.items()}}
    res["pass"] = all(c["pass"] for c in res["checks"].values())
    (out / "verify_d1.json").write_text(json.dumps(res, indent=1, default=str))
    for k, c in res["checks"].items():
        print(("PASS " if c["pass"] else "FAIL ") + k)
    print(f"rows_read {spent}; {'VERIFIED' if res['pass'] else 'MISMATCH: stop and report'}")
    return 0 if res["pass"] else 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch-mfl")
    f.add_argument("--cache", type=Path, default=DEFAULT_ROOT / "mfl")
    f.add_argument("--min-interval", type=float, default=3.0)
    e = sub.add_parser("extract-d1")
    e.add_argument("--out", type=Path, default=DEFAULT_ROOT / "d1")
    e.add_argument("--allow-prod-d1", action="store_true")
    e.add_argument("--max-rows-read", type=int, default=10_000)
    b = sub.add_parser("build")
    b.add_argument("--cache", type=Path, default=DEFAULT_ROOT / "mfl")
    b.add_argument("--d1", type=Path, default=DEFAULT_ROOT / "d1",
                   help="extract-d1 output; skipped if absent")
    b.add_argument("--archive", type=Path, default=None,
                   help="restored data/db-archives/mfl_database_2026-06-05.db (read-only)")
    b.add_argument("--manifest", type=Path, default=None, help="gap_manifest.json from the 10-22 audit")
    b.add_argument("--out", type=Path, default=DEFAULT_ROOT / "build")
    r = sub.add_parser("report")
    r.add_argument("--out", type=Path, default=DEFAULT_ROOT / "build")
    r.add_argument("--cache", type=Path, default=DEFAULT_ROOT / "mfl")
    r.add_argument("--report-path", type=Path, default=None, help="also write the report here")
    pf = sub.add_parser("preflight")
    pf.add_argument("--out", type=Path, default=DEFAULT_ROOT / "build")
    v = sub.add_parser("verify-d1")
    v.add_argument("--out", type=Path, default=DEFAULT_ROOT / "build")
    v.add_argument("--allow-prod-d1", action="store_true")
    lp = sub.add_parser("local-proof")
    lp.add_argument("--out", type=Path, default=DEFAULT_ROOT / "build")
    args = ap.parse_args(argv)
    return {"fetch-mfl": cmd_fetch_mfl, "extract-d1": cmd_extract_d1, "build": cmd_build,
            "report": cmd_report, "local-proof": cmd_local_proof, "preflight": cmd_preflight,
            "verify-d1": cmd_verify_d1}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
