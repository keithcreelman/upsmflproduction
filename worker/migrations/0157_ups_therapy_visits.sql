-- 0157_ups_therapy_visits.sql
--
-- One row per /therapy session, keyed by Discord user AND channel, so the
-- bot can count visits inside a rolling 90-minute window and call out the
-- 4th one (Keith 2026-09-15 bot spec, "Excessive-session response").
--
-- ups_therapy_sessions (0156) can't do this: it keeps only the LAST visit and
-- a lifetime count per franchise, so "how many in the last 90 minutes" isn't
-- answerable from it. It stays as-is and still drives the recency line.
--
-- Written directly by worker/src/discord_therapy.js on every modal submit.
-- Forward-looking state only -- no backfill, no historical-accuracy risk.

CREATE TABLE IF NOT EXISTS ups_therapy_visits (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT NOT NULL,
  channel_id      TEXT NOT NULL,
  franchise_id    TEXT,
  visited_at_utc  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ups_therapy_visits_user_channel_time
  ON ups_therapy_visits (discord_user_id, channel_id, visited_at_utc);
