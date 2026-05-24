-- 0069_extension_master_discord_bot.sql
-- 12 structured contract-extension announcements from UPS Contracts
-- Hub Bot (discord_contract_activity.csv, 2025-05+). High-confidence
-- evidence — bot's structured fields give us owner, player, term, TCV,
-- AAV, GTD verbatim. Upgrades existing derived rows to evidenced;
-- inserts new evidenced rows for any not yet in master.

UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:Hawks: TCV=$44000 years=2 gtd=$33000',
       new_tcv         = COALESCE(new_tcv, 44000),
       new_aav         = COALESCE(new_aav, 22000),
       new_gtd         = COALESCE(new_gtd, 33000),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0012',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15710';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:Sex Manther: TCV=$20000 years=1 gtd=$15000',
       new_tcv         = COALESCE(new_tcv, 20000),
       new_aav         = COALESCE(new_aav, 20000),
       new_gtd         = COALESCE(new_gtd, 15000),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0007',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15756';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:HammerTime 🔨 ⏰: TCV=$44000 years=2 gtd=$33000',
       new_tcv         = COALESCE(new_tcv, 44000),
       new_aav         = COALESCE(new_aav, 22000),
       new_gtd         = COALESCE(new_gtd, 33000),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0005',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15794';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:HammerTime 🔨 ⏰: TCV=$5000 years=1 gtd=$3750',
       new_tcv         = COALESCE(new_tcv, 5000),
       new_aav         = COALESCE(new_aav, 5000),
       new_gtd         = COALESCE(new_gtd, 3750),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0005',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15834';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:HammerTime 🔨 ⏰: TCV=$162000 years=3 gtd=$121500',
       new_tcv         = COALESCE(new_tcv, 162000),
       new_aav         = COALESCE(new_aav, 54000),
       new_gtd         = COALESCE(new_gtd, 121500),
       extension_term_years = COALESCE(extension_term_years, 2),
       franchise_id    = '0005',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15281';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:CBP: TCV=$14000 years=1 gtd=$10500',
       new_tcv         = COALESCE(new_tcv, 14000),
       new_aav         = COALESCE(new_aav, 14000),
       new_gtd         = COALESCE(new_gtd, 10500),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0002',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15742';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-17:CBP: TCV=$12000 years=1 gtd=$9000',
       new_tcv         = COALESCE(new_tcv, 12000),
       new_aav         = COALESCE(new_aav, 12000),
       new_gtd         = COALESCE(new_gtd, 9000),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0002',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15798';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-18:Blake Bombers: TCV=$15000 years=1 gtd=$11250',
       new_tcv         = COALESCE(new_tcv, 15000),
       new_aav         = COALESCE(new_aav, 15000),
       new_gtd         = COALESCE(new_gtd, 11250),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0010',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15712';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-20:Blake Bombers: TCV=$12000 years=1 gtd=$9000',
       new_tcv         = COALESCE(new_tcv, 12000),
       new_aav         = COALESCE(new_aav, 12000),
       new_gtd         = COALESCE(new_gtd, 9000),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0010',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15757';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-21:C-Town Chivalry: TCV=$19000 years=1 gtd=$14250',
       new_tcv         = COALESCE(new_tcv, 19000),
       new_aav         = COALESCE(new_aav, 19000),
       new_gtd         = COALESCE(new_gtd, 14250),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0009',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15762';
UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | discord_bot:2025-05-21:C-Town Chivalry: TCV=$15000 years=1 gtd=$11250',
       new_tcv         = COALESCE(new_tcv, 15000),
       new_aav         = COALESCE(new_aav, 15000),
       new_gtd         = COALESCE(new_gtd, 11250),
       extension_term_years = COALESCE(extension_term_years, 1),
       franchise_id    = '0009',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '2025'
   AND player_id   = '15716';
