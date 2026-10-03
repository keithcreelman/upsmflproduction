"""CBS league rules/scoring page -> fantasy_scoring_rules + settings rows.

⚠️ CURRENT SEASON ONLY — CBS SERVES NO RULES HISTORY.
`/rules/scoring/<YEAR>` returns HTTP 200 for any year and IGNORES the year:
2015, 2021 and the bare path all produce a byte-identical scoring table
(content hash 2a562147 on all three). The year suffix is decoration. This
matches the JSON API, which is also current-season-only.

So this module answers "what are the rules NOW" — the baseline a scoring-format
proposal is measured against — and it must NOT be presented as a history.
Season drift that IS recoverable comes from the draft data already ingested
(rounds per season: 17 in 2007-2012 and 2019, 18 elsewhere; 13 franchises in
2008 vs 12 otherwise).

⚠️ THE PAGE CONTAINS THE LEAGUE PASSWORD IN PLAIN TEXT ("League Password" row).
It is DROPPED here, not stored and not logged. A rules archive is something
you would happily paste into a league chat; a credential is not.

⚠️ /league/rules is the WRONG PATH — it returns the generic CBS shell (358KB,
zero scoring terms). The real page is /rules (aka /rules/scoring, 215KB).

⚠️ THIS PAGE HAS NO HISTORY, AND IT DOES NOT SAY SO (proven 2026-08-23)
=======================================================================
`/rules/scoring/2013`, `/rules/scoring/2019`, `?season=2019` and the bare
`/rules/scoring` all return HTTP 200 with a ~215KB page — and all four parse to
the SAME 48 rules with the same modifiers, term for term. The requested year is
echoed back in the page's `requestUri` and in a dropdown, and nowhere else; the
only real differences between two year-paths are per-request CSRF tokens and
JSON key ordering.

So a "historical rules backfill" over this URL would write today's scoring
under fourteen season stamps and look completely successful — the same failure
the JSON API invites (see adapter.SeasonNotServedByApi), via a different door.

CONSEQUENCE: historical scoring for this league is NOT retrievable as rules. It
can only be RECOVERED, by fitting observed points against observed stats — which
is what stats.py does, and the reason it exists. Its derived coefficients
(fantasy_scoring_rules, stat_id LIKE 'fit:%') are the only evidence of what this
league scored before the current season.

For the CURRENT season, prefer the JSON API (`league/scoring/rules` via
parse_api.py): it is authoritative, structured, and states the bonus BANDS this
page can only describe in prose.
"""
from __future__ import annotations

import re

from .constants import PLATFORM, league_key, league_host

#: Rows whose Description matches these are never emitted. Substring match,
#: case-insensitive, deliberately broad — a false positive costs one settings
#: row; a false negative writes a credential into the database.
_SECRET_ROWS = ("password", "passcode", "pin", "invite code", "league url")

_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_CELL_RE = re.compile(r"<t[dh][^>]*>(.*?)</t[dh]>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")

#: "Special Scoring for Wide Receivers" -> the position the block applies to.
_SECTION_RE = re.compile(r"Special Scoring for\s+(.+?)\s*$", re.I)
_POSITION_MAP = {
    "quarterbacks": "QB", "team quarterbacks": "TQB", "running backs": "RB",
    "wide receivers": "WR", "tight ends": "TE", "kickers": "K",
    "team kickers": "TK", "defense/special teams": "DST", "team defense": "DST",
}

#: "-2 points" / "12 points" / "1 point" -> the BASE value, with any trailing
#: bonus prose captured separately.
#: ⚠️ NO \b AFTER points? — CBS concatenates the bonus prose with NO separator
#: ("4 pointsPlus 1 point for a PaTD of 10 to 39 Yds"), so a word boundary
#: never matches there. With \b this regex failed on EVERY touchdown rule that
#: carries a distance bonus, and those rows were silently misfiled as league
#: settings — losing exactly the rules that make this league unusual.
_POINTS_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*points?(.*)$", re.I | re.S)

#: Everything after this banner is league prose + inlined JavaScript, not rules.
_STOP_BANNERS = ("constitution",)


def _text(html: str) -> str:
    return re.sub(r"\s+", " ", _TAG_RE.sub("", html)).replace("&nbsp;", " ").strip()


def _rows(html: str) -> list[list[str]]:
    out = []
    for m in _ROW_RE.finditer(html):
        cells = [_text(c) for c in _CELL_RE.findall(m.group(1))]
        out.append([c for c in cells if c])
    return out


def is_secret_row(description: str) -> bool:
    d = (description or "").lower()
    return any(k in d for k in _SECRET_ROWS)


def parse_rules(html: str, *, season: int, league_id: str) -> dict[str, list[dict]]:
    """Split the page into per-position SCORING rules and league SETTINGS.

    ⚠️ TWO DIFFERENT TABLE SHAPES SHARE THIS PAGE, and conflating them is the
    bug this docstring exists to prevent:
        settings rows -> 2 cells:  Description | Setting     ("Teams" | "12")
        scoring rows  -> 3 cells:  Abbr | Description | Value ("ReTD" | "Receiving TD" | "12 points...")
    A first version treated *any* numerically-valued 2-cell row as a scoring
    rule, which classified "Teams 12", "Draft Rounds 18" and "League Entry Fee
    64" as scoring — confidently wrong. Shape + section now decide, not the
    presence of a number.

    ⚠️ Scoring is PER POSITION here. The same abbreviation (ReTD) appears under
    several position blocks and may carry different values, so a rule is only
    meaningful together with applies_to_positions.
    """
    rows = _rows(html)
    if not rows:
        raise ValueError("no table rows parsed from the rules page — refusing to "
                         "report an empty rulebook")

    lk = league_key(season, league_id)
    scoring: list[dict] = []
    settings: list[dict] = []
    redacted = 0
    position = None
    order = 0

    for cells in rows:
        if not cells:
            continue
        low0 = cells[0].lower()

        if len(cells) == 1:
            if any(b in low0 for b in _STOP_BANNERS):
                break                      # league prose + JS follows; stop cleanly
            m = _SECTION_RE.match(cells[0])
            # A non-scoring banner ends the current scoring block, so settings
            # rows below it can never inherit a stale position.
            position = _POSITION_MAP.get(m.group(1).strip().lower()) if m else None
            continue

        if low0 in ("description", "category", "stat", "abbr"):
            continue
        if is_secret_row(cells[0]):
            redacted += 1
            continue

        if len(cells) >= 3 and position:
            m = _POINTS_RE.match(cells[2])
            if not m:
                # Value we cannot read as points -> keep it, flagged, rather
                # than dropping a real rule or guessing a number for it.
                settings.append({"description": f"{cells[1]} ({cells[0]})",
                                 "setting": cells[2], "section": position,
                                 "unparsed_scoring_value": True})
                continue
            base, bonus = float(m.group(1)), m.group(2).strip()
            order += 1
            scoring.append({
                "platform": PLATFORM,
                "league_key": lk,
                "season": season,
                # ⚠️ stat_id is CBS's own abbreviation scoped by position — NOT a
                # canonical cross-platform id. The same abbr under two positions
                # is two different rules in this league.
                "stat_id": f"{position}:{cells[0]}",
                "stat_abbr": cells[0],
                "stat_name": cells[1],
                "stat_display_name": cells[1],
                "position_type": position,
                "applies_to_positions": position,
                "modifier": base,
                "is_enabled": 1,
                "sort_order": order,
                # ⚠️ BONUS PROSE IS KEPT VERBATIM. This league stacks distance
                # bonuses on top of the base ("12 points" + more for 10-39 /
                # 40-69 / 70-100 yard TDs). `modifier` alone therefore UNDERSTATES
                # what a long touchdown is worth; any recomputation must read
                # raw_stat_json.bonus_text too.
                "raw_stat_json": {"abbr": cells[0], "description": cells[1],
                                  "value_text": cells[2], "base_points": base,
                                  "bonus_text": bonus or None, "position": position},
            })
        elif len(cells) >= 2:
            settings.append({"description": cells[0], "setting": cells[1],
                             "section": position})

    if not scoring:
        raise ValueError(
            f"parsed {len(rows)} rows but ZERO scoring rules — the page rendered "
            f"without per-position scoring blocks (wrong path? /league/rules returns "
            f"the CBS shell). Refusing to report an empty scoring system.")

    return {
        "fantasy_scoring_rules": scoring,
        "_settings": settings,
        "_redacted_rows": redacted,
        "_source_url": f"{league_host(league_id)}/rules/scoring",
    }
