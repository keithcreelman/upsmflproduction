-- 0077_ups_3way_trades.sql
-- 3-way (ring) trades. MFL only does 2-party trades, so a 3-way A->B->C->A is
-- tracked here as ONE deal and executed as two chained 2-party MFL trades with
-- the initiator (A) as hub (see worker/src/trade_3way.js). One row per 3-way.
--
-- Lifecycle: collecting (waiting on both partners to accept) -> executing
-- (both accepted, the commish is running the two legs) -> completed | failed
-- (partial/aborted; needs a manual commish fix — MFL can't undo a completed
-- trade) | cancelled (a partner declined). Mirrors the trade_offer_dm style.

CREATE TABLE IF NOT EXISTS ups_3way_trades (
  id                     TEXT PRIMARY KEY,        -- uuid
  league_id              TEXT NOT NULL,
  season                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'collecting'
                           CHECK (status IN ('collecting','executing','completed','failed','cancelled')),
  initiator_fid          TEXT NOT NULL,           -- A (ring order A->B->C->A)
  team_b_fid             TEXT NOT NULL,           -- B
  team_c_fid             TEXT NOT NULL,           -- C
  initiator_name         TEXT,
  team_b_name            TEXT,
  team_c_name            TEXT,
  -- The three legs: [{from, to, asset_tokens:[...], cap_k, summary}]. asset
  -- tokens are the builder's tokens (P_/FP_/DP_/BB_); the engine translates
  -- them to MFL form at execution.
  legs_json              TEXT NOT NULL,
  team_b_state           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (team_b_state IN ('pending','accepted','declined')),
  team_c_state           TEXT NOT NULL DEFAULT 'pending'
                           CHECK (team_c_state IN ('pending','accepted','declined')),
  -- All linked Discord accounts per franchise (CSV — reuse the multi-account fan-out).
  initiator_discord_ids  TEXT,
  team_b_discord_ids     TEXT,
  team_c_discord_ids     TEXT,
  mfl_trade1_id          TEXT,                    -- A<->B leg
  mfl_trade2_id          TEXT,                    -- A<->C leg
  failure_reason         TEXT,
  created_at_utc         TEXT NOT NULL,
  updated_at_utc         TEXT,
  executed_at_utc        TEXT
);

CREATE INDEX IF NOT EXISTS idx_3way_status ON ups_3way_trades(status);
CREATE INDEX IF NOT EXISTS idx_3way_league ON ups_3way_trades(league_id, season, status);
