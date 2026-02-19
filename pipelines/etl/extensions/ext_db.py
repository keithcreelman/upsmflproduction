"""
ext_db.py — Database migration runner + schema creation for extension tables.

Tables (per Step 5 spec):
    1. contract_events      — append-only canonical ledger
    2. contract_versions    — event-derived version history
    3. contracts_current    — single active snapshot per (player_id, franchise_id)
    4. ext_raw_payloads     — raw API response storage (Phase 0 + Phase 1)

All tables are created in the existing mfl_database.db (same SQLite DB).
Migrations are idempotent (CREATE IF NOT EXISTS).
"""
from __future__ import annotations

import logging
import sqlite3

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Schema definitions (Step 5 spec)
# ---------------------------------------------------------------------------

_SCHEMA_CONTRACT_EVENTS = """
CREATE TABLE IF NOT EXISTS contract_events (
    -- Identity
    event_id                    TEXT PRIMARY KEY,
    nfl_season                  INTEGER NOT NULL,
    event_timestamp             TEXT NOT NULL,
    event_type                  TEXT NOT NULL,
    player_id                   TEXT NOT NULL,
    franchise_id                TEXT NOT NULL,
    counterparty_franchise_id   TEXT,
    source_payload_fingerprint  TEXT,

    -- Post-event contract state (full snapshot)
    contract_status             TEXT,
    contract_year               INTEGER,
    salary                      INTEGER,
    contract_length             INTEGER,
    total_contract_value        INTEGER,
    aav_current                 INTEGER,
    aav_future                  INTEGER,
    contract_guarantee          INTEGER,
    year_salary_breakdown_json  TEXT,
    extension_history_json      TEXT,
    no_extension_flag           INTEGER,
    won_at_auction              INTEGER,
    acquisition_date            TEXT,
    acquisition_source          TEXT,

    -- Audit
    created_at                  TEXT NOT NULL,
    created_by                  TEXT NOT NULL
);
"""

_INDEX_CONTRACT_EVENTS_1 = """
CREATE INDEX IF NOT EXISTS idx_contract_events_player_franchise_ts
    ON contract_events (player_id, franchise_id, event_timestamp);
"""

_INDEX_CONTRACT_EVENTS_2 = """
CREATE INDEX IF NOT EXISTS idx_contract_events_type_ts
    ON contract_events (event_type, event_timestamp);
"""

_SCHEMA_CONTRACT_VERSIONS = """
CREATE TABLE IF NOT EXISTS contract_versions (
    -- Identity
    version_id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id                   TEXT NOT NULL,
    franchise_id                TEXT NOT NULL,
    nfl_season                  INTEGER NOT NULL,
    event_id                    TEXT NOT NULL REFERENCES contract_events(event_id),
    event_type                  TEXT NOT NULL,
    version_start               TEXT NOT NULL,
    version_end                 TEXT,

    -- Contract snapshot (copied from event)
    contract_status             TEXT,
    contract_year               INTEGER,
    salary                      INTEGER,
    contract_length             INTEGER,
    total_contract_value        INTEGER,
    aav_current                 INTEGER,
    aav_future                  INTEGER,
    contract_guarantee          INTEGER,
    year_salary_breakdown_json  TEXT,
    extension_history_json      TEXT,
    no_extension_flag           INTEGER,
    won_at_auction              INTEGER,
    acquisition_date            TEXT,
    acquisition_source          TEXT
);
"""

_INDEX_CONTRACT_VERSIONS_1 = """
CREATE INDEX IF NOT EXISTS idx_contract_versions_player_franchise
    ON contract_versions (player_id, franchise_id, version_end);
"""

_SCHEMA_CONTRACTS_CURRENT = """
CREATE TABLE IF NOT EXISTS contracts_current (
    -- Primary key
    player_id                   TEXT NOT NULL,
    franchise_id                TEXT NOT NULL,

    -- Version reference
    version_id                  INTEGER,

    -- Contract state
    contract_status             TEXT,
    contract_year               INTEGER,
    salary                      INTEGER,
    contract_length             INTEGER,
    total_contract_value        INTEGER,
    aav_current                 INTEGER,
    aav_future                  INTEGER,
    contract_guarantee          INTEGER,
    year_salary_breakdown_json  TEXT,
    extension_history_json      TEXT,
    no_extension_flag           INTEGER,
    won_at_auction              INTEGER,
    acquisition_date            TEXT,
    acquisition_source          TEXT,

    -- Event tracking
    last_event_id               TEXT,
    last_event_timestamp        TEXT,

    PRIMARY KEY (player_id, franchise_id)
);
"""

_SCHEMA_RAW_PAYLOADS = """
CREATE TABLE IF NOT EXISTS ext_raw_payloads (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    nfl_season      INTEGER NOT NULL,
    pull_type       TEXT NOT NULL,
    pulled_at       TEXT NOT NULL,
    row_count       INTEGER,
    payload_json    TEXT NOT NULL
);
"""

_INDEX_RAW_PAYLOADS_1 = """
CREATE INDEX IF NOT EXISTS idx_ext_raw_payloads_season_type
    ON ext_raw_payloads (nfl_season, pull_type);
"""


# ---------------------------------------------------------------------------
# Migration runner
# ---------------------------------------------------------------------------

_ALL_MIGRATIONS = [
    ("contract_events table", _SCHEMA_CONTRACT_EVENTS),
    ("contract_events index (player/franchise/ts)", _INDEX_CONTRACT_EVENTS_1),
    ("contract_events index (type/ts)", _INDEX_CONTRACT_EVENTS_2),
    ("contract_versions table", _SCHEMA_CONTRACT_VERSIONS),
    ("contract_versions index (player/franchise)", _INDEX_CONTRACT_VERSIONS_1),
    ("contracts_current table", _SCHEMA_CONTRACTS_CURRENT),
    ("ext_raw_payloads table", _SCHEMA_RAW_PAYLOADS),
    ("ext_raw_payloads index (season/type)", _INDEX_RAW_PAYLOADS_1),
]


def run_migrations(conn: sqlite3.Connection) -> None:
    """
    Run all extension table migrations (idempotent).

    Creates tables and indexes if they don't exist.
    Does not drop or alter existing tables.
    """
    cur = conn.cursor()
    for name, sql in _ALL_MIGRATIONS:
        try:
            cur.execute(sql)
            logger.info(f"Migration OK: {name}")
        except sqlite3.Error as e:
            logger.error(f"Migration FAILED: {name} — {e}")
            raise
    conn.commit()
    logger.info("All extension migrations complete.")


def verify_schema(conn: sqlite3.Connection) -> dict:
    """
    Verify that all expected extension tables exist.

    Returns:
        dict mapping table_name -> bool (exists or not).
    """
    expected = [
        "contract_events",
        "contract_versions",
        "contracts_current",
        "ext_raw_payloads",
    ]
    cur = conn.cursor()
    result = {}
    for table in expected:
        cur.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        )
        result[table] = cur.fetchone() is not None
    return result


# ---------------------------------------------------------------------------
# Raw payload storage helpers (Phase 0 / Phase 1)
# ---------------------------------------------------------------------------

def store_raw_payload(
    conn: sqlite3.Connection,
    nfl_season: int,
    pull_type: str,
    pulled_at: str,
    row_count: int | None,
    payload_json: str,
) -> int:
    """
    Insert a raw API response payload into ext_raw_payloads.

    Args:
        conn:         SQLite connection.
        nfl_season:   Season year.
        pull_type:    One of "league", "players", "rosters", "transactions".
        pulled_at:    ISO 8601 datetime string (ET).
        row_count:    Number of records in the payload (for sanity checks).
        payload_json: The raw JSON string from MFL.

    Returns:
        The rowid of the inserted record.
    """
    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO ext_raw_payloads
            (nfl_season, pull_type, pulled_at, row_count, payload_json)
        VALUES (?, ?, ?, ?, ?)
        """,
        (nfl_season, pull_type, pulled_at, row_count, payload_json),
    )
    conn.commit()
    return cur.lastrowid
