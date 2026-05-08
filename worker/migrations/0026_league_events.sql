-- 0026_league_events.sql
-- Canonical league deadline + event calendar — imported from the local
-- mfl_database.db `leagueevents` table. Keyed by (event, nfl_season).
-- Source-of-truth for any rule that references "X days before the rookie
-- draft" / "September auction kickoff" / "rookie extension deadline" etc.
--
-- Source: ~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/
--          MFL_Scripts/Datastorage/mfl_database.db .leagueevents
-- Schema renamed to snake_case for parity with the rest of D1.
--
-- Distinct event types:
--   • ups_contract_deadline       — last Sun before NFL Week 1
--   • nfl_kickoff                 — first Thursday game of the NFL season
--   • preseason_mymdeadline       — pre-Week-3 kickoff cutoff
--   • preseason_extensiondeadline — pre-Week-5 kickoff cutoff
--   • ups_rookieextension_deadline — Thu before Memorial Day
--   • ups_season_complete         — final week of the league season

CREATE TABLE IF NOT EXISTS league_events (
  event          TEXT NOT NULL,
  date           TEXT NOT NULL,        -- 'YYYY-MM-DD'
  nfl_season     TEXT NOT NULL,        -- '2026' etc.
  description    TEXT,                 -- optional human note
  source         TEXT DEFAULT 'mfl_database.db.leagueevents@2026-05-06',
  created_at_utc TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (event, nfl_season)
);

CREATE INDEX IF NOT EXISTS idx_league_events_season ON league_events(nfl_season, date);
CREATE INDEX IF NOT EXISTS idx_league_events_date   ON league_events(date);

INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2011-09-01', '2011');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2012-09-01', '2012');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2013-09-01', '2013');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2014-09-01', '2014');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2015-09-01', '2015');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2016-09-01', '2016');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2017-09-01', '2017');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2018-09-01', '2018');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2019-09-01', '2019');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2020-09-01', '2020');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2021-09-01', '2021');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2022-09-01', '2022');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2023-09-01', '2023');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2024-09-01', '2024');
INSERT INTO league_events (event, date, nfl_season) VALUES ('nfl_kickoff', '2024-09-05', '2024');
INSERT INTO league_events (event, date, nfl_season) VALUES ('preseason_mymdeadline', '2024-09-18', '2024');
INSERT INTO league_events (event, date, nfl_season) VALUES ('preseason_extensiondeadline', '2024-10-02', '2024');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_season_complete', '2024-12-30', '2024');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_rookieextension_deadline', '2025-05-25', '2025');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2025-08-31', '2025');
INSERT INTO league_events (event, date, nfl_season) VALUES ('nfl_kickoff', '2025-09-04', '2025');
INSERT INTO league_events (event, date, nfl_season) VALUES ('preseason_mymdeadline', '2025-09-17', '2025');
INSERT INTO league_events (event, date, nfl_season) VALUES ('preseason_extensiondeadline', '2025-10-01', '2025');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_season_complete', '2025-12-29', '2025');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_rookieextension_deadline', '2026-05-21', '2026');
INSERT INTO league_events (event, date, nfl_season) VALUES ('ups_contract_deadline', '2026-09-06', '2026');
INSERT INTO league_events (event, date, nfl_season) VALUES ('nfl_kickoff', '2026-09-10', '2026');
INSERT INTO league_events (event, date, nfl_season) VALUES ('preseason_mymdeadline', '2026-09-24', '2026');
INSERT INTO league_events (event, date, nfl_season) VALUES ('preseason_extensiondeadline', '2026-10-07', '2026');
