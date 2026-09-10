"""Yahoo Fantasy API HTTP client — throttling, retries, and refusal to fail open.

⚠️ THE RULE THIS FILE EXISTS TO ENFORCE: check the status and the body shape
BEFORE parsing, and never turn a failure into an empty collection.

Yahoo's throttle does not arrive as a clean 429. It arrives as **HTTP 999** with
a non-JSON, non-XML body — a Yahoo HTML "Request denied" page. A client that
parses first blows up with a JSON decode error; a client that catches broadly
returns `[]` and the backfill cheerfully records "this league had no
transactions in 2021". That second outcome is the dangerous one, and it is the
same failure class behind every data-destruction incident in this repo. So:

  * status is checked first, always
  * 999 and any unparseable body raise a typed, retryable error
  * an EMPTY collection is only ever reported when Yahoo returned a well-formed
    payload that actually contained zero elements

RATE LIMITS ARE COMPLETELY UNDOCUMENTED. Yahoo's only public statement is that
excessive use "over the course of short periods" may be throttled. There are no
numbers, no Retry-After, no documented headers. Blocks are applied per
client_id, not per user, and last minutes to hours. The defaults here are
deliberately conservative — a backfill that finishes in four hours is strictly
better than one that gets the app blocked in ten minutes.
"""

from __future__ import annotations

import gzip
import io
import json
import random
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from ...redact import redact_text, redact_url
from ..base import (
    AccessDeniedError,
    AuthError,
    ProviderError,
    RateLimitError,
    UnreadableResponseError,
)
from . import oauth as yoauth
from .shape import YahooShapeError, unwrap_content

API_BASE = "https://fantasysports.yahooapis.com/fantasy/v2"

#: Yahoo's undocumented-but-universal JSON switch. XML is the only DOCUMENTED
#: format; JSON is what every wrapper uses. We request JSON for ergonomics and
#: store the raw body regardless, so a future switch to XML costs a parser, not
#: a re-fetch.
JSON_PARAM = ("format", "json")

#: Sustained pacing between requests. ~1 req/s is the community-accepted safe
#: rate for bulk historical reads.
DEFAULT_MIN_INTERVAL_SEC = 1.0

DEFAULT_MAX_RETRIES = 5
DEFAULT_TIMEOUT_SEC = 45

#: Yahoo's throttle status. Not in any RFC — it is a Yahoo-ism.
HTTP_RATE_LIMITED = 999

USER_AGENT = "upsmfl-fantasy-ingest/1.0 (read-only; +https://github.com/keithcreelman/upsmflproduction)"


@dataclass
class ClientStats:
    """Per-run counters, reported into fantasy_sync_runs."""

    api_calls: int = 0
    retries: int = 0
    rate_limit_hits: int = 0
    bytes_received: int = 0
    errors: list[dict] = field(default_factory=list)


class _Pacer:
    """Process-wide minimum interval between outbound requests.

    Thread-safe because a future parallel fetcher must not be able to defeat the
    pacing simply by using two threads — the block is applied per client_id, so
    concurrency does not buy throughput, it buys a ban.
    """

    def __init__(self, min_interval: float) -> None:
        self.min_interval = max(0.0, float(min_interval))
        self._lock = threading.Lock()
        self._next_allowed = 0.0

    def wait(self) -> None:
        with self._lock:
            now = time.monotonic()
            if now < self._next_allowed:
                time.sleep(self._next_allowed - now)
                now = time.monotonic()
            # Jitter avoids a lockstep request train, which is what a naive
            # fixed sleep produces and what pattern-based throttles notice.
            self._next_allowed = now + self.min_interval * (1.0 + random.random() * 0.15)


class YahooClient:
    """Authenticated, paced, retrying HTTP access to the Yahoo Fantasy API.

    `raw_sink`, when supplied, is called with every response so the payload is
    preserved before any parsing happens. That ordering matters: a payload that
    is only stored after a successful parse is exactly the payload you cannot
    reparse when the parser turns out to be wrong.
    """

    def __init__(
        self,
        *,
        token_provider: Callable[[], str],
        stats: ClientStats | None = None,
        min_interval_sec: float = DEFAULT_MIN_INTERVAL_SEC,
        max_retries: int = DEFAULT_MAX_RETRIES,
        timeout_sec: int = DEFAULT_TIMEOUT_SEC,
        raw_sink: Callable[..., str | None] | None = None,
        run_id: str | None = None,
    ) -> None:
        self._token_provider = token_provider
        self.stats = stats or ClientStats()
        self._pacer = _Pacer(min_interval_sec)
        self.max_retries = max_retries
        self.timeout_sec = timeout_sec
        self._raw_sink = raw_sink
        self.run_id = run_id

    # ── public API ───────────────────────────────────────────────────────────

    def get_json(
        self,
        path: str,
        *,
        resource: str,
        params: dict | None = None,
        scope: dict | None = None,
    ) -> dict:
        """GET a Yahoo resource and return the unwrapped fantasy_content object.

        `resource` is the logical name recorded in the raw index ('league.settings').
        `scope` carries league_key/team_key/player_key/season/week for provenance.
        """
        url = self._build_url(path, params)
        body, status, content_type = self._request_with_retries(url, resource=resource)

        if self._raw_sink is not None:
            self._raw_sink(
                resource=resource,
                endpoint_path=redact_url(url),
                request_params=params or {},
                body=body,
                http_status=status,
                content_type=content_type,
                run_id=self.run_id,
                **(scope or {}),
            )

        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise UnreadableResponseError(
                f"{resource}: HTTP {status} body is not JSON ({len(body)} bytes, "
                f"content-type {content_type!r}). This is an error or throttle "
                f"page, NOT an empty result. First 200 chars: "
                f"{redact_text(body)[:200]!r}",
                resource=resource, endpoint=redact_url(url), http_status=status,
            ) from exc

        try:
            return unwrap_content(payload)
        except YahooShapeError as exc:
            raise UnreadableResponseError(
                f"{resource}: {exc}", resource=resource,
                endpoint=redact_url(url), http_status=status,
            ) from exc

    def paginate(
        self,
        path: str,
        *,
        resource: str,
        collection_getter: Callable[[dict], list],
        params: dict | None = None,
        scope: dict | None = None,
        page_size: int = 25,
        max_pages: int | None = None,
    ) -> Iterator[tuple[list, bool]]:
        """Walk a start/count-paginated collection to exhaustion.

        ⚠️ Yahoo hard-caps responses at 25 items regardless of the `count` asked
        for, and the cap is UNDOCUMENTED. Stopping at the first page is the
        classic failure here and it looks exactly like success — a 1,000-player
        league quietly becomes 25 players.

        Yields (page_items, is_final_page). The final flag lets the caller mark
        a bounded read as incomplete rather than silently truncating: a
        `max_pages` cutoff yields is_final=False on the last page it returns.

        Termination is on a SHORT page (fewer than page_size) or an empty page.
        A full page always triggers another request, because "exactly 25 left"
        is indistinguishable from "25 of many" without asking.
        """
        start = 0
        pages = 0
        while True:
            page_params = dict(params or {})
            page_params["start"] = start
            page_params["count"] = page_size
            content = self.get_json(path, resource=resource, params=page_params, scope=scope)
            items = collection_getter(content)
            pages += 1

            if not items:
                # A well-formed payload containing zero elements. This is the
                # ONLY path that legitimately reports emptiness — every failure
                # mode above raised before reaching here.
                yield [], True
                return

            hit_page_cap = max_pages is not None and pages >= max_pages
            exhausted = len(items) < page_size
            yield items, (exhausted and not hit_page_cap)

            if exhausted or hit_page_cap:
                return
            start += page_size

    # ── internals ────────────────────────────────────────────────────────────

    def _build_url(self, path: str, params: dict | None) -> str:
        """Compose a Yahoo URI.

        Yahoo uses semicolon-delimited MATRIX parameters on path segments
        (`/players;start=25;count=25`) and a normal query string only for
        `format`. Passing matrix params as a query string silently returns
        unfiltered results — a subtle, expensive mistake.
        """
        segments = []
        for key, value in sorted((params or {}).items()):
            if value is None:
                continue
            segments.append(f"{key}={urllib.parse.quote(str(value), safe=',')}")
        matrix = (";" + ";".join(segments)) if segments else ""
        base = f"{API_BASE}/{path.lstrip('/')}{matrix}"
        return f"{base}?{JSON_PARAM[0]}={JSON_PARAM[1]}"

    def _request_with_retries(self, url: str, *, resource: str) -> tuple[str, int, str]:
        last_exc: ProviderError | None = None

        for attempt in range(1, self.max_retries + 1):
            self._pacer.wait()
            try:
                body, status, content_type = self._request_once(url, attempt=attempt, resource=resource)
                self.stats.api_calls += 1
                self.stats.bytes_received += len(body)
                return body, status, content_type
            except (RateLimitError, UnreadableResponseError) as exc:
                last_exc = exc
                self.stats.api_calls += 1
                if isinstance(exc, RateLimitError):
                    self.stats.rate_limit_hits += 1
            except ProviderError as exc:
                last_exc = exc
                self.stats.api_calls += 1
                if not exc.retryable:
                    self._record_error(exc, resource)
                    raise
            if attempt < self.max_retries:
                self.stats.retries += 1
                # Exponential with jitter. Rate limits get a much longer floor:
                # a Yahoo block lasts minutes to hours, so retrying in 2s just
                # spends the budget without helping.
                base = 30.0 if isinstance(last_exc, RateLimitError) else 2.0
                delay = min(base * (2 ** (attempt - 1)), 300.0)
                time.sleep(delay * (0.75 + random.random() * 0.5))

        assert last_exc is not None
        self._record_error(last_exc, resource)
        raise last_exc

    def _request_once(self, url: str, *, attempt: int, resource: str) -> tuple[str, int, str]:
        token = self._token_provider()
        req = urllib.request.Request(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                raw = resp.read()
                status = resp.status
                content_type = resp.headers.get("Content-Type", "") or ""
                if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
                    raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
        except urllib.error.HTTPError as exc:
            status = exc.code
            content_type = (exc.headers.get("Content-Type", "") if exc.headers else "") or ""
            raw = exc.read() if exc.fp else b""
            body = raw.decode("utf-8", errors="replace")
            self._raise_for_status(status, body, url=url, resource=resource, attempt=attempt)
            # _raise_for_status always raises for a non-2xx; belt and braces.
            raise ProviderError(
                f"{resource}: unhandled HTTP {status}", resource=resource,
                endpoint=redact_url(url), http_status=status, retryable=True, attempt=attempt,
            ) from exc
        except urllib.error.URLError as exc:
            # Bare connection resets are a documented Yahoo behaviour under
            # sustained looping. Retryable, and explicitly NOT empty data.
            raise ProviderError(
                f"{resource}: transport failure — {redact_text(exc.reason)}",
                resource=resource, endpoint=redact_url(url),
                error_kind="transport", retryable=True, attempt=attempt,
            ) from exc
        except TimeoutError as exc:
            raise ProviderError(
                f"{resource}: timed out after {self.timeout_sec}s",
                resource=resource, endpoint=redact_url(url),
                error_kind="transport", retryable=True, attempt=attempt,
            ) from exc

        body = raw.decode("utf-8", errors="replace")
        self._raise_for_status(status, body, url=url, resource=resource, attempt=attempt)
        return body, status, content_type

    @staticmethod
    def _raise_for_status(status: int, body: str, *, url: str, resource: str, attempt: int) -> None:
        """Map an HTTP status onto a typed error. Never returns for non-2xx.

        The status check happens before any parse attempt, which is the entire
        point — 999's body is HTML and parsing it first turns a clean
        "we are being throttled" into an opaque decode error.
        """
        if 200 <= status < 300:
            # A 2xx whose body is obviously not JSON is still a failure. Yahoo
            # has been observed returning HTML with a 200 during incidents.
            stripped = body.lstrip()
            if stripped and stripped[0] not in "{[":
                raise UnreadableResponseError(
                    f"{resource}: HTTP {status} but the body is not JSON "
                    f"(starts with {stripped[:40]!r}). Treating as unreadable, "
                    "NOT as an empty result.",
                    resource=resource, endpoint=redact_url(url),
                    http_status=status, attempt=attempt,
                )
            return

        if status == HTTP_RATE_LIMITED:
            raise RateLimitError(
                f"{resource}: Yahoo returned HTTP 999 (throttled). Blocks are "
                "applied per client_id and last minutes to hours; backing off.",
                resource=resource, endpoint=redact_url(url),
                http_status=status, attempt=attempt,
            )
        if status == 429:
            raise RateLimitError(
                f"{resource}: HTTP 429 rate limited.",
                resource=resource, endpoint=redact_url(url),
                http_status=status, attempt=attempt,
            )
        if status == 401:
            raise AuthError(
                f"{resource}: HTTP 401 — the access token was rejected. It may "
                "have expired mid-run, or the app's Fantasy Read permission may "
                "not be approved yet.",
                resource=resource, endpoint=redact_url(url),
                http_status=status, attempt=attempt,
            )
        if status == 403:
            raise AccessDeniedError(
                f"{resource}: HTTP 403 — this account cannot read that resource. "
                "Private leagues are readable only by members, so a season the "
                "authenticating account never played is permanently unreachable.",
                resource=resource, endpoint=redact_url(url),
                http_status=status, attempt=attempt,
            )
        if status == 404:
            raise ProviderError(
                f"{resource}: HTTP 404 — no such resource.",
                resource=resource, endpoint=redact_url(url), http_status=status,
                error_kind="not_found", retryable=False, attempt=attempt,
            )
        if 500 <= status < 600:
            raise ProviderError(
                f"{resource}: HTTP {status} from Yahoo. Large collection requests "
                "intermittently 500; retrying.",
                resource=resource, endpoint=redact_url(url), http_status=status,
                error_kind="server", retryable=True, attempt=attempt,
            )
        raise ProviderError(
            f"{resource}: unexpected HTTP {status}: {redact_text(body)[:200]}",
            resource=resource, endpoint=redact_url(url), http_status=status,
            error_kind="unknown", retryable=False, attempt=attempt,
        )

    def _record_error(self, exc: ProviderError, resource: str) -> None:
        self.stats.errors.append({
            "resource": resource,
            "endpoint_path": exc.endpoint,
            "http_status": exc.http_status,
            "error_kind": exc.error_kind,
            "attempt": exc.attempt,
            "is_retryable": 1 if exc.retryable else 0,
            "message": redact_text(str(exc))[:1000],
        })


# ─────────────────────────────────────────────────────────────────────────────
# Token supply
# ─────────────────────────────────────────────────────────────────────────────

class TokenManager:
    """Keeps a live access token, refreshing it when it ages out.

    ⚠️ PERSIST-BEFORE-USE. When Yahoo rotates the refresh token, the new value
    is written to the store BEFORE the new access token is handed out. Doing it
    the other way round means a crash between the two loses access permanently
    and only reveals it an hour later.
    """

    def __init__(
        self,
        creds: yoauth.ClientCredentials,
        store: Any,
        *,
        on_refresh: Callable[[yoauth.TokenBundle], None] | None = None,
    ) -> None:
        self._creds = creds
        self._store = store
        self._bundle: yoauth.TokenBundle | None = None
        self._on_refresh = on_refresh
        self._lock = threading.Lock()

    def __call__(self) -> str:
        return self.access_token()

    def access_token(self) -> str:
        with self._lock:
            if self._bundle is not None and not self._bundle.is_expired:
                return self._bundle.access_token
            refresh_token = self._store.load()
            if not refresh_token:
                raise AuthError(
                    "No stored Yahoo refresh token. Authorize once with:\n"
                    "  npm run yahoo:auth\n"
                    "The token is then reused automatically and never needs a browser again."
                )
            bundle = yoauth.refresh(self._creds, refresh_token)
            # Persist FIRST. See the class docstring.
            if bundle.refresh_token and bundle.refresh_token != refresh_token:
                self._store.save(bundle.refresh_token)
            if self._on_refresh:
                self._on_refresh(bundle)
            self._bundle = bundle
            return bundle.access_token
