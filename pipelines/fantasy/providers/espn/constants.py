"""ESPN's numeric code tables.

⚠️ SOURCE AND CONFIDENCE. ESPN's Fantasy API is entirely undocumented — there
is no official reference anywhere, unlike Yahoo which at least publishes an
OAuth guide even if the resource docs are thin. Every table below is
transcribed from the most actively maintained community client,
github.com/cwendt94/espn-api (`espn_api/football/constant.py`), fetched and
verified 2026-08-12. It is community knowledge, not an official spec, and
ESPN has changed this API's base URL without notice before (fantasy.espn.com
→ lm-api-reads.fantasy.espn.com, April 2024) — treat any entry that produces
an unexpected None as a signal the table needs re-verifying against a fresh
capture, not as a bug in the row.

Unlike Yahoo, ESPN's numeric player and team IDs are STABLE — a playerId does
not change across seasons or leagues, and there is no season-scoped-vs-
editorial key duality to reconcile. This makes the ESPN parser meaningfully
simpler than the Yahoo one; the complexity here is entirely in decoding
numeric codes, not in surviving a hostile JSON shape.
"""

from __future__ import annotations

#: lineupSlotId -> the slot label the schema stores in
#: fantasy_roster_snapshots.selected_position / fantasy_roster_positions.position.
#: Verbatim from espn-api's POSITION_MAP, id side.
LINEUP_SLOT_MAP: dict[int, str] = {
    0: "QB", 1: "TQB", 2: "RB", 3: "RB/WR", 4: "WR", 5: "WR/TE", 6: "TE",
    7: "OP", 8: "DT", 9: "DE", 10: "LB", 11: "DL", 12: "CB", 13: "S",
    14: "DB", 15: "DP", 16: "D/ST", 17: "K", 18: "P", 19: "HC", 20: "BE",
    21: "IR", 22: "", 23: "RB/WR/TE", 24: "ER", 25: "Rookie",
}

#: Slot IDs that are NOT part of the active starting lineup.
#: ⚠️ Mirrors the Yahoo design principle exactly: is_starter is DERIVED from
#: this classification, never assumed from a position label. 20=BE (bench),
#: 21=IR (injured reserve) are the only two ESPN uses in practice; the set is
#: still defined explicitly (not just "!= 20 and != 21") so a future slot type
#: ESPN adds that is ALSO non-starting (e.g. a taxi-squad-like slot) can be
#: added here deliberately rather than silently miscounted as a starter.
BENCH_SLOT_IDS: frozenset[int] = frozenset({20})
INJURY_SLOT_IDS: frozenset[int] = frozenset({21})

#: proTeamId -> NFL team abbreviation. Verbatim from espn-api's PRO_TEAM_MAP.
#: 0 = 'None' (free agent / no NFL team, e.g. between-season states).
PRO_TEAM_MAP: dict[int, str] = {
    0: "None", 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL",
    7: "DEN", 8: "DET", 9: "GB", 10: "TEN", 11: "IND", 12: "KC", 13: "LV",
    14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG",
    20: "NYJ", 21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF",
    26: "SEA", 27: "TB", 28: "WSH", 29: "CAR", 30: "JAX", 33: "BAL",
    34: "HOU",
}

#: defaultPositionId on a player object -> display position.
#: A smaller, distinct table from LINEUP_SLOT_MAP: this describes what a
#: player IS, not what slot they are CURRENTLY in.
DEFAULT_POSITION_MAP: dict[int, str] = {
    1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST",
    9: "DT", 10: "DE", 11: "LB", 12: "CB", 13: "S", 14: "DB", 15: "DP",
}

#: The first season served by the current (2018+) URL shape. Earlier seasons
#: use a different path AND wrap the response body in a single-element list —
#: see providers/espn/client.py.
FIRST_MODERN_SEASON = 2018

#: Base URL, confirmed current 2026-08-12. ESPN moved this without notice in
#: April 2024 (from fantasy.espn.com); if requests start failing outright,
#: re-verify this host before assuming credentials are the problem.
API_BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl"

#: The only game code this adapter targets. ESPN uses the same 'ffl' segment
#: for every season, unlike Yahoo where the equivalent (game_key) changes
#: every year — one more way ESPN's addressing is simpler than Yahoo's.
GAME_CODE = "ffl"

#: transaction `type` values this adapter requests via mTransactions2's
#: x-fantasy-filter header. Mirrors espn_api's own default `types` set
#: (League.transactions()) — trades ('TRADE_ACCEPT' etc.) are deliberately
#: excluded, matching the scope of what this pass was built for: FAAB/waiver
#: activity, not the full transaction history. WAIVER_ERROR is included
#: DELIBERATELY: confirmed live 2026-08-12 against Keith's real league that
#: ESPN's activity log does NOT show only completed moves the way an earlier
#: draft of this adapter assumed — status FAILED_PLAYERALREADYDROPPED,
#: FAILED_INVALIDPLAYERSOURCE, and CANCELED all appear alongside EXECUTED and
#: PENDING for type=WAIVER, i.e. losing/failed bids ARE exposed. This is
#: exactly the data ESPN's own https://fantasy.espn.com/football/league/
#: offerreport page shows (every offer, not just winners).
FAAB_TRANSACTION_TYPES: tuple[str, ...] = ("WAIVER", "FREEAGENT", "WAIVER_ERROR")
