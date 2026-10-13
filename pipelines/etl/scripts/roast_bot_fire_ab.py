#!/usr/bin/env python3
"""
roast_bot_fire_ab.py — One-shot A/B fire for the Trade Roast Bot.

(Renamed from test_fire_ab.py 2026-10-12 so test discovery — test_*.py,
*_test.py — can never run it. tests: test_roast_bot_fire_ab_safety.py.)

NOTHING RUNS WITHOUT AN OPTION. With no option (or only --trade/--model)
it prints the usage and a preflight plan (Anthropic: NO, Discord read: NO,
Discord write: NO) and exits 0 — no network, no secrets, no Keychain.

Every mode prints a PREFLIGHT PLAN first: whether Anthropic will be called,
whether Discord will be read (and for what), whether Discord can be written,
and the exact destination. Nothing touches the network before it.

  --generate      PAID Anthropic generation, then a dry-run preview of the
                  destination + every message. Never writes to Discord. It
                  makes every READ a send makes:
                    - MFL export + Worker GETs (trade, league, rosters, context)
                    - Discord: the bot's recent posts in the trade channel (the
                      duplicate / anti-repetition check). Token: DISCORD_BOT_TOKEN
                      env → Keychain discord_bot_token. No token → the check is
                      SKIPPED and the run says so; it still completes.
                    - Giphy: the GIF search for the roast's [GIF: …] tag
                  It differs from --send ONLY at the write step.
  --send          implies --generate (same reads, same messages), then POSTS
                  to the Discord TEST channel. Needs BOTH (either missing →
                  print why, exit 2, before any MFL/Anthropic/Keychain/Discord
                  activity):
                    --confirm-send=<TEST_CHANNEL_ID>   exact id it will post to
                    UPS_ALLOW_ROAST_AB_DISCORD_SEND=1  in the environment
                  It also stops (exit 2) if no Discord bot token is found.
  --context-only  OFFLINE: prints only what local files hold — the trade from
                  the newest committed MFL snapshot (data/mfl-snapshots),
                  franchise names from that snapshot, the local owner dossier,
                  and the prompt framing. No network, no token, no Keychain, no
                  Anthropic, no Giphy. The full roast context (live MFL/Worker)
                  is NOT built, and the duplicate check runs only with
                  --generate / --send; the output says so.

Per fire (trade × model), a send posts:
  Message 1  trade announcement embed → channel TEST_CHANNEL_ID
  thread     a NEW thread created off Message 1
  Message 2  roast embed → that thread
  Message 3  Giphy GIF → that thread (only when the roast ends in [GIF: …])
Trades: 1778546756 (0006 ↔ 0007) and 1775772921 (Hurts fixture).
Models: opus (default), sonnet, both.

Bypasses the launchd bot entirely — uses Discord REST API (no gateway
connection → no identity conflict with the running bot). Reads owner /
team mapping from D1 (discord_owners table) via the worker, NOT the
missing hardcoded CSV. Reads contracts + rosters live from MFL.

WRITE GUARD (in _discord_request, the one function that does Discord HTTP,
checked before any network attempt): a non-GET request needs
UPS_ALLOW_ROAST_AB_DISCORD_SEND=1 AND this run's validated --confirm-send,
must be a POST create-message or create-thread-from-message route, and may
target only TEST_CHANNEL_ID or a thread THIS run created there. The
production trade channel, existing threads, other channels, other routes and
unparsable paths are refused with the reason.

Audit log (pipelines/etl/data/ab_test_fire.log, gitignored): one JSON line
per --generate/--send run with whitelisted fields only — mode, trade, model,
ok/error type, message/thread ids, char counts, flags, token usage. Never a
token/key, roast or context text, GIF query, or fetched Discord text.

Env / Keychain (each env first, then `security find-generic-password -a $USER -s <service> -w`):
  ANTHROPIC_API_KEY  — --generate/--send          (service anthropic_api_key)
  DISCORD_BOT_TOKEN  — --generate/--send, read; --send, write
                                                   (service discord_bot_token)
  GIPHY_API_KEY      — --generate/--send, optional (service giphy_api_key;
                       falls back to the Worker /api/giphy-search proxy)

Usage:
  python roast_bot_fire_ab.py                        # usage + plan only; nothing runs
  python roast_bot_fire_ab.py --generate             # PAID: both trades, opus; preview only
  python roast_bot_fire_ab.py --generate --trade 1778546756 --model both
  python roast_bot_fire_ab.py --context-only         # offline: local context only
  UPS_ALLOW_ROAST_AB_DISCORD_SEND=1 python roast_bot_fire_ab.py \\
      --send --confirm-send=1089538054236160010      # generates, then POSTS to the test channel
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import anthropic

# Ensure local imports resolve when run from anywhere
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from trade_grader import (
    fetch_trades, analyze_trade, load_franchises, load_players_map,
    load_rosters, load_rollover, load_auction_pool, load_team_caps,
    load_future_picks, load_trade_value_model,
)
import trade_roast_context
from trade_roast_context import (
    build_trade_roast_context,
    context_to_prompt_text,
)
from trade_announcement import build_announcement_embed
from content_engine import ROAST_SYSTEM


# ── Config ─────────────────────────────────────────────────────────────────

TEST_CHANNEL_ID = "1089538054236160010"

# Discord channels are public per-server; channel ID above is the UPS test channel
# (DISCORD_CONTRACT_TEST_CHANNEL_ID).

TRADE_1_TS = 1778546756   # The trade the launchd bot is queued on (0006 ↔ 0007)
TRADE_2_TS = 1775772921   # Hurts test fixture (existing --test default)

MODELS = {
    "opus":   "claude-opus-4-6",
    "sonnet": "claude-sonnet-4-6",
}

DISCORD_API_BASE = "https://discord.com/api/v10"

# Discord writes need this env var AND --send --confirm-send=<TEST_CHANNEL_ID>.
SEND_ENV = "UPS_ALLOW_ROAST_AB_DISCORD_SEND"

# The only HTTP method _discord_request() lets through without SEND_ENV=1.
READ_METHODS = frozenset({"GET"})

PLAN_START = "=== PREFLIGHT PLAN ==="
PLAN_END = "=== END PLAN ==="


def send_refusal(args, env) -> str:
    """Why this run may NOT write to Discord, or "" when every gate is met.
    Only meaningful with --send; without it nothing is ever written."""
    if not args.send:
        if args.confirm_send:
            return "REFUSING: --confirm-send given without --send; nothing run, nothing sent."
        return ""
    missing = []
    if args.confirm_send is None:
        missing.append(f"--confirm-send={TEST_CHANNEL_ID} (the exact channel id it will post to)")
    elif args.confirm_send.strip() != TEST_CHANNEL_ID:
        missing.append(f"--confirm-send={args.confirm_send!r} does not match the destination "
                       f"channel {TEST_CHANNEL_ID}")
    if env.get(SEND_ENV, "").strip() != "1":
        missing.append(f"{SEND_ENV}=1 in the environment")
    if missing:
        return "REFUSING to post to Discord — missing:\n  - " + "\n  - ".join(missing)
    return ""


# ── Token sourcing ─────────────────────────────────────────────────────────

def get_discord_token() -> str:
    """DISCORD_BOT_TOKEN: env, then Keychain (service discord_bot_token).
    "" when neither has it. This IS trade_roast_context's helper — the one
    the context builder's recent-posts read uses — so --generate and --send
    source the token exactly the way the live build does. --context-only
    never calls it."""
    return trade_roast_context._discord_bot_token()


def source_discord_token() -> str:
    """Read the bot token (same helper in every mode) and say what that
    means for the recent-posts duplicate check. Returns "" when unavailable."""
    from_env = bool(os.environ.get("DISCORD_BOT_TOKEN", "").strip())
    tok = get_discord_token()
    if tok:
        print(f"  Discord token: found in {'env' if from_env else 'Keychain'} ({len(tok)} chars) — "
              f"the recent-posts duplicate check will read trade channel "
              f"{trade_roast_context.DISCORD_TRADE_CHANNEL_ID} (GET only)")
    else:
        print("  Discord token: NOT FOUND (no DISCORD_BOT_TOKEN in env; Keychain service "
              "discord_bot_token empty or unreadable)")
        print("  Duplicate check: SKIPPED — no Discord token, so the bot's recent posts can't be "
              "read; the roast context goes without the RECENT BOT POSTS ban list")
    return tok


def _dup_check_status(ctx, have_token: bool) -> str:
    """skipped (no token) | done (ban list built) | empty (read gave nothing)."""
    if not have_token:
        return "skipped"
    text = (ctx.get("recent_bot_posts_text") or "") if isinstance(ctx, dict) else ""
    return "done" if text else "empty"


def _dup_check_note(ctx, have_token: bool) -> str:
    """One line on whether the recent-posts duplicate check fed this context."""
    status = _dup_check_status(ctx, have_token)
    if status == "skipped":
        return "  Duplicate check: SKIPPED (no Discord token — see above)"
    text = (ctx.get("recent_bot_posts_text") or "") if isinstance(ctx, dict) else ""
    if status == "done":
        return (f"  Duplicate check: done — bot's recent posts read from trade channel "
                f"{trade_roast_context.DISCORD_TRADE_CHANNEL_ID}; ban list in the prompt "
                f"({len(text)} chars)")
    return ("  Duplicate check: read attempted, no recent bot posts came back (empty channel, or "
            "the read failed — see any '[trade_roast_context] recent-bot-posts fetch skipped' line)")


def get_giphy_key() -> str:
    """Source Giphy API key from env or Keychain (service=giphy_api_key)."""
    key = os.environ.get("GIPHY_API_KEY", "").strip()
    if key:
        return key
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ["USER"],
             "-s", "giphy_api_key", "-w"],
            check=True, capture_output=True, text=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, KeyError):
        return ""  # Giphy is optional — if missing, just skip the GIF


def get_anthropic_key() -> str:
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    # Fallback: Keychain (recommend storing under service "anthropic_api_key")
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ["USER"],
             "-s", "anthropic_api_key", "-w"],
            check=True, capture_output=True, text=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, KeyError) as e:
        raise SystemExit(
            "ANTHROPIC_API_KEY not in env and not in Keychain. "
            "Set via `security add-generic-password -a $USER -s anthropic_api_key -w` "
            "(paste the sk-ant-... key when prompted) "
            "or `export ANTHROPIC_API_KEY=...`"
        ) from e


# ── Discord REST post ──────────────────────────────────────────────────────

# ── Discord WRITE GUARD ────────────────────────────────────────────────────
# Every Discord request goes through _discord_request(); every non-GET one
# passes _write_guard() there, BEFORE any network attempt, so no caller can
# bypass it. A write is allowed only when ALL hold:
#   - UPS_ALLOW_ROAST_AB_DISCORD_SEND=1 in the environment, AND
#   - this run's main() accepted --confirm-send=<TEST_CHANNEL_ID> (run state), AND
#   - method POST on exactly one of two routes:
#       /channels/<id>/messages                   create message
#       /channels/<id>/messages/<msg id>/threads  create thread from message
#   - <id> is never the production trade channel
#     (trade_roast_context.DISCORD_TRADE_CHANNEL_ID), AND
#   - create message: <id> is TEST_CHANNEL_ID or a thread THIS run created there;
#     create thread: <id> is TEST_CHANNEL_ID and <msg id> a message THIS run
#     posted there.
# Anything else — another channel, an existing/unknown thread, another route
# or method, an unparsable path — is refused with the reason.

_SNOWFLAKE = "[0-9]{1,20}"
_CREATE_MESSAGE_RE = re.compile(rf"/channels/({_SNOWFLAKE})/messages")
_CREATE_THREAD_RE = re.compile(rf"/channels/({_SNOWFLAKE})/messages/({_SNOWFLAKE})/threads")

# Run-local write state. main() resets it at the start and end of every run.
#   confirmed_channel  the --confirm-send value main() validated (TEST_CHANNEL_ID or None)
#   posted_messages    ids of messages this run posted in TEST_CHANNEL_ID
#   created_threads    ids of threads this run created off those messages,
#                      taken ONLY from a create-thread response whose
#                      parent_id is TEST_CHANNEL_ID
_RUN = {"confirmed_channel": None, "posted_messages": set(), "created_threads": set()}


class DiscordWriteRefused(SystemExit):
    """A Discord write the guard refused. Raised before any network attempt."""


def _reset_run_state() -> None:
    _RUN["confirmed_channel"] = None
    _RUN["posted_messages"] = set()
    _RUN["created_threads"] = set()


def record_send_confirmation(value) -> bool:
    """main() calls this once it has accepted --send: records the validated
    --confirm-send value for _write_guard(). Only TEST_CHANNEL_ID is accepted."""
    if str(value or "").strip() != TEST_CHANNEL_ID:
        return False
    _RUN["confirmed_channel"] = TEST_CHANNEL_ID
    return True


def _write_guard(method: str, path) -> tuple:
    """Raise DiscordWriteRefused unless this write is allowed (rules above).
    Returns (route, channel_id, message_id) for _record_write()."""
    def refuse(why):
        raise DiscordWriteRefused(f"Discord {method} {path!r} REFUSED (nothing sent): {why}")

    if os.environ.get(SEND_ENV, "").strip() != "1":
        refuse(f"{SEND_ENV}=1 is not set (only GET is allowed without it)")
    if _RUN["confirmed_channel"] != TEST_CHANNEL_ID:
        refuse(f"this run has no validated --confirm-send={TEST_CHANNEL_ID}")
    if str(method).upper() != "POST":
        refuse("only POST create-message / create-thread-from-message writes are allowed")
    path_s = path if isinstance(path, str) else ""
    m_thread = _CREATE_THREAD_RE.fullmatch(path_s)
    m_msg = _CREATE_MESSAGE_RE.fullmatch(path_s)
    if not (m_thread or m_msg):
        refuse("unrecognised or unparsable route (allowed: /channels/<id>/messages, "
               "/channels/<id>/messages/<msg id>/threads)")
    channel_id = (m_thread or m_msg).group(1)
    prod = str(getattr(trade_roast_context, "DISCORD_TRADE_CHANNEL_ID", "") or "").strip()
    if not prod:
        refuse("the production trade channel id is unknown, so the destination can't be verified")
    if channel_id == prod:
        refuse(f"{channel_id} is the PRODUCTION trade channel")
    if m_thread:
        if channel_id != TEST_CHANNEL_ID:
            refuse(f"threads may only be created in the test channel {TEST_CHANNEL_ID}")
        if m_thread.group(2) not in _RUN["posted_messages"]:
            refuse(f"message {m_thread.group(2)} was not posted to the test channel by this run")
        return "thread", channel_id, m_thread.group(2)
    if channel_id == TEST_CHANNEL_ID or channel_id in _RUN["created_threads"]:
        return "message", channel_id, ""
    refuse(f"{channel_id} is neither the test channel nor a thread this run created in it "
           f"(existing threads and other channels are refused)")


def _record_write(route: str, channel_id: str, resp) -> None:
    """After an allowed write: remember what THIS run created, so only those
    ids become valid destinations."""
    rid = str((resp or {}).get("id", "")) if isinstance(resp, dict) else ""
    if not re.fullmatch(_SNOWFLAKE, rid):
        return
    if route == "message" and channel_id == TEST_CHANNEL_ID:
        _RUN["posted_messages"].add(rid)
    elif (route == "thread" and channel_id == TEST_CHANNEL_ID
          and str(resp.get("parent_id", "")) == TEST_CHANNEL_ID):
        _RUN["created_threads"].add(rid)


def _discord_request(method: str, path: str, token: str, payload: dict = None) -> dict:
    # The ONE function that performs Discord HTTP. GET is a read and passes;
    # every other method must clear _write_guard() first (raises, no request).
    write = str(method).upper() not in READ_METHODS
    if write:
        route, channel_id, _msg = _write_guard(method, path)
    url = f"{DISCORD_API_BASE}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "ups-roast-bot-test-fire (https://github.com/keithcreelman/upsmflproduction)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8")
            result = json.loads(body) if body else {}
        if write:
            _record_write(route, channel_id, result)
        return result
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Discord {method} {path} failed {e.code}: {body}") from e


def discord_post_message(channel_id: str, token: str, payload: dict) -> dict:
    """POST a message to a Discord channel via REST. No gateway needed."""
    return _discord_request("POST", f"/channels/{channel_id}/messages", token, payload)


def discord_create_thread_from_message(channel_id: str, message_id: str, token: str,
                                       thread_name: str, auto_archive_minutes: int = 1440) -> dict:
    """Start a thread anchored to an existing message. Returns the thread channel object."""
    return _discord_request(
        "POST",
        f"/channels/{channel_id}/messages/{message_id}/threads",
        token,
        {"name": thread_name, "auto_archive_duration": auto_archive_minutes},
    )


WORKER_GIPHY_PROXY_URL = "https://upsmflproduction.keith-creelman.workers.dev/api/giphy-search"


def giphy_search(api_key: str, query: str) -> str:
    """Pick a random GIF for `query`. Returns URL or empty string.

    Two paths:
      1) If `api_key` is provided (env or Keychain), hit Giphy directly.
      2) Otherwise fall back to the Worker's /api/giphy-search proxy, which
         uses the Worker's GIPHY_API_KEY secret (same secret the drops post
         uses internally). Keith 2026-05-22 — "wire it the same way we are
         for drops" — this path means the local roast bot doesn't need its
         own Giphy key on the box.
    """
    import random
    if not query:
        return ""

    # Path 1: direct Giphy (only if we have a local key)
    if api_key:
        u = urllib.parse.urlencode({"api_key": api_key, "q": query, "limit": 25,
                                    "lang": "en", "rating": "r"})
        url = f"https://api.giphy.com/v1/gifs/search?{u}"
        try:
            with urllib.request.urlopen(url, timeout=10) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            rows = data.get("data", []) or []
            if rows:
                pick = random.choice(rows)
                return (pick.get("images", {}).get("original", {}).get("url")
                        or pick.get("images", {}).get("downsized_large", {}).get("url")
                        or pick.get("images", {}).get("fixed_height", {}).get("url")
                        or "")
        except Exception:
            pass  # fall through to worker proxy

    # Path 2: Worker proxy (uses CF Worker's GIPHY_API_KEY secret).
    # CF edge blocks the default Python urllib User-Agent with 403; supply
    # a custom UA so the proxy actually receives the request.
    proxy_url = f"{WORKER_GIPHY_PROXY_URL}?{urllib.parse.urlencode({'q': query})}"
    req = urllib.request.Request(
        proxy_url,
        headers={"User-Agent": "ups-roast-bot-test-fire (https://github.com/keithcreelman/upsmflproduction)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if data.get("ok"):
            return data.get("gif_url", "") or ""
    except Exception as e:
        print(f"    (proxy error: {type(e).__name__}: {e})")
        return ""
    return ""


# ── Roast generation ───────────────────────────────────────────────────────

# The user turn sent with every roast (the context text follows it).
ROAST_USER_PREFIX = "Roast this trade. Use ALL the data provided. Be ruthless."


def generate_roast(client: anthropic.Anthropic, model: str, context_text: str) -> tuple[str, dict]:
    """Generate a roast. Returns (roast_text, usage_dict) — usage has input_tokens, output_tokens, cost_estimate."""
    message = client.messages.create(
        model=model,
        max_tokens=2048,
        system=ROAST_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"{ROAST_USER_PREFIX}\n\n{context_text}",
        }],
    )
    usage = message.usage
    # Per-million pricing (Anthropic 2026 — Opus 4.x, Sonnet 4.x)
    PRICING = {
        "claude-opus-4-6":   {"input": 15.0, "output": 75.0},
        "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0},
    }
    p = PRICING.get(model, {"input": 0, "output": 0})
    cost = (usage.input_tokens * p["input"] + usage.output_tokens * p["output"]) / 1_000_000
    return message.content[0].text, {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cost_estimate_usd": round(cost, 5),
    }


# ── Trade fetch ────────────────────────────────────────────────────────────

def find_trade(timestamp: int) -> dict:
    """Pull a specific trade from MFL by timestamp."""
    trades = fetch_trades()
    for t in trades:
        if int(t.get("timestamp", 0)) == timestamp:
            return t
    raise SystemExit(f"Trade ts={timestamp} not found in MFL transactions feed")


# ── Main ───────────────────────────────────────────────────────────────────

_GIF_TAG_RE = re.compile(r"\[GIF:\s*([^\]]+?)\s*\]\s*$", re.IGNORECASE | re.MULTILINE)


def _extract_gif_query(roast_text: str) -> tuple[str, str]:
    """Pull [GIF: ...] from the end of the roast. Returns (clean_roast, gif_query)."""
    m = _GIF_TAG_RE.search(roast_text)
    if not m:
        return roast_text, ""
    query = m.group(1).strip()
    clean = roast_text[:m.start()].rstrip() + ("\n" if not roast_text[:m.start()].endswith("\n") else "")
    return clean, query


def _show(label: str, payload: dict) -> None:
    print(f"  {label}:\n" + json.dumps(payload, indent=2, ensure_ascii=False))


def fire_one(client, discord_token, giphy_key, model_label: str, model_id: str,
             trade_ts: int, send: bool) -> dict:
    """Full sequence (every message is built and printed before any post).
    Steps 1-5 are identical for --generate and --send (same reads); only
    step 6, the write, is --send only:
      1) Run analyze_trade → TradeAnalysis
      2) Build announcement embed (Message 1)
      3) Build the roast context (incl. the Discord recent-posts read when a
         token is available), generate via Anthropic, parse [GIF: ...] (Message 2)
      4) Search Giphy for the GIF query (Message 3)
      5) Print the destination + the exact proposed messages
      6) --send only: post Message 1 to the channel, create a thread off it,
         post Messages 2 and 3 in the thread
    """
    print(f"\n=== ts={trade_ts} · model={model_label} ({model_id}) ===")

    trade = find_trade(trade_ts)
    fr_a_id = trade.get("franchise", "")
    fr_b_id = trade.get("franchise2", "")
    print(f"  Trade: {fr_a_id} ↔ {fr_b_id}")

    # Extension hint
    comments = (trade.get("comments", "") or "").lower()
    ext_years = 0
    ext_player = ""
    if "extension" in comments or "extend" in comments:
        ext_years = 2
        gave_up = trade.get("franchise2_gave_up", "")
        for tok in gave_up.split(","):
            tok = tok.strip()
            if tok and not tok.startswith("FP_") and not tok.startswith("BB_"):
                ext_player = tok
                break

    # 1) Analyze trade
    print(f"  Running analyze_trade...")
    franchises = load_franchises()
    analysis = analyze_trade(
        trade,
        load_players_map(), franchises, load_rosters(), load_rollover(),
        load_auction_pool(), load_team_caps(), load_future_picks(), load_trade_value_model(),
    )

    # 2) Build announcement embed
    ts_int = int(trade.get("timestamp", 0))
    trade_iso = datetime.fromtimestamp(ts_int, tz=timezone.utc).isoformat() if ts_int else ""
    announcement = build_announcement_embed(analysis, franchises, trade_iso)

    # 3) Build roast context + generate
    print(f"  Building roast context...")
    ctx = build_trade_roast_context(trade, extension_years=ext_years,
                                    extension_player_id=ext_player)
    context_text = context_to_prompt_text(ctx)
    print(f"  Context built ({len(context_text)} chars)")
    print(_dup_check_note(ctx, bool(discord_token)))
    dup_check = _dup_check_status(ctx, bool(discord_token))

    print(f"  Generating roast via {model_id}...")
    t0 = time.time()
    raw_roast, usage = generate_roast(client, model_id, context_text)
    gen_ms = int((time.time() - t0) * 1000)
    print(f"  Generated in {gen_ms}ms · {len(raw_roast)} chars · "
          f"{usage['input_tokens']} in / {usage['output_tokens']} out tokens · "
          f"${usage['cost_estimate_usd']}")

    # 4) Extract GIF tag
    roast_clean, gif_query = _extract_gif_query(raw_roast)
    print(f"  GIF query: {gif_query!r}" if gif_query else "  GIF query: (none — Opus skipped the tag)")

    # 5) Build every message before anything is posted
    announce_payload = {"embeds": [announcement], "allowed_mentions": {"parse": []}}
    team_a_name = franchises.get(analysis.side_a.franchise_id, analysis.side_a.franchise_name or "Team A")
    team_b_name = franchises.get(analysis.side_b.franchise_id, analysis.side_b.franchise_name or "Team B")
    # Discord thread names cap at 100 chars
    thread_name = f"Trade Roast — {team_a_name} ↔ {team_b_name}"[:100]
    roast_embed = {
        "title": f"🔥 Roast — {model_label.upper()}",
        "description": roast_clean[:4096],
        "color": 0x5865F2 if model_label == "opus" else 0x57F287,
    }
    roast_payload = {"embeds": [roast_embed], "allowed_mentions": {"parse": []}}
    # giphy_search() tries local key first, falls back to Worker /api/giphy-search proxy.
    # A read: runs the same in --generate and --send.
    gif_url = ""
    if gif_query:
        source = "local key" if giphy_key else "Worker proxy"
        print(f"  Searching Giphy for {gif_query!r} via {source}...")
        gif_url = giphy_search(giphy_key, gif_query)
        if not gif_url:
            print(f"    (no Giphy result for query — neither local key nor proxy returned a URL)")
    gif_payload = ({"embeds": [{"image": {"url": gif_url}, "color": 0x202225}],
                    "allowed_mentions": {"parse": []}} if gif_url else None)

    print(f"\n  DESTINATION: channel {TEST_CHANNEL_ID} (UPS test channel); Messages 2-3 go in a "
          f"NEW thread {thread_name!r} created off Message 1 (thread id assigned by Discord)")
    _show(f"Message 1 → channel {TEST_CHANNEL_ID}", announce_payload)
    _show("Message 2 → new thread", roast_payload)
    if gif_payload:
        _show("Message 3 → new thread", gif_payload)
    else:
        print("  Message 3: none (no GIF)")

    # ── The ONLY difference between --generate and --send starts here. ──
    if not send:
        print(f"  DRY RUN — nothing posted to Discord (roast {len(roast_clean)} chars, gif='{gif_query}')")
        return {
            "ok": True, "dry_run": True,
            "trade_ts": trade_ts, "model": model_label,
            "context_chars": len(context_text), "dup_check": dup_check,
            "roast_chars": len(roast_clean),
            "gif_query": gif_query, "gif": bool(gif_url),
            "gen_ms": gen_ms, "usage": usage,
        }

    # 6) Post announcement (Message 1)
    print(f"  Posting announcement to channel {TEST_CHANNEL_ID}...")
    announce_resp = discord_post_message(TEST_CHANNEL_ID, discord_token, announce_payload)
    announce_msg_id = announce_resp.get("id", "")
    print(f"    announcement message_id={announce_msg_id}")

    # 7) Create thread off announcement
    print(f"  Creating thread '{thread_name}'...")
    thread = discord_create_thread_from_message(
        TEST_CHANNEL_ID, announce_msg_id, discord_token, thread_name)
    thread_id = thread.get("id", "")
    print(f"    thread_id={thread_id}")

    # 8) Post roast in thread (Message 2)
    print(f"  Posting roast in thread {thread_id}...")
    roast_resp = discord_post_message(thread_id, discord_token, roast_payload)
    roast_msg_id = roast_resp.get("id", "")
    print(f"    roast message_id={roast_msg_id}")

    # 9) Post GIF in thread (Message 3)
    gif_msg_id = ""
    if gif_payload:
        gif_resp = discord_post_message(thread_id, discord_token, gif_payload)
        gif_msg_id = gif_resp.get("id", "")
        print(f"    gif message_id={gif_msg_id}  url={gif_url[:80]}")

    return {
        "ok": True,
        "trade_ts": trade_ts, "model": model_label,
        "announcement_msg_id": announce_msg_id,
        "thread_id": thread_id,
        "roast_msg_id": roast_msg_id,
        "gif_msg_id": gif_msg_id,
        "gif_query": gif_query, "gif": bool(gif_url),
        "context_chars": len(context_text), "dup_check": dup_check,
        "roast_chars": len(roast_clean),
        "gen_ms": gen_ms, "usage": usage,
    }


# Audit log: the only fields a result may write (anything else is dropped).
AUDIT_RESULT_KEYS = ("ok", "dry_run", "trade_ts", "model", "context_chars", "dup_check",
                     "roast_chars", "gif", "gen_ms", "announcement_msg_id", "thread_id",
                     "roast_msg_id", "gif_msg_id", "error_type")
AUDIT_USAGE_KEYS = ("input_tokens", "output_tokens", "cost_estimate_usd")


def audit_log_line(mode: str, results: list) -> str:
    """One JSON line for ab_test_fire.log: whitelisted ids/counts/flags only."""
    rows = []
    for r in results:
        row = {k: r[k] for k in AUDIT_RESULT_KEYS if k in r}
        usage = r.get("usage")
        if isinstance(usage, dict):
            row["usage"] = {k: usage[k] for k in AUDIT_USAGE_KEYS if k in usage}
        rows.append(row)
    return json.dumps({"fired_at_utc": datetime.now(timezone.utc).isoformat(),
                       "mode": mode, "results": rows})


DESTINATION = (f"channel {TEST_CHANNEL_ID} (UPS test channel) — Message 1 (trade announcement) "
               f"goes there, then a NEW thread created off it gets Message 2 (roast) + "
               f"Message 3 (GIF)")

HOW_TO_GENERATE = f"""\
Nothing was run. Generating a roast is a PAID Anthropic call, so it needs an explicit option:
  --generate        generate + print a dry-run preview (destination + every message); never posts
  --send            generate, then post to the test channel; also needs
                    --confirm-send={TEST_CHANNEL_ID} and {SEND_ENV}=1 in the environment
  --context-only    offline: print the context local files hold; no network, no token"""


def preflight_plan(args, mode: str, trades: list, models: list) -> str:
    """What this run will and won't do, printed before any network,
    Keychain or Anthropic activity. mode: plan | refused | context |
    generate | send."""
    n_calls = len(trades) * len(models)
    model_ids = ", ".join(MODELS[m] for m in models)
    gen = (f"YES — {n_calls} PAID call(s): {model_ids} × trades {trades} "
           f"(ANTHROPIC_API_KEY env → Keychain anthropic_api_key)")
    mfl = "YES, read only — MFL trade feed, league, rosters; Worker roast context"
    dread = (f"YES when a bot token is found (DISCORD_BOT_TOKEN env → Keychain discord_bot_token): "
             f"GET /users/@me + GET the last 100 messages in trade channel "
             f"{trade_roast_context.DISCORD_TRADE_CHANNEL_ID} — the recent-posts duplicate check "
             f"(anti-repetition ban list)")
    no_token = "; no token → check SKIPPED and said so"
    giphy = ("YES — one GIF search per roast that ends in [GIF: …] "
             "(GIPHY_API_KEY env → Keychain giphy_api_key → Worker /api/giphy-search proxy)")
    secrets = "ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, GIPHY_API_KEY (each env first, then Keychain)"
    dup_later = "NO — duplicate check: runs only with --generate / --send"
    if mode == "plan":
        rows = [
            ("Mode", "PLAN ONLY — no option given; nothing is read, generated or posted"),
            ("Network", "NO"),
            ("Anthropic", "NO — generating is a paid call; it needs --generate (or --send)"),
            ("MFL / Worker", "NO"),
            ("Discord read", "NO"),
            ("Giphy read", "NO"),
            ("Discord write", "NO"),
            ("Secrets", "none (no env key, no Keychain)"),
            ("Destination", f"none this run; --send would post to {DESTINATION}"),
        ]
    elif mode == "refused":
        what = ("--send (implies --generate: generate, print, then post)" if args.send
                else "--confirm-send without --send")
        rows = [
            ("Mode", f"REFUSED — {what}; nothing runs (reason below)"),
            ("Network", "NO (refused)"),
            ("Anthropic", "NO (refused)"),
            ("MFL / Worker", "NO (refused)"),
            ("Discord read", "NO (refused)"),
            ("Giphy read", "NO (refused)"),
            ("Discord write", "NO (refused)"),
            ("Secrets", "none (refused before any env key or Keychain read)"),
            ("Destination", f"none this run; an allowed --send posts to {DESTINATION}"),
        ]
    elif mode == "context":
        rows = [
            ("Mode", "CONTEXT ONLY (offline) — print the context available from local files; "
                     "the full roast context needs live reads, so it is NOT built here"),
            ("Network", "NO — no MFL, Worker, Discord, Giphy or Anthropic"),
            ("Anthropic", "NO"),
            ("MFL / Worker", "NO — local files only: committed MFL snapshots "
                             "(data/mfl-snapshots/<date>/transactions.json, league.json) "
                             "+ local owner_profiles.json"),
            ("Discord read", dup_later),
            ("Giphy read", "NO"),
            ("Discord write", "NO"),
            ("Secrets", "none (no token, no env key, no Keychain)"),
            ("Destination", "none — nothing is posted"),
        ]
    elif mode == "generate":
        rows = [
            ("Mode", "GENERATE — paid generation, then a DRY-RUN preview; nothing is posted"),
            ("Network", "YES — MFL, Worker, Discord (GET only), Giphy, Anthropic"),
            ("Anthropic", gen),
            ("MFL / Worker", mfl),
            ("Discord read", dread + no_token + ". Same reads as --send"),
            ("Giphy read", giphy + ". Same as --send"),
            ("Discord write", "NO — dry run; only --send writes (the token is used for the read only)"),
            ("Secrets", secrets),
            ("Destination", f"PREVIEW ONLY — {DESTINATION}"),
        ]
    else:  # send — every gate already met
        rows = [
            ("Mode", "SEND — --send implies --generate: same reads + messages as --generate, "
                     "every message printed, THEN posted"),
            ("Network", "YES — MFL, Worker, Discord (GET + test-channel POSTs), Giphy, Anthropic"),
            ("Anthropic", gen),
            ("MFL / Worker", mfl),
            ("Discord read", dread + "; no token → --send stops (exit 2) before generating"),
            ("Giphy read", giphy),
            ("Discord write", f"YES — gates met (--confirm-send={TEST_CHANNEL_ID}, {SEND_ENV}=1); "
                              f"per fire: POST Message 1, create a NEW thread off it, POST "
                              f"Messages 2-3 in that thread. Write guard: only channel "
                              f"{TEST_CHANNEL_ID} + threads this run creates there; production "
                              f"trade channel {trade_roast_context.DISCORD_TRADE_CHANNEL_ID} "
                              f"and every other id refused"),
            ("Secrets", secrets),
            ("Destination", DESTINATION),
        ]
    rows.append(("Selection", f"trades {trades} (context only; --model unused)" if mode == "context"
                 else f"trades {trades} × models {models} = {n_calls} fire(s)"))
    width = max(len(k) for k, _ in rows) + 1
    body = "\n".join(f"  {k + ':':<{width}} {v}" for k, v in rows)
    return f"{PLAN_START}\n{body}\n{PLAN_END}"


# ── --context-only: OFFLINE (local files only) ─────────────────────────────
# repo/data/mfl-snapshots — the committed daily MFL pulls. Fixed at import
# (not derived from SCRIPT_DIR) so it never moves with the audit-log dir.
REPO_ROOT = Path(__file__).resolve().parents[3]
SNAPSHOT_DIR = REPO_ROOT / "data" / "mfl-snapshots"


def _rel(path: Path) -> str:
    try:
        return str(Path(path).resolve().relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _read_json(path: Path):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def local_trade_snapshot(ts: int):
    """(snapshot_dir, trade) from the NEWEST local MFL snapshot whose
    transactions.json has this trade, else (None, None). Local files only."""
    if not SNAPSHOT_DIR.is_dir():
        return None, None
    for d in sorted((p for p in SNAPSHOT_DIR.iterdir() if p.is_dir()), reverse=True):
        data = _read_json(d / "transactions.json")
        if not isinstance(data, dict):
            continue
        txns = (data.get("transactions") or {}).get("transaction") or []
        if isinstance(txns, dict):
            txns = [txns]
        for t in txns:
            if t.get("type") == "TRADE" and str(t.get("timestamp")) == str(ts):
                return d, t
    return None, None


def _snapshot_franchise_names(snapshot_dir: Path) -> dict:
    data = _read_json(snapshot_dir / "league.json") or {}
    rows = ((data.get("league") or {}).get("franchises") or {}).get("franchise") or []
    if isinstance(rows, dict):
        rows = [rows]
    return {str(r.get("id")): r.get("name", "") for r in rows if isinstance(r, dict)}


def print_offline_context(trades: list) -> None:
    """Print only what local files hold — no network, no token, no Keychain,
    no Anthropic. Says plainly what is NOT built and why."""
    print("CONTEXT ONLY — OFFLINE: no network, no token, no Keychain, no Anthropic.")
    print("  NOT built here: the full roast context. It needs live reads (MFL league, players,")
    print("  rosters, future picks; Worker stats) — run --generate for it.")
    print("  Duplicate check: runs only with --generate / --send (it reads the bot's recent")
    print("  Discord posts). Not run here.")
    print(f"  Prompt framing (local): system prompt content_engine.ROAST_SYSTEM = "
          f"{len(ROAST_SYSTEM)} chars; user turn = {ROAST_USER_PREFIX!r} + the full context.")
    print("  Asset tokens: DP_<round>_<pick> = this year's pick, zero-indexed (DP_2_10 = 3.11);")
    print("  FP_<team>_<year>_<round> = future pick; BB_<n> = budget bucks; a bare number = MFL player id.")
    profiles = trade_roast_context.OWNER_PROFILES_PATH
    for ts in trades:
        print(f"\n{'='*70}\n=== LOCAL CONTEXT for ts={ts} ===\n{'='*70}")
        snap, trade = local_trade_snapshot(ts)
        if not trade:
            print(f"  Trade: not found in any local MFL snapshot under {_rel(SNAPSHOT_DIR)} "
                  f"(nothing more can be shown offline)")
            continue
        names = _snapshot_franchise_names(snap)
        fa, fb = str(trade.get("franchise", "")), str(trade.get("franchise2", ""))
        print(f"  Source: {_rel(snap / 'transactions.json')} — local MFL snapshot "
              f"{snap.name}, NOT a live read")
        print(f"  Trade:  {fa} {names.get(fa, '(name not in snapshot)')} ↔ "
              f"{fb} {names.get(fb, '(name not in snapshot)')}")
        for fid, key in ((fa, "franchise1_gave_up"), (fb, "franchise2_gave_up")):
            assets = [a for a in str(trade.get(key, "")).split(",") if a.strip()]
            print(f"    {fid} {names.get(fid, '')} gave up: {', '.join(assets) or '(nothing listed)'}")
        print(f"  Comments: {trade.get('comments') or '(none)'}")
        dossier = trade_roast_context.format_owner_dossier([fa, fb])
        if dossier:
            print(f"  Owner dossier (local {profiles.name}):{dossier}")
        else:
            print(f"  Owner dossier: none locally for {fa}/{fb} ({_rel(profiles)} missing or "
                  f"no entries)")


def main(argv=None) -> int:
    # Every run starts and ends with empty write state: no confirmation, no
    # posted messages, no created threads carried between runs.
    _reset_run_state()
    try:
        return _main(argv)
    finally:
        _reset_run_state()


def _main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        prog="roast_bot_fire_ab.py",
        description="A/B fire for the Trade Roast Bot. With no option it only prints this "
                    "usage and a plan: no Anthropic call, no Discord read or write.")
    parser.add_argument("--generate", action="store_true",
                        help="PAID: generate the roasts via Anthropic, then print a dry-run preview "
                             "(destination + every message). Same reads as --send; never posts.")
    parser.add_argument("--send", action="store_true",
                        help=f"Implies --generate, then POSTS to Discord. Also needs --confirm-send "
                             f"and {SEND_ENV}=1.")
    parser.add_argument("--confirm-send", metavar="CHANNEL_ID", default=None,
                        help=f"Must equal the destination channel id ({TEST_CHANNEL_ID}) for --send")
    parser.add_argument("--context-only", action="store_true",
                        help="OFFLINE: print the trade context available from local files "
                             "(committed MFL snapshot, owner dossier). No network, no token, no "
                             "Keychain, no Anthropic; the duplicate check runs only with "
                             "--generate / --send.")
    parser.add_argument("--trade", type=int, choices=[TRADE_1_TS, TRADE_2_TS],
                        help="Only fire this trade timestamp (else both)")
    parser.add_argument("--model", choices=["opus", "sonnet", "both"], default=None,
                        help="opus (default) | sonnet | both for A/B compare")
    args = parser.parse_args(argv)
    if args.context_only and (args.generate or args.send):
        parser.error("--context-only cannot be combined with --generate or --send")

    trades = [args.trade] if args.trade else [TRADE_1_TS, TRADE_2_TS]
    # Default to Opus-only (Keith 2026-05-22: "stick 100% with Opus for the roast").
    # Pass --model sonnet or --model both to compare.
    if args.model == "both":
        models = ["opus", "sonnet"]
    elif args.model:
        models = [args.model]
    else:
        models = ["opus"]

    refusal = send_refusal(args, os.environ)
    send = args.send and not refusal
    if refusal:
        mode = "refused"
    elif send:
        mode = "send"
    elif args.generate:
        mode = "generate"
    elif args.context_only:
        mode = "context"
    else:
        mode = "plan"

    # The plan comes first in every mode: nothing below it has run yet.
    if mode == "plan":
        print(parser.format_help())
    print(preflight_plan(args, mode, trades, models))
    if refusal:
        print(refusal)
        return 2
    if mode == "plan":
        print(HOW_TO_GENERATE)
        return 0

    # --context-only: OFFLINE. Local files only — no network, no token, no
    # Keychain, no Anthropic (Keith 2026-10-12). The live builder needs MFL +
    # Worker + Discord reads, so it is not called here.
    if mode == "context":
        print_offline_context(trades)
        return 0

    if send:
        # Recorded for _write_guard(), which re-checks it on every write.
        record_send_confirmation(args.confirm_send)

    # --generate / --send: identical credential sourcing (fail fast, before
    # any MFL or Anthropic call). Only --send needs the token to exist.
    print("Sourcing credentials...")
    anthropic_key = get_anthropic_key()
    discord_token = source_discord_token()
    if send and not discord_token:
        print("REFUSING to post: --send needs DISCORD_BOT_TOKEN (env or Keychain service "
              "discord_bot_token). Nothing generated, nothing sent.")
        return 2
    giphy_key = get_giphy_key()
    os.environ["ANTHROPIC_API_KEY"] = anthropic_key  # SDK reads from env
    client = anthropic.Anthropic()
    print(f"  Anthropic key: sourced ({len(anthropic_key)} chars)")
    print(f"  Giphy: {'local key (' + str(len(giphy_key)) + ' chars)' if giphy_key else 'Worker /api/giphy-search proxy (no local key)'}")
    print(f"  Target channel: {TEST_CHANNEL_ID}")
    print(f"  Trades: {trades}")
    print(f"  Models: {models}")
    print(f"  Mode: {'SEND — will post to Discord' if send else 'DRY RUN — nothing will be posted'}")

    results = []
    for ts in trades:
        for m_label in models:
            try:
                r = fire_one(client, discord_token, giphy_key, m_label, MODELS[m_label],
                             ts, send)
                results.append(r)
            except Exception as e:
                print(f"  ✗ FAILED ts={ts} model={m_label}: {e}")
                results.append({"ok": False, "trade_ts": ts, "model": m_label,
                                "error": str(e), "error_type": type(e).__name__})
            # polite pacing between fires
            time.sleep(1.5)

    print("\n=== SUMMARY ===")
    total_cost = 0.0
    for r in results:
        if r.get("ok"):
            tag = "DRY-RUN" if r.get("dry_run") else "POSTED"
            u = r.get("usage", {})
            cost = u.get("cost_estimate_usd", 0)
            total_cost += cost
            print(f"  {tag}  ts={r['trade_ts']}  {r['model']:6}  "
                  f"announce={r.get('announcement_msg_id','—'):20}  "
                  f"thread={r.get('thread_id','—'):20}  "
                  f"roast={r.get('roast_msg_id','—'):20}  "
                  f"gif={r.get('gif_msg_id','—'):20}  "
                  f"gif_q={r.get('gif_query','—')!r}  "
                  f"gen={r.get('gen_ms','?')}ms  "
                  f"in={u.get('input_tokens','?')}t  out={u.get('output_tokens','?')}t  "
                  f"cost=${cost}")
        else:
            print(f"  FAIL  ts={r['trade_ts']}  {r['model']:6}  {r.get('error','?')}")
    print(f"\n  TOTAL COST: ${round(total_cost, 4)}")

    # Write a tiny audit log (gitignored, local). WHITELISTED fields only:
    # ids, counts, flags, usage — never a token/key, roast or context text,
    # GIF query, fetched Discord message text, or a free-text error.
    audit_path = SCRIPT_DIR.parent / "data" / "ab_test_fire.log"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with open(audit_path, "a") as f:
        f.write(audit_log_line("send" if send else "generate", results) + "\n")
    print(f"\n  Audit log: {audit_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
