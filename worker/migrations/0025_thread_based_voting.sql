-- 0025_thread_based_voting.sql
-- Pivot from DM-based voting to per-rule public threads in the rules channel.
-- Each rule gets its own thread spawned off a pinned kickoff anchor message.
-- All voting + commenting + AI explainer activity happens IN the thread.
--
-- New rule (Keith 2026-05-06):
--   • At threshold-hit, the verdict is locked but voting STAYS OPEN for
--     non-voters (their late vote is recorded, doesn't change verdict).
--   • Already-cast votes lock 5 minutes after threshold-hit.
--   • All voting fully closes at /rules close (manual commish action).

-- Threshold-reached timestamp (verdict locked, vote-change lock starts ticking).
ALTER TABLE discord_round_items ADD COLUMN threshold_reached_at_utc TEXT;
-- Computed timestamp = threshold_reached_at_utc + 5 minutes.
-- Stored explicitly so the lock check is a simple SELECT vs a clock-diff calc.
ALTER TABLE discord_round_items ADD COLUMN votes_locked_at_utc TEXT;

-- Discord thread + per-thread message references.
ALTER TABLE discord_round_items ADD COLUMN discord_thread_id    TEXT;
ALTER TABLE discord_round_items ADD COLUMN proposal_message_id  TEXT;
ALTER TABLE discord_round_items ADD COLUMN tally_message_id     TEXT;

-- Cross-channel announcement when the verdict locks (passed/rejected post in
-- main channel with a deep link to the rule's thread).
ALTER TABLE discord_round_items ADD COLUMN announce_message_id  TEXT;
ALTER TABLE discord_round_items ADD COLUMN announce_channel_id  TEXT;

-- Round-level: the pinned kickoff message in the rules channel that all
-- 6 per-rule threads spawn off of.
ALTER TABLE discord_rounds ADD COLUMN kickoff_anchor_message_id TEXT;
ALTER TABLE discord_rounds ADD COLUMN kickoff_channel_id        TEXT;

-- Per-vote: the message_id of the bot's vote post in the thread, so we can
-- edit it on vote change instead of spamming a new message.
ALTER TABLE discord_responses ADD COLUMN thread_message_id TEXT;

-- Free-form comments via the 💬 Comment button. Captured separately from votes
-- so the schema stays clean (votes constrained to yes/no/abstain).
CREATE TABLE IF NOT EXISTS discord_comments (
  comment_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id          TEXT NOT NULL,
  proposal_id       TEXT NOT NULL,
  discord_user_id   TEXT NOT NULL,
  display_name      TEXT,
  body              TEXT NOT NULL,
  thread_message_id TEXT,
  created_at_utc    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discord_comments_proposal
  ON discord_comments(round_id, proposal_id, created_at_utc);

-- Index for the auto-lock sweep (find items past their 5-min vote-change window
-- that haven't been announced yet).
CREATE INDEX IF NOT EXISTS idx_round_items_threshold
  ON discord_round_items(threshold_reached_at_utc, votes_locked_at_utc);
