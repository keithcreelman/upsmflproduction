-- Durable narration (Keith 2026-07-27). A bid row is stamped ONLY after its
-- Discord message actually posts; anything still NULL inside the narration
-- lookback gets retried on the next poll tick. Fixes the fire-once-and-lose
-- behavior that silently dropped 37 events during the 2026 FAA.
ALTER TABLE ups_auction_bids ADD COLUMN narrated_at_unix INTEGER;

-- Backfill every EXISTING row as already-narrated. Without this, the first
-- tick after deploy would see an hour of already-posted bids as un-narrated
-- and re-announce all of them into a live channel.
UPDATE ups_auction_bids SET narrated_at_unix = bid_at_unix WHERE narrated_at_unix IS NULL;
