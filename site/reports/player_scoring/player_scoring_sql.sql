-- UPS Reports Module: Player Scoring
-- Compatibility views normalize the existing ETL schema to the report contract.

DROP VIEW IF EXISTS player_master;
CREATE VIEW IF NOT EXISTS player_master AS
SELECT
  CAST(dp.player_id AS TEXT) AS player_id,
  TRIM(COALESCE(dp.player_name, '')) AS player_name,
  UPPER(TRIM(COALESCE(NULLIF(dp.position, ''), 'OTHER'))) AS position,
  CASE
    WHEN UPPER(TRIM(COALESCE(dp.position, ''))) IN ('CB', 'S') THEN 'DB'
    WHEN UPPER(TRIM(COALESCE(dp.position, ''))) IN ('DE', 'DT') THEN 'DL'
    WHEN UPPER(TRIM(COALESCE(dp.position, ''))) IN ('QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'PK', 'PN') THEN UPPER(TRIM(dp.position))
    ELSE 'OTHER'
  END AS position_group,
  UPPER(TRIM(COALESCE(dp.nfl_team, ''))) AS team
FROM dim_player dp
WHERE TRIM(COALESCE(dp.player_id, '')) <> '';

DROP VIEW IF EXISTS rosters_currentseason;
CREATE VIEW IF NOT EXISTS rosters_currentseason AS
WITH latest_cycle AS (
  SELECT
    season AS roster_snapshot_season,
    MAX(week) AS roster_snapshot_week
  FROM rosters_current
  WHERE season = (SELECT MAX(season) FROM rosters_current)
),
current_rows AS (
  SELECT rc.*
  FROM rosters_current rc
  JOIN latest_cycle lc
    ON lc.roster_snapshot_season = rc.season
   AND lc.roster_snapshot_week = rc.week
)
SELECT
  lc.roster_snapshot_season,
  lc.roster_snapshot_week,
  CAST(cr.player_id AS TEXT) AS player_id,
  COALESCE(NULLIF(TRIM(cr.player_name), ''), TRIM(COALESCE(dp.player_name, ''))) AS player_name,
  COALESCE(NULLIF(UPPER(TRIM(cr.position)), ''), UPPER(TRIM(COALESCE(NULLIF(dp.position, ''), 'OTHER'))), 'OTHER') AS position,
  COALESCE(NULLIF(UPPER(TRIM(cr.nfl_team)), ''), UPPER(TRIM(COALESCE(dp.nfl_team, ''))), '') AS team,
  CAST(cr.franchise_id AS TEXT) AS franchise_id,
  COALESCE(NULLIF(TRIM(df.franchise_name), ''), CAST(cr.franchise_id AS TEXT), '') AS franchise_name,
  COALESCE(NULLIF(TRIM(df.owner_name), ''), '') AS owner_name,
  UPPER(TRIM(COALESCE(NULLIF(cr.status, ''), 'ROSTER'))) AS roster_status,
  1 AS rostered_ind,
  0 AS free_agent_ind
FROM current_rows cr
JOIN latest_cycle lc
  ON 1 = 1
LEFT JOIN dim_player dp
  ON dp.player_id = CAST(cr.player_id AS TEXT)
LEFT JOIN dim_franchise df
  ON df.franchise_id = CAST(cr.franchise_id AS TEXT);

DROP VIEW IF EXISTS weekly_player_scores;
CREATE VIEW IF NOT EXISTS weekly_player_scores AS
WITH normalized AS (
  SELECT
    CAST(w.season AS INTEGER) AS nfl_season,
    CAST(w.week AS INTEGER) AS nfl_week,
    CAST(w.player_id AS TEXT) AS player_id,
    COALESCE(NULLIF(TRIM(w.player_name), ''), TRIM(COALESCE(dp.player_name, ''))) AS player_name,
    COALESCE(NULLIF(UPPER(TRIM(w.position)), ''), UPPER(TRIM(COALESCE(NULLIF(dp.position, ''), 'OTHER'))), 'OTHER') AS position,
    COALESCE(
      NULLIF(UPPER(TRIM(w.pos_group)), ''),
      CASE
        WHEN UPPER(TRIM(COALESCE(dp.position, ''))) IN ('CB', 'S') THEN 'DB'
        WHEN UPPER(TRIM(COALESCE(dp.position, ''))) IN ('DE', 'DT') THEN 'DL'
        WHEN UPPER(TRIM(COALESCE(dp.position, ''))) IN ('QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'PK', 'PN') THEN UPPER(TRIM(dp.position))
        ELSE 'OTHER'
      END,
      CASE
        WHEN COALESCE(NULLIF(UPPER(TRIM(w.position)), ''), UPPER(TRIM(COALESCE(dp.position, ''))), '') IN ('CB', 'S') THEN 'DB'
        WHEN COALESCE(NULLIF(UPPER(TRIM(w.position)), ''), UPPER(TRIM(COALESCE(dp.position, ''))), '') IN ('DE', 'DT') THEN 'DL'
        WHEN COALESCE(NULLIF(UPPER(TRIM(w.position)), ''), UPPER(TRIM(COALESCE(dp.position, ''))), '') IN ('QB', 'RB', 'WR', 'TE', 'DL', 'LB', 'DB', 'PK', 'PN') THEN COALESCE(NULLIF(UPPER(TRIM(w.position)), ''), UPPER(TRIM(COALESCE(dp.position, ''))))
        ELSE 'OTHER'
      END
    ) AS position_group,
    COALESCE(NULLIF(UPPER(TRIM(COALESCE(dp.nfl_team, ''))), ''), '') AS team,
    ROUND(CAST(w.score AS REAL), 3) AS weekly_score,
    LOWER(COALESCE(NULLIF(TRIM(w.status), ''), 'fa')) AS season_usage_status,
    UPPER(
      COALESCE(
        NULLIF(TRIM(w.roster_status), ''),
        CASE
          WHEN LOWER(COALESCE(NULLIF(TRIM(w.status), ''), 'fa')) = 'fa' THEN 'FA'
          ELSE 'ROSTER'
        END
      )
    ) AS season_roster_status,
    CAST(w.roster_franchise_id AS TEXT) AS season_franchise_id,
    COALESCE(NULLIF(TRIM(df.franchise_name), ''), CAST(w.roster_franchise_id AS TEXT), '') AS season_franchise_name,
    ROUND(COALESCE(CAST(w.vam AS REAL), 0), 3) AS weekly_vam
  FROM player_weeklyscoringresults w
  LEFT JOIN dim_player dp
    ON dp.player_id = CAST(w.player_id AS TEXT)
  LEFT JOIN dim_franchise df
    ON df.franchise_id = CAST(w.roster_franchise_id AS TEXT)
  WHERE w.score IS NOT NULL
)
SELECT
  n.*,
  DENSE_RANK() OVER (
    PARTITION BY n.nfl_season, n.nfl_week, n.position_group
    ORDER BY n.weekly_score DESC, n.player_id
  ) AS position_week_rank,
  COUNT(*) OVER (
    PARTITION BY n.nfl_season, n.nfl_week, n.position_group
  ) AS position_week_player_count,
  ROUND(
    CUME_DIST() OVER (
      PARTITION BY n.nfl_season, n.nfl_week, n.position_group
      ORDER BY n.weekly_score ASC, n.player_id
    ),
    6
  ) AS position_week_cume_dist,
  ROUND(
    PERCENT_RANK() OVER (
      PARTITION BY n.nfl_season, n.nfl_week, n.position_group
      ORDER BY n.weekly_score ASC, n.player_id
    ),
    6
  ) AS position_week_percent_rank
FROM normalized n
WHERE COALESCE(NULLIF(n.position_group, ''), '') <> '';

DROP VIEW IF EXISTS report_player_scoring_weekly_v1;
CREATE VIEW report_player_scoring_weekly_v1 AS
WITH current_roster_meta AS (
  SELECT
    COALESCE(MAX(roster_snapshot_season), 0) AS current_roster_season,
    COALESCE(MAX(roster_snapshot_week), 0) AS current_roster_week
  FROM rosters_currentseason
)
SELECT
  w.nfl_season,
  w.nfl_week,
  w.player_id,
  w.player_name,
  w.position,
  w.position_group,
  w.team,
  w.weekly_score,
  w.weekly_vam,
  w.season_usage_status,
  w.season_roster_status,
  w.season_franchise_id,
  w.season_franchise_name,
  w.position_week_rank,
  w.position_week_player_count,
  w.position_week_cume_dist,
  w.position_week_percent_rank,
  COALESCE(rc.roster_snapshot_season, crm.current_roster_season) AS current_roster_season,
  COALESCE(rc.roster_snapshot_week, crm.current_roster_week) AS current_roster_week,
  COALESCE(rc.franchise_id, '') AS current_franchise_id,
  COALESCE(rc.franchise_name, '') AS current_franchise_name,
  COALESCE(rc.owner_name, '') AS current_owner_name,
  COALESCE(rc.roster_status, 'FREE_AGENT') AS current_roster_status,
  CASE WHEN rc.player_id IS NOT NULL THEN 1 ELSE 0 END AS current_rostered_ind,
  CASE WHEN rc.player_id IS NULL THEN 1 ELSE 0 END AS current_free_agent_ind
FROM weekly_player_scores w
JOIN current_roster_meta crm
  ON 1 = 1
LEFT JOIN rosters_currentseason rc
  ON rc.player_id = w.player_id;

DROP VIEW IF EXISTS report_player_scoring_summary_v1;
CREATE VIEW report_player_scoring_summary_v1 AS
WITH season_totals AS (
  SELECT
    w.nfl_season,
    w.player_id,
    MIN(w.player_name) AS player_name,
    MIN(w.position) AS position,
    MIN(w.position_group) AS position_group,
    MIN(w.team) AS team,
    COUNT(*) AS games_played,
    SUM(w.weekly_score) AS total_points_raw,
    AVG(w.weekly_score) AS points_per_game_raw,
    MAX(w.weekly_score) AS max_points_raw,
    MIN(w.weekly_score) AS min_points_raw,
    AVG(w.weekly_score * w.weekly_score) AS avg_square_score_raw,
    SUM(CASE WHEN w.season_usage_status = 'starter' THEN 1 ELSE 0 END) AS starter_count,
    SUM(CASE WHEN w.season_usage_status = 'nonstarter' THEN 1 ELSE 0 END) AS bench_count,
    SUM(CASE WHEN w.season_usage_status = 'fa' THEN 1 ELSE 0 END) AS free_agent_count,
    SUM(CASE WHEN w.position_week_cume_dist >= 0.75 THEN 1 ELSE 0 END) AS default_elite_weeks,
    SUM(CASE WHEN w.position_week_cume_dist <= 0.25 THEN 1 ELSE 0 END) AS default_dud_weeks
  FROM weekly_player_scores w
  GROUP BY w.nfl_season, w.player_id
),
ordered_scores AS (
  SELECT
    w.nfl_season,
    w.player_id,
    w.weekly_score,
    ROW_NUMBER() OVER (
      PARTITION BY w.nfl_season, w.player_id
      ORDER BY w.weekly_score ASC
    ) AS score_rank_asc,
    COUNT(*) OVER (
      PARTITION BY w.nfl_season, w.player_id
    ) AS player_game_count
  FROM weekly_player_scores w
),
medians AS (
  SELECT
    o.nfl_season,
    o.player_id,
    AVG(o.weekly_score) AS median_points
  FROM ordered_scores o
  WHERE o.score_rank_asc IN ((o.player_game_count + 1) / 2, (o.player_game_count + 2) / 2)
  GROUP BY o.nfl_season, o.player_id
),
position_baselines AS (
  SELECT
    st.nfl_season,
    st.position_group,
    AVG(st.points_per_game_raw) AS position_average_points_per_game
  FROM season_totals st
  GROUP BY st.nfl_season, st.position_group
),
latest_transactions AS (
  SELECT
    CAST(t.player_id AS TEXT) AS player_id,
    t.season AS last_transaction_season,
    COALESCE(NULLIF(TRIM(t.move_type), ''), '') AS last_move_type,
    COALESCE(NULLIF(TRIM(t.method), ''), '') AS last_move_method,
    COALESCE(NULLIF(TRIM(CAST(t.franchise_id AS TEXT)), ''), '') AS last_transaction_franchise_id,
    COALESCE(NULLIF(TRIM(t.franchise_name), ''), COALESCE(NULLIF(TRIM(CAST(t.franchise_id AS TEXT)), ''), ''), '') AS last_transaction_franchise_name,
    COALESCE(NULLIF(TRIM(t.date_et), ''), '') AS last_transaction_date,
    COALESCE(NULLIF(TRIM(t.datetime_et), ''), '') AS last_transaction_datetime,
    ROW_NUMBER() OVER (
      PARTITION BY CAST(t.player_id AS TEXT)
      ORDER BY COALESCE(t.unix_timestamp, 0) DESC, t.season DESC, t.txn_index DESC
    ) AS rn
  FROM transactions_adddrop t
),
current_roster_meta AS (
  SELECT
    COALESCE(MAX(roster_snapshot_season), 0) AS current_roster_season,
    COALESCE(MAX(roster_snapshot_week), 0) AS current_roster_week
  FROM rosters_currentseason
),
base_metrics AS (
  SELECT
    st.nfl_season,
    st.player_id,
    st.player_name,
    st.position,
    st.position_group,
    st.team,
    COALESCE(rc.roster_snapshot_season, crm.current_roster_season) AS current_roster_season,
    COALESCE(rc.roster_snapshot_week, crm.current_roster_week) AS current_roster_week,
    COALESCE(rc.franchise_id, '') AS franchise_id,
    COALESCE(rc.franchise_name, '') AS franchise_name,
    COALESCE(rc.owner_name, '') AS owner_name,
    COALESCE(rc.roster_status, 'FREE_AGENT') AS current_roster_status,
    CASE WHEN rc.player_id IS NOT NULL THEN 1 ELSE 0 END AS rostered_ind,
    CASE WHEN rc.player_id IS NULL THEN 1 ELSE 0 END AS free_agent_ind,
    st.games_played,
    st.total_points_raw,
    st.points_per_game_raw,
    COALESCE(m.median_points, 0) AS median_points_raw,
    st.max_points_raw,
    st.min_points_raw,
    CASE
      WHEN (st.avg_square_score_raw - (st.points_per_game_raw * st.points_per_game_raw)) > 0 THEN
        SQRT(st.avg_square_score_raw - (st.points_per_game_raw * st.points_per_game_raw))
      ELSE 0
    END AS std_dev_raw,
    st.starter_count,
    st.bench_count,
    st.free_agent_count,
    st.default_elite_weeks AS elite_weeks,
    CASE
      WHEN (st.games_played - st.default_elite_weeks - st.default_dud_weeks) > 0 THEN
        (st.games_played - st.default_elite_weeks - st.default_dud_weeks)
      ELSE 0
    END AS neutral_weeks,
    st.default_dud_weeks AS dud_weeks,
    COALESCE(pb.position_average_points_per_game, 0) AS position_average_points_per_game,
    (st.points_per_game_raw - COALESCE(pb.position_average_points_per_game, 0)) AS vam_raw,
    (st.total_points_raw - (COALESCE(pb.position_average_points_per_game, 0) * st.games_played)) AS vam_total_raw,
    COALESCE(psd.total_vam, (st.total_points_raw - (COALESCE(pb.position_average_points_per_game, 0) * st.games_played))) AS dominance_total_vam,
    COALESCE(psd.total_win_chunks_pos, 0) AS dominance_win_chunks_pos,
    COALESCE(lt.last_transaction_season, 0) AS last_transaction_season,
    COALESCE(lt.last_move_type, '') AS last_move_type,
    COALESCE(lt.last_move_method, '') AS last_move_method,
    COALESCE(lt.last_transaction_franchise_id, '') AS last_transaction_franchise_id,
    COALESCE(lt.last_transaction_franchise_name, '') AS last_transaction_franchise_name,
    COALESCE(lt.last_transaction_date, '') AS last_transaction_date,
    COALESCE(lt.last_transaction_datetime, '') AS last_transaction_datetime
  FROM season_totals st
  LEFT JOIN medians m
    ON m.nfl_season = st.nfl_season
   AND m.player_id = st.player_id
  LEFT JOIN position_baselines pb
    ON pb.nfl_season = st.nfl_season
   AND pb.position_group = st.position_group
  JOIN current_roster_meta crm
    ON 1 = 1
  LEFT JOIN rosters_currentseason rc
    ON rc.player_id = st.player_id
  LEFT JOIN player_season_dominance psd
    ON psd.season = st.nfl_season
   AND psd.player_id = CAST(st.player_id AS INTEGER)
  LEFT JOIN latest_transactions lt
    ON lt.player_id = st.player_id
   AND lt.rn = 1
),
ranked AS (
  SELECT
    bm.*,
    DENSE_RANK() OVER (
      PARTITION BY bm.nfl_season, bm.position_group
      ORDER BY bm.points_per_game_raw DESC, bm.total_points_raw DESC, bm.player_name ASC
    ) AS positional_rank,
    ROUND(
      100.0 * CUME_DIST() OVER (
        PARTITION BY bm.nfl_season, bm.position_group
        ORDER BY bm.points_per_game_raw ASC, bm.total_points_raw ASC, bm.player_name ASC
      ),
      1
    ) AS percentile_rank
  FROM base_metrics bm
)
SELECT
  r.nfl_season,
  r.player_id,
  r.player_name,
  r.position,
  r.position_group,
  r.team,
  r.current_roster_season,
  r.current_roster_week,
  r.franchise_id,
  r.franchise_name,
  r.owner_name,
  r.current_roster_status,
  r.rostered_ind,
  r.free_agent_ind,
  r.games_played,
  ROUND(r.total_points_raw, 1) AS total_points,
  ROUND(r.points_per_game_raw, 3) AS points_per_game,
  ROUND(r.median_points_raw, 3) AS median_points,
  ROUND(r.max_points_raw, 1) AS max_points,
  ROUND(r.min_points_raw, 1) AS min_points,
  ROUND(r.std_dev_raw, 3) AS std_dev,
  r.elite_weeks,
  r.neutral_weeks,
  r.dud_weeks,
  ROUND(r.position_average_points_per_game, 3) AS position_average_points_per_game,
  ROUND(r.vam_raw, 3) AS vam,
  ROUND(r.vam_total_raw, 3) AS vam_total,
  r.starter_count,
  r.bench_count,
  r.free_agent_count,
  r.positional_rank,
  r.percentile_rank,
  ROUND(
    CASE
      WHEN r.points_per_game_raw > 0 THEN
        CASE
          WHEN (100.0 * (1.0 - (r.std_dev_raw / r.points_per_game_raw))) < 0 THEN 0
          ELSE (100.0 * (1.0 - (r.std_dev_raw / r.points_per_game_raw)))
        END
      ELSE 0
    END,
    1
  ) AS consistency_index,
  ROUND(CASE WHEN r.games_played > 0 THEN (100.0 * r.elite_weeks / r.games_played) ELSE 0 END, 1) AS boom_rate,
  ROUND(CASE WHEN r.games_played > 0 THEN (100.0 * r.dud_weeks / r.games_played) ELSE 0 END, 1) AS bust_rate,
  ROUND(r.dominance_total_vam, 3) AS dominance_total_vam,
  ROUND(r.dominance_win_chunks_pos, 3) AS dominance_win_chunks_pos,
  r.last_transaction_season,
  r.last_move_type,
  r.last_move_method,
  r.last_transaction_franchise_id,
  r.last_transaction_franchise_name,
  r.last_transaction_date,
  r.last_transaction_datetime
FROM ranked r;
