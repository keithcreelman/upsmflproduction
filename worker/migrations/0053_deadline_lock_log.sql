-- 0053_deadline_lock_log
-- Idempotency markers for deadline-driven worker actions.
-- Each row records that a given scheduled action has fired and completed
-- for a (season, league, event_key) tuple. The hourly cron checks for the
-- row before firing; if present, skip. If absent, run + INSERT on success.
--
-- Event keys currently in use:
--   tag_deadline_midnight_lock    — midnight ET tag deadline closure:
--                                    auto-drop non-extended expired rookies,
--                                    flip hasTagDeadlinePassed semantics.
--   tag_deadline_six_am_dm        — 6 AM ET day-after-deadline:
--                                    DM commish the locked tag contracts.
--
-- Stored as text JSON in `details_json` for after-the-fact diagnostics:
--   { dropped_player_ids: [...], dm_message_id: "...", errors: [...] }

CREATE TABLE IF NOT EXISTS ups_deadline_lock_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  season            TEXT NOT NULL,
  league_id         TEXT NOT NULL,
  event_key         TEXT NOT NULL,
  completed_at_utc  TEXT NOT NULL,
  details_json      TEXT,
  UNIQUE (season, league_id, event_key)
);

CREATE INDEX IF NOT EXISTS idx_deadline_lock_log_event
  ON ups_deadline_lock_log (event_key, season, league_id);
