"""ESPN credential sourcing — two session cookies, no OAuth.

⚠️ THESE ARE LIVE SESSION CREDENTIALS, NOT AN API KEY. `SWID` and `espn_s2`
are cookies ESPN's website sets when you log in at espn.com. They are the
functional equivalent of a session token — anyone holding them can act as
your ESPN identity for reading (and on espn.com itself, more than reading).
Treat them exactly like a password:
  - never paste them into chat, a commit, an issue, or a log line
  - store them ONLY via the macOS Keychain (see below) or a CI secret
  - if they ever leak, the remedy is logging out of ESPN everywhere (which
    rotates them) — there is no narrower revocation

HOW TO GET THEM (do this yourself, in your own browser):
  1. Log into https://www.espn.com in a normal browser tab.
  2. Open DevTools → Application (Chrome) or Storage (Firefox) → Cookies →
     https://www.espn.com.
  3. Find `SWID` (a short GUID like {ABCXXXXX-...}) and `espn_s2` (a long
     opaque string). Copy each value — not the cookie name, the value.
  4. Store them locally:
       security add-generic-password -a "$USER" -s espn_swid -w
       security add-generic-password -a "$USER" -s espn_s2 -w
     (each prompts for the value; never put it on the command line)

WHY NO OAuth. ESPN Fantasy has no public developer program and no OAuth flow
at all — this is a materially less durable foundation than Yahoo's, and it is
worth saying so plainly rather than dressing it up as equivalent. There is
nothing to apply for and no approval queue, which is why ESPN was the faster
platform to start on; the tradeoff is that ESPN can change or invalidate this
without notice, with no changelog and no deprecation window.

PUBLIC LEAGUES NEED NO CREDENTIALS AT ALL. If a league's privacy setting is
public, ESPN serves its data with no cookies present. This adapter still
accepts cookies when available (most real leagues, including ones you have
played in for years, are set to private) but does not require them.
"""

from __future__ import annotations

from dataclasses import dataclass

from ...keychain import keychain_secret


@dataclass
class EspnCookies:
    """Session credentials for one ESPN account. Empty means 'try unauthenticated'.

    ⚠️ Never render these. There is no __repr__ override here on purpose —
    the default dataclass repr WOULD print both values verbatim, so nothing in
    this codebase may call repr()/str() or log this object directly. Log
    `bool(cookies.is_present)` instead.
    """

    swid: str | None
    espn_s2: str | None

    @property
    def is_present(self) -> bool:
        return bool(self.swid and self.espn_s2)

    def as_cookie_header(self) -> str | None:
        """The literal Cookie header value, or None for an unauthenticated request."""
        if not self.is_present:
            return None
        # SWID is stored and sent WITH its braces, e.g. '{ABC12345-...}' — ESPN
        # rejects a stripped value. espn_s2 is used exactly as copied.
        swid = self.swid if self.swid.startswith("{") else "{" + self.swid.strip("{}") + "}"
        return f"SWID={swid}; espn_s2={self.espn_s2}"

    def __repr__(self) -> str:  # never leak via a bare print(cookies)
        return f"EspnCookies(swid={'[set]' if self.swid else 'None'}, espn_s2={'[set]' if self.espn_s2 else 'None'})"


def load_cookies(account_key: str = "primary") -> EspnCookies:
    """Load from environment / Keychain. Returns an empty EspnCookies if unset.

    ⚠️ DELIBERATELY DOES NOT RAISE ON ABSENCE, unlike Yahoo's
    ClientCredentials.from_env(). A missing Yahoo client_secret means nothing
    can work at all — refusing loudly is correct. A missing ESPN cookie pair
    means only that PRIVATE leagues are unreachable; a PUBLIC league still
    works with no cookies. The caller (the adapter, when it actually gets a
    403/401 from ESPN) is what decides whether the absence mattered, and that
    decision is provider.fetch_*'s to make, not this loader's.
    """
    suffix = f":{account_key}" if account_key != "primary" else ""
    swid = keychain_secret("ESPN_SWID", f"espn_swid{suffix}")
    s2 = keychain_secret("ESPN_S2", f"espn_s2{suffix}")
    return EspnCookies(swid=swid, espn_s2=s2)
