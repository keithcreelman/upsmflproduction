# db_utils.py
from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Iterator, Tuple
from datetime import datetime

# Single source of truth for DB path.
# You can override via env var: MFL_DB_PATH=/some/where/mfl_database.db
DEFAULT_DB_PATH = os.environ.get(
    "MFL_DB_PATH",
    os.path.expanduser(
        "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db"
    ),
)


def get_conn(db_path: str | None = None) -> sqlite3.Connection:
    """
    Return a sqlite3 Connection to the MFL DB.

    Args:
        db_path: Optional override path. If None, uses DEFAULT_DB_PATH.

    Sets WAL mode + a 30-second busy timeout (Keith 2026-04-25 — the
    iCloud-backed DB serializes write locks badly when the iCloud
    daemon is reading the file mid-write; WAL lets reads stay
    non-blocking and busy_timeout gives concurrent writers a chance
    to finish instead of failing instantly).
    """
    conn = sqlite3.connect(db_path or DEFAULT_DB_PATH, timeout=30)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
    except sqlite3.DatabaseError:
        pass  # SQLite version may not support; non-fatal
    return conn


def open_local_db(db_path: str | os.PathLike | None = None) -> sqlite3.Connection:
    """Same as get_conn but accepts a Path or string. Used by the
    fetcher scripts that hold a single connection for a long run.
    """
    return get_conn(str(db_path) if db_path else None)


@contextmanager
def cursor(db_path: str | None = None) -> Iterator[sqlite3.Cursor]:
    """
    Context manager providing a cursor with automatic commit/close.
    """
    conn = get_conn(db_path)
    try:
        cur = conn.cursor()
        yield cur
        conn.commit()
    finally:
        conn.close()


def get_league_info(conn: sqlite3.Connection, season: int) -> Tuple[str, str]:
    """
    Look up (server, league_id) for a season from league_years table.

    Returns:
        (server, league_id) as strings.
    """
    cur = conn.cursor()
    cur.execute(
        "SELECT server, league_id FROM league_years WHERE season = ?",
        (season,),
    )
    row = cur.fetchone()
    if not row:
        raise ValueError(f"No league mapping found in league_years for season {season}")
    server, league_id = row
    return str(server), str(league_id)


def insert_transaction(cur: sqlite3.Cursor, row: tuple) -> None:
    """
    Compatibility helper to insert into transactions_base.

    Legacy callers pass a 10-tuple:
      (txn_id, season, timestamp, franchise_id, franchise_name,
       player_ids, player_names, transaction_type, amount, raw_json)

    The current transactions_base schema (see loadtransactions_base.py) is:
      (season, txn_index, type, unix_timestamp, datetime_et, date_et, time_et, raw_json)
    We map what we can and leave the date/time fields NULL.
    """
    def _safe_int(val):
        if val in (None, ""):
            return None
        try:
            return int(str(val))
        except Exception:
            return None

    (
        raw_txn_id,
        season,
        timestamp,
        _franchise_id,
        _franchise_name,
        _player_ids,
        _player_names,
        tx_type,
        _amount,
        raw_json,
    ) = row

    txn_index = _safe_int(raw_txn_id)
    unix_ts = _safe_int(timestamp)

    if txn_index is None:
        # fallback: assign next sequential index for the season
        cur.execute(
            "SELECT COALESCE(MAX(txn_index), -1) + 1 FROM transactions_base WHERE season = ?",
            (season,),
        )
        txn_index = cur.fetchone()[0] or 0

    # derive simple ET fields if we have a unix timestamp
    datetime_et = date_et = time_et = None
    if unix_ts is not None:
        try:
            try:
                import zoneinfo

                tz = zoneinfo.ZoneInfo("America/New_York")
                dt = datetime.fromtimestamp(unix_ts, tz)
            except Exception:
                dt = datetime.fromtimestamp(unix_ts)
            datetime_et = dt.strftime("%Y-%m-%d %H:%M:%S")
            date_et = dt.strftime("%Y-%m-%d")
            time_et = dt.strftime("%H:%M:%S")
        except Exception:
            datetime_et = date_et = time_et = None

    cur.execute(
        """
        INSERT OR REPLACE INTO transactions_base (
            season, txn_index, type,
            unix_timestamp, datetime_et, date_et, time_et,
            raw_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (season, txn_index, tx_type, unix_ts, datetime_et, date_et, time_et, raw_json),
    )
