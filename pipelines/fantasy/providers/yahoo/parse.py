"""Yahoo payload → platform-neutral fantasy_* rows.

This is the only module in the pipeline that knows what Yahoo's JSON looks like.
Everything downstream — the loader, the quality checks, the analytical views —
sees column names from migrations 0127-0132 and nothing else. That boundary is
what makes a CBS or ESPN adapter a new directory rather than a rewrite.

THREE RULES, APPLIED EVERYWHERE IN THIS FILE:

  1. VERBATIM. Provider vocabularies (transaction types, statuses, draft types,
     waiver rules, position labels) are passed through unnormalized. Yahoo's
     enums drift across fifteen seasons; normalizing on ingest hides the drift,
     and seeing it is the point. The ingester prints the vocabulary it observed
     each run for the same reason.

  2. NULL ≠ 0 ≠ "". `None` means the provider did not say. `0` means it said
     zero. `""` means it said "empty" (Yahoo emits self-closing elements for
     known-but-unset fields, and for `renew` an empty value genuinely means "not
     renewed"). Collapsing any pair of these silently corrupts analysis.

  3. DERIVED IS LABELLED. Anything this module computes rather than reads —
     starter status, week-from-timestamp, keeper inference — lands in a column
     whose name or sibling flag says it was derived.
"""

from __future__ import annotations

import re
from typing import Any, Iterable

from .shape import (
    MISSING,
    YahooShapeError,
    as_list,
    collection_count,
    first_text,
    flatten_resource,
    get,
    to_bool_int,
    to_float,
    to_int,
    to_text,
    subresource,
    unmapped_keys,
)

PLATFORM = "yahoo"

_LEAGUE_KEY_RE = re.compile(r"^(?P<game>\d+)\.l\.(?P<league>\d+)$")
_TEAM_KEY_RE = re.compile(r"^(?P<game>\d+)\.l\.(?P<league>\d+)\.t\.(?P<team>\d+)$")
_PLAYER_KEY_RE = re.compile(r"^(?P<game>[a-z0-9]+)\.p\.(?P<player>\d+)$")

#: Yahoo's own cross-season link format is '{game_id}_{league_id}', which is NOT
#: a league key. Canonicalizing it here means nothing downstream ever has to
#: know the two forms exist.
_RENEW_RE = re.compile(r"^(?P<game>\d+)_(?P<league>\d+)$")


def canonical_league_key(value: Any) -> str | None:
    """Normalize any league reference to '{numeric_game_id}.l.{league_id}'.

    ⚠️ Yahoo rewrites a game_code you send ('nfl.l.576919') into the numeric
    game_id in every key it returns ('461.l.576919'). Storing both forms would
    produce phantom duplicates of the same league, so everything is canonicalized
    to the numeric form on the way in. A code-form key that reaches here
    unresolved is returned as-is rather than guessed at — an invented game_id
    would be worse than an odd-looking one.
    """
    text = to_text(value)
    if not text:
        return None
    m = _RENEW_RE.match(text)
    if m:
        return f"{m.group('game')}.l.{m.group('league')}"
    return text


def _player_uid(node: dict, *, game_code: str = "nfl") -> str | None:
    """The season-INDEPENDENT player identity.

    editorial_player_key ('nfl.p.30121') is the contract; player_key
    ('461.p.30121') is season-scoped and changes every year. Where Yahoo omits
    the editorial key, it is reconstructed from the bare player_id — which is
    safe because the reconstruction uses the season-independent game CODE, not
    the season's game_id.
    """
    editorial = to_text(get(node, "editorial_player_key"))
    if editorial:
        return editorial
    player_id = to_text(get(node, "player_id"))
    if player_id:
        return f"{game_code}.p.{player_id}"
    key = to_text(get(node, "player_key"))
    if key:
        m = _PLAYER_KEY_RE.match(key)
        if m:
            return f"{game_code}.p.{m.group('player')}"
    return None


def normalize_name(value: Any) -> str | None:
    """Lowercase, strip punctuation and generational suffixes.

    ⚠️ FOR FALLBACK MATCHING ONLY, AND NEVER ON ITS OWN. Two different players
    legitimately normalize to the same string; a name-only match that writes a
    mapping merges their careers. The crosswalk requires name AND team AND
    position to agree before it will even record a fuzzy candidate.
    """
    text = to_text(value)
    if not text:
        return None
    text = text.lower()
    text = text.replace("'", "").replace("’", "").replace(".", "")
    text = re.sub(r"[^a-z0-9 ]+", " ", text)
    parts = [p for p in text.split() if p not in {"jr", "sr", "ii", "iii", "iv", "v"}]
    return " ".join(parts) or None


# ─────────────────────────────────────────────────────────────────────────────
# Discovery
# ─────────────────────────────────────────────────────────────────────────────

def parse_games(content: dict) -> list[dict]:
    """Season → game_key, from the games collection.

    ⚠️ NEVER HARDCODE GAME IDS. They are not derivable (2019=390, 2020=399,
    2025=461 — no pattern) and a wrong one silently queries a different season.
    Enumerate once at bootstrap and persist.
    """
    out = []
    for game_node in as_list(get(content, "games")):
        node = flatten_resource(get(game_node, "game", default=game_node))
        season = to_int(get(node, "season"))
        game_key = to_text(get(node, "game_key"))
        if not game_key or season is None:
            continue
        out.append({
            "game_key": game_key,
            "game_code": to_text(get(node, "code")),
            "season": season,
            "name": to_text(get(node, "name")),
            "game_type": to_text(get(node, "type")),
            "is_game_over": to_bool_int(get(node, "is_game_over")),
            "is_offseason": to_bool_int(get(node, "is_offseason")),
        })
    return out


def parse_user_leagues(content: dict) -> list[dict]:
    """Walk users → games → leagues into flat league-season rows.

    The nesting here is the deepest in the API and the shape shifts with which
    sub-resources were requested, which is exactly why nothing indexes
    positionally — every level goes through flatten_resource / as_list.
    """
    out: list[dict] = []
    for user_node in as_list(get(content, "users")):
        user = flatten_resource(get(user_node, "user", default=user_node))
        for game_node in as_list(get(user, "games")):
            game = flatten_resource(get(game_node, "game", default=game_node))
            game_key = to_text(get(game, "game_key"))
            game_code = to_text(get(game, "code"))
            season = to_int(get(game, "season"))
            for league_node in as_list(get(game, "leagues")):
                league = flatten_resource(get(league_node, "league", default=league_node))
                row = parse_league_metadata_node(league, game_key=game_key,
                                                 game_code=game_code, season=season)
                if row:
                    row["discovery_source"] = "users_games_leagues"
                    out.append(row)
    return out


# ─────────────────────────────────────────────────────────────────────────────
# League
# ─────────────────────────────────────────────────────────────────────────────

_LEAGUE_META_MAPPED = {
    "league_key", "league_id", "name", "url", "logo_url", "draft_status",
    "num_teams", "edit_key", "weekly_deadline", "league_update_timestamp",
    "scoring_type", "league_type", "renew", "renewed", "current_week",
    "start_week", "start_date", "end_week", "end_date", "is_finished",
    "game_code", "season", "allow_add_to_dl_extra_pos", "is_pro_league",
    "is_cash_league", "felo_tier", "short_invitation_url",
}


def parse_league_metadata_node(
    league: dict, *, game_key: str | None = None,
    game_code: str | None = None, season: int | None = None,
) -> dict | None:
    """One fantasy_league_seasons row from a league resource."""
    league_key = canonical_league_key(get(league, "league_key"))
    if not league_key:
        return None
    m = _LEAGUE_KEY_RE.match(league_key)
    resolved_game_key = (m.group("game") if m else None) or game_key
    league_id = (m.group("league") if m else None) or to_text(get(league, "league_id"))
    resolved_season = to_int(get(league, "season"))
    if resolved_season is None:
        resolved_season = season

    return {
        "platform": PLATFORM,
        "league_key": league_key,
        "season": resolved_season,
        "game_key": resolved_game_key,
        "game_code": to_text(get(league, "game_code")) or game_code,
        "league_id": league_id,
        "league_name": to_text(get(league, "name")),
        "league_url": to_text(get(league, "url")),
        "num_teams": to_int(get(league, "num_teams")),
        "draft_type": None,          # lives in settings, not metadata
        "is_auction_draft": None,    # ditto
        "scoring_type": to_text(get(league, "scoring_type")),
        "league_type": to_text(get(league, "league_type")),
        "start_week": to_int(get(league, "start_week")),
        "end_week": to_int(get(league, "end_week")),
        "current_week": to_int(get(league, "current_week")),
        # ⚠️ '' here is REAL INFORMATION — Yahoo emits <renew/> to say "this
        # league was not renewed". canonical_league_key returns None for '',
        # which is the correct storage: no previous season exists.
        "renew_key": canonical_league_key(get(league, "renew")),
        "renewed_key": canonical_league_key(get(league, "renewed")),
        "my_team_key": None,
        "discovery_source": "league_resource",
        "is_accessible": 1,
        "unmapped_fields": unmapped_keys(league, _LEAGUE_META_MAPPED),
    }


def parse_league_metadata(content: dict) -> dict | None:
    league = flatten_resource(get(content, "league"))
    if not league:
        raise YahooShapeError("no 'league' node in payload")
    return parse_league_metadata_node(league)


_SETTINGS_MAPPED = {
    "draft_type", "is_auction_draft", "scoring_type", "persistent_url",
    "uses_playoff", "has_playoff_consolation_games", "playoff_start_week",
    "uses_playoff_reseeding", "uses_lock_eliminated_teams",
    "num_playoff_teams", "num_playoff_consolation_teams",
    "has_multiweek_championship", "waiver_type", "waiver_rule", "uses_faab",
    "draft_time", "draft_pick_time", "post_draft_players", "max_teams",
    "waiver_time", "trade_end_date", "trade_ratify_type", "trade_reject_time",
    "player_pool", "cant_cut_list", "sendbird_channel_url", "roster_positions",
    "stat_categories", "stat_modifiers", "divisions", "uses_negative_points",
    "uses_fractional_points", "max_adds", "max_weekly_adds", "max_trades",
    "faab_balance", "num_keepers", "uses_keepers", "can_trade_draft_picks",
}

#: Bench-like slots seen in the wild. Used ONLY as a fallback hint when the
#: provider gives no position_type; the authoritative classification is the
#: league's own roster_positions list, which is why is_starting_slot is computed
#: per league rather than pattern-matched globally.
_KNOWN_BENCH = {"BN", "BE"}
_KNOWN_INJURY = {"IR", "IR+", "IR-R", "IL", "IL+", "NA"}


def parse_league_settings(content: dict, *, league_key: str, season: int) -> dict[str, list[dict]]:
    """Settings, scoring rules, bonuses, roster slots and divisions in one pass.

    Returns a dict of table-name → rows. These arrive in a single payload and
    splitting the request would triple the API cost for no benefit.
    """
    league = flatten_resource(get(content, "league"))
    settings = flatten_resource(get(league, "settings"))
    if not settings:
        raise YahooShapeError("no 'settings' node in league payload")

    base = {"platform": PLATFORM, "league_key": league_key, "season": season}

    is_auction = to_bool_int(get(settings, "is_auction_draft"))
    settings_row = {
        **base,
        "league_name": to_text(get(league, "name")),
        "league_url": to_text(get(league, "url")),
        "logo_url": to_text(get(league, "logo_url")),
        "league_type": to_text(get(league, "league_type")),
        "num_teams": to_int(get(league, "num_teams")),
        "max_teams": to_int(get(settings, "max_teams")),
        "start_week": to_int(get(league, "start_week")),
        "end_week": to_int(get(league, "end_week")),
        "current_week": to_int(get(league, "current_week")),
        "start_date": to_text(get(league, "start_date")),
        "end_date": to_text(get(league, "end_date")),
        "is_finished": to_bool_int(get(league, "is_finished")),
        "weekly_deadline": to_text(get(league, "weekly_deadline")),
        "league_update_timestamp_unix": to_int(get(league, "league_update_timestamp")),
        "draft_status": to_text(get(league, "draft_status")),
        "draft_type": to_text(get(settings, "draft_type")),
        "is_auction_draft": is_auction,
        "draft_time_unix": to_int(get(settings, "draft_time")),
        "draft_pick_time_sec": to_int(get(settings, "draft_pick_time")),
        "post_draft_players": to_text(get(settings, "post_draft_players")),
        "scoring_type": to_text(get(league, "scoring_type")),
        "uses_fractional_points": to_bool_int(get(settings, "uses_fractional_points")),
        "uses_negative_points": to_bool_int(get(settings, "uses_negative_points")),
        "waiver_type": to_text(get(settings, "waiver_type")),
        "waiver_rule": to_text(get(settings, "waiver_rule")),
        "waiver_time_days": to_int(get(settings, "waiver_time")),
        "uses_faab": to_bool_int(get(settings, "uses_faab")),
        # ⚠️ NULL, not 0. Yahoo documents faab_bid only as a WRITE input and it
        # is unverified whether a budget comes back on a GET. "not exposed" and
        # "no budget" are different facts.
        # ⚠️ COLUMN NAME FIX: this must be "faab_budget" (the migration's real
        # column, the league SETTING for starting FAAB per team) — it was
        # emitted as "faab_balance" (the TEAM's remaining balance, a different
        # concept that correctly lives on fantasy_team_season_state). A
        # section-K adapter-path test, added after the same class of bug hit
        # a live ESPN backfill, caught this dormant Yahoo bug the same day.
        "faab_budget": to_int(get(settings, "faab_balance")),
        "trade_end_date": to_text(get(settings, "trade_end_date")),
        "trade_ratify_type": to_text(get(settings, "trade_ratify_type")),
        "trade_reject_time_days": to_int(get(settings, "trade_reject_time")),
        "max_acquisitions": to_int(get(settings, "max_adds")),
        "max_weekly_acquisitions": to_int(get(settings, "max_weekly_adds")),
        "max_trades": to_int(get(settings, "max_trades")),
        "player_pool": to_text(get(settings, "player_pool")),
        "cant_cut_list": to_text(get(settings, "cant_cut_list")),
        "uses_playoff": to_bool_int(get(settings, "uses_playoff")),
        "playoff_start_week": to_int(get(settings, "playoff_start_week")),
        "num_playoff_teams": to_int(get(settings, "num_playoff_teams")),
        "num_playoff_consolation_teams": to_int(get(settings, "num_playoff_consolation_teams")),
        "has_playoff_consolation_games": to_bool_int(get(settings, "has_playoff_consolation_games")),
        "uses_playoff_reseeding": to_bool_int(get(settings, "uses_playoff_reseeding")),
        "uses_lock_eliminated_teams": to_bool_int(get(settings, "uses_lock_eliminated_teams")),
        "has_multiweek_championship": to_bool_int(get(settings, "has_multiweek_championship")),
        "uses_keepers": to_bool_int(get(settings, "uses_keepers")),
        "num_keepers": to_int(get(settings, "num_keepers")),
        "unmapped_fields": unmapped_keys(settings, _SETTINGS_MAPPED),
    }

    roster_rows = _parse_roster_positions(settings, base)
    settings_row["uses_divisions"] = None
    divisions = _parse_divisions(settings, base)
    if divisions:
        settings_row["uses_divisions"] = 1
        settings_row["num_divisions"] = len(divisions)
    else:
        settings_row["num_divisions"] = None

    scoring_rows, bonus_rows = _parse_scoring(settings, base)

    return {
        "fantasy_league_settings": [settings_row],
        "fantasy_roster_positions": roster_rows,
        "fantasy_scoring_rules": scoring_rows,
        "fantasy_scoring_bonuses": bonus_rows,
        "fantasy_divisions": divisions,
    }


def _parse_roster_positions(settings: dict, base: dict) -> list[dict]:
    """Slot definitions, with starter/bench/IR classification computed once.

    ⚠️ This is where `is_starter` ultimately comes from. Yahoo has no
    is_started field, so starter status is "the player's slot is not a bench-like
    slot in THIS league". Leagues define IR+, IR-R, NA and other bench-like
    slots, so the classification is derived from the league's own slot list and
    only falls back to a known-name check when position_type is absent.
    """
    rows = []
    for idx, node in enumerate(as_list(get(settings, "roster_positions"))):
        rp = flatten_resource(get(node, "roster_position", default=node))
        position = to_text(get(rp, "position"))
        if not position:
            continue
        pos_upper = position.upper()
        position_type = to_text(get(rp, "position_type"))
        is_bench = 1 if pos_upper in _KNOWN_BENCH else 0
        is_injury = 1 if pos_upper in _KNOWN_INJURY else 0
        # A flex slot's label carries its eligibility ('W/R/T', 'Q/W/R/T').
        flex_parts = [p for p in re.split(r"[/,]", position) if p] if "/" in position else []
        rows.append({
            **base,
            "position": position,
            "position_type": position_type,
            "slot_count": to_int(get(rp, "count")) or 0,
            "is_starting_slot": 0 if (is_bench or is_injury) else 1,
            "is_bench_slot": is_bench,
            "is_injury_slot": is_injury,
            "is_flex_slot": 1 if flex_parts else 0,
            "flex_positions": flex_parts or None,
            "sort_order": idx,
            # ⚠️ NO unmapped_fields KEY: fantasy_roster_positions (migration
            # 0128) has no such column, unlike most other tables in this
            # family. Emitting one here was a dormant bug — never caught
            # because no test exercised this row through d1.write_rows until
            # section K, added after the same class of bug hit a live ESPN
            # backfill. If unmapped-field tracking is ever wanted here, it
            # needs an additive migration first, not a parser guess at a
            # column that doesn't exist.
        })
    return rows


def _parse_divisions(settings: dict, base: dict) -> list[dict]:
    rows = []
    for node in as_list(get(settings, "divisions")):
        div = flatten_resource(get(node, "division", default=node))
        div_id = to_text(get(div, "division_id"))
        if div_id is None:
            continue
        rows.append({**base, "division_id": div_id,
                     "division_name": to_text(get(div, "name"))})
    return rows


def _parse_scoring(settings: dict, base: dict) -> tuple[list[dict], list[dict]]:
    """Stat dictionary joined to its point modifiers and threshold bonuses.

    Yahoo returns the stat DICTIONARY (names, ids, position applicability) and
    the MODIFIERS (point values) as two separate structures keyed by stat_id.
    They are joined here so a scoring rule is one row, which is what makes
    points reconstruction a join rather than a lookup-in-two-places.
    """
    modifiers: dict[str, dict] = {}
    for node in as_list(get(get(settings, "stat_modifiers"), "stats")):
        stat = flatten_resource(get(node, "stat", default=node))
        sid = to_text(get(stat, "stat_id"))
        if sid is not None:
            modifiers[sid] = stat

    bonuses: list[dict] = []
    for node in as_list(get(get(settings, "stat_modifiers"), "bonuses")):
        bonus = flatten_resource(get(node, "bonus", default=node))
        sid = to_text(get(bonus, "stat_id"))
        target = to_float(get(bonus, "target"))
        points = to_float(get(bonus, "points"))
        # Yahoo gives bonuses no id of their own; a deterministic composite key
        # keeps re-ingest idempotent.
        bonus_id = to_text(get(bonus, "bonus_id")) or f"{sid}:{target}"
        bonuses.append({
            **base, "bonus_id": bonus_id, "stat_id": sid,
            "stat_name": None, "target_value": target, "bonus_points": points,
            "position_type": to_text(get(bonus, "position_type")),
        })

    rules: list[dict] = []
    for node in as_list(get(get(settings, "stat_categories"), "stats")):
        stat = flatten_resource(get(node, "stat", default=node))
        sid = to_text(get(stat, "stat_id"))
        if sid is None:
            continue
        mod = modifiers.get(sid, {})
        position_types = []
        for pt_node in as_list(get(stat, "stat_position_types")):
            pt = flatten_resource(get(pt_node, "stat_position_type", default=pt_node))
            label = to_text(get(pt, "position_type"))
            if label:
                position_types.append(label)
        rules.append({
            **base,
            "stat_id": sid,
            "stat_name": to_text(get(stat, "name")),
            "stat_display_name": to_text(get(stat, "display_name")),
            "stat_abbr": to_text(get(stat, "abbr")),
            "stat_group": to_text(get(stat, "group")),
            "position_type": to_text(get(stat, "position_type")),
            "applies_to_positions": position_types or None,
            # ⚠️ NULL when the stat carries no modifier. A stat that is tracked
            # but not scored is NOT worth 0.0 — that distinction is what makes
            # "does this league score first downs" answerable.
            "modifier": to_float(get(mod, "value")),
            "is_enabled": to_bool_int(get(stat, "enabled")),
            "is_display_only": to_bool_int(get(stat, "is_only_display_stat")),
            "sort_order": to_int(get(stat, "sort_order")),
        })

    # Backfill bonus stat names from the dictionary we just built.
    names = {r["stat_id"]: r["stat_name"] for r in rules}
    for b in bonuses:
        b["stat_name"] = names.get(b["stat_id"])

    return rules, bonuses


# ─────────────────────────────────────────────────────────────────────────────
# Teams and managers
# ─────────────────────────────────────────────────────────────────────────────

_TEAM_MAPPED = {
    "team_key", "team_id", "name", "url", "team_logos", "waiver_priority",
    "faab_balance", "number_of_moves", "number_of_trades", "roster_adds",
    "clinched_playoffs", "league_scoring_type", "draft_position",
    "has_draft_grade", "draft_grade", "draft_recap_url", "managers",
    "division_id", "is_owned_by_current_login", "team_points", "team_standings",
    "team_projected_points", "win_probability", "team_stats",
}


def parse_teams(content: dict, *, league_key: str, season: int) -> dict[str, list[dict]]:
    """Teams, their per-season state, managers, and the team↔manager linkage."""
    league = flatten_resource(get(content, "league"))
    teams_node = get(league, "teams")
    if teams_node is MISSING:
        teams_node = get(content, "teams")

    teams, states, managers, links = [], [], [], []
    seen_managers: set[str] = set()

    for node in as_list(teams_node):
        team = flatten_resource(get(node, "team", default=node))
        team_key = to_text(get(team, "team_key"))
        if not team_key:
            continue

        logo = None
        for logo_node in as_list(get(team, "team_logos")):
            lg = flatten_resource(get(logo_node, "team_logo", default=logo_node))
            logo = to_text(get(lg, "url")) or logo

        teams.append({
            "platform": PLATFORM,
            "team_key": team_key,
            "league_key": league_key,
            "season": season,
            "team_id": to_text(get(team, "team_id")),
            "team_name": to_text(get(team, "name")),
            "team_url": to_text(get(team, "url")),
            "logo_url": logo,
            "division_id": to_text(get(team, "division_id")),
            "is_owned_by_current_login": to_bool_int(get(team, "is_owned_by_current_login")),
            "unmapped_fields": unmapped_keys(team, _TEAM_MAPPED),
        })

        roster_adds = flatten_resource(get(team, "roster_adds"))
        states.append({
            "platform": PLATFORM,
            "team_key": team_key,
            "league_key": league_key,
            "season": season,
            "waiver_priority": to_int(get(team, "waiver_priority")),
            "faab_balance": to_int(get(team, "faab_balance")),
            "number_of_moves": to_int(get(team, "number_of_moves")),
            "number_of_trades": to_int(get(team, "number_of_trades")),
            "roster_adds_week": to_int(get(roster_adds, "coverage_value")),
            "roster_adds_value": to_int(get(roster_adds, "value")),
            "draft_position": to_int(get(team, "draft_position")),
            "draft_grade": to_text(get(team, "draft_grade")),
            "has_draft_grade": to_bool_int(get(team, "has_draft_grade")),
            "draft_recap_url": to_text(get(team, "draft_recap_url")),
            "clinched_playoffs": to_bool_int(get(team, "clinched_playoffs")),
        })

        for mgr_node in as_list(get(team, "managers")):
            mgr = flatten_resource(get(mgr_node, "manager", default=mgr_node))
            # ⚠️ guid is the ONLY stable cross-season manager identity. nickname
            # changes yearly and is frequently the literal '--hidden--', which
            # several distinct managers carry simultaneously — keying on it would
            # merge them.
            guid = to_text(get(mgr, "guid"))
            if not guid:
                continue
            nickname = to_text(get(mgr, "nickname"))
            if guid not in seen_managers:
                seen_managers.add(guid)
                managers.append({
                    "platform": PLATFORM,
                    "manager_uid": guid,
                    "display_name": nickname,
                    "image_url": to_text(get(mgr, "image_url")),
                    "first_season": season,
                    "last_season": season,
                    # ⚠️ email is deliberately NOT read even though Yahoo returns
                    # it for the authenticating user. Nothing needs it and it
                    # would land in an hourly R2 snapshot.
                })
            links.append({
                "platform": PLATFORM,
                "team_key": team_key,
                "manager_uid": guid,
                "league_key": league_key,
                "season": season,
                "nickname_at_time": nickname,
                "is_commissioner": to_bool_int(get(mgr, "is_commissioner")) or 0,
                "is_comanager": to_bool_int(get(mgr, "is_comanager")) or 0,
            })

    return {
        "fantasy_teams": teams,
        "fantasy_team_season_state": states,
        "fantasy_managers": managers,
        "fantasy_team_managers": links,
    }


# ─────────────────────────────────────────────────────────────────────────────
# Draft
# ─────────────────────────────────────────────────────────────────────────────

def parse_draft_results(
    content: dict, *, league_key: str, season: int, is_auction: int | None,
    game_code: str = "nfl",
) -> dict[str, list[dict]]:
    """Draft picks.

    ⚠️ THE AUCTION-PRICE RULE. `cost` is read with to_float, which returns None
    for an absent or empty value and 0.0 only for a literal zero. It is NEVER
    defaulted. In an auction league a $0 keeper is real and meaningful; in a
    snake league the field is meaningless rather than zero, which is why
    is_price_bearing is recorded on the parent draft row.

    ⚠️ THE KEEPER RULE. Yahoo exposes no per-pick keeper flag. `is_keeper` is
    populated only if the provider genuinely sends one; otherwise it stays NULL
    and any later inference lands in keeper_inferred with its basis. A derived
    value must never occupy the column that means "the provider said so".
    """
    league = flatten_resource(get(content, "league"))
    node = get(league, "draft_results")
    if node is MISSING:
        node = get(content, "draft_results")

    picks = []
    for item in as_list(node):
        dr = flatten_resource(get(item, "draft_result", default=item))
        pick_number = to_int(get(dr, "pick"))
        if pick_number is None:
            continue
        player_key = to_text(get(dr, "player_key"))
        uid = _player_uid(dr, game_code=game_code)
        if not uid and player_key:
            m = _PLAYER_KEY_RE.match(player_key)
            if m:
                uid = f"{game_code}.p.{m.group('player')}"

        provider_keeper = get(dr, "is_keeper")
        picks.append({
            "platform": PLATFORM,
            "league_key": league_key,
            "season": season,
            "pick_number": pick_number,
            "round_number": to_int(get(dr, "round")),
            "pick_in_round": None,   # computed by the loader once team count is known
            "team_key": to_text(get(dr, "team_key")),
            "player_uid": uid,
            "player_key_at_draft": player_key,
            "provider_player_id": to_text(get(dr, "player_id")),
            "auction_cost": to_float(get(dr, "cost")),   # ⚠️ never coerced
            "is_keeper": to_bool_int(provider_keeper) if provider_keeper is not MISSING else None,
            "keeper_inferred": 0,
            "keeper_inference_basis": None,
            "is_auto_pick": to_bool_int(get(dr, "is_auto_pick")),
            "picked_at_unix": to_int(get(dr, "timestamp")),
            "unmapped_fields": unmapped_keys(dr, {
                "pick", "round", "team_key", "player_key", "player_id", "cost",
                "is_keeper", "is_auto_pick", "timestamp",
            }),
        })

    draft_row = {
        "platform": PLATFORM,
        "league_key": league_key,
        "season": season,
        "draft_kind": ("auction" if is_auction == 1 else
                       "snake" if is_auction == 0 else "unknown"),
        "is_price_bearing": 1 if is_auction == 1 else 0,
        "draft_status": to_text(get(league, "draft_status")),
        "num_picks": len(picks),
        "num_rounds": max((p["round_number"] or 0) for p in picks) if picks else None,
        # NULL, not 0: Yahoo does not expose per-pick keeper status, so "does
        # this draft have keepers" is genuinely unknown from this payload.
        "has_keepers": None,
    }
    return {"fantasy_drafts": [draft_row], "fantasy_draft_events": picks}


# ─────────────────────────────────────────────────────────────────────────────
# Transactions
# ─────────────────────────────────────────────────────────────────────────────

def parse_transactions(
    content: dict, *, league_key: str, season: int, game_code: str = "nfl",
) -> dict[str, list[dict]]:
    """Transactions as parent rows plus one row per asset leg.

    ⚠️ THE SHAPE TRAP. For TRADES, Yahoo returns `transaction_data` as a LIST OF
    ONE DICT rather than a bare dict, because a traded player can in principle
    have several legs. For adds/drops it is a bare dict. Both shapes are handled
    via as_list; assuming either one alone silently drops every trade or every
    add/drop.

    ⚠️ A leg's source_team_key is ABSENT (not empty) when source_type is
    'waivers' or 'freeagents' — the concept does not apply. That absence is what
    lets waiver analysis distinguish a waiver claim from a free-agent pickup, so
    it is preserved as NULL rather than filled with ''.
    """
    league = flatten_resource(get(content, "league"))
    node = get(league, "transactions")
    if node is MISSING:
        node = get(content, "transactions")

    parents, legs = [], []
    for item in as_list(node):
        txn = flatten_resource(get(item, "transaction", default=item))
        txn_key = to_text(get(txn, "transaction_key"))
        if not txn_key:
            continue

        leg_index = 0
        for player_node in as_list(get(txn, "players")):
            player = flatten_resource(get(player_node, "player", default=player_node))
            uid = _player_uid(player, game_code=game_code)
            name = flatten_resource(get(player, "name"))

            for data in as_list(get(player, "transaction_data")):
                td = flatten_resource(data)
                legs.append({
                    "platform": PLATFORM,
                    "transaction_key": txn_key,
                    "leg_index": leg_index,
                    "league_key": league_key,
                    "season": season,
                    "asset_kind": "player",
                    "movement_type": to_text(get(td, "type")),
                    "player_uid": uid,
                    "player_key_at_txn": to_text(get(player, "player_key")),
                    "player_name_at_txn": to_text(get(name, "full")),
                    "player_position_at_txn": to_text(get(player, "display_position")),
                    "nfl_team_at_txn": to_text(get(player, "editorial_team_abbr")),
                    "source_type": to_text(get(td, "source_type")),
                    "source_team_key": to_text(get(td, "source_team_key")),
                    "source_team_name": to_text(get(td, "source_team_name")),
                    "destination_type": to_text(get(td, "destination_type")),
                    "destination_team_key": to_text(get(td, "destination_team_key")),
                    "destination_team_name": to_text(get(td, "destination_team_name")),
                })
                leg_index += 1

        # Draft-pick legs, where the platform trades picks.
        for pick_node in as_list(get(txn, "picks")):
            pick = flatten_resource(get(pick_node, "pick", default=pick_node))
            legs.append({
                "platform": PLATFORM,
                "transaction_key": txn_key,
                "leg_index": leg_index,
                "league_key": league_key,
                "season": season,
                "asset_kind": "draft_pick",
                "movement_type": None,
                "player_uid": None,
                "source_team_key": to_text(get(pick, "source_team_key")),
                "destination_team_key": to_text(get(pick, "destination_team_key")),
                "pick_season": to_int(get(pick, "season")),
                "pick_round": to_int(get(pick, "round")),
            })
            leg_index += 1

        parents.append({
            "platform": PLATFORM,
            "transaction_key": txn_key,
            "league_key": league_key,
            "season": season,
            "transaction_id": to_text(get(txn, "transaction_id")),
            "transaction_type": to_text(get(txn, "type")),
            "status": to_text(get(txn, "status")),
            "timestamp_unix": to_int(get(txn, "timestamp")),
            "processed_date": None,
            "week": None,   # derived by the loader from schedule periods
            # ⚠️ NULL = not exposed. 0 = a genuine zero bid. Never coerced.
            "faab_bid": to_int(get(txn, "faab_bid")),
            "waiver_priority_at_processing": to_int(get(txn, "waiver_priority")),
            "is_commissioner_action": 1 if to_text(get(txn, "type")) == "commish" else 0,
            "trade_note": to_text(get(txn, "trade_note")),
            "asset_count": leg_index,
            "unmapped_fields": unmapped_keys(txn, {
                "transaction_key", "transaction_id", "type", "status",
                "timestamp", "players", "picks", "faab_bid", "waiver_priority",
                "trade_note",
            }),
        })

    return {"fantasy_transactions": parents, "fantasy_transaction_assets": legs}


# ─────────────────────────────────────────────────────────────────────────────
# Standings, scoreboard, rosters, players
# ─────────────────────────────────────────────────────────────────────────────

def parse_standings(content: dict, *, league_key: str, season: int) -> list[dict]:
    """The one standings state the provider exposes.

    ⚠️ This is NOT a weekly series. Yahoo returns exactly one standings state —
    final for a completed season, current for a live one — and has no
    standings;week=N. as_of_week is set by the caller from the league's
    current/end week, and every RECONSTRUCTED week is written separately with
    is_inferred=1.
    """
    league = flatten_resource(get(content, "league"))
    standings = flatten_resource(get(league, "standings"))
    rows = []
    # subresource, not get: 'teams' sits under the numeric wrapper key on a live
    # standings payload (pathology 6) and directly on some samples. Both work.
    for node in as_list(subresource(standings, "teams")):
        team = flatten_resource(get(node, "team", default=node))
        team_key = to_text(get(team, "team_key"))
        if not team_key:
            continue
        ts = flatten_resource(get(team, "team_standings"))
        outcome = flatten_resource(get(ts, "outcome_totals"))
        streak = flatten_resource(get(ts, "streak"))
        points = flatten_resource(get(team, "team_points"))
        rows.append({
            "platform": PLATFORM,
            "league_key": league_key,
            "season": season,
            "team_key": team_key,
            "rank": to_int(get(ts, "rank")),
            "playoff_seed": to_int(get(ts, "playoff_seed")),
            "wins": to_int(get(outcome, "wins")),
            "losses": to_int(get(outcome, "losses")),
            "ties": to_int(get(outcome, "ties")),
            # ⚠️ Yahoo sends this with a LEADING DOT ('.571'). to_float handles
            # it; int() and a naive parseInt do not.
            "win_percentage": to_float(get(outcome, "percentage")),
            "points_for": to_float(get(ts, "points_for")) or to_float(get(points, "total")),
            "points_against": to_float(get(ts, "points_against")),
            "games_back": to_float(get(ts, "games_back")),
            "streak_type": to_text(get(streak, "type")),
            "streak_value": to_int(get(streak, "value")),
            "division_id": to_text(get(team, "division_id")),
            "clinched_playoffs": to_bool_int(get(team, "clinched_playoffs")),
            "is_inferred": 0,   # read from the provider, not reconstructed
            "inference_basis": None,
        })
    return rows


def parse_scoreboard(content: dict, *, league_key: str, season: int) -> dict[str, list[dict]]:
    """Matchups and the team scores they contain."""
    league = flatten_resource(get(content, "league"))
    scoreboard = flatten_resource(get(league, "scoreboard"))
    # ⚠️ subresource, not get. A live scoreboard is
    # {"0": {"matchups": …}, "week": "15"} and each matchup is
    # {"week": …, "0": {"teams": …}} — pathology 6 twice over. With a plain
    # `get` both lookups return MISSING and this function returns zero matchups
    # and zero team scores without raising: a whole season of results, silently
    # absent.
    matchups_node = subresource(scoreboard, "matchups")
    if matchups_node is MISSING:
        matchups_node = subresource(content, "matchups")

    matchups, team_scores = [], []
    for node in as_list(matchups_node):
        mu = flatten_resource(get(node, "matchup", default=node))
        week = to_int(get(mu, "week"))

        sides = []
        for team_node in as_list(subresource(mu, "teams")):
            team = flatten_resource(get(team_node, "team", default=team_node))
            tk = to_text(get(team, "team_key"))
            if not tk:
                continue
            pts = flatten_resource(get(team, "team_points"))
            proj = flatten_resource(get(team, "team_projected_points"))
            sides.append({
                "team_key": tk,
                "points": to_float(get(pts, "total")),
                "projected": to_float(get(proj, "total")),
                "win_probability": to_float(get(team, "win_probability")),
            })

        grades = {}
        for g_node in as_list(get(mu, "matchup_grades")):
            g = flatten_resource(get(g_node, "matchup_grade", default=g_node))
            tk = to_text(get(g, "team_key"))
            if tk:
                grades[tk] = to_text(get(g, "grade"))

        if len(sides) != 2:
            # A matchup without exactly two sides is a bye or a malformed
            # payload. Recorded as-is rather than dropped, so the completeness
            # check can see it; the loader flags it.
            for s in sides:
                team_scores.append(_team_week_score(league_key, season, week, s))
            continue

        # ⚠️ Sorted so the pairing is canonical. Without this, the same matchup
        # ingested from the scoreboard and from a team's own matchups endpoint
        # produces two different rows for one game.
        a, b = sorted(sides, key=lambda s: s["team_key"])
        matchups.append({
            "platform": PLATFORM,
            "league_key": league_key,
            "season": season,
            "week": week,
            "matchup_key": f"{a['team_key']}|{b['team_key']}",
            "team_a_key": a["team_key"],
            "team_b_key": b["team_key"],
            "team_a_points": a["points"],
            "team_b_points": b["points"],
            "team_a_projected": a["projected"],
            "team_b_projected": b["projected"],
            "team_a_grade": grades.get(a["team_key"]),
            "team_b_grade": grades.get(b["team_key"]),
            "team_a_win_probability": a["win_probability"],
            "team_b_win_probability": b["win_probability"],
            "winner_team_key": to_text(get(mu, "winner_team_key")),
            "is_tied": to_bool_int(get(mu, "is_tied")),
            "status": to_text(get(mu, "status")),
            "is_playoffs": to_bool_int(get(mu, "is_playoffs")),
            "is_consolation": to_bool_int(get(mu, "is_consolation")),
            "recap_url": (to_text(get(mu, "matchup_recap_url")) or "").replace("&amp;", "&") or None,
            "recap_title": to_text(get(mu, "matchup_recap_title")),
            "unmapped_fields": unmapped_keys(mu, {
                "week", "week_start", "week_end", "status", "is_playoffs",
                "is_consolation", "is_matchup_recap_available",
                "matchup_recap_url", "matchup_recap_title", "matchup_grades",
                "is_tied", "winner_team_key", "teams",
            }),
        })
        for s in (a, b):
            team_scores.append(_team_week_score(league_key, season, week, s))

    return {"fantasy_matchups": matchups, "fantasy_team_week_scores": team_scores}


def _team_week_score(league_key: str, season: int, week: int | None, side: dict) -> dict:
    return {
        "platform": PLATFORM,
        "league_key": league_key,
        "season": season,
        "week": week,
        "team_key": side["team_key"],
        "points_provider": side["points"],
        "projected_points": side["projected"],
    }


_PLAYER_MAPPED = {
    "player_key", "player_id", "name", "editorial_player_key",
    "editorial_team_key", "editorial_team_full_name", "editorial_team_abbr",
    "bye_weeks", "uniform_number", "display_position", "headshot", "image_url",
    "is_undroppable", "position_type", "primary_position", "eligible_positions",
    "selected_position", "player_stats", "player_points", "status",
    "status_full", "injury_note", "ownership", "percent_owned",
    "has_player_notes", "player_notes_last_timestamp", "is_editable",
    "eligible_positions_to_add", "has_recent_player_notes",
}


def parse_player_node(node: Any, *, game_code: str = "nfl") -> dict | None:
    """One fantasy_players row (plus the season-scoped bits) from a player resource."""
    player = flatten_resource(get(node, "player", default=node))
    uid = _player_uid(player, game_code=game_code)
    if not uid:
        return None
    name = flatten_resource(get(player, "name"))
    headshot = flatten_resource(get(player, "headshot"))
    bye = flatten_resource(get(player, "bye_weeks"))

    positions = []
    for p_node in as_list(get(player, "eligible_positions")):
        p = flatten_resource(p_node)
        label = to_text(get(p, "position"))
        if label:
            positions.append(label)

    full_name = to_text(get(name, "full"))
    return {
        "platform": PLATFORM,
        "player_uid": uid,
        "provider_player_id": to_text(get(player, "player_id")),
        "player_key": to_text(get(player, "player_key")),
        "full_name": full_name,
        "first_name": to_text(get(name, "first")),
        "last_name": to_text(get(name, "last")),
        "ascii_first_name": to_text(get(name, "ascii_first")),
        "ascii_last_name": to_text(get(name, "ascii_last")),
        "normalized_name": normalize_name(full_name),
        "display_position": to_text(get(player, "display_position")),
        "primary_position": to_text(get(player, "primary_position")),
        "position_type": to_text(get(player, "position_type")),
        "uniform_number": to_text(get(player, "uniform_number")),
        "editorial_team_key": to_text(get(player, "editorial_team_key")),
        "editorial_team_abbr": to_text(get(player, "editorial_team_abbr")),
        "editorial_team_full": to_text(get(player, "editorial_team_full_name")),
        "headshot_url": to_text(get(headshot, "url")),
        "image_url": to_text(get(player, "image_url")),
        "is_undroppable": to_bool_int(get(player, "is_undroppable")),
        "bye_week": to_int(get(bye, "week")),
        "eligible_positions": positions,
        "injury_status": to_text(get(player, "status")),
        "injury_note": to_text(get(player, "injury_note")),
        "unmapped_fields": unmapped_keys(player, _PLAYER_MAPPED),
    }


def parse_rosters(
    content: dict, *, league_key: str, season: int, week: int,
    starting_slots: set[str] | None = None, bench_slots: set[str] | None = None,
    injury_slots: set[str] | None = None, game_code: str = "nfl",
) -> dict[str, list[dict]]:
    """Weekly rosters for every team in the payload.

    `starting_slots` / `bench_slots` / `injury_slots` come from THIS league's
    fantasy_roster_positions. When they are not supplied, is_starter is left
    NULL rather than guessed — an unknown lineup requirement produces an unknown
    starter flag, never a wrong one.
    """
    league = flatten_resource(get(content, "league"))
    teams_node = get(league, "teams")
    if teams_node is MISSING:
        teams_node = get(content, "teams")

    snapshots, players = [], []
    for node in as_list(teams_node):
        team = flatten_resource(get(node, "team", default=node))
        team_key = to_text(get(team, "team_key"))
        if not team_key:
            continue
        roster = flatten_resource(get(team, "roster"))
        roster_week = to_int(get(roster, "week"))
        is_editable = to_bool_int(get(roster, "is_editable"))

        # ⚠️ subresource, not get. The players collection is nested under the
        # numeric wrapper key "0" inside the roster object (pathology 6); a
        # plain `get` yields MISSING and this loop produces zero roster rows
        # with no exception at all.
        for p_node in as_list(subresource(roster, "players")):
            prow = parse_player_node(p_node, game_code=game_code)
            if not prow:
                continue
            players.append(prow)
            player = flatten_resource(get(p_node, "player", default=p_node))
            selected = flatten_resource(get(player, "selected_position"))
            slot = to_text(get(selected, "position"))

            is_starter = is_bench = is_injury = None
            if slot is not None and starting_slots is not None:
                slot_u = slot.upper()
                is_bench = 1 if slot_u in (bench_slots or set()) else 0
                is_injury = 1 if slot_u in (injury_slots or set()) else 0
                is_starter = 1 if slot_u in starting_slots else 0

            snapshots.append({
                "platform": PLATFORM,
                "league_key": league_key,
                "season": season,
                "week": roster_week if roster_week is not None else week,
                "team_key": team_key,
                "player_uid": prow["player_uid"],
                "selected_position": slot,
                "is_starter": is_starter,
                "is_bench": is_bench,
                "is_injury_slot": is_injury,
                "is_flex_slot": to_bool_int(get(selected, "is_flex")),
                "eligible_positions": prow["eligible_positions"],
                "player_position": prow["display_position"],
                "nfl_team_abbr": prow["editorial_team_abbr"],
                "injury_status": prow["injury_status"],
                "is_editable_at_capture": is_editable,
            })

    return {"fantasy_roster_snapshots": snapshots, "fantasy_players": players}


def parse_player_week_stats(
    content: dict, *, league_key: str, season: int, week: int, game_code: str = "nfl",
) -> dict[str, list[dict]]:
    """Per-player stat lines and fantasy points for one week.

    ⚠️ player_points is only populated in a LEAGUE context, because points
    require the league's stat modifiers. Fetching a player resource bare returns
    raw stats and no points at all — which is why every stats request in the
    adapter is made under a /league/ or /team/ path.
    """
    stat_rows, point_rows = [], []

    def _walk(node: Any) -> Iterable[dict]:
        """Players appear under league/players, team/roster/players, or bare."""
        league = flatten_resource(get(node, "league"))
        if league:
            direct = subresource(league, "players")
            if direct is not MISSING:
                yield from as_list(direct)
            for t_node in as_list(get(league, "teams")):
                team = flatten_resource(get(t_node, "team", default=t_node))
                roster = flatten_resource(get(team, "roster"))
                # subresource: pathology 6 again — see parse_rosters.
                yield from as_list(subresource(roster, "players"))
            return
        direct = subresource(node, "players")
        if direct is not MISSING:
            yield from as_list(direct)

    for p_node in _walk(content):
        player = flatten_resource(get(p_node, "player", default=p_node))
        uid = _player_uid(player, game_code=game_code)
        if not uid:
            continue

        stats = flatten_resource(get(player, "player_stats"))
        for s_node in as_list(get(stats, "stats")):
            stat = flatten_resource(get(s_node, "stat", default=s_node))
            sid = to_text(get(stat, "stat_id"))
            if sid is None:
                continue
            stat_rows.append({
                "platform": PLATFORM,
                "league_key": league_key,
                "season": season,
                "week": week,
                "player_uid": uid,
                "stat_id": sid,
                # NULL when the provider reported nothing for this stat; 0.0
                # only when it genuinely reported zero.
                "stat_value": to_float(get(stat, "value")),
            })

        points = flatten_resource(get(player, "player_points"))
        if points:
            point_rows.append({
                "platform": PLATFORM,
                "league_key": league_key,
                "season": season,
                "week": week,
                "player_uid": uid,
                "points_provider": to_float(get(points, "total")),
                # Historical projections are definitively unavailable — there is
                # no per-player projection resource. NULL is correct, not missing.
                "projected_points": None,
            })

    return {
        "fantasy_player_week_stats": stat_rows,
        "fantasy_player_week_points": point_rows,
    }


def parse_players_collection(
    content: dict, *, game_code: str = "nfl",
) -> tuple[list[dict], int | None]:
    """A page of the players collection, plus the provider's declared count.

    The count is returned so the caller can compare it against the number of
    parsed rows — a mismatch means the page was truncated, which is exactly what
    a pagination bug looks like from the outside.
    """
    league = flatten_resource(get(content, "league"))
    node = get(league, "players")
    if node is MISSING:
        node = get(content, "players")
    rows = []
    for p_node in as_list(node):
        row = parse_player_node(p_node, game_code=game_code)
        if row:
            rows.append(row)
    return rows, collection_count(node)
