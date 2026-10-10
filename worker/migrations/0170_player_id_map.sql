-- 0170: MFL player id -> NFL (gsis) id by IDENTIFIERS, with the evidence.
-- Built by pipelines/etl/scripts/build_player_id_map.py (DynastyProcess's
-- mfl_id row + nflverse's ESPN id, birthdate/draft/position checks, reviewed
-- overrides in pipelines/etl/data/player_id_map_overrides.csv). Never a name.
--
-- WHY (2026-10-10). player_id_crosswalk was last built 2026-04-22 — before the
-- draft — so all 167 rookies with 2026 NFL games had no NFL id on the player
-- card (empty game log, no snaps / MFL position on the leaderboard), and its 3
-- name-only fuzzy rows were wrong (J'Mari Taylor resolved to J.J. Taylor).
-- The worker prefers an accepted row here and falls back to the crosswalk's
-- non-fuzzy rows for players MFL no longer lists (past seasons).
CREATE TABLE IF NOT EXISTS player_id_map (
  mfl_id     TEXT PRIMARY KEY,      -- MFL player id, no zero padding ('15698')
  gsis_id    TEXT,                  -- the NFL id the routes agree on (NULL when none)
  pfr_id     TEXT,                  -- nflverse players.pfr_id for that gsis (snap counts join) — accepted rows only
  espn_id    TEXT,                  -- MFL's espn_id
  status     TEXT NOT NULL,         -- verified | verified_dp | single_route | bio_flag | override_accept
                                    -- | id_suspect | id_disagree | dup_claim | unmapped | override_exclude
  accepted   INTEGER NOT NULL DEFAULT 0,
  routes     TEXT,                  -- JSON: which ID route gave which gsis
  checks     TEXT,                  -- JSON: birthdate / draft / position results
  note       TEXT,
  built_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_player_id_map_gsis ON player_id_map (gsis_id);
CREATE INDEX IF NOT EXISTS idx_player_id_map_pfr  ON player_id_map (pfr_id);
