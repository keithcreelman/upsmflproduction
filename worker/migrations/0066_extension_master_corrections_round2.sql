-- 0066_extension_master_corrections_round2.sql
-- Corrections from Keith review 2026-05-24 (round 2):
--
-- 1. DELETE Derrick Henry 2021 EXT1 by fr=0004 (PG). The xlsx 2021 row
--    is wrong: PG didn't own Henry in 2021 (Blake had him), the existing
--    127K Blake contract was still running, and no MFL signal exists
--    for an extension event in 2021. Likely a misclassified data entry
--    in the 2021_Contract_Transaction_Log.xlsx.
--
-- 2. (Term inference fix lives in scripts/reconcile_extensions.py; re-run
--    will regenerate the derived rows with corrected term values.)

DELETE FROM ups_extension_master
WHERE league_id = '74598'
  AND season = '2021'
  AND player_id = '12626'
  AND franchise_id = '0004';
