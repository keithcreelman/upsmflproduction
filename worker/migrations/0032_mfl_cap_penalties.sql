-- 0032_mfl_cap_penalties.sql
-- Team-level cap-penalty events + per-player itemization.
-- Sources:
--   - Pre-2017: forum manual posts (parsed from
--     services/rulebook/sources/rules/mfl_message_boards/manual/{year}_messageboard.txt)
--   - 2017+: site/reports/contract_history_*.csv has dropped_under_contract details
--
-- Loader: pipelines/etl/scripts/load_historical_lineage.py
--
-- Single source of truth for cap penalties. The 11 teams' 2011 final cap-hits
-- (per Jan 8, 2012 forum post) get loaded here.

CREATE TABLE IF NOT EXISTS mfl_cap_penalty_event (
  event_id         TEXT    PRIMARY KEY,         -- season + franchise_id + post_date
  season           INTEGER NOT NULL,
  franchise_id     TEXT    NOT NULL,
  total_cut_amount INTEGER,                     -- sum of all contracts cut (whole $)
  cap_hit_amount   INTEGER,                     -- actual cap penalty applied
  cap_hit_pct      REAL,                        -- percentage rate (e.g., 0.20 for 20%)
  post_date        TEXT,                        -- date of forum/admin post (ISO)
  is_final         INTEGER NOT NULL DEFAULT 1,  -- 0 = mid-season provisional, 1 = final
  source           TEXT,                        -- 'forum_manual' | 'mfl_api' | 'manual'
  source_citation  TEXT,                        -- e.g., "manual/2011_messageboard.txt:304"
  raw_text         TEXT
);
CREATE INDEX IF NOT EXISTS idx_cap_penalty_franchise ON mfl_cap_penalty_event (season, franchise_id);

CREATE TABLE IF NOT EXISTS mfl_cap_penalty_player (
  event_id         TEXT    NOT NULL,
  player_id        TEXT,                        -- nullable when player not yet matched
  player_text      TEXT    NOT NULL,            -- raw "Brandon Pettigrew 2 yrs $8K per yr"
  contract_length  INTEGER,                     -- years
  salary_per_yr    INTEGER,                     -- annual $
  total_value      INTEGER,                     -- length * salary_per_yr
  PRIMARY KEY (event_id, player_text)
);
CREATE INDEX IF NOT EXISTS idx_cap_penalty_player_id ON mfl_cap_penalty_player (player_id);
