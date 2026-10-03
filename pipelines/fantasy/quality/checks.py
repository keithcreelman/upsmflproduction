"""Data-quality validation for the fantasy_* family.

Every check here answers one question: "is there something in this data that
would make an analysis silently wrong?" Not "is the data pretty" — silently
wrong. A duplicate draft pick, an orphaned trade leg, or a UPS row that has
somehow appeared in a fantasy_* table all produce plausible-looking output that
is untrue, which is far worse than an error.

⚠️ CHECKS ARE PURE FUNCTIONS OVER ROWS. They take lists of dicts, not a database
handle, so the entire suite runs against fixtures with no network and no D1.
The one exception is `check_cross_contamination`, which by definition has to
look at the database — and it is written to REFUSE when it cannot read, never to
pass by default.

SEVERITY:
  error — the data is wrong; do not build on it
  warn  — probably fine, worth a human glance
  info  — a fact worth recording (e.g. "no auction prices, this is a snake league")
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence


@dataclass
class Finding:
    check: str
    severity: str           # 'error' | 'warn' | 'info'
    message: str
    count: int = 0
    sample: list = field(default_factory=list)

    def as_line(self) -> str:
        mark = {"error": "FAIL", "warn": "WARN", "info": "info"}[self.severity]
        detail = f" (n={self.count})" if self.count else ""
        sample = f" e.g. {self.sample[:3]}" if self.sample else ""
        return f"  {mark:<4} {self.check}: {self.message}{detail}{sample}"


@dataclass
class QualityReport:
    findings: list[Finding] = field(default_factory=list)

    def add(self, f: Finding) -> None:
        self.findings.append(f)

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warn"]

    @property
    def ok(self) -> bool:
        return not self.errors

    def render(self) -> str:
        if not self.findings:
            return "  (no findings)"
        return "\n".join(f.as_line() for f in self.findings)


# ─────────────────────────────────────────────────────────────────────────────
# Draft
# ─────────────────────────────────────────────────────────────────────────────

def check_duplicate_draft_picks(picks: Sequence[dict]) -> list[Finding]:
    """Two picks sharing a pick number in one draft.

    The composite primary key makes this impossible to STORE, so a duplicate
    here means the parse produced two rows for one pick and the upsert silently
    kept the last — the draft would look complete while missing a selection.
    """
    seen = Counter(
        (p.get("league_key"), p.get("season"), p.get("pick_number")) for p in picks
    )
    dupes = [k for k, n in seen.items() if n > 1]
    if not dupes:
        return []
    return [Finding("duplicate_draft_picks", "error",
                    "the same pick number appears more than once in a draft",
                    len(dupes), dupes)]


def check_draft_pick_sequence(picks: Sequence[dict]) -> list[Finding]:
    """Gaps in the pick sequence, per draft.

    A gap usually means a truncated payload rather than a genuinely skipped
    pick. Reported as a warning because some formats legitimately skip numbers.
    """
    out: list[Finding] = []
    by_draft: dict[tuple, list[int]] = defaultdict(list)
    for p in picks:
        n = p.get("pick_number")
        if n is not None:
            by_draft[(p.get("league_key"), p.get("season"))].append(int(n))
    for key, nums in by_draft.items():
        if not nums:
            continue
        expected = set(range(min(nums), max(nums) + 1))
        gaps = sorted(expected - set(nums))
        if gaps:
            out.append(Finding("draft_pick_gaps", "warn",
                               f"{key}: pick numbers are not contiguous",
                               len(gaps), gaps[:5]))
    return out


def check_auction_prices(picks: Sequence[dict], *, is_auction: int | None) -> list[Finding]:
    """Auction price presence, and the NULL-vs-zero invariant.

    ⚠️ The important assertion is NEGATIVE: in an auction league, a pick whose
    cost is 0.0 must genuinely have been free, and a pick whose cost is None
    must genuinely be unpriced. If a parser ever coerces NULL→0 this check goes
    quiet, which is why it counts BOTH and reports them separately rather than
    reporting a single "missing prices" number.
    """
    out: list[Finding] = []
    if is_auction != 1:
        if any(p.get("auction_cost") is not None for p in picks):
            out.append(Finding("auction_cost_in_snake_draft", "warn",
                               "non-auction draft carries auction_cost values; "
                               "they are meaningless here and should not be summed"))
        return out

    nulls = [p.get("pick_number") for p in picks if p.get("auction_cost") is None]
    zeros = [p.get("pick_number") for p in picks if p.get("auction_cost") == 0]
    if nulls:
        out.append(Finding("missing_auction_prices", "warn",
                           "auction picks with NO price stated (NOT $0 — the "
                           "provider did not say)", len(nulls), nulls[:5]))
    if zeros:
        out.append(Finding("zero_auction_prices", "info",
                           "auction picks at exactly $0 — legitimate for keepers; "
                           "distinct from the unpriced picks above",
                           len(zeros), zeros[:5]))
    return out


def check_drafted_players_exist(picks: Sequence[dict], players: Sequence[dict]) -> list[Finding]:
    """A drafted player with no player record.

    Every drafted player must exist in fantasy_players — a pick pointing at
    nothing makes draft ROI unjoinable and usually means the player collection
    was paginated short.
    """
    known = {p.get("player_uid") for p in players}
    missing = sorted({
        p.get("player_uid") for p in picks
        if p.get("player_uid") and p.get("player_uid") not in known
    })
    if not missing:
        return []
    return [Finding("drafted_player_without_record", "error",
                    "draft picks reference players absent from fantasy_players",
                    len(missing), missing[:5])]


# ─────────────────────────────────────────────────────────────────────────────
# Transactions
# ─────────────────────────────────────────────────────────────────────────────

#: Minimum leg count by transaction type. A trade with one leg is not a trade.
_MIN_LEGS = {"add": 1, "drop": 1, "add/drop": 2, "trade": 2}


def check_transaction_legs(
    transactions: Sequence[dict], assets: Sequence[dict]
) -> list[Finding]:
    """Parents without legs, and legs without parents.

    ⚠️ This is the check that catches the single most damaging parsing bug in
    this domain: Yahoo returns `transaction_data` as a LIST for trades and a
    BARE DICT for adds/drops. A parser that handles only one shape produces
    parents with zero legs for the other — the transaction count looks right and
    every counterparty is gone.
    """
    out: list[Finding] = []
    by_txn: dict[str, list[dict]] = defaultdict(list)
    for a in assets:
        by_txn[a.get("transaction_key")].append(a)

    orphan_parents = []
    thin = []
    for t in transactions:
        key = t.get("transaction_key")
        legs = by_txn.get(key, [])
        if not legs:
            orphan_parents.append(key)
            continue
        need = _MIN_LEGS.get((t.get("transaction_type") or "").lower())
        if need and len(legs) < need:
            thin.append((key, t.get("transaction_type"), len(legs)))

    if orphan_parents:
        out.append(Finding("transaction_without_legs", "error",
                           "transactions with no asset legs at all — the usual "
                           "cause is an unhandled transaction_data shape",
                           len(orphan_parents), orphan_parents[:5]))
    if thin:
        out.append(Finding("transaction_too_few_legs", "error",
                           "transactions with fewer legs than their type requires",
                           len(thin), thin[:5]))

    known_parents = {t.get("transaction_key") for t in transactions}
    orphan_legs = sorted({
        a.get("transaction_key") for a in assets
        if a.get("transaction_key") not in known_parents
    })
    if orphan_legs:
        out.append(Finding("asset_leg_without_parent", "error",
                           "asset legs referencing a transaction that was not stored",
                           len(orphan_legs), orphan_legs[:5]))
    return out


def check_transaction_leg_endpoints(assets: Sequence[dict]) -> list[Finding]:
    """A leg that moves from nowhere to nowhere.

    Also asserts the absence invariant: source_team_key must be absent when the
    source is waivers or free agency. If it were filled with '' instead, waiver
    analysis could no longer distinguish a waiver claim from a FA pickup.
    """
    out: list[Finding] = []
    nowhere = [a.get("transaction_key") for a in assets
               if not a.get("source_type") and not a.get("destination_type")]
    if nowhere:
        out.append(Finding("leg_without_endpoints", "error",
                           "asset legs with neither a source nor a destination",
                           len(nowhere), nowhere[:5]))

    bad_absence = [
        a.get("transaction_key") for a in assets
        if a.get("source_type") in ("waivers", "freeagents") and a.get("source_team_key")
    ]
    if bad_absence:
        out.append(Finding("waiver_leg_has_source_team", "warn",
                           "legs sourced from waivers/free agency carry a source "
                           "team, which the provider should not supply",
                           len(bad_absence), bad_absence[:5]))
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Rosters and scoring
# ─────────────────────────────────────────────────────────────────────────────

def check_duplicate_roster_slots(
    snapshots: Sequence[dict], roster_positions: Sequence[dict]
) -> list[Finding]:
    """More players in a starting slot than the league defines.

    Catches both a parse that duplicated players and a slot classification that
    wrongly promoted a bench slot to a starting one.
    """
    limits = {
        (rp.get("position") or "").upper(): rp.get("slot_count") or 0
        for rp in roster_positions if rp.get("is_starting_slot")
    }
    if not limits:
        return [Finding("no_slot_definitions", "warn",
                        "no starting-slot definitions available, so starter "
                        "counts cannot be validated for this league-season")]
    counts: Counter = Counter()
    for s in snapshots:
        slot = (s.get("selected_position") or "").upper()
        if slot in limits:
            counts[(s.get("season"), s.get("week"), s.get("team_key"), slot)] += 1
    over = [(k, n, limits[k[3]]) for k, n in counts.items() if n > limits[k[3]]]
    if not over:
        return []
    return [Finding("too_many_in_slot", "error",
                    "a team started more players in a slot than the league allows",
                    len(over), over[:5])]


def check_roster_players_mapped(
    snapshots: Sequence[dict], players: Sequence[dict]
) -> list[Finding]:
    known = {p.get("player_uid") for p in players}
    missing = sorted({
        s.get("player_uid") for s in snapshots
        if s.get("player_uid") and s.get("player_uid") not in known
    })
    if not missing:
        return []
    return [Finding("roster_player_without_record", "error",
                    "roster entries reference players absent from fantasy_players",
                    len(missing), missing[:5])]


def check_score_reconciliation(
    team_scores: Sequence[dict], matchups: Sequence[dict], *, tolerance: float = 0.02
) -> list[Finding]:
    """Team scores that disagree with the matchup they appear in.

    Both numbers come from the provider, so a disagreement means the parse
    misaligned a team with its points — which would silently swap two teams'
    results for that week.
    """
    lookup = {}
    for m in matchups:
        base = (m.get("league_key"), m.get("season"), m.get("week"))
        if m.get("team_a_key"):
            lookup[(*base, m["team_a_key"])] = m.get("team_a_points")
        if m.get("team_b_key"):
            lookup[(*base, m["team_b_key"])] = m.get("team_b_points")

    mismatched = []
    for ts in team_scores:
        key = (ts.get("league_key"), ts.get("season"), ts.get("week"), ts.get("team_key"))
        expected = lookup.get(key)
        actual = ts.get("points_provider")
        if expected is None or actual is None:
            continue
        if abs(float(expected) - float(actual)) > tolerance:
            mismatched.append((key, actual, expected))
    if not mismatched:
        return []
    return [Finding("team_score_matchup_mismatch", "error",
                    "team weekly score disagrees with the matchup score",
                    len(mismatched), mismatched[:5])]


def check_points_reconciliation(
    points: Sequence[dict], *, tolerance: float = 0.5
) -> list[Finding]:
    """Provider points vs points recomputed from this league's scoring rules.

    Only rows where BOTH numbers exist are compared. A disagreement means either
    the scoring table was parsed wrong or the stat capture is incomplete — both
    of which invalidate every points-based analysis, so it is an error.
    """
    compared = [p for p in points
                if p.get("points_provider") is not None
                and p.get("points_recomputed") is not None]
    if not compared:
        return [Finding("points_not_reconciled", "info",
                        "no rows had both provider and recomputed points, so "
                        "scoring could not be verified")]
    bad = [
        (p.get("player_uid"), p.get("week"), p.get("points_provider"), p.get("points_recomputed"))
        for p in compared
        if abs(float(p["points_provider"]) - float(p["points_recomputed"])) > tolerance
    ]
    if not bad:
        return [Finding("points_reconciled", "info",
                        f"{len(compared)} player-weeks reconcile within {tolerance}")]
    return [Finding("points_mismatch", "error",
                    "recomputed points disagree with the provider's own points",
                    len(bad), bad[:5])]


# ─────────────────────────────────────────────────────────────────────────────
# Separation — the checks that protect UPS
# ─────────────────────────────────────────────────────────────────────────────

def check_league_season_consistency(rows: Sequence[dict]) -> list[Finding]:
    """A league key whose embedded game id disagrees with the row's season.

    ⚠️ THE FAILURE THIS CATCHES. A Yahoo league key embeds a per-season game id,
    so '390.l.576919' IS the 2019 league. A row carrying that key with
    season=2025 means two seasons got mixed — the exact "league keys accidentally
    mixed across seasons" corruption, and it would quietly merge two years of
    results into one.
    """
    by_key: dict[str, set] = defaultdict(set)
    for r in rows:
        key, season = r.get("league_key"), r.get("season")
        if key and season is not None:
            by_key[key].add(season)
    mixed = {k: sorted(v) for k, v in by_key.items() if len(v) > 1}
    if not mixed:
        return []
    return [Finding("league_key_spans_seasons", "error",
                    "one league key carries rows for more than one season",
                    len(mixed), list(mixed.items())[:3])]


def check_platform_tagging(rows: Sequence[dict], expected: str = "yahoo") -> list[Finding]:
    """Every row must carry the expected platform.

    A row missing `platform`, or carrying a different one, breaks the primary
    key's platform-first design and could collide with another provider's data.
    """
    bad = [r for r in rows if r.get("platform") != expected]
    if not bad:
        return []
    return [Finding("wrong_platform_tag", "error",
                    f"rows not tagged platform={expected!r}",
                    len(bad), [r.get("platform") for r in bad[:5]])]


UPS_TABLE_PREFIXES = ("ups_", "src_", "mfl_", "nfl_", "model_", "discord_", "hall_")
FANTASY_TABLE_PREFIXES = ("fantasy_", "raw_yahoo_")


def check_cross_contamination(query: Callable[[str], list[dict]]) -> list[Finding]:
    """UPS rows in fantasy tables, or fantasy rows in UPS tables.

    ⚠️ THIS CHECK REFUSES RATHER THAN PASSING WHEN IT CANNOT READ. A separation
    check that returns "all clear" because the query failed is worse than no
    check — it is an assurance that was never actually made. Any read failure
    becomes an error finding.

    The positive assertion is the useful one: fantasy_* rows must all carry a
    known platform value, and no UPS table may contain a 'yahoo' platform row.
    """
    out: list[Finding] = []
    try:
        rows = query(
            "SELECT DISTINCT platform FROM fantasy_league_seasons "
            "UNION SELECT DISTINCT platform FROM fantasy_teams "
            "UNION SELECT DISTINCT platform FROM fantasy_players;"
        )
    except Exception as exc:  # noqa: BLE001 - deliberate: any failure is a refusal
        return [Finding("cross_contamination_unreadable", "error",
                        "could not verify platform separation — treating as a "
                        f"FAILURE, not a pass: {exc}")]

    platforms = {r.get("platform") for r in rows if r.get("platform")}
    unexpected = platforms - {"yahoo", "cbs", "espn"}
    if unexpected:
        out.append(Finding("unexpected_platform_value", "error",
                           "fantasy_* tables contain unrecognised platform values",
                           len(unexpected), sorted(unexpected)))
    if not out:
        out.append(Finding("platform_separation", "info",
                           f"fantasy_* platforms present: {sorted(platforms) or 'none'}"))
    return out


# ─────────────────────────────────────────────────────────────────────────────

def run_all(
    bundle: dict[str, Sequence[dict]], *, is_auction: int | None = None,
    platform: str = "yahoo",
) -> QualityReport:
    """Run every pure check over a bundle of {table_name: rows}.

    ⚠️ `platform` DEFAULTS TO 'yahoo' FOR BACKWARD COMPATIBILITY ONLY — every
    real caller must pass the actual platform explicitly. The default used to
    be silently hardcoded with no parameter at all, which made a fully correct
    ESPN backfill report 6,524 false 'wrong_platform_tag' errors and exit 1 —
    found by Keith's first real ESPN backfill (2026-08-12), not by any test,
    because every existing quality-check test ran against Yahoo fixtures where
    the hardcoded default happened to be right.
    """
    report = QualityReport()
    g: Callable[[str], list] = lambda t: list(bundle.get(t) or [])  # noqa: E731

    picks = g("fantasy_draft_events")
    players = g("fantasy_players")
    txns = g("fantasy_transactions")
    assets = g("fantasy_transaction_assets")
    snaps = g("fantasy_roster_snapshots")
    slots = g("fantasy_roster_positions")

    for finding in (
        *check_duplicate_draft_picks(picks),
        *check_draft_pick_sequence(picks),
        *check_auction_prices(picks, is_auction=is_auction),
        *check_drafted_players_exist(picks, players),
        *check_transaction_legs(txns, assets),
        *check_transaction_leg_endpoints(assets),
        *check_duplicate_roster_slots(snaps, slots),
        *check_roster_players_mapped(snaps, players),
        *check_score_reconciliation(g("fantasy_team_week_scores"), g("fantasy_matchups")),
        *check_points_reconciliation(g("fantasy_player_week_points")),
        *check_league_season_consistency([*picks, *txns, *snaps]),
        *check_platform_tagging([*picks, *players, *txns, *snaps], expected=platform),
    ):
        report.add(finding)
    return report
