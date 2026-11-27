-- GAP-01 PROPOSED SCHEMA: historical auction bids, 2014-2025. NOT APPLIED.
--
-- Manual file, not a numbered migration, so `wrangler d1 migrations apply`
-- cannot pick it up. It becomes a numbered migration (or a one-time
-- `d1 execute --file`) only after Keith's explicit go for that write.
-- Rollback: gap01_ups_hist_auction_bids_rollback.sql (drops both tables).
--
-- Why new tables: ups_auction_history keeps one summary row per auction as
-- MFL's O=102 report lists it, and that report shows one auction per player
-- per season, so a player auctioned twice in a season (May ERA, then the
-- July/August FA auction) loses one auction (GAP-02). ups_auction_bids /
-- ups_auction_lots belong to the live 2026 auction poller and key by
-- (season, league, player), the same flaw. These tables key by AUCTION:
-- season + player + the auction's first logged event.
--
-- Loader and reconciliation: pipelines/etl/scripts/dryrun_gap01_auction_bids.py
-- Report: docs/data_fixes/2026-10-22-gap01-auction-bids-reconciliation.md
--
-- PRIVACY: no comment text. MFL's "<team> forced bid increase" note is
-- stored only as forced = 1 + forcing_fid; owner-written comments are dropped.
--
-- Final price vs bids: the price is ups_hist_auctions.winning_bid (MFL's
-- AUCTION_WON). In 2014-2016 a bid row's amount is the owner's entered maximum
-- (amount_meaning = entered_max), so a top bid above the price is normal there.

-- One row per auction, including bidding MFL never awarded (outcome = 'no_win':
-- cancelled, or abandoned before MFL's lock closed it).
CREATE TABLE IF NOT EXISTS ups_hist_auctions (
  season            INTEGER NOT NULL,
  player_id         TEXT    NOT NULL,  -- MFL player id exactly as MFL writes it (TEXT, as ups_auction_history)
  started_at_unix   INTEGER NOT NULL,  -- the auction's first logged event (INIT, or the opening BID before 2019)
  league_id         TEXT    NOT NULL,
  start_basis       TEXT    NOT NULL,  -- nomination (AUCTION_INIT, 2019+) | mfl_report (O=102 start, +-1 min)
                                       -- | first_logged_bid (2016 and undated bidding: not independently confirmed)
  split_reason      TEXT    NOT NULL,  -- nomination | new_nomination | first_bid | mfl_report_start | idle_over_lock
  opened_by_fid     TEXT,
  opening_bid       INTEGER,
  last_bid_at_unix  INTEGER,           -- duration = last_bid_at_unix - started_at_unix (MFL's definition; excludes the lock)
  outcome           TEXT    NOT NULL,  -- won | no_win
  won_at_unix       INTEGER,           -- joins ups_auction_history (season, league_id, player_id, won_at_unix)
  winner_fid        TEXT,
  winning_bid       INTEGER,           -- MFL AUCTION_WON amount (the price)
  bid_count         INTEGER NOT NULL,  -- INIT + BID rows in ups_hist_auction_bids
  price_check       TEXT    NOT NULL,  -- how winning_bid ties back to the logged bids:
                                       --   last_bid (2017+: the last row is the winner at the price)
                                       --   proxy_replay (2014-2016: replaying MFL's proxy rules over the rows gives it)
                                       --   unexplained (the rows do NOT reproduce MFL's price: Jamison Crowder 2016)
                                       --   none (no_win)
  caveat            TEXT,              -- NULL, or ';'-joined flags a story must not state as fact:
                                       --   start_unconfirmed (start_basis = first_logged_bid)
                                       --   price_unexplained (price_check = unexplained)
                                       --   unreadable_amount (a row whose amount MFL wrote as text, e.g. '19000-4')
  auction_kind      TEXT    NOT NULL,  -- ERA (closes by June) | FAA (July on), as ups_auction_history
  log_semantics     TEXT    NOT NULL,  -- every_bid (2014-2016: every bid placed, at the bidder's entered maximum)
                                       -- | lead_changes (2017+: a bid that took the lead, or a forced proxy raise)
  source            TEXT    NOT NULL,  -- mfl_txlog
  PRIMARY KEY (season, player_id, started_at_unix)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_hist_auctions_player ON ups_hist_auctions(player_id, season);

-- One row per MFL AUCTION_INIT / AUCTION_BID event, in time order.
CREATE TABLE IF NOT EXISTS ups_hist_auction_bids (
  season            INTEGER NOT NULL,
  player_id         TEXT    NOT NULL,
  started_at_unix   INTEGER NOT NULL,  -- the auction (ups_hist_auctions key)
  seq               INTEGER NOT NULL,  -- 1 = the opening bid
  event             TEXT    NOT NULL,  -- init | bid
  fid               TEXT    NOT NULL,  -- franchise MFL credits with the row
  amount            INTEGER,           -- MFL's amount; NULL only where MFL wrote an unreadable amount (2 rows in 2014: '19000-4')
  amount_meaning    TEXT    NOT NULL,  -- entered_max (2014-2016: the maximum the owner entered; NOT a price)
                                       -- | price_after_bid (2017+: the high bid once this row took effect)
  amount_raw        TEXT,              -- MFL's amount text, kept only when it is not a plain integer ('40000.00', '19000-4')
  bid_at_unix       INTEGER NOT NULL,
  forced            INTEGER NOT NULL DEFAULT 0,  -- 1 = MFL raised this leader's proxy because a rival bid
  forcing_fid       TEXT,              -- the rival, resolved from MFL's team name; NULL if the name did not resolve
  PRIMARY KEY (season, player_id, started_at_unix, seq)
) WITHOUT ROWID;
