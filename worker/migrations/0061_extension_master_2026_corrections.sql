-- 0061_extension_master_2026_corrections.sql
-- Two corrections to the 2026 master inventory per Keith review 2026-05-24:
--
-- 1. DELETE the two fr=0008 (Mike) rows — both were test submissions
--    that were reset afterward:
--      • 16594 Trey Benson      EXT1     (ups-mobile-extension-submit test)
--      • 16803 Blake Watson     EXT2-BL  (front-office-extension-submit test)
--    These also matched the master-MFL drift items flagged earlier
--    (master EXT row but MFL didn't actually hold an EXT contract /
--    player dropped) — confirms drift was a test artifact, not a bug.
--
-- 2. POPULATE extension_term_years from new_contract_status where NULL.
--    Per canon §C4: EXT1 = 1 year added, EXT2 (incl. EXT2-FL / EXT2-BL)
--    = 2 years added. Only touches rows where the column is currently
--    NULL — preserves any explicit values (e.g. David Montgomery's
--    historical term=2 stays as-is even though it disagrees with EXT1,
--    because there's a separate data-quality question there).

-- ── Step 1: delete test rows ────────────────────────────────────
DELETE FROM ups_extension_master
WHERE season = '2026'
  AND player_id IN ('16594', '16803');

-- ── Step 2: backfill extension_term_years from contract status ──
UPDATE ups_extension_master
SET
  extension_term_years = 1,
  updated_at_utc       = datetime('now')
WHERE season = '2026'
  AND extension_term_years IS NULL
  AND UPPER(new_contract_status) = 'EXT1';

UPDATE ups_extension_master
SET
  extension_term_years = 2,
  updated_at_utc       = datetime('now')
WHERE season = '2026'
  AND extension_term_years IS NULL
  AND (
        UPPER(new_contract_status) = 'EXT2'
     OR UPPER(new_contract_status) = 'EXT2-FL'
     OR UPPER(new_contract_status) = 'EXT2-BL'
  );
