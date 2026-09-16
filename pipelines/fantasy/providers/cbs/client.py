"""HTTP for CBS history pages. Thin on purpose — the hard part is parse.py."""
from __future__ import annotations

import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

from .auth import CbsCookies
from .constants import draft_results_url

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")


@dataclass
class ClientStats:
    api_calls: int = 0
    retries: int = 0
    errors: list[str] = field(default_factory=list)


class CbsFetchError(RuntimeError):
    pass


class CbsClient:
    def __init__(self, cookies: CbsCookies, *, stats: ClientStats | None = None,
                 min_interval_sec: float = 1.0) -> None:
        self.cookies = cookies
        self.stats = stats or ClientStats()
        self.min_interval = min_interval_sec
        self._last = 0.0

    def _throttle(self) -> None:
        gap = time.time() - self._last
        if gap < self.min_interval:
            time.sleep(self.min_interval - gap)
        self._last = time.time()

    def get_html(self, url: str, *, attempts: int = 3) -> str:
        last = None
        for i in range(attempts):
            self._throttle()
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "text/html",
                "Cookie": self.cookies.cookie_header})
            try:
                with urllib.request.urlopen(req, timeout=40) as r:
                    self.stats.api_calls += 1
                    html = r.read().decode("utf-8", "ignore")
            except urllib.error.HTTPError as e:
                last = f"HTTP {e.code}"
                if e.code in (429, 500, 502, 503, 504) and i < attempts - 1:
                    self.stats.retries += 1
                    time.sleep(2 ** i)
                    continue
                break
            except Exception as e:                            # noqa: BLE001
                last = f"{type(e).__name__}: {e}"
                if i < attempts - 1:
                    self.stats.retries += 1
                    time.sleep(2 ** i)
                    continue
                break
            # ⚠️ A LOGIN REDIRECT RETURNS HTTP 200 WITH A FULL HTML PAGE.
            # Status is not proof; the marker is. Detected here so a stale
            # cookie surfaces as an auth error rather than "0 picks".
            if "product_abbrev=mgmt" in html or "/login?" in html[:4000]:
                raise CbsFetchError(
                    f"{url} returned a LOGIN page (HTTP 200). The `pid` cookie is "
                    f"stale — re-copy it from Chrome and re-store cbs_cookies.")
            return html
        self.stats.errors.append(f"{url}: {last}")
        raise CbsFetchError(f"{url}: {last}")

    def fetch_draft_results(self, season: int, league_id: str) -> str:
        return self.get_html(draft_results_url(season, league_id))
