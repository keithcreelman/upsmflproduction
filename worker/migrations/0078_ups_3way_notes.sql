-- 0078: free-form routing + notes for 3-way trades.
--
-- legs_json is repurposed to store a variable-length list of "movements"
-- ([{from, to, asset_tokens[], summary}]) instead of a fixed A->B->C->A ring.
-- A pure cycle is just the 3-movement special case (A->B, B->C, C->A), so
-- existing rows remain valid and no column rename is needed.
--
-- Adds an optional free-text note from the initiator, surfaced to both
-- partners in their Accept/Decline DM.
ALTER TABLE ups_3way_trades ADD COLUMN notes TEXT;

-- Free-form routing can decompose into up to THREE pairwise MFL trades (one per
-- team-pair), more than the two mfl_trade1_id / mfl_trade2_id columns hold. Store
-- the full CSV of executed MFL trade ids here for the record.
ALTER TABLE ups_3way_trades ADD COLUMN mfl_trade_ids TEXT;
