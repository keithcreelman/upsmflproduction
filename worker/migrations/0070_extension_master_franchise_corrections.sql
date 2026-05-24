-- 0070_extension_master_franchise_corrections.sql
-- Three franchise_id corrections per Keith review 2026-05-24:
-- master had been recording the franchise that ENDED UP with the player
-- (post-trade), but canon §C4 + audit semantics require the franchise
-- that DID THE EXTENSION (pre-trade extending team).
--
-- 1. Jordan Addison 2025: Long Haulers (0006) extended pre-trade,
--    player went to HammerTime (0005). Discord:
--    "Extend Jordan Addison I year by the Long Haulers" — briancross0914
-- 2. Jahmyr Gibbs 2025: Sex Manther (0007) extended per pending trade
--    to PG (0004). Discord: "Extend Gibbs 2yrs per trade" — sexmanther
-- 3. Josh Downs 2026: Gride (0003) extended pre-trade, player went to
--    Long Haulers (0006). Discord:
--    "Prior to trade with Long Haulers, Gride extends Josh Downs for
--    1 year = 2026 $12,000" — gride09

UPDATE ups_extension_master
   SET franchise_id    = '0006',
       evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source,'') || ' | discord:contract_activity:2025-03-27:briancross0914: "Extend Jordan Addison I year by the Long Haulers"',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598' AND season = '2025' AND player_id = '16186';

UPDATE ups_extension_master
   SET franchise_id    = '0007',
       evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source,'') || ' | discord:contract_activity:2025-08-20:sexmanther: "Extend Gibbs 2yrs per trade"',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598' AND season = '2025' AND player_id = '16162';

UPDATE ups_extension_master
   SET franchise_id    = '0003',
       evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source,'') || ' | discord:contract_activity:2025-10-22:gride09: "Prior to trade with Long Haulers, Gride extends Josh Downs for 1 year = 2026 $12,000"',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598' AND season = '2026' AND player_id = '16187';
