-- Idempotency marker for the orphaned-thread Discord backfill sweep
-- (repairOrphanedAuctionThreads). Claimed BEFORE any Discord API call so a
-- lot is repaired at most once, even if the sweep runs twice concurrently.
ALTER TABLE ups_auction_lots ADD COLUMN discord_backfilled_at_utc TEXT;
