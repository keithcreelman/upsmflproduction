-- 0022_round_item_close.sql
-- Item-level auto-close support. Each round_item can close independently when
-- its YES (or NO) vote count hits the per-proposal threshold, without waiting
-- for the rest of the round.

ALTER TABLE discord_round_items ADD COLUMN closed_at_utc TEXT;
ALTER TABLE discord_round_items ADD COLUMN close_reason TEXT;
-- 'auto_passed'        — YES count hit pass_yes_count, vote auto-decided
-- 'auto_rejected'      — NO count made YES threshold mathematically impossible
-- 'manual_close'       — commish closed this item explicitly (future feature)
-- 'round_close'        — round was closed before item auto-closed; outcome by tally

ALTER TABLE discord_round_items ADD COLUMN final_outcome TEXT;
-- 'passed' | 'rejected' | 'tie_no' | 'no_decision'

ALTER TABLE discord_round_items ADD COLUMN final_yes INTEGER;
ALTER TABLE discord_round_items ADD COLUMN final_no INTEGER;
ALTER TABLE discord_round_items ADD COLUMN final_abstain INTEGER;

-- The "pass YES count" lives on hall_proposals so it's per-proposal-tunable.
-- (Default: 7 of 12, simple majority. Some proposals may use a higher bar.)
ALTER TABLE hall_proposals ADD COLUMN pass_yes_count INTEGER NOT NULL DEFAULT 7;

CREATE INDEX IF NOT EXISTS idx_round_items_closed
  ON discord_round_items(round_id, closed_at_utc);
