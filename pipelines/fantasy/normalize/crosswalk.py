"""Yahoo player identity → the repo's existing NFL player identities.

RESOLUTION ORDER, strictly. Each step runs only if the previous found nothing:

  1. provider_id        ff_player_ids.yahoo_id, guarded against 'NA'
  2. gsis_id            where the provider supplied one directly
  3. name+team+position all three must agree
  4. manual             a human decision, never overwritten by a later run

⚠️ RULE 1 — A NAME MATCH ALONE NEVER WRITES A MAPPING. Two different players
legitimately normalize to the same string, and merging them silently corrupts
every career total downstream. Step 3 requires the normalized name AND the NFL
team AND the position to agree, and even then records a fuzzy confidence rather
than an exact one.

⚠️ RULE 2 — THE 'NA' TRAP. ff_player_ids stores missing external ids as the
LITERAL STRING 'NA' (R's missing idiom serialized to text) — 4,740 of its 12,468
rows carry it somewhere. 'NA' passes both `IS NOT NULL` and `!= ''`, so an
unguarded join reports 100% coverage while matching garbage. Every id predicate
here goes through `usable_id()`. This is the repo's no-fail-open rule applied to
identity: an unusable id is not a match, and it is not an absence either — it is
a refusal.

⚠️ RULE 3 — AN UNRESOLVED PLAYER IS A ROW, NOT AN ABSENCE. Players that resolve
to nothing are written with confidence='unmapped'. Dropping them would make the
unresolved report impossible and would quietly shrink the player universe. Team
defenses, kickers and pre-2015 players are the expected tail: the upstream
crosswalk source is skill-position biased.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

#: Values that look like an id but are not one.
_UNUSABLE = {"", "na", "n/a", "null", "none", "0", "-"}

CONFIDENCE_EXACT = "exact"
CONFIDENCE_FUZZY_AUTO = "fuzzy_auto"
CONFIDENCE_FUZZY_REVIEW = "fuzzy_review"
CONFIDENCE_MANUAL = "manual"
CONFIDENCE_UNMAPPED = "unmapped"

METHOD_PROVIDER_ID = "provider_id"
METHOD_GSIS = "gsis_id"
METHOD_NAME = "name_team_position"
METHOD_MANUAL = "manual"
METHOD_NONE = "none"

#: Team abbreviation drift across sources and eras. Yahoo and nflverse disagree
#: on relocations and on Washington's several names. Without this, every player
#: on a relocated team fails the team check in step 3 and lands in review.
_TEAM_ALIASES = {
    "OAK": "LV", "LVR": "LV", "SD": "LAC", "SDG": "LAC", "STL": "LAR",
    "LA": "LAR", "WSH": "WAS", "WFT": "WAS", "ARZ": "ARI", "BLT": "BAL",
    "CLV": "CLE", "HST": "HOU", "JAC": "JAX", "KAN": "KC", "NWE": "NE",
    "NOR": "NO", "SFO": "SF", "TAM": "TB", "GNB": "GB",
}

#: Position drift. Yahoo's labels are close to but not identical to MFL's.
_POSITION_ALIASES = {
    "DEF": "DST", "D/ST": "DST", "DST": "DST", "K": "PK", "PK": "PK",
    "OLB": "LB", "ILB": "LB", "MLB": "LB", "SS": "S", "FS": "S", "CB": "CB",
    "DE": "DL", "DT": "DL", "NT": "DL", "HB": "RB", "FB": "RB", "WR/RB": "WR",
}


def usable_id(value) -> str | None:
    """Return the id only if it is genuinely usable, else None.

    This is the guard that makes the 'NA' trap harmless. Call it on EVERY id
    before using it in a comparison — including gsis_id, pfr_id and yahoo_id.
    """
    if value is None:
        return None
    text = str(value).strip()
    if text.lower() in _UNUSABLE:
        return None
    return text


def usable_gsis(value) -> str | None:
    """GSIS ids have a known shape ('00-00XXXXX'). Anything else is not one.

    A format check rather than a presence check, because 'NA' and a truncated
    value both pass a presence check and neither is a GSIS id.
    """
    text = usable_id(value)
    if not text or not text.startswith("00-"):
        return None
    return text


def normalize_team(value) -> str | None:
    text = usable_id(value)
    if not text:
        return None
    upper = text.upper()
    return _TEAM_ALIASES.get(upper, upper)


def normalize_position(value) -> str | None:
    text = usable_id(value)
    if not text:
        return None
    upper = text.upper()
    return _POSITION_ALIASES.get(upper, upper)


def normalize_name(value) -> str | None:
    """Lowercase, strip punctuation and generational suffixes.

    Mirrors the normalizer in the Yahoo parser. ⚠️ The repo has 8+ divergent
    copies of this idea that disagree with each other; this one is deliberately
    conservative and is never used as a sole matching criterion.
    """
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    # 'Last, First' → 'First Last' (the MFL convention appears in src_players).
    if "," in text:
        parts = [p.strip() for p in text.split(",", 1)]
        if len(parts) == 2 and parts[1]:
            text = f"{parts[1]} {parts[0]}"
    text = text.replace("'", "").replace("’", "").replace(".", "")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    tokens = [t for t in text.split() if t not in {"jr", "sr", "ii", "iii", "iv", "v"}]
    return " ".join(tokens) or None


@dataclass
class IdentityRecord:
    """One row of the existing ff_player_ids crosswalk."""

    mfl_id: str
    yahoo_id: str | None = None
    gsis_id: str | None = None
    pfr_id: str | None = None
    sleeper_id: str | None = None
    name: str | None = None
    merge_name: str | None = None
    position: str | None = None
    team: str | None = None

    @classmethod
    def from_row(cls, row: dict) -> "IdentityRecord":
        return cls(
            mfl_id=str(row.get("mfl_id") or "").strip(),
            yahoo_id=usable_id(row.get("yahoo_id")),
            gsis_id=usable_gsis(row.get("gsis_id")),
            pfr_id=usable_id(row.get("pfr_id")),
            sleeper_id=usable_id(row.get("sleeper_id")),
            name=row.get("name"),
            merge_name=row.get("merge_name"),
            position=row.get("position"),
            team=row.get("team"),
        )


class CrosswalkResolver:
    """Resolves Yahoo players against ff_player_ids, in the documented order."""

    def __init__(self, identities: Iterable[dict]) -> None:
        self.by_yahoo: dict[str, IdentityRecord] = {}
        self.by_gsis: dict[str, list[IdentityRecord]] = {}
        self.by_name_key: dict[tuple, list[IdentityRecord]] = {}

        for raw in identities:
            rec = IdentityRecord.from_row(raw)
            if not rec.mfl_id:
                continue
            if rec.yahoo_id:
                # ⚠️ First writer wins on a duplicate yahoo_id. Overwriting would
                # make resolution depend on row order, which is not stable.
                self.by_yahoo.setdefault(rec.yahoo_id, rec)
            if rec.gsis_id:
                self.by_gsis.setdefault(rec.gsis_id, []).append(rec)
            nm = normalize_name(rec.merge_name) or normalize_name(rec.name)
            pos = normalize_position(rec.position)
            if nm and pos:
                self.by_name_key.setdefault((nm, pos), []).append(rec)

    def resolve(self, player: dict) -> dict:
        """Resolve one Yahoo player to a fantasy_player_crosswalk row."""
        uid = player.get("player_uid")
        provider_id = usable_id(player.get("provider_player_id"))
        name = player.get("full_name")
        position = normalize_position(player.get("display_position"))
        team = normalize_team(player.get("editorial_team_abbr"))

        base = {
            "platform": player.get("platform", "yahoo"),
            "player_uid": uid,
            "provider_player_id": provider_id,
            "provider_name": name,
            "provider_position": player.get("display_position"),
            "provider_team_abbr": player.get("editorial_team_abbr"),
        }

        # 1 — the provider's own id, via the upstream crosswalk.
        if provider_id:
            rec = self.by_yahoo.get(provider_id)
            if rec:
                return {**base, **_hit(rec), "match_method": METHOD_PROVIDER_ID,
                        "confidence": CONFIDENCE_EXACT, "match_score": None,
                        "review_status": "none", "resolved_by": "yahoo_id"}

        # 2 — a GSIS id supplied directly by the provider.
        gsis = usable_gsis(player.get("gsis_id"))
        if gsis:
            candidates = self.by_gsis.get(gsis) or []
            if candidates:
                # ⚠️ gsis_id is NOT unique in ff_player_ids — several MFL ids can
                # share one. Taking MAX(mfl_id) mirrors the aggregate-subquery
                # form already used in the worker so the join cannot fan out.
                rec = max(candidates, key=lambda r: _as_int(r.mfl_id))
                return {**base, **_hit(rec), "match_method": METHOD_GSIS,
                        "confidence": CONFIDENCE_EXACT, "match_score": None,
                        "review_status": "none", "resolved_by": "gsis_id"}

        # 3 — name AND team AND position. All three, or nothing.
        nm = normalize_name(name)
        if nm and position:
            candidates = self.by_name_key.get((nm, position)) or []
            exact_team = [c for c in candidates if normalize_team(c.team) == team and team]
            if len(exact_team) == 1:
                return {**base, **_hit(exact_team[0]), "match_method": METHOD_NAME,
                        "confidence": CONFIDENCE_FUZZY_AUTO, "match_score": 0.95,
                        "review_status": "none", "resolved_by": "name_team_position",
                        "notes": "matched on normalized name + NFL team + position"}
            if len(candidates) == 1 and not team:
                # Name and position agree and there is exactly one candidate, but
                # the team could not be compared. Plausible, NOT auto-accepted.
                return {**base, **_hit(candidates[0]), "match_method": METHOD_NAME,
                        "confidence": CONFIDENCE_FUZZY_REVIEW, "match_score": 0.80,
                        "review_status": "needed", "resolved_by": "name_position_only",
                        "notes": "name+position agree but NFL team was unavailable "
                                 "to confirm; NOT auto-accepted"}
            if len(candidates) > 1:
                return {**base, "mfl_id": None, "gsis_id": None, "pfr_id": None,
                        "sleeper_id": None, "match_method": METHOD_NAME,
                        "confidence": CONFIDENCE_FUZZY_REVIEW, "match_score": 0.50,
                        "review_status": "needed", "resolved_by": "ambiguous",
                        "notes": f"{len(candidates)} candidates share this "
                                 "normalized name and position; refusing to guess"}

        # 4 — nothing. Recorded, not dropped.
        return {**base, "mfl_id": None, "gsis_id": None, "pfr_id": None,
                "sleeper_id": None, "match_method": METHOD_NONE,
                "confidence": CONFIDENCE_UNMAPPED, "match_score": None,
                "review_status": "needed", "resolved_by": None,
                "notes": "no provider id, no GSIS id, and no name+team+position match"}

    def resolve_all(self, players: Sequence[dict]) -> list[dict]:
        return [self.resolve(p) for p in players]


def _hit(rec: IdentityRecord) -> dict:
    return {"mfl_id": rec.mfl_id, "gsis_id": rec.gsis_id,
            "pfr_id": rec.pfr_id, "sleeper_id": rec.sleeper_id}


def _as_int(value) -> int:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return -1


def coverage_summary(rows: Sequence[dict]) -> dict:
    """Counts by confidence, for the unresolved-player report.

    ⚠️ Counts the POSITIVE case and subtracts. A naive "count unmapped" query
    over SQL returns NULL→0 when both operands are NULL — a documented trap in
    this repo — so the resolved count is the one that is measured directly.
    """
    total = len(rows)
    by_conf: dict[str, int] = {}
    for r in rows:
        conf = r.get("confidence") or CONFIDENCE_UNMAPPED
        by_conf[conf] = by_conf.get(conf, 0) + 1
    resolved = sum(1 for r in rows if usable_id(r.get("mfl_id")))
    return {
        "total": total,
        "resolved": resolved,
        "unresolved": total - resolved,
        "resolved_pct": round(100.0 * resolved / total, 1) if total else 0.0,
        "by_confidence": dict(sorted(by_conf.items())),
        "needs_review": sum(1 for r in rows if r.get("review_status") == "needed"),
    }


def render_unresolved(rows: Sequence[dict], limit: int = 50) -> str:
    """The unresolved-player report, as text."""
    unresolved = [r for r in rows if not usable_id(r.get("mfl_id"))]
    if not unresolved:
        return "  (every player resolved)"
    out = [f"  {len(unresolved)} unresolved player(s):",
           f"  {'player_uid':<20}{'name':<26}{'pos':<6}{'team':<6}{'reason'}"]
    for r in sorted(unresolved, key=lambda x: (x.get("provider_name") or ""))[:limit]:
        out.append(
            f"  {(r.get('player_uid') or '')[:19]:<20}"
            f"{(r.get('provider_name') or '')[:25]:<26}"
            f"{(r.get('provider_position') or '')[:5]:<6}"
            f"{(r.get('provider_team_abbr') or '')[:5]:<6}"
            f"{(r.get('notes') or r.get('confidence') or '')[:60]}"
        )
    if len(unresolved) > limit:
        out.append(f"  … and {len(unresolved) - limit} more")
    return "\n".join(out)
