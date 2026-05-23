#!/usr/bin/env python3
"""
test_fire_ab.py — One-shot A/B test fire for the Trade Roast Bot.

Posts 4 messages to the Discord TEST channel:
  - Trade 1 (ts=1778546756, 0006 ↔ 0007) × Opus 4.6
  - Trade 1 × Sonnet 4.6
  - Trade 2 (Hurts ts=1775772921) × Opus 4.6
  - Trade 2 × Sonnet 4.6

Each message footer-tagged with the model + trade ID for direct comparison.

Bypasses the launchd bot entirely — uses Discord REST API (no gateway
connection → no identity conflict with the running bot). Reads owner /
team mapping from D1 (discord_owners table) via the worker, NOT the
missing hardcoded CSV. Reads contracts + rosters live from MFL.

Env required:
  ANTHROPIC_API_KEY  — sk-ant-...
  DISCORD_BOT_TOKEN  — read from Keychain if not in env:
                       security find-generic-password -a $USER -s discord_bot_token -w

Usage:
  python test_fire_ab.py                           # both trades, both models
  python test_fire_ab.py --trade 1778546756        # single trade, both models
  python test_fire_ab.py --model opus              # both trades, opus only
  python test_fire_ab.py --dry-run                 # build + print, don't post
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


def fire_one(client, discord_token, giphy_key, model_label: str, model_id: str,
             trade_ts: int, dry_run: bool) -> dict:
    """Full sequence:
      1) Run analyze_trade → TradeAnalysis
      2) Build announcement embed → post to channel (Message 1)
      3) Create thread off Message 1
      4) Generate roast via Anthropic
      5) Parse [GIF: ...] tag from roast end
      6) Post roast in thread (Message 2)
      7) Search Giphy for the GIF query
      8) Post GIF in thread (Message 3)
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

    if dry_run:
        print(f"  DRY-RUN — would post announcement + thread (roast {len(roast_clean)} chars, gif='{gif_query}')")
        return {
            "ok": True, "dry_run": True,
            "trade_ts": trade_ts, "model": model_label,
            "context_chars": len(context_text),
            "roast_chars": len(roast_clean),
            "gif_query": gif_query,
            "gen_ms": gen_ms, "usage": usage,
        }

    # 5) Post announcement (Message 1)
    print(f"  Posting announcement to channel {TEST_CHANNEL_ID}...")
    announce_payload = {"embeds": [announcement], "allowed_mentions": {"parse": []}}
    announce_resp = discord_post_message(TEST_CHANNEL_ID, discord_token, announce_payload)
    announce_msg_id = announce_resp.get("id", "")
    print(f"    announcement message_id={announce_msg_id}")

    # 6) Create thread off announcement
    team_a_name = franchises.get(analysis.side_a.franchise_id, analysis.side_a.franchise_name or "Team A")
    team_b_name = franchises.get(analysis.side_b.franchise_id, analysis.side_b.franchise_name or "Team B")
    # Discord thread names cap at 100 chars
    thread_name = f"Trade Roast — {team_a_name} ↔ {team_b_name}"[:100]
    print(f"  Creating thread '{thread_name}'...")
    thread = discord_create_thread_from_message(
        TEST_CHANNEL_ID, announce_msg_id, discord_token, thread_name)
    thread_id = thread.get("id", "")
    print(f"    thread_id={thread_id}")

    # 7) Post roast in thread (Message 2)
    roast_embed = {
        "title": f"🔥 Roast — {model_label.upper()}",
        "description": roast_clean[:4096],
        "color": 0x5865F2 if model_label == "opus" else 0x57F287,
    }
    print(f"  Posting roast in thread...")
    roast_resp = discord_post_message(thread_id, discord_token,
                                      {"embeds": [roast_embed], "allowed_mentions": {"parse": []}})
    roast_msg_id = roast_resp.get("id", "")
    print(f"    roast message_id={roast_msg_id}")

    # 8) Fetch + post GIF (Message 3)
    # giphy_search() tries local key first, falls back to Worker /api/giphy-search proxy.
    gif_url = ""
    gif_msg_id = ""
    if gif_query:
        source = "local key" if giphy_key else "Worker proxy"
        print(f"  Searching Giphy for {gif_query!r} via {source}...")
        gif_url = giphy_search(giphy_key, gif_query)
        if gif_url:
            gif_embed = {"image": {"url": gif_url}, "color": 0x202225}
            gif_resp = discord_post_message(thread_id, discord_token,
                                            {"embeds": [gif_embed], "allowed_mentions": {"parse": []}})
            gif_msg_id = gif_resp.get("id", "")
            print(f"    gif message_id={gif_msg_id}  url={gif_url[:80]}")
        else:
            print(f"    (no Giphy result for query — neither local key nor proxy returned a URL)")

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


def main():
    parser = argparse.ArgumentParser(description="A/B test fire for the trade roast")
    parser.add_argument("--trade", type=int, choices=[TRADE_1_TS, TRADE_2_TS],
                        help="Only fire this trade timestamp (else both)")
    parser.add_argument("--model", choices=["opus", "sonnet", "both"], default=None,
                        help="opus (default) | sonnet | both for A/B compare")
    parser.add_argument("--dry-run", action="store_true",
                        help="Build context + generate roast but don't post to Discord")
    parser.add_argument("--context-only", action="store_true",
                        help="Just build + print the context. No Anthropic call, no posting. Useful for previewing what the LLM would see without needing the API key.")
    args = parser.parse_args()

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
        return

    # Validate creds up front so we fail fast
    print("Sourcing credentials...")
    anthropic_key = get_anthropic_key()
    discord_token = get_discord_token() if not args.dry_run else "(skipped — dry-run)"
    giphy_key = get_giphy_key()
    os.environ["ANTHROPIC_API_KEY"] = anthropic_key  # SDK reads from env
    client = anthropic.Anthropic()
    print(f"  Anthropic key: sourced ({len(anthropic_key)} chars)")
    print(f"  Discord token: sourced ({len(discord_token) if not args.dry_run else 0} chars)")
    print(f"  Giphy: {'local key (' + str(len(giphy_key)) + ' chars)' if giphy_key else 'Worker /api/giphy-search proxy (no local key)'}")
    print(f"  Target channel: {TEST_CHANNEL_ID}")
    print(f"  Trades: {trades}")
    print(f"  Models: {models}")
    print(f"  Dry run: {args.dry_run}")

    results = []
    for ts in trades:
        for m_label in models:
            try:
                r = fire_one(client, discord_token, giphy_key, m_label, MODELS[m_label],
                             ts, args.dry_run)
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


if __name__ == "__main__":
    main()
