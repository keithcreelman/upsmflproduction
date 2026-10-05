-- 0134_fantasy_bonus_bands.sql
-- Additive: give fantasy_scoring_bonuses the upper edge of a bonus band.
-- Apply AFTER 0128. Safe to re-run? NO — SQLite has no ADD COLUMN IF NOT
-- EXISTS. Run once; a second run errors with "duplicate column name", which is
-- harmless but noisy.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- WHY THIS COLUMN EXISTS
-- ======================
-- 0128 modelled a bonus as a THRESHOLD: reach target_value, collect
-- bonus_points. That is right for a milestone ("+3 at 100 rushing yards") and
-- WRONG for a band, and CBS's grffl league uses both at once:
--
--   RuYd  100+ : +3   200+ : +3   300+ : +3     <- open-ended, and they STACK
--   RuTD  10-39: +1  40-69: +3  70-100: +5      <- closed bands, EXCLUSIVE
--
-- With only target_value, a 45-yard touchdown satisfies `target_value <= 45`
-- for both the 10-39 row and the 40-69 row, so the obvious query awards +4
-- instead of +3. The band's upper edge was recoverable from raw_bonus_json,
-- but a correctness-critical fact that lives only inside a JSON blob is a fact
-- every future query will get wrong. It belongs in a column.
--
-- These bonuses are the single largest driver of this league's divergence from
-- standard scoring — an out-of-position touchdown pays double base AND carries
-- the larger bonus scale — so the cost of modelling them loosely is not
-- academic.

-- The inclusive upper edge of the band. NULL means OPEN-ENDED ("100 or more"),
-- which is a real and different claim from a bounded band, never a missing value.
ALTER TABLE fantasy_scoring_bonuses ADD COLUMN target_max REAL;

-- 1 = this bonus stacks with the other bonuses on the same stat (milestones);
-- 0 = the bands are mutually exclusive and at most one may fire.
-- NULL = the provider did not say, and the consumer must not guess.
ALTER TABLE fantasy_scoring_bonuses ADD COLUMN is_stacking INTEGER;

-- Position scope, mirroring fantasy_scoring_rules.applies_to_positions.
-- Necessary because CBS states a DIFFERENT bonus scale for the same stat by
-- position: a receiving TD is 1/3/5 for a WR and 2/6/10 for a running back.
ALTER TABLE fantasy_scoring_bonuses ADD COLUMN applies_to_positions TEXT;
