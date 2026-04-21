"""
projection.py — Forward-looking PPG projection for the trade grader.

Signal hierarchy (derived from stickiness research — see yoy_signals.py):
  1. Weighted prior PPG (last 3 seasons, 50/30/20 recency) — strongest predictor (r=+0.66).
  2. Age x position multiplier — applies decline curves (RB cliff ~28, WR ~30, etc.).
  3. Internal ADP-velocity flag — detects breakout/crash candidates. Stored on the
     projection but not displayed (internal signal, not user-facing).

Public API:
    project_player_ppg(player_id, position, current_year, current_adp=None) -> dict
        Returns:
          {
            "projection_ppg": float | None,
            "components": {prior_ppg_weighted, age_multiplier, prior_adp, current_adp},
            "signals": {velocity, breakout_candidate, crash_candidate},
          }
"""

import sqlite3
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
YOY_DB = ETL_ROOT / "data" / "yoy_signals.db"

# Weights for last 3 seasons, recency-ordered. Renormalized when a season is missing.
RECENCY_WEIGHTS = (0.50, 0.30, 0.20)
GAMES_FULL_SEASON = 17
MIN_GAMES_RELIABLE = 4  # below this, the season is too noisy to weight

# Age x position multiplier curves.
# Based on empirical peak-age research + our 2017-2025 YoY decline pattern
# (RB 31+ showed r=+0.54 stickiness drop; crashes are heavily RB-biased age 28+).
AGE_CURVES = {
    # position: (peak_lo, peak_hi, decline_rate_per_year_past_peak, cliff_age, floor)
    "QB": (26, 35, 0.020, 40, 0.65),
    "RB": (24, 27, 0.070, 32, 0.50),
    "WR": (25, 29, 0.050, 34, 0.60),
    "TE": (26, 30, 0.050, 35, 0.60),
}

# ADP velocity thresholds (internal signal — not displayed)
VELOCITY_BREAKOUT_RISE = 50     # ADP improved by 50+ positions in a year
VELOCITY_CRASH_FALL = 40        # ADP fell by 40+ positions in a year


_DB: sqlite3.Connection | None = None


def _db():
    global _DB
    if _DB is None and YOY_DB.exists():
        _DB = sqlite3.connect(str(YOY_DB))
    return _DB


def _age_multiplier(position: str, age: int | None) -> float:
    """Position-specific age multiplier applied to the weighted prior PPG."""
    if age is None:
        return 1.0
    curve = AGE_CURVES.get(position)
    if not curve:
        return 1.0
    peak_lo, peak_hi, decline, cliff, floor = curve
    if age < peak_lo:
        years_below = peak_lo - age
        return min(1.10, 1.0 + 0.03 * years_below)  # modest young-player upside, capped
    if age <= peak_hi:
        return 1.0
    years_past = age - peak_hi
    if age >= cliff:
        return floor
    return max(floor, 1.0 - decline * years_past)


def _weighted_prior_ppg(player_id: str, current_year: int) -> tuple[float | None, list[tuple[int, float, int]]]:
    """Weighted average of last 3 seasons' PPG, with missing-year renormalization.

    Returns (weighted_ppg, components) where components is a list of
    (year, ppg, games_played) used in the calc (most recent first).
    """
    db = _db()
    if not db:
        return None, []
    components = []
    parts = []
    for i, recency_weight in enumerate(RECENCY_WEIGHTS):
        year = current_year - 1 - i
        row = db.execute(
            "SELECT ppg, games_played FROM yoy_player_signals WHERE player_id=? AND year=?",
            (str(player_id), year)
        ).fetchone()
        if not row or row[0] is None:
            continue
        ppg, gp = row
        if gp is None or gp < MIN_GAMES_RELIABLE:
            continue
        # Down-weight injury-shortened seasons
        game_fraction = min(gp / GAMES_FULL_SEASON, 1.0)
        final_weight = recency_weight * game_fraction
        components.append((year, float(ppg), int(gp)))
        parts.append((final_weight, float(ppg)))
    if not parts:
        return None, components
    total_w = sum(w for w, _ in parts)
    if total_w == 0:
        return None, components
    weighted = sum(w * v for w, v in parts) / total_w
    return weighted, components


def _prior_year_adp(player_id: str, current_year: int) -> float | None:
    db = _db()
    if not db:
        return None
    row = db.execute(
        "SELECT adp_avg_pick FROM yoy_player_signals WHERE player_id=? AND year=?",
        (str(player_id), current_year - 1)
    ).fetchone()
    return float(row[0]) if row and row[0] is not None else None


def _player_age(player_id: str, current_year: int) -> int | None:
    db = _db()
    if not db:
        return None
    row = db.execute("""
        SELECT age_at_season FROM yoy_player_signals
        WHERE player_id=? AND age_at_season IS NOT NULL
        ORDER BY year DESC LIMIT 1
    """, (str(player_id),)).fetchone()
    if not row or row[0] is None:
        return None
    latest_age = int(row[0])
    # Latest recorded age might be from an older season — adjust forward
    row2 = db.execute("""
        SELECT MAX(year) FROM yoy_player_signals WHERE player_id=? AND age_at_season IS NOT NULL
    """, (str(player_id),)).fetchone()
    if row2 and row2[0]:
        latest_age += max(0, current_year - int(row2[0]))
    return latest_age


def project_player_ppg(
    player_id: str,
    position: str,
    current_year: int = 2026,
    current_adp: float | None = None,
    fallback_ppg: float | None = None,
) -> dict:
    """Forward-looking PPG projection for a player in a given season.

    Returns dict with projection_ppg, a components breakdown, and internal
    signals (velocity flags — kept for internal use, not meant for display).
    """
    # 1. Weighted prior PPG
    prior_ppg, components = _weighted_prior_ppg(player_id, current_year)

    # 2. Age x position multiplier
    age = _player_age(player_id, current_year)
    age_mult = _age_multiplier(position, age)

    # If we have no prior data, fall back to the caller-supplied value (e.g., trade_value_model ppg).
    base = prior_ppg if prior_ppg is not None else fallback_ppg

    projection = base * age_mult if base is not None else None

    # 3. Internal ADP-velocity flags (not returned to display layer directly)
    prior_adp = _prior_year_adp(player_id, current_year)
    velocity = None
    breakout = False
    crash = False
    if prior_adp is not None and current_adp is not None:
        velocity = prior_adp - current_adp  # positive = rose up (improved)
        if velocity >= VELOCITY_BREAKOUT_RISE and prior_adp >= 60:
            breakout = True
        if velocity <= -VELOCITY_CRASH_FALL and prior_adp <= 36:
            crash = True

    return {
        "projection_ppg": projection,
        "components": {
            "weighted_prior_ppg": prior_ppg,
            "prior_components": components,
            "age": age,
            "age_multiplier": age_mult,
            "fallback_used": prior_ppg is None and fallback_ppg is not None,
        },
        "signals": {
            "adp_velocity": velocity,
            "breakout_candidate": breakout,
            "crash_candidate": crash,
            "prior_adp": prior_adp,
            "current_adp": current_adp,
        },
    }


# ── CLI sanity check ──────────────────────────────────────────────────────
if __name__ == "__main__":
    import json
    # Load trade_value_model players for id + fallback ppg lookup
    tvm_path = Path("/Users/keithcreelman/Documents/New project/site/trade-value/trade_value_model_2026.json")
    try:
        data = json.loads(tvm_path.read_text())
    except Exception:
        data = {"players": []}
    players = {p.get("player_name", ""): p for p in data.get("players", [])}

    samples = [
        ("Montgomery, David", "RB"),
        ("Allen, Josh", "QB"),
        ("Jefferson, Justin", "WR"),
        ("McCaffrey, Christian", "RB"),
        ("Ekeler, Austin", "RB"),
        ("Nacua, Puka", "WR"),
        ("Kelce, Travis", "TE"),
        ("McBride, Trey", "TE"),
        ("Brown, Chase", "RB"),
    ]
    print(f"{'Name':<25} {'Pos':<4} {'Age':<4} {'Model PPG':<10} {'Prior 3yr':<10} {'x Age':<8} {'Projection':<12} {'Flag':<12}")
    print("-" * 100)
    for name, pos in samples:
        p = next((v for k, v in players.items() if name in k), None)
        if not p:
            print(f"  {name}: not in model")
            continue
        pid = str(p.get("player_id"))
        model_ppg = float(p.get("ppg", 0) or 0)
        current_adp = float(p.get("redraft_adp_raw") or p.get("normalized_adp") or 0) or None
        res = project_player_ppg(pid, pos, current_year=2026,
                                 current_adp=current_adp, fallback_ppg=model_ppg)
        comp = res["components"]
        sig = res["signals"]
        flag = ""
        if sig["breakout_candidate"]: flag = "BREAKOUT"
        elif sig["crash_candidate"]: flag = "CRASH"
        age_s = comp["age"] if comp["age"] else "-"
        prior_s = f"{comp['weighted_prior_ppg']:.1f}" if comp["weighted_prior_ppg"] else "-"
        proj_s = f"{res['projection_ppg']:.1f}" if res["projection_ppg"] else "-"
        print(f"{name:<25} {pos:<4} {str(age_s):<4} {model_ppg:<10.1f} {prior_s:<10} "
              f"{comp['age_multiplier']:<8.2f} {proj_s:<12} {flag:<12}")
