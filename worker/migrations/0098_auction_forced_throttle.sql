-- 0098 — Forced-increase narration throttle.
--
-- A rival bidding into the leader's hidden max makes MFL walk the price up one
-- step at a time, and each step is its own AUCTION_BID row. Real Deal Creel
-- walked HammerTime's Lamar proxy $3K → $4K → $5K inside six minutes; the
-- narrator posted every one. That's the auction channel talking over itself.
--
-- Keith 2026-07-14: "if someone does multiple force bids within the 5 minutes
-- by the same owner between messages limit it to only one post per 5 minute.
-- Indicate each forced increase, and if one bid results in a take over then
-- post that immediately."
--
-- So: throttle per (lot, forcer) — NOT per lot. Two different rivals bumping
-- the same player are two separate stories and both deserve to be heard; one
-- rival clicking five times is one story.
--
-- `pending_count` is why this is a table and not just a timestamp. When a
-- walk-up is suppressed it must not vanish — the count is folded into the NEXT
-- post so it can say "bumped you 5×". Suppressing without carrying forward
-- would silently drop the middle of the story.
--
-- Overtakes are never throttled and never touch this table: a lead change is
-- the one thing an owner must hear about immediately.

CREATE TABLE IF NOT EXISTS ups_auction_forced_throttle (
  lot_id          TEXT    NOT NULL,   -- '<season>|<league>|<player_id>'
  forcer_key      TEXT    NOT NULL,   -- normalized forcer name, or '' when the leader raised its own max
  last_post_unix  INTEGER NOT NULL DEFAULT 0,
  -- Walk-ups suppressed since the last post, waiting to be folded in.
  pending_count   INTEGER NOT NULL DEFAULT 0,
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (lot_id, forcer_key)
);
