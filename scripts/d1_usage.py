#!/usr/bin/env python3
"""Readable D1 usage against the free-tier daily limits.

`wrangler d1 insights` prints raw JSON with the full SQL of every query — for
this database that is a screenful of embedded comments per row and unreadable in
a terminal. This summarises it: what you are on track for per day, and which
queries are responsible.

Usage:
    python3 scripts/d1_usage.py            # last 1h, projected to a day
    python3 scripts/d1_usage.py 6h
    python3 scripts/d1_usage.py 1d

Pick the window deliberately. 1d includes anything unusual that happened today
(a one-off backfill will dominate it); 1h is the better proxy for steady state,
but is noisy if nobody used the app.
"""
import json, re, subprocess, sys

READ_LIMIT_PER_DAY = 5_000_000
WRITE_LIMIT_PER_DAY = 100_000
HOURS = {"1h": 1, "6h": 6, "12h": 12, "1d": 24, "7d": 168}


def label(sql: str) -> str:
    """A short, human name for a query — its first real FROM/INSERT target."""
    t = re.sub(r"--[^\n]*", "", sql)          # strip SQL comments
    t = re.sub(r"\s+", " ", t).strip()
    m = re.search(r"INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([A-Za-z_][\w]*)", t, re.I)
    if m:
        return f"INSERT {m.group(1)}"
    m = re.search(r"\bUPDATE\s+([A-Za-z_][\w]*)", t, re.I)
    if m:
        return f"UPDATE {m.group(1)}"
    # The leaderboard's giant CTE opens `FROM src_players`, which is misleading.
    # Name it by what makes it expensive instead.
    if "nfl_player_weekly" in t and "pos_group" in t:
        season = re.search(r"season IN \(([\d,\s]+)\)", t)
        return f"LEADERBOARD live query (season {season.group(1).strip() if season else '?'})"
    if "nfl_leaderboard_precompute" in t:
        return "leaderboard PRECOMPUTE"
    m = re.search(r"\bFROM\s+([A-Za-z_][\w]*)", t, re.I)
    return m.group(1) if m else t[:40]


def main(window: str) -> int:
    if window not in HOURS:
        print(f"window must be one of {', '.join(HOURS)}"); return 2
    out = subprocess.run(
        ["npx", "wrangler", "d1", "insights", "ups-mfl-db",
         "--time-period", window, "--sort-by", "reads", "--limit", "25", "--json"],
        capture_output=True, text=True, cwd="worker")
    i = out.stdout.find("[")
    if i < 0:
        print("could not read insights:\n" + (out.stderr or out.stdout)[:400]); return 1
    rows = json.loads(out.stdout[i:])

    reads = sum(r.get("totalRowsRead", 0) for r in rows)
    writes = sum(r.get("totalRowsWritten", 0) for r in rows)
    runs = sum(r.get("numberOfTimesRun", 0) for r in rows)
    scale = 24 / HOURS[window]

    print(f"\n  D1 usage — last {window}   ({runs:,} queries)\n")
    for kind, got, limit in (("rows read", reads, READ_LIMIT_PER_DAY),
                             ("rows written", writes, WRITE_LIMIT_PER_DAY)):
        proj = got * scale
        pct = proj / limit * 100
        state = "OK" if pct < 60 else ("WATCH" if pct < 100 else "OVER LIMIT")
        print(f"  {kind:<13} {got:>13,}  ->  {proj:>13,.0f}/day  "
              f"({pct:>5.1f}% of {limit:,})  {state}")

    print(f"\n  Biggest readers:\n")
    print(f"  {'avg/run':>11} {'runs':>6} {'total':>13}  query")
    for r in sorted(rows, key=lambda x: -x.get("totalRowsRead", 0))[:8]:
        if not r.get("totalRowsRead"):
            continue
        flag = "  <-- EXPENSIVE" if r.get("avgRowsRead", 0) > 100_000 else ""
        print(f"  {r.get('avgRowsRead',0):>11,.0f} {r.get('numberOfTimesRun',0):>6} "
              f"{r.get('totalRowsRead',0):>13,}  {label(r['query'])}{flag}")
    print("\n  Anything over ~100k rows PER RUN is worth investigating: at that size a"
          "\n  handful of requests can consume the entire daily allowance.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "1h"))
