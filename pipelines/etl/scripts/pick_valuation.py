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

Future picks (Keith 2026-10-20, #1343 decision 2) are valued over BRACKET
ODDS, not one predicted slot. The draft order follows the prior season's
brackets (canon §A1). project_future_pick() estimates the chance the pick's
ORIGINAL franchise makes the championship bracket: its current owner's playoff
history (canon §D.2 tenure) pulled toward 50%, blended in season with that
season's All-Play % and points for. Every slot inside a bracket is equally
likely. Inputs it cannot trust are named in .issues and the grade is
provisional; nothing falls back silently to a fixed slot.

Public API:
    pick_expected_points(year, round_, slot=...) -> float     # a known slot
    expected_points_over(dist, round_) -> float               # a slot distribution
    pick_rookie_salary_aav(round_, slot) -> int
    pick_rookie_salary_tcv(round_, slot, years=3) -> int
    rookie_contract_terms(round_, slot) -> dict   # display + cap checks, never the grade
    pick_value(...) -> int   # legacy dollar approximation (points x $/point)
    slot_for_finish(finish) -> int
    project_future_pick(original_fid, pick_year, round_, season_state) -> FuturePickProjection
    describe_pick_odds(projection) -> str          # owner-facing wording
    inseason_playoff_probability(owner_rate, fid, allplay_pct, points_for, week) -> float
"""

import json
import math
import re
import statistics
from dataclasses import dataclass, field
from pathlib import Path

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
TRADE_VALUE_MODEL = Path(
    "/Users/keithcreelman/Documents/New project/site/trade-value/trade_value_model_2026.json"
)
CAREER_STATS = ETL_ROOT / "data" / "franchise_career_stats.json"
INSEASON_COEFFICIENTS = ETL_ROOT / "config" / "future_pick_inseason_coefficients.json"

# ── Draft order (canon docs/league_context_v1.md §A1) ──────────────────────
# Rounds 1-5 follow the prior season's brackets, NOT inverse finish. The
# championship bracket (final finish 1-6) picks 7-12; the Hawk Tuah bracket
# (finish 7-12) picks 1-6, and its winner, the 7th-place team, picks FIRST.
# 5 and 6 are decided by a week-16 game: the winner (finish 5) picks 1.07.
# The same order runs every round (no snake). Verified 2026-10-20 on 884 traced
# picks, 2012-2026: 98.9% match when finishes come from the bracket games
# (#1343; three stored final finishes are wrong, the draft followed the games).
SLOT_BY_FINISH = {1: 12, 2: 11, 3: 10, 4: 9, 5: 7, 6: 8,
                  7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6}
TOILET_SLOTS = (1, 2, 3, 4, 5, 6)        # Hawk Tuah bracket, finish 7-12
PLAYOFF_SLOTS = (7, 8, 9, 10, 11, 12)    # championship bracket, finish 1-6

# Owner history predicts the bracket, not the finish inside it: the owner's
# playoff rate is pulled toward 50% by k pseudo-seasons, k = 4 for the season
# being played (or next to be played) and k = 6 two or more seasons out, and
# every slot inside a bracket is equally likely. Backtest:
# pipelines/etl/scripts/backtest_pick_slot_model.py.
PRIOR_SEASONS_NEXT = 4
PRIOR_SEASONS_LATER = 6

# Owner-facing labels for the more likely bracket (Keith 2026-10-20).
LIKELY_AT = 0.80
LEANS_AT = 0.60

# Canon §D.2: a season belongs to the owner who ran that year's auction. The
# career file must agree before its owner history is used:
# (franchise, season, auction-of-record owner).
KNOWN_OWNERSHIP_CORRECTIONS = (
    ("0002", 2017, "Derrick Whitman"),
    ("0002", 2022, "AJ Balderelli"),
    ("0005", 2022, "Rico Balderelli"),
    ("0006", 2024, "Josh Lima"),
)

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

    A known slot is valued at that slot. Without a slot this returns the
    league-average (uniform 1.01-1.12) value; future picks go through
    project_future_pick() and expected_points_over() instead.
    """
    if round_ >= 4:
        return FALLBACK_DEEP_ROUND_PTS.get(round_, 5.0)
    if slot is None:
        return expected_points_over(bracket_distribution(0.5), round_)
    slot = max(1, min(12, int(slot)))
    overall = (round_ - 1) * 12 + slot
    return _smoothed_points_r123(overall)


def expected_points_over(dist: dict, round_: int) -> float:
    """Football value of a pick whose slot is uncertain: sum of P(slot) x value(slot)."""
    if round_ >= 4:
        return FALLBACK_DEEP_ROUND_PTS.get(round_, 5.0)
    return sum(p * _smoothed_points_r123((round_ - 1) * 12 + s) for s, p in dist.items())


# ── Future picks: bracket odds ─────────────────────────────────────────────

def slot_for_finish(finish: int) -> int:
    """Rounds 1-5 draft slot earned by a final finish (canon §A1)."""
    return SLOT_BY_FINISH[int(finish)]


def bracket_distribution(p_playoff: float) -> dict[int, float]:
    """{slot: probability}: p_playoff spread evenly over 7-12, the rest over 1-6."""
    dist = {s: (1 - p_playoff) / len(TOILET_SLOTS) for s in TOILET_SLOTS}
    dist.update({s: p_playoff / len(PLAYOFF_SLOTS) for s in PLAYOFF_SLOTS})
    return dist


@dataclass
class SeasonState:
    """The current season's standings as of the trade, never later.

    status: "offseason" (no games yet), "in_season", or "unavailable" (reason says why).
    allplay_pct / points_for are keyed by franchise id for all twelve teams.
    """
    season: int
    status: str
    weeks_completed: int = 0
    allplay_pct: dict = field(default_factory=dict)
    points_for: dict = field(default_factory=dict)
    as_of: str = ""
    reason: str = ""


@dataclass
class FuturePickProjection:
    original_fid: str
    pick_year: int | None
    round: int
    basis: str = "league_average"      # "set" | "offseason" | "in_season" | "league_average"
    deciding_season: int | None = None
    seasons_ahead: int | None = None    # 0 = the season being played, or next to be played
    prior_seasons: int | None = None    # k
    owner_playoff_rate: float | None = None
    p_playoff: float = 0.5
    weeks_completed: int = 0
    slot: int | None = None             # only when the deciding season is complete
    finish: int | None = None
    dist: dict = field(default_factory=dict)
    issues: list = field(default_factory=list)

    @property
    def average_slot(self) -> float:
        return sum(s * p for s, p in self.dist.items())

    @property
    def provisional(self) -> bool:
        return bool(self.issues)


def _current_season() -> tuple[int | None, str]:
    """The season being played or next to be played, from the career file."""
    _load()
    years = {int(v["current_year"]) for v in _CAREER_CACHE.values()
             if isinstance(v, dict) and str(v.get("current_year") or "").isdigit()}
    if len(years) != 1:
        return None, "career file has no single current_year"
    return years.pop(), ""


def ownership_history_issues(franchise_id: str) -> list[str]:
    """Problems with the current owner's playoff record in the career file.

    Checks the owner block exists and that its tenure agrees with every canon
    §D.2 correction it touches (a season counted for a replacement owner, or
    an auction-of-record season left out).
    """
    _load()
    owner = (_CAREER_CACHE.get(franchise_id) or {}).get("owner")
    if not isinstance(owner, dict):
        return [f"no owner history for {franchise_id} in franchise_career_stats.json"]
    try:
        seasons = int(owner["seasons_count"])
        made = int(owner["playoff_appearances"])
    except (KeyError, TypeError, ValueError):
        return [f"owner history for {franchise_id} lacks seasons_count / playoff_appearances"]
    if seasons < 0 or not 0 <= made <= seasons:
        return [f"owner history for {franchise_id} is inconsistent ({made} playoffs in {seasons} seasons)"]
    tenure = owner.get("seasons_by_franchise")
    if not isinstance(tenure, dict):
        return [f"owner history for {franchise_id} has no seasons_by_franchise to check against canon §D.2"]
    issues = []
    name = owner.get("display", "")
    for fid, season, record_owner in KNOWN_OWNERSHIP_CORRECTIONS:
        counted = season in (tenure.get(fid) or [])
        if name == record_owner and not counted:
            issues.append(f"owner history for {franchise_id} leaves out {season} ({fid}), "
                          f"which canon §D.2 credits to {record_owner}")
        elif name != record_owner and counted:
            issues.append(f"owner history for {franchise_id} counts {season} ({fid}) for {name}; "
                          f"canon §D.2 credits it to {record_owner}")
    return issues


def owner_playoff_rate(franchise_id: str, k: int) -> tuple[float | None, list[str]]:
    """Current owner's championship-bracket rate, pulled toward 50% by k seasons."""
    issues = ownership_history_issues(franchise_id)
    if issues:
        return None, issues
    owner = _CAREER_CACHE[franchise_id]["owner"]
    seasons, made = int(owner["seasons_count"]), int(owner["playoff_appearances"])
    return (made + k / 2) / (seasons + k), []


def _season_finish(franchise_id: str, season: int) -> int | None:
    _load()
    for row in (_CAREER_CACHE.get(franchise_id) or {}).get("trend") or []:
        if row.get("season") == season and row.get("finish"):
            return int(row["finish"])
    return None


_COEFFICIENTS: dict | None = None


def _inseason_coefficients() -> dict:
    global _COEFFICIENTS
    if _COEFFICIENTS is None:
        try:
            _COEFFICIENTS = json.loads(INSEASON_COEFFICIENTS.read_text())
        except Exception:
            _COEFFICIENTS = {}
    return _COEFFICIENTS


def _logit(p: float) -> float:
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def _zscores(values: dict) -> dict:
    vals = list(values.values())
    mean = statistics.mean(vals)
    sd = statistics.pstdev(vals) or 1.0
    return {k: (v - mean) / sd for k, v in values.items()}


def inseason_playoff_probability(owner_rate: float, franchise_id: str, allplay_pct: dict,
                                 points_for: dict, week: int) -> float:
    """Bracket odds after `week` completed weeks: owner history blended with
    that season's All-Play % and points for (z-scored across the league), using
    the logistic coefficients fitted for that week on earlier seasons only."""
    table = (_inseason_coefficients().get("weeks") or {})
    if not table:
        raise LookupError("in-season coefficients missing")
    w = min(int(week), max(int(k) for k in table))
    b0, b_prior, b_ap, b_pf = table[str(w)]
    z_ap, z_pf = _zscores(allplay_pct)[franchise_id], _zscores(points_for)[franchise_id]
    x = b0 + b_prior * _logit(owner_rate) + b_ap * z_ap + b_pf * z_pf
    return 1 / (1 + math.exp(-max(-35.0, min(35.0, x))))


def project_future_pick(original_fid, pick_year, round_: int,
                        season_state: SeasonState | None = None) -> FuturePickProjection:
    """Bracket odds for a future pick, decided by its ORIGINAL franchise's finish.

    Any input it cannot trust goes into .issues (the grade is then provisional)
    and the pick is valued at league-average odds; it never falls back silently.
    """
    fid = str(original_fid or "").strip()
    proj = FuturePickProjection(original_fid=fid, pick_year=None, round=int(round_))
    _load()
    if not re.fullmatch(r"\d{4}", fid) or fid not in _CAREER_CACHE:
        proj.issues.append(f"original franchise {fid or '(blank)'} is not in franchise_career_stats.json")
    current, why = _current_season()
    if current is None:
        proj.issues.append(why)
    try:
        proj.pick_year = int(pick_year)
    except (TypeError, ValueError):
        proj.issues.append(f"pick year {pick_year!r} is unreadable")
    if proj.pick_year is not None and current is not None and not (2012 <= proj.pick_year <= current + 6):
        proj.issues.append(f"pick year {proj.pick_year} is out of range")
    if proj.issues:
        proj.dist = bracket_distribution(0.5)
        return proj

    proj.deciding_season = proj.pick_year - 1
    proj.seasons_ahead = proj.deciding_season - current
    if proj.seasons_ahead < 0:
        # The deciding season is over: the slot is set by its final finish.
        finish = _season_finish(fid, proj.deciding_season)
        if finish is None:
            proj.issues.append(f"final finish of {fid} in {proj.deciding_season} is not in the career file")
            proj.dist = bracket_distribution(0.5)
            return proj
        proj.basis, proj.finish, proj.slot = "set", finish, slot_for_finish(finish)
        proj.p_playoff = 1.0 if finish <= 6 else 0.0
        proj.dist = {proj.slot: 1.0}
        return proj

    k = PRIOR_SEASONS_NEXT if proj.seasons_ahead == 0 else PRIOR_SEASONS_LATER
    proj.prior_seasons = k
    rate, issues = owner_playoff_rate(fid, k)
    proj.issues.extend(issues)
    proj.owner_playoff_rate = rate
    p = rate if rate is not None else 0.5
    proj.basis = "offseason" if rate is not None else "league_average"

    if proj.seasons_ahead == 0:
        st = season_state
        if st is None:
            proj.issues.append(f"{current} standings were not provided, so in-season form is unknown")
        elif st.status == "unavailable":
            proj.issues.append(st.reason or f"{current} standings are unavailable")
        elif st.season != current:
            proj.issues.append(f"standings are for {st.season}, but this pick is decided by {current}")
        elif st.status == "in_season" and st.weeks_completed >= 1:
            missing = [f for f in (set(_CAREER_CACHE) | {fid})
                       if f not in st.allplay_pct or f not in st.points_for]
            if missing:
                proj.issues.append(f"{current} standings lack {', '.join(sorted(missing))}")
            else:
                try:
                    p = inseason_playoff_probability(rate if rate is not None else 0.5, fid,
                                                     st.allplay_pct, st.points_for, st.weeks_completed)
                    proj.basis = "in_season"
                    proj.weeks_completed = st.weeks_completed
                except LookupError as exc:
                    proj.issues.append(f"in-season model unavailable ({exc})")
    proj.p_playoff = p
    proj.dist = bracket_distribution(p)
    return proj


def describe_pick_odds(proj: FuturePickProjection) -> str:
    """Owner-facing wording: bracket odds and both ranges, never a predicted slot."""
    r = proj.round
    low, high = f"{r}.01-{r}.06", f"{r}.07-{r}.12"
    if proj.basis == "set":
        return (f"slot set: {r}.{proj.slot:02d} (original franchise finished "
                f"{proj.finish} in {proj.deciding_season})")
    p_po = proj.p_playoff
    p_ht = 1 - p_po
    lead = max(p_ht, p_po)
    lead_pct = math.floor(lead * 100 + 1e-9)
    if p_ht >= p_po:
        ht_pct, po_pct, side = lead_pct, 100 - lead_pct, "Hawk Tuah side"
    else:
        ht_pct, po_pct, side = 100 - lead_pct, lead_pct, "playoff side"
    if lead >= LIKELY_AT:
        head = f"likely {side}"
    elif lead >= LEANS_AT:
        head = f"leans {side}"
    else:
        head = "toss-up"
    text = (f"{head}: {ht_pct}% Hawk Tuah side ({low}), {po_pct}% playoff side ({high}); "
            f"average slot {proj.average_slot:.1f} of 12 (an average of the odds, not a predicted finish)")
    if proj.basis == "in_season":
        text += (f". Owner history blended with {proj.deciding_season} All-Play % and points "
                 f"through week {proj.weeks_completed}")
    elif proj.basis == "offseason":
        text += ". Offseason: owner playoff history only, which is a weak signal"
    else:
        text += ". League-average odds"
    if proj.issues:
        text = "PROVISIONAL (" + "; ".join(proj.issues) + "): " + text
    return text


# ── Legacy dollar approximation (for grade-math compatibility) ─────────────

def pick_value(
    year: int,
    round_: int,
    original_owner: str = "",
    slot: int | None = None,
    current_year: int = 2026,
    weeks_played: int = 0,
) -> int:
    """Dollar approximation: expected points x $/point (gross, display only)."""
    _load()
    pts = pick_expected_points(year, round_, original_owner, slot, weeks_played)
    return int(pts * (_DOLLARS_PER_POINT or 60.0))


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
    current, _ = _current_season()
    print(f"Next-season firsts (decided by {current}), offseason odds:")
    for fid in sorted(_CAREER_CACHE.keys()):
        proj = project_future_pick(fid, (current or 0) + 1, 1, SeasonState(current or 0, "offseason"))
        print(f"  {fid}: {expected_points_over(proj.dist, 1):6.0f} pts | {describe_pick_odds(proj)}")
