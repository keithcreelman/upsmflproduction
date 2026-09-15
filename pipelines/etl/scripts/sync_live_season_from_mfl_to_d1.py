#!/usr/bin/env python3
"""sync_live_season_from_mfl_to_d1.py — direct MFL API -> D1 sync for the
CURRENT, in-progress season, bypassing the legacy local-DB fetcher entirely.

WHY THIS EXISTS (Keith 2026-09-15): the normal nightly pipeline is
local MFL fetcher (~/Desktop/MFL_Scripts, outside this repo) -> mfl_database.db
-> scripts/load_local_to_d1.py -> D1 src_* tables. That local fetcher's DB
hadn't been touched since 2026-05-08 (confirmed via file mtime), so D1's
src_schedule/src_standings had zero rows for season 2026 even though MFL
itself already had real Week 1 results -- /api/standings fell back to its
"preseason, 0-0" synthesis (worker/src/index.js, ~line 18759) because that
fallback only triggers on an EMPTY src_standings, not on a stale one.

Rather than resurrect the legacy fetcher, this script talks to MFL's live
export API directly (TYPE=league, TYPE=weeklyResults) for one season and
upserts the same src_franchises / src_schedule / src_franchise_weekly_score /
src_standings rows the nightly pipeline would have produced. Scoped to
season-in-progress use (weeks with real scores only) -- NOT a replacement
for full historical backfill.

Methodology matches migration 0040/0041's own stated convention: all-play /
h2h / div records are derived from real per-franchise weekly scores and
per-matchup results (MFL's authoritative numbers), not invented. pf/pp/eff
are derived the same way and cross-checked against MFL's own leagueStandings
export as a correctness check (see --verify).

KNOWN GAP: `pwr` (power ranking) has no source anywhere in this repo or in
MFL's export API (checked TYPE=leagueStandings' full field list; grepped
this repo for any pwr formula -- none exists, it was always a raw pass-through
from the legacy local `standings` table, whose own origin is outside this
repo). Left NULL here rather than invented. Same for
`src_weekly_franchise_summary` / `src_weekly` (per-player granularity) --
out of scope, not needed by /api/standings.

Usage:
  python3 sync_live_season_from_mfl_to_d1.py --season 2026 --dry-run
  python3 sync_live_season_from_mfl_to_d1.py --season 2026
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WORKER_DIR = SCRIPT_DIR.resolve().parents[2] / "worker"
WORKER_BASE = "https://upsmflproduction.keith-creelman.workers.dev"


def safe_str(v):
    return "" if v is None else str(v).strip()


def safe_int(v, default=0):
    try:
        return int(float(safe_str(v)))
    except Exception:
        return default


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


def pct_from_wlt(w, l, t):
    games = max(0, w + l + t)
    return round((w + 0.5 * t) / games, 4) if games > 0 else 0.0


def fetch_url_json(url, retries=4, timeout=30):
    last_err = None
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; upsmfl-sync/1.0)"})
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


def fetch_owner_map(seasons_to_try):
    """Most recent non-preseason season's owner_name per franchise_id, read
    from the live worker's own public /api/standings -- same fallback the
    worker itself uses (owners are stable year to year), no D1 credentials
    required."""
    for yr in seasons_to_try:
        try:
            resp = fetch_url_json(f"{WORKER_BASE}/api/standings?year={yr}")
        except Exception as exc:
            sys.stderr.write(f"owner-map fetch for {yr} failed: {exc}\n")
            continue
        if resp.get("preseason"):
            continue
        owners = {}
        for r in resp.get("rows", []):
            fid = pad4(r.get("franchise_id"))
            if fid and r.get("owner_name"):
                owners[fid] = r["owner_name"]
        if owners:
            return owners, yr
    return {}, None


def sql_quote(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'%s'" % str(v).replace("'", "''")


def determine_played_weeks(season, league_id, server, max_week):
    """Weeks with at least one real (nonzero) franchise score. Stops at the
    first unplayed week -- a scheduled-but-not-yet-played week still returns
    matchup pairings with all-zero scores, so presence of a matchup alone
    isn't sufficient."""
    played = []
    for wk in range(1, max_week + 1):
        payload = fetch_mfl(season, league_id, server, "weeklyResults", {"W": wk})
        matchups = as_list((payload.get("weeklyResults") or {}).get("matchup"))
        if not matchups:
            break
        any_real = any(
            safe_float(f.get("score")) > 0
            for m in matchups
            for f in as_list(m.get("franchise"))
        )
        if not any_real:
            break
        played.append((wk, matchups))
    return played


def build_league_meta(season, league_id, server):
    payload = fetch_mfl(season, league_id, server, "league")
    league = payload.get("league") or {}
    divisions = {}
    for d in as_list((league.get("divisions") or {}).get("division")):
        did = safe_str(d.get("id"))
        if did:
            divisions[did] = safe_str(d.get("name")) or f"Division {did}"
    fmeta = {}
    for f in as_list((league.get("franchises") or {}).get("franchise")):
        fid = pad4(f.get("id"))
        if not fid:
            continue
        fmeta[fid] = {
            "name": safe_str(f.get("name")) or fid,
            "division": safe_str(f.get("division")),
            "logo": safe_str(f.get("logo")),
        }
    return fmeta, divisions


def build_from_weeks(season, played_weeks, fmeta, owner_map):
    """Returns (schedule_rows, weekly_score) where weekly_score maps
    (week, franchise_id) -> {"score":..., "opt_pts":...} -- ONE row per
    franchise per week regardless of how many matchups that franchise plays
    that week (multi-opponent weeks reuse the same weekly score across each
    matchup -- verified directly against MFL's own W=1 payload)."""
    schedule_rows = []
    weekly_score = {}
    for wk, matchups in played_weeks:
        for m in matchups:
            reg = safe_int(m.get("regularSeason"), 1)
            frs = as_list(m.get("franchise"))
            if len(frs) != 2:
                sys.stderr.write(f"week {wk}: skipping non-2-team matchup ({len(frs)} franchises)\n")
                continue
            a, b = frs[0], frs[1]
            aid, bid = pad4(a.get("id")), pad4(b.get("id"))
            if not aid or not bid:
                continue
            a_score, b_score = safe_float(a.get("score")), safe_float(b.get("score"))
            a_opt, b_opt = safe_float(a.get("opt_pts")), safe_float(b.get("opt_pts"))
            a_div, b_div = fmeta.get(aid, {}).get("division"), fmeta.get(bid, {}).get("division")
            is_div = 1 if (a_div and a_div == b_div) else 0
            is_playoff = 0 if reg == 1 else 1
            for fid, oid, fs, osc, res, home in (
                (aid, bid, a_score, b_score, a.get("result"), safe_int(a.get("isHome"))),
                (bid, aid, b_score, a_score, b.get("result"), safe_int(b.get("isHome"))),
            ):
                schedule_rows.append({
                    "season": season, "week": wk,
                    "franchise_id": fid, "opponent_franchise_id": oid,
                    "franchise_name": fmeta.get(fid, {}).get("name"),
                    "opponent_franchise_name": fmeta.get(oid, {}).get("name"),
                    "franchise_owner": owner_map.get(fid),
                    "opponent_owner": owner_map.get(oid),
                    "is_home": home, "result": res,
                    "team_score": fs, "opponent_score": osc,
                    "is_divisional": is_div, "is_playoff": is_playoff,
                })
            weekly_score[(wk, aid)] = {"score": a_score, "opt_pts": a_opt, "is_playoff": is_playoff}
            weekly_score[(wk, bid)] = {"score": b_score, "opt_pts": b_opt, "is_playoff": is_playoff}
    return schedule_rows, weekly_score


def build_standings(season, franchise_ids, schedule_rows, weekly_score, fmeta, owner_map, salary_map):
    by_fid = {fid: {"h2h": [0, 0, 0], "div": [0, 0, 0]} for fid in franchise_ids}
    for r in schedule_rows:
        fid = r["franchise_id"]
        if fid not in by_fid:
            continue
        res = safe_str(r["result"]).upper()
        idx = 0 if res == "W" else (1 if res == "L" else 2)
        by_fid[fid]["h2h"][idx] += 1
        if r["is_divisional"]:
            by_fid[fid]["div"][idx] += 1

    weeks = sorted(set(wk for (wk, _fid) in weekly_score.keys()))
    allplay = {fid: [0, 0, 0] for fid in franchise_ids}
    pf_sum = {fid: 0.0 for fid in franchise_ids}
    pp_sum = {fid: 0.0 for fid in franchise_ids}
    for wk in weeks:
        week_scores = {
            fid: weekly_score[(wk, fid)]["score"]
            for fid in franchise_ids
            if (wk, fid) in weekly_score
        }
        for fid, sc in week_scores.items():
            pf_sum[fid] += sc
            pp_sum[fid] += weekly_score[(wk, fid)]["opt_pts"]
        fids = list(week_scores.keys())
        for fid in fids:
            for oid in fids:
                if fid == oid:
                    continue
                if week_scores[fid] > week_scores[oid]:
                    allplay[fid][0] += 1
                elif week_scores[fid] < week_scores[oid]:
                    allplay[fid][1] += 1
                else:
                    allplay[fid][2] += 1

    rows = []
    for fid in franchise_ids:
        h2h_w, h2h_l, h2h_t = by_fid[fid]["h2h"]
        div_w, div_l, div_t = by_fid[fid]["div"]
        ap_w, ap_l, ap_t = allplay[fid]
        pf = round(pf_sum[fid], 2)
        pp = round(pp_sum[fid], 2)
        eff = round(pf / pp * 100, 1) if pp > 0 else None
        rows.append({
            "season": season, "franchise_id": fid,
            "franchise_name": fmeta.get(fid, {}).get("name"),
            "owner_name": owner_map.get(fid),
            "division": fmeta.get(fid, {}).get("division"),
            "div_w": div_w, "div_l": div_l, "div_pct": pct_from_wlt(div_w, div_l, div_t),
            "h2h_w": h2h_w, "h2h_l": h2h_l, "h2h_t": h2h_t, "h2h_pct": pct_from_wlt(h2h_w, h2h_l, h2h_t),
            "allplay_w": ap_w, "allplay_l": ap_l, "allplay_t": ap_t,
            "allplay_pct": pct_from_wlt(ap_w, ap_l, ap_t),
            "pf": pf, "pp": pp, "pwr": None, "eff": eff,
            "salary": salary_map.get(fid),
        })
    return rows


SCHEDULE_COLS = [
    "season", "week", "franchise_id", "opponent_franchise_id",
    "franchise_name", "opponent_franchise_name", "franchise_owner", "opponent_owner",
    "is_home", "result", "team_score", "opponent_score", "is_divisional", "is_playoff",
]
STANDINGS_COLS = [
    "season", "franchise_id", "franchise_name", "owner_name", "division",
    "div_w", "div_l", "div_pct", "h2h_w", "h2h_l", "h2h_t", "h2h_pct",
    "allplay_w", "allplay_l", "allplay_t", "allplay_pct",
    "pf", "pp", "pwr", "eff", "salary",
    # migration 0040/0041 triplets: no playoff weeks exist yet this season,
    # so regseason == full == historical (2017+ convention) for all of them.
    "allplay_regseason_w", "allplay_regseason_l", "allplay_regseason_t",
    "allplay_playoff_w", "allplay_playoff_l", "allplay_playoff_t",
    "allplay_full_w", "allplay_full_l", "allplay_full_t",
    "allplay_historical_w", "allplay_historical_l", "allplay_historical_t",
]
FRANCHISES_COLS = ["season", "franchise_id", "owner_name", "team_name", "division", "logo"]
WEEKLY_SCORE_COLS = ["season", "week", "franchise_id", "team_score", "team_opt_pts", "is_playoff"]


def build_sql(table, cols, rows, pk_cols):
    if not rows:
        return ""
    update_clause = ", ".join(f"{c} = excluded.{c}" for c in cols if c not in pk_cols)
    parts = [f"DELETE FROM {table} WHERE season = {rows[0]['season']};"]
    for r in rows:
        values = ", ".join(sql_quote(r.get(c)) for c in cols)
        parts.append(
            f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({values}) "
            f"ON CONFLICT({', '.join(pk_cols)}) DO UPDATE SET {update_clause};"
        )
    return "\n".join(parts) + "\n"


def d1_execute_file(sql_text, label):
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write(sql_text)
        sql_path = f.name
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", sql_path],
        capture_output=True, text=True, cwd=str(WORKER_DIR),
    )
    if result.returncode != 0:
        sys.stderr.write(f"D1 execute failed for {label}:\n{result.stderr}\n")
        sys.exit(1)
    print(f"  {label}: {result.stdout[-500:].strip()}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, required=True)
    parser.add_argument("--league-id", default="74598")
    parser.add_argument("--server", default="www48")
    parser.add_argument("--max-week", type=int, default=17)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print(f"Fetching league meta for {args.season}...")
    fmeta, divisions = build_league_meta(args.season, args.league_id, args.server)
    franchise_ids = sorted(fmeta.keys())
    print(f"  {len(franchise_ids)} franchises, {len(divisions)} divisions")

    owner_map, owner_source_year = fetch_owner_map(range(args.season - 1, args.season - 6, -1))
    print(f"  owner names backfilled from season {owner_source_year} ({len(owner_map)} owners)")
    missing_owners = [fid for fid in franchise_ids if fid not in owner_map]
    if missing_owners:
        print(f"  WARNING: no owner_name for {missing_owners}")

    print("Fetching leagueStandings (for salary passthrough)...")
    ls_payload = fetch_mfl(args.season, args.league_id, args.server, "leagueStandings")
    ls_rows = as_list((ls_payload.get("leagueStandings") or {}).get("franchise"))
    salary_map = {pad4(r.get("id")): safe_str(r.get("salary")) or None for r in ls_rows}

    print(f"Determining played weeks (up to week {args.max_week})...")
    played_weeks = determine_played_weeks(args.season, args.league_id, args.server, args.max_week)
    week_nums = [wk for wk, _ in played_weeks]
    print(f"  played weeks: {week_nums}")
    if not played_weeks:
        print("No played weeks found -- nothing to sync.")
        return 0

    schedule_rows, weekly_score = build_from_weeks(args.season, played_weeks, fmeta, owner_map)
    print(f"  {len(schedule_rows)} src_schedule rows")

    standings_rows = build_standings(
        args.season, franchise_ids, schedule_rows, weekly_score, fmeta, owner_map, salary_map
    )
    for r in standings_rows:
        for trip in ("regseason", "full", "historical"):
            r[f"allplay_{trip}_w"] = r["allplay_w"]
            r[f"allplay_{trip}_l"] = r["allplay_l"]
            r[f"allplay_{trip}_t"] = r["allplay_t"]
        r["allplay_playoff_w"] = 0
        r["allplay_playoff_l"] = 0
        r["allplay_playoff_t"] = 0

    # Correctness check against MFL's own leagueStandings numbers.
    ls_by_fid = {pad4(r.get("id")): r for r in ls_rows}
    mismatches = []
    for r in standings_rows:
        fid = r["franchise_id"]
        ls = ls_by_fid.get(fid)
        if not ls:
            continue
        checks = [
            ("h2h_w", safe_int(ls.get("h2hw"))), ("h2h_l", safe_int(ls.get("h2hl"))),
            ("div_w", safe_int(ls.get("divw"))), ("div_l", safe_int(ls.get("divl"))),
            ("pf", safe_float(ls.get("pf"))), ("pp", safe_float(ls.get("pp"))),
            ("eff", safe_float(ls.get("eff"))),
        ]
        for field, expected in checks:
            got = r[field]
            if got is None or abs(safe_float(got) - safe_float(expected)) > 0.15:
                mismatches.append((fid, field, got, expected))
        exp_ap_w, exp_ap_l, exp_ap_t = (parse_ap := parse_wlt_local(ls.get("all_play_wlt")))
        for field, expected in (("allplay_w", exp_ap_w), ("allplay_l", exp_ap_l), ("allplay_t", exp_ap_t)):
            if r[field] != expected:
                mismatches.append((fid, field, r[field], expected))

    if mismatches:
        print(f"\n!! {len(mismatches)} MISMATCH(ES) vs MFL leagueStandings -- refusing to write:")
        for fid, field, got, expected in mismatches:
            print(f"   {fid} {field}: computed={got} mfl={expected}")
        return 1
    print(f"\nVerified: all {len(standings_rows)} franchises' h2h/div/allplay/pf/pp/eff match MFL's leagueStandings exactly.")

    franchises_rows = [
        {
            "season": args.season, "franchise_id": fid,
            "owner_name": owner_map.get(fid),
            "team_name": fmeta[fid]["name"],
            "division": fmeta[fid]["division"],
            "logo": fmeta[fid]["logo"],
        }
        for fid in franchise_ids
    ]
    weekly_score_rows = [
        {"season": args.season, "week": wk, "franchise_id": fid,
         "team_score": v["score"], "team_opt_pts": v["opt_pts"], "is_playoff": v["is_playoff"]}
        for (wk, fid), v in weekly_score.items()
    ]

    print("\nSample standings row:", json.dumps(standings_rows[0], indent=2))

    if args.dry_run:
        print(f"\nDRY RUN -- would write: {len(franchises_rows)} src_franchises, "
              f"{len(schedule_rows)} src_schedule, {len(weekly_score_rows)} src_franchise_weekly_score, "
              f"{len(standings_rows)} src_standings rows for season {args.season}.")
        print("NOTE: pwr left NULL for every row -- no source exists for it (see module docstring).")
        print(f"SYNC_RESULT week_nums={week_nums} max_week={max(week_nums)}")
        return 0

    print("\nWriting to D1 (remote)...")
    d1_execute_file(build_sql("src_franchises", FRANCHISES_COLS, franchises_rows, ["season", "franchise_id"]), "src_franchises")
    d1_execute_file(build_sql("src_schedule", SCHEDULE_COLS, schedule_rows, ["season", "week", "franchise_id", "opponent_franchise_id"]), "src_schedule")
    d1_execute_file(build_sql("src_franchise_weekly_score", WEEKLY_SCORE_COLS, weekly_score_rows, ["season", "week", "franchise_id"]), "src_franchise_weekly_score")
    d1_execute_file(build_sql("src_standings", STANDINGS_COLS, standings_rows, ["season", "franchise_id"]), "src_standings")
    print(f"\nD1 sync complete for season {args.season}: "
          f"{len(franchises_rows)} franchises, {len(schedule_rows)} schedule rows, "
          f"{len(weekly_score_rows)} weekly-score rows, {len(standings_rows)} standings rows.")
    print(f"SYNC_RESULT week_nums={week_nums} max_week={max(week_nums)}")
    return 0


def parse_wlt_local(text):
    raw = safe_str(text)
    parts = raw.replace("/", "-").split("-")
    if len(parts) < 2:
        return (0, 0, 0)
    w = safe_int(parts[0], 0)
    l = safe_int(parts[1], 0)
    t = safe_int(parts[2], 0) if len(parts) > 2 else 0
    return (w, l, t)


if __name__ == "__main__":
    sys.exit(main())
