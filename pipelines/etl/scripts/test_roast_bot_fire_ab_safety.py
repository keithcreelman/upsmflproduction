#!/usr/bin/env python3
"""ROAST A/B FIRE SAFETY TEST -- ordinary test commands can never post to Discord.

WHY (Keith 2026-10-12)
======================
pipelines/etl/scripts/test_fire_ab.py was named like a test, so any "run every
test_*.py" loop or pytest run would have executed it -- and with no flags it
POSTED the Trade Roast Bot A/B fire to Discord (token from env or Keychain).
It is now roast_bot_fire_ab.py: a dry run by default, and a Discord write
needs BOTH --send --confirm-send=<the exact channel id> AND
UPS_ALLOW_ROAST_AB_DISCORD_SEND=1.

WHAT IS PROVEN HERE (no network, no secrets)
============================================
Sockets, DNS, urllib.request.urlopen and subprocess (the Keychain) are
replaced with stubs that RECORD every attempt and RAISE. anthropic and the
MFL/trade modules the fire script imports are in-memory fakes.
1. Discovery: tests/*.test.mjs, tests/*.test.js, the runbook's tests/*.mjs +
   tests/*.js sweep, pipelines/etl/scripts/test_*.py, pytest's default
   test_*.py / *_test.py and unittest's test*.py do not include the fire
   script, and test_fire_ab.py is gone.
2. main() with no flags, --send only, the env var only, a mismatched or
   missing confirmation, --confirm-send without --send, the old --dry-run
   flag and --context-only: no Discord function is called, no request or
   socket is attempted, no Keychain read. Refusals exit 2 before anything
   else runs; dry runs exit 0 and print the destination + proposed messages.
3. discord_post_message() called directly without the env var refuses
   before any request.
4. The REAL trade_roast_context would read the Keychain for the Discord
   token in a dry run; the fire script's dry-run patch stops that.
5. Positive control: with every gate met, the destination and messages are
   printed BEFORE the first POST, and the POSTs go to the confirmed channel
   and then the new thread (answered by a recording fake) -- so the
   harness above would catch a post if one were attempted.

Usage:
  python3 pipelines/etl/scripts/test_roast_bot_fire_ab_safety.py
"""
from __future__ import annotations

import contextlib
import fnmatch
import importlib.util
import inspect
import io
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import types
import urllib.request
from pathlib import Path
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
FIRE_PATH = HERE / "roast_bot_fire_ab.py"
CHANNEL = "1089538054236160010"
SEND_ENV = "UPS_ALLOW_ROAST_AB_DISCORD_SEND"

fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


# ── Network / Keychain blockers: record every attempt, then raise ──────────
NET = []          # (kind, method, target) for every urlopen / socket attempt
KEYCHAIN = []     # every subprocess call (the scripts only use it for `security`)
FAKE_DISCORD = {"on": False, "next": 0}   # positive control only


class _FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def blocked_urlopen(req, *a, **k):
    url = getattr(req, "full_url", req)
    method = req.get_method() if hasattr(req, "get_method") else "GET"
    NET.append(("urlopen", method, url, dict(getattr(req, "headers", {}) or {})))
    if FAKE_DISCORD["on"] and str(url).startswith("https://discord.com/api/v10/"):
        FAKE_DISCORD["next"] += 1
        kind = "thread" if str(url).endswith("/threads") else "msg"
        return _FakeResp(json.dumps({"id": f"fake-{kind}-{FAKE_DISCORD['next']}"}).encode())
    raise RuntimeError(f"network blocked in test: {method} {url}")


def blocked_socket(*a, **k):
    NET.append(("socket", "", repr(a[1:2] or a[:1]), {}))
    raise RuntimeError("network blocked in test (socket)")


def blocked_subprocess(*a, **k):
    cmd = a[0] if a else k.get("args")
    KEYCHAIN.append(cmd)
    raise subprocess.CalledProcessError(1, cmd, "", "blocked in test (no Keychain)")


urllib.request.urlopen = blocked_urlopen
socket.socket.connect = blocked_socket
socket.socket.connect_ex = blocked_socket
socket.create_connection = blocked_socket
socket.getaddrinfo = blocked_socket
subprocess.run = blocked_subprocess
subprocess.Popen = blocked_subprocess
time.sleep = lambda s: None

# No real secrets in this process, ever.
for var in ("DISCORD_BOT_TOKEN", "GIPHY_API_KEY", SEND_ENV):
    os.environ.pop(var, None)
os.environ["ANTHROPIC_API_KEY"] = "sk-ant-fake-for-test"


# ── 1. discovery ───────────────────────────────────────────────────────────
print("1. normal test discovery cannot reach the fire script")
check("fire script lives at roast_bot_fire_ab.py", FIRE_PATH.exists())
check("old test_fire_ab.py is gone", not (HERE / "test_fire_ab.py").exists())
NAME_PATTERNS = ["test_*.py", "*_test.py", "test*.py", "*.test.mjs", "*.test.js", "*.test.*"]
check("its name matches no discovery pattern",
      not any(fnmatch.fnmatch(FIRE_PATH.name, p) for p in NAME_PATTERNS), FIRE_PATH.name)

discovered = set()
for pat in ("tests/*.test.mjs", "tests/*.test.js", "tests/*.mjs", "tests/*.js"):
    discovered |= {p.resolve() for p in REPO.glob(pat)}
discovered |= {p.resolve() for p in HERE.glob("test_*.py")}
SKIP_DIRS = {".git", "node_modules", ".claude", "__pycache__", ".venv", "venv"}
for root, dirs, files in os.walk(REPO):
    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
    for f in files:
        if any(fnmatch.fnmatch(f, p) for p in ("test_*.py", "*_test.py", "test*.py")):
            discovered.add((Path(root) / f).resolve())
check("discovery sets are non-empty (the globs work)", len(discovered) > 20, str(len(discovered)))
check("the fire script is in none of them", FIRE_PATH.resolve() not in discovered)
check("no discovered file is named test_fire_ab.py",
      not any(p.name == "test_fire_ab.py" for p in discovered))


# ── Fakes for everything the fire script imports ───────────────────────────
CALLS = {"anthropic": [], "fetch_trades": 0, "context_token_reads": 0}


def fake_module(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


class _FakeMessages:
    def create(self, **kw):
        CALLS["anthropic"].append(kw.get("model"))
        return SimpleNamespace(usage=SimpleNamespace(input_tokens=100, output_tokens=40),
                               content=[SimpleNamespace(text="Fake roast line.\n[GIF: sad trombone]")])


class _FakeAnthropic:
    def __init__(self, *a, **k):
        self.messages = _FakeMessages()


def _fake_fetch_trades():
    CALLS["fetch_trades"] += 1
    return [{"timestamp": str(ts), "franchise": "0001", "franchise2": "0002",
             "comments": "", "franchise2_gave_up": "15000"} for ts in (1778546756, 1775772921)]


def _original_context_token_reader():
    # Stands in for trade_roast_context._discord_bot_token (env -> Keychain).
    CALLS["context_token_reads"] += 1
    return ""


def _fake_build_context(trade, extension_years=0, extension_player_id=""):
    CTX._discord_bot_token()  # the real builder reads it via fetch_recent_bot_posts
    return {"trade": trade.get("timestamp")}


_empty = lambda *a, **k: {}
fake_module("anthropic", Anthropic=_FakeAnthropic)
fake_module("trade_grader", fetch_trades=_fake_fetch_trades,
            analyze_trade=lambda *a: SimpleNamespace(
                side_a=SimpleNamespace(franchise_id="0001", franchise_name="Alpha"),
                side_b=SimpleNamespace(franchise_id="0002", franchise_name="Bravo")),
            load_franchises=lambda: {"0001": "Alpha", "0002": "Bravo"},
            load_players_map=_empty, load_rosters=_empty, load_rollover=_empty,
            load_auction_pool=_empty, load_team_caps=_empty, load_future_picks=_empty,
            load_trade_value_model=_empty)
CTX = fake_module("trade_roast_context", build_trade_roast_context=_fake_build_context,
                  context_to_prompt_text=lambda ctx: f"FAKE CONTEXT {ctx}",
                  _discord_bot_token=_original_context_token_reader)
fake_module("trade_announcement",
            build_announcement_embed=lambda analysis, franchises, iso: {"title": "FAKE TRADE EMBED"})
fake_module("content_engine", ROAST_SYSTEM="fake system prompt")

spec = importlib.util.spec_from_file_location("roast_bot_fire_ab", FIRE_PATH)
fire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fire)
TMP = Path(tempfile.mkdtemp(prefix="roast_ab_safety_"))
fire.SCRIPT_DIR = TMP / "scripts"           # audit log lands in TMP, not the repo

DISCORD_FN_CALLS = []
for fn_name in ("_discord_request", "discord_post_message", "discord_create_thread_from_message"):
    def _wrap(*a, _orig=getattr(fire, fn_name), _name=fn_name, **k):
        DISCORD_FN_CALLS.append((_name, a[:2]))
        return _orig(*a, **k)
    setattr(fire, fn_name, _wrap)


def run_main(argv, send_env=None, extra_env=None):
    NET.clear(); KEYCHAIN.clear(); DISCORD_FN_CALLS.clear()
    CALLS.update(anthropic=[], fetch_trades=0, context_token_reads=0)
    CTX._discord_bot_token = _original_context_token_reader
    os.environ.pop(SEND_ENV, None)
    if send_env is not None:
        os.environ[SEND_ENV] = send_env
    for k, v in (extra_env or {}).items():
        os.environ[k] = v
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            try:
                rc = fire.main(argv)
            except SystemExit as e:
                rc = e.code if isinstance(e.code, int) else 1
            except Exception as e:     # a crash is a result too -- the checks still run
                rc = f"crashed: {type(e).__name__}: {e}"
    finally:
        os.environ.pop(SEND_ENV, None)
        for k in (extra_env or {}):
            os.environ.pop(k, None)
    return rc, out.getvalue()


def nothing_sent(label, rc, out):
    check(f"{label}: no Discord function called", DISCORD_FN_CALLS == [], str(DISCORD_FN_CALLS))
    check(f"{label}: no request / socket attempted", NET == [], str(NET))
    check(f"{label}: no Keychain read", KEYCHAIN == [] and CALLS["context_token_reads"] == 0,
          f"{KEYCHAIN} context_token_reads={CALLS['context_token_reads']}")


# ── 2. entry point: nothing an ordinary command does can post ──────────────
print("2. no flags / one gate / wrong confirmation never posts")
rc, out = run_main([])
check("no flags: dry run, exit 0", rc == 0 and "DRY RUN — nothing will be posted" in out, out[-800:])
nothing_sent("no flags", rc, out)
check("no flags: prints the destination channel", f"DESTINATION: channel {CHANNEL}" in out, out[-800:])
check("no flags: prints the exact proposed messages",
      "FAKE TRADE EMBED" in out and "Fake roast line." in out and "'sad trombone'" in out, out[-800:])
check("no flags: dry run still generates text via Anthropic (fake), opus x 2 trades",
      CALLS["anthropic"] == ["claude-opus-4-6", "claude-opus-4-6"], str(CALLS["anthropic"]))
check("no flags: audit log written to the temp dir, not the repo",
      (TMP / "data" / "ab_test_fire.log").exists())

REFUSALS = [
    ("--send only", ["--send"], None, ["--confirm-send=", f"{SEND_ENV}=1"]),
    ("--send + env, no confirmation", ["--send"], "1", ["--confirm-send="]),
    ("--send + env + mismatched id", ["--send", "--confirm-send=1234567890"], "1", ["does not match"]),
    ("--send + matching id, no env", ["--send", f"--confirm-send={CHANNEL}"], None, [f"{SEND_ENV}=1"]),
    ("--send + matching id, env='true' (not '1')", ["--send", f"--confirm-send={CHANNEL}"], "true",
     [f"{SEND_ENV}=1"]),
    ("--confirm-send without --send", [f"--confirm-send={CHANNEL}"], "1", ["without --send"]),
]
for label, argv, env, reasons in REFUSALS:
    rc, out = run_main(argv, send_env=env)
    check(f"{label}: refused, exit 2, says why",
          rc == 2 and all(r in out for r in reasons), f"rc={rc} out={out[-600:]}")
    nothing_sent(label, rc, out)
    check(f"{label}: refused before MFL or Anthropic",
          CALLS["fetch_trades"] == 0 and CALLS["anthropic"] == [], str(CALLS))

rc, out = run_main([], send_env="1")
check("env var only: dry run, exit 0", rc == 0 and "DRY RUN — nothing will be posted" in out, out[-600:])
nothing_sent("env var only", rc, out)

rc, out = run_main(["--dry-run"], send_env="1")
check("old --dry-run flag: rejected by argparse (exit 2)", rc == 2, f"rc={rc}")
nothing_sent("old --dry-run flag", rc, out)

rc, out = run_main(["--context-only"])
check("--context-only: exit 0, no Anthropic", rc == 0 and CALLS["anthropic"] == [], f"rc={rc} {CALLS}")
nothing_sent("--context-only", rc, out)


# ── 3. backstop inside the request helper ──────────────────────────────────
print("3. the Discord helper itself refuses without the env var")
NET.clear(); DISCORD_FN_CALLS.clear()
try:
    fire.discord_post_message(CHANNEL, "fake-token", {"content": "x"})
    refused = False
except SystemExit as e:
    refused = SEND_ENV in str(e)
except Exception:            # reached the (blocked) network instead of refusing
    refused = False
check("direct discord_post_message() refuses", refused)
check("...before any request", NET == [], str(NET))


# ── 4. the real context builder's Keychain read is skipped in dry runs ─────
print("4. real trade_roast_context: dry-run patch stops its Discord-token Keychain read")
saved = {n: sys.modules.pop(n) for n in ("trade_grader", "trade_roast_context")}
real_spec = importlib.util.spec_from_file_location("real_trade_roast_context", HERE / "trade_roast_context.py")
real_ctx = importlib.util.module_from_spec(real_spec)
real_spec.loader.exec_module(real_ctx)
sys.modules.update(saved)
check("fetch_recent_bot_posts reads the token via _discord_bot_token()",
      "_discord_bot_token()" in inspect.getsource(real_ctx.fetch_recent_bot_posts))
NET.clear(); KEYCHAIN.clear()
with contextlib.redirect_stdout(io.StringIO()):
    posts = real_ctx.fetch_recent_bot_posts()
check("unpatched + no env token: it WOULD read the Keychain",
      posts == [] and any("find-generic-password" in " ".join(c) for c in KEYCHAIN), str(KEYCHAIN))
run_main([])                                  # a dry run installs the patch on CTX
dry_run_patch = CTX._discord_bot_token
check("a dry run replaces the context token reader", dry_run_patch is not _original_context_token_reader)
real_ctx._discord_bot_token = dry_run_patch
NET.clear(); KEYCHAIN.clear()
with contextlib.redirect_stdout(io.StringIO()):
    posts = real_ctx.fetch_recent_bot_posts()
check("patched: no Keychain read, no request, empty list", posts == [] and KEYCHAIN == [] and NET == [],
      f"{posts} {KEYCHAIN} {NET}")


# ── 5. positive control: every gate met → posts happen, after the preview ──
print("5. positive control: all gates met (fake Discord) -> preview printed, then POSTs")
FAKE_DISCORD.update(on=True, next=0)
real_giphy = fire.giphy_search
fire.giphy_search = lambda key, q: "https://media.giphy.com/fake.gif"
try:
    rc, out = run_main(["--send", f"--confirm-send={CHANNEL}", "--trade", "1775772921"], send_env="1",
                       extra_env={"DISCORD_BOT_TOKEN": "fake-bot-token-for-test",
                                  "GIPHY_API_KEY": "fake-giphy-key"})
finally:
    FAKE_DISCORD["on"] = False
    fire.giphy_search = real_giphy
posts = [(m, u) for kind, m, u, h in NET if kind == "urlopen"]
check("send: exit 0", rc == 0, out[-800:])
check("send: preview (destination + messages) printed before the first POST",
      0 <= out.find("DESTINATION:") < out.find("Message 1 →") < out.find("Posting announcement"), out[-1200:])
check("send: announcement → confirmed channel, thread off it, roast + GIF into the thread",
      posts == [("POST", f"https://discord.com/api/v10/channels/{CHANNEL}/messages"),
                ("POST", f"https://discord.com/api/v10/channels/{CHANNEL}/messages/fake-msg-1/threads"),
                ("POST", "https://discord.com/api/v10/channels/fake-thread-2/messages"),
                ("POST", "https://discord.com/api/v10/channels/fake-thread-2/messages")], str(posts))
check("send: token came from env (fake), no Keychain read", KEYCHAIN == [], str(KEYCHAIN))
check("send: the harness saw the Discord functions (so sections 2-3 would have too)",
      [n for n, _ in DISCORD_FN_CALLS].count("discord_post_message") == 3, str(DISCORD_FN_CALLS))

print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILURE(S)'}")


def test_roast_bot_fire_ab_cannot_post():   # pytest entry point; the checks above ran at import
    assert fails == 0


if __name__ == "__main__":
    sys.exit(1 if fails else 0)
