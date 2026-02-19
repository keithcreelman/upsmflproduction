"""
ext_config.py — Extension module configuration.

Loads extension-specific runtime parameters from environment variables,
then delegates to the existing mfl_config / db_utils for DB path, timezone,
and server derivation.

Environment variables (extension-specific):
    MFL_LEAGUE_ID           - League ID (required; e.g., "74598")
    MFL_SEASON              - NFL season year (required; e.g., "2026")
    MFL_COMMISSIONER_COOKIE - Commissioner cookie string (required for Step 6 POST only)

All other config (DB path, timezone, pacing) comes from the existing
mfl_config.load_config() chain.
"""
from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# sys.path injection: allow importing from the existing ETL scripts directory
# without modifying those scripts.
# ---------------------------------------------------------------------------
_SCRIPTS_DIR = str(Path(__file__).resolve().parent.parent / "scripts")
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)

import mfl_config as _mfl_config  # noqa: E402
import db_utils as _db_utils  # noqa: E402


@dataclass(frozen=True)
class ExtConfig:
    """Immutable configuration for the extension module."""

    # Extension-specific (from env)
    league_id: str
    season: int
    commissioner_cookie: Optional[str]

    # From existing mfl_config
    db_path: str
    timezone: str

    # Derived at init time (not hard-coded)
    server: Optional[str] = field(default=None)


def _require_env(name: str) -> str:
    """Return env var value or raise with a clear message."""
    value = os.environ.get(name, "").strip()
    if not value:
        raise EnvironmentError(
            f"Required environment variable {name} is not set. "
            f"Set it in your .env or shell environment."
        )
    return value


def load_ext_config(config_path: str | None = None) -> ExtConfig:
    """
    Build an ExtConfig by combining:
      1. Extension env vars (MFL_LEAGUE_ID, MFL_SEASON, MFL_COMMISSIONER_COOKIE)
      2. Existing mfl_config.load_config() for DB path, timezone, etc.
      3. Server derived from league_years DB table (not hard-coded).
    """
    # --- Extension-specific env vars ---
    league_id = _require_env("MFL_LEAGUE_ID")
    season = int(_require_env("MFL_SEASON"))
    commissioner_cookie = os.environ.get("MFL_COMMISSIONER_COOKIE", "").strip() or None

    # --- Existing config (DB path, timezone, etc.) ---
    base_cfg = _mfl_config.load_config(config_path)

    # --- Derive server from DB (authoritative source) ---
    server = _derive_server(base_cfg.db_path, season)

    return ExtConfig(
        league_id=league_id,
        season=season,
        commissioner_cookie=commissioner_cookie,
        db_path=base_cfg.db_path,
        timezone=base_cfg.timezone,
        server=server,
    )


def _derive_server(db_path: str, season: int) -> Optional[str]:
    """
    Look up the MFL server number for the given season from league_years.
    Returns the server number as a string (e.g., "48"), or None if not found.
    Never hard-codes a default.
    """
    import mfl_api as _mfl_api  # noqa: E402

    try:
        conn = _db_utils.get_conn(db_path)
        _mfl_api.init_server_map_from_league_years(conn)
        server = _mfl_api.get_server_for_season(season)
        conn.close()
        return server
    except Exception:
        return None


def get_db_conn(cfg: ExtConfig):
    """Return a sqlite3 Connection using the resolved DB path."""
    return _db_utils.get_conn(cfg.db_path)
