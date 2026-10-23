-- 0173_deepcut_suggestions.sql
-- Owner suggestions for UPS Wire Deep Cuts (#ups-wire): the "Suggest a deep cut" button on every deep-cut post opens a form;
-- each submission is one row here for Keith to review. Tiny table: one write per submission, capped at 5 per owner per day.
-- status: new -> considered -> queued | declined. category: an existing deep-cut category, or a proposed new one (free text).
CREATE TABLE IF NOT EXISTS ups_deepcut_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,            -- unix seconds
  discord_user_id TEXT NOT NULL,
  discord_name TEXT,
  source_message_id TEXT,                 -- the deep-cut post the button was on
  source_channel_id TEXT,
  subject TEXT NOT NULL,                  -- the player or moment
  seasons TEXT,                           -- era, as the owner remembers it
  details TEXT,                           -- what the owner remembers
  status TEXT NOT NULL DEFAULT 'new',
  category TEXT,
  reviewer_notes TEXT,
  rounds INTEGER NOT NULL DEFAULT 0       -- follow-up rounds the owner has added (max 3)
);
CREATE INDEX IF NOT EXISTS idx_deepcut_suggestions_user ON ups_deepcut_suggestions (discord_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deepcut_suggestions_status ON ups_deepcut_suggestions (status, created_at);
-- The worker also creates this table on first use (ensureSchema), so the button works before this file is applied by hand; both are IF NOT EXISTS.
