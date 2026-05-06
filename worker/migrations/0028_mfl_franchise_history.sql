-- 0028_mfl_franchise_history.sql
-- Per-(season, franchise_id) team name + owner historical record.
-- Owned by pipelines/etl/scripts/load_historical_lineage.py.
--
-- Why this exists: MFL's current `franchises` endpoint returns CURRENT names.
-- Teams renamed across years (e.g., f0008 was "Raining Bullets" in 2011 and is
-- "Bad Newz Kennels" today). This table preserves what each franchise was
-- ACTUALLY called in each season, with optional owner name.
--
-- Sources (in preference order):
--   1. src_adddrop / src_trades captured franchise_name (for 2011-2016)
--   2. site/reports/contract_history_*_owner_lineage.csv (for 2017+)
--   3. MFL league.json current name (last-resort fallback)

CREATE TABLE IF NOT EXISTS mfl_franchise_history (
  season         INTEGER NOT NULL,
  franchise_id   TEXT    NOT NULL,
  team_name      TEXT,
  owner_name     TEXT,                  -- often unknown; populate when discovered
  source         TEXT,                  -- 'src_adddrop' | 'mfl_api' | 'forum' | 'manual'
  notes          TEXT,                  -- free-text e.g. "renamed mid-season"
  PRIMARY KEY (season, franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_mfl_franchise_history_name ON mfl_franchise_history (team_name);
