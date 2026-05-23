-- 0058_ups_owner_career_stats.sql
-- D1-backed view of pipelines/etl/data/franchise_career_stats.json so the
-- worker can read owner-attribution stats at request time (clap-back prompt
-- grounding for the trade-roast bot's Reply button).
--
-- The rebuilder (rebuild_franchise_career_stats.py) writes both the JSON file
-- AND this table in lockstep. The JSON is the human-readable artifact + the
-- input for the Python launchd bot's prompt builder; this table is the
-- worker-side mirror for runtime lookups.
--
-- Owner-tenure attribution is cross-franchise — Keith spans 0007/2010 +
-- 0008/2011-2025. The rebuilder stores Keith's stats keyed by his CURRENT
-- franchise (0008). `owner_franchises_owned` lists every franchise he's
-- been season-start owner of. Don't query src_final_standings directly for
-- owner stats — that table is franchise-keyed and would credit franchise
-- 0008's 2010 chip (won by Tom Roussin) to Keith.

CREATE TABLE IF NOT EXISTS ups_owner_career_stats (
  franchise_id                    TEXT PRIMARY KEY,        -- current franchise id (zero-padded 4 chars)
  owner_display                   TEXT NOT NULL,           -- e.g. "Keith Creelman"
  franchise_name                  TEXT,                    -- current team name (e.g. "Real Deal Creel")
  current_year                    INTEGER,                 -- upcoming season (last_completed_season + 1)

  -- Owner-tenure attribution (cross-franchise, post-override)
  owner_first_season              INTEGER,
  owner_seasons_count             INTEGER NOT NULL DEFAULT 0,  -- COMPLETED seasons only
  owner_franchises_owned          TEXT,                    -- JSON array: ["0007","0008"]
  owner_seasons_by_franchise      TEXT,                    -- JSON: {"0007":[2010], "0008":[2011..2025]}
  owner_championships             INTEGER NOT NULL DEFAULT 0,
  owner_playoff_appearances       INTEGER NOT NULL DEFAULT 0,
  owner_best_finish               INTEGER,
  owner_worst_finish              INTEGER,
  owner_allplay_w                 INTEGER NOT NULL DEFAULT 0,
  owner_allplay_l                 INTEGER NOT NULL DEFAULT 0,
  owner_allplay_pct               REAL,
  owner_overall_w                 INTEGER NOT NULL DEFAULT 0,
  owner_overall_l                 INTEGER NOT NULL DEFAULT 0,
  owner_last_championship         INTEGER,                 -- season of owner's LAST chip (null if none)

  -- Franchise-level (any owner) — useful context, must be labeled as such
  franchise_seasons_played        INTEGER NOT NULL DEFAULT 0,
  franchise_championships         INTEGER NOT NULL DEFAULT 0,
  franchise_last_championship     INTEGER,
  franchise_championship_drought  INTEGER,

  updated_at                      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_owner_career_display ON ups_owner_career_stats(owner_display);
