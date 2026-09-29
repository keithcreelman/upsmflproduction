-- 0163: the loaded-contract CONDITIONAL-DROP SELECTION store (ups_trade_conditional_drops).
--
-- Keith's ruling (2026-09-29, correcting a real gap found on the deployed Trade War Room):
-- HammerTime's live roster already had 6 rostered loaded contracts (7 including an IR player) --
-- over the 5-loaded-contract limit -- and building/reviewing a trade as the SENDER showed no
-- warning at all, because the loaded-contract check (PR #1135, migration-free) was wired only
-- into the RECIPIENT's accept/preview path. This table records which of a franchise's OWN
-- loaded-contract players its owner has selected to drop, conditional on a specific trade going
-- through -- see worker/src/trade_conditional_drops.js for the full rule and
-- worker/src/trade_cap_authority.js's evaluateTradeCompliance() `conditionalDrops` input for how
-- a selection is validated fresh against live data every time (never trusted from this table
-- alone). It does NOT record or perform an actual MFL drop or trade -- see the execution-safety
-- design doc for why that is a separate, not-yet-built path.
--
-- The worker also creates this table on demand (CREATE TABLE IF NOT EXISTS, exactly this DDL,
-- the same convention as ups_trade_cap_acknowledgments / the trade execution ledger / the
-- outbox), so it does NOT depend on this migration being applied first; shipping it keeps the
-- migration tracker and the schema in step. Additive; safe to apply before or after the worker
-- deploys.
--
-- Apply ONLY this file's SQL directly (never a blanket `wrangler d1 migrations apply`, which
-- would sweep in whatever else is pending at the time -- `wrangler d1 migrations list` first):
--
--   cd worker && npx wrangler d1 migrations list ups-mfl-db --remote
--   npx wrangler d1 execute ups-mfl-db --remote --file=migrations/0163_ups_trade_conditional_drops.sql
--   npx wrangler d1 execute ups-mfl-db --remote --command "INSERT INTO d1_migrations (name) VALUES ('0163_ups_trade_conditional_drops.sql')"
--   npx wrangler d1 migrations list ups-mfl-db --remote   # confirm 0163 is gone from the pending list

CREATE TABLE IF NOT EXISTS ups_trade_conditional_drops (
  league_id             TEXT NOT NULL,
  season                TEXT NOT NULL,
  trade_key             TEXT NOT NULL,   -- 2-way: the SAME capAckTermsKey() as trade_cap_ack.js (this offer's complete authoritative terms); 3-way: the ups_3way_trades.id uuid
  trade_kind            TEXT NOT NULL,   -- 'two_way' | 'three_way'
  franchise_id          TEXT NOT NULL,   -- the franchise dropping this player (always its OWN roster -- enforced fresh at validation, not by this table)
  player_id             TEXT NOT NULL,   -- the MFL player id selected to drop, conditional on the trade going through
  selected_by_fid       TEXT NOT NULL,   -- the franchise whose owner actually made the selection (proven caller identity; in every current caller this equals franchise_id)
  selected_at_utc       TEXT NOT NULL,
  PRIMARY KEY (league_id, season, trade_key, franchise_id, player_id)
);
