from __future__ import annotations

from typing import Any, Optional


POS_BUCKET_DUD = 0
POS_BUCKET_NEUTRAL = 1
POS_BUCKET_PLUS = 2
POS_BUCKET_ELITE = 3

POS_BUCKET_ELITE_MIN = 1.0
POS_BUCKET_PLUS_MIN = 0.25
POS_BUCKET_NEUTRAL_MIN = -0.5

POS_BUCKET_CODE_TO_LABEL = {
    POS_BUCKET_DUD: "dud",
    POS_BUCKET_NEUTRAL: "neutral",
    POS_BUCKET_PLUS: "plus",
    POS_BUCKET_ELITE: "elite",
}

POS_BUCKET_THRESHOLDS = {
    "elite_min": POS_BUCKET_ELITE_MIN,
    "plus_min": POS_BUCKET_PLUS_MIN,
    "neutral_min": POS_BUCKET_NEUTRAL_MIN,
}


def parse_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        text = str(value).strip()
        if not text:
            return None
        return float(text)
    except (TypeError, ValueError):
        return None


def compute_pos_week_score(
    score: Any,
    median_starter_score: Any,
    season_delta: Any,
    stored_score: Any = None,
) -> Optional[float]:
    # Align reconstructed benched-week scores to the persisted starter score scale.
    score_value = parse_float(score)
    baseline_value = parse_float(median_starter_score)
    if score_value is None or baseline_value is None:
        return parse_float(stored_score)
    season_delta_value = parse_float(season_delta)
    if season_delta_value is None or season_delta_value <= 0:
        return parse_float(stored_score)
    return (score_value - baseline_value) / season_delta_value


def pos_bucket_code(score: Optional[float]) -> Optional[int]:
    if score is None:
        return None
    if score >= POS_BUCKET_ELITE_MIN:
        return POS_BUCKET_ELITE
    if score >= POS_BUCKET_PLUS_MIN:
        return POS_BUCKET_PLUS
    if score >= POS_BUCKET_NEUTRAL_MIN:
        return POS_BUCKET_NEUTRAL
    return POS_BUCKET_DUD


def bucket_label(code: Any) -> str:
    try:
        return POS_BUCKET_CODE_TO_LABEL.get(int(code), "")
    except (TypeError, ValueError):
        return ""
