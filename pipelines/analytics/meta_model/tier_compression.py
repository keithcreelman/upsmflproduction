"""
tier_compression.py — shared utilities for ZAP 2.0 tier bands and cross-model agreement.

ZAP 2.0 tier bands per JJ's 2026 PreDraft Guide p. 25-26:
  Legendary Performer: 90-100
  Elite Producer:      75-90
  Weekly Starter:      60-75
  Flex Play:           40-60
  Benchwarmer:         30-40
  Waiver Wire Add:     20-30
  Dart Throw:           0-20
"""
from __future__ import annotations

ZAP2_TIERS = [
    ("Legendary Performer", 90, 100),
    ("Elite Producer", 75, 90),
    ("Weekly Starter", 60, 75),
    ("Flex Play", 40, 60),
    ("Benchwarmer", 30, 40),
    ("Waiver Wire Add", 20, 30),
    ("Dart Throw", 0, 20),
]

TIER_ORDER = {name: i for i, (name, _, _) in enumerate(ZAP2_TIERS)}
# 0 = Legendary (best), 6 = Dart Throw (worst)


def assign_tier(score: float) -> str:
    if score is None:
        return "—"
    for name, lo, hi in ZAP2_TIERS:
        if lo <= score < hi or (hi == 100 and score >= lo):
            return name
    return "Dart Throw"


def tier_distance(tier_a: str, tier_b: str) -> int:
    """Number of tier-band positions between two tiers."""
    if tier_a not in TIER_ORDER or tier_b not in TIER_ORDER:
        return 0
    return abs(TIER_ORDER[tier_a] - TIER_ORDER[tier_b])


def cross_model_agreement(jj_tier: str, koalaty_tier: str) -> str:
    """
    Per the spec, default disagreement threshold is 2 tiers.
    Returns: 'agree', 'mild_disagreement', 'strong_disagreement'
    """
    if not jj_tier or not koalaty_tier or jj_tier == "—" or koalaty_tier == "—":
        return "single_model"
    d = tier_distance(jj_tier, koalaty_tier)
    if d == 0:
        return "agree"
    if d == 1:
        return "near_agree"
    return "disagree"


def normalize_name(name: str) -> str:
    """Normalize for cross-source name matching."""
    return (name.replace(",", "").replace(".", "").replace("'", "")
            .replace(" ", "").replace("-", "").replace("Jr", "")
            .replace("Sr", "").replace("II", "").replace("III", "")
            .lower().strip())
