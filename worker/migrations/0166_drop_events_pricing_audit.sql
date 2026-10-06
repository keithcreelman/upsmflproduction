-- 0166 — every change to how a drop is PRICED is written to the audit table,
-- whoever makes it.
--
-- Why (Keith 2026-10-06, Colbie Young, ups_drop_events id 96):
--   - The row's pre-drop contract and exemption were rewritten after the
--     2026-09-08 Discord post. Some fields matched a 3-year MYAC; the
--     contract text and the exempt flag matched a stale 1-year snapshot.
--   - Nothing recorded which write did it, so the row sat self-contradictory
--     for a month.
--   - Worker repairs already audit their own writes. A hand-run SQL fix, a
--     script or a future route does not have to.
--   - This trigger audits all of them, at the database.
--
-- Only PRICING columns are watched: the pre-drop contract, penalty, basis,
-- exemption, guarantee and earned. Discord / MFL-posting / cap-season
-- bookkeeping updates are not logged. SQLite does not count trigger writes in
-- changes(), so every worker guard of the form `meta.changes !== 1` /
-- `WHERE changes() = 1` behaves exactly as before
-- (tests/drop_events_pricing_audit.test.mjs).
CREATE TABLE IF NOT EXISTS ups_contract_gate_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at_utc TEXT NOT NULL, season TEXT, field TEXT NOT NULL,
  before_val TEXT, after_val TEXT, actor TEXT, note TEXT
);

CREATE TRIGGER IF NOT EXISTS trg_ups_drop_events_pricing_audit
AFTER UPDATE ON ups_drop_events
FOR EACH ROW
WHEN OLD.pre_drop_contract_status IS NOT NEW.pre_drop_contract_status
  OR OLD.pre_drop_salary IS NOT NEW.pre_drop_salary
  OR OLD.pre_drop_contract_year IS NOT NEW.pre_drop_contract_year
  OR OLD.pre_drop_contract_length IS NOT NEW.pre_drop_contract_length
  OR OLD.pre_drop_contract_info IS NOT NEW.pre_drop_contract_info
  OR OLD.pre_drop_tcv IS NOT NEW.pre_drop_tcv
  OR OLD.pre_drop_years_remaining IS NOT NEW.pre_drop_years_remaining
  OR OLD.earned_to_date IS NOT NEW.earned_to_date
  OR OLD.guaranteed_amount IS NOT NEW.guaranteed_amount
  OR OLD.penalty_amount IS NOT NEW.penalty_amount
  OR OLD.penalty_basis IS NOT NEW.penalty_basis
  OR OLD.penalty_exempt IS NOT NEW.penalty_exempt
  OR OLD.penalty_exempt_reason IS NOT NEW.penalty_exempt_reason
BEGIN
  INSERT INTO ups_contract_gate_audit (at_utc, season, field, before_val, after_val, actor, note)
  VALUES (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    NEW.season,
    'ups_drop_events_pricing_change',
    json_object(
      'pre_drop_contract_status', OLD.pre_drop_contract_status, 'pre_drop_salary', OLD.pre_drop_salary,
      'pre_drop_contract_year', OLD.pre_drop_contract_year, 'pre_drop_contract_length', OLD.pre_drop_contract_length,
      'pre_drop_contract_info', OLD.pre_drop_contract_info, 'pre_drop_tcv', OLD.pre_drop_tcv,
      'pre_drop_years_remaining', OLD.pre_drop_years_remaining, 'earned_to_date', OLD.earned_to_date,
      'guaranteed_amount', OLD.guaranteed_amount, 'penalty_amount', OLD.penalty_amount,
      'penalty_basis', OLD.penalty_basis, 'penalty_exempt', OLD.penalty_exempt,
      'penalty_exempt_reason', OLD.penalty_exempt_reason, 'snapshot_source', OLD.snapshot_source),
    json_object(
      'pre_drop_contract_status', NEW.pre_drop_contract_status, 'pre_drop_salary', NEW.pre_drop_salary,
      'pre_drop_contract_year', NEW.pre_drop_contract_year, 'pre_drop_contract_length', NEW.pre_drop_contract_length,
      'pre_drop_contract_info', NEW.pre_drop_contract_info, 'pre_drop_tcv', NEW.pre_drop_tcv,
      'pre_drop_years_remaining', NEW.pre_drop_years_remaining, 'earned_to_date', NEW.earned_to_date,
      'guaranteed_amount', NEW.guaranteed_amount, 'penalty_amount', NEW.penalty_amount,
      'penalty_basis', NEW.penalty_basis, 'penalty_exempt', NEW.penalty_exempt,
      'penalty_exempt_reason', NEW.penalty_exempt_reason, 'snapshot_source', NEW.snapshot_source),
    'd1_trigger',
    'drop_event_id=' || NEW.id || ' player=' || NEW.player_id || ' franchise=' || NEW.franchise_id
  );
END;
