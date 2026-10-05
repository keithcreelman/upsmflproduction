"""Secret redaction for logs, error rows and exception messages.

WHY THIS IS A MODULE AND NOT AN INLINE re.sub. This pipeline is the first thing
in the repo to handle OAuth material, and the repo already has a documented
incident where live secrets were printed into agent tool output because a
command echoed them instead of piping them. Redaction that lives in one place
can be tested; redaction sprinkled at call sites cannot.

WHAT IS CONSIDERED SECRET. Anything that grants access:
  - client_secret          (long-lived, in a Worker secret / env)
  - refresh_token          (long-lived, encrypted at rest in D1)
  - access_token           (1 hour, but still a bearer credential)
  - code                   (single-use authorization code)
  - Authorization headers  (carry the bearer token)

WHAT IS NOT SECRET AND MUST SURVIVE REDACTION. league keys, team keys, player
keys, game keys, seasons, weeks, HTTP status codes. Over-redacting makes errors
undiagnosable, which is its own failure mode — a redactor that turns every URL
into "[redacted]" means nobody can tell which request failed.

⚠️ NEVER log a value this module has not passed through. The rule is: build the
message, redact it, THEN emit it. Redacting after the fact is not possible.
"""

from __future__ import annotations

import re
from typing import Any, Mapping
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

REDACTED = "[redacted]"

# Query-string / form-field names whose VALUES must never be emitted.
SECRET_PARAM_NAMES = frozenset(
    {
        "client_secret",
        "client_id",  # not strictly secret, but pairs with the secret; no reason to log it
        "refresh_token",
        "access_token",
        "code",
        "id_token",
        "state",  # single-use CSRF token; logging it weakens the check
        "nonce",
        "assertion",
        "password",
    }
)

# Header names whose values must never be emitted.
SECRET_HEADER_NAMES = frozenset({"authorization", "cookie", "set-cookie", "proxy-authorization"})

# Free-text patterns, for messages that are not structured (exception strings,
# provider error bodies). Ordered most-specific first.
_FREE_TEXT_PATTERNS = (
    # bearer tokens in a header echoed into a message
    re.compile(r"(?i)\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}", ),
    # key=value in a querystring or form body
    re.compile(
        r"(?i)\b(" + "|".join(sorted(SECRET_PARAM_NAMES)) + r")=([^&\s\"']+)"
    ),
    # JSON "key": "value"
    re.compile(
        r"(?i)\"(" + "|".join(sorted(SECRET_PARAM_NAMES)) + r")\"\s*:\s*\"[^\"]*\""
    ),
)


def redact_text(text: Any) -> str:
    """Redact secret material from an arbitrary string.

    Safe to call on None or a non-string; returns a string either way, because
    the callers are logging paths and a redactor that raises is a redactor that
    gets wrapped in a bare except and bypassed.
    """
    if text is None:
        return ""
    s = str(text)
    s = _FREE_TEXT_PATTERNS[0].sub(r"\1 " + REDACTED, s)
    s = _FREE_TEXT_PATTERNS[1].sub(lambda m: f"{m.group(1)}={REDACTED}", s)
    s = _FREE_TEXT_PATTERNS[2].sub(lambda m: f'"{m.group(1)}": "{REDACTED}"', s)
    return s


def redact_url(url: Any) -> str:
    """Rewrite a URL so secret query parameters carry no value.

    Structural: parses the query rather than regexing it, so a token containing
    an '&' or an encoded character cannot leak through a greedy match. This
    mirrors the existing worker-side redactUrlSecrets helper, which chose
    URLSearchParams over a regex for the same reason.

    The path, host and every non-secret parameter are preserved — you still need
    to know WHICH request failed.
    """
    if not url:
        return ""
    try:
        parts = urlsplit(str(url))
    except (ValueError, AttributeError):
        return redact_text(url)
    if not parts.query:
        return str(url)
    cleaned = [
        (k, REDACTED if k.lower() in SECRET_PARAM_NAMES else v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit(
        (parts.scheme, parts.netloc, parts.path, urlencode(cleaned), parts.fragment)
    )


def redact_headers(headers: Mapping[str, Any] | None) -> dict:
    """Return a copy of `headers` with credential-bearing values replaced."""
    if not headers:
        return {}
    return {
        k: (REDACTED if str(k).lower() in SECRET_HEADER_NAMES else v)
        for k, v in headers.items()
    }


def redact_params(params: Mapping[str, Any] | None) -> dict:
    """Return a copy of `params` with secret values replaced."""
    if not params:
        return {}
    return {
        k: (REDACTED if str(k).lower() in SECRET_PARAM_NAMES else v)
        for k, v in params.items()
    }


def safe_repr(value: Any, limit: int = 400) -> str:
    """A truncated, redacted repr for diagnostics.

    Truncation matters as much as redaction here: an unbounded provider error
    body dumped into a D1 error row can blow past the ~100KB single-statement
    cap and take the whole insert down with it.
    """
    return redact_text(value)[:limit]
