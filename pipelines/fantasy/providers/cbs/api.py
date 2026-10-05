"""CBS JSON API client. CURRENT SEASON ONLY — history lives in HTML (parse.py).

WHY THIS IS A SECOND CLIENT AND NOT A METHOD ON CbsClient
=========================================================
CBS has two authentication systems that do not overlap. `client.py` speaks to
the league WEBSITE with the `pid` session cookie; this speaks to the JSON API
with an `access_token` query parameter. The token does not authenticate HTML
and the cookie does not authenticate the API — proven by leave-one-out testing
in both directions. Two credentials, two transports, two clients.

THREE WAYS THIS ENDPOINT FAMILY LIES, ALL GUARDED HERE
------------------------------------------------------
1. AN UNKNOWN ENDPOINT RETURNS 95KB OF HTML, not a JSON error. `json.loads`
   raises and that raise must surface as UnreadableResponseError — never be
   swallowed into an empty result.
2. THE ENVELOPE CARRIES ITS OWN STATUS. `statusCode` inside the body can
   disagree with the HTTP status, and a 400 arrives as
   `{"body": {"exceptions": [...]}}` with the real reason inside. Checking the
   HTTP status alone would read that as success with an odd shape.
3. A NARROWED RESULT LOOKS EXACTLY LIKE A COMPLETE ONE. `league/rosters`
   without `team_id=all` returns ONE team — the caller's own — at HTTP 200
   with no flag saying it filtered. This is why `fetch` takes explicit params
   and why the adapter asserts team counts against `num_teams` rather than
   trusting the row count it got back.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ...keychain import keychain_secret
from ..base import AuthError, ProviderError, RateLimitError, UnreadableResponseError
from .client import UA, ClientStats
from .constants import DEFAULT_LEAGUE_ID, api_url


class CbsApiAuthMissing(AuthError):
    pass


def load_access_token(account_key: str = "primary") -> str:
    """⚠️ FAILS CLOSED. No token means raise. There is no anonymous mode that
    returns less data — an unauthenticated call returns a 401 whose body is an
    HTML page, which would parse as 'unreadable' rather than 'empty' anyway,
    but refusing here makes the remedy obvious instead of cryptic."""
    tok = keychain_secret("CBS_ACCESS_TOKEN", "cbs_access_token")
    if not tok or not tok.strip():
        raise CbsApiAuthMissing(
            "No CBS access token (env CBS_ACCESS_TOKEN or Keychain "
            "'cbs_access_token'). Copy it from a logged-in league page's "
            "network requests, then:\n"
            "  security add-generic-password -U -a \"$USER\" -s cbs_access_token -w",
            resource="auth",
        )
    return tok.strip()


class CbsApiClient:
    def __init__(self, access_token: str, *, league_id: str = DEFAULT_LEAGUE_ID,
                 min_interval_sec: float = 0.6, stats: ClientStats | None = None) -> None:
        self.token = access_token
        self.league_id = league_id
        self.min_interval = min_interval_sec
        # ⚠️ SHARED WITH THE HTML CLIENT ON PURPOSE. The CLI prints one call
        # count per run; if this client kept a private counter the summary
        # would report "0 API calls" for a run that made eight, which is the
        # same class of quietly-wrong reporting the rest of this pipeline
        # refuses. One counter, both transports.
        self.stats = stats or ClientStats()
        self._last = 0.0

    @property
    def api_calls(self) -> int:
        return self.stats.api_calls

    def _throttle(self) -> None:
        gap = time.time() - self._last
        if gap < self.min_interval:
            time.sleep(self.min_interval - gap)
        self._last = time.time()

    def fetch(self, endpoint: str, *, params: dict[str, str] | None = None,
              attempts: int = 3) -> dict[str, Any]:
        """One API call → the unwrapped `body` object.

        Raises rather than returning anything ambiguous. Every return path here
        has already proven the payload is JSON, that the envelope reports
        success, and that a `body` object is present.
        """
        q = {"version": "3.0", "response_format": "json",
             "league_id": self.league_id, "access_token": self.token}
        q.update(params or {})
        url = f"{api_url(endpoint, self.league_id)}?{urllib.parse.urlencode(q)}"
        # Never let the token reach a log line or an exception message.
        safe = f"{api_url(endpoint, self.league_id)}?{urllib.parse.urlencode({k: v for k, v in q.items() if k != 'access_token'})}"

        last: str | None = None
        for i in range(attempts):
            self._throttle()
            req = urllib.request.Request(
                url, headers={"User-Agent": UA, "Accept": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=45) as r:
                    self.stats.api_calls += 1
                    raw = r.read().decode("utf-8", "ignore")
                    status = r.status
            except urllib.error.HTTPError as e:
                status = e.code
                raw = e.read().decode("utf-8", "ignore")
                if status in (429, 500, 502, 503, 504) and i < attempts - 1:
                    self.stats.retries += 1
                    time.sleep(2 ** i)
                    last = f"HTTP {status}"
                    continue
                if status == 429:
                    raise RateLimitError(f"{safe}: HTTP 429", resource=endpoint,
                                         endpoint=safe, http_status=429, attempt=i + 1)
                if status in (401, 403):
                    raise AuthError(
                        f"{safe}: HTTP {status}. The CBS access token is stale or "
                        f"revoked — re-copy it and re-store 'cbs_access_token'.",
                        resource=endpoint, endpoint=safe, http_status=status)
            except Exception as e:                                   # noqa: BLE001
                last = f"{type(e).__name__}: {e}"
                if i < attempts - 1:
                    self.stats.retries += 1
                    time.sleep(2 ** i)
                    continue
                self.stats.errors.append(f"{safe}: {last}")
                raise ProviderError(f"{safe}: {last}", resource=endpoint,
                                    endpoint=safe, error_kind="transport",
                                    retryable=True, attempt=i + 1) from e
            return self._unwrap(raw, endpoint=endpoint, safe_url=safe, http_status=status)
        raise ProviderError(f"{safe}: {last}", resource=endpoint, endpoint=safe,
                            error_kind="transport", retryable=True, attempt=attempts)

    @staticmethod
    def _unwrap(raw: str, *, endpoint: str, safe_url: str, http_status: int) -> dict[str, Any]:
        """Envelope → body, refusing every ambiguous shape.

        Split out as a static method with no I/O so the guards can be tested
        against captured payloads without a network or a credential.
        """
        try:
            env = json.loads(raw)
        except ValueError as e:
            head = raw.lstrip()[:60]
            # The signature of CBS's 404: an HTML document, HTTP 404, ~95KB.
            hint = (" — this is CBS's HTML 404 page, meaning the endpoint does "
                    "not exist. CBS does not return a JSON error for unknown "
                    "endpoints.") if head.lower().startswith(("not found", "<!doctype", "<html")) else ""
            raise UnreadableResponseError(
                f"{safe_url}: response was not JSON (HTTP {http_status}, "
                f"{len(raw)} bytes, starts {head!r}){hint}",
                resource=endpoint, endpoint=safe_url, http_status=http_status) from e

        if not isinstance(env, dict):
            raise UnreadableResponseError(
                f"{safe_url}: expected a JSON object envelope, got {type(env).__name__}",
                resource=endpoint, endpoint=safe_url, http_status=http_status)

        body = env.get("body")
        # ⚠️ CBS reports a rejected request as HTTP 400 with the reason nested
        # in body.exceptions. Surfacing it here means the caller sees the
        # provider's own words instead of "unexpected shape".
        if isinstance(body, dict) and body.get("exceptions"):
            raise ProviderError(
                f"{safe_url}: CBS rejected the request — {json.dumps(body['exceptions'])[:300]}",
                resource=endpoint, endpoint=safe_url, http_status=http_status,
                error_kind="rejected", retryable=False)

        env_status = env.get("statusCode")
        if env_status is not None and int(env_status) != 200:
            raise ProviderError(
                f"{safe_url}: envelope statusCode={env_status} "
                f"({env.get('statusMessage')})",
                resource=endpoint, endpoint=safe_url, http_status=int(env_status),
                error_kind="rejected", retryable=False)

        if not isinstance(body, dict):
            raise UnreadableResponseError(
                f"{safe_url}: envelope has no `body` object (keys: "
                f"{sorted(env)[:8]}). A missing body is not an empty result.",
                resource=endpoint, endpoint=safe_url, http_status=http_status)
        return body
