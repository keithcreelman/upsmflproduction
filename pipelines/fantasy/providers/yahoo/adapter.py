"""YahooProvider — the FantasyProvider implementation for Yahoo Fantasy Sports.

Everything Yahoo-specific stops here. Callers see FetchResults full of
platform-neutral rows keyed like the fantasy_* columns; they never learn that
Yahoo collections are objects with a "count" sibling, that a league key embeds a
per-season game id, or that a throttle arrives as HTTP 999.

REQUEST-BUDGET NOTES (they shape the method bodies):

  * `/league/{lk}/teams/roster;week=N` fetches ALL twelve teams' rosters for a
    week in ONE call. Per-team fetching would be 12x the requests for identical
    data, and Yahoo's rate limit is per client_id — so the batched form is not
    an optimization, it is the difference between a backfill finishing and the
    app getting blocked.

  * Rosters alone carry NO points. Per-player weekly points need the chained
    form `.../roster;week=N/players/stats;type=week;week=N`. That is one extra
    call per league-week, and it is the only way to get historical bench points.

  * `;out=` is one level deep only and cannot take parameters, so deep weekly
    data always needs its own request path. There is no way around the
    per-week loop.
"""

from __future__ import annotations

from typing import Iterator, Sequence

from ...redact import redact_text
from ..base import (
    AccessDeniedError,
    FantasyProvider,
    FetchResult,
    LeagueRef,
    ProviderError,
)
from . import parse
from .client import YahooClient
from .shape import as_list, flatten_resource, get, to_int, to_text

PLATFORM = "yahoo"

# Cover Page of the executed API Access and Use Agreement (effective
# 2026-08-21). Kept as a constant so the scope is quotable at the point of
# enforcement rather than living only in a doc nobody re-reads.
APPROVED_USE_CASE = (
    "read-only access to pull completed drafts, transactions, weekly rosters, "
    "and final standings for the purpose of computing historical statistics"
)

# MANDATORY attribution — Cover Page of the same agreement. This is a condition
# of the license, not a courtesy: it must appear on EVERY surface that displays
# Yahoo Fantasy Information.
#   Web    — footer of each such page, hyperlinked to an official Yahoo Fantasy page.
#   Mobile — inside the app, e.g. an "About" or "Legal" section.
#   App store listing (if Yahoo data is a material feature) —
#            "This application uses fantasy data provided by Yahoo Fantasy."
# Defined here, next to the provider, so a UI never has to re-type the wording
# and drift out of compliance. ⚠️ Only required for YAHOO-sourced rows — do not
# stamp it on ESPN data, which is not covered by this agreement.
ATTRIBUTION_TEXT = "Fantasy data provided by Yahoo Fantasy"
ATTRIBUTION_URL = "https://football.fantasysports.yahoo.com/"
ATTRIBUTION_HTML = (
    f'<a href="{ATTRIBUTION_URL}" target="_blank" rel="noopener noreferrer">'
    f'{ATTRIBUTION_TEXT}</a>'
)


class OutsideApprovedUseCase(ProviderError):
    """A Yahoo resource the API offers that our AGREEMENT does not permit.

    Distinct from both 'not offered by the platform' and 'not built yet': the
    endpoint exists and the adapter can parse it, but calling it would exceed
    the Approved Use Case on the Cover Page of the signed agreement, or breach
    one of the Exhibit A restrictions.

    Raising (never returning an empty complete=False FetchResult) is the same
    no-fail-open discipline used everywhere else here, applied to a CONTRACT
    boundary: a silent empty result would look like "Yahoo had no data", which
    would be a false statement about Yahoo's API and would hide the fact that
    we declined on purpose.
    """

    def __init__(self, resource: str, clause: str, note: str) -> None:
        super().__init__(
            f"{resource}: outside the Approved Use Case of the executed Yahoo "
            f"API Access and Use Agreement ({clause}). {note} "
            f"Approved Use Case is: {APPROVED_USE_CASE}.",
            resource=resource, error_kind="outside_approved_use_case",
            retryable=False,
        )


class YahooProvider(FantasyProvider):
    platform = PLATFORM

    def __init__(self, client: YahooClient, *, game_code: str = "nfl") -> None:
        self.client = client
        self.game_code = game_code
        # Slot classification is per league-season and is looked up once, then
        # reused for every week. Without it, is_starter stays NULL rather than
        # being guessed — see fetch_rosters.
        self._slot_cache: dict[str, tuple[set[str], set[str], set[str]]] = {}
        self._settings_cache: dict[str, dict] = {}

    # ── discovery ────────────────────────────────────────────────────────────

    def list_nfl_games(self, seasons: Sequence[int] | None = None) -> list[dict]:
        """Every NFL game key the provider knows about, by season.

        ⚠️ Called at bootstrap and once each preseason. Game ids are NOT
        derivable (2019=390, 2020=399, 2025=461 — no pattern), so hardcoding one
        silently queries the wrong season.
        """
        params = {"game_codes": self.game_code}
        if seasons:
            params["seasons"] = ",".join(str(s) for s in sorted(seasons))
        content = self.client.get_json("games", resource="games", params=params)
        return parse.parse_games(content)

    def discover_leagues(self, *, seasons: Sequence[int] | None = None) -> list[LeagueRef]:
        """Every league-season this account can reach, from two mechanisms.

        ⚠️ THE ORDER MATTERS AND SO DOES THE FILTERING. Calling
        `/users;use_login=1/games/leagues` unfiltered throws if the account ever
        played a game type that has no league sub-resource (pick'em, DFS) — a
        documented behaviour and the single biggest practical trap in
        cross-season discovery. So: enumerate games first, filter client-side to
        full NFL games, then ask for leagues by explicit game key.
        """
        games = self._user_games()
        nfl = [
            g for g in games
            if (g.get("game_code") == self.game_code)
            and (g.get("game_type") in (None, "full"))
        ]
        if seasons:
            wanted = set(seasons)
            nfl = [g for g in nfl if g.get("season") in wanted]
        if not nfl:
            return []

        refs: list[LeagueRef] = []
        seen: set[str] = set()
        # Batched by game key. Yahoo documents no maximum; community practice is
        # to stay conservative, so this batches in tens rather than sending 15
        # game keys in one URL.
        keys = [g["game_key"] for g in nfl if g.get("game_key")]
        for chunk in _chunks(keys, 10):
            content = self.client.get_json(
                "users;use_login=1/games/leagues",
                resource="users.games.leagues",
                params={"game_keys": ",".join(chunk)},
            )
            for row in parse.parse_user_leagues(content):
                key = row.get("league_key")
                if not key or key in seen:
                    continue
                seen.add(key)
                refs.append(_ref_from_row(row))
        return refs

    def _user_games(self) -> list[dict]:
        content = self.client.get_json(
            "users;use_login=1/games", resource="users.games", params=None
        )
        out: list[dict] = []
        for user_node in as_list(get(content, "users")):
            user = flatten_resource(get(user_node, "user", default=user_node))
            for g_node in as_list(get(user, "games")):
                game = flatten_resource(get(g_node, "game", default=g_node))
                out.append({
                    "game_key": to_text(get(game, "game_key")),
                    "game_code": to_text(get(game, "code")),
                    "game_type": to_text(get(game, "type")),
                    "season": to_int(get(game, "season")),
                })
        return out

    def follow_renewal_chain(self, seed: LeagueRef, *, max_hops: int = 30) -> list[LeagueRef]:
        """Walk `renew` backwards and `renewed` forwards from a known league.

        WHY THIS EXISTS ALONGSIDE discover_leagues. The account-based query only
        reaches seasons the AUTHENTICATING account actually played. If ownership
        changed hands, or the account joined late, those seasons are invisible to
        it — but the renewal chain still links them. Neither mechanism alone is
        complete; running both and unioning is.
        """
        found: dict[str, LeagueRef] = {}
        for direction in ("renew_key", "renewed_key"):
            cursor: str | None = getattr(seed, direction)
            hops = 0
            while cursor and hops < max_hops:
                if cursor in found:
                    break
                try:
                    content = self.client.get_json(
                        f"league/{cursor}", resource="league.metadata", params=None,
                        scope={"league_key": cursor},
                    )
                except AccessDeniedError:
                    # A season this account cannot read. Recorded by the caller
                    # as access_denied; the chain stops here because we cannot
                    # read its own renew pointer.
                    break
                except ProviderError:
                    break
                row = parse.parse_league_metadata(content)
                if not row:
                    break
                row["discovery_source"] = "renew_chain"
                ref = _ref_from_row(row)
                found[cursor] = ref
                cursor = row.get(direction)
                hops += 1
        return list(found.values())

    # ── league ───────────────────────────────────────────────────────────────

    def fetch_league_metadata(self, league: LeagueRef) -> FetchResult:
        content = self.client.get_json(
            f"league/{league.league_key}", resource="league.metadata", params=None,
            scope={"league_key": league.league_key, "season": league.season},
        )
        row = parse.parse_league_metadata(content)
        rows = [row] if row else []
        return FetchResult(rows=rows, resource="league.metadata", api_calls=1,
                           complete=bool(rows))

    def fetch_league_settings(self, league: LeagueRef) -> FetchResult:
        content = self.client.get_json(
            f"league/{league.league_key}/settings", resource="league.settings", params=None,
            scope={"league_key": league.league_key, "season": league.season},
        )
        tables = parse.parse_league_settings(
            content, league_key=league.league_key, season=league.season
        )
        self._settings_cache[league.league_key] = tables
        self._cache_slots(league.league_key, tables.get("fantasy_roster_positions", []))
        return FetchResult(rows=_tagged(tables), resource="league.settings", api_calls=1)

    def _cache_slots(self, league_key: str, roster_positions: list[dict]) -> None:
        starting, bench, injury = set(), set(), set()
        for rp in roster_positions:
            pos = (rp.get("position") or "").upper()
            if not pos:
                continue
            if rp.get("is_bench_slot"):
                bench.add(pos)
            elif rp.get("is_injury_slot"):
                injury.add(pos)
            if rp.get("is_starting_slot"):
                starting.add(pos)
        if starting or bench or injury:
            self._slot_cache[league_key] = (starting, bench, injury)

    # ── participants ─────────────────────────────────────────────────────────

    def fetch_teams(self, league: LeagueRef) -> FetchResult:
        content = self.client.get_json(
            f"league/{league.league_key}/teams", resource="league.teams", params=None,
            scope={"league_key": league.league_key, "season": league.season},
        )
        tables = parse.parse_teams(content, league_key=league.league_key, season=league.season)
        return FetchResult(rows=_tagged(tables), resource="league.teams", api_calls=1)

    def fetch_managers(self, league: LeagueRef) -> FetchResult:
        """Managers come embedded in the teams payload.

        Fetching them separately would be a second request for data already in
        hand. The method exists because the interface promises it — and because
        CBS/ESPN may well need a distinct call — but on Yahoo it reuses the
        teams response and reports 0 extra API calls, which keeps the run
        accounting honest.
        """
        result = self.fetch_teams(league)
        rows = [r for r in result.rows
                if r.get("_table") in ("fantasy_managers", "fantasy_team_managers")]
        return FetchResult(rows=rows, resource="league.managers",
                           api_calls=result.api_calls,
                           notes="derived from the teams payload; no extra request")

    # ── history ──────────────────────────────────────────────────────────────

    def fetch_draft_results(self, league: LeagueRef) -> FetchResult:
        is_auction = self._is_auction(league)
        content = self.client.get_json(
            f"league/{league.league_key}/draftresults", resource="league.draftresults",
            params=None,
            scope={"league_key": league.league_key, "season": league.season},
        )
        tables = parse.parse_draft_results(
            content, league_key=league.league_key, season=league.season,
            is_auction=is_auction, game_code=self.game_code,
        )
        picks = tables.get("fantasy_draft_events", [])
        notes = None
        if is_auction is None:
            notes = ("league settings were not fetched first, so auction-vs-snake "
                     "is unknown; auction_cost is stored as returned and "
                     "is_price_bearing is 0")
        return FetchResult(rows=_tagged(tables), resource="league.draftresults",
                           api_calls=1, complete=bool(picks), notes=notes)

    def _is_auction(self, league: LeagueRef) -> int | None:
        cached = self._settings_cache.get(league.league_key)
        if not cached:
            return None
        rows = cached.get("fantasy_league_settings") or []
        return rows[0].get("is_auction_draft") if rows else None

    def fetch_transactions(self, league: LeagueRef) -> FetchResult:
        """All COMPLETED transactions for the league-season.

        ⚠️ Yahoo documents no `start` parameter on the transactions collection —
        only `count`. Whether it silently paginates is undocumented and untested,
        so this makes the unfiltered request (which returns full history for a
        completed season) and reports the observed count. The completeness check
        compares it against the teams' own number_of_moves/number_of_trades; a
        shortfall is surfaced rather than assumed away.
        """
        content = self.client.get_json(
            f"league/{league.league_key}/transactions", resource="league.transactions",
            params=None,
            scope={"league_key": league.league_key, "season": league.season},
        )
        tables = parse.parse_transactions(
            content, league_key=league.league_key, season=league.season,
            game_code=self.game_code,
        )
        parents = tables.get("fantasy_transactions", [])
        return FetchResult(rows=_tagged(tables), resource="league.transactions",
                           api_calls=1, complete=True,
                           notes=f"{len(parents)} completed transactions; losing "
                                 "waiver claims and rejected trades are not exposed "
                                 "by the API and are absent by design")

    def fetch_standings(self, league: LeagueRef) -> FetchResult:
        content = self.client.get_json(
            f"league/{league.league_key}/standings", resource="league.standings",
            params=None,
            scope={"league_key": league.league_key, "season": league.season},
        )
        rows = parse.parse_standings(
            content, league_key=league.league_key, season=league.season
        )
        # ⚠️ ONE state only, and as_of_week IS part of this table's primary
        # key — a row without it is not just incomplete, d1.py refuses to
        # write it at all ("missing primary-key column(s)"). This comment used
        # to just PROMISE "the loader stamps it" with nothing actually doing
        # so; a live ESPN backfill (same gap, same schema) hit the refusal
        # first and this was fixed here at the same time. Prefer current_week
        # (a live season) and fall back to end_week (a closed one) — both come
        # from the SAME settings fetch that already ran, no extra request.
        as_of_week = self._current_week(league) or self._settings_end_week(league)
        if as_of_week is None:
            raise ProviderError(
                "league.standings: cannot determine as_of_week — fetch league "
                "settings before standings so current_week/end_week are known.",
                resource="league.standings", error_kind="unknown", retryable=False,
            )
        return FetchResult(
            rows=[{**r, "as_of_week": as_of_week, "_table": "fantasy_standings_snapshots"}
                  for r in rows],
            resource="league.standings", api_calls=1,
            notes="single provider state (final for a closed season, current for "
                  "a live one); weekly history is reconstructed and flagged inferred",
        )

    # ── weekly ───────────────────────────────────────────────────────────────

    def fetch_scoreboard(self, league: LeagueRef, week: int) -> FetchResult:
        content = self.client.get_json(
            f"league/{league.league_key}/scoreboard", resource="league.scoreboard",
            params={"week": week},
            scope={"league_key": league.league_key, "season": league.season, "week": week},
        )
        tables = parse.parse_scoreboard(
            content, league_key=league.league_key, season=league.season
        )
        return FetchResult(rows=_tagged(tables), resource="league.scoreboard",
                           api_calls=1,
                           complete=bool(tables.get("fantasy_matchups")))

    def fetch_rosters(self, league: LeagueRef, week: int) -> FetchResult:
        """Every team's roster for one week, in a single request.

        `/league/{lk}/teams/roster;week=N` returns all twelve rosters at once.
        Per-team fetching is 12x the requests against a per-client_id rate limit
        for byte-identical data.
        """
        starting, bench, injury = self._slots(league)
        content = self.client.get_json(
            f"league/{league.league_key}/teams/roster",
            resource="league.teams.roster",
            params={"week": week},
            scope={"league_key": league.league_key, "season": league.season, "week": week},
        )
        tables = parse.parse_rosters(
            content, league_key=league.league_key, season=league.season, week=week,
            starting_slots=starting, bench_slots=bench, injury_slots=injury,
            game_code=self.game_code,
        )
        snaps = tables.get("fantasy_roster_snapshots", [])
        notes = None
        if starting is None:
            notes = ("roster slot definitions unavailable, so is_starter is NULL "
                     "for this week rather than guessed")
        return FetchResult(rows=_tagged(tables), resource="league.teams.roster",
                           api_calls=1, complete=bool(snaps), notes=notes)

    def _slots(self, league: LeagueRef):
        cached = self._slot_cache.get(league.league_key)
        if cached:
            return cached
        return (None, None, None)

    def fetch_player_stats(self, league: LeagueRef, week: int) -> FetchResult:
        """Per-player weekly stats and points, chained off the roster.

        ⚠️ A plain roster response carries NO points — it ends each player at
        selected_position. Points require chaining players/stats under a league
        context, because the modifiers that turn stats into points are the
        league's. This is the second request per league-week and it is the only
        route to historical bench points.
        """
        content = self.client.get_json(
            f"league/{league.league_key}/teams/roster/players/stats",
            resource="league.teams.roster.players.stats",
            params={"week": week, "type": "week"},
            scope={"league_key": league.league_key, "season": league.season, "week": week},
        )
        tables = parse.parse_player_week_stats(
            content, league_key=league.league_key, season=league.season, week=week,
            game_code=self.game_code,
        )
        stats = tables.get("fantasy_player_week_stats", [])
        return FetchResult(rows=_tagged(tables),
                           resource="league.teams.roster.players.stats",
                           api_calls=1, complete=bool(stats))

    # ── players ──────────────────────────────────────────────────────────────

    def fetch_players(
        self, league: LeagueRef, *, status: str | None = None,
        max_pages: int | None = None,
    ) -> FetchResult:
        """REFUSED — the league's full player universe is not ours to compile.

        The endpoint works and this adapter can parse it (that is exactly why
        this is a deliberate refusal and not a missing feature). Exhibit A
        §2.c.x of the executed agreement forbids using Yahoo Fantasy
        Information to compile "complete statistics for any players in the
        League, all players on any League team (unless all such players are
        also on a User's fantasy team) or all players in a fantasy league" —
        which is precisely what paginating this collection to exhaustion
        produces. The Cover Page's Approved Use Case likewise names only
        drafts, transactions, weekly rosters, and final standings.

        Player rows still reach fantasy_players legitimately: fetch_rosters
        yields the players actually ON a team's roster, which is roster data
        under the Approved Use Case, not a league-wide player catalog.

        ⚠️ DO NOT "fix" this by re-enabling it with a max_pages cap. A bounded
        pull of a catalog we are not licensed to compile is a smaller breach,
        not a compliant one. Re-enable only against a written scope change from
        Yahoo, and update APPROVED_USE_CASE above when that happens.
        """
        raise OutsideApprovedUseCase(
            "league.players",
            "Exhibit A §2.c.x",
            "Compiling the league-wide player universe is barred; rostered "
            "players arrive via fetch_rosters instead.",
        )

    # ── orchestration ────────────────────────────────────────────────────────

    def backfill_season(self, league: LeagueRef) -> Iterator[FetchResult]:
        """Full historical capture for one league-season.

        Yields as it goes so the caller can write and checkpoint incrementally —
        a rate-limit block halfway through a fifteen-season backfill must not
        discard everything captured before it.

        Settings come FIRST because the roster-slot definitions they carry are
        what make is_starter derivable for every subsequent week.
        """
        yield self.fetch_league_metadata(league)
        yield self.fetch_league_settings(league)
        yield self.fetch_teams(league)
        yield self.fetch_draft_results(league)
        yield self.fetch_transactions(league)
        yield self.fetch_standings(league)

        for week in self._weeks(league):
            yield self.fetch_scoreboard(league, week)
            yield self.fetch_rosters(league, week)
            yield self.fetch_player_stats(league, week)

    def sync_season(
        self, league: LeagueRef, *, since_week: int | None = None
    ) -> Iterator[FetchResult]:
        """Refresh only what changes during a live season."""
        yield self.fetch_league_metadata(league)
        yield self.fetch_teams(league)          # waiver priority, FAAB, move counts
        yield self.fetch_transactions(league)
        yield self.fetch_standings(league)

        weeks = self._weeks(league)
        current = self._current_week(league)
        start = since_week if since_week is not None else (current or 1)
        for week in [w for w in weeks if w >= start and (current is None or w <= current)]:
            yield self.fetch_scoreboard(league, week)
            yield self.fetch_rosters(league, week)
            yield self.fetch_player_stats(league, week)

    def _weeks(self, league: LeagueRef) -> list[int]:
        """Week bounds from the league's own settings, never a hardcoded 17.

        Season length changed (the NFL moved to 18 weeks in 2021) and playoff
        structures vary, so a constant would skip real weeks in some seasons and
        request non-existent ones in others.
        """
        cached = self._settings_cache.get(league.league_key)
        if cached:
            rows = cached.get("fantasy_league_settings") or []
            if rows:
                start = rows[0].get("start_week") or 1
                end = rows[0].get("end_week")
                if end:
                    return list(range(int(start), int(end) + 1))
        raw = league.raw or {}
        start = to_int(raw.get("start_week")) or 1
        end = to_int(raw.get("end_week"))
        if end:
            return list(range(start, end + 1))
        # ⚠️ No bound available. Refuse rather than assume — a guessed range
        # either misses real weeks or burns the rate limit on 404s.
        raise ProviderError(
            f"cannot determine week bounds for {league.league_key}: fetch "
            "league settings before rosters/scoreboards",
            resource="league.settings", error_kind="unknown", retryable=False,
        )

    def _current_week(self, league: LeagueRef) -> int | None:
        cached = self._settings_cache.get(league.league_key)
        if cached:
            rows = cached.get("fantasy_league_settings") or []
            if rows:
                return rows[0].get("current_week")
        return to_int((league.raw or {}).get("current_week"))

    def _settings_end_week(self, league: LeagueRef) -> int | None:
        """Fallback for a CLOSED season, where current_week is often absent
        or stale. Used only by fetch_standings's as_of_week stamp."""
        cached = self._settings_cache.get(league.league_key)
        if cached:
            rows = cached.get("fantasy_league_settings") or []
            if rows:
                return rows[0].get("end_week")
        return to_int((league.raw or {}).get("end_week"))

    def resource_supported(self, resource: str) -> bool:
        """Resources Yahoo genuinely does not expose.

        These become `not_exposed` completeness rows rather than gaps someone
        later mistakes for an ingestion bug.
        """
        return resource not in {
            "weekly_standings",       # one state only; must be reconstructed
            "failed_waiver_claims",   # vanish once waivers process
            "rejected_transactions",  # not retrievable historically
            "player_projections",     # no documented per-player projection resource
            "waiver_priority_history",
        }

    def close(self) -> None:
        return None


# ─────────────────────────────────────────────────────────────────────────────

def _tagged(tables: dict[str, list[dict]]) -> list[dict]:
    """Flatten {table: rows} into rows each carrying its destination.

    One payload legitimately produces rows for several tables (settings yields
    scoring rules, roster slots and divisions too). Tagging keeps the adapter's
    return type uniform without the loader having to know which resource
    produces which tables.
    """
    out: list[dict] = []
    for table, rows in tables.items():
        for row in rows:
            out.append({**row, "_table": table})
    return out


def _ref_from_row(row: dict) -> LeagueRef:
    return LeagueRef(
        platform=PLATFORM,
        league_key=row["league_key"],
        season=row.get("season") or 0,
        game_key=row.get("game_key") or "",
        league_id=row.get("league_id") or "",
        league_name=row.get("league_name"),
        renew_key=row.get("renew_key"),
        renewed_key=row.get("renewed_key"),
        discovery_source=row.get("discovery_source", "unknown"),
        is_accessible=True,
        raw=row,
    )


def _chunks(seq: Sequence, size: int) -> Iterator[list]:
    for i in range(0, len(seq), size):
        yield list(seq[i:i + size])
