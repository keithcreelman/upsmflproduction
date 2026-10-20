"""
trade_grader.py — UPS Trade Intelligence Report Generator

Analyzes MFL trades using league intelligence data (Exp$, Expected PPG,
contracts, cap situations) and generates Discord-ready roast reports.

Usage:
    python trade_grader.py                          # Grade most recent trade
    python trade_grader.py --timestamp 1775772921   # Grade specific trade
    python trade_grader.py --list                   # List recent trades
"""

import argparse
import bisect
import csv
import json
import os
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.request import urlopen
from urllib.error import HTTPError

from pick_valuation import (
    pick_value as _pick_value,
    pick_expected_points as _pick_points,
    pick_rookie_salary_aav as _rookie_aav,
    rookie_contract_terms as _rookie_contract_terms,
    project_future_pick as _project_future_pick,
    expected_points_over as _points_over,
    describe_pick_odds as _describe_pick_odds,
    SeasonState,
    dollars_per_point as _dpp,
    ValuationUnavailable,
)
import valuation_snapshot as _vs

GAMES_PER_SEASON = 17


def _safe_int(v) -> int:
    """MFL salary fields arrive as '', None, '12345', 12345, or '12345.0' —
    a bare int() crashes on half of those (prod hand-fix 2026-06, now on main)."""
    try:
        return int(float(v)) if v not in (None, "") else 0
    except (ValueError, TypeError):
        return 0
# Simple year-over-year production decay (Y1, Y2, Y3+).
# Conservative: veterans hold PPG ~stably for 2 years, fade after.
PLAYER_DECAY = [1.00, 0.95, 0.88, 0.80]

# Defensive (IDP) positions — see _player_production_pts FIX C (Keith 2026-07-18).
# One canonical set shared by the grade-math neutralization and any future IDP
# valuation model.
IDP_POSITIONS = {"DT", "DE", "DL", "EDGE", "NT", "LB", "ILB", "OLB", "MLB",
                 "CB", "S", "SS", "FS", "DB", "IDP"}


def _parse_contract(ci: str, contract_year: int, current_salary: int) -> tuple[int, list[int]]:
    """Return (years_remaining, remaining_salaries) from an MFL contractInfo string.

    - years_remaining: from contractYear field (MFL: 1 = final year, N = N years remaining).
      Falls back to CL if contractYear is 0.
    - remaining_salaries: year-by-year salaries for the remaining contract years.
      If the contract info has "Y1-X, Y2-Y", we slice the last N entries.
      Otherwise we fall back to [current_salary] * years_remaining.
    """
    import re
    cl_match = re.search(r"CL\s*(\d+)", ci or "")
    cl = int(cl_match.group(1)) if cl_match else max(1, contract_year)

    years_remaining = contract_year if contract_year and contract_year > 0 else cl
    years_remaining = max(1, min(years_remaining, cl if cl else years_remaining))

    # Extract Y1-X, Y2-Y, ... values
    yr_pairs = re.findall(r"Y(\d+)\s*-\s*([\d.]+)\s*([KkMm]?)", ci or "")
    # FIX B (Keith 2026-07-18) — $K SHORTHAND. UPS contractInfo often stamps the
    # 'K' only on the TCV/AAV tokens and writes the per-year figures bare:
    #   "CL 3| TCV 24K| AAV 5K| Y1-5, Y2-5, Y3-14"  → the years are 5K, 5K, 14K.
    # The old parser read bare "14" as $14, silently dropping Isaiah Bond's $14K
    # 2027 escalator (his 2yr remaining commitment collapsed from $19,000 to $19)
    # and zeroing a real liability in the grade math. When the line is
    # K-denominated (a 'K' appears anywhere), treat any UNIT-LESS per-year value
    # below $1,000 as thousands-shorthand and scale it up. Values that carry an
    # explicit K/M, or are already >= $1,000, are left untouched (no double-scale).
    k_shorthand = "k" in (ci or "").lower()
    per_year: dict[int, int] = {}
    for yr_str, val_str, unit in yr_pairs:
        yr = int(yr_str)
        val = float(val_str)
        if unit.lower() == "k":
            val *= 1000
        elif unit.lower() == "m":
            val *= 1_000_000
        elif k_shorthand and val < 1000:
            val *= 1000
        per_year[yr] = int(val)

    if per_year and cl:
        # Slice last `years_remaining` entries (years cl - years_remaining + 1 .. cl)
        start_yr = cl - years_remaining + 1
        remaining = [per_year.get(y, current_salary) for y in range(start_yr, cl + 1)]
    else:
        remaining = [current_salary] * years_remaining

    return years_remaining, remaining


def _player_production_pts(player: "PlayerInfo") -> tuple[float, int]:
    """Expected multi-year fantasy production + remaining salary dollars.

    Production uses ppg x 17 with a conservative decay across remaining years.
    Salary is the sum of remaining year salaries (parsed from contract_info).
    """
    # FIX C — IDP NET-NEUTRAL (Keith 2026-07-18). Defensive players carry a
    # salary but ~no offense-scale PPG, so the old math booked their salary as a
    # pure COST on the acquirer with zero production credit — dragging the grade
    # of whoever took on a defensive piece (Jordan Battle, S, is exactly what
    # dragged The Long Haulers to a phantom D+ blowout). Until a real IDP
    # production model exists, value every IDP at (0 production, 0 salary): they
    # contribute NOTHING to received_pts OR given_pts — no cost drag, and no
    # cap-relief credit either. IDPs are STILL listed in the roast context/
    # display; only the GRADE MATH neutralizes them.
    # TODO: full IDP production valuation deferred — for now, unless a superstar
    # IDP is involved, it's mostly ho-hum.
    if (player.position or "").upper() in IDP_POSITIONS:
        return 0.0, 0
    ppg = player.expected_ppg or 0
    years_remaining, remaining_salaries = _parse_contract(
        player.contract_info, player.contract_year, player.salary
    )
    prod = 0.0
    for i in range(years_remaining):
        decay = PLAYER_DECAY[i] if i < len(PLAYER_DECAY) else PLAYER_DECAY[-1]
        prod += ppg * GAMES_PER_SEASON * decay
    salary_remaining = sum(remaining_salaries)
    return prod, salary_remaining


def pick_label(pk: "PickInfo") -> str:
    """'2026 1.10' for a known slot; '2027 round 1' for a future pick (its odds
    are shown separately: never a predicted slot)."""
    if pk.slot_is_projected or not pk.predicted_slot:
        return f"{pk.year} round {pk.round}"
    return f"{pk.year} {pk.round}.{pk.predicted_slot:02d}"


def rookie_contract_line(pk: "PickInfo") -> str:
    """The R1 rookie contract a pick carries, as one display line ("" for R2+).

    Shown next to the pick, never subtracted from the grade (Keith 2026-10-20,
    #1343 decision 1): every round is graded on football value, as R2-R6
    already were. The salary still drives cap-feasibility (trade_announcement's
    net salary change). A future pick's slot is projected, so its contract is
    shown at that slot alongside the full 1.01-1.12 range.
    """
    if pk.round != 1 or not pk.predicted_slot:
        return ""
    t = _rookie_contract_terms(1, pk.predicted_slot)
    option = (f"4th-year option ${t['option_salary']:,} (Year 3 ${t['aav']:,} + $5,000), "
              f"not guaranteed")
    if pk.slot_is_projected:
        top, bottom = _rookie_contract_terms(1, 1), _rookie_contract_terms(1, 12)
        return (f"Rookie contract (not in the grade): set by draft slot, "
                f"${bottom['tcv']:,} at 1.12 to ${top['tcv']:,} at 1.01 over {t['years']} years "
                f"(${t['aav']:,}/yr x {t['years']} = ${t['tcv']:,} near the average slot, "
                f"not a predicted finish); 4th-year option = Year 3 + $5,000 "
                f"(${bottom['option_salary']:,} to ${top['option_salary']:,}), not guaranteed")
    return (f"Rookie contract (not in the grade): 1.{pk.predicted_slot:02d} "
            f"${t['aav']:,}/yr x {t['years']} = ${t['tcv']:,}; {option}")


def _salary_to_pts(dollars: float) -> float:
    """Convert dollars to points-equivalent via the snapshot's $/point rate
    (raises ValuationUnavailable if no snapshot is loaded; no default)."""
    return dollars / _dpp()


def _compute_side_value_pts(side: "TradeSide") -> dict:
    """Symmetric points-based value for one side of a trade.

    Value received:
      - Expected production from acquired players (1 season)
      - Expected 3yr points from acquired picks
      - Cap relief from giving away player salaries (in point-equiv)
      - Budget bucks received (in point-equiv)

    Value given up:
      - Production lost from given players (1 season)
      - Expected 3yr points from given picks
      - Salary commitment on acquired players (in point-equiv)
      - Budget bucks given (in point-equiv)

    Picks of every round count on football value only: a rookie contract is
    shown beside the pick (rookie_contract_line) but never charged here, so an
    earlier pick is always worth more and a trade is exactly zero-sum:
    side_a.net == -side_b.net.
    """
    # Players: multi-year production + multi-year remaining salary
    def _player_parts(players):
        prod_total = 0.0
        salary_total = 0
        for p in players:
            prod, sal = _player_production_pts(p)
            prod_total += prod
            salary_total += sal
        return prod_total, salary_total

    prod_received, salary_recv_from_acquired = _player_parts(side.players_received)
    prod_lost, salary_freed_from_given = _player_parts(side.players_given)

    received_pts = (
        prod_received
        + sum(pk.expected_points for pk in side.picks_received)
        + _salary_to_pts(salary_freed_from_given)     # cap relief
        + _salary_to_pts(side.salary_received)         # BB received
    )
    given_pts = (
        prod_lost
        + sum(pk.expected_points for pk in side.picks_given)
        + _salary_to_pts(salary_recv_from_acquired)    # salary committed on acquired players
        + _salary_to_pts(side.salary_given)            # BB given
    )
    return {
        "received_pts": received_pts,
        "given_pts": given_pts,
        "net_pts": received_pts - given_pts,
        "prod_received": prod_received,
        "prod_lost": prod_lost,
        "salary_freed": salary_freed_from_given,
        "salary_committed": salary_recv_from_acquired,
    }

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
CONFIG_DIR = ETL_ROOT / "config"
# Decision 3 (#1343): the early-projection CSVs, the iCloud trade-value model
# and projection.py's yoy_signals.db overlay are retired. Every grade-affecting
# valuation comes from valuation_snapshot (data/valuation/).

# ── MFL API ────────────────────────────────────────────────────────────────
LEAGUE_ID = "74598"
MFL_BASE = "https://www48.myfantasyleague.com/2026/export"
LEAGUE_SEASON = int(MFL_BASE.rstrip("/").split("/")[-2])


def mfl_fetch(export_type: str, **params) -> dict:
    params["TYPE"] = export_type
    params["L"] = LEAGUE_ID
    params["JSON"] = "1"
    qs = "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{MFL_BASE}?{qs}"
    with urlopen(url, timeout=20) as resp:
        return json.loads(resp.read())


# ── Data Classes ───────────────────────────────────────────────────────────
@dataclass
class PlayerInfo:
    player_id: str
    name: str
    position: str
    team: str
    salary: int = 0
    contract_info: str = ""
    contract_status: str = ""
    contract_year: int = 0
    # From the valuation snapshot (decision 3); nothing else sets these.
    expected_ppg: float = 0.0
    ppg_basis: str = ""            # the snapshot's basis text for expected_ppg
    franchise_id: str = ""
    franchise_name: str = ""
    projected_ppg: float = 0.0
    projection_age: Optional[int] = None
    projection_age_mult: float = 1.0


@dataclass
class PickInfo:
    year: int
    round: int
    original_owner: str  # franchise_id
    original_owner_name: str = ""
    estimated_value: float = 0.0
    expected_points: float = 0.0  # 3yr rookie production expectation
    predicted_slot: int = 0        # slot used for valuation (1-12)
    rookie_aav: int = 0            # per-year rookie salary if drafted (cap checks + display only)
    slot_is_projected: bool = False  # future pick: predicted_slot is the rounded average slot
    projection: object = None      # pick_valuation.FuturePickProjection for future picks

    @property
    def odds_text(self) -> str:
        """Owner-facing bracket odds ("" for a pick whose slot is known)."""
        return _describe_pick_odds(self.projection) if self.projection is not None else ""

    @property
    def value_issues(self) -> list:
        """Projection problems that change this pick's value (rounds 1-3 only;
        rounds 4+ are valued the same at every slot)."""
        if self.projection is None or self.round > 3:
            return []
        return list(self.projection.issues)


@dataclass
class TradeSide:
    franchise_id: str
    franchise_name: str
    players_given: list = field(default_factory=list)
    picks_given: list = field(default_factory=list)
    salary_given: int = 0  # budget bucks
    players_received: list = field(default_factory=list)
    picks_received: list = field(default_factory=list)
    salary_received: int = 0
    total_roster_salary: int = 0
    cap_space: int = 0
    cap_adjustments: int = 0  # signed; positive = added to salary, negative = added to cap space
    grade: str = ""
    grade_score: float = 0.0
    value_pts: dict = field(default_factory=dict)  # received/given/net breakdown


@dataclass
class TradeAnalysis:
    timestamp: int = 0
    comments: str = ""
    side_a: TradeSide = None
    side_b: TradeSide = None
    # Inputs the grade could not trust. Non-empty = the grade is PROVISIONAL and
    # must not be presented as final (Keith 2026-10-20, #1343 decision 2).
    provisional_reasons: list = field(default_factory=list)
    # A grade-affecting input failed validation (#1343 decision 3). Non-empty =
    # NO GRADE: no letter or score, no roast-model call, no Discord post.
    no_grade_reasons: list = field(default_factory=list)
    valuation_as_of: str = ""          # snapshot as_of and checksum prefix
    regrade_label: str = ""            # set when the snapshot postdates the trade
    # Display-only fields left out, with why (they never change the grade).
    display_notes: list = field(default_factory=list)

    @property
    def no_grade(self) -> bool:
        return bool(self.no_grade_reasons)


def display_name(mfl_name: str) -> str:
    """Convert MFL 'Last, First' to 'First Last'."""
    if "," in mfl_name:
        parts = mfl_name.split(",", 1)
        return f"{parts[1].strip()} {parts[0].strip()}"
    return mfl_name


# ── Loaders ────────────────────────────────────────────────────────────────

def load_franchises() -> dict:
    """Return {franchise_id: name}."""
    data = mfl_fetch("league")
    return {
        f["id"]: f.get("name", f"Franchise {f['id']}")
        for f in data["league"]["franchises"]["franchise"]
    }


def load_players_map() -> dict:
    """Return {player_id: {name, position, team}}."""
    data = mfl_fetch("players")
    out = {}
    players = data["players"]["player"]
    if isinstance(players, dict):
        players = [players]
    for p in players:
        out[p["id"]] = {
            "name": p.get("name", "Unknown"),
            "position": p.get("position", ""),
            "team": p.get("team", ""),
        }
    return out


def load_rosters() -> dict:
    """Return {franchise_id: [{player_id, salary, contractInfo, ...}]}."""
    data = mfl_fetch("rosters")
    out = {}
    for f in data["rosters"]["franchise"]:
        players = f["player"]
        if isinstance(players, dict):
            players = [players]
        out[f["id"]] = players
    return out


def load_salary_adjustments() -> dict | None:
    """Return {franchise_id: sum_of_adjustments_signed}.

    Pulls MFL TYPE=salaryAdjustments. MFL convention: positive amount = adds
    to total salary (reduces cap space); negative = subtracts from salary
    (increases cap space). Sum per franchise.

    For Brian Cross (0006) in 2026: -$20K from a UPS-traded-salary settlement
    + $2.5K drop penalty = -$17.5K net → +$17.5K of effective cap space
    relative to raw roster total. Bug fix per Keith 2026-05-22.
    """
    out: dict[str, int] = {}
    try:
        data = mfl_fetch("salaryAdjustments")
    except Exception:
        return None   # display-only: the caller says so instead of showing $0
    rows = data.get("salaryAdjustments", {}).get("salaryAdjustment", [])
    if isinstance(rows, dict):
        rows = [rows]
    for r in rows:
        fid = str(r.get("franchise_id", "")).zfill(4)
        try:
            amt = int(float(r.get("amount", 0)))
        except (TypeError, ValueError):
            amt = 0
        if fid:
            out[fid] = out.get(fid, 0) + amt
    return out


def load_future_picks() -> dict:
    """Return {franchise_id: [picks]}."""
    data = mfl_fetch("futureDraftPicks")
    out = {}
    for f in data["futureDraftPicks"]["franchise"]:
        picks = f.get("futureDraftPick", [])
        if isinstance(picks, dict):
            picks = [picks]
        out[f["id"]] = picks
    return out


# ── Trade Parser ───────────────────────────────────────────────────────────

def future_pick_info(token: str, franchises: dict, season_state=None) -> "PickInfo":
    """A future pick FP_<original franchise>_<year>_<round>, valued over bracket odds.

    The ORIGINAL franchise (the token's, not whoever holds the pick) sets the
    slot. Unreadable parts are named in the projection's issues, never guessed.
    """
    parts = token.split("_")
    owner = parts[1] if len(parts) > 1 else ""
    year_raw = parts[2] if len(parts) > 2 else ""
    try:
        rnd = int(parts[3])
    except (IndexError, ValueError):
        rnd = 1
    proj = _project_future_pick(owner, year_raw, rnd, season_state)
    if not str(token).count("_") >= 3:
        proj.blocking.append(f"future-pick token {token!r} is malformed")
    pts = _points_over(proj.dist, rnd)
    slot = proj.slot or max(1, min(12, round(proj.average_slot)))
    return PickInfo(
        year=proj.pick_year or 0,
        round=rnd,
        original_owner=owner,
        original_owner_name=franchises.get(owner, "Unknown"),
        estimated_value=int(pts * _dpp()),
        expected_points=pts,
        predicted_slot=slot,
        rookie_aav=_rookie_aav(rnd, slot),
        slot_is_projected=proj.slot is None,
        projection=proj,
    )


def parse_asset_string(asset_str: str, players_map: dict, franchises: dict,
                       season_state=None) -> tuple:
    """Parse MFL asset string like '14783,FP_0006_2027_1,BB_20000,' into
    (players, picks, salary_bb). season_state: the current season's standings
    as of the trade (pick_valuation.SeasonState), for future-pick odds."""
    players = []
    picks = []
    salary = 0

    if not asset_str:
        return players, picks, salary

    for token in asset_str.strip().rstrip(",").split(","):
        token = token.strip()
        if not token:
            continue

        if token.startswith("FP_"):
            # Future pick: FP_FRANCHISE_YEAR_ROUND
            picks.append(future_pick_info(token, franchises, season_state))
        elif token.startswith("DP_"):
            # Current year draft pick: DP_ROUND_PICK (both 0-indexed in MFL)
            parts = token.split("_")
            if len(parts) >= 3:
                rnd = int(parts[1]) + 1
                slot = int(parts[2]) + 1
                picks.append(PickInfo(
                    year=2026,
                    round=rnd,
                    original_owner="",
                    estimated_value=_pick_value(2026, rnd, slot=slot),
                    expected_points=_pick_points(2026, rnd, slot=slot),
                    predicted_slot=slot,
                    rookie_aav=_rookie_aav(rnd, slot),
                ))
        elif token.startswith("BB_"):
            salary = int(token.replace("BB_", ""))
        else:
            # Player ID
            pinfo = players_map.get(token, {})
            players.append(PlayerInfo(
                player_id=token,
                name=pinfo.get("name", f"ID:{token}"),
                position=pinfo.get("position", ""),
                team=pinfo.get("team", ""),
            ))

    return players, picks, salary


def fetch_trades() -> list:
    """Fetch all TRADE transactions from MFL."""
    data = mfl_fetch("transactions")
    txns = data.get("transactions", {}).get("transaction", [])
    if isinstance(txns, dict):
        txns = [txns]
    return [t for t in txns if t.get("type") == "TRADE"]


def enrich_player(player: PlayerInfo, rosters: dict, franchises: dict, snapshot: dict) -> None:
    """Contract from MFL rosters; name, position and projected PPG from the
    valuation snapshot. trade_coverage() has already refused players the
    snapshot cannot value, so there is nothing to fall back to here."""
    for fid, roster in rosters.items():
        for p in roster:
            if p["id"] == player.player_id:
                player.salary = _safe_int(p.get("salary", 0))
                player.contract_info = p.get("contractInfo", "")
                player.contract_status = p.get("contractStatus", "")
                player.contract_year = _safe_int(p.get("contractYear", 0))
                player.franchise_id = fid
                player.franchise_name = franchises.get(fid, "")
                break
    row = snapshot["players"][str(player.player_id)]
    player.position = row["pos"]
    if row.get("name") and (not player.name or player.name.startswith("ID:")):
        player.name = row["name"]
    player.expected_ppg = float(row["ppg"] or 0.0)
    player.projected_ppg = player.expected_ppg
    player.ppg_basis = row.get("basis_text") or row.get("basis", "")
    player.projection_age = row.get("age")
    player.projection_age_mult = row.get("age_mult", 1.0)


def compute_grade(score: float) -> str:
    if score > 40:
        return "A+"
    elif score > 25:
        return "A"
    elif score > 15:
        return "A-"
    elif score > 5:
        return "B+"
    elif score > -5:
        return "B"
    elif score > -15:
        return "B-"
    elif score > -25:
        return "C+"
    elif score > -40:
        return "C"
    else:
        return "D+"


# ── Auction Pool Comparables ──────────────────────────────────────────────

def calculate_extension(player: PlayerInfo, years: int = 2) -> dict:
    """Calculate extension terms per league rules (R-9.4)."""
    # Parse AAV from contract_info
    aav = 0
    ci = player.contract_info
    if "AAV" in ci:
        import re
        m = re.search(r"AAV\s*[\$]?([\d,.]+)K", ci)
        if m:
            aav = int(float(m.group(1).replace(",", "")) * 1000)

    # Schedule 1 (QB/RB/WR/TE): +10K for 1yr, +20K for 2yr
    # Schedule 2 (DB/LB/DL/K): +3K for 1yr, +5K for 2yr
    schedule1 = player.position in ("QB", "RB", "WR", "TE")
    if years == 1:
        raise_amount = 10000 if schedule1 else 3000
    else:
        raise_amount = 20000 if schedule1 else 5000

    new_aav = aav + raise_amount
    current_salary = player.salary

    # Extension years get the new AAV
    ext_salaries = [new_aav] * years
    total_commitment = current_salary + sum(ext_salaries)

    return {
        "current_aav": aav,
        "raise": raise_amount,
        "new_aav": new_aav,
        "current_salary": current_salary,
        "extension_salaries": ext_salaries,
        "total_years": 1 + years,  # current year + extension
        "total_commitment": total_commitment,
        "effective_aav": total_commitment // (1 + years),
    }


# ── Discord Formatter ─────────────────────────────────────────────────────

def format_discord_report(analysis: TradeAnalysis, comparables: dict = None,
                          extension_info: dict = None,
                          rosters: dict = None,
                          players_map: dict = None,
                          franchises: dict = None,
                          auction_pool: dict = None) -> str:
    """Generate the full Discord-ready trade report."""
    a = analysis.side_a
    b = analysis.side_b
    lines = []

    def ln(s=""):
        lines.append(s)

    # ── Header ─────────────────────────────────────────────────────────
    ln("```")
    ln("==========================================================")
    ln("         UPS TRADE INTELLIGENCE REPORT")
    ln("           Powered by Claude x UPS Analytics")
    ln("==========================================================")
    ln()
    ln(f"TRADE: {a.franchise_name} <-> {b.franchise_name}")
    ln(f"DATE: April 2026 (Pre-Auction Window)")
    ln()

    # ── What each side gave up ─────────────────────────────────────────
    ln("ASSETS EXCHANGED:")
    ln(f"  {a.franchise_name} gave up:")
    for pk in a.picks_given:
        ln(f"    Pick: {pk.year} Round {pk.round} (orig: {pk.original_owner_name})")
    for p in a.players_given:
        ln(f"    Player: {display_name(p.name)} ({p.position}, {p.team})")
    if a.salary_given:
        ln(f"    Salary: ${a.salary_given:,}")

    ln(f"  {b.franchise_name} gave up:")
    for pk in b.picks_given:
        ln(f"    Pick: {pk.year} Round {pk.round} (orig: {pk.original_owner_name})")
    for p in b.players_given:
        ln(f"    Player: {display_name(p.name)} ({p.position}, {p.team}) [${p.salary:,}]")
    if b.salary_given:
        ln(f"    Salary: ${b.salary_given:,} (Budget Bucks)")
    ln()

    # ── Player contract breakdown ──────────────────────────────────────
    all_players = a.players_given + b.players_given
    for p in all_players:
        if p.salary > 0:
            ln("==========================================================")
            ln(f"  {display_name(p.name)} ({p.position}, {p.team}) - CONTRACT")
            ln("==========================================================")
            ln(f"  Contract: {p.contract_info}")
            ln(f"  Current Salary: ${p.salary:,}")
            ln(f"  Projected PPG: {p.expected_ppg:.1f} ({p.ppg_basis})")
            ln()

            # Extension projection if available
            if extension_info and p.player_id in extension_info:
                ext = extension_info[p.player_id]
                ln(f"  WITH 2-YEAR EXTENSION (Schedule 1: +${ext['raise']:,}):")
                ln(f"    Current AAV: ${ext['current_aav']:,}")
                ln(f"    New AAV (ext years): ${ext['new_aav']:,}")
                ln(f"    2026: ${ext['current_salary']:,} (locked in)")
                for i, sal in enumerate(ext["extension_salaries"], 1):
                    ln(f"    {2026+i}: ${sal:,} (extension yr {i})")
                ln(f"    TOTAL: ${ext['total_commitment']:,} over {ext['total_years']} years")
                ln(f"    Effective AAV: ${ext['effective_aav']:,}")
                ln()
    ln()

    ln("  Auction-price comparables: not in valuation snapshot v1 (decision 3),")
    ln("  so none are shown. They never affected the grade.")
    ln()

    # ── Grades & Roasts ────────────────────────────────────────────────
    ln("==========================================================")
    ln("                    THE GRADES")
    ln("==========================================================")
    ln()
    if analysis.provisional_reasons:
        ln("  PROVISIONAL GRADE -- not final. Inputs it could not trust:")
        for reason in analysis.provisional_reasons:
            ln(f"    - {reason}")
        ln()

    for side in [a, b]:
        ln(f"  {side.franchise_name} -- GRADE: {side.grade} ({side.grade_score:+.0f}%)")
        ln(f"  {'─' * 40}")

        # Points-based breakdown — pulls pre-computed totals from value_pts.
        v = side.value_pts
        prod_received = v.get("prod_received", 0)
        prod_lost = v.get("prod_lost", 0)
        picks_recv_pts = sum(pk.expected_points for pk in side.picks_received)
        picks_given_pts = sum(pk.expected_points for pk in side.picks_given)
        sal_committed = v.get("salary_committed", 0)
        sal_freed = v.get("salary_freed", 0)

        def _yrs(player):
            y, _ = _parse_contract(player.contract_info, player.contract_year, player.salary)
            return y

        if prod_received:
            yrs = ", ".join(f"{_yrs(p)}yr" for p in side.players_received)
            ln(f"    Production Gained:       {prod_received:>+8.0f} pts  ({yrs} horizon)")
        if picks_recv_pts:
            ln(f"    Pick Production:         {picks_recv_pts:>+8.0f} pts  (3-yr rookie)")
        if sal_freed:
            ln(f"    Cap Freed:               {_salary_to_pts(sal_freed):>+8.0f} pts  (${sal_freed:,} remaining)")
        if side.salary_received:
            ln(f"    Budget Bucks Received:   {_salary_to_pts(side.salary_received):>+8.0f} pts  (${side.salary_received:,})")
        if prod_lost:
            yrs = ", ".join(f"{_yrs(p)}yr" for p in side.players_given)
            ln(f"    Production Lost:         {-prod_lost:>+8.0f} pts  ({yrs} horizon)")
        if picks_given_pts:
            ln(f"    Picks Given Up:          {-picks_given_pts:>+8.0f} pts  (3-yr rookie)")
        if sal_committed:
            ln(f"    Salary Taken On:         {-_salary_to_pts(sal_committed):>+8.0f} pts  (${sal_committed:,} remaining)")
        if side.salary_given:
            ln(f"    Budget Bucks Given:      {-_salary_to_pts(side.salary_given):>+8.0f} pts  (${side.salary_given:,})")
        ln(f"    {'─' * 45}")
        ln(f"    Net Value:               {v.get('net_pts', 0):>+8.0f} pts")
        for pk in side.picks_received:
            contract = rookie_contract_line(pk)
            if contract:
                ln(f"    {pk.year} R1: {contract}")
        ln()

        # Opposite side's player 3yr-production threshold for probability-of-match.
        # If side has a player-vs-pick trade, we want "what % of historical picks
        # at this slot matched the PPG of the player being traded?"
        def _compare_player_pts(players):
            if not players:
                return None
            return max((p.expected_ppg or 0) * GAMES_PER_SEASON * 3 for p in players)

        def _format_pick(pk, compare_pts=None):
            per_season = pk.expected_points / 3 if pk.expected_points else 0
            per_game = per_season / GAMES_PER_SEASON if per_season else 0
            contract = rookie_contract_line(pk)
            salary = (f"\n        {contract}" if contract
                      else f", rookie ${pk.rookie_aav:,}/yr (taxi-eligible)")
            odds = f"\n        Bracket odds: {pk.odds_text}" if pk.odds_text else ""
            base = (f"      {pick_label(pk)} pick — est. {pk.expected_points:.0f} pts / 3yr "
                    f"(~{per_game:.1f} PPG avg){odds}{salary}")
            return base

        # Probability threshold: what's the opposing player asking the pick to match?
        threshold_given = _compare_player_pts(side.players_received)  # pick GIVEN up vs player RECEIVED
        threshold_recv = _compare_player_pts(side.players_given)      # pick RECEIVED vs player GIVEN

        ln(f"    Gave up:")
        for p in side.players_given:
            proj_note = ""
            if p.projected_ppg:
                proj_note = f" | proj {p.projected_ppg:.1f} PPG"
                if p.projection_age and p.projection_age_mult != 1.0:
                    tag = "age-decline" if p.projection_age_mult < 1.0 else "young"
                    proj_note += f" [{tag} x{p.projection_age_mult:.2f}]"
            ln(f"      {display_name(p.name)} ({p.position}) - ${p.salary:,}/yr{proj_note}")
        for pk in side.picks_given:
            ln(_format_pick(pk, threshold_given))
        if side.salary_given:
            ln(f"      ${side.salary_given:,} salary (BB)")

        ln(f"    Received:")
        for p in side.players_received:
            proj_note = ""
            if p.projected_ppg:
                proj_note = f" | proj {p.projected_ppg:.1f} PPG"
                if p.projection_age and p.projection_age_mult != 1.0:
                    tag = "age-decline" if p.projection_age_mult < 1.0 else "young"
                    proj_note += f" [{tag} x{p.projection_age_mult:.2f}]"
            ln(f"      {display_name(p.name)} ({p.position}) - ${p.salary:,}/yr{proj_note}")
        for pk in side.picks_received:
            ln(_format_pick(pk, threshold_recv))
        if side.salary_received:
            ln(f"      ${side.salary_received:,} salary (BB)")
        ln()

        # Roster context — use the adjustment-aware numbers analyze_trade already
        # computed on the TradeSide (cap = $300K − salaries − MFL salaryAdjustments).
        # The old naive recompute here (300000 − salaries) is what let the
        # 2026-07-11 roast claim $41K cap space when the true number was $27.5K
        # (it ignored $13.5K of cap adjustments) — sexmanther noticed.
        if rosters and players_map and side.franchise_id in rosters:
            roster = rosters[side.franchise_id]
            total_sal = side.total_roster_salary or sum(
                _safe_int(p.get("salary", 0)) for p in roster
                if p.get("status") != "TAXI_SQUAD")
            adj = side.cap_adjustments or 0
            cap_space = side.cap_space if side.cap_space else (300000 - total_sal - adj)
            ln(f"    Post-Trade Roster: ${total_sal:,} / $300K cap"
               + (f" (incl. ${adj:+,} cap adjustments)" if adj else ""))
            ln(f"    Cap Space: ${cap_space:,}")

            # Show their QBs
            qbs = []
            for rp in roster:
                pinfo = players_map.get(rp["id"], {})
                if pinfo.get("position") == "QB" and rp.get("status") != "TAXI_SQUAD":
                    qbs.append(f"{pinfo['name']} ${_safe_int(rp.get('salary',0)):,}")
            if qbs:
                ln(f"    QB Room: {', '.join(qbs)}")
        ln()

    # ── Verdict ────────────────────────────────────────────────────────
    ln("==========================================================")
    ln("                    VERDICT")
    ln("==========================================================")

    # Determine winner
    if a.grade_score > b.grade_score:
        winner, loser = a, b
    else:
        winner, loser = b, a

    ln(f"  WINNER: {winner.franchise_name} ({winner.grade}, {winner.grade_score:+.0f}%)")
    ln(f"  LOSER:  {loser.franchise_name} ({loser.grade}, {loser.grade_score:+.0f}%)")
    ln()

    # ── WHY: explain the drivers ──────────────────────────────────────────
    ln("  WHY:")
    for side, label in [(winner, "WINS"), (loser, "LOSES")]:
        v = side.value_pts
        drivers = []
        # Gains
        if v.get("prod_received", 0) > 0:
            yrs = ", ".join(
                f"{_parse_contract(p.contract_info, p.contract_year, p.salary)[0]}yr"
                for p in side.players_received)
            names = ", ".join(display_name(p.name) for p in side.players_received)
            drivers.append((v['prod_received'],
                            f"+{v['prod_received']:>4.0f} pts  Production from {names} ({yrs})"))
        if side.picks_received:
            pick_pts = sum(pk.expected_points for pk in side.picks_received)
            pick_descs = []
            for pk in side.picks_received:
                per_game = (pk.expected_points / 3) / GAMES_PER_SEASON
                pick_descs.append(f"{pick_label(pk)} pick (~{per_game:.1f} PPG avg)")
            drivers.append((pick_pts,
                            f"+{pick_pts:>4.0f} pts  Picks: {'; '.join(pick_descs)}"))
        if v.get("salary_freed", 0) > 0:
            sal = v['salary_freed']
            pts = _salary_to_pts(sal)
            names = ", ".join(display_name(p.name) for p in side.players_given)
            drivers.append((pts,
                            f"+{pts:>4.0f} pts  Cap freed: ${sal:,} remaining on {names}"))
        if side.salary_received > 0:
            pts = _salary_to_pts(side.salary_received)
            drivers.append((pts,
                            f"+{pts:>4.0f} pts  Budget Bucks received (${side.salary_received:,})"))
        # Losses
        if v.get("prod_lost", 0) > 0:
            yrs = ", ".join(
                f"{_parse_contract(p.contract_info, p.contract_year, p.salary)[0]}yr"
                for p in side.players_given)
            names = ", ".join(display_name(p.name) for p in side.players_given)
            drivers.append((-v['prod_lost'],
                            f"-{v['prod_lost']:>4.0f} pts  Lost production of {names} ({yrs})"))
        if side.picks_given:
            pick_pts = sum(pk.expected_points for pk in side.picks_given)
            pick_descs = []
            for pk in side.picks_given:
                pick_descs.append(pick_label(pk))
            drivers.append((-pick_pts,
                            f"-{pick_pts:>4.0f} pts  Picks given: {', '.join(pick_descs)}"))
        if v.get("salary_committed", 0) > 0:
            sal = v['salary_committed']
            pts = _salary_to_pts(sal)
            drivers.append((-pts,
                            f"-{pts:>4.0f} pts  Salary committed: ${sal:,} remaining"))
        if side.salary_given > 0:
            pts = _salary_to_pts(side.salary_given)
            drivers.append((-pts,
                            f"-{pts:>4.0f} pts  Budget Bucks given (${side.salary_given:,})"))

        # Sort by absolute impact, show top 3
        drivers.sort(key=lambda t: -abs(t[0]))
        ln(f"    {side.franchise_name} {label}:")
        for _, desc in drivers[:4]:
            ln(f"      {desc}")
        ln()

    ln("==========================================================")
    ln("  UPS Analytics | League 74598")
    ln("==========================================================")
    ln("```")

    return "\n".join(lines)


# ── Roast Generator ───────────────────────────────────────────────────────

def generate_roast_context(analysis: TradeAnalysis, comparables: dict = None,
                           extension_info: dict = None) -> str:
    """Build context string for Claude API roast generation."""
    a = analysis.side_a
    b = analysis.side_b

    ctx = []
    ctx.append("=== TRADE DETAILS ===")
    ctx.append(f"{a.franchise_name} gave: " +
               ", ".join([f"{pk.year} Rd {pk.round}" for pk in a.picks_given] +
                         [p.name for p in a.players_given] +
                         ([f"${a.salary_given:,} BB"] if a.salary_given else [])))
    ctx.append(f"{b.franchise_name} gave: " +
               ", ".join([f"{pk.year} Rd {pk.round}" for pk in b.picks_given] +
                         [f"{p.name} (${p.salary:,})" for p in b.players_given] +
                         ([f"${b.salary_given:,} BB"] if b.salary_given else [])))

    ctx.append(f"\n=== GRADES ===")
    ctx.append(f"{a.franchise_name}: {a.grade} (score: {a.grade_score:+.1f}%)")
    ctx.append(f"{b.franchise_name}: {b.grade} (score: {b.grade_score:+.1f}%)")
    if analysis.provisional_reasons:
        ctx.append("PROVISIONAL, not final: " + "; ".join(analysis.provisional_reasons))

    ctx.append(f"\n=== KEY NUMBERS ===")
    extension_info = extension_info or {}
    for p in b.players_given:
        if p.player_id in extension_info:
            ext = extension_info[p.player_id]
            ctx.append(f"{p.name}: ${p.salary:,}/yr, {p.expected_ppg:.1f} PPG, "
                       f"extends to ${ext['total_commitment']:,} over {ext['total_years']}yr")

    ctx.append(f"\n=== ROSTER CONTEXT ===")
    ctx.append(f"{a.franchise_name}: Grade {a.grade}, cap ${a.cap_space:,} remaining")
    ctx.append(f"{b.franchise_name}: Grade {b.grade}")

    return "\n".join(ctx)


# ── Main ───────────────────────────────────────────────────────────────────


def _worker_base() -> str:
    return os.environ.get("UPS_WORKER_BASE",
                          "https://upsmflproduction.keith-creelman.workers.dev").rstrip("/")


def _worker_get_json(url: str, timeout: int = 20):
    import urllib.request as _ur
    req = _ur.Request(url, headers={"User-Agent": "ups-roast-bot-launchd"})
    with _ur.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


# KEITH'S STANDING RULE (2026-07-12): NEVER cite current-season numbers before
# the season has started. Pre-season player value = the prior THREE seasons'
# actual MFL PPG, weighted toward the most recent (0.60 / 0.25 / 0.15,
# renormalized over available seasons), plus CURRENT multi-source ADP
# (/api/adp-board consensus). Enforced here in the DATA LAYER — prompt rules
# alone demonstrably don't stop the model from misusing 0.0 offseason stats.
PPG_SEASON_WEIGHTS = (0.60, 0.25, 0.15)


def fetch_weighted_ppg(players) -> dict:
    """{mfl_player_id: {ppg, basis, by_season}} — 3-prior-season weighted MFL PPG
    from the worker leaderboard (the site's own scoring source of truth)."""
    out = {}
    try:
        from datetime import date as _date
        cur = _date.today().year
        seasons = [cur - 1, cur - 2, cur - 3]
        pos_groups = set()
        for p in players:
            pos = (getattr(p, "position", "") or "").upper()
            pos_groups.add("qb" if pos == "QB" else
                           "kicker" if pos == "PK" else
                           "punter" if pos == "PN" else
                           "idp" if pos in ("DT","DE","NT","DL","LB","OLB","ILB","MLB","CB","S","SS","FS","DB") else
                           "skill")
        want = {str(getattr(p, "player_id", "")) for p in players}
        per_season: dict = {}
        for season in seasons:
            for pg in pos_groups:
                url = (f"{_worker_base()}/api/advanced-stats-leaderboard"
                       f"?seasons={season}&pos={pg}&limit=500")
                try:
                    rows = _worker_get_json(url).get("rows", [])
                except Exception:
                    continue
                for r in rows:
                    mid = str(r.get("mfl_pid") or "")
                    if mid in want and r.get("mfl_ppg"):
                        per_season.setdefault(mid, {})[season] = {
                            "ppg": float(r["mfl_ppg"]),
                            "games": int(r.get("games") or 0)}
        # A 1-3 game injury cameo is noise, not a season: exclude it from the
        # blend. Weights renormalize over the seasons a player ACTUALLY played,
        # so a 2nd-year player is judged on his one real season, never
        # penalized for seasons that predate his career (Keith 2026-07-12).
        MIN_GAMES = 4
        for mid, by in per_season.items():
            qual = {s2: v for s2, v in by.items() if v["games"] >= MIN_GAMES}
            use = qual or by  # if NO season qualifies, thin data beats none
            num = den = 0.0
            for i, season in enumerate(seasons):
                if season in use:
                    w = PPG_SEASON_WEIGHTS[i]
                    num += w * use[season]["ppg"]; den += w
            if den > 0:
                blend = num / den
                parts = ", ".join(
                    "{}: {:.1f} ({}G)".format(s2, use[s2]["ppg"], use[s2]["games"])
                    for s2 in sorted(use, reverse=True))
                skipped = sorted(set(by) - set(use), reverse=True)
                note = ("; excluded " + ", ".join(map(str, skipped)) +
                        " (injury cameo <" + str(MIN_GAMES) + "G)") if skipped else ""
                out[mid] = {"ppg": round(blend, 1),
                            "basis": "weighted over seasons played (" + parts + ")" + note,
                            "by_season": by}
    except Exception as e:
        print(f"[trade_grader] weighted PPG lookup skipped ({e})")
    return out


def _rank_map(items: list, key_fn, ascending: bool) -> dict:
    """id(item) -> rank (1=best) among items where key_fn(item) is not None."""
    scored = [(key_fn(p), id(p)) for p in items if key_fn(p) is not None]
    scored.sort(key=lambda t: t[0] if ascending else -t[0])
    return {pid: i + 1 for i, (_, pid) in enumerate(scored)}


def _rank_to_fc_value_curve(board: list, fc_rank: dict) -> list:
    """Sorted [(rank, fc.rsf value)] pairs — the reference for mapping a
    cross-source CONSENSUS RANK back onto FantasyCalc's redraft $-scale."""
    pairs = []
    for p in board:
        r = fc_rank.get(id(p))
        v = (p.get("fc") or {}).get("rsf")
        if r and v:
            pairs.append((r, float(v)))
    pairs.sort()
    return pairs


def _value_at_rank(r: float, curve: list):
    if not curve:
        return None
    ranks = [c[0] for c in curve]
    i = bisect.bisect_left(ranks, r)
    if i == 0:
        return curve[0][1]
    if i >= len(curve):
        return curve[-1][1]
    r0, v0 = curve[i - 1]
    r1, v1 = curve[i]
    f = (r - r0) / (r1 - r0) if r1 != r0 else 0.0
    return v0 + (v1 - v0) * f


def fetch_adp_board() -> dict:
    """{mfl_player_id: {overall, pos_rank, pos, trend30, sources}} replicating the
    SITE'S ADP board math (canon: the board the league actually looks at;
    verified vs the UI 2026-07-12 — Kittle TE9/#103, Pitts TE6/#77):
      - Superflex values: per-dimension source means (fc/ktc/dp dsf and rsf
        averaged separately), blended 65% dynasty / 35% redraft
      - overall # = blended-value ordering over the NON-IDP universe
      - posRank = same ordering within position; IDP ranked in its own space
    Keith 2026-07-12: current ADP is the true market perception.
    Keith 2026-07-13: the redraft axis used to be a straight VALUE average of
    fc.rsf/ktc.rsf. Two compounding bugs: (1) KTC/DynastyProcess rarely publish
    rsf at all, so the "35% redraft" weight often collapsed to FantasyCalc's
    single field; (2) where KTC DOES publish rsf, its redraft $-scale is not
    comparable to FC's — a KTC rsf of ~4700-4800 can correspond to only KTC's
    OWN ~104th-110th-best redraft player, wildly inflating a mid-tier player's
    blended value the instant KTC is present. Both bugs are fixed the same way:
    the redraft axis is now a RANK-consensus (each source ranked against only
    its own reporting population, so a scale mismatch between sources can never
    leak in), averaged across whichever of {fc.rsf desc, ktc.rsf desc, ffcAdp
    asc (FantasyFootballCalculator, real live-draft ADP)} are present, then
    mapped back onto FC's rsf $-scale via _value_at_rank() so the result still
    plugs into the existing 65/35 dynasty/redraft $ blend unchanged. Verified
    against real external sources same-day: Parker Washington WR91->WR42 (FantasyData
    has him WR39/ADP85.0, ffcAdp independently says pick 72 — old value-based
    blend undershot even after a first attempt at this fix); Kyle Pitts TE6->TE7
    (FantasyData has him TE8/ADP92 right now — the OLD "TE6" hand-verified
    benchmark was itself inflated by the KTC scale-mismatch bug); Kittle holds
    exactly TE9 (his three source ranks already agreed, so the correction is a
    no-op for him — the standing regression check). Sleeper's search_rank was
    evaluated too but carries suspicious round-number sentinels (many unrelated
    players share an identical 999) — left out to avoid injecting noise.
    Keith 2026-07-21: the DYNASTY axis had the same class of bug the redraft axis
    was fixed for in 2026-07-13 — it averaged raw `dsf` across three sources whose
    value curves decay at wildly different rates (at each source's own rank 100:
    KTC keeps 35.5% of its top value, FantasyCalc 24.1%, DynastyProcess 7.7%), so
    KTC's flat tail dominated the sum and the "consensus" was effectively KTC. The
    worker now emits `ndsf` per source — scale-normalised, TE-premium-corrected —
    and this reads that. Also adds MFL native AAV to the redraft rank-consensus."""
    RD_PCT = 0.35
    out = {}
    try:
        d = _worker_get_json(f"{_worker_base()}/api/adp-board", timeout=25)
        board = d.get("board") or []
        fc_rank = _rank_map(board, lambda p: (p.get("fc") or {}).get("rsf") or None, False)
        ktc_rank = _rank_map(board, lambda p: (p.get("ktc") or {}).get("rsf") or None, False)
        ffc_rank = _rank_map(board, lambda p: p.get("ffcAdp"), True)
        # MFL native AAV is REFERENCE ONLY and deliberately absent from the blend.
        # It is the only source quoting real auction dollars and it IS live again
        # for 2026 (800 tracked auctions), but inspected 2026-07-21 the top six
        # players by average value are all 2026 rookies (Jeremiyah Love $57.39,
        # Carnell Tate $37.82, ... Ja'Marr Chase 7th, Josh Allen 10th): in July the
        # auctions MFL tracks are dynasty ROOKIE auctions. That is a rookie-draft
        # ordering, not a redraft one, and ranking rather than averaging does not
        # save it — the contamination is in the ordering itself. Re-evaluate once
        # redraft auctions dominate the pool closer to the season.
        rank_curve = _rank_to_fc_value_curve(board, fc_rank)
        def blend(p):
            # DYNASTY axis: `ndsf` is the worker's SCALE-NORMALISED dynasty value
            # (each source ranked inside its own reporting population, TE-premium-
            # bridged for the non-TEP sources, mapped onto one common cardinal
            # curve). The old code averaged raw `dsf` across sources — the same
            # incompatible-scales bug that hit the redraft axis on 2026-07-13, just
            # on the dynasty side: KTC's value curve is ~4.6x flatter than
            # DynastyProcess's past rank 100, so the mean quietly became KTC's
            # board. Measured before the fix: the consensus correlated MOST with
            # KTC (rho .985) despite KTC agreeing LEAST with the other two — an
            # inverted centroid. `dsf` fallback is split-deploy safety only.
            dyn_vals = []
            for src in ("fc", "ktc", "dp"):
                blk = p.get(src) or {}
                v = blk.get("ndsf") or blk.get("dsf")
                if v and v > 0:
                    dyn_vals.append(float(v))
            dyn_c = sum(dyn_vals) / len(dyn_vals) if dyn_vals else None
            ranks = [x[id(p)] for x in (fc_rank, ktc_rank, ffc_rank) if id(p) in x]
            rd_c = _value_at_rank(sum(ranks) / len(ranks), rank_curve) if ranks else None
            if dyn_c is None and rd_c is None:
                return None
            if rd_c is None:
                return dyn_c
            if dyn_c is None:
                return rd_c
            return (1 - RD_PCT) * dyn_c + RD_PCT * rd_c
        for universe, is_idp in ((False, False), (True, True)):
            rows = [p for p in board if bool(p.get("isIdp")) == is_idp]
            scored = []
            for p in rows:
                v = p.get("idpVal") if is_idp else blend(p)
                if v:
                    scored.append((float(v), p))
            scored.sort(key=lambda t: -t[0])
            pos_counter = {}
            for i, (v, p) in enumerate(scored, 1):
                pos = str(p.get("pos") or "")
                pos_counter[pos] = pos_counter.get(pos, 0) + 1
                pid = str(p.get("pid") or "")
                if pid:
                    out[pid] = {"overall": i, "pos_rank": pos_counter[pos], "pos": pos,
                                "trend30": int(p.get("trend30") or 0),
                                "sources": int(p.get("nSources") or 0),
                                # independent PANELS behind the number (DynastyProcess
                                # and FantasyPros are one panel, not two)
                                "panels": int(p.get("nPanels") or 0),
                                "tier": p.get("tier")}
    except Exception as e:
        print(f"[trade_grader] adp-board lookup skipped ({e})")
    return out


def adp_implied_ppg(pos: str, pos_rank: int) -> tuple:
    """(ppg, basis) for players with NO qualifying NFL seasons (rookies): the
    prior season's actual MFL PPG of the player at the SAME positional rank —
    i.e. "the market says he's TE4; last year's TE4 scored X". Never returns a
    punitive 0 for a player who simply hasn't played yet (Keith 2026-07-12)."""
    try:
        from datetime import date as _date
        season = _date.today().year - 1
        pos = (pos or "").upper()
        pg = ("qb" if pos == "QB" else "kicker" if pos == "PK" else
              "punter" if pos == "PN" else
              "idp" if pos in ("DT","DE","NT","DL","LB","OLB","ILB","MLB","CB","S","SS","FS","DB") else "skill")
        url = (f"{_worker_base()}/api/advanced-stats-leaderboard"
               f"?seasons={season}&pos={pg}&limit=500")
        rows = _worker_get_json(url).get("rows", [])
        ranked = sorted((r for r in rows
                         if (r.get("position") or "").upper() == pos
                         and r.get("mfl_ppg") and int(r.get("games") or 0) >= 6),
                        key=lambda r: -float(r["mfl_ppg"]))
        if 0 < pos_rank <= len(ranked):
            ppg = float(ranked[pos_rank - 1]["mfl_ppg"])
            return round(ppg, 1), (f"ADP-implied: market ranks him {pos}{pos_rank}; "
                                   f"{season}'s {pos}{pos_rank} scored {ppg:.1f} PPG")
    except Exception as e:
        print(f"[trade_grader] adp-implied ppg skipped ({e})")
    return 0.0, ""


# Back-compat alias (context imports the old name)
def fetch_prior_season_ppg(players) -> dict:
    w = fetch_weighted_ppg(players)
    from datetime import date as _date
    return {mid: {"ppg": v["ppg"], "season": _date.today().year - 1} for mid, v in w.items()}


STANDINGS_MAX_LAG_SECONDS = 6 * 3600


def load_season_state(trade_ts: int, now: float | None = None) -> "SeasonState":
    """The current season's standings from MFL, trusted only near the trade.

    Read right after the trade (the bot's case) they can only hold weeks that
    finished before it. Read more than STANDINGS_MAX_LAG_SECONDS later, with
    games played, they may include later weeks, so they are marked unavailable
    instead of being used (a re-grade of an old in-season trade is provisional).
    """
    import time as _time
    season = int(MFL_BASE.rstrip("/").split("/")[-2])
    now = _time.time() if now is None else now
    try:
        rows = mfl_fetch("leagueStandings")["leagueStandings"]["franchise"]
        if isinstance(rows, dict):
            rows = [rows]
        ap = {r["id"]: float(r["all_play_pct"]) for r in rows}
        pf = {r["id"]: float(r["pf"]) for r in rows}
        games = [sum(int(x) for x in str(r["all_play_wlt"]).split("-")) for r in rows]
    except Exception as exc:
        return SeasonState(season, "unavailable",
                           reason=f"MFL leagueStandings unavailable ({exc.__class__.__name__})")
    teams = len(rows)
    weeks = round(statistics_mean(games) / (teams - 1)) if teams > 1 else 0
    if weeks == 0:
        return SeasonState(season, "offseason", as_of=str(int(now)))
    if trade_ts and now - int(trade_ts) > STANDINGS_MAX_LAG_SECONDS:
        hours = (now - int(trade_ts)) / 3600
        return SeasonState(season, "unavailable",
                           reason=(f"{season} standings were read {hours:.0f}h after the trade "
                                   f"and may include later weeks"))
    return SeasonState(season, "in_season", weeks_completed=weeks,
                       allplay_pct=ap, points_for=pf, as_of=str(int(now)))


def statistics_mean(values) -> float:
    values = list(values)
    return sum(values) / len(values) if values else 0.0


def provisional_reasons(*sides: "TradeSide") -> list:
    """Every input problem that changes a pick's value in this trade."""
    out = []
    for side in sides:
        for pk in side.picks_given:
            for issue in pk.value_issues:
                out.append(f"{pk.year} round {pk.round} pick ({pk.original_owner or 'unknown'}): {issue}")
    return out


def provisional_banner(reasons: list) -> str:
    """Fixed (not model-written) warning shown above the roast when the grade
    used inputs it could not trust (Keith 2026-10-20, #1343 decision 2)."""
    if not reasons:
        return ""
    text = "; ".join(dict.fromkeys(reasons))
    if len(text) > 700:
        text = text[:697] + "..."
    return f"⚠️ **Provisional grade, not final.** Inputs the grader could not trust: {text}"


def with_provisional_banner(roast_text: str, reasons: list) -> str:
    banner = provisional_banner(reasons)
    return f"{banner}\n\n{roast_text}" if banner else roast_text


def grade_sides(side_a: "TradeSide", side_b: "TradeSide") -> None:
    """Score both sides with one symmetric function and set value_pts, grade_score
    and grade on each. Zero-sum by construction: side_a's score == -side_b's."""
    a_val = _compute_side_value_pts(side_a)
    b_val = _compute_side_value_pts(side_b)

    # Denominator: total points moved in the trade (sum of both sides' given).
    trade_size_pts = a_val["given_pts"] + b_val["given_pts"]
    if trade_size_pts > 0:
        side_a.grade_score = (a_val["net_pts"] / trade_size_pts) * 100
        side_b.grade_score = (b_val["net_pts"] / trade_size_pts) * 100
    else:
        side_a.grade_score = 0
        side_b.grade_score = 0

    # Stash the breakdowns for downstream display.
    side_a.value_pts = a_val
    side_b.value_pts = b_val

    side_a.grade = compute_grade(side_a.grade_score)
    side_b.grade = compute_grade(side_b.grade_score)


DISPLAY_NOTES = (
    "Auction-price estimates, free-agent comparables and team tiers are not in valuation "
    "snapshot v1, so they are omitted. They never affected the grade.",
    "ADP is not in valuation snapshot v1 and is omitted (rookies' PPG basis names their ADP rank).",
)


def _pick_failures(picks) -> list:
    out = []
    for pk in picks:
        if pk.projection is not None:
            out += [f"{pk.year or '?'} round {pk.round} pick ({pk.original_owner or 'unknown'}): {b}"
                    for b in pk.projection.blocking]
        elif not (1 <= pk.round <= 6 and 1 <= (pk.predicted_slot or 0) <= 12):
            out.append(f"current-year pick round {pk.round} slot {pk.predicted_slot} is not a draft slot")
    return out


def no_grade_report(analysis: "TradeAnalysis") -> str:
    """The owner-facing NO GRADE text ("" when the trade can be graded)."""
    if not analysis.no_grade:
        return ""
    a, b = analysis.side_a, analysis.side_b
    label = f"Trade {analysis.timestamp}: {a.franchise_name} <-> {b.franchise_name}"
    return _vs.no_grade_message(analysis.no_grade_reasons, label)


def analyze_trade(trade_txn: dict, players_map: dict, franchises: dict, rosters: dict,
                  *, season_state=None, snapshot=None, now: float | None = None) -> TradeAnalysis:
    """Full analysis of a single trade transaction, or NO GRADE.

    Grades only on the validated valuation snapshot (decision 3). Any failed
    grade-affecting input (snapshot, freshness, checksums, coverage of a traded
    player or pick, current-season standings a pick needs) returns an analysis
    with no_grade_reasons and no letters or scores.

    season_state: this season's standings as of the trade (read from MFL now
    when omitted). snapshot: an already-loaded snapshot (replays and tests); it
    is validated all the same. now: grading time (freshness).
    """
    import time as _time
    now = _time.time() if now is None else now
    fid_a = trade_txn["franchise"]
    fid_b = trade_txn["franchise2"]
    trade_ts = int(trade_txn.get("timestamp", 0) or 0)
    side_a = TradeSide(franchise_id=fid_a, franchise_name=franchises.get(fid_a, f"Franchise {fid_a}"))
    side_b = TradeSide(franchise_id=fid_b, franchise_name=franchises.get(fid_b, f"Franchise {fid_b}"))
    base = dict(timestamp=trade_ts, comments=trade_txn.get("comments", ""), side_a=side_a, side_b=side_b)

    if season_state is None:
        season_state = load_season_state(trade_ts, now=now)
    live_weeks = season_state.weeks_completed if season_state.status == "in_season" else None
    if snapshot is None:
        snapshot, failures = _vs.load_for_grading(now=now, league_season=LEAGUE_SEASON,
                                                  live_weeks_completed=live_weeks)
    else:
        failures = _vs.validate_snapshot(snapshot, now=now, league_season=LEAGUE_SEASON,
                                         live_weeks_completed=live_weeks)
        if failures:
            from pick_valuation import clear_valuation
            clear_valuation()
        else:
            from pick_valuation import use_snapshot
            use_snapshot(snapshot)
    if failures:
        return TradeAnalysis(**base, no_grade_reasons=[str(f) for f in failures])

    a_gave_players, a_gave_picks, a_gave_sal = parse_asset_string(
        trade_txn.get("franchise1_gave_up", ""), players_map, franchises, season_state)
    b_gave_players, b_gave_picks, b_gave_sal = parse_asset_string(
        trade_txn.get("franchise2_gave_up", ""), players_map, franchises, season_state)
    reasons = [str(f) for f in _vs.trade_coverage(
        snapshot, [p.player_id for p in a_gave_players + b_gave_players])]
    reasons += _pick_failures(a_gave_picks + b_gave_picks)
    side_a.players_given, side_a.picks_given, side_a.salary_given = a_gave_players, a_gave_picks, a_gave_sal
    side_a.players_received, side_a.picks_received, side_a.salary_received = b_gave_players, b_gave_picks, b_gave_sal
    side_b.players_given, side_b.picks_given, side_b.salary_given = b_gave_players, b_gave_picks, b_gave_sal
    side_b.players_received, side_b.picks_received, side_b.salary_received = a_gave_players, a_gave_picks, a_gave_sal
    if reasons:
        return TradeAnalysis(**base, no_grade_reasons=reasons)

    for p in a_gave_players + b_gave_players:
        enrich_player(p, rosters, franchises, snapshot)

    notes = list(DISPLAY_NOTES)
    notes += [n for pk in a_gave_picks + b_gave_picks if pk.projection is not None for n in pk.projection.notes]
    # Cap context (display): MFL salary adjustments so cap space matches MFL's
    # league cap report (Keith 2026-05-22). A failed read is said, not zeroed.
    adjustments = load_salary_adjustments()
    if adjustments is None:
        notes.append("Cap space excludes salary adjustments: MFL salaryAdjustments could not be read.")
        adjustments = {}
    for side in (side_a, side_b):
        if side.franchise_id in rosters:
            roster = rosters[side.franchise_id]
            total_sal = sum(_safe_int(p.get("salary", 0)) for p in roster
                            if p.get("status") != "TAXI_SQUAD")
            adj = adjustments.get(side.franchise_id, 0)
            side.total_roster_salary = total_sal
            side.cap_adjustments = adj
            # MFL convention: positive adj = adds to salary (reduces cap),
            # negative = subtracts from salary (adds cap).
            side.cap_space = 300000 - total_sal - adj

    grade_sides(side_a, side_b)
    return TradeAnalysis(
        **base,
        provisional_reasons=provisional_reasons(side_a, side_b),
        valuation_as_of=f"{snapshot['as_of']} ({snapshot['content_sha256'][:12]})",
        regrade_label=_vs.regrade_label(snapshot, trade_ts),
        display_notes=notes,
    )


def main():
    parser = argparse.ArgumentParser(description="UPS Trade Intelligence Report")
    parser.add_argument("--timestamp", type=int, help="Specific trade timestamp")
    parser.add_argument("--list", action="store_true", help="List recent trades")
    parser.add_argument("--roast-context", action="store_true",
                        help="Output roast context for Claude API")
    parser.add_argument("--extension-years", type=int, default=0,
                        help="Project N-year extension for traded players")
    parser.add_argument("--extension-player", type=str, default="",
                        help="Player ID to project extension for")
    args = parser.parse_args()

    print("Loading league data...", file=sys.stderr)
    franchises = load_franchises()
    players_map = load_players_map()
    rosters = load_rosters()

    trades = fetch_trades()

    if args.list:
        print(f"\n{'Timestamp':<14} {'Team A':<25} {'Team B':<25} Comments")
        print("─" * 90)
        for t in trades:
            fa = franchises.get(t["franchise"], t["franchise"])
            fb = franchises.get(t.get("franchise2", ""), "")
            print(f"{t['timestamp']:<14} {fa:<25} {fb:<25} {t.get('comments','')[:40]}")
        return

    # Select trade
    if args.timestamp:
        trade = next((t for t in trades if int(t["timestamp"]) == args.timestamp), None)
        if not trade:
            print(f"No trade found with timestamp {args.timestamp}", file=sys.stderr)
            sys.exit(1)
    else:
        trade = trades[0] if trades else None
        if not trade:
            print("No trades found", file=sys.stderr)
            sys.exit(1)

    analysis = analyze_trade(trade, players_map, franchises, rosters)
    if analysis.no_grade:
        print(no_grade_report(analysis))
        sys.exit(2)
    all_players = analysis.side_a.players_given + analysis.side_b.players_given

    # Extension projections
    extension_info = {}
    if args.extension_years > 0:
        for p in all_players:
            if args.extension_player and p.player_id != args.extension_player:
                continue
            try:
                ext = calculate_extension(p, args.extension_years)
                extension_info[p.player_id] = ext
            except Exception as e:
                print(f"Warning: Could not calc extension for {p.name}: {e}",
                      file=sys.stderr)

    if args.roast_context:
        print(generate_roast_context(analysis, None, extension_info))
    else:
        print(format_discord_report(analysis, None, extension_info, rosters, players_map, franchises))


if __name__ == "__main__":
    main()
