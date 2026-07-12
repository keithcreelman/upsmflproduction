"""
roast_bot_watchdog.py — health checker for trade_roast_bot.py.

Runs on a launchd timer (every 5 min). Checks if trade_roast_bot.py is
running. If not, DMs the commissioner via Discord and triggers
launchctl to wake it back up.

State file at /tmp/roast_bot_watchdog_state.json tracks last_status so
we don't DM every 5 minutes during an extended outage — only on
status transitions.

Required env vars:
    DISCORD_BOT_TOKEN          — same bot token the roast bot uses
    COMMISH_DISCORD_USER_ID    — Discord user ID to DM
                                 (find by Right-click your name →
                                  Copy User ID — needs Developer Mode
                                  on in Discord settings)
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

# ── Config ──
STATE_FILE = Path("/tmp/roast_bot_watchdog_state.json")
BOT_PROCESS_PATTERN = "trade_roast_bot.py"
LAUNCH_AGENT_LABEL = "com.keith.mfl.roast-bot"
DISCORD_API = "https://discord.com/api/v10"
USER_AGENT = "ups-roast-bot-watchdog/1.0"
# Heartbeat file the bot writes every poll tick (~5 min). Age > STALE_AFTER with
# a LIVE process = the bot is HUNG — the failure mode pgrep can't see. The
# 2026-07-11 incident was a live process frozen 25h on a blocking read; a
# process-only watchdog would have said "up" the whole time. 20 min tolerates
# the slowest legitimate roast (analyze+context+Opus timeouts ≈ 10 min total).
HEARTBEAT_FILE = Path.home() / "Library" / "Application Support" / "ups-roast-bot" / "heartbeat.json"
STALE_AFTER_SECONDS = 20 * 60
KICK_COOLDOWN_SECONDS = 20 * 60  # at most one hang-kick per cooldown window


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def heartbeat_age_seconds():
    """Age of the bot's last heartbeat, or None if no heartbeat file exists
    (pre-heartbeat build / first boot — treated as unknown, never as hung)."""
    try:
        data = json.loads(HEARTBEAT_FILE.read_text())
        return max(0.0, time.time() - float(data.get("ts", 0)))
    except Exception:
        return None


def read_state():
    if not STATE_FILE.exists():
        return {"status": "unknown", "last_dm_at": None, "last_checked_at": None}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"status": "unknown", "last_dm_at": None, "last_checked_at": None}


def write_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def bot_is_running():
    """True if a process matching the bot script is alive."""
    try:
        result = subprocess.run(
            ["pgrep", "-f", BOT_PROCESS_PATTERN],
            capture_output=True, text=True, timeout=5,
        )
        return result.returncode == 0 and bool(result.stdout.strip())
    except Exception:
        return False


def get_bot_token():
    """Read bot token from env, falling back to macOS Keychain."""
    env_token = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if env_token:
        return env_token
    try:
        result = subprocess.run(
            ["security", "find-generic-password",
             "-a", os.environ.get("USER", ""),
             "-s", "discord_bot_token", "-w"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception:
        pass
    return ""


def _dm_one_user(token, user_id, message, headers):
    """Open DM channel + post message for a single user. Returns True on success."""
    try:
        req = urlrequest.Request(
            f"{DISCORD_API}/users/@me/channels",
            data=json.dumps({"recipient_id": user_id}).encode(),
            headers=headers,
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=10) as resp:
            channel = json.loads(resp.read())
            channel_id = channel.get("id")
    except HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(f"[{now_iso()}] WARN: open DM channel failed for {user_id}: HTTP {e.code} — {body}")
        return False
    except URLError as e:
        print(f"[{now_iso()}] WARN: open DM channel network error for {user_id}: {e}")
        return False

    if not channel_id:
        return False

    try:
        req = urlrequest.Request(
            f"{DISCORD_API}/channels/{channel_id}/messages",
            data=json.dumps({"content": message}).encode(),
            headers=headers,
            method="POST",
        )
        with urlrequest.urlopen(req, timeout=10) as resp:
            return resp.status in (200, 201)
    except (HTTPError, URLError) as e:
        print(f"[{now_iso()}] WARN: post DM failed for {user_id}: {e}")
        return False


def discord_dm(message):
    """DM every user listed in COMMISH_DISCORD_USER_ID (comma-separated).
    Returns True if AT LEAST ONE recipient succeeded."""
    token = get_bot_token()
    raw_ids = os.environ.get("COMMISH_DISCORD_USER_ID", "").strip()
    if not token or not raw_ids:
        print(f"[{now_iso()}] WARN: missing bot token (Keychain/env) or COMMISH_DISCORD_USER_ID; cannot DM")
        return False

    user_ids = [uid.strip() for uid in raw_ids.split(",") if uid.strip()]
    if not user_ids:
        return False

    headers = {
        "Authorization": f"Bot {token}",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
    }

    any_ok = False
    for uid in user_ids:
        if _dm_one_user(token, uid, message, headers):
            any_ok = True
    return any_ok


def try_restart_via_launchd():
    """Tell launchd to kickstart the roast bot agent."""
    try:
        subprocess.run(
            ["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCH_AGENT_LABEL}"],
            capture_output=True, text=True, timeout=10,
        )
        return True
    except Exception as e:
        print(f"[{now_iso()}] WARN: launchctl kickstart failed: {e}")
        return False


def main():
    state = read_state()
    running = bot_is_running()
    prior_status = state.get("status", "unknown")
    hb_age = heartbeat_age_seconds()
    hung = bool(running and hb_age is not None and hb_age > STALE_AFTER_SECONDS)
    new_status = "hung" if hung else ("up" if running else "down")

    state["status"] = new_status
    state["last_checked_at"] = now_iso()

    # HUNG: process alive but heartbeat stale → kick (rate-limited) + DM on
    # transition. This is the 2026-07-11 failure mode a pgrep check can't see.
    if hung:
        last_kick = float(state.get("last_kick_ts") or 0)
        if time.time() - last_kick >= KICK_COOLDOWN_SECONDS:
            print(f"[{now_iso()}] bot HUNG — heartbeat {hb_age/60:.1f} min old, process alive. Kicking.")
            try_restart_via_launchd()
            state["last_kick_ts"] = time.time()
        else:
            print(f"[{now_iso()}] bot still hung (heartbeat {hb_age/60:.1f} min) — kick within cooldown, waiting")
        if prior_status != "hung":
            msg = (
                ":hourglass: **UPS Roast Bot is HUNG** — process alive but no "
                f"heartbeat for {hb_age/60:.0f} min. Auto-kicking it via launchd. "
                "Check `/tmp/roast_bot.log` if it doesn't report back online."
            )
            if discord_dm(msg):
                state["last_dm_at"] = now_iso()
        write_state(state)
        return

    # DM on first detection of outage. ALSO retry if we're still down but
    # never successfully sent a DM (e.g. earlier tick failed because of
    # missing env var); otherwise the user would never get notified.
    needs_down_dm = new_status == "down" and (
        prior_status != "down" or not state.get("last_dm_at")
    )
    if needs_down_dm:
        msg = (
            ":rotating_light: **UPS Roast Bot is OFFLINE**\n"
            f"Detected at {now_iso()}. Attempting auto-restart via launchd. "
            "If you see another message in ~5 min saying it's back online, "
            "we're good. If not, check `/tmp/roast_bot.log`."
        )
        if discord_dm(msg):
            state["last_dm_at"] = now_iso()
        try_restart_via_launchd()
    elif new_status == "up" and prior_status in ("down", "hung"):
        # Transition to up — let the user know it recovered
        msg = (
            ":white_check_mark: **UPS Roast Bot is back online.**\n"
            f"Recovered at {now_iso()}."
        )
        if discord_dm(msg):
            state["last_dm_at"] = now_iso()

    write_state(state)
    print(f"[{now_iso()}] watchdog: status={new_status} prior={prior_status}")


if __name__ == "__main__":
    sys.exit(main())
