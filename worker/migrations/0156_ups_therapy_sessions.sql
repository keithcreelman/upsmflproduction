-- 0156_ups_therapy_sessions.sql
--
-- One row per franchise, tracking when they last ran /therapy -- so the bot
-- can react to the gap ("back again so soon?" vs "welcome back, it's been a
-- minute") instead of treating every session as if it's the first.
--
-- WHY THIS EXISTS (Keith 2026-09-14): "when you go back to the therapy
-- session fairly quickly from the last session, 'Back again so soon?' or
-- something along those lines and when it's been a minute give similar
-- feedback." No historical-accuracy risk here (unlike ups_bad_beats /
-- ups_trade_outcomes) -- this is forward-looking state, always correct by
-- construction: it's just "now" compared against whatever was last written.
--
-- Written directly by the Discord worker (worker/src/discord_therapy.js) on
-- every /therapy modal submit, not by a Python sync script -- there is no
-- offline computation involved, so none of the sync-script conventions
-- (owner_map, --dry-run, etc.) apply here.

CREATE TABLE IF NOT EXISTS ups_therapy_sessions (
  franchise_id       TEXT PRIMARY KEY,
  last_session_at_utc TEXT NOT NULL,
  session_count       INTEGER NOT NULL DEFAULT 0
);
