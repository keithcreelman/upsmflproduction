-- 0141 — Sleeper player facts, keyed by MFL player id
--
-- ⚠️ NEVER `wrangler d1 migrations apply`. Apply with:
--   npx wrangler d1 execute ups-mfl-db --remote --file worker/migrations/0141_sleeper_player_cache.sql
--
-- WHY
--   /api/player-news fetched https://api.sleeper.app/v1/players/nfl on every
--   request: 14.6 MB, 12,225 players, JSON.parse'd inside the Worker. That blows
--   the CPU budget, the surrounding try/catch is fail-soft, and sleeperIndex
--   silently stayed {} — so `sleeper_matched: 0` for EVERY player, and nobody
--   ever saw an injury status or depth-chart card. Measured 2026-08-27.
--
--   The heavy work now happens in CI (no CPU ceiling) and the Worker reads only
--   the handful of rows it needs.
--
-- MATCHING (both paths were broken, which is why this is keyed by MFL pid)
--   * gsis_id: MFL's DETAILS export returns it for 0 of 2,609 players, so the
--     primary path could never fire.
--   * name+team: MFL says KCC/GBP/SFO/TBB/NEP where Sleeper says KC/GB/SF/TB/NE,
--     so every one of those teams failed the fallback too.
--   Resolving it once, offline, means the Worker never re-derives either.
CREATE TABLE IF NOT EXISTS sleeper_player_cache (
  mfl_player_id           TEXT PRIMARY KEY,
  sleeper_player_id       TEXT,
  full_name               TEXT,
  team                    TEXT,
  injury_status           TEXT,
  injury_body_part        TEXT,
  injury_notes            TEXT,
  practice_participation  TEXT,
  practice_description    TEXT,
  depth_chart_position    TEXT,
  depth_chart_order       INTEGER,
  news_updated            INTEGER,
  matched_by              TEXT,      -- gsis | name_team | none
  built_at_utc            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sleeper_cache_team ON sleeper_player_cache (team);
