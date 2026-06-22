"""Season-range guard for the nflverse fetchers.

nflverse only publishes data up to the current season, and `get_current_season`
LAGS the calendar through the off-season (e.g. it returns 2025 until the 2026
NFL season kicks off in Sept 2026). Passing a not-yet-existent season to any
`nflreadpy.load_*()` call raises (404 / "Season must be between …"), which took
down the whole weekly refresh in the off-season. Clamp the requested list to
what nflverse actually has before loading.
"""
from __future__ import annotations
import sys


def available_seasons(seasons, floor=None):
    """Drop seasons nflverse doesn't have yet (future / off-season) and below an
    optional per-source floor. Logs what was dropped; returns the kept list."""
    import nflreadpy as nfl
    cur = nfl.get_current_season(roster=False)   # 2025 through the 2026 off-season
    kept = [s for s in seasons if s <= cur and (floor is None or s >= floor)]
    dropped = [s for s in seasons if s not in kept]
    if dropped:
        print(
            f"  clamp: skipping {dropped} (nflverse current season={cur}"
            + (f", floor={floor}" if floor else "") + ")",
            file=sys.stderr,
        )
    return kept
