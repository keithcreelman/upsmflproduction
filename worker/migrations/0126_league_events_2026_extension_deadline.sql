-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0126_league_events_2026_extension_deadline.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- UNAPPLIED. Keith applies by hand:
--     wrangler d1 execute ups-mfl-db --remote \
--       --file worker/migrations/0126_league_events_2026_extension_deadline.sql
-- NEVER `wrangler d1 migrations apply` — that tracker is ~47 migrations behind
-- and running it corrupts contracts.
--
-- WHAT: corrects ONE row — 2026 `preseason_extensiondeadline`, 2026-10-07 →
-- 2026-10-08.
--
-- WHY: migration 0026 seeded the pre-season ladder from the WEDNESDAY before
-- each Thursday kickoff. Canon (league_context_v1.md ~1211 / ~1214) ties the
-- Extension window to the kickoff of NFL Week 5, and MFL's own nflSchedule
-- says 2026 Week 5 opens Thu 2026-10-08 8:15 PM ET (unix 1791504900). The
-- stored row was a day early, so the Extension window read as closing a day
-- before it actually does. This is the LIVE season — it matters now.
--
-- The 2026 `preseason_mymdeadline` row (2026-09-24) already matches the real
-- Week 3 kickoff (Thu 2026-09-24 8:15 PM ET) and is left alone.
--
-- DELIBERATELY NOT IN THIS MIGRATION: the 2024 and 2025 pre-season rows, which
-- are wrong the same way (each one day early). Those seasons are closed and
-- historical reporting may depend on the values as recorded, so changing them
-- is Keith's call, not a side effect of fixing the live row. The correct dates
-- and the ready-to-run SQL for them are in the dry-run report that ships with
-- this change (branch claude/league-events-kickoff), for him to decide on:
--   2024 preseason_mymdeadline        2024-09-18 → 2024-09-19
--   2024 preseason_extensiondeadline  2024-10-02 → 2024-10-03
--   2025 preseason_mymdeadline        2025-09-17 → 2025-09-18
--   2025 preseason_extensiondeadline  2025-10-01 → 2025-10-02
-- Stated plainly: those windows were wrong AT THE TIME — the MYM and Extension
-- windows in 2024 and 2025 were published as closing a day earlier than canon
-- says they should have.
--
-- BELT AND BRACES: as of the same change, GET /api/league-events no longer
-- trusts these two rows at all — it resolves them from nflWeekFirstKickoffUnix
-- (the same helper Discord + mobile use) and falls back to the stored row only
-- when MFL's schedule cannot be read, saying so in `date_source`. So this
-- migration is not what makes the surfaces correct; it makes the stored
-- FALLBACK correct, which is what gets served during an MFL outage.
--
-- WRITES: 1 row. No schema change. No contract data touched.
-- ─────────────────────────────────────────────────────────────────────────────

-- Before.
SELECT 'BEFORE' AS phase, event, date, nfl_season, source
  FROM league_events
 WHERE nfl_season = '2026'
   AND event IN ('preseason_mymdeadline', 'preseason_extensiondeadline');

-- The `AND date = '2026-10-07'` is a guard, not decoration: if the row has
-- already been corrected, or holds some third value nobody expected, this is a
-- no-op instead of a blind overwrite. Re-running the file is safe.
UPDATE league_events
   SET date        = '2026-10-08',
       description = 'Extension window closes at the first kickoff of NFL Week 5 (Thu 2026-10-08 8:15 PM ET, unix 1791504900) — corrected from the 0026 seed, which used the Wednesday before',
       source      = 'mfl_nflSchedule_first_kickoff@2026-08-08'
 WHERE event      = 'preseason_extensiondeadline'
   AND nfl_season = '2026'
   AND date       = '2026-10-07';

-- After. Expect preseason_extensiondeadline = 2026-10-08.
SELECT 'AFTER' AS phase, event, date, nfl_season, source
  FROM league_events
 WHERE nfl_season = '2026'
   AND event IN ('preseason_mymdeadline', 'preseason_extensiondeadline');
