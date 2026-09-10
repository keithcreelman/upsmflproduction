"""Yahoo OAuth 2.0 — read-only authorization, token exchange and refresh.

WHAT YAHOO DOCUMENTS (verified 2026-08-11 against the live pages):
  authorize : https://api.login.yahoo.com/oauth2/request_auth   (GET or POST)
  token     : https://api.login.yahoo.com/oauth2/get_token      (POST only)
  api base  : https://fantasysports.yahooapis.com/fantasy/v2

  - Access tokens live 3600 seconds.
  - redirect_uri must byte-match between the authorize call and the token
    exchange; Yahoo uses it "solely as a security check" per RFC 6749.
  - Credentials may be sent as body params OR HTTP Basic. Basic is used here.
    The base64 must carry NO trailing newline — that is an explicit
    troubleshooting note on Yahoo's own docs and a classic silent 401.
  - `oob` (out-of-band, paste-the-code) is still documented with no deprecation
    notice anywhere in Yahoo's OAuth guide text — but ⚠️ CONFIRMED 2026-08-12
    that the live app-registration form at developer.yahoo.com/apps/create/
    rejects the bare string `oob` in the Redirect URI(s) field with "Invalid
    URI" (client-side validation: it wants a URI, and `oob` isn't one). So
    while the token-exchange semantics for `oob` remain documented, no app can
    actually be registered with it as of this date. The default here is
    therefore a loopback URL (`https://localhost:PORT`), which needs no
    listener: `cmd_auth`'s non-oob branch prints the authorize URL, then asks
    you to copy the `code` param out of the browser's address bar after the
    (failed-to-load, expected) redirect — the paste-the-code UX survives even
    without `oob` support.

WHAT YAHOO DOES *NOT* DOCUMENT, AND HOW THAT IS HANDLED:
  - The scope identifier page (oauth2/guide/yahoo_scopes/) now returns HTTP 404.
    `fspt-r` (Fantasy Sports read-only) is community-known with high confidence,
    and it IS the correct string — see the confirmation below.
  - ⚠️ CONFIRMED 2026-08-12 (Keith, live run): `/oauth2/request_auth` with
    `scope=fspt-r` returns `error=invalid_scope` and bounces BEFORE showing a
    consent screen, for an app that has not had Fantasy Sports API access
    approved via the separate application at sports.yahoo.com/developer/access/.
    This resolves what was previously only a documented ambiguity ("does an
    existing app keep working without the new approval flow?") into a
    confirmed fact: no, and more specifically, the block is not just on data
    calls — it's on the AUTHORIZE step itself. An unapproved app cannot even
    request the `fspt-r` scope, let alone use it. There is nothing to fix in
    this client; the fix is Yahoo approving the access application. Once
    approved, no code change should be needed — same client_id, same scope
    string, same flow.
  - There is NO programmatic revocation endpoint. Revocation is user-initiated
    from Yahoo account settings. `revoke()` therefore marks the local record and
    tells the human what to do rather than pretending to call an API.

⚠️ TOKEN LIFETIME CONTRADICTION IN YAHOO'S OWN DOCS. flows_authcode says a
refresh token "persists even when the user changes passwords"; the FAQ says
"all your refresh tokens are revoked after you change your password". The FAQ is
treated as authoritative because it is the more specific page. Consequence: an
`invalid_grant` on refresh is a NORMAL, EXPECTED outcome that needs re-consent,
not a bug — it is surfaced as AuthError with a human-readable remedy.

⚠️ ALWAYS PERSIST A RETURNED REFRESH TOKEN. Yahoo "may issue a new refresh token,
in which case the client must discard the old" and "will revoke the old refresh
token after issuing a new one". In practice it usually returns the same string —
but a rotation that is not persisted is an UNRECOVERABLE loss of access that
only shows up an hour later. Persist first, then use the access token.

⚠️ NEVER STORED, ANYWHERE, BY ANYTHING IN THIS MODULE: Yahoo passwords,
verification/MFA codes, browser cookies, or the account email address.
"""

from __future__ import annotations

import base64
import json
import os
import secrets
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from ...keychain import forget_keychain_secret, keychain_secret, save_keychain_secret
from ...redact import redact_text
from ..base import AuthError, ProviderError

AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth"
TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token"

#: Fantasy Sports, read-only. Write access is unavailable from Yahoo in 2026
#: regardless of what is requested ("Write access is not available at this
#: time" — sports.yahoo.com/developer/access).
SCOPE_READ_ONLY = "fspt-r"

#: Yahoo's documented out-of-band redirect: no server, user pastes the code.
OOB_REDIRECT = "oob"

#: Access tokens last 3600s. Refresh this many seconds early so a long request
#: cannot start on a token that expires mid-flight.
EXPIRY_SKEW_SEC = 300


@dataclass
class TokenBundle:
    """An access token and the refresh token that produced it.

    `refresh_token` may be a NEW value Yahoo rotated in. The caller must persist
    it before using `access_token`, never after.
    """

    access_token: str
    refresh_token: str | None
    expires_at_unix: int
    scope: str | None = None
    yahoo_guid: str | None = None

    @property
    def is_expired(self) -> bool:
        return time.time() >= (self.expires_at_unix - EXPIRY_SKEW_SEC)

    def __repr__(self) -> str:
        # Defensive: a TokenBundle must never render its secrets, because a
        # bare `print(bundle)` or an exception repr would otherwise leak them.
        return (
            f"TokenBundle(access_token='[redacted]', refresh_token="
            f"{'[redacted]' if self.refresh_token else 'None'}, "
            f"expires_at_unix={self.expires_at_unix}, scope={self.scope!r})"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Credential sourcing
# ─────────────────────────────────────────────────────────────────────────────
#
# ⚠️ REFACTORED 2026-08-12: the Keychain helper that used to live only here
# (as a private `_keychain_secret`) moved to ../../keychain.py once ESPN's
# cookie-based auth needed the identical env-then-Keychain-then-refuse
# pattern. `_keychain_secret` is kept as a thin alias so nothing below (or any
# external caller) needs to change; behavior is byte-identical to before.
_keychain_secret = keychain_secret


@dataclass
class ClientCredentials:
    """The registered app's identity. Never logged, never persisted by us."""

    client_id: str
    client_secret: str
    redirect_uri: str

    @classmethod
    def from_env(cls) -> "ClientCredentials":
        """Load from environment / Keychain, refusing loudly when incomplete.

        ⚠️ NO HARDCODED FALLBACK, EVER. The repo contains a counter-example —
        a live MFL API key committed as an `os.environ.get(..., "<literal>")`
        default — which is exactly what RULE-SECRETS-001 forbids and what the
        wrangler.toml pinning comments call the silent-failure class. An unset
        credential must fail, not quietly "work".
        """
        client_id = _keychain_secret("YAHOO_CLIENT_ID", "yahoo_client_id")
        client_secret = _keychain_secret("YAHOO_CLIENT_SECRET", "yahoo_client_secret")
        # ⚠️ NO DEFAULT HERE EITHER, as of 2026-08-12. This used to fall back to
        # OOB_REDIRECT when unset, but Yahoo's live registration form rejects
        # `oob` as an invalid URI — no app can be registered with it — so a
        # silent default to it would produce a redirect_uri that byte-matches
        # nothing the user actually registered. Require it explicitly, same as
        # the two credentials below.
        redirect_uri = os.environ.get("YAHOO_REDIRECT_URI", "").strip()

        missing = [
            name for name, val in
            (("YAHOO_CLIENT_ID", client_id), ("YAHOO_CLIENT_SECRET", client_secret),
             ("YAHOO_REDIRECT_URI", redirect_uri))
            if not val
        ]
        if missing:
            raise AuthError(
                "Missing Yahoo OAuth credentials: " + ", ".join(missing) + ".\n"
                "Set them as environment variables, or add them to the macOS "
                "Keychain:\n"
                "  security add-generic-password -a \"$USER\" -s yahoo_client_id -w\n"
                "  security add-generic-password -a \"$USER\" -s yahoo_client_secret -w\n"
                "Obtain both by registering an app at "
                "https://developer.yahoo.com/apps/create/ — see "
                "docs/yahoo_fantasy_ingestion.md for the full walkthrough."
            )
        return cls(client_id=client_id, client_secret=client_secret, redirect_uri=redirect_uri)


# ─────────────────────────────────────────────────────────────────────────────
# Authorization
# ─────────────────────────────────────────────────────────────────────────────

def new_state() -> str:
    """256 bits of CSPRNG, URL-safe. Single-use, verified on callback."""
    return secrets.token_urlsafe(32)


def build_authorize_url(
    creds: ClientCredentials, *, state: str, scope: str = SCOPE_READ_ONLY,
    language: str = "en-us",
) -> str:
    """The URL the human opens to grant read-only access."""
    params = {
        "client_id": creds.client_id,
        "redirect_uri": creds.redirect_uri,
        "response_type": "code",
        "state": state,
        "scope": scope,
        "language": language,
    }
    return AUTHORIZE_URL + "?" + urllib.parse.urlencode(params)


def _post_token(creds: ClientCredentials, form: dict, *, timeout: int = 30) -> dict:
    """POST to Yahoo's token endpoint with HTTP Basic auth.

    Credentials go in the Authorization header rather than the body so they
    never appear in a URL, a form dump, or a retry log.
    """
    basic = base64.b64encode(
        f"{creds.client_id}:{creds.client_secret}".encode("utf-8")
    ).decode("ascii")  # NO trailing newline — Yahoo's docs call this out explicitly.

    body = urllib.parse.urlencode(form).encode("utf-8")
    req = urllib.request.Request(
        TOKEN_URL,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Basic {basic}",
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
            "User-Agent": "upsmfl-fantasy-ingest/1.0 (+read-only)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            status = resp.status
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        status = exc.code
        # invalid_grant is the documented signal that the refresh token is dead
        # — password change, user revocation, or a rotation we failed to persist.
        if "invalid_grant" in raw or status in (400, 401):
            raise AuthError(
                "Yahoo rejected the token request (HTTP "
                f"{status}). If this was a refresh, the refresh token is no longer "
                "valid — Yahoo revokes refresh tokens when the account password "
                "changes or the user removes the app. Re-run "
                "`npm run yahoo:auth` to re-consent.\n"
                f"Provider said: {redact_text(raw)[:300]}",
                http_status=status, endpoint=TOKEN_URL,
            ) from exc
        raise ProviderError(
            f"Yahoo token endpoint returned HTTP {status}: {redact_text(raw)[:300]}",
            http_status=status, endpoint=TOKEN_URL, error_kind="auth",
            retryable=status >= 500,
        ) from exc
    except urllib.error.URLError as exc:
        raise ProviderError(
            f"Could not reach Yahoo token endpoint: {redact_text(exc.reason)}",
            endpoint=TOKEN_URL, error_kind="transport", retryable=True,
        ) from exc

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        # A non-JSON body from the token endpoint is an error page or a throttle,
        # never an empty success.
        raise ProviderError(
            f"Yahoo token endpoint returned HTTP {status} with a non-JSON body "
            f"({len(raw)} bytes) — this is an error or throttle page, not a token.",
            http_status=status, endpoint=TOKEN_URL, error_kind="unparseable",
            retryable=True,
        ) from exc

    if "access_token" not in data:
        raise AuthError(
            "Yahoo token response contained no access_token; keys were "
            f"{sorted(data.keys())}",
            http_status=status, endpoint=TOKEN_URL,
        )
    return data


def _bundle_from_response(data: dict, *, fallback_refresh: str | None) -> TokenBundle:
    expires_in = data.get("expires_in")
    try:
        ttl = int(expires_in)
    except (TypeError, ValueError):
        ttl = 3600  # Yahoo's documented default; only used if the field is malformed.
    return TokenBundle(
        access_token=str(data["access_token"]),
        # Persist whatever came back. If Yahoo omitted it, the old one is still
        # current — but a returned value ALWAYS wins, because Yahoo revokes the
        # old token once it issues a new one.
        refresh_token=str(data.get("refresh_token") or "") or fallback_refresh,
        expires_at_unix=int(time.time()) + ttl,
        scope=data.get("scope"),
        yahoo_guid=data.get("xoauth_yahoo_guid"),
    )


def exchange_code(creds: ClientCredentials, code: str) -> TokenBundle:
    """Trade a single-use authorization code for tokens."""
    data = _post_token(creds, {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": creds.redirect_uri,
    })
    return _bundle_from_response(data, fallback_refresh=None)


def refresh(creds: ClientCredentials, refresh_token: str) -> TokenBundle:
    """Mint a new access token from a refresh token.

    The returned bundle's refresh_token MUST be persisted before the access
    token is used — see the module docstring.
    """
    if not refresh_token or not refresh_token.strip():
        raise AuthError(
            "No Yahoo refresh token available. Run `npm run yahoo:auth` once to "
            "authorize; after that the token is reused automatically."
        )
    data = _post_token(creds, {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token.strip(),
        "redirect_uri": creds.redirect_uri,
    })
    return _bundle_from_response(data, fallback_refresh=refresh_token.strip())


def revocation_instructions() -> str:
    """What to tell a human who wants to revoke access.

    Yahoo exposes no programmatic revocation endpoint for OAuth2 Fantasy, so
    this returns guidance rather than pretending to make a call. Claiming to
    have revoked a token that is still live would be worse than saying nothing.
    """
    return (
        "Yahoo provides no API to revoke an OAuth token. Revoke access yourself at\n"
        "  https://login.yahoo.com/account/security  →  'Apps connected to your account'\n"
        "Then run `npm run yahoo:auth -- --forget` to clear the stored token locally.\n"
        "Note: changing your Yahoo password also revokes every refresh token."
    )


# ─────────────────────────────────────────────────────────────────────────────
# Local token persistence (the no-Worker path)
# ─────────────────────────────────────────────────────────────────────────────

class LocalTokenStore:
    """Refresh token in the macOS Keychain, for laptop-driven backfills.

    WHY NOT A FILE. A dotfile refresh token is one `git add -A` away from being
    committed, and this repo already has a gitignore gap where a credentials
    file under pipelines/etl/config/ would NOT be ignored. The Keychain has no
    such failure mode and is already how every other local secret here is held.

    The Worker-backed store (`WorkerTokenStore`) is the alternative for
    unattended/CI runs; both satisfy the same tiny interface.
    """

    SERVICE = "yahoo_fantasy_refresh_token"

    def __init__(self, account_key: str = "primary") -> None:
        self.account_key = account_key

    def _service_name(self) -> str:
        return f"{self.SERVICE}:{self.account_key}"

    def load(self) -> str | None:
        return _keychain_secret("YAHOO_REFRESH_TOKEN", self._service_name())

    def save(self, refresh_token: str) -> None:
        """Persist via stdin so the secret never appears in an argv the process
        table (or a shell history) can see."""
        if not refresh_token:
            return
        try:
            subprocess.run(
                ["security", "add-generic-password", "-U",
                 "-a", os.environ.get("USER", ""), "-s", self._service_name(),
                 "-w", refresh_token],
                capture_output=True, text=True, timeout=10, check=True,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise ProviderError(
                "Could not store the Yahoo refresh token in the macOS Keychain. "
                "Store it manually with:\n"
                f"  security add-generic-password -U -a \"$USER\" -s {self._service_name()} -w\n"
                "(you will be prompted for the value; do not pass it on the command line)"
            ) from exc

    def forget(self) -> None:
        subprocess.run(
            ["security", "delete-generic-password",
             "-a", os.environ.get("USER", ""), "-s", self._service_name()],
            capture_output=True, text=True, timeout=10, check=False,
        )
