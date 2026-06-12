-- 0076_trade_offer_dm.sql
-- Trade-offer Discord DM + multi-day reminder state. ONE row per CREATED trade
-- offer (initial OR counter) that we DM'd the recipient about. Detection is
-- event-driven off our offer-creation path (the worker can't poll an owner's
-- pendingTrades without their live MFL_USER_ID), so this table IS the system of
-- record for "who do we still need to nag." The hourly reminder cron operates
-- ONLY on this table; it never reads MFL directly.
--
-- created_at_utc is the cadence ANCHOR (day 1 = offer creation). Reconciliation
-- against the GitHub-backed stored offers doc flips state->resolved the moment
-- the offer leaves PENDING (owner acted in-app via a deep-link). The trade_id
-- PRIMARY KEY is the anti-spam dedupe guard: a duplicate creation hook
-- (retry / rollout skew) is an INSERT no-op, so a recipient is DM'd at most once.

CREATE TABLE IF NOT EXISTS trade_offer_dm (
  trade_id                   TEXT PRIMARY KEY,          -- MFL numeric trade id (digits only) = dedupe guard
  league_id                  TEXT NOT NULL,
  season                     TEXT NOT NULL,
  from_franchise_id          TEXT NOT NULL,             -- offerer (padded, e.g. 0008)
  to_franchise_id            TEXT NOT NULL,             -- recipient (the one we DM)
  from_franchise_name        TEXT,
  to_franchise_name          TEXT,
  summary_text               TEXT,                      -- one-line recap (recipient POV) so reminders are self-contained
  recipient_discord_user_id  TEXT,                      -- resolved from discord_owners at enqueue
  offerer_discord_user_id    TEXT,                      -- resolved at enqueue (for the "thinking" alert)
  dm_channel_id              TEXT,                      -- cached recipient DM channel (openDmChannel)
  offerer_dm_channel_id      TEXT,                      -- cached offerer DM channel (alert target)
  created_at_utc             TEXT NOT NULL,             -- ANCHOR = day 1 (offer creation)
  last_dm_utc                TEXT,                      -- last reminder/kickoff send to recipient
  dm_count                   INTEGER NOT NULL DEFAULT 0,
  track                      TEXT NOT NULL DEFAULT 'main'
                               CHECK (track IN ('main','thinking')),
  think_pressed_utc          TEXT,                      -- when recipient pressed "Think about it"
  think_stage                INTEGER NOT NULL DEFAULT 0,-- index into THINK_INTERVALS once on thinking track
  offerer_alerted            INTEGER NOT NULL DEFAULT 0,-- 1 once we DM'd the offerer "<x> is thinking"
  state                      TEXT NOT NULL DEFAULT 'active'
                               CHECK (state IN ('active','resolved','ended')),
  resolved_reason            TEXT,                      -- not_pending(_live)|day11_terminal|age_cap|think_cap|dm_undeliverable|no_discord_owner
  bot_message_id             TEXT,                      -- id of the day-1 DM (future: disable buttons on resolve)
  updated_at_utc             TEXT
);

-- Cron scans active rows least-recently-DM'd first.
CREATE INDEX IF NOT EXISTS idx_trade_offer_dm_active
  ON trade_offer_dm(state, last_dm_utc);

-- Reconciliation cross-checks active rows for a (league, season) against the doc.
CREATE INDEX IF NOT EXISTS idx_trade_offer_dm_league
  ON trade_offer_dm(league_id, season, state);
