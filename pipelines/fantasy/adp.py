"""Average Draft Position ingestion — what the MARKET charges for a player.

WHY THIS MODULE EXISTS
======================
Keeper and trade valuation needs a player's COST, not his projected points.
Before this, cost was approximated by converting weekly point projections into
a VOR rank. That proxy produced confidently wrong answers on exactly the
players a keeper decision hinges on:

    Zach Charbonnet   projection said round 3   real ADP 135.8  (round 12)
    Luther Burden     projection said round 8   real ADP  59.6  (round 5)

A projection answers "how many points will he score." ADP answers "what will
he cost." They diverge hardest for committee running backs and for breakout
candidates the market has already bid up — which is to say, precisely the
population of interesting keepers. Never substitute one for the other again.

SOURCES ARE PLUGGABLE AND NEVER BLENDED
=======================================
Each source lands under its own `source` key so two sources may disagree and
both survive. Blending them into one "consensus" number here would destroy the
disagreement, which is itself signal.

  ffc          — Fantasy Football Calculator. Free, documented JSON, no key.
                 Real draft data from their own mock/real drafts.
  fantasypros  — FantasyPros' cross-site AGGREGATE (ESPN + Sleeper + CBS +
                 NFL + RTSports). Broader and generally the better number,
                 but it REQUIRES AN API KEY: their pages are JS-rendered and
                 the public v2 endpoint answers 403 without `x-api-key`.

⚠️ FANTASYPROS FAILS CLOSED. If no key is configured this raises rather than
quietly falling back to FFC. A silent fallback would mean a caller who asked
for the aggregate got single-source numbers and never knew — the same class of
bug as the projection proxy this module exists to kill.

⚠️ SOFT 404s ARE REAL HERE. fantasypros.com/api-data/... answers HTTP **200**
with a "Page Not Found" HTML body. Status codes alone are not proof of data;
every fetch below validates the parsed shape, not the status.
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .keychain import keychain_secret

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120 Safari/537.36"
)
SCORING = ("ppr", "half_ppr", "standard", "2qb")


class AdpError(RuntimeError):
    """A source could not be read. Never swallowed into an empty result."""


class AdpSourceUnavailable(AdpError):
    """The source exists but we are not provisioned to read it (e.g. no key).

    Distinct from "the fetch failed": this is a configuration state the caller
    can fix, and it must never be downgraded to an empty list of players.
    """


def player_key(name: str) -> str:
    """Normalized join key. Suffixes and punctuation vary by source —
    'Luther Burden III' (FFC) vs 'Luther Burden' (elsewhere) must collide."""
    s = (name or "").replace("’", "'").strip().lower()
    s = re.sub(r"\s+(jr|sr|ii|iii|iv|v)\.?$", "", s)
    s = re.sub(r"[.'`]", "", s)
    return re.sub(r"\s+", " ", s).strip()


@dataclass
class AdpFetch:
    source: str
    season: int
    scoring: str
    teams: int
    rows: list[dict] = field(default_factory=list)
    url: str = ""

    @property
    def complete(self) -> bool:
        return bool(self.rows)


def _get(url: str, *, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept": "application/json, text/plain, */*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise AdpError(f"{url} -> HTTP {e.code}") from e
    except Exception as e:                                  # noqa: BLE001
        raise AdpError(f"{url} -> {type(e).__name__}: {e}") from e


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ── Fantasy Football Calculator ──────────────────────────────────────────────

_FFC_SCORING = {"ppr": "ppr", "half_ppr": "half-ppr", "standard": "standard", "2qb": "2qb"}


def fetch_ffc(season: int, *, scoring: str = "ppr", teams: int = 12,
              run_id: str | None = None) -> AdpFetch:
    if scoring not in _FFC_SCORING:
        raise AdpError(f"unknown scoring {scoring!r}; expected one of {sorted(_FFC_SCORING)}")
    url = (f"https://fantasyfootballcalculator.com/api/v1/adp/"
           f"{_FFC_SCORING[scoring]}?teams={teams}&year={season}&position=all")
    raw = _get(url)
    try:
        data = json.loads(raw)
    except Exception as e:                                   # noqa: BLE001
        raise AdpError(f"FFC returned non-JSON ({len(raw)} bytes) — likely a soft 404") from e
    players = data.get("players")
    # Shape validation, not status validation. See module docstring.
    if not isinstance(players, list) or not players:
        raise AdpError(f"FFC returned no players for {season} {scoring} {teams}-team "
                       f"(status={data.get('status')!r}) — refusing to report an empty board")
    rows = []
    for i, p in enumerate(players, 1):
        nm = p.get("name")
        if not nm:
            continue
        rows.append({
            "source": "ffc", "season": season, "scoring": scoring, "teams": teams,
            "player_key": player_key(nm), "player_name": nm,
            "position": p.get("position"), "nfl_team": p.get("team"),
            "adp": p.get("adp"), "adp_rank": i,
            "adp_stdev": p.get("stdev"),
            "high_pick": p.get("high"), "low_pick": p.get("low"),
            "times_drafted": p.get("times_drafted"), "bye_week": p.get("bye"),
            "source_url": url, "source_run_id": run_id,
            "fetched_at_utc": _now(), "updated_at_utc": _now(),
        })
    return AdpFetch("ffc", season, scoring, teams, rows, url)


# ── FantasyPros (cross-site aggregate) ───────────────────────────────────────

_FP_SCORING = {"ppr": "PPR", "half_ppr": "HALF", "standard": "STD"}


def fantasypros_api_key() -> str | None:
    """env FANTASYPROS_API_KEY, else Keychain service 'fantasypros_api_key'."""
    return keychain_secret("FANTASYPROS_API_KEY", "fantasypros_api_key")


def fetch_fantasypros(season: int, *, scoring: str = "ppr", teams: int = 12,
                      run_id: str | None = None, api_key: str | None = None) -> AdpFetch:
    """FantasyPros' aggregate ADP. Requires an API key — see module docstring."""
    if scoring not in _FP_SCORING:
        raise AdpError(f"unknown scoring {scoring!r}; expected one of {sorted(_FP_SCORING)}")
    key = api_key or fantasypros_api_key()
    if not key:
        raise AdpSourceUnavailable(
            "FantasyPros ADP needs an API key and none is configured.\n"
            "  Their ADP pages are JS-rendered (a plain scrape now yields ZERO rows —\n"
            "  which is why pipelines/etl/scripts/fetch_fantasypros_adp.py is stale),\n"
            "  and api.fantasypros.com answers 403 without x-api-key.\n"
            "  Get a key at https://www.fantasypros.com/api/ then store it with:\n"
            "    security add-generic-password -U -a \"$USER\" -s fantasypros_api_key -w\n"
            "  (type the key at the prompt; do NOT pass it as an argument)\n"
            "  Until then use --source ffc, which needs no key.")
    url = (f"https://api.fantasypros.com/public/v2/json/nfl/{season}/consensus-rankings"
           f"?type=adp&scoring={_FP_SCORING[scoring]}&position=ALL")
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT, "Accept": "application/json", "x-api-key": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise AdpSourceUnavailable(
                f"FantasyPros rejected the API key (HTTP {e.code}). Check it is current "
                f"and that your plan includes ADP.") from e
        raise AdpError(f"{url} -> HTTP {e.code}") from e
    except Exception as e:                                   # noqa: BLE001
        raise AdpError(f"{url} -> {type(e).__name__}: {e}") from e

    players = data.get("players")
    if not isinstance(players, list) or not players:
        raise AdpError("FantasyPros returned no players — refusing to report an empty board")
    rows = []
    for i, p in enumerate(players, 1):
        nm = p.get("player_name") or p.get("name")
        if not nm:
            continue
        adp = p.get("rank_ave") or p.get("adp")
        rows.append({
            "source": "fantasypros", "season": season, "scoring": scoring, "teams": teams,
            "player_key": player_key(nm), "player_name": nm,
            "position": (p.get("player_position_id") or p.get("position")),
            "nfl_team": p.get("player_team_id") or p.get("team"),
            "adp": float(adp) if adp not in (None, "") else None,
            "adp_rank": i,
            "adp_stdev": p.get("rank_std"),
            "high_pick": p.get("rank_min"), "low_pick": p.get("rank_max"),
            "times_drafted": None, "bye_week": p.get("player_bye_week"),
            "source_url": url, "source_run_id": run_id,
            "fetched_at_utc": _now(), "updated_at_utc": _now(),
        })
    return AdpFetch("fantasypros", season, scoring, teams, rows, url)


SOURCES = {"ffc": fetch_ffc, "fantasypros": fetch_fantasypros}


def fetch(source: str, season: int, **kw) -> AdpFetch:
    if source not in SOURCES:
        raise AdpError(f"unknown ADP source {source!r}; expected one of {sorted(SOURCES)}")
    return SOURCES[source](season, **kw)
