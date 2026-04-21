BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  applied_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_environment (
  env_key TEXT PRIMARY KEY,
  env_name TEXT NOT NULL,
  league_id TEXT,
  is_writable INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dependency_register (
  dep_id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('blocker','high','medium','low')),
  status TEXT NOT NULL DEFAULT 'open',
  owner_lane TEXT NOT NULL,
  blocking_phase TEXT,
  notes TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publish_batch (
  batch_id TEXT PRIMARY KEY,
  publish_scope TEXT NOT NULL,
  publish_unit_type TEXT NOT NULL,
  approval_class TEXT NOT NULL,
  verification_type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS publish_unit (
  unit_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES publish_batch(batch_id),
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  state TEXT NOT NULL,
  requires_mfl_readback INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'pending',
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_event (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL,
  source TEXT NOT NULL,
  reference_key TEXT,
  payload_json TEXT,
  created_at_utc TEXT NOT NULL
);

INSERT OR IGNORE INTO schema_migrations (name, applied_at_utc)
VALUES ('0001_governance_foundation', strftime('%Y-%m-%dT%H:%M:%SZ','now'));

INSERT OR IGNORE INTO runtime_environment (env_key, env_name, league_id, is_writable, description) VALUES
  ('prod_mirror','Production Mirror','74598',0,'Read-only verified mirror of production league state'),
  ('test_working','Primary Test Working','25625',1,'Writable test league runtime and validation target'),
  ('future_lab_2027','Future Lab 2027',NULL,1,'Deferred experiment environment enabled in Phase 11+');

COMMIT;
