-- 0020_hall_schema.sql
-- UPS League Hall — owner-facing proposals + responses (Phase 1).
--
-- A proposal is one governance item Keith publishes. Each item has a type:
--   'fyi'       — informational; owners hit a single "ack" button
--   'sentiment' — advisory thumbs up/down/meh + optional one-liner
--   'vote'      — formal Yes/No/Abstain with quorum + threshold (locked once cast)
--
-- A response is one owner's interaction with one proposal. Identity is
-- deferred (Phase 3 of the plan) — v1 captures optional self-reported
-- name + Discord handle, plus an opaque session_token cookie + IP hash
-- for soft de-duplication. The schema is identity-ready: nullable
-- franchise_id / discord_user_id / magic_link_token columns let us
-- backfill attribution later without a migration.

CREATE TABLE IF NOT EXISTS hall_proposals (
  id                            TEXT PRIMARY KEY,            -- slug, e.g. 'realignment-historical-allplay'
  title                         TEXT NOT NULL,
  type                          TEXT NOT NULL CHECK (type IN ('fyi', 'sentiment', 'vote')),
  status                        TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'passed', 'rejected')) DEFAULT 'draft',
  category                      TEXT,                        -- optional grouping ('realignment', 'superflex', etc.)
  tldr                          TEXT,                        -- 1-2 sentence summary
  body_md                       TEXT NOT NULL,               -- full proposal body (markdown)
  deadline_utc                  TEXT,                        -- ISO timestamp; NULL = no deadline
  quorum_min                    INTEGER NOT NULL DEFAULT 8,  -- vote-type only; min responses for valid vote
  threshold_yes_pct             INTEGER NOT NULL DEFAULT 60, -- vote-type only; % yes (of yes+no, abstain excluded)
  discord_announce_channel_id   TEXT,                        -- where the announcement was posted
  discord_announce_message_id   TEXT,                        -- so we can edit it on close
  created_at_utc                TEXT NOT NULL,
  created_by                    TEXT,                        -- author label (Keith/commish)
  closed_at_utc                 TEXT,
  final_tally_json              TEXT                         -- snapshot of tally at close time
);

CREATE INDEX IF NOT EXISTS idx_hall_proposals_status ON hall_proposals(status);
CREATE INDEX IF NOT EXISTS idx_hall_proposals_type ON hall_proposals(type);

-- Each row = one interaction. A single session may produce multiple rows
-- across proposals. Vote-type proposals enforce one-active-vote-per-session
-- via the partial unique index below. Sentiment/comment rows are not
-- de-duplicated at the schema level; the route handler caps how often a
-- given session may post.
CREATE TABLE IF NOT EXISTS hall_responses (
  response_id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id                   TEXT NOT NULL REFERENCES hall_proposals(id) ON DELETE CASCADE,
  response_kind                 TEXT NOT NULL CHECK (response_kind IN ('ack', 'sentiment', 'vote', 'comment')),
  value                         TEXT,                        -- vote: yes|no|abstain ; sentiment: up|down|meh ; ack: 'ack' ; comment: NULL
  comment_text                  TEXT,                        -- optional rider on sentiment/vote, or full body for comment
  responder_name                TEXT,                        -- self-reported, optional
  responder_discord_handle      TEXT,                        -- self-reported, optional
  responder_ip_hash             TEXT,                        -- sha256(ip + salt); throttle key, no PII stored
  session_token                 TEXT,                        -- opaque cookie token
  franchise_id                  TEXT,                        -- nullable; populated when identity layer lands
  discord_user_id               TEXT,                        -- nullable; populated when identity layer lands
  magic_link_token              TEXT,                        -- nullable; populated when identity layer lands
  user_agent_short              TEXT,                        -- truncated UA for forensic visibility (no full UA)
  superseded_at_utc             TEXT,                        -- non-null = this row was overwritten by a later one
  created_at_utc                TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hall_responses_proposal ON hall_responses(proposal_id, response_kind);
CREATE INDEX IF NOT EXISTS idx_hall_responses_session ON hall_responses(session_token);
CREATE INDEX IF NOT EXISTS idx_hall_responses_iphash ON hall_responses(responder_ip_hash);

-- One active vote per session per proposal. Older votes get superseded
-- (UPDATE … SET superseded_at_utc=…) before a new vote is INSERTed, so
-- the partial unique index over (active vote rows only) holds.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_hall_active_vote_session
  ON hall_responses(proposal_id, session_token)
  WHERE response_kind = 'vote' AND superseded_at_utc IS NULL AND session_token IS NOT NULL;
