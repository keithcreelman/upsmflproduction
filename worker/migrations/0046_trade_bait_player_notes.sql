-- 0046 — Per-player Trade Bait notes
--
-- MFL's TYPE=tradeBait is franchise-level: WILL_GIVE_UP (PIDs) + a single
-- WILL_TAKE_TEXT comment. Owners can't attach a note to "why this player"
-- through MFL. UPS-side, owners want a per-player note ("rebuild value
-- only — won't move below $X", "package piece for a top-tier TE", etc.).
-- That metadata lives here. Read by Trade War Room + Team Ops; written
-- alongside /api/submit-trade-bait.
--
-- PK: (league_id, season, franchise_id, player_id) — one note per
-- (franchise, player, season). Empty/blank notes are removed on save so
-- the table only holds actively annotated bait.
--
-- Idempotent. Safe to re-apply.
CREATE TABLE IF NOT EXISTS ups_trade_bait_notes (
  league_id    TEXT    NOT NULL,
  season       INTEGER NOT NULL,
  franchise_id TEXT    NOT NULL,
  player_id    TEXT    NOT NULL,
  note         TEXT    NOT NULL,
  updated_at   TEXT    NOT NULL,
  PRIMARY KEY (league_id, season, franchise_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_ups_trade_bait_notes_franchise
  ON ups_trade_bait_notes (league_id, season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_ups_trade_bait_notes_player
  ON ups_trade_bait_notes (league_id, season, player_id);
