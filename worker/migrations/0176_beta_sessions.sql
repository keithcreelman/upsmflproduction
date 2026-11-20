-- 0176_beta_sessions.sql — server-side sessions and invitations for the optional mobile beta (issue #1475, Stage 1).
--
-- PROVISIONAL NUMBER and NOT APPLIED. Applying it is its own approval (Keith, 2026-11-19: "Keep the migration unapplied").
-- Until it is applied, every beta code path is dark: BETA_ENABLED is off, and the cron sweep treats "no such table" as nothing to do.
--
-- ups_beta_sessions: one row per session. The phone holds a random session id; only its SHA-256 (sid_hash) is stored. A handoff code is
-- likewise stored only as a hash (handoff_hash) and only while it is pending. The owner's MFL session is stored ONLY as AES-256-GCM
-- ciphertext in mfl_enc (see worker/src/beta_session.js); it is wiped (set NULL) on sign-out, revocation, expiry, cap eviction and purge.
-- The partial unique indexes keep NULL hashes out of the index, so a spent or revoked row costs no index entry.
CREATE TABLE IF NOT EXISTS ups_beta_sessions (
  row_id             TEXT PRIMARY KEY,                       -- random; names the row; bound into the ciphertext (not a credential)
  franchise_id       TEXT NOT NULL,                          -- the franchise MFL proved at handoff
  league_id          TEXT NOT NULL,
  environment        TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  handoff_hash       TEXT,                                   -- sha256(handoff code) while pending; NULL once redeemed, revoked or evicted
  handoff_expires_at INTEGER NOT NULL,                       -- ms since epoch; 60 s after creation
  sid_hash           TEXT,                                   -- sha256(session id) once redeemed; NULL once revoked
  activated_at       INTEGER,
  expires_at         INTEGER,                                -- ms; absolute 8 h from activation; NULL while pending
  live_until         INTEGER NOT NULL,                       -- handoff_expires_at while pending, expires_at once active: drives the cap and the lookup
  revoked_at         INTEGER,
  revoked_reason     TEXT,                                   -- signout | cap | uninvited | purge | ...
  mfl_enc            TEXT,                                   -- v1.<iv>.<ciphertext>, AES-256-GCM; NULL once wiped
  key_id             TEXT,                                   -- which key sealed it (rotation)
  created_at         INTEGER NOT NULL
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS ux_beta_sessions_handoff ON ups_beta_sessions (handoff_hash) WHERE handoff_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_beta_sessions_sid ON ups_beta_sessions (sid_hash) WHERE sid_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_beta_sessions_franchise ON ups_beta_sessions (franchise_id, league_id, environment, live_until);
CREATE INDEX IF NOT EXISTS ix_beta_sessions_live_until ON ups_beta_sessions (live_until);

-- ups_beta_invites: who may use the beta, per environment. Server-side only; hiding a button is never access control.
CREATE TABLE IF NOT EXISTS ups_beta_invites (
  franchise_id TEXT NOT NULL,
  league_id    TEXT NOT NULL,
  environment  TEXT NOT NULL CHECK (environment IN ('test', 'live')),
  invited_at   INTEGER NOT NULL,
  revoked_at   INTEGER,
  note         TEXT,
  PRIMARY KEY (franchise_id, league_id, environment)
) WITHOUT ROWID;
