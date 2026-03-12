# Acquisition Value Score Calculation Registry

- Methodology version: `rookie_value_score_v1`
- Canonical weekly model: `roster_bucket_v1`
- Legacy weekly model: `legacy_week_flags_v1`
- Canonical weekly model start season: `2020`

## canonical_pos_week_score_v1

- Output fields: `pos_week_score`
- Canonical: `True`
- Formula: (score - median_starter_score) / delta_win_pos when score, median_starter_score, and delta_win_pos are available and delta_win_pos > 0; otherwise fall back to stored_pos_week_score.
- Units: normalized positional win-profile score
- Rounding: Stored raw in memory; rounded to 3 decimals in roster history weekly rows.
- Denominator: delta_win_pos
- Source tables/views: `player_weeklyscoringresults, metadata_weeklypositionalbaselines, metadata_positionalwinprofile`
- Upstream dependencies: `score, median_starter_score, delta_win_pos, stored_pos_week_score`
- Consumer artifacts: `site/rosters/player_points_history.json, site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/lib/weekly_classification.py::compute_pos_week_score`
- Season availability: Canonical where positional baseline metadata exists. Full coverage begins in 2020 for the current rookie-history window.
- Fallback behavior: Use stored_pos_week_score when metadata inputs are missing or invalid. Return null when neither computed nor stored score is available.

## canonical_pos_bucket_v1

- Output fields: `pos_bucket, bucket_label`
- Canonical: `True`
- Formula: elite if pos_week_score >= 1.0; plus if pos_week_score >= 0.25; neutral if pos_week_score >= -0.5; otherwise dud.
- Units: bucket code and label
- Rounding: No rounding beyond upstream pos_week_score handling.
- Denominator: none
- Source tables/views: `player_weeklyscoringresults, metadata_weeklypositionalbaselines, metadata_positionalwinprofile`
- Upstream dependencies: `pos_week_score`
- Consumer artifacts: `site/rosters/player_points_history.json, site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/lib/weekly_classification.py::pos_bucket_code`
- Season availability: Canonical where positional baseline metadata exists. Full coverage begins in 2020 for the current rookie-history window.
- Fallback behavior: Return null when pos_week_score is unavailable.

## canonical_rookie_weekly_rates_v1

- Output fields: `classified_weeks_3yr, elite_weeks, dud_weeks, non_dud_weeks, elite_week_rate, dud_week_rate, non_dud_rate`
- Canonical: `True`
- Formula: Across rookie season + next 2 seasons, classified_weeks_3yr is the count of weekly rows with a canonical pos_bucket. elite_weeks counts elite buckets. dud_weeks counts dud buckets. non_dud_weeks = classified_weeks_3yr - dud_weeks. elite_week_rate = elite_weeks / classified_weeks_3yr. dud_week_rate = dud_weeks / classified_weeks_3yr. Stored non_dud_rate is derived from the same rounded dud_week_rate as 1 - dud_week_rate so the published rates remain internally consistent.
- Units: weeks and rates
- Rounding: Counts stored as integers. Rates rounded to 2 decimals in acquisition history.
- Denominator: classified_weeks_3yr
- Source tables/views: `player_weeklyscoringresults, metadata_weeklypositionalbaselines, metadata_positionalwinprofile`
- Upstream dependencies: `pos_bucket, season, player_id`
- Consumer artifacts: `site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/scripts/build_acquisition_hub_artifacts.py::build_rookie_history`
- Season availability: 2020+ rookie classes
- Fallback behavior: Use legacy_week_flags_v1 for pre-2020 rookie classes.

## legacy_rookie_week_flags_v1

- Output fields: `classified_weeks_3yr, elite_weeks, non_dud_weeks, elite_week_rate, non_dud_rate, weekly_classification_model, weekly_classification_is_legacy`
- Canonical: `False`
- Formula: Across rookie season + next 2 seasons, classified_weeks_3yr is total weekly games. elite_weeks sums legacy elite_week flags. non_dud_weeks sums legacy winning_week flags. Rates divide each count by classified_weeks_3yr when the denominator is > 0, else 0.
- Units: weeks and rates
- Rounding: Counts stored as integers. Rates rounded to 2 decimals in acquisition history.
- Denominator: classified_weeks_3yr
- Source tables/views: `player_weeklyscoringresults`
- Upstream dependencies: `elite_week, winning_week, season, player_id`
- Consumer artifacts: `site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/scripts/build_acquisition_hub_artifacts.py::build_rookie_history`
- Season availability: 2013-2019 rookie classes
- Fallback behavior: dud_weeks and dud_week_rate remain null because canonical dud data is unavailable.

## rookie_pick_bucket_v1

- Output fields: `pick_bucket`
- Canonical: `True`
- Formula: Bucket overall rookie picks into 6-pick ranges: 01-06, 07-12, 13-18, and so on.
- Units: string label
- Rounding: Zero-padded integer labels.
- Denominator: none
- Source tables/views: `View_RookieDraft`
- Upstream dependencies: `pick_overall`
- Consumer artifacts: `site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/scripts/build_acquisition_hub_artifacts.py::build_rookie_history`
- Season availability: All rookie history rows
- Fallback behavior: Minimum pick_overall defaults to 1.

## rookie_expected_points_3yr_v1

- Output fields: `expected_points_3yr`
- Canonical: `True`
- Formula: Median points_rookiecontract for all rows in the same pick_bucket.
- Units: fantasy points over first 3 years
- Rounding: Rounded to 2 decimals in acquisition history.
- Denominator: pick_bucket sample size
- Source tables/views: `View_RookieDraft`
- Upstream dependencies: `pick_bucket, points_rookiecontract`
- Consumer artifacts: `site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/scripts/build_acquisition_hub_artifacts.py::build_rookie_history`
- Season availability: All rookie history rows
- Fallback behavior: 0.0 when a bucket has no values.

## rookie_roi_score_v1

- Output fields: `roi_score`
- Canonical: `True`
- Formula: points_rookiecontract - expected_points_3yr
- Units: fantasy points over expectation
- Rounding: Rounded to 2 decimals in acquisition history.
- Denominator: none
- Source tables/views: `View_RookieDraft`
- Upstream dependencies: `points_rookiecontract, expected_points_3yr`
- Consumer artifacts: `site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/scripts/build_acquisition_hub_artifacts.py::build_rookie_history`
- Season availability: All rookie history rows
- Fallback behavior: 0.0 expected_points_3yr when a bucket has no values.

## rookie_value_score_v1

- Output fields: `rookie_value_score`
- Canonical: `True`
- Formula: 100 * sum(component_scaled * weight) across: points_rookiecontract_scaled*0.27, elite_week_rate_scaled*0.15, non_dud_rate_scaled*0.12, starts_share_scaled*0.12, positional_value_score_scaled*0.12, overall_impact_score_scaled*0.12, roi_score_scaled*0.10
- Units: 0-100 composite score
- Rounding: Scaled inputs stay raw floats; final score rounded to 2 decimals.
- Denominator: none
- Source tables/views: `View_RookieDraft, player_weeklyscoringresults`
- Upstream dependencies: `points_rookiecontract, elite_week_rate, non_dud_rate, starts_share, positional_value_score, overall_impact_score, roi_score`
- Consumer artifacts: `site/acquisition/rookie_draft_history.json`
- Source file/function: `pipelines/etl/scripts/build_acquisition_hub_artifacts.py::build_rookie_history`
- Season availability: All rookie history rows
- Fallback behavior: Each raw component is min-max scaled by offense_defense cohort before weighting. When a cohort has no spread, non-zero values scale to 0.5 and zero values to 0.0.
