"""Completeness classification — one row per (league-season, resource).

WHY A CLOSED VOCABULARY. "Missing" is not one thing, and treating it as one
thing is how a gap gets mistaken for a bug (or worse, a bug for a gap). These
seven statuses each imply a different next action:

    complete       captured all of it                  → nothing to do
    partial        captured some of it                 → re-run, or accept
    not_exposed    the API does not offer it           → stop looking; document
    access_denied  the API offers it, this token can't → different credentials
    not_applicable the concept does not exist here     → nothing to do, ever
    failed         we tried and it errored             → retry
    inferred       we RECONSTRUCTED it                 → do not present as source

⚠️ NEVER FABRICATE. A resource the provider does not expose is `not_exposed`
with NULL values, never an invented default. The report says what is missing;
it does not fill it in.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

COMPLETE = "complete"
PARTIAL = "partial"
NOT_EXPOSED = "not_exposed"
ACCESS_DENIED = "access_denied"
NOT_APPLICABLE = "not_applicable"
FAILED = "failed"
INFERRED = "inferred"

ALL_STATUSES = (COMPLETE, PARTIAL, NOT_EXPOSED, ACCESS_DENIED,
                NOT_APPLICABLE, FAILED, INFERRED)

#: Resources tracked per league-season. Weekly ones are scored against the
#: league's own week bounds, never against a hardcoded 17.
RESOURCES = (
    "settings", "teams", "managers", "draft", "transactions", "standings",
    "players", "matchups", "rosters", "player_week_stats", "player_week_points",
)

WEEKLY_RESOURCES = frozenset({"matchups", "rosters", "player_week_stats", "player_week_points"})

#: Resources Yahoo genuinely does not expose. These are recorded once per
#: league-season so the gap is visible in the report rather than discovered by
#: someone who assumes the ingester is broken.
YAHOO_NOT_EXPOSED = {
    "failed_waiver_claims":
        "Losing waiver claims vanish once waivers process. Who else bid, how "
        "many claims a player drew, and losing FAAB amounts are permanently "
        "unrecoverable from the API.",
    "rejected_transactions":
        "The transactions collection is documented as COMPLETED transactions "
        "only. Whether a vetoed trade persists with a non-successful status is "
        "undocumented; assume rejected trades are unrecoverable.",
    "weekly_standings":
        "The API returns exactly one standings state (final for a closed "
        "season, current for a live one). There is no standings;week=N. Weekly "
        "standings are reconstructed from the scoreboard and flagged inferred.",
    "player_projections":
        "No documented per-player projection resource. team_projected_points "
        "exists on the scoreboard for live weeks only; historical per-player "
        "projections are definitively unavailable.",
    "waiver_priority_history":
        "Only the CURRENT waiver priority is exposed on the team resource. Its "
        "value over time must be inferred from the transaction sequence.",
    "per_pick_draft_grades":
        "The team resource exposes one letter grade for the whole draft. It is "
        "not decomposable to picks; the detail lives only on the website.",
    "manager_real_names":
        "Other managers' nicknames return as '--hidden--' unless made public. "
        "Only the stable account GUID is available, which is what we key on.",
}


@dataclass
class ResourceOutcome:
    """What actually happened for one resource in one league-season."""

    resource: str
    row_count: int = 0
    expected_units: int | None = None
    observed_units: int | None = None
    first_week: int | None = None
    last_week: int | None = None
    errored: bool = False
    access_denied: bool = False
    applicable: bool = True
    inferred: bool = False
    provider_exposes: bool = True
    note: str | None = None

    def classify(self) -> str:
        """Resolve to exactly one status. Order matters — most specific first."""
        if not self.applicable:
            return NOT_APPLICABLE
        if not self.provider_exposes:
            return NOT_EXPOSED
        if self.access_denied:
            return ACCESS_DENIED
        if self.errored:
            return FAILED
        if self.inferred:
            return INFERRED
        if self.expected_units is not None:
            if self.observed_units is None:
                # ⚠️ We expected units and observed nothing measurable. That is
                # unknown, not complete — refuse to call it complete.
                return FAILED
            if self.observed_units >= self.expected_units and self.row_count > 0:
                return COMPLETE
            if self.observed_units > 0:
                return PARTIAL
            return FAILED
        if self.row_count > 0:
            return COMPLETE
        # Zero rows with no expectation to measure against. Could be a genuinely
        # empty resource (a league with no trades) — reported as partial so a
        # human looks, rather than as complete.
        return PARTIAL


def build_rows(
    *, league_key: str, season: int, outcomes: Sequence[ResourceOutcome],
    run_id: str | None = None, platform: str = "yahoo",
) -> list[dict]:
    """Turn outcomes into fantasy_data_completeness rows."""
    rows = []
    for o in outcomes:
        rows.append({
            "platform": platform,
            "league_key": league_key,
            "season": season,
            "resource": o.resource,
            "status": o.classify(),
            "expected_units": o.expected_units,
            "observed_units": o.observed_units,
            "row_count": o.row_count,
            "first_week": o.first_week,
            "last_week": o.last_week,
            "is_inferred": 1 if o.inferred else 0,
            "missing_notes": o.note,
            "last_run_id": run_id,
        })
    return rows


def not_exposed_rows(
    *, league_key: str, season: int, run_id: str | None = None,
    platform: str = "yahoo",
) -> list[dict]:
    """The standing 'this provider does not offer it' rows.

    Written once per league-season so the completeness report is a full account
    of what exists, not just what was fetched.
    """
    return [{
        "platform": platform,
        "league_key": league_key,
        "season": season,
        "resource": resource,
        "status": NOT_EXPOSED,
        "expected_units": None,
        "observed_units": None,
        "row_count": 0,
        "first_week": None,
        "last_week": None,
        "is_inferred": 0,
        "missing_notes": note,
        "last_run_id": run_id,
    } for resource, note in sorted(YAHOO_NOT_EXPOSED.items())]


def rollup(rows: Sequence[dict]) -> str:
    """One-word verdict for a whole season, for fantasy_sync_runs."""
    statuses = {r.get("status") for r in rows}
    if FAILED in statuses:
        return "failed"
    if ACCESS_DENIED in statuses:
        return "access_denied"
    if PARTIAL in statuses:
        return "partial"
    return "complete"


def render_report(rows: Sequence[dict]) -> str:
    """The season-by-season completeness table, as text."""
    if not rows:
        return "(no completeness rows)"
    by_season: dict[int, list[dict]] = {}
    for r in rows:
        by_season.setdefault(r.get("season") or 0, []).append(r)

    out = []
    header = f"{'season':<8}{'resource':<22}{'status':<16}{'rows':>8}  {'units':<12} notes"
    out.append(header)
    out.append("-" * len(header))
    for season in sorted(by_season):
        for r in sorted(by_season[season], key=lambda x: x.get("resource") or ""):
            units = ""
            if r.get("expected_units") is not None:
                units = f"{r.get('observed_units')}/{r.get('expected_units')}"
            note = (r.get("missing_notes") or "")[:60]
            out.append(
                f"{season:<8}{(r.get('resource') or ''):<22}"
                f"{(r.get('status') or ''):<16}{(r.get('row_count') or 0):>8}  "
                f"{units:<12} {note}"
            )
    return "\n".join(out)
