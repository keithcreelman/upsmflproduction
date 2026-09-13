-- 0149_lineup_sat_announce_log.sql
-- Dedupe guard for the Saturday-AM league-wide lineup compliance post
-- (Keith 2026-09-13: "we need a Sat AM Post that's supposed to be based off
-- the injury reports not just DMs"). Distinct from ups_lineup_dm_log, which
-- tracks per-owner private DMs per kickoff window — this is ONE public post
-- per league per week, so an hourly cron ticking through the whole Saturday
-- morning window must not repost it every hour.

CREATE TABLE IF NOT EXISTS ups_lineup_sat_announce_log (
  season       INTEGER NOT NULL,
  league_id    TEXT    NOT NULL,
  week         INTEGER NOT NULL,
  message_id   TEXT,
  clean_count  INTEGER NOT NULL DEFAULT 0,
  issue_count  INTEGER NOT NULL DEFAULT 0,
  posted_unix  INTEGER NOT NULL,
  PRIMARY KEY (season, league_id, week)
);
