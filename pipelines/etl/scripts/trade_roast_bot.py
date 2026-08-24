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
import fcntl
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
    # 3-way support: nav / production value for the net-value read, contract
    # parsing for the salary schedule, and the MFL "Last, First" formatter.
    estimate_production_value, nav_player, _parse_contract, display_name,
)
from trade_roast_context import (
    build_trade_roast_context, context_to_prompt_text,
    load_career_stats, load_discord_users,
    # 3-way support: per-franchise owner context + dossier + anti-repetition.
    build_franchise_context, load_trade_value_model_full,
    format_owner_dossier, format_recent_bot_posts_section,
    find_defending_champion,
)
from trade_announcement import (
    build_announcement_embed,
    # 3-way support: reuse the exact same asset renderers as the 2-party embed.
    _format_player, _format_pick_with_sender, _fmt_dollars,
)
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


def _startup_commit() -> str:
    """Git commit of the code this process booted from. Fail-soft 'unknown'.

    Computed ONCE at import (never on the event loop). The watchdog compares
    it against the repo's current HEAD to detect a bot still running stale
    code after a pull, and kickstarts it.
    """
    try:
        r = subprocess.run(
            ["git", "-C", str(SCRIPT_DIR), "rev-parse", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip()
    except Exception:
        pass
    return "unknown"


BOT_CODE_COMMIT = _startup_commit()


def _write_local_heartbeat(status: str):
    try:
        SUPPORT_DIR.mkdir(parents=True, exist_ok=True)
        tmp = HEARTBEAT_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"ts": int(time.time()), "status": status,
                                   "pid": os.getpid(), "env": ROAST_BOT_ENV,
                                   "commit": BOT_CODE_COMMIT}))
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
                     "Authorization": f"Bearer {ROAST_TRACK_API_KEY}",
                     # Cloudflare 403s the bare python-urllib UA
                     "User-Agent": "ups-roast-bot-launchd"})
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


# ── Single-instance lock ───────────────────────────────────────────────────
#
# WHY: the poll loop's only dedupe is last_trade_timestamp.txt — read at the
# top of a poll, written after each successful post. That is crash-safe for ONE
# process and completely defenceless against two. Two copies both read the same
# cursor, both compute the same new_trades, both post, both save. The league
# gets the same roast twice (or six times).
#
# It has happened at least twice:
#   2026-05-25  63 tracked rows across 7 trades
#   2026-07-12  SIX distinct Discord messages for one trade inside two seconds,
#               same thread, context_text arriving in two different lengths --
#               i.e. two processes with two different context builds
# Both windows coincide with launchd agent maintenance (the plists were edited
# twice on 2026-07-12, and the duplicate burst lands between the two edits).
#
# The watchdog is NOT the culprit: it restarts via `launchctl kickstart -k`,
# which kills the old process first. The hole is that nothing stops a SECOND
# copy started outside launchd -- a manual `python trade_roast_bot.py --prod`,
# or a `launchctl load` of an edited plist while the old job is still alive.
#
# flock, not a PID file: the lock is held by the kernel on an open descriptor
# and is released automatically when the process dies, however it dies. That
# matters because the watchdog SIGKILLs a hung bot -- a PID file would be left
# stale by exactly the failure mode this system is built around.
#
# The path is absolute and checkout-independent on purpose: the repo has git
# worktrees, and a lock under the repo would let a bot started from a worktree
# run alongside one started from the main checkout.
#
# Scoped per environment so a `--test` run (which posts to the test channel) can
# still be started while prod is live. Two PRODS are the failure mode; prod and
# test coexisting is a normal workflow.
#
# KNOWN, NOT FIXED HERE: test and prod share last_trade_timestamp.txt, so a test
# run can advance the prod cursor and make prod SKIP a trade. Separate bug from
# duplicate-posting, and separate fix -- flagged rather than silently widened.
SINGLETON_LOCK_PATH = f"/tmp/ups_roast_bot.{ROAST_BOT_ENV or 'unknown'}.lock"
_singleton_lock_fd = None


def acquire_singleton_lock(label: str = "roast-bot"):
    """Take the exclusive run lock, or return False if another copy holds it.

    The descriptor is deliberately kept in a module global for the lifetime of
    the process. Letting it get garbage-collected would close it and silently
    release the lock.
    """
    global _singleton_lock_fd
    try:
        fd = os.open(SINGLETON_LOCK_PATH, os.O_CREAT | os.O_RDWR, 0o644)
    except Exception as e:
        # Never let a lock problem stop the bot from running -- a bot that does
        # not post is a worse failure than one that might double-post.
        print(f"[{datetime.now()}] WARN: could not open {SINGLETON_LOCK_PATH} ({e}); "
              f"continuing WITHOUT a single-instance guard")
        return True
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        try:
            holder = os.read(fd, 64).decode("utf-8", "replace").strip()
        except Exception:
            holder = "unknown"
        os.close(fd)
        print(f"[{datetime.now()}] ABORT: another {label} instance is already running "
              f"(lock {SINGLETON_LOCK_PATH} held by pid {holder or 'unknown'}). "
              f"Exiting so the league does not get duplicate roasts.")
        return False

    _singleton_lock_fd = fd
    try:
        os.ftruncate(fd, 0)
        os.write(fd, f"{os.getpid()}\n".encode())
        os.fsync(fd)
    except Exception:
        pass
    return True


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
        # CONCEDE OUT LOUD. This used to be silent: the `clap_back_warranted`
        # gate sat ABOVE this branch and returned first, so a DATA_ERROR — the
        # one category where the owner is probably RIGHT — produced no reply at
        # all. From the owner's side a correct concession was indistinguishable
        # from the bot crashing ("think the bot gave up on my trade roast",
        # shawnblake on Jonah Coleman, 2026-08-23).
        #
        # The gate belongs to the COPE branch only. A clap-back is an
        # ARGUMENT; these two are acknowledgements, and declining to argue is
        # not a reason to say nothing.
        await post_destination.send(
            "Fair — that one's on us. Logged for a look at the source data.",
            allowed_mentions=discord.AllowedMentions.none())
        return

    # COPE → full clap-back, and the ONLY branch the clap-back gate governs.
    # The classifier decides whether an argument is worth having; it does not
    # decide whether an owner deserves an answer.
    if not classification.get("clap_back_warranted", False):
        print(f"[{datetime.now()}]   → clap-back NOT warranted ({category}); staying quiet")
        return

    # Use OWNER-tenure stats not franchise stats.
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


# ── 3-Way (commish-processed multi-leg) trades ──────────────────────────────
#
# MFL only records TWO-party trades. When the commish processes a 3-team deal
# it lands as THREE separate pairwise legs, each carrying a comment of the form
#   "[Commish-processed: 3-way] 3-way <uuid> pair-N (pairwise)".
# Two of those legs are ONE-SIDED (a team gives an asset "for nothing" because
# its return arrives on a DIFFERENT leg). Roasting the legs standalone reads as
# an absurd "gave away a star for free" — the 2026-07-22 incident. So we DETECT
# the legs by their shared uuid, COLLAPSE them into per-franchise NET gives/gets,
# and roast the whole deal ONCE. Normal 2-party trades are untouched.

THREEWAY_MARKER = "[Commish-processed: 3-way]"
_UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

# Cross-poll completeness gate. A commish 3-way is committed atomically (its
# legs share a timestamp-second), so by the time a 5-min poll fires all legs are
# already present AND several seconds/minutes old — the normal path fires
# immediately. The gate below is belt-and-suspenders for a hypothetical
# eventually-consistent split across polls: on the FIRST sighting of a uuid whose
# newest leg is still "fresh", defer ONE poll to collect stragglers; after that
# we roast regardless (keyed on the uuid, never on the shared second) so we can
# never hang forever waiting on a leg count we don't know in advance.
MULTIWAY_SETTLE_SECS = 120
_multiway_first_seen: dict = {}


def _multiway_uuid(comments: str):
    """Return the 3-way group uuid for a leg, or None for a normal trade."""
    if not comments or THREEWAY_MARKER not in comments:
        return None
    m = _UUID_RE.search(comments)
    return m.group(0).lower() if m else None


def group_multiway_legs(trades: list) -> dict:
    """{uuid: [legs]} for every commish-processed multi-way trade in `trades`."""
    groups: dict = {}
    for t in trades:
        u = _multiway_uuid(t.get("comments", ""))
        if u:
            groups.setdefault(u, []).append(t)
    return groups


def _pick_key(pk) -> tuple:
    return (pk.year, pk.round, (getattr(pk, "original_owner", "") or ""))


def build_multiway_summary(legs: list) -> dict:
    """Collapse the pairwise legs of one commish multi-way into per-franchise
    NET movements. Returns the dict the announce-embed + roast-context builders
    consume.

    Every leg is analysed with the SAME analyze_trade the normal path uses, so
    each PlayerInfo is fully enriched (salary, contract, PPG, ADP, Exp$). We then
    route each side's `*_given` to gave[sender] / got[receiver]; because we only
    ever read the *given* lists, no asset is double-counted. A defensive net pass
    cancels any pure pass-through (a franchise that receives X on one leg and
    gives the same X on another) so a conduit franchise shows a clean ledger.
    """
    players_map = load_players_map()
    franchises = load_franchises()
    rosters = load_rosters()
    rollover = load_rollover()
    auction_pool = load_auction_pool()
    team_caps = load_team_caps()
    future_picks = load_future_picks()
    tv_model = load_trade_value_model()

    analyses = [
        analyze_trade(leg, players_map, franchises, rosters, rollover,
                      auction_pool, team_caps, future_picks, tv_model)
        for leg in legs
    ]

    from collections import OrderedDict
    order: list = []
    fr: "OrderedDict[str, dict]" = OrderedDict()

    def _slot(fid, name, cap_space, total_salary):
        if fid not in fr:
            order.append(fid)
            fr[fid] = {
                "franchise_id": fid,
                "name": name,
                "cap_space": cap_space,
                "total_salary": total_salary,
                "gave": {"players": [], "picks": [], "bb": 0},
                "got": {"players": [], "picks": [], "bb": 0},
            }
        return fr[fid]

    ledger = []  # (asset_label, from_name, to_name) — one line per moved asset
    for an in analyses:
        for sender, receiver in ((an.side_a, an.side_b), (an.side_b, an.side_a)):
            s = _slot(sender.franchise_id, sender.franchise_name,
                      sender.cap_space, sender.total_roster_salary)
            r = _slot(receiver.franchise_id, receiver.franchise_name,
                      receiver.cap_space, receiver.total_roster_salary)
            for p in sender.players_given:
                s["gave"]["players"].append(p)
                r["got"]["players"].append(p)
                ledger.append((f"{display_name(p.name)} ({p.position})",
                               sender.franchise_name, receiver.franchise_name))
            for pk in sender.picks_given:
                s["gave"]["picks"].append(pk)
                r["got"]["picks"].append(pk)
                ledger.append((f"{pk.year} R{pk.round} pick",
                               sender.franchise_name, receiver.franchise_name))
            if sender.salary_given:
                s["gave"]["bb"] += sender.salary_given
                r["got"]["bb"] += sender.salary_given
                ledger.append((f"${sender.salary_given:,} budget bucks",
                               sender.franchise_name, receiver.franchise_name))

    def _net(gave, got, keyfn):
        """Cancel items present in BOTH a franchise's gave and got (pass-through)."""
        got_ct: dict = {}
        for x in got:
            got_ct[keyfn(x)] = got_ct.get(keyfn(x), 0) + 1
        net_gave = []
        for x in gave:
            k = keyfn(x)
            if got_ct.get(k, 0) > 0:
                got_ct[k] -= 1
            else:
                net_gave.append(x)
        gave_ct: dict = {}
        for x in gave:
            gave_ct[keyfn(x)] = gave_ct.get(keyfn(x), 0) + 1
        net_got = []
        for x in got:
            k = keyfn(x)
            if gave_ct.get(k, 0) > 0:
                gave_ct[k] -= 1
            else:
                net_got.append(x)
        return net_gave, net_got

    for fid, d in fr.items():
        d["gave"]["players"], d["got"]["players"] = _net(
            d["gave"]["players"], d["got"]["players"], lambda p: p.player_id)
        d["gave"]["picks"], d["got"]["picks"] = _net(
            d["gave"]["picks"], d["got"]["picks"], _pick_key)
        net_bb = d["gave"]["bb"] - d["got"]["bb"]
        d["gave"]["bb"] = max(0, net_bb)
        d["got"]["bb"] = max(0, -net_bb)

        def _sv(side):
            return (sum(nav_player(p) for p in side["players"])
                    + sum(pk.estimated_value for pk in side["picks"])
                    + side["bb"])
        d["net_value"] = _sv(d["got"]) - _sv(d["gave"])

    return {
        "franchises": fr,
        # Deterministic display order (by franchise id) so the embed/roast read
        # the same regardless of the arbitrary order MFL returns the legs in.
        "order": sorted(order),
        "franchises_map": franchises,
        "ledger": ledger,
        "timestamp": max(int(l.get("timestamp", 0)) for l in legs),
        "comment": next((l.get("comments", "") for l in legs), ""),
    }


def build_multiway_embed(summary: dict, trade_dt_iso: str = "") -> dict:
    """Announcement embed for a 3-team deal: one field per franchise showing both
    what it GIVES and what it GETS (net). Reuses the 2-party asset renderers so
    the formatting matches the normal announcement exactly."""
    from trade_announcement import _format_eastern  # local import (mirrors 2-party)
    fr = summary["franchises"]
    order = summary["order"]
    franchises = summary["franchises_map"]
    names = [fr[fid]["name"] for fid in order]

    date_str = _format_eastern(trade_dt_iso) if trade_dt_iso else ""
    desc = ["# 🤝 3-Team Trade Alert", "", " ↔ ".join(f"**{n}**" for n in names)]
    if date_str:
        desc.append(f"_{date_str}_")

    fields = []
    for fid in order:
        d = fr[fid]
        lines = ["**Gives up:**"]
        gave = d["gave"]
        any_g = False
        for p in gave["players"]:
            lines.append(_format_player(p)); any_g = True
        for pk in gave["picks"]:
            lines.append(f"  • {_format_pick_with_sender(pk, fid, franchises)}"); any_g = True
        if gave["bb"]:
            lines.append(f"  • {_fmt_dollars(gave['bb'])} Budget Bucks"); any_g = True
        if not any_g:
            lines.append("  • (nothing)")
        lines.append("**Receives:**")
        got = d["got"]
        any_r = False
        for p in got["players"]:
            lines.append(_format_player(p)); any_r = True
        for pk in got["picks"]:
            lines.append(f"  • {_format_pick_with_sender(pk, fid, franchises)}"); any_r = True
        if got["bb"]:
            lines.append(f"  • {_fmt_dollars(got['bb'])} Budget Bucks"); any_r = True
        if not any_r:
            lines.append("  • (nothing)")
        value = "\n".join(lines)
        if len(value) > 1000:  # Discord field-value hard cap is 1024
            value = value[:997] + "..."
        fields.append({"name": d["name"][:256], "value": value, "inline": False})

    return {
        "title": "TRADE",
        "description": "\n".join(desc),
        "color": 0xc8a24d,  # gold — same as the 2-party announcement
        "fields": fields,
    }


def build_multiway_context_text(summary: dict) -> str:
    """Roast prompt/context for a 3-team deal. Mirrors context_to_prompt_text but
    over N franchises: a strong 'roast as ONE deal' framing, an asset-direction
    ledger, per-team net gives/gets, owner records, dossiers, and the recent-bot
    ban list. Same builder feeds BOTH the Opus prompt AND the clap-back context."""
    career_stats = load_career_stats()
    tv_full = load_trade_value_model_full()
    discord_users = load_discord_users()
    fr = summary["franchises"]
    order = summary["order"]
    franchises = summary["franchises_map"]

    fctx = {
        fid: build_franchise_context(fid, career_stats, tv_full, discord_users,
                                     live_franchise_name=fr[fid]["name"])
        for fid in order
    }
    current_year = next((fctx[f].get("current_year") for f in order
                         if fctx[f].get("current_year")), 0)

    L: list = []
    def ln(s=""):
        L.append(s)

    ln("=== THREE-TEAM TRADE (commish-processed) — ROAST IT AS ONE DEAL ===")
    if current_year:
        ln(f"CURRENT YEAR: {current_year} (offseason — {current_year} season has not started)")
        ln(f"LAST COMPLETED SEASON: {current_year - 1}")
    ln("")
    ln("MFL can only store two-party trades, so the commish entered this ONE "
       "three-team trade as three pairwise legs. Below is the NET result per "
       "team. Roast it as a single coherent three-team deal — NOT three separate "
       "trades. Every team's FULL return is listed, so NEVER say any team 'gave "
       "X away for nothing' — nobody did.")
    ln("Produce a GRADE + roast paragraph for EACH of the THREE teams (three "
       "blocks in the FORMAT '[TEAM NAME] — GRADE: X'), then a VERDICT naming the "
       "biggest winner and the team that came out worst, then the [GIF: ...] "
       "line. There is NO canonical grader letter for a three-team trade — judge "
       "each team's net haul yourself and assign a fair grade A+ through F.")
    ln("")

    dc = find_defending_champion(career_stats)
    if dc and dc.get("franchise_id") in order:
        ln(f"NOTE: {dc['owner_name']} ({dc['team_name']}) IS the defending "
           f"champion — they won {dc['season']}.")
        ln("")

    ln("ASSET DIRECTION LEDGER (who ended up with what — read this, do not infer):")
    for label, frm, to in summary["ledger"]:
        ln(f"  {label}: {frm} → {to}")
    ln("")

    def render_player(p) -> str:
        yrs, rem = _parse_contract(p.contract_info, p.contract_year, p.salary)
        sal = f"${p.salary:,} salary"
        if len(rem) > 1 and len(set(rem)) > 1:
            sched = " → ".join(f"${s:,}" for s in rem)
            sal = (f"${p.salary:,} salary (schedule {sched}; "
                   f"${sum(rem):,} over {len(rem)} yrs)")
        # PPG is NEVER observed production here — it is a trade-value model, a
        # rollover estimate, or a forward projection. `ppg_basis` says which.
        # An EMPTY basis means the projection overlay set the number and nobody
        # recorded where it came from, which used to render as a bare "(proj)".
        # An owner read that as production for a player who has never taken a
        # snap and concluded the bot was making things up (2026-08-23). Say it
        # in words the model cannot quietly drop.
        _basis = (p.ppg_basis or "").strip()
        if not _basis:
            _basis = "PROJECTED — not games played"
        ppg = (f", {round(p.expected_ppg, 1)} PPG ({_basis})"
               if p.expected_ppg else "")
        adp = ""
        if getattr(p, "adp_overall", 0):
            adp = (f", ADP {p.position}{p.adp_pos_rank} / #{p.adp_overall} overall "
                   f"({p.adp_sources}-source consensus)")
        cs = f", {p.contract_status}" if getattr(p, "contract_status", "") else ""
        return f"    - {display_name(p.name)} ({p.position}) — {sal}{ppg}{adp}{cs}"

    def render_pick(pk) -> str:
        orig_raw = (getattr(pk, "original_owner", "") or "").strip()
        oname = franchises.get(orig_raw.zfill(4) if orig_raw else "", "unknown")
        return (f"    - {pk.year} Round {pk.round} pick (originally {oname}'s, "
                f"est. value ${pk.estimated_value:,.0f})")

    for fid in order:
        d = fr[fid]
        ln(f"{d['name']} — gives:")
        gave = d["gave"]
        any_g = False
        for p in gave["players"]:
            ln(render_player(p)); any_g = True
        for pk in gave["picks"]:
            ln(render_pick(pk)); any_g = True
        if gave["bb"]:
            ln(f"    - ${gave['bb']:,} in traded salary (budget bucks)"); any_g = True
        if not any_g:
            ln("    - (nothing)")
        ln(f"{d['name']} — receives:")
        got = d["got"]
        any_r = False
        for p in got["players"]:
            ln(render_player(p)); any_r = True
        for pk in got["picks"]:
            ln(render_pick(pk)); any_r = True
        if got["bb"]:
            ln(f"    - ${got['bb']:,} in traded salary (budget bucks)"); any_r = True
        if not any_r:
            ln("    - (nothing)")
        ln(f"    Post-trade cap space: ${d['cap_space']:,} (of $300K cap)")
        ln("")

    # NOTE: no canonical grader/value anchor is injected for a 3-team deal — a
    # naive 2-side NAV blunt-scores a team that LANDS an elite-but-pricey asset
    # as a "loser," which would fight the asset lists. Judge each team from the
    # per-player PPG/ADP/salary + picks above, per the self-consistency rule.
    ln('Trade comment: "commish-processed three-team trade"')

    for fid in order:
        f = fctx[fid]
        d = fr[fid]
        ln(f"\n=== TEAM: {d['name']} ===")
        ln(f"  Owner: {f['owner_name']} (since {f['owner_since']}, {f['owner_seasons']} season(s))")
        if f.get("owner_allplay_pct"):
            ln(f"  {f['owner_name']}'s allplay: {f['owner_allplay_pct']:.3f}")
        ln(f"  {f['owner_name']}'s championships: {f['owner_championships']}")
        ln(f"  {f['owner_name']}'s playoff appearances: {f['owner_playoff_appearances']} "
           f"in {f['owner_seasons']} season(s)")
        if f.get("owner_best_finish"):
            ln(f"  {f['owner_name']}'s best finish: #{f['owner_best_finish']}")
        if f.get("owner_worst_finish"):
            ln(f"  {f['owner_name']}'s worst finish: #{f['owner_worst_finish']}")
        if (f.get("franchise_championship_drought") and f["franchise_championship_drought"] <= 5
                and f.get("franchise_championships", 0) > 0):
            ln(f"  Franchise's last championship: {f['franchise_last_championship']} "
               f"({f['franchise_championship_drought']} years ago)")
        ln(f"  Post-trade cap space: ${d['cap_space']:,} (of $300K cap)")
        if f.get("trend"):
            ln("  Recent trend (franchise, not necessarily current owner):")
            for t in f["trend"]:
                ln(f"    {t['season']}: allplay {t['allplay_pct']:.3f}, finish #{t['finish']}")

    dossier = format_owner_dossier(order)
    if dossier:
        ln(dossier)
    recent = format_recent_bot_posts_section()
    if recent:
        ln(recent)

    return "\n".join(L)


async def analyze_and_post_multiway(channel: discord.TextChannel, legs: list,
                                    uuid: str) -> dict:
    """Post ONE combined roast for a commish-processed multi-way trade.

    Mirrors analyze_and_post's announce-embed → thread → roast → GIF → tracker →
    archive flow, but over the per-franchise NET movements collapsed from the
    legs. Never posts the one-sided legs individually.
    """
    print(f"[{datetime.now()}] Building combined 3-way roast for {uuid} "
          f"({len(legs)} legs)")

    # Heavy prep (per-leg analyze_trade → net summary → embed dict → context
    # text) is all sync + blocking (MFL API, file reads, worker calls), so it
    # runs off-loop with a hard timeout — the 2026-07-11 frozen-loop lesson.
    def _prep():
        summary_ = build_multiway_summary(legs)
        ts_int = summary_["timestamp"]
        trade_iso = (datetime.fromtimestamp(ts_int, tz=timezone.utc).isoformat()
                     if ts_int else "")
        embed_ = build_multiway_embed(summary_, trade_iso)
        ctx_text_ = build_multiway_context_text(summary_)
        return summary_, embed_, ctx_text_
    summary, announce_embed_dict, context_text = await _in_executor(
        "multiway prepare", 240, _prep)

    order = summary["order"]
    fr = summary["franchises"]
    names = [fr[fid]["name"] for fid in order]
    announce_embed = discord.Embed.from_dict(announce_embed_dict)

    print(f"[{datetime.now()}] Posting 3-way announcement to #{channel.name}")
    announce_msg = await channel.send(
        embed=announce_embed, allowed_mentions=discord.AllowedMentions.none())

    thread_name = ("3-Team Trade — " + " ↔ ".join(names))[:100]
    thread = await announce_msg.create_thread(name=thread_name,
                                              auto_archive_duration=1440)

    print(f"[{datetime.now()}] 3-way context built ({len(context_text)} chars). "
          f"Calling Claude Opus...")
    raw_roast = await _in_executor("generate_trade_roast", 300,
                                   generate_trade_roast, context_text)
    roast_clean, gif_query = _extract_gif_query(raw_roast)
    print(f"[{datetime.now()}] 3-way roast generated ({len(roast_clean)} chars). "
          f"GIF query: {gif_query!r}")

    roast_embed = discord.Embed(title="🔥 Roast", description=roast_clean[:4096],
                                color=0x5865F2)
    roast_msg = await thread.send(
        embed=roast_embed, allowed_mentions=discord.AllowedMentions.none())
    try:
        await roast_msg.edit(view=ReplyView(roast_msg.id))
    except Exception as e:
        print(f"[{datetime.now()}] failed to attach Reply view: {e}")

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
        gif_msg = await thread.send(
            embed=gif_embed, allowed_mentions=discord.AllowedMentions.none())

    # Track for reply monitoring (both announcement + roast route to clap-back).
    tracker_payload = {
        "context_text": context_text,
        "ctx": None,  # no 2-side ctx dict for a 3-way; clap-back uses context_text
        "thread_id": thread.id,
        "channel_id": channel.id,
        "announcement_msg_id": announce_msg.id,
        "roast_msg_id": roast_msg.id,
        "timestamp": time.time(),
    }
    ROAST_TRACKER[announce_msg.id] = tracker_payload
    ROAST_TRACKER[roast_msg.id] = tracker_payload
    _save_tracker()

    await _track_roast_async({
        "roast_message_id": str(roast_msg.id),
        "thread_id": str(thread.id),
        "channel_id": str(channel.id),
        "announcement_message_id": str(announce_msg.id),
        "context_text": context_text[:16384],
        "roast_text": roast_clean[:8000],
        "trade_id": uuid,
        "trade_franchises": ",".join(order),
        "posted_at": int(time.time()),
    })

    save_to_archive({
        "id": f"trade-3way-{uuid}",
        "type": "trade_roast_3way",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "teams": list(order),
        "discord_announcement_msg_id": announce_msg.id,
        "discord_thread_id": thread.id,
        "discord_roast_msg_id": roast_msg.id,
        "discord_gif_msg_id": gif_msg.id if gif_msg else None,
        "channel_id": channel.id,
        "env": ROAST_BOT_ENV,
        "content": {"roast": roast_clean, "gif_query": gif_query,
                    "gif_url": gif_url, "uuid": uuid},
        "replies": [],
    })

    print(f"[{datetime.now()}] Posted 3-way roast (env={ROAST_BOT_ENV}, "
          f"announcement={announce_msg.id}, thread={thread.id}, "
          f"roast={roast_msg.id}, gif={gif_msg.id if gif_msg else 'none'})")
    return {"announcement_msg_id": announce_msg.id, "thread_id": thread.id,
            "roast_msg_id": roast_msg.id, "roast_text": roast_clean,
            "gif_url": gif_url}


def dry_run_multiway(uuid: str):
    """Print the collapsed net per-franchise gives/gets for a 3-way uuid and
    exit. No Discord, no Claude — the pre-post verification the task asks for."""
    trades = fetch_trades()
    legs = group_multiway_legs(trades).get(uuid.lower())
    if not legs:
        print(f"No 3-way legs found for uuid {uuid}")
        return
    print(f"Found {len(legs)} legs for {uuid}")
    summary = build_multiway_summary(legs)
    fmap = summary["franchises_map"]
    print("\n=== ASSET DIRECTION LEDGER ===")
    for label, frm, to in summary["ledger"]:
        print(f"  {label}: {frm} -> {to}")
    print("\n=== NET PER-FRANCHISE ===")
    for fid in summary["order"]:
        d = summary["franchises"][fid]
        print(f"\n{d['name']} ({fid})  [net_value={d['net_value']:,.0f}, "
              f"cap_space=${d['cap_space']:,}]")
        print("  GIVES:")
        for p in d["gave"]["players"]:
            print(f"    - {display_name(p.name)} ({p.position}) ${p.salary:,}")
        for pk in d["gave"]["picks"]:
            orig = (pk.original_owner or "").zfill(4)
            print(f"    - {pk.year} R{pk.round} pick (orig {fmap.get(orig, '?')})")
        if d["gave"]["bb"]:
            print(f"    - ${d['gave']['bb']:,} budget bucks")
        print("  GETS:")
        for p in d["got"]["players"]:
            print(f"    - {display_name(p.name)} ({p.position}) ${p.salary:,}")
        for pk in d["got"]["picks"]:
            orig = (pk.original_owner or "").zfill(4)
            print(f"    - {pk.year} R{pk.round} pick (orig {fmap.get(orig, '?')})")
        if d["got"]["bb"]:
            print(f"    - ${d['got']['bb']:,} budget bucks")


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

    # Trigger 2: @mention INSIDE a tracked roast thread. Scoped to threads only
    # as of 2026-07-14. The old `or v.get("channel_id") == chan_id` disjunct
    # matched EVERY tracked roast for ANY message in #transactions, then picked
    # the most recent trade by timestamp. Two things made that explode:
    #   1. the auction narrator posts as the SAME Discord bot user, so Discord
    #      adds us to `mentions` on any REPLY to a nomination (replied_user ping)
    #      even when the human only @-ed another owner;
    #   2. so a reply to an auction nomination clapped back with a days-old
    #      trade's context. That is exactly what happened to the commish.
    # A mention in the open channel is no longer evidence of intent.
    if bot.user and bot.user.id in mentions:
        chan_id = message.channel.id
        thread_tracks = [v for v in ROAST_TRACKER.values()
                         if v.get("thread_id") and v.get("thread_id") == chan_id]
        if thread_tracks:
            tracked = max(thread_tracks, key=lambda v: v.get("timestamp", 0) or 0)
            await handle_reply(message, tracked)
            return
        print(f"[{datetime.now()}]   → @mention outside any tracked roast thread ({chan_id}); ignoring")

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


async def _resolve_thread(thread_id: int):
    """Resolve a tracked roast thread: cache first, HTTP fetch fallback.

    fetch_channel is discord.py's async HTTP call (aiohttp) — safe on the
    event loop, NOT a blocking urllib call. Returns None on any failure
    (deleted thread, 403/404, network) so callers can fail soft.
    """
    try:
        ch = bot.get_channel(thread_id)
        if ch is None:
            ch = await bot.fetch_channel(thread_id)
        return ch
    except Exception as e:
        print(f"[{datetime.now()}] thread {thread_id} resolve failed: {e}")
        return None


async def handle_reply(message: discord.Message, tracked: dict):
    """Adapter from on_message → core _run_clap_back.

    Containment (Keith 2026-07-14): ALL clap-backs live inside the trade's
    thread. If the trigger message is already in the tracked thread, reply
    in place (unchanged). If it came from the MAIN channel, echo the user's
    message into the thread (same format the worker Reply-button path uses,
    so the thread stays self-contained), clap back THERE, and leave a short
    pointer reply in the channel so the user knows where the answer went.
    Sending to an archived thread auto-unarchives it. If the thread can't be
    resolved or written (deleted / 403 / 404), fail soft to the old
    in-channel reply so the response is never dropped.
    """
    thread_id = tracked.get("thread_id")
    try:
        tid = int(thread_id) if thread_id else 0
    except (TypeError, ValueError):
        tid = 0

    post_destination = None
    if tid and message.channel.id != tid:
        # Main-channel trigger → route to the roast thread.
        thread = await _resolve_thread(tid)
        if thread is not None:
            try:
                # Echo BEFORE running any LLM call — this send doubles as the
                # writability probe: if it 403/404s we fall back in-channel
                # without having burned a classify/clap-back call.
                echo = (f"**{message.author.display_name}** says:\n"
                        f"> {(message.content or '')[:1800]}")
                await thread.send(echo, allowed_mentions=discord.AllowedMentions.none())
                post_destination = thread
            except Exception as e:
                print(f"[{datetime.now()}] thread echo failed ({e}); "
                      f"falling back to in-channel reply")
        if post_destination is not None:
            # Pointer in the main channel (best-effort, before the slow
            # Opus call so the user gets immediate feedback).
            guild_id = message.guild.id if message.guild else "@me"
            jump = f"https://discord.com/channels/{guild_id}/{tid}"
            try:
                await message.reply(f"took it to the thread 👉 {jump}",
                                    allowed_mentions=discord.AllowedMentions.none())
            except Exception as e:
                print(f"[{datetime.now()}] pointer reply failed (non-fatal): {e}")

    if post_destination is None:
        # Only reply in place when we are ALREADY inside the tracked thread.
        # Never fall back to a flat in-channel reply: that is how clap-backs
        # ended up interrupting the auction conversation in #transactions.
        if tid and message.channel.id == tid:
            post_destination = _MessageReplyShim(message)
        else:
            print(f"[{datetime.now()}] no tracked thread (tid={tid}, chan={message.channel.id}); "
                  f"skipping clap-back rather than replying in-channel")
            return

    await _run_clap_back(
        reply_text=message.content,
        replier_user_id=message.author.id,
        replier_name=message.author.name,
        tracked=tracked,
        post_destination=post_destination,
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
        # 3-way groups are keyed off the FULL trades list (not just new_trades) so
        # a leg that landed below the cursor in a prior poll still gets assembled
        # into the complete combined roast. handled_uuids dedupes within a poll.
        multiway_groups = group_multiway_legs(trades)
        handled_uuids: set = set()

        for trade in new_trades:
            ts = int(trade.get("timestamp", 0))
            uuid = _multiway_uuid(trade.get("comments", ""))

            # ── Commish-processed 3-way leg → ONE combined roast ──────────────
            if uuid:
                if uuid in handled_uuids:
                    # A sibling leg already rolled into this poll's combined roast;
                    # just advance the cursor past this leg and move on.
                    save_last_trade_ts(ts)
                    continue
                legs = multiway_groups.get(uuid) or [trade]
                # Completeness gate (see MULTIWAY_SETTLE_SECS): defer at most one
                # poll for stragglers on first sighting, then roast regardless.
                now = time.time()
                first_seen = _multiway_first_seen.setdefault(uuid, now)
                newest_age = now - max(int(l.get("timestamp", 0)) for l in legs)
                if newest_age < MULTIWAY_SETTLE_SECS and (now - first_seen) < POLL_INTERVAL_SECONDS:
                    print(f"[{datetime.now()}] 3-way {uuid} still settling "
                          f"({len(legs)} legs, newest {newest_age:.0f}s old) — "
                          f"deferring to next poll (cursor held)")
                    break  # leave the cursor so we re-see these legs next poll
                print(f"[{datetime.now()}] 3-way trade detected! uuid={uuid} "
                      f"legs={len(legs)}")
                await _heartbeat("processing")
                try:
                    await analyze_and_post_multiway(channel, legs, uuid)
                    handled_uuids.add(uuid)
                    _multiway_first_seen.pop(uuid, None)
                    _trade_attempts.pop(uuid, None)
                    # Advance the cursor past EVERY leg of the group at once.
                    max_leg_ts = max(int(l.get("timestamp", 0)) for l in legs)
                    save_last_trade_ts(max(ts, max_leg_ts))
                except Exception as e:
                    n = _trade_attempts.get(uuid, 0) + 1
                    _trade_attempts[uuid] = n
                    print(f"[{datetime.now()}] 3-way {uuid} attempt "
                          f"{n}/{MAX_TRADE_ATTEMPTS} failed: {e}")
                    if n >= MAX_TRADE_ATTEMPTS:
                        max_leg_ts = max(int(l.get("timestamp", 0)) for l in legs)
                        save_last_trade_ts(max(ts, max_leg_ts))
                        _trade_attempts.pop(uuid, None)
                        _multiway_first_seen.pop(uuid, None)
                        await _dm_commish(
                            f"⚠️ Trade Roast bot: giving up on 3-way {uuid} after "
                            f"{MAX_TRADE_ATTEMPTS} attempts (last error: {e}). "
                            f"Cursor advanced — no combined roast was posted.")
                    break  # retry (or skip) next poll; keep trades in order
                continue

            # ── Normal 2-party trade (unchanged) ─────────────────────────────
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
    parser.add_argument("--dry-run-multiway", type=str, default="",
                        help="Print the collapsed net per-franchise gives/gets "
                             "for a 3-way uuid and exit (no Discord, no Claude)")
    parser.add_argument("--post-multiway", type=str, default="",
                        help="Post ONE combined roast for a 3-way uuid via the "
                             "real machinery (announce embed + roast thread + "
                             "tracker) to ROAST_CHANNEL_ID, then exit")
    args = parser.parse_args()

    # Pure-data verification path — no Discord connection, no Claude call.
    if args.dry_run_multiway:
        dry_run_multiway(args.dry_run_multiway)
        return

    # One-off combined roast for a single 3-way uuid, then exit. Reuses the
    # exact analyze_and_post_multiway machinery the poller uses. Does NOT start
    # poll_for_trades, so it won't interfere with the running launchd bot.
    if args.post_multiway:
        uuid = args.post_multiway.strip().lower()

        @bot.event
        async def on_ready():
            print(f"[{datetime.now()}] Bot connected as {bot.user} "
                  f"(post-multiway one-off)")
            print(f"[{datetime.now()}] Env: ROAST_BOT_ENV={ROAST_BOT_ENV}, "
                  f"ROAST_CHANNEL_ID={ROAST_CHANNEL_ID}")
            _load_tracker()
            for k, v in list(ROAST_TRACKER.items()):
                rid = v.get("roast_msg_id")
                if rid:
                    try:
                        bot.add_view(ReplyView(int(rid)))
                    except Exception:
                        pass
            try:
                channel = bot.get_channel(ROAST_CHANNEL_ID)
                if not channel:
                    print(f"ERROR: channel {ROAST_CHANNEL_ID} not found")
                    return
                trades = await _in_executor("fetch_trades", 60, fetch_trades)
                legs = group_multiway_legs(trades).get(uuid)
                if not legs:
                    print(f"ERROR: no 3-way legs found for uuid {uuid}")
                    return
                res = await analyze_and_post_multiway(channel, legs, uuid)
                print("POSTED_MULTIWAY_RESULT: " + json.dumps({
                    "announcement_msg_id": str(res["announcement_msg_id"]),
                    "roast_msg_id": str(res["roast_msg_id"]),
                    "thread_id": str(res["thread_id"]),
                    "gif_url": res.get("gif_url", ""),
                }))
                print("ROAST_TEXT_BEGIN")
                print(res["roast_text"])
                print("ROAST_TEXT_END")
            except Exception as e:
                import traceback
                traceback.print_exc()
                print(f"ERROR posting multiway: {e}")
            finally:
                await bot.close()

        bot.run(BOT_TOKEN)
        return

    # Single-instance guard -- POLLING PATH ONLY.
    #
    # The duplicate-roast bug (#800) is a property of the poll loop: its cursor
    # is read at the top of a poll and written after each post, so two pollers
    # both read it, both post, both save. Nothing else in this file has that
    # problem.
    #
    # So the lock deliberately does NOT cover the one-off modes. --post-multiway
    # was built to fire a single combined roast WHILE the launchd bot is live,
    # --dry-run-multiway touches neither Discord nor Claude, and --test replaces
    # on_ready so the poller never starts. Guarding those would break the exact
    # workflow they exist for.
    if not (args.test or args.test_ts or args.dry_run_multiway or args.post_multiway):
        if not acquire_singleton_lock():
            # Exit 0, not non-zero: the plist sets KeepAlive with
            # ThrottleInterval=10, so a failing exit would have launchd
            # relaunching every ten seconds for as long as the other copy ran.
            time.sleep(30)
            raise SystemExit(0)

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
