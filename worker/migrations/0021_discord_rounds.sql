-- 0021_discord_rounds.sql
-- UPS League Hall — Discord bot rounds + per-owner state + outbox queue.
--
-- A "round" = one batch of items the commish puts to the league.
-- Each round has a draft-date anchor; voting closes 7 days before the draft;
-- proposal-submission closes 14 days before voting closes.
-- Per-owner state lets owners pause + resume on their own schedule.
-- The dm_outbox queue throttles fanout to respect Discord's DM rate limits.

CREATE TABLE IF NOT EXISTS discord_rounds (
  round_id                       TEXT PRIMARY KEY,
  title                          TEXT NOT NULL,
  status                         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  started_at_utc                 TEXT NOT NULL,
  started_by                     TEXT,
  draft_date_utc                 TEXT,
  voting_deadline_utc            TEXT,
  proposal_submission_closes_at  TEXT,
  test_only                      INTEGER NOT NULL DEFAULT 0,
  closed_at_utc                  TEXT,
  broadcast_channel_id           TEXT,
  final_summary_json             TEXT
);

CREATE TABLE IF NOT EXISTS discord_round_items (
  round_id      TEXT NOT NULL REFERENCES discord_rounds(round_id) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,
  proposal_id   TEXT NOT NULL REFERENCES hall_proposals(id),
  PRIMARY KEY (round_id, ordinal)
);

CREATE TABLE IF NOT EXISTS discord_round_owners (
  round_id              TEXT NOT NULL REFERENCES discord_rounds(round_id) ON DELETE CASCADE,
  discord_user_id       TEXT NOT NULL,
  franchise_id          TEXT,
  display_name          TEXT,
  state                 TEXT NOT NULL DEFAULT 'not_started' CHECK (state IN ('not_started', 'in_progress', 'done', 'declined')),
  current_ordinal       INTEGER,
  last_active_utc       TEXT,
  nudges_sent           INTEGER NOT NULL DEFAULT 0,
  last_nudge_utc        TEXT,
  bot_dm_channel_id     TEXT,
  bot_thread_message_ids TEXT,
  PRIMARY KEY (round_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS idx_round_owners_state ON discord_round_owners(round_id, state);
CREATE INDEX IF NOT EXISTS idx_round_owners_nudge ON discord_round_owners(state, last_nudge_utc);

CREATE TABLE IF NOT EXISTS discord_responses (
  response_id       INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id          TEXT NOT NULL,
  proposal_id       TEXT NOT NULL,
  discord_user_id   TEXT NOT NULL,
  value             TEXT NOT NULL CHECK (value IN ('yes', 'no', 'abstain')),
  reasoning         TEXT,
  source            TEXT NOT NULL DEFAULT 'discord_bot',
  created_at_utc    TEXT NOT NULL,
  superseded_at_utc TEXT
);

CREATE INDEX IF NOT EXISTS idx_discord_responses_proposal
  ON discord_responses(proposal_id, superseded_at_utc);
CREATE INDEX IF NOT EXISTS idx_discord_responses_owner
  ON discord_responses(round_id, discord_user_id, proposal_id, superseded_at_utc);

-- One active response per (round, proposal, owner). Older votes get
-- superseded_at_utc set before a new INSERT (matches the hall_responses pattern).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_discord_active_vote
  ON discord_responses(round_id, proposal_id, discord_user_id)
  WHERE superseded_at_utc IS NULL;

CREATE TABLE IF NOT EXISTS discord_owner_proposals (
  owner_proposal_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  submitted_by_discord_id  TEXT NOT NULL,
  submitted_at_utc         TEXT NOT NULL,
  raw_text                 TEXT NOT NULL,
  aligned_to_rule          TEXT,
  alignment_confidence     REAL,
  suggested_title          TEXT,
  suggested_tldr           TEXT,
  suggested_body_md        TEXT,
  classification           TEXT CHECK (classification IS NULL OR classification IN ('minor', 'major', 'unknown')),
  status                   TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'approved', 'rejected', 'edited')),
  commish_note             TEXT,
  reviewed_at_utc          TEXT,
  promoted_to_proposal_id  TEXT REFERENCES hall_proposals(id)
);
CREATE INDEX IF NOT EXISTS idx_owner_proposals_status
  ON discord_owner_proposals(status, submitted_at_utc);

CREATE TABLE IF NOT EXISTS discord_dm_outbox (
  outbox_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id   TEXT NOT NULL,
  round_id          TEXT,
  payload_json      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  scheduled_for_utc TEXT NOT NULL,
  sent_at_utc       TEXT,
  last_error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_dm_outbox_pending
  ON discord_dm_outbox(status, scheduled_for_utc);
