#!/usr/bin/env python3
"""
sync_owner_ammo_to_d1.py — mirror owner_profiles.json's personality dossier
into D1 (ups_roast_owner_ammo), so the worker's clapback path can see it.

WHY THIS EXISTS (Keith 2026-09-02, same day as the dossier rewrite)
    pipelines/etl/data/bot/owner_profiles.json is LOCAL-ONLY by design
    (gitignored — candid material, some of it flagged slur-adjacent-and-
    unusable, about real people; the repo is public). trade_roast_context.py
    reads it directly for the trade-roast prompt via format_owner_dossier()
    — that path is fine.

    worker/src/discord_roast_reply.js's buildReplierContext() — the "someone
    heckled the bot, build a clap-back" path — runs on Cloudflare, which can
    only ever read what reached GitHub. It has NEVER had access to this file,
    participant or not: within an hour of the rewrite going live, a heckle
    produced a banned "sixteen years, nine playoff trips" résumé recitation,
    because that path falls back to a bare stats dump with zero personality
    material (see PR #1014).

    This script is the fix's other half: a one-way LOCAL -> D1 sync of
    exactly the fields the clapback path needs (voice, form, device,
    roast_angles, discord_receipts, running_gags, sensitivities,
    best_counterpunch) into ups_roast_owner_ammo (migration 0147). The
    worker's buildReplierContext() then renders from THAT table using the
    same "ammo, draw from it, don't recite it" rules format_owner_dossier()
    already uses, instead of falling back to a raw stat sheet.

    RUN THIS BY HAND after editing owner_profiles.json. There is no cron —
    this mirrors "Keith hot-edits profiles between trades" exactly. If a
    future weekly-scan script starts writing owner_profiles.json on its own,
    it should call this at the end of its own run.

Usage:
  python3 sync_owner_ammo_to_d1.py            # sync
  python3 sync_owner_ammo_to_d1.py --dry-run  # print the SQL, don't run it
"""

import argparse
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PROFILES_PATH = SCRIPT_DIR.parent / "data" / "bot" / "owner_profiles.json"
WORKER_DIR = SCRIPT_DIR.resolve().parents[2] / "worker"

COLS = [
    "franchise_id", "owner_display", "team_name", "discord_handle",
    "voice", "form", "device", "best_counterpunch",
    "roast_angles_json", "discord_receipts_json",
    "running_gags_json", "sensitivities_json", "synced_at_utc",
]


def _sql_quote(v) -> str:
    """SQL string literal — single quotes, escape internal single quotes."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def load_profiles() -> dict:
    if not PROFILES_PATH.exists():
        sys.stderr.write(f"No profile file at {PROFILES_PATH}\n")
        sys.exit(1)
    with open(PROFILES_PATH, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("profiles", data) or {}


def build_rows(profiles: dict) -> list[dict]:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = []
    for fid, p in profiles.items():
        fid = str(fid).zfill(4)
        rows.append({
            "franchise_id": fid,
            "owner_display": p.get("owner") or "",
            "team_name": p.get("team_name") or "",
            "discord_handle": p.get("discord") or "",
            "voice": p.get("voice") or "",
            "form": p.get("form") or "",
            "device": p.get("device") or "",
            "best_counterpunch": p.get("best_counterpunch") or "",
            "roast_angles_json": json.dumps(p.get("roast_angles") or [], ensure_ascii=False),
            "discord_receipts_json": json.dumps(p.get("discord_receipts") or [], ensure_ascii=False),
            "running_gags_json": json.dumps(p.get("running_gags") or [], ensure_ascii=False),
            "sensitivities_json": json.dumps(p.get("sensitivities") or [], ensure_ascii=False),
            "synced_at_utc": now,
        })
    return rows


def build_sql(rows: list[dict]) -> str:
    update_clause = ", ".join(f"{c} = excluded.{c}" for c in COLS if c != "franchise_id")
    parts = []
    for r in rows:
        values = ", ".join(_sql_quote(r.get(c)) for c in COLS)
        parts.append(
            f"INSERT INTO ups_roast_owner_ammo ({', '.join(COLS)}) "
            f"VALUES ({values}) "
            f"ON CONFLICT(franchise_id) DO UPDATE SET {update_clause};"
        )
    return "\n".join(parts) + "\n"


def d1_execute_file(sql_text: str) -> None:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write(sql_text)
        sql_path = f.name
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", sql_path],
        capture_output=True, text=True, cwd=str(WORKER_DIR),
    )
    if result.returncode != 0:
        sys.stderr.write(f"D1 execute failed:\n{result.stderr}\n")
        sys.exit(1)
    print(result.stdout[-2000:])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    profiles = load_profiles()
    print(f"Loaded {len(profiles)} owner profile(s) from {PROFILES_PATH}")
    rows = build_rows(profiles)
    sql_text = build_sql(rows)

    if args.dry_run:
        print(sql_text)
        print(f"DRY RUN — would UPSERT {len(rows)} row(s), not writing")
        return 0

    d1_execute_file(sql_text)
    print(f"D1 sync: {len(rows)} row(s) UPSERTed into ups_roast_owner_ammo")
    return 0


if __name__ == "__main__":
    sys.exit(main())
