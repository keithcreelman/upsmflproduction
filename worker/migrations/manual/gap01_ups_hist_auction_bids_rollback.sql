-- ROLLBACK for gap01_ups_hist_auction_bids.sql (manual; NOT a migration).
-- Both tables are new and nothing else reads or writes them, so rollback is
-- dropping them. Export first if any consumer has been built since:
--   SELECT * FROM ups_hist_auctions;  SELECT * FROM ups_hist_auction_bids;
DROP INDEX IF EXISTS idx_hist_auctions_player;
DROP TABLE IF EXISTS ups_hist_auction_bids;
DROP TABLE IF EXISTS ups_hist_auctions;
