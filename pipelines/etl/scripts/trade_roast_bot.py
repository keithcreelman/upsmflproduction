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

from trade_grader import fetch_trades, load_franchises
from trade_roast_context import (
    build_trade_roast_context, context_to_prompt_text,
    load_career_stats, load_discord_users,
)
from content_engine import (
    generate_trade_roast, classify_reply, generate_clap_back,
    log_value_signal, log_data_error, save_to_archive,
)

# ── Config ─────────────────────────────────────────────────────────────────
TEST_CHANNEL_ID = 1089538054236160010
HURTS_TRADE_TS = 1775772921
POLL_INTERVAL_SECONDS = 300  # 5 minutes

# Bot token — supply via DISCORD_BOT_TOKEN env var. The previously
# hardcoded literal was flagged by GitHub push-protection and has been
# scrubbed; rotate a new token in the Discord developer portal and
# export it before running the script.
BOT_TOKEN = os.environ.get("DISCORD_BOT_TOKEN", "")
if not BOT_TOKEN:
    raise SystemExit(
        "DISCORD_BOT_TOKEN env var is required — the previously-committed "
        "token was public for a moment and must be rotated before use."
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

async def analyze_and_post(channel: discord.TextChannel, trade_txn: dict,
                           extension_years: int = 0,
                           extension_player_id: str = ""):
    """Full pipeline: analyze trade → generate roast → post to Discord."""

    print(f"[{datetime.now()}] Analyzing trade: {trade_txn.get('franchise','')} "
          f"↔ {trade_txn.get('franchise2','')}")

    # Build context
    ctx = build_trade_roast_context(
        trade_txn,
        extension_years=extension_years,
        extension_player_id=extension_player_id,
    )
    context_text = context_to_prompt_text(ctx)

    print(f"[{datetime.now()}] Context built. Calling Claude Opus...")

    # Generate roast
    roast = generate_trade_roast(context_text)

    print(f"[{datetime.now()}] Roast generated ({len(roast)} chars). Posting...")

    # Build the data report section (code block)
    report = build_report_block(ctx)

    # Post report as code block
    if len(report) > 1900:
        # Split into multiple messages if needed
        parts = split_message(report, 1900)
        for part in parts:
            await channel.send(f"```\n{part}\n```")
    else:
        await channel.send(f"```\n{report}\n```")

    # Post roast as plain text (may need splitting too)
    roast_parts = split_message(roast, 1900)
    last_msg = None
    for part in roast_parts:
        last_msg = await channel.send(part)

    # Track the roast message for reply monitoring
    if last_msg:
        ROAST_TRACKER[last_msg.id] = {
            "context_text": context_text,
            "ctx": ctx,
            "timestamp": time.time(),
        }

    # Save to archive
    save_to_archive({
        "id": f"trade-{trade_txn.get('timestamp', '')}",
        "type": "trade_roast",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "teams": [ctx["side_a"]["franchise"]["franchise_id"],
                  ctx["side_b"]["franchise"]["franchise_id"]],
        "discord_message_id": last_msg.id if last_msg else None,
        "content": {
            "report": report,
            "roast": roast,
            "grades": {
                ctx["side_a"]["franchise"]["franchise_id"]: ctx["side_a"]["grade"],
                ctx["side_b"]["franchise"]["franchise_id"]: ctx["side_b"]["grade"],
            },
        },
        "replies": [],
    })

    print(f"[{datetime.now()}] Posted to #{channel.name}")


def build_report_block(ctx: dict) -> str:
    """Build the structured data report (posted as code block)."""
    a = ctx["side_a"]
    b = ctx["side_b"]
    fa = a["franchise"]
    fb = b["franchise"]

    lines = []
    lines.append("═══════════════════════════════════════════")
    lines.append("       UPS TRADE INTELLIGENCE REPORT")
    lines.append("═══════════════════════════════════════════")
    lines.append("")
    lines.append(f"TRADE: {fa['franchise_name']} ↔ {fb['franchise_name']}")
    lines.append("")

    # Assets
    lines.append(f"  {fa['franchise_name']} gave:")
    for pk in a["picks_given"]:
        lines.append(f"    {pk['year']} Round {pk['round']} pick")
    for p in a["players_given"]:
        lines.append(f"    {p['name']} ({p['position']}) — ${p['salary']:,}/yr")
    if a["salary_given"]:
        lines.append(f"    ${a['salary_given']:,} traded salary")

    lines.append(f"  {fb['franchise_name']} gave:")
    for pk in b["picks_given"]:
        lines.append(f"    {pk['year']} Round {pk['round']} pick")
    for p in b["players_given"]:
        lines.append(f"    {p['name']} ({p['position']}) — ${p['salary']:,}/yr")
    if b["salary_given"]:
        lines.append(f"    ${b['salary_given']:,} traded salary")

    if ctx["effective_cost_note"]:
        lines.append(f"\n  ** {ctx['effective_cost_note']}")

    # Extension
    if ctx["extension_projections"]:
        lines.append("\n  EXTENSION PROJECTION:")
        for pid, ext in ctx["extension_projections"].items():
            lines.append(f"    Current salary: ${ext['current_salary']:,}")
            for i, sal in enumerate(ext["extension_salaries"], 1):
                lines.append(f"    Extension yr {i}: ${sal:,}")
            lines.append(f"    Total: ${ext['total_commitment']:,} / {ext['total_years']}yr "
                         f"(${ext['effective_aav']:,} avg)")

    # Auction alternatives
    lines.append("\n  FREE AGENTS AVAILABLE AT AUCTION:")
    for pos, comps in ctx["auction_comparables"].items():
        for c in comps[:5]:
            lines.append(f"    {c['name']:<22} Auction price: ${c['exp_price']:>7,.0f}  "
                         f"PPG: {c.get('exp_ppg',0):.1f}")

    # Grades
    lines.append(f"\n  GRADES: {fa['franchise_name']} {a['grade']}  |  "
                 f"{fb['franchise_name']} {b['grade']}")

    lines.append("═══════════════════════════════════════════")
    return "\n".join(lines)


def split_message(text: str, max_len: int = 1900) -> list:
    """Split text into chunks that fit Discord's 2000 char limit."""
    if len(text) <= max_len:
        return [text]
    parts = []
    while text:
        if len(text) <= max_len:
            parts.append(text)
            break
        # Find last newline before limit
        split_at = text.rfind("\n", 0, max_len)
        if split_at == -1:
            split_at = max_len
        parts.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    return parts


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
    """Check MFL API for new trades every 5 minutes."""
    try:
        channel = bot.get_channel(TEST_CHANNEL_ID)
        if not channel:
            print(f"[{datetime.now()}] Channel {TEST_CHANNEL_ID} not found")
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
    if not poll_for_trades.is_running():
        poll_for_trades.start()
    print(f"[{datetime.now()}] Trade polling started (every {POLL_INTERVAL_SECONDS}s)")


# ── Test Mode ──────────────────────────────────────────────────────────────

async def run_test(trade_timestamp: int = HURTS_TRADE_TS,
                   extension_years: int = 2,
                   extension_player_id: str = "14783"):
    """Run a one-shot test: post a roast for a specific trade."""
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
