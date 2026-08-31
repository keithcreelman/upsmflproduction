-- 0146 — ups_ir_roster_status: last-known-status ledger for the native
-- IR-move detector (worker/src/index.js scheduled(), hourly cron).
--
-- WHY THIS TABLE EXISTS
--   The app's Discord IR announcement only ever fired at write-time, from
--   this app's own /roster-workbench/action "deactivate_ir"/"activate_ir"
--   handler. A move made on MFL's native page never touches that route, so
--   it was silent forever -- discovered 2026-08-31 when Hammer (franchise
--   0005) placed Josh Jacobs on IR with zero Discord announcement. Same
--   blind spot as the ERA auto-drop incident (unload_player posts MFL's own
--   commish web form, invisible to import?TYPE=rosters grep).
--
--   Detection is a plain before/after diff: every hourly tick reads the
--   whole roster export, compares each (season, league, franchise, player)
--   row's status against what this table last recorded, and treats a
--   non-IR -> IR (or IR -> non-IR) transition as the event to announce.
--
-- WHY A LEDGER, NOT A RE-DERIVATION FROM A SNAPSHOT
--   The daily mfl-snapshots directory captures roster state once a day;
--   this needs hourly resolution AND a place to record "already announced"
--   so a re-run of the same hour's poll (or a Worker restart) cannot
--   double-announce the same transition. Modeled on ups_bot_heartbeat's
--   one-row-per-key upsert shape, not on the append-only event-log tables
--   elsewhere in this schema -- there is exactly one current status per
--   player worth keeping, not a history of every poll.
--
-- Apply directly (the d1_migrations tracker was reconciled 2026-08-17 and
-- `wrangler d1 migrations apply` is safe again -- see
-- reference_d1_migration_tracker_drift memory -- but a targeted file apply
-- remains the simplest way to ship exactly one new table):
--   cd worker && npx wrangler d1 execute ups-mfl-db --remote --file migrations/0146_ir_native_status_ledger.sql
CREATE TABLE IF NOT EXISTS ups_ir_roster_status (
  season          TEXT    NOT NULL,
  league_id       TEXT    NOT NULL,
  franchise_id    TEXT    NOT NULL,
  player_id       TEXT    NOT NULL,
  last_status     TEXT    NOT NULL,   -- MFL's raw roster status string, upper-cased (ROSTER / TAXI_SQUAD / INJURED_RESERVE / ...)
  last_checked_at INTEGER NOT NULL,   -- unix seconds, updated every tick regardless of whether status changed
  PRIMARY KEY (season, league_id, franchise_id, player_id)
);
