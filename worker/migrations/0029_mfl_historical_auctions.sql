-- 0029_mfl_historical_auctions.sql
-- Initial-auction wins per (season, league_id, player_id).
-- Source: nflreadpy/MFL `auctionResults` endpoint per season.
-- Loader: pipelines/etl/scripts/load_historical_lineage.py
--
-- Notes on data normalization:
--   - winning_bid is the RAW bid as MFL stored it (e.g., Ray Rice 2011 = 59009).
--     A normalized_bid column rounds to nearest $1K to handle quirks like the
--     $9 trailing on Ray Rice that traces to a forum-resolved cap-overage refund.
--   - auction_type captures 'INAUGURAL' vs 'FA_AUCTION' vs 'EXPIRED_ROOKIE' etc.

CREATE TABLE IF NOT EXISTS mfl_historical_auctions (
  season           INTEGER NOT NULL,
  league_id        TEXT    NOT NULL,
  player_id        TEXT    NOT NULL,
  franchise_id     TEXT    NOT NULL,
  winning_bid      INTEGER NOT NULL,            -- raw bid from MFL
  normalized_bid   INTEGER NOT NULL,            -- rounded to nearest $1K
  time_started     INTEGER,                     -- unix
  last_bid_time    INTEGER,                     -- unix (auction close)
  auction_type     TEXT    NOT NULL DEFAULT 'INAUGURAL',
  contract_length  INTEGER,                     -- years (when forum-derivable)
  contract_info    TEXT,                        -- e.g., "CL 3| TCV 30K| AAV 10K| Y1-10K, Y2-10K, Y3-10K"
  source           TEXT,
  notes            TEXT,
  PRIMARY KEY (season, league_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_mfl_auc_franchise ON mfl_historical_auctions (season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_mfl_auc_player ON mfl_historical_auctions (player_id, season);
