-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0123_ups_player_projections.sql
-- Weekly player projections, captured as-of.
--
-- ⚠️ ALREADY APPLIED IN PRODUCTION. The table and both indexes exist in
--    ups-mfl-db today (verified via sqlite_master 2026-08-05). Every statement
--    here is IF NOT EXISTS, so re-running is a safe no-op. This file exists so
--    the schema is in git rather than only in the database.
--
-- ⚠️ RENUMBERED FROM 0114. This migration was written on 2026-08-01 in the
--    `wire/p1-hub-shell` worktree, applied by hand, and never committed — so
--    0114 was taken in the meantime by 0114_tackle_semantics_and_first_downs.sql.
--    The same worktree still has a staged 0113_ups_discord_messages.sql that
--    collides with the committed 0113_ups_lineup_submissions.sql; that one
--    belongs to the wire branch and is NOT renumbered here.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- WHY: MFL serves projections LIVE only and never stores them, so "actual vs
-- projected" -- the single most requested thing missing from the weekly recaps
-- -- is unrecoverable for any past week. It is only unrecoverable BACKWARDS.
-- Capturing from now means 2026 has it from Week 1.
--
-- WHAT IS STORED. One row per (season, week, player). `projected_score` is
-- always the MOST RECENT value seen -- projections move all week as injury news
-- lands, and the current number is the one that matters. `first_projected` and
-- `first_captured_at` keep the earliest sighting too, because the MOVEMENT is
-- its own story: a player projected low on Wednesday who is projected high by
-- Sunday tells you something happened, and the recap can say so.
--
-- Deliberately NOT keeping every intermediate capture. The open and the close
-- carry the signal; a row per poll would grow without adding much.
--
-- HISTORICAL ACCURACY IS NOT CLAIMED. Anything captured after the fact is
-- whatever MFL was serving at capture time, not what was on screen during the
-- week. `first_captured_at` makes that auditable rather than assumed -- if it
-- is after the games were played, the row is a post-hoc number and any recap
-- using it should say so.

CREATE TABLE IF NOT EXISTS ups_player_projections (
  season             INTEGER NOT NULL,
  week               INTEGER NOT NULL,
  player_id          TEXT    NOT NULL,   -- MFL id, zero-padded TEXT
  projected_score    REAL    NOT NULL,   -- latest seen
  first_projected    REAL,               -- earliest seen, for movement
  first_captured_at  INTEGER,            -- unix; if post-games, this is post-hoc
  updated_at         INTEGER NOT NULL,
  capture_count      INTEGER DEFAULT 1,
  PRIMARY KEY (season, week, player_id)
);

-- The recap's access path: "give me every projection for this week".
CREATE INDEX IF NOT EXISTS idx_projections_season_week
  ON ups_player_projections(season, week);

-- "Who moved the most this week" -- biggest gap between open and close.
CREATE INDEX IF NOT EXISTS idx_projections_player
  ON ups_player_projections(player_id, season, week);
