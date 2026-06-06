-- 0075_ups_transactions.sql
-- Unified D1 ledger of EVERY MFL transaction (Keith 2026-06-05: "we need ALL
-- transactions in D1"). Today drops live in ups_drop_events and auctions in
-- ups_auction_*, but trades / adds / waivers / taxi / IR have no unified table.
-- A 5-min cron pulls MFL TYPE=transactions and INSERT-OR-IGNOREs every row here
-- (dedup on the synthesized mfl_txn_id). Stage 2 reads discord_posted=0 rows to
-- fire per-type Discord posts (taxi GIF + weeks counter, IR injury GIF, adds).
--
-- Transaction types seen in MFL: TRADE, FREE_AGENT (add/drop), BBID_WAIVER /
-- WAIVER / BBID_AUTO_PROCESS_WAIVERS, TAXI (promote/demote), IR
-- (activate/deactivate), AUCTION_* (already in ups_auction_*), and admin
-- (LOCK/UNLOCK/LOAD — stored but never posted).

CREATE TABLE IF NOT EXISTS ups_transactions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  mfl_txn_id          TEXT NOT NULL UNIQUE,   -- season:type:ts:franchise:sig (dedup key)
  league_id           TEXT NOT NULL,
  season              TEXT NOT NULL,
  type                TEXT NOT NULL,          -- TRADE / FREE_AGENT / TAXI / IR / BBID_WAIVER / ...
  unix_timestamp      INTEGER,
  datetime_et         TEXT,
  franchise_id        TEXT,                   -- primary franchise (4-char zero-padded)
  franchise_id2       TEXT,                   -- second franchise on TRADE
  added_players       TEXT,                   -- comma player ids (parsed per type)
  dropped_players     TEXT,                   -- comma player ids
  raw_json            TEXT NOT NULL,          -- full MFL transaction object
  discord_posted      INTEGER NOT NULL DEFAULT 0,
  discord_message_id  TEXT,
  posted_at           TEXT,
  recorded_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_txn_season_league ON ups_transactions(season, league_id);
CREATE INDEX IF NOT EXISTS idx_txn_type          ON ups_transactions(type, season);
CREATE INDEX IF NOT EXISTS idx_txn_ts            ON ups_transactions(unix_timestamp);
CREATE INDEX IF NOT EXISTS idx_txn_unposted      ON ups_transactions(discord_posted, season);
