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

Future picks are valued over a DISTRIBUTION of slots, not one predicted slot.
The draft order follows the prior season's brackets (canon §A1), so the owner's
history predicts which bracket the team lands in, and the slot is uniform
inside that bracket. See future_slot_distribution().

Public API:
    pick_expected_points(year, round_, original_owner="", slot=None, ...) -> float
    pick_rookie_salary_aav(round_, slot) -> int
    pick_rookie_salary_tcv(round_, slot, years=3) -> int
    rookie_contract_terms(round_, slot) -> dict   # display + cap checks, never the grade
    pick_value(...) -> int   # legacy dollar approximation (points x $/point)
    slot_for_finish(finish) -> int
    playoff_probability(franchise_id) -> float
    future_slot_distribution(franchise_id, weeks_played=0) -> {slot: probability}
    predict_future_slot(franchise_id, weeks_played=0) -> int   # display label only
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

# ── Draft order (canon docs/league_context_v1.md §A1) ──────────────────────
# Rounds 1-5 follow the prior season's brackets, NOT inverse finish. The
# championship bracket (final finish 1-6) picks 7-12; the Hawk Tuah bracket
# (finish 7-12) picks 1-6, and its winner, the 7th-place team, picks FIRST.
# 5 and 6 are decided by a week-16 game: the winner (finish 5) picks 1.07.
# Proven on 281 recorded picks, 2012-2025 (draft PR #1331's evidence fixture).
SLOT_BY_FINISH = {1: 12, 2: 11, 3: 10, 4: 9, 5: 7, 6: 8,
                  7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6}
TOILET_SLOTS = (1, 2, 3, 4, 5, 6)        # Hawk Tuah bracket, finish 7-12
PLAYOFF_SLOTS = (7, 8, 9, 10, 11, 12)    # championship bracket, finish 1-6

# Owner history predicts the bracket but not the finish inside it, so the
# owner's playoff rate is shrunk toward 50% by this many pseudo-seasons and the
# slot is uniform within each bracket. 4 was within 0.01 of the lowest error
# when predicting every 2013-2025 pick from the seasons before it
# (pipelines/etl/scripts/backtest_pick_slot_model.py).
PLAYOFF_PRIOR_SEASONS = 4

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


# Canon §A1: a 1st-round rookie's 4th-year team option costs the original
# Year 3 salary + $5,000. Rookie salaries are flat (Y1 = Y2 = Y3 = AAV).
ROOKIE_OPTION_RAISE = 5000


def rookie_contract_terms(round_: int, slot: int) -> dict:
    """The rookie contract a pick at this slot carries.

    For display and cap-feasibility checks only: the trade grade values every
    pick on football value and never subtracts this salary (Keith 2026-10-20,
    #1343 decision 1). option_salary is R1 only and is not guaranteed.
    """
    aav = pick_rookie_salary_aav(round_, slot)
    terms = {"round": round_, "slot": slot, "aav": aav,
             "years": ROOKIE_CONTRACT_YEARS, "tcv": aav * ROOKIE_CONTRACT_YEARS}
    if round_ == 1:
        terms["option_salary"] = aav + ROOKIE_OPTION_RAISE
    return terms


# ── Fallbacks ──────────────────────────────────────────────────────────────
FALLBACK_DEEP_ROUND_PTS = {4: 60.0, 5: 30.0, 6: 15.0}

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
    """Expected 3-year fantasy points for a rookie drafted with this pick.

    A known slot (a current-year pick) is valued at that slot. A future pick is
    the probability-weighted average over its slot distribution, not the value
    at one predicted slot.
    """
    if round_ >= 4:
        return FALLBACK_DEEP_ROUND_PTS.get(round_, 5.0)
    if slot is None:
        dist = future_slot_distribution(original_owner, weeks_played)
        return sum(p * _smoothed_points_r123((round_ - 1) * 12 + s) for s, p in dist.items())
    slot = max(1, min(12, int(slot)))
    overall = (round_ - 1) * 12 + slot
    return _smoothed_points_r123(overall)


# ── Future-pick slot distribution ──────────────────────────────────────────

def slot_for_finish(finish: int) -> int:
    """Rounds 1-5 draft slot earned by a final finish (canon §A1)."""
    return SLOT_BY_FINISH[int(finish)]


def playoff_probability(franchise_id: str) -> float:
    """Chance the franchise's CURRENT OWNER makes the championship bracket.

    From the owner block of franchise_career_stats.json (owner.playoff_appearances
    over owner.seasons_count: actual seeding across every franchise and season of
    the owner's tenure), shrunk toward 50% by PLAYOFF_PRIOR_SEASONS. An owner with
    no record gets 50%, the league average.
    """
    _load()
    owner = (_CAREER_CACHE.get(franchise_id) or {}).get("owner") or {}
    seasons = int(owner.get("seasons_count") or 0)
    made = int(owner.get("playoff_appearances") or 0)
    k = PLAYOFF_PRIOR_SEASONS
    return (made + k / 2) / (seasons + k)


def future_slot_distribution(franchise_id: str, weeks_played: int = 0) -> dict[int, float]:
    """{slot: probability} for a future pick originally owned by franchise_id.

    Bracket first: P(championship bracket) = playoff_probability(), spread evenly
    over 1.07-1.12; the rest is spread evenly over the Hawk Tuah slots 1.01-1.06.
    weeks_played is accepted for callers but not used: current-season standings
    are not wired in yet, so an in-season trade still uses owner history only.
    """
    p = playoff_probability(franchise_id) if franchise_id else 0.5
    dist = {s: (1 - p) / len(TOILET_SLOTS) for s in TOILET_SLOTS}
    dist.update({s: p / len(PLAYOFF_SLOTS) for s in PLAYOFF_SLOTS})
    return dist


def predict_future_slot(franchise_id: str, weeks_played: int = 0) -> int:
    """The expected slot, rounded: the '~1.05' label shown for a future pick.

    Display only. Values come from the whole distribution, because a pick that
    is either 1.02 or 1.10 is not worth the same as a sure 1.06.
    """
    dist = future_slot_distribution(franchise_id, weeks_played)
    return max(1, min(12, round(sum(s * p for s, p in dist.items()))))


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
    print("Future picks by original owner (2027 picks):")
    print(f"  {'FID':<5} {'Name':<22} {'P(po)':<6} {'~Slot':<6} {'R1 pts':<8} {'R2 pts':<8} {'R3 pts':<8} {'R1 AAV':<8}")
    for fid in sorted(_CAREER_CACHE.keys()):
        name = _CAREER_CACHE[fid].get("franchise_name", "?")[:21]
        p = playoff_probability(fid)
        s = predict_future_slot(fid)
        p1 = pick_expected_points(2027, 1, original_owner=fid)
        p2 = pick_expected_points(2027, 2, original_owner=fid)
        p3 = pick_expected_points(2027, 3, original_owner=fid)
        aav = expected_rookie_salary_aav(1, fid)
        print(f"  {fid:<5} {name:<22} {p:<6.2f} {s:<6} {p1:<8.0f} {p2:<8.0f} {p3:<8.0f} ${aav:<7,}")
