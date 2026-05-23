-- 0057_ups_roast_threads.sql
-- Per-roast tracking for the Discord trade-roast bot's Reply button.
--
-- The bot posts a 3-part Discord thread per trade (announcement embed →
-- threaded roast → GIF reaction). The roast message carries a "💬 Reply
-- to bot" button. Clicking it routes to the worker (because the Discord
-- App has an Interactions Endpoint URL set, which bypasses the launchd
-- Python bot's gateway connection). The worker needs the roast's prompt
-- context to generate a clap-back — so the Python bot writes one row
-- here per roast, and the worker reads it on button → modal → submit.
--
-- Lifecycle: rows persist for ~30 days, then a sweeper (future) prunes
-- by posted_at. Short-lived because relevance dies after the trade is
-- old news.
--
-- Reply lookup path:
--   Discord button click → custom_id `roast_reply:<roast_message_id>`
--   → worker queries by roast_message_id
--   → loads context_text + thread_id
--   → modal submit → classify (Sonnet) → clap-back (Sonnet) → post
--     to thread_id via Discord bot token.

CREATE TABLE IF NOT EXISTS ups_roast_threads (
  roast_message_id          TEXT PRIMARY KEY,        -- the Discord message id of the roast (the one carrying the Reply button)
  trade_id                  TEXT,                    -- MFL transaction id (informational; trade-counter lookups)
  thread_id                 TEXT NOT NULL,           -- Discord thread channel id (where clap-backs post)
  channel_id                TEXT NOT NULL,           -- parent channel id (the trade channel)
  announcement_message_id   TEXT,                    -- Discord message id of the announcement embed
  context_text              TEXT NOT NULL,           -- roast prompt context (full text, used as classify+clap-back grounding)
  roast_text                TEXT,                    -- the actual roast that was posted (informational)
  trade_franchises          TEXT,                    -- comma-separated fids involved (e.g. "0005,0006")
  posted_at                 INTEGER NOT NULL         -- unix epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_roast_threads_thread ON ups_roast_threads(thread_id);
CREATE INDEX IF NOT EXISTS idx_roast_threads_trade ON ups_roast_threads(trade_id);
CREATE INDEX IF NOT EXISTS idx_roast_threads_posted ON ups_roast_threads(posted_at);
