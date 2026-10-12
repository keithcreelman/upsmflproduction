-- Rollback for 02_void_false_rows.sql (NOT run). Restores the 48 rows to
-- unvoided exactly as they were, guarded so it touches only rows that void
-- stamped. Alternative full-database restore point: D1 time-travel bookmark
-- 0000f04a-00000000-00005101-6ec9425c0e5622da1cf35122a55992ab
-- (taken 2026-10-11 23:33Z, just before the void).
CREATE TABLE _guard_lineup_unvoid_20261011 (ok INTEGER CHECK (ok = 1));
INSERT INTO _guard_lineup_unvoid_20261011 (ok) SELECT 0 WHERE ((SELECT COUNT(*) FROM ups_lineup_violations WHERE voided=1 AND voided_at_utc='2026-10-11T23:34:38Z') = 48) IS NOT 1;
UPDATE ups_lineup_violations SET voided=0, void_reason=NULL, voided_by=NULL, voided_at_utc=NULL
 WHERE voided=1 AND voided_at_utc='2026-10-11T23:34:38Z';
INSERT INTO _guard_lineup_unvoid_20261011 (ok) SELECT 0 WHERE ((SELECT COUNT(*) FROM ups_lineup_violations WHERE voided_at_utc='2026-10-11T23:34:38Z') = 0) IS NOT 1;
DROP TABLE _guard_lineup_unvoid_20261011;
