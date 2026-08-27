#!/usr/bin/env python3
"""Resolve MFL players → Sleeper facts once, offline, into D1.

WHY THIS RUNS IN CI AND NOT IN THE WORKER
    /api/player-news fetched Sleeper's 14.6 MB player file and JSON.parse'd it on
    every request. That exceeds the Worker's CPU budget; the surrounding catch is
    fail-soft, so `sleeperIndex` silently stayed {} and EVERY player reported
    sleeper_matched: 0 — no injury status, no depth chart, for anyone. Measured
    2026-08-27 against Trey Benson and Patrick Mahomes.

BOTH MATCH PATHS WERE BROKEN
    gsis_id   MFL's DETAILS export returns it for 0 of 2,609 players.
    name+team MFL says KCC / GBP / SFO / TBB / NEP where Sleeper says
              KC / GB / SF / TB / NE, so those teams never matched either.

    So neither worked, and the failure was invisible because the catch swallowed
    it. This resolves the mapping once and stores the result.

Usage:
    python3 scripts/build_sleeper_cache.py --dry-run
    python3 scripts/build_sleeper_cache.py --apply
"""
import json, os, re, subprocess, sys, urllib.request
from datetime import datetime, timezone

LEAGUE, SEASON = "74598", "2026"
UA = {"User-Agent": "upsmflproduction-sleeper-cache", "Accept": "application/json"}

# MFL's team codes -> Sleeper's. MFL pads several to three letters; Sleeper uses
# the NFL's own abbreviations. Only the ones that actually differ are listed.
TEAM_FIX = {
    "KCC": "KC", "GBP": "GB", "SFO": "SF", "TBB": "TB", "NEP": "NE",
    "NOS": "NO", "LVR": "LV", "JAC": "JAX", "WAS": "WAS", "ARZ": "ARI",
}


def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120))


def norm_team(t):
    t = (t or "").upper()
    return TEAM_FIX.get(t, t)


def main(apply: bool) -> int:
    mfl = get(f"https://www48.myfantasyleague.com/{SEASON}/export"
              f"?TYPE=players&L={LEAGUE}&DETAILS=1&JSON=1")["players"]["player"]
    sleeper = get("https://api.sleeper.app/v1/players/nfl")
    print(f"  MFL players     : {len(mfl):,}")
    print(f"  Sleeper players : {len(sleeper):,}")

    by_gsis, by_name_team = {}, {}
    for sid, p in sleeper.items():
        if not p:
            continue
        g = (p.get("gsis_id") or "").strip()
        if g:
            by_gsis[g] = (sid, p)
        fn = (p.get("full_name") or "").strip().lower()
        tm = norm_team(p.get("team"))
        if fn and tm:
            by_name_team[f"{fn}|{tm}"] = (sid, p)

    rows, by_kind = [], {"gsis": 0, "name_team": 0, "none": 0}
    now = datetime.now(timezone.utc).isoformat()
    for m in mfl:
        pid = str(m.get("id") or "")
        if not pid:
            continue
        g = (m.get("gsis_id") or "").strip()
        hit, kind = None, "none"
        if g and g in by_gsis:
            hit, kind = by_gsis[g], "gsis"
        if not hit:
            nm = (m.get("name") or "")
            flipped = " ".join(reversed([x.strip() for x in nm.split(",")])) if "," in nm else nm
            key = f"{flipped.strip().lower()}|{norm_team(m.get('team'))}"
            if key in by_name_team:
                hit, kind = by_name_team[key], "name_team"
        by_kind[kind] += 1
        if not hit:
            continue
        sid, p = hit
        rows.append((pid, sid, p.get("full_name"), norm_team(p.get("team")),
                     p.get("injury_status"), p.get("injury_body_part"), p.get("injury_notes"),
                     p.get("practice_participation"), p.get("practice_description"),
                     p.get("depth_chart_position"), p.get("depth_chart_order"),
                     p.get("news_updated"), kind, now))

    print(f"  matched by gsis : {by_kind['gsis']:,}")
    print(f"  matched by name : {by_kind['name_team']:,}")
    print(f"  unmatched       : {by_kind['none']:,}")
    print(f"  rows to write   : {len(rows):,}")

    # A collapse to near-zero means the upstream shape changed — writing that
    # would replace a working cache with an empty one, which is exactly the
    # silent failure this whole file exists to end.
    if len(rows) < 500:
        print(f"REFUSE: only {len(rows)} matches — expected >500. Not writing.")
        return 2

    if not apply:
        print("\n  DRY RUN — nothing written.")
        for r in rows[:5]:
            print(f"    {r[0]:>6} {str(r[2])[:24]:<24} {r[3]:<4} inj={r[4]!r} depth={r[9]}/{r[10]} via {r[12]}")
        return 0

    def esc(v):
        if v is None or v == "":
            return "NULL"
        return "'" + str(v).replace("'", "''") + "'"

    stmts = ["DELETE FROM sleeper_player_cache;"]
    for r in rows:
        stmts.append(
            "INSERT INTO sleeper_player_cache (mfl_player_id, sleeper_player_id, full_name, team,"
            " injury_status, injury_body_part, injury_notes, practice_participation,"
            " practice_description, depth_chart_position, depth_chart_order, news_updated,"
            " matched_by, built_at_utc) VALUES ("
            + ", ".join(esc(x) for x in r) + ");")

    path = "/tmp/sleeper_cache.sql"
    open(path, "w").write("\n".join(stmts))
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", path],
        capture_output=True, text=True,
        cwd=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker"))
    tail = (out.stdout + out.stderr)[-500:]
    print(tail)
    return 0 if "success" in tail.lower() or out.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
