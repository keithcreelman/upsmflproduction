-- 0096_auction_nom_slots.sql — FA-Auction nomination cap reservations.
--
-- §A2 (commish, 2026-07-14): exactly 2 nominations per franchise per ET
-- calendar day — a floor AND a ceiling. The ceiling is enforced in
-- performAuctionAction before the O=43 form POST.
--
-- Why this table exists at all: the enforcement count is read live from MFL
-- (export?TYPE=transactions&TRANS_TYPE=AUCTION_INIT) because ups_auction_bids
-- is only written by the */5 poll and trails MFL by up to 5 minutes — fid
-- 0007's 2nd→3rd nomination on 2026-07-14 were 12 SECONDS apart, so a
-- D1-count gate would have read 1 and let the 3rd through.
--
-- But a live read is still check-then-act: two nominations in flight on
-- different players both read used=0 and both pass. The UNIQUE constraint
-- below — not the read — is what actually enforces the cap.
--
-- slot_no is allocated by PROBING this table for a free index (1..2), never as
-- `used + 1` off the count: the count is a player_id-deduped union across three
-- sources, slot_no is a positional index into this one table, and any drift
-- between them made a race-loser (or a leaked row) collide and get refused as
-- "quota reached" — locking a franchise out of a nomination §A2 REQUIRES it to
-- make. A collision means "try the next index", not "you're done for the day".
--
-- Rows are claimed BEFORE the MFL POST and released in a finally if the submit
-- fails or throws, so a failed submit doesn't burn a nomination. Reconciliation
-- with the live MFL count is by (fid, player_id) union: you cannot nominate the
-- same player twice (the lot already exists), so the union is idempotent, needs
-- no timestamp matching, and lets a retry after a leaked claim reuse its row.
--
-- et_day is 'YYYY-MM-DD' in America/New_York (see worker/src/auction_windows.js).

CREATE TABLE IF NOT EXISTS ups_auction_nom_slots (
  season          TEXT    NOT NULL,
  league_id       TEXT    NOT NULL,
  fid             TEXT    NOT NULL,
  et_day          TEXT    NOT NULL,
  slot_no         INTEGER NOT NULL,
  player_id       TEXT    NOT NULL,
  claimed_at_unix INTEGER NOT NULL,
  UNIQUE (season, league_id, fid, et_day, slot_no)
);

CREATE INDEX IF NOT EXISTS idx_auction_nom_slots_day
  ON ups_auction_nom_slots (season, league_id, fid, et_day);
