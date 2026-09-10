"""CBS league HISTORY — /history/team-overview/<TEAM_ID>.

WHAT THIS UNLOCKS, AND WHY IT WAS WORTH HUNTING FOR
===================================================
CBS serves no league-wide weekly scores for any past season, so All-Play and
anything else needing game-level history is unreachable (see adapter
fetch_scoreboard). This page is the consolation prize and it is a large one:
a YEARLY RESULTS table per franchise going back to 2003, carrying

    Year | [Team Name] | W | L | T | PCT | PF | PA | MANAGERS | FINISH

⚠️ THE MANAGERS COLUMN IS THE POINT. Every other CBS surface — draft results,
standings, schedules — names FRANCHISES and never PEOPLE, which is why owner
continuity previously had to be taken on testimony. This states, per season,
who ran each franchise. It is what turns "I'm told only one owner is new" into
a fact that can be checked.

⚠️ TWO HEADER SHAPES. Some franchises render a `Team Name` column and some do
not, so the row width varies by TEAM. Parsing with one fixed pattern silently
returns zero rows for half the league — detect the header first.

⚠️ MANAGER NAMES ARE FREE TEXT AND DIRTY. Observed in one league: 'chuck
shcoolcraft' vs 'chuck', 'chris klingenberg' vs 'Chris Klingenberg', 'cliff
partosan' vs 'Cliff Partosan', and a literal '-' for unknown. They are stored
VERBATIM and a normalised key is offered alongside — never silently merged,
because 'Chuck Schoolcraft' (id 11) and 'chuck shcoolcraft' (id 6) are two
DIFFERENT people in this league and a fuzzy match would fuse them.
"""
from __future__ import annotations

import json as _json
import re

from .constants import PLATFORM, league_key, team_key_from_id

#: The nav lists every franchise that has ever existed, retired ones included.
_ID_RE = re.compile(r"/history/team-overview/(\d+)")
_MARKER = "YEARLY RESULTS"
#: With a Team Name column, and without.
#: ⚠️ THE TRAILING DELIMITER IS A LOOKAHEAD, NOT A MATCH. Consuming it eats the
#: pipe that the NEXT row needs as its leading delimiter, so finditer skips
#: every other row — which looked like a franchise having half its seasons.
_ROW_NAMED = re.compile(
    r"\|(\d{4})\|([^|]*)\|(\d+)\|(\d+)\|(\d+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([^|]*)\|([^|]*)(?=\|)")
_ROW_PLAIN = re.compile(
    r"\|(\d{4})\|(\d+)\|(\d+)\|(\d+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([^|]*)\|([^|]*)(?=\|)")


class CbsHistoryError(ValueError):
    pass


def _flatten(html: str) -> str:
    """Tags -> pipes, with whitespace around the pipes REMOVED.

    ⚠️ The live page happens to emit cells with no surrounding whitespace, so
    patterns anchored on a bare year-between-pipes worked against it and silently matched
    NOTHING on any page formatted with newlines or indentation. Normalising the
    separator here makes the row patterns depend on structure rather than on
    CBS's current whitespace habits.
    """
    t = re.sub(r"<script.*?</script>", "", html, flags=re.S)
    t = re.sub(r"<[^>]+>", "|", t)
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s*\|\s*", "|", t)
    return re.sub(r"\|+", "|", t)


def franchise_ids(history_html: str) -> list[str]:
    ids = sorted(set(_ID_RE.findall(history_html)), key=int)
    if not ids:
        raise CbsHistoryError(
            "/history lists no team-overview links. An empty franchise list is "
            "not a league with no history; it means the page changed shape.")
    return ids


def manager_key(name: str) -> str:
    """A comparison key. Case and spacing only — NEVER fuzzy.

    ⚠️ DELIBERATELY NOT A SIMILARITY MATCH. This league contains both 'Chuck
    Schoolcraft' and 'chuck shcoolcraft' as DISTINCT managers of DIFFERENT
    franchises. Any edit-distance merge fuses two real people into one and
    silently reassigns a decade of results.
    """
    return re.sub(r"[^a-z]", "", (name or "").lower())


def parse_team_overview(html: str, team_id: str) -> list[dict]:
    """One franchise's season-by-season history. May legitimately be EMPTY —
    a brand-new franchise has no rows, which is a fact worth recording."""
    flat = _flatten(html)
    i = flat.find(_MARKER)
    if i < 0:
        raise CbsHistoryError(
            f"team {team_id}: no {_MARKER!r} block — the page did not render as "
            f"a history table (stale cookie, or CBS changed the layout).")
    block = flat[i:i + 8000]
    # ⚠️ DETECT THE SHAPE BY COLUMN NAME, NOT BY DELIMITER PATTERN. An earlier
    # version keyed on a `| |` sequence that existed only because the live page
    # emitted an empty cell there — normalising whitespace removed it and the
    # header stopped matching, which silently made every franchise look narrow.
    # The header is whatever precedes the first 4-digit year.
    first_year = re.search(r"\|(\d{4})\|", block)
    header = block[:first_year.start()] if first_year else block[:400]
    named = "Team Name" in header
    rows = []
    for m in (_ROW_NAMED if named else _ROW_PLAIN).finditer(block):
        g = list(m.groups())
        if not named:
            g.insert(1, "")
        rows.append({
            "team_id": team_id, "season": int(g[0]), "team_name": g[1].strip() or None,
            "wins": int(g[2]), "losses": int(g[3]), "ties": int(g[4]),
            "win_percentage": float(g[5]),
            "points_for": float(g[6]), "points_against": float(g[7]),
            "manager": g[8].strip(), "finish": g[9].strip(),
        })
    return rows


def to_rows(history: dict[str, list[dict]], *, league_id: str,
            known_managers: dict[str, str] | None = None,
            names_by_id: dict[str, str] | None = None) -> dict[str, list[dict]]:
    """Franchise histories → fantasy_standings_snapshots + managers + linkage.

    `known_managers` maps a normalised manager name to the API's REAL account
    GUID. Passing it reconciles the two identifier spaces: without it the same
    person lands twice — once under the API's stable GUID from the current
    season, and once under a name-derived id from these pages — and every
    "career" query silently splits them in half.

    A name that does not match a known GUID keeps the `name:` id, which is the
    honest outcome for a manager who has not been in the league since the API
    started answering for it.
    """
    if not history:
        raise CbsHistoryError("no franchise histories parsed; refusing to write nothing.")
    standings, managers, links, teams, seen_mgr = [], [], [], [], {}
    for tid, rows in history.items():
        for r in rows:
            season = r["season"]
            lk = league_key(season, league_id)
            tk = team_key_from_id(season, league_id, tid)
            standings.append({
                "platform": PLATFORM, "league_key": lk, "season": season,
                # ⚠️ as_of_week IS PART OF THE PRIMARY KEY, so NULL is not an
                # option — the audit caught it. W+L+T is the number of periods
                # the team actually played, which for this league equals the
                # full schedule (every team plays all 17, playoff or
                # consolation). So it IS the final period, derived from the
                # data rather than hardcoded to a 17 that varies by season.
                "as_of_week": r["wins"] + r["losses"] + r["ties"],
                "team_key": tk, "rank": _finish_rank(r["finish"]),
                "wins": r["wins"], "losses": r["losses"], "ties": r["ties"],
                "win_percentage": r["win_percentage"],
                "points_for": r["points_for"], "points_against": r["points_against"],
                "is_final": 1, "is_inferred": 0,
                # ⚠️ KEEP THE VERBATIM FINISH. 'CHAMPION' and '1st' are
                # DIFFERENT labels in CBS's vocabulary — every season has
                # exactly one CHAMPION, while '1st' appears in only 7 of 23
                # seasons and means the regular-season leader. Mapping both to
                # rank 1 produced two champions in 2025. Any champion analysis
                # must filter on this string, not on rank.
                "raw_standings_json": _json.dumps({"finish": r["finish"]}),
            })
            # ⚠️ WITHOUT A fantasy_teams ROW THE HISTORY IS UNJOINABLE. Draft
            # rows key on a slug of the franchise NAME; these key on a numeric
            # id. Emitting the team row with its name is what lets the two meet.
            nm = r["team_name"] or (names_by_id or {}).get(tid)
            if nm:
                teams.append({
                    "platform": PLATFORM, "team_key": tk, "league_key": lk,
                    "season": season, "team_id": tid, "team_name": nm,
                    "is_owned_by_current_login": None,
                })
            mk = manager_key(r["manager"])
            # '-' and blanks are CBS saying it does not know, not a person.
            if not mk or r["manager"] == "-":
                continue
            uid = (known_managers or {}).get(mk) or f"name:{mk}"
            prev = seen_mgr.get(uid)
            seen_mgr[uid] = (min(prev[0], season) if prev else season,
                             max(prev[1], season) if prev else season,
                             r["manager"])
            links.append({
                "platform": PLATFORM, "team_key": tk, "manager_uid": uid,
                "league_key": lk, "season": season,
                "nickname_at_time": r["manager"],
                "is_commissioner": 0, "is_comanager": 0,
            })
    for uid, (lo, hi, label) in seen_mgr.items():
        managers.append({
            "platform": PLATFORM, "manager_uid": uid, "display_name": label,
            "first_season": lo, "last_season": hi,
            "name_history": None,
            # ⚠️ A NAME-DERIVED UID, and it says so. The API's owner GUIDs are
            # stable and real; these are not, and the two must never be
            # confused — hence the 'name:' prefix rather than a bare string.
            "raw_manager_json": ('{"source":"history_page","id_basis":"api_guid"}'
                                 if not uid.startswith("name:")
                                 else '{"source":"history_page","id_basis":"normalised name"}'),
        })
    out = {"fantasy_standings_snapshots": standings,
           "fantasy_managers": managers, "fantasy_team_managers": links}
    if teams:
        out["fantasy_teams"] = teams
    return out


_STANDING_RE = re.compile(r"\|([^|]{3,40}?)\|(\d+)\|(\d+)\|(\d+)\|")


def parse_standings_names(html: str) -> list[dict]:
    """`/standings/overall/<YEAR>` → franchise NAME + W-L-T for that season.

    ⚠️ THIS IS THE MISSING HALF OF THE JOIN. The history pages key on a numeric
    franchise id and (for most teams) never state the franchise NAME; the draft
    pages state the name and never the id. Neither can be matched to the other
    directly. Both, however, carry the season W-L-T record — so the standings
    page is what bridges them.
    """
    flat = _flatten(html)
    out = []
    for m in _STANDING_RE.finditer(flat):
        name = m.group(1).strip()
        if not name or not re.search(r"[A-Za-z]", name) or name.lower() in (
                "team", "overall", "division", "record", "streak"):
            continue
        out.append({"team_name": name, "wins": int(m.group(2)),
                    "losses": int(m.group(3)), "ties": int(m.group(4))})
    return out


def crosswalk(history: dict[str, list[dict]],
              standings: dict[int, list[dict]]) -> dict[str, str]:
    """franchise NAME -> history team id, matched on season W-L-T.

    ⚠️ ONLY UNAMBIGUOUS MATCHES ARE KEPT. Two teams can finish 8-8 in the same
    season, so a single season is not enough to identify anyone. A name is
    bound to an id only where the pairing holds across EVERY season both
    appear, and where no other id fits equally well. Anything ambiguous is
    dropped rather than guessed — a wrong binding silently reassigns a decade
    of somebody's results.
    """
    rec_by_id: dict[str, dict[int, tuple]] = {}
    for tid, rows in history.items():
        rec_by_id[tid] = {r["season"]: (r["wins"], r["losses"], r["ties"]) for r in rows}
    out, ambiguous = {}, []
    names = {s["team_name"] for rows in standings.values() for s in rows}
    for name in names:
        mine = {yr: (s["wins"], s["losses"], s["ties"])
                for yr, rows in standings.items()
                for s in rows if s["team_name"] == name}
        fits = [tid for tid, rec in rec_by_id.items()
                if mine and all(rec.get(yr) == v for yr, v in mine.items())
                and any(yr in rec for yr in mine)]
        if len(fits) == 1:
            out[name] = fits[0]
        elif len(fits) > 1:
            ambiguous.append((name, fits))
    if ambiguous:
        raise CbsHistoryError(
            f"ambiguous franchise identity for {ambiguous[:3]} — more than one "
            f"history id matches the same season records. Refusing to bind a "
            f"name to an id on a coin flip.")
    return out


def _finish_rank(finish: str) -> int | None:
    """'CHAMPION' -> 1, '4th' -> 4, anything else -> None (never a guess).

    ⚠️ RANK IS NOT A CHAMPION FLAG. CBS also emits a separate '1st' for the
    regular-season leader in some seasons, which lands on rank 1 as well — so a
    season can legitimately contain two rank-1 rows. The verbatim finish is
    preserved in raw_standings_json precisely so champion questions can be
    answered from the label rather than from this number.
    """
    f = (finish or "").strip().upper()
    if f.startswith("CHAMPION"):
        return 1
    m = re.match(r"(\d+)", f)
    return int(m.group(1)) if m else None


def _j_finish(finish: str) -> str:
    return finish
