-- 0030_tag_master.sql
-- "Master" tag table — the current-state mirror of who is tagged right
-- now in a given season. Companion to ups_tag_submissions (0029):
--
--   ups_tag_submissions  → transactional audit (every tag + every untag,
--                          with timestamps; rows are append-only)
--   ups_tag_master       → current-state truth (one row per active tag;
--                          UPSERTed on tag, DELETEd on untag)
--
-- Unique key (league_id, season, franchise_id, tag_side) so each
-- franchise has at most one OFFENSE + one DEFENSE tag per season. A
-- re-tag (e.g., owner cancels + tags a different player on the same
-- side) UPSERTs into the same row.
--
-- Distinct from the existing ups_tag_history table (legacy 2012-2024
-- Franchise/Transition mechanics, loaded once via offline script) —
-- those rows are historical-final and should never be touched by the
-- live worker. ups_tag_master only tracks the modern unified Tag
-- (2025+) where there's just one side category per OFFENSE / DEFENSE.

CREATE TABLE IF NOT EXISTS ups_tag_master (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id         TEXT NOT NULL,
  season            TEXT NOT NULL,
  franchise_id      TEXT NOT NULL,        -- 4-char zero-padded
  tag_side          TEXT NOT NULL,        -- 'OFFENSE' | 'DEFENSE'
  player_id         TEXT NOT NULL,
  player_name       TEXT,
  position          TEXT,
  salary            INTEGER,              -- tag salary at confirmation (USD)
  source            TEXT,                 -- 'roster-workbench' etc.
  tagged_at_utc     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at_utc    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Each franchise can hold at most one tag per side per season. UPSERT
-- uses this index to swap player when a side is re-tagged.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tag_master_slot
  ON ups_tag_master(league_id, season, franchise_id, tag_side);

CREATE INDEX IF NOT EXISTS idx_tag_master_player    ON ups_tag_master(season, player_id);
CREATE INDEX IF NOT EXISTS idx_tag_master_franchise ON ups_tag_master(season, franchise_id);
