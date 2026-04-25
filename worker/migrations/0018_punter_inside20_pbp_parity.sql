-- 0018_punter_inside20_pbp_parity.sql
-- Keith 2026-04-25 cross-check: nflverse PBP exposes a flag
-- `punt_inside_twenty` per punt — the canonical "golden source" for
-- the official MFL I20 stat. We populate punt_inside20 from that
-- flag in fetch_nflverse_pbp.py.
--
-- Separately, I5/I10/I15 are derived from end-of-play yardline
-- (gross kick - return yards). Adding punt_inside20_pbp using the
-- SAME end-spot derivation lets the user verify our derivation
-- aligns with the golden source. If punt_inside20_pbp ≈ punt_inside20
-- per player-week, our I5/I10/I15 are trustworthy. Drift = our
-- end-spot math has a bug.

ALTER TABLE nfl_player_weekly ADD COLUMN punt_inside20_pbp INTEGER;
