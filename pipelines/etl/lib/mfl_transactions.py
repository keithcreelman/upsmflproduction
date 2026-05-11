"""
MFL TYPE=transactions API client + canonical event parser.

The local DB's transactions tables have ingestion gaps (notably trades
2012-2014 era — see Daniels 2012 case). MFL's TYPE=transactions endpoint
is the canonical source. This module fetches per (year, league_id) and
normalizes into a uniform event record so cycle pairing can run on
clean canonical data.

Event record format (uniform across all transaction types):
  {
    "year":               int,
    "timestamp":          int (epoch),
    "ts_iso":             str (YYYY-MM-DD HH:MM:SS),
    "transaction_type":   str (MFL type),
    "franchise_id":       str (the 'primary' franchise — receiver/holder),
    "franchise2_id":      str | None (counterparty for trades),
    "player_id":          str,
    "action":             "add" | "drop" | "trade_in" | "trade_out" | "ir_activate" | "ir_deactivate" | "taxi_demote" | "taxi_promote" | "draft_pick",
    "salary":             int | None (for AUCTION_WON; cents-aware MFL int),
    "comments":           str | None,
    "transaction_id":     str (synthesized; "{type}_{timestamp}_{player_id}_{franchise_id}_{action}"),
  }

A single MFL transaction (e.g., a trade with 4 assets, or an FA pickup
that includes a corresponding drop) expands into MULTIPLE event records.

Skip categories (no cycle effect, no event emitted):
  - LOCK_ALL_PLAYERS / UNLOCK_ALL_PLAYERS  (league-wide ops)
  - LOAD_ROSTERS                           (initial roster load — bulk add not a transaction)
  - AUCTION_BID                            (a bid is not a roster change)
  - AUCTION_INIT                           (auction process metadata)
  - PROCESS_WAIVERS / BBID_PROCESS_WAIVERS (process events; per-player effects come via BBID_WAIVER)
"""

from __future__ import annotations

import csv
import json
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import urlencode
from urllib.request import Request, urlopen


SKIP_TYPES = {
    "LOCK_ALL_PLAYERS", "UNLOCK_ALL_PLAYERS", "LOAD_ROSTERS",
    "AUCTION_BID", "AUCTION_INIT",
    "PROCESS_WAIVERS", "BBID_PROCESS_WAIVERS", "BBID_AUTO_PROCESS_WAIVERS",
}


@dataclass
class SeasonInfo:
    year: int
    server: str
    league_id: str


def load_seasons(seasons_csv: Path) -> list[SeasonInfo]:
    """Read seasons.csv → list of SeasonInfo."""
    out = []
    with seasons_csv.open() as f:
        reader = csv.DictReader(f)
        for row in reader:
            out.append(SeasonInfo(
                year=int(row["season"]),
                server=row["server"],
                league_id=row["league_id"],
            ))
    return out


def fetch_year_transactions(season: SeasonInfo, api_key: str | None = None,
                             timeout: int = 30) -> list[dict]:
    """Fetch raw MFL transactions for one (year, league_id) using the
    season-specific server (per seasons.csv). Returns the raw transaction
    list.
    """
    params = {"TYPE": "transactions", "L": season.league_id, "JSON": "1"}
    if api_key:
        params["APIKEY"] = api_key
    url = f"https://{season.server}.myfantasyleague.com/{season.year}/export?{urlencode(params)}"
    req = Request(url, headers={"User-Agent": "ups-mfl-cap-backfill/1.0"})
    with urlopen(req, timeout=timeout) as r:
        data = json.loads(r.read().decode())
    items = data.get("transactions", {}).get("transaction", [])
    if isinstance(items, dict):
        items = [items]
    return items


def _split_player_csv(s: str) -> list[str]:
    """MFL transaction.transaction format: player IDs separated by commas
    with trailing comma, e.g., '14817,16675,'."""
    if not s:
        return []
    parts = [p.strip() for p in s.split(",") if p.strip()]
    return parts


def _split_assets(s: str) -> tuple[list[str], list[str]]:
    """MFL trade gave_up format: player IDs and FP_<owner>_<year>_<round>
    pick references mixed, comma-separated. Return (player_ids, pick_strs).
    Picks are NOT cycle-relevant (only player movement starts/ends cycles).
    """
    players, picks = [], []
    for asset in _split_player_csv(s):
        if asset.startswith("FP_"):
            picks.append(asset)
        elif asset.isdigit():
            players.append(asset)
        else:
            # Unknown asset format — log to picks defensively
            picks.append(asset)
    return players, picks


def _ts_iso(epoch_str: str) -> str:
    try:
        dt = datetime.fromtimestamp(int(epoch_str), tz=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return ""


def parse_year(year: int, raw_transactions: list[dict]) -> Iterator[dict]:
    """Normalize raw MFL transactions for a year into uniform event records.

    Yields events. A single raw transaction can yield multiple events
    (e.g., a 4-player trade = 8 events: 4 trade_out + 4 trade_in).
    """
    for raw in raw_transactions:
        ttype = raw.get("type", "")
        if ttype in SKIP_TYPES:
            continue
        ts = raw.get("timestamp", "")
        ts_iso = _ts_iso(ts)
        ts_epoch = int(ts) if ts and ts.isdigit() else 0
        comments = raw.get("comments") or None

        if ttype == "TRADE":
            # Two franchises swap assets. Emit trade_in + trade_out per player.
            f1 = raw.get("franchise") or ""
            f2 = raw.get("franchise2") or ""
            f1_gave = raw.get("franchise1_gave_up") or ""
            f2_gave = raw.get("franchise2_gave_up") or ""

            f1_players, _ = _split_assets(f1_gave)
            f2_players, _ = _split_assets(f2_gave)

            # Players f1 gave up move FROM f1 TO f2.
            for pid in f1_players:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, f1, f2, pid,
                    "trade_out", None, comments,
                )
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, f2, f1, pid,
                    "trade_in", None, comments,
                )
            # Players f2 gave up move FROM f2 TO f1.
            for pid in f2_players:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, f2, f1, pid,
                    "trade_out", None, comments,
                )
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, f1, f2, pid,
                    "trade_in", None, comments,
                )
            continue

        if ttype == "AUCTION_WON":
            # transaction = "<player_id>|<salary>"
            txn = raw.get("transaction") or ""
            franchise = raw.get("franchise") or ""
            pid, _, sal = txn.partition("|")
            pid = pid.strip()
            try:
                salary = int(sal.strip()) if sal.strip().isdigit() else None
            except ValueError:
                salary = None
            if pid:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "add", salary, comments,
                )
            continue

        if ttype == "BBID_WAIVER":
            # 3-field format: "<adds_csv>|<bid_amount>|<drops_csv>"
            # The bid amount is metadata; cycle pairing only needs adds + drops.
            txn = raw.get("transaction") or ""
            franchise = raw.get("franchise") or ""
            parts = txn.split("|")
            adds_csv = parts[0] if len(parts) > 0 else ""
            drops_csv = parts[2] if len(parts) > 2 else ""
            adds = _split_player_csv(adds_csv)
            drops = _split_player_csv(drops_csv)
            for pid in adds:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "add", None, comments,
                )
            for pid in drops:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "drop", None, comments,
                )
            continue

        if ttype in ("FREE_AGENT", "WAIVER"):
            # 2-field format: "<adds_csv>|<drops_csv>"
            txn = raw.get("transaction") or ""
            franchise = raw.get("franchise") or ""
            adds_csv, _, drops_csv = txn.partition("|")
            adds = _split_player_csv(adds_csv)
            drops = _split_player_csv(drops_csv)
            for pid in adds:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "add", None, comments,
                )
            for pid in drops:
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "drop", None, comments,
                )
            continue

        if ttype == "IR":
            # IR has activated / deactivated CSVs
            franchise = raw.get("franchise") or ""
            for pid in _split_player_csv(raw.get("activated") or ""):
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "ir_activate", None, comments,
                )
            for pid in _split_player_csv(raw.get("deactivated") or ""):
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "ir_deactivate", None, comments,
                )
            continue

        if ttype == "TAXI":
            # TAXI uses promoted / demoted CSVs
            franchise = raw.get("franchise") or ""
            for pid in _split_player_csv(raw.get("promoted") or ""):
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "taxi_promote", None, comments,
                )
            for pid in _split_player_csv(raw.get("demoted") or ""):
                yield _mk_event(
                    year, ts_epoch, ts_iso, ttype, franchise, None, pid,
                    "taxi_demote", None, comments,
                )
            continue

        # Fallback for unknown types — yield a flagged event so we can
        # surface them.
        yield {
            "year": year,
            "timestamp": ts_epoch,
            "ts_iso": ts_iso,
            "transaction_type": ttype,
            "franchise_id": raw.get("franchise") or "",
            "franchise2_id": None,
            "player_id": "",
            "action": "_unknown",
            "salary": None,
            "comments": comments,
            "transaction_id": f"{ttype}_{ts}_unknown",
            "_raw": raw,
        }


def _mk_event(year, ts, ts_iso, ttype, f1, f2, pid, action, salary, comments) -> dict:
    return {
        "year": year,
        "timestamp": ts,
        "ts_iso": ts_iso,
        "transaction_type": ttype,
        "franchise_id": f1,
        "franchise2_id": f2,
        "player_id": pid,
        "action": action,
        "salary": salary,
        "comments": comments,
        "transaction_id": f"{ttype}_{ts}_{pid}_{f1}_{action}",
    }


def fetch_and_parse_all_seasons(seasons: list[SeasonInfo],
                                  api_key: str | None = None,
                                  delay_seconds: float = 0.5) -> dict[int, list[dict]]:
    """Pull + normalize all seasons. Polite delay between API calls."""
    out = {}
    for season in seasons:
        raw = fetch_year_transactions(season, api_key=api_key)
        events = list(parse_year(season.year, raw))
        out[season.year] = events
        time.sleep(delay_seconds)
    return out
