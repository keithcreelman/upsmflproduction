-- 0140 — precomputed advanced-stats leaderboard
--
-- ⚠️ NEVER `wrangler d1 migrations apply` — the tracker is ~47 entries behind and
-- applying it corrupts contracts. Apply with:
--   npx wrangler d1 execute ups-mfl-db --remote --file worker/migrations/0140_leaderboard_precompute.sql
--
-- WHY
--   /api/advanced-stats-leaderboard scans nfl_player_weekly and nested-loops a
--   stack of materialised CTEs. Measured 2026-08-24: 2.0-3.7 MILLION rows read
--   PER RUN, 304M total. D1's free tier allows 5 MILLION PER DAY and Cloudflare
--   begins enforcing it 2026-09-01 — one cache miss was most of a day's budget.
--
--   Caching alone could not fix it: the Cache API is per-colo, so every new edge
--   location paid full price again. The query itself had to get cheaper.
--
--   100% of the measured reads were COMPLETED seasons — data frozen forever.
--   This table stores their finished answer.
--
-- SHAPE
--   One row PER PLAYER, not per position group. The per-group JSON hits 724 KB
--   for `skill` against a 1 MB row ceiling; per-player rows are ~1.5 KB and a
--   read of 500 costs 500 row-reads instead of 3,668,064.
--
--   `row_json` is the leaderboard row verbatim, so the endpoint serves it without
--   re-deriving anything and cannot drift from the live query's shape.
CREATE TABLE IF NOT EXISTS nfl_leaderboard_precompute (
  season       INTEGER NOT NULL,
  pos_alias    TEXT    NOT NULL,   -- qb | skill | idp | kicker | punter
  rank         INTEGER NOT NULL,   -- position within the ORDER BY the query used
  gsis_id      TEXT,
  games        INTEGER NOT NULL DEFAULT 0,  -- so min_games filters without parsing JSON
  punts        INTEGER NOT NULL DEFAULT 0,  -- so the punter filter does too
  franchise_id TEXT,                        -- so the team filter does too
  row_json     TEXT    NOT NULL,
  built_at_utc TEXT    NOT NULL,
  PRIMARY KEY (season, pos_alias, rank)
);

-- The read path is always (season, pos_alias) ordered by rank, which the primary
-- key already serves. This index covers the min_games filter so a filtered read
-- does not fall back to scanning the group.
CREATE INDEX IF NOT EXISTS idx_lbpre_season_pos_games
  ON nfl_leaderboard_precompute (season, pos_alias, games);

-- Build bookkeeping: which (season, pos) are populated, and from what.
-- A season absent here has NO precompute and MUST fall back to the live query —
-- serving an empty result would silently report that nobody played.
CREATE TABLE IF NOT EXISTS nfl_leaderboard_precompute_meta (
  season       INTEGER NOT NULL,
  pos_alias    TEXT    NOT NULL,
  row_count    INTEGER NOT NULL,
  source_sha   TEXT,
  built_at_utc TEXT    NOT NULL,
  PRIMARY KEY (season, pos_alias)
);
