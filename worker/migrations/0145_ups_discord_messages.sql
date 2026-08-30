-- 0145_ups_discord_messages.sql
-- League chat archive, for UPS Wire recaps.
--
-- WHY: the generated weekly recaps read as a data dump because they had only
-- team totals to work with -- no names, no events, no voices. The league's
-- actual game-day chat is the missing ingredient: #the-coffee-shop carried 902
-- messages in December 2025 alone, with real digs tied to real decisions
-- ("Sweet job by Whitman playing Kamara lol"), real injury reactions, and real
-- running feuds. None of that was reachable, because Discord history lived only
-- in Discord and was never mirrored anywhere queryable.
--
-- SCOPE: this table is an ARCHIVE, not a feed. It is written by
-- pipelines/etl/scripts/ingest_discord_chat.py (backfill and ongoing) and read
-- by the Wire pack builders. Nothing in the worker request path touches it.
--
-- ATTRIBUTION: author_id is the Discord snowflake and is the ONLY reliable
-- join key -- display names differ from usernames ("RyBo" vs "rybo4591") and
-- users can change them at will. franchise_id/owner_name are resolved at
-- ingest through discord_owners, which must be filtered on active_owner='Y'
-- (fid 0008 has two rows). Bots and non-owners resolve to NULL rather than
-- being dropped, so bot posts stay available as timeline context.
--
-- WEEK BINNING: season/week are resolved at ingest. A fantasy week starts on
-- THURSDAY -- verified against canon (docs/league_context_v1.md lists 2026
-- wk15/16/17 as Dec 17/24/31, all Thursdays) and against real 2025 chat. The
-- window is [Thu 00:00 UTC of week N, Thu 00:00 UTC of week N+1). Messages
-- outside any season window get season/week NULL and are kept anyway --
-- off-season chatter is still useful for a season review.
--
-- PRIVACY: #private_league_discussion is deliberately NOT ingested; the bot
-- cannot read it and it must stay that way. See the channel allowlist in the
-- ingest script.

CREATE TABLE IF NOT EXISTS ups_discord_messages (
  message_id       TEXT PRIMARY KEY,     -- Discord snowflake; makes re-ingest idempotent
  channel_id       TEXT NOT NULL,
  channel_name     TEXT,                 -- denormalised for readability; channels get renamed
  author_id        TEXT NOT NULL,        -- Discord snowflake -- the real join key
  author_display   TEXT,                 -- global_name or username at ingest time
  franchise_id     TEXT,                 -- resolved via discord_owners; NULL for bots/non-owners
  owner_name       TEXT,                 -- resolved via discord_owners; NULL for bots/non-owners
  content          TEXT NOT NULL,
  posted_at_unix   INTEGER NOT NULL,
  season           INTEGER,              -- NULL when outside a season window (off-season chat)
  week             INTEGER,              -- fantasy week, Thursday-anchored
  is_bot           INTEGER DEFAULT 0,
  reply_to_id      TEXT,                 -- referenced_message.id, for reconstructing exchanges
  attachment_count INTEGER DEFAULT 0,
  ingested_at_utc  TEXT
);

-- The pack builder's main access path: "give me week N's chat, oldest first".
CREATE INDEX IF NOT EXISTS idx_discord_msgs_season_week
  ON ups_discord_messages(season, week, posted_at_unix);

-- Backfill/refresh cursor: "what is the newest message I already have here?"
CREATE INDEX IF NOT EXISTS idx_discord_msgs_channel_time
  ON ups_discord_messages(channel_id, posted_at_unix);

-- "What did this owner say?" -- for per-team sections and season reviews.
CREATE INDEX IF NOT EXISTS idx_discord_msgs_franchise
  ON ups_discord_messages(franchise_id, season, week);
