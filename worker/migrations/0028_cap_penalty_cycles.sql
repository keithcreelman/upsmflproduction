-- 0028_cap_penalty_cycles.sql
--
-- Cap-penalty cycle tracking + era-aware calculation foundation.
-- Build context: docs/league_context_v1.md Section 6.B (UPDATED 2026-05-08)
-- + Section 4 "2019 — Cap-penalty system overhaul" (CONFIRMED 2026-05-08).
--
-- Design intent (from Keith's spec):
--   1. Two layers of values per closed cycle:
--      - LEGACY: what was actually applied to the cap at the moment of the
--        historical drop. Immutable. Never restated when rules change.
--      - COMPARISON: what each rule era WOULD compute for the same cycle.
--        Useful for apples-to-apples old-vs-new analysis. Recomputed if
--        rules change.
--   2. Each ON→OFF round per player per franchise = one cycle. Re-acquisition
--      starts a new cycle (fresh denominator, fresh weeks_active counter).
--   3. weeks_active = derived (single source) from per-week roster status,
--      validated against MFL weekly snapshots where available (2020+).
--
-- See `pipelines/etl/lib/cap_penalty.py` and `worker/src/lib/cap_penalty.js`
-- for the era-aware calculator that consumes these tables.

-- ---------------------------------------------------------------------------
-- Reference table: NFL season schedule (Week 1 Thursday + total reg-season
-- weeks). Pre-2021 = 16 weeks; 2021+ = 17 weeks. Anchors the per-week
-- earning denominator.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS nfl_season_calendar (
  season                INTEGER PRIMARY KEY,
  regular_season_weeks  INTEGER NOT NULL,        -- 16 (pre-2021) or 17 (2021+)
  week1_thursday        TEXT NOT NULL,           -- ISO date YYYY-MM-DD (Thursday kickoff)
  week1_kickoff_utc     TEXT,                    -- ISO timestamp if known, else NULL
  source                TEXT,                    -- 'nflcom_official' | 'league_events' | 'manual'
  notes                 TEXT
);

-- ---------------------------------------------------------------------------
-- Reference table: cap-penalty rule eras. Single source of truth for
-- "which era was in effect on a given drop date" — though the actual
-- era determination ALSO depends on the contract's grandfather flag.
-- See determine_rule_era() in the calculator.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cap_penalty_rule_eras (
  era_id           TEXT PRIMARY KEY,           -- e.g., 'era_pre_2019_flat'
  effective_from   TEXT NOT NULL,              -- ISO date; first drop_date this era covers
  effective_to     TEXT,                       -- ISO date; NULL = still in effect
  description      TEXT NOT NULL,
  formula_summary  TEXT NOT NULL,
  notes            TEXT
);

-- Seed the three known eras (per league_context_v1.md Section 4).
INSERT OR REPLACE INTO cap_penalty_rule_eras
  (era_id, effective_from, effective_to, description, formula_summary, notes)
VALUES
  ('era_pre_2019_flat',
   '2010-09-01', '2019-08-31',
   'Original UPS cap-penalty rule. Flat 20% of total salary remaining. No earning concept.',
   'penalty = 0.20 * total_salary_remaining; <$5K TCV exempt',
   'Also applies to GRANDFATHERED contracts that survived past the 2019 cutover (see Section 4).'),
  ('era_2019_calendar_monthly',
   '2019-09-01', '2026-05-07',
   '75% TCV guarantee with calendar-month earning curve + flat 35% WW for in-season pickups.',
   'penalty = (TCV * 0.75) - earned, where earned uses 25/50/75 Oct/Nov/Dec checkpoints; WW $5K+ in-season override = 0.35 * salary',
   'Replaced by per-week pro-rated 2026-05-08.'),
  ('era_2026_05_08_per_week',
   '2026-05-08', NULL,
   'True pro-rated per-completed-NFL-regular-season-week earning, uniform across all acquisition paths.',
   'penalty = (TCV * 0.75) - earned, where earned = (weeks_active / total_eligible_weeks) * year_salary',
   'Currently in effect.');

-- ---------------------------------------------------------------------------
-- Main cycle table: one row per acquisition→drop round per player per
-- franchise. Inputs are immutable. Legacy outputs are immutable. Comparison
-- columns can be recomputed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_acquisition_cycles (
  cycle_id                          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identity
  player_id                         TEXT NOT NULL,
  franchise_id                      TEXT NOT NULL,
  season                            INTEGER NOT NULL,         -- season the cycle started in

  -- Acquisition (inputs — immutable)
  acquisition_path                  TEXT NOT NULL,            -- 'auction'|'ww'|'fcfs'|'trade'|'rookie_draft'|'dispersal'|'comp_pick'
  acquisition_date                  TEXT NOT NULL,            -- ISO UTC
  acquisition_week                  INTEGER NOT NULL,         -- 0 = pre-Week-1; 1..N for in-season pickups
  contract_type_at_acquisition      TEXT,                     -- 'auction'|'rookie'|'ww'|'extension'|'mym'|'tag'|...
  contract_was_grandfathered_at_acq INTEGER NOT NULL DEFAULT 0,  -- 1 if MFL contract_info had 'GF' tag at acquisition
  salary_at_acquisition_usd         INTEGER,
  contract_years_at_acquisition     INTEGER,
  total_eligible_weeks              INTEGER NOT NULL,         -- = nfl_season_calendar.regular_season_weeks(season) - acquisition_week + 1, or full schedule weeks if pre-Week-1

  -- Roster activity — derived from player_weekly_active table
  weeks_active                      INTEGER NOT NULL DEFAULT 0,  -- aggregated count where counts_for_earning = 1

  -- Drop (NULL while cycle is open)
  drop_date                         TEXT,
  drop_week                         INTEGER,                  -- 1..N or NULL for offseason cuts (which earn 0)
  drop_reason                       TEXT,                     -- 'cut'|'trade'|'expired'|'retired'|'taxi_drop'|'cap_free_cut'|'1yr_under_5k_freecut'
  contract_was_grandfathered_at_drop INTEGER NOT NULL DEFAULT 0,
  salary_at_drop_usd                INTEGER,                  -- year's actual salary (may differ from acquisition for multi-year)
  tcv_at_drop_usd                   INTEGER,                  -- total contract value at drop (frozen at last touch)

  -- LEGACY — what was actually applied to the cap (immutable historical fact)
  rule_era_at_drop                  TEXT,                     -- 'era_pre_2019_flat'|'era_2019_calendar_monthly'|'era_2026_05_08_per_week'
  earned_legacy_usd                 INTEGER,
  penalty_legacy_usd                INTEGER,
  legacy_was_cap_free               INTEGER NOT NULL DEFAULT 0,  -- 1 if penalty=$0 due to cap-free category (taxi-never-promoted, <$5K, retired, etc.)
  legacy_cap_free_reason            TEXT,                     -- e.g., 'taxi_never_promoted', '1yr_under_5k', 'retired_calvin_johnson_eligible'

  -- COMPARISON — recomputable under each rule era for side-by-side analysis.
  -- For cap-free cycles, all columns mirror legacy ($0) per Keith — era differences
  -- don't apply to cap-free categories.
  earned_pre2019_usd                INTEGER,
  earned_calendar_monthly_usd       INTEGER,
  earned_per_week_usd               INTEGER,
  penalty_pre2019_usd               INTEGER,
  penalty_calendar_monthly_usd      INTEGER,
  penalty_per_week_usd              INTEGER,

  -- Status
  status                            TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'

  -- Audit
  created_at_utc                    TEXT NOT NULL,
  updated_at_utc                    TEXT NOT NULL,
  source                            TEXT NOT NULL,            -- 'backfill_2026'|'live_event'|'manual_correction'
  notes                             TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycles_franchise_season ON player_acquisition_cycles(franchise_id, season);
CREATE INDEX IF NOT EXISTS idx_cycles_player_season    ON player_acquisition_cycles(player_id, season);
CREATE INDEX IF NOT EXISTS idx_cycles_status           ON player_acquisition_cycles(status);
CREATE INDEX IF NOT EXISTS idx_cycles_drop_date        ON player_acquisition_cycles(drop_date);
CREATE INDEX IF NOT EXISTS idx_cycles_player_franchise ON player_acquisition_cycles(player_id, franchise_id);

-- ---------------------------------------------------------------------------
-- Per-week roster status. Single source for weeks_active. Cross-validated
-- against MFL weekly roster snapshots (2020+) where possible; pre-2020
-- derived from transaction logs only.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_weekly_active (
  cycle_id            INTEGER NOT NULL REFERENCES player_acquisition_cycles(cycle_id) ON DELETE CASCADE,
  season              INTEGER NOT NULL,
  week                INTEGER NOT NULL,         -- NFL regular-season week 1..N
  status              TEXT NOT NULL,            -- 'active'|'ir'|'taxi'|'taxi_called_up'|'not_rostered'
  counts_for_earning  INTEGER NOT NULL DEFAULT 0,  -- per Keith 2026-05-08: active|ir|taxi|taxi_called_up = 1; not_rostered = 0
  source              TEXT NOT NULL,            -- 'mfl_weekly_roster'|'tx_derived'|'manual'
  validated_against   TEXT,                     -- 'mfl_weekly_roster' if cross-checked, else NULL
  PRIMARY KEY (cycle_id, season, week)
);
CREATE INDEX IF NOT EXISTS idx_weekly_active_cycle ON player_weekly_active(cycle_id);
CREATE INDEX IF NOT EXISTS idx_weekly_active_season_week ON player_weekly_active(season, week);
