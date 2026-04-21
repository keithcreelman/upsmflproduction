"""
mfl_write_client.py — Thin wrapper around MFL's POST/import endpoints.

Supports the write endpoints needed by the Rookie Draft Hub:
  - draftResults   : submit an individual draft pick
  - tradeProposal  : propose a trade
  - tradeResponse  : accept or decline a proposed trade
  - myDraftList    : set a franchise's personal pre-draft board

All calls use MFL's `/YEAR/import?TYPE=...&L=...&APIKEY=...` form-urlencoded pattern.

Auth: a league-wide API key is used for all reads/writes. For franchise-specific
writes (e.g., submitting a pick for franchise 0005), MFL may additionally require
the franchise-owner's MFL_USER_ID cookie. This module exposes both paths.

CLI:
    python3 mfl_write_client.py pick --franchise 0005 --player 12345
    python3 mfl_write_client.py trade --from 0005 --to 0006 \\
        --give "PLAYER:12345" --receive "PLAYER:67890,FP_0006_2027_2"
"""

from __future__ import annotations
import argparse
import json
import sys
from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError

LEAGUE_ID = "74598"
MFL_HOST = "https://www48.myfantasyleague.com"
MFL_APIKEY = "aRBv1sCXvuWpx0OmP13EaDoeFbox"
CURRENT_YEAR = 2026


@dataclass
class WriteResult:
    ok: bool
    status: int
    body: str
    url: str


def _post(endpoint_type: str, params: dict, year: int = CURRENT_YEAR,
          apikey: str = MFL_APIKEY, user_id: Optional[str] = None) -> WriteResult:
    """POST to MFL's import endpoint.

    MFL's convention: TYPE goes in the query string; payload goes in the body.
    Some endpoints accept GET with identical params — POST is safer for writes.
    """
    base = f"{MFL_HOST}/{year}/import"
    qs = {"TYPE": endpoint_type, "L": LEAGUE_ID, "APIKEY": apikey, "JSON": "1"}
    url = f"{base}?{urlencode(qs)}"
    body = urlencode(params).encode()
    req = Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    if user_id:
        req.add_header("Cookie", f"MFL_USER_ID={user_id}")
    try:
        with urlopen(req, timeout=30) as r:
            raw = r.read().decode(errors="replace")
            return WriteResult(ok=r.status == 200, status=r.status, body=raw, url=url)
    except HTTPError as e:
        return WriteResult(ok=False, status=e.code, body=e.read().decode(errors="replace"), url=url)
    except Exception as e:
        return WriteResult(ok=False, status=0, body=str(e), url=url)


# ── Draft pick submission ─────────────────────────────────────────────────

def submit_draft_pick(franchise_id: str, player_id: str,
                      user_id: Optional[str] = None, year: int = CURRENT_YEAR,
                      apikey: str = MFL_APIKEY) -> WriteResult:
    """Submit a single draft pick to MFL.

    MFL's draftResults import accepts: FRANCHISE_ID, PLAYER_ID.
    The pick slot is inferred from whoever is on the clock.
    """
    params = {"FRANCHISE_ID": franchise_id, "PLAYER_ID": player_id}
    return _post("draftResults", params, year=year, apikey=apikey, user_id=user_id)


# ── Trade proposal / response ─────────────────────────────────────────────

def submit_trade_proposal(from_fid: str, to_fid: str,
                          offer_assets: list[str], want_assets: list[str],
                          comments: str = "", expires_ts: Optional[int] = None,
                          user_id: Optional[str] = None,
                          year: int = CURRENT_YEAR,
                          apikey: str = MFL_APIKEY) -> WriteResult:
    """Propose a trade.

    Asset format (per MFL):
      - Player: just the numeric player id, e.g. "13593"
      - Future pick: "FP_FRANCHISE_YEAR_ROUND" e.g. "FP_0005_2027_2"
      - Current draft pick: "DP_ROUND_PICK" e.g. "DP_1_03"
      - Budget bucks / salary adjustment: "BB_amount" e.g. "BB_5000"

    Asset lists are comma-separated in the POST body.
    """
    params = {
        "FRANCHISE_ID": from_fid,
        "FRANCHISE2": to_fid,
        "WILL_GIVE_UP": ",".join(offer_assets) + ",",
        "WILL_RECEIVE": ",".join(want_assets) + ",",
        "COMMENTS": comments,
    }
    if expires_ts:
        params["EXPIRES"] = str(int(expires_ts))
    return _post("tradeProposal", params, year=year, apikey=apikey, user_id=user_id)


def respond_to_trade(offered_to_fid: str, offering_fid: str, accept: bool,
                     comments: str = "",
                     user_id: Optional[str] = None,
                     year: int = CURRENT_YEAR,
                     apikey: str = MFL_APIKEY) -> WriteResult:
    """Accept or decline a proposed trade."""
    params = {
        "FRANCHISE_ID": offered_to_fid,
        "FRANCHISE2": offering_fid,
        "ACCEPT": "Yes" if accept else "No",
        "COMMENTS": comments,
    }
    return _post("tradeResponse", params, year=year, apikey=apikey, user_id=user_id)


# ── Personal draft list ───────────────────────────────────────────────────

def update_draft_list(franchise_id: str, player_ids: list[str],
                      user_id: Optional[str] = None,
                      year: int = CURRENT_YEAR,
                      apikey: str = MFL_APIKEY) -> WriteResult:
    """Save a franchise's personal pre-draft rankings."""
    params = {
        "FRANCHISE_ID": franchise_id,
        "PLAYERS": ",".join(player_ids),
    }
    return _post("myDraftList", params, year=year, apikey=apikey, user_id=user_id)


# ── CLI ────────────────────────────────────────────────────────────────────

def _print_result(r: WriteResult):
    print(f"STATUS {r.status} ({'OK' if r.ok else 'FAIL'})")
    print(f"URL: {r.url}")
    try:
        parsed = json.loads(r.body)
        print(json.dumps(parsed, indent=2))
    except Exception:
        print(r.body[:2000])


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    pick = sub.add_parser("pick", help="Submit a draft pick")
    pick.add_argument("--franchise", required=True)
    pick.add_argument("--player", required=True)
    pick.add_argument("--user-id", default=None, help="Owner's MFL_USER_ID cookie")

    trade = sub.add_parser("trade", help="Propose a trade")
    trade.add_argument("--from", dest="from_fid", required=True)
    trade.add_argument("--to", dest="to_fid", required=True)
    trade.add_argument("--give", required=True, help="Comma list of assets to give")
    trade.add_argument("--receive", required=True, help="Comma list of assets to receive")
    trade.add_argument("--comments", default="")
    trade.add_argument("--user-id", default=None)

    resp = sub.add_parser("respond", help="Respond to a trade")
    resp.add_argument("--from", dest="from_fid", required=True,
                      help="Franchise responding (the one that received the offer)")
    resp.add_argument("--to", dest="to_fid", required=True,
                      help="Franchise that sent the original proposal")
    resp.add_argument("--accept", action="store_true")
    resp.add_argument("--comments", default="")
    resp.add_argument("--user-id", default=None)

    draft_list = sub.add_parser("draft-list", help="Set personal draft list")
    draft_list.add_argument("--franchise", required=True)
    draft_list.add_argument("--players", required=True, help="Comma list of player ids")
    draft_list.add_argument("--user-id", default=None)

    args = ap.parse_args()

    if args.cmd == "pick":
        r = submit_draft_pick(args.franchise, args.player, user_id=args.user_id)
    elif args.cmd == "trade":
        r = submit_trade_proposal(
            args.from_fid, args.to_fid,
            args.give.split(","), args.receive.split(","),
            comments=args.comments, user_id=args.user_id)
    elif args.cmd == "respond":
        r = respond_to_trade(
            args.from_fid, args.to_fid, args.accept,
            comments=args.comments, user_id=args.user_id)
    elif args.cmd == "draft-list":
        r = update_draft_list(
            args.franchise, args.players.split(","), user_id=args.user_id)
    else:
        print("Unknown command", file=sys.stderr)
        return 2

    _print_result(r)
    return 0 if r.ok else 1


if __name__ == "__main__":
    sys.exit(main())
