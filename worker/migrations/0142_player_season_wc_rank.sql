-- 0142 — precomputed Adj-AP-Wins season ranks
--
-- ⚠️ NEVER `wrangler d1 migrations apply`. Apply with:
--   npx wrangler d1 execute ups-mfl-db --remote --file worker/migrations/0142_player_season_wc_rank.sql
--
-- WHY
--   /api/player-bundle's career_summary opened with two CTEs that scanned ALL of
--   src_weekly — every player, every season — to produce a positional rank, then
--   LEFT JOINed it and threw the rest away. The outer SELECT filters to one
--   player; the CTEs could not. Measured 2026-08-27: 254,689 rows read PER CALL,
--   ten calls in an hour. That is the player card, which owners open constantly —
--   roughly ten opens would consume half of D1's 5M daily free-tier reads.
--
--   Same shape as the leaderboard (migration 0140): a whole-table aggregate
--   answering a single-player question.
--
-- The ranks depend only on (season, player_id) and change when src_weekly does —
-- i.e. weekly in season, never in the offseason. Rebuilt by
-- worker/migrations/manual/rebuild_player_season_wc_rank.sql.
CREATE TABLE IF NOT EXISTS player_season_wc_rank (
  season               INTEGER NOT NULL,
  player_id            TEXT    NOT NULL,
  pos_group            TEXT,
  win_chunks_total     REAL    NOT NULL DEFAULT 0,
  games_played         INTEGER NOT NULL DEFAULT 0,
  wc_pos_rank          INTEGER,
  wc_per_game_pos_rank INTEGER,
  built_at_utc         TEXT    NOT NULL,
  PRIMARY KEY (season, player_id)
);

-- The read is always (season, player_id), which the primary key serves.
-- This one covers the rebuild's own PARTITION BY.
CREATE INDEX IF NOT EXISTS idx_wc_rank_season_pos ON player_season_wc_rank (season, pos_group);
