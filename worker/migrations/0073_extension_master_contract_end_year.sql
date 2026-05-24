-- 0073_extension_master_contract_end_year.sql
-- Adds contract_end_year to ups_extension_master and computes it from
-- src_contracts.contract_length at the extension season.
--
-- Per Keith 2026-05-24 review: once an extension contract expires AND
-- the player goes through FA Auction, the extending franchise's
-- "extension right" on that player RESETS. Hill went through FA after
-- Manther extended him in 2018; in 2026 Manther should be able to
-- extend him again (if they re-acquired him). Same for Bosa (PG 2023
-- EXT2 expired, FA, PG re-acquired 2026) and Ertz (PG 2022 EXT2
-- expired, etc).
--
-- contract_end_year = season + contract_length - 1
--   (season = year the new contract starts, including any carry-over
--   year for vet extensions; for expired-rookie fresh contracts season
--   is just Y1 of the new term.)
--
-- The worker /trade-workbench filter will use this column to gate
-- block decisions: only block per-franchise extension if the contract
-- is still in effect this season (contract_end_year >= current_season).

ALTER TABLE ups_extension_master ADD COLUMN contract_end_year INTEGER;

-- Populate from src_contracts.contract_length at the extension's season.
UPDATE ups_extension_master
   SET contract_end_year = (
     SELECT CAST(ups_extension_master.season AS INTEGER) + sc.contract_length - 1
     FROM src_contracts sc
     WHERE sc.player_id = ups_extension_master.player_id
       AND sc.season = CAST(ups_extension_master.season AS INTEGER)
     LIMIT 1
   )
 WHERE league_id = '74598';

-- Fallback for rows where src_contracts has no data for that
-- (player, season). Use season + extension_term_years (slightly
-- over-estimates by 1 for fresh-from-rookie extensions, but errs on
-- the side of blocking when uncertain).
UPDATE ups_extension_master
   SET contract_end_year = CAST(season AS INTEGER) + COALESCE(extension_term_years, 1)
 WHERE league_id = '74598'
   AND contract_end_year IS NULL;

CREATE INDEX IF NOT EXISTS idx_ext_master_end_year
  ON ups_extension_master(league_id, contract_end_year);
