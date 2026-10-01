-- 0164: universal server-side staging for two-team ("2-way") War Room trades
-- (ups_2way_trades).
--
-- Keith's ruling (2026-09-29, after the native-MFL-bypass analysis in
-- docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §8): every new 2-way trade must be created
-- and retained here, in D1, with NO native MFL tradeProposal while pending -- exactly
-- mirroring ups_3way_trades' already-proven architecture (migration 0077 and its
-- descendants), degenerated to exactly two parties and a single resulting MFL trade instead
-- of up to three. See worker/src/trade_2way.js for the full engine (create/accept/execute)
-- and the docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §8.2 staging mechanism this
-- implements.
--
-- Movements use the SAME {from, to, asset_tokens, cap_k} shape as ups_3way_trades.legs_json
-- (never separate give/receive columns), so trade_cap_authority.js's evaluateTradeCompliance
-- and every existing movement-shaped helper (injectCapTokens, fetchRosterSalaryMap, etc.)
-- work unchanged.
--
-- The worker also creates this table on demand (CREATE TABLE IF NOT EXISTS, exactly this
-- DDL, the same convention as ups_3way_trades / ups_trade_conditional_drops / the execution
-- ledger / the outbox) -- it does NOT depend on this migration being applied first.
--
-- Apply ONLY this file's SQL directly (never a blanket `wrangler d1 migrations apply`):
--
--   cd worker && npx wrangler d1 migrations list ups-mfl-db --remote
--   npx wrangler d1 execute ups-mfl-db --remote --file=migrations/0164_ups_2way_trades.sql
--   npx wrangler d1 execute ups-mfl-db --remote --command "INSERT INTO d1_migrations (name) VALUES ('0164_ups_2way_trades.sql')"
--   npx wrangler d1 migrations list ups-mfl-db --remote   # confirm 0164 is gone from the pending list
--
-- NOT APPLIED as part of this change -- Keith's explicit instruction (2026-09-29): "Keep
-- #1149 draft. Do not apply migration 0163 [or this one], merge, deploy, or execute a real
-- trade or drop."

CREATE TABLE IF NOT EXISTS ups_2way_trades (
  id                     TEXT PRIMARY KEY,        -- uuid, assigned at STAGING time (before any MFL trade exists)
  league_id              TEXT NOT NULL,
  season                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'collecting'
                           CHECK (status IN ('collecting','executing','completed','failed','cancelled')),
  from_fid               TEXT NOT NULL,           -- the initiator/sender
  to_fid                 TEXT NOT NULL,           -- the recipient
  from_name              TEXT,
  to_name                TEXT,
  -- {from, to, asset_tokens:[...], cap_k, summary} -- identical shape to
  -- ups_3way_trades.legs_json; a 2-way deal has at most two entries (from->to, to->from).
  movements_json         TEXT NOT NULL,
  extension_requests_json TEXT,
  notes                  TEXT,
  to_state               TEXT NOT NULL DEFAULT 'pending'
                           CHECK (to_state IN ('pending','accepted','declined')),
  from_discord_ids       TEXT,
  to_discord_ids         TEXT,
  mfl_trade_id           TEXT,                    -- filled in only once execute2Way actually lands the trade
  failure_reason         TEXT,
  cancel_basis           TEXT,
  cancelled_by           TEXT,
  cancel_reason          TEXT,
  cancelled_at_utc       TEXT,
  created_at_utc         TEXT NOT NULL,
  updated_at_utc         TEXT,
  executed_at_utc        TEXT
);
CREATE INDEX IF NOT EXISTS idx_2way_status ON ups_2way_trades(status);
CREATE INDEX IF NOT EXISTS idx_2way_league ON ups_2way_trades(league_id, season, status);
