-- 0160: the trade EXECUTION LEDGER (ups_trade_executions).
--
-- MFL accepting a trade is irreversible. This table records, BEFORE MFL is called, that a trade is being executed (a conditional lock), then MFL's
-- confirmation and each post-processing step, so a lost response / D1 fault / failed contract import can never make an executed trade look
-- unexecuted or executable again. See worker/src/trade_execution.js.
--
-- The worker also creates this table on demand (CREATE TABLE IF NOT EXISTS, exactly this DDL), so it does NOT depend on this migration being
-- applied first; shipping it keeps the migration tracker and the schema in step. Additive; safe to apply before or after the worker deploys.
--
--   cd worker && npx wrangler d1 migrations apply ups-mfl-db --remote

CREATE TABLE IF NOT EXISTS ups_trade_executions (
  league_id            TEXT NOT NULL,
  season               TEXT NOT NULL,
  exec_key             TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  lock_token           TEXT,
  actor_fid            TEXT,
  participants         TEXT,
  payload_hash         TEXT,
  payload_json         TEXT,
  mfl_evidence_json    TEXT,
  steps_json           TEXT,
  failed_step          TEXT,
  failure_detail       TEXT,
  block_json           TEXT,
  created_at_utc       TEXT NOT NULL,
  updated_at_utc       TEXT NOT NULL,
  mfl_executed_at_utc  TEXT,
  completed_at_utc     TEXT,
  PRIMARY KEY (league_id, season, exec_key)
);
