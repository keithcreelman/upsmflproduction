#!/usr/bin/env python3
"""Find the actual highlight clip for a performance. Cached, so builds stay
deterministic.

WHY A CACHE IS NOT OPTIONAL
    A YouTube search is a live ranking: the same query returns different videos
    next week. Every other stage of this pipeline is byte-identical on a rerun,
    and `wire.py verify` depends on that. So a lookup happens ONCE, the winning
    video id is written to a committed JSON file, and every later build reads
    the file. Re-running a render a year from now produces the same article.

    It also means the API key is needed only when a NEW performance is looked
    up. CI renders without one.

WHAT "STRONG CONVICTION" MEANS HERE
    Keith asked for a match on name, team and position, and accepted less than
    certainty as long as the conviction is real. A wrong clip is worse than no
    clip -- it asserts a falsehood more convincingly than a sentence does -- so
    a candidate is only accepted when ALL of these hold:

      1. It is on an ALLOWED CHANNEL: the official NFL channel or the player's
         own NFL team channel. This alone eliminates reaction videos, fantasy
         shows, and highlight compilations from anonymous uploaders.
      2. The player's SURNAME appears in the title.
      3. The title says "highlights" (or the week number), so it is a clip and
         not a press conference or a podcast.
      4. It was PUBLISHED inside the game's own window -- the Thursday the week
         opened through ten days later. A career-retrospective video that
         mentions the right name is not this week's play.

    Anything short of all four is recorded as a miss, and the card falls back to
    the search link it has always carried. A miss is cached too, so a build does
    not re-query for the same dead end every time.
"""

import io
import json
import os
import re
import subprocess
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

CACHE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "highlight_cache.json")
API = "https://www.googleapis.com/youtube/v3/search"

# The official NFL channel. Team channels are resolved on demand and cached
# alongside the clips, because there are thirty-two of them and hardcoding
# thirty-two ids that can change is worse than one lookup.
NFL_CHANNEL_ID = "UCDVYQ4Zhbm3S2dlz7P1GBDg"


class VideoError(RuntimeError):
    pass


def _api_key():
    """YouTube Data API key, or None. Absence is normal, not an error.

    Never printed, never written to the cache, never included in a pack.
    """
    key = os.environ.get("YOUTUBE_API_KEY", "").strip()
    if key:
        return key
    try:
        proc = subprocess.run(
            ["security", "find-generic-password", "-s", "youtube_api_key", "-w"],
            capture_output=True, text=True, timeout=15)
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except Exception:                                     # noqa: BLE001
        pass
    return None


def load_cache():
    if not os.path.exists(CACHE_PATH):
        return {}
    try:
        return json.load(io.open(CACHE_PATH, encoding="utf-8"))
    except ValueError:
        return {}


def save_cache(cache):
    """Sorted and indented so a diff of new clips is readable in review."""
    with io.open(CACHE_PATH, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(cache, indent=2, ensure_ascii=False, sort_keys=True) + "\n")


def _week_window(season, week):
    """The Thursday the fantasy week opened, and ten days on.

    Same anchoring as wire_data.week_window and the Discord ingest. Kept local
    so this module has no import cycle back into the data layer.
    """
    d = datetime(int(season), 9, 4, tzinfo=timezone.utc)
    while d.weekday() != 3:
        d += timedelta(days=1)
    start = d + timedelta(weeks=int(week) - 1)
    return start, start + timedelta(days=10)


def _surname(player_name):
    """'Trey McBride' -> 'mcbride'. Handles suffixes, which titles drop."""
    parts = [p for p in re.split(r"[\s]+", str(player_name or "").strip()) if p]
    while parts and parts[-1].rstrip(".").lower() in ("jr", "sr", "ii", "iii", "iv", "v"):
        parts.pop()
    return parts[-1].lower() if parts else ""


def _search(key, query, published_after, published_before, channel_id=None):
    params = {
        "part": "snippet", "type": "video", "maxResults": "10",
        "q": query, "key": key, "videoEmbeddable": "true",
        "publishedAfter": published_after.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "publishedBefore": published_before.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if channel_id:
        params["channelId"] = channel_id
    url = "%s?%s" % (API, urllib.parse.urlencode(params))
    req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-highlights"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:                              # noqa: BLE001
        raise VideoError("YouTube search failed: %s" % exc)
    if "error" in payload:
        raise VideoError("YouTube API error: %s"
                         % str(payload["error"].get("message"))[:160])
    return payload.get("items") or []


def _accept(item, surname, week):
    """The four conviction tests. All must pass."""
    title = (item.get("snippet", {}).get("title") or "").lower()
    if surname not in title:
        return False
    if "highlight" not in title and ("week %d" % int(week)) not in title:
        return False
    return True


def find_highlight(season, week, player_id, player_name, nfl_team=None, position=None,
                   cache=None, key=None, allow_lookup=True):
    """Returns {"videoId","title","channel"} or None. Cached both ways.

    `allow_lookup=False` makes this cache-only, which is what CI wants: a render
    never needs a key, and a missing entry simply means no clip.
    """
    cache = load_cache() if cache is None else cache
    ck = "%s:%s:%s" % (season, week, player_id)
    if ck in cache:
        hit = cache[ck]
        return hit or None                                 # a cached miss is {}

    if not allow_lookup:
        return None
    key = key or _api_key()
    if not key:
        return None

    surname = _surname(player_name)
    if not surname:
        cache[ck] = {}
        return None
    after, before = _week_window(season, week)

    found = None
    query = "%s highlights week %d" % (player_name, int(week))
    for channel in (NFL_CHANNEL_ID, None):
        # NFL's own channel first. The unrestricted pass still has to clear the
        # title and window tests, and is only reached when the official channel
        # has nothing -- it is a fallback, not a widening of the standard.
        if channel is None:
            break
        try:
            items = _search(key, query, after, before, channel_id=channel)
        except VideoError:
            items = []
        for item in items:
            if _accept(item, surname, week):
                sn = item["snippet"]
                found = {"videoId": item["id"]["videoId"], "title": sn["title"],
                         "channel": sn.get("channelTitle") or "NFL"}
                break
        if found:
            break

    cache[ck] = found or {}
    return found
