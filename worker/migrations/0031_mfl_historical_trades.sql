-- 0031_mfl_historical_trades.sql
-- Multi-asset trade event + per-asset detail.
-- Source: src_trades (which has trade comments preserved for 2011-2016 better
-- than MFL's transactions endpoint, where TRADE entries have rolled off pre-2017).
--
-- Loader: pipelines/etl/scripts/load_historical_lineage.py

CREATE TABLE IF NOT EXISTS mfl_trade_event (
  trade_id          TEXT    PRIMARY KEY,        -- season + ts + sorted franchises
  season            INTEGER NOT NULL,
  ts_unix           INTEGER NOT NULL,
  ts_iso            TEXT,
  franchises_csv    TEXT,                       -- CSV of franchise_ids involved
  comments          TEXT,                       -- preserved chat from src_trades
  source            TEXT
);
CREATE INDEX IF NOT EXISTS idx_trade_season ON mfl_trade_event (season);

CREATE TABLE IF NOT EXISTS mfl_trade_asset (
  trade_id          TEXT    NOT NULL,
  asset_seq         INTEGER NOT NULL,           -- 1..N within the trade
  franchise_id      TEXT    NOT NULL,
  asset_role        TEXT    NOT NULL,           -- 'ACQUIRE' | 'RELINQUISH'
  asset_type        TEXT    NOT NULL,           -- 'PLAYER' | 'DRAFTPICK_FUTURE' | 'DRAFTPICK_CURRENT' | 'CASH' | 'OTHER'
  player_id         TEXT,                       -- when asset_type=PLAYER
  pick_descriptor   TEXT,                       -- when asset_type=DRAFTPICK_*
  PRIMARY KEY (trade_id, asset_seq)
);
CREATE INDEX IF NOT EXISTS idx_trade_asset_player ON mfl_trade_asset (player_id);
CREATE INDEX IF NOT EXISTS idx_trade_asset_franchise ON mfl_trade_asset (franchise_id, trade_id);
