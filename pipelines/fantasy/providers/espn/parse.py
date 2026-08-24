"""ESPN payload → platform-neutral fantasy_* rows.

SCOPE OF THIS LIGHTER FIRST PASS — deliberately narrower than the Yahoo
adapter. Covers: league metadata, teams, managers, team season state
(record/points/waiver rank), matchups + team weekly scores, weekly rosters
with derived starter status, and the player-week points already embedded in
the roster/boxscore payload (no extra request).

NOT covered yet, and not silently faked as empty — see adapter.py, which
raises a clear "not built yet" error for these rather than returning
complete=False the way a genuinely-unsupported resource would:
  - draft results (ESPN's mDraftDetail view exists; not parsed here)
  - full player-universe pagination (kona_player_info; not parsed here)
  - granular per-stat player_week_stats (only the pre-computed points total
    is captured, since it comes free in the same payload as the roster)
  - league scoring rules / roster-position capture — see the note below on
    why ESPN doesn't need this the way Yahoo does

WHY ESPN'S PARSER IS SIMPLER THAN YAHOO'S. Two structural facts, both
confirmed against ESPN's actual JSON (via the cwendt94/espn-api source, not
guessed):
  1. Real arrays throughout. None of Yahoo's numeric-string-keyed
     collection-as-object pathology, no MISSING-vs-empty ambiguity to the same
     degree. Standard `dict.get()` with an explicit default is sufficient.
  2. lineupSlotId is a FIXED GLOBAL enum (20=bench, 21=IR, same meaning in
     every league), unlike Yahoo where which position LABELS are bench-like
     is configured per league. So is_starter is derived from
     constants.BENCH_SLOT_IDS/INJURY_SLOT_IDS directly — no need to fetch and
     cross-reference this league's own roster-position settings first, the
     way the Yahoo adapter must.

STILL TRUE HERE, SAME AS YAHOO: NULL means the provider didn't say; 0 means it
said zero. Provider vocabulary (playoffTierType, activity types) is stored
verbatim. Anything this module computes rather than reads is labelled.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .constants import (
    BENCH_SLOT_IDS,
    DEFAULT_POSITION_MAP,
    GAME_CODE,
    INJURY_SLOT_IDS,
    LINEUP_SLOT_MAP,
    PRO_TEAM_MAP,
)

PLATFORM = "espn"


def league_key(season: int, league_id: str) -> str:
    """Season-scoped key, matching the schema's Yahoo-shaped contract.

    ESPN's own league_id is stable across seasons (unlike Yahoo's key, which
    embeds a season-varying game key) — the season is folded in here purely to
    satisfy fantasy_league_seasons' (platform, league_key) primary key, which
    the schema defines as season-scoped for every platform. This is a pure
    normalization; ESPN itself has no such compound identifier.
    """
    return f"{GAME_CODE}.s{season}.l.{league_id}"


def team_key(season: int, league_id: str, team_id: Any) -> str:
    """ESPN team ids are small ints, unique only WITHIN one league+season."""
    return f"{GAME_CODE}.s{season}.l.{league_id}.t.{team_id}"


def player_uid(player_id: Any) -> str | None:
    """ESPN player ids are stable across seasons and leagues — no season
    scoping needed, unlike Yahoo's player_key/editorial_player_key duality."""
    if player_id is None:
        return None
    return f"{GAME_CODE}.p.{player_id}"


def _team_display_name(team: dict) -> str | None:
    """ESPN splits a team name into location + nickname (both optional,
    independently). Neither being present is a real state (newly created
    team, name not yet set) and yields None rather than an empty string."""
    location = (team.get("location") or "").strip()
    nickname = (team.get("nickname") or "").strip()
    name = f"{location} {nickname}".strip()
    return name or team.get("name") or None


# ─────────────────────────────────────────────────────────────────────────────
# League
# ─────────────────────────────────────────────────────────────────────────────

def parse_league_metadata(data: dict, *, season: int, league_id: str) -> dict:
    """One fantasy_league_seasons row.

    ⚠️ ONLY columns that exist on fantasy_league_seasons (migration 0127)
    belong in this dict. `is_finished` lives on the WIDER fantasy_league_settings
    table (0128), which ESPN does not populate this pass — it does NOT exist on
    fantasy_league_seasons, and including it here is exactly the bug a live
    backfill caught: d1.py's write_rows builds its column list straight from
    each row's own keys with no schema check, so a stray key fails the INSERT
    with a SQLite "no such column" error rather than silently dropping it.
    Loud and clear, but avoidable — keep this dict scoped to the real columns.
    There is likewise no raw-JSON column on this table (unlike Yahoo's
    fantasy_league_settings.raw_settings_json) — ESPN has no raw-archival layer
    in this pass, so `status` is read for current_week and then discarded.
    """
    settings = data.get("settings") or {}
    status = data.get("status") or {}
    return {
        "platform": PLATFORM,
        "league_key": league_key(season, league_id),
        "season": season,
        "game_key": GAME_CODE,
        "game_code": GAME_CODE,
        "league_id": str(league_id),
        "league_name": settings.get("name"),
        "num_teams": settings.get("size"),
        "current_week": status.get("latestScoringPeriod"),
        "discovery_source": "direct",  # ESPN has no cross-season discovery endpoint — see adapter.py
        "is_accessible": 1,
    }


def parse_teams(data: dict, *, season: int, league_id: str) -> dict[str, list[dict]]:
    """Teams, managers, and per-season team state (record/points/waiver rank)."""
    teams, states, managers, links = [], [], [], []
    seen_managers: set[str] = set()

    for team in data.get("teams") or []:
        tid = team.get("id")
        if tid is None:
            continue
        tk = team_key(season, league_id, tid)

        teams.append({
            "platform": PLATFORM,
            "team_key": tk,
            "league_key": league_key(season, league_id),
            "season": season,
            "team_id": str(tid),
            "team_name": _team_display_name(team),
            "division_id": (str(team.get("divisionId"))
                            if team.get("divisionId") is not None else None),
            "logo_url": team.get("logo"),
        })

        record = ((team.get("record") or {}).get("overall")) or {}
        states.append({
            "platform": PLATFORM,
            "team_key": tk,
            "league_key": league_key(season, league_id),
            "season": season,
            "waiver_priority": team.get("waiverRank"),
            "number_of_moves": team.get("transactionCounter", {}).get("acquisitions")
                               if isinstance(team.get("transactionCounter"), dict) else None,
            "number_of_trades": team.get("transactionCounter", {}).get("trades")
                                if isinstance(team.get("transactionCounter"), dict) else None,
        })

        for owner in team.get("owners") or []:
            # `owners` is a list of GUID-like member id strings in the modern
            # API. This is ESPN's equivalent of Yahoo's manager guid — the one
            # stable cross-season identity — never the display name.
            guid = owner if isinstance(owner, str) else owner.get("id")
            if not guid:
                continue
            if guid not in seen_managers:
                seen_managers.add(guid)
                managers.append({
                    "platform": PLATFORM,
                    "manager_uid": guid,
                    "first_season": season,
                    "last_season": season,
                    # ⚠️ No display name captured here: the modern `owners` array
                    # is bare id strings in most payloads. If a richer `members`
                    # block is present elsewhere in the response, a future pass
                    # can enrich this — not guessed at here.
                })
            links.append({
                "platform": PLATFORM,
                "team_key": tk,
                "manager_uid": guid,
                "league_key": league_key(season, league_id),
                "season": season,
                "is_commissioner": 1 if team.get("primaryOwner") == guid else 0,
            })

    return {
        "fantasy_teams": teams,
        "fantasy_team_season_state": states,
        "fantasy_managers": managers,
        "fantasy_team_managers": links,
    }


def parse_standings(data: dict, *, season: int, league_id: str) -> list[dict]:
    """Record and points-for/against as ESPN's team objects currently report them.

    ⚠️ rank and playoff_seed are left NULL, not computed. ESPN's team object
    does not expose a confirmed 'current rank' field in what has been verified
    for this pass, and sorting teams by record to invent one would be a real
    computation presented as a fact — exactly the thing this project's
    is_inferred discipline exists to prevent. Add a rank computation later,
    explicitly marked is_inferred=1, once the tiebreak rules are confirmed.
    """
    rows = []
    for team in data.get("teams") or []:
        tid = team.get("id")
        if tid is None:
            continue
        record = ((team.get("record") or {}).get("overall")) or {}
        rows.append({
            "platform": PLATFORM,
            "league_key": league_key(season, league_id),
            "season": season,
            "team_key": team_key(season, league_id, tid),
            "wins": record.get("wins"),
            "losses": record.get("losses"),
            "ties": record.get("ties"),
            "points_for": team.get("pointsFor"),
            "points_against": team.get("pointsAgainst"),
            "rank": None,          # not confirmed available; see docstring
            "playoff_seed": None,  # ditto
            "is_final": 0,         # this is a point-in-time read, not confirmed end-of-season
            "is_inferred": 0,      # every value above is read, not computed
        })
    return rows


# ─────────────────────────────────────────────────────────────────────────────
# Transactions — FAAB/waiver scope only (see adapter.py's module docstring)
# ─────────────────────────────────────────────────────────────────────────────

def transaction_key(season: int, league_id: str, txn_id: Any) -> str:
    """ESPN transaction ids are already-unique UUID-like strings; the league
    prefix is folded in purely so the key traces back to its source at a
    glance, same convention as team_key/player_uid."""
    return f"{league_key(season, league_id)}.txn.{txn_id}"


#: Non-team side of an ADD/DROP leg, keyed by the transaction's own `type`.
#: WAIVER_ERROR transactions are failed WAIVER claims, so they use the same
#: 'waivers' pool label as a successful one.
_POOL_TYPE_BY_TXN_TYPE: dict[str, str] = {
    "WAIVER": "waivers", "WAIVER_ERROR": "waivers", "FREEAGENT": "freeagents",
}

#: Parent-object keys this parser actually consumes. Anything else present on
#: a real ESPN transaction (e.g. `rating`, `executionType`,
#: `relatedTransactionId`, `memberId`, `isPending`) is preserved verbatim in
#: raw_transaction_json but also surfaced in unmapped_fields — same reasoning
#: as Yahoo's unmapped_keys: a new/unexamined provider field should show up as
#: data to look at, not vanish silently.
_TXN_MAPPED_KEYS = {
    "id", "type", "status", "teamId", "scoringPeriodId", "bidAmount",
    "processDate", "proposedDate", "items", "isLeagueManager",
}


def _unmapped_keys(node: dict, mapped: set[str]) -> list[str] | None:
    extra = sorted(k for k in node.keys() if k not in mapped)
    return extra or None


def parse_transactions(
    data: dict, *, season: int, league_id: str, week: int,
) -> dict[str, list[dict]]:
    """One mTransactions2 response (scoped to a single scoringPeriodId) ->
    transaction parent rows plus one row per add/drop leg.

    ⚠️ UNLIKE YAHOO'S transactions endpoint, this view exposes losing and
    failed claims too — status FAILED_PLAYERALREADYDROPPED,
    FAILED_INVALIDPLAYERSOURCE, CANCELED all appear alongside EXECUTED and
    PENDING, confirmed live against Keith's real league 2026-08-12. Every
    status is kept verbatim; nothing here filters down to "successful" the
    way it would have to if this were reproducing Yahoo's narrower payload.
    This is exactly what https://fantasy.espn.com/football/league/
    offerreport shows: every offer, not just the winners.

    ⚠️ bidAmount is 0 for an uncontested claim (a real, meaningful zero — the
    team still "bid" $0) and is passed through as-is. It is never coerced;
    a genuinely absent value stays None.

    ⚠️ fromTeamId/toTeamId of 0 means the free-agent/waiver pool, not team id
    0 — mirrors PRO_TEAM_MAP's `0: "None"` convention used elsewhere in this
    module for "no real team" sentinels.
    """
    lk = league_key(season, league_id)
    pool_type_default = "freeagents"
    parents, legs = [], []

    for txn in data.get("transactions") or []:
        txn_id = txn.get("id")
        if not txn_id:
            continue
        txn_key = transaction_key(season, league_id, txn_id)
        txn_type = txn.get("type")
        pool_type = _POOL_TYPE_BY_TXN_TYPE.get(txn_type, pool_type_default)

        process_ms = txn.get("processDate")
        proposed_ms = txn.get("proposedDate")
        timestamp_ms = process_ms if process_ms is not None else proposed_ms
        processed_date = None
        if process_ms is not None:
            processed_date = datetime.fromtimestamp(
                process_ms / 1000, tz=timezone.utc
            ).strftime("%Y-%m-%d")

        leg_index = 0
        for item in txn.get("items") or []:
            from_tid = item.get("fromTeamId")
            to_tid = item.get("toTeamId")
            if from_tid:
                source_type, source_team_key = "team", team_key(season, league_id, from_tid)
            else:
                source_type, source_team_key = pool_type, None
            if to_tid:
                destination_type, destination_team_key = "team", team_key(season, league_id, to_tid)
            else:
                destination_type, destination_team_key = pool_type, None

            legs.append({
                "platform": PLATFORM,
                "transaction_key": txn_key,
                "leg_index": leg_index,
                "league_key": lk,
                "season": season,
                "asset_kind": "player",
                "movement_type": item.get("type"),  # 'ADD'|'DROP', verbatim
                "player_uid": player_uid(item.get("playerId")),
                "player_key_at_txn": (str(item.get("playerId"))
                                       if item.get("playerId") is not None else None),
                "source_type": source_type,
                "source_team_key": source_team_key,
                "destination_type": destination_type,
                "destination_team_key": destination_team_key,
            })
            leg_index += 1

        parents.append({
            "platform": PLATFORM,
            "transaction_key": txn_key,
            "league_key": lk,
            "season": season,
            "transaction_id": str(txn_id),
            "transaction_type": txn_type,
            "status": txn.get("status"),
            "timestamp_unix": int(timestamp_ms / 1000) if timestamp_ms is not None else None,
            "processed_date": processed_date,
            "week": txn.get("scoringPeriodId", week),
            "faab_bid": txn.get("bidAmount"),
            "waiver_priority_at_processing": None,  # not exposed by this view
            "is_commissioner_action": 1 if txn.get("isLeagueManager") else 0,
            "trade_note": None,  # TRADE_* types are out of scope this pass
            "asset_count": leg_index,
            "raw_transaction_json": txn,
            "unmapped_fields": _unmapped_keys(txn, _TXN_MAPPED_KEYS),
        })

    return {"fantasy_transactions": parents, "fantasy_transaction_assets": legs}


# ─────────────────────────────────────────────────────────────────────────────
# Weekly: matchups, rosters, points — one call, three tables
# ─────────────────────────────────────────────────────────────────────────────

def _player_row(entry: dict) -> dict | None:
    """One roster entry (from mRoster or mBoxscore) -> a fantasy_players +
    roster-slot fragment. Returns None if the entry carries no player id."""
    pool = entry.get("playerPoolEntry") or {}
    player = pool.get("player") or entry.get("player") or {}
    pid = entry.get("playerId") or player.get("id")
    if pid is None:
        return None

    first = player.get("firstName") or ""
    last = player.get("lastName") or ""
    full_name = (f"{first} {last}").strip() or player.get("fullName")

    default_pos_id = player.get("defaultPositionId")
    pro_team_id = player.get("proTeamId")

    slot_id = entry.get("lineupSlotId")
    slot_label = LINEUP_SLOT_MAP.get(slot_id) if slot_id is not None else None
    is_bench = 1 if slot_id in BENCH_SLOT_IDS else 0
    is_injury = 1 if slot_id in INJURY_SLOT_IDS else 0
    is_starter = None if slot_id is None else (0 if (is_bench or is_injury) else 1)

    eligible = [
        LINEUP_SLOT_MAP.get(s, str(s))
        for s in (player.get("eligibleSlots") or [])
    ]

    # ⚠️ appliedTotal is the pre-computed fantasy points ESPN already scored
    # this entry with — capturing it costs nothing extra since it's in the
    # same payload as the roster. Distinct from a full per-stat breakdown,
    # which this pass does not attempt.
    stats = entry.get("playerPoolEntry", {}).get("appliedStatTotal")
    if stats is None:
        stats = entry.get("appliedStatTotal")

    return {
        "uid": player_uid(pid),
        # ⚠️ NO eligible_positions HERE. fantasy_players has no such column —
        # only fantasy_roster_snapshots and fantasy_player_eligibility do (the
        # latter unpopulated by ESPN this pass). A second audit script, run
        # after a live backfill caught the same class of bug on
        # parse_league_metadata, found this one too — every ESPN parse
        # function's output keys are now checked against the real D1 schema,
        # not just eyeballed. See the audit note in cli.py's module docstring.
        "player_row": {
            "platform": PLATFORM,
            "player_uid": player_uid(pid),
            "provider_player_id": str(pid),
            "full_name": full_name,
            "first_name": first or None,
            "last_name": last or None,
            "display_position": DEFAULT_POSITION_MAP.get(default_pos_id) if default_pos_id is not None else None,
            "editorial_team_abbr": PRO_TEAM_MAP.get(pro_team_id) if pro_team_id is not None else None,
        },
        "slot_label": slot_label,
        "is_starter": is_starter,
        "is_bench": is_bench,
        "is_injury_slot": is_injury,
        "eligible_positions": eligible or None,  # for fantasy_roster_snapshots ONLY
        "points_provider": stats,
    }


def parse_weekly(
    data: dict, *, season: int, league_id: str, week: int,
) -> dict[str, list[dict]]:
    """One request (mBoxscore [+mMatchup], scoringPeriodId=week) → matchups,
    team weekly scores, roster snapshots, players, and player-week points.

    ⚠️ A 'schedule' entry with only one side present (a bye week, in an
    odd-team-count league) yields a team-week-score row for the side that
    exists and no matchup row — a bye is not a matchup, and inventing an
    opponent would be fabrication.
    """
    lk = league_key(season, league_id)
    matchups, team_scores, roster_snaps, players, points = [], [], [], [], []
    seen_players: dict[str, dict] = {}

    for game in data.get("schedule") or []:
        period = game.get("matchupPeriodId")
        if period != week:
            # mBoxscore can return the whole schedule; only this week's
            # entries carry rosterForCurrentScoringPeriod for the requested week.
            continue

        sides = {}
        for side_key in ("home", "away"):
            side = game.get(side_key)
            if not side or side.get("teamId") is None:
                continue
            tid = side["teamId"]
            tk = team_key(season, league_id, tid)
            total = side.get("totalPointsLive")
            if total is None:
                total = side.get("totalPoints")
            sides[side_key] = {"team_key": tk, "points": total}

            team_scores.append({
                "platform": PLATFORM, "league_key": lk, "season": season,
                "week": week, "team_key": tk, "points_provider": total,
            })

            for entry in ((side.get("rosterForCurrentScoringPeriod") or {}).get("entries") or []):
                parsed = _player_row(entry)
                if not parsed:
                    continue
                seen_players[parsed["uid"]] = parsed["player_row"]
                roster_snaps.append({
                    "platform": PLATFORM, "league_key": lk, "season": season,
                    "week": week, "team_key": tk, "player_uid": parsed["uid"],
                    "selected_position": parsed["slot_label"],
                    "is_starter": parsed["is_starter"],
                    "is_bench": parsed["is_bench"],
                    "is_injury_slot": parsed["is_injury_slot"],
                    "eligible_positions": parsed["eligible_positions"],
                    "player_position": parsed["player_row"]["display_position"],
                    "nfl_team_abbr": parsed["player_row"]["editorial_team_abbr"],
                })
                if parsed["points_provider"] is not None:
                    points.append({
                        "platform": PLATFORM, "league_key": lk, "season": season,
                        "week": week, "player_uid": parsed["uid"],
                        "points_provider": parsed["points_provider"],
                    })

        if "home" in sides and "away" in sides:
            a, b = sorted((sides["home"], sides["away"]), key=lambda s: s["team_key"])
            matchups.append({
                "platform": PLATFORM, "league_key": lk, "season": season, "week": week,
                "matchup_key": f"{a['team_key']}|{b['team_key']}",
                "team_a_key": a["team_key"], "team_b_key": b["team_key"],
                "team_a_points": a["points"], "team_b_points": b["points"],
                # ⚠️ playoffTierType stored verbatim; is_playoffs left NULL —
                # the enum's values are not confirmed. See module docstring.
                "status": game.get("playoffTierType"),
                "is_playoffs": None,
                "winner_team_key": (
                    a["team_key"] if (a["points"] or 0) > (b["points"] or 0) else
                    b["team_key"] if (b["points"] or 0) > (a["points"] or 0) else None
                ) if a["points"] is not None and b["points"] is not None else None,
            })

    players = list(seen_players.values())
    return {
        "fantasy_matchups": matchups,
        "fantasy_team_week_scores": team_scores,
        "fantasy_roster_snapshots": roster_snaps,
        "fantasy_players": players,
        "fantasy_player_week_points": points,
    }


# ─────────────────────────────────────────────────────────────────────────────
# League settings  (mSettings)
# ─────────────────────────────────────────────────────────────────────────────

#: Positions a FLEX slot can draw from. "D/ST" is deliberately absent: it is a
#: single position whose NAME contains a slash, which is exactly the trap the
#: naive `"/" in label` test fell into.
_FLEX_ELIGIBLE = frozenset({"QB", "RB", "WR", "TE", "K"})


def _is_flex_label(label: str | None) -> bool:
    """True only when the label names 2+ distinct flex-eligible positions."""
    if not label or "/" not in label:
        return False
    parts = [p.strip().upper() for p in label.split("/") if p.strip()]
    return len(parts) > 1 and all(p in _FLEX_ELIGIBLE for p in parts)


def parse_league_settings(
    data: dict, *, season: int, league_id: str
) -> dict[str, list[dict]]:
    """fantasy_league_settings + fantasy_scoring_rules + fantasy_roster_positions.

    ⚠️ WHY THIS EXISTS NOW, HAVING BEEN SKIPPED IN THE FIRST PASS. The original
    ESPN pass argued settings were unnecessary because is_starter derives from
    a GLOBAL lineupSlotId enum, so ESPN needs no per-league slot table the way
    Yahoo does. That reasoning is still correct for starter derivation — but it
    is not the only thing settings are for. Without them there is no record of
    what a point MEANS in this league, so any cross-league or historical
    comparison silently mixes scoring systems. A live analysis hit exactly that
    wall: a valuation had to borrow another league's scoring because this
    league's PPR variant was unknown.

    ⚠️ SCORING SEMANTICS — read before trusting `modifier`.
    ESPN expresses a rule as `points` (applies to every position) PLUS an
    optional `pointsOverrides` map keyed by POSITION ID. A reception rule can
    therefore be 1.0 for everyone, or 0.5 base with a TE override of 1.0 (TE
    premium). We store `points` verbatim in `modifier` and preserve the FULL
    item — overrides included — in `raw_stat_json`, because collapsing an
    override map into one number would silently erase TE-premium and
    D/ST-only rules. `applies_to_positions` names the override positions when
    any exist, so a reader can see at a glance that the flat modifier is not
    the whole story.

    statId is ESPN's own opaque integer. We do NOT invent a name for ids we
    cannot confidently map: stat_name stays NULL rather than guessing, per the
    same no-fail-open rule used everywhere else here. A wrong label is worse
    than an honest absence, because it would be believed.
    """
    lk = league_key(season, league_id)
    settings = data.get("settings") or {}
    scoring = settings.get("scoringSettings") or {}
    roster = settings.get("rosterSettings") or {}
    schedule = settings.get("scheduleSettings") or {}
    draft = settings.get("draftSettings") or {}
    acq = settings.get("acquisitionSettings") or {}
    trade = settings.get("tradeSettings") or {}

    slot_counts = roster.get("lineupSlotCounts") or {}

    league_row = {
        "platform": PLATFORM,
        "league_key": lk,
        "season": season,
        "league_name": settings.get("name"),
        "num_teams": settings.get("size"),
        "scoring_type": scoring.get("scoringType"),
        # ESPN's playerRankType ('PPR'/'STANDARD') is the league's own summary
        # of its reception scoring. Kept because it is the field a human reads.
        "league_type": scoring.get("playerRankType"),
        "start_week": None,
        "end_week": None,
        "playoff_start_week": schedule.get("matchupPeriodCount"),
        "num_playoff_teams": schedule.get("playoffTeamCount"),
        "draft_type": draft.get("type"),
        "is_auction_draft": 1 if (draft.get("type") or "").upper() == "AUCTION" else 0,
        "draft_time_unix": (draft.get("date") // 1000) if isinstance(draft.get("date"), int) else None,
        "uses_faab": 1 if acq.get("isUsingAcquisitionBudget") else 0,
        "faab_budget": acq.get("acquisitionBudget"),
        "max_acquisitions": acq.get("acquisitionLimit"),
        "waiver_type": acq.get("waiverProcessDays") and "waivers" or None,
        "uses_keepers": 1 if (settings.get("draftSettings") or {}).get("keeperCount") else 0,
        "num_keepers": (settings.get("draftSettings") or {}).get("keeperCount"),
        "trade_reject_time_days": trade.get("revisionHours") and int(trade["revisionHours"]) // 24 or None,
        "max_trades": trade.get("max"),
        "raw_settings_json": settings,
    }

    scoring_rows: list[dict] = []
    for idx, item in enumerate(scoring.get("scoringItems") or []):
        stat_id = item.get("statId")
        if stat_id is None:
            continue
        overrides = item.get("pointsOverrides") or {}
        applies = (
            ",".join(
                DEFAULT_POSITION_MAP.get(int(k), str(k)) for k in sorted(overrides, key=lambda x: int(x))
            )
            or None
        )
        scoring_rows.append({
            "platform": PLATFORM,
            "league_key": lk,
            "season": season,
            "stat_id": str(stat_id),
            # No guessed labels — see the docstring.
            "stat_name": None,
            "modifier": item.get("points"),
            "applies_to_positions": applies,
            "is_enabled": 1,
            "sort_order": idx,
            "raw_stat_json": item,
        })

    roster_rows: list[dict] = []
    for sid, count in sorted(slot_counts.items(), key=lambda kv: int(kv[0])):
        sid_i = int(sid)
        count_i = int(count or 0)
        if count_i == 0:
            # A zero-count slot is a real "this league does not use it" fact,
            # but storing 25 empty rows per league buries the 7 real ones.
            continue
        label = LINEUP_SLOT_MAP.get(sid_i)
        is_bench = sid_i in BENCH_SLOT_IDS
        is_injury = sid_i in INJURY_SLOT_IDS
        roster_rows.append({
            "platform": PLATFORM,
            "league_key": lk,
            "season": season,
            "position": label if label else f"slot_{sid_i}",
            "slot_count": count_i,
            "is_starting_slot": 0 if (is_bench or is_injury) else 1,
            "is_bench_slot": 1 if is_bench else 0,
            "is_injury_slot": 1 if is_injury else 0,
            # ⚠️ A flex slot is one whose label names more than one ELIGIBLE
            # position — NOT merely one containing a slash. "D/ST" contains a
            # slash and is a SINGLE position; the naive slash test flagged
            # every league's defense as a flex slot (caught 2026-08-22 reading
            # real output for Keith's league). Splitting and checking each part
            # against known skill positions is what actually distinguishes
            # "RB/WR/TE" from "D/ST".
            "is_flex_slot": 1 if _is_flex_label(label) else 0,
            "flex_positions": label if _is_flex_label(label) else None,
            "sort_order": sid_i,
            "raw_position_json": {"lineupSlotId": sid_i, "count": count_i},
        })

    return {
        "fantasy_league_settings": [league_row],
        "fantasy_scoring_rules": scoring_rows,
        "fantasy_roster_positions": roster_rows,
    }
