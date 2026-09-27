-- 0159: audit columns for a commissioner's ADMINISTRATIVE cancel of a 3-way trade.
--
-- RULING (Keith, 2026-09-25): the commissioner may cancel a `collecting` 3-way as a distinct
-- administrative action (explicit COMMISH_API_KEY + a required reason) — not by impersonating the
-- initiator. The state change and its audit trail are written in ONE conditional UPDATE, so the
-- record cannot be lost or half-written. `failure_reason` stays a machine code
-- ('cancelled_by_commissioner'); the human fields live here. Rows are never deleted: the complete
-- trade history (legs, notes, extension requests, participants) is preserved.
--
-- Additive and nullable: existing rows and the owner-facing code paths are unaffected, and old
-- worker code ignores these columns. The administrative cancel itself fails closed
-- (503 migration_required, nothing changed) until this migration has been applied.
--
--   cd worker && npx wrangler d1 migrations apply ups-mfl-db --remote

ALTER TABLE ups_3way_trades ADD COLUMN cancel_basis TEXT;        -- 'cancelled_by_commissioner'
ALTER TABLE ups_3way_trades ADD COLUMN cancelled_by TEXT;        -- 'commissioner_admin' (never a franchise id)
ALTER TABLE ups_3way_trades ADD COLUMN cancel_reason TEXT;       -- the commissioner's stated reason (1..500 chars)
ALTER TABLE ups_3way_trades ADD COLUMN cancelled_at_utc TEXT;    -- ISO timestamp of the cancel
