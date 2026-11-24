-- UPS TEST database setup (#1475). Run ONLY against the test database, after Keith approves:
--   npx wrangler d1 execute ups-test-db --remote --config wrangler.test.toml --file test_env/ups_test_db_setup.sql
-- NEVER against ups-mfl-db. If this marker ever reached the production database, a test
-- deployment bound to it would pass its database check; nothing else creates this table
-- (tests/ups_env_guard.test.mjs fails if a migration ever does).
--
-- The test worker reads this table before serving any request (SELECT env, league_id FROM
-- ups_env_marker) and refuses everything unless every row says env='test' and the test league.
CREATE TABLE IF NOT EXISTS ups_env_marker (
  env TEXT NOT NULL CHECK (env = 'test'),
  league_id TEXT NOT NULL CHECK (league_id <> '74598'),
  created_at TEXT NOT NULL,
  note TEXT
);
INSERT INTO ups_env_marker (env, league_id, created_at, note)
SELECT 'test', '25625', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), 'UPS test database for league 25625 (#1475)'
WHERE NOT EXISTS (SELECT 1 FROM ups_env_marker);

-- The write ledger and outbound log (also created on first use by test_env_runtime.js).
CREATE TABLE IF NOT EXISTS ups_test_write_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
  league_id TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  query_redacted TEXT,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','responded','uncertain','failed','resolved_applied','resolved_not_applied')),
  http_status INTEGER,
  response_sha256 TEXT,
  response_body TEXT,
  response_content_type TEXT,
  egress_json TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  resolution_note TEXT,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS ups_test_egress_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  env TEXT NOT NULL DEFAULT 'test' CHECK (env = 'test'),
  ts TEXT NOT NULL,
  idempotency_key TEXT,
  method TEXT,
  url_redacted TEXT,
  host TEXT,
  decision TEXT,
  kind TEXT,
  reason TEXT,
  status INTEGER,
  error TEXT
);
