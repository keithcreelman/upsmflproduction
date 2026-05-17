-- 0048_taxi_callups.sql
-- Persistent counter for taxi-squad call-ups (UPS-owned; MFL does NOT
-- enforce the 3-call-up budget). Per canon docs/league_context_v1.md §B2
-- (UPDATED 2026-05-08, re-confirmed 2026-05-16):
--   • Each temporary call-up burns 1 of 3 allowed weeks per player.
--   • The 3-call-up budget is a TOTAL across the player's entire 3-year
--     taxi-eligibility window, NOT per-season.
--   • The 4th activation auto-flips the call-up to PERMANENT promotion —
--     player can never re-enter the taxi squad after that.
--
-- One row per call-up event. `demoted_at` is filled in on the matching
-- demote-to-taxi action (if it happens before the next NFL week locks).
-- `became_permanent=1` is set on the 4th activation row; once any row
-- for a (player_id) carries that flag, future demote-to-taxi attempts
-- must be rejected.
--
-- Tracker: docs/AUDIT_FOLLOWUP_TRACKERS.md Q10.

CREATE TABLE IF NOT EXISTS ups_taxi_callups (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id                TEXT NOT NULL,
  season                   TEXT NOT NULL,             -- league year of the call-up
  franchise_id             TEXT NOT NULL,             -- 4-char zero-padded
  player_id                TEXT NOT NULL,
  nfl_week                 INTEGER,                   -- NFL week the call-up was for
  called_up_at             TEXT NOT NULL DEFAULT (datetime('now')),
  demoted_at               TEXT,                      -- filled when player returns to taxi
  became_permanent         INTEGER NOT NULL DEFAULT 0, -- 1 = this call-up was the 4th
  callup_index             INTEGER,                   -- 1-based: which call-up in the window
  source                   TEXT,                      -- 'worker:promote_taxi' / 'mfl-sync' / etc.
  acting_user_id           TEXT,
  raw_payload_json         TEXT,
  submitted_at_utc         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_taxi_cu_player              ON ups_taxi_callups(player_id);
CREATE INDEX IF NOT EXISTS idx_taxi_cu_franchise_player    ON ups_taxi_callups(franchise_id, player_id);
CREATE INDEX IF NOT EXISTS idx_taxi_cu_season              ON ups_taxi_callups(season);
CREATE INDEX IF NOT EXISTS idx_taxi_cu_permanent           ON ups_taxi_callups(player_id, became_permanent);
CREATE INDEX IF NOT EXISTS idx_taxi_cu_open                ON ups_taxi_callups(player_id, demoted_at);
