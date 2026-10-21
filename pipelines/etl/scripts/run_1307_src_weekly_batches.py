#!/usr/bin/env python3
"""run_1307_src_weekly_batches.py -- guarded executor for the #1307 src_weekly repair.

Runs the reviewed dry-run SQL (dryrun_1307_src_weekly_backfill.py, PR #1363)
one season-batch at a time, ONLY inside a Free-plan write budget. Nothing
remote happens unless a subcommand is given its opt-in flag; a write needs
--execute AND --approval <URL of Keith's GitHub comment approving that batch>.

Scope: phases A + B + C only (2011-2020 playoff weeks; 2021-2025 free agents in
playoff weeks; 2021-2025 playoff rank fixes). Phase E, the rank-table rebuild,
the 23 unresolved player-seasons and win_chunks are out of scope.

THE GUARD (all checks fail closed)
  * Cloudflare's Free limits reset daily at 00:00 UTC (D1 pricing page), and
    they are per ACCOUNT, so usage is summed over every D1 database.
  * Before a batch: read today's account-wide rowsWritten since 00:00 UTC from
    Cloudflare's GraphQL Analytics (d1AnalyticsAdaptiveGroups; control plane,
    reads no D1 rows) and forecast the rest of the UTC day as the max, per
    remaining hour, over the last 14 days. Refuse unless
        used_today + batch_billed_writes + forecast_rest_of_day <= 90,000.
  * batch_billed_writes counts inserts x 4 (table + PK index + 2 indexes) and
    updates x 1 (unindexed columns), as measured on Miniflare D1 in #1363.
  * Start only inside 22:05-23:30 UTC (no scheduled write-heavy job runs then;
    see the runbook), and only if no write-heavy workflow or local job is running.
  * During: every statement's meta.rows_written and meta.changes must equal its
    expected value; the first deviation stops the batch.
  * After: verify the season's playoff weeks row-for-row against the expected
    after-state, wait for the metrics to settle, and stop if the account delta
    exceeds this batch's writes plus the quiet-hour allowance.

SUBCOMMANDS
  plan      --artifacts DIR --out PLAN.json              offline: batch table
  usage                                                  control-plane metrics only
  preflight --plan P --artifacts DIR --batch N --allow-prod-d1-read
  apply     --plan P --artifacts DIR --batch N --execute --approval URL
  verify    --plan P --artifacts DIR --batch N --allow-prod-d1-read
  rollback  --plan P --artifacts DIR --batch N --execute --approval URL
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
COLS = ["season", "week", "player_id", "pos_group", "status", "score", "is_reg",
        "roster_franchise_id", "roster_franchise_name", "pos_rank", "overall_rank", "win_chunks"]

DAILY_CEILING = 90_000          # Free plan is 100,000/day; keep >= 10,000 unused
FREE_PLAN_LIMIT = 100_000
WINDOW_START = (22, 5)          # UTC; inside the window a batch may START
WINDOW_LAST_START = (23, 30)
SETTLE_MINUTES = 12             # GraphQL analytics lag
OTHER_WRITES_ALLOWANCE = 3_000  # quiet-hour writes by other jobs while a batch runs
FORECAST_DAYS = 7               # complete UTC days, all after the changed-only writer (#1267)
ANOMALY_MARGIN = 5_000          # an hour today this far above its 7-day max = unscheduled heavy job
UPDATES_PER_COMMAND = 25
LEAGUE_IDS = {2011: "40832", 2012: "37227", 2013: "42721", 2014: "30590", 2015: "29015", 2016: "27191"}

# Workflows / local jobs that write D1 in bulk; a batch never starts while one runs.
WRITE_HEAVY_WORKFLOWS = [
    "nflverse-stats-refresh.yml", "wc-rank-rebuild.yml", "mfl-daily-snapshot.yml", "nightly-builders.yml",
    "nightly-config-sync.yml", "contract-reconcile.yml", "ingest-projections.yml", "owner-career-stats.yml",
    "roster-anomaly-check.yml", "sleeper-cache-build.yml", "discord-chat-ingest.yml",
]
WRITE_HEAVY_PROCESSES = ["upsmfl-live-season-sync", "upsmfl-ups-center-auto", "deadline_drop_2026",
                         "sync_live_weekly_scores_to_d1", "load_local_to_d1", "fetch_nflverse"]

# Order: the most-used seasons first; one season per batch.
BATCH_ORDER = [("BC", s) for s in range(2025, 2020, -1)] + [("A", s) for s in range(2020, 2010, -1)]


def league_id(season: int) -> str:
    return LEAGUE_IDS.get(season, "74598")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def sha256_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


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
    bills 1 and changes 1; a DELETE of n keys changes n (billing not asserted)."""
    head = sql.lstrip()[:12].upper()
    if head.startswith("INSERT"):
        n = sql.count("\n(")
        return {"kind": "insert", "rows": n, "rows_written": 4 * n, "changes": n}
    if head.startswith("UPDATE"):
        return {"kind": "update", "rows": 1, "rows_written": 1, "changes": 1}
    if head.startswith("DELETE"):
        n = sql.count(",") + 1
        return {"kind": "delete", "rows": n, "rows_written": None, "changes": n}
    raise ValueError(f"unexpected statement: {sql[:60]}")


def check_meta(expect: dict, meta: dict) -> str | None:
    """None if D1's meta matches the statement's expectation, else the reason."""
    if expect["changes"] is not None and int(meta.get("changes") or 0) != expect["changes"]:
        return f"changes {meta.get('changes')} != expected {expect['changes']}"
    if expect["rows_written"] is not None and int(meta.get("rows_written") or 0) != expect["rows_written"]:
        return f"rows_written {meta.get('rows_written')} != expected {expect['rows_written']}"
    return None


def hourly_max(hourly: dict, now: datetime, days: int = FORECAST_DAYS) -> dict:
    """{hour: max rowsWritten that UTC hour reached} over the last `days` COMPLETE
    UTC days (account-wide)."""
    keep = {(now - timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, days + 1)}
    by_hour = defaultdict(int)
    for key, v in hourly.items():
        if key[:10] in keep:
            by_hour[int(key[11:13])] = max(by_hour[int(key[11:13])], v)
    return by_hour


def forecast_rest_of_day(hourly: dict, now: datetime) -> int:
    """Writes still to come today: for each remaining UTC hour (the current one
    in full), the max that hour reached over the last 7 complete days."""
    mx = hourly_max(hourly, now)
    return sum(mx[h] for h in range(now.hour, 24))


def anomalous_hours_today(hourly: dict, now: datetime) -> list:
    """Hours today already ANOMALY_MARGIN above their 7-day max: something
    unscheduled is writing, so no batch starts today."""
    mx, today = hourly_max(hourly, now), now.strftime("%Y-%m-%d")
    return sorted(k for k, v in hourly.items() if k[:10] == today and v > mx[int(k[11:13])] + ANOMALY_MARGIN)


def used_today(hourly: dict, now: datetime) -> int:
    today = now.strftime("%Y-%m-%d")
    return sum(v for k, v in hourly.items() if k[:10] == today)


def guard(used: int, batch_writes: int, forecast: int, ceiling: int = DAILY_CEILING) -> dict:
    projected = used + batch_writes + forecast
    return {"used_today": used, "batch_billed_writes": batch_writes, "forecast_rest_of_day": forecast,
            "projected": projected, "ceiling": ceiling, "unused_after": FREE_PLAN_LIMIT - projected,
            "ok": projected <= ceiling}


def in_window(now: datetime) -> bool:
    hm = (now.hour, now.minute)
    return WINDOW_START <= hm <= WINDOW_LAST_START


def next_window(now: datetime) -> datetime:
    start = now.replace(hour=WINDOW_START[0], minute=WINDOW_START[1], second=0, microsecond=0)
    if in_window(now):
        return now
    return start if now < start else start + timedelta(days=1)


# ──────────────────────────────────────────────────────────────────────
# Remote reads: Cloudflare metrics, D1 keyed SELECTs, MFL
# ──────────────────────────────────────────────────────────────────────

def oauth_token() -> str:
    # wrangler's OAuth token; `npx wrangler whoami` refreshes it.
    cfg = Path.home() / ".wrangler" / "config" / "default.toml"
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', cfg.read_text())
    if not m:
        raise SystemExit("STOP: no wrangler OAuth token; run `npx wrangler whoami` first")
    return m.group(1)


def account_hourly_writes(days: int = FORECAST_DAYS + 1) -> dict:
    """{'YYYY-MM-DDTHH': rowsWritten} summed over every D1 database in the account."""
    end = utc_now().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    q = ("query($a:String!,$s:Time!,$e:Time!){viewer{accounts(filter:{accountTag:$a}){"
         "d1AnalyticsAdaptiveGroups(limit:10000,filter:{datetimeHour_geq:$s,datetimeHour_lt:$e}){"
         "sum{rowsWritten} dimensions{datetimeHour databaseId}}}}}")
    body = json.dumps({"query": q, "variables": {"a": ACCOUNT_ID, "s": iso(end - timedelta(days=days)),
                                                  "e": iso(end)}}).encode()
    req = urllib.request.Request("https://api.cloudflare.com/client/v4/graphql", data=body,
                                 headers={"Authorization": f"Bearer {oauth_token()}",
                                          "Content-Type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=60).read())
    if d.get("errors") or not d.get("data"):
        raise SystemExit(f"STOP: usage metrics unavailable: {d.get('errors')}")
    out = defaultdict(int)
    for g in d["data"]["viewer"]["accounts"][0]["d1AnalyticsAdaptiveGroups"]:
        out[g["dimensions"]["datetimeHour"][:13]] += int(g["sum"]["rowsWritten"])
    return dict(out)


def d1(sql: str, allow_write: bool = False) -> list:
    """One `wrangler d1 execute --remote --json --command`; returns the per-statement
    results. SELECT-only unless allow_write (set only by apply / rollback)."""
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


def mfl_get(season: int, params: dict):
    url = f"https://api.myfantasyleague.com/{season}/export?{urllib.parse.urlencode({**params, 'JSON': '1'})}"
    req = urllib.request.Request(url, headers={"User-Agent": "ups-1307-preflight/1.0 (read-only)"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    time.sleep(6)
    return url, data


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


def cached_mfl(artifacts: Path, url: str):
    p = artifacts / "mflcache" / (re.sub(r"[^A-Za-z0-9]", "_", url.replace("https://", "")) + ".json")
    return json.loads(p.read_text()) if p.exists() else None


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


def expected_after(artifacts: Path, phase: str, season: int) -> tuple[list, list]:
    """(before rows, after rows) of the season's playoff weeks."""
    snap = json.loads((artifacts / "d1_snapshot" / f"playoff_{season}.json").read_text())["rows"]
    rows = {(r["week"], str(r["player_id"])): dict(r) for r in snap}
    if phase == "BC":
        for u in load_jsonl(artifacts / "out" / "proposed" / f"C_{season}.jsonl"):
            rows[(u["week"], u["player_id"])].update(u["new"])
    for r in load_jsonl(artifacts / "out" / "proposed" / f"{'A' if phase == 'A' else 'B'}_{season}.jsonl"):
        rows[(r["week"], r["player_id"])] = {c: r[c] for c in COLS}
    return snap, list(rows.values())


def build_plan(artifacts: Path) -> dict:
    rec = json.loads((artifacts / "out" / "reconciliation.json").read_text())
    meas = json.loads((artifacts / "out" / "d1_measure.json").read_text())["phases"]
    batches = []
    for i, (phase, s) in enumerate(BATCH_ORDER, start=1):
        files = ["A"] if phase == "A" else ["B", "C"]
        stmts, rollback, sha = [], [], {}
        for f in files:
            p = artifacts / "out" / "statements" / f"{f}_{s}.json"
            sha[f"statements/{p.name}"] = sha256_file(p)
            d = json.loads(p.read_text())
            stmts += [(f, x) for x in d["forward"]]
            rollback = [(f, x) for x in d["rollback"]] + rollback  # undo C before B
        exp = [statement_expectation(x) for _, x in stmts]
        inserted = sum(e["rows"] for e in exp if e["kind"] == "insert")
        updated = sum(e["rows"] for e in exp if e["kind"] == "update")
        billed = sum(e["rows_written"] for e in exp)
        measured = sum(meas[f"{f}_{s}"]["forward"]["rows_written"] for f in files)
        if billed != measured:
            raise SystemExit(f"plan: {phase} {s} expected {billed} != Miniflare-measured {measured}")
        before, after = expected_after(artifacts, phase, s)
        ps = rec["pointssummary"]["by_season"][str(s)]
        weeks = sorted(int(w) for w in rec["seasons"][str(s)]["playoff_weeks"])
        batches.append({
            "batch": i, "phases": files, "season": s, "weeks": weeks,
            "rows_inserted": inserted, "rows_updated": updated, "billed_writes": billed,
            "statements": len(stmts), "statement_files_sha256": sha,
            "reads": {"preflight_d1": max(1, len(before)), "during_writes": updated,
                      "post_verify_d1": len(after), "mfl_gets": 2 * len(weeks)},
            "preimage": {"rows": len(before), "sha256": rows_hash(before)},
            "after": {"rows": len(after), "sha256": rows_hash(after),
                      "null_status": sum(1 for r in after if r.get("status") is None)},
            "reconciliation": {"pts_rank_shown_before": ps.get("rank_shown_before", 0),
                               "pts_rank_shown_after": ps.get("rank_shown_after", 0),
                               "ppg_rank_shown_before": ps.get("ppg_rank_shown_before", 0),
                               "ppg_rank_shown_after": ps.get("ppg_rank_shown_after", 0),
                               "ranked_player_seasons": ps.get("pointssummary_rows", 0)},
            "rollback_rows_changed": sum(statement_expectation(x)["changes"] for _, x in rollback),
        })
    return {"issue": 1307, "dry_run_pr": 1363, "scope": "phases A + B + C; unproven fields NULL",
            "daily_ceiling": DAILY_CEILING, "reset": "00:00 UTC daily (Cloudflare D1 pricing page)",
            "window_utc": "start 22:05-23:30", "batches": batches,
            "totals": {"billed_writes": sum(b["billed_writes"] for b in batches),
                       "rows_inserted": sum(b["rows_inserted"] for b in batches),
                       "rows_updated": sum(b["rows_updated"] for b in batches)}}


def calendar(batches: list, used_by_window: list, rest_forecast: int) -> list:
    """Likely nights, in order, if night i has used_by_window[i] writes on the
    account by 22:05 UTC. A batch that does not fit waits for a lighter night;
    batches never run out of order. -> [(night index, [batch ids])]."""
    nights, i, todo = [], 0, list(batches)
    while todo and i < len(used_by_window):
        used, ran = used_by_window[i], []
        while todo and guard(used, todo[0]["billed_writes"], rest_forecast)["ok"]:
            used += todo[0]["billed_writes"]
            ran.append(todo.pop(0)["batch"])
        nights.append((i, ran))
        i += 1
    return nights


# ──────────────────────────────────────────────────────────────────────
# Subcommands
# ──────────────────────────────────────────────────────────────────────

def load_batch(args) -> dict:
    plan = json.loads(Path(args.plan).read_text())
    b = next((x for x in plan["batches"] if x["batch"] == args.batch), None)
    if not b:
        raise SystemExit(f"no batch {args.batch}")
    art = Path(args.artifacts)
    for rel, want in b["statement_files_sha256"].items():
        if sha256_file(art / "out" / rel) != want:
            raise SystemExit(f"STOP: {rel} differs from the reviewed plan")
    return b


def batch_statements(art: Path, b: dict, key: str) -> list:
    out = []
    for f in b["phases"]:
        out += json.loads((art / "out" / "statements" / f"{f}_{b['season']}.json").read_text())[key]
    return out


def usage_report(batch_writes: int = 0, now: datetime | None = None) -> dict:
    now = now or utc_now()
    hourly = account_hourly_writes()
    g = guard(used_today(hourly, now), batch_writes, forecast_rest_of_day(hourly, now))
    g["anomalous_hours_today"] = anomalous_hours_today(hourly, now)
    g["ok"] = g["ok"] and not g["anomalous_hours_today"]
    g.update({"now_utc": iso(now), "in_window": in_window(now), "next_window_utc": iso(next_window(now))})
    return g


def cmd_usage(args) -> int:
    print(json.dumps(usage_report(args.batch_writes), indent=1))
    return 0


def preflight(args, b: dict) -> dict:
    """Read-only. Returns the facts apply needs; raises SystemExit on any STOP."""
    art = Path(args.artifacts)
    stops, facts = [], {"batch": b["batch"], "season": b["season"], "at_utc": iso(utc_now())}
    g = usage_report(b["billed_writes"])
    facts["usage"] = g
    if not g["in_window"] and not getattr(args, "ignore_window_for_readonly", False):
        stops.append(f"outside the 22:05-23:30 UTC start window (next {g['next_window_utc']})")
    if g["anomalous_hours_today"]:
        stops.append(f"unscheduled heavy writes today in hours {g['anomalous_hours_today']}")
    if g["projected"] > g["ceiling"]:
        stops.append(f"projected {g['projected']:,} > ceiling {g['ceiling']:,}")
    busy = running_write_jobs()
    if busy:
        stops.append(f"write-heavy job running: {busy}")
    rows, read = season_playoff_rows(b["season"])
    facts["d1_rows_read"] = read
    if len(rows) != b["preimage"]["rows"] or rows_hash(rows) != b["preimage"]["sha256"]:
        stops.append(f"target weeks changed since the dry run: {len(rows)} rows, hash {rows_hash(rows)[:12]}")
    pre = art / "preimages" / f"batch_{b['batch']:02d}_{b['season']}.json"
    pre.parent.mkdir(exist_ok=True)
    pre.write_text(json.dumps({"captured_at_utc": facts["at_utc"], "rows": rows}))
    facts["preimage_file"] = str(pre)
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
    args.ignore_window_for_readonly = True
    facts = preflight(args, load_batch(args))
    print(json.dumps(facts, indent=1))
    return 1 if facts["stops"] else 0


def verify(args, b: dict) -> dict:
    art = Path(args.artifacts)
    _, after = expected_after(art, "A" if b["phases"] == ["A"] else "BC", b["season"])
    rows, read = season_playoff_rows(b["season"])
    return {"rows": len(rows), "expected_rows": len(after), "rows_read": read,
            "ok": rows_hash(rows) == b["after"]["sha256"]}


def cmd_verify(args) -> int:
    if not args.allow_prod_d1_read:
        print("SKIPPED: verify reads production D1; pass --allow-prod-d1-read.")
        return 0
    v = verify(args, load_batch(args))
    print(json.dumps(v))
    return 0 if v["ok"] else 1


def run_writes(stmts: list, log: Path) -> dict:
    """Send statements (UPDATEs grouped UPDATES_PER_COMMAND per call), checking
    every statement's meta; stop at the first deviation."""
    groups, cur = [], []
    for s in stmts:
        if s.lstrip().upper().startswith("UPDATE"):
            cur.append(s)
            if len(cur) == UPDATES_PER_COMMAND:
                groups.append(cur)
                cur = []
        else:
            if cur:
                groups.append(cur)
                cur = []
            groups.append([s])
    if cur:
        groups.append(cur)
    tot = {"statements": 0, "rows_written": 0, "rows_read": 0, "changes": 0}
    with open(log, "a") as lf:
        for grp in groups:
            res = d1("\n".join(grp), allow_write=True)
            if len(res) != len(grp):
                raise SystemExit(f"STOP: D1 returned {len(res)} results for {len(grp)} statements")
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
                    raise SystemExit(f"STOP after statement {tot['statements']}: {why}; totals {tot}")
    return tot


def cmd_apply(args) -> int:
    b = load_batch(args)
    if not args.execute or not re.match(r"^https://github\.com/keithcreelman/upsmflproduction/(issues|pull)/\d+#issuecomment-\d+$",
                                        args.approval or ""):
        print("DRY: apply writes production D1 and needs --execute and --approval <Keith's comment URL> "
              "for this batch. Nothing was done.")
        return 0
    art = Path(args.artifacts)
    facts = preflight(args, b)
    if facts["stops"]:
        print(json.dumps(facts, indent=1))
        raise SystemExit("STOP: preflight failed; nothing written")
    log = art / "runs" / f"batch_{b['batch']:02d}_{b['season']}_{utc_now().strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    log.parent.mkdir(exist_ok=True)
    log.write_text(json.dumps({"approval": args.approval, "preflight": facts}) + "\n")
    tot = run_writes(batch_statements(art, b, "forward"), log)
    if tot["rows_written"] != b["billed_writes"]:
        raise SystemExit(f"STOP: batch billed {tot['rows_written']} != planned {b['billed_writes']}")
    v = verify(args, b)
    print(json.dumps({"writes": tot, "verify": v}))
    if not v["ok"]:
        raise SystemExit("STOP: after-state differs from the plan; consider rollback")
    time.sleep(SETTLE_MINUTES * 60)
    after = usage_report()
    other = after["used_today"] - facts["usage"]["used_today"] - tot["rows_written"]
    result = {"account_used_before": facts["usage"]["used_today"], "account_used_after": after["used_today"],
              "batch_rows_written": tot["rows_written"], "other_writes_meanwhile": other,
              "ok": other <= OTHER_WRITES_ALLOWANCE and after["used_today"] <= DAILY_CEILING}
    with open(log, "a") as lf:
        lf.write(json.dumps({"post": result, "verify": v}) + "\n")
    print(json.dumps(result))
    if not result["ok"]:
        raise SystemExit("STOP: account usage moved more than this batch explains; no further batch tonight")
    return 0


def cmd_rollback(args) -> int:
    b = load_batch(args)
    if not args.execute or not re.match(r"^https://github\.com/keithcreelman/upsmflproduction/(issues|pull)/\d+#issuecomment-\d+$",
                                        args.approval or ""):
        print("DRY: rollback writes production D1 and needs --execute and --approval <comment URL>. Nothing was done.")
        return 0
    art = Path(args.artifacts)
    g = usage_report(4 * b["rows_inserted"] + b["rows_updated"])  # deletes may bill index entries too
    if not g["ok"]:
        raise SystemExit(f"STOP: rollback could breach the daily ceiling ({g['projected']:,}); "
                         f"run it after 00:00 UTC")
    log = art / "runs" / f"rollback_{b['batch']:02d}_{b['season']}_{utc_now().strftime('%Y%m%dT%H%M%SZ')}.jsonl"
    log.parent.mkdir(exist_ok=True)
    log.write_text(json.dumps({"approval": args.approval, "usage": g}) + "\n")
    stmts = []
    for f in reversed(b["phases"]):  # C restores before B deletes
        stmts += json.loads((art / "out" / "statements" / f"{f}_{b['season']}.json").read_text())["rollback"]
    for grp in [stmts[i:i + UPDATES_PER_COMMAND] for i in range(0, len(stmts), UPDATES_PER_COMMAND)]:
        res = d1("\n".join(grp), allow_write=True)
        with open(log, "a") as lf:
            for sql, r in zip(grp, res):
                lf.write(json.dumps({"sql_sha256": hashlib.sha256(sql.encode()).hexdigest(),
                                     "meta": {k: (r.get("meta") or {}).get(k) for k in ("rows_written", "changes")}}) + "\n")
    rows, _ = season_playoff_rows(b["season"])
    ok = len(rows) == b["preimage"]["rows"] and rows_hash(rows) == b["preimage"]["sha256"]
    print(json.dumps({"restored_rows": len(rows), "identical_to_preimage": ok}))
    return 0 if ok else 1


def cmd_plan(args) -> int:
    plan = build_plan(Path(args.artifacts))
    Path(args.out).write_text(json.dumps(plan, indent=1) + "\n")
    for b in plan["batches"]:
        print(f"batch {b['batch']:2d} {'+'.join(b['phases']):3s} {b['season']} wks {b['weeks']} "
              f"ins {b['rows_inserted']:,} upd {b['rows_updated']:,} billed {b['billed_writes']:,}")
    print(json.dumps(plan["totals"]))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("plan")
    p.add_argument("--artifacts", required=True)
    p.add_argument("--out", required=True)
    u = sub.add_parser("usage")
    u.add_argument("--batch-writes", type=int, default=0)
    for name in ("preflight", "apply", "verify", "rollback"):
        s = sub.add_parser(name)
        s.add_argument("--plan", required=True)
        s.add_argument("--artifacts", required=True)
        s.add_argument("--batch", type=int, required=True)
        if name in ("preflight", "verify"):
            s.add_argument("--allow-prod-d1-read", action="store_true")
        else:
            s.add_argument("--execute", action="store_true")
            s.add_argument("--approval", default="")
    args = ap.parse_args(argv)
    return {"plan": cmd_plan, "usage": cmd_usage, "preflight": cmd_preflight, "apply": cmd_apply,
            "verify": cmd_verify, "rollback": cmd_rollback}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
