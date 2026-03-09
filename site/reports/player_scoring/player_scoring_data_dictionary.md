# Player Scoring Report Data Dictionary

## Source Mapping

- `weekly_player_scores` view: normalized from `player_weeklyscoringresults`
- `player_master` view: normalized from `dim_player`
- `rosters_currentseason` view: latest season/week snapshot from `rosters_current`
- `player_season_dominance`: existing ETL table, joined for supplemental dominance metrics
- `transactions_adddrop`: existing ETL table, joined for the latest add/drop context

## Core Fields

- `nfl_season`: report season from weekly scoring results.
- `player_id`: stable league player identifier.
- `player_name`: normalized player display name.
- `position`: player position from weekly scoring, backfilled from `dim_player` when needed.
- `position_group`: roster-aligned grouping. `CB` and `S` roll up to `DB`; `DE` and `DT` roll up to `DL`.
- `team`: NFL team from `dim_player`.

## Roster Fields

- `franchise_id`: current roster snapshot franchise id. Blank means free agent in the latest snapshot.
- `franchise_name`: current roster snapshot franchise name.
- `owner_name`: current roster snapshot owner.
- `current_roster_status`: latest roster snapshot status. Defaults to `FREE_AGENT` when the player is not rostered.
- `rostered_ind`: `true` when the player exists in the latest `rosters_currentseason` snapshot.
- `free_agent_ind`: inverse of `rostered_ind`.
- `starter_count`: number of weekly scoring rows where `status = starter`.
- `bench_count`: number of weekly scoring rows where `status = nonstarter`.
- `free_agent_count`: number of weekly scoring rows where `status = fa`.
- `games_started`: UI/export alias of `starter_count`.
- `games_benched`: UI/export alias of `bench_count`.

## Scoring Metrics

- `games_played`: count of weekly scoring rows for the season.
- `total_points`: sum of weekly scores.
- `points_per_game`: `total_points / games_played`.
- `median_points`: median weekly score for the season.
- `max_points`: highest weekly score.
- `min_points`: lowest weekly score.
- `std_dev`: standard deviation of weekly scores using `sqrt(avg(score^2) - avg(score)^2)`.
- `standard_deviation`: UI/export alias of `std_dev`.

## Weekly Classification Fields

- `position_week_percentile`: weekly percentile within `season + week + position_group`, stored in the compact weekly export arrays.
- `elite_weeks`: count of weekly rows where `position_week_percentile >= elite_threshold`.
- `dud_weeks`: count of weekly rows where `position_week_percentile <= dud_threshold`.
- `neutral_weeks`: `games_played - elite_weeks - dud_weeks`.

Default UI thresholds:

- elite: `75`
- dud: `25`

The frontend recalculates these counts client-side whenever the thresholds change.

## Value Metrics

- `position_average_points_per_game`: average `points_per_game` for the season and `position_group`.
- `vam`: `points_per_game - position_average_points_per_game`.
- `vam_total`: `total_points - (position_average_points_per_game * games_played)`.
- `dominance_total_vam`: carried from `player_season_dominance.total_vam` when available, otherwise falls back to `vam_total`.

## Ranking Metrics

- `positional_rank`: dense rank by `points_per_game DESC`, then `total_points DESC`, within `season + position_group`.
- `percentile_rank`: `cume_dist(points_per_game ASC)` within `season + position_group`, scaled to `0-100`.

## Stability Metrics

- `consistency_index`: `max(0, 100 * (1 - (std_dev / points_per_game)))`.
- `boom_rate`: `100 * elite_weeks / games_played`.
- `bust_rate`: `100 * dud_weeks / games_played`.
- `elite_week_rate`: UI/export alias of `boom_rate`.
- `dud_week_rate`: UI/export alias of `bust_rate`.

## Trend Metrics

These fields are derived client-side from `weekly_scores_by_player` and are not stored as top-level fields in the exported JSON.

- `last_3_avg`: average of the player's most recent 3 weekly scores, or fewer when the player has fewer than 3 games.
- `last_5_avg`: average of the player's most recent 5 weekly scores, or fewer when the player has fewer than 5 games.
- `recent_trend_delta`: `last_3_avg` minus the immediately preceding comparison window. The comparison window uses up to 3 prior games and falls back to the earlier portion of the season when fewer than 6 games exist.
- `recent_trend_direction`: `up`, `down`, or `flat`, based on `recent_trend_delta` versus a lightweight client-side threshold of `max(1.25, 8% of recent reference average)`.
- `best_streak`: longest consecutive elite-week streak under the current UI elite threshold.
- `dud_streak`: longest consecutive dud-week streak under the current UI dud threshold.
- `rolling_volatility`: standard deviation of the most recent 5 weekly scores, or the full weekly series when fewer than 5 games are present.

The sparkline view is also client-side. It is rendered only for the currently visible table rows or mobile cards to keep the report lightweight.

## Weekly Detail View

The expandable weekly detail layer is also client-side and threshold-aware. It reuses the same weekly export plus the active elite/dud settings.

Client-side weekly detail fields:

- `week`: NFL week number from the compact weekly export.
- `score`: weekly player score.
- `weekly_vam`: weekly positional value-above-mean from the compact weekly export.
- `weekly_position_percentile`: weekly positional percentile from the compact weekly export, scaled to `0-100`.
- `weekly_classification`: `elite`, `neutral`, or `dud` under the current UI thresholds.
- `usage_status`: client-side label resolved from `lookups.usage_statuses`.
- `is_recent_week`: `true` for the player's most recent 3 scored weeks.
- `classification_streak_count`: consecutive elite or dud run length at that point in the season.
- `streak_marker`: optional client-side display label such as `Elite x2` or `Dud x2`.

Desktop renders the detail as an expandable row directly beneath the player. Mobile renders it as a collapsible stacked section inside the player card.

## Comparison Mode

The comparison tray is client-side only. It reuses the same season summary rows, trend metrics, and threshold-aware weekly derivations already used by the main report.

Client-side comparison state:

- `comparePlayerIds`: ordered list of selected `player_id` values for the active season.
- `compareMessage`: lightweight UI message used when the tray reaches the selection limit.

Comparison constraints:

- minimum `2` players for an active side-by-side comparison state
- maximum `4` selected players at once
- selected players remain pinned in the comparison tray even if filters change, as long as they still exist in the current season dataset
- selection resets on season change

Displayed comparison metrics:

- `player_name`
- `position_group`
- `team`
- `roster_status`
- `total_points`
- `points_per_game`
- `elite_weeks`
- `neutral_weeks`
- `dud_weeks`
- `vam`
- `consistency_index`
- `last_3_avg`
- `last_5_avg`
- `best_streak`
- `dud_streak`
- `rolling_volatility`
- `percentile_rank`
- `positional_rank`

The compare tray also renders the existing client-side sparkline and recent trend direction for each selected player.

## UI Filter Surface

Current Player Scoring filters support:

- season
- free-text player/team/franchise search
- position group
- NFL team
- roster status bucket (`all`, `rostered`, `free agent`)
- snapshot roster status (`ROSTER`, `TAXI_SQUAD`, `INJURED_RESERVE`, `FREE_AGENT` when present)
- usage bucket (`any`, `started`, `benched`)
- minimum games played
- minimum starts
- minimum points per game
- configurable elite and dud percentile thresholds

## Transaction Context

- `last_transaction_season`: season of the latest add/drop event for the player.
- `last_move_type`: latest move type from `transactions_adddrop` (`ADD` or `DROP`).
- `last_move_method`: acquisition method from the latest add/drop event.
- `last_transaction_franchise_id`: franchise id tied to the latest add/drop event.
- `last_transaction_franchise_name`: franchise name tied to the latest add/drop event.
- `last_transaction_date`: latest add/drop date in ET.
- `last_transaction_datetime`: latest add/drop timestamp in ET.

## Export Notes

- `player_scoring_manifest.json`: season index and global metadata.
- `player_scoring_<season>.json`: season-level summary rows plus compact weekly arrays.
- `weekly_scores_by_player`: keyed by `player_id`.
- `lookups.weekly_schema`: array order for each compact weekly score entry.
- filtered CSV export includes the client-side trend metrics shown above.
- CSV export remains summary-focused in this phase and does not include per-week detail rows.
- compare tray selections and comparison cards are UI-only and are not included in CSV export.
