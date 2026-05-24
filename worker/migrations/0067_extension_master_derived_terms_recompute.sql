-- 0067_extension_master_derived_terms_recompute.sql
-- Recomputes extension_term_years for every evidence_grade='derived'
-- row using the canonical carry formula (Keith 2026-05-24):
--   term = contract_length - carry
--   carry = 0 if prev season was Rookie cy=1, else 1
--
-- Only touches rows where term is currently NULL AND grade='derived'.
-- Doesn't touch evidenced rows.

UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '10738'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '11150'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11192'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11222'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '11228'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11232'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '11239'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '11244'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '11244'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11247'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '11247'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '11644'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '11671'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '11674'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11675'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11678'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '11679'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '11706'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '11721'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '11721'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '11783'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '12152'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '12157'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '12175'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '12175'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '12175'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '12186'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '12233'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '12263'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '12611'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '12611'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '12626'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '12634'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '12650'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '12650'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '12686'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '12801'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13113'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13113'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13116'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13116'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13128'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13128'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13128'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13130'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13130'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13130'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13131'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13132'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13132'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13154'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13164'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '13168'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13189'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13230'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13230'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '13232'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13299'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13299'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2020'
   AND player_id = '13364'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '13378'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13589'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13590'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13604'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13604'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13604'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13610'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13610'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13610'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13629'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '13629'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '13630'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13633'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13635'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13635'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13671'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13671'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '13671'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2019'
   AND player_id = '13672'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '13772'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '13772'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '13850'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14056'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14073'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14073'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14075'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14079'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14085'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14085'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14085'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14102'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14104'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14104'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14109'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14109'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14136'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14136'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14138'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14147'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14208'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14208'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14225'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14225'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14778'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14778'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14782'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14782'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14783'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14797'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14797'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14800'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14800'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14802'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14832'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14835'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14835'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14836'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '14840'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14842'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14842'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14842'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14860'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14867'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '14867'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2022'
   AND player_id = '14877'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '14974'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15238'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15240'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15241'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15254'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15254'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15256'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15259'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15259'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15259'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15271'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15281'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15281'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15282'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15282'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15282'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15284'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15287'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15289'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15293'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15329'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15329'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15329'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15350'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15350'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15350'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2023'
   AND player_id = '15355'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15711'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15711'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15715'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15715'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15749'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15749'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15751'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15751'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15754'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15754'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15799'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15799'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '15805'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '15805'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16162'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16167'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16185'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16186'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16187'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16190'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16194'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16204'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16206'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16213'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '16223'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '16239'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2024'
   AND player_id = '16342'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16342'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 2,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2025'
   AND player_id = '16643'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
UPDATE ups_extension_master
   SET extension_term_years = 1,
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '2018'
   AND player_id = '8687'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
