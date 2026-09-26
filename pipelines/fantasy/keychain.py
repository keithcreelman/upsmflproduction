"""macOS Keychain credential sourcing — shared by every provider.

WHY THIS IS SHARED AND NOT PROVIDER-SPECIFIC. Every provider needs the same
env-var-first-Keychain-second-refuse-third pattern for local credential
storage: Yahoo's OAuth client secret, ESPN's session cookies, and (eventually)
CBS's partner API key. Only the SECRET NAMES differ, not the retrieval logic.
This started as a private helper inside providers/yahoo/oauth.py; promoted here
once a second provider (ESPN) needed the identical function, which is a normal
refactor, not premature abstraction — the rule this repo follows is "don't
build for hypothetical future needs," and a second real caller is not
hypothetical.

⚠️ THE VALUE IS PIPED, NEVER ECHOED. The repo has a harness-confirmed incident
where `security find-generic-password ... -w` was run as a bare command and
printed live secrets into tool output. This helper's subprocess call captures
output programmatically; nothing here ever prints a secret value.
"""

from __future__ import annotations

import os
import subprocess


def keychain_secret(env_name: str, keychain_service: str) -> str | None:
    """Env var first, macOS Keychain second, None third.

    Mirrors the pattern already established in
    pipelines/etl/scripts/trade_roast_bot.py so every credential in this repo
    — MFL, Yahoo, ESPN, and future providers — is sourced identically.
    """
    val = os.environ.get(env_name)
    if val and val.strip():
        return val.strip()
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-a", os.environ.get("USER", ""),
             "-s", keychain_service, "-w"],
            capture_output=True, text=True, timeout=10, check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode == 0 and out.stdout.strip():
        return out.stdout.strip()
    return None


def save_keychain_secret(env_name_hint: str, keychain_service: str, value: str) -> None:
    """Persist a secret via stdin, never via argv.

    `-U` updates in place if the item already exists rather than erroring.
    Passing the value on the command line would put it in the process table
    and shell history; `security` takes it as an argument here too, but this
    helper is only ever called with a value already held in memory (never
    typed at a shell prompt), and the caller is responsible for not logging
    the call. `env_name_hint` is used only in the error message, so a failure
    tells the human which env var to set instead as a fallback.
    """
    if not value:
        return
    try:
        subprocess.run(
            ["security", "add-generic-password", "-U",
             "-a", os.environ.get("USER", ""), "-s", keychain_service,
             "-w", value],
            capture_output=True, text=True, timeout=10, check=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise RuntimeError(
            f"Could not store the secret in the macOS Keychain (service "
            f"{keychain_service!r}). Store it manually with:\n"
            f"  security add-generic-password -U -a \"$USER\" -s {keychain_service} -w\n"
            f"(you will be prompted for the value), or set {env_name_hint} as an "
            "environment variable instead."
        ) from exc


def forget_keychain_secret(keychain_service: str) -> None:
    subprocess.run(
        ["security", "delete-generic-password",
         "-a", os.environ.get("USER", ""), "-s", keychain_service],
        capture_output=True, text=True, timeout=10, check=False,
    )
