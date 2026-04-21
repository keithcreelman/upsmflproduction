"""
pick_valuation.py — Empirical rookie-pick valuation for trade grader.

Two layers:
  1. Expected POINTS — the primary value signal. Comes from an exponential
     curve fit to expected_points_3yr (trade_value_model_2026.json), smoothing
     slot-level noise (~14-pick samples per slot).
  2. Rookie SALARY — the cost side. Comes from the league's actual rookie
     scale (empirical from 11 years of history):
       R1: linear $15K (1.01) -> $5K (1.11), floor $5K
       R2: $5K flat
       R3+: $2K flat
     AAV x 3-year rookie contract.

Future picks are valued by predicting the owner's finish using a blend of
historical tenure and current-season data, weighted toward owner early,
toward current reality as the season progresses.

Public API:
    pick_expected_points(year, round_, original_owner="", slot=None, ...) -> float
    pick_rookie_salary_aav(round_, slot) -> int
    pick_rookie_salary_tcv(round_, slot, years=3) -> int
    pick_value(...) -> int   # legacy dollar approximation (points x $/point)
    predict_finish(franchise_id, weeks_played=0) -> float
    predict_future_slot(franchise_id, weeks_played=0) -> int
"""

import json
import math
import statistics
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
TRADE_VALUE_MODEL = Path(
    "/Users/keithcreelman/Documents/New project/site/trade-value/trade_value_model_2026.json"
)
CAREER_STATS = ETL_ROOT / "data" / "franchise_career_stats.json"

# ── Owner tenure config ────────────────────────────────────────────────────
OWNER_TENURE_START = {
    "0002": 2023,  # Derrick Whitman
    "0005": 2023,  # Eric Martel
    "0006": 2025,  # Brian Cross
}

# ── Rookie contract scale (from 11 years of league history) ────────────────
# Returns AAV (per-year salary). Multiply by ROOKIE_CONTRACT_YEARS for TCV.
ROOKIE_CONTRACT_YEARS = 3


def pick_rookie_salary_aav(round_: int, slot: int) -> int:
    if round_ == 1:
        # 1.01 = $15K, linear $1K drop per slot, floor $5K at 1.11
        return max(5000, 16000 - slot * 1000)
    if round_ == 2:
        return 5000
    return 2000  # R3+


def pick_rookie_salary_tcv(round_: int, slot: int, years: int = ROOKIE_CONTRACT_YEARS) -> int:
    return pick_rookie_salary_aav(round_, slot) * years


# ── Fallbacks ──────────────────────────────────────────────────────────────
FALLBACK_DEEP_ROUND_PTS = {4: 60.0, 5: 30.0, 6: 15.0}
DEFAULT_FINISH = 6.5

# ── Blending weights (owner vs current-season reality) ─────────────────────
def _owner_weight(weeks_played: int) -> float:
    if weeks_played <= 0: return 0.90
    if weeks_played <= 4: return 0.65
    if weeks_played <= 8: return 0.45
    if weeks_played <= 12: return 0.25
    if weeks_played <= 14: return 0.10
    return 0.0

# ── Module state ───────────────────────────────────────────────────────────
_CURVE_A: float | None = None
_CURVE_B: float | None = None
_DOLLARS_PER_POINT: float | None = None
_CAREER_CACHE: dict | None = None


def _fit_exponential_curve(pairs: list[tuple[int, float]]) -> tuple[float, float]:
    """Fit pts = A * exp(-B * pick) via log-linear least-squares (stdlib only)."""
    pairs = [(x, y) for (x, y) in pairs if y > 0]
    if len(pairs) < 3:
        return 500.0, 0.03
    xs = [float(p[0]) for p in pairs]
    log_ys = [math.log(p[1]) for p in pairs]
    mean_x = statistics.mean(xs)
    mean_ly = statistics.mean(log_ys)
    cov = sum((xs[i] - mean_x) * (log_ys[i] - mean_ly) for i in range(len(xs))) / len(xs)
    var_x = statistics.pvariance(xs)
    if var_x == 0:
        return 500.0, 0.03
    slope = cov / var_x
    intercept = mean_ly - slope * mean_x
    return math.exp(intercept), -slope


def _load():
    global _CURVE_A, _CURVE_B, _DOLLARS_PER_POINT, _CAREER_CACHE
    if _CURVE_A is not None:
        return
    try:
        data = json.loads(TRADE_VALUE_MODEL.read_text())
    except Exception:
        data = {}
    pairs: list[tuple[int, float]] = []
    for p in data.get("picks", []):
        rnd = p.get("pick_round")
        slot = p.get("pick_slot")
        pts = p.get("expected_points_3yr")
        if rnd in (1, 2, 3) and slot and pts:
            overall = (rnd - 1) * 12 + slot
            pairs.append((overall, pts))
    _CURVE_A, _CURVE_B = _fit_exponential_curve(pairs)
    ratios = [
        p["salary"] / p["total_points"]
        for p in data.get("players", [])
        if (p.get("salary") or 0) >= 3000
        and (p.get("total_points") or 0) >= 100
        and (p.get("games_played") or 0) >= 8
    ]
    _DOLLARS_PER_POINT = statistics.median(ratios) if ratios else 60.0
    try:
        _CAREER_CACHE = json.loads(CAREER_STATS.read_text())
    except Exception:
        _CAREER_CACHE = {}


# ── Expected points (primary metric) ───────────────────────────────────────

def dollars_per_point() -> float:
    """Public accessor for the league's $/point rate (salary <-> pts conversion)."""
    _load()
    return _DOLLARS_PER_POINT or 60.0


def _smoothed_points_r123(overall_pick: int) -> float:
    _load()
    return _CURVE_A * math.exp(-_CURVE_B * overall_pick)


# Cache of per-slot historical player outcomes (from trade_value_model picks[].players[]).
_SLOT_HISTORIES: dict[str, list[float]] | None = None  # "2.10" -> [pts_3yr, ...]


def _load_slot_histories():
    global _SLOT_HISTORIES
    if _SLOT_HISTORIES is not None:
        return
    try:
        data = json.loads(TRADE_VALUE_MODEL.read_text())
    except Exception:
        _SLOT_HISTORIES = {}
        return
    out: dict[str, list[float]] = {}
    for p in data.get("picks", []):
        label = p.get("pick_label")
        if not label:
            continue
        pts_list = [pl.get("pts_3yr", 0) for pl in p.get("players", []) if pl.get("pts_3yr") is not None]
        if pts_list:
            out[label] = pts_list
    _SLOT_HISTORIES = out


def probability_match(slot_label: str, threshold_3yr_pts: float) -> float:
    """Fraction of historical picks at this slot that produced >= threshold pts over 3yr.

    Uses the ~14-player historical sample per slot from trade_value_model. Includes
    adjacent slots (+/-2) for a slightly bigger sample. Returns 0.0 if no data.
    """
    _load_slot_histories()
    if not _SLOT_HISTORIES:
        return 0.0
    try:
        rnd, slot = slot_label.split(".")
        rnd, slot = int(rnd), int(slot)
    except Exception:
        return 0.0
    nearby: list[float] = []
    for s in range(max(1, slot - 2), min(12, slot + 2) + 1):
        label = f"{rnd}.{s:02d}"
        nearby.extend(_SLOT_HISTORIES.get(label, []))
    if not nearby:
        return 0.0
    hits = sum(1 for v in nearby if v >= threshold_3yr_pts)
    return hits / len(nearby)


def pick_expected_points(
    year: int,
    round_: int,
    original_owner: str = "",
    slot: int | None = None,
    weeks_played: int = 0,
) -> float:
    """Expected 3-year fantasy points for a rookie drafted with this pick."""
    if round_ >= 4:
        return FALLBACK_DEEP_ROUND_PTS.get(round_, 5.0)
    if slot is None:
        slot = predict_future_slot(original_owner, weeks_played) if original_owner else 7
    slot = max(1, min(12, int(slot)))
    overall = (round_ - 1) * 12 + slot
    return _smoothed_points_r123(overall)


# ── Owner-based finish prediction ──────────────────────────────────────────

def _owner_historical_finish(franchise_id: str) -> float:
    _load()
    stats = _CAREER_CACHE.get(franchise_id, {})
    seasons = stats.get("seasons", []) or []
    tenure_start = OWNER_TENURE_START.get(franchise_id, 0)
    relevant = [s for s in seasons if s.get("season", 0) >= tenure_start and s.get("finish")]
    if not relevant:
        return DEFAULT_FINISH
    return sum(s["finish"] for s in relevant) / len(relevant)


def _current_team_finish_estimate(franchise_id: str, weeks_played: int) -> float:
    """Stub — returns owner historical for now. Wire in:
      - weeks_played==0 (post-auction): rank by sum(exp_price - salary) on roster
      - weeks_played>=1: use actual W/L record + points_for
    """
    return _owner_historical_finish(franchise_id)


def predict_finish(franchise_id: str, weeks_played: int = 0) -> float:
    w_owner = _owner_weight(weeks_played)
    owner = _owner_historical_finish(franchise_id)
    current = _current_team_finish_estimate(franchise_id, weeks_played)
    return w_owner * owner + (1 - w_owner) * current


def predict_future_slot(franchise_id: str, weeks_played: int = 0) -> int:
    finish = predict_finish(franchise_id, weeks_played)
    slot = round(13 - finish)
    return max(1, min(12, slot))


# ── Legacy dollar approximation (for grade-math compatibility) ─────────────

def pick_value(
    year: int,
    round_: int,
    original_owner: str = "",
    slot: int | None = None,
    current_year: int = 2026,
    weeks_played: int = 0,
) -> int:
    """Dollar approximation: smoothed expected points x $/point.

    Caveat: units are gross production-equivalent dollars (3yr cumulative points
    times single-year $/point rate). Treat as rough approximation for the
    current grade formula until the grade math is refactored to use points
    directly. See pick_expected_points() for the primary metric.
    """
    _load()
    pts = pick_expected_points(year, round_, original_owner, slot, weeks_played)
    if _DOLLARS_PER_POINT is None:
        return int(pts * 60)
    return int(pts * _DOLLARS_PER_POINT)


# ── CLI sanity check ───────────────────────────────────────────────────────
if __name__ == "__main__":
    _load()
    print(f"Fit curve: pts = {_CURVE_A:.1f} * exp(-{_CURVE_B:.4f} * overall_pick)")
    print(f"$/point: ${_DOLLARS_PER_POINT:.1f}")
    print()
    print(f"{'Slot':<6} {'Overall':<8} {'Exp Pts (3yr)':<15} {'AAV':<8} {'Salary (3yr)':<14}")
    print("-" * 60)
    for rnd in (1, 2, 3):
        for slot in range(1, 13):
            overall = (rnd - 1) * 12 + slot
            pts = _smoothed_points_r123(overall)
            aav = pick_rookie_salary_aav(rnd, slot)
            tcv = pick_rookie_salary_tcv(rnd, slot)
            print(f"{rnd}.{slot:02d}   {overall:<8} {pts:<15.1f} ${aav:<7,} ${tcv:<13,}")
        print()
    print("Owner-based predicted slots (2027 picks):")
    print(f"  {'FID':<5} {'Name':<22} {'AvgFin':<7} {'Slot':<5} {'R1 pts':<8} {'R2 pts':<8} {'R3 pts':<8}")
    for fid in sorted(_CAREER_CACHE.keys()):
        name = _CAREER_CACHE[fid].get("franchise_name", "?")[:21]
        f = _owner_historical_finish(fid)
        s = predict_future_slot(fid)
        p1 = pick_expected_points(2027, 1, original_owner=fid)
        p2 = pick_expected_points(2027, 2, original_owner=fid)
        p3 = pick_expected_points(2027, 3, original_owner=fid)
        print(f"  {fid:<5} {name:<22} {f:<7.1f} {s:<5} {p1:<8.0f} {p2:<8.0f} {p3:<8.0f}")
