-- 0025_transactions_auction.sql
-- Per-bid auction history. Each row is one MFL transaction event:
--   auction_event_type   INIT | BID | WON
--   transaction_type     OpeningBid | Bid | WinningBid
--
-- Sourced from local SQLite mfl_database.db via
-- pipelines/etl/scripts/fetch_transactions_auction.py.
--
-- Schema mirrors the local table 1:1 so existing analyses ported from
-- local can run unchanged against D1. PK is `transactionid` (MFL global
-- unique). The (season, franchise_id) index serves Layer 4 owner-pattern
-- queries; the (season, auction_group_id) index serves the simulator
-- when reconstructing per-player bid sequences.

CREATE TABLE IF NOT EXISTS transactions_auction (
  transactionid                   TEXT PRIMARY KEY,
  season                          INTEGER NOT NULL,
  txn_index                       INTEGER NOT NULL,

  auction_group_id                TEXT NOT NULL,    -- '<season>:<player_id>'
  auction_event_type              TEXT NOT NULL,    -- INIT | BID | WON
  transaction_type                TEXT NOT NULL,    -- OpeningBid | Bid | WinningBid
  bid_sequence                    INTEGER NOT NULL,

  player_id                       TEXT NOT NULL,
  player_name                     TEXT,
  position                        TEXT,
  nfl_team                        TEXT,

  franchise_id                    TEXT,
  team_name                       TEXT,
  owner_name                      TEXT,

  franchise_currentbid_id         TEXT,
  franchise_currentbid_team_name  TEXT,
  franchise_currentbid_owner_name TEXT,

  franchise_forcing_id            TEXT,
  franchise_forcing_team_name     TEXT,
  franchise_forcing_owner_name    TEXT,

  bid_amount                      INTEGER,
  initialbid_ind                  INTEGER DEFAULT 0,
  finalbid_ind                    INTEGER DEFAULT 0,
  forced_bid_ind                  INTEGER DEFAULT 0,

  auction_type                    TEXT,
  unix_timestamp                  INTEGER,
  datetime_et                     TEXT,
  date_et                         TEXT,
  time_et                         TEXT,

  auction_start_ts                INTEGER,
  seconds_since_start             INTEGER,
  seconds_since_prev_bid          INTEGER,

  comment_raw                     TEXT,
  raw_json                        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txn_auction_season_franchise
  ON transactions_auction (season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_txn_auction_group
  ON transactions_auction (season, auction_group_id);
CREATE INDEX IF NOT EXISTS idx_txn_auction_winning
  ON transactions_auction (season, finalbid_ind, position);
