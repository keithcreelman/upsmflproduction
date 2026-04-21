"""
build_rookie_draft_hub.py — Aggregates data for the Rookie Draft Hub UI.

Outputs 6 JSON artifacts into /New project/site/rookies/:
  1. rookie_draft_tiers.json         — slot-band hit rates (offense/defense/combined)
  2. rookie_draft_history.json       — enriched historical picks (tier + E+P rate per player)
  3. rookie_draft_team_tendencies.json — per-franchise drafting profile
  4. rookie_draft_day_trades.json    — trades within ±24h of each season's rookie draft
  5. rookie_draft_hub_2026.json      — live draft state (order, picks, salaries)
  6. rookie_prospects_2026.json      — 2026 prospect board (ZAP + KTC + ADP merged)

Data sources:
  - MFL API (TYPE=futureDraftPicks, draftResults, league, rosters, players)
  - mfl_database.db (player_weeklyscoringresults, draftresults_mfl, transactions_trades,
                     metadata_positionalwinprofile, rosters_weekly)
  - rookie_draft_history.json (legacy, /Codex/V1/legacy_snapshot/site/acquisition/)
  - zap_scores_2026.json, ktc_sf_values_2026.json (/New project/pipelines/etl/config/)
  - trade_value_model_2026.json (/New project/site/trade-value/)

Run:
    python3 build_rookie_draft_hub.py [--skip-live]
"""

from __future__ import annotations
import argparse
import json
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError

# ── Paths ──────────────────────────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
MFL_DB = ETL_ROOT / "data" / "mfl_database.db"
YOY_DB = ETL_ROOT / "data" / "yoy_signals.db"

NEW_PROJECT = Path("/Users/keithcreelman/Documents/New project")
OUT_DIR = NEW_PROJECT / "site" / "rookies"
ZAP_FILE = NEW_PROJECT / "pipelines" / "etl" / "config" / "zap_scores_2026.json"
KTC_FILE = NEW_PROJECT / "pipelines" / "etl" / "config" / "ktc_sf_values_2026.json"
TRADE_VALUE_MODEL = NEW_PROJECT / "site" / "trade-value" / "trade_value_model_2026.json"

LEGACY_HISTORY = Path(
    "/Users/keithcreelman/Documents/mfl/Codex/V1/legacy_snapshot/site/acquisition/rookie_draft_history.json"
)

# ── MFL API ────────────────────────────────────────────────────────────────
LEAGUE_ID = "74598"
MFL_HOST = "https://www48.myfantasyleague.com"
MFL_APIKEY = "aRBv1sCXvuWpx0OmP13EaDoeFbox"
CURRENT_YEAR = 2026

OFFENSE_POS = {"QB", "RB", "WR", "TE"}
DB_POS = {"CB", "S", "SS", "FS", "DB"}
DL_POS = {"DE", "DT", "DL"}
LB_POS = {"LB", "ILB", "OLB"}
SPECIAL_POS = {"PK", "K", "P", "PN", "ST"}


def _get(url: str, attempts: int = 3) -> dict:
    for i in range(attempts):
        try:
            with urlopen(url, timeout=30) as r:
                return json.loads(r.read())
        except HTTPError as e:
            if i == attempts - 1: raise
            time.sleep(2 * (i + 1))
        except Exception:
            if i == attempts - 1: raise
            time.sleep(2 * (i + 1))
    return {}


def pos_group(position: str) -> str:
    """Return 'offense' / 'defense' / 'special' for pos classification."""
    p = (position or "").upper()
    if p in OFFENSE_POS: return "offense"
    if p in SPECIAL_POS: return "special"
    return "defense"


def pos_subgroup(position: str) -> str:
    """Finer categorization: QB/RB/WR/TE keep their own; defenders consolidate to DB/DL/LB; kickers/punters -> ST."""
    p = (position or "").upper()
    if p in OFFENSE_POS: return p
    if p in DB_POS: return "DB"
    if p in DL_POS: return "DL"
    if p in LB_POS: return "LB"
    if p in SPECIAL_POS: return "ST"
    return p or "?"


# ══════════════════════════════════════════════════════════════════════════
# 1. rookie_draft_tiers.json — slot-band hit rates with off/def split
# ══════════════════════════════════════════════════════════════════════════

# Cache of positional baselines (season, pos_group) -> (p50, delta_win_pos)
_POS_BASELINES: dict[tuple[int, str], tuple[float, float]] = {}

_STARTERS_PER_SEASON_POS: dict[tuple[int, str], int] = {}


def _resolve_starters_per_week(conn: sqlite3.Connection, season: int, pg: str) -> int:
    """How many players at this position are typically started per week in this season.

    Priority:
      1. Empirical count from status='starter' (when populated — 2010-11, 2020+).
      2. League rules from metadata_starters × 12 teams (upper bound of limit_range,
         with a small SF flex bump for QB when the rules allow).
      3. Hard-coded defaults (shouldn't hit for our league).
    """
    key = (int(season), pg)
    if key in _STARTERS_PER_SEASON_POS:
        return _STARTERS_PER_SEASON_POS[key]

    # 1. Empirical — use weeklyresults (has full starter coverage 2012+)
    # Join to player_weeklyscoringresults for pos_group classification.
    rows = conn.execute("""
        SELECT wr.week, COUNT(*)
        FROM weeklyresults wr
        LEFT JOIN player_weeklyscoringresults pws
          ON pws.player_id=wr.player_id AND pws.season=wr.season AND pws.week=wr.week
        WHERE wr.season=? AND pws.pos_group=? AND wr.status='starter'
        GROUP BY wr.week
    """, (season, pg)).fetchall()
    if rows and len(rows) >= 8:
        avg = sum(r[1] for r in rows) / len(rows)
        if avg >= 5:
            n = int(round(avg))
            _STARTERS_PER_SEASON_POS[key] = n
            return n

    # 2. Empirical fallback: use the closest season's actual count (both directions).
    # Gives much more realistic numbers than limit_range * 12 which uses the upper bound.
    all_empirical_rows = conn.execute("""
        SELECT season, week, COUNT(*) FROM player_weeklyscoringresults
        WHERE is_reg=1 AND pos_group=? AND status='starter'
        GROUP BY season, week
    """, (pg,)).fetchall()
    # Build {year: avg_per_week}
    by_year: dict[int, list[int]] = {}
    for ys, _wk, n_ in all_empirical_rows:
        by_year.setdefault(int(ys), []).append(int(n_))
    year_avgs = {y: sum(v)/len(v) for y, v in by_year.items() if len(v) >= 8 and sum(v)/len(v) >= 5}
    if year_avgs:
        nearest = min(year_avgs.keys(), key=lambda y: abs(y - int(season)))
        n = int(round(year_avgs[nearest]))
        _STARTERS_PER_SEASON_POS[key] = n
        return n

    # 3. League rules × 12 teams as last-resort (using min-of-range, not max, to avoid inflation)
    r = conn.execute("""
        SELECT limit_range FROM metadata_starters
        WHERE season=? AND position_name=?
    """, (season, pg)).fetchone()
    if r and r[0]:
        rng = r[0].strip()
        try:
            if "-" in rng:
                lo, hi = rng.split("-", 1)
                lo = int(lo); hi = int(hi)
                # Use mid-point (min + 0.5 team flex)
                n = int(round((lo + (hi - lo) * 0.5) * 12))
            else:
                n = int(rng) * 12
        except ValueError:
            n = 24
        _STARTERS_PER_SEASON_POS[key] = n
        return n

    # 4. Defaults (shouldn't hit for our league)
    fallback = {"QB": 12, "RB": 30, "WR": 41, "TE": 13}.get(pg, 12)
    _STARTERS_PER_SEASON_POS[key] = fallback
    return fallback


def _load_pos_baselines(conn: sqlite3.Connection):
    """Load the league's POSITIONAL WIN-CHUNK baselines.

    The authoritative methodology (used by stored `metadata_positionalwinprofile`
    rows for 2011 and 2020+) is: take every player-week where the player was
    actually STARTED in some team's lineup (weeklyresults.status='starter'),
    take median of those scores for p50, and 80th percentile for p80.

    Earlier we incorrectly backfilled 2012-2019 using top-N NFL scorers per
    week, which made the pre-2020 bar artificially high. This version first
    loads the stored values (preserving 2011 + 2020+ as-is), then backfills
    missing (season, pos_group) using the SAME rostered-starter methodology
    so all eras are comparable.
    """
    if _POS_BASELINES:
        return
    import statistics as _stats

    # First: stored values (trusted — these are league-computed with the
    # rostered-starter methodology)
    for season, pg, p50, delta in conn.execute("""
        SELECT season, pos_group, score_p50_pos, delta_win_pos
        FROM metadata_positionalwinprofile
        WHERE delta_win_pos > 0
    """):
        _POS_BASELINES[(int(season), pg)] = (float(p50), float(delta))

    # Backfill missing (season, pos_group) using the ROSTERED-STARTER methodology:
    # every player-week where the player was actually started in some team's
    # lineup — matches the stored `metadata_positionalwinprofile` approach.
    all_seasons = [r[0] for r in conn.execute(
        "SELECT DISTINCT season FROM player_weeklyscoringresults").fetchall()]
    all_pos_groups = [r[0] for r in conn.execute(
        "SELECT DISTINCT pos_group FROM player_weeklyscoringresults WHERE pos_group IS NOT NULL"
    ).fetchall()]
    # Skip kickers/punters/Def for baseline math — not part of rookie evaluation.
    pos_groups = [pg for pg in all_pos_groups if pg not in ("PK", "PN", "Def")]
    for season in all_seasons:
        for pg in pos_groups:
            if (season, pg) in _POS_BASELINES:
                continue
            rows = conn.execute("""
                SELECT pws.score
                FROM weeklyresults wr
                JOIN player_weeklyscoringresults pws
                  ON pws.player_id=wr.player_id AND pws.season=wr.season AND pws.week=wr.week
                WHERE wr.season=? AND pws.pos_group=? AND wr.status='starter'
                  AND pws.score > 0
            """, (season, pg)).fetchall()
            if len(rows) < 50:
                continue
            starter_scores = sorted(float(r[0]) for r in rows)
            p50 = _stats.median(starter_scores)
            p80_idx = max(0, int(0.8 * len(starter_scores)) - 1)
            p80 = starter_scores[p80_idx]
            delta = max(1.0, p80 - p50)
            _POS_BASELINES[(int(season), pg)] = (p50, delta)


def _weekly_rows(conn: sqlite3.Connection, player_id: str, season: int) -> list[tuple[float, float, float]]:
    """Return (score, p50, delta) for every week the player played (score > 0),
    including regular season AND playoffs — baseline still uses reg-season starters
    per position, which is the standard reference.
    """
    _load_pos_baselines(conn)
    out: list[tuple[float, float, float]] = []
    rows = conn.execute("""
        SELECT score, pos_group
        FROM player_weeklyscoringresults
        WHERE player_id=? AND season=? AND score > 0
    """, (str(player_id), int(season))).fetchall()
    for score, pg in rows:
        baseline = _POS_BASELINES.get((int(season), pg or ""))
        if not baseline:
            continue
        out.append((float(score), baseline[0], baseline[1]))
    return out


def _best_ep_rate(conn: sqlite3.Connection, player_id: str, draft_year: int) -> tuple[float | None, list[tuple[int, float, int, int]]]:
    """Best Elite+Plus rate across the first 4 NFL seasons (min 8 games played).

    Computes z-score inline from raw score + position baselines, independent of
    MFL's 'starter' lineup flag and without requiring the stored win_chunks_pos_vam
    (which is NULL for FA-status weeks — breaking players like Gurley/CMC/Zeke
    who MFL tagged as FA in their rookie years despite being NFL starters).
    """
    best = None
    per_season = []
    for yr in range(int(draft_year), int(draft_year) + 4):
        weeks = _weekly_rows(conn, player_id, yr)
        if len(weeks) < 8:
            continue
        ep_weeks = sum(1 for score, p50, delta in weeks if (score - p50) / delta >= 0.25)
        rate = ep_weeks / len(weeks)
        per_season.append((yr, rate, len(weeks), ep_weeks))
        if best is None or rate > best:
            best = rate
    return best, per_season


def _per_season_production(conn: sqlite3.Connection, player_id: str, draft_year: int) -> list[dict]:
    """Per-season totals for the first 4 NFL seasons using z-score computed inline.

    Includes:
      - games_played
      - mfl_starts:   weeks MFL owners actually started the player
      - ep_rate:      % of played weeks >= +0.25 z (Elite+Plus)
      - dud_rate:     % of played weeks < -0.5 z (Dud)
      - win_chunks:   per-season sum of z-scores (raw win-chunk production)
    """
    out = []
    for yr in range(int(draft_year), int(draft_year) + 4):
        weeks = _weekly_rows(conn, player_id, yr)
        # weeklyresults has proper starter data for 2012-2025.
        # player_weeklyscoringresults.status is all 'fa' for 2012-2019.
        started_row = conn.execute("""
            SELECT COUNT(*) FROM weeklyresults
            WHERE player_id=? AND season=? AND status='starter'
        """, (str(player_id), int(yr))).fetchone()
        mfl_starts = int(started_row[0]) if started_row else 0
        if not weeks:
            out.append({
                "season": yr, "games_played": 0, "mfl_starts": mfl_starts,
                "points": 0.0, "ppg": None,
                "ep_weeks": 0, "ep_rate": None,
                "dud_weeks": 0, "dud_rate": None,
                "ep_when_started": None,
                "win_chunks_sum": 0.0,
            })
            continue
        gp = len(weeks)
        pts = sum(s for s, _, _ in weeks)
        ep = sum(1 for s, p50, d in weeks if (s - p50) / d >= 0.25)
        dud = sum(1 for s, p50, d in weeks if (s - p50) / d < -0.5)
        wc = sum((s - p50) / d for s, p50, d in weeks)
        ep_started = None
        if mfl_starts >= 1:
            # Join weeklyresults (authoritative for starter status) against
            # player_weeklyscoringresults (has z-score).
            r = conn.execute("""
                SELECT COUNT(*), SUM(CASE WHEN pws.win_chunks_pos_vam >= 0.25 THEN 1 ELSE 0 END)
                FROM weeklyresults wr
                LEFT JOIN player_weeklyscoringresults pws
                  ON pws.player_id=wr.player_id AND pws.season=wr.season AND pws.week=wr.week
                WHERE wr.player_id=? AND wr.season=? AND wr.status='starter'
                  AND wr.player_score > 0
            """, (str(player_id), int(yr))).fetchone()
            if r and r[0]:
                ep_started = round((r[1] or 0) / r[0], 3)
        out.append({
            "season": yr,
            "games_played": gp,
            "mfl_starts": mfl_starts,
            "points": round(pts, 1),
            "ppg": round(pts / gp, 2) if gp else None,
            "ep_weeks": ep,
            "ep_rate": round(ep / gp, 3) if gp else None,
            "dud_weeks": dud,
            "dud_rate": round(dud / gp, 3) if gp else None,
            "ep_when_started": ep_started,
            "win_chunks_sum": round(wc, 2),
        })
    return out


def _min_games_for_window(draft_year: int) -> int:
    """60% of the maximum possible regular-season games across the years that
    have ACTUALLY HAPPENED in the player's 3-year rookie window.

    Pre-2021 seasons were 16 games; 2021+ are 17. Playoffs excluded.

    For a 2023 rookie in 2026: all 3 years (2023+2024+2025) are in the books,
      max = 17+17+17 = 51, threshold = round(0.60 * 51) = 31.
    For a 2024 rookie: only 2024+2025 have happened,
      max = 17+17 = 34, threshold = 20.
    For a 2025 rookie: only 2025 has happened,
      max = 17, threshold = 10.

    This prevents tagging 2025 rookies as Injury Bust just because they
    haven't had 3 years to accumulate games yet."""
    total = 0
    for yr in (draft_year, draft_year + 1, draft_year + 2):
        # Only count years that have completed (yr < CURRENT_YEAR).
        # CURRENT_YEAR is the upcoming draft year, so completed seasons are yr < CURRENT_YEAR.
        if yr < CURRENT_YEAR:
            total += 17 if yr >= 2021 else 16
    return int(round(total * 0.60))


def classify_tier(rate: float | None, total_games: int | None = None,
                  draft_year: int | None = None,
                  dud_rate: float | None = None) -> str:
    """Rookie tier classification based on NET = E+P rate MINUS 0.5×Dud rate,
    using games-weighted 3yr averages.

    Rationale (validated against 192 team-seasons 2010-2025):
      - E+P alone correlates with AP% at r=+0.834
      - NET with k=1 (EP - 1×Dud): r=+0.844
      - NET with k=0.5 (EP - 0.5×Dud): r=+0.851  ← OPTIMAL
      - NET with k=2: r=+0.827 (over-penalizes duds)
      Duds matter but only half as much as peaks — tuning k=0.5 gives best fit.

    Tiers anchored to rookie-pool distribution + "thrilled to draft" framing:
      Smash    NET >= +30  (top ~20% — reliably elite, built a team around)
      Hit      NET +15/+30 (next ~18% — more elite weeks than the typical starter)
      Contrib  NET 0/+15   (next ~20% — useful rotational piece)
      Bust     NET < 0     (remainder — duds outweigh peaks, or never played enough)

    No "Injury Bust" carve-out (Option A) — games-weighted averaging already
    adjusts for short samples fairly; low games-played is surfaced via the
    `gp_3yr_total` informational marker in the UI.
    """
    if rate is None:
        return "Bust"
    if dud_rate is not None:
        net = rate - 0.5 * dud_rate
        if net >= 0.30: return "Smash"
        elif net >= 0.15: return "Hit"
        elif net >= 0.00: return "Contrib"
        else: return "Bust"
    # Fallback: EP-rate-only (legacy, shouldn't normally hit)
    if rate >= 0.45: return "Smash"
    elif rate >= 0.30: return "Hit"
    elif rate >= 0.15: return "Contrib"
    return "Bust"


def _rookie_slot_salary(rnd: int, slot: int) -> int:
    """League rookie contract salary schedule.
    R1: linear $15K -> $5K floor at 1.11; R2: $5K flat; R3-R5: $2K; R6: $1K.
    """
    if rnd == 1:
        return max(5000, 16000 - slot * 1000)
    if rnd == 2:
        return 5000
    if rnd in (3, 4, 5):
        return 2000
    return 1000  # R6 option-eligible slot


def _player_photo_url(player_id: str) -> str:
    """MFL photo URL pattern (verified by scraping player profile page).
    The photos live in a stable `player_photos_2014/` directory even for newer
    players — MFL uses this as the canonical photo archive.
    """
    if not player_id:
        return ""
    return f"{MFL_HOST}/player_photos_2014/{player_id}_thumb.jpg"


def _build_active_owner_set(db: sqlite3.Connection) -> set:
    """Return the set of owner_names present in the most recent season's franchises.

    An "active" owner is someone currently rostered/playing in the league.
    A "retired" owner has left (replaced, quit, kicked out, etc.)
    """
    out: set[str] = set()
    try:
        latest = db.execute("SELECT MAX(season) FROM franchises").fetchone()[0]
        for (owner,) in db.execute(
            "SELECT DISTINCT owner_name FROM franchises WHERE season=? AND owner_name IS NOT NULL",
            (latest,)
        ):
            if owner:
                out.add(owner)
    except sqlite3.OperationalError:
        pass
    return out


def _build_owner_map(db: sqlite3.Connection) -> dict:
    """Build (season, franchise_id) -> {owner_name, team_name} from the franchises table.

    CRITICAL: franchise_id ALONE is not a stable identity — the same numeric ID
    can represent different owners across league restructures / replacements. Owner
    name at time of pick is the authoritative team-identity stamp.

    Fallbacks cascade: franchises → transactions_adddrop → transactions_auction.
    """
    out: dict[tuple[int, str], dict] = {}
    try:
        for s, fid, owner, team in db.execute("""
            SELECT season, franchise_id, owner_name, team_name FROM franchises
            WHERE owner_name IS NOT NULL AND franchise_id IS NOT NULL
        """):
            out[(int(s), str(fid))] = {"owner_name": owner, "team_name": team or ""}
    except sqlite3.OperationalError:
        pass
    # Back-fill from add/drop
    for s, fid, owner, fname in db.execute("""
        SELECT season, franchise_id, franchise_owner, franchise_name FROM transactions_adddrop
        WHERE franchise_owner IS NOT NULL AND franchise_id IS NOT NULL
    """):
        key = (int(s), str(fid))
        if key not in out and owner:
            out[key] = {"owner_name": owner, "team_name": fname or ""}
    # Auction
    for s, fid, owner, team in db.execute("""
        SELECT season, franchise_id, owner_name, team_name FROM transactions_auction
        WHERE owner_name IS NOT NULL AND franchise_id IS NOT NULL
    """):
        key = (int(s), str(fid))
        if key not in out and owner:
            out[key] = {"owner_name": owner, "team_name": team or ""}
    return out


def _team_name_norm(name: str) -> str:
    """Normalize a team name for fuzzy matching — lowercase + keep only alnum,
    truncate to a prefix so typos like "Persuasion" vs "Persuasian" still match."""
    import re
    cleaned = re.sub(r"[^a-z0-9]", "", (name or "").lower())
    return cleaned[:15]  # "crystalbluepers" catches both spellings


def _build_team_to_owner_map(db: sqlite3.Connection) -> dict:
    """Build (season, normalized_team_name) -> owner_name.

    Used as a FALLBACK when draftresults rows have blank franchise_id but do
    preserve the team name (e.g. 2017 legacy "The Baster" rows, or 2014-17
    "Crystal Blue Persuasion" rows where the franchises table has the typo'd
    spelling "Persuasian"). Cross-season alias table ensures historical team
    names still resolve to their owner after rename events.
    """
    out: dict[tuple[int, str], str] = {}
    try:
        for s, owner, team in db.execute("""
            SELECT season, owner_name, team_name FROM franchises
            WHERE owner_name IS NOT NULL AND team_name IS NOT NULL
        """):
            norm = _team_name_norm(team)
            if norm:
                out[(int(s), norm)] = owner
    except sqlite3.OperationalError:
        pass
    # Cross-season alias: owner X used team_name Y in season N-1 but drafted
    # under the same banner in season N.
    try:
        owner_aliases: dict[str, set] = {}
        for owner, team in db.execute("""
            SELECT DISTINCT owner_name, team_name FROM franchises
            WHERE owner_name IS NOT NULL AND team_name IS NOT NULL
        """):
            owner_aliases.setdefault(owner, set()).add(_team_name_norm(team))
        all_seasons = [r[0] for r in db.execute(
            "SELECT DISTINCT season FROM draftresults_legacy"
        ).fetchall()]
        for owner, aliases in owner_aliases.items():
            for s in all_seasons:
                for alias in aliases:
                    if alias:
                        out.setdefault((int(s), alias), owner)
    except sqlite3.OperationalError:
        pass
    return out


def _load_legacy_rows(db: sqlite3.Connection) -> list[dict]:
    """Pull all drafted rookies 2012-2025 with position + salary + historically-accurate owner.

    Expected pick counts per season (league rule history):
      2012-2017: 60 picks/year  (R1-R5, 5-round era; no R6)
      2018:      71 picks       (C'mon Son stripped of a pick as league penalty — intentional gap)
      2019-2025: 72 picks/year  (R1-R6 full bracket)
    """
    legacy = json.loads(LEGACY_HISTORY.read_text()).get("history_rows", [])
    by_key: dict[tuple, dict] = {
        (r.get("season"), r.get("draft_round"), r.get("pick_in_round")): r
        for r in legacy
    }
    owner_map = _build_owner_map(db)
    team_to_owner = _build_team_to_owner_map(db)
    active_owners = _build_active_owner_set(db)

    rows = db.execute("""
        SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
               franchise_id, franchise_name, player_id, player_name
        FROM draftresults_legacy
        UNION ALL
        SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
               franchise_id, franchise_name, player_id, player_name
        FROM draftresults_mfl
        ORDER BY season, draftpick_round, draftpick_roundorder
    """).fetchall()

    # Position AT DRAFT YEAR — players can change position mid-career (e.g., Jordan
    # Matthews was a WR when drafted but converted later). Use the player's position
    # as recorded in their rookie/early seasons in player_weeklyscoringresults.
    pos_map: dict[tuple[str, int], str] = {}
    for pid, season, pos in db.execute("""
        SELECT CAST(player_id AS TEXT), season, pos_group
        FROM player_weeklyscoringresults
        WHERE pos_group IS NOT NULL AND score > 0
        GROUP BY player_id, season, pos_group
    """):
        pos_map.setdefault((str(pid), int(season)), (pos or "").upper())

    def _resolve_position(pid: str, draft_year: int) -> str:
        """Pick the position the player held at (or closest to) their draft year.
        Falls back to any season's recorded position if the rookie year isn't indexed."""
        if not pid:
            return ""
        # Exact draft year
        p = pos_map.get((pid, draft_year))
        if p:
            return p
        # Scan forward within the 3-year window
        for off in (1, 2):
            p = pos_map.get((pid, draft_year + off))
            if p:
                return p
        # Last resort: any season the player appears in
        for (other_pid, _s), p in pos_map.items():
            if other_pid == pid and p:
                return p
        return ""

    # Photos derived from stable MFL URL pattern (scraped from profile page)

    out: list[dict] = []
    for season, rnd, slot, overall, fid, fname, pid, pname in rows:
        # Upstream ETL bug: draftresults_legacy stored raw_pick="1.1" (meaning slot 10)
        # as slot=1. Always derive slot from overall for 12-team correctness.
        true_slot = None
        if overall and rnd:
            true_slot = ((int(overall) - 1) % 12) + 1
        elif slot:
            true_slot = int(slot)
        key = (int(season), int(rnd) if rnd else None, true_slot)
        legacy_match = by_key.get(key) or by_key.get((int(season), int(rnd) if rnd else None, int(slot) if slot else None), {})
        pos = _resolve_position(str(pid) if pid else "", int(season)) or legacy_match.get("position", "") or ""
        owner_info = owner_map.get((int(season), str(fid)), {}) if fid else {}
        # Resolve owner with priority:
        #   1. (season, franchise_id) match from the authoritative franchises table
        #   2. If franchise_id is BLANK, normalize the draft-row's franchise_name and
        #      look up in team_to_owner (handles legacy "The Baster" / "Crystal Blue
        #      Persuasion" rows that never had franchise_id populated).
        #   3. Only fall back to legacy_match.owner_name as a last resort — the
        #      legacy JSON has known mis-attributions on blank-fid rows.
        resolved_owner = owner_info.get("owner_name") or ""
        if not resolved_owner and fname:
            resolved_owner = team_to_owner.get((int(season), _team_name_norm(fname)), "")
        if not resolved_owner:
            resolved_owner = legacy_match.get("owner_name", "")
        resolved_team = owner_info.get("team_name") or fname
        out.append({
            "season": int(season),
            "draft_round": int(rnd) if rnd else None,
            "pick_in_round": true_slot,
            "pick_overall": int(overall) if overall else None,
            "franchise_id": fid,
            "franchise_name": resolved_team,
            "owner_name": resolved_owner,
            "owner_active": bool(resolved_owner and resolved_owner in active_owners),
            "player_id": str(pid) if pid else "",
            "player_name": pname,
            "position": pos,
            "icon_url": _player_photo_url(str(pid) if pid else ""),
            "salary": legacy_match.get("salary") or _rookie_slot_salary(int(rnd or 0), int(true_slot or 0)),
            "rookie_value_score": legacy_match.get("rookie_value_score"),
            "hit_flag": legacy_match.get("hit_flag"),
        })
    return out


TIER_SCORE = {"Smash": 4, "Hit": 3, "Contrib": 2, "Injury Bust": 1, "Bust": 0}

# Cache: (pos_group, start_year, end_year) -> {pid: {rank_total, rank_ppg, total_pts, ppg, games}}
_POS_RANK_CACHE: dict[tuple, dict] = {}
# Per-season positional rankings by all four metrics.
_SEASON_RANK_CACHE: dict[tuple, dict] = {}


def _compute_pos_ranks(conn: sqlite3.Connection, pos_group: str, start_year: int, end_year: int) -> dict:
    """Rank players at position over a 3-year window (used for 3yr-window-total/ppg ranks)."""
    key = (pos_group, int(start_year), int(end_year))
    if key in _POS_RANK_CACHE:
        return _POS_RANK_CACHE[key]
    rows = conn.execute("""
        SELECT CAST(player_id AS TEXT),
               SUM(score) AS total,
               COUNT(*)   AS games
        FROM player_weeklyscoringresults
        WHERE season BETWEEN ? AND ? AND pos_group=? AND score > 0
        GROUP BY player_id
        HAVING games >= 10
    """, (start_year, end_year, pos_group)).fetchall()
    entries = []
    for pid, total, games in rows:
        ppg = (total or 0) / games if games else 0
        entries.append({"player_id": pid, "total_pts": float(total or 0),
                        "games": int(games), "ppg": float(ppg)})
    for i, e in enumerate(sorted(entries, key=lambda x: -x["total_pts"]), 1):
        e["rank_total"] = i
    ppg_pool = [e for e in entries if e["games"] >= 16]
    for i, e in enumerate(sorted(ppg_pool, key=lambda x: -x["ppg"]), 1):
        e["rank_ppg"] = i
    out = {e["player_id"]: e for e in entries}
    _POS_RANK_CACHE[key] = out
    return out


def _compute_season_ranks(conn: sqlite3.Connection, pos_group: str, season: int) -> dict:
    """For a single season + position, rank every player by:
      - total points
      - PPG (min 8 games)
      - E+P rate (min 8 games)
      - win chunks sum (min 8 games)

    Returns {player_id: {rank_total, rank_ppg, rank_ep, rank_wc}}.
    """
    key = (pos_group, int(season))
    if key in _SEASON_RANK_CACHE:
        return _SEASON_RANK_CACHE[key]
    _load_pos_baselines(conn)
    baseline = _POS_BASELINES.get((int(season), pos_group))
    if not baseline:
        _SEASON_RANK_CACHE[key] = {}
        return {}
    p50, delta = baseline
    # Pull every player's weekly scores for this season+pos
    rows = conn.execute("""
        SELECT CAST(player_id AS TEXT) as pid, score
        FROM player_weeklyscoringresults
        WHERE season=? AND pos_group=? AND score > 0
    """, (season, pos_group)).fetchall()
    by_pid: dict[str, list[float]] = {}
    for pid, score in rows:
        by_pid.setdefault(pid, []).append(float(score))
    entries = []
    for pid, scores in by_pid.items():
        gp = len(scores)
        total = sum(scores)
        ppg = total / gp if gp else 0
        ep = sum(1 for s in scores if (s - p50) / delta >= 0.25) / gp if gp else 0
        wc = sum((s - p50) / delta for s in scores)
        entries.append({"player_id": pid, "games": gp, "total": total,
                        "ppg": ppg, "ep": ep, "wc": wc})
    # Rank by total (all, no min)
    for i, e in enumerate(sorted(entries, key=lambda x: -x["total"]), 1):
        e["rank_total"] = i
    # PPG/EP/WC: min 8 games so single-game booms don't flood the top
    pool = [e for e in entries if e["games"] >= 8]
    for i, e in enumerate(sorted(pool, key=lambda x: -x["ppg"]), 1):
        e["rank_ppg"] = i
    for i, e in enumerate(sorted(pool, key=lambda x: -x["ep"]), 1):
        e["rank_ep"] = i
    for i, e in enumerate(sorted(pool, key=lambda x: -x["wc"]), 1):
        e["rank_wc"] = i
    out = {e["player_id"]: e for e in entries}
    _SEASON_RANK_CACHE[key] = out
    return out


def _mfl_profile_url(player_id: str, year: int = CURRENT_YEAR) -> str:
    if not player_id: return ""
    return f"{MFL_HOST}/{year}/player?L={LEAGUE_ID}&P={player_id}"


def build_tiers_and_history(db: sqlite3.Connection) -> tuple[dict, list[dict]]:
    """Build both rookie_draft_tiers.json and enriched rookie_draft_history.json in one pass."""
    legacy_rows = _load_legacy_rows(db)

    # Enrich each row with E+P rate + tier
    enriched: list[dict] = []
    tiers_by_key: dict[tuple, list[str]] = defaultdict(list)

    for r in legacy_rows:
        rnd = r.get("draft_round")
        slot = r.get("pick_in_round")
        yr = r.get("season")
        pid = str(r.get("player_id") or "")
        if not (rnd and slot and yr and pid):
            continue
        pos = (r.get("position") or "").upper()
        pg = pos_group(pos)
        sub = pos_subgroup(pos)
        # Legacy: best-year E+P rate retained for reference only; tier classification
        # now uses the 3-year AVERAGE E+P rate (computed below) per user request.
        best_rate, _ = _best_ep_rate(db, pid, yr)
        seasons = _per_season_production(db, pid, yr)

        # Build Y1/Y2/Y3 + totals from our pipeline (authoritative over legacy)
        points_y1 = seasons[0]["points"] if len(seasons) > 0 else None
        points_y2 = seasons[1]["points"] if len(seasons) > 1 else None
        points_y3 = seasons[2]["points"] if len(seasons) > 2 else None
        ppg_y1 = seasons[0]["ppg"] if len(seasons) > 0 else None
        ppg_y2 = seasons[1]["ppg"] if len(seasons) > 1 else None
        ppg_y3 = seasons[2]["ppg"] if len(seasons) > 2 else None
        ep_y1 = seasons[0]["ep_rate"] if len(seasons) > 0 else None
        ep_y2 = seasons[1]["ep_rate"] if len(seasons) > 1 else None
        ep_y3 = seasons[2]["ep_rate"] if len(seasons) > 2 else None
        wc_y1 = seasons[0]["win_chunks_sum"] if len(seasons) > 0 else None
        wc_y2 = seasons[1]["win_chunks_sum"] if len(seasons) > 1 else None
        wc_y3 = seasons[2]["win_chunks_sum"] if len(seasons) > 2 else None
        gp_y1 = seasons[0]["games_played"] if len(seasons) > 0 else 0
        gp_y2 = seasons[1]["games_played"] if len(seasons) > 1 else 0
        gp_y3 = seasons[2]["games_played"] if len(seasons) > 2 else 0
        mfl_y1 = seasons[0].get("mfl_starts", 0) if len(seasons) > 0 else 0
        mfl_y2 = seasons[1].get("mfl_starts", 0) if len(seasons) > 1 else 0
        mfl_y3 = seasons[2].get("mfl_starts", 0) if len(seasons) > 2 else 0
        dud_y1 = seasons[0].get("dud_rate") if len(seasons) > 0 else None
        dud_y2 = seasons[1].get("dud_rate") if len(seasons) > 1 else None
        dud_y3 = seasons[2].get("dud_rate") if len(seasons) > 2 else None
        ep_started_y1 = seasons[0].get("ep_when_started") if len(seasons) > 0 else None
        ep_started_y2 = seasons[1].get("ep_when_started") if len(seasons) > 1 else None
        ep_started_y3 = seasons[2].get("ep_when_started") if len(seasons) > 2 else None
        total_pts = sum((p or 0) for p in (points_y1, points_y2, points_y3))
        total_gp = gp_y1 + gp_y2 + gp_y3
        total_mfl_starts = mfl_y1 + mfl_y2 + mfl_y3
        avg_ppg = round(total_pts / total_gp, 2) if total_gp else None
        # 3yr aggregates: GAMES-WEIGHTED averages across the rookie window.
        # Simple avg was giving 2-game seasons equal weight to 15-game seasons,
        # which over-punished players like Saquon 2018 (15/12/2gp → artificially
        # dragged down by tiny Y3 sample) and over-rewarded Bosa 2019 (14/1/16 →
        # tiny ACL Y2 inflated sim avg). Games-weighted respects sample size.
        def _wavg(vals, weights):
            pool = [(v, w) for v, w in zip(vals, weights) if v is not None and w]
            tot = sum(w for _, w in pool)
            return round(sum(v * w for v, w in pool) / tot, 3) if tot else None
        gps = [gp_y1, gp_y2, gp_y3]
        ep_rate_3yr_avg = _wavg([ep_y1, ep_y2, ep_y3], gps)
        dud_rate_3yr_avg = _wavg([dud_y1, dud_y2, dud_y3], gps)
        wc_3yr_avg = _wavg([wc_y1, wc_y2, wc_y3], gps)
        # 3yr avg of totals (for "avg season points")
        avg_season_pts_3yr = round(total_pts / 3, 1) if total_pts else None
        # Positional rank across the player's 3-year rookie window (total/PPG cumulative)
        rank_group = sub  # WR/RB/QB/TE/etc.
        pos_ranks_3yr = _compute_pos_ranks(db, rank_group, int(yr), int(yr) + 2)
        rk3 = pos_ranks_3yr.get(pid, {})
        pos_rank_total_3yr = rk3.get("rank_total")
        pos_rank_ppg_3yr = rk3.get("rank_ppg")
        pos_rank_total_label = f"{sub}{pos_rank_total_3yr}" if pos_rank_total_3yr else None
        pos_rank_ppg_label = f"{sub}{pos_rank_ppg_3yr}" if pos_rank_ppg_3yr else None

        # Per-year positional ranks across 4 metrics
        yearly_ranks = [_compute_season_ranks(db, rank_group, int(yr) + i) for i in range(3)]
        def _rank_of(i, key):
            return yearly_ranks[i].get(pid, {}).get(key) if i < len(yearly_ranks) else None
        pts_rk_y1 = _rank_of(0, "rank_total"); pts_rk_y2 = _rank_of(1, "rank_total"); pts_rk_y3 = _rank_of(2, "rank_total")
        ppg_rk_y1 = _rank_of(0, "rank_ppg");   ppg_rk_y2 = _rank_of(1, "rank_ppg");   ppg_rk_y3 = _rank_of(2, "rank_ppg")
        ep_rk_y1  = _rank_of(0, "rank_ep");    ep_rk_y2  = _rank_of(1, "rank_ep");    ep_rk_y3  = _rank_of(2, "rank_ep")
        wc_rk_y1  = _rank_of(0, "rank_wc");    wc_rk_y2  = _rank_of(1, "rank_wc");    wc_rk_y3  = _rank_of(2, "rank_wc")
        # Games-weighted average — a rank of 50 based on 1 game should weigh
        # much less than a rank of 5 based on 15 games.
        def _wavg_rank(vals, weights):
            pool = [(v, w) for v, w in zip(vals, weights) if v is not None and w]
            tot = sum(w for _, w in pool)
            return round(sum(v * w for v, w in pool) / tot, 1) if tot else None
        _gps = [gp_y1, gp_y2, gp_y3]
        avg_pts_rank = _wavg_rank([pts_rk_y1, pts_rk_y2, pts_rk_y3], _gps)
        avg_ppg_rank = _wavg_rank([ppg_rk_y1, ppg_rk_y2, ppg_rk_y3], _gps)
        avg_ep_rank  = _wavg_rank([ep_rk_y1, ep_rk_y2, ep_rk_y3], _gps)
        avg_wc_rank  = _wavg_rank([wc_rk_y1, wc_rk_y2, wc_rk_y3], _gps)

        # Tier classification: NET = weighted 3yr E+P − 0.5×(weighted 3yr Dud).
        # Smash ≥ +30, Hit +15 to +30, Contrib 0 to +15, Bust < 0.
        # No "Injury Bust" — weighted avg + gp_3yr_total marker handles low-sample cases.
        net_score = None
        if ep_rate_3yr_avg is not None and dud_rate_3yr_avg is not None:
            net_score = round(ep_rate_3yr_avg - 0.5 * dud_rate_3yr_avg, 3)
        tier = classify_tier(ep_rate_3yr_avg, total_gp, int(yr), dud_rate_3yr_avg)
        # Years of data used for this NET — lets the UI flag "only 1yr sample" for recent rookies
        years_of_data = sum(1 for g in (gp_y1, gp_y2, gp_y3) if g and g > 0)
        total_gp_window = int(gp_y1 or 0) + int(gp_y2 or 0) + int(gp_y3 or 0)

        row_out = {
            "season": int(yr),
            "round": int(rnd),
            "slot": int(slot),
            "pick_label": f"{int(rnd)}.{int(slot):02d}",
            "pick_overall": r.get("pick_overall"),
            "franchise_id": r.get("franchise_id"),
            "franchise_name": r.get("franchise_name"),
            "owner_name": r.get("owner_name"),
            "owner_active": bool(r.get("owner_active")),
            "player_id": pid,
            "player_name": r.get("player_name"),
            "position": pos,
            "pos_subgroup": sub,
            "pos_group": pg,
            "profile_url": _mfl_profile_url(pid, int(yr)),
            "icon_url": r.get("icon_url") or "",
            "salary": r.get("salary"),
            "points_y1": points_y1, "points_y2": points_y2, "points_y3": points_y3,
            "ppg_y1": ppg_y1, "ppg_y2": ppg_y2, "ppg_y3": ppg_y3,
            "ep_y1": ep_y1, "ep_y2": ep_y2, "ep_y3": ep_y3,
            "dud_y1": dud_y1, "dud_y2": dud_y2, "dud_y3": dud_y3,
            "wc_y1": wc_y1, "wc_y2": wc_y2, "wc_y3": wc_y3,
            "gp_y1": gp_y1, "gp_y2": gp_y2, "gp_y3": gp_y3,
            "mfl_starts_y1": mfl_y1, "mfl_starts_y2": mfl_y2, "mfl_starts_y3": mfl_y3,
            "ep_started_y1": ep_started_y1, "ep_started_y2": ep_started_y2, "ep_started_y3": ep_started_y3,
            "total_mfl_starts": total_mfl_starts,
            "points_3yr_total": round(total_pts, 1),
            "avg_ppg_3yr": avg_ppg,
            "avg_season_pts_3yr": avg_season_pts_3yr,  # 3yr total / 3 (per-season avg of totals)
            "wc_3yr_total": round(sum((w or 0) for w in (wc_y1, wc_y2, wc_y3)), 2),
            "wc_3yr_avg": wc_3yr_avg,
            "ep_rate_3yr_avg": ep_rate_3yr_avg,
            "dud_rate_3yr_avg": dud_rate_3yr_avg,
            "net_score_3yr": net_score,  # NET = E+P − 0.5*Dud (tier classification metric)
            "years_of_data": years_of_data,  # 1/2/3 — tells UI to show sample-size caveat
            "total_gp_window": total_gp_window,
            "pos_rank_total_3yr": pos_rank_total_3yr,
            "pos_rank_total_label": pos_rank_total_label,
            "pos_rank_ppg_3yr": pos_rank_ppg_3yr,
            "pos_rank_ppg_label": pos_rank_ppg_label,
            "best_ep_rate": round(best_rate, 3) if best_rate is not None else None,
            # Per-year positional ranks (by pts/PPG/E+P/WC among players at same position)
            "pts_rank_y1": pts_rk_y1, "pts_rank_y2": pts_rk_y2, "pts_rank_y3": pts_rk_y3,
            "ppg_rank_y1": ppg_rk_y1, "ppg_rank_y2": ppg_rk_y2, "ppg_rank_y3": ppg_rk_y3,
            "ep_rank_y1": ep_rk_y1, "ep_rank_y2": ep_rk_y2, "ep_rank_y3": ep_rk_y3,
            "wc_rank_y1": wc_rk_y1, "wc_rank_y2": wc_rk_y2, "wc_rank_y3": wc_rk_y3,
            "pts_rank_3yr_avg": avg_pts_rank,
            "ppg_rank_3yr_avg": avg_ppg_rank,
            "ep_rank_3yr_avg": avg_ep_rank,
            "wc_rank_3yr_avg": avg_wc_rank,
            "tier": tier,
            "rookie_value_score": r.get("rookie_value_score"),
            "hit_flag": r.get("hit_flag"),
            # Legacy MFL-starts column preserved (pre-2018 where our scoring DB is sparse)
            "starts_y1": r.get("starts_y1"),
            "starts_y2": r.get("starts_y2"),
            "starts_y3": r.get("starts_y3"),
        }
        enriched.append(row_out)

        # For tiers — build band
        if slot <= 4: band = f"{rnd}.01-04"
        elif slot <= 8: band = f"{rnd}.05-08"
        else: band = f"{rnd}.09-12"
        # Combined bucket
        tiers_by_key[(band, "combined")].append(tier)
        # Off/def bucket
        tiers_by_key[(band, pg)].append(tier)
        # Per-slot for rounds 1-3
        if rnd <= 3:
            slot_label = f"{rnd}.{slot:02d}"
            tiers_by_key[(slot_label, "combined")].append(tier)
            tiers_by_key[(slot_label, pg)].append(tier)

    # Build tier summary JSON
    tiers_summary: dict = {}
    for (key, group), tier_list in tiers_by_key.items():
        n = len(tier_list)
        if n == 0:
            continue
        c = Counter(tier_list)
        smash = c.get("Smash", 0)
        hit = c.get("Hit", 0)
        contrib = c.get("Contrib", 0)
        bust = c.get("Bust", 0)
        tiers_summary.setdefault(key, {})[group] = {
            "n": n,
            "smash": smash, "hit": hit, "contrib": contrib, "bust": bust,
            "smash_pct": round(smash / n, 3),
            "hit_pct": round(hit / n, 3),
            "contrib_pct": round(contrib / n, 3),
            "bust_pct": round(bust / n, 3),
            "usable_pct": round((smash + hit) / n, 3),
        }

    # Per-slot expected values — median of historical picks at that (round, slot).
    # Used to flag over/underperformers relative to the slot's floor.
    import statistics as _stats
    metric_buckets: dict[str, dict[tuple, list[float]]] = {
        "points_3yr_total": defaultdict(list),
        "ep_rate_3yr_avg": defaultdict(list),
        "dud_rate_3yr_avg": defaultdict(list),
        "wc_3yr_avg": defaultdict(list),
        "pos_rank_total_3yr": defaultdict(list),
        "pos_rank_ppg_3yr": defaultdict(list),
        "net_score_3yr": defaultdict(list),  # expected-NET-by-slot for Draft Rating
    }
    for row in enriched:
        k = (row["round"], row["slot"])
        for metric in metric_buckets:
            v = row.get(metric)
            if v is not None and v != 0:
                metric_buckets[metric][k].append(float(v))
    expected_by_slot: dict[str, dict[tuple, float]] = {m: {} for m in metric_buckets}
    for metric, bucket in metric_buckets.items():
        for k, vals in bucket.items():
            if vals:
                expected_by_slot[metric][k] = _stats.median(vals)

    for row in enriched:
        k = (row["round"], row["slot"])
        exp_pts = expected_by_slot["points_3yr_total"].get(k, 0.0)
        row["expected_points_3yr"] = round(exp_pts, 1)
        row["value_above_expected"] = round((row["points_3yr_total"] or 0) - exp_pts, 1)
        # E+P rate vs expected
        exp_ep = expected_by_slot["ep_rate_3yr_avg"].get(k)
        row["expected_ep_rate_3yr"] = round(exp_ep, 3) if exp_ep is not None else None
        row["ep_rate_vs_expected"] = (
            round((row["ep_rate_3yr_avg"] or 0) - exp_ep, 3) if row.get("ep_rate_3yr_avg") is not None and exp_ep is not None else None
        )
        # Dud rate vs expected (lower is better — so expected - actual = how much better)
        exp_dud = expected_by_slot["dud_rate_3yr_avg"].get(k)
        row["expected_dud_rate_3yr"] = round(exp_dud, 3) if exp_dud is not None else None
        row["dud_rate_vs_expected"] = (
            round((row["dud_rate_3yr_avg"] or 0) - exp_dud, 3) if row.get("dud_rate_3yr_avg") is not None and exp_dud is not None else None
        )
        # Win Chunks 3yr avg vs expected
        exp_wc = expected_by_slot["wc_3yr_avg"].get(k)
        row["expected_wc_3yr_avg"] = round(exp_wc, 2) if exp_wc is not None else None
        row["wc_3yr_avg_vs_expected"] = (
            round((row["wc_3yr_avg"] or 0) - exp_wc, 2) if row.get("wc_3yr_avg") is not None and exp_wc is not None else None
        )
        # Positional rank vs expected (lower/better rank = positive delta)
        exp_pr_total = expected_by_slot["pos_rank_total_3yr"].get(k)
        row["expected_pos_rank_total"] = round(exp_pr_total) if exp_pr_total is not None else None
        row["pos_rank_total_vs_expected"] = (
            round(exp_pr_total - row["pos_rank_total_3yr"]) if row.get("pos_rank_total_3yr") is not None and exp_pr_total is not None else None
        )
        exp_pr_ppg = expected_by_slot["pos_rank_ppg_3yr"].get(k)
        row["expected_pos_rank_ppg"] = round(exp_pr_ppg) if exp_pr_ppg is not None else None
        row["pos_rank_ppg_vs_expected"] = (
            round(exp_pr_ppg - row["pos_rank_ppg_3yr"]) if row.get("pos_rank_ppg_3yr") is not None and exp_pr_ppg is not None else None
        )
        # Draft Rating: actual NET vs slot-expected NET. Late-round smashes weighted
        # heavier because the slot's expected NET is low/negative — hitting big from
        # 5.08 is more impressive than hitting from 1.01. Expressed in "NET points
        # above expected for slot", positive = outperformed slot, negative = under.
        exp_net = expected_by_slot["net_score_3yr"].get(k)
        row["expected_net_3yr"] = round(exp_net, 3) if exp_net is not None else None
        row["draft_rating"] = (
            round((row.get("net_score_3yr") or 0) - exp_net, 3)
            if row.get("net_score_3yr") is not None and exp_net is not None else None
        )
        # Per-pick slot percentile: how this pick's NET ranks among every historical
        # pick at the same (round, slot). 100 = best ever at that slot; 50 = median;
        # 0 = worst. More interpretable than raw Draft Rating for individual picks.
        slot_nets = metric_buckets["net_score_3yr"].get(k, [])
        if row.get("net_score_3yr") is not None and slot_nets:
            below = sum(1 for n in slot_nets if n < row["net_score_3yr"])
            row["slot_percentile"] = round(below / len(slot_nets) * 100, 1)
        else:
            row["slot_percentile"] = None
        # Composite score for "best pick" ranking.
        # Primary: tier (Smash > Hit > Contrib > Bust). Tiebreaker: Draft Rating
        # (NET Δ vs slot-expected NET). Draft Rating aligns with how we grade
        # owners on the Team Tendencies cards, so Best / Worst / Bang-for-$ stay
        # internally consistent. Fallback to value_above_expected (points Δ) if
        # no Draft Rating is available.
        dr = row.get("draft_rating")
        tier_component = TIER_SCORE.get(row["tier"], 0) * 1000
        tiebreaker = dr if dr is not None else (row["value_above_expected"] / 1000)
        row["overall_score"] = round(tier_component + tiebreaker, 3)

    tiers_artifact = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "source": "rookie_draft_history 2015-2025 via player_weeklyscoringresults",
            "methodology": {
                "smash_threshold": "best Elite+Plus rate >= 55% across first 4 seasons, min 8 starts/season",
                "hit_threshold": "35%-55%",
                "contrib_threshold": "20%-35%",
                "bust_threshold": "<20% or never cracked a starting lineup with 8+ starts",
                "offense_positions": sorted(OFFENSE_POS),
            },
        },
        "bands": tiers_summary,
    }
    return tiers_artifact, enriched


# ══════════════════════════════════════════════════════════════════════════
# 3. rookie_draft_team_tendencies.json — per-franchise drafting profile
# ══════════════════════════════════════════════════════════════════════════

def _compact_pick(r: dict | None) -> dict | None:
    if not r: return None
    return {
        "season": r.get("season"),
        "slot": r.get("pick_label"),
        "player": r.get("player_name"),
        "position": r.get("position"),
        "tier": r.get("tier"),
        "points_3yr": r.get("points_3yr_total"),
        "expected_3yr": r.get("expected_points_3yr"),
        "value_above_expected": r.get("value_above_expected"),
        "overall_score": r.get("overall_score"),
    }


def build_team_tendencies(history_rows: list[dict]) -> dict:
    # Group by OWNER_NAME, not franchise_id.
    # Franchise IDs are recycled across league restructures and owner replacements,
    # so aggregating by id would combine e.g. Kyle Creelman's 2012 BTNH picks with
    # Eric Martel's 2023+ HammerTime picks. Owner name gives us true tenure slices.
    by_team: dict[str, list[dict]] = defaultdict(list)
    for r in history_rows:
        owner = r.get("owner_name") or "(Unknown owner)"
        by_team[owner].append(r)

    teams: dict = {}
    for fid, rows in by_team.items():
        if not rows:
            continue
        n = len(rows)
        tiers = Counter(r["tier"] for r in rows)
        positions = Counter(r["position"] for r in rows)
        pos_groups = Counter(r["pos_group"] for r in rows)

        hit_plus = tiers.get("Smash", 0) + tiers.get("Hit", 0)
        rvs_vals = [r["rookie_value_score"] for r in rows if r.get("rookie_value_score") is not None]
        avg_rvs = round(sum(rvs_vals) / len(rvs_vals), 2) if rvs_vals else None
        # DRAFT RATING: avg (actual NET − slot-expected NET) per pick.
        # RAW = unsmoothed average. Good owners score positive (outperform slots),
        # bad ones negative. Small-sample owners get noisy extremes — mitigated below.
        dr_vals = [r["draft_rating"] for r in rows if r.get("draft_rating") is not None]
        draft_rating_raw = round(sum(dr_vals) / len(dr_vals), 3) if dr_vals else None

        # Best / Worst: highest / lowest 3yr NET. NET is the single best predictor
        # of All-Play winning % (r = +0.850 across 192 team-seasons), so it's the
        # right metric to grade "this is the pick that helped/hurt the team most".
        # Draft slot doesn't matter here — raw impact on winning does.
        net_rows = [r for r in rows if r.get("net_score_3yr") is not None]
        sorted_by_net = sorted(net_rows, key=lambda x: -x["net_score_3yr"])
        best = sorted_by_net[0] if sorted_by_net else None
        worst = sorted_by_net[-1] if sorted_by_net else None
        # Bang-for-$: highest Draft Rating (NET Δ vs slot). Slot-aware — rewards
        # late-round smashes even if their absolute NET is less than a 1.01 Smash.
        bang_rows = [r for r in rows if r.get("draft_rating") is not None]
        bang = max(bang_rows, key=lambda r: r["draft_rating"], default=None)

        # Per-round breakdown
        per_round: dict = {}
        for rnd in (1, 2, 3, 4, 5, 6):
            round_rows = [r for r in rows if r["round"] == rnd]
            if not round_rows:
                continue
            rt = Counter(r["tier"] for r in round_rows)
            per_round[str(rnd)] = {
                "n": len(round_rows),
                "smash_pct": round(rt.get("Smash", 0) / len(round_rows), 3),
                "hit_pct": round(rt.get("Hit", 0) / len(round_rows), 3),
                "usable_pct": round((rt.get("Smash", 0) + rt.get("Hit", 0)) / len(round_rows), 3),
            }

        # Use latest season's data for the card header
        latest = max(rows, key=lambda r: r.get("season", 0))
        seasons_range = sorted({r.get("season") for r in rows})
        tenure_label = f"{seasons_range[0]}-{seasons_range[-1]}" if seasons_range else "?"
        # All team_names this owner fielded (chronological)
        name_history = []
        for r in sorted(rows, key=lambda x: x.get("season", 0)):
            tn = r.get("franchise_name")
            if tn and (not name_history or name_history[-1] != tn):
                name_history.append(tn)

        is_active = any(r.get("owner_active") for r in rows)
        teams[fid] = {
            "owner_name": fid,  # `fid` here is actually owner_name (group key)
            "is_active": is_active,
            "tenure": tenure_label,
            "team_names": name_history,
            "current_team_name": name_history[-1] if name_history else "",
            "franchise_id": latest.get("franchise_id"),
            "franchise_name": latest.get("franchise_name"),
            "picks_made": n,
            "smash": tiers.get("Smash", 0),
            "hit": tiers.get("Hit", 0),
            "contrib": tiers.get("Contrib", 0),
            "injury_bust": tiers.get("Injury Bust", 0),
            "bust": tiers.get("Bust", 0),
            "smash_rate": round(tiers.get("Smash", 0) / n, 3),
            "hit_plus_rate": round(hit_plus / n, 3),
            "bust_rate": round(tiers.get("Bust", 0) / n, 3),
            "injury_bust_rate": round(tiers.get("Injury Bust", 0) / n, 3),
            "avg_rookie_value_score": avg_rvs,
            "draft_rating_raw": draft_rating_raw,
            "draft_rating_n_picks": len(dr_vals),
            # draft_rating_shrunk + draft_rating_100 computed AFTER the owner loop
            # (needs league-wide distribution to anchor the 0-100 scale).
            "position_mix": {p: round(v / n, 3) for p, v in positions.most_common()},
            "offense_pct": round(pos_groups.get("offense", 0) / n, 3),
            "defense_pct": round(pos_groups.get("defense", 0) / n, 3),
            "per_round": per_round,
            "best_pick": _compact_pick(best),
            "worst_pick": _compact_pick(worst),
            "best_bang_for_buck": _compact_pick(bang),
        }

    # ─────────────────────────────────────────────────────────────────────
    # DRAFT RATING SHRINKAGE + 0-100 NORMALIZATION
    # ─────────────────────────────────────────────────────────────────────
    # Small-sample owners (e.g. John Richard/Jarrade with 7 picks at +32.7 raw)
    # get noisy extremes. We apply Bayesian-style shrinkage: blend each owner's
    # raw average with the league prior (0) using a pseudo-count of 20 picks —
    # equivalent to pretending every owner drafted 20 league-average rookies first
    # before their own picks start mattering. A 5-pick hot streak gets regressed
    # hard; a 100-pick track record barely moves.
    SHRINKAGE_PSEUDO_N = 20
    for team in teams.values():
        raw = team.get("draft_rating_raw")
        n = team.get("draft_rating_n_picks") or 0
        if raw is None or n == 0:
            team["draft_rating_shrunk"] = None
            continue
        # shrunk = (sum + prior * pseudo_n) / (n + pseudo_n), prior=0
        team["draft_rating_shrunk"] = round((raw * n) / (n + SHRINKAGE_PSEUDO_N), 3)

    # Anchor the 0-100 scale to the observed shrunk distribution.
    # 50 = median, 0 = worst observed, 100 = best observed. Linear between.
    shrunk_vals = sorted([t["draft_rating_shrunk"] for t in teams.values()
                          if t.get("draft_rating_shrunk") is not None])
    if shrunk_vals:
        dr_min = shrunk_vals[0]
        dr_max = shrunk_vals[-1]
        dr_median = shrunk_vals[len(shrunk_vals) // 2]
        dr_range = max(0.001, dr_max - dr_min)
        for team in teams.values():
            s = team.get("draft_rating_shrunk")
            if s is None:
                team["draft_rating_100"] = None
                continue
            if s >= dr_median:
                # 50 → 100 between median and max
                span = max(0.001, dr_max - dr_median)
                team["draft_rating_100"] = round(50 + (s - dr_median) / span * 50, 1)
            else:
                # 0 → 50 between min and median
                span = max(0.001, dr_median - dr_min)
                team["draft_rating_100"] = round((s - dr_min) / span * 50, 1)

    # League-wide benchmark for dynamic filter comparison
    league_total = len(history_rows)
    league_tiers = Counter(r["tier"] for r in history_rows)
    league_benchmark = {
        "total_picks": league_total,
        "smash_rate": round(league_tiers.get("Smash", 0) / league_total, 3) if league_total else 0,
        "hit_plus_rate": round((league_tiers.get("Smash", 0) + league_tiers.get("Hit", 0)) / league_total, 3) if league_total else 0,
        "bust_rate": round(league_tiers.get("Bust", 0) / league_total, 3) if league_total else 0,
        "injury_bust_rate": round(league_tiers.get("Injury Bust", 0) / league_total, 3) if league_total else 0,
        "avg_points_3yr": round(sum(r["points_3yr_total"] for r in history_rows) / league_total, 1) if league_total else 0,
        "draft_rating_shrinkage_n": SHRINKAGE_PSEUDO_N,
    }

    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "n_teams": len(teams),
        },
        "league_benchmark": league_benchmark,
        "teams": teams,
    }


# ══════════════════════════════════════════════════════════════════════════
# 4. rookie_draft_day_trades.json — trades within ±24h of each year's rookie draft
# ══════════════════════════════════════════════════════════════════════════

def _build_future_pick_outcomes(db: sqlite3.Connection) -> dict:
    """Map (year, original_franchise_id, round) -> actual draft result.

    When a future pick (FP_0006_2025_1 style) has been consumed, look up what it
    became in the actual year's draft. We use the FRANCHISE that made the pick
    for that slot (i.e. the current owner at draft time, not original franchise).

    Returns {(year, round): [list of {overall, pick_label, player_name, franchise_id}, ...]}
    Because MFL records `original_franchise_id` only via the trade chain, we also
    need a way to resolve this. For v1 we just return per (year, round) the
    ordered list of picks, letting the UI/display pick the nearest-match by slot.
    """
    out: dict[tuple[int, int], list[dict]] = {}
    rows = db.execute("""
        SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
               franchise_id, franchise_name, player_name
        FROM draftresults_legacy
        UNION ALL
        SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
               franchise_id, franchise_name, player_name
        FROM draftresults_mfl
        ORDER BY season, draftpick_round, draftpick_roundorder
    """).fetchall()
    for season, rnd, slot, overall, fid, fname, pname in rows:
        if not (season and rnd and slot):
            continue
        key = (int(season), int(rnd))
        out.setdefault(key, []).append({
            "overall": int(overall) if overall else None,
            "round": int(rnd),
            "slot": int(slot),
            "pick_label": f"{int(rnd)}.{int(slot):02d}",
            "franchise_id": fid,
            "franchise_name": fname,
            "player_name": pname,
        })
    return out


def build_draft_day_trades(db: sqlite3.Connection) -> dict:
    future_outcomes = _build_future_pick_outcomes(db)

    # For each season with a rookie draft, find min(unix_timestamp) of draftresults_mfl
    draft_anchors = {}
    for season, min_ts, max_ts in db.execute("""
        SELECT season, MIN(unix_timestamp), MAX(unix_timestamp)
        FROM draftresults_mfl
        WHERE unix_timestamp IS NOT NULL
        GROUP BY season
    """):
        draft_anchors[int(season)] = {"first": int(min_ts), "last": int(max_ts)}

    # Pull trades near those anchors (±24h of the draft's first pick)
    trades_by_season: dict[int, list[dict]] = {}
    for season, anchors in draft_anchors.items():
        window_lo = anchors["first"] - 24 * 3600
        window_hi = anchors["last"] + 24 * 3600
        rows = db.execute("""
            SELECT transactionid, trade_group_id, franchise_id, franchise_name, franchise_role,
                   asset_role, asset_type, player_id, player_name,
                   asset_draftpick_season, asset_draftpick_round, asset_draftpick_roundorder,
                   asset_draftpick_overall,
                   asset_draftpick_future_year, asset_draftpick_future_round,
                   asset_draftpick_future_roundorder, asset_draftpick_future_overall,
                   asset_draftpick_future_franchiseid,
                   comments, unix_timestamp, datetime_et
            FROM transactions_trades
            WHERE season=? AND unix_timestamp BETWEEN ? AND ?
            ORDER BY unix_timestamp, trade_group_id, franchise_id
        """, (season, window_lo, window_hi)).fetchall()
        if not rows:
            continue
        # Group by trade_group_id so each trade appears once
        by_group: dict[str, dict] = {}
        cols = ["transactionid", "trade_group_id", "franchise_id", "franchise_name",
                "franchise_role", "asset_role", "asset_type", "player_id", "player_name",
                "asset_draftpick_season", "asset_draftpick_round", "asset_draftpick_roundorder",
                "asset_draftpick_overall",
                "asset_draftpick_future_year", "asset_draftpick_future_round",
                "asset_draftpick_future_roundorder", "asset_draftpick_future_overall",
                "asset_draftpick_future_franchiseid",
                "comments", "unix_timestamp", "datetime_et"]
        for r in rows:
            d = dict(zip(cols, r))
            gid = d["trade_group_id"] or d["transactionid"]
            if gid not in by_group:
                by_group[gid] = {
                    "trade_group_id": gid,
                    "unix_timestamp": d["unix_timestamp"],
                    "datetime_et": d["datetime_et"],
                    "comments": d["comments"],
                    "hours_from_first_pick": round((d["unix_timestamp"] - anchors["first"]) / 3600, 1),
                    "sides": {},
                }
            fid = d["franchise_id"]
            side = by_group[gid]["sides"].setdefault(fid, {
                "franchise_id": fid,
                "franchise_name": d["franchise_name"],
                "gave_up": [],
                "received": [],
            })
            asset_desc = _asset_description(d, future_outcomes, season, db)
            if d["asset_role"] == "RELINQUISH":
                side["gave_up"].append(asset_desc)
            elif d["asset_role"] == "RECEIVE":
                side["received"].append(asset_desc)
        # Mirror RELINQUISH -> other side's received (MFL often records only one direction)
        for gid, grp in by_group.items():
            sides = list(grp["sides"].values())
            if len(sides) == 2:
                a, b = sides
                if not a["received"] and b["gave_up"]:
                    a["received"] = list(b["gave_up"])
                if not b["received"] and a["gave_up"]:
                    b["received"] = list(a["gave_up"])
        # Flatten
        trades_by_season[season] = list(by_group.values())

    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "window_hours": 24,
            "seasons_covered": sorted(trades_by_season.keys()),
        },
        "trades_by_season": trades_by_season,
    }


_FRANCHISE_NAME_CACHE: dict[str, str] = {}

def _franchise_name_for(db: sqlite3.Connection, fid: str, season: int = 0) -> str:
    """Best-effort franchise name lookup.

    Falls back across: franchises table (current), transactions_trades (any season),
    draftresults tables, rosters_weekly. Returns the fid itself if nothing matches.
    Cached.
    """
    if not fid:
        return ""
    if fid in _FRANCHISE_NAME_CACHE:
        return _FRANCHISE_NAME_CACHE[fid]
    name = None
    for sql in (
        "SELECT franchise_name FROM franchises WHERE franchise_id=? LIMIT 1",
        "SELECT franchise_name FROM transactions_trades WHERE franchise_id=? AND franchise_name IS NOT NULL ORDER BY season DESC LIMIT 1",
        "SELECT franchise_name FROM draftresults_mfl WHERE franchise_id=? AND franchise_name IS NOT NULL ORDER BY season DESC LIMIT 1",
        "SELECT franchise_name FROM draftresults_legacy WHERE franchise_id=? AND franchise_name IS NOT NULL ORDER BY season DESC LIMIT 1",
        "SELECT team_name FROM rosters_weekly WHERE franchise_id=? AND team_name IS NOT NULL ORDER BY season DESC, week DESC LIMIT 1",
    ):
        try:
            row = db.execute(sql, (fid,)).fetchone()
            if row and row[0]:
                name = row[0]
                break
        except sqlite3.OperationalError:
            continue
    _FRANCHISE_NAME_CACHE[fid] = name or fid
    return _FRANCHISE_NAME_CACHE[fid]


def _asset_description(d: dict, future_outcomes: dict, current_season: int, db: sqlite3.Connection) -> dict:
    if d["asset_type"] == "PLAYER":
        return {"type": "player", "player_id": d["player_id"], "player_name": d["player_name"]}
    # Current-year draft pick (being traded during/near that year's draft)
    if d["asset_draftpick_season"]:
        rnd = d["asset_draftpick_round"]
        slot = d["asset_draftpick_roundorder"]
        overall = d["asset_draftpick_overall"]
        # Derive slot from overall when MFL left it null, but only if result is sane
        if (not slot) and overall and rnd:
            candidate = int(overall) - (int(rnd) - 1) * 12
            if 1 <= candidate <= 12:
                slot = candidate
        label = f"{d['asset_draftpick_season']} R{rnd}"
        if rnd and slot and 1 <= int(slot) <= 12:
            label = f"{d['asset_draftpick_season']} {int(rnd)}.{int(slot):02d}"
        return {
            "type": "current_pick",
            "season": d["asset_draftpick_season"],
            "round": rnd,
            "slot": slot,
            "overall": overall,
            "label": label,
        }
    # Future draft pick — look up what it became
    if d["asset_draftpick_future_year"]:
        fy = int(d["asset_draftpick_future_year"])
        fr = int(d["asset_draftpick_future_round"] or 0)
        original_fid = d.get("asset_draftpick_future_franchiseid")
        original_fname = _franchise_name_for(db, original_fid, fy) if original_fid else ""
        # Look up what this pick became
        outcome = None
        # The future pick's original owner is asset_draftpick_future_franchiseid.
        # The actual pick at (fy, fr) owned by original_fid at draft time is what it became.
        # We look in the draft outcomes list for that (fy, fr) by matching franchise_id
        # of the ORIGINAL OWNER — but after mid-season trades, that franchise may not
        # still own it. The cleanest "became" mapping requires walking the trade
        # chain; as a heuristic, match by lowest-slot pick owned by the original fid.
        candidates = future_outcomes.get((fy, fr), [])
        if original_fid:
            matched = next((c for c in candidates if c["franchise_id"] == original_fid), None)
            if matched:
                outcome = matched
        return {
            "type": "future_pick",
            "year": fy,
            "round": fr,
            "original_franchise_id": original_fid,
            "original_franchise_name": original_fname,
            "label": (
                f"{original_fname}'s {fy} R{fr}" if original_fname else f"{fy} R{fr} pick"
            ),
            "became": outcome,
        }
    return {"type": "unknown"}


# ══════════════════════════════════════════════════════════════════════════
# 5. rookie_draft_hub_2026.json — live draft state
# ══════════════════════════════════════════════════════════════════════════

def build_live_state() -> dict:
    # Get league metadata
    try:
        league_data = _get(
            f"{MFL_HOST}/{CURRENT_YEAR}/export?TYPE=league&L={LEAGUE_ID}&APIKEY={MFL_APIKEY}&JSON=1"
        )
    except Exception as e:
        league_data = {}
        print(f"  WARN: league fetch failed: {e}", file=sys.stderr)

    franchises_list = (league_data.get("league", {}).get("franchises", {}).get("franchise", [])) or []
    franchises = {f.get("id"): f.get("name", "") for f in franchises_list}

    # Future draft picks (upcoming draft order)
    try:
        fdp_data = _get(
            f"{MFL_HOST}/{CURRENT_YEAR}/export?TYPE=futureDraftPicks&L={LEAGUE_ID}"
            f"&APIKEY={MFL_APIKEY}&JSON=1"
        )
    except Exception:
        fdp_data = {}
    future_picks = fdp_data.get("futureDraftPicks", {}).get("franchise", []) or []

    # Completed draft results (if any picks already made)
    try:
        dr_data = _get(
            f"{MFL_HOST}/{CURRENT_YEAR}/export?TYPE=draftResults&L={LEAGUE_ID}"
            f"&APIKEY={MFL_APIKEY}&JSON=1"
        )
    except Exception:
        dr_data = {}
    draft_units = dr_data.get("draftResults", {}).get("draftUnit", [])
    if isinstance(draft_units, dict):
        draft_units = [draft_units]

    picks_made = []
    picks_queued = []
    for unit in draft_units:
        unit_picks = unit.get("draftPick", [])
        if isinstance(unit_picks, dict):
            unit_picks = [unit_picks]
        for pk in unit_picks:
            row = {
                "round": int(pk.get("round", 0)),
                "pick": int(pk.get("pick", 0)),
                "franchise_id": pk.get("franchise"),
                "player_id": pk.get("player") or "",
                "timestamp": pk.get("timestamp") or "",
                "comments": pk.get("comments") or "",
            }
            if row["player_id"]:
                picks_made.append(row)
            else:
                picks_queued.append(row)

    # Expected order: prefer draftResults queued slots (has round+pick+franchise for every slot)
    # since futureDraftPicks only holds "traded away" picks, not the original order.
    if picks_queued:
        expected_order = [
            {
                "round": p["round"],
                "pick": p["pick"],
                "owned_by_franchise_id": p["franchise_id"],
                "original_franchise_id": None,
            }
            for p in picks_queued
        ]
    else:
        expected_order = []
        for fp_entry in future_picks:
            fid = fp_entry.get("id") or fp_entry.get("franchise")
            owned_picks = fp_entry.get("futureDraftPick", [])
            if isinstance(owned_picks, dict):
                owned_picks = [owned_picks]
            for p in owned_picks:
                year = int(p.get("year", 0) or 0)
                if year == CURRENT_YEAR:
                    expected_order.append({
                        "round": int(p.get("round", 0)),
                        "owned_by_franchise_id": fid,
                        "original_franchise_id": p.get("originalPickFor"),
                    })
    expected_order.sort(key=lambda p: (p["round"], p.get("pick") or 0))

    # Active pick = first queued pick (lowest round+pick ordinal) not yet made
    active_pick = picks_queued[0] if picks_queued else None

    # Draft salary schedule — league rookie scale
    draft_salaries = []
    for rnd in range(1, 7):
        for slot in range(1, 13):
            aav = _rookie_slot_salary(rnd, slot)
            draft_salaries.append({
                "round": rnd,
                "slot": slot,
                "pick_label": f"{rnd}.{slot:02d}",
                "rookie_aav": aav,
                "rookie_tcv_3yr": aav * 3,
            })

    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "league_id": LEAGUE_ID,
            "season": CURRENT_YEAR,
        },
        "franchises": franchises,
        "draft_order": expected_order,
        "picks_made": picks_made,
        "active_pick": active_pick,
        "draft_salaries": draft_salaries,
    }


# ══════════════════════════════════════════════════════════════════════════
# 6. rookie_prospects_2026.json — merged ZAP + KTC + ADP + projections
# ══════════════════════════════════════════════════════════════════════════

def build_prospects() -> dict:
    """Build prospect board from MFL players API filtered to current-year rookies.

    Includes ALL positions (offense + defense + special). Merges ZAP and KTC
    signals where available via name match, but the source of truth for "who's
    a rookie" is MFL's own draft_year field.
    """
    # Fetch MFL rookies (draft_year=CURRENT_YEAR)
    try:
        data = _get(
            f"https://api.myfantasyleague.com/{CURRENT_YEAR}/export?TYPE=players&DETAILS=1&JSON=1"
        )
    except Exception:
        data = {}
    all_players = data.get("players", {}).get("player", []) or []
    rookies = [
        p for p in all_players
        if str(p.get("draft_year") or "") == str(CURRENT_YEAR)
    ]

    # Fetch multiple ADP sources — all from MFL's cross-league rookie drafts,
    # filtered by different formats (SF vs 1QB vs Dynasty).
    def _fetch_adp(params: str) -> dict:
        try:
            d = _get(f"https://api.myfantasyleague.com/{CURRENT_YEAR}/export?TYPE=adp&JSON=1&{params}")
            rows = d.get("adp", {}).get("player", []) or []
            return {str(a.get("id")): a for a in rows}
        except Exception:
            return {}

    adp_sources = {
        "mfl_rookie": _fetch_adp("IS_MOCK=-1&ROOKIES=1"),
        "mfl_rookie_sf":   _fetch_adp("IS_MOCK=-1&ROOKIES=1&IS_PPR=0&IS_KEEPER=Y"),
        "mfl_dynasty": _fetch_adp("IS_MOCK=-1&IS_KEEPER=Y"),
        "mfl_mock":    _fetch_adp("IS_MOCK=1&ROOKIES=1"),
    }
    adp_by_pid = adp_sources["mfl_rookie"]  # primary default

    # Optional ZAP/KTC overlays by name
    zap = json.loads(ZAP_FILE.read_text()) if ZAP_FILE.exists() else {}
    ktc = json.loads(KTC_FILE.read_text()) if KTC_FILE.exists() else {}
    zap_players = zap.get("sf_rankings", zap.get("players", [])) or []
    ktc_players = ktc.get("players", ktc.get("rankings", [])) or []
    if isinstance(ktc_players, dict):
        ktc_players = list(ktc_players.values())

    def _nkey(name: str) -> str:
        return (name or "").lower().replace(".", "").replace(",", "").strip()

    zap_by_name = {_nkey(p.get("player") or p.get("name", "")): p for p in zap_players}
    ktc_by_name = {_nkey(p.get("name", "")): p for p in ktc_players}

    prospects: list[dict] = []
    for p in rookies:
        pid = str(p.get("id"))
        name = p.get("name", "")  # "Last, First"
        pos = (p.get("position") or "").upper()
        adp_row = adp_by_pid.get(pid, {})
        nkey = _nkey(name)
        zap_row = zap_by_name.get(nkey, {})
        ktc_row = ktc_by_name.get(nkey, {})
        # Pull ADP from each source
        def _v(src_by_pid, key):
            r = src_by_pid.get(pid, {})
            return float(r.get(key) or 0) or None if r.get(key) else None
        adp_mfl_rookie     = _v(adp_sources["mfl_rookie"], "averagePick")
        adp_mfl_rookie_sf  = _v(adp_sources["mfl_rookie_sf"], "averagePick")
        adp_mfl_dynasty    = _v(adp_sources["mfl_dynasty"], "averagePick")
        adp_mfl_mock       = _v(adp_sources["mfl_mock"], "averagePick")
        # Average across available sources for a consensus number
        adp_pool = [x for x in (adp_mfl_rookie, adp_mfl_rookie_sf, adp_mfl_dynasty, adp_mfl_mock) if x]
        adp_avg = round(sum(adp_pool) / len(adp_pool), 2) if adp_pool else None
        prospects.append({
            "player_id": pid,
            "name": name,
            "position": pos,
            "pos_group": pos_group(pos),
            "pos_subgroup": pos_subgroup(pos),
            "nfl_team": p.get("team"),
            # Legacy single-source fields kept for back-compat
            "rookie_adp": float(adp_row.get("averagePick") or 0) or None,
            "rookie_adp_rank": int(adp_row.get("rank") or 0) or None,
            "rookie_adp_n_drafts": int(adp_row.get("draftsSelectedIn") or 0) or None,
            # Multi-source ADPs
            "adp_sources": {
                "mfl_rookie":    adp_mfl_rookie,
                "mfl_rookie_sf": adp_mfl_rookie_sf,
                "mfl_dynasty":   adp_mfl_dynasty,
                "mfl_mock":      adp_mfl_mock,
                "ktc_sf":        ktc_row.get("sf_value"),  # KTC uses value not pick #
                "avg":           adp_avg,
            },
            "profile_url": _mfl_profile_url(pid, CURRENT_YEAR),
            "zap_score": zap_row.get("zap"),
            "zap_sf_rank": zap_row.get("sf_rank"),
            "ktc_sf_value": ktc_row.get("sf_value"),
        })

    # Sort by rookie ADP (lower = better). Unranked go to end.
    prospects.sort(key=lambda p: p.get("rookie_adp") or 9999)

    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "sources": ["MFL players (draft_year=CURRENT)", "MFL rookie ADP", "ZAP", "KTC"],
            "n_prospects": len(prospects),
        },
        "prospects": prospects,
    }


# ══════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════

# ══════════════════════════════════════════════════════════════════════════
# Future Draft Picks — 2027 projected slots based on 2026 standings
# ══════════════════════════════════════════════════════════════════════════

def build_future_picks() -> dict:
    """Pull each franchise's owned future picks + project a 2027 slot order
    based on 2026 final standings.

    League rule: the Toilet Bowl (7th place) WINS 1.01 of the next rookie
    draft. Everyone else slots by inverse finish (12th → 1.02, 11th → 1.03,
    etc., but 7th → 1.01 overrides the normal order).
    """
    try:
        url = (f"https://www48.myfantasyleague.com/{CURRENT_YEAR}/export"
               f"?TYPE=futureDraftPicks&L={LEAGUE_ID}&JSON=1")
        raw = _get(url)
    except Exception as e:
        return {"meta": {"error": f"fetch failed: {e}"}, "picks": []}
    # Franchise name lookup
    try:
        league_raw = _get(
            f"https://www48.myfantasyleague.com/{CURRENT_YEAR}/export?TYPE=league&L={LEAGUE_ID}&JSON=1")
        lf = league_raw.get("league", {}).get("franchises", {}).get("franchise", [])
        if isinstance(lf, dict): lf = [lf]
        fid_to_name = {str(f.get("id")): f.get("name", "") for f in lf}
    except Exception:
        fid_to_name = {}

    rows = raw.get("futureDraftPicks", {}).get("franchise", [])
    if isinstance(rows, dict): rows = [rows]

    picks_flat: list[dict] = []
    for row in rows:
        fid = str(row.get("id"))
        items = row.get("futureDraftPick", []) or []
        if isinstance(items, dict): items = [items]
        for p in items:
            yr = str(p.get("year"))
            rnd = int(p.get("round") or 0)
            original_fid = str(p.get("originalPickFor", fid))
            picks_flat.append({
                "current_owner_fid": fid,
                "current_owner_name": fid_to_name.get(fid, fid),
                "original_owner_fid": original_fid,
                "original_owner_name": fid_to_name.get(original_fid, original_fid),
                "year": yr,
                "round": rnd,
                "projected_slot": None,  # filled for 2027 below
                "projected_pick_label": None,
                "asset_id": f"FP_{original_fid}_{yr}_{rnd}",
                "tradeable": True,
            })

    # Synthesize R6 picks — MFL doesn't return them (non-tradeable per league rule),
    # but we display them so every owner sees their full future pick inventory.
    # Each franchise owns their own R6 at every future year covered by R1-R5.
    years_covered = sorted({p["year"] for p in picks_flat}) or [str(CURRENT_YEAR + 1)]
    for yr in years_covered:
        for fid, fname in fid_to_name.items():
            picks_flat.append({
                "current_owner_fid": fid,
                "current_owner_name": fname,
                "original_owner_fid": fid,
                "original_owner_name": fname,
                "year": yr,
                "round": 6,
                "projected_slot": None,
                "projected_pick_label": None,
                "asset_id": f"FP_{fid}_{yr}_6",
                "tradeable": False,  # R6 non-tradeable per league rules
            })

    # Project slot order for all future-pick years (including R6) using a
    # time-weighted blend of historical avg finish + current-year AP trajectory.
    # Matches the trade-analyzer philosophy: historical matters more pre-season,
    # less once the season is underway.
    #
    # For the "current" rookie draft year (e.g. 2027 projection in 2026):
    #   - If 2026 season hasn't started: 100% historical weight (use 2023-2025 avg)
    #   - Mid-season: blend historical + current-year standings
    #   - Post-season: 100% current-year result
    # Toilet Bowl rule: 7th place finisher → 1.01 (R1 only).
    # All other rounds: standard inverse-finish order (worst → pick 1, best → pick 12).
    try:
        import sqlite3
        from collections import defaultdict as _dd
        db = sqlite3.connect(str(MFL_DB))
        # ─────────────────────────────────────────────────────────────────────
        # PROJECTION MODEL: 10-yr reg-season AP% base + bracket-aware playoff adjustment.
        #
        # Step 1 — Base rank from 10yr regular-season AP% (best single predictor, r²=0.21).
        # Step 2 — Apply bracket-aware playoff-performance adjustment:
        #   - If base rank is TOP-6 (projected playoff bracket): adjust by historical
        #     playoff Δ (playoff_AP − reg_AP when in playoff bracket).
        #     E.g., Ryan Bousquet: −16 Δ → "bed-shitter", push him down 1-2 spots.
        #     Eric Martel: +9 Δ → "rallier", push him up.
        #   - If base rank is BOT-6 (projected TB bracket): adjust by historical
        #     TB Δ (playoff_AP − reg_AP when in TB bracket).
        #     E.g., Derrick Whitman: −23 Δ when in TB → tanks to 12th.
        #     Shawn Blake: +21 Δ when in TB → wins TB (7th).
        # Step 3 — Re-rank after adjustment; map to slot via FINISH_TO_SLOT.
        # ─────────────────────────────────────────────────────────────────────
        RECENT_YEARS = list(range(CURRENT_YEAR - 10, CURRENT_YEAR))

        # Owner-tracked reg-season AP% + playoff AP% + bracket per season
        # owner_season_data[owner] = [{year, reg_ap, po_ap, final_finish, bracket}]
        owner_season_data: dict[str, list[dict]] = _dd(list)
        for yr in RECENT_YEARS:
            weekly = db.execute("""
                SELECT week, franchise_id, SUM(player_score), is_playoff
                FROM weeklyresults WHERE season=? AND status='starter'
                GROUP BY week, franchise_id, is_playoff
            """, (yr,)).fetchall()
            if not weekly: continue
            by_wk: dict = _dd(list)
            for wk, fid2, pts, is_po in weekly:
                by_wk[(wk, is_po or 0)].append((fid2, pts or 0))
            stats: dict = _dd(lambda: {"rw": 0, "rl": 0, "pw": 0, "pl": 0})
            for (_wk, is_po), teams in by_wk.items():
                for fid2, pts in teams:
                    w = sum(1 for o, p in teams if o != fid2 and pts > p)
                    l = sum(1 for o, p in teams if o != fid2 and pts < p)
                    s = stats[fid2]
                    if is_po: s["pw"] += w; s["pl"] += l
                    else: s["rw"] += w; s["rl"] += l
            for fid2, s in stats.items():
                rt = s["rw"] + s["rl"]; pt = s["pw"] + s["pl"]
                reg_ap = s["rw"] / rt if rt else None
                po_ap = s["pw"] / pt if pt else None
                owner_r = db.execute(
                    "SELECT owner_name FROM franchises WHERE franchise_id=? AND season=?",
                    (fid2, yr)).fetchone()
                final_r = db.execute(
                    "SELECT final_finish FROM metadata_finalstandings WHERE franchise_id=? AND year=?",
                    (fid2, yr)).fetchone()
                if not owner_r or not owner_r[0]: continue
                final = final_r[0] if (final_r and final_r[0]) else None
                owner_season_data[owner_r[0]].append({
                    "year": yr, "reg_ap": reg_ap, "po_ap": po_ap,
                    "final": final,
                    "bracket": ("playoff" if final and final <= 6
                                else "TB" if final else None),
                })

        # Compute per-owner avg reg AP + bracket-specific Δ
        owner_summary: dict[str, dict] = {}
        for owner, seasons in owner_season_data.items():
            reg_aps = [s["reg_ap"] for s in seasons if s["reg_ap"] is not None]
            avg_reg_ap = sum(reg_aps) / len(reg_aps) if reg_aps else None
            # Playoff-bracket Δ (top-6)
            po_seasons = [s for s in seasons if s["bracket"] == "playoff"
                          and s["reg_ap"] is not None and s["po_ap"] is not None]
            playoff_delta = (sum(s["po_ap"] - s["reg_ap"] for s in po_seasons) / len(po_seasons)
                             if po_seasons else None)
            # TB-bracket Δ (bot-6)
            tb_seasons = [s for s in seasons if s["bracket"] == "TB"
                          and s["reg_ap"] is not None and s["po_ap"] is not None]
            tb_delta = (sum(s["po_ap"] - s["reg_ap"] for s in tb_seasons) / len(tb_seasons)
                        if tb_seasons else None)
            owner_summary[owner] = {
                "avg_reg_ap": avg_reg_ap,
                "years_of_history": len(seasons),
                "playoff_bracket_years": len(po_seasons),
                "playoff_delta": playoff_delta,
                "tb_bracket_years": len(tb_seasons),
                "tb_delta": tb_delta,
                "yearly_reg_ap": {str(s["year"]): round(s["reg_ap"], 3)
                                  for s in seasons if s["reg_ap"] is not None},
            }

        # Current-owner-per-franchise
        current_owner_of: dict[str, str] = {}
        for fid2, owner in db.execute(
            "SELECT franchise_id, owner_name FROM franchises WHERE season=? AND owner_name IS NOT NULL",
            (CURRENT_YEAR - 1,),
        ).fetchall():
            current_owner_of[str(fid2)] = owner

        # ── STEP 1: base rank from reg-season AP% ──
        fids_with_data = [fid for fid in current_owner_of
                          if owner_summary.get(current_owner_of[fid], {}).get("avg_reg_ap") is not None]
        # Sort DESC by reg AP%; best reg-season team gets base rank 1
        fids_with_data.sort(key=lambda f: -owner_summary[current_owner_of[f]]["avg_reg_ap"])
        base_rank: dict[str, int] = {fid: i + 1 for i, fid in enumerate(fids_with_data)}

        # ── STEP 2: apply bracket-aware adjustment WITHIN the bracket ──
        # Brackets are SEALED per league rules:
        #   - Top-6 by reg AP → playoff bracket → final finish 1-6 (can't fall to TB)
        #   - Bot-6 by reg AP → Toilet Bowl bracket → final finish 7-12 (can't escape)
        # So we only REORDER within each bracket based on the bracket-specific Δ.
        DELTA_WEIGHT = 10.0
        adjusted_rank: dict[str, float] = {}
        for fid, br in base_rank.items():
            owner = current_owner_of[fid]
            summ = owner_summary[owner]
            delta = (summ.get("playoff_delta") if br <= 6 else summ.get("tb_delta")) or 0.0
            # Negative Δ pushes DOWN (higher # = worse), positive pulls UP
            adjusted_rank[fid] = br + (-delta * DELTA_WEIGHT)

        # ── STEP 3: separately re-rank each bracket, keep them sealed ──
        playoff_fids = [fid for fid, br in base_rank.items() if br <= 6]
        tb_fids = [fid for fid, br in base_rank.items() if br >= 7]
        # Sort each by adjusted rank (ASC — lower = better finish within bracket)
        playoff_fids.sort(key=lambda f: adjusted_rank[f])
        tb_fids.sort(key=lambda f: adjusted_rank[f])
        final_ordinal: dict[str, int] = {}
        for i, fid in enumerate(playoff_fids, 1):  # ordinals 1..6
            final_ordinal[fid] = i
        for i, fid in enumerate(tb_fids, 7):        # ordinals 7..12
            final_ordinal[fid] = i

        # League mapping
        FINISH_TO_SLOT = {7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6,
                          6: 7, 5: 8, 4: 9, 3: 10, 2: 11, 1: 12}
        r1_slot_assign = {fid2: FINISH_TO_SLOT.get(ord_)
                          for fid2, ord_ in final_ordinal.items()}
        std_slot_assign = dict(r1_slot_assign)

        # Per league rules: Toilet Bowl winner (7th place) takes slot X.01 in EVERY
        # round R1-R5. R6 is a random drawing, so no slot is projected.
        for p in picks_flat:
            if p.get("year") != str(CURRENT_YEAR + 1):
                continue
            orig_fid = p.get("original_owner_fid")
            if not orig_fid: continue
            rnd = p["round"]
            if rnd == 6:
                # R6 slot assignment is random, happens on draft day; don't project
                p["projected_pick_label"] = "(random drawing)"
                continue
            # R1-R5 all use the Toilet Bowl + inverse-finish order
            s = r1_slot_assign.get(orig_fid)
            if s:
                p["projected_slot"] = s
                p["projected_pick_label"] = f"{rnd}.{s:02d}"
        db.close()
    except Exception as e:
        picks_flat.append({"projection_error": str(e)})

    # Build the projection_basis — exposes the full math chain:
    #   reg-season AP% → base rank → bracket-aware Δ adjustment → final rank → slot
    projection_basis = []
    try:
        for fid in current_owner_of:
            owner = current_owner_of[fid]
            summ = owner_summary.get(owner, {})
            fname = fid_to_name.get(fid, fid)
            br = base_rank.get(fid)
            adj = adjusted_rank.get(fid)
            final_ord = final_ordinal.get(fid)
            proj_slot = r1_slot_assign.get(fid)
            # Which Δ is applied
            applied_delta = None
            adjustment_source = None
            if br is not None:
                if br <= 6:
                    applied_delta = summ.get("playoff_delta")
                    adjustment_source = "playoff_bracket"
                else:
                    applied_delta = summ.get("tb_delta")
                    adjustment_source = "tb_bracket"
            rank_shift = (adj - br) if (adj is not None and br is not None) else None
            projection_basis.append({
                "franchise_id": fid,
                "franchise_name": fname,
                "current_owner": owner,
                "yearly_ap": summ.get("yearly_reg_ap") or {},
                "years_of_history": summ.get("years_of_history", 0),
                "avg_ap_pct": round(summ["avg_reg_ap"], 3) if summ.get("avg_reg_ap") is not None else None,
                "base_rank": br,
                "playoff_delta": round(summ["playoff_delta"], 3) if summ.get("playoff_delta") is not None else None,
                "playoff_bracket_years": summ.get("playoff_bracket_years", 0),
                "tb_delta": round(summ["tb_delta"], 3) if summ.get("tb_delta") is not None else None,
                "tb_bracket_years": summ.get("tb_bracket_years", 0),
                "applied_delta": round(applied_delta, 3) if applied_delta is not None else None,
                "adjustment_source": adjustment_source,
                "rank_shift": round(rank_shift, 2) if rank_shift is not None else None,
                "adjusted_rank": round(adj, 2) if adj is not None else None,
                "projected_ordinal": final_ord,
                "projected_slot": proj_slot,
                "projected_slot_label": f"1.{proj_slot:02d}" if proj_slot else None,
                "is_toilet_bowl": proj_slot == 1,
            })
        projection_basis.sort(key=lambda r: r.get("projected_slot") or 99)
    except Exception as e:
        projection_basis.append({"basis_error": str(e)})

    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "n_picks": len(picks_flat),
            "projection_note": (
                "Projection = 10yr reg-season AP% base rank + bracket-aware playoff Δ. "
                "Step 1: sort owners by 10yr reg-season AP% → base rank (1=best). "
                "Step 2: if base rank is top-6 (playoff bracket), apply their playoff-bracket Δ "
                "(bed-shitter penalty or rally bonus). If base rank is bot-6 (TB bracket), "
                "apply their TB-bracket Δ (tanker penalty or try-hard bonus). "
                "Step 3: re-rank by adjusted finish; map via FINISH_TO_SLOT (7→1.01, 8→1.02 … 1→1.12). "
                "R2-R5 same mapping; R6 random."
            ),
            "lookback_years": RECENT_YEARS,
        },
        "picks": picks_flat,
        "projection_basis": projection_basis,
    }


# ══════════════════════════════════════════════════════════════════════════
# AP vs E+P per team per season (throwaway sub-page for analysis)
# ══════════════════════════════════════════════════════════════════════════

def build_ap_vs_ep(db: sqlite3.Connection) -> dict:
    """Per (season, franchise) row with All-Play record + E+P rate side-by-side.

    Also includes Dud rate + NET (E+P - 0.5×Dud), since the NET metric is what
    drives tier classification and user analysis now.
    """
    _load_pos_baselines(db)
    active_owners = _build_active_owner_set(db)

    rows: list[dict] = []
    seasons = [r[0] for r in db.execute(
        "SELECT DISTINCT season FROM standings WHERE allplay_pct IS NOT NULL ORDER BY season"
    ).fetchall()]

    for season in seasons:
        season_teams = db.execute("""
            SELECT franchise_id, franchise_name, owner_name,
                   allplay_w, allplay_l, allplay_t, allplay_pct,
                   h2h_w, h2h_l, pf, eff
            FROM standings WHERE season=? ORDER BY allplay_pct DESC
        """, (season,)).fetchall()

        # Per-team E+P rate — pull all starter-weeks for this team this season
        team_ep_rows: list[dict] = []
        for fid, fname, owner, apw, apl, apt, appct, h2hw, h2hl, pf, eff in season_teams:
            starter_rows = db.execute("""
                SELECT pws.score, pws.pos_group
                FROM weeklyresults wr
                JOIN player_weeklyscoringresults pws
                  ON pws.player_id=wr.player_id AND pws.season=wr.season AND pws.week=wr.week
                WHERE wr.franchise_id=? AND wr.season=? AND wr.status='starter' AND pws.score > 0
            """, (fid, season)).fetchall()

            starter_weeks = 0
            ep_weeks = dud_weeks = 0
            off_weeks = off_ep = off_dud = def_weeks = def_ep = def_dud = 0
            for score, pg in starter_rows:
                baseline = _POS_BASELINES.get((int(season), pg))
                if not baseline: continue
                p50, delta = baseline
                z = (float(score) - p50) / delta
                starter_weeks += 1
                is_ep = z >= 0.25
                is_dud = z < -0.5
                if is_ep: ep_weeks += 1
                if is_dud: dud_weeks += 1
                side = "offense" if pg in ("QB", "RB", "WR", "TE") else "defense" if pg in (
                    "CB+S", "DT+DE", "LB", "DL", "DB"
                ) else None
                if side == "offense":
                    off_weeks += 1
                    if is_ep: off_ep += 1
                    if is_dud: off_dud += 1
                elif side == "defense":
                    def_weeks += 1
                    if is_ep: def_ep += 1
                    if is_dud: def_dud += 1

            ep_rate = round(ep_weeks / starter_weeks, 4) if starter_weeks else None
            dud_rate = round(dud_weeks / starter_weeks, 4) if starter_weeks else None
            net_score = round(ep_rate - 0.5 * dud_rate, 4) if (ep_rate is not None and dud_rate is not None) else None
            off_ep_rate = round(off_ep / off_weeks, 4) if off_weeks else None
            off_dud_rate = round(off_dud / off_weeks, 4) if off_weeks else None
            def_ep_rate = round(def_ep / def_weeks, 4) if def_weeks else None
            def_dud_rate = round(def_dud / def_weeks, 4) if def_weeks else None

            team_ep_rows.append({
                "season": int(season),
                "franchise_id": fid,
                "franchise_name": fname,
                "owner_name": owner or "",
                "owner_active": bool(owner and owner in active_owners),
                "ap_w": int(apw) if apw is not None else 0,
                "ap_l": int(apl) if apl is not None else 0,
                "ap_t": int(apt) if apt is not None else 0,
                "ap_pct": round(float(appct), 4) if appct is not None else None,
                "h2h_w": int(h2hw) if h2hw is not None else 0,
                "h2h_l": int(h2hl) if h2hl is not None else 0,
                "pf": round(float(pf), 1) if pf is not None else None,
                "eff": round(float(eff), 1) if eff is not None else None,
                "starter_weeks": starter_weeks,
                "ep_weeks": ep_weeks,
                "ep_rate": ep_rate,
                "dud_weeks": dud_weeks,
                "dud_rate": dud_rate,
                "net_score": net_score,
                "off_weeks": off_weeks,
                "off_ep_weeks": off_ep,
                "off_ep_rate": off_ep_rate,
                "off_dud_rate": off_dud_rate,
                "def_weeks": def_weeks,
                "def_ep_weeks": def_ep,
                "def_ep_rate": def_ep_rate,
                "def_dud_rate": def_dud_rate,
            })

        # Compute per-season ranks for AP and E+P
        ap_sorted = sorted(team_ep_rows, key=lambda r: -(r["ap_pct"] or 0))
        for i, r in enumerate(ap_sorted, 1):
            r["ap_rank"] = i
        ep_sorted = sorted(team_ep_rows, key=lambda r: -(r["ep_rate"] or 0))
        for i, r in enumerate(ep_sorted, 1):
            r["ep_rank"] = i
        # Delta: AP rank minus EP rank — negative = overachieved AP vs E+P,
        # positive = underachieved AP despite good E+P
        for r in team_ep_rows:
            r["rank_delta"] = (r["ap_rank"] or 0) - (r["ep_rank"] or 0)

        rows.extend(team_ep_rows)

    # League aggregates by season
    by_season = defaultdict(list)
    for r in rows:
        by_season[r["season"]].append(r)
    season_summary: list[dict] = []
    for s, team_rows in sorted(by_season.items()):
        ep_vals = [r["ep_rate"] for r in team_rows if r["ep_rate"] is not None]
        ap_vals = [r["ap_pct"] for r in team_rows if r["ap_pct"] is not None]
        top3_ep = sorted(ep_vals, reverse=True)[:3]
        bot3_ep = sorted(ep_vals)[:3]
        season_summary.append({
            "season": s,
            "n_teams": len(team_rows),
            "league_avg_ep": round(sum(ep_vals) / len(ep_vals), 4) if ep_vals else None,
            "top3_avg_ep": round(sum(top3_ep) / len(top3_ep), 4) if top3_ep else None,
            "bot3_avg_ep": round(sum(bot3_ep) / len(bot3_ep), 4) if bot3_ep else None,
        })

    # Compute correlations of every metric with AP% across all team-seasons
    def _pearson(xs, ys):
        pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
        n = len(pairs)
        if n < 2: return None
        mx = sum(p[0] for p in pairs) / n
        my = sum(p[1] for p in pairs) / n
        num = sum((p[0] - mx) * (p[1] - my) for p in pairs)
        dx = sum((p[0] - mx) ** 2 for p in pairs)
        dy = sum((p[1] - my) ** 2 for p in pairs)
        return round(num / (dx * dy) ** 0.5, 4) if dx > 0 and dy > 0 else None

    ap_vals = [r["ap_pct"] for r in rows]
    correlations = {
        "n_team_seasons": len(rows),
        "overall_ep_rate": _pearson(ap_vals, [r["ep_rate"] for r in rows]),
        "overall_dud_rate": _pearson(ap_vals, [r["dud_rate"] for r in rows]),
        "overall_net_score": _pearson(ap_vals, [r["net_score"] for r in rows]),
        "offense_ep_rate": _pearson(ap_vals, [r["off_ep_rate"] for r in rows]),
        "offense_dud_rate": _pearson(ap_vals, [r["off_dud_rate"] for r in rows]),
        "defense_ep_rate": _pearson(ap_vals, [r["def_ep_rate"] for r in rows]),
        "defense_dud_rate": _pearson(ap_vals, [r["def_dud_rate"] for r in rows]),
        "points_for": _pearson(ap_vals, [r["pf"] for r in rows]),
        "efficiency": _pearson(ap_vals, [r["eff"] for r in rows]),
    }

    return {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "methodology": "E+P = % of starter-weeks where (score - p50) / Δ >= 0.25, "
                           "using rostered-starter positional baselines. "
                           "NET = E+P − 0.5×Dud (tier classifier metric).",
            "n_rows": len(rows),
        },
        "rows": rows,
        "season_summary": season_summary,
        "correlations": correlations,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--skip-live", action="store_true",
                    help="Skip live MFL API calls (for offline rebuilds)")
    args = ap.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    print(f"Building Rookie Draft Hub artifacts -> {OUT_DIR}")
    t0 = time.time()

    db = sqlite3.connect(str(MFL_DB))
    try:
        print("[1/6] Tiers + enriched history...", flush=True)
        tiers, history = build_tiers_and_history(db)
        (OUT_DIR / "rookie_draft_tiers.json").write_text(json.dumps(tiers, indent=2))
        history_artifact = {
            "meta": {
                "generated_at_utc": datetime.now(timezone.utc).isoformat(),
                "n_rows": len(history),
                "seasons": sorted({r["season"] for r in history}),
            },
            "picks": history,
        }
        (OUT_DIR / "rookie_draft_history.json").write_text(json.dumps(history_artifact, indent=2))
        print(f"  wrote tiers ({len(tiers['bands'])} bands) + history ({len(history)} rows)")

        print("[2/6] Team tendencies...", flush=True)
        tendencies = build_team_tendencies(history)
        (OUT_DIR / "rookie_draft_team_tendencies.json").write_text(json.dumps(tendencies, indent=2))
        print(f"  wrote {len(tendencies['teams'])} team profiles")

        print("[3/6] Draft-day trades...", flush=True)
        ddt = build_draft_day_trades(db)
        (OUT_DIR / "rookie_draft_day_trades.json").write_text(json.dumps(ddt, indent=2))
        print(f"  wrote {sum(len(v) for v in ddt['trades_by_season'].values())} trades across {len(ddt['trades_by_season'])} seasons")

        print("[3b/6] AP vs E+P analysis (throwaway sub-page)...", flush=True)
        ap_ep = build_ap_vs_ep(db)
        (OUT_DIR / "rookie_ap_vs_ep.json").write_text(json.dumps(ap_ep, indent=2))
        print(f"  wrote {ap_ep['meta']['n_rows']} team-season rows")

        print("[3c/6] Future Draft Picks (2027 projected)...", flush=True)
        fut = build_future_picks()
        (OUT_DIR / "rookie_future_picks.json").write_text(json.dumps(fut, indent=2))
        print(f"  wrote {fut['meta'].get('n_picks', 0)} future-pick rows")
    finally:
        db.close()

    print("[4/6] Rookie prospect board (ZAP + KTC)...", flush=True)
    prospects = build_prospects()
    (OUT_DIR / "rookie_prospects_2026.json").write_text(json.dumps(prospects, indent=2))
    print(f"  wrote {prospects['meta']['n_prospects']} prospects")

    if args.skip_live:
        print("[5/6] Skipping live draft state (--skip-live)")
    else:
        print("[5/6] Live draft state (MFL API)...", flush=True)
        try:
            live = build_live_state()
            (OUT_DIR / "rookie_draft_hub_2026.json").write_text(json.dumps(live, indent=2))
            print(f"  wrote draft state, {len(live.get('draft_order', []))} picks queued, "
                  f"{len(live.get('picks_made', []))} picks made")
        except Exception as e:
            print(f"  ERROR: live fetch failed: {e}")

    print(f"\nDone in {time.time() - t0:.1f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
