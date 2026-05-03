-- 0030_mfl_historical_transactions.sql
-- Canonical league transaction log. Combines MFL `transactions` endpoint
-- with src_adddrop / src_trades cross-validation.
-- Loader: pipelines/etl/scripts/load_historical_lineage.py
--
-- One row per transaction event (NOT per asset). Multi-asset trades are
-- represented in mfl_historical_trades (separate table for trade groups).
--
-- type values seen in MFL 2011:
--   AUCTION_WON, BBID_WAIVER, BBID_AUTO_PROCESS_WAIVERS, FREE_AGENT, WAIVER,
--   IR, LOAD_ROSTERS, TRADE, PROCESS_WAIVERS
--
-- player_in/player_out parsed from MFL `transaction` field (pipe-delimited).

CREATE TABLE IF NOT EXISTS mfl_historical_transactions (
  season         INTEGER NOT NULL,
  txn_uid        TEXT    NOT NULL,           -- season + ts + franchise + type hash for uniqueness
  type           TEXT    NOT NULL,
  ts_unix        INTEGER NOT NULL,
  ts_iso         TEXT,
  franchise_id   TEXT,
  player_in_id   TEXT,                       -- player added (null for trades — see trades table)
  player_out_id  TEXT,                       -- player dropped (null for adds-only)
  salary         INTEGER,                    -- player_in salary if applicable
  source         TEXT,                       -- 'mfl_api' | 'src_adddrop' | 'src_trades' | 'forum_load_rosters'
  raw_payload    TEXT,                       -- original transaction string for audit
  PRIMARY KEY (season, txn_uid)
);
CREATE INDEX IF NOT EXISTS idx_txn_franchise ON mfl_historical_transactions (season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_txn_player_in ON mfl_historical_transactions (player_in_id, season);
CREATE INDEX IF NOT EXISTS idx_txn_player_out ON mfl_historical_transactions (player_out_id, season);
CREATE INDEX IF NOT EXISTS idx_txn_type ON mfl_historical_transactions (season, type);
