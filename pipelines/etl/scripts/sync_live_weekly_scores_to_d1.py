#!/usr/bin/env python3
"""sync_live_weekly_scores_to_d1.py — direct MFL API -> D1 sync for
src_weekly (per-player-week fantasy score), bypassing the dead legacy
local-DB fetcher entirely, same as sync_live_season_from_mfl_to_d1.py.

WHY THIS EXISTS (Keith 2026-09-15): src_weekly is the foundational
per-player-week score table behind bench_burns/top_performers/
player_prior_form (wire_data.py), the bad-beats and trade-outcome D1 syncs,
the weekly recap packs, the ML feature pipeline (build_player_week_features,
simulate_wr_te_ups), roster points history, and player scoring reports. Its
only writer was the same dead local-fetcher -> load_local_to_d1.py chain
already found broken for standings (fetcher's local DB last touched
2026-05-08) -- so it has zero 2026 rows.

SCHEMA SEMANTICS -- reverse-engineered and VERIFIED against real historical
data (2025 week 1: reconstructed independently from live MFL, diffed
field-by-field against all 1,191 real stored D1 rows -- exact match on
score/pos_group/status/roster_franchise_id/roster_franchise_name for every
row; the only mismatches were pos_rank/overall_rank ties AMONG PLAYERS WITH
THE IDENTICAL SCORE, i.e. arbitrary tie-break order, not a real difference):

  - Row set = exactly MFL's TYPE=playerScores universe for that week (every
    player MFL computed a real score for). A player MFL didn't score that
    week (bye, truly inactive, or an unscored taxi/IR slot) has NO row --
    never a fabricated 0.
  - status is 'starter' | 'nonstarter' | 'fa' (NOT "free agent" -- the wire_data.py
    docstring's prose is loose; the literal stored value is 'fa').
      * 'starter'/'nonstarter' + real roster_franchise_id: from
        TYPE=weeklyResults' per-franchise player[] list, whose own `status`
        field is authoritative (cross-checked against the redundant
        `nonstarters` id-list field -- always agreed, 0 mismatches).
      * TAXI_SQUAD players (from TYPE=rosters, W=<week>) who aren't in
        weeklyResults' player[] are ALSO 'nonstarter' with their real
        franchise -- confirmed on 6 real 2025-wk1 taxi players who had a
        playerScores entry; taxi players with no score simply get no row.
      * INJURED_RESERVE: no historical example this session had a real
        score to confirm against, so this is a REASONED EXTENSION of the
        taxi rule (rostered + can't start -> 'nonstarter'), not a verified
        fact. Flagged again at the point it's applied.
      * Anyone not on any of the 12 rosters -> status='fa',
        roster_franchise_id='FA', roster_franchise_name='Free Agent'
        (literal sentinel strings, confirmed against real rows).
  - pos_group: QB/RB/WR/TE/PK/PN/DL/LB/DB, mapped from TYPE=players'
    `position` (same 9-group taxonomy as worker/src/index.js's posGroup()
    in /api/lineup-matchups -- reused verbatim, confirmed exact match).
  - pos_rank / overall_rank: plain rank by score, descending, within
    pos_group / globally across ALL players THAT WEEK (fa included) --
    ties broken here by player_id for determinism (the original tie-break
    order is not recoverable and doesn't matter -- see above).
  - is_reg: 1 if week <= that season's last_regular_season_week, else 0
    (confirmed against every week of 2025 via the public /api/standings meta).

KNOWN GAP: `win_chunks` (a z-score-derived "chunks of winning" metric,
migration 0004) is a metric COMPUTED by the legacy pipeline from
`src_baselines` (percentile baselines, itself fed by the same dead fetcher)
-- not a raw MFL field, and its exact formula lives outside this repo.
Left NULL rather than invented. If it's needed, that is a separate,
follow-up task requiring Keith to either supply the formula or approve a
reconstruction from real historical score distributions.

Usage:
  python3 sync_live_weekly_scores_to_d1.py --season 2026 --dry-run
  python3 sync_live_weekly_scores_to_d1.py --season 2026
  python3 sync_live_weekly_scores_to_d1.py --season 2025 --weeks 1 --dry-run --verify-against-d1
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR.parent))
from lib.d1_io import D1Writer  # noqa: E402

WORKER_BASE = "https://upsmflproduction.keith-creelman.workers.dev"

POSMAP = {
    "QB": "QB",
    "RB": "RB", "FB": "RB", "HB": "RB",
    "WR": "WR",
    "TE": "TE",
    "PK": "PK", "K": "PK",
    "PN": "PN", "P": "PN",
    "DT": "DL", "DE": "DL", "NT": "DL", "DL": "DL",
    "LB": "LB", "OLB": "LB", "ILB": "LB", "MLB": "LB",
    "CB": "DB", "S": "DB", "FS": "DB", "SS": "DB", "DB": "DB",
}


def safe_str(v):
    return "" if v is None else str(v).strip()


def safe_float(v, default=0.0):
    try:
        return float(safe_str(v))
    except Exception:
        return default


def pad4(v):
    d = "".join(ch for ch in safe_str(v) if ch.isdigit())
    return d.zfill(4)[-4:] if d else ""


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def fetch_url_json(url, retries=4, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; upsmfl-sync/1.0)"})
    last_err = None
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code not in (429, 500, 502, 503, 504) or attempt >= retries:
                raise
            time.sleep(min(20, 2 + attempt * 3))
        except Exception as e:
            last_err = e
            if attempt >= retries:
                raise
            time.sleep(min(10, 1 + attempt))
    if last_err:
        raise last_err
    raise RuntimeError("fetch failed")


def fetch_mfl(season, league_id, server, type_name, extra=None):
    params = {"TYPE": type_name, "L": league_id, "JSON": "1"}
    if extra:
        params.update(extra)
    url = f"https://{server}.myfantasyleague.com/{season}/export?{urllib.parse.urlencode(params)}"
    return fetch_url_json(url)


def determine_played_weeks(season, league_id, server, max_week):
    """playerScores returns a full-universe row set for a FUTURE week too
    (every player, score=0) -- confirmed live 2026-09-16, week 2 onward all
    "had rows" with nothing real in them. Require at least one real nonzero
    score, matching the same real-vs-scheduled distinction used for
    liveScoring/weeklyResults elsewhere in this pipeline."""
    played = []
    for wk in range(1, max_week + 1):
        payload = fetch_mfl(season, league_id, server, "playerScores", {"W": wk})
        rows = as_list((payload.get("playerScores") or {}).get("playerScore"))
        if not rows or not any(safe_float(r.get("score")) != 0 for r in rows):
            break
        played.append(wk)
    return played


def fetch_last_regular_season_week(season):
    resp = fetch_url_json(f"{WORKER_BASE}/api/standings?year={season}")
    wk = resp.get("meta", {}).get("last_regular_season_week")
    return int(wk) if wk else None


def build_position_map(season, league_id, server):
    payload = fetch_mfl(season, league_id, server, "players", {"DETAILS": "1"})
    pos_of = {}
    for p in as_list((payload.get("players") or {}).get("player")):
        pid = safe_str(p.get("id"))
        if pid:
            pos_of[pid] = POSMAP.get(safe_str(p.get("position")).upper())
    return pos_of


def build_team_names(season, league_id, server):
    payload = fetch_mfl(season, league_id, server, "league")
    names = {}
    for f in as_list((payload.get("league") or {}).get("franchises", {}).get("franchise")):
        fid = pad4(f.get("id"))
        if fid:
            names[fid] = safe_str(f.get("name")) or fid
    return names


def build_week_rows(season, week, league_id, server, pos_of, team_name_of, is_reg):
    ps = fetch_mfl(season, league_id, server, "playerScores", {"W": week})
    score_of = {}
    for p in as_list((ps.get("playerScores") or {}).get("playerScore")):
        pid = safe_str(p.get("id"))
        if pid:
            score_of[pid] = safe_float(p.get("score"))
    if not score_of:
        return []

    wr = fetch_mfl(season, league_id, server, "weeklyResults", {"W": week})
    status_of, roster_of = {}, {}
    for m in as_list((wr.get("weeklyResults") or {}).get("matchup")):
        for fr in as_list(m.get("franchise")):
            fid = pad4(fr.get("id"))
            if not fid:
                continue
            for p in as_list(fr.get("player")):
                pid = safe_str(p.get("id"))
                if pid:
                    status_of[pid] = safe_str(p.get("status"))
                    roster_of[pid] = fid

    # TAXI_SQUAD (and, unverified but reasoned, INJURED_RESERVE) players who
    # aren't in weeklyResults' player[] but DID get a real score this week.
    ros = fetch_mfl(season, league_id, server, "rosters", {"W": week})
    for fr in as_list((ros.get("rosters") or {}).get("franchise")):
        fid = pad4(fr.get("id"))
        if not fid:
            continue
        for p in as_list(fr.get("player")):
            pid = safe_str(p.get("id"))
            rstatus = safe_str(p.get("status"))
            if pid and pid not in status_of and pid in score_of and rstatus in ("TAXI_SQUAD", "INJURED_RESERVE"):
                status_of[pid] = "nonstarter"
                roster_of[pid] = fid

    rows = {}
    for pid, score in score_of.items():
        status = status_of.get(pid, "fa")
        fid = roster_of.get(pid, "FA")
        rows[pid] = {
            "season": season, "week": week, "player_id": pid,
            "pos_group": pos_of.get(pid), "status": status, "score": score,
            "is_reg": is_reg,
            "roster_franchise_id": fid,
            "roster_franchise_name": "Free Agent" if fid == "FA" else team_name_of.get(fid, fid),
        }

    overall_order = sorted(rows.keys(), key=lambda p: (-rows[p]["score"], p))
    for i, pid in enumerate(overall_order, start=1):
        rows[pid]["overall_rank"] = i
    by_pos = {}
    for pid, r in rows.items():
        by_pos.setdefault(r["pos_group"], []).append(pid)
    for _pg, ids in by_pos.items():
        ids.sort(key=lambda p: (-rows[p]["score"], p))
        for i, pid in enumerate(ids, start=1):
            rows[pid]["pos_rank"] = i

    starters = sum(1 for r in rows.values() if r["status"] == "starter")
    print(f"  week {week}: {len(rows)} rows ({starters} starters, "
          f"{sum(1 for r in rows.values() if r['status']=='nonstarter')} nonstarter, "
          f"{sum(1 for r in rows.values() if r['status']=='fa')} fa)", file=sys.stderr)
    return list(rows.values())


COLS = ["season", "week", "player_id", "pos_group", "status", "score", "is_reg",
        "roster_franchise_id", "roster_franchise_name", "pos_rank", "overall_rank"]


def verify_against_d1(rows, season, week):
    """Re-derive from raw D1 and diff, for --verify-against-d1 on a past week.
    Uses --command (not --file): --file's upload-progress banner goes to
    stdout ahead of the JSON and breaks a naive json.loads."""
    import subprocess
    worker_dir = SCRIPT_DIR.resolve().parents[2] / "worker"
    q = (f"SELECT player_id, pos_group, status, score, roster_franchise_id, "
         f"roster_franchise_name, pos_rank, overall_rank FROM src_weekly "
         f"WHERE season={season} AND week={week}")
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", q],
        capture_output=True, text=True, cwd=str(worker_dir),
    )
    if res.returncode != 0:
        print(f"  [verify] D1 read failed: {res.stderr[-500:]}", file=sys.stderr)
        return
    d1_rows = {r["player_id"]: r for r in json.loads(res.stdout)[0]["results"]}
    by_pid = {r["player_id"]: r for r in rows}
    missing = set(d1_rows) - set(by_pid)
    extra = set(by_pid) - set(d1_rows)
    print(f"  [verify] D1 has {len(d1_rows)} rows, computed {len(by_pid)}; "
          f"missing={len(missing)} extra={len(extra)}")
    mism = {k: 0 for k in ("pos_group", "status", "roster_franchise_id", "roster_franchise_name", "score")}
    rank_mism = 0
    for pid in set(d1_rows) & set(by_pid):
        a, b = d1_rows[pid], by_pid[pid]
        for f in mism:
            av, bv = a[f], b[f]
            if f == "score":
                if abs(float(av) - float(bv)) > 0.05:
                    mism[f] += 1
            elif av != bv:
                mism[f] += 1
        if int(a["overall_rank"]) != b["overall_rank"] or int(a["pos_rank"] or -1) != (b.get("pos_rank") or -1):
            rank_mism += 1
    print(f"  [verify] field mismatches: {mism}, rank mismatches (incl. tie order): {rank_mism}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--league-id", default="74598")
    parser.add_argument("--server", default="www48")
    parser.add_argument("--max-week", type=int, default=17)
    parser.add_argument("--weeks", default=None, help="Comma list, e.g. '1,2'. Default: auto-detect played weeks.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--verify-against-d1", action="store_true", help="Diff computed rows against real stored D1 rows (for a past week).")
    args = parser.parse_args()

    print(f"Fetching position map + team names for {args.season}...")
    pos_of = build_position_map(args.season, args.league_id, args.server)
    team_name_of = build_team_names(args.season, args.league_id, args.server)
    print(f"  {len(pos_of)} players, {len(team_name_of)} franchises")

    last_reg_wk = fetch_last_regular_season_week(args.season)
    if not last_reg_wk:
        print(f"Could not resolve last_regular_season_week for {args.season} "
              f"(src_league_season_meta not synced?) -- refusing to guess is_reg.", file=sys.stderr)
        return 1
    print(f"  last_regular_season_week={last_reg_wk}")

    if args.weeks:
        weeks = [int(w) for w in args.weeks.split(",")]
    else:
        print(f"Determining played weeks (up to week {args.max_week})...")
        weeks = determine_played_weeks(args.season, args.league_id, args.server, args.max_week)
    print(f"  weeks: {weeks}")
    if not weeks:
        print("No played weeks found -- nothing to sync.")
        return 0

    all_rows = []
    for wk in weeks:
        is_reg = 1 if wk <= last_reg_wk else 0
        rows = build_week_rows(args.season, wk, args.league_id, args.server, pos_of, team_name_of, is_reg)
        all_rows.extend(rows)
        if args.verify_against_d1:
            verify_against_d1(rows, args.season, wk)

    print(f"\nTotal: {len(all_rows)} rows across {len(weeks)} week(s).")
    print("NOTE: win_chunks left NULL for every row -- no source exists for it (see module docstring).")

    if args.dry_run:
        print("\nSample row:", json.dumps(all_rows[0], indent=2) if all_rows else None)
        print(f"\nDRY RUN -- would write {len(all_rows)} rows to src_weekly.")
        print(f"SYNC_RESULT week_nums={weeks} max_week={max(weeks)}")
        return 0

    print("\nWriting to D1 (remote)...")
    with D1Writer(table="src_weekly", cols=COLS, pk_cols=["season", "week", "player_id"]) as w:
        for r in all_rows:
            w.add(tuple(r[c] for c in COLS))
    print(f"\nD1 sync complete: {len(all_rows)} src_weekly rows for season {args.season}, weeks {weeks}.")
    print(f"SYNC_RESULT week_nums={weeks} max_week={max(weeks)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
