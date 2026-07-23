-- Three-Value Board: commish-gated auction board carrying the three value axes
-- (current_season_value_k / ultimate_value_k / fa_value_k) plus contract_surplus,
-- option_band and scale_trust, alongside the Saturday shopping list (IDP/K/P must-fills).
-- Served by GET /api/auction/three-value. Produced by build_three_value_board.py --push-d1.
-- The board is ~1,470 rows; the lean JSON blob exceeds D1's 100KB single-statement cap,
-- so it's stored PART-KEYED: --push-d1 writes the JSON string in <90KB chunks (part 0..n);
-- the worker concatenates payload ORDER BY part and JSON.parse()s the result.
CREATE TABLE IF NOT EXISTS ups_auction_three_value (
  part       INTEGER PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER
);
