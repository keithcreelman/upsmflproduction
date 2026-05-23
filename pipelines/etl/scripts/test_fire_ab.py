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
import subprocess
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import anthropic

# Ensure local imports resolve when run from anywhere
SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from trade_grader import fetch_trades
from trade_roast_context import (
    build_trade_roast_context,
    context_to_prompt_text,
)
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

def discord_post_message(channel_id: str, token: str, payload: dict) -> dict:
    """POST a message to a Discord channel via REST. No gateway needed."""
    url = f"{DISCORD_API_BASE}/channels/{channel_id}/messages"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "ups-roast-bot-test-fire (https://github.com/keithcreelman/upsmflproduction)",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise SystemExit(f"Discord POST failed {e.code}: {body}") from e


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

def fire_one(client, discord_token, model_label: str, model_id: str,
             trade_ts: int, dry_run: bool) -> dict:
    """Generate one roast and post it. Returns a result summary."""
    print(f"\n=== ts={trade_ts} · model={model_label} ({model_id}) ===")

    trade = find_trade(trade_ts)
    fr_a = trade.get("franchise", "")
    fr_b = trade.get("franchise2", "")
    print(f"  Trade: {fr_a} ↔ {fr_b}")

    # Detect extension hint from comments (same logic the bot uses)
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

    print(f"  Building context...")
    ctx = build_trade_roast_context(trade, extension_years=ext_years,
                                    extension_player_id=ext_player)
    context_text = context_to_prompt_text(ctx)
    print(f"  Context built ({len(context_text)} chars)")

    print(f"  Generating roast via {model_id}...")
    t0 = time.time()
    roast, usage = generate_roast(client, model_id, context_text)
    gen_ms = int((time.time() - t0) * 1000)
    print(f"  Generated in {gen_ms}ms · {len(roast)} chars · "
          f"{usage['input_tokens']} in / {usage['output_tokens']} out tokens · "
          f"${usage['cost_estimate_usd']}")

    # Use embed.description for the roast (4096-char limit vs content's 2000).
    # No footer (Keith 2026-05-22: "I dont need this at the end"). Title carries the model label.
    desc_max = 4096
    if len(roast) > desc_max:
        roast = roast[:desc_max - 20] + "\n[…truncated…]"

    embed = {
        "title": f"A/B — {model_label.upper()}",
        "description": roast,
        "color": 0x5865F2 if model_label == "opus" else 0x57F287,  # blurple Opus, green Sonnet
    }
    payload = {
        "embeds": [embed],
        "allowed_mentions": {"parse": []},
    }

    if dry_run:
        print(f"  DRY-RUN — would post embed ({len(roast)} chars in description) to channel {TEST_CHANNEL_ID}")
        return {
            "ok": True, "dry_run": True,
            "trade_ts": trade_ts, "model": model_label,
            "context_chars": len(context_text),
            "roast_chars": len(roast),
            "gen_ms": gen_ms,
            "usage": usage,
        }

    print(f"  Posting to channel {TEST_CHANNEL_ID}...")
    result = discord_post_message(TEST_CHANNEL_ID, discord_token, payload)
    msg_id = result.get("id", "")
    print(f"  Posted: message_id={msg_id}")
    return {
        "ok": True,
        "trade_ts": trade_ts, "model": model_label,
        "message_id": msg_id,
        "context_chars": len(context_text),
        "roast_chars": len(roast),
        "gen_ms": gen_ms,
        "usage": usage,
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
    os.environ["ANTHROPIC_API_KEY"] = anthropic_key  # SDK reads from env
    client = anthropic.Anthropic()
    print(f"  Anthropic key: sourced ({len(anthropic_key)} chars)")
    print(f"  Discord token: sourced ({len(discord_token) if not args.dry_run else 0} chars)")
    print(f"  Target channel: {TEST_CHANNEL_ID}")
    print(f"  Trades: {trades}")
    print(f"  Models: {models}")
    print(f"  Dry run: {args.dry_run}")

    results = []
    for ts in trades:
        for m_label in models:
            try:
                r = fire_one(client, discord_token, m_label, MODELS[m_label],
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
                  f"msg_id={r.get('message_id','—'):20}  "
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
