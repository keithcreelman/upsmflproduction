-- 2026-08-08 — D1 half of the mis-filed drop-penalty repair.
--
-- NOT a numbered migration: this is a one-off data correction for two specific
-- ups_drop_events rows, not a schema change. Hand-apply, and ONLY after
--   (a) migration 0125_drop_events_cap_season.sql has been applied, and
--   (b) .github/workflows/drop-penalty-capyear-repair-2026-08-08.yml has run in
--       APPLY mode and its post-write verification passed.
--
--   wrangler d1 execute UPS_MFL_DB --remote \
--     --file=worker/migrations/manual/2026-08-08_misfiled_drop_penalties_capyear.sql
--
-- NEVER `wrangler d1 migrations apply`.
--
-- WHAT HAPPENED
-- The drop tracker had no cap-year bucketing, so these two penalties were
-- posted to the 2026 cap even though both drops landed after the 2026 FA
-- Auction opened. Canon §6 penalty timing puts them on the 2027 cap, ledger-only
-- until the rollover.
--
--   17254_1786195613  Konata Mumpfield       fid 0006  $1,000  2026-08-08 13:26 UTC
--   17205_1786195656  KeAndre Lambert-Smith  fid 0006  $1,000  2026-08-08 13:27 UTC
--
-- WHAT THIS DOES
--   applies_to_season -> 2027            (the cap year the money belongs to)
--   posted_to_mfl     -> 0               (it is no longer on any MFL cap: the
--                                         2026 row was cancelled by an equal
--                                         negative reversal, so the 2027
--                                         rollover must still pick it up)
--   posted_amount / posted_explanation cleared, with the reversal recorded in
--   cap_season_review_reason as the audit trail.
--
-- Guarded by ledger_key AND franchise AND amount: if any of the three has moved
-- since this was written, zero rows update.
--
-- ASSERTIONS (added 2026-08-08 after review). "Zero rows updated" is NOT a safe
-- outcome here: this file runs AFTER the offsetting entries have already landed
-- on MFL, so a silent no-op leaves MFL corrected and D1 still claiming these are
-- 2026 rows that were posted — the two sources of truth disagreeing, with
-- nothing raised. SQLite has no ASSERT, and RAISE() only works inside a trigger,
-- so a TEMP TABLE with a CHECK constraint is the portable way to abort: a failed
-- CHECK is a real error and stops the run.

-- PRE-FLIGHT: exactly the two expected rows must be present, unmodified, before
-- anything is written. Aborts rather than half-applying.
CREATE TEMP TABLE _assert_pre (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _assert_pre (ok)
SELECT CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END
  FROM ups_drop_events
 WHERE ledger_key IN ('17254_1786195613', '17205_1786195656')
   AND franchise_id = '0006'
   AND penalty_amount = 1000;

UPDATE ups_drop_events
   SET applies_to_season          = 2027,
       cap_season_source          = 'manual repair 2026-08-08 (canon §6 penalty timing)',
       cap_season_resolved_at_utc = datetime('now'),
       cap_season_needs_review    = 0,
       cap_season_review_reason   = 'Posted to the 2026 MFL cap in error; reversed on MFL by id:ups_drop_capyear_fix_17254_1786195613. Owed on the 2027 cap.',
       posted_to_mfl              = 0,
       posted_at_utc              = NULL,
       posted_amount              = NULL,
       posted_explanation         = NULL
 WHERE ledger_key   = '17254_1786195613'
   AND franchise_id = '0006'
   AND penalty_amount = 1000;

UPDATE ups_drop_events
   SET applies_to_season          = 2027,
       cap_season_source          = 'manual repair 2026-08-08 (canon §6 penalty timing)',
       cap_season_resolved_at_utc = datetime('now'),
       cap_season_needs_review    = 0,
       cap_season_review_reason   = 'Posted to the 2026 MFL cap in error; reversed on MFL by id:ups_drop_capyear_fix_17205_1786195656. Owed on the 2027 cap.',
       posted_to_mfl              = 0,
       posted_at_utc              = NULL,
       posted_amount              = NULL,
       posted_explanation         = NULL
 WHERE ledger_key   = '17205_1786195656'
   AND franchise_id = '0006'
   AND penalty_amount = 1000;

-- POST-FLIGHT: both rows must now read 2027 / not-posted. Aborts if either
-- UPDATE matched nothing, so this file can never report success while D1 and
-- MFL disagree about which cap year owes the money.
CREATE TEMP TABLE _assert_post (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _assert_post (ok)
SELECT CASE WHEN COUNT(*) = 2 THEN 1 ELSE 0 END
  FROM ups_drop_events
 WHERE ledger_key IN ('17254_1786195613', '17205_1786195656')
   AND franchise_id = '0006'
   AND applies_to_season = 2027
   AND posted_to_mfl = 0;

DROP TABLE _assert_pre;
DROP TABLE _assert_post;

-- Verify (expect exactly 2 rows, both applies_to_season = 2027, posted_to_mfl = 0):
--   SELECT ledger_key, player_name, franchise_id, penalty_amount,
--          applies_to_season, posted_to_mfl
--     FROM ups_drop_events
--    WHERE ledger_key IN ('17254_1786195613','17205_1786195656');
