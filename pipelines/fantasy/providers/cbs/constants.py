"""CBS Fantasy constants for league grffl.football.cbssports.com."""
from __future__ import annotations

PLATFORM = "cbs"
GAME_CODE = "ffl"

#: The league id CBS wants is the SUBDOMAIN STRING, not a number. Every
#: numeric guess returns HTTP 400 "Missing league_id"; 'grffl' returns 200.
DEFAULT_LEAGUE_ID = "grffl"


def league_host(league_id: str = DEFAULT_LEAGUE_ID) -> str:
    return f"https://{league_id}.football.cbssports.com"


def league_key(season: int, league_id: str = DEFAULT_LEAGUE_ID) -> str:
    """Season-scoped, matching the schema's contract for every platform."""
    return f"{GAME_CODE}.s{season}.l.{league_id}"


def team_key(season: int, league_id: str, franchise: str) -> str:
    """⚠️ CBS's HISTORY PAGES EXPOSE NO TEAM ID — only the franchise NAME as
    free text ("Pure Greatness", '"Sweet"ish Chef'). The key is therefore
    derived from a slug of that name. Consequence to know before joining:
    a franchise that RENAMES itself between seasons produces a different
    team_key, and one that reuses a name under a new owner collides. Owner
    continuity across seasons must come from fantasy_managers, never from
    this key alone."""
    slug = "".join(c.lower() if c.isalnum() else "-" for c in franchise).strip("-")
    while "--" in slug:
        slug = slug.replace("--", "-")
    return f"{GAME_CODE}.s{season}.l.{league_id}.t.{slug}"


#: Draft-results history lives ONLY at the PATH form. `?season=YYYY` also
#: returns HTTP 200 but with FEWER rows (252 vs 294 for 2019) — a silent
#: truncation that would quietly drop real picks from a backfill.
def draft_results_url(season: int, league_id: str = DEFAULT_LEAGUE_ID) -> str:
    return f"{league_host(league_id)}/draft/results/{season}"


#: Confirmed range on Keith's league; the season dropdown enumerates these.
FIRST_HISTORY_SEASON = 2013


# ─────────────────────────────────────────────────────────────────────────────
# JSON API — the CURRENT season only. History is HTML (see parse.py).
# ─────────────────────────────────────────────────────────────────────────────

def api_url(endpoint: str, league_id: str = DEFAULT_LEAGUE_ID) -> str:
    return f"{league_host(league_id)}/api/{endpoint.strip('/')}"


#: Endpoints proven to return HTTP 200 with a real body. Recorded because CBS
#: answers an UNKNOWN endpoint with a 95KB HTML 404 page, not a JSON error —
#: a guess that "works" is indistinguishable from one that doesn't unless you
#: check the content type. Probed 2026-08-23.
API_ENDPOINTS = (
    "league/details", "league/rules", "league/scoring/rules",
    "league/scoring/categories", "league/teams", "league/owners",
    "league/rosters", "league/schedules", "league/standings/overall",
    "league/draft/config", "league/draft/order", "league/draft/results",
    "league/scoring/live", "league/stats", "players/list",
)

#: ⚠️ `league/rosters` WITHOUT this parameter returns EXACTLY ONE TEAM — the
#: authenticating user's — with HTTP 200 and no indication that it narrowed the
#: result. An ingest that omitted it would capture 1/12 of the league and call
#: it a complete season. `team_id=all` returns all twelve.
ROSTERS_ALL_TEAMS = {"team_id": "all"}

#: ⚠️ SAME TRAP, SECOND ENDPOINT. `league/schedules` with no parameter returns
#: ONE period — the current one — out of seventeen, again at HTTP 200 with no
#: signal that it narrowed. `period=all` returns all seventeen. Two endpoints
#: now share this behaviour, so treat "CBS defaulted to a narrow slice" as the
#: expected case for any collection endpoint and prove the width every time.
SCHEDULES_ALL_PERIODS = {"period": "all"}

#: CBS marks an unplayed slot on the draft board with this literal player id.
#: `player` is still a populated object, so "does this pick name a player" is
#: NOT a truthiness test — 216 of 216 picks pass that test on an un-started
#: draft. The sentinel is the only reliable signal.
UPCOMING_PICK_SENTINEL = "UpcomingPick"

#: The flex slot as CBS spells it. Kept verbatim per the adapter contract; the
#: eligible positions are parsed out of the label rather than hardcoded.
FLEX_SEPARATOR = "-"

#: CBS's roster rules express BENCH capacity as a "Reserve Players" status row,
#: not as a lineup slot, so there is no bench row to mark is_bench_slot on.
#: Recorded here so the absence reads as a fact about CBS, not an omission.
RESERVE_STATUS_LABEL = "Reserve Players"


def team_key_from_id(season: int, league_id: str, team_id: str) -> str:
    """The CANONICAL team key, used for every API-sourced row.

    ⚠️ TWO KEYING SCHEMES COEXIST FOR CBS, DELIBERATELY. The JSON API exposes a
    stable numeric team id, so API rows key on it and match the schema's
    documented '{game_key}.l.{league_id}.t.{team_id}' contract. The HISTORY
    pages expose no id at all — only the franchise name as free text — so
    `team_key()` above slugs the name instead. Confirmed by grepping a live
    2025 draft page for every id-bearing pattern: zero matches.

    Consequence: a 2026 API team_key does NOT join to a 2025 history team_key.
    That is not papered over here. Owner continuity across the two comes from
    fantasy_managers (the API's GUIDs are stable) plus an explicit name
    crosswalk, built and validated as its own step rather than assumed.
    """
    return f"{GAME_CODE}.s{season}.l.{league_id}.t.{team_id}"
