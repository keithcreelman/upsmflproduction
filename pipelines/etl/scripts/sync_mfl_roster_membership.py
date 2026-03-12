#!/usr/bin/env python3
"""Sync MFL roster membership through the commissioner load/unload roster page.

This is the same live flow as the MFL commissioner "Load/Unload Rosters" UI:
it fetches the current roster for one franchise, applies add/remove changes,
then posts the full desired roster back to MFL.

Examples:
  python3 sync_mfl_roster_membership.py --season 2026 --league-id 74598 \
      --franchise-id 0001 --add-player-id 14860 --cookie "$MFLTEST_COMMISHCOOKIE"

  python3 sync_mfl_roster_membership.py --season 2026 --league-id 74598 \
      --franchise-id 0001 --remove-player-id 14860 --cookie "$MFLTEST_COMMISHCOOKIE"
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Dict, Iterable, List, Sequence, Tuple
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from db_utils import DEFAULT_DB_PATH, get_conn, get_league_info  # noqa: E402


USER_AGENT = "upsmflproduction-roster-sync"


@dataclass(frozen=True)
class LoadForm:
    action_url: str
    base_fields: List[Tuple[str, str]]
    current_roster_ids: List[str]


def safe_str(value: object) -> str:
    return "" if value is None else str(value).strip()


def pad4(value: object) -> str:
    digits = "".join(ch for ch in safe_str(value) if ch.isdigit())
    return digits.zfill(4)[-4:] if digits else ""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--league-id", default=os.environ.get("MFL_LEAGUE_ID", ""))
    parser.add_argument("--franchise-id", required=True)
    parser.add_argument(
        "--cookie",
        default=os.environ.get("MFLTEST_COMMISHCOOKIE", os.environ.get("MFL_COOKIE", "")),
    )
    parser.add_argument("--db-path", default=os.environ.get("MFL_DB_PATH", DEFAULT_DB_PATH))
    parser.add_argument("--host", default="")
    parser.add_argument("--add-player-id", action="append", default=[])
    parser.add_argument("--remove-player-id", action="append", default=[])
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    args.franchise_id = pad4(args.franchise_id)
    args.add_player_id = [normalize_player_id(v) for v in args.add_player_id]
    args.remove_player_id = [normalize_player_id(v) for v in args.remove_player_id]
    args.add_player_id = [v for v in args.add_player_id if v]
    args.remove_player_id = [v for v in args.remove_player_id if v]

    if not args.franchise_id:
        parser.error("--franchise-id must contain digits")
    if not args.league_id:
        parser.error("--league-id is required (or set MFL_LEAGUE_ID)")
    if not args.cookie:
        parser.error("--cookie is required (or set MFLTEST_COMMISHCOOKIE)")
    if not args.add_player_id and not args.remove_player_id:
        parser.error("Specify at least one --add-player-id or --remove-player-id")
    return args


def normalize_cookie(raw_cookie: str) -> str:
    cookie = safe_str(raw_cookie)
    return cookie if "=" in cookie else f"MFL_USER_ID={cookie}"


def normalize_player_id(value: object) -> str:
    return "".join(ch for ch in safe_str(value) if ch.isdigit())


def normalize_host(value: object) -> str:
    host = safe_str(value).lower()
    if not host:
        return ""
    if host.endswith(".myfantasyleague.com"):
        return host
    if host.startswith("www"):
        return f"{host}.myfantasyleague.com"
    if host.isdigit():
        return f"www{host}.myfantasyleague.com"
    return host


def resolve_host(season: int, league_id: str, db_path: str, host_override: str) -> str:
    if safe_str(host_override):
        return normalize_host(host_override)
    try:
        conn = get_conn(db_path)
    except sqlite3.Error:
        conn = None
    if conn is not None:
        try:
            server, db_league_id = get_league_info(conn, season)
            league_digits = "".join(ch for ch in safe_str(league_id) if ch.isdigit())
            db_digits = "".join(ch for ch in safe_str(db_league_id) if ch.isdigit())
            if not league_digits or league_digits == db_digits:
                normalized = normalize_host(server)
                if normalized:
                    return normalized
        finally:
            conn.close()
    return "api.myfantasyleague.com"


def build_session(cookie_header: str, host: str) -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    parsed = SimpleCookie()
    parsed.load(normalize_cookie(cookie_header))
    if not parsed:
        raise RuntimeError("Could not parse MFL cookie")

    for morsel in parsed.values():
        session.cookies.set(morsel.key, morsel.value, domain=host)
    return session


def ensure_commissioner_mode(session: requests.Session, base_url: str, league_id: str) -> None:
    become_url = f"{base_url}/logout?L={league_id}&BECOME=0000"
    resp = session.get(become_url, timeout=30, allow_redirects=True)
    resp.raise_for_status()


def fetch_load_form(
    session: requests.Session,
    base_url: str,
    league_id: str,
    franchise_id: str,
) -> LoadForm:
    url = f"{base_url}/csetup?LEAGUE_ID={league_id}&FRANCHISE={franchise_id}&C=LOADROST"
    resp = session.get(url, timeout=30)
    resp.raise_for_status()
    if "Commissioner Access Required" in resp.text:
        raise RuntimeError("MFL rejected roster load page: commissioner access required")

    soup = BeautifulSoup(resp.text, "html.parser")
    form = soup.find("form")
    if form is None:
        raise RuntimeError("Could not find roster load form in MFL response")

    action_url = urljoin(resp.url, safe_str(form.get("action")))
    current_select = form.find("select", {"name": "ROSTER"})
    if current_select is None:
        raise RuntimeError("Could not find current roster selector in MFL response")

    current_roster_ids = [
        normalize_player_id(option.get("value"))
        for option in current_select.find_all("option")
        if normalize_player_id(option.get("value"))
    ]

    base_fields: List[Tuple[str, str]] = []
    seen_names = set()
    for field in form.find_all("input"):
        field_type = safe_str(field.get("type")).lower()
        name = safe_str(field.get("name"))
        if not name or field_type in {"button", "submit", "checkbox"}:
            continue
        if name in {"sel_pid", "picker_filt_name"}:
            continue
        if name in seen_names:
            continue
        seen_names.add(name)
        base_fields.append((name, safe_str(field.get("value"))))

    if "PLAYER_NAMES" not in seen_names:
        base_fields.append(("PLAYER_NAMES", ""))
    return LoadForm(
        action_url=action_url,
        base_fields=base_fields,
        current_roster_ids=current_roster_ids,
    )


def build_desired_roster(
    current_roster_ids: Sequence[str],
    add_player_ids: Iterable[str],
    remove_player_ids: Iterable[str],
) -> List[str]:
    desired: List[str] = []
    remove_set = {normalize_player_id(v) for v in remove_player_ids if normalize_player_id(v)}
    seen = set()
    for player_id in current_roster_ids:
        pid = normalize_player_id(player_id)
        if not pid or pid in remove_set or pid in seen:
            continue
        seen.add(pid)
        desired.append(pid)
    for player_id in add_player_ids:
        pid = normalize_player_id(player_id)
        if not pid or pid in seen:
            continue
        seen.add(pid)
        desired.append(pid)
    return desired


def post_roster(
    session: requests.Session,
    form: LoadForm,
    desired_roster_ids: Sequence[str],
) -> requests.Response:
    payload = list(form.base_fields)
    for player_id in desired_roster_ids:
        payload.append(("ROSTER", player_id))
    response = session.post(form.action_url, data=payload, timeout=30, allow_redirects=True)
    response.raise_for_status()
    return response


def fetch_rosters_export(
    session: requests.Session,
    base_url: str,
    league_id: str,
) -> Dict[str, object]:
    resp = session.get(
        f"{base_url}/export?TYPE=rosters&L={league_id}&JSON=1",
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def roster_ids_for_franchise(rosters_payload: Dict[str, object], franchise_id: str) -> List[str]:
    rosters_root = rosters_payload.get("rosters", {})
    franchises = rosters_root.get("franchise", []) if isinstance(rosters_root, dict) else []
    if isinstance(franchises, dict):
        franchises = [franchises]
    for franchise in franchises:
        if pad4(franchise.get("id")) != franchise_id:
            continue
        players = franchise.get("player", [])
        if isinstance(players, dict):
            players = [players]
        return [
            normalize_player_id(player.get("id"))
            for player in players
            if normalize_player_id(player.get("id"))
        ]
    return []


def player_row_for_franchise(
    rosters_payload: Dict[str, object],
    franchise_id: str,
    player_id: str,
) -> Dict[str, str] | None:
    rosters_root = rosters_payload.get("rosters", {})
    franchises = rosters_root.get("franchise", []) if isinstance(rosters_root, dict) else []
    if isinstance(franchises, dict):
        franchises = [franchises]
    for franchise in franchises:
        if pad4(franchise.get("id")) != franchise_id:
            continue
        players = franchise.get("player", [])
        if isinstance(players, dict):
            players = [players]
        for player in players:
            if normalize_player_id(player.get("id")) != player_id:
                continue
            return {
                "franchise_id": franchise_id,
                "player_id": player_id,
                "status": safe_str(player.get("status")),
                "salary": safe_str(player.get("salary")),
                "contract_year": safe_str(player.get("contractYear")),
                "contract_status": safe_str(player.get("contractStatus")),
                "contract_info": safe_str(player.get("contractInfo")),
            }
    return None


def main() -> int:
    args = parse_args()
    host = resolve_host(args.season, args.league_id, args.db_path, args.host)
    base_url = f"https://{host}/{args.season}"
    session = build_session(args.cookie, host)

    ensure_commissioner_mode(session, base_url, args.league_id)
    form = fetch_load_form(session, base_url, args.league_id, args.franchise_id)

    desired_roster_ids = build_desired_roster(
        form.current_roster_ids,
        args.add_player_id,
        args.remove_player_id,
    )
    current_set = set(form.current_roster_ids)
    desired_set = set(desired_roster_ids)
    actually_added = sorted(desired_set - current_set)
    actually_removed = sorted(current_set - desired_set)

    response_meta = {
        "changed": bool(actually_added or actually_removed),
        "dry_run": bool(args.dry_run),
        "post_status": None,
        "post_url": "",
    }

    if args.dry_run:
        rosters_payload = fetch_rosters_export(session, base_url, args.league_id)
    else:
        if response_meta["changed"]:
            post_resp = post_roster(session, form, desired_roster_ids)
            response_meta["post_status"] = post_resp.status_code
            response_meta["post_url"] = post_resp.url
        rosters_payload = fetch_rosters_export(session, base_url, args.league_id)

    verified_roster_ids = roster_ids_for_franchise(rosters_payload, args.franchise_id)
    verified_set = set(verified_roster_ids)
    add_verification = {
        player_id: (player_id in verified_set)
        for player_id in args.add_player_id
    }
    remove_verification = {
        player_id: (player_id not in verified_set)
        for player_id in args.remove_player_id
    }

    result = {
        "ok": all(add_verification.values()) and all(remove_verification.values()),
        "season": args.season,
        "league_id": args.league_id,
        "franchise_id": args.franchise_id,
        "host": host,
        "current_count": len(form.current_roster_ids),
        "desired_count": len(desired_roster_ids),
        "verified_count": len(verified_roster_ids),
        "added": actually_added,
        "removed": actually_removed,
        "response": response_meta,
        "verify_add": add_verification,
        "verify_remove": remove_verification,
        "players": {
            player_id: player_row_for_franchise(rosters_payload, args.franchise_id, player_id)
            for player_id in sorted({*args.add_player_id, *args.remove_player_id})
        },
    }
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
