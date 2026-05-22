-- ── 0050_auction_lots_bids.sql ───────────────────────────────────────
-- D1 schema for the UPS Auction Hub's live state pipeline.
--
-- Data flow:
--   1. Cron polls MFL TYPE=transactions&TRANS_TYPE=AUCTION_BID every 5min.
--   2. Each bid → upsert into ups_auction_bids (UNIQUE constraint dedupes).
--   3. Each bid → upsert ups_auction_lots (first bid creates the lot;
--      subsequent bids update current_high_bid_k / locks_at_unix).
--   4. Cron also polls TRANS_TYPE=AUCTION_WON → mark lots status='won'.
--   5. /api/auction/lots reads from these tables.
--
-- "First bid" = nomination. lot.opening_bid_k + lot.nominator_fid come
-- from that first bid.
--
-- Locks at = last_bid_at + 36hr (per league_context_v1.md §A3).
-- ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ups_auction_lots (
  lot_id                  TEXT PRIMARY KEY,    -- season|league_id|player_id
  season                  INTEGER NOT NULL,
  league_id               TEXT NOT NULL,
  player_id               TEXT NOT NULL,
  nominator_fid           TEXT NOT NULL,
  opening_bid_k           INTEGER NOT NULL,
  opened_at_unix          INTEGER NOT NULL,
  current_high_bid_k      INTEGER NOT NULL,
  current_high_bidder_fid TEXT NOT NULL,
  last_bid_at_unix        INTEGER NOT NULL,
  locks_at_unix           INTEGER NOT NULL,    -- last_bid_at + 36hr
  status                  TEXT NOT NULL DEFAULT 'open',  -- open | won
  winner_fid              TEXT,
  won_at_unix             INTEGER,
  bid_count               INTEGER NOT NULL DEFAULT 1,
  unique_bidder_count     INTEGER NOT NULL DEFAULT 1,
  created_at_utc          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_utc          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ups_auction_lots_season_status
  ON ups_auction_lots(season, league_id, status);
CREATE INDEX IF NOT EXISTS idx_ups_auction_lots_locks_at
  ON ups_auction_lots(locks_at_unix);

CREATE TABLE IF NOT EXISTS ups_auction_bids (
  bid_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  lot_id          TEXT NOT NULL,
  season          INTEGER NOT NULL,
  league_id       TEXT NOT NULL,
  player_id       TEXT NOT NULL,
  fid             TEXT NOT NULL,
  bid_k           INTEGER NOT NULL,
  bid_at_unix     INTEGER NOT NULL,
  note            TEXT,                -- MFL annotations e.g. "X forced bid increase"
  raw_transaction TEXT,                -- original pipe-string for audit
  created_at_utc  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Dedupe across re-polls. MFL's timestamps are second-precision; in
  -- practice no two distinct bids land in the same second from the
  -- same franchise on the same lot at the same amount, so this is
  -- sufficient.
  UNIQUE(lot_id, fid, bid_at_unix, bid_k)
);
CREATE INDEX IF NOT EXISTS idx_ups_auction_bids_lot
  ON ups_auction_bids(lot_id);
CREATE INDEX IF NOT EXISTS idx_ups_auction_bids_at
  ON ups_auction_bids(bid_at_unix);

-- Owner-private proxy bids. MFL shows each owner THEIR own proxy max;
-- we mirror that visibility (never expose other owners' proxies).
-- Read access is gated by franchise_id in the /api/auction/lots route.
CREATE TABLE IF NOT EXISTS ups_auction_proxy_bids (
  proxy_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  season          INTEGER NOT NULL,
  league_id       TEXT NOT NULL,
  fid             TEXT NOT NULL,
  player_id       TEXT NOT NULL,
  proxy_bid_k     INTEGER NOT NULL,
  set_at_unix     INTEGER NOT NULL,
  created_at_utc  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_utc  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(season, league_id, fid, player_id)
);
CREATE INDEX IF NOT EXISTS idx_ups_auction_proxy_fid
  ON ups_auction_proxy_bids(season, league_id, fid);

-- Tracks Discord posts per lot so we can update threads on subsequent
-- bids (Phase 2). Indexed by lot_id so the bot can find the existing
-- thread to reply to instead of starting a new one each time.
CREATE TABLE IF NOT EXISTS ups_auction_discord_threads (
  thread_id           TEXT PRIMARY KEY,         -- Discord thread ID
  lot_id              TEXT NOT NULL,
  channel_id          TEXT NOT NULL,            -- Discord channel ID
  root_message_id     TEXT NOT NULL,            -- the original nomination post
  last_bid_message_id TEXT,                     -- most recent reply
  created_at_utc      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lot_id)
);
