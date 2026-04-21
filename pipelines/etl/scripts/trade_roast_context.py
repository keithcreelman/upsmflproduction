"""
trade_roast_context.py — Build rich context dicts for Claude roast generation.

Consolidates: trade value model, rosters, standings history, owner profiles,
team summaries, auction comparables, and extension projections into a single
context payload that Claude can use to generate savage, data-backed roasts.
"""

import csv
import json
from pathlib import Path
from typing import Optional

from trade_grader import (
    TradeAnalysis, PlayerInfo, mfl_fetch, load_franchises, load_players_map,
    load_rosters, load_rollover, load_auction_pool, load_team_caps,
    load_future_picks, load_trade_value_model, fetch_trades, analyze_trade,
    find_comparables, calculate_extension, estimate_production_value,
    TRADE_VALUE_MODEL,
)


def display_name(mfl_name: str) -> str:
    """Convert MFL 'Last, First' to 'First Last' for human-readable output."""
    if "," in mfl_name:
        parts = mfl_name.split(",", 1)
        return f"{parts[1].strip()} {parts[0].strip()}"
    return mfl_name

CAREER_STATS_PATH = Path(__file__).resolve().parent.parent / "data" / "franchise_career_stats.json"
DISCORD_USERS_CSV = Path("/Users/keithcreelman/Documents/mfl/mfl_python/dev/import_discord_info.csv")


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
                            tv_full: dict, discord_users: dict) -> dict:
    """Build complete context for one franchise."""
    cs = career_stats.get(franchise_id, {})
    op = get_owner_profile(franchise_id, tv_full)
    ts = get_team_summary(franchise_id, tv_full)
    du = discord_users.get(franchise_id, {})

    # Owner-specific stats (only their tenure)
    owner = cs.get("owner", {})

    return {
        "franchise_id": franchise_id,
        "franchise_name": cs.get("franchise_name", op.get("team_name", "")),
        "owner_name": owner.get("display", du.get("owner_name", "")),
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
    ctx_a = build_franchise_context(a.franchise_id, career_stats, tv_full, discord_users)
    ctx_b = build_franchise_context(b.franchise_id, career_stats, tv_full, discord_users)

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

    # Build player details for context
    def player_detail(p: PlayerInfo) -> dict:
        return {
            "name": display_name(p.name),
            "position": p.position,
            "team": p.team,
            "salary": p.salary,
            "expected_auction_price": int(p.exp_price) if p.exp_price else int(
                estimate_production_value(p, auction_pool)),
            "ppg": round(p.expected_ppg, 1),
            "trade_value": round(p.trade_value, 1),
            "quality_score": round(p.quality_score, 1),
            "contract_info": p.contract_info,
            "contract_status": p.contract_status,
        }

    # Traded salary adjustment
    bb_a_to_b = b.salary_given  # BB from B to A
    bb_b_to_a = a.salary_given  # BB from A to B

    context = {
        "trade": {
            "timestamp": analysis.timestamp,
            "comments": analysis.comments,
        },
        "side_a": {
            "franchise": ctx_a,
            "grade": a.grade,
            "grade_score": round(a.grade_score, 1),
            "players_given": [player_detail(p) for p in a.players_given],
            "picks_given": [{"year": pk.year, "round": pk.round,
                             "value": pk.estimated_value} for pk in a.picks_given],
            "salary_given": a.salary_given,
            "players_received": [player_detail(p) for p in a.players_received],
            "picks_received": [{"year": pk.year, "round": pk.round,
                                "value": pk.estimated_value} for pk in a.picks_received],
            "salary_received": a.salary_received,
            "post_trade_salary": a.total_roster_salary,
            "post_trade_cap": a.cap_space,
        },
        "side_b": {
            "franchise": ctx_b,
            "grade": b.grade,
            "grade_score": round(b.grade_score, 1),
            "players_given": [player_detail(p) for p in b.players_given],
            "picks_given": [{"year": pk.year, "round": pk.round,
                             "value": pk.estimated_value} for pk in b.picks_given],
            "salary_given": b.salary_given,
            "players_received": [player_detail(p) for p in b.players_received],
            "picks_received": [{"year": pk.year, "round": pk.round,
                                "value": pk.estimated_value} for pk in b.picks_received],
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

    ln("=== TRADE ===")
    fa = a["franchise"]
    fb = b["franchise"]
    ln(f"{fa['franchise_name']} gave:")
    for pk in a["picks_given"]:
        ln(f"  - {pk['year']} Round {pk['round']} pick (est. value ${pk['value']:,})")
    for p in a["players_given"]:
        ln(f"  - {p['name']} ({p['position']}) — ${p['salary']:,} salary, "
           f"expected auction price ${p['expected_auction_price']:,}, {p['ppg']} PPG")
    if a["salary_given"]:
        ln(f"  - ${a['salary_given']:,} in traded salary")

    ln(f"{fb['franchise_name']} gave:")
    for pk in b["picks_given"]:
        ln(f"  - {pk['year']} Round {pk['round']} pick (est. value ${pk['value']:,})")
    for p in b["players_given"]:
        ln(f"  - {p['name']} ({p['position']}) — ${p['salary']:,} salary, "
           f"expected auction price ${p['expected_auction_price']:,}, {p['ppg']} PPG")
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

    # Auction alternatives
    ln(f"\n=== FREE AGENT AUCTION ALTERNATIVES (cost $0 in picks) ===")
    for pos, comps in ctx["auction_comparables"].items():
        ln(f"  {pos}:")
        for c in comps[:6]:
            ln(f"    {c['name']:<25} Expected price: ${c['exp_price']:>8,.0f}  "
               f"PPG: {c.get('exp_ppg', 0):.1f}")

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
