-- Phase 3 migration 0001: corrections override table.
--
-- The canonical source of truth for most league data is MFL (public API)
-- + mfl_database.db on Keith's laptop. Sometimes historical records are
-- wrong for reasons MFL can't fix (data-entry errors pre-API coverage,
-- draft-day trades that need post-hoc attribution, player_id mis-maps
-- like the 2016 1.06 Michael Thomas DB vs WR issue). The old fix
-- pattern — mutating both the source DB and the published JSON — leaves
-- no audit trail, is fragile to ETL reruns, and is hard to reverse.
--
-- This table replaces that pattern. Every correction is one row with:
--   * what was changed (table, record, field)
--   * original and corrected values
--   * who + why (reviewer, reason)
--   * when (created_at, plus optional effective_from for time-scoped fixes)
--
-- At read time the Worker does:
--   final_value = COALESCE(correction.corrected_value, source.original_value)
-- If a correction is wrong, DELETE the row — source data is untouched.
--
-- Corrections are idempotent: (entity_kind, entity_id, field_path) +
-- effective_from is the unique key. A later correction to the same field
-- supersedes the earlier one by timestamp.

CREATE TABLE IF NOT EXISTS corrections (
  correction_id   INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What data is being corrected
  entity_kind     TEXT NOT NULL,              -- 'draft_pick', 'player', 'trade', 'contract', ...
  entity_id       TEXT NOT NULL,              -- e.g. '2016.1.06' for a pick, player_id for a player
  field_path      TEXT NOT NULL,              -- dotted path: 'player_id', 'franchise_id', 'sides.0001.gave_up'

  -- Values (stored as JSON text so they can hold scalars or structures)
  original_value  TEXT,
  corrected_value TEXT NOT NULL,

  -- Why + who
  reason          TEXT NOT NULL,
  reviewer        TEXT NOT NULL,

  -- When
  created_at_utc  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  effective_from  TEXT,                       -- nullable: fix applies retroactively from this date
  superseded_by   INTEGER REFERENCES corrections(correction_id),

  -- Traceability
  commit_sha      TEXT,                       -- the git commit that set or changed this correction
  notes           TEXT                        -- freeform context
);

CREATE INDEX IF NOT EXISTS idx_corrections_entity
  ON corrections (entity_kind, entity_id);

CREATE INDEX IF NOT EXISTS idx_corrections_active
  ON corrections (entity_kind, entity_id, field_path)
  WHERE superseded_by IS NULL;

-- Seed with the two known corrections from the current session.
-- These are the SAME fixes live in rookie_draft_history.json today
-- (commits 07e46cf and e16f0b9). Recording them here gives the
-- corrections table its first real rows and an audit trail for
-- future `/api/player-bundle` etc. to honor without re-mutating
-- source data.

INSERT OR IGNORE INTO corrections
  (entity_kind, entity_id, field_path, original_value, corrected_value, reason, reviewer, commit_sha, notes)
VALUES
  ('draft_pick', '2014.R4.06', 'franchise_id',
   '"0011"', '"0001"',
   'Ryan Bousquet (Ulterior Warrior) instructed Eric Mannila (The Baster) to make the pick on his behalf due to draft-day technical issues; trade formalized immediately. See rookie_draft_day_trades.json 2014.',
   'keith', '07e46cf',
   'Paired fix also updates franchise_name and owner_name — applied in rookie_draft_history.json.'),
  ('draft_pick', '2014.R4.06', 'franchise_name',
   '"The Baster"', '"Ulterior Warrior"',
   'Linked to 2014.R4.06 franchise_id correction.',
   'keith', '07e46cf', NULL),
  ('draft_pick', '2014.R4.06', 'owner_name',
   '"Eric Mannila"', '"Ryan Bousquet"',
   'Linked to 2014.R4.06 franchise_id correction.',
   'keith', '07e46cf', NULL),
  ('draft_pick', '2016.R1.06', 'player_id',
   '"11613"', '"12652"',
   'Pick was recorded under pid 11613 (Miami S, Michael Thomas — DB). Actual pick was pid 12652 (NOS WR Michael Thomas — Saints stud). Steve Bousquet would not have taken a DB at 1.06.',
   'keith', 'e16f0b9',
   'Performance stats in rookie_draft_history.json were nulled alongside this correction pending ETL rerun to recompute with correct player.'),
  ('draft_pick', '2016.R1.06', 'position',
   '"CB+S"', '"WR"',
   'Linked to 2016.R1.06 player_id correction.',
   'keith', 'e16f0b9', NULL);
