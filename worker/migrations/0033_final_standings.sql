-- 0033_final_standings.sql
-- src_final_standings: per-season final-finish + regular-season-finish per
-- franchise. Drives the Historical Finishes view + champion highlight in the
-- team_operations Standings module.
--
-- Mirrors the local mfl_database.db `metadata_finalstandings` table; populated
-- by scripts/load_local_to_d1.py. Coverage: every closed UPS season
-- (2011-2025; 2010 redraft year excluded if no local row exists).
--
-- final_finish 1 = UPS Champion; 12 = Hawktuah/Toilet champion (last place
-- by record, won the Toilet bracket — drives 1.01 in next year's rookie
-- draft per league_context_v1.md §1).

CREATE TABLE IF NOT EXISTS src_final_standings (
  season                  INTEGER NOT NULL,
  franchise_id            TEXT    NOT NULL,
  final_finish            INTEGER,
  regular_season_finish   INTEGER,
  division                TEXT,
  PRIMARY KEY (season, franchise_id)
);
CREATE INDEX IF NOT EXISTS idx_src_final_standings_season ON src_final_standings (season);
CREATE INDEX IF NOT EXISTS idx_src_final_standings_franchise ON src_final_standings (franchise_id, season DESC);
