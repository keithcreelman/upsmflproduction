"""Score a stat line under a league's OWN rules, read from D1. Platform-neutral.

WHY THIS IS NOT A POINTS FORMULA WITH CONSTANTS IN IT
====================================================
Every constant a fantasy points function could hardcode is wrong for some real
league, and demonstrably wrong for the one this was built for: CBS's `grffl`
pays a receiving touchdown 6 to a wide receiver and 12 to a running back, a
passing yard 0.04, and a receiving yard 0.1. A generic PPR model misprices
almost every skill player in it. So the table is DATA — fantasy_scoring_rules
and fantasy_scoring_bonuses for one (platform, league_key, season) — and this
module only knows how to apply it.

THE THREE SHAPES A BONUS ROW CAN HAVE, AND WHY THEY CANNOT SHARE A CODE PATH
---------------------------------------------------------------------------
  1. STACKING MILESTONE  is_stacking=1, target_max NULL
     "+3 at 100 rushing yards, again at 200, again at 300." Every threshold at
     or below the value fires. Evaluated against a SINGLE GAME's total — a
     season total of 1,200 yards did not earn twelve milestones.
  2. EXCLUSIVE BAND      is_stacking=0, target_max set, the rule HAS a rate
     "a touchdown of 10-39 yards is worth +1, 40-69 +3, 70-100 +5." At most one
     fires, and it fires PER TOUCHDOWN, not per season total. Applying it to a
     count of touchdowns is meaningless, so `score_game` will not do it unless
     the caller supplies the individual event lengths.
  3. TIER LOOKUP         is_stacking=0, target_max set, the rule has NO rate
     Points allowed 0 -> 12, 1-13 -> 6, ... 50-99 -> -6. Exactly one fires and
     it IS the score; there is no rate to add it to.

Collapsing 1 and 2 double-counts a long touchdown. Collapsing 2 and 3 scores a
defense as though it had pitched a shutout. Both were live bugs in the CBS
parser before 0134 gave the table the vocabulary to tell them apart.

⚠️ REFUSES RATHER THAN ASSUMES. An unknown stat, a missing table, a bonus shape
it has not been taught — every one raises. A scoring engine that silently
treats an unrecognised stat as worth zero produces a plausible number that is
quietly wrong, which is worse than no number.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable, Mapping, Sequence


class ScoringError(RuntimeError):
    pass


@dataclass(frozen=True)
class Band:
    target: float
    target_max: float | None
    points: float
    stacking: bool

    def contains(self, value: float) -> bool:
        if value < self.target:
            return False
        return self.target_max is None or value <= self.target_max


@dataclass
class ScoringTable:
    """One league-season's scoring, resolved and ready to apply."""

    league_key: str
    season: int
    platform: str
    #: (position_or_None, stat) -> rate. None position = the league default.
    rates: dict[tuple[str | None, str], float | None] = field(default_factory=dict)
    #: (position_or_None, stat) -> bands
    bands: dict[tuple[str | None, str], list[Band]] = field(default_factory=dict)
    #: stats that resolve to a tier table rather than a rate
    tiered: set[tuple[str | None, str]] = field(default_factory=set)

    # ── construction ─────────────────────────────────────────────────────────

    @classmethod
    def from_rows(cls, rule_rows: Sequence[Mapping], bonus_rows: Sequence[Mapping],
                  *, platform: str, league_key: str, season: int) -> "ScoringTable":
        if not rule_rows:
            raise ScoringError(
                f"{platform}/{league_key}/{season}: no scoring rules. Every league "
                f"scores something; an empty table means the rules were never "
                f"ingested, and scoring against it would return 0.0 for everyone.")
        t = cls(league_key=league_key, season=season, platform=platform)

        for r in rule_rows:
            sid = str(r["stat_id"])
            if sid.startswith("fit:"):
                # Derived effective coefficients live in the same table under a
                # reserved prefix. They are EVIDENCE about past seasons, not
                # rules, and must never be applied as if they were.
                continue
            if not int(r.get("is_enabled") or 0):
                continue
            pos, stat = (sid.split(":", 1) if ":" in sid else (None, sid))
            t.rates[(pos, stat)] = (None if r.get("modifier") is None
                                    else float(r["modifier"]))

        for b in bonus_rows:
            sid = str(b["stat_id"])
            if sid.startswith("fit:"):
                continue
            pos, stat = (sid.split(":", 1) if ":" in sid else (None, sid))
            key = (pos, stat)
            if key not in t.rates:
                raise ScoringError(
                    f"bonus {b['bonus_id']!r} references stat_id {sid!r} that has "
                    f"no rule row. A bonus with no stat cannot be evaluated.")
            band = Band(target=float(b["target_value"]),
                        target_max=(None if b.get("target_max") is None
                                    else float(b["target_max"])),
                        points=float(b["bonus_points"]),
                        stacking=bool(b.get("is_stacking")))
            t.bands.setdefault(key, []).append(band)
            if t.rates[key] is None and not band.stacking:
                t.tiered.add(key)

        for key, bands in t.bands.items():
            bands.sort(key=lambda x: x.target)
            if key in t.tiered:
                cls._assert_tiers_partition(key, bands)
        return t

    @staticmethod
    def _assert_tiers_partition(key, bands: list[Band]) -> None:
        """A tier table must be exhaustive-ish and non-overlapping.

        Overlapping tiers make the score depend on iteration order, which is the
        kind of bug that produces a different answer on a different day.
        """
        for a, b in zip(bands, bands[1:]):
            if a.target_max is None or a.target_max >= b.target:
                raise ScoringError(
                    f"{key}: tiers overlap or are unbounded "
                    f"({a.target}-{a.target_max} then {b.target}-). Exactly one "
                    f"tier must match any value.")

    # ── resolution ───────────────────────────────────────────────────────────

    def resolve(self, position: str | None, stat: str) -> tuple[float | None, list[Band], bool]:
        """Position override first, league default second — CBS's own order.

        Returns (rate, bands, is_tiered). Raises when the stat is unknown at
        BOTH scopes, because "this league does not score X" and "I have never
        heard of X" must not produce the same silent 0.0.
        """
        for key in ((position, stat), (None, stat)):
            if key in self.rates:
                return self.rates[key], self.bands.get(key, []), key in self.tiered
        raise ScoringError(
            f"stat {stat!r} is not in this league's rulebook at position "
            f"{position!r} or as a league default. Known stats: "
            f"{sorted({s for _, s in self.rates})[:12]}...")

    def scores(self, stat: str, position: str | None = None) -> bool:
        try:
            rate, bands, tiered = self.resolve(position, stat)
        except ScoringError:
            return False
        return rate is not None or tiered or bool(bands)

    # ── application ──────────────────────────────────────────────────────────

    def score_stat(self, position: str | None, stat: str, value: float,
                   *, event_lengths: Iterable[float] | None = None) -> float:
        """Points for ONE stat in ONE GAME.

        ⚠️ PER GAME, NOT PER SEASON. Stacking milestones ("+3 at 100 yards")
        are game-level facts. Feeding a season total in would award a milestone
        for every 100 yards of the year.

        `event_lengths` supplies the individual event distances an exclusive
        band needs (touchdown lengths). Omitting it when the stat HAS exclusive
        bands is not an error — the base rate still applies — but the bands are
        skipped and the result is a documented UNDERSTATEMENT, which callers
        must handle explicitly (see `effective_rate`).
        """
        rate, bands, tiered = self.resolve(position, stat)

        if tiered:
            for b in bands:
                if b.contains(value):
                    return b.points
            raise ScoringError(
                f"{stat}: value {value} falls outside every tier "
                f"({bands[0].target}..{bands[-1].target_max}). A value with no "
                f"tier cannot be scored, and 0.0 would be a guess.")

        total = 0.0 if rate is None else rate * value

        stacking = [b for b in bands if b.stacking]
        for b in stacking:
            if value >= b.target:
                total += b.points

        exclusive = [b for b in bands if not b.stacking]
        if exclusive and event_lengths is not None:
            for length in event_lengths:
                for b in exclusive:
                    if b.contains(length):
                        total += b.points
                        break
        return total

    def score_weeks(self, position: str | None,
                    games: Sequence[Mapping[str, float]], **kw) -> float:
        """Season points as the sum of per-GAME scores. Use this, not score_game.

        ⚠️ THIS EXISTS BECAUSE THE OBVIOUS SHORTCUT IS WRONG AND LOOKS RIGHT.
        Feeding a SEASON total to score_game awards every stacking milestone
        exactly once — a 1,202-yard rusher collects the 100, 200 and 300-yard
        bonuses a single time each instead of once per qualifying game. Scored
        that way against CBS's own 2025 page, 63 of 100 running backs came out
        HIGHER than CBS says they actually scored, which is the tell: every
        bonus in this league is additive, so an engine can never legitimately
        exceed the provider's own total.

        A season is a sequence of games. Pass the games.
        """
        if not games:
            raise ScoringError(
                "score_weeks: no games supplied. A season with no games scores "
                "nothing, and returning 0.0 would be indistinguishable from a "
                "player who genuinely scored nothing.")
        return round(sum(self.score_game(position, g, **kw) for g in games), 4)

    def score_game(self, position: str | None, stats: Mapping[str, float],
                   *, event_lengths: Mapping[str, Iterable[float]] | None = None,
                   strict: bool = True) -> float:
        """Points for one player's ONE GAME.

        `strict` controls what happens to a stat this league does not score:
        True raises (the default, because an unrecognised key usually means a
        mapping mistake), False skips it. It never silently scores it as zero.
        """
        el = event_lengths or {}
        total = 0.0
        for stat, value in stats.items():
            if value is None:
                continue
            try:
                total += self.score_stat(position, stat, float(value),
                                         event_lengths=el.get(stat))
            except ScoringError:
                if strict:
                    raise
        return round(total, 4)

    def with_override(self, stat: str, value: float, *,
                      positions: Sequence[str | None]) -> "ScoringTable":
        """A COPY of this table with one stat's rate changed for some positions.

        Exists so a proposed rules change can be scored against real data
        instead of argued about. `positions` names exactly which scopes move —
        `[None, "QB"]` moves the league default and the quarterback override
        while leaving other positions' overrides alone, which is what "raise
        the base passing touchdown" means in a league that already pays a
        DIFFERENT passing-TD value to non-quarterbacks.

        ⚠️ RETURNS A NEW TABLE. Mutating in place would let a scenario leak
        into the baseline it is being compared against, and the comparison
        would silently be scenario-vs-scenario.
        """
        scopes = set(positions)
        if not any((p, stat) in self.rates for p in scopes):
            raise ScoringError(
                f"nothing to override: {stat!r} is not scored at any of "
                f"{sorted(str(p) for p in scopes)}. Refusing to build a "
                f"scenario that changes nothing while appearing to.")
        rules, bonuses = [], []
        for (pos, st), rate in self.rates.items():
            sid = f"{pos}:{st}" if pos else st
            new = value if (st == stat and pos in scopes) else rate
            rules.append({"stat_id": sid, "modifier": new, "is_enabled": 1})
            for i, b in enumerate(self.bands.get((pos, st), [])):
                bonuses.append({
                    "bonus_id": f"{sid}:{i}", "stat_id": sid,
                    "target_value": b.target, "target_max": b.target_max,
                    "bonus_points": b.points,
                    "is_stacking": 1 if b.stacking else 0})
        return ScoringTable.from_rows(rules, bonuses, platform=self.platform,
                                      league_key=self.league_key, season=self.season)

    def effective_rate(self, position: str | None, stat: str,
                       fits: Mapping[tuple[str, str], float] | None = None,
                       fit_stat: str | None = None) -> tuple[float, str]:
        """A single per-unit value usable on SEASON totals, and where it came from.

        ⚠️ WHY THIS EXISTS AND WHY IT IS SEPARATE FROM score_stat. Two of this
        league's bonus shapes cannot be evaluated from a season total at all:
        an exclusive band needs each touchdown's length, and a stacking
        milestone needs each game's yardage. A season-level ranking still has to
        price them somehow, and the honest options are (a) ignore them and
        knowingly understate long touchdowns, or (b) use a value FITTED against
        the league's own historical points, which has the average bonus already
        inside it.

        This prefers (b) when a fit is supplied and says so in the returned
        provenance string, so a ranking can never present a fitted number as if
        it were the rulebook.
        """
        rate, bands, tiered = self.resolve(position, stat)
        if tiered:
            raise ScoringError(
                f"{stat} is scored by a tier table, which has no per-unit rate. "
                f"Score it with score_stat against a real value instead.")
        if fits and fit_stat and position:
            hit = fits.get((position, fit_stat))
            if hit is not None:
                return float(hit), f"fitted from {self.platform} history"
        base = 0.0 if rate is None else rate
        if any(not b.stacking for b in bands):
            return base, "rulebook base only — EXCLUDES distance bonuses (understated)"
        return base, "rulebook base"


def load_table(loader, *, platform: str, league_key: str, season: int) -> ScoringTable:
    """Read one league-season's rules straight out of D1."""
    q = (lambda t: f"SELECT * FROM {t} WHERE platform = '{platform}' AND "
                   f"league_key = '{league_key}' AND season = {int(season)};")
    rules = loader.query(q("fantasy_scoring_rules"))
    bonuses = loader.query(q("fantasy_scoring_bonuses"))
    return ScoringTable.from_rows(rules, bonuses, platform=platform,
                                  league_key=league_key, season=season)


def load_fits(loader, *, platform: str, league_key: str,
              seasons: Sequence[int]) -> dict[tuple[str, str], float]:
    """Derived effective coefficients, averaged over the seasons requested.

    These are `stat_id LIKE 'fit:<POS>:<Group.Stat>'` rows produced by fitting
    observed points against observed stats. They are the ONLY evidence of what a
    league scored in a season whose rulebook is no longer retrievable, and they
    carry each season's average bonus inside them.
    """
    if not seasons:
        raise ScoringError("load_fits: no seasons requested; refusing to average nothing.")
    inlist = ",".join(str(int(s)) for s in seasons)
    rows = loader.query(
        f"SELECT stat_id, position_type, modifier FROM fantasy_scoring_rules "
        f"WHERE platform = '{platform}' AND league_key = '{league_key}' "
        f"AND season IN ({inlist}) AND stat_id LIKE 'fit:%';")
    acc: dict[tuple[str, str], list[float]] = {}
    for r in rows:
        parts = str(r["stat_id"]).split(":", 2)
        if len(parts) != 3 or r.get("modifier") is None:
            continue
        acc.setdefault((parts[1], parts[2]), []).append(float(r["modifier"]))
    return {k: sum(v) / len(v) for k, v in acc.items()}
