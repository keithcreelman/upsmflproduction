from __future__ import annotations

import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path


TEST_FILE = Path(__file__).resolve()
ETL_ROOT = TEST_FILE.parent.parent
REPO_ROOT = ETL_ROOT.parent.parent
if str(ETL_ROOT) not in sys.path:
    sys.path.insert(0, str(ETL_ROOT))

from lib.calculation_registry import (  # noqa: E402
    CANONICAL_WEEKLY_CLASSIFICATION_MODEL,
    CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON,
    LEGACY_WEEKLY_CLASSIFICATION_MODEL,
    ROOKIE_HISTORY_FLOOR_SEASON,
    VALUE_SCORE_COMPONENTS,
    build_calculation_registry,
    render_registry_markdown,
)
from lib.weekly_classification import (  # noqa: E402
    POS_BUCKET_DUD,
    POS_BUCKET_ELITE,
    POS_BUCKET_NEUTRAL,
    POS_BUCKET_PLUS,
    bucket_label,
    compute_pos_week_score,
    pos_bucket_code,
)
from scripts.build_acquisition_hub_artifacts import build_rookie_history  # noqa: E402


DB_PATH = Path(
    os.getenv(
        "MFL_DB_PATH",
        str(ETL_ROOT / "data" / "mfl_database.db"),
    )
)


@unittest.skipUnless(DB_PATH.is_file(), f"requires SQLite DB at {DB_PATH}")
class WeeklyClassificationTests(unittest.TestCase):
    def test_pos_bucket_threshold_boundaries(self) -> None:
        self.assertEqual(pos_bucket_code(1.0), POS_BUCKET_ELITE)
        self.assertEqual(pos_bucket_code(0.25), POS_BUCKET_PLUS)
        self.assertEqual(pos_bucket_code(-0.5), POS_BUCKET_NEUTRAL)
        self.assertEqual(pos_bucket_code(-0.50001), POS_BUCKET_DUD)
        self.assertEqual(bucket_label(POS_BUCKET_ELITE), "elite")

    def test_compute_pos_week_score_falls_back_to_stored_score(self) -> None:
        self.assertAlmostEqual(compute_pos_week_score(10, None, 8, -0.75), -0.75)
        self.assertIsNone(compute_pos_week_score(10, None, 8, None))

    def test_roster_helper_matches_existing_roster_history_row(self) -> None:
        data = json.loads((REPO_ROOT / "site/rosters/player_points_history.json").read_text())
        player_row = data["players"]["11150"]["w"]["2020"]["14"]
        expected_pos_week_score = player_row[5]
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        try:
            row = conn.execute(
                """
                SELECT
                  pwsr.score,
                  pwsr.win_chunks_pos_vam AS stored_pos_week_score,
                  wpb.median_starter_score,
                  pwp.delta_win_pos AS season_delta_win_pos
                FROM player_weeklyscoringresults pwsr
                LEFT JOIN metadata_weeklypositionalbaselines wpb
                  ON wpb.season = pwsr.season
                 AND wpb.week = pwsr.week
                 AND COALESCE(wpb.pos_group, '') = COALESCE(pwsr.pos_group, '')
                LEFT JOIN metadata_positionalwinprofile pwp
                  ON pwp.season = pwsr.season
                 AND COALESCE(pwp.pos_group, '') = COALESCE(pwsr.pos_group, '')
                WHERE pwsr.season = 2020
                  AND pwsr.week = 14
                  AND CAST(pwsr.player_id AS TEXT) = '11150'
                """
            ).fetchone()
        finally:
            conn.close()
        self.assertIsNotNone(row)
        actual = compute_pos_week_score(
            row["score"],
            row["median_starter_score"],
            row["season_delta_win_pos"],
            row["stored_pos_week_score"],
        )
        self.assertAlmostEqual(round(actual, 3), expected_pos_week_score, places=3)

    def test_acquisition_rows_use_canonical_and_legacy_models(self) -> None:
        conn = sqlite3.connect(str(DB_PATH))
        try:
            history = build_rookie_history(conn, 2026, 12)
        finally:
            conn.close()
        rows = history["history_rows"]
        canonical_rows = [
            row for row in rows if int(row["season"]) >= CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON
        ]
        legacy_rows = [
            row for row in rows if int(row["season"]) < CANONICAL_WEEKLY_CLASSIFICATION_START_SEASON
        ]
        self.assertTrue(canonical_rows)
        self.assertTrue(legacy_rows)
        self.assertEqual(min(int(row["season"]) for row in rows), ROOKIE_HISTORY_FLOOR_SEASON)
        self.assertTrue(
            all(row["weekly_classification_model"] == CANONICAL_WEEKLY_CLASSIFICATION_MODEL for row in canonical_rows)
        )
        self.assertTrue(all(row["weekly_classification_is_legacy"] == 0 for row in canonical_rows))
        self.assertTrue(all(row["weekly_classification_model"] == LEGACY_WEEKLY_CLASSIFICATION_MODEL for row in legacy_rows))
        self.assertTrue(all(row["weekly_classification_is_legacy"] == 1 for row in legacy_rows))
        self.assertTrue(all(row["dud_weeks"] is None for row in legacy_rows))
        self.assertTrue(all(row["dud_week_rate"] is None for row in legacy_rows))

    def test_canonical_rows_keep_non_dud_identity(self) -> None:
        conn = sqlite3.connect(str(DB_PATH))
        try:
            history = build_rookie_history(conn, 2026, 12)
        finally:
            conn.close()
        canonical_rows = [
            row for row in history["history_rows"]
            if row["weekly_classification_is_legacy"] == 0 and row["classified_weeks_3yr"] > 0
        ]
        self.assertTrue(canonical_rows)
        for row in canonical_rows:
            self.assertAlmostEqual(row["non_dud_rate"], round(1.0 - row["dud_week_rate"], 2), places=2)

    def test_value_score_still_matches_scaled_component_sum(self) -> None:
        conn = sqlite3.connect(str(DB_PATH))
        try:
            history = build_rookie_history(conn, 2026, 12)
        finally:
            conn.close()
        for row in history["history_rows"][:50]:
            expected = round(
                sum(float(row.get(component["scaled_field"], 0.0) or 0.0) * component["weight"] for component in VALUE_SCORE_COMPONENTS) * 100.0,
                2,
            )
            self.assertEqual(row["rookie_value_score"], expected)

    def test_registry_entries_have_required_fields_and_markdown(self) -> None:
        registry = build_calculation_registry()
        entries = registry["entries"]
        required_keys = {
            "id",
            "output_fields",
            "formula",
            "units",
            "rounding",
            "denominator",
            "source_tables",
            "upstream_dependencies",
            "consumer_artifacts",
            "source_file",
            "source_function",
            "season_availability",
            "fallback_behavior",
            "canonical",
        }
        self.assertTrue(entries)
        for entry in entries:
            self.assertTrue(required_keys.issubset(entry.keys()))
        markdown = render_registry_markdown(registry)
        self.assertIn("# Acquisition Value Score Calculation Registry", markdown)
        self.assertIn("## rookie_value_score_v1", markdown)


if __name__ == "__main__":
    unittest.main()
