-- 0051_auction_discord_thread.sql
--
-- Phase Y: thread each lot's bid history into its own Discord thread
-- (instead of flat channel spam). The narrator posts the nomination
-- as a parent message in the channel, creates a Discord thread from
-- that message, then posts subsequent bid/forced/overtake/won events
-- into the thread.
--
-- discord_thread_id: Discord snowflake of the thread (channel-equivalent
--                    for the per-lot bid history). Set on first
--                    nomination narration; immutable afterward.
-- discord_message_id: id of the parent message in the main channel
--                     that anchors the thread (helpful for later
--                     editing / cleanup).
-- discord_channel_id: the channel the parent message was posted to
--                     (so we know if test vs prod, useful for replay).

ALTER TABLE ups_auction_lots ADD COLUMN discord_thread_id TEXT;
ALTER TABLE ups_auction_lots ADD COLUMN discord_message_id TEXT;
ALTER TABLE ups_auction_lots ADD COLUMN discord_channel_id TEXT;

CREATE INDEX IF NOT EXISTS idx_auction_lots_discord_thread
  ON ups_auction_lots(discord_thread_id);
