from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List

from lib.weekly_classification import POS_BUCKET_THRESHOLDS


VALUE_SCORE_METHODOLOGY_VERSION = "rookie_value_score_v1"
CANONICAL_WEEKLY_CLASSIFICATION_MODEL = "roster_bucket_v1"
LEGACY_WEEKLY_CLASSIFICATION_MODEL = "legacy_week_flags_v1"
CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON = 2020
ROOKIE_HISTORY_FLOOR_SEASON = 2013
CALCULATION_REGISTRY_PATHS = {
    "json": "docs/calculations/acquisition_value_score_registry.json",
    "markdown": "docs/calculations/acquisition_value_score_registry.md",
}

VALUE_SCORE_COMPONENTS = [
    {
        "label": "first_3_year_points",
        "raw_field": "points_rookiecontract",
        "scaled_field": "points_rookiecontract_scaled",
        "weight": 0.27,
    },
    {
        "label": "elite_week_rate",
        "raw_field": "elite_week_rate",
        "scaled_field": "elite_week_rate_scaled",
        "weight": 0.15,
    },
    {
        "label": "non_dud_rate",
        "raw_field": "non_dud_rate",
        "scaled_field": "non_dud_rate_scaled",
        "weight": 0.12,
    },
    {
        "label": "starts_share",
        "raw_field": "starts_share",
        "scaled_field": "starts_share_scaled",
        "weight": 0.12,
    },
    {
        "label": "positional_value",
        "raw_field": "positional_value_score",
        "scaled_field": "positional_value_score_scaled",
        "weight": 0.12,
    },
    {
        "label": "overall_impact",
        "raw_field": "overall_impact_score",
        "scaled_field": "overall_impact_score_scaled",
        "weight": 0.12,
    },
    {
        "label": "roi_vs_pick_bucket_expectation",
        "raw_field": "roi_score",
        "scaled_field": "roi_score_scaled",
        "weight": 0.10,
    },
]


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def build_calculation_registry() -> Dict[str, Any]:
    entries: List[Dict[str, Any]] = [
        {
            "id": "canonical_pos_week_score_v1",
            "output_fields": ["pos_week_score"],
            "formula": (
                "(score - median_starter_score) / delta_win_pos when score, median_starter_score, "
                "and delta_win_pos are available and delta_win_pos > 0; otherwise fall back to "
                "stored_pos_week_score."
            ),
            "units": "normalized positional win-profile score",
            "rounding": "Stored raw in memory; rounded to 3 decimals in roster history weekly rows.",
            "denominator": "delta_win_pos",
            "source_tables": [
                "player_weeklyscoringresults",
                "metadata_weeklypositionalbaselines",
                "metadata_positionalwinprofile",
            ],
            "upstream_dependencies": [
                "score",
                "median_starter_score",
                "delta_win_pos",
                "stored_pos_week_score",
            ],
            "consumer_artifacts": [
                "site/rosters/player_points_history.json",
                "site/acquisition/rookie_draft_history.json",
            ],
            "source_file": "pipelines/etl/lib/weekly_classification.py",
            "source_function": "compute_pos_week_score",
            "season_availability": (
                "Canonical where positional baseline metadata exists. Full coverage begins in 2020 "
                "for the current rookie-history window."
            ),
            "fallback_behavior": (
                "Use stored_pos_week_score when metadata inputs are missing or invalid. Return null "
                "when neither computed nor stored score is available."
            ),
            "canonical": True,
        },
        {
            "id": "canonical_pos_bucket_v1",
            "output_fields": ["pos_bucket", "bucket_label"],
            "formula": (
                "elite if pos_week_score >= {elite_min}; plus if pos_week_score >= {plus_min}; "
                "neutral if pos_week_score >= {neutral_min}; otherwise dud."
            ).format(**POS_BUCKET_THRESHOLDS),
            "units": "bucket code and label",
            "rounding": "No rounding beyond upstream pos_week_score handling.",
            "denominator": "none",
            "source_tables": [
                "player_weeklyscoringresults",
                "metadata_weeklypositionalbaselines",
                "metadata_positionalwinprofile",
            ],
            "upstream_dependencies": ["pos_week_score"],
            "consumer_artifacts": [
                "site/rosters/player_points_history.json",
                "site/acquisition/rookie_draft_history.json",
            ],
            "source_file": "pipelines/etl/lib/weekly_classification.py",
            "source_function": "pos_bucket_code",
            "season_availability": (
                "Canonical where positional baseline metadata exists. Full coverage begins in 2020 "
                "for the current rookie-history window."
            ),
            "fallback_behavior": "Return null when pos_week_score is unavailable.",
            "canonical": True,
        },
        {
            "id": "canonical_rookie_weekly_rates_v1",
            "output_fields": [
                "classified_weeks_3yr",
                "elite_weeks",
                "dud_weeks",
                "non_dud_weeks",
                "elite_week_rate",
                "dud_week_rate",
                "non_dud_rate",
            ],
            "formula": (
                "Across rookie season + next 2 seasons, classified_weeks_3yr is the count of weekly "
                "rows with a canonical pos_bucket. elite_weeks counts elite buckets. dud_weeks counts "
                "dud buckets. non_dud_weeks = classified_weeks_3yr - dud_weeks. elite_week_rate = "
                "elite_weeks / classified_weeks_3yr. dud_week_rate = dud_weeks / "
                "classified_weeks_3yr. Stored non_dud_rate is derived from the same rounded dud_week_rate "
                "as 1 - dud_week_rate so the published rates remain internally consistent."
            ),
            "units": "weeks and rates",
            "rounding": "Counts stored as integers. Rates rounded to 2 decimals in acquisition history.",
            "denominator": "classified_weeks_3yr",
            "source_tables": [
                "player_weeklyscoringresults",
                "metadata_weeklypositionalbaselines",
                "metadata_positionalwinprofile",
            ],
            "upstream_dependencies": ["pos_bucket", "season", "player_id"],
            "consumer_artifacts": ["site/acquisition/rookie_draft_history.json"],
            "source_file": "pipelines/etl/scripts/build_acquisition_hub_artifacts.py",
            "source_function": "build_rookie_history",
            "season_availability": f"{CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON}+ rookie classes",
            "fallback_behavior": "Use legacy_week_flags_v1 for pre-2020 rookie classes.",
            "canonical": True,
        },
        {
            "id": "legacy_rookie_week_flags_v1",
            "output_fields": [
                "classified_weeks_3yr",
                "elite_weeks",
                "non_dud_weeks",
                "elite_week_rate",
                "non_dud_rate",
                "weekly_classification_model",
                "weekly_classification_is_legacy",
            ],
            "formula": (
                "Across rookie season + next 2 seasons, classified_weeks_3yr is total weekly games. "
                "elite_weeks sums legacy elite_week flags. non_dud_weeks sums legacy winning_week flags. "
                "Rates divide each count by classified_weeks_3yr when the denominator is > 0, else 0."
            ),
            "units": "weeks and rates",
            "rounding": "Counts stored as integers. Rates rounded to 2 decimals in acquisition history.",
            "denominator": "classified_weeks_3yr",
            "source_tables": ["player_weeklyscoringresults"],
            "upstream_dependencies": ["elite_week", "winning_week", "season", "player_id"],
            "consumer_artifacts": ["site/acquisition/rookie_draft_history.json"],
            "source_file": "pipelines/etl/scripts/build_acquisition_hub_artifacts.py",
            "source_function": "build_rookie_history",
            "season_availability": (
                f"{ROOKIE_HISTORY_FLOOR_SEASON}-{CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON - 1} rookie classes"
            ),
            "fallback_behavior": "dud_weeks and dud_week_rate remain null because canonical dud data is unavailable.",
            "canonical": False,
        },
        {
            "id": "rookie_pick_bucket_v1",
            "output_fields": ["pick_bucket"],
            "formula": "Bucket overall rookie picks into 6-pick ranges: 01-06, 07-12, 13-18, and so on.",
            "units": "string label",
            "rounding": "Zero-padded integer labels.",
            "denominator": "none",
            "source_tables": ["View_RookieDraft"],
            "upstream_dependencies": ["pick_overall"],
            "consumer_artifacts": ["site/acquisition/rookie_draft_history.json"],
            "source_file": "pipelines/etl/scripts/build_acquisition_hub_artifacts.py",
            "source_function": "build_rookie_history",
            "season_availability": "All rookie history rows",
            "fallback_behavior": "Minimum pick_overall defaults to 1.",
            "canonical": True,
        },
        {
            "id": "rookie_expected_points_3yr_v1",
            "output_fields": ["expected_points_3yr"],
            "formula": "Median points_rookiecontract for all rows in the same pick_bucket.",
            "units": "fantasy points over first 3 years",
            "rounding": "Rounded to 2 decimals in acquisition history.",
            "denominator": "pick_bucket sample size",
            "source_tables": ["View_RookieDraft"],
            "upstream_dependencies": ["pick_bucket", "points_rookiecontract"],
            "consumer_artifacts": ["site/acquisition/rookie_draft_history.json"],
            "source_file": "pipelines/etl/scripts/build_acquisition_hub_artifacts.py",
            "source_function": "build_rookie_history",
            "season_availability": "All rookie history rows",
            "fallback_behavior": "0.0 when a bucket has no values.",
            "canonical": True,
        },
        {
            "id": "rookie_roi_score_v1",
            "output_fields": ["roi_score"],
            "formula": "points_rookiecontract - expected_points_3yr",
            "units": "fantasy points over expectation",
            "rounding": "Rounded to 2 decimals in acquisition history.",
            "denominator": "none",
            "source_tables": ["View_RookieDraft"],
            "upstream_dependencies": ["points_rookiecontract", "expected_points_3yr"],
            "consumer_artifacts": ["site/acquisition/rookie_draft_history.json"],
            "source_file": "pipelines/etl/scripts/build_acquisition_hub_artifacts.py",
            "source_function": "build_rookie_history",
            "season_availability": "All rookie history rows",
            "fallback_behavior": "0.0 expected_points_3yr when a bucket has no values.",
            "canonical": True,
        },
        {
            "id": "rookie_value_score_v1",
            "output_fields": ["rookie_value_score"],
            "formula": (
                "100 * sum(component_scaled * weight) across: "
                + ", ".join(
                    f"{item['scaled_field']}*{item['weight']:.2f}" for item in VALUE_SCORE_COMPONENTS
                )
            ),
            "units": "0-100 composite score",
            "rounding": "Scaled inputs stay raw floats; final score rounded to 2 decimals.",
            "denominator": "none",
            "source_tables": ["View_RookieDraft", "player_weeklyscoringresults"],
            "upstream_dependencies": [item["raw_field"] for item in VALUE_SCORE_COMPONENTS],
            "consumer_artifacts": ["site/acquisition/rookie_draft_history.json"],
            "source_file": "pipelines/etl/scripts/build_acquisition_hub_artifacts.py",
            "source_function": "build_rookie_history",
            "season_availability": "All rookie history rows",
            "fallback_behavior": (
                "Each raw component is min-max scaled by offense_defense cohort before weighting. "
                "When a cohort has no spread, non-zero values scale to 0.5 and zero values to 0.0."
            ),
            "canonical": True,
        },
    ]
    return {
        "meta": {
            "generated_at_utc": utc_now_iso(),
            "methodology_version": VALUE_SCORE_METHODOLOGY_VERSION,
            "canonical_weekly_classification_model": CANONICAL_WEEKLY_CLASSIFICATION_MODEL,
            "legacy_weekly_classification_model": LEGACY_WEEKLY_CLASSIFICATION_MODEL,
            "canonical_weekly_classification_start_season": CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON,
            "registry_paths": CALCULATION_REGISTRY_PATHS,
            "scope": [
                "canonical weekly bucket calculations",
                "acquisition value score component calculations",
                "pick-bucket expectation and ROI calculations",
                "legacy fallback rules",
            ],
        },
        "entries": entries,
    }


def render_registry_markdown(registry: Dict[str, Any]) -> str:
    meta = registry.get("meta", {})
    entries = registry.get("entries", [])
    lines: List[str] = [
        "# Acquisition Value Score Calculation Registry",
        "",
        f"- Methodology version: `{meta.get('methodology_version', '')}`",
        f"- Canonical weekly model: `{meta.get('canonical_weekly_classification_model', '')}`",
        f"- Legacy weekly model: `{meta.get('legacy_weekly_classification_model', '')}`",
        f"- Canonical weekly model start season: `{meta.get('canonical_weekly_classification_start_season', '')}`",
        "",
    ]
    for entry in entries:
        lines.extend(
            [
                f"## {entry['id']}",
                "",
                f"- Output fields: `{', '.join(entry['output_fields'])}`",
                f"- Canonical: `{entry['canonical']}`",
                f"- Formula: {entry['formula']}",
                f"- Units: {entry['units']}",
                f"- Rounding: {entry['rounding']}",
                f"- Denominator: {entry['denominator']}",
                f"- Source tables/views: `{', '.join(entry['source_tables'])}`",
                f"- Upstream dependencies: `{', '.join(entry['upstream_dependencies'])}`",
                f"- Consumer artifacts: `{', '.join(entry['consumer_artifacts'])}`",
                f"- Source file/function: `{entry['source_file']}::{entry['source_function']}`",
                f"- Season availability: {entry['season_availability']}",
                f"- Fallback behavior: {entry['fallback_behavior']}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"
