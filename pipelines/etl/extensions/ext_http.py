"""
ext_http.py — HTTP client wrapper for the extension module.

GET requests:  Delegates to existing mfl_api.fetch_json() (throttling, retries, 429 backoff).
POST requests: Adds commissioner cookie authentication for MFL salary imports (Step 6).

The server number is NEVER hard-coded. It comes from ExtConfig.server,
which is derived from the league_years DB table at init time.
"""
from __future__ import annotations

import json
import logging
import sys
import time
import random
from pathlib import Path
from typing import Optional, Dict, Any
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

# sys.path injection for existing scripts
_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent / "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import mfl_api as _mfl_api  # noqa: E402

logger = logging.getLogger(__name__)

# POST-specific throttle (separate from GET to avoid stomping export calls)
POST_DELAY = 3.0
POST_JITTER = 0.5
POST_MAX_RETRIES = 3
POST_BASE_BACKOFF = 4.0


# ---------------------------------------------------------------------------
# GET helpers (thin wrappers around existing mfl_api)
# ---------------------------------------------------------------------------

def fetch_league_json(conn, season: int) -> Optional[dict]:
    """Fetch TYPE=league JSON. Uses existing mfl_api.get_metadata_rawjson()."""
    return _mfl_api.get_metadata_rawjson(conn, season)


def fetch_players_json(conn, season: int) -> Optional[dict]:
    """Fetch TYPE=players DETAILS=1 JSON. Uses existing mfl_api.get_players()."""
    return _mfl_api.get_players(conn, season, details=True)


def fetch_rosters_json(conn, season: int) -> Optional[dict]:
    """Fetch TYPE=rosters JSON. Uses existing mfl_api.get_rosters()."""
    return _mfl_api.get_rosters(conn, season)


def fetch_transactions_json(conn, season: int) -> Optional[dict]:
    """Fetch TYPE=transactions JSON. Uses existing mfl_api.get_transactions()."""
    return _mfl_api.get_transactions(conn, season)


# ---------------------------------------------------------------------------
# POST helper (commissioner-authenticated salary import)
# ---------------------------------------------------------------------------

def build_import_url(server: str, season: int) -> str:
    """
    Build MFL salary import URL.

    Uses server from league context (never hard-coded).
    Format: https://www{server}.myfantasyleague.com/{season}/import
    """
    return f"https://www{server}.myfantasyleague.com/{season}/import"


def post_salary_import(
    server: str,
    season: int,
    league_id: str,
    xml_payload: str,
    commissioner_cookie: str,
) -> Dict[str, Any]:
    """
    POST a salary import to MFL.

    Per Step 6 spec:
      - HTTP POST only (GET prohibited)
      - Content-Type: application/x-www-form-urlencoded
      - APPEND=1 always
      - Commissioner cookie in Cookie header
      - Response: HTTP 200 + no <error> = SUCCESS; else FAIL

    Args:
        server:               MFL server number (e.g., "48").
        season:               NFL season year.
        league_id:            League ID string.
        xml_payload:          Complete <salaries> XML string.
        commissioner_cookie:  Cookie string for commissioner auth.

    Returns:
        dict with keys:
            "success": bool
            "status_code": int or None
            "response_body": str or None
            "error": str or None
    """
    url = build_import_url(server, season)

    form_data = urlencode({
        "TYPE": "salaries",
        "L": league_id,
        "APPEND": "1",
        "DATA": xml_payload,
    }).encode("utf-8")

    for attempt in range(POST_MAX_RETRIES):
        try:
            # Throttle
            sleep_for = POST_DELAY + random.uniform(-POST_JITTER, POST_JITTER)
            if sleep_for < 0:
                sleep_for = POST_DELAY
            time.sleep(sleep_for)

            req = Request(url, data=form_data, method="POST")
            req.add_header("Content-Type", "application/x-www-form-urlencoded")
            req.add_header("Cookie", commissioner_cookie)

            logger.info(
                f"POST salary import (attempt {attempt + 1}/{POST_MAX_RETRIES}): {url}"
            )

            resp = urlopen(req, timeout=30)
            status_code = resp.getcode()
            body = resp.read().decode("utf-8")

            # Step 6 response validation
            if status_code != 200:
                return {
                    "success": False,
                    "status_code": status_code,
                    "response_body": body,
                    "error": f"HTTP {status_code}",
                }

            if "<error>" in body.lower():
                return {
                    "success": False,
                    "status_code": status_code,
                    "response_body": body,
                    "error": "Response contains <error> element",
                }

            return {
                "success": True,
                "status_code": status_code,
                "response_body": body,
                "error": None,
            }

        except HTTPError as e:
            if e.code == 429:
                backoff = POST_BASE_BACKOFF * (2 ** attempt)
                logger.warning(
                    f"429 Too Many Requests on POST. "
                    f"Sleeping {backoff:.1f}s before retry."
                )
                time.sleep(backoff)
                continue
            return {
                "success": False,
                "status_code": e.code,
                "response_body": None,
                "error": f"HTTP {e.code}: {e}",
            }

        except (URLError, Exception) as e:
            return {
                "success": False,
                "status_code": None,
                "response_body": None,
                "error": str(e),
            }

    return {
        "success": False,
        "status_code": None,
        "response_body": None,
        "error": f"Max retries ({POST_MAX_RETRIES}) exceeded for POST to {url}",
    }
