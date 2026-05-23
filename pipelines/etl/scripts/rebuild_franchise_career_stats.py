#!/usr/bin/env python3
"""
rebuild_franchise_career_stats.py — Regenerate pipelines/etl/data/franchise_career_stats.json from D1.

The roast context builder loads franchise_career_stats.json for owner W-L,
championships, playoff appearances, season-by-season finish trend, and h2h
between owners. This script rebuilds that file from D1's src_final_standings
+ src_weekly_franchise_summary + discord_owners tables.

Run periodically (manually, or via a future launchd timer) to keep career
stats fresh as new seasons complete.

Usage:
  python rebuild_franchise_career_stats.py            # writes JSON
  python rebuild_franchise_career_stats.py --dry-run  # prints, no write
"""

import argparse
import json
import subprocess
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
OUT_PATH = SCRIPT_DIR.parent / "data" / "franchise_career_stats.json"
TENURE_OVERRIDES_PATH = SCRIPT_DIR.parent / "config" / "owner_tenure_overrides.json"

# MFL truth source for per-(season, franchise_id) owner_name attribution.
# Worker endpoint authenticates via MFL_COOKIE and returns 17-year history.
# Replaces D1's src_weekly_franchise_summary.owner_name (which ETL stamped
# with current owners and lost historical attribution).
WORKER_OWNERSHIP_URL = (
    "https://upsmflproduction.keith-creelman.workers.dev"
    "/api/franchise-ownership-history"
)

# UPS league format history (Keith 2026-05-23 canon, refined):
#   2010 — first ever UPS season. Redraft auction-only format. STILL counts
#          as UPS year 1 ("count year 1 as 2010 regardless") even though it
#          wasn't dynasty format yet.
#   2011 — first season of CURRENT (dynasty) format. Counts.
#   2012 — first season with rookie draft + roster contract rollover. Counts.
# So UPS_FOUNDING_SEASON = 2010 (the league's actual first season).
# Owner-tenure attribution is handled separately — owners who weren't on a
# franchise in 2010 don't get credit for that season (per the season-start-
# owner rule + manual overrides in owner_tenure_overrides.json).
UPS_FOUNDING_SEASON = 2010


def load_tenure_overrides() -> dict:
    """Load manual owner-tenure overrides. Returns {fid: [{owner_name, tenure_start_season, tenure_end_season}]}."""
    if not TENURE_OVERRIDES_PATH.exists():
        return {}
    with open(TENURE_OVERRIDES_PATH) as f:
        raw = json.load(f)
    # Strip _README and _* metadata keys
    return {k: v for k, v in raw.items() if not k.startswith("_")}


def fetch_mfl_ownership() -> dict:
    """Pull per-year MFL ownership truth via worker endpoint.

    Returns {season(int): {fid(str): owner_name(str)}}. Authoritative replacement
    for D1's src_weekly_franchise_summary.owner_name. NOTE: MFL reports the
    END-OF-SEASON owner, not the season-start owner. Overrides handle the
    "season-start owner gets the season" Keith ruling on mid-season takeovers
    (e.g. 0006/2024 Brian Cross is MFL-attributed but Keith-overridden to Josh
    Lima as the season-start owner).
    """
    req = urllib.request.Request(
        WORKER_OWNERSHIP_URL,
        headers={"User-Agent": "Mozilla/5.0 (UPS-Rebuilder)"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.loads(resp.read())
    if not data.get("ok"):
        raise SystemExit(f"MFL ownership endpoint error: {data}")
    out = {}
    for season_str, fid_map in (data.get("history") or {}).items():
        try:
            season = int(season_str)
        except (ValueError, TypeError):
            continue
        if not isinstance(fid_map, dict):
            continue
        for fid, info in fid_map.items():
            if not isinstance(info, dict):
                continue
            owner = (info.get("owner_name") or "").strip()
            if owner:
                out.setdefault(season, {})[str(fid).zfill(4)] = owner
    return out


def _owners_match(a: str, b: str) -> bool:
    """Case-insensitive owner-name match. Substring tolerated for nickname variations."""
    if not a or not b:
        return False
    al, bl = a.strip().lower(), b.strip().lower()
    if al == bl:
        return True
    # Substring tolerance for nicknames (e.g. "Steve Bousquet" vs "Steve B.")
    return al in bl or bl in al


def build_effective_ownership(mfl_ownership: dict, overrides: dict) -> tuple[dict, dict]:
    """Resolve (fid, season) → effective season-start owner.

    Starts from MFL truth, then applies overrides: when an override declares
    "owner X's tenure on franchise Y starts season N", any season < N where MFL
    attributed X to Y is reassigned to the PRIOR MFL owner on that franchise
    (the season-start owner per Keith's commish ruling). If no prior owner
    exists in MFL data, the (fid, season) cell is dropped — the franchise totals
    still include it but no owner career picks it up.

    Returns:
      effective_owner_by_fs: {(fid, season): owner_name}
      override_meta_by_fid: {fid: [{"owner_name", "tenure_start_season",
                                    "tenure_end_season", "notes"}]}
    """
    effective: dict = {}
    for season, fid_map in mfl_ownership.items():
        for fid, owner in fid_map.items():
            effective[(fid, season)] = owner

    override_meta_by_fid: dict = defaultdict(list)
    for fid, entries in overrides.items():
        for entry in entries:
            owner_nm = (entry.get("owner_name") or "").strip()
            if not owner_nm:
                continue
            start = entry.get("tenure_start_season")
            end = entry.get("tenure_end_season")
            override_meta_by_fid[fid].append({
                "owner_name": owner_nm,
                "tenure_start_season": start,
                "tenure_end_season": end,
                "notes": entry.get("notes", ""),
            })

            # Seasons where MFL attributes this owner to this franchise
            mfl_seasons_for_owner = sorted(
                s for (f, s), nm in effective.items()
                if f == fid and _owners_match(nm, owner_nm)
            )
            for season in mfl_seasons_for_owner:
                in_tenure = (
                    (start is None or season >= start)
                    and (end is None or season <= end)
                )
                if in_tenure:
                    continue
                # Out-of-tenure: reassign to prior MFL owner on this franchise
                prior_owner = None
                for psn in range(season - 1, season - 16, -1):
                    cand = mfl_ownership.get(psn, {}).get(fid)
                    if cand and not _owners_match(cand, owner_nm):
                        prior_owner = cand
                        break
                if prior_owner:
                    effective[(fid, season)] = prior_owner
                else:
                    effective.pop((fid, season), None)

    return effective, dict(override_meta_by_fid)


def d1_query(sql: str) -> list[dict]:
    """Run a SELECT against the remote D1 via wrangler. Returns list of rows."""
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json",
         "--command", sql],
        capture_output=True, text=True,
        cwd=str(Path(__file__).resolve().parents[3] / "worker"),
    )
    if result.returncode != 0:
        sys.stderr.write(f"D1 query failed:\n{result.stderr}\n")
        sys.exit(1)
    # wrangler --json wraps results in [{ "results": [...], "success": true, ... }]
    payload = json.loads(result.stdout)
    if not payload or not isinstance(payload, list):
        return []
    return payload[0].get("results", []) or []


def d1_execute_file(sql_text: str) -> None:
    """Run a multi-statement SQL script against remote D1 via wrangler.

    Used to UPSERT the per-franchise career stats from this script's output
    into ups_owner_career_stats so the Cloudflare worker can read owner-
    attribution data at request time (clap-back grounding for the trade-
    roast bot's Reply button). Without this, the worker queries
    src_final_standings directly and credits the franchise's chips to the
    current owner — which is wrong for cross-franchise owners (Keith's
    franchise 0008 has 2010 chip from Roussin; Keith's owner career has 0).
    """
    import tempfile
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".sql", delete=False
    ) as f:
        f.write(sql_text)
        sql_path = f.name
    try:
        result = subprocess.run(
            ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote",
             "--file", sql_path],
            capture_output=True, text=True,
            cwd=str(Path(__file__).resolve().parents[3] / "worker"),
        )
        if result.returncode != 0:
            sys.stderr.write(f"D1 execute failed:\n{result.stderr}\n")
            sys.exit(1)
    finally:
        Path(sql_path).unlink(missing_ok=True)


def _sql_quote(v) -> str:
    """SQL string literal — single quotes, escape internal single quotes."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def sync_to_d1(stats: dict) -> None:
    """UPSERT each franchise's owner-career row into ups_owner_career_stats."""
    rows = []
    for fid, e in stats.items():
        o = e.get("owner", {}) or {}
        franchises_owned_json = json.dumps(o.get("franchises_owned", []))
        seasons_by_fr_json = json.dumps(o.get("seasons_by_franchise", {}))
        allplay = o.get("allplay", {}) or {}
        overall = o.get("overall", {}) or {}
        rows.append({
            "franchise_id": fid,
            "owner_display": o.get("display", "") or "",
            "franchise_name": e.get("franchise_name", "") or "",
            "current_year": e.get("current_year"),
            "owner_first_season": o.get("first_season"),
            "owner_seasons_count": o.get("seasons_count", 0) or 0,
            "owner_franchises_owned": franchises_owned_json,
            "owner_seasons_by_franchise": seasons_by_fr_json,
            "owner_championships": o.get("championships", 0) or 0,
            "owner_playoff_appearances": o.get("playoff_appearances", 0) or 0,
            "owner_best_finish": o.get("best_finish"),
            "owner_worst_finish": o.get("worst_finish"),
            "owner_allplay_w": allplay.get("w", 0) or 0,
            "owner_allplay_l": allplay.get("l", 0) or 0,
            "owner_allplay_pct": o.get("allplay_pct"),
            "owner_overall_w": overall.get("w", 0) or 0,
            "owner_overall_l": overall.get("l", 0) or 0,
            "owner_last_championship": o.get("last_championship"),
            "franchise_seasons_played": e.get("seasons_played", 0) or 0,
            "franchise_championships": e.get("championships", 0) or 0,
            "franchise_last_championship": e.get("last_championship"),
            "franchise_championship_drought": e.get("championship_drought"),
        })

    cols = [
        "franchise_id", "owner_display", "franchise_name", "current_year",
        "owner_first_season", "owner_seasons_count", "owner_franchises_owned",
        "owner_seasons_by_franchise", "owner_championships",
        "owner_playoff_appearances", "owner_best_finish", "owner_worst_finish",
        "owner_allplay_w", "owner_allplay_l", "owner_allplay_pct",
        "owner_overall_w", "owner_overall_l", "owner_last_championship",
        "franchise_seasons_played", "franchise_championships",
        "franchise_last_championship", "franchise_championship_drought",
    ]
    sql_parts = []
    for r in rows:
        values = ", ".join(_sql_quote(r.get(c)) for c in cols)
        update_clause = ", ".join(
            f"{c} = excluded.{c}" for c in cols if c != "franchise_id"
        )
        sql_parts.append(
            f"INSERT INTO ups_owner_career_stats ({', '.join(cols)}) "
            f"VALUES ({values}) "
            f"ON CONFLICT(franchise_id) DO UPDATE SET "
            f"{update_clause}, updated_at = datetime('now');"
        )
    sql_text = "\n".join(sql_parts) + "\n"
    d1_execute_file(sql_text)
    print(f"  D1 sync: {len(rows)} rows UPSERTed into ups_owner_career_stats")


def load_owners() -> dict:
    """Map franchise_id → current owner_name + team_name from D1."""
    out = {}
    for r in d1_query("SELECT franchise_id, team_name, owner_name FROM discord_owners WHERE active_owner='Y';"):
        fid = str(r["franchise_id"]).zfill(4)
        out[fid] = {"owner_name": r.get("owner_name") or "", "team_name": r.get("team_name") or ""}
    return out


def load_final_standings() -> list[dict]:
    return d1_query(
        f"SELECT season, franchise_id, final_finish, regular_season_finish "
        f"FROM src_final_standings WHERE season >= {UPS_FOUNDING_SEASON} "
        f"ORDER BY season, franchise_id;"
    )


def load_weekly_summary() -> list[dict]:
    return d1_query(
        f"SELECT season, week, franchise_id, owner_name, "
        f"       h2h_wins, h2h_losses, h2h_ties, h2h_games, "
        f"       allplay_wins, allplay_losses, h2h_team_score "
        f"FROM src_weekly_franchise_summary WHERE season >= {UPS_FOUNDING_SEASON};"
    )


def build_stats(owners: dict, standings: list[dict], weekly: list[dict],
                mfl_ownership: dict, overrides: dict = None) -> dict:
    """Build the career stats dict keyed by current franchise_id.

    Owner-tenure attribution rule (Keith 2026-05-22/05-23):
      "Once you start you're locked in." Whoever owns the franchise at
      SEASON START gets credited with the FULL season's stats — regardless
      of any mid-season takeover. A mid-season takeover does NOT begin the
      incoming owner's career tenure; their tenure starts at the NEXT
      season they own at week 1.

      Example: The Long Haulers 2024 = 3 weeks Lima → 14 weeks Cross.
        Season-start owner = Lima → Lima gets all 2024 stats.
        Cross's career starts 2025 (his first full season from week 1).

    Cross-franchise rule (Keith 2026-05-23):
      "Keith started in 2010 as 0007." Owners can span multiple franchises
      across their career (Keith on 0007/2010 → 0008/2011-2026). The owner
      block aggregates stats across EVERY (fid, season) where MFL truth +
      overrides attribute that owner.

    Data source:
      MFL public export per year (worker /api/franchise-ownership-history)
      provides END-OF-SEASON owner_name. Overrides reassign mid-season-
      takeover seasons to the prior MFL owner (the season-start owner).
    """
    overrides = overrides or {}

    # Per-(fid, season) raw stats — always franchise-scoped
    season_totals = defaultdict(lambda: defaultdict(lambda: {
        "h2h_w": 0, "h2h_l": 0, "h2h_t": 0, "h2h_g": 0,
        "ap_w": 0, "ap_l": 0, "pts_for": 0.0, "weeks": 0,
    }))
    # Distinct owners ever seen during a season (from D1 weekly) — heuristic
    # signal for transition_seasons; D1 owner_name is unreliable (ETL stamps
    # current owner backward), but multi-distinct-name still flags transitions.
    season_owners_seen = defaultdict(lambda: defaultdict(set))

    for w in weekly:
        fid = str(w["franchise_id"]).zfill(4)
        season = int(w["season"])
        s = season_totals[fid][season]
        s["h2h_w"] += int(w.get("h2h_wins") or 0)
        s["h2h_l"] += int(w.get("h2h_losses") or 0)
        s["h2h_t"] += int(w.get("h2h_ties") or 0)
        s["h2h_g"] += int(w.get("h2h_games") or 0)
        s["ap_w"] += int(w.get("allplay_wins") or 0)
        s["ap_l"] += int(w.get("allplay_losses") or 0)
        s["pts_for"] += float(w.get("h2h_team_score") or 0)
        s["weeks"] += 1
        owner_nm = (w.get("owner_name") or "").strip()
        if owner_nm:
            season_owners_seen[fid][season].add(owner_nm)

    # Resolve effective owner per (fid, season) — MFL truth + override reassignment
    effective_owner, override_meta_by_fid = build_effective_ownership(
        mfl_ownership, overrides
    )

    # Index final standings
    finish_by_fs = {}  # (fid, season) → final_finish
    played_seasons = set()  # seasons that have been COMPLETED (have final_finish)
    for r in standings:
        fid = str(r["franchise_id"]).zfill(4)
        season = int(r["season"])
        finish = int(r["final_finish"]) if r.get("final_finish") else None
        finish_by_fs[(fid, season)] = finish
        if finish is not None:
            played_seasons.add(season)
    # Keith 2026-05-23: don't count the upcoming/in-progress season toward
    # owner career — Real Deal Creel showing "17 seasons, 0 chips" when
    # season 17 hasn't even started is misleading. `played_seasons` is the
    # set of completed seasons (any franchise has a final_finish). Owner
    # career attribution filters to seasons in this set.

    # Build per-franchise career stats
    out = {}
    all_fids = sorted(
        set(list(owners.keys()) + list(season_totals.keys()))
        | {fid for (fid, _) in effective_owner.keys()}
    )
    for fid in all_fids:
        owner_info = owners.get(fid, {})
        seasons_with_data = sorted(season_totals.get(fid, {}).keys())
        # Determine the current owner: take from discord_owners (canonical)
        current_owner = owner_info.get("owner_name", "") or (
            effective_owner.get((fid, seasons_with_data[-1])) if seasons_with_data else ""
        ) or ""

        # ── OWNER CAREER (cross-franchise, completed seasons only) ────────
        # Walk every (fid', season) in effective_owner where the season-start
        # owner matches current_owner AND the season has actually been played
        # (Keith 2026-05-23: don't credit 17 seasons when season 17 hasn't
        # started). played_seasons = seasons with final_finish data.
        owner_seasons_pairs = []  # list of (fid', season)
        if current_owner:
            for (fid2, season), nm in effective_owner.items():
                if season not in played_seasons:
                    continue
                if _owners_match(nm, current_owner):
                    owner_seasons_pairs.append((fid2, season))
        owner_seasons_pairs.sort(key=lambda p: (p[1], p[0]))
        owner_seasons = sorted({s for (_, s) in owner_seasons_pairs})
        owner_franchises = sorted({f for (f, _) in owner_seasons_pairs})

        # Transition seasons (informational): D1 saw multiple distinct
        # owner names during this franchise-season. Used downstream for
        # trade-counter exclusion windows; doesn't affect stat attribution.
        transition_seasons = [
            season for season in seasons_with_data
            if len(season_owners_seen[fid].get(season, set())) >= 2
        ]

        # Override meta — surface the entries that apply to this fid
        # (may include overrides for owners who held the franchise but
        # aren't the current owner — useful audit trail).
        override_info = {}
        meta_list = override_meta_by_fid.get(fid, [])
        for m in meta_list:
            if _owners_match(m["owner_name"], current_owner):
                override_info = {
                    "applied": True,
                    "tenure_start_season": m["tenure_start_season"],
                    "tenure_end_season": m["tenure_end_season"],
                    "notes": m["notes"],
                }
                break

        # Owner-tenure aggregates — pulled from each (fid', season) tile
        owner_h2h_w = sum(season_totals[f][s]["h2h_w"] for (f, s) in owner_seasons_pairs)
        owner_h2h_l = sum(season_totals[f][s]["h2h_l"] for (f, s) in owner_seasons_pairs)
        owner_ap_w = sum(season_totals[f][s]["ap_w"] for (f, s) in owner_seasons_pairs)
        owner_ap_l = sum(season_totals[f][s]["ap_l"] for (f, s) in owner_seasons_pairs)
        owner_first = min(owner_seasons) if owner_seasons else None
        owner_finishes = [finish_by_fs.get((f, s)) for (f, s) in owner_seasons_pairs if finish_by_fs.get((f, s)) is not None]
        owner_chips = sum(1 for f in owner_finishes if f == 1)
        owner_playoffs = sum(1 for f in owner_finishes if f and f <= 6)  # top-6 = playoffs assumption
        owner_best = min(owner_finishes) if owner_finishes else None
        owner_worst = max(owner_finishes) if owner_finishes else None
        # OWNER's last championship — distinct from franchise.last_championship.
        # Keith's franchise 0008 has last_championship=2010 (Roussin's ring), but
        # owner_last_championship=None (Keith has zero rings). Worker clap-back
        # context MUST use owner_last_championship to avoid crediting Keith with
        # Roussin's 2010 chip (Keith 2026-05-23 callout).
        owner_chip_seasons = sorted(
            s for (f, s) in owner_seasons_pairs if finish_by_fs.get((f, s)) == 1
        )
        owner_last_chip = owner_chip_seasons[-1] if owner_chip_seasons else None

        # Franchise-wide aggregates — COMPLETED seasons only (Keith 2026-05-23:
        # don't count the upcoming/in-progress season toward seasons_played).
        all_seasons = [s for s in seasons_with_data if s in played_seasons]
        franchise_finishes = [finish_by_fs.get((fid, s)) for s in all_seasons if finish_by_fs.get((fid, s)) is not None]
        franchise_chips = sum(1 for f in franchise_finishes if f == 1)
        last_chip_season = None
        if franchise_chips:
            chip_seasons = [s for s in all_seasons if finish_by_fs.get((fid, s)) == 1]
            last_chip_season = max(chip_seasons) if chip_seasons else None
        # current_year_upcoming = last-completed-season + 1 (the offseason
        # we're currently in). For 2025 completed in 2026 offseason → 2026.
        # Drought = upcoming - last_chip_season. Hammer won 2024, upcoming
        # = 2026 → drought = 2 (Keith 2026-05-22 ruling).
        current_year_upcoming = (max(played_seasons) + 1) if played_seasons else None
        franchise_ap_w = sum(season_totals[fid][s]["ap_w"] for s in all_seasons)
        franchise_ap_l = sum(season_totals[fid][s]["ap_l"] for s in all_seasons)
        franchise_ap_pct = (franchise_ap_w / (franchise_ap_w + franchise_ap_l)) if (franchise_ap_w + franchise_ap_l) else 0
        owner_ap_pct = (owner_ap_w / (owner_ap_w + owner_ap_l)) if (owner_ap_w + owner_ap_l) else 0

        # Trend: last 4 COMPLETED seasons' allplay% + final finish
        trend = []
        for s in all_seasons[-4:]:
            sw = season_totals[fid][s]
            ap_pct = (sw["ap_w"] / (sw["ap_w"] + sw["ap_l"])) if (sw["ap_w"] + sw["ap_l"]) else 0
            trend.append({
                "season": s,
                "allplay_pct": round(ap_pct, 3),
                "finish": finish_by_fs.get((fid, s)),
            })

        # Best/worst season (by allplay %) — COMPLETED seasons only
        season_aps = [
            (s, (season_totals[fid][s]["ap_w"] / (season_totals[fid][s]["ap_w"] + season_totals[fid][s]["ap_l"]))
                if (season_totals[fid][s]["ap_w"] + season_totals[fid][s]["ap_l"]) else 0)
            for s in all_seasons
        ]
        best_season = max(season_aps, key=lambda x: x[1])[0] if season_aps else None
        worst_season = min(season_aps, key=lambda x: x[1])[0] if season_aps else None

        out[fid] = {
            "franchise_name": owner_info.get("team_name", ""),
            "current_year": current_year_upcoming,  # the upcoming season we're in offseason for
            "seasons_played": len(all_seasons),
            "championships": franchise_chips,
            "last_championship": last_chip_season,
            # Drought = current_year (upcoming) - last_chip_season. For 2024 chip
            # in 2026 offseason → drought = 2.
            "championship_drought": (current_year_upcoming - last_chip_season) if (current_year_upcoming and last_chip_season) else (current_year_upcoming - min(all_seasons) + 1 if all_seasons and current_year_upcoming else 0),
            "career_allplay_pct": round(franchise_ap_pct, 3),
            "best_season": best_season,
            "worst_season": worst_season,
            "trend": trend,
            # Transition seasons (multi-owner mid-year takeovers) — excluded
            # from owner-tenure stats. Surfaced so the trade-counter logic
            # can build trade_exclusions windows from these, and so the
            # roast prompt can avoid attributing inherited rosters.
            "transition_seasons": transition_seasons,
            "tenure_override": override_info,
            "owner": {
                "display": current_owner,
                "first_season": owner_first,
                "seasons_count": len(owner_seasons),
                # Cross-franchise: owner career spans EVERY franchise they've
                # been season-start owner of (e.g. Keith = 0007/2010 + 0008/
                # 2011-2026). franchises_owned lists those fids in order.
                "franchises_owned": owner_franchises,
                "seasons_by_franchise": {
                    f: sorted(s for (ff, s) in owner_seasons_pairs if ff == f)
                    for f in owner_franchises
                },
                "allplay": {"w": owner_ap_w, "l": owner_ap_l},
                "allplay_pct": round(owner_ap_pct, 3),
                "overall": {"w": owner_h2h_w, "l": owner_h2h_l},
                "championships": owner_chips,
                "last_championship": owner_last_chip,
                "playoff_appearances": owner_playoffs,
                "best_finish": owner_best,
                "worst_finish": owner_worst,
            },
            "h2h": {},  # filled below
        }

    # Build h2h between franchises (current owner ↔ current owner, lifetime)
    h2h_pair = defaultdict(lambda: {"w": 0, "l": 0, "games": 0})
    for w in weekly:
        fid = str(w["franchise_id"]).zfill(4)
        my_score = float(w.get("h2h_team_score") or 0)
        for opp_idx in (1, 2, 3):
            opp_id = w.get(f"h2h_opponent{opp_idx}_id")
            opp_score = w.get(f"h2h_opponent{opp_idx}_score")
            if opp_id is None or opp_score is None:
                continue
            opp_fid = str(opp_id).zfill(4)
            if opp_fid == fid:
                continue
            opp_score = float(opp_score)
            h2h_pair[(fid, opp_fid)]["games"] += 1
            if my_score > opp_score:
                h2h_pair[(fid, opp_fid)]["w"] += 1
            elif my_score < opp_score:
                h2h_pair[(fid, opp_fid)]["l"] += 1
    for (fid, opp_fid), record in h2h_pair.items():
        if fid in out:
            out[fid]["h2h"][opp_fid] = record

    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print("Querying D1...")
    owners = load_owners()
    print(f"  owners: {len(owners)}")
    standings = load_final_standings()
    print(f"  final standings rows: {len(standings)}")
    weekly = load_weekly_summary()
    print(f"  weekly summary rows: {len(weekly)}")
    overrides = load_tenure_overrides()
    print(f"  tenure overrides: {len(overrides)} franchise(s)")
    print("Fetching MFL ownership history from worker...")
    mfl_ownership = fetch_mfl_ownership()
    print(f"  MFL ownership: {len(mfl_ownership)} season(s), "
          f"{sum(len(v) for v in mfl_ownership.values())} (season, fid) cells")

    print("Building career stats...")
    stats = build_stats(owners, standings, weekly, mfl_ownership, overrides=overrides)

    # Quick sanity sample — Keith's cross-franchise career (0007/2010 → 0008+),
    # Brian Cross's 2025-start override on 0006, Hammer's 2024 chip drought.
    sample_fids = ["0006", "0007", "0008", "0005"]
    print("\nSample:")
    for fid in sample_fids:
        s = stats.get(fid, {})
        o = s.get("owner", {})
        print(f"  {fid} {s.get('franchise_name','')}: owner={o.get('display','')} "
              f"first_season={o.get('first_season')} "
              f"seasons={o.get('seasons_count',0)} "
              f"franchises={o.get('franchises_owned',[])} "
              f"allplay={o.get('allplay',{}).get('w',0)}-{o.get('allplay',{}).get('l',0)} "
              f"chips={o.get('championships',0)}")

    if args.dry_run:
        print("\nDRY RUN — not writing")
        return

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    # atomic write
    tmp = OUT_PATH.with_suffix(".json.tmp")
    with open(tmp, "w") as f:
        json.dump(stats, f, indent=2)
    tmp.replace(OUT_PATH)
    print(f"\nWrote {OUT_PATH} — {len(stats)} franchises")

    # Mirror to D1 so the Cloudflare worker can read owner-attribution stats
    # at request time (trade-roast Reply-button clap-back grounding). Without
    # this, worker falls back to franchise-keyed src_final_standings and
    # mis-credits cross-franchise owners (Keith on 0007/2010 + 0008/2011-2025).
    print("Syncing to D1 (ups_owner_career_stats)...")
    sync_to_d1(stats)


if __name__ == "__main__":
    main()
