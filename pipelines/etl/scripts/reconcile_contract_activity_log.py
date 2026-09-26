#!/usr/bin/env python3
"""
Fail LOUDLY when a real contract submission in D1 is missing from
contract_activity_<season>.json.

D1 (ups_extension/restructure/tag/mym_submissions) is the single source of
truth; the JSON log is a downstream copy fed by a repository_dispatch per
event. This closes the two holes the workflow fix cannot see:
  * the worker's dispatchRepoEvent() got a non-204 (PAT expired, GitHub 5xx) --
    the worker records that only in submitDebug and still reports success;
  * any event lost before the 2026-09-12 workflow fix.

Match key: (franchise_id, player_id, submitted_at_utc to the second) -- the
worker stamps the same instant into D1 and into the dispatch payload (verified
on every overlapping 2026 row).

Usage:
  reconcile_contract_activity_log.py --season 2026                   # live: GET /admin/contract-submissions
  reconcile_contract_activity_log.py --season 2026 --d1-cache DIR     # offline: ups_*_submissions_<season>.json dumps
Exit 0 = log complete, 1 = rows missing (listed), 2 = could not check.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
# D1 rows written by backfills that never went through the worker dispatch --
# by design they have no log row. Extend deliberately, never by pattern-guessing.
NOT_DISPATCHED_SOURCES = ("mfl-rosters-backfill", "ups-contracts-hub-bot-discord", "trade-workbench-pre-trade")


def key(fid, pid, ts):
    return (str(fid or "").zfill(4), str(pid or "").strip(), str(ts or "").strip()[:19])


def d1_rows_live(season: str):
    url = f"{WORKER}/admin/contract-submissions?L=74598&YEAR={season}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 reconcile-contract-activity"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.load(resp)
    if not body.get("ok"):
        raise RuntimeError(f"/admin/contract-submissions not ok: {str(body)[:300]}")
    return [(s.get("table"), s) for s in body.get("submissions") or []]


def d1_rows_cache(season: str, cache: Path):
    out = []
    for table in ("ups_extension_submissions", "ups_restructure_submissions", "ups_tag_submissions", "ups_mym_submissions"):
        f = cache / f"{table}_{season}.json"
        if not f.exists():
            raise RuntimeError(f"missing cache file {f}")
        for r in json.loads(f.read_text(encoding="utf-8")):
            if int(r.get("dry_run") or 0):
                continue
            out.append((table, r))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", required=True)
    ap.add_argument("--log", default="")
    ap.add_argument("--d1-cache", default="")
    a = ap.parse_args()
    log_path = Path(a.log) if a.log else REPO / f"site/rosters/contract_submissions/contract_activity_{a.season}.json"
    try:
        doc = json.loads(log_path.read_text(encoding="utf-8"))
        acts = doc["activities"] if isinstance(doc, dict) else doc
        d1 = d1_rows_cache(a.season, Path(a.d1_cache)) if a.d1_cache else d1_rows_live(a.season)
    except Exception as exc:  # noqa: BLE001 -- any failure to CHECK is itself a failure
        print(f"::error::could not reconcile: {exc}")
        return 2
    have = {key(r.get("franchise_id"), r.get("player_id"), r.get("submitted_at_utc")) for r in acts}
    # The commissioner's declared test franchises (contract_log_test_<season>.json):
    # events strictly before `before` are test data and are never expected in the log.
    test_cut = {}
    test_path = REPO / f"site/rosters/contract_submissions/contract_log_test_{a.season}.json"
    if test_path.exists():
        for t in json.loads(test_path.read_text(encoding="utf-8")).get("test_franchises") or []:
            test_cut[str(t.get("franchise_id")).zfill(4)] = str(t.get("before") or "")
    missing = []
    for table, r in d1:
        src = str(r.get("source") or "")
        if any(src.startswith(s) for s in NOT_DISPATCHED_SOURCES):
            continue
        if r.get("voided_at_utc") or int(r.get("dry_run") or 0):
            continue
        cut = test_cut.get(str(r.get("franchise_id") or "").zfill(4))
        if cut and str(r.get("submitted_at_utc") or "") < cut:
            continue
        if key(r.get("franchise_id"), r.get("player_id"), r.get("submitted_at_utc")) not in have:
            missing.append((str(r.get("submitted_at_utc")), table, str(r.get("franchise_id")), str(r.get("player_id")),
                            str(r.get("player_name") or ""), src))
    print(f"D1 real submissions checked: {len(d1)}; log rows: {len(acts)}; missing from log: {len(missing)}")
    for m in sorted(missing):
        print("::error::MISSING FROM LOG  %s  %-28s  fid=%s pid=%s  %s  (%s)" % m)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
