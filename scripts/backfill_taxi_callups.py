#!/usr/bin/env python3
"""Backfill `ups_taxi_callups` for a historical UPS season.

Walks MFL `TYPE=weeklyResults` for each NFL week of the target season,
identifies taxi-eligible R2-5 rookies who appeared on their franchise's
active lineup, and emits canonical INSERT statements so the worker's
`taxi_eligible` / `permanent_promotion` flags fire correctly going
forward (canon §B2 — 4+ active weeks = permanent promotion).

UPS Rookie Draft round is the canonical eligibility gate, NOT NFL
draft round. This script fetches UPS draftResults (TYPE=draftResults
on L=74598) and filters by `round` ∈ [2, 5].

Usage:
    python3 scripts/backfill_taxi_callups.py 2025 > /tmp/backfill_2025.sql
    cd worker
    npx wrangler d1 execute UPS_MFL_DB --remote --file /tmp/backfill_2025.sql

Idempotent: the generated SQL deletes any prior backfill rows for the
season (matched by source='backfill-<season>') before re-inserting. Safe
to re-run.

Limitations:
  - "Active for the week" requires the player to NOT be on taxi in
    weeklyResults for that week. Players in starter/nonstarter/IR
    status all count (canon §B2 includes IR).
  - 3-year UPS rookie window (current season - draft year < 3) is
    enforced — old rookies who've graduated to veteran status are
    skipped.
"""
import datetime
import json
import sys
import urllib.request

LEAGUE_ID = "74598"
NUM_WEEKS = 17
USER_AGENT = "upsmflproduction-backfill/1.0"
TAXI_LIKE_STATUSES = {"taxi", "taxi_squad", "taxisquad"}


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def fetch_ups_taxi_eligible(season):
    """Returns dict { player_id → { ups_round, ups_year, franchise_id_at_draft } }.

    Only includes R2-5 in the 3-year UPS rookie window
    (season - draft_year < 3).
    """
    out = {}
    for y in range(season, season - 3, -1):
        if y < 2010:
            break
        url = (
            f"https://api.myfantasyleague.com/{y}/export?"
            f"TYPE=draftResults&L={LEAGUE_ID}&JSON=1"
        )
        try:
            d = fetch_json(url)
        except Exception as e:
            print(f"-- WARN: skipping draft {y}: {e}", file=sys.stderr)
            continue
        for u in as_list(d.get("draftResults", {}).get("draftUnit")):
            for p in as_list(u.get("draftPick") or u.get("pick")):
                pid = str(p.get("player", "")).replace(" ", "").strip()
                pid = "".join(c for c in pid if c.isdigit())
                if not pid or pid in out:
                    continue
                try:
                    rnd = int(p.get("round", 0) or 0)
                except (TypeError, ValueError):
                    rnd = 0
                if rnd < 2 or rnd > 5:
                    continue
                fid = str(p.get("franchise", "")).strip().zfill(4)
                out[pid] = {
                    "ups_round": rnd,
                    "ups_year": y,
                    "franchise_id_at_draft": fid,
                }
    return out


def fetch_active_in_weeklyresults(season, week):
    """Returns list of (franchise_id, player_id) tuples for players active
    in that NFL week — anything NOT on taxi (starter, nonstarter, IR).
    """
    url = (
        f"https://api.myfantasyleague.com/{season}/export?"
        f"TYPE=weeklyResults&L={LEAGUE_ID}&W={week}&JSON=1"
    )
    try:
        d = fetch_json(url)
    except Exception as e:
        print(f"-- WARN: skipping week {season}/W{week}: {e}", file=sys.stderr)
        return []
    wr = d.get("weeklyResults", {}) or {}
    matchups = as_list(wr.get("matchup"))
    franchises = []
    if matchups:
        for m in matchups:
            franchises.extend(as_list(m.get("franchise")))
    franchises.extend(as_list(wr.get("franchise")))
    out = []
    seen = set()
    for fr in franchises:
        fid = str(fr.get("id", "")).strip().zfill(4)
        if not fid:
            continue
        for p in as_list(fr.get("player")):
            pid_raw = str(p.get("id", "")).strip()
            pid = "".join(c for c in pid_raw if c.isdigit())
            if not pid:
                continue
            status = str(p.get("status", "")).lower().strip()
            if status in TAXI_LIKE_STATUSES:
                continue
            key = (fid, pid)
            if key in seen:
                continue
            seen.add(key)
            out.append(key)
    return out


def main():
    if len(sys.argv) < 2:
        print("Usage: backfill_taxi_callups.py <season>", file=sys.stderr)
        sys.exit(1)
    try:
        season = int(sys.argv[1])
    except ValueError:
        print(f"Invalid season: {sys.argv[1]!r}", file=sys.stderr)
        sys.exit(1)

    ts = datetime.datetime.now(datetime.timezone.utc).isoformat()
    print(f"-- backfill_taxi_callups.py season={season}")
    print(f"-- generated {ts}")
    print(f"-- canon §B2: 4+ active weeks → became_permanent=1")
    print()

    print(f"-- Step 1: fetch UPS R2-5 rookies in 3yr window...", file=sys.stderr)
    elig = fetch_ups_taxi_eligible(season)
    print(f"-- Step 1 done: {len(elig)} taxi-eligible players", file=sys.stderr)

    print(f"-- Step 2: walk {NUM_WEEKS} weeks of weeklyResults...", file=sys.stderr)
    # week_actives[player_id] = list of (week, franchise_id) tuples
    week_actives = {}
    for w in range(1, NUM_WEEKS + 1):
        for fid, pid in fetch_active_in_weeklyresults(season, w):
            if pid not in elig:
                continue
            week_actives.setdefault(pid, []).append((w, fid))
        print(
            f"--   W{w:02d}: {sum(1 for v in week_actives.values() if any(x[0] == w for x in v))} active eligible",
            file=sys.stderr,
        )

    print(f"-- Step 2 done: {len(week_actives)} eligible players had ≥1 active week", file=sys.stderr)

    print(f"DELETE FROM ups_taxi_callups WHERE season='{season}' AND source='backfill-{season}';")
    total_rows = 0
    total_permanent = 0
    for pid in sorted(week_actives.keys()):
        weeks_sorted = sorted(week_actives[pid], key=lambda x: x[0])
        for idx, (wk, fid) in enumerate(weeks_sorted, start=1):
            permanent = 1 if idx >= 4 else 0
            if permanent:
                total_permanent += 1
            total_rows += 1
            print(
                "INSERT INTO ups_taxi_callups "
                "(league_id, season, franchise_id, player_id, nfl_week, "
                "called_up_at, demoted_at, became_permanent, callup_index, "
                "pending, source) VALUES "
                f"('{LEAGUE_ID}', '{season}', '{fid}', '{pid}', {wk}, "
                f"datetime('now'), NULL, {permanent}, {idx}, 0, "
                f"'backfill-{season}');"
            )

    print(
        f"\n-- Summary: {total_rows} rows inserted across {len(week_actives)} players. "
        f"{sum(1 for v in week_actives.values() if len(v) >= 4)} players hit 4+ weeks "
        f"(permanently promoted).",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
