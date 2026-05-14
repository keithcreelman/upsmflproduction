-- 0034_extension_submissions.sql
-- Persistent audit log of every extension submitted via Roster Workbench
-- (or any other client that POSTs /commish-contract-update with
-- submission_kind = "extension"). Tag-flow parity — companion to
-- ups_tag_submissions (0029) / ups_tag_master (0030).
--
-- Why we need this in addition to the generic salary_change_log:
--   • salary_change_log captures ALL contract mutations (tags,
--     restructures, manual updates, sync corrections, etc.) lumped
--     together. Filtering for "just extensions" requires joining on
--     submission_kind / contract_status patterns that are easy to
--     get wrong.
--   • This table is extension-only, structured, and forensics-ready
--     (raw_payload_json captured for every row).
--
-- Skipping 0033 to leave room for the standings-session migration
-- queued on branch claude/goofy-mcclintock-134dcc.

CREATE TABLE IF NOT EXISTS ups_extension_submissions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id                TEXT NOT NULL,
  season                   TEXT NOT NULL,
  franchise_id             TEXT NOT NULL,        -- 4-char zero-padded
  player_id                TEXT NOT NULL,
  player_name              TEXT,
  position                 TEXT,
  prior_contract_status    TEXT,                 -- e.g., 'Rookie', 'Veteran', 'EXT1'
  prior_salary             INTEGER,
  prior_contract_year      INTEGER,              -- years-remaining at time of submission
  prior_contract_info      TEXT,                 -- raw contractInfo string before extension
  new_contract_status      TEXT,                 -- e.g., 'EXT1', 'EXT2', 'Vet - Auction (FL)'
  new_salary               INTEGER,              -- year-1 salary post-extension
  new_contract_year        INTEGER,
  new_contract_info        TEXT,                 -- raw contractInfo string after extension
  extension_term_years     INTEGER,              -- years added to the contract
  new_tcv                  INTEGER,
  new_aav                  INTEGER,
  new_gtd                  INTEGER,
  ext_token                TEXT,                 -- owner shorthand from "Ext: AB, CD"
  source                   TEXT,                 -- 'roster-workbench' etc.
  acting_user_id           TEXT,
  raw_payload_json         TEXT,                 -- full request body for forensics
  submitted_at_utc         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ext_subs_season_league  ON ups_extension_submissions(season, league_id);
CREATE INDEX IF NOT EXISTS idx_ext_subs_franchise      ON ups_extension_submissions(season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_ext_subs_player         ON ups_extension_submissions(season, player_id);
CREATE INDEX IF NOT EXISTS idx_ext_subs_submitted      ON ups_extension_submissions(submitted_at_utc);
