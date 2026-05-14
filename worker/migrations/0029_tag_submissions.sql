-- 0029_tag_submissions.sql
-- Persistent audit log of every tag / untag action submitted through
-- Roster Workbench (or any other client that hits /commish-contract-update
-- with a TAG-flavored submission). Lets us answer:
--   "Did franchise X tag player Y in season Z?"
--   "Who has been tagged and then untagged before the deadline?"
--   "What was the salary at time of tag?"
--
-- Existing surface (site/ccc/tag_submissions.json) is a static repo file
-- updated by a GitHub Actions workflow on dispatch — it has been empty for
-- 2026 because no log-tag-submission dispatch type exists. This table is
-- the worker writing directly, no workflow round-trip.

CREATE TABLE IF NOT EXISTS ups_tag_submissions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         TEXT NOT NULL,
  season            TEXT NOT NULL,
  franchise_id      TEXT NOT NULL,        -- 4-char zero-padded
  player_id         TEXT NOT NULL,
  player_name       TEXT,
  position          TEXT,
  tag_side          TEXT,                 -- 'OFFENSE' | 'DEFENSE'
  action            TEXT NOT NULL,        -- 'tag' | 'untag'
  salary            INTEGER,              -- salary at time of action (USD)
  contract_status   TEXT,                 -- 'Tag' for tag; prior status for untag
  source            TEXT,                 -- 'roster-workbench' etc.
  acting_user_id    TEXT,                 -- MFL user id who submitted
  raw_payload_json  TEXT,                 -- full request body for forensics
  submitted_at_utc  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tag_subs_season_league ON ups_tag_submissions(season, league_id);
CREATE INDEX IF NOT EXISTS idx_tag_subs_franchise     ON ups_tag_submissions(season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_tag_subs_player        ON ups_tag_submissions(season, player_id);
CREATE INDEX IF NOT EXISTS idx_tag_subs_submitted     ON ups_tag_submissions(submitted_at_utc);
