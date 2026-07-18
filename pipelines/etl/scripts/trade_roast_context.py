"""
trade_roast_context.py — Build rich context dicts for Claude roast generation.

Consolidates: trade value model, rosters, standings history, owner profiles,
team summaries, auction comparables, and extension projections into a single
context payload that Claude can use to generate savage, data-backed roasts.
"""

import csv
import json
import os
from pathlib import Path
from typing import Optional

from trade_grader import (
    TradeAnalysis, PlayerInfo, mfl_fetch, load_franchises, load_players_map,
    load_rosters, load_rollover, load_auction_pool, load_team_caps,
    load_future_picks, load_trade_value_model, fetch_trades, analyze_trade,
    find_comparables, calculate_extension, estimate_production_value,
    _parse_contract, TRADE_VALUE_MODEL,
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
# Owner/team mapping — JSON in the data/ dir is the canonical source (deploy
# artifact generated from the owners CSV; NOT committed — the repo is public
# and it carries Discord user ids). CSV fallback order matters: the local
# Application Support copy comes FIRST and the legacy Documents/iCloud paths
# LAST — on 2026-07-11 the bot froze for 25h because a synchronous open() of
# the iCloud copy blocked while macOS tried to materialize it. Env overrides
# (DISCORD_OWNERS_JSON / DISCORD_USERS_CSV) win over everything.
DISCORD_OWNERS_JSON = Path(
    os.environ.get("DISCORD_OWNERS_JSON")
    or (Path(__file__).resolve().parent.parent / "data" / "discord_owners.json"))
_CSV_CANDIDATES = [
    os.environ.get("DISCORD_USERS_CSV", ""),
    str(Path.home() / "Library" / "Application Support" / "ups-roast-bot" / "import_discord_info.csv"),
    "/Users/keithcreelman/Documents/mfl/mfl_python/dev/import_discord_info.csv",
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Documents/mfl/mfl_python/dev/import_discord_info.csv",
]
DISCORD_USERS_CSV = Path(next((p for p in _CSV_CANDIDATES if p and Path(p).exists()),
                              _CSV_CANDIDATES[1]))
# Per-owner personality dossiers (voice / roast angles / running gags /
# sensitivities, every angle source-tagged). LOCAL-ONLY: lives under the
# gitignored data/ dir because the repo is public and the file contains
# insults + lore. Env-overridable; graceful no-op when missing.
OWNER_PROFILES_PATH = Path(
    os.environ.get("OWNER_PROFILES_JSON")
    or (Path(__file__).resolve().parent.parent / "data" / "bot" / "owner_profiles.json"))
# Anti-repetition source channel: the bot's own recent posts get fetched and
# fed back as a BANNED-verbiage section (data-layer enforcement — prompt
# rules alone have failed in this repo).
DISCORD_TRADE_CHANNEL_ID = os.environ.get(
    "DISCORD_TRADE_CHANNEL_ID", "1059111651846131833")


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


def _round_quarters(rnd: int) -> list[dict]:
    """Return the three quarter bands of a round in slot order [1-4, 5-8, 9-12]."""
    tiers = load_rookie_tiers().get("bands", {})
    return [tiers.get(f"{rnd}.01-04", {}).get("combined", {}),
            tiers.get(f"{rnd}.05-08", {}).get("combined", {}),
            tiers.get(f"{rnd}.09-12", {}).get("combined", {})]


def _avg_rate(quarters: list[dict], key: str) -> float:
    valid = [q.get(key, 0) for q in quarters if q]
    return round(sum(valid) / len(valid), 2) if valid else 0


def _half_band_rates(rnd: int, half: str) -> dict:
    """Compute half-band rates for R2+ with monotonic enforcement.

    Slots 1-12 split into:
      first  half = slots 1-6 (proportional weight: q1 [slots 1-4] = 4/6,
                                q2 [slots 5-8] = 2/6 → first 6 slots only)
      second half = slots 7-12 (proportional weight: q2 [slots 5-8] = 2/6,
                                q3 [slots 9-12] = 4/6 → last 6 slots only)

    Monotonic enforcement: if the small-sample noise makes second_half > first_half
    for any rate, force second_half ≤ first_half (Keith 2026-05-22: earlier should
    be at worst slightly better than later).
    """
    q1, q2, q3 = _round_quarters(rnd)
    if not (q1 or q2 or q3):
        return {}

    def blended(q_a, q_b, w_a, w_b, key):
        # Both quarters might be missing — fall back to whichever is present.
        if q_a and q_b:
            return round((q_a.get(key, 0) * w_a + q_b.get(key, 0) * w_b) / (w_a + w_b), 2)
        if q_a:
            return q_a.get(key, 0)
        if q_b:
            return q_b.get(key, 0)
        return 0

    keys = ("smash_pct", "hit_pct", "contrib_pct", "bust_pct", "usable_pct")
    # First half: weighted toward 1-4 (slots 1-6)
    first = {k: blended(q1, q2, 4, 2, k) for k in keys}
    # Second half: weighted toward 9-12 (slots 7-12)
    second = {k: blended(q2, q3, 2, 4, k) for k in keys}

    # Monotonic enforcement: success rates (smash/hit/contrib/usable) → first ≥ second.
    # Bust rate moves the opposite direction → first ≤ second.
    monotonic_floor = max(first["usable_pct"], second["usable_pct"])
    if second["usable_pct"] > first["usable_pct"]:
        # Swap so first ≥ second on success metrics, with small monotonic gap
        for k in ("smash_pct", "hit_pct", "contrib_pct", "usable_pct"):
            avg = (first[k] + second[k]) / 2
            # Force a 2 percentage-point gap, first slightly better
            first[k] = round(avg + 0.01, 2)
            second[k] = round(avg - 0.01, 2)
        # Bust the other way
        bust_avg = (first["bust_pct"] + second["bust_pct"]) / 2
        first["bust_pct"] = round(bust_avg - 0.01, 2)
        second["bust_pct"] = round(bust_avg + 0.01, 2)

    rates = first if half == "first" else second
    label = f"R{rnd} first half (slots 1-6)" if half == "first" else f"R{rnd} second half (slots 7-12)"
    return {"band": label, **rates}


def _avg_slot_bands(slot_keys: list[str]) -> dict:
    """Average smash/hit/contrib/bust/usable across multiple per-slot bands."""
    tiers = load_rookie_tiers().get("bands", {})
    rates = [tiers.get(k, {}).get("combined", {}) for k in slot_keys]
    valid = [r for r in rates if r]
    if not valid:
        return {}
    return {
        "smash_pct": round(sum(r.get("smash_pct", 0) for r in valid) / len(valid), 2),
        "hit_pct": round(sum(r.get("hit_pct", 0) for r in valid) / len(valid), 2),
        "contrib_pct": round(sum(r.get("contrib_pct", 0) for r in valid) / len(valid), 2),
        "bust_pct": round(sum(r.get("bust_pct", 0) for r in valid) / len(valid), 2),
        "usable_pct": round(sum(r.get("usable_pct", 0) for r in valid) / len(valid), 2),
    }


def pick_tier_rates(rnd: int, slot: int) -> dict:
    """Return historical hit rates for a pick's band.

    Granularity is finer at the top of the draft (where slot value differences
    are largest) and coarser later (where small-sample noise dominates):

      R1.01           → own tier (1.01 is MUCH better than 1.06; n=14 supports
                                  showing the consensus #1 pick separately)
      R1.02-04        → small band (avg of 1.02, 1.03, 1.04 per-slot data)
      R1.05-08        → quarter band
      R1.09-12        → quarter band
      R2+ first half  → slots 1-6, half-band
      R2+ second half → slots 7-12, half-band, monotonic-enforced ≤ first

    Keith 2026-05-22: "1.1 is MUCH MUCH better than 1.6 ... 1.1 should be its
    own tier but also hard to project, worth knowing for context. The bigger
    bands matter for later rounds."
    """
    tiers = load_rookie_tiers().get("bands", {})
    if rnd == 1:
        if slot == 1:
            d = tiers.get("1.01", {}).get("combined", {})
            if d:
                return {
                    "band": "1.01 (consensus #1)",
                    "smash_pct": d.get("smash_pct", 0),
                    "hit_pct": d.get("hit_pct", 0),
                    "contrib_pct": d.get("contrib_pct", 0),
                    "bust_pct": d.get("bust_pct", 0),
                    "usable_pct": d.get("usable_pct", 0),
                }
        if slot and 2 <= slot <= 4:
            return {"band": "1.02-04", **_avg_slot_bands(["1.02", "1.03", "1.04"])}
        if slot and 5 <= slot <= 8:
            d = tiers.get("1.05-08", {}).get("combined", {})
            if d:
                return {"band": "1.05-08", "smash_pct": d["smash_pct"], "hit_pct": d["hit_pct"],
                        "contrib_pct": d["contrib_pct"], "bust_pct": d["bust_pct"],
                        "usable_pct": d["usable_pct"]}
        if slot and 9 <= slot <= 12:
            d = tiers.get("1.09-12", {}).get("combined", {})
            if d:
                return {"band": "1.09-12", "smash_pct": d["smash_pct"], "hit_pct": d["hit_pct"],
                        "contrib_pct": d["contrib_pct"], "bust_pct": d["bust_pct"],
                        "usable_pct": d["usable_pct"]}
        # R1 with unknown slot → use the quarter most likely (mid)
        d = tiers.get("1.05-08", {}).get("combined", {})
        return {"band": "R1 (slot unknown)", **(d if d else {})}

    # R2+ → first/second half split with monotonic enforcement
    if not slot:
        half = "second"  # unknown slot → conservative
    elif 1 <= slot <= 6:
        half = "first"
    else:
        half = "second"
    return _half_band_rates(rnd, half)


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
    out = {}
    try:
        if DISCORD_OWNERS_JSON.exists():
            with open(DISCORD_OWNERS_JSON) as f:
                return json.load(f)
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
    except Exception as e:
        # Degraded > dead: a roast without owner nicknames beats no roast (and
        # infinitely beats a frozen event loop). The caller's timeout guards the
        # blocking-open case; this guards parse/permission errors.
        print(f"[trade_roast_context] load_discord_users degraded ({e}) — continuing without owner mapping")
    return out


def load_owner_profiles() -> dict:
    """{fid: profile} from owner_profiles.json — {} if missing/corrupt.

    Read fresh on every call (no module cache): the file is tiny, the bot is
    a long-running launchd process, and Keith hot-edits profiles between
    trades. Fail-soft: a roast without dossiers beats no roast.
    """
    try:
        if not OWNER_PROFILES_PATH.exists():
            return {}
        with open(OWNER_PROFILES_PATH) as f:
            data = json.load(f)
        return data.get("profiles", data) or {}
    except Exception as e:
        print(f"[trade_roast_context] owner profiles unavailable ({e}) — continuing without dossiers")
        return {}


def format_owner_dossier(franchise_ids: list, max_angles: int = 4) -> str:
    """Compact OWNER DOSSIER prompt block for the franchises in a trade.

    Personality AMMO the model may draw from — never a script. Every angle
    keeps its source tag so the model knows what it may embellish
    (lore:commish) vs what it must quote accurately (verified:*).
    Returns "" when no profiles match (missing file, unknown fids).
    """
    profiles = load_owner_profiles()
    if not profiles:
        return ""
    blocks = []
    for fid in franchise_ids:
        p = profiles.get((fid or "").strip().zfill(4))
        if not p:
            continue
        lines = [f"{p.get('owner', '?')} — {p.get('team_name', '')} "
                 f"(franchise {p.get('fid', fid)}, discord: {p.get('discord', '?')})"]
        if p.get("voice"):
            lines.append(f"  Voice in-channel: {p['voice']}")
        angles = (p.get("roast_angles") or [])[:max_angles]
        if angles:
            lines.append("  Roast angles (each carries its source tag):")
            for a in angles:
                src = a.get("source", "unsourced — do not cite stats from this")
                lines.append(f"    - {a.get('text', '')} [{src}]")
        gags = p.get("running_gags") or []
        if gags:
            lines.append("  Running gags: " + " | ".join(gags))
        sens = p.get("sensitivities") or []
        if sens:
            lines.append("  Handle with care: " + " | ".join(sens))
        blocks.append("\n".join(lines))
    if not blocks:
        return ""
    header = (
        "\n=== OWNER DOSSIER (personality ammo — draw from it, don't recite it) ===\n"
        "Rules: [verified:*] facts must be cited ACCURATELY (numbers verbatim). "
        "[lore:commish] items are league lore — comedic embellishment allowed, core claim fixed. "
        "Do not use any stat that lacks a source tag.")
    return header + "\n" + "\n\n".join(blocks)


def _discord_bot_token() -> str:
    """DISCORD_BOT_TOKEN from env, falling back to the macOS Keychain entry
    the launchd bot uses (service 'discord_bot_token'). "" on any failure."""
    tok = (os.environ.get("DISCORD_BOT_TOKEN") or "").strip()
    if tok:
        return tok
    try:
        import subprocess
        out = subprocess.run(
            ["security", "find-generic-password",
             "-a", os.environ.get("USER", ""),
             "-s", "discord_bot_token", "-w"],
            capture_output=True, text=True, timeout=10)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""


def fetch_recent_bot_posts(limit: int = 12) -> list:
    """Texts of the bot's last `limit` posts in the trade channel, newest first.

    Read-only Discord REST. Fail-soft to [] on ANY error (no token, network,
    rate limit, parse) — the roast simply ships without the anti-repetition
    ban list. NOTE: blocking HTTP — call from build_trade_roast_context
    (which the bot runs off-loop with a timeout), never directly on the
    event loop (see the 2026-07-11 frozen-loop incident).
    """
    try:
        token = _discord_bot_token()
        if not token:
            return []
        import urllib.request
        headers = {"Authorization": f"Bot {token}",
                   "User-Agent": "ups-roast-bot/1.0"}
        # Identify the bot's own user id so we filter by author, not username.
        bot_id = ""
        try:
            req = urllib.request.Request(
                "https://discord.com/api/v10/users/@me", headers=headers)
            with urllib.request.urlopen(req, timeout=10) as resp:
                bot_id = str(json.load(resp).get("id", ""))
        except Exception:
            pass  # fall back to author.bot flag below
        req = urllib.request.Request(
            f"https://discord.com/api/v10/channels/{DISCORD_TRADE_CHANNEL_ID}"
            f"/messages?limit=100", headers=headers)
        with urllib.request.urlopen(req, timeout=15) as resp:
            msgs = json.load(resp)
        out = []
        for m in msgs:  # Discord returns newest-first
            au = m.get("author") or {}
            if bot_id:
                if str(au.get("id", "")) != bot_id:
                    continue
            elif not au.get("bot"):
                continue
            text = (m.get("content") or "").strip()
            if not text:
                continue  # embed-only posts (announcements) have no content
            out.append(text)
            if len(out) >= limit:
                break
        return out
    except Exception as e:
        print(f"[trade_roast_context] recent-bot-posts fetch skipped ({e})")
        return []


def format_recent_bot_posts_section(posts: list = None, char_cap: int = 2500) -> str:
    """Render the RECENT BOT POSTS ban-list section (data-layer anti-repetition).

    Pass posts=None to fetch them (blocking — see fetch_recent_bot_posts).
    Returns "" when there's nothing to ban against.
    """
    if posts is None:
        posts = fetch_recent_bot_posts()
    if not posts:
        return ""
    header = ("\n=== RECENT BOT POSTS — every phrase, joke structure, opener "
              "and closer below is BANNED for this post ===")
    lines, used = [], 0
    for i, t in enumerate(posts, 1):
        flat = " ".join(t.split())  # trim + flatten whitespace/newlines
        entry = f"[{i}] {flat[:400]}"
        if used + len(entry) + 1 > char_cap:
            break
        lines.append(entry)
        used += len(entry) + 1
    if not lines:
        return ""
    return header + "\n" + "\n".join(lines)


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
                            live_franchise_name: str = "") -> dict:
    """Build complete context for one franchise.

    live_franchise_name is the CURRENT franchise name as just fetched from the
    live MFL league export (analyze_trade set it on the TradeSide). It WINS over
    every cached copy — see the franchise_name note below.
    """
    cs = career_stats.get(franchise_id, {})
    op = get_owner_profile(franchise_id, tv_full)
    ts = get_team_summary(franchise_id, tv_full)
    du = discord_users.get(franchise_id, {})

    # Owner-specific stats (only their tenure)
    owner = cs.get("owner", {})

    return {
        "franchise_id": franchise_id,
        # franchise_name — the LIVE MFL name WINS (Keith 2026-07-18). Every cached
        # copy (career_stats → owner_profiles → discord_users) goes STALE the
        # moment an owner renames his team: franchise 0001 renamed "Ulterior
        # Warrior" → "L.A. Looks", but the caches still said "Ulterior Warrior",
        # so a roast addressed a franchise that no longer exists in the league.
        # analyze_trade already fetched the current name into side.franchise_name;
        # prefer it and fall back to the caches only when it's somehow blank.
        "franchise_name": (live_franchise_name or cs.get("franchise_name")
                           or op.get("team_name") or du.get("team_name", "")),
        # Upcoming-season year (for the CURRENT YEAR / date-math block in the prompt).
        "current_year": cs.get("current_year"),
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



WORKER_BASE_URL = os.environ.get(
    "UPS_WORKER_BASE", "https://upsmflproduction.keith-creelman.workers.dev").rstrip("/")


def _fetch_prior_season_ppg(players) -> dict:
    """{mfl_player_id: {ppg, season}} — last season's ACTUAL MFL PPG from the
    worker leaderboard, used when projection artifacts are unavailable (their
    absence is why the 2026-07-12 roast claimed Kittle "posted 0.0 PPG").
    Best-effort: one GET per position group of the traded players; any failure
    returns {} and the prompt simply omits PPG."""
    out = {}
    try:
        import urllib.request
        from datetime import date
        season = date.today().year - 1
        pos_groups = set()
        for p in players:
            pos = (p.position or "").upper()
            pos_groups.add("qb" if pos == "QB" else
                           "kicker" if pos == "PK" else
                           "punter" if pos == "PN" else
                           "idp" if pos in ("DT","DE","NT","DL","LB","OLB","ILB","MLB","CB","S","SS","FS","DB") else
                           "skill")
        want = {str(p.player_id) for p in players}
        for pg in pos_groups:
            url = (f"{WORKER_BASE_URL}/api/advanced-stats-leaderboard"
                   f"?seasons={season}&pos={pg}&limit=500")
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh) ups-roast-bot/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                rows = json.load(resp).get("rows", [])
            for r in rows:
                mid = str(r.get("mfl_pid") or "")
                if mid in want and r.get("mfl_ppg"):
                    out[mid] = {"ppg": float(r["mfl_ppg"]), "season": season}
    except Exception as e:
        print(f"[trade_roast_context] prior-season PPG lookup skipped ({e})")
    return out



def _fix_encoding(text: str) -> str:
    """Repair UTF-8-read-as-latin-1 mojibake from MFL exports ("Iâ\x80\x99ll" -> "I'll")."""
    if not text:
        return text or ""
    try:
        repaired = text.encode("latin-1").decode("utf-8")
        # Only keep the repair if it actually removed mojibake markers
        return repaired if "Ã" not in repaired and "â" not in repaired else text
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


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

    # Build franchise contexts. Pass the LIVE MFL franchise names (analyze_trade
    # fetched them from the current league export) so a stale cache can never
    # resurrect an old team name in the roast (the "Ulterior Warrior" bug).
    ctx_a = build_franchise_context(a.franchise_id, career_stats, tv_full,
                                    discord_users, live_franchise_name=a.franchise_name)
    ctx_b = build_franchise_context(b.franchise_id, career_stats, tv_full,
                                    discord_users, live_franchise_name=b.franchise_name)

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

    # Player details. KEITH'S STANDING RULE (2026-07-12): pre-season, value
    # citations = prior-3-season weighted PPG (grader backfills expected_ppg +
    # ppg_basis from the worker leaderboard) + CURRENT multi-source ADP
    # (grader attaches adp_* from /api/adp-board). Current-season stats never
    # enter this payload before the season starts — enforced here, not by
    # prompt rules.
    def player_detail(p: PlayerInfo) -> dict:
        ppg = round(p.expected_ppg, 1) if p.expected_ppg else None
        ppg_label = p.ppg_basis or "proj"
        # FIX B (Keith 2026-07-18) — surface the FULL remaining per-year salary,
        # not just the current-year figure. This is the same _parse_contract the
        # grade math uses, so what the roast SAYS about salary matches what the
        # grade COUNTS. Isaiah Bond reads "$5,000 salary" today but is really
        # $5K (2026) → $14K (2027), a $19K/2yr liability the roast must factor.
        yrs_remaining, remaining_salaries = _parse_contract(
            p.contract_info, p.contract_year, p.salary)
        return {
            "name": display_name(p.name),
            "position": p.position,
            "team": p.team,
            "salary": p.salary,
            "years_remaining": yrs_remaining,
            "remaining_salaries": remaining_salaries,
            "salary_remaining_total": sum(remaining_salaries),
            "expected_auction_price": int(p.exp_price) if p.exp_price else int(
                estimate_production_value(p, auction_pool)),
            "ppg": ppg,
            "ppg_label": ppg_label,
            "adp_overall": p.adp_overall or None,
            "adp_pos_rank": p.adp_pos_rank or None,
            "adp_trend30": p.adp_trend30 or 0,
            "adp_sources": p.adp_sources or 0,
            "trade_value": round(p.trade_value, 1),
            "quality_score": round(p.quality_score, 1),
            "contract_info": p.contract_info,
            "contract_status": p.contract_status,
        }

    # Traded salary adjustment
    bb_a_to_b = b.salary_given  # BB from B to A
    bb_b_to_a = a.salary_given  # BB from A to B

    # Pick detail builder — includes historical hit-rate band for expected-value framing.
    # slot_confidence: 'high' when originating franchise's owner has 3+ seasons of
    # consistent results; 'low' when owner has <3 seasons (Brian Cross types).
    # The LLM should hedge slot predictions when confidence is low.
    def pick_detail(pk, sender_fid: str = "") -> dict:
        rates = pick_tier_rates(pk.round, getattr(pk, "predicted_slot", 0) or 0)
        # Look up originating-franchise owner's tenure depth.
        # PickInfo.original_owner is only set for picks acquired via prior trade.
        # For "native" picks (a team trading their own draft slot), it's "" — fall
        # back to the SENDER's fid since the sender's slot determines the pick.
        raw_orig = (getattr(pk, "original_owner", "") or "").strip()
        orig_fid = raw_orig.zfill(4) if raw_orig else (sender_fid or "").zfill(4)
        orig_stats = career_stats.get(orig_fid, {})
        orig_owner_seasons = orig_stats.get("owner", {}).get("seasons_count", 0)
        if orig_owner_seasons >= 3:
            slot_confidence = "high"
        elif orig_owner_seasons >= 1:
            slot_confidence = "low"
        else:
            slot_confidence = "unknown"
        return {
            "year": pk.year,
            "round": pk.round,
            "slot": getattr(pk, "predicted_slot", 0) or None,
            "slot_confidence": slot_confidence,
            "originating_owner_seasons": orig_owner_seasons,
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
            # Picks given by side A → A is the sender; A's fid is the originating-owner fallback.
            "picks_given": [pick_detail(pk, sender_fid=a.franchise_id) for pk in a.picks_given],
            "salary_given": a.salary_given,
            "players_received": [player_detail(p) for p in a.players_received],
            # Picks received by side A → B is the sender.
            "picks_received": [pick_detail(pk, sender_fid=b.franchise_id) for pk in a.picks_received],
            "salary_received": a.salary_received,
            "post_trade_salary": a.total_roster_salary,
            "post_trade_cap": a.cap_space,
        },
        "side_b": {
            "franchise": ctx_b,
            "grade": b.grade,
            "grade_score": round(b.grade_score, 1),
            "players_given": [player_detail(p) for p in b.players_given],
            "picks_given": [pick_detail(pk, sender_fid=b.franchise_id) for pk in b.picks_given],
            "salary_given": b.salary_given,
            "players_received": [player_detail(p) for p in b.players_received],
            "picks_received": [pick_detail(pk, sender_fid=a.franchise_id) for pk in b.picks_received],
            "salary_received": b.salary_received,
            "post_trade_salary": b.total_roster_salary,
            "post_trade_cap": b.cap_space,
        },
        "h2h_between_teams": h2h,
        "auction_comparables": comparables,
        "extension_projections": extensions,
        "effective_cost_note": "",
        # Owner personality dossiers + anti-repetition ban list — computed HERE
        # (build runs off-loop with a timeout in trade_roast_bot) because
        # fetch_recent_bot_posts does blocking HTTP. context_to_prompt_text
        # renders these, so they ride into BOTH the roast prompt AND the
        # context_text the bot POSTs to /api/roast-thread/track (the worker's
        # clap-back context) — same builder, per the D1/data-layer rule.
        "owner_dossier_text": format_owner_dossier(
            [a.franchise_id, b.franchise_id]),
        "recent_bot_posts_text": format_recent_bot_posts_section(),
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

    # Current-year framing — explicit date math for the LLM. The payload's
    # career_stats has current_year per franchise (upcoming season we're in
    # offseason for). Pull whichever side has it (both should agree).
    current_year = (fa.get("current_year") or fb.get("current_year") or 0)
    if current_year:
        last_completed = current_year - 1
        ln(f"CURRENT YEAR: {current_year} (offseason — {current_year} season has not started)")
        ln(f"LAST COMPLETED SEASON: {last_completed}")
        ln("")

    # Defending champion — only emit if one of the traded sides IS the defending champ.
    # Otherwise it's noise the LLM misuses (e.g. naming an uninvolved third party in a roast).
    dc = ctx.get("defending_champion") or {}
    if dc and dc.get("franchise_id") in (fa.get("franchise_id"), fb.get("franchise_id")):
        ln(f"NOTE: {dc['owner_name']} ({dc['team_name']}) IS the defending champion — they won {dc['season']}.")
        ln("")

    def render_pick(pk: dict) -> str:
        # Pick line with historical band hit-rates and slot-confidence flag.
        # smash = elite/star outcome, hit = solid starter, contrib = depth, bust = no impact.
        # slot_confidence: low → hedge predictions ("could land in 1.05-08 if their
        # season trajectory holds"); high → assert the band.
        slot = pk.get("slot")
        confidence = pk.get("slot_confidence", "unknown")
        owner_seasons = pk.get("originating_owner_seasons", 0)
        if slot:
            if confidence == "high":
                slot_str = f" (predicted slot {slot}, HIGH confidence — originating owner has {owner_seasons} consistent seasons)"
            elif confidence == "low":
                slot_str = f" (predicted slot {slot}, LOW confidence — originating owner only has {owner_seasons} season(s) of data; treat slot as tentative)"
            else:
                slot_str = f" (predicted slot {slot}, confidence unknown)"
        else:
            slot_str = ""
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

    def _money(n: int) -> str:
        """Compact dollars: $14K when it's a clean thousand, else $14,000."""
        return f"${n // 1000}K" if n and n % 1000 == 0 else f"${n:,}"

    def fmt_salary(p: dict) -> str:
        """Salary text. FIX B (Keith 2026-07-18): spell out the FULL remaining
        per-year schedule so an escalator like Isaiah Bond's ($5K 2026 → $14K
        2027) reads as the liability it is, instead of a flat '$5,000 salary'.
        Flat / single-year contracts stay terse (just the current number)."""
        rem = p.get("remaining_salaries") or []
        base = f"${p['salary']:,} salary"
        if len(rem) <= 1 or len(set(rem)) <= 1:
            return base  # single year, or every remaining year identical → flat
        if current_year:
            years = " → ".join(f"{current_year + i} {_money(s)}"
                               for i, s in enumerate(rem))
        else:
            years = " → ".join(f"yr{i + 1} {_money(s)}" for i, s in enumerate(rem))
        total = p.get("salary_remaining_total") or sum(rem)
        return f"{base} ({years}; {_money(total)} remaining over {len(rem)} yrs)"

    def render_player(p: dict) -> str:
        ppg_txt = (f", {p['ppg']} PPG ({p.get('ppg_label','proj')})" if p.get('ppg') else "")
        adp_txt = ""
        if p.get('adp_overall'):
            trend = p.get('adp_trend30') or 0
            trend_txt = f", 30d {'+' if trend > 0 else ''}{trend}" if trend else ""
            adp_txt = (f", ADP {p['position']}{p['adp_pos_rank']} / #{p['adp_overall']} overall "
                       f"({p.get('adp_sources', 0)}-source consensus{trend_txt})")
        return (f"  - {p['name']} ({p['position']}) — {fmt_salary(p)}, "
                f"expected auction price ${p['expected_auction_price']:,}{ppg_txt}{adp_txt}")

    # ASSET DIRECTION LEDGER — one terse line per asset stating exactly where it
    # ended up. FIX A (Keith 2026-07-18): the 2026-07 roast told Ryan he "turned
    # Bond into Mitchell" when he RECEIVED Bond and GAVE Mitchell — the model had
    # to INFER the received side (the text only printed what each team GAVE) and
    # flipped it. With an explicit ledger AND per-team received-lists below, the
    # direction can no longer be inferred/reversed.
    na, nb = fa['franchise_name'], fb['franchise_name']
    ledger = []
    for p in a["players_given"]:
        ledger.append(f"  {p['name']} ({p['position']}): {na} → {nb}")
    for pk in a["picks_given"]:
        ledger.append(f"  {pk['year']} R{pk['round']} pick: {na} → {nb}")
    if a["salary_given"]:
        ledger.append(f"  ${a['salary_given']:,} budget bucks: {na} → {nb}")
    for p in b["players_given"]:
        ledger.append(f"  {p['name']} ({p['position']}): {nb} → {na}")
    for pk in b["picks_given"]:
        ledger.append(f"  {pk['year']} R{pk['round']} pick: {nb} → {na}")
    if b["salary_given"]:
        ledger.append(f"  ${b['salary_given']:,} budget bucks: {nb} → {na}")
    if ledger:
        ln("ASSET DIRECTION LEDGER (who ended up with what — read this, do not infer):")
        for line in ledger:
            ln(line)
        ln("")

    def render_side(side: dict, name: str):
        """Print BOTH what a team gave AND what it received, same helpers for
        each, so the model is handed the direction explicitly on both axes."""
        ln(f"{name} gave:")
        gave_any = False
        for pk in side["picks_given"]:
            ln(render_pick(pk)); gave_any = True
        for p in side["players_given"]:
            ln(render_player(p)); gave_any = True
        if side["salary_given"]:
            ln(f"  - ${side['salary_given']:,} in traded salary"); gave_any = True
        if not gave_any:
            ln("  - (nothing)")
        ln(f"{name} received:")
        got_any = False
        for pk in side["picks_received"]:
            ln(render_pick(pk)); got_any = True
        for p in side["players_received"]:
            ln(render_player(p)); got_any = True
        if side["salary_received"]:
            ln(f"  - ${side['salary_received']:,} in traded salary"); got_any = True
        if not got_any:
            ln("  - (nothing)")

    render_side(a, fa['franchise_name'])
    render_side(b, fb['franchise_name'])

    if ctx["effective_cost_note"]:
        ln(f"\nEFFECTIVE COST: {ctx['effective_cost_note']}")

    ln(f"\nTrade comment: \"{_fix_encoding(t.get('comments', ''))}\"")

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
    # Only render positions that actually have comparables — an empty section
    # header ("TE:" with nothing under it) confuses the LLM into inventing
    # market claims (2026-07-12 report shipped a bare "FREE AGENTS" header).
    _comps = {pos: comps for pos, comps in ctx["auction_comparables"].items() if comps}
    if _comps:
        ln(f"\n=== FREE AGENT AUCTION ALTERNATIVES (cost $0 in picks) ===")
        for pos, comps in _comps.items():
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
        # Show only cap_space (the source of truth after adjustments). Don't show
        # total_roster_salary alongside — they don't tie out cleanly because of
        # league-applied salary adjustments (Keith 2026-05-22: "He's at 283K of
        # pure salary but with adjustments he's got the 33K of space"). LLM was
        # combining both and producing arithmetically wrong statements like
        # "$283K post-trade with $33,500 in breathing room" (sums to $316K, not
        # $300K cap).
        side_has_player_or_bb = (
            bool(side.get("players_received") or side.get("players_given")
                 or side.get("salary_received") or side.get("salary_given"))
        )
        if side_has_player_or_bb:
            ln(f"  Post-trade cap space: ${side['post_trade_cap']:,} (of $300K cap)")

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

    # OWNER DOSSIER — personality ammo for the two franchises in this trade.
    # Old ctx dicts (tracker payloads reloaded from disk) predate the key;
    # fall back to building the dossier fresh (pure file read, no network).
    dossier = ctx.get("owner_dossier_text")
    if dossier is None:
        dossier = format_owner_dossier(
            [fa.get("franchise_id", ""), fb.get("franchise_id", "")])
    if dossier:
        ln(dossier)

    # RECENT BOT POSTS ban list — anti-repetition, data-layer. Rendered only
    # when build_trade_roast_context prefetched it; NO network fallback here
    # because this formatter runs ON the bot's event loop (2026-07-11 freeze).
    recent = ctx.get("recent_bot_posts_text") or ""
    if recent:
        ln(recent)

    return "\n".join(lines)
