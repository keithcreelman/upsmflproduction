#!/usr/bin/env python3
"""ROAST A/B FIRE SAFETY TEST -- ordinary test commands can never post to
Discord or spend money on Anthropic.

WHY (Keith 2026-10-12)
======================
pipelines/etl/scripts/test_fire_ab.py was named like a test, so any "run every
test_*.py" loop or pytest run would have executed it -- and with no flags it
POSTED the Trade Roast Bot A/B fire to Discord (token from env or Keychain).
It is now roast_bot_fire_ab.py, and Keith's rules are:
  - no option        usage + preflight plan only: no Anthropic, no Discord
                     read or write, no network, no secrets; exit 0
  - --context-only   OFFLINE: local files only -- no network, no token, no
                     Keychain, no Anthropic; says the duplicate check runs only
                     with --generate / --send
  - --generate       paid Anthropic generation + a dry-run preview; makes the
                     SAME reads as a send (Discord recent-posts duplicate
                     check, Giphy) and differs ONLY at the write step
  - --send           implies --generate; needs --confirm-send=<exact channel
                     id> AND UPS_ALLOW_ROAST_AB_DISCORD_SEND=1 (and a bot
                     token), else exit 2 before any paid/Discord activity
  - WRITE GUARD in _discord_request (the one function that does Discord
    HTTP): only the test channel and threads THIS run created there; the
    production trade channel and every other destination refused, before any
    network attempt
  - the local audit log holds whitelisted ids/counts/flags only
  - every mode prints the preflight plan before any outside activity

WHAT IS PROVEN HERE (no network, no secrets)
============================================
Sockets, DNS, urllib.request.urlopen and subprocess (the Keychain) are
replaced with stubs that RECORD every attempt (with the stdout position at
that moment) and RAISE -- except, when a test turns it on, a recording fake
that answers Discord + Giphy. anthropic and the MFL trade modules are
in-memory fakes. The REAL trade_roast_context is loaded, so its real token
helper (wrapped to count calls) and its real recent-posts read run against
those stubs.
1. Discovery: the usual test globs never include the fire script.
2. Importing the harness, the real context module and the fire script makes
   no network attempt, no Keychain read and no Anthropic client.
3. No option (main([]), the sys.argv CLI path, --trade/--model only, the env
   var only, and a REAL child-process run with real imports and blocked
   network): exit 0, usage + plan, and nothing at all happens.
4. --send gates: every missing/wrong gate -> exit 2, nothing at all.
5. _discord_request(): every non-GET method refuses without the env var
   before any request; GET goes through.
6. WRITE GUARD: production channel, an existing production thread, another
   channel, an unverified thread id, a message id posing as a thread, a
   thread off someone else's message, a thread inside a thread, other
   methods, unparsable paths, a missing confirmation or env permission, and a
   previous run's thread are ALL refused with zero network attempts; the
   test-channel post -> create thread -> reply-in-thread path still works.
7. --context-only: offline even with every credential present -- zero token
   reads, Keychain reads, network attempts, MFL calls or Anthropic.
8. --generate: fake Anthropic called, the recent-posts READ happens (GET
   only) and feeds the prompt, Giphy is searched, zero POSTs; without a
   token it still completes, says the check was skipped, zero Discord calls.
9. --send positive control: preview before the first POST, POSTs go to the
   confirmed channel then the new thread, and the send made EXACTLY the same
   reads, prompts and previewed messages as the generated dry run.
10. Audit log: generate, send and a failing run write no secret, no fetched
   production text, no roast/context text, no free-text error.
Every run that prints a plan is checked to print it before any activity.

Usage:
  env -u UPS_ALLOW_ROAST_AB_DISCORD_SEND -u DISCORD_BOT_TOKEN -u ANTHROPIC_API_KEY \\
      -u GIPHY_API_KEY python3 pipelines/etl/scripts/test_roast_bot_fire_ab_safety.py
"""
from __future__ import annotations

import contextlib
import fnmatch
import importlib.util
import inspect
import io
import json
import os
import re
import shutil
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
DISCORD_API = "https://discord.com/api/v10/"
PLAN_START, PLAN_END = "=== PREFLIGHT PLAN ===", "=== END PLAN ==="
HAVE_REAL_ANTHROPIC = importlib.util.find_spec("anthropic") is not None
_REAL_SUBPROCESS = (subprocess.run, subprocess.Popen)   # only for the child-process check in section 3

fails = 0


def check(name, cond, detail=""):
    global fails
    if cond:
        print(f"  ok   {name}")
    else:
        fails += 1
        print(f"  FAIL {name}" + (f"\n         {detail}" if detail else ""))


# ── Network / Keychain blockers: record every attempt, then raise ──────────
NET = []          # (kind, method, url) for every urlopen / socket attempt
KEYCHAIN = []     # every subprocess call (the scripts only use it for `security`)
EVENTS = []       # (what, stdout position) for every outside-world touch
OUT = {"buf": None}
# Recording fake Discord + Giphy, off unless a test turns it on. Discord ids
# are snowflakes (digits) like the real API; a created thread's parent_id is
# the channel in the request path unless a test overrides it.
FAKE_NET = {"on": False, "next": 0, "thread_parent": None}
FAKE_ID_BASE = 900000000000000000
BOT_ID = "555000000000000001"
PRIOR_POST = "Earlier fake roast line that the duplicate check must ban"
GIF_URL = "https://media.giphy.com/fake.gif"


def fake_id(n):
    return str(FAKE_ID_BASE + n)


def _event(what):
    buf = OUT["buf"]
    EVENTS.append((what, len(buf.getvalue()) if buf is not None else -1))


class _FakeResp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _json_resp(obj):
    return _FakeResp(json.dumps(obj).encode())


def blocked_urlopen(req, *a, **k):
    url = str(getattr(req, "full_url", req))
    method = req.get_method() if hasattr(req, "get_method") else "GET"
    NET.append(("urlopen", method, url))
    _event(f"urlopen {method} {url}")
    if FAKE_NET["on"]:
        if url.startswith(DISCORD_API) and method == "GET" and url.endswith("/users/@me"):
            return _json_resp({"id": BOT_ID})
        if url.startswith(DISCORD_API) and method == "GET" and "/messages?" in url:
            return _json_resp([{"author": {"id": BOT_ID, "bot": True}, "content": PRIOR_POST}])
        if url.startswith(DISCORD_API) and method == "POST":
            FAKE_NET["next"] += 1
            new_id = fake_id(FAKE_NET["next"])
            m = re.match(rf"{re.escape(DISCORD_API)}channels/([^/]+)/messages/[^/]+/threads$", url)
            if m:
                return _json_resp({"id": new_id, "type": 11,
                                   "parent_id": FAKE_NET["thread_parent"] or m.group(1)})
            return _json_resp({"id": new_id})
        if url.startswith("https://api.giphy.com/") and method == "GET":
            return _json_resp({"data": [{"images": {"original": {"url": GIF_URL}}}]})
    raise RuntimeError(f"network blocked in test: {method} {url}")


def blocked_socket(*a, **k):
    NET.append(("socket", "", repr(a[1:2] or a[:1])))
    _event("socket")
    raise RuntimeError("network blocked in test (socket)")


def blocked_subprocess(*a, **k):
    cmd = a[0] if a else k.get("args")
    KEYCHAIN.append(cmd)
    _event(f"subprocess {cmd}")
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


@contextlib.contextmanager
def temp_env(**kv):
    saved = {k: os.environ.get(k) for k in kv}
    for k, v in kv.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


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


# ── Real trade_roast_context + fakes for everything else the script imports ─
CALLS = {"anthropic": [], "prompts": [], "anthropic_clients": 0, "mfl": 0, "context_builds": 0,
         "token_reads": 0, "anthropic_raise": None}


def fake_module(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m
    return m


class _FakeMessages:
    def create(self, **kw):
        _event("anthropic.messages.create")
        CALLS["anthropic"].append(kw.get("model"))
        CALLS["prompts"].append(kw["messages"][0]["content"])
        if CALLS["anthropic_raise"]:
            raise RuntimeError(CALLS["anthropic_raise"])
        return SimpleNamespace(usage=SimpleNamespace(input_tokens=100, output_tokens=40),
                               content=[SimpleNamespace(text="Fake roast line.\n[GIF: sad trombone]")])


class _FakeAnthropic:
    def __init__(self, *a, **k):
        _event("anthropic.Anthropic()")
        CALLS["anthropic_clients"] += 1
        self.messages = _FakeMessages()


def _mfl(name, result):
    def f(*a, **k):
        _event(f"mfl {name}")
        CALLS["mfl"] += 1
        return result() if callable(result) else result
    return f


_TRADES = lambda: [{"timestamp": str(ts), "franchise": "0001", "franchise2": "0002", "comments": "",
                    "franchise2_gave_up": "15000"} for ts in (1778546756, 1775772921)]


def _fake_build_context(trade, extension_years=0, extension_player_id=""):
    # Stands in for the heavy MFL/Worker builder, but runs the REAL Discord
    # step the real builder runs: format_recent_bot_posts_section() ->
    # fetch_recent_bot_posts() -> _discord_bot_token() (env -> Keychain).
    _event("context build")
    CALLS["context_builds"] += 1
    return {"trade": trade.get("timestamp"),
            "recent_bot_posts_text": REAL_CTX.format_recent_bot_posts_section()}


sys.path.insert(0, str(HERE))
_real_spec = importlib.util.spec_from_file_location("trade_roast_context", HERE / "trade_roast_context.py")
REAL_CTX = importlib.util.module_from_spec(_real_spec)
_real_spec.loader.exec_module(REAL_CTX)           # imports the real trade_grader too
_REAL_TOKEN_FN = REAL_CTX._discord_bot_token


def _counting_token_reader():
    # The REAL helper (env -> Keychain), counted so a read is visible even
    # when the token comes from env (no subprocess to record).
    _event("token read")
    CALLS["token_reads"] += 1
    return _REAL_TOKEN_FN()


REAL_CTX._discord_bot_token = _counting_token_reader
REAL_TOKEN_READER = _counting_token_reader
TRADE_CHANNEL = REAL_CTX.DISCORD_TRADE_CHANNEL_ID

fake_module("anthropic", Anthropic=_FakeAnthropic)
fake_module("trade_grader", fetch_trades=_mfl("fetch_trades", _TRADES),
            analyze_trade=_mfl("analyze_trade", SimpleNamespace(
                side_a=SimpleNamespace(franchise_id="0001", franchise_name="Alpha"),
                side_b=SimpleNamespace(franchise_id="0002", franchise_name="Bravo"))),
            load_franchises=_mfl("load_franchises", {"0001": "Alpha", "0002": "Bravo"}),
            **{n: _mfl(n, {}) for n in ("load_players_map", "load_rosters", "load_rollover",
                                        "load_auction_pool", "load_team_caps", "load_future_picks",
                                        "load_trade_value_model")})
REAL_CTX.build_trade_roast_context = _fake_build_context
REAL_CTX.context_to_prompt_text = lambda ctx: (f"FAKE CONTEXT ts={ctx['trade']}"
                                               f"{ctx.get('recent_bot_posts_text', '')}")
sys.modules["trade_roast_context"] = REAL_CTX
fake_module("trade_announcement",
            build_announcement_embed=lambda analysis, franchises, iso: {"title": "FAKE TRADE EMBED"})
fake_module("content_engine", ROAST_SYSTEM="fake system prompt")

spec = importlib.util.spec_from_file_location("roast_bot_fire_ab", FIRE_PATH)
fire = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fire)
TMP = Path(tempfile.mkdtemp(prefix="roast_ab_safety_"))
fire.SCRIPT_DIR = TMP / "scripts"           # audit log lands in TMP, not the repo
AUDIT = TMP / "data" / "ab_test_fire.log"
REAL_SNAPSHOT_DIR = fire.SNAPSHOT_DIR

DISCORD_FN_CALLS = []
for fn_name in ("_discord_request", "discord_post_message", "discord_create_thread_from_message"):
    def _wrap(*a, _orig=getattr(fire, fn_name), _name=fn_name, **k):
        _event(f"fire.{_name}")
        DISCORD_FN_CALLS.append((_name, a[:2]))
        return _orig(*a, **k)
    setattr(fire, fn_name, _wrap)


# ── 2. the harness itself: importing + discovery touch nothing ─────────────
print("2. importing the harness, the real context module and the fire script touches nothing")
check("no network attempt", NET == [], str(NET))
check("no Keychain / subprocess call", KEYCHAIN == [], str(KEYCHAIN))
check("no token read", CALLS["token_reads"] == 0, str(CALLS))
check("no Anthropic client constructed or called",
      CALLS["anthropic_clients"] == 0 and CALLS["anthropic"] == [], str(CALLS))
check("no recorded event of any kind", EVENTS == [], str(EVENTS))
check("SEND env var and Discord token are absent from this process",
      SEND_ENV not in os.environ and "DISCORD_BOT_TOKEN" not in os.environ)
check("write state starts empty", fire._RUN == {"confirmed_channel": None, "posted_messages": set(),
                                                "created_threads": set()}, str(fire._RUN))


LAST = {}


def run_main(argv, send_env=None, extra_env=None, via_sys_argv=False):
    NET.clear(); KEYCHAIN.clear(); DISCORD_FN_CALLS.clear(); EVENTS.clear()
    CALLS.update(anthropic=[], prompts=[], anthropic_clients=0, mfl=0, context_builds=0,
                 token_reads=0)
    REAL_CTX._discord_bot_token = REAL_TOKEN_READER
    FAKE_NET["next"] = 0
    env = {SEND_ENV: send_env}
    env.update(extra_env or {})
    out = io.StringIO()
    OUT["buf"] = out
    try:
        with temp_env(**env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            try:
                if via_sys_argv:
                    saved_argv, sys.argv = sys.argv, ["roast_bot_fire_ab.py", *argv]
                    try:
                        rc = fire.main()
                    finally:
                        sys.argv = saved_argv
                else:
                    rc = fire.main(argv)
            except SystemExit as e:
                rc = e.code if isinstance(e.code, int) else 1
            except Exception as e:     # a crash is a result too -- the checks still run
                rc = f"crashed: {type(e).__name__}: {e}"
    finally:
        OUT["buf"] = None
    LAST.update(events=list(EVENTS),
                token_reader_replaced=REAL_CTX._discord_bot_token is not REAL_TOKEN_READER,
                run_state_after=dict(fire._RUN))
    REAL_CTX._discord_bot_token = REAL_TOKEN_READER
    return rc, out.getvalue()


def plan_row(out, key):
    s, e = out.find(PLAN_START), out.find(PLAN_END)
    for line in out[s:e].splitlines():
        m = re.match(rf"\s+{re.escape(key)}:\s+(.*)$", line)
        if m:
            return m.group(1)
    return None


def plan_first(label, out):
    s, e = out.find(PLAN_START), out.find(PLAN_END)
    first = min((p for _, p in LAST["events"]), default=None)
    check(f"{label}: plan printed before any network / Keychain / Anthropic / MFL activity",
          0 <= s < e and (first is None or first >= e + len(PLAN_END)),
          f"plan at {s}..{e}, first event at {first}: {LAST['events'][:2]}")


def nothing_at_all(label):
    check(f"{label}: no request / socket attempted", NET == [], str(NET))
    check(f"{label}: no Keychain read, no token read", KEYCHAIN == [] and CALLS["token_reads"] == 0,
          f"{KEYCHAIN} token_reads={CALLS['token_reads']}")
    check(f"{label}: no Anthropic client constructed or called",
          CALLS["anthropic_clients"] == 0 and CALLS["anthropic"] == [], str(CALLS))
    check(f"{label}: no MFL read, no context build",
          CALLS["mfl"] == 0 and CALLS["context_builds"] == 0, str(CALLS))
    check(f"{label}: no Discord function called", DISCORD_FN_CALLS == [], str(DISCORD_FN_CALLS))
    check(f"{label}: no recorded event of any kind", LAST["events"] == [], str(LAST["events"]))


def discord_reqs():
    return [(m, u) for kind, m, u in NET if u.startswith(DISCORD_API)]


# ── 3. no option: usage + plan, nothing else ───────────────────────────────
print("3. no option: usage + plan only -- no Anthropic, no network, no Keychain, no write")
rc, out = run_main([])
check("no option: exit 0", rc == 0, f"rc={rc}")
check("no option: usage printed", "usage: roast_bot_fire_ab.py" in out and "--generate" in out, out[:400])
check("no option: plan says Network NO, Anthropic NO, Discord read NO, Discord write NO",
      plan_row(out, "Network") == "NO" and (plan_row(out, "Anthropic") or "").startswith("NO")
      and plan_row(out, "Discord read") == "NO" and plan_row(out, "Discord write") == "NO",
      out[out.find(PLAN_START):])
check("no option: explains generation needs an explicit option",
      "needs an explicit option" in out and "--generate" in out.split(PLAN_END)[1], out[-500:])
nothing_at_all("no option")
plan_first("no option", out)
check("no option: no audit log written", not AUDIT.exists())

rc, out = run_main([], via_sys_argv=True)
check("CLI (sys.argv, no option): exit 0 + plan", rc == 0 and PLAN_START in out, f"rc={rc}")
nothing_at_all("CLI (sys.argv, no option)")

rc, out = run_main(["--trade", "1775772921", "--model", "both"])
check("--trade/--model only: plan only, exit 0, selection shown",
      rc == 0 and "trades [1775772921] × models ['opus', 'sonnet']" in out, out[-600:])
nothing_at_all("--trade/--model only")
plan_first("--trade/--model only", out)

rc, out = run_main([], send_env="1")
check("env var only: plan only, exit 0, Discord write NO",
      rc == 0 and plan_row(out, "Discord write") == "NO", out[-600:])
nothing_at_all("env var only")

if HAVE_REAL_ANTHROPIC:
    # The real CLI in a fresh interpreter: REAL modules, network + Keychain
    # blocked and recorded, Anthropic client construction recorded.
    CHILD = r'''
import json, socket, subprocess, sys, urllib.request, runpy
ATTEMPTS = []
def rec(kind):
    def f(*a, **k):
        ATTEMPTS.append(kind)
        raise RuntimeError("blocked in child: " + kind)
    return f
urllib.request.urlopen = rec("urlopen")
socket.socket.connect = rec("socket"); socket.socket.connect_ex = rec("socket")
socket.create_connection = rec("socket"); socket.getaddrinfo = rec("dns")
subprocess.run = rec("subprocess"); subprocess.Popen = rec("subprocess")
import anthropic
anthropic.Anthropic.__init__ = rec("anthropic.Anthropic()")
script, extra = sys.argv[1], sys.argv[2:]
sys.argv = [script, *extra]
code = 0
try:
    runpy.run_path(script, run_name="__main__")
except SystemExit as e:
    code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
print("CHILD_RESULT " + json.dumps({"code": code, "attempts": ATTEMPTS}))
'''
    child_env = {k: v for k, v in os.environ.items()
                 if k not in ("DISCORD_BOT_TOKEN", "ANTHROPIC_API_KEY", "GIPHY_API_KEY", SEND_ENV)}

    def run_child(*extra):
        subprocess.Popen = _REAL_SUBPROCESS[1]          # run() spawns via the module's Popen
        try:
            res = _REAL_SUBPROCESS[0]([sys.executable, "-c", CHILD, str(FIRE_PATH), *extra],
                                      capture_output=True, text=True, timeout=180, env=child_env,
                                      cwd=str(TMP))
        finally:
            subprocess.Popen = blocked_subprocess
        m = re.search(r"^CHILD_RESULT (.*)$", res.stdout, re.M)
        return (json.loads(m.group(1)) if m else {}), res

    child, res = run_child()
    check("real CLI, no option: exit 0, nothing attempted (no network, Keychain or Anthropic)",
          child.get("code") == 0 and child.get("attempts") == [],
          f"{child} stderr={res.stderr[-400:]}")
    check("real CLI, no option: usage + plan printed",
          "usage: roast_bot_fire_ab.py" in res.stdout and PLAN_START in res.stdout
          and (plan_row(res.stdout, "Anthropic") or "").startswith("NO"), res.stdout[-600:])
else:
    run_child = None
    print("  skip real-CLI child checks: the anthropic package is not installed here")


# ── 4. --send gates ────────────────────────────────────────────────────────
print("4. --send without every gate: exit 2 before anything runs")
REFUSALS = [
    ("--send only", ["--send"], None, ["--confirm-send=", f"{SEND_ENV}=1"]),
    ("--send + env, no confirmation", ["--send"], "1", ["--confirm-send="]),
    ("--send + env + mismatched id", ["--send", "--confirm-send=1234567890"], "1", ["does not match"]),
    ("--send + matching id, no env", ["--send", f"--confirm-send={CHANNEL}"], None, [f"{SEND_ENV}=1"]),
    ("--send + matching id, env='true' (not '1')", ["--send", f"--confirm-send={CHANNEL}"], "true",
     [f"{SEND_ENV}=1"]),
    ("--confirm-send without --send", [f"--confirm-send={CHANNEL}"], "1", ["without --send"]),
    ("--generate + --confirm-send, no --send", ["--generate", f"--confirm-send={CHANNEL}"], "1",
     ["without --send"]),
]
for label, argv, env, reasons in REFUSALS:
    rc, out = run_main(argv, send_env=env)
    refusal_text = out[out.find("REFUSING"):] if "REFUSING" in out else ""
    check(f"{label}: refused, exit 2, says why",
          rc == 2 and all(r in refusal_text for r in reasons), f"rc={rc} out={out[-600:]}")
    check(f"{label}: plan says REFUSED and Network/Anthropic/Discord NO",
          (plan_row(out, "Mode") or "").startswith("REFUSED")
          and plan_row(out, "Network") == "NO (refused)"
          and plan_row(out, "Anthropic") == "NO (refused)"
          and plan_row(out, "Discord write") == "NO (refused)", out[:900])
    nothing_at_all(label)
    plan_first(label, out)

rc, out = run_main(["--send", f"--confirm-send={CHANNEL}"], send_env="1")   # every gate, NO token
check("--send, gates met but no bot token: exit 2, says why",
      rc == 2 and "needs DISCORD_BOT_TOKEN" in out, f"rc={rc} {out[-500:]}")
check("...only the (stubbed) Keychain token lookup ran -- no MFL, Anthropic, Giphy or Discord",
      CALLS["mfl"] == 0 and CALLS["anthropic_clients"] == 0 and NET == [] and DISCORD_FN_CALLS == []
      and len(KEYCHAIN) == 1 and "discord_bot_token" in KEYCHAIN[0], f"{CALLS} {NET} {KEYCHAIN}")
plan_first("--send without token", out)

for label, argv in (("old --dry-run flag", ["--dry-run"]),
                    ("--context-only + --generate", ["--context-only", "--generate"]),
                    ("--context-only + --send (all gates)", ["--context-only", "--send",
                                                             f"--confirm-send={CHANNEL}"])):
    rc, out = run_main(argv, send_env="1")
    check(f"{label}: rejected by argparse (exit 2)", rc == 2, f"rc={rc} {out[-300:]}")
    nothing_at_all(label)


# ── 5. backstop inside the request helper: writes only ─────────────────────
print("5. _discord_request(): every write refuses without the env var; GET is a read and passes")
fire._reset_run_state()
for method in ("POST", "post", "PATCH", "PUT", "DELETE"):
    NET.clear()
    try:
        fire._discord_request(method, f"/channels/{CHANNEL}/messages", "fake-token", {"content": "x"})
        refused = False
    except SystemExit as e:
        refused = SEND_ENV in str(e)
    except Exception:            # reached the (blocked) network instead of refusing
        refused = False
    check(f"direct _discord_request({method!r}) refuses before any request", refused and NET == [],
          str(NET))
NET.clear(); FAKE_NET["on"] = True
try:
    got = fire._discord_request("GET", "/users/@me", "fake-token")
except BaseException as e:   # SystemExit included: a refused GET is a failure here
    got = f"{type(e).__name__}: {e}"
finally:
    FAKE_NET["on"] = False
check("direct _discord_request('GET') without the env var reaches the (fake) network",
      got == {"id": BOT_ID} and NET == [("urlopen", "GET", f"{DISCORD_API}users/@me")], f"{got} {NET}")
check("the GET-only allowance is exactly {'GET'}", fire.READ_METHODS == frozenset({"GET"}),
      str(getattr(fire, "READ_METHODS", None)))


# ── 6. WRITE GUARD at the lowest Discord function ──────────────────────────
print("6. write guard: only the test channel + threads THIS run created there; all else refused, no network")
PROD = TRADE_CHANNEL
PROD_THREAD = "1059111651846131999"        # shaped like a thread of the trade channel; not ours
OTHER = "1234567890123456789"
UNVERIFIED_THREAD = "1089538054236160011"  # shaped like a test-channel thread; not created by this run
check("the production trade channel differs from the test channel", PROD and PROD != CHANNEL, PROD)


def attempt(label, fn, reason):
    NET.clear()
    try:
        fn()
        outcome = "ALLOWED"
    except SystemExit as e:
        outcome = str(e)
    except Exception as e:      # reached the (blocked) network instead of refusing
        outcome = f"{type(e).__name__}: {e}"
    check(f"refuses {label}: reason given, zero network attempts",
          "REFUSED" in outcome and reason in outcome and NET == [], f"{outcome} NET={NET}")


def arm():
    """What main() does once --send is accepted: confirmation in run state."""
    fire._reset_run_state()
    return fire.record_send_confirmation(CHANNEL)


body = {"content": "x"}
with temp_env(**{SEND_ENV: "1"}):
    check("record_send_confirmation accepts only the test channel id",
          fire.record_send_confirmation("123") is False and fire._RUN["confirmed_channel"] is None
          and arm() is True and fire._RUN["confirmed_channel"] == CHANNEL, str(fire._RUN))
    # positive control: post -> create thread -> reply in that thread (fake Discord)
    NET.clear(); FAKE_NET.update(on=True, next=0)
    try:
        m_id = fire.discord_post_message(CHANNEL, "tok", body).get("id")
        t_id = fire.discord_create_thread_from_message(CHANNEL, m_id, "tok", "Trade Roast").get("id")
        r_id = fire.discord_post_message(t_id, "tok", body).get("id")
        positive = None
    except BaseException as e:
        positive, m_id, t_id, r_id = f"{type(e).__name__}: {e}", None, None, None
    finally:
        FAKE_NET["on"] = False
    check("positive control: test-channel post -> create thread -> reply in that thread works",
          positive is None
          and [(m, u) for _, m, u in NET] == [
              ("POST", f"{DISCORD_API}channels/{CHANNEL}/messages"),
              ("POST", f"{DISCORD_API}channels/{CHANNEL}/messages/{fake_id(1)}/threads"),
              ("POST", f"{DISCORD_API}channels/{fake_id(2)}/messages")], f"{positive} {NET}")
    check("positive control: run state holds exactly this run's message + thread",
          fire._RUN["posted_messages"] == {fake_id(1)} and fire._RUN["created_threads"] == {fake_id(2)},
          str(fire._RUN))

    # Everything below is armed (env + confirmation) and has a live allowlist.
    attempt("a direct _discord_request POST to the production trade channel",
            lambda: fire._discord_request("POST", f"/channels/{PROD}/messages", "tok", body), "PRODUCTION")
    attempt("discord_post_message() to the production trade channel",
            lambda: fire.discord_post_message(PROD, "tok", body), "PRODUCTION")
    attempt("creating a thread in the production trade channel (even off our message id)",
            lambda: fire.discord_create_thread_from_message(PROD, m_id, "tok", "n"), "PRODUCTION")
    attempt("a reply in an existing production thread",
            lambda: fire.discord_post_message(PROD_THREAD, "tok", body), "neither the test channel")
    attempt("a direct POST into an existing production thread",
            lambda: fire._discord_request("POST", f"/channels/{PROD_THREAD}/messages", "tok", body),
            "neither the test channel")
    attempt("a post to another arbitrary channel",
            lambda: fire.discord_post_message(OTHER, "tok", body), "neither the test channel")
    attempt("a reply in an unverified thread id",
            lambda: fire.discord_post_message(UNVERIFIED_THREAD, "tok", body), "neither the test channel")
    attempt("a reply 'in' a message id this run posted (a message is not a thread)",
            lambda: fire.discord_post_message(m_id, "tok", body), "neither the test channel")
    attempt("a thread off a test-channel message this run did not post",
            lambda: fire.discord_create_thread_from_message(CHANNEL, "1089538054236160099", "tok", "n"),
            "not posted to the test channel by this run")
    attempt("a thread inside a run-created thread",
            lambda: fire.discord_create_thread_from_message(t_id, r_id, "tok", "n"),
            "only be created in the test channel")
    for method in ("PATCH", "PUT", "DELETE", "HEAD"):
        attempt(f"{method} on the test channel's message route",
                lambda method=method: fire._discord_request(method, f"/channels/{CHANNEL}/messages",
                                                            "tok", body), "only POST")
    for bad in ("/channels/abc/messages", f"/channels/{CHANNEL}/messages/", f"/channels/{CHANNEL}/messages?wait=true",
                f"channels/{CHANNEL}/messages", f"/channels/{CHANNEL}/messages/../../{PROD}/messages",
                f"/channels/{CHANNEL}/messages\n", f"/channels/{CHANNEL} /messages", "/channels/１２３/messages",
                f"/webhooks/{CHANNEL}/token", f"/channels/{CHANNEL}/messages/{m_id}", f"/channels/{CHANNEL}/threads",
                f"/channels/{CHANNEL}/messages/{m_id}/threads/x", "", None):
        attempt(f"unparsable / unknown route {bad!r}",
                lambda bad=bad: fire._discord_request("POST", bad, "tok", body), "unrecognised or unparsable")

    # fail closed when the production id can't be told apart from the test channel
    for prod_value, reason in ((CHANNEL, "PRODUCTION"), ("", "can't be verified")):
        saved_prod = REAL_CTX.DISCORD_TRADE_CHANNEL_ID
        REAL_CTX.DISCORD_TRADE_CHANNEL_ID = prod_value
        try:
            attempt(f"a test-channel post when the production id is {prod_value!r} (fail closed)",
                    lambda: fire.discord_post_message(CHANNEL, "tok", body), reason)
        finally:
            REAL_CTX.DISCORD_TRADE_CHANNEL_ID = saved_prod

    # a thread whose create response does not name the test channel as parent is never allowlisted
    NET.clear(); FAKE_NET.update(on=True, thread_parent=PROD)
    try:
        m2 = fire.discord_post_message(CHANNEL, "tok", body).get("id")
        t2 = fire.discord_create_thread_from_message(CHANNEL, m2, "tok", "n").get("id")
    finally:
        FAKE_NET.update(on=False, thread_parent=None)
    check("a thread-create response with parent_id != test channel is not allowlisted",
          t2 and t2 not in fire._RUN["created_threads"], f"{t2} {fire._RUN}")
    attempt("a reply in a thread whose parent was not the test channel",
            lambda: fire.discord_post_message(t2, "tok", body), "neither the test channel")

    # the confirmation is checked at the lowest function, not only in main()
    fire._reset_run_state()
    attempt("a test-channel post with no validated --confirm-send in run state",
            lambda: fire.discord_post_message(CHANNEL, "tok", body), "no validated --confirm-send")
    attempt("a direct _discord_request with no validated --confirm-send",
            lambda: fire._discord_request("POST", f"/channels/{CHANNEL}/messages", "tok", body),
            "no validated --confirm-send")
    # a thread created by a previous run is not a valid destination now
    arm()
    attempt("a reply in a thread created by a PREVIOUS run",
            lambda: fire.discord_post_message(t_id, "tok", body), "neither the test channel")
# env permission is checked at the lowest function too (run state armed, env absent)
arm()
attempt("a test-channel post with run state armed but no env permission",
        lambda: fire.discord_post_message(CHANNEL, "tok", body), f"{SEND_ENV}=1 is not set")
attempt("a thread create with run state armed but no env permission",
        lambda: fire._discord_request("POST", f"/channels/{CHANNEL}/messages/{fake_id(1)}/threads", "tok", body),
        f"{SEND_ENV}=1 is not set")
fire._reset_run_state()


# ── 7. --context-only: OFFLINE ─────────────────────────────────────────────
print("7. --context-only is offline: no token, no Keychain, no network, no MFL, no Anthropic")
SNAP = TMP / "snapshots"
(SNAP / "2026-10-12").mkdir(parents=True)
(SNAP / "2026-10-12" / "transactions.json").write_text(json.dumps({"transactions": {"transaction": [
    {"type": "TRADE", "timestamp": "1775772921", "franchise": "0006", "franchise2": "0005",
     "franchise1_gave_up": "FP_0006_2027_1,FP_0006_2027_2,", "franchise2_gave_up": "14783,BB_20000,",
     "comments": "Fake snapshot comment"}]}}))
(SNAP / "2026-10-12" / "league.json").write_text(json.dumps({"league": {"franchises": {"franchise": [
    {"id": "0005", "name": "Fake Five"}, {"id": "0006", "name": "Fake Six"}]}}}))
EVERY_CRED = {"DISCORD_BOT_TOKEN": "fake-bot-token-for-test", "GIPHY_API_KEY": "fake-giphy-key"}
fire.SNAPSHOT_DIR = SNAP
FAKE_NET["on"] = True                                   # even a reachable fake network must stay unused
try:
    rc, out = run_main(["--context-only"], send_env="1", extra_env=EVERY_CRED)
finally:
    FAKE_NET["on"] = False
    fire.SNAPSHOT_DIR = REAL_SNAPSHOT_DIR
CONTEXT_OUT = out
check("--context-only: exit 0", rc == 0, f"rc={rc} {out[-600:]}")
nothing_at_all("--context-only (every credential present, fake network reachable)")
plan_first("--context-only", out)
check("--context-only: plan says Network NO, Secrets none, duplicate check only with --generate/--send",
      (plan_row(out, "Network") or "").startswith("NO") and (plan_row(out, "Secrets") or "").startswith("none")
      and plan_row(out, "Discord read") == "NO — duplicate check: runs only with --generate / --send"
      and plan_row(out, "Anthropic") == "NO" and plan_row(out, "Discord write") == "NO", out[:1400])
check("--context-only: says it is offline and that the duplicate check runs with --generate",
      "CONTEXT ONLY — OFFLINE" in out and "Duplicate check: runs only with --generate / --send" in out
      and "NOT built here" in out, out[:1600])
check("--context-only: prints the trade from the local snapshot, with its source and names",
      "Source: " in out and "local MFL snapshot 2026-10-12, NOT a live read" in out
      and "0006 Fake Six ↔ 0005 Fake Five" in out and "FP_0006_2027_1, FP_0006_2027_2" in out
      and "14783, BB_20000" in out and "Fake snapshot comment" in out, out[-1500:])
check("--context-only: a trade missing from local snapshots says so (no made-up data)",
      "=== LOCAL CONTEXT for ts=1778546756 ===" in out and "not found in any local MFL snapshot" in out,
      out[-1500:])
check("--context-only: no duplicate-check result and no fetched production text in the output",
      PRIOR_POST not in out and "Duplicate check: done" not in out and "Duplicate check: SKIPPED" not in out)
check("--context-only: the fire source calls no token / network helper in that branch",
      not re.search(r"(get_discord_token|source_discord_token|_discord_bot_token|find_trade|"
                    r"build_trade_roast_context|urlopen|get_anthropic_key|get_giphy_key)\(",
                    inspect.getsource(fire.print_offline_context)), "")
rc, out = run_main(["--context-only", "--trade", "1775772921"], extra_env=EVERY_CRED)   # real repo snapshots
REAL_CONTEXT_OUT = out
check("--context-only on the repo's real committed snapshots: exit 0, zero outside activity",
      rc == 0 and NET == [] and KEYCHAIN == [] and CALLS["token_reads"] == 0 and LAST["events"] == []
      and "=== LOCAL CONTEXT for ts=1775772921 ===" in out, f"rc={rc} {NET} {out[-800:]}")
if run_child:
    child, res = run_child("--context-only")
    REAL_CHILD_CONTEXT_OUT = res.stdout
    check("real CLI --context-only: exit 0, nothing attempted (no network, Keychain or Anthropic)",
          child.get("code") == 0 and child.get("attempts") == [], f"{child} stderr={res.stderr[-400:]}")


# ── 8. --generate: paid generation + dry-run preview, same reads as a send ─
print("8. --generate: Anthropic (fake) called, recent-posts READ happens, zero POSTs, preview printed")
check("fetch_recent_bot_posts reads the token via _discord_bot_token()",
      "_discord_bot_token()" in inspect.getsource(REAL_CTX.fetch_recent_bot_posts))
check("the fire script never replaces trade_roast_context._discord_bot_token",
      not re.search(r"_discord_bot_token\s*=", FIRE_PATH.read_text()))
NET.clear(); FAKE_NET["on"] = True
try:
    with temp_env(DISCORD_BOT_TOKEN="fake-bot-token-for-test"), contextlib.redirect_stdout(io.StringIO()):
        posts = REAL_CTX.fetch_recent_bot_posts()
finally:
    FAKE_NET["on"] = False
check("real recent-posts read: the bot's post via GETs only",
      posts == [PRIOR_POST] and [m for _, m, _u in NET] == ["GET", "GET"]
      and NET[1][2] == f"{DISCORD_API}channels/{TRADE_CHANNEL}/messages?limit=100", f"{posts} {NET}")


def preview_block(out):
    s = out.find("\n  DESTINATION:")
    ends = [i for i in (out.find("  DRY RUN — nothing posted"), out.find("  Posting announcement"))
            if i > s]
    return out[s:min(ends)] if s >= 0 and ends else ""


def last_log_line():
    lines = AUDIT.read_text().splitlines() if AUDIT.exists() else []
    return lines[-1] if lines else ""


ONE_TRADE = ["--trade", "1775772921"]
TOKENS = {"DISCORD_BOT_TOKEN": "FAKE-DISCORD-TOKEN-q7zx", "GIPHY_API_KEY": "FAKE-GIPHY-KEY-q7zx",
          "ANTHROPIC_API_KEY": "sk-ant-FAKE-ANTHROPIC-q7zx"}
FAKE_NET["on"] = True
try:
    rc, out = run_main(["--generate", *ONE_TRADE], extra_env=TOKENS)
finally:
    FAKE_NET["on"] = False
GEN = {"gets": [(m, u) for k, m, u in NET if m == "GET"], "keychain": list(KEYCHAIN),
       "prompts": list(CALLS["prompts"]), "models": list(CALLS["anthropic"]),
       "preview": preview_block(out), "events": [w for w, _ in LAST["events"]],
       "log": last_log_line()}
check("--generate: exit 0", rc == 0, f"rc={rc} {out[-800:]}")
check("--generate: fake Anthropic constructed once and called (opus)",
      CALLS["anthropic_clients"] == 1 and CALLS["anthropic"] == ["claude-opus-4-6"], str(CALLS))
check("--generate: Discord recent-posts READ happened (GET /users/@me + trade-channel messages)",
      ("GET", f"{DISCORD_API}users/@me") in GEN["gets"]
      and ("GET", f"{DISCORD_API}channels/{TRADE_CHANNEL}/messages?limit=100") in GEN["gets"], str(NET))
check("--generate: the duplicate check fed the prompt (ban list carries the bot's prior post)",
      GEN["prompts"] and PRIOR_POST in GEN["prompts"][0] and "Duplicate check: done" in out, str(GEN["prompts"]))
check("--generate: Giphy searched (a read), GIF in the preview",
      any(u.startswith("https://api.giphy.com/") for _, u in GEN["gets"]) and GIF_URL in out, str(NET))
check("--generate: zero POSTs / writes of any kind",
      all(m == "GET" for k, m, u in NET if k == "urlopen") and DISCORD_FN_CALLS == [],
      f"{NET} {DISCORD_FN_CALLS}")
check("--generate: preview shows the destination channel + new thread + every message",
      f"DESTINATION: channel {CHANNEL}" in out and "NEW thread" in out and "FAKE TRADE EMBED" in out
      and "Fake roast line." in out and "DRY RUN — nothing posted" in out, out[-1200:])
check("--generate: plan says Network YES, Anthropic YES, Discord read YES, Discord write NO, destination",
      (plan_row(out, "Network") or "").startswith("YES")
      and (plan_row(out, "Anthropic") or "").startswith("YES — 1 PAID call")
      and (plan_row(out, "Discord read") or "").startswith("YES when")
      and (plan_row(out, "Discord write") or "").startswith("NO")
      and CHANNEL in (plan_row(out, "Destination") or "")
      and "NEW thread" in (plan_row(out, "Destination") or ""), out[:1500])
check("--generate: the token reader was not replaced (no dry-run stub)", not LAST["token_reader_replaced"])
check("--generate: audit log written to the temp dir, not the repo", AUDIT.exists() and GEN["log"])
plan_first("--generate", out)

rc, out = run_main(["--generate"])           # no Discord token, no Giphy key, fake network OFF
check("--generate, no token: still completes (exit 0), both trades, opus",
      rc == 0 and CALLS["anthropic"] == ["claude-opus-4-6", "claude-opus-4-6"]
      and out.count("DRY RUN — nothing posted") == 2, f"rc={rc} {CALLS} {out[-600:]}")
check("--generate, no token: prints that the duplicate check was skipped and why",
      "Duplicate check: SKIPPED — no Discord token" in out and "Discord token: NOT FOUND" in out, out[:2000])
check("--generate, no token: zero Discord requests, no Discord function",
      discord_reqs() == [] and DISCORD_FN_CALLS == [], f"{NET} {DISCORD_FN_CALLS}")
check("--generate, no token: every network attempt was a GET (no writes)",
      all(m == "GET" for k, m, u in NET if k == "urlopen"), str(NET))
plan_first("--generate, no token", out)


# ── 9. positive control: every gate met → posts happen, after the preview ──
print("9. --send positive control (fake Discord): preview first, then POSTs; same reads as --generate")
FAKE_NET["on"] = True
try:
    rc, out = run_main(["--send", f"--confirm-send={CHANNEL}", *ONE_TRADE], send_env="1", extra_env=TOKENS)
finally:
    FAKE_NET["on"] = False
posts = [(m, u) for k, m, u in NET if k == "urlopen" and m != "GET"]
first_post = min((p for w, p in LAST["events"] if w.startswith("urlopen POST")), default=-1)
check("send: exit 0", rc == 0, out[-800:])
check("send: plan says Discord write YES (gates met), names the write guard, --send implies --generate",
      (plan_row(out, "Discord write") or "").startswith("YES — gates met")
      and "Write guard" in (plan_row(out, "Discord write") or "")
      and "implies --generate" in (plan_row(out, "Mode") or ""), out[:1800])
check("send: preview (destination + all 3 messages) printed before the first POST",
      0 <= out.find("DESTINATION:") < out.find("Message 1 →") < out.find("Message 3 →") < first_post,
      f"first POST at {first_post}: {out[-1200:]}")
check("send: announcement → confirmed channel, thread off it, roast + GIF into the thread",
      posts == [("POST", f"{DISCORD_API}channels/{CHANNEL}/messages"),
                ("POST", f"{DISCORD_API}channels/{CHANNEL}/messages/{fake_id(1)}/threads"),
                ("POST", f"{DISCORD_API}channels/{fake_id(2)}/messages"),
                ("POST", f"{DISCORD_API}channels/{fake_id(2)}/messages")], str(posts))
check("send: the harness saw the Discord functions (so sections 3-8 would have too)",
      [n for n, _ in DISCORD_FN_CALLS].count("discord_post_message") == 3
      and [n for n, _ in DISCORD_FN_CALLS].count("discord_create_thread_from_message") == 1,
      str(DISCORD_FN_CALLS))
check("send: write state is cleared when main() returns (nothing carries to another caller)",
      LAST["run_state_after"] == {"confirmed_channel": None, "posted_messages": set(),
                                  "created_threads": set()}, str(LAST["run_state_after"]))
SEND = {"gets": [(m, u) for k, m, u in NET if m == "GET"], "keychain": list(KEYCHAIN),
        "prompts": list(CALLS["prompts"]), "models": list(CALLS["anthropic"]),
        "preview": preview_block(out),
        "events": [w for w, _ in LAST["events"]
                   if not w.startswith(("urlopen POST", "fire._discord_request", "fire.discord_"))],
        "log": last_log_line()}
check("same reads: --generate and --send made the SAME GET requests, in order",
      GEN["gets"] and GEN["gets"] == SEND["gets"], f"\n gen={GEN['gets']}\n snd={SEND['gets']}")
check("same reads: same Keychain lookups (none: tokens from env)",
      GEN["keychain"] == SEND["keychain"] == [], f"{GEN['keychain']} {SEND['keychain']}")
check("same generation: same model calls and identical prompts (incl. the ban list)",
      GEN["models"] == SEND["models"] and GEN["prompts"] == SEND["prompts"])
check("same messages: the previewed destination + messages are identical",
      GEN["preview"] and GEN["preview"] == SEND["preview"], f"\n{GEN['preview']}\n---\n{SEND['preview']}")
check("differs ONLY at the write step: every non-write event matches, in order",
      GEN["events"] == SEND["events"], f"\n gen={GEN['events']}\n snd={SEND['events']}")
check("send: token came from env (fake), no Keychain read", KEYCHAIN == [], str(KEYCHAIN))
plan_first("send", out)


# ── 10. audit log: whitelisted fields only ─────────────────────────────────
print("10. audit log: no secret, no fetched production text, no roast/context text, no free-text error")
CALLS["anthropic_raise"] = (f"boom {TOKENS['DISCORD_BOT_TOKEN']} {TOKENS['GIPHY_API_KEY']} "
                            f"{TOKENS['ANTHROPIC_API_KEY']} {PRIOR_POST}")
FAKE_NET["on"] = True
try:
    rc, out = run_main(["--generate", *ONE_TRADE], extra_env=TOKENS)
finally:
    FAKE_NET["on"] = False
    CALLS["anthropic_raise"] = None
FAIL_LOG = last_log_line()
check("failing run: the error (carrying fake secrets) reached the console summary only",
      rc == 0 and "FAIL  ts=1775772921" in out and TOKENS["DISCORD_BOT_TOKEN"] in out, out[-600:])
FORBIDDEN = [TOKENS["DISCORD_BOT_TOKEN"], TOKENS["GIPHY_API_KEY"], TOKENS["ANTHROPIC_API_KEY"],
             PRIOR_POST, "Fake roast line", "FAKE CONTEXT", "sad trombone", GIF_URL, "boom",
             "FAKE TRADE EMBED"]
ALLOWED_KEYS = set(fire.AUDIT_RESULT_KEYS) | {"usage"}
for label, line in (("generate", GEN["log"]), ("send", SEND["log"]), ("failing generate", FAIL_LOG)):
    try:
        rec = json.loads(line)
    except ValueError:
        rec = {}
    check(f"log ({label}): one JSON line with mode + results", rec.get("mode") in ("generate", "send")
          and isinstance(rec.get("results"), list) and rec["results"], line)
    check(f"log ({label}): no secret, fetched production text, roast/context text or GIF query",
          line and not [s for s in FORBIDDEN if s in line], f"leaked {[s for s in FORBIDDEN if s in line]}: {line}")
    check(f"log ({label}): only whitelisted fields",
          set(rec) == {"fired_at_utc", "mode", "results"}
          and all(set(r) <= ALLOWED_KEYS for r in rec.get("results", []))
          and all(set(r.get("usage", {})) <= set(fire.AUDIT_USAGE_KEYS) for r in rec.get("results", [])),
          line)
check("log (send): keeps the audit essentials (ids, counts, flags)",
      '"announcement_msg_id": "%s"' % fake_id(1) in SEND["log"] and '"thread_id": "%s"' % fake_id(2) in SEND["log"]
      and '"dup_check": "done"' in SEND["log"] and '"roast_chars": 16' in SEND["log"]
      and '"mode": "send"' in SEND["log"], SEND["log"])
check("log (failing run): records the error TYPE only",
      '"error_type": "RuntimeError"' in FAIL_LOG and '"error":' not in FAIL_LOG, FAIL_LOG)
check("the real log path is gitignored", (REPO / ".gitignore").exists()
      and "pipelines/etl/data/" in (REPO / ".gitignore").read_text().splitlines())

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{'ALL PASS' if not fails else str(fails) + ' FAILURE(S)'}")


def test_roast_bot_fire_ab_cannot_post():   # pytest entry point; the checks above ran at import
    assert fails == 0


if __name__ == "__main__":
    sys.exit(1 if fails else 0)
