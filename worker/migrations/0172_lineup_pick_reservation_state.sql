-- 0172 — state for §G3 forfeited-pick reservations (see worker/src/lineup_forfeits.js).
--
-- 0171 recorded WHICH pick a lineup penalty claims. Keith 2026-10-11 added
-- what happens to it afterwards: the War Room must refuse to trade it; a pick
-- whose league year MFL does not list yet stays an OBLIGATION until it does;
-- several qualifying picks wait for the commissioner's choice; a native MFL
-- trade is detected after the fact; and the penalty's pick half is APPLIED
-- only once the pick is actually SECURED (gone from every franchise on MFL).
--
-- state: reserved | obligation | needs_selection | traded_away | secured | released
-- (ALTER TABLE cannot add a CHECK; lineup_forfeits.js is the only writer.)
ALTER TABLE ups_lineup_pick_reservations ADD COLUMN state TEXT NOT NULL DEFAULT 'reserved';
ALTER TABLE ups_lineup_pick_reservations ADD COLUMN options_json TEXT;
ALTER TABLE ups_lineup_pick_reservations ADD COLUMN state_changed_at_utc TEXT;

UPDATE ups_lineup_pick_reservations SET state = 'obligation'
 WHERE ownership_basis = 'beyond_trade_horizon' AND released_at_utc IS NULL;
UPDATE ups_lineup_pick_reservations SET state = 'released' WHERE released_at_utc IS NOT NULL;
