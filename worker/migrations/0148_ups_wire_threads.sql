-- 0148_ups_wire_threads.sql
-- Per-post tracking for the UPS Wire's Discord "💬 Challenge this" button.
--
-- Mirrors 0057_ups_roast_threads.sql for the trade-roast bot's Reply button,
-- same reason: the Discord App's Interactions Endpoint URL routes every
-- component click to this worker, so the worker needs the announcement's
-- grounding context (what the article said, what the roast paragraph said)
-- to generate a clap-back when someone challenges the post.
--
-- Reply lookup path:
--   Discord button click -> custom_id `wire_reply:<wire_message_id>`
--   -> worker queries by wire_message_id
--   -> loads context_text + thread_id
--   -> modal submit -> classify (Sonnet) -> clap-back (Opus/Sonnet) -> post
--      to thread_id via Discord bot token.

CREATE TABLE IF NOT EXISTS ups_wire_threads (
  wire_message_id   TEXT PRIMARY KEY,   -- Discord message id of the announcement (the one carrying the Challenge button)
  article_id        TEXT,               -- Wire article id (e.g. "2026-season-forecast")
  thread_id         TEXT NOT NULL,      -- Discord thread channel id (where clap-backs post)
  channel_id        TEXT NOT NULL,      -- parent channel id
  article_title     TEXT,               -- article headline (informational)
  context_text      TEXT NOT NULL,      -- article dek + roast paragraph(s), used as classify+clap-back grounding
  posted_at         INTEGER NOT NULL    -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_wire_threads_thread ON ups_wire_threads(thread_id);
CREATE INDEX IF NOT EXISTS idx_wire_threads_posted ON ups_wire_threads(posted_at);
