-- 0102_trade_sentinel.sql
-- Trade-offer sentinel: commish-side mirror of EVERY pending MFL offer
-- (in-app AND native-desktop), the invalidation/re-offer state machine,
-- and the trade_offer_dm columns for the 14-day extension + DM editing.
--
-- Keith 2026-07-15: offers get an effective 14-day life (silent re-offer at
-- day ~6.5, no new Day-1 blast, nudge clock continues), and an offer whose
-- assets moved in ANOTHER executed trade dies everywhere — revoked on MFL,
-- nudges stopped, buttons killed, one death DM to the recipient.

CREATE TABLE IF NOT EXISTS ups_trade_offer_watch (
  trade_id            TEXT PRIMARY KEY,          -- current MFL trade id (digits)
  league_id           TEXT NOT NULL,
  season              TEXT NOT NULL,
  from_franchise_id   TEXT NOT NULL,             -- originator (padded)
  to_franchise_id     TEXT NOT NULL,
  will_give_up        TEXT,                      -- raw MFL token CSV (offerer side)
  will_receive        TEXT,                      -- raw MFL token CSV (recipient side)
  comments            TEXT,
  mfl_timestamp       INTEGER,                   -- MFL offer unix ts
  expires_unix        INTEGER,                   -- parsed from pendingTrades when present
  first_seen_utc      TEXT NOT NULL,
  last_seen_utc       TEXT,                      -- last tick this id appeared in pendingTrades
  origin              TEXT NOT NULL DEFAULT 'discovered'
                        CHECK (origin IN ('inapp','discovered')),
  lifecycle           TEXT NOT NULL DEFAULT 'pending'
                        CHECK (lifecycle IN ('pending','reoffer_in_progress','reoffered',
                                             'invalidated','revoke_failed','gone','expired')),
  anchor_utc          TEXT NOT NULL,             -- ORIGINAL clock for all 14d math; never moves
  reoffer_of          TEXT,                      -- parent trade_id (this row IS the day-7 re-offer)
  reoffered_trade_id  TEXT,                      -- child trade_id (this row WAS re-offered)
  invalidated_reason  TEXT,                      -- e.g. asset_moved:FP_0004_2027_1:will_receive:0007
  invalidated_asset   TEXT,
  act_log             TEXT,                      -- JSON array of MFL actions taken (or dry-run would-dos)
  updated_at_utc      TEXT
);
CREATE INDEX IF NOT EXISTS idx_totw_lifecycle
  ON ups_trade_offer_watch(league_id, season, lifecycle);

-- trade_offer_dm extensions (SQLite: one column per ALTER).
ALTER TABLE trade_offer_dm ADD COLUMN extended INTEGER NOT NULL DEFAULT 0;         -- 1 = 14-day life
ALTER TABLE trade_offer_dm ADD COLUMN reoffer_pending INTEGER NOT NULL DEFAULT 0;  -- id-swap shield for both reconcilers
ALTER TABLE trade_offer_dm ADD COLUMN origin TEXT NOT NULL DEFAULT 'inapp';        -- 'inapp'|'discovered'
ALTER TABLE trade_offer_dm ADD COLUMN dm_message_ids TEXT;                         -- CSV "channelId:messageId" of EVERY DM sent (void-editing)
ALTER TABLE trade_offer_dm ADD COLUMN death_dm_pending INTEGER NOT NULL DEFAULT 0; -- final DM deferred past quiet hours
