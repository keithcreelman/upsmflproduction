-- 0052_auction_cancelled.sql
--
-- MFL doesn't emit a transaction when commish deletes/cancels an auction
-- lot (verified 2026-05-20 via TYPE=transactions export: only
-- AUCTION_INIT, AUCTION_BID, AUCTION_WON ever appear). Without
-- reconciliation, deleted lots stick around as "open" in our D1
-- forever and surface as live lots in the Hub.
--
-- processAuctionPoll now reconciles after the standard ingest:
-- fetches the live O=43 page via MFL_COOKIE, parses out the currently-
-- displayed open player_ids, and marks any of our "open" lots whose
-- player_id ISN'T in the live list as 'cancelled'. This column captures
-- WHEN that reconciliation marked the lot dead so we can audit later.

ALTER TABLE ups_auction_lots ADD COLUMN cancelled_at_unix INTEGER;
