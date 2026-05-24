-- 0072_extension_master_extender_franchise_fix.sql
-- Per Keith 2026-05-24 + reconciliation pass: rows where master
-- franchise_id was set to the post-trade EOS franchise (acquirer)
-- but contract_info "Ext: <owner>" identifies a DIFFERENT extending
-- franchise. The pre-trade extension is the trading-away team's last
-- action; master must record the extender, not the receiver.
--
-- Examples:
--   • Jordan Love 2024 master fr=0002 (CBP) but "Ext: PG" → fr=0004
--   • Michael Pittman 2025 master fr=0003 (Gride) but "Ext: PG" → fr=0004
--   • DeVonta Smith 2024 master fr=0002 (CBP) but "Ext: GR" → fr=0003
--
-- Multi-owner annotations like "Ext: Mafia, LH, C-Town" are SKIPPED
-- here — those record multiple owners across the contract's history
-- and need manual review.

UPDATE ups_extension_master
   SET franchise_id    = '0009',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0005_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '11244';
UPDATE ups_extension_master
   SET franchise_id    = '0007',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '12611';
UPDATE ups_extension_master
   SET franchise_id    = '0001',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0006_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '12650';
UPDATE ups_extension_master
   SET franchise_id    = '0010',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0006_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '13590';
UPDATE ups_extension_master
   SET franchise_id    = '0008',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0011_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '13772';
UPDATE ups_extension_master
   SET franchise_id    = '0001',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0006_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '13850';
UPDATE ups_extension_master
   SET franchise_id    = '0008',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0004_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14102';
UPDATE ups_extension_master
   SET franchise_id    = '0006',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14109';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14147';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0003_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14208';
UPDATE ups_extension_master
   SET franchise_id    = '0001',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0011_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14800';
UPDATE ups_extension_master
   SET franchise_id    = '0001',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0003_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14805';
UPDATE ups_extension_master
   SET franchise_id    = '0003',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14833';
UPDATE ups_extension_master
   SET franchise_id    = '0001',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0011_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14845';
UPDATE ups_extension_master
   SET franchise_id    = '0008',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '14867';
UPDATE ups_extension_master
   SET franchise_id    = '0011',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '15254';
UPDATE ups_extension_master
   SET franchise_id    = '0006',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0005_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '15259';
UPDATE ups_extension_master
   SET franchise_id    = '0005',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '15271';
UPDATE ups_extension_master
   SET franchise_id    = '0003',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0008_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2023'
   AND player_id = '15329';
UPDATE ups_extension_master
   SET franchise_id    = '0009',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0005_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '11244';
UPDATE ups_extension_master
   SET franchise_id    = '0007',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '12611';
UPDATE ups_extension_master
   SET franchise_id    = '0007',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0012_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '13629';
UPDATE ups_extension_master
   SET franchise_id    = '0006',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0008_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '14109';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0003_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '14208';
UPDATE ups_extension_master
   SET franchise_id    = '0008',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0011_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '14860';
UPDATE ups_extension_master
   SET franchise_id    = '0011',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15254';
UPDATE ups_extension_master
   SET franchise_id    = '0008',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0003_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15281';
UPDATE ups_extension_master
   SET franchise_id    = '0009',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15290';
UPDATE ups_extension_master
   SET franchise_id    = '0003',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0008_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15329';
UPDATE ups_extension_master
   SET franchise_id    = '0006',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15350';
UPDATE ups_extension_master
   SET franchise_id    = '0002',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0009_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15715';
UPDATE ups_extension_master
   SET franchise_id    = '0011',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0008_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2024'
   AND player_id = '15805';
UPDATE ups_extension_master
   SET franchise_id    = '0007',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '12611';
UPDATE ups_extension_master
   SET franchise_id    = '0007',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0012_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '13629';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0002_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '14782';
UPDATE ups_extension_master
   SET franchise_id    = '0010',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0008_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '14823';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0003_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '14842';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0006_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15238';
UPDATE ups_extension_master
   SET franchise_id    = '0003',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0006_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15329';
UPDATE ups_extension_master
   SET franchise_id    = '0006',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15350';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0009_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15711';
UPDATE ups_extension_master
   SET franchise_id    = '0002',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0009_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15715';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0001_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15749';
UPDATE ups_extension_master
   SET franchise_id    = '0004',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0009_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15751';
UPDATE ups_extension_master
   SET franchise_id    = '0010',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0004_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15754';
UPDATE ups_extension_master
   SET franchise_id    = '0011',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0004_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '15805';
UPDATE ups_extension_master
   SET franchise_id    = '0003',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0004_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '16190';
UPDATE ups_extension_master
   SET franchise_id    = '0010',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr=0004_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '2025'
   AND player_id = '16342';
