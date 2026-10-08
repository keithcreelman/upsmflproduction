-- Restores the EXACT original dry_run / landed / notes of every relabeled row from its audit record, then marks the
-- audit record rolled back (it is kept). Guarded: touches only rows still carrying the relabel note.
UPDATE salary_change_log SET
    dry_run = (SELECT json_extract(a.before_val, '$.dry_run') FROM ups_contract_gate_audit a WHERE a.field = 'salary_change_log_dry_run_relabel' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %'),
    landed  = (SELECT json_extract(a.before_val, '$.landed')  FROM ups_contract_gate_audit a WHERE a.field = 'salary_change_log_dry_run_relabel' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %'),
    notes   = (SELECT json_extract(a.before_val, '$.notes')   FROM ups_contract_gate_audit a WHERE a.field = 'salary_change_log_dry_run_relabel' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %')
  WHERE id IN (1233, 1234, 1235, 1236, 1237, 1238, 1240, 1243, 1246, 1248, 1250, 1253, 1256, 1259, 1262, 1264, 1265, 1266, 1267, 1269, 1271, 1698, 1699, 1700, 1704, 1705, 1876) AND notes LIKE '%' || ' | relabeled 2026-10-08: DRY RUN, no MFL request (import_status 0); originally logged dry_run=0 landed=1 by the contract-route audit-writer bug; original row + evidence in ups_contract_gate_audit field salary_change_log_dry_run_relabel'
    AND EXISTS (SELECT 1 FROM ups_contract_gate_audit a WHERE a.field = 'salary_change_log_dry_run_relabel' AND a.note LIKE 'change_log_id=' || salary_change_log.id || ' %');
UPDATE ups_contract_gate_audit SET field = 'salary_change_log_dry_run_relabel_rolled_back' WHERE field = 'salary_change_log_dry_run_relabel';
