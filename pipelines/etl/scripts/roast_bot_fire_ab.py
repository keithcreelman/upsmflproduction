#!/usr/bin/env python3
"""
roast_bot_fire_ab.py — One-shot A/B fire for the Trade Roast Bot.

(Renamed from test_fire_ab.py 2026-10-12 so test discovery — test_*.py,
*_test.py — can never run it. tests: test_roast_bot_fire_ab_safety.py.)

DRY RUN IS THE DEFAULT. With no flags nothing is posted to Discord; it
builds each fire and prints the destination + proposed messages.

With --send it posts to the Discord TEST channel:
  - Trade 1 (ts=1778546756, 0006 ↔ 0007) × Opus 4.6
  - Trade 1 × Sonnet 4.6
  - Trade 2 (Hurts ts=1775772921) × Opus 4.6
  - Trade 2 × Sonnet 4.6

Each message footer-tagged with the model + trade ID for direct comparison.

Bypasses the launchd bot entirely — uses Discord REST API (no gateway
connection → no identity conflict with the running bot). Reads owner /
team mapping from D1 (discord_owners table) via the worker, NOT the
missing hardcoded CSV. Reads contracts + rosters live from MFL.

Sending needs BOTH (either missing → refuse, exit 2, nothing sent):
  --send --confirm-send=<TEST_CHANNEL_ID>      exact id it will post to
  UPS_ALLOW_ROAST_AB_DISCORD_SEND=1            in the environment

What a dry run still does (reads only, never a Discord write):
  - MFL export + Worker GETs (trade, league, rosters, roast context)
  - Anthropic: generates each roast (ANTHROPIC_API_KEY, env → Keychain)
It does NOT read the Discord token or the Giphy key, does NOT do the
context builder's read of the bot's recent posts (anti-repetition list),
and does NOT search Giphy (the GIF query is printed instead).

Env:
  ANTHROPIC_API_KEY  — sk-ant-... (Keychain service anthropic_api_key)
  DISCORD_BOT_TOKEN  — --send only; Keychain if not in env:
                       security find-generic-password -a $USER -s discord_bot_token -w

Usage:
  python roast_bot_fire_ab.py                      # dry run: both trades, opus
  python roast_bot_fire_ab.py --trade 1778546756   # dry run: single trade
  python roast_bot_fire_ab.py --model both         # dry run: opus + sonnet
  python roast_bot_fire_ab.py --context-only       # context only, no Anthropic
  UPS_ALLOW_ROAST_AB_DISCORD_SEND=1 python roast_bot_fire_ab.py \\
      --send --confirm-send=1089538054236160010    # POSTS to the test channel
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


def send_refusal(args, env) -> str:
    """Why this run may NOT write to Discord, or "" when every gate is met.
    Only meaningful with --send; without it the run is a dry run."""
    if not args.send:
        if args.confirm_send:
            return "--confirm-send given without --send — refusing; nothing sent."
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
    tok = os.environ.get("DISCORD_BOT_TOKEN", "").strip()
    if tok:
        return tok
    # Fallback: Keychain (matches the launchd plist's documented pattern)
    try:
        result = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ["USER"],
             "-s", "discord_bot_token", "-w"],
            check=True, capture_output=True, text=True,
        )
        return result.stdout.strip()
    except (subprocess.CalledProcessError, KeyError) as e:
        raise SystemExit(
            "DISCORD_BOT_TOKEN not in env and not in Keychain. "
            "Set via `security add-generic-password -a $USER -s discord_bot_token -w` "
            "or `export DISCORD_BOT_TOKEN=...`"
        ) from e


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

def _discord_request(method: str, path: str, token: str, payload: dict = None) -> dict:
    # Backstop for any caller that skipped main()'s gate: no env permission, no request.
    if os.environ.get(SEND_ENV, "").strip() != "1":
        raise SystemExit(f"Discord {method} {path} refused: {SEND_ENV}=1 is not set")
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
            return json.loads(body) if body else {}
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

def generate_roast(client: anthropic.Anthropic, model: str, context_text: str) -> tuple[str, dict]:
    """Generate a roast. Returns (roast_text, usage_dict) — usage has input_tokens, output_tokens, cost_estimate."""
    message = client.messages.create(
        model=model,
        max_tokens=2048,
        system=ROAST_SYSTEM,
        messages=[{
            "role": "user",
            "content": f"Roast this trade. Use ALL the data provided. Be ruthless.\n\n{context_text}",
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
    """Full sequence (every message is built and printed before any post):
      1) Run analyze_trade → TradeAnalysis
      2) Build announcement embed (Message 1)
      3) Generate roast via Anthropic, parse [GIF: ...] tag (Message 2)
      4) --send only: search Giphy for the GIF query (Message 3)
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
    # Dry run skips Giphy entirely (no key, no request).
    gif_url = ""
    if send and gif_query:
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
    elif gif_query and not send:
        print(f"  Message 3 → new thread: a Giphy GIF for {gif_query!r} (dry run: Giphy not searched)")
    else:
        print("  Message 3: none (no GIF)")

    if not send:
        print(f"  DRY RUN — nothing posted to Discord (roast {len(roast_clean)} chars, gif='{gif_query}')")
        return {
            "ok": True, "dry_run": True,
            "trade_ts": trade_ts, "model": model_label,
            "context_chars": len(context_text),
            "roast_chars": len(roast_clean),
            "gif_query": gif_query,
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
        "gif_query": gif_query,
        "context_chars": len(context_text),
        "roast_chars": len(roast_clean),
        "gen_ms": gen_ms, "usage": usage,
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="A/B fire for the trade roast (dry run unless --send)")
    parser.add_argument("--trade", type=int, choices=[TRADE_1_TS, TRADE_2_TS],
                        help="Only fire this trade timestamp (else both)")
    parser.add_argument("--model", choices=["opus", "sonnet", "both"], default=None,
                        help="opus (default) | sonnet | both for A/B compare")
    parser.add_argument("--send", action="store_true",
                        help=f"POST to Discord. Also needs --confirm-send and {SEND_ENV}=1. "
                             "Without it the run is a dry run: build + print, never post.")
    parser.add_argument("--confirm-send", metavar="CHANNEL_ID", default=None,
                        help=f"Must equal the destination channel id ({TEST_CHANNEL_ID}) for --send")
    parser.add_argument("--context-only", action="store_true",
                        help="Just build + print the context. No Anthropic call, no posting. Useful for previewing what the LLM would see without needing the API key.")
    args = parser.parse_args(argv)

    refusal = send_refusal(args, os.environ)
    if refusal:
        print(refusal)
        return 2
    send = args.send
    if not send:
        # Dry run never reads the Discord token: the roast context builder
        # would otherwise read it (env → Keychain) to fetch the bot's recent
        # posts as an anti-repetition list. Dry-run prompts go without it.
        trade_roast_context._discord_bot_token = lambda: ""

    trades = [args.trade] if args.trade else [TRADE_1_TS, TRADE_2_TS]
    # Default to Opus-only (Keith 2026-05-22: "stick 100% with Opus for the roast").
    # Pass --model sonnet or --model both to compare.
    if args.model == "both":
        models = ["opus", "sonnet"]
    elif args.model:
        models = [args.model]
    else:
        models = ["opus"]

    # --context-only short-circuit: just build + print, no Anthropic, no Discord
    if args.context_only:
        for ts in trades:
            print(f"\n{'='*70}\n=== CONTEXT for ts={ts} ===\n{'='*70}")
            trade = find_trade(ts)
            comments = (trade.get("comments", "") or "").lower()
            ext_years = 2 if ("extension" in comments or "extend" in comments) else 0
            ext_player = ""
            if ext_years:
                for tok in trade.get("franchise2_gave_up", "").split(","):
                    tok = tok.strip()
                    if tok and not tok.startswith("FP_") and not tok.startswith("BB_"):
                        ext_player = tok
                        break
            ctx = build_trade_roast_context(trade, extension_years=ext_years,
                                            extension_player_id=ext_player)
            print(context_to_prompt_text(ctx))
        return 0

    # Validate creds up front so we fail fast
    print("Sourcing credentials...")
    anthropic_key = get_anthropic_key()
    # Discord token + Giphy key are read only when sending.
    discord_token = get_discord_token() if send else ""
    giphy_key = get_giphy_key() if send else ""
    os.environ["ANTHROPIC_API_KEY"] = anthropic_key  # SDK reads from env
    client = anthropic.Anthropic()
    print(f"  Anthropic key: sourced ({len(anthropic_key)} chars)")
    if send:
        print(f"  Discord token: sourced ({len(discord_token)} chars)")
        print(f"  Giphy: {'local key (' + str(len(giphy_key)) + ' chars)' if giphy_key else 'Worker /api/giphy-search proxy (no local key)'}")
    else:
        print("  Discord token / Giphy key: not read (dry run)")
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
                results.append({"ok": False, "trade_ts": ts, "model": m_label, "error": str(e)})
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

    # Write a tiny audit log
    audit_path = SCRIPT_DIR.parent / "data" / "ab_test_fire.log"
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with open(audit_path, "a") as f:
        f.write(json.dumps({
            "fired_at_utc": datetime.now(timezone.utc).isoformat(),
            "results": results,
        }) + "\n")
    print(f"\n  Audit log: {audit_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
