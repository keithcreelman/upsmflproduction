-- 0035_extension_master.sql
-- Current-state mirror of who has been extended in a given season.
-- Companion to ups_extension_submissions (0034) — same audit/master
-- split as the tag flow (ups_tag_submissions / ups_tag_master).
--
-- Key (league_id, season, player_id) — a player can only be extended
-- once per season (the UI's extensionBlockedByCurrentOwner guard
-- enforces this), so there's exactly one "current extension state"
-- per player-season. UPSERT semantics: if a re-extension somehow
-- lands (commish override path, etc.) the row swaps to the latest.
--
-- No DELETE path — extensions don't get "un-extended" the way tags
-- get untagged. If a player is dropped or traded post-extension, the
-- extension event itself stands; queries that care about current
-- ownership should join through to roster state separately.
--
-- Independent of (and complementary to) ups_tag_history / legacy
-- pre-2025 extension history loaded offline via scripts.

CREATE TABLE IF NOT EXISTS ups_extension_master (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id                TEXT NOT NULL,
  season                   TEXT NOT NULL,
  franchise_id             TEXT NOT NULL,        -- franchise that signed the extension
  player_id                TEXT NOT NULL,
  player_name              TEXT,
  position                 TEXT,
  new_contract_status      TEXT,
  new_salary               INTEGER,
  new_contract_year        INTEGER,
  new_contract_info        TEXT,
  extension_term_years     INTEGER,
  new_tcv                  INTEGER,
  new_aav                  INTEGER,
  new_gtd                  INTEGER,
  ext_token                TEXT,
  source                   TEXT,
  extended_at_utc          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_utc           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ext_master_player_season
  ON ups_extension_master(league_id, season, player_id);

CREATE INDEX IF NOT EXISTS idx_ext_master_franchise ON ups_extension_master(season, franchise_id);
