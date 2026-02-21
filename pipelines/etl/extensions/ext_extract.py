"""
ext_extract.py — Raw field extraction from MFL JSON payloads (Phase 1).

Extracts the minimum required fields per Step 1 spec into flat row tuples
suitable for INSERT into dim_franchise, dim_player, and roster_snapshot.

No parsing of contractInfo. No salary math. No eligibility logic.
"""
from __future__ import annotations

import logging
import sqlite3
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# TYPE=league -> dim_franchise rows
# ---------------------------------------------------------------------------

def extract_franchises(league_data: dict) -> List[Tuple]:
    """
    Extract franchise identity rows from TYPE=league JSON.

    Step 1 required fields:
        franchise.id, franchise.name, franchise.abbrev,
        franchise.owner_name, franchise.username,
        franchise.division, franchise.logo

    Explicit exclusions: contact fields, lastVisit, waiver/bbid balances.

    Returns:
        List of tuples:
        (franchise_id, franchise_name, franchise_abbrev,
         owner_name, username, division, logo_url)
    """
    rows = []
    try:
        franchises = league_data["league"]["franchises"]["franchise"]
        if not isinstance(franchises, list):
            franchises = [franchises]
    except (KeyError, TypeError):
        logger.error("Could not extract franchises from league data.")
        return rows

    for f in franchises:
        rows.append((
            f.get("id", ""),
            f.get("name", ""),
            f.get("abbrev", ""),
            f.get("owner_name", ""),
            f.get("username", ""),
            f.get("division", ""),
            f.get("icon", ""),  # MFL uses "icon" for logo URL
        ))

    return rows


# ---------------------------------------------------------------------------
# TYPE=players (DETAILS=1) -> dim_player rows
# ---------------------------------------------------------------------------

def extract_players(players_data: dict) -> List[Tuple]:
    """
    Extract player identity rows from TYPE=players (DETAILS=1) JSON.

    Step 1 required fields:
        player.id, player.name, player.position,
        player.team, player.draft_year (NFL draft year)

    Explicit exclusions: all other DETAILS fields (stats, injury, etc.)

    Returns:
        List of tuples:
        (player_id, player_name, position, nfl_team, nfl_draft_year)
    """
    rows = []
    try:
        players = players_data["players"]["player"]
        if not isinstance(players, list):
            players = [players]
    except (KeyError, TypeError):
        logger.error("Could not extract players from players data.")
        return rows

    for p in players:
        rows.append((
            p.get("id", ""),
            p.get("name", ""),
            p.get("position", ""),
            p.get("team", ""),
            p.get("draft_year", ""),  # MFL field name for NFL draft year
        ))

    return rows


# ---------------------------------------------------------------------------
# TYPE=rosters -> roster_snapshot rows
# ---------------------------------------------------------------------------

def extract_roster_snapshot(
    rosters_data: dict,
    nfl_season: int,
) -> List[Tuple]:
    """
    Extract roster rows from TYPE=rosters JSON.

    Step 1 required fields per player node:
        franchise.@id  -> franchise_id
        player.@id     -> player_id
        player.@status -> roster_status (ROSTER / TAXI_SQUAD / INJURED_RESERVE)
        player.@contractStatus -> contract_status
        player.@contractYear   -> contract_year
        player.@salary         -> salary
        player.@contractInfo   -> contract_info_raw

    Explicit exclusions: franchise.@week, player.@drafted

    Returns:
        List of tuples:
        (nfl_season, franchise_id, player_id, roster_status,
         contract_status, contract_year, salary, contract_info_raw)
    """
    rows = []
    try:
        franchises = rosters_data["rosters"]["franchise"]
        if not isinstance(franchises, list):
            franchises = [franchises]
    except (KeyError, TypeError):
        logger.error("Could not extract franchises from rosters data.")
        return rows

    for f in franchises:
        franchise_id = f.get("id", "")
        players = f.get("player", [])
        if not isinstance(players, list):
            players = [players] if players else []

        for p in players:
            # contract_year: parse to int, default None
            raw_cy = p.get("contractYear", "")
            contract_year = _safe_int(raw_cy)

            # salary: parse to int, default None
            raw_sal = p.get("salary", "")
            salary = _safe_int(raw_sal)

            rows.append((
                nfl_season,
                franchise_id,
                p.get("id", ""),
                p.get("status", ""),
                p.get("contractStatus", ""),
                contract_year,
                salary,
                p.get("contractInfo", ""),
            ))

    return rows


def _safe_int(value) -> Optional[int]:
    """Parse a value to int, returning None on failure."""
    if value is None or value == "":
        return None
    try:
        return int(str(value).replace(",", "").strip())
    except (ValueError, TypeError):
        return None


# ---------------------------------------------------------------------------
# Bulk INSERT helpers
# ---------------------------------------------------------------------------

def load_dim_franchise(conn: sqlite3.Connection, rows: List[Tuple]) -> int:
    """
    INSERT OR REPLACE franchise rows into dim_franchise.

    Returns count of rows inserted.
    """
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT OR REPLACE INTO dim_franchise
            (franchise_id, franchise_name, franchise_abbrev,
             owner_name, username, division, logo_url)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def load_dim_player(conn: sqlite3.Connection, rows: List[Tuple]) -> int:
    """
    INSERT OR REPLACE player rows into dim_player.

    Returns count of rows inserted.
    """
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT OR REPLACE INTO dim_player
            (player_id, player_name, position, nfl_team, nfl_draft_year)
        VALUES (?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)


def load_roster_snapshot(conn: sqlite3.Connection, rows: List[Tuple]) -> int:
    """
    INSERT OR REPLACE roster snapshot rows.

    Uses INSERT OR REPLACE on UNIQUE(nfl_season, franchise_id, player_id)
    so re-runs are idempotent for the same season.

    Returns count of rows inserted.
    """
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT OR REPLACE INTO roster_snapshot
            (nfl_season, franchise_id, player_id, roster_status,
             contract_status, contract_year, salary, contract_info_raw)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)
