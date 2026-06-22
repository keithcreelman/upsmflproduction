-- nfl_team_pace — team pace (plays per game) + a schedule-adjusted pace, per season.
--
-- Derived from nflverse play-by-play (REG season): offensive plays/game (the
-- team's own pace), defensive plays-faced/game, and pace_sos = the average
-- offensive plays/game of the opponents on that team's schedule (the schedule
-- adjustment — high = faces fast-paced opponents = more total plays = more
-- fantasy opportunity).
--
-- Populated by: pipelines/etl/scripts/fetch_nflverse_pace.py
-- The Worker joins it to /api/advanced-stats-leaderboard as a "Team Context"
-- column group (team_plays_pg, team_def_plays_pg, pace_sos).

CREATE TABLE IF NOT EXISTS nfl_team_pace (
  season           INTEGER NOT NULL,
  team             TEXT    NOT NULL,
  games            INTEGER,
  off_plays_pg     REAL,   -- offensive plays per game (run+pass; the team's pace)
  def_plays_pg     REAL,   -- plays the defense faces per game
  pace_sos         REAL,   -- avg opponent off_plays_pg over the schedule (schedule-adjusted)
  updated_at       TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, team)
);
