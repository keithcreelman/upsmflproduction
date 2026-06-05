-- 0074_mym_submissions.sql
-- Persistent audit log of every Mid-Year Multi (MYM) submitted via the
-- Front Office MYM action (or any other client that POSTs /offer-mym, or
-- /commish-contract-update with submission_kind = "mym"). Mirrors the
-- parallel audit tables:
--   ups_tag_submissions         (0029)
--   ups_extension_submissions   (0034)
--   ups_restructure_submissions (0047)
--
-- Why MYM gets its own table (not folded into extensions):
--   • Canon §C3 makes MYM its OWN contract_type — "MYM" — never collapsed
--     into Veteran/Extension. Origin is captured by sub_type
--     (Veteran-MYM / WW-MYM / MYM-Rookie), not by mutating the type.
--   • Per-team season cap is MYM-specific (MAX 4/season per team, raised
--     from 3 in 2025). A dedicated, structured table answers "how many MYMs
--     has team X used this season" without join gymnastics.
--   • Length is owner's choice (2 or 3 years) and MYMs cannot be loaded —
--     mym_length + mym_option pin the chosen term forensically.
--
-- Canon: docs/league_context_v1.md §C3 (Mid-Year Multi).
-- Created 2026-06-05 alongside the FO MYM tab + action build-out.

CREATE TABLE IF NOT EXISTS ups_mym_submissions (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id                     TEXT NOT NULL,
  season                        TEXT NOT NULL,
  franchise_id                  TEXT NOT NULL,        -- 4-char zero-padded
  player_id                     TEXT NOT NULL,
  player_name                   TEXT,
  position                      TEXT,
  prior_contract_status         TEXT,                 -- e.g., 'Veteran', 'WW', 'Rookie'
  prior_salary                  INTEGER,              -- salary before MYM conversion
  prior_contract_year           INTEGER,              -- years-remaining before (usually 1/0)
  prior_contract_info           TEXT,                 -- raw contractInfo before
  new_contract_status           TEXT,                 -- 'Veteran' (MFL surface) — type is MYM
  new_salary                    INTEGER,              -- year-1 salary after MYM
  new_contract_year             INTEGER,              -- = MYM length (2 or 3)
  new_contract_info             TEXT,                 -- raw contractInfo after
  new_year_salaries_json        TEXT,                 -- JSON array of per-year salaries
  mym_length                    INTEGER,              -- 2 or 3 (owner's choice, §C3)
  mym_option                    TEXT,                 -- 'mym2' | 'mym3'
  sub_type                      TEXT,                 -- 'Veteran-MYM' | 'WW-MYM' | 'MYM-Rookie'
  tcv_usd                       INTEGER,              -- total contract value
  aav_usd                       INTEGER,              -- average annual value
  gtd_usd                       INTEGER,              -- guaranteed
  per_year_usd                  INTEGER,              -- per-year salary (flat — MYMs can't load)
  source                        TEXT,                 -- 'front-office-mym-submit' / 'worker-offer-mym'
  acting_user_id                TEXT,
  raw_payload_json              TEXT,                 -- full request body for forensics
  submitted_at_utc              TEXT NOT NULL DEFAULT (datetime('now')),
  dry_run                       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mym_subs_season_league ON ups_mym_submissions(season, league_id);
CREATE INDEX IF NOT EXISTS idx_mym_subs_franchise     ON ups_mym_submissions(season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_mym_subs_player        ON ups_mym_submissions(season, player_id);
CREATE INDEX IF NOT EXISTS idx_mym_subs_submitted     ON ups_mym_submissions(submitted_at_utc);
CREATE INDEX IF NOT EXISTS idx_mym_subs_dry_run       ON ups_mym_submissions(dry_run, season);
