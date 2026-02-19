"""
ext_time.py — Deterministic time utilities for the extension module.

All datetime outputs are in US Eastern Time (America/New_York).
Unix timestamps are integer seconds (matching MFL convention).
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

# Canonical timezone for all extension module datetime operations.
ET = ZoneInfo("America/New_York")
UTC = timezone.utc


# ---------------------------------------------------------------------------
# Unix <-> datetime conversions
# ---------------------------------------------------------------------------

def unix_to_datetime_et(unix_ts: int | float) -> datetime:
    """
    Convert a Unix timestamp (seconds) to a timezone-aware datetime in ET.

    Args:
        unix_ts: Unix timestamp in seconds (integer or float).

    Returns:
        datetime with tzinfo=America/New_York.
    """
    return datetime.fromtimestamp(int(unix_ts), tz=UTC).astimezone(ET)


def datetime_et_to_unix(dt: datetime) -> int:
    """
    Convert a timezone-aware datetime to a Unix timestamp (integer seconds).

    If the datetime is naive, it is assumed to be in ET.

    Args:
        dt: datetime object.

    Returns:
        Unix timestamp as integer seconds.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    return int(dt.timestamp())


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------

def format_datetime_et(dt: datetime) -> str:
    """
    Format a datetime as 'YYYY-MM-DD HH:MM:SS' in ET.

    If the datetime is not already in ET, it is converted first.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    else:
        dt = dt.astimezone(ET)
    return dt.strftime("%Y-%m-%d %H:%M:%S")


def format_date_et(dt: datetime) -> str:
    """Format a datetime as 'YYYY-MM-DD' in ET."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    else:
        dt = dt.astimezone(ET)
    return dt.strftime("%Y-%m-%d")


def format_iso8601(dt: datetime) -> str:
    """
    Format a datetime as ISO 8601 string with timezone offset.
    Used for deterministic event_id hashing (Step 5).
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=ET)
    return dt.isoformat()


# ---------------------------------------------------------------------------
# Current time
# ---------------------------------------------------------------------------

def now_et() -> datetime:
    """Return the current datetime in ET (timezone-aware)."""
    return datetime.now(tz=ET)


def now_unix() -> int:
    """Return the current time as a Unix timestamp (integer seconds)."""
    return int(datetime.now(tz=UTC).timestamp())


# ---------------------------------------------------------------------------
# Date arithmetic helpers (for Step 3 timing windows)
# ---------------------------------------------------------------------------

def add_days(dt: datetime, days: int) -> datetime:
    """Add (or subtract) days from a datetime, preserving timezone."""
    return dt + timedelta(days=days)


def is_before_or_equal(current: datetime, deadline: datetime) -> bool:
    """
    Deterministic comparison: current_date <= deadline.

    Both datetimes are normalized to ET before comparison.
    Naive datetimes are assumed ET.
    """
    if current.tzinfo is None:
        current = current.replace(tzinfo=ET)
    else:
        current = current.astimezone(ET)

    if deadline.tzinfo is None:
        deadline = deadline.replace(tzinfo=ET)
    else:
        deadline = deadline.astimezone(ET)

    return current <= deadline
