-- 0131_league_events_2024_2025_deadlines.sql
-- Corrects the 2024 and 2025 pre-season ladder rows, the same off-by-one 0126
-- fixed for 2026. Keith approved 2026-08-17.
--
-- WHY THEY WERE WRONG: migration 0026 seeded every pre-season deadline from the
-- WEDNESDAY BEFORE the Thursday kickoff. Canon ties both windows to a kickoff —
-- MYM to Week 3, Extension to Week 5 — so every seeded row landed a day early.
-- 0126 fixed 2026 and deliberately left these for Keith, because closed seasons
-- are historical record and changing them is a decision, not a side effect.
--
-- Stated plainly, because it is worth stating: the MYM and Extension windows in
-- 2024 and 2025 were PUBLISHED AS CLOSING A DAY EARLIER than canon says they
-- should have. This corrects the record; it cannot un-close a window an owner
-- was told had already shut.
--
-- VERIFIED 2026-08-17 against MFL TYPE=nflSchedule directly — not copied from
-- 0126's header, which is where these dates were first written down:
--
--     2024 W3  first kickoff  Thu 2024-09-19 8:15 PM ET
--     2024 W5  first kickoff  Thu 2024-10-03 8:15 PM ET
--     2025 W3  first kickoff  Thu 2025-09-18 8:15 PM ET
--     2025 W5  first kickoff  Thu 2025-10-02 8:15 PM ET
--
-- The same check re-confirmed 2026 (W3 09-24, W5 10-08), which matches what is
-- already stored after 0126 — so the method that produced these four is the one
-- that produced a row already accepted as correct.
--
-- Each UPDATE carries `AND date = '<the wrong value>'` as a guard, not
-- decoration: if a row was already corrected, or holds some third value nobody
-- expected, that statement is a no-op instead of a blind overwrite. Re-running
-- this file is safe.
--
-- WRITES: 4 rows. No schema change. No contract data touched.

SELECT 'BEFORE' AS phase, nfl_season, event, date, source
  FROM league_events
 WHERE nfl_season IN ('2024','2025')
   AND event IN ('preseason_mymdeadline','preseason_extensiondeadline')
 ORDER BY nfl_season, event;

UPDATE league_events
   SET date = '2024-09-19',
       description = 'MYM window closes at the first kickoff of NFL Week 3 (Thu 2024-09-19 8:15 PM ET) — corrected from the 0026 seed, which used the Wednesday before',
       source = 'mfl_nflSchedule_first_kickoff@2026-08-17'
 WHERE event = 'preseason_mymdeadline' AND nfl_season = '2024' AND date = '2024-09-18';

UPDATE league_events
   SET date = '2024-10-03',
       description = 'Extension window closes at the first kickoff of NFL Week 5 (Thu 2024-10-03 8:15 PM ET) — corrected from the 0026 seed, which used the Wednesday before',
       source = 'mfl_nflSchedule_first_kickoff@2026-08-17'
 WHERE event = 'preseason_extensiondeadline' AND nfl_season = '2024' AND date = '2024-10-02';

UPDATE league_events
   SET date = '2025-09-18',
       description = 'MYM window closes at the first kickoff of NFL Week 3 (Thu 2025-09-18 8:15 PM ET) — corrected from the 0026 seed, which used the Wednesday before',
       source = 'mfl_nflSchedule_first_kickoff@2026-08-17'
 WHERE event = 'preseason_mymdeadline' AND nfl_season = '2025' AND date = '2025-09-17';

UPDATE league_events
   SET date = '2025-10-02',
       description = 'Extension window closes at the first kickoff of NFL Week 5 (Thu 2025-10-02 8:15 PM ET) — corrected from the 0026 seed, which used the Wednesday before',
       source = 'mfl_nflSchedule_first_kickoff@2026-08-17'
 WHERE event = 'preseason_extensiondeadline' AND nfl_season = '2025' AND date = '2025-10-01';

SELECT 'AFTER' AS phase, nfl_season, event, date, source
  FROM league_events
 WHERE nfl_season IN ('2024','2025')
   AND event IN ('preseason_mymdeadline','preseason_extensiondeadline')
 ORDER BY nfl_season, event;
