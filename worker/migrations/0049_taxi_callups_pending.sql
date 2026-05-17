-- 0049_taxi_callups_pending.sql
-- Adds a `pending` state column to ups_taxi_callups so taxi call-ups
-- only count toward the canon §B2 3-call-up budget once weeklyresults
-- confirms the player was "active for the week."
--
-- Canon §B2: "Active for the week" definition: the player was on the
-- active roster (or on IR) at the time rosters and lineups locked for
-- that NFL week, AND appears in that week's weekly results.
--
-- State machine (canon §B2 + tracker Q20):
--   pending=1, demoted_at=NULL          — just promoted, awaiting weekly confirmation
--   pending=1, demoted_at!=NULL         — demoted before confirmation; will be cleared by cron (didn't count)
--   pending=0, demoted_at=NULL          — confirmed, currently on active roster
--   pending=0, demoted_at!=NULL         — confirmed (counted), later demoted to taxi
--
-- The "used" counter visible to owners = COUNT(*) WHERE pending=0.
-- Pending rows are surfaced separately so owners see their click took
-- effect even before NFL week locks.
--
-- Tracker: docs/AUDIT_FOLLOWUP_TRACKERS.md Q20.

ALTER TABLE ups_taxi_callups ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_taxi_cu_pending          ON ups_taxi_callups(pending, season);
CREATE INDEX IF NOT EXISTS idx_taxi_cu_pending_player   ON ups_taxi_callups(player_id, pending, demoted_at);
