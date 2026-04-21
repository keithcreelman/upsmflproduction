#!/usr/bin/env python3
"""
Build metadata_positionalwinprofile

Per season + pos_group, store starter score percentiles and delta_win_pos
used for positional win-chunk normalization:
  - score_p50_pos : 50th percentile starter score for the pos_group
  - score_p80_pos : 80th percentile starter score for the pos_group
  - delta_win_pos : score_p80_pos - score_p50_pos
  - starter_sample_count: number of starter scores used

Source data mirrors scoring_playerranking:
  playerscores_weekly + weeklyresults (starter tags) + conformance_extensions
  for positional grouping. Weeks are limited by metadata_leaguedetails
  start/end bounds.
"""

import sys
from db_utils import get_conn

SQL_TEMPLATE = """
DROP TABLE IF EXISTS metadata_positionalwinprofile;
CREATE TABLE metadata_positionalwinprofile AS
WITH season_weeks AS (
    SELECT
        season,
        COALESCE(start_week, 1) AS start_week,
        COALESCE(end_week, last_regular_season_week, 17) AS end_week
    FROM metadata_leaguedetails
),
scores AS (
    SELECT
        psw.season,
        psw.week,
        psw.player_id,
        psw.score
    FROM playerscores_weekly psw
    JOIN season_weeks sw
      ON sw.season = psw.season
    WHERE psw.week BETWEEN sw.start_week AND sw.end_week
    {season_filter}
),
players_pos AS (
    SELECT season, player_id, name AS player_name, position
    FROM players
),
pos_map AS (
    SELECT season, position, positional_grouping
    FROM conformance_extensions
),
starters_map AS (
    SELECT season, position_name
    FROM metadata_starters
),
roster_weekly AS (
    SELECT
        season,
        week,
        player_id,
        status
    FROM rosters_weekly
),
combined AS (
    SELECT
        sc.season,
        sc.week,
        sc.player_id,
        sc.score,
        COALESCE(pm.positional_grouping, ms.position_name, p.position) AS pos_group,
        -- Starter detection: prefer weeklyresults.status directly (works for
        -- every season where we have lineup history). Fall back to
        -- rosters_weekly presence (needed for 2010-2011 legacy where
        -- weeklyresults is sparse). Before 2026-04-21 the logic was
        -- gated on rosters_weekly presence, which silently dropped
        -- 2012-2016 because that table starts at 2017 — see RULE-DATA-004.
        CASE
            WHEN LOWER(wr.status) IN ('starter', 'nonstarter') THEN LOWER(wr.status)
            WHEN rw.player_id IS NOT NULL THEN 'nonstarter'
            ELSE 'fa'
        END AS status
    FROM scores sc
    LEFT JOIN weeklyresults wr
      ON wr.season    = sc.season
     AND wr.week      = sc.week
     AND wr.player_id = sc.player_id
    LEFT JOIN players_pos p
      ON p.season     = sc.season
     AND p.player_id  = sc.player_id
    LEFT JOIN pos_map pm
      ON pm.season    = sc.season
     AND pm.position  = p.position
    LEFT JOIN starters_map ms
      ON ms.season    = sc.season
     AND instr(ms.position_name, p.position) > 0
    LEFT JOIN roster_weekly rw
      ON rw.season    = sc.season
     AND rw.week      = sc.week
     AND rw.player_id = sc.player_id
),
pos_score_pool AS (
    -- starter scores only; drives percentile calcs
    SELECT
        season,
        pos_group,
        score
    FROM combined
    WHERE status = 'starter'
      AND score IS NOT NULL
),
pos_ranked AS (
    SELECT
        season,
        pos_group,
        score,
        ABS(PERCENT_RANK() OVER (PARTITION BY season, pos_group ORDER BY score) - 0.5) AS dist50,
        ABS(PERCENT_RANK() OVER (PARTITION BY season, pos_group ORDER BY score) - 0.8) AS dist80,
        COUNT(*) OVER (PARTITION BY season, pos_group) AS sample_count
    FROM pos_score_pool
),
pos_profile AS (
    SELECT DISTINCT
        season,
        pos_group,
        FIRST_VALUE(score) OVER w50 AS score_p50_pos,
        FIRST_VALUE(score) OVER w80 AS score_p80_pos,
        FIRST_VALUE(sample_count) OVER w50 AS starter_sample_count
    FROM pos_ranked
    WINDOW
        w50 AS (PARTITION BY season, pos_group ORDER BY dist50, score),
        w80 AS (PARTITION BY season, pos_group ORDER BY dist80, score)
)
SELECT
    season,
    pos_group,
    score_p50_pos,
    score_p80_pos,
    CASE
        WHEN score_p50_pos IS NOT NULL
         AND score_p80_pos IS NOT NULL
        THEN (score_p80_pos - score_p50_pos)
        ELSE NULL
    END AS delta_win_pos,
    starter_sample_count
FROM pos_profile;
"""


def main() -> None:
    """
    Usage:
        python metadata_positionalwinprofile.py        # all seasons
        python metadata_positionalwinprofile.py 2025   # only season 2025
    """
    season = None
    if len(sys.argv) > 1:
        try:
            season = int(sys.argv[1])
        except ValueError:
            raise SystemExit("Season argument must be an integer, e.g. 2025")

    if season is None:
        season_filter = ""
    else:
        season_filter = f" AND psw.season = {season}"

    sql = SQL_TEMPLATE.format(season_filter=season_filter)

    conn = get_conn()
    cur = conn.cursor()
    cur.executescript(sql)
    conn.commit()
    conn.close()

    if season is None:
        print(
            "metadata_positionalwinprofile built for ALL seasons present in playerscores_weekly "
            "within the league's configured weeks."
        )
    else:
        print(f"metadata_positionalwinprofile built for season {season}.")


if __name__ == "__main__":
    main()
