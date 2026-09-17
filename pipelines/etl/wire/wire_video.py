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

import html
import io
import json
import os
import re
import subprocess
import urllib.error
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


# Lookups that FAILED (bad key, quota, network) during this process. A failure
# is not a miss and is never cached as one: on 2026-09-16 an invalid key made
# every week-1 search return HTTP 400, find_highlight swallowed it, and four
# cards were cached as "no clip exists" forever. Callers read this and warn.
LOOKUP_ERRORS = []

# Official YouTube channel titles a hand-picked clip may come from: the NFL, or
# the player's own team (MFL team codes).
TEAM_CHANNELS = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GBP": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAC": "Jacksonville Jaguars",
    "KCC": "Kansas City Chiefs", "LAC": "Los Angeles Chargers", "LAR": "Los Angeles Rams",
    "LVR": "Las Vegas Raiders", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NEP": "New England Patriots", "NOS": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SEA": "Seattle Seahawks", "SFO": "San Francisco 49ers", "TBB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WAS": "Washington Commanders",
}


def _api_key():
    """YouTube Data API key, or None. Absence is normal, not an error.

    Never printed, never written to the cache, never included in a pack.

    A value that is not shaped like a Google API key (AIza + 35 characters) is
    an error, not an absence: on 2026-09-16 the Keychain item held the text of
    the `security` commands used to store it, pasted at the password prompt, and
    every lookup failed as a bare "API key not valid". Raises VideoError naming
    where the bad value came from and how to re-store it -- never the value.
    """
    key, where = os.environ.get("YOUTUBE_API_KEY", "").strip(), "the YOUTUBE_API_KEY environment variable"
    if not key:
        where = "Keychain item youtube_api_key"
        try:
            proc = subprocess.run(
                ["security", "find-generic-password", "-s", "youtube_api_key", "-w"],
                capture_output=True, text=True, timeout=15)
            key = proc.stdout.strip() if proc.returncode == 0 else ""
        except Exception:                                 # noqa: BLE001
            key = ""
    if not key:
        return None
    if not re.match(r"^AIza[0-9A-Za-z_-]{35}$", key):
        raise VideoError("%s is not a Google API key (%d characters; a key is 39 and starts with AIza) -- "
                         "re-store it with: security add-generic-password -U -a \"$USER\" -s youtube_api_key -w "
                         "(then paste ONLY the key at the prompt)" % (where, len(key)))
    return key


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
    except urllib.error.HTTPError as exc:
        try:
            why = json.loads(exc.read().decode("utf-8"))["error"]["message"]
        except Exception:                                 # noqa: BLE001
            why = str(exc)
        raise VideoError("YouTube search failed (HTTP %d): %s" % (exc.code, str(why)[:160]))
    except Exception as exc:                              # noqa: BLE001
        raise VideoError("YouTube search failed: %s" % exc)
    if "error" in payload:
        raise VideoError("YouTube API error: %s"
                         % str(payload["error"].get("message"))[:160])
    items = payload.get("items") or []
    # search.list returns snippet titles HTML-escaped ("Josh Allen&#39;s best
    # plays"); the renderer escapes again, so store plain text. Unescaped before
    # _accept too, or a surname with an apostrophe could never match.
    for item in items:
        sn = item.get("snippet") or {}
        if sn.get("title"):
            sn["title"] = html.unescape(sn["title"])
    return items


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
    try:
        key = key or _api_key()
    except VideoError as exc:
        LOOKUP_ERRORS.append("%s (%s): %s" % (player_name, ck, str(exc)[:240]))
        return None
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
        except VideoError as exc:
            # NOT a miss. Record it, cache nothing, and let the caller say so.
            LOOKUP_ERRORS.append("%s (%s): %s" % (player_name, ck, str(exc)[:160]))
            return None
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


def _video_id(url_or_id):
    """The 11-character id from a watch/shorts/youtu.be URL, or a bare id."""
    t = str(url_or_id or "").strip()
    for pat in (r"[?&]v=([A-Za-z0-9_-]{11})", r"youtu\.be/([A-Za-z0-9_-]{11})",
                r"/shorts/([A-Za-z0-9_-]{11})", r"/embed/([A-Za-z0-9_-]{11})", r"^([A-Za-z0-9_-]{11})$"):
        m = re.search(pat, t)
        if m:
            return m.group(1)
    raise VideoError("could not find a YouTube video id in %r" % t)


def _oembed(video_id):
    """Title + channel for a video, from YouTube's public oEmbed (no key).

    oEmbed answers 401 for a video whose owner disabled embedding and 400/404
    for one that does not exist -- both are refusals, not warnings.
    """
    url = ("https://www.youtube.com/oembed?format=json&url=" +
           urllib.parse.quote("https://www.youtube.com/watch?v=%s" % video_id, safe=""))
    req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-highlights"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 401:
            raise VideoError("video %s does not allow embedding" % video_id)
        raise VideoError("video %s was not found on YouTube (HTTP %d)" % (video_id, exc.code))
    except Exception as exc:                              # noqa: BLE001
        raise VideoError("could not reach YouTube oEmbed: %s" % exc)


def _published_at(key, video_id):
    url = "https://www.googleapis.com/youtube/v3/videos?%s" % urllib.parse.urlencode(
        {"part": "snippet", "id": video_id, "key": key})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ups-wire"}),
                                    timeout=30) as resp:
            items = json.loads(resp.read().decode("utf-8")).get("items") or []
    except Exception as exc:                              # noqa: BLE001
        raise VideoError("YouTube videos lookup failed: %s" % str(exc)[:120])
    if not items:
        raise VideoError("YouTube has no video %s" % video_id)
    return datetime.strptime(items[0]["snippet"]["publishedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc)


def set_clip(season, week, player_id, player_name, nfl_team, url, game_clip=False, cache=None):
    """An EDITOR-PICKED clip, checked before it is written to the cache.

    Same bar as the automatic lookup wherever it can be checked without
    guessing: the video must exist and allow embedding, come from the NFL's or
    the player's own team's official channel, and name the player in its title
    (a full game-highlights video from those channels may be allowed with
    game_clip=True). Publish date is checked against the week's window when a
    working YouTube key exists; otherwise the entry records that it was not.
    Returns the cache entry written.
    """
    cache = load_cache() if cache is None else cache
    vid = _video_id(url)
    meta = _oembed(vid)
    title, channel = meta.get("title") or "", meta.get("author_name") or ""
    allowed = {"nfl"} | ({TEAM_CHANNELS[nfl_team].lower()} if nfl_team in TEAM_CHANNELS else set())
    if channel.strip().lower() not in allowed:
        raise VideoError("%r is on channel %r -- only %s are accepted"
                         % (title, channel, " or ".join(sorted(allowed))))
    surname = _surname(player_name)
    if surname not in title.lower() and not game_clip:
        raise VideoError("the title %r does not name %s; pass --game-clip only if it is the "
                         "official game highlights he appears in" % (title, player_name))
    checks = {"embeddable": True, "officialChannel": channel,
              "namesPlayer": surname in title.lower()}
    try:
        key = _api_key()
    except VideoError as exc:
        key, checks["publishedInWindow"] = None, "not checked (%s)" % str(exc)[:80]
    published = None
    if key:
        try:
            published = _published_at(key, vid)
        except VideoError as exc:
            checks["publishedInWindow"] = "not checked (%s)" % str(exc)[:80]
    elif "publishedInWindow" not in checks:
        checks["publishedInWindow"] = "not checked (no YouTube key)"
    if published is not None:
        after, before = _week_window(season, week)
        if not after <= published <= before:
            raise VideoError("%r was published %s, outside week %d's window (%s to %s)"
                             % (title, published.date(), int(week), after.date(), before.date()))
        checks["publishedInWindow"] = published.strftime("%Y-%m-%dT%H:%M:%SZ")
    entry = {"videoId": vid, "title": title, "channel": channel, "pickedBy": "editor", "checks": checks}
    cache["%s:%s:%s" % (season, week, player_id)] = entry
    save_cache(cache)
    return entry
