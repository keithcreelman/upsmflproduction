-- 0103_auction_contract_finalizations
-- UPS-side audit ledger of AUTO-FINALIZED auction contracts.
--
-- Keith's rule (rule_d1_is_single_source_of_truth): EVERYTHING contract-related
-- lands in D1. When an auction lot closes, the worker writes the real 1-year
-- contract to MFL — Vet-ERA for ERA-pool wins (finalizeEraContracts) or Vet-FAA
-- for plain FA-Auction wins (finalizeFaaContracts). MFL stays canonical for the
-- salary itself; THIS table records that WE performed the write, from which won
-- bid, with what contract shape, and when — so every auto-finalize is auditable.
--
-- PK(player_id, season, league_id, source) makes re-running a finalize an
-- UPSERT (update-in-place) rather than a duplicate insert — matching the
-- idempotent, re-runnable design of the finalize functions themselves.
--   source: 'faa' (Free Agent Auction) | 'era' (Expired Rookie Auction)
CREATE TABLE IF NOT EXISTS ups_auction_contract_finalizations (
  player_id         TEXT    NOT NULL,
  season            TEXT    NOT NULL,
  league_id         TEXT    NOT NULL,
  winner_fid        TEXT,
  source            TEXT    NOT NULL,           -- 'faa' | 'era'
  won_bid_k         INTEGER,
  salary            INTEGER,
  contract_year     TEXT,
  contract_status   TEXT,
  contract_info     TEXT,
  finalized_at_unix INTEGER,
  PRIMARY KEY (player_id, season, league_id, source)
);

CREATE INDEX IF NOT EXISTS idx_auction_contract_final_season_league
  ON ups_auction_contract_finalizations (season, league_id, source);
