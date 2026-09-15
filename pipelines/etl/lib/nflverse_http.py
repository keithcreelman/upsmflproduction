"""Make nflreadpy downloads survive transient GitHub release-asset stalls.

nflreadpy 0.1.5 does one `requests.get(timeout=30)` per file and never
retries. On 2026-09-09 a 30s read stall on snap_counts_2025.parquet killed the
whole weekly refresh, after 15 minutes of work. harden():

  1. raises the timeout (NFLREADPY_TIMEOUT, default 120s);
  2. mounts urllib3 retries with backoff on nflreadpy's session (connect
     errors, stalls before headers, 429/5xx);
  3. retries a whole file download that dies mid-body, which (2) can't see.

A 404 is not retried: that's "not published", not a blip.

Relies on nflreadpy internals (get_downloader().session and
NflverseDownloader._download_file), so CI pins nflreadpy==0.1.5.
"""
from __future__ import annotations

import os
import sys
import time

_HARDENED = False
FILE_ATTEMPTS = 3


def harden() -> None:
    global _HARDENED
    if _HARDENED:
        return
    import requests
    from requests.adapters import HTTPAdapter
    from urllib3.util.retry import Retry
    from nflreadpy import downloader as dl
    from nflreadpy.config import update_config

    update_config(timeout=int(os.environ.get("NFLREADPY_TIMEOUT") or 120))

    retry = Retry(
        total=5, connect=5, read=5, status=5,
        backoff_factor=2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "HEAD"}),
    )
    adapter = HTTPAdapter(max_retries=retry)
    session = dl.get_downloader().session
    session.mount("https://", adapter)
    session.mount("http://", adapter)

    original = dl.NflverseDownloader._download_file

    def _download_file(self, url, **kwargs):
        for attempt in range(1, FILE_ATTEMPTS + 1):
            try:
                return original(self, url, **kwargs)
            except ConnectionError as e:
                cause = e.__cause__
                if (
                    isinstance(cause, requests.HTTPError)
                    and cause.response is not None
                    and cause.response.status_code == 404
                ):
                    raise
                if attempt == FILE_ATTEMPTS:
                    raise
                wait = 10 * attempt
                print(
                    f"  [nflverse] download failed (attempt {attempt}/{FILE_ATTEMPTS}), "
                    f"retrying in {wait}s: {e}",
                    file=sys.stderr,
                )
                time.sleep(wait)

    dl.NflverseDownloader._download_file = _download_file
    _HARDENED = True
