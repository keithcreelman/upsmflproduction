-- 0036_submission_dry_run_flag.sql
-- Adds a `dry_run` column to the contract-submission audit tables so we
-- can test end-to-end without writing to MFL or polluting the
-- production master state.
--
-- Behavior (enforced by worker /commish-contract-update):
--   • Client sends submission_kind="tag"|"untag"|"extension" with
--     dry_run=1 in payload (or ?dry_run=1 in URL).
--   • Worker SKIPS the MFL salary import POST entirely.
--   • Worker INSERTs into ups_*_submissions with dry_run=1.
--   • Worker SKIPS UPSERT into ups_*_master (dry runs never alter
--     current-state truth).
--   • Discord announcement (if any) is prefixed with [DRY RUN] and
--     routed to the test channel only.
--
-- The flag is on the AUDIT tables only — master tables stay clean.

-- ALTER TABLE ADD COLUMN is idempotent-friendly via INSERT OR IGNORE
-- on d1_migrations, but SQLite itself isn't. Wrap in pragma_table_info
-- check via a temp view to make this re-runnable.

ALTER TABLE ups_tag_submissions       ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ups_extension_submissions ADD COLUMN dry_run INTEGER NOT NULL DEFAULT 0;

-- Optional convenience: index for filtering audit history by mode.
CREATE INDEX IF NOT EXISTS idx_tag_subs_dry_run ON ups_tag_submissions(dry_run, season);
CREATE INDEX IF NOT EXISTS idx_ext_subs_dry_run ON ups_extension_submissions(dry_run, season);
