-- 0055_era_pool_ppg
-- ERA-Eligible table redesign (Keith 2026-05-22):
--   - Remove Age / Prior Owner / Rookie Slot / Rookie Salary from the display
--     (data columns stay in D1 for audit; just hidden in UI).
--   - Add 3-year PPG history + weighted average.
--   - High Bid Team + Total Bids are JOINed live from ups_auction_lots,
--     not stored here.
--
-- Weighted avg formula (Keith 2026-05-22, default — adjustable):
--   weighted = (ppg_2025 * 3 + ppg_2024 * 2 + ppg_2023 * 1) / sum_of_weights_with_data
-- Years with games=0 are excluded from both numerator and denominator.
-- PPG values are stored as REAL (1 decimal place is normal, but full
-- precision preserved for sort).

ALTER TABLE ups_era_pool ADD COLUMN ppg_2023 REAL;
ALTER TABLE ups_era_pool ADD COLUMN ppg_2024 REAL;
ALTER TABLE ups_era_pool ADD COLUMN ppg_2025 REAL;
ALTER TABLE ups_era_pool ADD COLUMN ppg_weighted REAL;
ALTER TABLE ups_era_pool ADD COLUMN games_2023 INTEGER;
ALTER TABLE ups_era_pool ADD COLUMN games_2024 INTEGER;
ALTER TABLE ups_era_pool ADD COLUMN games_2025 INTEGER;
