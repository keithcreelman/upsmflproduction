-- Voided (rule-illegal) auction nominations.
-- MFL's AUCTION_* transaction log is APPEND-ONLY: deleting the auction lot in
-- MFL does NOT remove the AUCTION_INIT transaction (verified 2026-07-26, Tony
-- Pollard / C-Town). Without this table the nomination keeps counting against
-- the owner's 2-per-day and the poller re-ingests the lot every 5 minutes.
-- A row here makes the nomination vanish from the daily count AND the board,
-- while preserving the Discord thread so the history and any later legal
-- nomination of the same player append to the same thread.
CREATE TABLE IF NOT EXISTS ups_auction_void_noms (
  season             TEXT NOT NULL,
  league_id          TEXT NOT NULL,
  player_id          TEXT NOT NULL,
  franchise_id       TEXT,
  reason             TEXT,
  discord_thread_id  TEXT,
  discord_message_id TEXT,
  discord_channel_id TEXT,
  voided_at_utc      TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (season, league_id, player_id)
);
