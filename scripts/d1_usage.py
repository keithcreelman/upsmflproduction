#!/usr/bin/env python3
"""D1 usage against the Free plan's daily limits: the exact counter first, sampled diagnosis second.

Cloudflare publishes two different datasets. This script never mixes them.

  EXACT    d1AnalyticsAdaptiveGroups. Every D1 database in the account, unsampled (checked:
           every group must carry sampleInterval 1). Same source as `wrangler d1 info` and the
           D1 dashboard. It is the ONLY number used for the Free-plan budget, and only for the
           current UTC billing day: Free limits reset at 00:00 UTC.
  SAMPLED  d1QueriesAdaptiveGroups, the dataset behind `wrangler d1 insights` (this script sends
           the same GraphQL query wrangler does, plus avg.sampleInterval, which wrangler omits).
           Cloudflare stores a sample of queries and multiplies each by its sampling interval.
           On 2026-10-21 one 50,750-row leaderboard query stored at 1 in 145 was reported as
           "145 runs, 7,358,750 rows" (#1354). Use it to find WHICH queries read most; it is never
           summed and never used for the budget.

Usage:
    python3 scripts/d1_usage.py              # budget + sampled diagnosis of the last hour
    python3 scripts/d1_usage.py 6h           # diagnosis window: 1h, 6h, 12h, 1d or 7d
    python3 scripts/d1_usage.py --json       # machine-readable (schema d1_usage.v2)
    python3 scripts/d1_usage.py --now 2026-10-22T02:41:00Z   # replay a past moment
    python3 scripts/d1_usage.py --fixture tests/fixtures/d1_usage/<case>.json   # offline
    python3 scripts/d1_usage.py --record <path>              # save the responses it read

Exit status: 0 = exact usage known, under the limit; 4 = known, at or over a limit;
3 = exact counter unreadable or not exact, so usage is UNKNOWN (fail closed: the sampled
figures are never substituted); 2 = bad arguments.

Reads no D1 rows: Cloudflare's analytics API and the D1 control plane (`wrangler d1 list`).
"""
import argparse, json, os, re, subprocess, sys, urllib.error, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

READ_LIMIT_PER_DAY = 5_000_000      # Free plan, rows read per UTC day, account-wide
WRITE_LIMIT_PER_DAY = 100_000       # Free plan, rows written per UTC day, account-wide
NEAR = 0.90                         # same ceiling the #1307 batch guard uses (4.5M reads)
THIN_SAMPLES = 5                    # fewer stored samples than this = a thin estimate
HOURS = {"1h": 1, "6h": 6, "12h": 12, "1d": 24, "7d": 168}
ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "ba1a1d492ec8a5485821eb8f0d5f32c2"
GRAPHQL = "https://api.cloudflare.com/client/v4/graphql"
ROOT = Path(__file__).resolve().parent.parent
WORKER_DIR = ROOT / "worker"


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_now(s):
    t = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


def windows(now):
    """[start, end) spans in UTC. end = the start of the current minute: the minute in
    progress is incomplete, and the analytics lag behind it anyway."""
    end = now.replace(second=0, microsecond=0)
    day = end.replace(hour=0, minute=0)
    return {"utc_day": (day, end), "previous_utc_day": (day - timedelta(days=1), day),
            "rolling_24h": (end - timedelta(hours=24), end)}


# ── Remote reads (skipped entirely under --fixture) ──────────────────────────────────

def _wrangler(*args):
    r = subprocess.run(["npx", "wrangler", *args], capture_output=True, text=True, cwd=str(WORKER_DIR),
                       env={**os.environ, "WRANGLER_SEND_METRICS": "false"}, timeout=120)
    return r.returncode, r.stdout, r.stderr


def _oauth_token():
    """wrangler's freshest OAuth login (the legacy ~/.wrangler path and the platform one)."""
    best = None
    for p in (Path.home() / ".wrangler" / "config" / "default.toml",
              Path.home() / "Library" / "Preferences" / ".wrangler" / "config" / "default.toml",
              Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / ".wrangler" / "config" / "default.toml"):
        try:
            txt = p.read_text()
        except OSError:
            continue
        tok = re.search(r'^oauth_token\s*=\s*"([^"]+)"', txt, re.M)
        exp = re.search(r'^expiration_time\s*=\s*"([^"]+)"', txt, re.M)
        if tok:
            e = parse_now(exp.group(1)) if exp else datetime.min.replace(tzinfo=timezone.utc)
            if best is None or e > best[1]:
                best = (tok.group(1), e)
    return best


def _token():
    env = os.environ.get("CLOUDFLARE_API_TOKEN")
    if env:
        return env
    best = _oauth_token()
    if best is None or best[1] <= datetime.now(timezone.utc) + timedelta(minutes=2):
        _wrangler("whoami")                 # refreshes an expired OAuth login
        best = _oauth_token()
    if best is None:
        raise RuntimeError("no Cloudflare credentials: set CLOUDFLARE_API_TOKEN or run `npx wrangler login`")
    return best[0]


def graphql(query, variables):
    """The raw response, or {"error": "..."}. Never raises."""
    try:
        req = urllib.request.Request(GRAPHQL, data=json.dumps({"query": query, "variables": variables}).encode(),
                                     headers={"Authorization": f"Bearer {_token()}", "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return {"error": f"HTTP {e.code} from the analytics API"}
    except Exception as e:  # noqa: BLE001 — any failure means "unknown", reported as such
        return {"error": f"{type(e).__name__}: {e}"}


EXACT_GQL = """query($a: String!, $d0: Time!, $d1: Time!, $p0: Time!, $r0: Time!) { viewer { accounts(filter: {accountTag: $a}) {
  utc_day: d1AnalyticsAdaptiveGroups(limit: 1000, filter: {datetimeMinute_geq: $d0, datetimeMinute_lt: $d1}) {
    sum { rowsRead rowsWritten readQueries writeQueries } avg { sampleInterval } dimensions { databaseId } }
  previous_utc_day: d1AnalyticsAdaptiveGroups(limit: 1000, filter: {datetimeMinute_geq: $p0, datetimeMinute_lt: $d0}) {
    sum { rowsRead rowsWritten readQueries writeQueries } avg { sampleInterval } dimensions { databaseId } }
  rolling_24h: d1AnalyticsAdaptiveGroups(limit: 1000, filter: {datetimeMinute_geq: $r0, datetimeMinute_lt: $d1}) {
    sum { rowsRead rowsWritten readQueries writeQueries } avg { sampleInterval } dimensions { databaseId } }
} } }"""

# The query `wrangler d1 insights --sort-by reads --limit 25` sends (wrangler 4.87,
# src/d1/insights.ts), plus avg.sampleInterval so the sample behind each row is visible.
SAMPLED_GQL = """query($a: String!, $filter: ZoneWorkersRequestsFilter_InputObject) { viewer { accounts(filter: {accountTag: $a}) {
  d1QueriesAdaptiveGroups(limit: 25, filter: $filter, orderBy: [sum_rowsRead_DESC]) {
    sum { queryDurationMs rowsRead rowsWritten rowsReturned }
    avg { queryDurationMs rowsRead rowsWritten rowsReturned sampleInterval }
    count dimensions { query } }
} } }"""


def fetch_exact(now):
    w = windows(now)
    return graphql(EXACT_GQL, {"a": ACCOUNT_ID, "d0": iso(w["utc_day"][0]), "d1": iso(w["utc_day"][1]),
                               "p0": iso(w["previous_utc_day"][0]), "r0": iso(w["rolling_24h"][0])})


def fetch_sampled(now, window, db_id):
    """wrangler's filter, plus datetime_lt so a --now replay stops at that second: wrangler's
    datetimeHour_leq alone takes in the whole current hour, which a live run hasn't seen yet."""
    start = now - timedelta(hours=HOURS[window])
    return graphql(SAMPLED_GQL, {"a": ACCOUNT_ID, "filter": {"AND": [
        {"datetimeHour_geq": iso(start), "datetimeHour_leq": iso(now), "databaseId": db_id, "datetime_lt": iso(now)}]}})


def fetch_databases():
    try:
        code, out, err = _wrangler("d1", "list", "--json")
        i = out.find("[")
        if code != 0 or i < 0:
            return {"error": (err or out).strip()[-200:] or "wrangler d1 list failed"}
        return [{"uuid": d.get("uuid"), "name": d.get("name")} for d in json.loads(out[i:])]
    except Exception as e:  # noqa: BLE001
        return {"error": f"{type(e).__name__}: {e}"}


def main_db_id():
    """ups-mfl-db's id, read from wrangler.toml (no network)."""
    try:
        m = re.search(r'database_name\s*=\s*"ups-mfl-db"\s*\n\s*database_id\s*=\s*"([^"]+)"',
                      (WORKER_DIR / "wrangler.toml").read_text())
        return m.group(1) if m else None
    except OSError:
        return None


# ── Interpretation (pure: fixtures exercise everything below) ────────────────────────

def _err(resp):
    if not isinstance(resp, dict):
        return "no response"
    if resp.get("error"):
        return str(resp["error"])
    if resp.get("errors"):
        return "; ".join(str(e.get("message", e)) for e in resp["errors"])[:300]
    try:
        resp["data"]["viewer"]["accounts"][0]
    except (KeyError, IndexError, TypeError):
        return "response had no account data"
    return None


def _span(groups, names, start, end):
    dbs, max_si = [], 1.0
    for g in groups:
        s, si = g["sum"], float((g.get("avg") or {}).get("sampleInterval") or 1)
        max_si = max(max_si, si)
        dbs.append({"database_id": g["dimensions"]["databaseId"], "name": names.get(g["dimensions"]["databaseId"]),
                    "rows_read": int(s["rowsRead"]), "rows_written": int(s["rowsWritten"]),
                    "read_queries": int(s.get("readQueries") or 0), "write_queries": int(s.get("writeQueries") or 0)})
    dbs.sort(key=lambda d: -d["rows_read"])
    acct = {k: sum(d[k] for d in dbs) for k in ("rows_read", "rows_written", "read_queries", "write_queries")}
    return {"start_utc": iso(start), "end_utc": iso(end), "account": acct, "databases": dbs, "max_sample_interval": max_si}


def interpret_exact(resp, now, names):
    w = windows(now)
    base = {"source": "Cloudflare GraphQL d1AnalyticsAdaptiveGroups, every D1 database in the account",
            "status": "unknown", "error": None, "utc_day": None, "previous_utc_day": None, "rolling_24h": None}
    e = _err(resp)
    if e:
        return {**base, "error": e}
    acc = resp["data"]["viewer"]["accounts"][0]
    out = {**base, "status": "ok"}
    for key in ("utc_day", "previous_utc_day", "rolling_24h"):
        groups = acc.get(key)
        if groups is None:
            return {**base, "error": f"response is missing {key}"}
        out[key] = _span(groups, names, *w[key])
    sampled = [k for k in ("utc_day", "previous_utc_day", "rolling_24h") if out[k]["max_sample_interval"] > 1]
    if sampled:
        return {**base, "error": "the counter came back sampled (sampleInterval > 1 in " + ", ".join(sampled)
                + "), so it is not exact"}
    if not out["rolling_24h"]["databases"]:
        return {**base, "error": "the counter returned no data for the last 24 hours (every D1 account has "
                "cron traffic), so it cannot be trusted"}
    out["utc_day"]["date"] = w["utc_day"][0].strftime("%Y-%m-%d")
    out["utc_day"]["resets_at_utc"] = iso(w["utc_day"][0] + timedelta(days=1))
    out["previous_utc_day"]["date"] = w["previous_utc_day"][0].strftime("%Y-%m-%d")
    out["rolling_24h"]["diagnostic_only"] = True
    return out


def _level(used, limit):
    return "over" if used >= limit else ("near" if used >= NEAR * limit else "ok")


def budget(exact):
    """Free-plan budget: ONLY the exact counter, ONLY the current UTC day, ONLY account-wide."""
    b = {"basis": "exact counter, current UTC billing day, every D1 database (account-wide)",
         "status": "unknown", "ok": False, "reads": None, "writes": None}
    if exact["status"] != "ok":
        b["reason"] = "exact counter unavailable: usage unknown, fail closed (no sampled fallback)"
        return b
    a = exact["utc_day"]["account"]
    for key, used, limit in (("reads", a["rows_read"], READ_LIMIT_PER_DAY), ("writes", a["rows_written"], WRITE_LIMIT_PER_DAY)):
        b[key] = {"used": used, "limit": limit, "pct_of_limit": round(100 * used / limit, 1),
                  "remaining": max(0, limit - used), "level": _level(used, limit)}
    order = ["ok", "near", "over"]
    b["status"] = max(b["reads"]["level"], b["writes"]["level"], key=order.index)
    b["ok"] = b["status"] != "over"
    return b


def label(sql):
    """A short, human name for a query: the route it serves where known, else its first table."""
    t = re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", sql)).strip()
    if "WITH current_team AS" in t or "CURRENT NFL team = their row" in sql:
        return "LEADERBOARD live query (/api/advanced-stats-leaderboard)"
    if "nfl_leaderboard_precompute" in t:
        return ("INSERT nfl_leaderboard_precompute (leaderboard rebuild)" if re.match(r"(INSERT|DELETE)", t, re.I)
                else "leaderboard PRECOMPUTE read")
    if "w.opponent AS def, sw.score AS pts" in t:
        return "/api/sos-adjusted-points"
    if "SELECT f.mfl_id AS m, w.week AS wk" in t:
        return "Pts Agst season context (fpa_engine.js)"
    m = re.search(r"INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([A-Za-z_]\w*)", t, re.I)
    if m:
        return f"INSERT {m.group(1)}"
    m = re.search(r"\bUPDATE\s+([A-Za-z_]\w*)", t, re.I)
    if m:
        return f"UPDATE {m.group(1)}"
    m = re.search(r"\bFROM\s+([A-Za-z_]\w*)", t, re.I)
    return m.group(1) if m else t[:40]


def interpret_sampled(resp, window, db_name):
    out = {"source": "Cloudflare GraphQL d1QueriesAdaptiveGroups: the query `wrangler d1 insights` sends, plus sampleInterval",
           "estimates_are_sampled": True, "summable": False, "database": db_name, "window": window,
           "error": None, "rows": [], "thin_rows": 0, "sample_interval_range": None}
    e = _err(resp)
    if e:
        return {**out, "error": e}
    rows = []
    for g in resp["data"]["viewer"]["accounts"][0].get("d1QueriesAdaptiveGroups") or []:
        q = (g.get("dimensions") or {}).get("query")
        if not q:
            continue
        n, si = int(g.get("count") or 0), float((g.get("avg") or {}).get("sampleInterval") or 1)
        stored = max(1, round(n / si)) if n else 0
        rows.append({"label": label(q), "query_prefix": re.sub(r"\s+", " ", re.sub(r"--[^\n]*", "", q)).strip()[:160],
                     "est_rows_read": int(g["sum"]["rowsRead"]), "est_rows_written": int(g["sum"]["rowsWritten"]),
                     "est_runs": n, "avg_rows_read_per_run": round(float(g["avg"]["rowsRead"] or 0)),
                     "stored_samples": stored, "sample_interval": round(si, 1),
                     # At 1 in 1 every query was kept, so the row is a count, not an estimate.
                     "thin": si > 1 and stored < THIN_SAMPLES})
    rows.sort(key=lambda r: -r["est_rows_read"])
    out["rows"] = rows
    out["thin_rows"] = sum(r["thin"] for r in rows)
    if rows:
        out["sample_interval_range"] = [min(r["sample_interval"] for r in rows), max(r["sample_interval"] for r in rows)]
    return out


def build(now, window, exact_resp, sampled_resp, databases, db_id):
    names = {d["uuid"]: d["name"] for d in databases} if isinstance(databases, list) else {}
    exact = interpret_exact(exact_resp, now, names)
    return {"schema": "d1_usage.v2", "as_of_utc": iso(now.replace(second=0, microsecond=0)),
            "account_id": ACCOUNT_ID, "exact": exact, "budget": budget(exact),
            "sampled_queries": interpret_sampled(sampled_resp, window, names.get(db_id) or "ups-mfl-db"),
            "database_names_error": databases.get("error") if isinstance(databases, dict) else None}


# ── Rendering ────────────────────────────────────────────────────────────────────────

def _left(now_s, reset_s):
    mins = int((parse_now(reset_s) - parse_now(now_s)).total_seconds() // 60)
    return f"{mins // 60}h {mins % 60:02d}m"


def render(r):
    L, ex, b, s = [], r["exact"], r["budget"], r["sampled_queries"]
    L.append(f"\n  D1 USAGE · as of {r['as_of_utc'][:16].replace('T', ' ')} UTC "
             "(Cloudflare's analytics can still add a few rows to the last few minutes)")
    if ex["status"] == "ok":
        d = ex["utc_day"]
        L.append(f"\n  FREE-PLAN BUDGET · UTC billing day {d['date']} · resets 00:00 UTC "
                 f"({_left(r['as_of_utc'], d['resets_at_utc'])} left)")
        L.append("  exact counter, ACCOUNT-WIDE (every D1 database). The only budget figure.")
        for key, what in (("reads", "rows read"), ("writes", "rows written")):
            x = b[key]
            L.append(f"    {what:<13} {x['used']:>11,} of {x['limit']:>9,}  {x['pct_of_limit']:>5.1f}%  {x['level'].upper()}")
        p = ex["previous_utc_day"]["account"]
        L.append(f"    previous UTC day {ex['previous_utc_day']['date']} (complete): rows read {p['rows_read']:,} "
                 f"({100 * p['rows_read'] / READ_LIMIT_PER_DAY:.1f}%), rows written {p['rows_written']:,} "
                 f"({100 * p['rows_written'] / WRITE_LIMIT_PER_DAY:.1f}%)")
        ro = ex["rolling_24h"]
        L.append(f"\n  ROLLING 24 H · {ro['start_utc'][:16].replace('T', ' ')} → {ro['end_utc'][:16].replace('T', ' ')} UTC"
                 " · DIAGNOSTIC ONLY")
        L.append("  exact counter, account-wide. Spans two billing days, so it is never a % of the daily limit.")
        L.append(f"    rows read {ro['account']['rows_read']:,} · rows written {ro['account']['rows_written']:,}")
        L.append("\n  BY DATABASE (database-specific, exact)              UTC day so far       rolling 24 h")
        roll = {x["database_id"]: x for x in ro["databases"]}
        ids = [x["database_id"] for x in ro["databases"]] + [x["database_id"] for x in d["databases"]
                                                              if x["database_id"] not in roll]
        today = {x["database_id"]: x for x in d["databases"]}
        for i in ids:
            n = (today.get(i) or roll.get(i))["name"] or i
            t, w = today.get(i, {}), roll.get(i, {})
            L.append(f"    {n[:36]:<36} read  {t.get('rows_read', 0):>15,}  {w.get('rows_read', 0):>17,}")
            L.append(f"    {'':<36} written {t.get('rows_written', 0):>13,}  {w.get('rows_written', 0):>17,}")
        if r.get("database_names_error"):
            L.append(f"    (database names unavailable: {r['database_names_error'][:80]})")
    else:
        L.append("\n  FREE-PLAN BUDGET · UTC billing day · resets 00:00 UTC")
        L.append("    USAGE UNKNOWN. The exact counter could not be used:")
        L.append(f"      {ex['error']}")
        L.append("    Fail closed: treat the day's budget as exhausted for any go/no-go decision.")
        L.append("    The sampled estimates below are NOT a substitute and are never used for the budget.")

    L.append(f"\n  QUERY DIAGNOSIS · {s['database']} only · last {s['window']} · SAMPLED ESTIMATES")
    L.append("  Same data as `wrangler d1 insights`. Cloudflare stores a sample of queries and multiplies each")
    L.append("  stored query by its sampling interval, so every number here is an estimate. They are not")
    L.append("  added up, are not account usage, and miss bulk `--file` imports. Use them to find heavy queries.")
    if s["error"]:
        L.append(f"    (sampled diagnosis unavailable: {s['error']})")
    elif not s["rows"]:
        L.append("    (no sampled queries in this window)")
    else:
        lo, hi = s["sample_interval_range"]
        L.append(f"  Sampling in this window: 1 in {lo:g} to 1 in {hi:g}.")
        thin = [x for x in s["rows"] if x["thin"]]
        for x in thin[:3]:
            what = "1 recorded query" if x["stored_samples"] == 1 else f"{x['stored_samples']} recorded queries"
            L.append(f"\n  !! THIN SAMPLE: {x['label']}")
            L.append(f"     shows {x['est_rows_read']:,} rows over {x['est_runs']:,} runs, but that is {what} multiplied "
                     f"by {x['sample_interval']:g} (1 in {x['sample_interval']:g}).")
            L.append(f"     Do not read it as {x['est_runs']:,} executions or {x['est_rows_read']:,} rows read; "
                     "the exact counter above is the only usage figure.")
        if len(thin) > 3:
            L.append(f"\n  !! {len(thin) - 3} more row(s) rest on fewer than {THIN_SAMPLES} recorded queries (marked !! THIN).")
        L.append(f"\n  {'est. rows':>11} {'est. runs':>9} {'rows/run':>9} {'samples':>8} {'rate':>11}  query")
        for x in s["rows"][:10]:
            if not x["est_rows_read"]:
                continue
            flag = "  !! THIN" if x["thin"] else ("  (heavy per run)" if x["avg_rows_read_per_run"] > 100_000 else "")
            rate = f"1 in {x['sample_interval']:g}"
            L.append(f"  {x['est_rows_read']:>11,} {x['est_runs']:>9,} {x['avg_rows_read_per_run']:>9,} "
                     f"{x['stored_samples']:>8,} {rate:>11}  {x['label']}{flag}")
    L.append("")
    return "\n".join(L)


def exit_code(r):
    return 3 if r["budget"]["status"] == "unknown" else (4 if r["budget"]["status"] == "over" else 0)


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("window", nargs="?", default="1h", help="sampled-diagnosis window: " + ", ".join(HOURS))
    ap.add_argument("--json", action="store_true", help="print the d1_usage.v2 JSON instead of text")
    ap.add_argument("--now", help="report as of this UTC instant (ISO 8601); analytics only")
    ap.add_argument("--fixture", help="read recorded responses from this file instead of Cloudflare")
    ap.add_argument("--record", help="also save the responses read to this file")
    a = ap.parse_args(argv)
    if a.window not in HOURS:
        print(f"window must be one of {', '.join(HOURS)}", file=sys.stderr)
        return 2
    if a.fixture:
        fx = json.loads(Path(a.fixture).read_text())
        now = parse_now(a.now or fx["now"])
        window = fx.get("window", a.window)
        exact_resp, sampled_resp, dbs, db_id = fx.get("exact_response"), fx.get("sampled_response"), \
            fx.get("databases", []), fx.get("database_id")
    else:
        now = parse_now(a.now) if a.now else datetime.now(timezone.utc)
        window, db_id = a.window, main_db_id()
        exact_resp = fetch_exact(now)
        sampled_resp = fetch_sampled(now, window, db_id) if db_id else {"error": "ups-mfl-db id not found in wrangler.toml"}
        dbs = fetch_databases()
    if a.record:
        Path(a.record).write_text(json.dumps({"now": iso(now), "window": window, "database_id": db_id,
                                              "databases": dbs, "exact_response": exact_resp,
                                              "sampled_response": sampled_resp}, indent=1) + "\n")
    report = build(now, window, exact_resp, sampled_resp, dbs, db_id)
    print(json.dumps(report, indent=1) if a.json else render(report))
    return exit_code(report)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
