-- 0158_discord_message_ingestion.sql
--
-- Foundation for the shared Discord intelligence service (Keith 2026-09-16
-- spec). Scoped to REST reconciliation only this pass -- no Gateway listener
-- yet (that lands as a later extension of trade_roast_bot.py, the one
-- process that already holds a Gateway session; see
-- pipelines/etl/scripts/discord_reconcile.py's docstring). Deletion
-- detection is therefore INFERRED (a previously-seen message missing from a
-- re-fetch of its window), not delivered by Discord's own MESSAGE_DELETE
-- event -- flagged explicitly in discord_message_events.detail, never
-- silently treated as certain.
--
-- discord_quotes is schema-only here -- NOT populated by this migration or
-- discord_reconcile.py. Every quote surface in this repo today is Keith
-- hand-curating owner_profiles.json; automating "what counts as
-- quote-worthy" is a real product decision -- the Coffee Shop's 11,652
-- messages have documented ~3.9% retrieval value (docs/DISCORD_REDESIGN_2026.md)
-- -- that was deliberately left out of this scoped pass rather than guessed at.

CREATE TABLE IF NOT EXISTS discord_messages_raw (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  parent_message_id TEXT,
  author_id TEXT NOT NULL,
  author_display_name TEXT,
  content TEXT,
  message_url TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  edited_at_utc TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  deleted_inferred_at_utc TEXT,
  first_captured_at_utc TEXT NOT NULL,
  last_verified_at_utc TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_messages_raw_channel_created
  ON discord_messages_raw (channel_id, created_at_utc);

CREATE TABLE IF NOT EXISTS discord_message_revisions (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT,
  captured_at_utc TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id, message_id, revision)
);

CREATE TABLE IF NOT EXISTS discord_message_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  event_type TEXT NOT NULL,  -- created | edited | deleted
  event_at_utc TEXT NOT NULL,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_discord_message_events_message
  ON discord_message_events (guild_id, channel_id, message_id);

CREATE TABLE IF NOT EXISTS discord_ingest_cursors (
  channel_id TEXT PRIMARY KEY,
  channel_name TEXT,
  last_message_id TEXT,
  last_synced_at_utc TEXT,
  last_status TEXT
);

CREATE TABLE IF NOT EXISTS discord_sync_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_at_utc TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,
  new_messages INTEGER NOT NULL DEFAULT 0,
  edited_messages INTEGER NOT NULL DEFAULT 0,
  deleted_messages_inferred INTEGER NOT NULL DEFAULT 0,
  threads_reconciled INTEGER NOT NULL DEFAULT 0,
  api_errors TEXT,
  duration_ms INTEGER,
  status TEXT NOT NULL  -- ok | partial | failed
);

CREATE INDEX IF NOT EXISTS idx_discord_sync_health_run_at
  ON discord_sync_health (run_at_utc);

-- Schema only -- see header note. quote_id = guild_id:channel_id:message_id:revision,
-- the uniqueness key the spec asks for, as a single indexable column.
CREATE TABLE IF NOT EXISTS discord_quotes (
  quote_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  author_id TEXT NOT NULL,
  author_display_name TEXT,
  quoted_text TEXT NOT NULL,
  context_text TEXT,
  franchise_id TEXT,
  player_id TEXT,
  extraction_confidence REAL,
  first_seen_at_utc TEXT NOT NULL,
  last_verified_at_utc TEXT NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  superseded_by_quote_id TEXT
);
