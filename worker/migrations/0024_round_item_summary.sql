-- 0024_round_item_summary.sql
-- After an item auto-closes + the 10-minute grace window expires, the bot
-- posts a summary announcement to the rules channel + creates a discussion
-- thread on it where the AI lays out the rule's impact on existing rules.
-- These columns track that lifecycle so we don't double-post.

ALTER TABLE discord_round_items ADD COLUMN summary_posted_at_utc TEXT;
ALTER TABLE discord_round_items ADD COLUMN summary_message_id    TEXT;
ALTER TABLE discord_round_items ADD COLUMN summary_thread_id     TEXT;

CREATE INDEX IF NOT EXISTS idx_round_items_pending_summary
  ON discord_round_items(closed_at_utc, summary_posted_at_utc);
