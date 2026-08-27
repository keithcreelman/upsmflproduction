-- Rebuild player_season_wc_rank. Run whenever src_weekly changes (weekly in
-- season). Executes ENTIRELY inside D1 — one expensive pass instead of one per
-- player-card open.
--
--   npx wrangler d1 execute ups-mfl-db --remote --file worker/migrations/manual/rebuild_player_season_wc_rank.sql
--
-- The SELECT is the exact CTE pair lifted out of /api/player-bundle, unchanged:
-- same WHERE (score > 0 AND status = 'starter'), same MIN(pos_group), same two
-- RANK() windows including the games_played divide-by-zero guard. If this drifts
-- from the endpoint, ranks silently change meaning — so it is copied verbatim
-- rather than "improved".
DELETE FROM player_season_wc_rank;

INSERT INTO player_season_wc_rank
  (season, player_id, pos_group, win_chunks_total, games_played,
   wc_pos_rank, wc_per_game_pos_rank, built_at_utc)
WITH season_totals AS (
  SELECT w.season, w.player_id,
         MIN(w.pos_group) AS pos_group,
         COUNT(*) AS games_played_cte,
         SUM(COALESCE(w.win_chunks, 0)) AS win_chunks_total
    FROM src_weekly w
   WHERE w.score > 0 AND w.status = 'starter'
   GROUP BY w.season, w.player_id
)
SELECT season, player_id, pos_group, win_chunks_total, games_played_cte,
       RANK() OVER (
         PARTITION BY season, pos_group
         ORDER BY win_chunks_total DESC
       ) AS wc_pos_rank,
       RANK() OVER (
         PARTITION BY season, pos_group
         ORDER BY (win_chunks_total * 1.0 /
                   CASE WHEN games_played_cte > 0
                        THEN games_played_cte ELSE 1 END) DESC
       ) AS wc_per_game_pos_rank,
       datetime('now')
  FROM season_totals;
