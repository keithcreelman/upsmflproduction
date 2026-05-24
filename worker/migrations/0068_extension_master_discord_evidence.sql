-- 0068_extension_master_discord_evidence.sql
-- Upgrades evidence_grade='derived' rows to 'evidenced' for any
-- (season, player_id, franchise_id) we found a Discord extension
-- message confirming. Preserves derived contract details; just adds
-- the Discord URL + quote to evidence_source.

UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord:discord_contract_activity:2024-12-07:cleoncash366: "Extend CeeDee 2/64 per"',
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '14832'
   AND franchise_id = '0011'
   AND evidence_grade = 'derived';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord:discord_contract_activity:2025-08-14:papabear4110: "Extend Tee Higgins 1 year so 1,47 and then restructure 24,24. Should be my 2nd restructure."',
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '14835'
   AND franchise_id = '0009'
   AND evidence_grade = 'derived';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord:discord_contract_activity:2025-08-17:papabear4110: "Extend Tony Pollard 1 year at 27k.  Workhorse."',
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '14085'
   AND franchise_id = '0009'
   AND evidence_grade = 'derived';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord:discord_contract_activity:2025-08-31:papabear4110: "I’m gonna extend JSN 2 years and restructure to 14,1,55  Thank you, Deputy Doofy"',
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '16185'
   AND franchise_id = '0009'
   AND evidence_grade = 'derived';
