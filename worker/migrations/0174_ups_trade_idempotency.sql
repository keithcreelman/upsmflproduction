-- 0174: idempotency keys for creating trade offers (ups_trade_idempotency) — P0 S6, server side.
--
-- A client may send an optional `idempotency_key` with POST /api/trades/proposals (= /trade-offers) or POST /api/trades/3way. The worker
-- takes the key with a conditional INSERT immediately before the irreversible write (the MFL tradeProposal / the ups_3way_trades INSERT) and
-- records the response, so a double tap or a retry after a timeout gets the original answer instead of a second offer and a second set of
-- DMs. Requests without a key are unchanged. See worker/src/trade_idempotency.js.
--
-- The worker also creates this table and index on demand (CREATE ... IF NOT EXISTS, exactly this DDL), so it does NOT depend on this
-- migration being applied first; shipping it keeps the migration tracker and the schema in step. Additive; safe before or after the deploy.
-- Rows older than 14 days are purged by the hourly cron (a range DELETE on idx_ups_trade_idempotency_created).
--
--   cd worker && npx wrangler d1 migrations apply ups-mfl-db --remote

CREATE TABLE IF NOT EXISTS ups_trade_idempotency (
  league_id       TEXT NOT NULL,
  season          TEXT NOT NULL,
  scope           TEXT NOT NULL,
  actor_fid       TEXT NOT NULL,
  idem_key        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL,
  status_code     INTEGER,
  response_json   TEXT,
  created_at_utc  TEXT NOT NULL,
  updated_at_utc  TEXT NOT NULL,
  PRIMARY KEY (league_id, season, scope, actor_fid, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_ups_trade_idempotency_created ON ups_trade_idempotency (created_at_utc);
