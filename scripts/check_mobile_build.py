#!/usr/bin/env python3
"""Keep site/m's cache-busting honest.

THE BUG THIS EXISTS FOR (2026-08-27)
    site/m/version.json said 2026.08.25.2 while index.html still referenced
    app.js?v=2026.08.17.5 and app.js itself carried BUILD = "2026.08.17.5".

    Two consequences, both invisible without this check:

    1. AN INFINITE UPDATE BANNER. app.js compares version.json (fetched fresh,
       no-store) against its own baked-in BUILD. Bumping only version.json makes
       them permanently unequal, so "New version available" reappears after every
       Reload — the reload re-fetches the SAME ?v= URL and nothing changes.

    2. FIXES THAT NEVER SHIP. The service worker is cache-first on assets,
       keyed by the ?v= URL. A changed .js with an unchanged ?v= is served from
       cache forever. Six mobile files had shipped changes no owner could load.

    Neither shows up in CI, in a deploy log, or in the app. It just silently
    does nothing.

Checks:
  * version.json build == the BUILD constant in app.js
  * version.json build == index.html's app.js?v=
  * every site/m/**.js modified more recently than its ?v= stamp implies

Usage:
    python3 scripts/check_mobile_build.py            # verify (exit 1 on drift)
    python3 scripts/check_mobile_build.py --since 7  # widen the staleness window
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = os.path.join(ROOT, "site", "m")


def read(p):
    with open(p, encoding="utf-8") as fh:
        return fh.read()


def main(since_days: int) -> int:
    problems = []
    build = json.loads(read(os.path.join(M, "version.json")))["build"]
    app = read(os.path.join(M, "app.js"))
    idx = read(os.path.join(M, "index.html"))

    m = re.search(r'var BUILD\s*=\s*"([^"]+)"', app)
    if not m:
        problems.append("app.js has no `var BUILD = \"...\"` — the update check cannot work")
    elif m.group(1) != build:
        problems.append(
            f"app.js BUILD is {m.group(1)!r} but version.json says {build!r} — "
            "the update banner will reappear after every Reload, forever")

    m = re.search(r"app\.js\?v=([0-9.]+)", idx)
    if not m:
        problems.append("index.html does not reference app.js?v= — nothing busts its cache")
    elif m.group(1) != build:
        problems.append(
            f"index.html loads app.js?v={m.group(1)} but version.json says {build} — "
            "the service worker will keep serving the cached app.js")

    # Files changed more recently than their cache-bust stamp.
    try:
        changed = subprocess.run(
            ["git", "log", f"--since={since_days} days ago", "--name-only",
             "--pretty=format:", "--", "site/m"],
            capture_output=True, text=True, cwd=ROOT).stdout.split()
    except Exception:
        changed = []
    seen = set()
    for path in changed:
        if not path.endswith(".js") or path in seen:
            continue
        seen.add(path)
        base = os.path.basename(path)
        ref = re.search(re.escape(base) + r"\?v=([0-9.]+)", idx)
        if not ref:
            continue
        last = subprocess.run(
            ["git", "log", "-1", "--format=%ad", "--date=short", "--", path],
            capture_output=True, text=True, cwd=ROOT).stdout.strip()
        stamp = ref.group(1)               # e.g. 2026.08.08.5 -> 2026-08-08
        stamp_day = "-".join(stamp.split(".")[:3])
        if last and stamp_day and last > stamp_day:
            problems.append(
                f"{base} changed {last} but index.html still loads it at ?v={stamp} "
                f"({stamp_day}) — the service worker serves the OLD file")

    if problems:
        print("Mobile build drift:\n")
        for p in problems:
            print("  ✗ " + p)
        print("\n  Bump site/m/version.json, the BUILD constant in app.js, and the ?v= of "
              "\n  every changed file in index.html TOGETHER. They are one release, not three.\n")
        return 1
    print(f"Mobile build OK — version.json, app.js BUILD and index.html all at {build}, "
          f"no stale ?v= in the last {since_days} days.")
    return 0


if __name__ == "__main__":
    n = 7
    if "--since" in sys.argv:
        try: n = int(sys.argv[sys.argv.index("--since") + 1])
        except Exception: pass
    sys.exit(main(n))
