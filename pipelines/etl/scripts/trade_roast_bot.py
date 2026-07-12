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
import functools
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
WORKER_BASE_URL = "https://upsmflproduction.keith-creelman.workers.dev"
WORKER_GIPHY_PROXY_URL = f"{WORKER_BASE_URL}/api/giphy-search"
WORKER_ROAST_TRACK_URL = f"{WORKER_BASE_URL}/api/roast-thread/track"
WORKER_HEARTBEAT_URL = f"{WORKER_BASE_URL}/api/roast-heartbeat"

# Heartbeat — proof-of-life for the watchdog + the Commish Settings status pill.
# Written locally every poll tick (the watchdog checks its age to catch HANGS,
# which a pgrep-style check can't see — the 2026-07-11 incident was a live
# process frozen 25h on a blocking read). Also POSTed to the worker (throttled)
# so Commish Settings can show "last heartbeat Xm ago" instead of a hardcoded
# PROD pill.
SUPPORT_DIR = Path.home() / "Library" / "Application Support" / "ups-roast-bot"
HEARTBEAT_FILE = SUPPORT_DIR / "heartbeat.json"
HEARTBEAT_POST_MIN_INTERVAL = 60  # seconds between worker heartbeat POSTs
_last_hb_post = 0.0

# Per-trade processing attempts — after MAX_TRADE_ATTEMPTS failures the cursor
# advances anyway (and the commish gets a DM) so one poisoned trade can't wedge
# the poll loop forever. Success path advances the cursor ONLY after the post.
MAX_TRADE_ATTEMPTS = 3
_trade_attempts: dict = {}

# Secrets — preferred location is the macOS Keychain. Store once with:
#   security add-generic-password -a "$USER" -s "discord_bot_token" -w
#   security add-generic-password -a "$USER" -s "anthropic_api_key" -w
# (each prompts for the value; never echoes to shell history).
# Env vars are honored as fallback.
import subprocess
import re
import urllib.request
import urllib.parse
import urllib.error


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

# Worker → roast-track shared secret. Lets the bot register each roast in D1
# so the worker-side Reply button handler (Option B, Keith 2026-05-23) can
# load the prompt context. Optional — if missing, the button still appears
# but clicking it returns "tracking expired" from the worker. To enable:
#   security add-generic-password -a "$USER" -s "ups_roast_track_api_key" -w
# AND set the same value as worker secret ROAST_TRACK_API_KEY:
#   echo "<value>" | npx wrangler secret put ROAST_TRACK_API_KEY --config worker/wrangler.toml
ROAST_TRACK_API_KEY = _keychain_secret("ROAST_TRACK_API_KEY", "ups_roast_track_api_key")

# Track posted roasts: {discord_message_id: tracker_payload}
# Persisted to disk so clap-back monitoring + reply button survive bot restarts.
ROAST_TRACKER: dict = {}
TRACKER_FILE = SCRIPT_DIR.parent / "data" / "roast_tracker.json"


def _save_tracker():
    """Persist ROAST_TRACKER to disk so it survives restart."""
    try:
        TRACKER_FILE.parent.mkdir(parents=True, exist_ok=True)
        # Strip non-serializable fields (ctx dicts can be deep)
        serializable = {}
        for k, v in ROAST_TRACKER.items():
            serializable[str(k)] = {
                "context_text": v.get("context_text", "")[:8000],  # cap at 8KB
                "thread_id": v.get("thread_id"),
                "channel_id": v.get("channel_id"),
                "announcement_msg_id": v.get("announcement_msg_id"),
                "roast_msg_id": v.get("roast_msg_id"),
                "timestamp": v.get("timestamp"),
            }
        tmp = TRACKER_FILE.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(serializable, f, indent=2)
        tmp.replace(TRACKER_FILE)
    except Exception as e:
        print(f"[{datetime.now()}] _save_tracker failed: {e}")


def _load_tracker():
    """Restore ROAST_TRACKER from disk on bot startup."""
    if not TRACKER_FILE.exists():
        return
    try:
        with open(TRACKER_FILE) as f:
            data = json.load(f)
        for k, v in data.items():
            ROAST_TRACKER[int(k)] = v
        print(f"[{datetime.now()}] Loaded {len(ROAST_TRACKER)} tracked roast entries from {TRACKER_FILE}")
    except Exception as e:
        print(f"[{datetime.now()}] _load_tracker failed: {e}")


async def _in_executor(label: str, timeout: float, fn, *args, **kwargs):
    """Run a sync (potentially blocking) callable off the event loop with a hard
    timeout. THE lesson of 2026-07-11: one synchronous open() of an iCloud file
    inside the async flow froze the entire bot — heartbeat, polling, everything —
    for 25 hours. Every network/file-bound stage now runs in a worker thread and
    the loop gets its thread back on timeout (the stuck thread can't be killed,
    but the bot keeps living: polling continues and the failed trade retries)."""
    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, functools.partial(fn, *args, **kwargs)),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        raise RuntimeError(f"{label} timed out after {timeout:.0f}s (blocking call abandoned)")


def _write_local_heartbeat(status: str):
    try:
        SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
        tmp = HEARTBEAT_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"ts": int(time.time()), "status": status,
                                   "pid": os.getpid(), "env": ROAST_BOT_ENV}))
        tmp.replace(HEARTBEAT_FILE)
    except Exception as e:
        print(f"[{datetime.now()}] heartbeat write failed: {e}")


def _post_worker_heartbeat_sync(status: str):
    """Best-effort POST to the worker so Commish Settings shows live status."""
    if not ROAST_TRACK_API_KEY:
        return
    try:
        body = json.dumps({"bot": "trade_roast", "status": status,
                           "env": ROAST_BOT_ENV}).encode()
        req = urllib.request.Request(
            WORKER_HEARTBEAT_URL, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {ROAST_TRACK_API_KEY}"})
        urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:
        print(f"[{datetime.now()}] worker heartbeat failed (non-fatal): {e}")


async def _heartbeat(status: str = "ok"):
    """Local file always; worker POST throttled to one per minute."""
    global _last_hb_post
    _write_local_heartbeat(status)
    now = time.time()
    if now - _last_hb_post >= HEARTBEAT_POST_MIN_INTERVAL:
        _last_hb_post = now
        try:
            await _in_executor("worker heartbeat", 10, _post_worker_heartbeat_sync, status)
        except Exception:
            pass


async def _dm_commish(text: str):
    """Best-effort DM to the commish (COMMISH_DISCORD_USER_ID env)."""
    uid = int(os.environ.get("COMMISH_DISCORD_USER_ID", "0") or 0)
    if not uid:
        return
    try:
        user = bot.get_user(uid) or await bot.fetch_user(uid)
        await user.send(text[:1900])
    except Exception as e:
        print(f"[{datetime.now()}] commish DM failed: {e}")


# Track last seen trade timestamp
LAST_TRADE_FILE = SCRIPT_DIR.parent / "data" / "last_trade_timestamp.txt"


def get_last_trade_ts() -> int:
    # A missing/corrupt marker must NEVER fall back to 0 — that would replay the
    # entire trade history. Default to "now" so a reset can't repost old trades.
    if LAST_TRADE_FILE.exists():
        try:
            return int(LAST_TRADE_FILE.read_text().strip())
        except Exception:
            pass
    return int(time.time())


def save_last_trade_ts(ts: int):
    LAST_TRADE_FILE.parent.mkdir(parents=True, exist_ok=True)
    LAST_TRADE_FILE.write_text(str(ts))


# ── Discord Bot Setup ──────────────────────────────────────────────────────
intents = discord.Intents.default()
intents.message_content = True
intents.members = True
bot = commands.Bot(command_prefix="!", intents=intents)


# ── Reply Button / Modal (Keith 2026-05-23: more intuitive than Discord Reply) ─

class ReplyModal(discord.ui.Modal, title="💬 Reply to the bot"):
    """Modal that pops up when a user clicks the Reply button on a roast.

    Submitting it triggers the same clap-back loop as a normal Discord
    "Reply" — classify (Sonnet), then VALUE_SIGNAL/DATA_ERROR/COPE branch.
    """
    response = discord.ui.TextInput(
        label="Your take",
        style=discord.TextStyle.paragraph,
        max_length=1900,
        placeholder="Defend your team. Call out a stat. Vent. Whatever.",
        required=True,
    )

    def __init__(self, roast_msg_id: int):
        super().__init__()
        self.roast_msg_id = roast_msg_id

    async def on_submit(self, interaction: discord.Interaction):
        reply_text = self.response.value.strip()
        tracked = ROAST_TRACKER.get(self.roast_msg_id)
        if not tracked:
            await interaction.response.send_message(
                "This roast's tracking expired. Use Discord's Reply feature on the roast message instead.",
                ephemeral=True,
            )
            return
        # Acknowledge the modal immediately (ephemeral)
        await interaction.response.send_message("Posting your reply...", ephemeral=True)
        # Echo the user's reply into the thread so others can see it
        thread = interaction.channel
        author = interaction.user
        await thread.send(
            f"**{author.display_name}** says:\n> {reply_text[:1900]}",
            allowed_mentions=discord.AllowedMentions.none(),
        )
        # Run the clap-back logic against this reply
        await _run_clap_back(
            reply_text=reply_text,
            replier_user_id=author.id,
            replier_name=author.display_name,
            tracked=tracked,
            post_destination=thread,
        )


class ReplyView(discord.ui.View):
    """Persistent View with a Reply button. Attached to each roast message.

    timeout=None + custom_id makes it survive bot restarts when re-registered
    via bot.add_view() in on_ready.
    """
    def __init__(self, roast_msg_id: int = 0):
        super().__init__(timeout=None)
        # Dynamic button so each roast has its own custom_id (encoding the msg_id).
        self.add_item(ReplyButton(roast_msg_id))


class ReplyButton(discord.ui.Button):
    def __init__(self, roast_msg_id: int):
        super().__init__(
            label="💬 Reply to bot",
            style=discord.ButtonStyle.primary,
            custom_id=f"roast_reply:{roast_msg_id}",
        )
        self.roast_msg_id = roast_msg_id

    async def callback(self, interaction: discord.Interaction):
        # Parse roast_msg_id from custom_id (works for persistent views after restart)
        cid = self.custom_id or ""
        msg_id = self.roast_msg_id
        if cid.startswith("roast_reply:"):
            try:
                msg_id = int(cid.split(":", 1)[1])
            except (ValueError, IndexError):
                pass
        modal = ReplyModal(msg_id)
        await interaction.response.send_modal(modal)


async def _run_clap_back(reply_text: str, replier_user_id: int, replier_name: str,
                         tracked: dict, post_destination):
    """Core clap-back loop — reused by on_message handler AND modal submission.

    `post_destination` is anything with an async .send(content) method
    (a Channel, Thread, or — in on_message — a discord.Message wrapper
    that proxies .reply()).
    """
    context_text = tracked.get("context_text", "")
    print(f"[{datetime.now()}] Reply from {replier_name}: {reply_text[:100]}")

    classification = classify_reply(reply_text, context_text)
    category = classification.get("category", "COPE")
    details = classification.get("details", "")
    print(f"[{datetime.now()}] Classified as: {category} — {details}")

    # Identify replier franchise
    discord_users = load_discord_users()
    replier_fid = None
    for fid, user_info in discord_users.items():
        if str(replier_user_id) == str(user_info.get("discord_userid", "")):
            replier_fid = fid
            break

    if category == "VALUE_SIGNAL":
        log_value_signal(details, reply_text, replier_fid or "")
        await post_destination.send("Interesting take. Logged for model review.",
                                    allowed_mentions=discord.AllowedMentions.none())
        return

    if category == "DATA_ERROR":
        log_data_error(details, reply_text, replier_fid or "")
        await post_destination.send("Noted. We'll verify against the source data.",
                                    allowed_mentions=discord.AllowedMentions.none())
        return

    # COPE → full clap-back. Use OWNER-tenure stats not franchise stats.
    replier_context = ""
    if replier_fid:
        career_stats = load_career_stats()
        cs = career_stats.get(replier_fid, {})
        owner = cs.get("owner", {})
        owner_name = owner.get("display") or "the owner"
        owner_ap = owner.get("allplay", {}) or {}
        replier_context = (
            f"Replier: {owner_name} (franchise {replier_fid} — {cs.get('franchise_name', 'Unknown')})\n"
            f"Owner tenure: {owner.get('seasons_count', 0)} season(s) since {owner.get('first_season', 'unknown')}\n"
            f"Owner allplay: {owner_ap.get('w', 0)}-{owner_ap.get('l', 0)} "
            f"({owner.get('allplay_pct', 0):.3f})\n"
            f"Owner championships: {owner.get('championships', 0)}\n"
            f"Owner playoff appearances: {owner.get('playoff_appearances', 0)}\n"
            f"Best finish under this owner: #{owner.get('best_finish', '?')}\n"
            f"Worst finish under this owner: #{owner.get('worst_finish', '?')}\n"
        )
        if cs.get("trend"):
            replier_context += "Recent franchise trend (any owner — for context only):\n"
            for t in cs["trend"]:
                replier_context += f"  {t['season']}: allplay {t['allplay_pct']:.3f}, finish #{t['finish']}\n"

    clap_back = generate_clap_back(reply_text, context_text, replier_context)
    await post_destination.send(clap_back, allowed_mentions=discord.AllowedMentions.none())
    print(f"[{datetime.now()}] Clap back sent: {clap_back[:100]}")


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


async def _track_roast_async(payload: dict) -> bool:
    """Off-loop wrapper for _track_roast_to_worker — best-effort, never raises."""
    try:
        return await _in_executor("roast track", 15, _track_roast_to_worker, payload)
    except Exception as e:
        print(f"[{datetime.now()}] roast track skipped: {e}")
        return False


def _track_roast_to_worker(payload: dict) -> bool:
    """Register a roast in D1 via POST /api/roast-thread/track.

    Lets the worker handle Reply-button interactions when Discord routes
    them to /discord/interactions (Discord App has an Interactions Endpoint
    URL set, which bypasses the gateway-based Python bot). Without this row
    the button returns "tracking expired."

    Soft failure: if the worker secret is unconfigured or the call fails,
    log and continue — the in-memory ROAST_TRACKER + Python ReplyView still
    handles the case if interactions ever route to the gateway. The
    worker-handled path is the LIVE path right now though, so a failure
    here means clap-backs won't fire for this roast.
    """
    if not ROAST_TRACK_API_KEY:
        print(f"[{datetime.now()}] roast-track skipped — "
              f"ROAST_TRACK_API_KEY not in env or Keychain")
        return False
    try:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            WORKER_ROAST_TRACK_URL,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {ROAST_TRACK_API_KEY}",
                "Content-Type": "application/json",
                "User-Agent": "ups-roast-bot-launchd",
            },
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("ok"):
            print(f"[{datetime.now()}] roast-track OK "
                  f"(roast_message_id={data.get('roast_message_id')})")
            return True
        print(f"[{datetime.now()}] roast-track non-ok: {data}")
        return False
    except urllib.error.HTTPError as e:
        body_preview = ""
        try: body_preview = e.read().decode("utf-8")[:300]
        except Exception: pass
        print(f"[{datetime.now()}] roast-track HTTP {e.code}: {body_preview}")
        return False
    except Exception as e:
        print(f"[{datetime.now()}] roast-track error: {e}")
        return False


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

    # 1. Analyze trade — every loader hits the MFL API (sync urllib), so the whole
    # stage runs off-loop with a hard timeout (see _in_executor: 2026-07-11 hang).
    def _analyze_sync():
        franchises_ = load_franchises()
        analysis_ = analyze_trade(
            trade_txn,
            load_players_map(), franchises_, load_rosters(), load_rollover(),
            load_auction_pool(), load_team_caps(), load_future_picks(),
            load_trade_value_model(),
        )
        return franchises_, analysis_
    franchises, analysis = await _in_executor("analyze_trade", 180, _analyze_sync)

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

    # 5. Build context + generate roast — both sync + blocking (file reads, MFL
    # fetches, the Anthropic SDK call), so both run off-loop with hard timeouts.
    ctx = await _in_executor(
        "build_trade_roast_context", 120, build_trade_roast_context,
        trade_txn,
        extension_years=extension_years,
        extension_player_id=extension_player_id,
    )
    context_text = context_to_prompt_text(ctx)
    print(f"[{datetime.now()}] Context built ({len(context_text)} chars). Calling Claude Opus...")
    raw_roast = await _in_executor("generate_trade_roast", 300, generate_trade_roast, context_text)

    # 6. Parse GIF tag
    roast_clean, gif_query = _extract_gif_query(raw_roast)
    print(f"[{datetime.now()}] Roast generated ({len(roast_clean)} chars). GIF query: {gif_query!r}")

    # 7. Post roast in thread (Message 2) — with a Reply button view attached
    roast_embed = discord.Embed(
        title="🔥 Roast",
        description=roast_clean[:4096],
        color=0x5865F2,
    )
    # Post WITHOUT view first so we know the msg id, then edit-in the view
    # (View's custom_id encodes the msg id, so we need it before constructing).
    roast_msg = await thread.send(embed=roast_embed, allowed_mentions=discord.AllowedMentions.none())
    try:
        view = ReplyView(roast_msg.id)
        await roast_msg.edit(view=view)
    except Exception as e:
        print(f"[{datetime.now()}] failed to attach Reply view: {e}")

    # 8. + 9. Fetch GIF via worker proxy + post in thread (Message 3)
    gif_url = ""
    if gif_query:
        try:
            gif_url = await _in_executor("gif fetch", 20, _fetch_gif_via_worker, gif_query)
        except Exception as e:
            print(f"[{datetime.now()}] gif fetch skipped: {e}")
    gif_msg = None
    if gif_url:
        gif_embed = discord.Embed(color=0x202225)
        gif_embed.set_image(url=gif_url)
        gif_msg = await thread.send(embed=gif_embed, allowed_mentions=discord.AllowedMentions.none())

    # 10. Track for reply monitoring — both announcement + roast can be replied to.
    # Persist to disk so the bot survives restart with active threads still trackable.
    tracker_payload = {
        "context_text": context_text,
        "ctx": ctx,
        "thread_id": thread.id,
        "channel_id": channel.id,   # lets the @mention fallback match in-channel
        "announcement_msg_id": announce_msg.id,
        "roast_msg_id": roast_msg.id,
        "timestamp": time.time(),
    }
    ROAST_TRACKER[announce_msg.id] = tracker_payload
    ROAST_TRACKER[roast_msg.id] = tracker_payload
    _save_tracker()

    # 10b. Register the roast in D1 via the worker so Discord-routed
    #      Reply-button interactions can find the prompt context. Discord
    #      delivers component clicks to /discord/interactions (because the
    #      Discord App has an Interactions Endpoint URL set, bypassing the
    #      gateway). The worker reads ups_roast_threads → classify → clap-
    #      back → post to thread. Without this row, the button returns
    #      "tracking expired." Soft fail — bot keeps posting either way.
    fr_a_id = ctx["side_a"]["franchise"]["franchise_id"]
    fr_b_id = ctx["side_b"]["franchise"]["franchise_id"]
    await _track_roast_async({
        "roast_message_id": str(roast_msg.id),
        "thread_id": str(thread.id),
        "channel_id": str(channel.id),
        "announcement_message_id": str(announce_msg.id),
        "context_text": context_text[:16384],
        "roast_text": roast_clean[:8000],
        "trade_id": str(trade_txn.get("timestamp", "")),
        "trade_franchises": f"{fr_a_id},{fr_b_id}",
        "posted_at": int(time.time()),
    })

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

    # Diagnostics (ported from the prod fork — Keith 2026-05-24: when clap back
    # doesn't fire we need to SEE why: reply target, tracker hit, mentions).
    ref_id = message.reference.message_id if message.reference else None
    mentions = [u.id for u in message.mentions]
    try:
        print(f"[{datetime.now()}] on_message FIRED: "
              f"author={message.author.name}(bot={message.author.bot},id={message.author.id}) "
              f"chan={message.channel.id} reply_to={ref_id} "
              f"in_tracker={ref_id in ROAST_TRACKER if ref_id else 'n/a'} "
              f"content_len={len(message.content or '')} mentions={mentions} "
              f"bot_mentioned={(bot.user.id in mentions) if bot.user else False} "
              f"content={(message.content or '')[:80]!r}")
    except Exception as e:
        print(f"[{datetime.now()}] on_message LOG ERROR: {e}")

    # Trigger 1: explicit reply to any of our tracked roast messages
    if ref_id and ref_id in ROAST_TRACKER:
        await handle_reply(message, ROAST_TRACKER[ref_id])
        return

    # Trigger 2: @mention fallback — works in the roast thread OR the channel
    # even when the reply target isn't tracked (ported from the prod fork).
    if bot.user and bot.user.id in mentions:
        chan_id = message.channel.id
        channel_tracks = [v for v in ROAST_TRACKER.values()
                          if v.get("thread_id") == chan_id or v.get("channel_id") == chan_id]
        if channel_tracks:
            tracked = max(channel_tracks, key=lambda v: v.get("timestamp", 0) or 0)
            await handle_reply(message, tracked)
            return
        print(f"[{datetime.now()}]   → @mention seen but no tracked roast in channel {chan_id}")

    print(f"[{datetime.now()}]   → no match (not a reply to tracked roast, not @mention)")
    await bot.process_commands(message)


class _MessageReplyShim:
    """Adapter so _run_clap_back can `await x.send(content)` to call
    discord.Message.reply() — same shape as Channel/Thread.send().
    """
    def __init__(self, message: discord.Message):
        self._msg = message

    async def send(self, content: str, **kwargs):
        return await self._msg.reply(content, **kwargs)


async def handle_reply(message: discord.Message, tracked: dict):
    """Adapter from on_message → core _run_clap_back."""
    await _run_clap_back(
        reply_text=message.content,
        replier_user_id=message.author.id,
        replier_name=message.author.name,
        tracked=tracked,
        post_destination=_MessageReplyShim(message),
    )


# ── Trade Polling ──────────────────────────────────────────────────────────

@tasks.loop(seconds=POLL_INTERVAL_SECONDS)
async def poll_for_trades():
    """Check MFL API for new trades every 5 minutes.

    Posts to ROAST_CHANNEL_ID (prod when ROAST_BOT_ENV=prod and
    DISCORD_TRADE_CHANNEL_ID is set, else test channel).
    """
    try:
        await _heartbeat("ok")
        channel = bot.get_channel(ROAST_CHANNEL_ID)
        if not channel:
            print(f"[{datetime.now()}] Channel {ROAST_CHANNEL_ID} (env={ROAST_BOT_ENV}) not found")
            return

        trades = await _in_executor("fetch_trades", 60, fetch_trades)
        last_ts = get_last_trade_ts()

        # Only trades newer than the marker, oldest-first so the marker advances
        # monotonically. Cursor advances only after a successful post — but a
        # trade that keeps failing gets MAX_TRADE_ATTEMPTS tries across polls,
        # then the cursor advances anyway + the commish gets a DM. So a transient
        # MFL hiccup no longer silently drops a roast, and a poisoned trade
        # can't wedge the loop forever.
        new_trades = sorted(
            (t for t in trades if int(t.get("timestamp", 0)) > last_ts),
            key=lambda t: int(t.get("timestamp", 0)),
        )
        for trade in new_trades:
            ts = int(trade.get("timestamp", 0))
            print(f"[{datetime.now()}] New trade detected! ts={ts}")
            await _heartbeat("processing")   # long analyze ahead — keep the watchdog fed
            try:
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
                _trade_attempts.pop(ts, None)
                save_last_trade_ts(ts)
            except Exception as e:
                n = _trade_attempts.get(ts, 0) + 1
                _trade_attempts[ts] = n
                print(f"[{datetime.now()}] Trade ts={ts} attempt {n}/{MAX_TRADE_ATTEMPTS} failed: {e}")
                if n >= MAX_TRADE_ATTEMPTS:
                    save_last_trade_ts(ts)
                    _trade_attempts.pop(ts, None)
                    await _dm_commish(
                        f"⚠️ Trade Roast bot: giving up on trade ts={ts} after "
                        f"{MAX_TRADE_ATTEMPTS} attempts (last error: {e}). "
                        f"Cursor advanced — no roast was posted for this trade.")
                break  # retry (or skip) next poll; keep trades in order

    except Exception as e:
        msg = str(e)
        print(f"[{datetime.now()}] Poll error: {msg}")
        if "429" in msg:
            # MFL rate-limited us — back off a full minute before the next tick.
            await asyncio.sleep(60)
    finally:
        # Anti-replay: reschedule the next tick relative to NOW. Without this,
        # discord.ext.tasks "catches up" on every interval missed during a long
        # iteration — after the 2026-07-11 25h hang it replayed ~3,000 ticks
        # back-to-back and got the bot 429-limited by MFL for ~15 minutes.
        try:
            poll_for_trades.change_interval(seconds=POLL_INTERVAL_SECONDS)
        except Exception:
            pass


# ── Bot Events ─────────────────────────────────────────────────────────────

@bot.event
async def on_ready():
    print(f"[{datetime.now()}] Bot connected as {bot.user}")
    print(f"[{datetime.now()}] Guilds: {[g.name for g in bot.guilds]}")
    print(f"[{datetime.now()}] Env: ROAST_BOT_ENV={ROAST_BOT_ENV}, "
          f"ROAST_CHANNEL_ID={ROAST_CHANNEL_ID} "
          f"(test={TEST_CHANNEL_ID}, prod={PROD_CHANNEL_ID or 'unset'})")

    # Restore tracker + re-register persistent Reply buttons so they survive restart.
    _load_tracker()
    registered = 0
    for k, v in list(ROAST_TRACKER.items()):
        roast_msg_id = v.get("roast_msg_id")
        if roast_msg_id:
            try:
                bot.add_view(ReplyView(int(roast_msg_id)))
                registered += 1
            except Exception as e:
                print(f"[{datetime.now()}] failed to re-register view for {roast_msg_id}: {e}")
    print(f"[{datetime.now()}] Re-registered {registered} persistent Reply view(s)")

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
    parser.add_argument("--prod", action="store_true",
                        help="Assert prod mode: requires ROAST_BOT_ENV=prod + "
                             "DISCORD_TRADE_CHANNEL_ID set (the launchd launcher "
                             "passes this so a misconfigured env fails loudly at "
                             "startup instead of silently posting to test)")
    args = parser.parse_args()

    if args.prod:
        if args.test or args.test_ts:
            raise SystemExit("--prod and --test are mutually exclusive")
        if ROAST_BOT_ENV != "prod" or not PROD_CHANNEL_ID:
            raise SystemExit(
                f"--prod asserted but env resolves to '{ROAST_BOT_ENV}' "
                f"(prod channel={'set' if PROD_CHANNEL_ID else 'MISSING'}). "
                "Set ROAST_BOT_ENV=prod and DISCORD_TRADE_CHANNEL_ID.")
        print(f"[{datetime.now()}] --prod asserted: posting to channel {PROD_CHANNEL_ID}")

    if args.test or args.test_ts:
        ts = args.test_ts or HURTS_TRADE_TS
        ext_years = args.ext_years or (2 if ts == HURTS_TRADE_TS else 0)
        ext_player = args.ext_player or ("14783" if ts == HURTS_TRADE_TS else "")

        # Override on_ready for test mode: load tracker + register views like
        # normal startup, THEN run the test post, then stay running for replies.
        @bot.event
        async def on_ready():
            print(f"[{datetime.now()}] Bot connected as {bot.user}")
            print(f"[{datetime.now()}] Guilds: {[g.name for g in bot.guilds]}")
            _load_tracker()
            for k, v in list(ROAST_TRACKER.items()):
                roast_msg_id = v.get("roast_msg_id")
                if roast_msg_id:
                    try:
                        bot.add_view(ReplyView(int(roast_msg_id)))
                    except Exception:
                        pass
            print(f"[{datetime.now()}] Bot ready. Running test for ts={ts}...")
            await run_test(ts, ext_years, ext_player)

    bot.run(BOT_TOKEN)


if __name__ == "__main__":
    main()
