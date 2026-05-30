"""
trade_roast_context.py — Build rich context dicts for Claude roast generation.

Consolidates: trade value model, rosters, standings history, owner profiles,
team summaries, auction comparables, and extension projections into a single
context payload that Claude can use to generate savage, data-backed roasts.
"""

import csv
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from trade_grader import (
    TradeAnalysis, PlayerInfo, mfl_fetch, load_franchises, load_players_map,
    load_rosters, load_rollover, load_auction_pool, load_team_caps,
    load_future_picks, load_trade_value_model, fetch_trades, analyze_trade,
    find_comparables, calculate_extension, estimate_production_value,
    TRADE_VALUE_MODEL,
)
from pick_valuation import pick_expected_points


# Round-level hit-or-smash rates from 14 seasons of UPS rookie drafts
# (site/rookies/rookie_draft_history.json). Used for qualitative pick framing
# in roasts — speak in terms of probability tiers, not raw EP numbers.
ROUND_HIT_RATES = {
    1: 0.43,   # ~43% hit-or-smash
    2: 0.21,   # ~21%
    3: 0.15,   # ~15%
    4: 0.15,
    5: 0.16,
    6: 0.20,   # IDP slot distorts upward
}


def round_hit_rate(round_: int) -> float:
    return ROUND_HIT_RATES.get(round_, 0.10)


# ── Dynasty SF ADP (FantasyCalc) — VETERANS + ROOKIES ──────────────────────
# Used by the roast to anchor TIER reasoning on real market ranks rather than
# stale auction-model dollar amounts.

_FANTASYCALC_CACHE_PATH = (Path(__file__).resolve().parent.parent / "data"
                           / "fantasycalc_sf_all_2026.json")
_FANTASYCALC_CACHE: dict | None = None


def _fetch_fantasycalc_all() -> dict:
    """Return {mfl_id: {overall_rank, pos_rank, value, position, name}}.

    Hits FantasyCalc Dynasty SF API. Caches to disk for 24h to avoid repeat
    network calls. On any failure returns {} (Opus falls back to its own
    positional knowledge in that case).
    """
    global _FANTASYCALC_CACHE
    if _FANTASYCALC_CACHE is not None:
        return _FANTASYCALC_CACHE

    # Try cached copy first
    if _FANTASYCALC_CACHE_PATH.exists():
        try:
            age_hours = (datetime.now().timestamp() -
                         _FANTASYCALC_CACHE_PATH.stat().st_mtime) / 3600
            if age_hours < 24:
                with open(_FANTASYCALC_CACHE_PATH) as f:
                    _FANTASYCALC_CACHE = json.load(f)
                    return _FANTASYCALC_CACHE
        except (json.JSONDecodeError, OSError):
            pass

    # Live fetch
    import urllib.request
    url = ("https://api.fantasycalc.com/values/current"
           "?isDynasty=true&numQbs=2&numTeams=12&ppr=1")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "upsmflproduction-roastbot/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            rows = json.loads(r.read())
    except Exception as e:
        print(f"[fantasycalc] fetch failed ({e}); skipping ADP enrichment")
        _FANTASYCALC_CACHE = {}
        return _FANTASYCALC_CACHE

    out = {}
    for entry in rows:
        p = entry.get("player") or {}
        mfl_id = str(p.get("mflId") or "").strip()
        if not mfl_id or mfl_id.upper() == "UNK":
            continue
        out[mfl_id] = {
            "name": p.get("name", ""),
            "position": p.get("position", ""),
            "overall_rank": entry.get("overallRank"),
            "pos_rank": entry.get("positionRank"),
            "value": entry.get("value"),
            "trend30": entry.get("trend30Day"),
            "is_rookie": (p.get("maybeYoe") == 0),
        }

    # Cache to disk
    try:
        _FANTASYCALC_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with open(_FANTASYCALC_CACHE_PATH, "w") as f:
            json.dump(out, f)
    except OSError:
        pass

    _FANTASYCALC_CACHE = out
    return out


def get_dynasty_rank(mfl_id: str) -> dict:
    """Look up a player's dynasty SF rank by MFL id. Returns empty dict if
    not in the cache (FantasyCalc maps most NFL fantasy-relevant players,
    but obscure ones may be missing)."""
    return _fetch_fantasycalc_all().get(str(mfl_id), {})


def display_name(mfl_name: str) -> str:
    """Convert MFL 'Last, First' to 'First Last' for human-readable output."""
    if "," in mfl_name:
        parts = mfl_name.split(",", 1)
        return f"{parts[1].strip()} {parts[0].strip()}"
    return mfl_name

_ETL_ROOT = Path(__file__).resolve().parent.parent
# Franchise career stats JSON. Override via FRANCHISE_CAREER_STATS_PATH env var.
# Falls back to iCloud-synced parallel workspace if repo copy is missing.
_CAREER_CANDIDATES = [
    os.environ.get("FRANCHISE_CAREER_STATS_PATH"),
    str(_ETL_ROOT / "data" / "franchise_career_stats.json"),
    str(Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs"
        / "Documents" / "mfl" / "Development" / "pipelines" / "etl" / "data"
        / "franchise_career_stats.json"),
]
CAREER_STATS_PATH = Path(next(
    (p for p in _CAREER_CANDIDATES if p and Path(p).exists()),
    _CAREER_CANDIDATES[1]
))

# Discord user mapping CSV — contains owner/team/discord-id PII. Set
# DISCORD_USERS_CSV env var to override the default location. Default points
# to Keith's iCloud-synced copy on macOS; on a deploy host, set the env var.
_DEFAULT_DISCORD_CSV = Path.home() / "Library" / "Mobile Documents" / "com~apple~CloudDocs" / "Documents" / "mfl" / "mfl_python" / "dev" / "import_discord_info.csv"
DISCORD_USERS_CSV = Path(os.environ.get("DISCORD_USERS_CSV", str(_DEFAULT_DISCORD_CSV)))


def load_career_stats() -> dict:
    if not CAREER_STATS_PATH.exists():
        return {}
    with open(CAREER_STATS_PATH) as f:
        return json.load(f)


def load_trade_value_model_full() -> dict:
    """Load the full trade value model including owner_profiles and team_summary."""
    if not TRADE_VALUE_MODEL.exists():
        return {}
    with open(TRADE_VALUE_MODEL) as f:
        return json.load(f)


def get_model_generated_at() -> Optional[str]:
    """Return an ISO timestamp for when the auction model was last built.

    Prefers a meta.generated_at field inside trade_value_model.json; falls
    back to the file mtime. Used by the roast prompt to soften tier claims
    when the underlying market data is stale.
    """
    if not TRADE_VALUE_MODEL.exists():
        return None
    try:
        with open(TRADE_VALUE_MODEL) as f:
            data = json.load(f)
        meta = data.get("meta", {})
        if isinstance(meta, dict) and meta.get("generated_at"):
            return meta["generated_at"]
    except (json.JSONDecodeError, OSError):
        pass
    mtime = TRADE_VALUE_MODEL.stat().st_mtime
    return datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat()


# ── Trade-time context helpers ─────────────────────────────────────────────

def detect_in_trade_extension(contract_info: str) -> Optional[str]:
    """Return the extension owner code if the contract was extended as part of
    a trade (e.g. "Ext: LH"). Returns None if no in-trade extension marker."""
    if not contract_info:
        return None
    import re
    m = re.search(r"Ext:\s*([A-Za-z0-9 ]+?)(?:\||$)", contract_info)
    if m:
        return m.group(1).strip()
    return None


def get_player_scoring_context(player_id: str, position: str,
                                year: int, through_week: int) -> dict:
    """Get season PPG, last-3-week PPG, and position rank for a player as of
    a given week. Returns empty dict if data unavailable.

    Reads from MFL playerScores API (in-season). For pre-season or out-of-season
    trades, returns empty — caller should use preseason ADP instead.
    """
    if through_week <= 0:
        return {}
    try:
        data = mfl_fetch("playerScores", PLAYERS=player_id, YEAR=year)
        all_weeks = data.get("playerScores", {}).get("playerScore", [])
        if isinstance(all_weeks, dict):
            all_weeks = [all_weeks]
        # playerScores returns {week: ..., playerScore: {score, ...}} structure varies
        scores = []
        for entry in all_weeks:
            wk = int(entry.get("week", 0))
            ps = entry.get("playerScore", entry)
            score_str = ps.get("score", "") if isinstance(ps, dict) else ""
            if wk and wk <= through_week and score_str:
                try:
                    scores.append((wk, float(score_str)))
                except ValueError:
                    pass
    except Exception:
        return {}

    if not scores:
        return {}

    season_ppg = sum(s for _, s in scores) / len(scores)
    last3 = [s for w, s in scores if w >= max(1, through_week - 2)]
    last3_ppg = sum(last3) / len(last3) if last3 else None

    # Position rank: too expensive to compute live for every player. Defer
    # to a precomputed lookup or a separate aggregator if available. For
    # now leave rank empty — Opus will work with PPG + hot/cold trend alone.
    return {
        "games_played": len(scores),
        "season_ppg": round(season_ppg, 1),
        "last3_ppg": round(last3_ppg, 1) if last3_ppg is not None else None,
        "trend": ("HOT" if last3_ppg and last3_ppg > season_ppg * 1.15 else
                  "COLD" if last3_ppg and last3_ppg < season_ppg * 0.85 else
                  "STEADY") if last3_ppg is not None else None,
    }


def nfl_week_from_timestamp(timestamp: int) -> int:
    """Approximate NFL week for a unix timestamp. Returns 0 for offseason.

    NFL regular season runs ~Sep first Thursday through early January.
    Uses a simple calendar mapping; precise week boundaries vary slightly.
    """
    from datetime import datetime as _dt
    dt = _dt.fromtimestamp(timestamp)
    year = dt.year
    if dt.month < 9:
        return 0  # offseason
    if dt.month == 9:
        # Week 1 typically starts first Thursday in September
        return max(1, (dt.day - 4) // 7 + 1)
    # Oct=W5-9, Nov=W9-13, Dec=W13-17, early Jan=W18
    week_starts = {10: 5, 11: 9, 12: 13, 1: 17}
    base = week_starts.get(dt.month if dt.month <= 12 else 1, 0)
    return base + (dt.day - 1) // 7


def build_pick_context(picks: list) -> list:
    """For each pick in a trade, attach expected-value points and round-level
    hit-rate context. Returns enriched list."""
    enriched = []
    for pk in picks:
        rnd = pk.get("round") or pk.get("pick_round") or 0
        slot = pk.get("slot") or pk.get("pick_pick") or None
        year = pk.get("year") or pk.get("pick_year") or 0
        owner = pk.get("from_franchise") or pk.get("original_owner", "")
        try:
            ev = pick_expected_points(year=int(year), round_=int(rnd),
                                      original_owner=owner, slot=slot)
        except Exception:
            ev = None
        enriched.append({
            **pk,
            "round": rnd,
            "slot": slot,
            "year": year,
            "expected_points_3yr": round(ev, 1) if ev else None,
            "round_hit_rate": round_hit_rate(int(rnd)) if rnd else None,
        })
    return enriched


def load_discord_users() -> dict:
    """Return {franchise_id: {owner_name, discord_username, discord_userid}}."""
    out = {}
    if not DISCORD_USERS_CSV.exists():
        return out
    with open(DISCORD_USERS_CSV) as f:
        reader = csv.DictReader(f)
        for row in reader:
            fid = row.get("franchise_id", "").strip().zfill(4)
            if fid and fid != "0013":  # skip commish entry
                out[fid] = {
                    "owner_name": row.get("owner_name", ""),
                    "discord_username": row.get("discord_username", ""),
                    "discord_userid": row.get("discord_userid", ""),
                    "team_name": row.get("team_name", ""),
                }
    return out


def get_owner_profile(franchise_id: str, tv_full: dict) -> dict:
    """Get owner profile from trade value model."""
    for op in tv_full.get("owner_profiles", []):
        if op.get("franchise_id") == franchise_id:
            return op
    return {}


def get_team_summary(franchise_id: str, tv_full: dict) -> dict:
    """Get team summary from trade value model."""
    for ts in tv_full.get("team_summary", []):
        if ts.get("franchise_id") == franchise_id:
            return ts
    return {}


def get_h2h_record(career_stats: dict, fid_a: str, fid_b: str) -> dict:
    """Get head-to-head record between two franchises."""
    stats_a = career_stats.get(fid_a, {})
    h2h = stats_a.get("h2h", {}).get(fid_b, {})
    return h2h


def build_franchise_context(franchise_id: str, career_stats: dict,
                            tv_full: dict, discord_users: dict,
                            franchises: dict | None = None) -> dict:
    """Build complete context for one franchise.

    franchises (optional): the load_franchises() dict — falls back here for
    franchise_name and owner_name when career_stats/trade_value_model don't
    cover this franchise.
    """
    cs = career_stats.get(franchise_id, {})
    op = get_owner_profile(franchise_id, tv_full)
    ts = get_team_summary(franchise_id, tv_full)
    du = discord_users.get(franchise_id, {})
    fr = (franchises or {}).get(franchise_id, {}) if franchises else {}

    # Owner-specific stats (only their tenure)
    owner = cs.get("owner", {})

    return {
        "franchise_id": franchise_id,
        "franchise_name": (cs.get("franchise_name") or op.get("team_name")
                           or fr.get("name") or du.get("team_name")
                           or f"Franchise {franchise_id}"),
        "owner_name": (owner.get("display") or du.get("owner_name")
                       or fr.get("owner_name") or ""),
        "discord_username": du.get("discord_username", ""),

        # OWNER stats (their tenure only — this is what the roast should cite)
        "owner_since": owner.get("first_season", 2017),
        "owner_seasons": owner.get("seasons_count", 0),
        "owner_allplay": owner.get("allplay", {}),
        "owner_allplay_pct": owner.get("allplay_pct", 0),
        "owner_overall": owner.get("overall", {}),
        "owner_championships": owner.get("championships", 0),
        "owner_playoff_appearances": owner.get("playoff_appearances", 0),
        "owner_best_finish": owner.get("best_finish"),
        "owner_worst_finish": owner.get("worst_finish"),

        # Franchise-wide history (for context, not direct attribution)
        "franchise_championships": cs.get("championships", 0),
        "franchise_last_championship": cs.get("last_championship"),
        "franchise_championship_drought": cs.get("championship_drought", 0),
        "franchise_allplay_pct": cs.get("career_allplay_pct", 0),
        "franchise_seasons": cs.get("seasons_played", 0),
        "best_season": cs.get("best_season"),
        "worst_season": cs.get("worst_season"),
        "trend": cs.get("trend", []),

        # Owner profile (auction tendencies)
        "auction_style": op.get("auction_style", ""),
        "deal_rate": op.get("deal_rate", 0),
        "avg_value_delta": op.get("avg_value_delta", 0),
        "picks_traded_away": op.get("picks_traded_away", 0),
        "picks_acquired": op.get("picks_acquired", 0),
        "r1_away": op.get("r1_away", 0),
        "r1_in": op.get("r1_in", 0),
        "position_targeting": op.get("position_targeting", {}),

        # Team summary (current state)
        "tier": ts.get("tier", ""),
        "roster_size": ts.get("roster_size", 0),
        "total_tv": ts.get("total_tv", 0),
        "cap_space": ts.get("cap_space", 0),
        "total_salary": ts.get("total_salary", 0),
        "needs": ts.get("needs", []),
        "recent_record": ts.get("recent_record", ""),
        "recent_finish": ts.get("recent_finish", 0),
        "allplay_pct_current": ts.get("allplay_pct", 0),
    }


def build_trade_roast_context(trade_txn: dict,
                               extension_years: int = 0,
                               extension_player_id: str = "") -> dict:
    """Build the complete roast context for a trade.

    Returns a dict with everything Claude needs to write a savage roast.
    """
    # Load all data
    franchises = load_franchises()
    players_map = load_players_map()
    rosters = load_rosters()
    rollover = load_rollover()
    auction_pool = load_auction_pool()
    team_caps = load_team_caps()
    future_picks = load_future_picks()
    tv_model = load_trade_value_model()
    tv_full = load_trade_value_model_full()
    career_stats = load_career_stats()
    discord_users = load_discord_users()

    # Run core analysis
    analysis = analyze_trade(
        trade_txn, players_map, franchises, rosters,
        rollover, auction_pool, team_caps, future_picks, tv_model
    )

    a = analysis.side_a
    b = analysis.side_b

    # Build franchise contexts
    ctx_a = build_franchise_context(a.franchise_id, career_stats, tv_full, discord_users, franchises)
    ctx_b = build_franchise_context(b.franchise_id, career_stats, tv_full, discord_users, franchises)

    # H2H between the two teams
    h2h = get_h2h_record(career_stats, a.franchise_id, b.franchise_id)

    # Auction comparables
    all_players = a.players_given + b.players_given
    comparables = {}
    for p in all_players:
        if p.position and p.position not in comparables:
            comparables[p.position] = find_comparables(
                p, auction_pool, players_map, tv_model)

    # Extension projections
    extensions = {}
    if extension_years > 0:
        for p in all_players:
            if extension_player_id and p.player_id != extension_player_id:
                continue
            try:
                extensions[p.player_id] = calculate_extension(p, extension_years)
            except Exception:
                pass

    # Determine in-season context: derive NFL week from trade timestamp
    trade_ts = int(analysis.timestamp or 0)
    trade_year = (datetime.fromtimestamp(trade_ts).year
                  if trade_ts else datetime.now().year)
    nfl_week = nfl_week_from_timestamp(trade_ts) if trade_ts else 0
    through_week = max(0, nfl_week - 1)  # use completed weeks only
    in_season = nfl_week > 0

    # Build player details for context
    def player_detail(p: PlayerInfo) -> dict:
        d = {
            "name": display_name(p.name),
            "position": p.position,
            "team": p.team,
            "salary": p.salary,
            # NOTE: expected_auction_price is from a stale model — kept in the
            # payload for back-compat with grade math but NOT surfaced to Opus.
            "_internal_expected_auction_price": int(p.exp_price) if p.exp_price else int(
                estimate_production_value(p, auction_pool)),
            "ppg": round(p.expected_ppg, 1),
            "trade_value": round(p.trade_value, 1),
            "quality_score": round(p.quality_score, 1),
            "contract_info": p.contract_info,
            "contract_status": p.contract_status,
            "in_trade_extension_owner": detect_in_trade_extension(p.contract_info),
        }
        # Attach dynasty SF ADP rank (FantasyCalc) — this is the tier anchor
        dyn = get_dynasty_rank(p.player_id)
        if dyn:
            d["dynasty_sf_rank"] = dyn.get("overall_rank")
            d["dynasty_sf_pos_rank"] = dyn.get("pos_rank")
            d["dynasty_sf_value"] = dyn.get("value")
            d["dynasty_trend30"] = dyn.get("trend30")
        if in_season and through_week > 0:
            scoring = get_player_scoring_context(
                p.player_id, p.position, trade_year, through_week)
            if scoring:
                d["season_scoring"] = scoring
        return d

    # Traded salary adjustment
    bb_a_to_b = b.salary_given  # BB from B to A
    bb_b_to_a = a.salary_given  # BB from A to B

    # Enrich picks with EV + round hit-rate.
    # PickInfo schema: year, round, original_owner, original_owner_name,
    # estimated_value, expected_points, predicted_slot, rookie_aav.
    #
    # IMPORTANT slot handling:
    #   - Current-draft-year picks have a real slot (from draft order).
    #   - FUTURE picks (year > season_year) have only a PREDICTED slot used
    #     internally for EV math. Do NOT expose predicted_slot as a concrete
    #     slot in the prompt — it misleads Opus into citing a specific pick
    #     position. Instead, surface the originating franchise so Opus can
    #     reason about historical finish as the precedent.
    def pick_dict(pk):
        is_future = int(pk.year or 0) > int(trade_year or 0)
        predicted_slot = getattr(pk, "predicted_slot", 0) or None
        from_fr = getattr(pk, "original_owner", "") or ""
        d = {
            "year": pk.year, "round": pk.round,
            "from_franchise": from_fr,
            "from_franchise_name": getattr(pk, "original_owner_name", "") or "",
            "value": pk.estimated_value,
            "is_future_pick": is_future,
            "expected_points_3yr": (round(pk.expected_points, 1)
                                    if getattr(pk, "expected_points", 0) else None),
        }
        # Slot: only for current-draft picks. Future picks get None.
        if not is_future and predicted_slot:
            d["slot"] = predicted_slot
        else:
            d["slot"] = None
        # Fall back to computing EV if not already on the PickInfo
        if d["expected_points_3yr"] is None:
            try:
                d["expected_points_3yr"] = round(pick_expected_points(
                    year=int(pk.year), round_=int(pk.round),
                    original_owner=from_fr, slot=predicted_slot), 1)
            except Exception:
                pass
        d["round_hit_rate"] = round_hit_rate(int(pk.round)) if pk.round else None
        # For future picks, attach the CURRENT OWNER's record only — not the
        # franchise's history under prior owners. If the current owner has
        # under 3 seasons of data, flag that explicitly so Opus doesn't
        # over-extrapolate from a small sample.
        if is_future and from_fr:
            cs = career_stats.get(from_fr, {})
            owner = cs.get("owner", {}) or {}
            owner_first_season = owner.get("first_season")
            owner_seasons = owner.get("seasons_count", 0)
            trend = cs.get("trend", []) or []
            # Filter trend to seasons under the current owner only
            if owner_first_season:
                owner_trend = [t for t in trend
                              if (t.get("season") or 0) >= owner_first_season]
            else:
                owner_trend = trend
            owner_finishes = [t.get("finish") for t in owner_trend if t.get("finish")]
            d["origin_owner_finishes"] = owner_finishes
            d["origin_owner_seasons"] = owner_seasons
            d["origin_owner_first_season"] = owner_first_season
            d["origin_owner_name"] = owner.get("display", "")
            d["origin_sample_warning"] = (
                "INSUFFICIENT_SAMPLE" if owner_seasons < 3 else "OK"
            )
        return d

    context = {
        "model_generated_at": get_model_generated_at(),
        "trade": {
            "timestamp": analysis.timestamp,
            "comments": analysis.comments,
            "nfl_week_at_trade": nfl_week,
            "in_season": in_season,
            "season_year": trade_year,
        },
        "round_hit_rate_baseline": {
            "R1": "~43% hit-or-smash",
            "R2": "~21%",
            "R3": "~15%",
            "R4": "~15%",
            "R5+": "~15%",
        },
        "side_a": {
            "franchise": ctx_a,
            "grade": a.grade,
            "grade_score": round(a.grade_score, 1),
            "players_given": [player_detail(p) for p in a.players_given],
            "picks_given": [pick_dict(pk) for pk in a.picks_given],
            "salary_given": a.salary_given,
            "players_received": [player_detail(p) for p in a.players_received],
            "picks_received": [pick_dict(pk) for pk in a.picks_received],
            "salary_received": a.salary_received,
            "post_trade_salary": a.total_roster_salary,
            "post_trade_cap": a.cap_space,
        },
        "side_b": {
            "franchise": ctx_b,
            "grade": b.grade,
            "grade_score": round(b.grade_score, 1),
            "players_given": [player_detail(p) for p in b.players_given],
            "picks_given": [pick_dict(pk) for pk in b.picks_given],
            "salary_given": b.salary_given,
            "players_received": [player_detail(p) for p in b.players_received],
            "picks_received": [pick_dict(pk) for pk in b.picks_received],
            "salary_received": b.salary_received,
            "post_trade_salary": b.total_roster_salary,
            "post_trade_cap": b.cap_space,
        },
        "h2h_between_teams": h2h,
        "auction_comparables": comparables,
        "extension_projections": extensions,
        "effective_cost_note": "",
    }

    # Add effective cost note if BB was traded
    for side_key, side in [("side_a", a), ("side_b", b)]:
        received_players = side.players_received
        bb_received = side.salary_received
        if bb_received > 0 and received_players:
            player = received_players[0]
            effective = player.salary - bb_received
            context["effective_cost_note"] = (
                f"{display_name(player.name)} has a ${player.salary:,} salary, but with "
                f"${bb_received:,} in traded salary, the effective cost to "
                f"{side.franchise_name} is ${effective:,}."
            )

    return context


def context_to_prompt_text(ctx: dict) -> str:
    """Convert context dict to a readable text block for Claude's prompt."""
    lines = []

    def ln(s=""):
        lines.append(s)

    t = ctx["trade"]
    a = ctx["side_a"]
    b = ctx["side_b"]

    mga = ctx.get("model_generated_at")
    if mga:
        ln(f"=== AUCTION MODEL FRESHNESS ===")
        ln(f"model_generated_at: {mga}")
        ln()

    # Trade timing context
    if t.get("in_season"):
        ln(f"=== TRADE TIMING ===")
        ln(f"In-season: NFL Week {t.get('nfl_week_at_trade')} ({t.get('season_year')})")
        ln(f"Cite player rank/hot-cold from in-season scoring; do NOT use auction comparables.")
        ln()
    elif t.get("season_year"):
        ln(f"=== TRADE TIMING ===")
        ln(f"Offseason ({t.get('season_year')}). Prior-season records are tangential.")
        ln(f"Lead with pick value/curve and contract optionality.")
        ln()

    # Round-level hit-rate baseline (always include if picks present)
    if any(side.get("picks_given") or side.get("picks_received") for side in (a, b)):
        ln(f"=== ROUND-LEVEL HIT/SMASH RATES (UPS history) ===")
        for round_label, rate in ctx.get("round_hit_rate_baseline", {}).items():
            ln(f"  {round_label}: {rate}")
        ln(f"Use these qualitatively; pick value curve falls off exponentially across R1-R3.")
        ln()

    def pick_line(pk):
        bits = [f"{pk['year']} Round {pk['round']}"]
        # Only show slot for CURRENT-DRAFT picks (real slot from draft order).
        # Future picks: slot is a prediction; do not expose it.
        if pk.get("slot") and not pk.get("is_future_pick"):
            bits.append(f"slot {pk['slot']}")
        if pk.get("from_franchise_name"):
            bits.append(f"orig: {pk['from_franchise_name']}")
        elif pk.get("from_franchise"):
            bits.append(f"orig: {pk['from_franchise']}")
        # For future picks: surface the CURRENT OWNER's finish history only.
        # Flag insufficient sample (owner < 3 seasons) so Opus doesn't
        # extrapolate from prior owners' results.
        if pk.get("is_future_pick"):
            finishes = pk.get("origin_owner_finishes") or []
            seasons = pk.get("origin_owner_seasons", 0)
            owner_name = pk.get("origin_owner_name", "")
            if pk.get("origin_sample_warning") == "INSUFFICIENT_SAMPLE":
                bits.append(
                    f"originating owner ({owner_name}) has {seasons} season(s) "
                    f"of data: finishes {finishes} (slot TBD, sample too small "
                    f"to project — use round-level hit rate only)"
                )
            elif finishes:
                bits.append(
                    f"originating owner ({owner_name}) recent finishes: "
                    f"{finishes} (slot TBD)"
                )
            else:
                bits.append("originating owner finish history unavailable (slot TBD)")
        if pk.get("round_hit_rate"):
            bits.append(f"hit/smash baseline {int(pk['round_hit_rate']*100)}%")
        return f"  - " + " | ".join(bits)

    def player_line(p):
        # Replace stale auction-model dollar with dynasty SF ADP rank (the
        # market tier anchor). PPG is kept as a production signal but is a
        # rough 3yr expected; the rank tells us where the market puts them.
        line = (f"  - {p['name']} ({p['position']}) — ${p['salary']:,} salary, "
                f"{p['ppg']} PPG (3yr exp)")
        if p.get("dynasty_sf_rank"):
            pos = p.get("position", "")
            line += (f", **Dynasty SF #{p['dynasty_sf_rank']} overall"
                     f" / {pos}#{p.get('dynasty_sf_pos_rank', '?')}**")
            if p.get("dynasty_trend30"):
                trend = p["dynasty_trend30"]
                arrow = "↑" if trend > 0 else "↓" if trend < 0 else "→"
                line += f" (trend30 {arrow}{abs(trend)})"
        if p.get("contract_status"):
            line += f" [{p['contract_status']}]"
        if p.get("in_trade_extension_owner"):
            line += f" [IN-TRADE EXT BY: {p['in_trade_extension_owner']}]"
        if p.get("season_scoring"):
            sc = p["season_scoring"]
            line += (f"\n    Season-to-date: {sc.get('season_ppg','?')} PPG "
                     f"({sc.get('games_played','?')} games)")
            if sc.get("last3_ppg") is not None:
                line += f", last-3wk {sc['last3_ppg']} PPG ({sc.get('trend','?')})"
        return line

    ln("=== TRADE ===")
    fa = a["franchise"]
    fb = b["franchise"]
    ln(f"{fa['franchise_name']} gave:")
    for pk in a["picks_given"]:
        ln(pick_line(pk))
    for p in a["players_given"]:
        ln(player_line(p))
    if a["salary_given"]:
        ln(f"  - ${a['salary_given']:,} in traded salary")

    ln(f"{fb['franchise_name']} gave:")
    for pk in b["picks_given"]:
        ln(pick_line(pk))
    for p in b["players_given"]:
        ln(player_line(p))
    if b["salary_given"]:
        ln(f"  - ${b['salary_given']:,} in traded salary")

    if ctx["effective_cost_note"]:
        ln(f"\nEFFECTIVE COST: {ctx['effective_cost_note']}")

    ln(f"\nTrade comment: \"{t.get('comments', '')}\"")

    # Grades
    ln(f"\n=== GRADES ===")
    ln(f"{fa['franchise_name']}: {a['grade']} ({a['grade_score']:+.1f}%)")
    ln(f"{fb['franchise_name']}: {b['grade']} ({b['grade_score']:+.1f}%)")

    # Extension projections
    if ctx["extension_projections"]:
        ln(f"\n=== EXTENSION PROJECTIONS ===")
        for pid, ext in ctx["extension_projections"].items():
            ln(f"  Current AAV: ${ext['current_aav']:,}")
            ln(f"  Extension raise: +${ext['raise']:,}")
            ln(f"  New AAV (extended years): ${ext['new_aav']:,}")
            ln(f"  Current year salary: ${ext['current_salary']:,}")
            for i, sal in enumerate(ext["extension_salaries"], 1):
                ln(f"  Extension year {i}: ${sal:,}")
            ln(f"  Total commitment: ${ext['total_commitment']:,} over {ext['total_years']} years")
            ln(f"  Effective AAV: ${ext['effective_aav']:,}")

    # Auction alternatives — show by dynasty SF position rank (ADP tier),
    # not by stale dollar projections. The auction-model dollars are a known
    # stale signal and must not appear in the roast.
    if ctx["auction_comparables"]:
        ln(f"\n=== FREE AGENTS BY DYNASTY SF ADP RANK (cost $0 in picks) ===")
        ln(f"(Tier reasoning: use these ranks, not dollar projections.)")
        for pos, comps in ctx["auction_comparables"].items():
            # Re-sort by dynasty SF position rank if available, else fall back
            # to expected_auction_price order (legacy).
            def _rank_key(c):
                pid = c.get("player_id", "")
                dyn = get_dynasty_rank(pid)
                pr = dyn.get("pos_rank")
                return pr if pr is not None else 999
            sorted_comps = sorted(comps, key=_rank_key)
            ln(f"  {pos}:")
            for c in sorted_comps[:8]:
                pid = c.get("player_id", "")
                dyn = get_dynasty_rank(pid)
                name = c["name"]
                if dyn.get("pos_rank"):
                    rank_str = f"{pos}#{dyn['pos_rank']} (overall #{dyn.get('overall_rank','?')})"
                else:
                    rank_str = "rank unmapped"
                ln(f"    {name:<25} {rank_str}")

    # Franchise context for each side
    for side_key, label in [("side_a", "TEAM A"), ("side_b", "TEAM B")]:
        side = ctx[side_key]
        f = side["franchise"]
        ln(f"\n=== {label}: {f['franchise_name']} ===")
        ln(f"  Owner: {f['owner_name']} (since {f['owner_since']}, {f['owner_seasons']} season(s))")
        ln(f"  Current tier: {f['tier']}")
        ln(f"  Recent record: {f['recent_record']} (finish: #{f['recent_finish']})")

        # Owner's personal record (USE THIS FOR ROASTING)
        oap = f.get("owner_allplay", {})
        if oap:
            ln(f"  {f['owner_name']}'s allplay record: {oap.get('w',0)}-{oap.get('l',0)} ({f['owner_allplay_pct']:.3f})")
        ln(f"  {f['owner_name']}'s championships: {f['owner_championships']}")
        ln(f"  {f['owner_name']}'s playoff appearances: {f['owner_playoff_appearances']} in {f['owner_seasons']} season(s)")
        if f["owner_best_finish"]:
            ln(f"  {f['owner_name']}'s best finish: #{f['owner_best_finish']}")
        if f["owner_worst_finish"]:
            ln(f"  {f['owner_name']}'s worst finish: #{f['owner_worst_finish']}")

        # Franchise history (for inherited context)
        if f["franchise_championships"] > 0:
            ln(f"  Franchise history: {f['franchise_championships']} championship(s), "
               f"last in {f['franchise_last_championship']} ({f['franchise_championship_drought']} years ago)")
        else:
            ln(f"  Franchise history: ZERO championships in {f['franchise_seasons']} seasons")

        ln(f"  Auction style: {f['auction_style']}")
        ln(f"  Deal rate: {f['deal_rate']}%")
        pt = f.get("position_targeting", {})
        for pos in ("QB", "RB", "WR", "TE"):
            if pos in pt:
                pd = pt[pos]
                ln(f"  {pos} bidding: avg bid ${pd.get('avg_bid',0):,}, "
                   f"avg value delta ${pd.get('avg_delta',0):+,}")

        ln(f"  Post-trade salary: ${side['post_trade_salary']:,} / $300K cap")
        ln(f"  Post-trade cap space: ${side['post_trade_cap']:,}")

        if f.get("trend"):
            ln(f"  Recent trend (franchise, not necessarily current owner):")
            for t in f["trend"]:
                ln(f"    {t['season']}: allplay {t['allplay_pct']:.3f}, finish #{t['finish']}")

    # H2H
    h2h = ctx.get("h2h_between_teams", {})
    if h2h:
        ln(f"\n=== HEAD-TO-HEAD ===")
        ln(f"  {ctx['side_a']['franchise']['franchise_name']} vs "
           f"{ctx['side_b']['franchise']['franchise_name']}: "
           f"{h2h.get('w',0)}-{h2h.get('l',0)} ({h2h.get('games',0)} games)")

    return "\n".join(lines)
