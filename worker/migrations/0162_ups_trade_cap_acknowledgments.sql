-- 0162: the salary-cap OVERAGE ACKNOWLEDGMENT store (ups_trade_cap_acknowledgments).
--
-- Keith's ruling (2026-09-28, separate from the loaded-contract/lineup work in PR #1135): "a
-- proven post-trade salary-cap overage should be displayed and explicitly acknowledged, but
-- should not itself block the trade." This table records that a specific franchise's owner
-- explicitly acknowledged a specific projected overage (tied to a signature of the exact dollar
-- figures) -- see worker/src/trade_cap_ack.js for the full rule and how staleness/forgery are
-- handled. It does NOT replace or weaken the loaded-contract hard block (still enforced,
-- unmodified, directly from trade_cap_authority.js's `loaded_contracts` result) or the lineup
-- advisory (still never blocks); those are completely independent of this table.
--
-- The worker also creates this table on demand (CREATE TABLE IF NOT EXISTS, exactly this DDL,
-- the same convention as the trade execution ledger and the outbox), so it does NOT depend on
-- this migration being applied first; shipping it keeps the migration tracker and the schema in
-- step. Additive; safe to apply before or after the worker deploys.
--
-- As of 2026-09-28, `wrangler d1 migrations list ups-mfl-db --remote` shows TWO migrations
-- pending: 0161_leaderboard_precompute_week_coverage.sql (a DIFFERENT, already-merged PR --
-- not reviewed or written here) and this one, 0162. `wrangler d1 migrations apply` is a BLANKET
-- command: it would apply every pending migration in one run, including 0161. Do not run it for
-- this release -- apply ONLY this file's SQL directly instead:
--
--   cd worker && npx wrangler d1 migrations list ups-mfl-db --remote   # verify current state first
--   npx wrangler d1 execute ups-mfl-db --remote --file=migrations/0162_ups_trade_cap_acknowledgments.sql
--
-- Confirm afterward that `migrations list` still shows only 0161 pending (0162 gone) -- if
-- 0161 was applied by someone else in the meantime, that is expected and unrelated to this table.

CREATE TABLE IF NOT EXISTS ups_trade_cap_acknowledgments (
  league_id             TEXT NOT NULL,
  season                TEXT NOT NULL,
  trade_key             TEXT NOT NULL,   -- 2-way: capAckTermsKey() -- the offer's complete authoritative terms (moving assets + cap money, folded in as BB_ tokens, + any extension requests' full priced terms), NOT the outbox's own payload_hash (too coarse: it does not vary with the traded assets when a trade carries no extension/cap-money XML, so two different trades could collide on it -- see trade_cap_ack.js); 3-way: the ups_3way_trades.id uuid
  trade_kind            TEXT NOT NULL,   -- 'two_way' | 'three_way'
  franchise_id          TEXT NOT NULL,   -- the AFFECTED franchise (the one whose cap would be over)
  acknowledged_by_fid   TEXT NOT NULL,   -- the franchise whose owner actually performed the acknowledgment (proven caller identity -- see trade_cap_ack.js; in every current caller this equals franchise_id, since only that franchise's own owner may acknowledge its own overage)
  signature             TEXT NOT NULL,   -- capAckSignature(...) -- a fingerprint of the trade + franchise + the two dollar figures acknowledged; a later mismatch means the numbers changed and this row no longer counts
  amount_over_dollars   INTEGER NOT NULL,
  used_after_dollars    INTEGER,
  cap_dollars           INTEGER,
  acknowledged_at_utc   TEXT NOT NULL,
  PRIMARY KEY (league_id, season, trade_key, franchise_id)
);
