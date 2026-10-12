-- ROLLBACK for 0172_lineup_pick_reservation_state.sql (manual; NOT a migration).
--
-- Order: (1) revert PR #1223's code and let the worker redeploy (the old code
-- does not read these columns); (2) export what this drops:
--   SELECT * FROM ups_lineup_pick_reservations;
--   SELECT * FROM ups_lineup_forfeit_events;
-- (3) run this file:  wrangler d1 execute ups-mfl-db --remote --file <this>
-- It runs as ONE transaction. Afterwards the schema is exactly 0171's, and
-- 0172 is no longer recorded as applied.
DROP INDEX IF EXISTS idx_lineup_forfeit_events_holder;
DROP TABLE IF EXISTS ups_lineup_forfeit_events;
ALTER TABLE ups_lineup_pick_reservations DROP COLUMN state_changed_at_utc;
ALTER TABLE ups_lineup_pick_reservations DROP COLUMN options_json;
ALTER TABLE ups_lineup_pick_reservations DROP COLUMN state;
DELETE FROM d1_migrations WHERE name = '0172_lineup_pick_reservation_state.sql';
