#!/usr/bin/env python3
"""Prove the live leaderboard query still returns EXACTLY the stored board.

    python3 scripts/verify_leaderboard_matches_precompute.py 2025 idp

WHY THIS WORKS, AND WHY IT IS ALMOST FREE
    nfl_leaderboard_precompute holds the live query's own output, captured at
    build time (row_json is the response row verbatim — see migration 0140). So
    it is a recorded baseline of the query BEFORE a change, and reading it back
    costs one row per player instead of the millions the live query costs.

    That makes it the right regression check for any edit to the leaderboard
    SQL: run only the NEW query once, diff it against the stored OLD answer.
    If the edit was supposed to be a pure optimisation, the diff must be empty.

    ⚠️ The baseline is only as good as its build. Check built_at_utc against the
    last commit that touched the SQL — if the SQL changed after the board was
    built, the board is stale and a diff here is expected, not a regression.
    This script prints built_at_utc so that comparison is possible.

D1 COST
    Reading the baseline: ~row_count rows (500 for idp).
    Running the live query: whatever the query costs — which is the number the
    optimisation is trying to reduce. On the FREE tier (5,000,000 rows/day) an
    unoptimised idp run is ~5,000,000. Run this sparingly, and never in a loop.
"""
import json, os, subprocess, sys

WORKER = "https://upsmflproduction.keith-creelman.workers.dev"


def d1(sql: str):
    worker_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "worker")
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
        capture_output=True, text=True, cwd=worker_dir,
        env={k: v for k, v in os.environ.items()
             if k not in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")})
    # wrangler prints a human preamble before the JSON, and that preamble can
    # itself contain a "[" (version banners, log lines). Taking the FIRST one and
    # calling json.loads on the rest fails with "Extra data". Scan every "[" and
    # keep the first that actually decodes as a complete array.
    dec, text = json.JSONDecoder(), out.stdout
    for i, ch in enumerate(text):
        if ch != "[":
            continue
        try:
            val, _ = dec.raw_decode(text, i)
        except ValueError:
            continue
        if isinstance(val, list) and val:
            return val[0]
    print("wrangler returned no JSON array:\n" + (out.stderr or out.stdout)[-1200:]); sys.exit(1)


def main(season: str, pos: str) -> int:
    meta = d1(f"SELECT row_count, built_at_utc FROM nfl_leaderboard_precompute_meta "
              f"WHERE season={int(season)} AND pos_alias='{pos}'")["results"]
    if not meta:
        print(f"No stored board for {season}/{pos} — nothing to compare against."); return 1
    print(f"baseline: {meta[0]['row_count']} rows, built {meta[0]['built_at_utc']}")
    print("  ^ if the SQL changed AFTER this timestamp, a diff below is expected, not a regression")

    got = d1(f"SELECT row_json FROM nfl_leaderboard_precompute "
             f"WHERE season={int(season)} AND pos_alias='{pos}' ORDER BY rank ASC")
    old = [json.loads(r["row_json"]) for r in got["results"]]
    print(f"  baseline read cost: {got['meta']['rows_read']} rows")

    # NO_PRECOMPUTE=1 forces the live path; NO_CACHE=1 skips the edge cache.
    # Without BOTH we would be handed the very board we are trying to check.
    url = (f"{WORKER}/api/advanced-stats-leaderboard?season={season}&pos={pos}"
           f"&min_games=1&limit=500&NO_CACHE=1&NO_PRECOMPUTE=1")
    print(f"\nrunning the LIVE query (this is the expensive one)...")
    raw = subprocess.run(["curl", "-sS", url], capture_output=True, text=True).stdout
    try:
        body = json.loads(raw)
    except Exception:
        print("live query did not return JSON:\n" + raw[:800]); return 1
    if body.get("source") == "precompute":
        print("REFUSING: the live call was served the precompute — NO_PRECOMPUTE is not working, "
              "so this would be comparing the baseline against itself."); return 1
    new = body.get("rows") or []

    print(f"\nbaseline rows: {len(old)}   live rows: {len(new)}")
    if len(old) != len(new):
        print(f"MISMATCH: row COUNT differs ({len(old)} vs {len(new)}) — this alone is a regression")

    diffs, key = [], (lambda r: str(r.get("gsis_id") or ""))
    oldby, newby = {key(r): r for r in old}, {key(r): r for r in new}
    for missing in sorted(set(oldby) - set(newby)):
        diffs.append(f"row PRESENT in baseline, ABSENT live: {missing} "
                     f"({oldby[missing].get('player_name')})")
    for added in sorted(set(newby) - set(oldby)):
        diffs.append(f"row ABSENT in baseline, PRESENT live: {added} "
                     f"({newby[added].get('player_name')})")
    for k in sorted(set(oldby) & set(newby)):
        o, n = oldby[k], newby[k]
        for col in sorted(set(o) | set(n)):
            if o.get(col) != n.get(col):
                diffs.append(f"{k} {o.get('player_name')}: {col}  {o.get(col)!r} -> {n.get(col)!r}")
    # Ordering matters: the leaderboard IS a ranking.
    if [key(r) for r in old] != [key(r) for r in new]:
        first = next((i for i, (a, b) in enumerate(zip(old, new)) if key(a) != key(b)), None)
        diffs.append(f"ORDER differs, first at rank {(first or 0) + 1}: "
                     f"baseline {old[first].get('player_name')} vs live {new[first].get('player_name')}"
                     if first is not None else "ORDER differs")

    if not diffs:
        print("\nIDENTICAL — every row, every column, same order.")
        return 0
    print(f"\n{len(diffs)} DIFFERENCE(S):")
    for d in diffs[:40]:
        print("  " + d)
    if len(diffs) > 40:
        print(f"  ... and {len(diffs) - 40} more")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__); sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
