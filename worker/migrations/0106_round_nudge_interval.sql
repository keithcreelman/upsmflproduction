-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0106: per-round DM nudge cadence for rule-proposal voting rounds.
-- NULL  = default cadence (48h for the first 6 days, then daily)
-- 0     = nudges OFF for this round
-- N > 0 = nudge every N hours (quiet hours 10PM-6AM ET still apply)
--
-- ⚠️ Apply manually with `wrangler d1 execute ups-mfl-db --remote --file=...`
--    — NEVER `wrangler d1 migrations apply` (tracker is ~47 behind).
ALTER TABLE discord_rounds ADD COLUMN nudge_interval_hours INTEGER;
