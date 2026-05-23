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
# Rookie-pick historical hit rates by band (smash/hit/contrib/bust).
# Used to attach expected-value framing to each pick in the roast context.
ROOKIE_TIERS_PATH = Path(__file__).resolve().parent.parent.parent.parent / "site" / "rookies" / "rookie_draft_tiers.json"
# Owner/team mapping — JSON in the repo is the canonical source (exported
# from D1 discord_owners table). CSV is the legacy fallback for old deploys.
DISCORD_OWNERS_JSON = Path(__file__).resolve().parent.parent / "data" / "discord_owners.json"
DISCORD_USERS_CSV = Path("/Users/keithcreelman/Documents/mfl/mfl_python/dev/import_discord_info.csv")


def load_career_stats() -> dict:
    if not CAREER_STATS_PATH.exists():
        return {}
    with open(CAREER_STATS_PATH) as f:
        return json.load(f)


_ROOKIE_TIERS_CACHE = None
def load_rookie_tiers() -> dict:
    global _ROOKIE_TIERS_CACHE
    if _ROOKIE_TIERS_CACHE is not None:
        return _ROOKIE_TIERS_CACHE
    if not ROOKIE_TIERS_PATH.exists():
        _ROOKIE_TIERS_CACHE = {}
        return _ROOKIE_TIERS_CACHE
    with open(ROOKIE_TIERS_PATH) as f:
        _ROOKIE_TIERS_CACHE = json.load(f)
    return _ROOKIE_TIERS_CACHE


def pick_band_for_slot(rnd: int, slot: int) -> str:
    """Map (round, slot) to a tier band key like '3.01-04', '3.05-08', '3.09-12'.
    For slot=0 (unknown), returns round-level fallback like '3.01-12'.
    """
    if slot < 1 or slot > 12:
        # Unknown slot — use round-average across quarters
        return f"{rnd}.01-12"  # synthetic key, looked up via aggregation below
    if slot <= 4:
        return f"{rnd}.01-04"
    if slot <= 8:
        return f"{rnd}.05-08"
    return f"{rnd}.09-12"


def pick_tier_rates(rnd: int, slot: int) -> dict:
    """Return historical hit rates for a pick's band — smash/hit/contrib/bust/usable.
    Returns {} if the band isn't in rookie_draft_tiers.json (e.g. R6+ or unknown).
    """
    tiers = load_rookie_tiers().get("bands", {})
    band = pick_band_for_slot(rnd, slot)
    data = tiers.get(band, {}).get("combined", {})
    if not data:
        # Try round-aggregate by averaging the three known quarter bands
        quarters = [tiers.get(f"{rnd}.01-04", {}).get("combined", {}),
                    tiers.get(f"{rnd}.05-08", {}).get("combined", {}),
                    tiers.get(f"{rnd}.09-12", {}).get("combined", {})]
        valid = [q for q in quarters if q]
        if not valid:
            return {}
        return {
            "band": f"{rnd}.01-12 (round avg)",
            "smash_pct": round(sum(q.get("smash_pct", 0) for q in valid) / len(valid), 2),
            "hit_pct": round(sum(q.get("hit_pct", 0) for q in valid) / len(valid), 2),
            "contrib_pct": round(sum(q.get("contrib_pct", 0) for q in valid) / len(valid), 2),
            "bust_pct": round(sum(q.get("bust_pct", 0) for q in valid) / len(valid), 2),
            "usable_pct": round(sum(q.get("usable_pct", 0) for q in valid) / len(valid), 2),
        }
    return {
        "band": band,
        "smash_pct": data.get("smash_pct", 0),
        "hit_pct": data.get("hit_pct", 0),
        "contrib_pct": data.get("contrib_pct", 0),
        "bust_pct": data.get("bust_pct", 0),
        "usable_pct": data.get("usable_pct", 0),
    }


def find_defending_champion(career_stats: dict) -> dict:
    """Find the most recent season's champion (final_finish=1).
    Returns {season, franchise_id, owner_name, team_name} or {} if none.
    """
    # career_stats has per-franchise trend with finish per season.
    # Find the franchise with finish=1 in the most recent season across all franchises.
    candidates = []  # (season, fid, finish)
    for fid, stats in career_stats.items():
        for t in stats.get("trend", []):
            if t.get("finish") == 1:
                candidates.append((t["season"], fid, stats))
    if not candidates:
        return {}
    candidates.sort(key=lambda x: x[0], reverse=True)
    season, fid, stats = candidates[0]
    return {
        "season": season,
        "franchise_id": fid,
        "owner_name": stats.get("owner", {}).get("display", ""),
        "team_name": stats.get("franchise_name", ""),
    }


def load_trade_value_model_full() -> dict:
    """Load the full trade value model including owner_profiles and team_summary."""
    if not TRADE_VALUE_MODEL.exists():
        return {}
    with open(TRADE_VALUE_MODEL) as f:
        return json.load(f)


def load_discord_users() -> dict:
    """Return {franchise_id: {owner_name, discord_username, discord_userid, team_name}}.

    Source order (first hit wins):
      1. discord_owners.json in the repo data/ dir (canonical — D1 export)
      2. Legacy CSV at the hardcoded Documents path (fallback for old deploys)
    """
    if DISCORD_OWNERS_JSON.exists():
        with open(DISCORD_OWNERS_JSON) as f:
            return json.load(f)
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
        # franchise_name fallback chain: career_stats → owner_profiles → discord_users → ""
        # discord_users team_name is the load-bearing fallback when career_stats is missing.
        "franchise_name": cs.get("franchise_name") or op.get("team_name") or du.get("team_name", ""),
        "owner_name": owner.get("display") or du.get("owner_name", ""),
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

    # Pick detail builder — includes historical hit-rate band for expected-value framing.
    def pick_detail(pk) -> dict:
        rates = pick_tier_rates(pk.round, getattr(pk, "predicted_slot", 0) or 0)
        return {
            "year": pk.year,
            "round": pk.round,
            "slot": getattr(pk, "predicted_slot", 0) or None,
            "value": pk.estimated_value,
            **rates,  # band, smash_pct, hit_pct, contrib_pct, bust_pct, usable_pct
        }

    context = {
        "trade": {
            "timestamp": analysis.timestamp,
            "comments": analysis.comments,
        },
        "defending_champion": find_defending_champion(career_stats),
        "side_a": {
            "franchise": ctx_a,
            "grade": a.grade,
            "grade_score": round(a.grade_score, 1),
            "players_given": [player_detail(p) for p in a.players_given],
            "picks_given": [pick_detail(pk) for pk in a.picks_given],
            "salary_given": a.salary_given,
            "players_received": [player_detail(p) for p in a.players_received],
            "picks_received": [pick_detail(pk) for pk in a.picks_received],
            "salary_received": a.salary_received,
            "post_trade_salary": a.total_roster_salary,
            "post_trade_cap": a.cap_space,
        },
        "side_b": {
            "franchise": ctx_b,
            "grade": b.grade,
            "grade_score": round(b.grade_score, 1),
            "players_given": [player_detail(p) for p in b.players_given],
            "picks_given": [pick_detail(pk) for pk in b.picks_given],
            "salary_given": b.salary_given,
            "players_received": [player_detail(p) for p in b.players_received],
            "picks_received": [pick_detail(pk) for pk in b.picks_received],
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

    # Defending champion (most recent season's #1)
    dc = ctx.get("defending_champion") or {}
    if dc:
        ln(f"DEFENDING CHAMPION (won {dc['season']}): {dc['owner_name']} ({dc['team_name']})")
        ln("")

    def render_pick(pk: dict) -> str:
        # Pick line with historical band hit-rates for expected-value framing.
        # smash = elite/star outcome, hit = solid starter, contrib = depth, bust = no impact.
        slot = pk.get("slot")
        slot_str = f" (slot {slot})" if slot else ""
        band = pk.get("band", "")
        smash = pk.get("smash_pct", 0)
        hit = pk.get("hit_pct", 0)
        contrib = pk.get("contrib_pct", 0)
        bust = pk.get("bust_pct", 0)
        usable = pk.get("usable_pct", 0)
        rates = ""
        if band:
            rates = (f" — historical band {band}: "
                     f"smash {smash:.0%} / hit {hit:.0%} / "
                     f"contrib {contrib:.0%} / bust {bust:.0%} / "
                     f"usable {usable:.0%}")
        return (f"  - {pk['year']} Round {pk['round']} pick{slot_str}"
                f" (est. value ${pk['value']:,}){rates}")

    ln(f"{fa['franchise_name']} gave:")
    for pk in a["picks_given"]:
        ln(render_pick(pk))
    for p in a["players_given"]:
        ln(f"  - {p['name']} ({p['position']}) — ${p['salary']:,} salary, "
           f"expected auction price ${p['expected_auction_price']:,}, {p['ppg']} PPG")
    if a["salary_given"]:
        ln(f"  - ${a['salary_given']:,} in traded salary")

    ln(f"{fb['franchise_name']} gave:")
    for pk in b["picks_given"]:
        ln(render_pick(pk))
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
        # Owner W/L — pct only (Keith 2026-05-22: cite percentage, not W-L count + pct).
        if f.get("owner_allplay_pct"):
            ln(f"  {f['owner_name']}'s allplay: {f['owner_allplay_pct']:.3f}")
        ln(f"  {f['owner_name']}'s championships: {f['owner_championships']}")
        ln(f"  {f['owner_name']}'s playoff appearances: {f['owner_playoff_appearances']} in {f['owner_seasons']} season(s)")
        if f["owner_best_finish"]:
            ln(f"  {f['owner_name']}'s best finish: #{f['owner_best_finish']}")
        if f["owner_worst_finish"]:
            ln(f"  {f['owner_name']}'s worst finish: #{f['owner_worst_finish']}")

        # Franchise-wide history — ONLY when it's recent / relevant (not deep history).
        # Keith 2026-05-22: don't reach >2 seasons back unless current owner played them.
        if f["franchise_championship_drought"] and f["franchise_championship_drought"] <= 5 and f["franchise_championships"] > 0:
            ln(f"  Franchise's last championship: {f['franchise_last_championship']} ({f['franchise_championship_drought']} years ago)")
        # Ancient championships (>5 years) deliberately omitted — they don't roast a current owner.

        # Owner auction tendencies — CUT per Keith 2026-05-22 cut list. The fields
        # (auction_style, deal_rate, position_targeting) are derived from owner_profiles
        # in trade_value_model_2026.json. With that file missing, they emit zeros that
        # the LLM mis-reads as real signals ("0% deal rate" hallucination). Re-add as
        # categorical tendency labels once the model is back online and Keith's reviewed
        # the avg_value_delta calc.

        # Cap context — only show if the trade INCLUDES players or BB (cap matters then).
        # Pick-only trades don't move cap; suppress to keep the roast focused.
        side_has_player_or_bb = (
            bool(side.get("players_received") or side.get("players_given")
                 or side.get("salary_received") or side.get("salary_given"))
        )
        if side_has_player_or_bb:
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
