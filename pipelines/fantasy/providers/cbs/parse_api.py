"""CBS JSON API payloads → platform-neutral fantasy_* rows. Pure functions.

No network, no credentials, no database — every function here takes an already
unwrapped `body` dict and returns row dicts, so the whole mapping is testable
against captured fixtures. That separation is the reason the ESPN and Yahoo
parsers could be verified without a live account, and it applies unchanged here.

WHAT CBS GETS RIGHT, AND THE ONE THING IT DOESN'T
=================================================
Right: stable numeric team ids and stable owner GUIDs, both absent from the
history pages. Those make `fantasy_managers` genuinely keyable for this
platform for the first time.

Not right: **CBS states scoring TWICE and the two disagree on purpose.**
`categories` is the league default for a stat; `positions` is the per-position
override, active only when `position_scoring` is 1. A parser that read either
list alone would produce a scoring table that is wrong for most of the roster —
in this league a receiving touchdown is worth 6 to a wide receiver and 12 to a
running back. Both lists are emitted, distinguished by stat_id namespace
('ReTD' vs 'RB:ReTD') and by applies_to_positions, and `position_scoring` is
carried through so a consumer knows whether the overrides are live.
"""
from __future__ import annotations

import json
from typing import Any

from .constants import (GAME_CODE, PLATFORM, UPCOMING_PICK_SENTINEL,
                        league_host, league_key, team_key_from_id)


class CbsPayloadError(ValueError):
    """A payload that parsed as JSON but cannot be believed.

    Separate from the transport-level errors in api.py: this is 'CBS answered,
    the answer is well-formed, and it does not say what it appears to say'.
    """


# ── small helpers ────────────────────────────────────────────────────────────

def _int(v: Any) -> int | None:
    """int(), but NULL-preserving. '' and None both mean 'not stated'.

    ⚠️ Never returns 0 for an unparseable value. CBS uses '' for several
    booleans that are genuinely unset, and coercing those to 0 would turn
    'CBS did not say' into 'CBS said no'.
    """
    if v is None or v == "":
        return None
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _float(v: Any) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        return None


def _j(v: Any) -> str | None:
    return None if v is None else json.dumps(v, sort_keys=True, separators=(",", ":"))


def _require(body: dict, key: str, endpoint: str) -> Any:
    if key not in body:
        raise CbsPayloadError(
            f"{endpoint}: payload has no '{key}' (keys: {sorted(body)[:10]}). "
            f"A missing collection is not an empty one.")
    return body[key]


def _week_from_label(label: Any) -> int | None:
    """'Week 15' -> 15. Anything else -> None, never a guess."""
    if not isinstance(label, str):
        return None
    digits = "".join(c for c in label if c.isdigit())
    return int(digits) if digits else None


def _yyyymmdd(v: Any) -> str | None:
    """20261115 -> '2026-11-15'. Refuses anything that is not 8 digits."""
    s = str(v or "").strip()
    if len(s) != 8 or not s.isdigit():
        return None
    return f"{s[0:4]}-{s[4:6]}-{s[6:8]}"



def _rate_and_tiers(entry: dict, *, stat_id: str) -> tuple[float | None, list[dict]]:
    """Read CBS's `ranges`, which carries TWO INCOMPATIBLE MEANINGS.

    ⚠️ THE `per` DIVISOR IS LOAD-BEARING AND EASY TO MISS. A rate arrives as
    `{"from":"0","to":"+","points":".1","per":"2.5"}` — .1 points for every 2.5
    yards, i.e. 0.04/yd. Passing yards and receiving yards look IDENTICAL apart
    from that one field (per 2.5 vs per 1), so dropping it scores every passing
    yard at 2.5x. It did, until an empirical fit of CBS's own displayed points
    said 0.05/yd where the parser claimed 0.1 and the HTML rules page spelled it
    out: ".1 points for every 2.5 PaYds". Two independent sources agreeing
    against the parser is what caught it.

    The OTHER meaning is a piecewise LOOKUP TABLE: DSTPA maps points-allowed to
    a flat score across seven closed, mutually exclusive tiers. There is no
    rate to state, so `modifier` is NULL and the tiers are returned to be
    stored as bands. Taking ranges[0] — as this function's predecessor did —
    silently reduced that whole table to its shutout tier, scoring every
    defense as though it had pitched a shutout.

    Returns (rate_or_None, tier_dicts). Raises rather than guessing on any
    shape not seen in the payload this was written against.
    """
    ranges = [r for r in (entry.get("ranges") or [])
              if r.get("points") is not None or r.get("from") is not None]
    if not ranges:
        return None, []

    if len(ranges) == 1:
        r = ranges[0]
        pts = _float(r.get("points"))
        if pts is None:
            raise CbsPayloadError(f"{stat_id}: range {r!r} states no points.")
        per = _float(r.get("per"))
        if per is None:
            # A single open range with no divisor is a plain per-unit rate.
            # Only accept that when CBS really did omit `per`; a present-but-
            # unparseable value is a shape change and must not read as 1.
            if "per" in r:
                raise CbsPayloadError(
                    f"{stat_id}: range has an unreadable `per` ({r.get('per')!r}). "
                    f"Defaulting it to 1 would silently change the scoring rate.")
            return pts, []
        if per == 0:
            raise CbsPayloadError(f"{stat_id}: range `per` is zero — no rate exists.")
        return pts / per, []

    # Multiple ranges = a lookup table. `per` has no meaning here and its
    # presence would mean a shape this code has never seen.
    for r in ranges:
        if r.get("per") is not None:
            raise CbsPayloadError(
                f"{stat_id}: {len(ranges)} ranges AND a `per` divisor. That "
                f"combination has never been observed and cannot be scored as "
                f"either a rate or a table.")
    tiers = []
    for r in ranges:
        lo, hi, pts = _float(r.get("from")), _float(r.get("to")), _float(r.get("points"))
        if lo is None or pts is None:
            raise CbsPayloadError(f"{stat_id}: tier {r!r} has no usable from/points.")
        tiers.append({"from": lo, "to": hi, "points": pts, "raw": r})
    return None, tiers


# ── league identity + settings ───────────────────────────────────────────────

def parse_league_metadata(details: dict, *, season: int, league_id: str,
                          draft_config: dict | None = None,
                          my_team_id: str | None = None) -> dict:
    """`league/details` (+ optional `league/draft/config`) → fantasy_league_seasons."""
    d = _require(details, "league_details", "league/details")
    dc = (draft_config or {}).get("draft") or {}
    draft_type = d.get("draft_type")
    return {
        "platform": PLATFORM,
        "league_key": league_key(season, league_id),
        "season": season,
        # CBS has no per-season game key (Yahoo's reason for that column); the
        # season lives in league_key itself. Stored as the sport code so the
        # NOT NULL constraint carries a true value rather than a placeholder.
        "game_key": GAME_CODE,
        "game_code": GAME_CODE,
        "league_id": league_id,
        "league_name": d.get("name"),
        "league_url": league_host(league_id),
        "num_teams": _int(d.get("num_teams")),
        "draft_type": draft_type,                      # verbatim: 'live'
        "is_auction_draft": 1 if str(draft_type).lower() == "auction" else 0,
        # league/details states the format as the flag is_h2h; the word 'h2h'
        # is CBS's own (rules.scoring_system.type says exactly that).
        "scoring_type": "h2h" if _int(d.get("is_h2h")) else None,
        # CBS never states public/private on this endpoint. NULL, not a guess.
        "league_type": None,
        "start_week": 1,
        "end_week": _int(d.get("scoring_periods")),
        "current_week": _int(d.get("current_period")),
        "my_team_key": team_key_from_id(season, league_id, my_team_id) if my_team_id else None,
        "discovery_source": "manual",
        "is_accessible": 1,
        "backfill_status": "in_progress",
        "notes": f"draft {dc.get('order_type') or '?'} {dc.get('rounds') or '?'}rd; "
                 f"season_status={d.get('season_status')}",
    }


def parse_league_settings(details: dict, rules: dict, *, season: int, league_id: str,
                          draft_config: dict | None = None,
                          scoring_rows: list[dict] | None = None) -> dict:
    """`league/details` + `league/rules` (+ draft/config) → fantasy_league_settings.

    `scoring_rows` is the output of parse_scoring_rules. It is used ONLY to set
    uses_fractional_points / uses_negative_points, which CBS states nowhere:
    they are read off the modifiers this league actually has rather than
    assumed, so they are derived from stated data, not invented.
    """
    d = _require(details, "league_details", "league/details")
    r = _require(rules, "rules", "league/rules")
    sched = r.get("schedule") or {}
    tx = r.get("transactions") or {}
    dc = (draft_config or {}).get("draft") or {}

    def sv(block: dict, key: str) -> Any:
        v = block.get(key)
        return v.get("value") if isinstance(v, dict) else v

    mods = [row.get("modifier") for row in (scoring_rows or [])
            if row.get("modifier") is not None]
    num_div = _int(d.get("num_divisions"))
    draft_type = d.get("draft_type")

    return {
        "platform": PLATFORM,
        "league_key": league_key(season, league_id),
        "season": season,

        "league_name": d.get("name"),
        "league_url": league_host(league_id),
        "logo_url": None,
        "league_type": None,
        "num_teams": _int(d.get("num_teams")),
        "max_teams": None,

        "start_week": 1,
        "end_week": _int(d.get("scoring_periods")),
        "current_week": _int(d.get("current_period")),
        "start_date": None,
        "end_date": None,
        # season_status is CBS's own word and is preserved in raw_settings_json.
        # Only the unambiguous 'complete' maps to finished; 'preseason' and
        # 'inseason' both mean not finished.
        "is_finished": 1 if str(d.get("season_status")).lower() in ("complete", "final") else 0,
        "weekly_deadline": sv(tx, "lineup_deadline"),          # 'game_time', verbatim
        "league_update_timestamp_unix": None,

        "draft_status": d.get("draft_state"),                   # 'awaitingstart', verbatim
        "draft_type": draft_type,                               # 'live', verbatim
        "is_auction_draft": 1 if str(draft_type).lower() == "auction" else 0,
        "draft_time_unix": _int(dc.get("timestamp")),
        "draft_pick_time_sec": _int(dc.get("time_limit")),
        "post_draft_players": None,

        "scoring_type": (r.get("scoring_system") or {}).get("type"),   # 'h2h', verbatim
        "uses_fractional_points": (1 if any(m != int(m) for m in mods) else 0) if mods else None,
        "uses_negative_points": (1 if any(m < 0 for m in mods) else 0) if mods else None,
        "waiver_type": sv(tx, "add_drop_policy"),               # 'waivers', verbatim
        "waiver_rule": sv(tx, "add_drop_deadline"),             # verbatim
        "waiver_time_days": _int(sv(tx, "add_drop_waiver_period")),
        # ⚠️ NULL, NOT 0. CBS's transactions block has no FAAB/budget/bid field
        # under any spelling (grepped). Absence of a field is 'CBS did not say',
        # which is a different fact from 'CBS said this league has no FAAB' —
        # and the waiver-analysis queries downstream depend on the difference.
        "uses_faab": None,
        "faab_budget": None,
        "trade_end_date": _yyyymmdd(sv(tx, "trade_deadline")),
        "trade_ratify_type": sv(tx, "trade_policy"),            # 'approve', verbatim
        "trade_reject_time_days": None,
        "max_acquisitions": _int(sv(tx, "add_drop_limit")),
        "max_weekly_acquisitions": None,
        "max_trades": None,
        "player_pool": (r.get("player_pool") or {}).get("value"),   # 'both', verbatim
        "cant_cut_list": None,

        "uses_playoff": 1 if str(sv(sched, "automatic_playoffs")).lower() == "yes" else None,
        "playoff_start_week": _week_from_label(sv(sched, "playoffs_start")),
        "num_playoff_teams": _int(sv(sched, "num_playoff_teams")),
        "num_playoff_consolation_teams": _int(sv(sched, "num_consolation_teams")),
        "has_playoff_consolation_games":
            1 if str(sv(sched, "consolation_playoffs")).lower() == "yes" else 0,
        "uses_playoff_reseeding": 1 if str(sv(sched, "reseed")).lower() == "yes" else 0,
        "uses_lock_eliminated_teams": None,
        "has_multiweek_championship": None,

        "uses_keepers": _int(d.get("uses_keepers")),
        "num_keepers": None,
        "uses_divisions": (1 if num_div and num_div > 1 else 0) if num_div is not None else None,
        "num_divisions": num_div,

        "raw_settings_json": _j({"league_details": d, "rules": r, "draft": dc}),
        "unmapped_fields": _j(["rules.fees", "rules.eligibility",
                               "rules.roster.illegal_rosters_score_zero",
                               "league_details.service_level",
                               "league_details.effective_point"]),
    }


# ── scoring ──────────────────────────────────────────────────────────────────

def _bonus_rows(entries: list[dict], *, stat_id: str, stat_name: str,
                positions: list[str] | None, league_key_: str, season: int) -> list[dict]:
    """One fantasy_scoring_bonuses row per band.

    ⚠️ THE BAND'S UPPER EDGE IS LOAD-BEARING. CBS writes an open-ended
    milestone as to='+' and a closed exclusive band as to='39'. Both arrive in
    the same list with the same `scale_bonus` flag, so the only thing
    separating '+3 for every 100 rushing yards, cumulative' from 'exactly one
    of 10-39 / 40-69 / 70-100 fires' is whether `to` is a number. Collapsing
    them to a single threshold makes a 45-yard touchdown collect two bonuses.
    """
    out = []
    for e in entries or []:
        lo = _float(e.get("from"))
        raw_to = e.get("to")
        hi = _float(raw_to)                       # '+' -> None, i.e. open-ended
        pts = _float(e.get("points"))
        if lo is None or pts is None:
            # A band with no threshold or no value cannot be applied. Refusing
            # is the point: a silently dropped bonus understates every score.
            raise CbsPayloadError(
                f"{stat_id}: bonus band {e!r} has no usable from/points. "
                f"A bonus that cannot be evaluated must not be stored as if it could.")
        out.append({
            "platform": PLATFORM,
            "league_key": league_key_,
            "season": season,
            "bonus_id": f"{stat_id}:{int(lo) if lo == int(lo) else lo}",
            "stat_id": stat_id,
            "stat_name": stat_name,
            "target_value": lo,
            "target_max": hi,                     # NULL = open-ended, see 0134
            "bonus_points": pts,
            # CBS sets scale_bonus on BOTH shapes, so it is not the stacking
            # signal — an unbounded upper edge is. Recorded as observed.
            "is_stacking": 1 if hi is None else 0,
            "position_type": None,
            "applies_to_positions": _j(positions) if positions else None,
            "raw_bonus_json": _j(e),
        })
    return out


def _tier_rows(tiers: list[dict], *, stat_id: str, stat_name: str,
               positions: list[str] | None, league_key_: str, season: int) -> list[dict]:
    """A piecewise lookup table, stored in the same shape as a closed bonus band.

    DSTPA (points allowed -> score) is the only stat in this league that works
    this way. The tiers reuse fantasy_scoring_bonuses because 0134 gave it
    exactly the vocabulary a tier needs — a lower edge, an inclusive upper edge,
    and is_stacking=0 meaning EXACTLY ONE fires. The distinguishing mark of a
    tier versus a bonus is that its rule row has modifier NULL: there is no rate
    to add the tier to, the tier IS the score.
    """
    out = []
    for t in tiers:
        lo = t["from"]
        out.append({
            "platform": PLATFORM, "league_key": league_key_, "season": season,
            "bonus_id": f"{stat_id}:tier:{int(lo) if lo == int(lo) else lo}",
            "stat_id": stat_id, "stat_name": stat_name,
            "target_value": lo,
            "target_max": t["to"],
            "bonus_points": t["points"],
            "is_stacking": 0,
            "position_type": None,
            "applies_to_positions": _j(positions) if positions else None,
            "raw_bonus_json": _j(t["raw"]),
        })
    return out


def parse_scoring_rules(scoring: dict, *, season: int, league_id: str
                        ) -> dict[str, list[dict]]:
    """`league/scoring/rules` → fantasy_scoring_rules + fantasy_scoring_bonuses.

    STAT_ID NAMESPACING. The table's primary key allows one row per stat per
    season, but this league scores the same stat differently by position. The
    league-default row keeps the bare abbreviation ('ReTD'); each override is
    namespaced by position ('RB:ReTD') and carries applies_to_positions. A
    points calculation therefore looks up '<pos>:<stat>' first and falls back
    to '<stat>', which is exactly CBS's own resolution order.
    """
    sr = _require(scoring, "scoring_rules", "league/scoring/rules")
    lk = league_key(season, league_id)
    position_scoring = _int(sr.get("position_scoring"))
    cats = sr.get("categories")
    poss = sr.get("positions")
    if not isinstance(cats, list) or not isinstance(poss, list):
        raise CbsPayloadError(
            "league/scoring/rules: expected list 'categories' and list "
            f"'positions', got {type(cats).__name__}/{type(poss).__name__}")
    if not cats:
        raise CbsPayloadError(
            "league/scoring/rules: zero scoring categories. Every league scores "
            "something; an empty rulebook is an unreadable response, not a league "
            "with no rules.")

    rules: list[dict] = []
    bonuses: list[dict] = []

    for order, c in enumerate(cats):
        abbr = c.get("name")
        if not abbr:
            raise CbsPayloadError(f"league/scoring/rules: category with no name: {c!r}")
        # `ranges` is how CBS states a per-unit rate for yardage: [{from:0,
        # to:'+', points:'.1'}] means 0.1 points per yard. `points` is null for
        # those stats, so reading `points` alone would score every yardage stat
        # as unscored — a league where passing yards are worth nothing.
        rate = _float(c.get("points"))
        tiers: list[dict] = []
        if rate is None:
            rate, tiers = _rate_and_tiers(c, stat_id=abbr)
        rules.append({
            "platform": PLATFORM, "league_key": lk, "season": season,
            "stat_id": abbr, "stat_name": abbr, "stat_display_name": abbr,
            "stat_abbr": abbr, "stat_group": c.get("group"),
            "position_type": None,
            "applies_to_positions": None,          # NULL = every position
            "modifier": rate,
            "is_enabled": 1,
            # A tiered stat has no rate but is emphatically SCORED — its value
            # lives in the tiers below. Only a stat with neither is display-only.
            "is_display_only": 1 if (rate is None and not tiers) else 0,
            "sort_order": order,
            "raw_stat_json": _j(c),
        })
        bonuses += _bonus_rows(c.get("bonuses"), stat_id=abbr, stat_name=abbr,
                               positions=None, league_key_=lk, season=season)
        bonuses += _tier_rows(tiers, stat_id=abbr, stat_name=abbr, positions=None,
                              league_key_=lk, season=season)

    for order, p in enumerate(poss, start=1000):
        pos, abbr = p.get("pos"), p.get("name")
        if not pos or not abbr:
            raise CbsPayloadError(f"league/scoring/rules: position rule missing pos/name: {p!r}")
        sid = f"{pos}:{abbr}"
        rate = _float(p.get("points"))
        ptiers: list[dict] = []
        if rate is None:
            rate, ptiers = _rate_and_tiers(p, stat_id=sid)
        rules.append({
            "platform": PLATFORM, "league_key": lk, "season": season,
            "stat_id": sid, "stat_name": abbr, "stat_display_name": f"{abbr} ({pos})",
            "stat_abbr": abbr, "stat_group": p.get("group"),
            "position_type": pos,
            "applies_to_positions": _j([pos]),
            "modifier": rate,
            # position_scoring=0 would mean CBS is showing overrides it does not
            # apply. Recorded as disabled rather than dropped, so a future
            # season that toggles the setting is visible as data.
            "is_enabled": 1 if position_scoring else 0,
            "is_display_only": 1 if (rate is None and not ptiers) else 0,
            "sort_order": order,
            "raw_stat_json": _j(p),
        })
        bonuses += _bonus_rows(p.get("bonuses"), stat_id=sid, stat_name=abbr,
                               positions=[pos], league_key_=lk, season=season)
        bonuses += _tier_rows(ptiers, stat_id=sid, stat_name=abbr, positions=[pos],
                              league_key_=lk, season=season)

    return {"fantasy_scoring_rules": rules, "fantasy_scoring_bonuses": bonuses}


# ── roster slots ─────────────────────────────────────────────────────────────

def parse_roster_positions(rules: dict, *, season: int, league_id: str) -> list[dict]:
    """`league/rules` → fantasy_roster_positions.

    CBS splits the roster into two lists that must BOTH be read:
      `positions` — the active lineup slots (QB, RB, ..., RB-WR-TE)
      `statuses`  — capacity buckets (Active / Reserve / Injured / Practice)
    The bench exists only in the second list, as 'Reserve Players'. Reading
    `positions` alone yields a nine-man roster for an eighteen-man league, and
    every bench-points or optimal-lineup calculation downstream would be built
    on half a roster.
    """
    r = _require(rules, "rules", "league/rules")
    roster = r.get("roster") or {}
    positions = roster.get("positions")
    statuses = roster.get("statuses") or []
    if not isinstance(positions, list) or not positions:
        raise CbsPayloadError(
            "league/rules: roster.positions is empty. A league with no lineup "
            "slots is not a readable league.")
    lk = league_key(season, league_id)
    out: list[dict] = []

    for order, p in enumerate(positions):
        abbr = p.get("abbr")
        if not abbr:
            raise CbsPayloadError(f"league/rules: roster position with no abbr: {p!r}")
        # A flex slot is spelled as its eligible positions joined by '-'
        # ('RB-WR-TE'). Derived from the label CBS gave rather than matched
        # against a hardcoded list of known flex names.
        parts = [x.strip() for x in abbr.split("-") if x.strip()]
        is_flex = len(parts) > 1
        out.append({
            "platform": PLATFORM, "league_key": lk, "season": season,
            "position": abbr,                      # verbatim, including 'RB-WR-TE'
            "position_type": None,
            "slot_count": _int(p.get("max_active")) or 0,
            "is_starting_slot": 1,
            "is_bench_slot": 0,
            "is_injury_slot": 0,
            "is_flex_slot": 1 if is_flex else 0,
            "flex_positions": _j(parts) if is_flex else None,
            "sort_order": order,
            "raw_position_json": _j(p),
        })

    for order, s in enumerate(statuses, start=100):
        desc = (s.get("description") or "").strip()
        low = desc.lower()
        # 'Active Players' and 'Total Players' are totals over the slots above,
        # not slots themselves; emitting them would double-count the roster.
        if not desc or low.startswith(("active", "total")):
            continue
        cap = _int(s.get("max"))
        if cap is None:
            raise CbsPayloadError(
                f"league/rules: roster status {desc!r} has no max. An unstated "
                f"capacity is not a capacity of zero.")
        out.append({
            "platform": PLATFORM, "league_key": lk, "season": season,
            "position": desc,                      # CBS's own label, verbatim
            "position_type": None,
            "slot_count": cap,                     # 0 is REAL: this league has no IR
            "is_starting_slot": 0,
            "is_bench_slot": 1 if low.startswith("reserve") else 0,
            "is_injury_slot": 1 if low.startswith("injured") else 0,
            "is_flex_slot": 0,
            "flex_positions": None,
            "sort_order": order,
            "raw_position_json": _j(s),
        })
    return out


# ── teams, managers, divisions ───────────────────────────────────────────────

def parse_teams(teams_body: dict, *, season: int, league_id: str,
                my_team_id: str | None = None,
                expected_num_teams: int | None = None) -> dict[str, list[dict]]:
    """`league/teams` → fantasy_teams + fantasy_managers + fantasy_team_managers.

    ⚠️ THE COUNT IS ASSERTED, NOT TRUSTED. Two CBS collection endpoints already
    default to a one-row slice at HTTP 200 with no marker (see
    ROSTERS_ALL_TEAMS / SCHEDULES_ALL_PERIODS). Comparing against the league's
    own num_teams is the only thing standing between a narrowed response and a
    league that appears to have one team.
    """
    ts = _require(teams_body, "teams", "league/teams")
    if not isinstance(ts, list) or not ts:
        raise CbsPayloadError("league/teams: no teams. A league has teams by definition.")
    if expected_num_teams is not None and len(ts) != expected_num_teams:
        raise CbsPayloadError(
            f"league/teams returned {len(ts)} teams but league/details says the "
            f"league has {expected_num_teams}. CBS narrows collections silently; "
            f"refusing rather than storing a partial league as a whole one.")

    lk = league_key(season, league_id)
    teams, managers, links = [], [], []
    for t in ts:
        tid = str(t.get("id") or "").strip()
        if not tid:
            raise CbsPayloadError(f"league/teams: team with no id: {t!r}")
        tk = team_key_from_id(season, league_id, tid)
        teams.append({
            "platform": PLATFORM, "team_key": tk, "league_key": lk, "season": season,
            "team_id": tid,
            "team_name": t.get("name"),
            "team_url": f"{league_host(league_id)}/teams/{tid}",
            "logo_url": t.get("logo"),
            "division_id": t.get("division"),      # CBS exposes only the NAME
            "is_owned_by_current_login": 1 if my_team_id and tid == str(my_team_id) else 0,
            "name_history": _j([t["name"]]) if t.get("name") else None,
            "raw_team_json": _j(t),
            "unmapped_fields": _j(["abbr", "short_name", "long_abbr", "is_vacant"]),
        })
        for o in t.get("owners") or []:
            uid = str(o.get("id") or "").strip()
            if not uid:
                # A team with an unidentifiable owner is a real state (vacant
                # franchises exist) but must not become a manager row keyed on
                # a display name — that is exactly what manager_uid forbids.
                continue
            managers.append({
                "platform": PLATFORM, "manager_uid": uid,
                "display_name": o.get("name"),
                "name_history": _j([o["name"]]) if o.get("name") else None,
                "image_url": None,
                "first_season": season, "last_season": season,
                "raw_manager_json": _j(o),
            })
            links.append({
                "platform": PLATFORM, "team_key": tk, "manager_uid": uid,
                "league_key": lk, "season": season,
                "nickname_at_time": o.get("name"),
                "is_commissioner": _int(o.get("commissioner")) or 0,
                "is_comanager": 1 if len(t.get("owners") or []) > 1 else 0,
            })
    return {"fantasy_teams": teams, "fantasy_managers": managers,
            "fantasy_team_managers": links}


def parse_divisions(teams_body: dict, *, season: int, league_id: str) -> list[dict]:
    """Divisions, derived from the teams' own division labels.

    CBS has no divisions endpoint and exposes no division id — only a name per
    team. The name therefore serves as division_id, which is recorded here
    rather than hidden, because a renamed division would read as a new one.
    """
    ts = _require(teams_body, "teams", "league/teams")
    lk = league_key(season, league_id)
    names = sorted({(t.get("division") or "").strip() for t in ts} - {""})
    return [{
        "platform": PLATFORM, "league_key": lk, "season": season,
        "division_id": n, "division_name": n,
        "raw_division_json": _j({"derived_from": "league/teams[].division",
                                 "note": "CBS exposes no division id"}),
    } for n in names]


# ── schedule ─────────────────────────────────────────────────────────────────

def parse_schedule_periods(schedule_body: dict, *, season: int, league_id: str,
                           playoff_start_week: int | None = None,
                           end_week: int | None = None,
                           expected_periods: int | None = None) -> list[dict]:
    """`league/schedules?period=all` → fantasy_schedule_periods."""
    sched = _require(schedule_body, "schedule", "league/schedules")
    periods = sched.get("periods")
    if not isinstance(periods, list) or not periods:
        raise CbsPayloadError("league/schedules: no periods returned.")
    if expected_periods is not None and len(periods) != expected_periods:
        raise CbsPayloadError(
            f"league/schedules returned {len(periods)} periods but the league has "
            f"{expected_periods} scoring periods. Without period=all CBS returns "
            f"exactly one; refusing to store a one-week season.")
    lk = league_key(season, league_id)
    weeks = [_int(p.get("id")) for p in periods]
    last_week = max(w for w in weeks if w is not None)

    out = []
    for p in periods:
        wk = _int(p.get("id"))
        if wk is None:
            raise CbsPayloadError(f"league/schedules: period with no id: {p!r}")
        is_po = 1 if (playoff_start_week and wk >= playoff_start_week) else 0
        out.append({
            "platform": PLATFORM, "league_key": lk, "season": season, "week": wk,
            "week_start": _mdy(p.get("start")),
            "week_end": None,                      # CBS states a start only
            "is_playoff": is_po,
            # CBS labels no period as consolation — consolation is a property of
            # individual matchups within the playoff weeks. 0 here means 'this
            # week is not wholly consolation', which is the true claim.
            "is_consolation": 0,
            "is_championship": 1 if (is_po and wk == last_week) else 0,
            "status": None,
        })
    return out


def _mdy(v: Any) -> str | None:
    """'9/9/26' -> '2026-09-09'. Returns None rather than guessing a century
    for anything that is not exactly m/d/yy or m/d/yyyy."""
    s = str(v or "").strip()
    parts = s.split("/")
    if len(parts) != 3 or not all(p.isdigit() for p in parts):
        return None
    m, d, y = (int(p) for p in parts)
    if len(parts[2]) == 2:
        y += 2000
    elif len(parts[2]) != 4:
        return None
    if not (1 <= m <= 12 and 1 <= d <= 31):
        return None
    return f"{y:04d}-{m:02d}-{d:02d}"


# ── weekly ───────────────────────────────────────────────────────────────────

def parse_scoreboard(live: dict, *, season: int, league_id: str, week: int,
                     expected_teams: int | None = None) -> dict[str, list[dict]]:
    """`league/scoring/live?period=N` → fantasy_matchups + fantasy_team_week_scores.

    ⚠️ EVERY TEAM APPEARS TWICE — once as itself and once as somebody's
    opponent. Emitting a matchup row per team would double every game in the
    league. Matchups are de-duplicated on the unordered team pair, and the
    count is asserted against teams/2.

    ⚠️ ZERO IS A REAL SCORE, AND SO IS AN UNPLAYED WEEK. Pre-season CBS returns
    all twelve teams with pts=0, which is structurally identical to a week
    everybody was shut out. `matchup_status` is what separates them, and it is
    carried through so the caller can tell "nobody has played" from "nobody
    scored" rather than inferring it from the zeros.
    """
    ls = _require(live, "live_scoring", "league/scoring/live")
    teams = ls.get("teams")
    if not isinstance(teams, list) or not teams:
        raise CbsPayloadError("league/scoring/live: no teams.")
    if expected_teams is not None and len(teams) != expected_teams:
        raise CbsPayloadError(
            f"league/scoring/live returned {len(teams)} teams, expected "
            f"{expected_teams}. CBS narrows collections silently.")
    lk = league_key(season, league_id)
    status = ls.get("matchup_status")

    scores, seen_pairs, matchups = [], set(), []
    for t in teams:
        tid = str(t.get("id") or "").strip()
        if not tid:
            raise CbsPayloadError(f"league/scoring/live: team with no id: {t!r}")
        scores.append({
            "platform": PLATFORM, "league_key": lk, "season": season,
            "week": week, "team_key": team_key_from_id(season, league_id, tid),
            "points_provider": _float(t.get("pts")),
            "points_bench": _float(t.get("reserve_pts")),
            # CBS states neither an optimal lineup nor an efficiency figure.
            # NULL, not a computed guess — the optimal lineup depends on slot
            # eligibility this payload does not carry.
            "points_optimal": None,
            "lineup_efficiency": None,
            "projected_points": _float(t.get("p")),
            "scores_reconciled": None,
            "reconcile_delta": None,
            "is_derived": 0,
        })
        for m in t.get("matchups") or []:
            opp = str(m.get("opponent_team_id") or "").strip()
            if not opp:
                continue
            pair = tuple(sorted((tid, opp)))
            if pair in seen_pairs:
                continue
            seen_pairs.add(pair)
            ids = m.get("team_ids") or {}
            home = str(ids.get("home") or tid)
            away = str(ids.get("away") or opp)
            hp = _float(m.get("pts") if home == tid else m.get("opponent_pts"))
            ap = _float(m.get("pts") if away == tid else m.get("opponent_pts"))
            matchups.append({
                "platform": PLATFORM, "league_key": lk, "season": season,
                "week": week,
                # ⚠️ COLUMN NAMES COME FROM THE MIGRATION, NOT FROM THE PROVIDER.
                # The table is team_a/team_b, deliberately NOT home/away: CBS
                # states a home_away flag but many leagues have no such concept,
                # so the neutral pair is the schema's contract. Writing
                # home_team_key here produced eight phantom columns on the first
                # attempt — the schema audit is what caught it.
                "matchup_key": f"{lk}.w{week}.m{m.get('id') or pair[0] + 'v' + pair[1]}",
                "team_a_key": team_key_from_id(season, league_id, home),
                "team_b_key": team_key_from_id(season, league_id, away),
                "team_a_points": hp, "team_b_points": ap,
                "team_a_projected": None, "team_b_projected": None,
                "is_playoffs": 1 if str(m.get("type", "")).lower() != "regular" else 0,
                "is_consolation": _int(m.get("thirdplace")) or 0,
                "is_division_matchup": None,   # CBS does not state it per matchup
                "winner_team_key": None if (hp is None or ap is None or hp == ap)
                else team_key_from_id(season, league_id, home if hp > ap else away),
                "is_tied": 1 if (hp is not None and ap is not None and hp == ap) else 0,
                "status": status,
                "raw_matchup_json": _j(m),
                "unmapped_fields": _j(["home_away", "opponent_team_logo",
                                       "championship"]),
            })
    if len(matchups) * 2 != len(teams):
        raise CbsPayloadError(
            f"{len(matchups)} matchups from {len(teams)} teams — every team must "
            f"appear in exactly one game. A bye or a duplicated pair would make "
            f"the week's records wrong.")
    return {"fantasy_team_week_scores": scores, "fantasy_matchups": matchups}


# ── draft ────────────────────────────────────────────────────────────────────

def parse_draft_order(order_body: dict, *, season: int, league_id: str
                      ) -> dict[str, Any]:
    """`league/draft/order` → per-team draft slots + the pick map.

    This is the ORDER, not the results: it exists before a pick is made, which
    is precisely what makes it useful pre-draft. Returns
    fantasy_team_season_state rows carrying draft_position, plus a
    pick_number -> team_id map the caller can use to plan.
    """
    do = _require(order_body, "draft_order", "league/draft/order")
    picks = do.get("picks")
    if not isinstance(picks, list) or not picks:
        raise CbsPayloadError("league/draft/order: no picks.")
    lk = league_key(season, league_id)

    slot_by_team: dict[str, int] = {}
    picks_by_team: dict[str, list[int]] = {}
    pick_map: dict[int, str] = {}
    for p in picks:
        num = _int(p.get("number"))
        tid = str((p.get("team") or {}).get("id") or "").strip()
        rnd = _int(p.get("round"))
        if num is None or not tid or rnd is None:
            raise CbsPayloadError(f"league/draft/order: unusable pick {p!r}")
        pick_map[num] = tid
        picks_by_team.setdefault(tid, []).append(num)
        if rnd == 1:
            slot_by_team[tid] = num

    if not slot_by_team:
        raise CbsPayloadError(
            "league/draft/order: no round-1 picks, so no team has a draft slot. "
            "Refusing to infer slots from pick ordering.")

    states = [{
        "platform": PLATFORM,
        "team_key": team_key_from_id(season, league_id, tid),
        "league_key": lk, "season": season,
        "waiver_priority": None,
        "faab_balance": None,                      # NULL = not exposed, not zero
        "number_of_moves": None, "number_of_trades": None,
        "roster_adds_week": None, "roster_adds_value": None,
        "draft_position": slot,
        "draft_grade": None, "has_draft_grade": None, "draft_recap_url": None,
        "clinched_playoffs": None,
    } for tid, slot in sorted(slot_by_team.items(), key=lambda kv: kv[1])]

    return {"fantasy_team_season_state": states, "pick_map": pick_map,
            "picks_by_team": picks_by_team, "num_picks": len(picks)}


def draft_has_started(results_body: dict) -> bool:
    """Whether `league/draft/results` describes a draft that actually happened.

    ⚠️ THE OBVIOUS TEST IS WRONG. An un-started CBS draft returns a FULL board —
    216 of 216 picks, each with a populated `player` object — so
    `if pick.get('player')` passes for every slot and a parser would happily
    store a complete draft of nobody. The player id is the literal string
    'UpcomingPick' on every unplayed slot; that sentinel is the only signal.
    """
    dr = _require(results_body, "draft_results", "league/draft/results")
    picks = dr.get("picks") or []
    real = sum(1 for p in picks
               if str((p.get("player") or {}).get("id") or "") not in ("", UPCOMING_PICK_SENTINEL))
    return real > 0
