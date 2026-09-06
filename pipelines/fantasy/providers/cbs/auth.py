"""CBS auth. TWO separate credentials — do not mix them up.

  cbs_access_token  -> authenticates the JSON API (query param). Current
                       season only; the API serves no history.
  cbs_cookies       -> authenticates the HTML history pages. Proven by
                       leave-one-out testing: **`pid` alone is necessary AND
                       sufficient**. `anon` and `tpid` ride along and do
                       nothing; without `pid` every page is a login redirect.

⚠️ Fails CLOSED. No cookie means raise, never "fetch anonymously and report an
empty draft" — an anonymous fetch returns a login page that still parses as a
valid HTML document with zero picks.
"""
from __future__ import annotations

from dataclasses import dataclass

from ...keychain import keychain_secret


class CbsAuthMissing(RuntimeError):
    pass


@dataclass(frozen=True)
class CbsCookies:
    cookie_header: str

    @property
    def names(self) -> list[str]:
        return [p.split("=", 1)[0].strip() for p in self.cookie_header.split(";") if "=" in p]

    @property
    def has_session(self) -> bool:
        """`pid` is the whole ballgame — see module docstring."""
        return any(n.lower() == "pid" for n in self.names)


def load_cookies(account_key: str = "primary") -> CbsCookies:
    raw = keychain_secret("CBS_COOKIES", "cbs_cookies") or ""
    raw = raw.strip()
    if not raw:
        raise CbsAuthMissing(
            "No CBS cookies found (env CBS_COOKIES or Keychain 'cbs_cookies').\n"
            "  In Chrome on the league page press ⌥⌘J, type `allow pasting`, then run:\n"
            "    copy(document.cookie.split(';').map(c=>c.trim())"
            ".filter(c=>/^pid=/i.test(c)).join('; '))\n"
            "  then: security add-generic-password -U -a \"$USER\" -s cbs_cookies -w")
    ck = CbsCookies(raw)
    if not ck.has_session:
        raise CbsAuthMissing(
            f"Stored CBS cookies have no `pid` — got {ck.names}. `pid` is the only "
            f"cookie that authenticates; without it every history page is a login "
            f"redirect that would parse as an empty draft.")
    return ck
