"""EspnProvider — the FantasyProvider implementation for ESPN Fantasy Sports.

⚠️ THIS IS THE LIGHTER FIRST PASS Keith asked for, not full parity with the
Yahoo adapter. It implements: league metadata, teams/managers, standings,
weekly scoreboard+rosters (+ the points already embedded in that payload),
and FAAB/waiver transactions (added 2026-08-12 — see fetch_transactions).

It does NOT implement drafts, TRADE_* transactions, full player-universe
pagination, or granular per-stat capture. Those methods/scopes exist (the ABC
requires the methods) but RAISE NotImplementedInThisPass rather than
returning an empty, complete=False FetchResult — because that combination
specifically means "the platform does not offer this," which is false here.
ESPN's mDraftDetail view exists; it is simply not built yet. Conflating "not
built" with "not offered" would corrupt the completeness report the same way
returning empty-on-error would corrupt a sync — this is the same no-fail-open
discipline applied to scope-boundaries instead of error-handling.
"""

from __future__ import annotations

import json
from typing import Iterator, Sequence

from ..base import FantasyProvider, FetchResult, LeagueRef, ProviderError
from . import parse
from .auth import EspnCookies
from .client import EspnClient
from .constants import FAAB_TRANSACTION_TYPES

PLATFORM = "espn"

_METADATA_VIEWS = ["mTeam", "mSettings", "mStandings"]
_WEEKLY_VIEWS = ["mBoxscore", "mMatchup"]
_TRANSACTIONS_FILTER_HEADER = {
    "x-fantasy-filter": json.dumps(
        {"transactions": {"filterType": {"value": list(FAAB_TRANSACTION_TYPES)}}}
    )
}
#: NFL has used an 18-week regular season since 2021; confirmed live that
#: requesting scoringPeriodId outside a league's actual range still returns
#: HTTP 200 with zero transactions (no 404 to catch), so this range is safe
#: to request unconditionally rather than needing a break-on-not_found loop.
_TRANSACTION_WEEKS = range(1, 19)


class NotImplementedInThisPass(ProviderError):
    """A resource ESPN offers, that this adapter has not been built to parse yet.

    Distinct from 'not supported by the platform' — see the module docstring.
    Never caught and silently downgraded to an empty result; the CLI reports
    it as a failed resource, not a quiet gap.
    """

    def __init__(self, resource: str, note: str) -> None:
        super().__init__(
            f"{resource}: not implemented in the ESPN adapter's lighter first "
            f"pass. {note}",
            resource=resource, error_kind="not_implemented", retryable=False,
        )


class EspnProvider(FantasyProvider):
    platform = PLATFORM

    def __init__(self, client: EspnClient) -> None:
        self.client = client
        # Cached per league-season so fetch_scoreboard/fetch_rosters (which
        # share one ESPN request) don't fetch twice in one sync pass.
        self._weekly_cache: dict[tuple[str, int], dict] = {}

    # ── discovery ────────────────────────────────────────────────────────────

    def discover_leagues(self, *, seasons: Sequence[int] | None = None) -> list[LeagueRef]:
        """ESPN has no cross-season discovery endpoint, unlike Yahoo's
        users;use_login=1/games/leagues.

        There is no documented (or community-known) way to ask "which leagues
        does this cookie pair belong to" — you address a league by an id you
        already know. This method therefore does not discover anything; it is
        a placeholder that makes the ABC contract satisfiable and says so
        rather than silently returning [], which would look like "you are in
        zero leagues" instead of "this platform cannot answer that question."
        """
        raise NotImplementedInThisPass(
            "discover_leagues",
            "ESPN has no discovery endpoint. Use `probe_league(season, league_id)` "
            "to validate a league you already know the id for instead.",
        )

    def probe_league(self, *, season: int, league_id: str) -> LeagueRef:
        """The ESPN equivalent of discovery: confirm one known league_id/season
        is reachable, and return its LeagueRef. This is what backfill/sync
        actually use for ESPN, driven by --league-id on the CLI."""
        data = self.client.fetch_league(
            season=season, league_id=league_id, views=_METADATA_VIEWS,
            resource="league.metadata",
        )
        row = parse.parse_league_metadata(data, season=season, league_id=league_id)
        return LeagueRef(
            platform=PLATFORM, league_key=row["league_key"], season=season,
            game_key=row["game_key"], league_id=row["league_id"],
            league_name=row.get("league_name"), discovery_source="direct",
            is_accessible=True, raw=row,
        )

    # ── league ───────────────────────────────────────────────────────────────

    def fetch_league_metadata(self, league: LeagueRef) -> FetchResult:
        data = self.client.fetch_league(
            season=league.season, league_id=league.league_id, views=_METADATA_VIEWS,
            resource="league.metadata",
        )
        row = parse.parse_league_metadata(data, season=league.season, league_id=league.league_id)
        return FetchResult(rows=[{**row, "_table": "fantasy_league_seasons"}],
                           resource="league.metadata", api_calls=1)

    def fetch_league_settings(self, league: LeagueRef) -> FetchResult:
        """League settings, scoring rules, and roster slot counts (mSettings).

        Built 2026-08-22, after the first pass deliberately skipped it. The
        original reasoning — that ESPN's lineupSlotId is a global enum, so
        starter derivation needs no per-league slot table — still holds. What
        it missed is that settings also record what a POINT MEANS here. Without
        them, any valuation or cross-league comparison silently borrows another
        league's scoring, which is exactly what happened in practice before
        this existed.

        Emits three tables at once because ESPN returns them in one payload;
        splitting into three requests would triple the calls for identical data.
        """
        data = self.client.fetch_league(
            season=league.season, league_id=league.league_id,
            views=("mSettings",), resource="league.settings",
        )
        tables = parse.parse_league_settings(
            data, season=league.season, league_id=league.league_id,
        )
        settings_rows = tables.get("fantasy_league_settings") or []
        slot_rows = tables.get("fantasy_roster_positions") or []
        # complete only if we actually learned the two things this exists for:
        # how the league scores, and what its lineup looks like.
        complete = bool(settings_rows) and bool(slot_rows)
        return FetchResult(
            rows=_tagged(tables),
            resource="league.settings",
            api_calls=1,
            complete=complete,
            notes=None if complete else
            "mSettings returned no scoring/roster detail — settings NOT captured",
        )

    # ── participants ─────────────────────────────────────────────────────────

    def fetch_teams(self, league: LeagueRef) -> FetchResult:
        data = self.client.fetch_league(
            season=league.season, league_id=league.league_id, views=_METADATA_VIEWS,
            resource="league.teams",
        )
        tables = parse.parse_teams(data, season=league.season, league_id=league.league_id)
        return FetchResult(rows=_tagged(tables), resource="league.teams", api_calls=1)

    def fetch_managers(self, league: LeagueRef) -> FetchResult:
        """Derived from the teams payload — same request, no extra call.

        Mirrors the Yahoo adapter's fetch_managers, which reuses fetch_teams
        for the same reason: the data arrives together and a second request
        for data already in hand would be wasteful.
        """
        result = self.fetch_teams(league)
        rows = [r for r in result.rows
                if r.get("_table") in ("fantasy_managers", "fantasy_team_managers")]
        return FetchResult(rows=rows, resource="league.managers",
                           api_calls=result.api_calls,
                           notes="derived from the teams payload; no extra request")

    # ── history — explicitly out of scope this pass ─────────────────────────

    def fetch_draft_results(self, league: LeagueRef) -> FetchResult:
        raise NotImplementedInThisPass(
            "league.draftresults",
            "ESPN's mDraftDetail view exists and is expected to work; parsing "
            "it is planned but not built. See docs/fantasy_provider_adapter_plan.md.",
        )

    def fetch_transactions(self, league: LeagueRef) -> FetchResult:
        """FAAB/waiver transactions only — see the module docstring.

        ⚠️ mTransactions2 is scoped to a SINGLE scoringPeriodId per request;
        confirmed live that omitting scoringPeriodId (or leaving out the
        x-fantasy-filter header) returns zero transactions rather than an
        error or "all weeks" — so this makes one request per week and
        aggregates, unlike Yahoo's fetch_transactions which gets the whole
        season in one call. TRADE_* types are excluded (see
        constants.FAAB_TRANSACTION_TYPES) — this pass targets FAAB usage
        reporting specifically, not full transaction-history parity.
        """
        parents: list[dict] = []
        legs: list[dict] = []
        api_calls = 0
        seen: set[str] = set()  # a txn could in principle surface at more than one scoringPeriodId
        for week in _TRANSACTION_WEEKS:
            data = self.client.fetch_league(
                season=league.season, league_id=league.league_id,
                views=["mTransactions2"], week=week, resource="league.transactions",
                extra_headers=_TRANSACTIONS_FILTER_HEADER,
            )
            api_calls += 1
            tables = parse.parse_transactions(
                data, season=league.season, league_id=league.league_id, week=week,
            )
            new_keys = {r["transaction_key"] for r in tables["fantasy_transactions"]} - seen
            seen |= new_keys
            parents.extend(r for r in tables["fantasy_transactions"] if r["transaction_key"] in new_keys)
            legs.extend(leg for leg in tables["fantasy_transaction_assets"] if leg["transaction_key"] in new_keys)
        rows = ([{**r, "_table": "fantasy_transactions"} for r in parents]
                + [{**r, "_table": "fantasy_transaction_assets"} for r in legs])
        return FetchResult(
            rows=rows, resource="league.transactions", api_calls=api_calls,
            complete=True,
            notes=f"{len(parents)} FAAB/waiver transactions across weeks "
                  f"{_TRANSACTION_WEEKS.start}-{_TRANSACTION_WEEKS.stop - 1}; "
                  "TRADE_* transaction types are not covered this pass",
        )

    def fetch_standings(self, league: LeagueRef) -> FetchResult:
        data = self.client.fetch_league(
            season=league.season, league_id=league.league_id, views=_METADATA_VIEWS,
            resource="league.standings",
        )
        rows = parse.parse_standings(data, season=league.season, league_id=league.league_id)
        # ⚠️ as_of_week IS PART OF THIS TABLE'S PRIMARY KEY — a row without it
        # is not merely incomplete, d1.py refuses to write it at all. Found by
        # a live backfill against Keith's real league (2026-08-12); the exact
        # same gap existed in the Yahoo adapter (fixed at the same time) —
        # its comment PROMISED "the loader stamps it" but nothing did.
        # status.latestScoringPeriod is already in this same mTeam/mSettings/
        # mStandings payload, so this costs no extra request.
        as_of_week = (data.get("status") or {}).get("latestScoringPeriod")
        if as_of_week is None:
            raise ProviderError(
                "league.standings: ESPN's status.latestScoringPeriod was "
                "absent, so as_of_week cannot be determined.",
                resource="league.standings", error_kind="unknown", retryable=False,
            )
        return FetchResult(
            rows=[{**r, "as_of_week": as_of_week, "_table": "fantasy_standings_snapshots"}
                  for r in rows],
            resource="league.standings", api_calls=1,
            notes="rank/playoff_seed are NULL — not confirmed available from "
                  "this view; only record and points are populated",
        )

    # ── weekly ───────────────────────────────────────────────────────────────

    def _weekly(self, league: LeagueRef, week: int) -> dict:
        key = (league.league_key, week)
        if key not in self._weekly_cache:
            data = self.client.fetch_league(
                season=league.season, league_id=league.league_id,
                views=_WEEKLY_VIEWS, week=week, resource="league.weekly",
            )
            self._weekly_cache[key] = parse.parse_weekly(
                data, season=league.season, league_id=league.league_id, week=week,
            )
        return self._weekly_cache[key]

    def fetch_scoreboard(self, league: LeagueRef, week: int) -> FetchResult:
        tables = self._weekly(league, week)
        rows = [{**r, "_table": t} for t in ("fantasy_matchups", "fantasy_team_week_scores")
                for r in tables.get(t, [])]
        return FetchResult(rows=rows, resource="league.scoreboard", api_calls=1,
                           complete=bool(tables.get("fantasy_matchups")))

    def fetch_rosters(self, league: LeagueRef, week: int) -> FetchResult:
        tables = self._weekly(league, week)
        rows = [{**r, "_table": t} for t in ("fantasy_roster_snapshots", "fantasy_players")
                for r in tables.get(t, [])]
        return FetchResult(rows=rows, resource="league.rosters",
                           api_calls=0,  # already counted by fetch_scoreboard if called first
                           complete=bool(tables.get("fantasy_roster_snapshots")))

    def fetch_player_stats(self, league: LeagueRef, week: int) -> FetchResult:
        """Only the pre-computed points total — see the module docstring.

        Not raising NotImplementedInThisPass here: fantasy_player_week_points
        genuinely is populated (from the same weekly payload), just without
        the granular per-stat breakdown fantasy_player_week_stats would carry.
        That's a real, if partial, result — not an unbuilt one.
        """
        tables = self._weekly(league, week)
        rows = [{**r, "_table": "fantasy_player_week_points"}
                for r in tables.get("fantasy_player_week_points", [])]
        return FetchResult(rows=rows, resource="league.player_week_points",
                           api_calls=0, complete=bool(rows),
                           notes="points total only; no per-stat breakdown "
                                 "(fantasy_player_week_stats) in this pass")

    # ── players ──────────────────────────────────────────────────────────────

    def fetch_players(
        self, league: LeagueRef, *, status: str | None = None, max_pages: int | None = None,
    ) -> FetchResult:
        raise NotImplementedInThisPass(
            "league.players",
            "Full player-universe pagination (ESPN's kona_player_info view) "
            "is not built. fantasy_players is still populated incidentally "
            "for every player who appears on a fetched roster.",
        )

    # ── orchestration ────────────────────────────────────────────────────────

    def backfill_season(self, league: LeagueRef) -> Iterator[FetchResult]:
        """This pass's scope, applied across a season: metadata, teams,
        standings, FAAB/waiver transactions, then every week's
        scoreboard+rosters+points.

        ⚠️ Week bounds are not derived from confirmed league settings (see
        fetch_league_settings) — a conservative fixed range covers every NFL
        regular season+playoffs since 2018. This is a known simplification for
        the lighter pass, not a silent guess: it is documented here and
        overshoots into 404 territory for past-the-end weeks, which the
        client reports as a clean not_found rather than corrupting anything.
        """
        yield self.fetch_league_metadata(league)
        # Settings BEFORE the weekly loop, mirroring the Yahoo adapter's order:
        # they define what a point means in this league, so anything written
        # afterward is interpretable on its own terms.
        yield self.fetch_league_settings(league)
        yield self.fetch_teams(league)
        yield self.fetch_standings(league)
        yield self.fetch_transactions(league)
        for week in range(1, 19):  # NFL has used an 18-week regular season since 2021
            try:
                yield self.fetch_scoreboard(league, week)
                yield self.fetch_rosters(league, week)
                yield self.fetch_player_stats(league, week)
            except ProviderError as exc:
                if exc.error_kind == "not_found":
                    break  # past the end of this season's schedule
                raise

    def sync_season(self, league: LeagueRef, *, since_week: int | None = None) -> Iterator[FetchResult]:
        yield self.fetch_league_metadata(league)
        yield self.fetch_teams(league)
        yield self.fetch_standings(league)
        yield self.fetch_transactions(league)
        week = since_week or 1
        try:
            yield self.fetch_scoreboard(league, week)
            yield self.fetch_rosters(league, week)
            yield self.fetch_player_stats(league, week)
        except ProviderError as exc:
            if exc.error_kind != "not_found":
                raise

    def resource_supported(self, resource: str) -> bool:
        return resource not in {
            "weekly_standings",       # same reasoning as Yahoo: reconstruct + flag inferred
            "player_projections",     # not confirmed exposed by any view checked
            "trade_transactions",     # TRADE_* types excluded from fetch_transactions this pass
            # ⚠️ "failed_waiver_claims" USED TO BE HERE, on the assumption
            # "ESPN's activity log shows only completed moves." Confirmed
            # WRONG by a live call 2026-08-12: mTransactions2 with
            # type=WAIVER returns FAILED_PLAYERALREADYDROPPED,
            # FAILED_INVALIDPLAYERSOURCE, and CANCELED statuses right
            # alongside EXECUTED/PENDING. Removed rather than left stale —
            # this resource genuinely is supported now (see fetch_transactions).
        }

    def close(self) -> None:
        return None


def _tagged(tables: dict[str, list[dict]]) -> list[dict]:
    out: list[dict] = []
    for table, rows in tables.items():
        for row in rows:
            out.append({**row, "_table": table})
    return out
