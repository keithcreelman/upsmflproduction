#!/usr/bin/env python3
"""The one stage that calls a model: pack -> prose.json.

STDLIB ONLY. The repo has no requirements file and CI installs nothing, so this
speaks to the Anthropic Messages API over urllib rather than importing the SDK.
The worker already does the same thing in JS.

KEY HANDLING
  Read from ANTHROPIC_API_KEY. In CI that is a repo secret; locally it can come
  from the environment or the macOS Keychain entry the existing roast bot uses.
  The key is never logged, never written to a file, and never included in the
  prose artifact.

  NOT SUPPORTED: content_engine.py's ANTHROPIC_USE_PROXY mode. It points at
  {WORKER_BASE}/api/anthropic-proxy, which does not exist -- grep the worker and
  you get zero hits. Only direct mode works.

MODEL
  Defaults to the current most-capable model. content_engine.py is pinned to an
  older one; that pin is deliberate for the roast bot (known-good) and is not
  inherited here.
"""

import json
import os
import subprocess
import urllib.error
import urllib.request

import wire_voice

API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
DEFAULT_MODEL = "claude-opus-5"
MAX_TOKENS = 32000


class WriteError(RuntimeError):
    pass


def _api_key():
    key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if key:
        return key
    # Local convenience only: the same Keychain entry the roast bot reads. Never
    # echoed; goes straight into the Authorization header.
    try:
        proc = subprocess.run(
            ["security", "find-generic-password", "-s", "anthropic_api_key", "-w"],
            capture_output=True, text=True, timeout=15)
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
    except Exception:                                    # noqa: BLE001
        pass
    raise WriteError(
        "No ANTHROPIC_API_KEY. In CI this is a repo secret; add it with\n"
        "  gh secret set ANTHROPIC_API_KEY --repo keithcreelman/upsmflproduction\n"
        "Locally, export ANTHROPIC_API_KEY or store it in the Keychain as "
        "'anthropic_api_key'.")


def call_model(system, user, model=DEFAULT_MODEL, max_tokens=MAX_TOKENS):
    body = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")

    req = urllib.request.Request(API_URL, data=body, method="POST")
    req.add_header("content-type", "application/json")
    req.add_header("anthropic-version", API_VERSION)
    req.add_header("x-api-key", _api_key())

    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise WriteError("Anthropic API %s: %s" % (exc.code, detail))
    except Exception as exc:                             # noqa: BLE001
        raise WriteError("Anthropic API call failed: %s" % exc)

    text = "".join(b.get("text", "") for b in payload.get("content", [])
                   if b.get("type") == "text")
    if not text.strip():
        raise WriteError("model returned no text (stop_reason=%s)"
                         % payload.get("stop_reason"))
    if payload.get("stop_reason") == "max_tokens":
        # Otherwise this surfaces downstream as an inscrutable "Unterminated
        # string" from the JSON parser, which sends you hunting the wrong bug.
        raise WriteError(
            "model hit the %d-token output cap and the JSON is truncated. Raise "
            "MAX_TOKENS or trim the section outline." % max_tokens)
    return text, payload.get("usage", {}), payload.get("model", model)


def _extract_json(text):
    """The system prompt asks for bare JSON. Tolerate a stray fence anyway --
    failing a whole generation over three backticks is a bad trade."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    start, end = t.find("{"), t.rfind("}")
    if start < 0 or end <= start:
        raise WriteError("model output contained no JSON object")
    return json.loads(t[start:end + 1])


def write_prose(pack, family_id, model=DEFAULT_MODEL):
    """Returns (prose_dict, meta_dict). Never returns the key or the raw prompt."""
    system = wire_voice.system_prompt(family_id)
    user = wire_voice.build_user_payload(pack)

    text, usage, actual_model = call_model(system, user, model=model)
    try:
        prose = _extract_json(text)
    except ValueError as exc:
        raise WriteError("model output was not valid JSON: %s" % exc)

    for key in ("kicker", "title", "dek", "sections"):
        if key not in prose:
            raise WriteError("model output is missing %r" % key)

    meta = {
        "engine": actual_model,
        "inputTokens": usage.get("input_tokens"),
        "outputTokens": usage.get("output_tokens"),
        "packId": pack["packId"],
        "packGeneratedAtUtc": pack["generatedAtUtc"],
    }
    return prose, meta
