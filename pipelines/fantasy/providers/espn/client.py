"""ESPN Fantasy API HTTP client.

⚠️ SAME NO-FAIL-OPEN RULE AS THE YAHOO CLIENT: check the status before
parsing, and never turn a failure into an empty collection. A non-JSON body,
a 5xx, or a malformed payload raises a typed, retryable error; only a
genuinely well-formed response with zero elements is reported as empty.

WHAT'S DIFFERENT FROM YAHOO, CONCRETELY:
  - No documented rate limit and no observed 999-style throttle signature in
    community tooling — but this is still an undocumented API being hit by an
    automated client, so conservative pacing and retry-on-5xx are kept anyway.
  - No pagination on any of the views this adapter uses (mTeam, mRoster,
    mMatchup, mSettings, mStandings, mBoxscore) — each returns the whole
    league for the requested scope in one response.
  - Real JSON arrays throughout — none of Yahoo's numeric-string-keyed
    collection-as-object pathology. The parser (parse.py) is correspondingly
    simpler.
  - A private league without cookies returns 401 BEFORE any consent-style
    flow — there's nothing to consent to, since there's no OAuth. A public
    league needs no cookies at all.

⚠️ CONFIRMED 2026-08-12 (community source, cwendt94/espn-api): ESPN moved this
API's host from fantasy.espn.com to lm-api-reads.fantasy.espn.com in April
2024 with no announcement. If every request starts failing with a connection
error rather than a clean 401/404, re-verify the host before assuming
credentials broke.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from ...redact import redact_text
from ..base import (
    AccessDeniedError,
    AuthError,
    ProviderError,
    UnreadableResponseError,
)
from .auth import EspnCookies
from .constants import API_BASE, FIRST_MODERN_SEASON, GAME_CODE

DEFAULT_MIN_INTERVAL_SEC = 0.5
DEFAULT_MAX_RETRIES = 4
DEFAULT_TIMEOUT_SEC = 30

USER_AGENT = "upsmfl-fantasy-ingest/1.0 (read-only; +https://github.com/keithcreelman/upsmflproduction)"


@dataclass
class ClientStats:
    api_calls: int = 0
    retries: int = 0
    errors: list[dict] = field(default_factory=list)


class EspnClient:
    """Cookie-authenticated, retrying HTTP access to ESPN's Fantasy API."""

    def __init__(
        self,
        *,
        cookies: EspnCookies,
        stats: ClientStats | None = None,
        min_interval_sec: float = DEFAULT_MIN_INTERVAL_SEC,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout_sec: int = DEFAULT_TIMEOUT_SEC,
    ) -> None:
        self.cookies = cookies
        self.stats = stats or ClientStats()
        self.min_interval_sec = min_interval_sec
        self.max_retries = max_retries
        self.timeout_sec = timeout_sec
        self._next_allowed = 0.0

    def league_url(self, *, season: int, league_id: str) -> str:
        """The base league URL for the given season.

        Two shapes, chosen by season, NOT by trial and error: modern seasons
        (2018+) use the direct path; earlier seasons use leagueHistory and the
        caller (fetch_league) must unwrap the resulting single-element list.
        """
        if season >= FIRST_MODERN_SEASON:
            return f"{API_BASE}/seasons/{season}/segments/0/leagues/{league_id}"
        return f"{API_BASE}/leagueHistory/{league_id}?seasonId={season}"

    def fetch_players_page(self, *, season: int, league_id: str,
                           limit: int, offset: int) -> dict:
        """One page of the player universe (kona_player_info).

        ⚠️ THE LEAGUE ENDPOINT, NOT /players. The bare /players route ACCEPTS
        the same filter and then ignores its limit — it returned 11,613 rows for
        a limit of 5 — so paging against it silently re-reads the whole universe
        every call. The league-scoped route honours limit AND offset (verified:
        no overlap between consecutive pages, stable ordering).
        """
        return self.fetch_league(
            season=season, league_id=league_id, views=["kona_player_info"],
            resource="league.players",
            extra_headers={"x-fantasy-filter": json.dumps({"players": {
                "limit": limit, "offset": offset,
                "sortPercOwned": {"sortPriority": 1, "sortAsc": False}}})},
        )

    def fetch_league(
        self, *, season: int, league_id: str, views: list[str], week: int | None = None,
        resource: str = "league", extra_headers: dict[str, str] | None = None,
    ) -> dict:
        """GET a league resource with one or more `view` params.

        Returns the unwrapped league object — for a historical-season request
        this means indexing into the single-element list ESPN wraps the body
        in, so every caller sees the same shape regardless of season.

        extra_headers exists for mTransactions2, the one view that requires an
        `x-fantasy-filter` header (a JSON-encoded filter of transaction types)
        to return anything at all — confirmed live: the same request WITHOUT
        the header, or without a `scoringPeriodId`, returns zero transactions
        rather than an error, which would otherwise look identical to "no
        transactions this week" and silently under-report FAAB activity.
        """
        base = self.league_url(season=season, league_id=league_id)
        sep = "&" if "?" in base else "?"
        query = sep + "&".join(f"view={v}" for v in views)
        if week is not None:
            query += f"&scoringPeriodId={week}"
        url = base + query

        body, status = self._request_with_retries(url, resource=resource, extra_headers=extra_headers)
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise UnreadableResponseError(
                f"{resource}: HTTP {status} body is not JSON ({len(body)} bytes). "
                f"First 200 chars: {redact_text(body)[:200]!r}",
                resource=resource, endpoint=url, http_status=status,
            ) from exc

        if season < FIRST_MODERN_SEASON:
            if not isinstance(payload, list) or not payload:
                raise UnreadableResponseError(
                    f"{resource}: expected a single-element list for a "
                    f"historical-season (leagueHistory) response, got "
                    f"{type(payload).__name__}",
                    resource=resource, endpoint=url, http_status=status,
                )
            payload = payload[0]

        if not isinstance(payload, dict):
            raise UnreadableResponseError(
                f"{resource}: expected a JSON object, got {type(payload).__name__}",
                resource=resource, endpoint=url, http_status=status,
            )
        return payload

    # ── internals ────────────────────────────────────────────────────────────

    def _pace(self) -> None:
        now = time.monotonic()
        if now < self._next_allowed:
            time.sleep(self._next_allowed - now)
            now = time.monotonic()
        self._next_allowed = now + self.min_interval_sec * (1.0 + random.random() * 0.2)

    def _request_with_retries(
        self, url: str, *, resource: str, extra_headers: dict[str, str] | None = None,
    ) -> tuple[str, int]:
        last_exc: ProviderError | None = None
        for attempt in range(1, self.max_retries + 1):
            self._pace()
            try:
                return self._request_once(url, resource=resource, attempt=attempt, extra_headers=extra_headers)
            except ProviderError as exc:
                last_exc = exc
                self.stats.api_calls += 1
                self.stats.errors.append({
                    "resource": resource, "endpoint_path": exc.endpoint,
                    "http_status": exc.http_status, "error_kind": exc.error_kind,
                    "attempt": attempt, "is_retryable": 1 if exc.retryable else 0,
                    "message": redact_text(str(exc))[:500],
                })
                if not exc.retryable:
                    raise
                if attempt < self.max_retries:
                    self.stats.retries += 1
                    time.sleep(min(2.0 * (2 ** (attempt - 1)), 30.0) * (0.75 + random.random() * 0.5))
        assert last_exc is not None
        raise last_exc

    def _request_once(
        self, url: str, *, resource: str, attempt: int, extra_headers: dict[str, str] | None = None,
    ) -> tuple[str, int]:
        headers = {
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        }
        cookie_header = self.cookies.as_cookie_header()
        if cookie_header:
            headers["Cookie"] = cookie_header
        if extra_headers:
            headers.update(extra_headers)

        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                status = resp.status
        except urllib.error.HTTPError as exc:
            status = exc.code
            body = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
            self._raise_for_status(status, body, url=url, resource=resource, attempt=attempt)
        except urllib.error.URLError as exc:
            raise ProviderError(
                f"{resource}: transport failure — {redact_text(exc.reason)}. If "
                "this is a connection error rather than an HTTP error, verify "
                f"{API_BASE} is still the correct host — ESPN moved it once "
                "before (April 2024) with no announcement.",
                resource=resource, endpoint=url, error_kind="transport",
                retryable=True, attempt=attempt,
            ) from exc
        except TimeoutError as exc:
            raise ProviderError(
                f"{resource}: timed out after {self.timeout_sec}s",
                resource=resource, endpoint=url, error_kind="transport",
                retryable=True, attempt=attempt,
            ) from exc

        self.stats.api_calls += 1
        return raw, status

    def _raise_for_status(self, status: int, body: str, *, url: str, resource: str, attempt: int) -> None:
        if status == 401:
            if self.cookies.is_present:
                raise AuthError(
                    f"{resource}: HTTP 401 with cookies supplied — SWID/espn_s2 "
                    "are likely expired or wrong. Re-extract them from a fresh "
                    "espn.com login (they rotate on logout/password change) and "
                    "re-store via `security add-generic-password`.",
                    resource=resource, endpoint=url, http_status=status, attempt=attempt,
                )
            raise AccessDeniedError(
                f"{resource}: HTTP 401 with no cookies supplied — this league "
                "is private. Provide ESPN_SWID and ESPN_S2 (see "
                "pipelines/fantasy/providers/espn/auth.py for how to obtain them).",
                resource=resource, endpoint=url, http_status=status, attempt=attempt,
            )
        if status == 404:
            raise ProviderError(
                f"{resource}: HTTP 404 — no such league/season, or (for a "
                "private league) ESPN returning 404 instead of 401 to avoid "
                "confirming the league exists.",
                resource=resource, endpoint=url, http_status=status,
                error_kind="not_found", retryable=False, attempt=attempt,
            )
        if 500 <= status < 600:
            raise ProviderError(
                f"{resource}: HTTP {status} from ESPN.",
                resource=resource, endpoint=url, http_status=status,
                error_kind="server", retryable=True, attempt=attempt,
            )
        raise ProviderError(
            f"{resource}: unexpected HTTP {status}: {redact_text(body)[:200]}",
            resource=resource, endpoint=url, http_status=status,
            error_kind="unknown", retryable=False, attempt=attempt,
        )
