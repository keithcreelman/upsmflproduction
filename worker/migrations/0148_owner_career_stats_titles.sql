-- 0148_owner_career_stats_titles.sql
-- The owner-history columns the Wire's team reviews need (Keith 2026-09-11:
-- "number of years, titles, 2nd place finishes, all play champion, number of
-- playoff appearances, division titles").
--
-- Written by pipelines/etl/scripts/rebuild_franchise_career_stats.py, which is
-- now run weekly by .github/workflows/owner-career-stats.yml.
--
--   owner_runner_ups / _years       final_finish = 2 (src_final_standings)
--   owner_title_years               final_finish = 1, as a JSON array
--   owner_allplay_titles / _years   best HISTORICAL all-play % of the season
--                                   (league_context §D.1: regular season only
--                                   2010-2016, full season 2017+); an exact tie
--                                   credits every tied owner
--   owner_division_titles / _years  seeded as a division winner by /api/standings,
--                                   which applies MFL's year-specific standingsSort;
--                                   2011+ only -- 2010 reports two, not four
--
-- owner_playoff_appearances keeps its name but now comes from actual seeding
-- (bye / division_winner / wild_card) rather than "final finish <= 6".

ALTER TABLE ups_owner_career_stats ADD COLUMN owner_runner_ups INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ups_owner_career_stats ADD COLUMN owner_runner_up_years TEXT;
ALTER TABLE ups_owner_career_stats ADD COLUMN owner_title_years TEXT;
ALTER TABLE ups_owner_career_stats ADD COLUMN owner_allplay_titles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ups_owner_career_stats ADD COLUMN owner_allplay_title_years TEXT;
ALTER TABLE ups_owner_career_stats ADD COLUMN owner_division_titles INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ups_owner_career_stats ADD COLUMN owner_division_title_years TEXT;
