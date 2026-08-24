"""The provider-adapter interface every fantasy platform implements.

DESIGN CONTRACT — the thing that makes CBS and ESPN cheap later:

  Each method returns PLATFORM-NEUTRAL row dicts keyed exactly like the
  fantasy_* columns in migrations 0127-0132. Yahoo's JSON pathologies, CBS's
  session auth, ESPN's cookie scheme — all of that stays inside its own adapter
  and never reaches the normalizer, the loader, the quality checks or the CLI.

  Concretely: nothing outside providers/yahoo/ may know that Yahoo collections
  are objects with a "count" sibling, that its league key embeds the game key,
  or that a throttle arrives as HTTP 999. If any of those facts leak upward, a
  second provider becomes a rewrite instead of a new directory.

WHAT AN ADAPTER MUST GUARANTEE:

  1. RAISE, NEVER RETURN EMPTY, ON AN UNREADABLE RESPONSE. An empty list means
     "the provider says there are none". An unreadable payload means "we do not
     know" and must raise ProviderError. Conflating them is the single root
     cause behind every data-destruction incident in this repo, and it is the
     reason this contract is stated first.

  2. NEVER FABRICATE. A field the provider does not expose is absent from the
     returned dict (or explicitly None). Adapters do not default, do not infer,
     and do not carry a value over from another season. Derived values are
     marked as derived by the column that holds them.

  3. PRESERVE PROVIDER VOCABULARY VERBATIM. Statuses, draft types, waiver rules
     and position labels are passed through unnormalized. Cross-season
     vocabulary drift is a known silent-failure class here; normalizing on
     ingest hides it, and the point is to see it.

  4. BE IDEMPOTENT. The same call over the same upstream state produces the same
     rows with the same keys, so re-running a backfill upserts rather than
     duplicates.

  5. STAMP PROVENANCE. Every row carries platform, and the caller adds
     source_run_id. Adapters never write to the database themselves — they
     return rows; the loader writes. That separation is what lets the whole
     pipeline be tested against fixtures with no network and no D1.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, Iterator, Sequence


class ProviderError(RuntimeError):
    """Base class for every adapter failure.

    Carries enough structure to become a fantasy_api_errors row without the
    caller having to re-parse an exception string.
    """

    def __init__(
        self,
        message: str,
        *,
        resource: str | None = None,
        endpoint: str | None = None,
        http_status: int | None = None,
        error_kind: str = "unknown",
        retryable: bool = False,
        attempt: int = 1,
    ) -> None:
        super().__init__(message)
        self.resource = resource
        self.endpoint = endpoint
        self.http_status = http_status
        self.error_kind = error_kind
        self.retryable = retryable
        self.attempt = attempt


class AuthError(ProviderError):
    """Credentials are missing, expired, or were revoked.

    Distinguished from a transport error because the remedy is different: this
    one needs a human to re-consent, and retrying makes it worse.
    """

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("error_kind", "auth")
        kw.setdefault("retryable", False)
        super().__init__(message, **kw)


class RateLimitError(ProviderError):
    """The provider is throttling. Always retryable, always with backoff."""

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("error_kind", "rate_limited")
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)


class UnreadableResponseError(ProviderError):
    """A 2xx response whose body could not be interpreted.

    ⚠️ This exists so that "the body was an HTML throttle page" can never be
    mistaken for "the collection was empty".
    """

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("error_kind", "unparseable")
        kw.setdefault("retryable", True)
        super().__init__(message, **kw)


class AccessDeniedError(ProviderError):
    """The resource exists but this account cannot read it.

    Private leagues are readable only by members, so a historical season the
    account never played is permanently unreachable — not a transient failure
    and not an empty season. Recorded as access_denied completeness.
    """

    def __init__(self, message: str, **kw: Any) -> None:
        kw.setdefault("error_kind", "auth")
        kw.setdefault("retryable", False)
        super().__init__(message, **kw)


@dataclass(frozen=True)
class LeagueRef:
    """A league-season, identified the way the platform identifies it.

    `league_key` is the platform's own full key and is the primary key
    everywhere downstream. `league_id` alone is NEVER sufficient: on Yahoo the
    key embeds a per-season game key, so the same numeric league id denotes a
    different resource every year.
    """

    platform: str
    league_key: str
    season: int
    game_key: str
    league_id: str
    league_name: str | None = None
    my_team_key: str | None = None
    renew_key: str | None = None
    renewed_key: str | None = None
    discovery_source: str = "unknown"
    is_accessible: bool | None = None
    raw: dict = field(default_factory=dict)


@dataclass
class FetchResult:
    """Rows plus the provenance needed to record how they were obtained.

    `complete` is not decoration. A fetch that hit a rate limit halfway through
    pagination returns the rows it got AND complete=False, so the loader records
    `partial` rather than overwriting a good season with a short read.
    """

    rows: list[dict]
    resource: str
    complete: bool = True
    notes: str | None = None
    api_calls: int = 0
    raw_refs: list[str] = field(default_factory=list)

    def __len__(self) -> int:  # pragma: no cover - convenience
        return len(self.rows)


class FantasyProvider(abc.ABC):
    """The interface. Implement all of it; raise NotImplementedError for nothing.

    A platform that genuinely cannot serve a resource returns an empty
    FetchResult with complete=False and a note explaining why — that becomes a
    `not_exposed` completeness row. It does NOT raise NotImplementedError,
    because "this platform has no such endpoint" is a fact about the data worth
    recording, not a bug.
    """

    #: lowercase platform discriminator; goes in every primary key
    platform: str = "unknown"

    # ── discovery ────────────────────────────────────────────────────────────

    @abc.abstractmethod
    def discover_leagues(self, *, seasons: Sequence[int] | None = None) -> list[LeagueRef]:
        """Every league-season this account can reach.

        Implementations should use more than one discovery mechanism where the
        platform offers them, because each has blind spots — an account-based
        query misses seasons the account did not play, while a season-chain walk
        misses leagues that never renewed.
        """

    @abc.abstractmethod
    def fetch_league_metadata(self, league: LeagueRef) -> FetchResult:
        """Identity, calendar and status for one league-season."""

    @abc.abstractmethod
    def fetch_league_settings(self, league: LeagueRef) -> FetchResult:
        """Settings, scoring rules, bonuses, roster slots, divisions.

        Returns rows for several tables at once; each row carries a `_table`
        key naming its destination, because these arrive in one payload and
        splitting the request would triple the API cost for no benefit.
        """

    # ── participants ─────────────────────────────────────────────────────────

    @abc.abstractmethod
    def fetch_teams(self, league: LeagueRef) -> FetchResult:
        """Teams in this league-season."""

    @abc.abstractmethod
    def fetch_managers(self, league: LeagueRef) -> FetchResult:
        """Managers and their team linkage.

        Must key on the platform's stable account identifier, never on a display
        name — names change every season and are frequently withheld.
        """

    # ── history ──────────────────────────────────────────────────────────────

    @abc.abstractmethod
    def fetch_draft_results(self, league: LeagueRef) -> FetchResult:
        """Every draft pick.

        ⚠️ Auction price must be preserved as-is: None when the provider did not
        state one, 0.0 only when it genuinely said zero.
        """

    @abc.abstractmethod
    def fetch_transactions(self, league: LeagueRef) -> FetchResult:
        """Transactions as parent rows plus asset legs.

        Never collapses a multi-asset move into one row.
        """

    @abc.abstractmethod
    def fetch_standings(self, league: LeagueRef) -> FetchResult:
        """Standings as the provider currently reports them.

        Most platforms expose exactly one state (final or current) with no
        history; weekly standings are reconstructed elsewhere and flagged
        inferred. This method returns only what the provider actually said.
        """

    # ── weekly ───────────────────────────────────────────────────────────────

    @abc.abstractmethod
    def fetch_scoreboard(self, league: LeagueRef, week: int) -> FetchResult:
        """Matchups and team scores for one week."""

    @abc.abstractmethod
    def fetch_rosters(self, league: LeagueRef, week: int) -> FetchResult:
        """Every team's roster for one week, with lineup slots.

        Starter status is derived from the league's own slot definitions, not
        from a hardcoded bench-slot list.
        """

    @abc.abstractmethod
    def fetch_player_stats(self, league: LeagueRef, week: int) -> FetchResult:
        """Per-player stats and fantasy points for one week."""

    # ── players ──────────────────────────────────────────────────────────────

    @abc.abstractmethod
    def fetch_players(
        self, league: LeagueRef, *, status: str | None = None, max_pages: int | None = None
    ) -> FetchResult:
        """The player universe for this league-season.

        MUST paginate to exhaustion. Stopping at the first page is the classic
        failure here and it looks like success. When a page limit is applied,
        the result carries complete=False and says so in `notes` — a bounded
        read that reports itself as complete is worse than no read at all.
        """

    # ── orchestration ────────────────────────────────────────────────────────

    @abc.abstractmethod
    def sync_season(self, league: LeagueRef, *, since_week: int | None = None) -> Iterator[FetchResult]:
        """Incremental refresh of mutable state for a season in progress.

        Yields FetchResults so the caller can write and checkpoint as it goes
        rather than buffering an entire season in memory.
        """

    @abc.abstractmethod
    def backfill_season(self, league: LeagueRef) -> Iterator[FetchResult]:
        """Full historical capture of one league-season."""

    # ── shared helpers ───────────────────────────────────────────────────────

    def resource_supported(self, resource: str) -> bool:
        """Whether this platform exposes `resource` at all.

        Drives the `not_applicable` / `not_exposed` distinction in the
        completeness report; default is optimistic and adapters narrow it.
        """
        return True

    def close(self) -> None:
        """Release any held resources. Safe to call more than once."""
        return None

    def __enter__(self):  # pragma: no cover - trivial
        return self

    def __exit__(self, *exc):  # pragma: no cover - trivial
        self.close()
        return False
