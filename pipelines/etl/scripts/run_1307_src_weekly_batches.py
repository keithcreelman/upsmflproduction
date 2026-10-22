#!/usr/bin/env python3
"""run_1307_src_weekly_batches.py -- guarded executor for the #1307 src_weekly repair.

Runs reviewed dry-run SQL (dryrun_1307_src_weekly_backfill.py, PR #1363) one
batch at a time, only inside a Free-plan write budget that also holds the
batch's full rollback. Nothing remote happens without its opt-in flag; a write
needs --execute AND --approval <URL of Keith's GitHub comment approving THAT batch>.

PLAN v2 (Keith, 2026-10-21): authoritative scores are separated from disputed
ranks. The only READY batch is 1A = phase B for 2025 (free agent / taxi / IR
playoff score rows, weekly ranks NULL). 1C (2025 weekly rank updates) is HELD
until the rank definition is reviewed; every other batch is PENDING and has no
executable SQL in the plan. Phase E, the rank-table rebuild, the 23 unresolved
player-seasons and win_chunks are out of scope.

THE GUARD (every check fails closed)
  * Cloudflare's Free limits reset at 00:00 UTC and are per ACCOUNT: usage is
    summed over every D1 database (GraphQL d1AnalyticsAdaptiveGroups; control
    plane, reads no D1 rows).
  * A batch starts only if
        used_today + forecast_rest_of_day + forward_writes + rollback_reserve <= 90,000
    forward_writes = inserts x 4 (table + PK + 2 indexes) + updates x 1 (measured);
    rollback_reserve = inserts x 4 + updates x 1 (a DELETE may bill its index
    entries too), so a full restore always fits the same UTC day;
    forecast = per remaining hour, the max of the last 7 complete UTC days.
  * Also: no hour today 5,000+ above its 7-day max; start 22:05-23:30 UTC; no
    write-heavy job running; target weeks == dry-run preimage; season player
    totals reconcile exactly to the approved "before" set; MFL unchanged.
  * During: each statement's meta.rows_written / meta.changes must equal its
    expected value. The first statement (80 rows) is the production billing
    calibration.
  * AUTOMATIC ROLLBACK (authorized by the batch approval) when the billed count
    differs from plan, any row- or season-level invariant fails (after-state
    hash, row count, any write error), or the post-batch reconciliation differs
    from the approved result. A verified batch is never rolled back without a
    separate decision (`rollback` subcommand).
  * After: account delta since the batch started, minus this batch, must be
    <= 3,000 (works across 00:00 UTC); otherwise no further batch that night.

READ CAPACITY (Keith, 2026-10-22) -- alongside the write guard, every check fails closed
  * reads_used_today (same GraphQL source, rowsRead, every D1 database, the
    current UTC calendar day) + reads_forecast_rest_of_day (per remaining hour,
    the max of the last 7 complete UTC days) + the batch's full read reserve
    (preflight + writes + both verifications + worst-case rollback + panel
    check) <= 4,500,000 (90% of the 5,000,000 Free allowance).
  * Cross-check: the GraphQL hourly totals for the last 24 h must bracket
    `wrangler d1 info` rows_read_24h / rows_written_24h summed over every
    database (`wrangler d1 list`) within 5%; a failed or disagreeing source
    stops the batch before its first D1 read. (`wrangler d1 insights` is not a
    usage source here: it reported 11.29M for a 24 h in which both of these
    agreed on ~4.9M; #1354 owns that discrepancy.)

ONE ATTEMPT PER APPROVAL (Keith, 2026-10-21)
  * `apply` consumes its approval before its first production read: an
    attempt record is created atomically in ATTEMPT_DIR (a fixed path, not
    under --artifacts) and is never deleted or reused. A preflight STOP, a
    failed run, an automatic rollback or a crash all still consume it.
  * A later attempt needs a NEW approval: a comment id greater than every
    approval already recorded for that batch. Re-running with the same (or an
    older) approval is refused that night and every night after.
  * `rollback` approvals are single-use the same way and never reuse an apply
    approval. `verify`, `preflight`, `panel-check` and `attempts` stay
    read-only and need no approval.

SUBCOMMANDS
  plan        --artifacts DIR --out PLAN.json         offline
  usage       [--batch-writes N]                      control-plane metrics only
  preflight   --plan P --artifacts DIR --batch ID --allow-prod-d1-read
  apply       --plan P --artifacts DIR --batch ID --execute --approval URL
  verify      --plan P --artifacts DIR --batch ID --allow-prod-d1-read
  panel-check --plan P --batch ID --allow-prod-read
  rollback    --plan P --artifacts DIR --batch ID --execute --approval URL
  attempts    --batch ID                              offline: the attempt ledger
  safeguard-check --plan P --allow-prod-read          read-only: the live bundle vs the PR #1372 manifest
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
D1_DB = "ups-mfl-db"
ACCOUNT_ID = "ba1a1d492ec8a5485821eb8f0d5f32c2"
WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
COLS = ["season", "week", "player_id", "pos_group", "status", "score", "is_reg",
        "roster_franchise_id", "roster_franchise_name", "pos_rank", "overall_rank", "win_chunks"]

DAILY_CEILING = 90_000          # Free plan is 100,000/day; keep >= 10,000 unused
FREE_PLAN_LIMIT = 100_000
READ_LIMIT = 5_000_000          # Free plan rows read per UTC day, account-wide
READ_CEILING = 4_500_000        # 90% of it: projected reads above this refuse the batch
USAGE_DISAGREEMENT = 0.05       # GraphQL vs `wrangler d1 info`: beyond 5% = metrics not trusted
BUNDLE_READ_RESERVE = 5_000     # per /api/player-bundle GET (measured ~400: insights avg 191 + 109 + small)
WINDOW_START = (22, 5)          # UTC; a batch may START only inside the window
WINDOW_LAST_START = (23, 30)
SETTLE_MINUTES = 12             # GraphQL analytics lag
OTHER_WRITES_ALLOWANCE = 3_000  # quiet-hour writes by other jobs while a batch runs
FORECAST_DAYS = 7               # complete UTC days, all after the changed-only writer (#1267)
ANOMALY_MARGIN = 5_000          # an hour today this far above its 7-day max = unscheduled heavy job
UPDATES_PER_COMMAND = 25
PLAN_VERSION = 4
ATTEMPT_DIR = Path.home() / ".ups_jobs" / "1307_src_weekly" / "attempts"   # fixed on purpose: see ONE ATTEMPT PER APPROVAL
APPROVAL_RE = re.compile(r"^https://github\.com/keithcreelman/upsmflproduction/(issues|pull)/\d+#issuecomment-\d+$")
LEAGUE_IDS = {2011: "40832", 2012: "37227", 2013: "42721", 2014: "30590", 2015: "29015", 2016: "27191"}

# Workflows / local jobs that write D1 in bulk; a batch never starts while one runs.
WRITE_HEAVY_WORKFLOWS = [
    "nflverse-stats-refresh.yml", "wc-rank-rebuild.yml", "mfl-daily-snapshot.yml", "nightly-builders.yml",
    "nightly-config-sync.yml", "contract-reconcile.yml", "ingest-projections.yml", "owner-career-stats.yml",
    "roster-anomaly-check.yml", "sleeper-cache-build.yml", "discord-chat-ingest.yml",
]
WRITE_HEAVY_PROCESSES = ["upsmfl-live-season-sync", "upsmfl-ups-center-auto", "deadline_drop_2026",
                         "sync_live_weekly_scores_to_d1", "load_local_to_d1", "fetch_nflverse"]


class Invariant(Exception):
    """A row-, season- or billing-level check failed after writing started."""


def league_id(season: int) -> str:
    return LEAGUE_IDS.get(season, "74598")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def ids_hash(ids) -> str:
    return hashlib.sha256("\n".join(sorted(str(i) for i in ids)).encode()).hexdigest()


# ──────────────────────────────────────────────────────────────────────
# Pure rules (unit-tested)
# ──────────────────────────────────────────────────────────────────────

def canon_row(r: dict) -> list:
    """One row in a form that compares equal whether it came from the build
    (Python floats) or from D1's JSON (12.0 arrives as 12)."""
    out = []
    for c in COLS:
        v = r.get(c)
        if v is not None and c in ("score", "win_chunks"):
            v = round(float(v), 4)
        elif v is not None and c in ("season", "week", "is_reg", "pos_rank", "overall_rank"):
            v = int(v)
        elif v is not None:
            v = str(v)
        out.append(v)
    return out


def rows_hash(rows: list) -> str:
    items = sorted(json.dumps(canon_row(r)) for r in rows)
    return hashlib.sha256("\n".join(items).encode()).hexdigest()


def statement_expectation(sql: str) -> dict:
    """What D1 must report for one reviewed statement: an INSERT of n rows bills
    4n rows written (table + 3 index entries) and changes n; an UPDATE of one row
    bills 1 and changes 1; a DELETE of n keys changes at most n (billing not asserted)."""
    head = sql.lstrip()[:12].upper()
    if head.startswith("INSERT"):
        n = sql.count("\n(")
        return {"kind": "insert", "rows": n, "rows_written": 4 * n, "changes": n}
    if head.startswith("UPDATE"):
        return {"kind": "update", "rows": 1, "rows_written": 1, "changes": 1}
    if head.startswith("DELETE"):
        n = sql.count(",") + 1
        return {"kind": "delete", "rows": n, "rows_written": None, "changes": None}
    raise ValueError(f"unexpected statement: {sql[:60]}")


def check_meta(expect: dict, meta: dict) -> str | None:
    """None if D1's meta matches the statement's expectation, else the reason."""
    if expect["changes"] is not None and int(meta.get("changes") or 0) != expect["changes"]:
        return f"changes {meta.get('changes')} != expected {expect['changes']}"
    if expect["rows_written"] is not None and int(meta.get("rows_written") or 0) != expect["rows_written"]:
        return f"rows_written {meta.get('rows_written')} != expected {expect['rows_written']}"
    return None


def rollback_reserve(rows_inserted: int, rows_updated: int) -> int:
    return 4 * rows_inserted + rows_updated


def hourly_max(hourly: dict, now: datetime, days: int = FORECAST_DAYS) -> dict:
    """{hour: max rowsWritten that UTC hour reached} over the last `days` COMPLETE UTC days."""
    keep = {(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, days + 1)}
    by_hour = defaultdict(int)
    for key, v in hourly.items():
        if key[:10] in keep:
            by_hour[int(key[11:13])] = max(by_hour[int(key[11:13])], v)
    return by_hour


def forecast_rest_of_day(hourly: dict, now: datetime) -> int:
    """Writes still to come today: each remaining UTC hour (the current one in
    full) at its max over the last 7 complete days."""
    mx = hourly_max(hourly, now)
    return sum(mx[h] for h in range(now.hour, 24))


def anomalous_hours_today(hourly: dict, now: datetime) -> list:
    mx, today = hourly_max(hourly, now), now.strftime("%Y-%m-%d")
    return sorted(k for k, v in hourly.items() if k[:10] == today and v > mx[int(k[11:13])] + ANOMALY_MARGIN)


def used_today(hourly: dict, now: datetime) -> int:
    today = now.strftime("%Y-%m-%d")
    return sum(v for k, v in hourly.items() if k[:10] == today)


def writes_since(hourly: dict, start: datetime) -> int:
    """Account writes in every hour bucket from start's hour on (spans 00:00 UTC)."""
    first = start.strftime("%Y-%m-%dT%H")
    return sum(v for k, v in hourly.items() if k >= first)


def read_guard(used: int, forecast: int, reserve: int, ceiling: int = READ_CEILING) -> dict:
    projected = used + forecast + reserve
    return {"reads_used_today": used, "reads_forecast_rest_of_day": forecast, "read_reserve": reserve,
            "projected_reads": projected, "read_ceiling": ceiling, "read_limit": READ_LIMIT,
            "reads_unused_after_worst_case": READ_LIMIT - projected, "ok": projected <= ceiling}


def usage_cross_check(hourly_reads: dict, hourly_writes: dict, info: dict, now: datetime,
                      tolerance: float = USAGE_DISAGREEMENT) -> dict:
    """`wrangler d1 info`'s rolling 24 h must fall inside the GraphQL hourly sum for
    the same span: lower = whole hours inside it, upper = also the hour it starts in;
    each widened by `tolerance`. Anything else means the usage numbers can't be trusted."""
    start = now - timedelta(hours=24)
    edge, cur = start.strftime("%Y-%m-%dT%H"), now.strftime("%Y-%m-%dT%H")
    out = {"ok": True}
    for name, hourly, key in (("reads", hourly_reads, "rows_read_24h"), ("writes", hourly_writes, "rows_written_24h")):
        upper = sum(v for k, v in hourly.items() if edge <= k <= cur)
        lower = upper - hourly.get(edge, 0)
        got = int(info[key])
        ok = lower * (1 - tolerance) <= got <= upper * (1 + tolerance)
        out[name] = {"graphql_lower": lower, "graphql_upper": upper, "d1_info_24h": got, "ok": ok}
        out["ok"] &= ok
    return out


def guard(used: int, forward: int, reserve: int, forecast: int, ceiling: int = DAILY_CEILING) -> dict:
    projected = used + forecast + forward + reserve
    return {"used_today": used, "forecast_rest_of_day": forecast, "forward_writes": forward,
            "rollback_reserve": reserve, "projected": projected, "ceiling": ceiling,
            "unused_after_worst_case": FREE_PLAN_LIMIT - projected, "ok": projected <= ceiling}


def in_window(now: datetime) -> bool:
    return WINDOW_START <= (now.hour, now.minute) <= WINDOW_LAST_START


def next_window(now: datetime) -> datetime:
    start = now.replace(hour=WINDOW_START[0], minute=WINDOW_START[1], second=0, microsecond=0)
    if in_window(now):
        return now
    return start if now < start else start + timedelta(days=1)


def showable(totals: dict, basis: dict, season_weeks: int) -> tuple[set, set]:
    """The player card's rule (#1353): a season's Pts Rk shows when the rank's own
    basis (src_pointssummary points_total, games_played) equals the weekly total
    (rounded to 0.1) and week count; its PPG Rk additionally needs half the
    season's UPS weeks. totals / basis: {player_id: (pts, games)}."""
    half = math.ceil(season_weeks / 2)
    pts_ok = {pid for pid, (bp, bg) in basis.items()
              if pid in totals and abs(float(bp) - round(totals[pid][0], 1)) < 0.05 and int(bg) == totals[pid][1]}
    return pts_ok, {pid for pid in pts_ok if totals[pid][1] >= half}


def mfl_facts(data) -> object:
    """The parts of an MFL reply the plan depends on: each player's score, or
    each franchise's lineup (player, status). Volatile fields are ignored."""
    as_list = lambda v: v if isinstance(v, list) else ([] if v is None else [v])
    if data is None:
        return None
    if "playerScores" in data:
        return sorted((str(p.get("id")), str(p.get("score"))) for p in as_list(data["playerScores"].get("playerScore")))
    wr = data.get("weeklyResults") or {}
    frs = [f for m in as_list(wr.get("matchup")) for f in as_list(m.get("franchise"))] + as_list(wr.get("franchise"))
    return sorted((str(f.get("id")), str(p.get("id")), str(p.get("status"))) for f in frs for p in as_list(f.get("player")))


def calendar(batches: list, used_by_window: list, forecast: int) -> list:
    """Likely nights, in order, if night i has used_by_window[i] writes by 22:05 UTC.
    A batch that does not fit (with its rollback reserve) waits; order is kept."""
    nights, i, todo = [], 0, list(batches)
    while todo and i < len(used_by_window):
        used, ran = used_by_window[i], []
        while todo and guard(used, todo[0]["billed_writes"], todo[0]["rollback_reserve"], forecast)["ok"]:
            used += todo[0]["billed_writes"]
            ran.append(todo.pop(0)["batch"])
        nights.append((i, ran))
        i += 1
    return nights


# ──────────────────────────────────────────────────────────────────────
# Remote reads: Cloudflare metrics, D1, MFL, worker
# ──────────────────────────────────────────────────────────────────────

def oauth_token() -> str:
    cfg = Path.home() / ".wrangler" / "config" / "default.toml"
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', cfg.read_text())
    if not m:
        raise SystemExit("STOP: no wrangler OAuth token; run `npx wrangler whoami` first")
    return m.group(1)


def account_hourly_writes(days: int = FORECAST_DAYS + 1) -> dict:
    """{'YYYY-MM-DDTHH': rowsWritten} summed over every D1 database in the account."""
    return account_hourly_usage(days)[0]


def account_hourly_usage(days: int = FORECAST_DAYS + 1) -> tuple[dict, dict]:
    """({hour: rowsWritten}, {hour: rowsRead}), each summed over every D1 database in the account."""
    end = utc_now().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    q = ("query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){"
         "d1AnalyticsAdaptiveGroups(limit:10000,filter:{datetimeHour_geq:$s,datetimeHour_lt:$e}){"
         "sum{rowsWritten rowsRead} dimensions{datetimeHour databaseId}}}}}")
    body = json.dumps({"query": q, "variables": {"a": ACCOUNT_ID, "s": iso(end - timedelta(days=days)),
                                                  "e": iso(end)}}).encode()
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=body,
                                 headers={"Authorization": f"Bearer {oauth_token()}",
                                          "Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=60).read())
    if d.get("errors") or not d.get("data"):
        raise SystemExit(f"STOP: usage metrics unavailable: {d.get('errors')}")
    out, reads = defaultdict(int), defaultdict(int)
    for g in d["data"]["viewer"]["accounts"][0]["d1AnalyticsAdaptiveGroups"]:
        out[g["dimensions"]["datetimeHour"][:13]] += int(g["sum"]["rowsWritten"])
        reads[g["dimensions"]["datetimeHour"][:13]] += int(g["sum"]["rowsRead"])
    return dict(out), dict(reads)


def d1_info_24h() -> dict:
    """Rolling-24 h rows read / written summed over every D1 database (`wrangler d1 list` + `d1 info`;
    control plane, reads no D1 rows). Raises SystemExit (fail closed) on any failure."""
    def wr(*a):
        r = subprocess.run(["npx", "wrangler", "d1", *a, "--json"], capture_output=True, text=True,
                           cwd=str(REPO_ROOT / "worker"), env={**os.environ, "WRANGLER_SEND_METRICS": "false"})
        i = min([x for x in (r.stdout.find("["), r.stdout.find("{")) if x >= 0], default=-1)
        if r.returncode != 0 or i < 0:
            raise SystemExit(f"STOP: `wrangler d1 {' '.join(a)}` failed: {(r.stderr or r.stdout)[-300:]}")
        return json.loads(r.stdout[i:])
    dbs = wr("list")
    if not dbs:
        raise SystemExit("STOP: `wrangler d1 list` returned no databases")
    tot = {"rows_read_24h": 0, "rows_written_24h": 0, "databases": []}
    for db in dbs:
        info = wr("info", db["name"])
        for k in ("rows_read_24h", "rows_written_24h"):
            if not isinstance(info.get(k), int):
                raise SystemExit(f"STOP: `wrangler d1 info {db['name']}` has no {k}")
            tot[k] += info[k]
        tot["databases"].append(db["name"])
    return tot


def d1(sql: str, allow_write: bool = False) -> list:
    """One `wrangler d1 execute --remote --json --command`; per-statement results.
    SELECT-only unless allow_write (set only by apply / rollback)."""
    if not allow_write and not re.match(r"^\s*SELECT\b", sql, re.I):
        raise ValueError("read path runs SELECT only")
    res = subprocess.run(["npx", "wrangler", "d1", "execute", D1_DB, "--remote", "--json", "--command", sql],
                         capture_output=True, text=True, cwd=str(REPO_ROOT / "worker"),
                         env={**os.environ, "WRANGLER_SEND_METRICS": "false"})
    out = res.stdout[res.stdout.find("["):] if "[" in res.stdout else ""
    if res.returncode != 0 or not out:
        blob = (res.stderr + res.stdout)[-1500:]
        raise RuntimeError(("DAILY LIMIT: " if "limit" in blob.lower() else "") + blob)
    return json.loads(out)


def season_playoff_rows(season: int) -> tuple[list, int]:
    last_reg = 14 if season >= 2021 else 13
    r = d1(f"SELECT * FROM src_weekly WHERE season = {int(season)} AND week > {last_reg}")[0]
    return r["results"], int(r["meta"].get("rows_read") or 0)


def season_reconciliation(season: int, season_weeks: int) -> dict:
    """Season player totals (the card's rule: score IS NOT NULL) vs src_pointssummary.
    Two keyed reads: about the season's rows + its src_pointssummary rows."""
    a = d1(f"SELECT player_id, COUNT(*) AS g, SUM(score) AS pts FROM src_weekly "
           f"WHERE season = {int(season)} AND score IS NOT NULL GROUP BY player_id")[0]
    b = d1(f"SELECT player_id, games_played, points_total FROM src_pointssummary WHERE season = {int(season)}")[0]
    totals = {str(r["player_id"]): (float(r["pts"] or 0), int(r["g"])) for r in a["results"]}
    basis = {str(r["player_id"]): (float(r["points_total"] or 0), int(r["games_played"] or 0)) for r in b["results"]}
    pts_ok, ppg_ok = showable(totals, basis, season_weeks)
    return {"pts_showable": len(pts_ok), "ppg_showable": len(ppg_ok), "pts_sha256": ids_hash(pts_ok),
            "ppg_sha256": ids_hash(ppg_ok), "hidden": sorted(set(basis) - pts_ok),
            "rows_read": int(a["meta"].get("rows_read") or 0) + int(b["meta"].get("rows_read") or 0)}


def mfl_get(season: int, params: dict):
    url = f"https://api.myfantasyleague.com/{season}/export?{urllib.parse.urlencode({**params, 'JSON': '1'})}"
    req = urllib.request.Request(url, headers={"User-Agent": "ups-1307-preflight/1.0 (read-only)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    time.sleep(6)
    return url, data


def cached_mfl(artifacts: Path, url: str):
    p = artifacts / "mflcache" / (re.sub(r"[^A-Za-z0-9]", "_", url.replace("https://", "")) + ".json")
    return json.loads(p.read_text()) if p.exists() else None


def worker_bundle(pid: str) -> dict:
    url = f"{WORKER}/api/player-bundle?pid={urllib.parse.quote(pid)}&L=74598"
    req = urllib.request.Request(url, headers={"User-Agent": "ups-1307-panel-check/1.0 (read-only)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def running_write_jobs() -> list:
    busy = []
    try:
        res = subprocess.run(["gh", "run", "list", "--status", "in_progress", "--json", "workflowName,path",
                              "--limit", "50"], capture_output=True, text=True, cwd=str(REPO_ROOT), timeout=60)
        runs = json.loads(res.stdout or "[]") if res.returncode == 0 else None
    except Exception:
        runs = None
    if runs is None:
        busy.append("could not list GitHub runs (fail closed)")
    else:
        busy += [r["path"] for r in runs if any(r.get("path", "").endswith(w) for w in WRITE_HEAVY_WORKFLOWS)]
    ps = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
    busy += [p for p in WRITE_HEAVY_PROCESSES if p in ps]
    return busy


# ──────────────────────────────────────────────────────────────────────
# plan (offline)
# ──────────────────────────────────────────────────────────────────────

def load_jsonl(p: Path) -> list:
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()] if p.exists() else []


def read_budget(preimage_rows: int, after_rows: int, inserted: int, rec: dict, meas: dict) -> dict:
    """1A's complete D1 read reservation: every read a run can make, worst case."""
    preflight = preimage_rows + rec["season_rows_before"] + rec["pointssummary_rows"]
    verify = after_rows + rec["season_rows_before"] + inserted + rec["pointssummary_rows"]
    writes = meas["totals"]["rerun_rows_read"]          # measured 0 on a first run; a full re-run reads 2,664
    rollback = meas["totals"]["rollback_rows_read"] + preimage_rows   # deletes + the preimage re-read
    panel = len(rec["panel_examples"]) * BUNDLE_READ_RESERVE
    parts = {"preflight_d1": preflight, "during_writes_worst_case": writes, "apply_verify_d1": verify,
             "runbook_verify_d1": verify, "rollback_worst_case": rollback, "panel_check_reserve": panel}
    return {**parts, "reserve_total": sum(parts.values()), "mfl_gets": 6,
            "panel_check_d1_bundle_gets": len(rec["panel_examples"]),
            "bundle_read_reserve_each": BUNDLE_READ_RESERVE}


def build_plan(artifacts: Path) -> dict:
    """v2: 1A ready (phase B 2025, weekly ranks NULL), 1C held, the rest pending."""
    nul = artifacts / "out_ranks_null"
    stf = nul / "statements" / "B_2025.json"
    st = json.loads(stf.read_text())
    exp = [statement_expectation(x) for x in st["forward"]]
    inserted = sum(e["rows"] for e in exp)
    billed = sum(e["rows_written"] for e in exp)
    meas = json.loads((nul / "d1_measure_1a.json").read_text())
    if billed != meas["totals"]["forward_rows_written"]:
        raise SystemExit(f"plan: 1A expected {billed} != Miniflare-measured {meas['totals']['forward_rows_written']}")
    snap = json.loads((artifacts / "d1_snapshot" / "playoff_2025.json").read_text())["rows"]
    after = {(r["week"], str(r["player_id"])): dict(r) for r in snap}
    new = load_jsonl(nul / "proposed" / "B_2025.jsonl")
    if any(r["pos_rank"] is not None or r["overall_rank"] is not None for r in new):
        raise SystemExit("plan: 1A rows must carry NULL weekly ranks")
    for r in new:
        after[(r["week"], r["player_id"])] = {c: r[c] for c in COLS}
    rec = json.loads((artifacts / "recon_2025_1a.json").read_text())
    # PR #1372 holds these 2025 ranks back from /api/player-bundle (null + rank_pending) until the
    # clean recount is approved; it must be live before 1A, so panel-check expects them held.
    held = json.loads((artifacts / "rank_pending_2025.json").read_text())
    examples = [{**ex, "rank_pending_fields": [k for k in ("pos_rank", "pos_ppg_rank") if ex["player_id"] in held[k]]}
                for ex in rec["panel_examples"]]
    c_upd = len(load_jsonl(artifacts / "out" / "proposed" / "C_2025.jsonl"))
    batch_1a = {
        "batch": "1A", "status": "ready", "phases": ["B"], "season": 2025, "weeks": [15, 16, 17],
        "what": "insert every 2025 playoff-week player MFL scored but src_weekly lacks (free agent / taxi / "
                "IR, status proven by MFL); pos_rank / overall_rank NULL",
        "rows_inserted": inserted, "rows_updated": 0, "billed_writes": billed,
        "rollback_reserve": rollback_reserve(inserted, 0), "statements": len(st["forward"]),
        "statement_file": "out_ranks_null/statements/B_2025.json", "statement_file_sha256": sha256_file(stf),
        "calibration": {"first_statement_rows": exp[0]["rows"], "first_statement_billed": exp[0]["rows_written"],
                        "its_rollback_reserve": rollback_reserve(exp[0]["rows"], 0)},
        "reads": read_budget(len(snap), len(after), inserted, rec, meas),
        "preimage": {"rows": len(snap), "sha256": rows_hash(snap)},
        "after": {"rows": len(after), "sha256": rows_hash(list(after.values())),
                  "null_weekly_ranks": len(new), "null_status": sum(1 for r in new if r["status"] is None)},
        "reconciliation": {
            "season_weeks": 17,
            "before": {"pts_showable": len(rec["before_ids"]), "pts_sha256": ids_hash(rec["before_ids"]),
                       "ppg_showable": len(rec["ppg_before_ids"]), "ppg_sha256": ids_hash(rec["ppg_before_ids"])},
            "after": {"pts_showable": len(rec["after_ids"]), "pts_sha256": ids_hash(rec["after_ids"]),
                      "ppg_showable": len(rec["ppg_after_ids"]), "ppg_sha256": ids_hash(rec["ppg_after_ids"])},
            "hidden_after": [h["player_id"] for h in rec["hidden"]],
        },
        "panel_examples": examples,
        "rank_pending_safeguard": {"pr": 1372, "pos_rank": len(held["pos_rank"]), "pos_ppg_rank": len(held["pos_ppg_rank"]),
                                   "pos_rank_sha256": ids_hash(held["pos_rank"]),
                                   "pos_ppg_rank_sha256": ids_hash(held["pos_ppg_rank"])},
        "rollback": "delete exactly the inserted keys (statement file 'rollback'); restore is checked "
                    "against the preimage hash",
        "local_replay": {"miniflare": meas["totals"], "before": meas["before"], "after_forward": meas["after_forward"],
                         "after_rollback": meas["after_rollback"]},
    }
    return {
        "issue": 1307, "dry_run_pr": 1363, "plan_version": PLAN_VERSION,
        "scope": "authoritative score rows only; ranks held for the rank-definition review",
        "daily_ceiling": DAILY_CEILING, "reset": "00:00 UTC daily (Cloudflare D1 pricing page); account-wide",
        "guard": "used_today + forecast_rest_of_day + forward_writes + rollback_reserve <= 90,000",
        "window_utc": "start 22:05-23:30",
        "read_guard": {"ceiling": READ_CEILING, "limit": READ_LIMIT,
                       "rule": "reads_used_today (GraphQL rowsRead, every D1 database, current UTC day) + "
                               "reads_forecast_rest_of_day (7-day per-hour max) + read reserve <= 4,500,000; "
                               "GraphQL must bracket `wrangler d1 info` 24 h totals (all databases) within 5%, "
                               "or the batch stops before its first D1 read"},
        "attempt_lock": {"ledger": "~/.ups_jobs/1307_src_weekly/attempts/ (fixed path)",
                         "rule": "one apply attempt per approval, consumed before the first production read and "
                                 "never released (preflight STOP, failure, automatic rollback and crash included); "
                                 "a later attempt needs a newer approval comment; rollback approvals are single-use "
                                 "and never reuse an apply approval; verify stays read-only"},
        "batches": [batch_1a],
        "held": [{"batch": "1C", "status": "held", "phases": ["C"], "season": 2025, "rows_updated": c_upd,
                  "billed_writes": c_upd, "reason": "weekly rank tie convention is part of the rank-definition "
                  "review: 625 of the 630 changes only re-order tied scores by player id"}],
        "pending": {"status": "pending; no executable SQL in this plan; to be regenerated after the "
                              "rank-definition review", "phase_B_2021_2024_rows": 10728,
                    "phase_A_2011_2020_rows": 34900, "phase_C_2021_2024_rows": 2433},
    }


# ──────────────────────────────────────────────────────────────────────
# Subcommands
# ──────────────────────────────────────────────────────────────────────

def load_batch(args) -> dict:
    plan = json.loads(Path(args.plan).read_text())
    if plan.get("plan_version") != PLAN_VERSION:
        raise SystemExit("STOP: plan version mismatch")
    b = next((x for x in plan["batches"] if x["batch"] == args.batch), None)
    if not b or b.get("status") != "ready":
        raise SystemExit(f"STOP: batch {args.batch} is not a ready batch in this plan")
    if getattr(args, "artifacts", None):
        p = Path(args.artifacts) / b["statement_file"]
        if sha256_file(p) != b["statement_file_sha256"]:
            raise SystemExit(f"STOP: {b['statement_file']} differs from the reviewed plan")
    return b


def statements(args, b: dict, key: str) -> list:
    return json.loads((Path(args.artifacts) / b["statement_file"]).read_text())[key]


def usage_report(forward: int = 0, reserve: int = 0, now: datetime | None = None, read_reserve: int = 0) -> dict:
    now = now or utc_now()
    hourly, reads = account_hourly_usage()
    info = d1_info_24h()
    g = guard(used_today(hourly, now), forward, reserve, forecast_rest_of_day(hourly, now))
    g["anomalous_hours_today"] = anomalous_hours_today(hourly, now)
    g["reads"] = read_guard(used_today(reads, now), forecast_rest_of_day(reads, now), read_reserve)
    g["cross_check"] = usage_cross_check(reads, hourly, info, now)
    if not g["cross_check"]["ok"]:
        # `wrangler d1 info` has returned 0 for its 24 h counters on a call made seconds after a
        # correct one (2026-10-22). Re-read it once; a second disagreement stops the batch.
        time.sleep(30)
        first = g["cross_check"]
        g["cross_check"] = usage_cross_check(reads, hourly, d1_info_24h(), now)
        g["cross_check"]["first_attempt"] = first
    g["writes_ok"] = g["ok"] and not g["anomalous_hours_today"]
    g["ok"] = g["writes_ok"] and g["reads"]["ok"] and g["cross_check"]["ok"]
    g.update({"now_utc": iso(now), "in_window": in_window(now), "next_window_utc": iso(next_window(now)),
              "_hourly": hourly})
    return g


def cmd_usage(args) -> int:
    g = usage_report(args.batch_writes, args.rollback_reserve, read_reserve=args.read_reserve)
    g.pop("_hourly")
    print(json.dumps(g, indent=1))
    return 0


def preflight(args, b: dict, enforce_window: bool = True) -> dict:
    """Read-only. Returns the facts apply needs; facts['stops'] lists every STOP."""
    art = Path(args.artifacts)
    stops, facts = [], {"batch": b["batch"], "season": b["season"], "at_utc": iso(utc_now())}
    # Every usage check runs before the first D1 read; a metrics failure raises (fail closed).
    g = usage_report(b["billed_writes"], b["rollback_reserve"], read_reserve=b["reads"]["reserve_total"])
    facts["hourly_at_start"] = g.pop("_hourly")
    facts["usage"] = g
    if not g["cross_check"]["ok"]:
        facts["stops"] = [f"usage sources disagree beyond {USAGE_DISAGREEMENT:.0%}: {g['cross_check']}"]
        return facts
    if not g["reads"]["ok"]:
        facts["stops"] = [f"projected reads {g['reads']['projected_reads']:,} (incl. read reserve "
                          f"{g['reads']['read_reserve']:,}) > read ceiling {g['reads']['read_ceiling']:,}"]
        return facts
    if enforce_window and not g["in_window"]:
        stops.append(f"outside the 22:05-23:30 UTC start window (next {g['next_window_utc']})")
    if g["anomalous_hours_today"]:
        stops.append(f"unscheduled heavy writes today in hours {g['anomalous_hours_today']}")
    if g["projected"] > g["ceiling"]:
        stops.append(f"projected {g['projected']:,} (incl. rollback reserve) > ceiling {g['ceiling']:,}")
    busy = running_write_jobs()
    if busy:
        stops.append(f"write-heavy job running: {busy}")
    rows, read = season_playoff_rows(b["season"])
    facts["d1_rows_read"] = read
    if len(rows) != b["preimage"]["rows"] or rows_hash(rows) != b["preimage"]["sha256"]:
        stops.append(f"target weeks changed since the dry run: {len(rows)} rows, hash {rows_hash(rows)[:12]}")
    pre = art / "preimages" / f"batch_{b['batch']}_{b['season']}.json"
    pre.parent.mkdir(exist_ok=True)
    pre.write_text(json.dumps({"captured_at_utc": facts["at_utc"], "rows": rows}))
    facts["preimage_file"] = str(pre)
    rc = season_reconciliation(b["season"], b["reconciliation"]["season_weeks"])
    facts["reconciliation_before"] = {k: v for k, v in rc.items() if k != "hidden"}
    facts["d1_rows_read"] += rc["rows_read"]
    want = b["reconciliation"]["before"]
    if (rc["pts_sha256"], rc["ppg_sha256"]) != (want["pts_sha256"], want["ppg_sha256"]):
        stops.append(f"season totals do not reconcile to the approved before-state "
                     f"({rc['pts_showable']} / {rc['ppg_showable']} vs {want['pts_showable']} / {want['ppg_showable']})")
    for w in b["weeks"]:
        for params in ({"TYPE": "playerScores", "L": league_id(b["season"]), "W": str(w)},
                       {"TYPE": "weeklyResults", "L": league_id(b["season"]), "W": str(w), "MISSING_AS_BYE": "1"}):
            url, live = mfl_get(b["season"], params)
            if mfl_facts(live) != mfl_facts(cached_mfl(art, url)):
                stops.append(f"MFL changed since the dry run: {params['TYPE']} W={w}")
    facts["stops"] = stops
    return facts


def cmd_preflight(args) -> int:
    if not args.allow_prod_d1_read:
        print("SKIPPED: preflight reads production D1; pass --allow-prod-d1-read.")
        return 0
    facts = preflight(args, load_batch(args), enforce_window=False)
    facts.pop("hourly_at_start", None)
    print(json.dumps(facts, indent=1))
    return 1 if facts["stops"] else 0


def verify(b: dict) -> dict:
    rows, read = season_playoff_rows(b["season"])
    rc = season_reconciliation(b["season"], b["reconciliation"]["season_weeks"])
    want = b["reconciliation"]["after"]
    return {"rows": len(rows), "expected_rows": b["after"]["rows"], "rows_read": read + rc["rows_read"],
            "after_hash_ok": len(rows) == b["after"]["rows"] and rows_hash(rows) == b["after"]["sha256"],
            "reconciliation": {k: v for k, v in rc.items() if k != "rows_read"},
            "reconciliation_ok": (rc["pts_sha256"], rc["ppg_sha256"]) == (want["pts_sha256"], want["ppg_sha256"])
            and rc["hidden"] == sorted(b["reconciliation"]["hidden_after"])}


def cmd_verify(args) -> int:
    if not args.allow_prod_d1_read:
        print("SKIPPED: verify reads production D1; pass --allow-prod-d1-read.")
        return 0
    v = verify(load_batch(args))
    print(json.dumps(v))
    return 0 if v["after_hash_ok"] and v["reconciliation_ok"] else 1


def run_writes(stmts: list, log: Path) -> dict:
    """Inserts one per command (the first is the 80-row billing calibration);
    UPDATEs / DELETEs grouped UPDATES_PER_COMMAND per command. Every statement's
    meta is checked; the first deviation raises Invariant."""
    groups, cur = [], []
    for s in stmts:
        if s.lstrip().upper().startswith("INSERT"):
            if cur:
                groups.append(cur)
                cur = []
            groups.append([s])
        else:
            cur.append(s)
            if len(cur) == UPDATES_PER_COMMAND:
                groups.append(cur)
                cur = []
    if cur:
        groups.append(cur)
    tot = {"statements": 0, "rows_written": 0, "rows_read": 0, "changes": 0}
    with open(log, "a") as lf:
        for grp in groups:
            try:
                res = d1("\n".join(grp), allow_write=True)
            except Exception as e:
                raise Invariant(f"write error after {tot['statements']} statements: {str(e)[:300]}")
            if len(res) != len(grp):
                raise Invariant(f"D1 returned {len(res)} results for {len(grp)} statements")
            for sql, r in zip(grp, res):
                m = r.get("meta") or {}
                tot["statements"] += 1
                tot["rows_written"] += int(m.get("rows_written") or 0)
                tot["rows_read"] += int(m.get("rows_read") or 0)
                tot["changes"] += int(m.get("changes") or 0)
                lf.write(json.dumps({"at": iso(utc_now()), "sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                                     "meta": {k: m.get(k) for k in ("rows_written", "rows_read", "changes")}}) + "\n")
                why = check_meta(statement_expectation(sql), m)
                if why:
                    raise Invariant(f"statement {tot['statements']}: {why}; totals {tot}")
    return tot


def restore(args, b: dict, log: Path) -> dict:
    """Undo the batch: delete exactly the inserted keys (idempotent), then require
    the preimage hash."""
    stmts = statements(args, b, "rollback")
    with open(log, "a") as lf:
        for grp in [stmts[i:i + UPDATES_PER_COMMAND] for i in range(0, len(stmts), UPDATES_PER_COMMAND)]:
            res = d1("\n".join(grp), allow_write=True)
            for sql, r in zip(grp, res):
                lf.write(json.dumps({"rollback_sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                                     "meta": {k: (r.get("meta") or {}).get(k) for k in ("rows_written", "changes")}}) + "\n")
    rows, _ = season_playoff_rows(b["season"])
    ok = len(rows) == b["preimage"]["rows"] and rows_hash(rows) == b["preimage"]["sha256"]
    with open(log, "a") as lf:
        lf.write(json.dumps({"restored_rows": len(rows), "identical_to_preimage": ok}) + "\n")
    return {"restored_rows": len(rows), "identical_to_preimage": ok}


def approved(args) -> bool:
    return bool(args.execute) and bool(APPROVAL_RE.match(args.approval or ""))


def approval_comment_id(url: str) -> int:
    return int(url.rsplit("-", 1)[1])


def attempts(batch: str) -> list:
    """Every recorded attempt for a batch, oldest first, each with its outcomes."""
    out = []
    for f in sorted(ATTEMPT_DIR.glob(f"batch_{batch}_*.json")):
        a = json.loads(f.read_text())
        o = f.with_suffix(".outcome.jsonl")
        a["outcomes"] = [json.loads(x) for x in o.read_text().splitlines() if x.strip()] if o.exists() else []
        out.append(a)
    return sorted(out, key=lambda a: a["approval_comment_id"])


def consume_approval(batch: str, kind: str, approval: str, now: datetime) -> Path:
    """Record that this approval has started its one attempt. Raises SystemExit
    (nothing done) if it, or an older approval, is already recorded for the batch."""
    cid = approval_comment_id(approval)
    prior = attempts(batch)
    used = [a for a in prior if a["approval_comment_id"] >= cid]
    if used:
        u = next((a for a in used if a["approval_comment_id"] == cid), used[-1])
        raise SystemExit(f"STOP: approval {approval} cannot start an attempt: {u['kind']} attempt with approval "
                         f"{u['approval']} began {u['started_utc']}. Another attempt needs a NEW approval "
                         "comment from Keith. Nothing was done.")
    ATTEMPT_DIR.mkdir(parents=True, exist_ok=True)
    path = ATTEMPT_DIR / f"batch_{batch}_{kind}_{cid}.json"
    rec = {"batch": batch, "kind": kind, "approval": approval, "approval_comment_id": cid,
           "started_utc": iso(now), "night_utc": now.date().isoformat(), "pid": os.getpid()}
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)   # a concurrent second run fails here
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps(rec) + "\n")
    return path


def attempt_outcome(path: Path, outcome: str, **detail) -> None:
    with open(path.with_suffix(".outcome.jsonl"), "a") as fh:
        fh.write(json.dumps({"at_utc": iso(utc_now()), "outcome": outcome, **detail}) + "\n")


def cmd_apply(args) -> int:
    b = load_batch(args)
    if not approved(args):
        print("DRY: apply writes production D1 and needs --execute and --approval <Keith's comment URL> "
              "for this batch. Nothing was done.")
        return 0
    art = Path(args.artifacts)
    lock = consume_approval(b["batch"], "apply", args.approval, utc_now())
    try:
        return _apply(args, b, art, lock)
    except BaseException as e:
        # Whatever happened, the approval stays consumed; record how it ended.
        attempt_outcome(lock, "stopped", detail=str(e)[:500])
        raise


def _apply(args, b: dict, art: Path, lock: Path) -> int:
    facts = preflight(args, b)
    if facts["stops"]:
        facts.pop("hourly_at_start", None)
        print(json.dumps(facts, indent=1))
        raise SystemExit("STOP: preflight failed; nothing written (this approval is now used)")
    started = utc_now()
    attempt_outcome(lock, "writes_starting")
    before_since = writes_since(facts.pop("hourly_at_start"), started)
    log = art / "runs" / f"batch_{b['batch']}_{b['season']}_{started.strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    log.parent.mkdir(exist_ok=True)
    log.write_text(json.dumps({"approval": args.approval, "preflight": facts}) + "\n")
    try:
        tot = run_writes(statements(args, b, "forward"), log)
        if tot["rows_written"] != b["billed_writes"]:
            raise Invariant(f"batch billed {tot['rows_written']} != planned {b['billed_writes']}")
        v = verify(b)
        if not v["after_hash_ok"]:
            raise Invariant(f"after-state differs from the plan: {v['rows']} rows")
        if not v["reconciliation_ok"]:
            raise Invariant(f"post-batch reconciliation differs from the approved result: {v['reconciliation']}")
    except Invariant as e:
        with open(log, "a") as lf:
            lf.write(json.dumps({"invariant_failed": str(e), "automatic_rollback": True}) + "\n")
        print(f"INVARIANT FAILED: {e}\nAutomatic rollback (authorized by the batch approval)...")
        r = restore(args, b, log)
        print(json.dumps(r))
        attempt_outcome(lock, "automatic_rollback", invariant=str(e)[:500], **r)
        raise SystemExit("STOPPED and rolled back" if r["identical_to_preimage"]
                         else "STOPPED; rollback did NOT restore the preimage -- escalate to Keith")
    print(json.dumps({"writes": tot, "verify": v}))
    attempt_outcome(lock, "verified", writes=tot)
    time.sleep(SETTLE_MINUTES * 60)
    after_since = writes_since(account_hourly_writes(), started)
    other = after_since - before_since - tot["rows_written"]
    result = {"account_writes_since_start_before": before_since, "after": after_since,
              "batch_rows_written": tot["rows_written"], "other_writes_meanwhile": other,
              "ok": other <= OTHER_WRITES_ALLOWANCE}
    with open(log, "a") as lf:
        lf.write(json.dumps({"post": result, "verify": v}) + "\n")
    print(json.dumps(result))
    attempt_outcome(lock, "post_check", **result)
    if not result["ok"]:
        raise SystemExit("STOP: account usage moved more than this batch explains; no further batch tonight")
    return 0


def cmd_rollback(args) -> int:
    """Discretionary rollback of a VERIFIED batch: needs its own approval."""
    b = load_batch(args)
    if not approved(args):
        print("DRY: rollback writes production D1 and needs --execute and --approval <comment URL>. Nothing was done.")
        return 0
    lock = consume_approval(b["batch"], "rollback", args.approval, utc_now())
    try:
        g = usage_report(b["rollback_reserve"], 0, read_reserve=b["reads"]["rollback_worst_case"])
        g.pop("_hourly")
        if g["projected"] > g["ceiling"]:
            raise SystemExit(f"STOP: rollback could breach the daily ceiling ({g['projected']:,})")
        if not (g["reads"]["ok"] and g["cross_check"]["ok"]):
            raise SystemExit(f"STOP: rollback read check failed: {g['reads']} {g['cross_check']}")
        log = Path(args.artifacts) / "runs" / f"rollback_{b['batch']}_{utc_now().strftime('%Y%m%dT%H%M%SZ')}.jsonl"
        log.parent.mkdir(exist_ok=True)
        log.write_text(json.dumps({"approval": args.approval, "usage": g}) + "\n")
        r = restore(args, b, log)
    except BaseException as e:
        attempt_outcome(lock, "stopped", detail=str(e)[:500])
        raise
    attempt_outcome(lock, "rolled_back", **r)
    print(json.dumps(r))
    return 0 if r["identical_to_preimage"] else 1


def cmd_attempts(args) -> int:
    """Offline: the attempt ledger for a batch (who approved, when it began, how it ended)."""
    print(json.dumps({"ledger": str(ATTEMPT_DIR), "attempts": attempts(args.batch)}, indent=1))
    return 0


def cmd_panel_check(args) -> int:
    """After a verified batch: the player panel's inputs for the plan's example
    players, from the live worker (read-only)."""
    if not args.allow_prod_read:
        print("SKIPPED: panel-check calls the production worker; pass --allow-prod-read.")
        return 0
    b = load_batch(args)
    out, ok = [], True
    for ex in b["panel_examples"]:
        bundle = worker_bundle(ex["player_id"])
        row = next((r for r in bundle.get("career_summary") or [] if int(r.get("season") or 0) == b["season"]), None)
        got = row and [round(float(row["season_points"]), 1), int(row["games_played"]),
                       row.get("pos_rank"), row.get("pos_ppg_rank")]
        # A rank #1372 holds back comes as null with rank_pending naming it (proves the safeguard is live).
        held = ex.get("rank_pending_fields", [])
        want = [ex["after"][0], ex["after"][1], None if "pos_rank" in held else ex["stored_rank"][0],
                None if "pos_ppg_rank" in held else ex["stored_rank"][1]]
        pending = ((row or {}).get("rank_pending") or {}).get("fields") or []
        shows = bool(row) and abs(ex["rank_basis"][0] - got[0]) < 0.05 and ex["rank_basis"][1] == got[1]
        good = got == want and sorted(pending) == sorted(held) and shows == ex["shows_after"]
        ok &= good
        out.append({"player_id": ex["player_id"], "name": ex["name"], "got": got, "want": want,
                    "rank_pending": pending, "expected_rank_pending": held,
                    "rank_shows": shows, "expected_shows": ex["shows_after"], "ok": good})
    print(json.dumps(out, indent=1))
    return 0 if ok else 1


SAFEGUARD_DIR = REPO_ROOT / "docs" / "data_fixes" / "1307_rank_pending"
SAFEGUARD_NAMED = ["17086", "16390", "17124", "14252", "13307"]   # Royals both; McLaughlin Pts; Carter PPG; panel PPG
SAFEGUARD_CONTROLS = ["12620", "12616", "17039"]                   # Dak, Brissett, Shough: newly shown, not held


def safeguard_sample(manifest: dict) -> list:
    """Deterministic minimal sample: the named cases, the first / middle / last held id of
    each field, the unaffected controls, and the first already-visible (not held) id of each field."""
    out = list(SAFEGUARD_NAMED)
    for f in ("pos_rank", "pos_ppg_rank"):
        ids = sorted((x["player_id"] for x in manifest["held"][f]), key=int)
        out += [ids[0], ids[len(ids) // 2], ids[-1]]
    out += SAFEGUARD_CONTROLS
    out += [manifest["not_held_already_visible"][f][0] for f in ("pos_rank", "pos_ppg_rank")]
    return list(dict.fromkeys(out))


def safeguard_expect(pid: str, manifest: dict, stored: dict) -> dict:
    """{field: None (held) or the stored rank} for the player's 2025 row."""
    held = {f: {x["player_id"] for x in manifest["held"][f]} for f in ("pos_rank", "pos_ppg_rank")}
    return {f: (None if pid in held[f] else stored[pid][f]) for f in ("pos_rank", "pos_ppg_rank")}


def safeguard_compare(pid: str, bundle: dict, manifest: dict, stored: dict, has_rows: bool = True) -> dict:
    """has_rows: the player has 2025 src_weekly rows in the D1 state being checked. Without them
    the bundle carries no stored rank at all (both null, nothing to hold, no rank_pending)."""
    rows = {int(r.get("season") or 0): r for r in bundle.get("career_summary") or []}
    row = rows.get(manifest["season"]) or {}
    want = safeguard_expect(pid, manifest, stored)
    if not has_rows:
        want = {f: None for f in want}
    got = {f: row.get(f) for f in want}
    held = sorted(f for f, v in want.items() if v is None) if has_rows else []
    rp = row.get("rank_pending") or {}
    ok = bool(row) and got == want and sorted(rp.get("fields") or []) == held \
        and (rp.get("reason") == manifest["reason"] if held else not rp)
    # Every other season stays untouched.
    others = [s for s, r in rows.items() if s != manifest["season"] and r.get("rank_pending")]
    return {"player_id": pid, "want": want, "got": got, "rank_pending": rp or None, "other_seasons_pending": others,
            "ok": ok and not others}


def cmd_safeguard_check(args) -> int:
    """Read-only consumer gate: the deployed /api/player-bundle holds exactly what the PR #1372
    manifest says, for a minimal deterministic sample. Read capacity is checked first."""
    if not args.allow_prod_read:
        print("SKIPPED: safeguard-check calls the production worker; pass --allow-prod-read.")
        return 0
    manifest = json.loads((SAFEGUARD_DIR / "manifest_2025.json").read_text())
    inputs = json.loads((SAFEGUARD_DIR / "inputs_2025.json").read_text())
    cols = inputs["columns"]
    stored = {r[0]: {"pos_rank": r[cols.index("stored_pos_rank")], "pos_ppg_rank": r[cols.index("stored_pos_ppg_rank")]}
              for r in inputs["rows"]}
    weeks_col = cols.index("d1_after_weeks" if args.after_batch else "d1_before_weeks")
    has_rows = {r[0]: r[weeks_col] > 0 for r in inputs["rows"]}
    sample = safeguard_sample(manifest)
    g = usage_report(0, 0, read_reserve=len(sample) * BUNDLE_READ_RESERVE)
    g.pop("_hourly")
    # A 14-GET gate (~400 rows each, 5,000 reserved) can't be what pushes a day over, so it needs
    # today's reads + its own reserve under the ceiling and agreeing sources, not the batch's
    # full-day forecast (that one applies to the batch itself, in preflight).
    r = g["reads"]
    gate_ok = r["reads_used_today"] + r["read_reserve"] <= r["read_ceiling"]
    if not (gate_ok and g["cross_check"]["ok"]):
        print(json.dumps({"reads": g["reads"], "cross_check": g["cross_check"]}, indent=1))
        raise SystemExit("STOP: read capacity or usage cross-check failed; no bundle was fetched")
    out = [safeguard_compare(pid, worker_bundle(pid), manifest, stored, has_rows[pid]) for pid in sample]
    ok = all(x["ok"] for x in out)
    print(json.dumps({"manifest_inputs_sha256": manifest["inputs_sha256"], "bundle_gets": len(sample),
                      "d1_state": "after Batch 1A" if args.after_batch else "before Batch 1A",
                      "reads": g["reads"], "results": out, "ok": ok}, indent=1))
    return 0 if ok else 1


def cmd_plan(args) -> int:
    plan = build_plan(Path(args.artifacts))
    Path(args.out).write_text(json.dumps(plan, indent=1) + "\n")
    b = plan["batches"][0]
    print(json.dumps({k: b[k] for k in ("batch", "rows_inserted", "billed_writes", "rollback_reserve", "statements")}))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--out", required=True)
    u = sub.add_parser("usage")
    u.add_argument("--batch-writes", type=int, default=0)
    u.add_argument("--rollback-reserve", type=int, default=0)
    u.add_argument("--read-reserve", type=int, default=0)
    a = sub.add_parser("attempts")
    a.add_argument("--batch", required=True)
    sg = sub.add_parser("safeguard-check")
    sg.add_argument("--allow-prod-read", action="store_true")
    sg.add_argument("--after-batch", action="store_true", help="expect the post-1A D1 state")
    for name in ("preflight", "apply", "verify", "rollback", "panel-check"):
        s = sub.add_parser(name)
        s.add_argument("--plan", required=True)
        s.add_argument("--batch", required=True)
        s.add_argument("--artifacts", required=name != "panel-check")
        if name in ("preflight", "verify"):
            s.add_argument("--allow-prod-d1-read", action="store_true")
        elif name == "panel-check":
            s.add_argument("--allow-prod-read", action="store_true")
        else:
            s.add_argument("--execute", action="store_true")
            s.add_argument("--approval", default="")
    args = ap.parse_args(argv)
    return {"plan": cmd_plan, "usage": cmd_usage, "preflight": cmd_preflight, "apply": cmd_apply,
            "verify": cmd_verify, "rollback": cmd_rollback, "panel-check": cmd_panel_check,
            "attempts": cmd_attempts, "safeguard-check": cmd_safeguard_check}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
