"""
trade_roast_bot.py — UPS Trade Roast Discord Bot.

Auto-detects trades, generates Opus-powered roasts, posts to Discord,
monitors replies, and clap backs with data-backed savagery.

Usage:
    python trade_roast_bot.py                    # Run bot (polls for trades)
    python trade_roast_bot.py --test             # Post Hurts trade roast to test channel
    python trade_roast_bot.py --test-ts 12345    # Post specific trade to test channel
"""

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import discord
from discord.ext import commands, tasks

# Add script dir to path for local imports
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from trade_grader import (
    fetch_trades, load_franchises, analyze_trade,
    load_players_map, load_rosters, load_rollover,
    load_auction_pool, load_team_caps, load_future_picks,
    load_trade_value_model,
)
from trade_roast_context import (
    build_trade_roast_context, context_to_prompt_text,
    load_career_stats, load_discord_users,
)
from trade_announcement import build_announcement_embed
from content_engine import (
    generate_trade_roast, classify_reply, generate_clap_back,
    log_value_signal, log_data_error, save_to_archive,
)

# ── Config ─────────────────────────────────────────────────────────────────
# Channel routing — env-driven, test by default. Set DISCORD_TRADE_CHANNEL_ID
# + ROAST_BOT_ENV=prod to fire to production.
TEST_CHANNEL_ID = int(os.environ.get("DISCORD_TEST_CHANNEL_ID", "1089538054236160010"))
PROD_CHANNEL_ID = int(os.environ.get("DISCORD_TRADE_CHANNEL_ID", "0"))
ROAST_BOT_ENV = os.environ.get("ROAST_BOT_ENV", "test").strip().lower()
ROAST_CHANNEL_ID = PROD_CHANNEL_ID if (ROAST_BOT_ENV == "prod" and PROD_CHANNEL_ID) else TEST_CHANNEL_ID

HURTS_TRADE_TS = 1775772921
POLL_INTERVAL_SECONDS = 300  # 5 minutes
WORKER_GIPHY_PROXY_URL = "https://upsmflproduction.keith-creelman.workers.dev/api/giphy-search"

# Secrets — preferred location is the macOS Keychain. Store once with:
#   security add-generic-password -a "$USER" -s "discord_bot_token" -w
#   security add-generic-password -a "$USER" -s "anthropic_api_key" -w
# (each prompts for the value; never echoes to shell history).
# Env vars are honored as fallback.
import subprocess
import re
import urllib.request
import urllib.parse


def _keychain_secret(env_name: str, keychain_service: str) -> str:
    env_val = os.environ.get(env_name, "").strip()
    if env_val:
        return env_val
    try:
        result = subprocess.run(
            ["security", "find-generic-password",
             "-a", os.environ.get("USER", ""),
             "-s", keychain_service, "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


BOT_TOKEN = _keychain_secret("DISCORD_BOT_TOKEN", "discord_bot_token")
if not BOT_TOKEN:
    raise SystemExit(
        "Discord bot token not found. Store it in Keychain once:\n"
        "  security add-generic-password -a \"$USER\" -s \"discord_bot_token\" -w\n"
        "Or set the DISCORD_BOT_TOKEN env var."
    )

# Anthropic key — set into env so the SDK auto-picks it up
_anthropic_key = _keychain_secret("ANTHROPIC_API_KEY", "anthropic_api_key")
if _anthropic_key:
    os.environ["ANTHROPIC_API_KEY"] = _anthropic_key
else:
    raise SystemExit(
        "Anthropic API key not found. Store it in Keychain once:\n"
        "  security add-generic-password -a \"$USER\" -s \"anthropic_api_key\" -w\n"
        "Or set the ANTHROPIC_API_KEY env var."
    )

# Track posted roasts: {discord_message_id: context_text}
ROAST_TRACKER: dict = {}

# Track last seen trade timestamp
LAST_TRADE_FILE = SCRIPT_DIR.parent / "data" / "last_trade_timestamp.txt"


def get_last_trade_ts() -> int:
    if LAST_TRADE_FILE.exists():
        return int(LAST_TRADE_FILE.read_text().strip())
    return 0


def save_last_trade_ts(ts: int):
    LAST_TRADE_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_TRADE_FILE.write_text(str(ts))


# ── Discord Bot Setup ──────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
intents.members = True
bot = commands.Bot(command_prefix="!", intents=intents)


# ── Trade Analysis + Posting ───────────────────────────────────────────────

_GIF_TAG_RE = re.compile(r"\[GIF:\s*([^\]]+?)\s*\]\s*$", re.IGNORECASE | re.MULTILINE)


def _extract_gif_query(roast_text: str) -> tuple[str, str]:
    """Pull [GIF: ...] from end of roast. Returns (clean_roast, gif_query)."""
    m = _GIF_TAG_RE.search(roast_text)
    if not m:
        return roast_text, ""
    query = m.group(1).strip()
    clean = roast_text[:m.start()].rstrip()
    return clean, query


def _fetch_gif_via_worker(query: str) -> str:
    """Hit the Worker /api/giphy-search proxy to get a Giphy URL.

    Uses the Worker's GIPHY_API_KEY secret. Same path the drops post uses
    (Keith 2026-05-22 — wire roast GIFs like drops). Sync HTTP — fast
    enough not to need an aiohttp call.
    """
    if not query:
        return ""
    url = f"{WORKER_GIPHY_PROXY_URL}?{urllib.parse.urlencode({'q': query})}"
    req = urllib.request.Request(
        url, headers={"User-Agent": "ups-roast-bot-launchd (production)"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("ok"):
            return data.get("gif_url", "") or ""
    except Exception as e:
        print(f"[{datetime.now()}] Giphy proxy error: {e}")
    return ""


async def analyze_and_post(channel: discord.TextChannel, trade_txn: dict,
                           extension_years: int = 0,
                           extension_player_id: str = ""):
    """v9 flow: announcement embed → thread → roast → GIF.

    Mirrors test_fire_ab.py end-to-end. Keith 2026-05-22.

    1. Analyze trade via trade_grader.analyze_trade
    2. Build announcement embed (trade_announcement.build_announcement_embed)
    3. Post announcement to `channel` (Message 1)
    4. Create thread off announcement (auto-archive 24h)
    5. Build roast context, generate Opus roast
    6. Parse [GIF: ...] tag → clean roast + GIF query
    7. Post clean roast in thread (Message 2)
    8. Fetch GIF via Worker proxy
    9. Post GIF in thread (Message 3)
    10. Track both messages in ROAST_TRACKER (replies to either route here)
    11. Save to archive
    """
    fr_a = trade_txn.get("franchise", "")
    fr_b = trade_txn.get("franchise2", "")
    print(f"[{datetime.now()}] Analyzing trade: {fr_a} ↔ {fr_b}")

    # 1. Analyze trade
    franchises = load_franchises()
    analysis = analyze_trade(
        trade_txn,
        load_players_map(), franchises, load_rosters(), load_rollover(),
        load_auction_pool(), load_team_caps(), load_future_picks(),
        load_trade_value_model(),
    )

    # 2. Build announcement embed
    ts_int = int(trade_txn.get("timestamp", 0))
    trade_iso = datetime.fromtimestamp(ts_int, tz=timezone.utc).isoformat() if ts_int else ""
    announce_embed_dict = build_announcement_embed(analysis, franchises, trade_iso)
    # Convert dict to discord.Embed
    announce_embed = discord.Embed.from_dict(announce_embed_dict)

    # 3. Post announcement (Message 1)
    print(f"[{datetime.now()}] Posting announcement to #{channel.name}")
    announce_msg = await channel.send(embed=announce_embed, allowed_mentions=discord.AllowedMentions.none())

    # 4. Create thread
    team_a = franchises.get(analysis.side_a.franchise_id, analysis.side_a.franchise_name or "Team A")
    team_b = franchises.get(analysis.side_b.franchise_id, analysis.side_b.franchise_name or "Team B")
    thread_name = f"Trade Roast — {team_a} ↔ {team_b}"[:100]
    print(f"[{datetime.now()}] Creating thread '{thread_name}'")
    thread = await announce_msg.create_thread(name=thread_name, auto_archive_duration=1440)

    # 5. Build context + generate roast
    ctx = build_trade_roast_context(
        trade_txn,
        extension_years=extension_years,
        extension_player_id=extension_player_id,
    )
    context_text = context_to_prompt_text(ctx)
    print(f"[{datetime.now()}] Context built ({len(context_text)} chars). Calling Claude Opus...")
    raw_roast = generate_trade_roast(context_text)

    # 6. Parse GIF tag
    roast_clean, gif_query = _extract_gif_query(raw_roast)
    print(f"[{datetime.now()}] Roast generated ({len(roast_clean)} chars). GIF query: {gif_query!r}")

    # 7. Post roast in thread (Message 2)
    roast_embed = discord.Embed(
        title="🔥 Roast",
        description=roast_clean[:4096],
        color=0x5865F2,
    )
    roast_msg = await thread.send(embed=roast_embed, allowed_mentions=discord.AllowedMentions.none())

    # 8. + 9. Fetch GIF via worker proxy + post in thread (Message 3)
    gif_url = _fetch_gif_via_worker(gif_query) if gif_query else ""
    gif_msg = None
    if gif_url:
        gif_embed = discord.Embed(color=0x202225)
        gif_embed.set_image(url=gif_url)
        gif_msg = await thread.send(embed=gif_embed, allowed_mentions=discord.AllowedMentions.none())

    # 10. Track for reply monitoring — both announcement + roast can be replied to
    tracker_payload = {
        "context_text": context_text,
        "ctx": ctx,
        "thread_id": thread.id,
        "announcement_msg_id": announce_msg.id,
        "roast_msg_id": roast_msg.id,
        "timestamp": time.time(),
    }
    ROAST_TRACKER[announce_msg.id] = tracker_payload
    ROAST_TRACKER[roast_msg.id] = tracker_payload

    # 11. Save to archive
    save_to_archive({
        "id": f"trade-{trade_txn.get('timestamp', '')}",
        "type": "trade_roast",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "teams": [ctx["side_a"]["franchise"]["franchise_id"],
                  ctx["side_b"]["franchise"]["franchise_id"]],
        "discord_announcement_msg_id": announce_msg.id,
        "discord_thread_id": thread.id,
        "discord_roast_msg_id": roast_msg.id,
        "discord_gif_msg_id": gif_msg.id if gif_msg else None,
        "channel_id": channel.id,
        "env": ROAST_BOT_ENV,
        "content": {
            "roast": roast_clean,
            "gif_query": gif_query,
            "gif_url": gif_url,
            "grades": {
                ctx["side_a"]["franchise"]["franchise_id"]: ctx["side_a"]["grade"],
                ctx["side_b"]["franchise"]["franchise_id"]: ctx["side_b"]["grade"],
            },
        },
        "replies": [],
    })

    print(f"[{datetime.now()}] Posted to #{channel.name} (env={ROAST_BOT_ENV}, "
          f"announcement={announce_msg.id}, thread={thread.id}, "
          f"roast={roast_msg.id}, gif={gif_msg.id if gif_msg else 'none'})")


# Legacy build_report_block() + split_message() helpers removed in v9 — the
# ASCII code-block intelligence report is replaced by the
# trade_announcement.build_announcement_embed() flow. See git history if you
# need the legacy version back (last live in commit ~8fd4087 era).


# ── Reply Monitoring ───────────────────────────────────────────────────────

@bot.event
async def on_message(message: discord.Message):
    if message.author.bot:
        return

    # Check if this is a reply to one of our roasts
    if message.reference and message.reference.message_id in ROAST_TRACKER:
        tracked = ROAST_TRACKER[message.reference.message_id]
        await handle_reply(message, tracked)
        return

    await bot.process_commands(message)


async def handle_reply(message: discord.Message, tracked: dict):
    """Handle a reply to a roast message."""
    reply_text = message.content
    context_text = tracked["context_text"]
    ctx = tracked["ctx"]

    print(f"[{datetime.now()}] Reply from {message.author.name}: {reply_text[:100]}")

    # Classify the reply
    classification = classify_reply(reply_text, context_text)
    category = classification.get("category", "COPE")
    details = classification.get("details", "")

    print(f"[{datetime.now()}] Classified as: {category} — {details}")

    # Identify the replier's franchise
    discord_users = load_discord_users()
    replier_fid = None
    for fid, user_info in discord_users.items():
        if str(message.author.id) == str(user_info.get("discord_userid", "")):
            replier_fid = fid
            break

    if category == "VALUE_SIGNAL":
        log_value_signal(details, reply_text, replier_fid or "")
        await message.reply("Interesting take. Logged for model review.")

    elif category == "DATA_ERROR":
        log_data_error(details, reply_text, replier_fid or "")
        await message.reply("Noted. We'll verify against the source data.")

    elif category == "COPE":
        # Build replier context for personalized clap back
        replier_context = ""
        if replier_fid:
            career_stats = load_career_stats()
            cs = career_stats.get(replier_fid, {})
            cap = cs.get("career_allplay", {})
            replier_context = (
                f"Replier: {cs.get('franchise_name', 'Unknown')} "
                f"(franchise {replier_fid})\n"
                f"Career allplay: {cap.get('w',0)}-{cap.get('l',0)} "
                f"({cs.get('career_allplay_pct', 0):.3f})\n"
                f"Championships: {cs.get('championships', 0)}\n"
                f"Championship drought: {cs.get('championship_drought', 0)} years\n"
                f"Best finish: #{cs.get('best_finish', '?')}\n"
                f"Worst finish: #{cs.get('worst_finish', '?')}\n"
            )
            if cs.get("trend"):
                replier_context += "Recent trend:\n"
                for t in cs["trend"]:
                    replier_context += f"  {t['season']}: allplay {t['allplay_pct']:.3f}, finish #{t['finish']}\n"

        clap_back = generate_clap_back(reply_text, context_text, replier_context)
        await message.reply(clap_back)

        print(f"[{datetime.now()}] Clap back sent: {clap_back[:100]}")


# ── Trade Polling ──────────────────────────────────────────────────────────

@tasks.loop(seconds=POLL_INTERVAL_SECONDS)
async def poll_for_trades():
    """Check MFL API for new trades every 5 minutes.

    Posts to ROAST_CHANNEL_ID (prod when ROAST_BOT_ENV=prod and
    DISCORD_TRADE_CHANNEL_ID is set, else test channel).
    """
    try:
        channel = bot.get_channel(ROAST_CHANNEL_ID)
        if not channel:
            print(f"[{datetime.now()}] Channel {ROAST_CHANNEL_ID} (env={ROAST_BOT_ENV}) not found")
            return

        trades = fetch_trades()
        last_ts = get_last_trade_ts()

        for trade in trades:
            ts = int(trade.get("timestamp", 0))
            if ts > last_ts:
                print(f"[{datetime.now()}] New trade detected! ts={ts}")

                # Check trade comments for extension hints
                comments = trade.get("comments", "").lower()
                ext_years = 0
                ext_player = ""
                if "extension" in comments or "extend" in comments:
                    ext_years = 2  # default assumption
                    # Try to identify the player from franchise2_gave_up
                    gave_up = trade.get("franchise2_gave_up", "")
                    for token in gave_up.split(","):
                        token = token.strip()
                        if token and not token.startswith("FP_") and not token.startswith("BB_"):
                            ext_player = token
                            break

                await analyze_and_post(channel, trade, ext_years, ext_player)
                save_last_trade_ts(ts)

    except Exception as e:
        print(f"[{datetime.now()}] Poll error: {e}")


# ── Bot Events ─────────────────────────────────────────────────────────────

@bot.event
async def on_ready():
    print(f"[{datetime.now()}] Bot connected as {bot.user}")
    print(f"[{datetime.now()}] Guilds: {[g.name for g in bot.guilds]}")
    print(f"[{datetime.now()}] Env: ROAST_BOT_ENV={ROAST_BOT_ENV}, "
          f"ROAST_CHANNEL_ID={ROAST_CHANNEL_ID} "
          f"(test={TEST_CHANNEL_ID}, prod={PROD_CHANNEL_ID or 'unset'})")
    if not poll_for_trades.is_running():
        poll_for_trades.start()
    print(f"[{datetime.now()}] Trade polling started (every {POLL_INTERVAL_SECONDS}s)")


# ── Test Mode ──────────────────────────────────────────────────────────────

async def run_test(trade_timestamp: int = HURTS_TRADE_TS,
                   extension_years: int = 2,
                   extension_player_id: str = "14783"):
    """Run a one-shot test: post a roast for a specific trade.

    Test mode ALWAYS posts to TEST_CHANNEL_ID regardless of ROAST_BOT_ENV —
    this is the safety valve for iterating on roast structure without
    risking a prod post.
    """
    await bot.wait_until_ready()

    channel = bot.get_channel(TEST_CHANNEL_ID)
    if not channel:
        print(f"ERROR: Channel {TEST_CHANNEL_ID} not found")
        return

    # Find the trade
    trades = fetch_trades()
    trade = None
    for t in trades:
        if int(t.get("timestamp", 0)) == trade_timestamp:
            trade = t
            break

    if not trade:
        print(f"ERROR: Trade with timestamp {trade_timestamp} not found")
        return

    await analyze_and_post(
        channel, trade,
        extension_years=extension_years,
        extension_player_id=extension_player_id,
    )
    print("Test complete. Bot will stay running to monitor replies.")


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="UPS Trade Roast Bot")
    parser.add_argument("--test", action="store_true",
                        help="Post Hurts trade roast to test channel")
    parser.add_argument("--test-ts", type=int, default=0,
                        help="Specific trade timestamp to test")
    parser.add_argument("--ext-years", type=int, default=0,
                        help="Extension years to project")
    parser.add_argument("--ext-player", type=str, default="",
                        help="Player ID for extension projection")
    args = parser.parse_args()

    if args.test or args.test_ts:
        ts = args.test_ts or HURTS_TRADE_TS
        ext_years = args.ext_years or (2 if ts == HURTS_TRADE_TS else 0)
        ext_player = args.ext_player or ("14783" if ts == HURTS_TRADE_TS else "")

        @bot.event
        async def on_ready():
            print(f"[{datetime.now()}] Bot ready. Running test...")
            await run_test(ts, ext_years, ext_player)

    bot.run(BOT_TOKEN)


if __name__ == "__main__":
    main()
