-- 0047_restructure_submissions.sql
-- Persistent audit log of every restructure submitted via Roster Workbench
-- (or any other client that POSTs /offer-restructure or
-- /commish-contract-update with submission_kind = "restructure"). Mirrors
-- the parallel audit tables:
--   ups_tag_submissions       (0029)
--   ups_extension_submissions (0034)
--
-- Why we need this in addition to the generic salary_change_log:
--   • salary_change_log captures ALL contract mutations — restructures
--     are mixed in with tags, extensions, manual updates, etc.
--   • This table is restructure-only, structured, and forensics-ready
--     (raw_payload_json + before/after year salary arrays). Lets the
--     bot answer "how many restructures has team X used this season"
--     against canon §C5 (3 per team per season) without join gymnastics.
--
-- Canon: docs/league_context_v1.md §C5 (D1 audit trail intent, 2026-05-16).
-- Tracker: docs/AUDIT_FOLLOWUP_TRACKERS.md Q14.

CREATE TABLE IF NOT EXISTS ups_restructure_submissions (
  id                            INTEGER PRIMARY KEY AUTOINCREMENT,
  league_id                     TEXT NOT NULL,
  season                        TEXT NOT NULL,
  franchise_id                  TEXT NOT NULL,        -- 4-char zero-padded
  player_id                     TEXT NOT NULL,
  player_name                   TEXT,
  position                      TEXT,
  prior_contract_status         TEXT,                 -- e.g., 'Veteran', 'Vet - Auction'
  prior_salary                  INTEGER,              -- year-1 salary before restructure
  prior_contract_year           INTEGER,              -- years-remaining at time of submission
  prior_contract_info           TEXT,                 -- raw contractInfo before
  prior_year_salaries_json      TEXT,                 -- JSON array of per-year salaries before
  new_contract_status           TEXT,                 -- e.g., 'Vet - Auction (FL)', 'Restructure'
  new_salary                    INTEGER,              -- year-1 salary after restructure
  new_contract_year             INTEGER,
  new_contract_info             TEXT,                 -- raw contractInfo after
  new_year_salaries_json        TEXT,                 -- JSON array of per-year salaries after
  tcv_usd                       INTEGER,              -- total contract value (preserved by §C5)
  new_aav                       INTEGER,
  source                        TEXT,                 -- 'roster-workbench' / 'worker-offer-restructure'
  acting_user_id                TEXT,
  raw_payload_json              TEXT,                 -- full request body for forensics
  submitted_at_utc              TEXT NOT NULL DEFAULT (datetime('now')),
  dry_run                       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_rs_subs_season_league ON ups_restructure_submissions(season, league_id);
CREATE INDEX IF NOT EXISTS idx_rs_subs_franchise     ON ups_restructure_submissions(season, franchise_id);
CREATE INDEX IF NOT EXISTS idx_rs_subs_player        ON ups_restructure_submissions(season, player_id);
CREATE INDEX IF NOT EXISTS idx_rs_subs_submitted     ON ups_restructure_submissions(submitted_at_utc);
CREATE INDEX IF NOT EXISTS idx_rs_subs_dry_run       ON ups_restructure_submissions(dry_run, season);
