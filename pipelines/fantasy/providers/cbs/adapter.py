"""CbsProvider — the FantasyProvider implementation for CBS Sports Fantasy.

SCOPE, STATED HONESTLY
======================
CBS splits cleanly in two and this adapter reflects that split rather than
hiding it:

  CURRENT SEASON  -> JSON API (api.py). League identity, settings, the full
                     scoring rulebook, roster slots, divisions, teams,
                     managers, the schedule, and the draft order. Complete.
  PAST SEASONS    -> HTML (client.py + parse.py). Draft results only, which is
                     what has been built and backfilled.

⚠️ THE API IGNORES EVERY SEASON PARAMETER. `&season=`, `&year=`, `&season_id=`
and `&yr=` all return the current season's data at HTTP 200. That was proven by
diffing content, not by comparing hashes — a payload-hash comparison originally
said league/stats DID vary by season and it was list-ordering noise. So
`fetch_*` here refuses a non-current season outright instead of silently
serving 2026 rows stamped 2019.

METHODS THAT RAISE RATHER THAN RETURN EMPTY
-------------------------------------------
fetch_transactions and fetch_player_stats are not built. They raise
NotImplementedInThisPass, exactly as the ESPN adapter does, because an empty
complete=False result means 'the platform does not offer this' — and CBS does
offer both. Recording 'not built' as 'not offered' would corrupt the
completeness report in the direction that stops anyone ever building it.
"""
from __future__ import annotations

import json
from typing import Iterator, Sequence

from ..base import (AccessDeniedError, FantasyProvider, FetchResult, LeagueRef,
                    ProviderError)
from . import parse as html_parse
from . import parse_api
from .api import CbsApiClient
from .client import CbsClient, CbsFetchError
from .constants import (DEFAULT_LEAGUE_ID, GAME_CODE, PLATFORM,
                        ROSTERS_ALL_TEAMS, SCHEDULES_ALL_PERIODS, league_key)


class NotImplementedInThisPass(ProviderError):
    """A resource CBS offers that this adapter does not yet parse."""

    def __init__(self, resource: str, note: str) -> None:
        super().__init__(
            f"{resource}: not implemented in the CBS adapter. {note}",
            resource=resource, error_kind="not_implemented", retryable=False)


class SeasonNotServedByApi(ProviderError):
    """A historical season was requested from an endpoint that only has today's.

    ⚠️ This is the guard that keeps the worst CBS failure mode out of the
    database. The API answers a 2019 request with 2026 data and HTTP 200. Left
    ungated, a backfill loop over 2013-2026 would write the same current-season
    rows under fourteen different season stamps and every one of them would look
    like a successful ingest.
    """

    def __init__(self, resource: str, requested: int, current: int) -> None:
        super().__init__(
            f"{resource}: CBS's JSON API serves only the current season "
            f"({current}); season {requested} was requested. The API ignores "
            f"every season parameter and would return {current} data stamped "
            f"{requested}. Use the HTML history path for past seasons.",
            resource=resource, error_kind="season_not_served", retryable=False)


class CbsProvider(FantasyProvider):
    platform = PLATFORM

    def __init__(self, api: CbsApiClient, *, html: CbsClient | None = None,
                 league_id: str = DEFAULT_LEAGUE_ID) -> None:
        self.api = api
        self.html = html
        self.league_id = league_id
        self._cache: dict[str, dict] = {}

    # ── cached single-fetch endpoints ────────────────────────────────────────

    def _get(self, endpoint: str, params: dict[str, str] | None = None) -> dict:
        ck = endpoint + "?" + json.dumps(params or {}, sort_keys=True)
        if ck not in self._cache:
            self._cache[ck] = self.api.fetch(endpoint, params=params)
        return self._cache[ck]

    def _details(self) -> dict:
        return self._get("league/details")

    def current_season(self) -> int:
        """The season the API is actually serving.

        Derived from the schedule's first period date rather than from the
        wall clock: a league whose 2026 season has not started still reports
        current_period=1, and 'what year does CBS think it is' must come from
        CBS, not from `datetime.now()`.
        """
        sched = self._get("league/schedules", SCHEDULES_ALL_PERIODS)
        periods = (sched.get("schedule") or {}).get("periods") or []
        for p in periods:
            iso = parse_api._mdy(p.get("start"))
            if iso:
                return int(iso[:4])
        raise ProviderError(
            "league/schedules: no period carries a parseable start date, so the "
            "current season cannot be established from CBS's own data. Refusing "
            "to fall back to the system clock.",
            resource="league/schedules", error_kind="unparseable")

    def _assert_current(self, resource: str, season: int) -> None:
        cur = self.current_season()
        if season != cur:
            raise SeasonNotServedByApi(resource, season, cur)

    def _my_team_id(self) -> str | None:
        live = self._get("league/scoring/live")
        return str((live.get("live_scoring") or {}).get("my_team_id") or "") or None

    # ── discovery ────────────────────────────────────────────────────────────

    def discover_leagues(self, *, seasons: Sequence[int] | None = None) -> list[LeagueRef]:
        """CBS addresses a league by its SUBDOMAIN, which the caller already
        knows because they typed it into a browser to get here. There is no
        'which leagues am I in' endpoint on the league host. Raising rather than
        returning [] keeps 'cannot answer' distinct from 'you are in none'."""
        raise NotImplementedInThisPass(
            "discover_leagues",
            "CBS league hosts have no cross-league discovery endpoint. Use "
            "probe_league(league_id=<subdomain>).")

    def probe_league(self, *, league_id: str | None = None) -> LeagueRef:
        lid = league_id or self.league_id
        season = self.current_season()
        row = parse_api.parse_league_metadata(
            self._details(), season=season, league_id=lid,
            draft_config=self._get("league/draft/config"),
            my_team_id=self._my_team_id())
        return LeagueRef(platform=PLATFORM, league_key=row["league_key"],
                         season=season, game_key=GAME_CODE, league_id=lid,
                         league_name=row.get("league_name"),
                         my_team_key=row.get("my_team_key"),
                         discovery_source="manual", is_accessible=True, raw=row)

    # ── league ───────────────────────────────────────────────────────────────

    def fetch_league_metadata(self, league: LeagueRef) -> FetchResult:
        self._assert_current("league.metadata", league.season)
        before = self.api.api_calls
        row = parse_api.parse_league_metadata(
            self._details(), season=league.season, league_id=league.league_id,
            draft_config=self._get("league/draft/config"),
            my_team_id=self._my_team_id())
        return FetchResult(rows=[{**row, "_table": "fantasy_league_seasons"}],
                           resource="league.metadata",
                           api_calls=self.api.api_calls - before)

    def fetch_league_settings(self, league: LeagueRef) -> FetchResult:
        """Settings + scoring rules + bonuses + roster slots + divisions.

        Five tables from four calls. They are fetched together because the
        settings row's uses_fractional_points / uses_negative_points are read
        off the scoring modifiers — CBS states neither flag, so the only honest
        source is the rulebook itself.
        """
        self._assert_current("league.settings", league.season)
        before = self.api.api_calls
        season, lid = league.season, league.league_id
        details = self._details()
        rules = self._get("league/rules")
        scoring = self._get("league/scoring/rules")
        teams_body = self._get("league/teams")

        sc = parse_api.parse_scoring_rules(scoring, season=season, league_id=lid)
        settings = parse_api.parse_league_settings(
            details, rules, season=season, league_id=lid,
            draft_config=self._get("league/draft/config"),
            scoring_rows=sc["fantasy_scoring_rules"])
        slots = parse_api.parse_roster_positions(rules, season=season, league_id=lid)
        divisions = parse_api.parse_divisions(teams_body, season=season, league_id=lid)

        # The league says how many divisions it has; the teams say which ones
        # they are. Disagreement means one of the two collections was narrowed.
        want_div = settings.get("num_divisions")
        if want_div and len(divisions) != want_div:
            raise ProviderError(
                f"league/teams yields {len(divisions)} distinct divisions "
                f"({[d['division_id'] for d in divisions]}) but league/details "
                f"says {want_div}. Refusing a partial division map.",
                resource="league.settings", error_kind="inconsistent")

        rows = [{**settings, "_table": "fantasy_league_settings"}]
        rows += [{**r, "_table": "fantasy_scoring_rules"} for r in sc["fantasy_scoring_rules"]]
        rows += [{**b, "_table": "fantasy_scoring_bonuses"} for b in sc["fantasy_scoring_bonuses"]]
        rows += [{**s, "_table": "fantasy_roster_positions"} for s in slots]
        rows += [{**d, "_table": "fantasy_divisions"} for d in divisions]
        return FetchResult(
            rows=rows, resource="league.settings",
            api_calls=self.api.api_calls - before,
            notes=(f"{len(sc['fantasy_scoring_rules'])} scoring rules "
                   f"({sum(1 for r in sc['fantasy_scoring_rules'] if r['position_type'])} "
                   f"position overrides), {len(sc['fantasy_scoring_bonuses'])} bonus bands, "
                   f"{len(slots)} roster slots, {len(divisions)} divisions"))

    # ── participants ─────────────────────────────────────────────────────────

    def fetch_teams(self, league: LeagueRef) -> FetchResult:
        self._assert_current("teams", league.season)
        before = self.api.api_calls
        d = (self._details().get("league_details") or {})
        t = parse_api.parse_teams(
            self._get("league/teams"), season=league.season,
            league_id=league.league_id, my_team_id=self._my_team_id(),
            expected_num_teams=parse_api._int(d.get("num_teams")))
        rows = [{**r, "_table": "fantasy_teams"} for r in t["fantasy_teams"]]
        return FetchResult(rows=rows, resource="teams",
                           api_calls=self.api.api_calls - before)

    def fetch_managers(self, league: LeagueRef) -> FetchResult:
        """Managers + the team linkage, keyed on CBS's account GUID.

        This is the first CBS source with a stable manager identifier at all —
        the history pages carry only franchise names — so it is what makes
        owner continuity across seasons resolvable later.
        """
        self._assert_current("managers", league.season)
        before = self.api.api_calls
        d = (self._details().get("league_details") or {})
        t = parse_api.parse_teams(
            self._get("league/teams"), season=league.season,
            league_id=league.league_id, my_team_id=self._my_team_id(),
            expected_num_teams=parse_api._int(d.get("num_teams")))
        rows = [{**r, "_table": "fantasy_managers"} for r in t["fantasy_managers"]]
        rows += [{**r, "_table": "fantasy_team_managers"} for r in t["fantasy_team_managers"]]
        return FetchResult(rows=rows, resource="managers",
                           api_calls=self.api.api_calls - before,
                           notes=f"{len(t['fantasy_managers'])} managers")

    # ── history ──────────────────────────────────────────────────────────────

    def fetch_draft_results(self, league: LeagueRef) -> FetchResult:
        """Draft picks. Current season from the API; past seasons from HTML.

        Pre-draft, the API returns a FULL board of `UpcomingPick` placeholders,
        so this reports an empty-but-complete result with the reason rather than
        writing 216 picks of nobody.
        """
        season, lid = league.season, league.league_id
        try:
            self._assert_current("draft.results", season)
            is_current = True
        except SeasonNotServedByApi:
            is_current = False

        if not is_current:
            if self.html is None:
                raise AccessDeniedError(
                    f"draft.results {season}: past seasons live on the league "
                    f"website and need the `pid` session cookie, which this "
                    f"provider was constructed without.",
                    resource="draft.results")
            try:
                html = self.html.fetch_draft_results(season, lid)
            except CbsFetchError as e:
                raise ProviderError(str(e), resource="draft.results",
                                    error_kind="transport", retryable=True) from e
            t = html_parse.parse_draft_results(html, season=season, league_id=lid)
            rows = [{**r, "_table": "fantasy_drafts"} for r in t["fantasy_drafts"]]
            rows += [{**r, "_table": "fantasy_draft_events"} for r in t["fantasy_draft_events"]]
            return FetchResult(rows=rows, resource="draft.results",
                               notes=f"{season} from HTML history")

        before = self.api.api_calls
        results = self._get("league/draft/results")
        if not parse_api.draft_has_started(results):
            state = (results.get("draft_results") or {}).get("state")
            return FetchResult(
                rows=[], resource="draft.results", complete=True,
                api_calls=self.api.api_calls - before,
                notes=(f"{season} draft has not happened (state={state!r}). CBS "
                       f"renders a full board of 'UpcomingPick' placeholders "
                       f"pre-draft; storing those would be a draft of nobody."))
        raise NotImplementedInThisPass(
            "draft.results (current season, drafted)",
            "The 2026 board is still placeholders, so the completed-draft "
            "branch has never been run against a real payload. It will be built "
            "against the real shape after the draft rather than guessed now.")

    def fetch_draft_order(self, league: LeagueRef) -> FetchResult:
        """The draft ORDER — available before any pick is made.

        Not part of the FantasyProvider ABC because no other platform here
        exposes a pre-draft order. It is the single most useful pre-draft fact:
        every slot, for every team, for all eighteen rounds.
        """
        self._assert_current("draft.order", league.season)
        before = self.api.api_calls
        o = parse_api.parse_draft_order(self._get("league/draft/order"),
                                        season=league.season, league_id=league.league_id)
        cfg = (self._get("league/draft/config").get("draft") or {})
        d = (self._details().get("league_details") or {})
        want = (parse_api._int(cfg.get("rounds")) or 0) * (parse_api._int(d.get("num_teams")) or 0)
        if want and o["num_picks"] != want:
            raise ProviderError(
                f"league/draft/order returned {o['num_picks']} picks but "
                f"{cfg.get('rounds')} rounds x {d.get('num_teams')} teams = {want}.",
                resource="draft.order", error_kind="inconsistent")
        rows = [{**r, "_table": "fantasy_team_season_state"}
                for r in o["fantasy_team_season_state"]]
        return FetchResult(rows=rows, resource="draft.order",
                           api_calls=self.api.api_calls - before,
                           notes=f"{o['num_picks']} slots, {cfg.get('order_type')} "
                                 f"{cfg.get('rounds')} rounds")

    def fetch_transactions(self, league: LeagueRef) -> FetchResult:
        raise NotImplementedInThisPass(
            "transactions",
            "CBS serves a transaction log on the league website; no JSON "
            "endpoint for it was found (every /league/transaction* spelling "
            "404s). Not built, and NOT the same as CBS not having one.")

    def fetch_standings(self, league: LeagueRef) -> FetchResult:
        raise NotImplementedInThisPass(
            "standings",
            "league/standings/overall parses cleanly but the 2026 season has "
            "not started, so every row is zeros. Building the mapping against "
            "an all-zero payload cannot distinguish a real 0 from a missing "
            "field; deferred until there are played games.")

    # ── weekly ───────────────────────────────────────────────────────────────

    def fetch_scoreboard(self, league: LeagueRef, week: int) -> FetchResult:
        raise NotImplementedInThisPass(
            "scoreboard", "league/schedules?period=all carries the matchups; the "
            "score side needs league/scoring/live, which is only meaningful "
            "in-season.")

    def fetch_rosters(self, league: LeagueRef, week: int) -> FetchResult:
        """Every team's roster for one week.

        ⚠️ team_id=all IS NOT OPTIONAL. Without it CBS returns the caller's own
        team and nothing else, at HTTP 200, with no marker. The team-count
        assertion below is what turns that from a silent 1/12 ingest into a
        refusal.
        """
        self._assert_current("rosters", league.season)
        before = self.api.api_calls
        body = self._get("league/rosters", {**ROSTERS_ALL_TEAMS, "period": str(week)})
        teams = (body.get("rosters") or {}).get("teams") or []
        want = parse_api._int((self._details().get("league_details") or {}).get("num_teams"))
        if want and len(teams) != want:
            raise ProviderError(
                f"league/rosters returned {len(teams)} teams, expected {want}. "
                f"Without team_id=all CBS returns only the caller's own team.",
                resource="rosters", error_kind="inconsistent")
        if not any(t.get("players") for t in teams):
            return FetchResult(
                rows=[], resource="rosters", complete=True,
                api_calls=self.api.api_calls - before,
                notes=(f"all {len(teams)} teams present and every roster is empty "
                       f"— the {league.season} draft has not happened yet."))
        raise NotImplementedInThisPass(
            "rosters (populated)",
            "Rosters are empty pre-draft, so the player-row mapping has never "
            "seen a real payload. Built after the draft, against the real shape.")

    def fetch_player_stats(self, league: LeagueRef, week: int) -> FetchResult:
        raise NotImplementedInThisPass(
            "player_stats",
            "league/stats returns the full 1.9MB season table; the per-week "
            "split and the stat-id mapping are not built.")

    def fetch_players(self, league: LeagueRef, *, status: str | None = None,
                      max_pages: int | None = None) -> FetchResult:
        raise NotImplementedInThisPass(
            "players",
            "players/list returns all ~4,900 players in one unpaginated call "
            "(id, position, pro_team, bye_week, eligible_positions). Mapping to "
            "fantasy_players is Step 2 work, not league-state ingestion.")

    # ── orchestration ────────────────────────────────────────────────────────

    def sync_season(self, league: LeagueRef, *, since_week: int | None = None
                    ) -> Iterator[FetchResult]:
        yield self.fetch_league_metadata(league)
        yield self.fetch_league_settings(league)
        yield self.fetch_teams(league)
        yield self.fetch_managers(league)
        yield self.fetch_schedule(league)
        yield self.fetch_draft_order(league)

    def fetch_schedule(self, league: LeagueRef) -> FetchResult:
        self._assert_current("schedule", league.season)
        before = self.api.api_calls
        d = (self._details().get("league_details") or {})
        rules = self._get("league/rules")
        po = parse_api._week_from_label(
            ((rules.get("rules") or {}).get("schedule") or {}).get("playoffs_start", {}).get("value"))
        rows = parse_api.parse_schedule_periods(
            self._get("league/schedules", SCHEDULES_ALL_PERIODS),
            season=league.season, league_id=league.league_id,
            playoff_start_week=po,
            expected_periods=parse_api._int(d.get("scoring_periods")))
        return FetchResult(
            rows=[{**r, "_table": "fantasy_schedule_periods"} for r in rows],
            resource="schedule", api_calls=self.api.api_calls - before,
            notes=f"{len(rows)} periods, playoffs from week {po}")

    def backfill_season(self, league: LeagueRef) -> Iterator[FetchResult]:
        yield from self.sync_season(league)
        yield self.fetch_draft_results(league)

    def resource_supported(self, resource: str) -> bool:
        # 'not offered by CBS' vs 'not built here' — only the first belongs in
        # this method. Everything CBS serves returns True even when unbuilt.
        return resource not in ("discover_leagues",)

    def close(self) -> None:
        self._cache.clear()
