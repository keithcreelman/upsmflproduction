"""fetch_external_adp.py — Pull rookie rankings from multiple free sources.

Sources (no API keys required, all public):
  - FantasyCalc       (api.fantasycalc.com — community trade values, includes mflId)
  - KeepTradeCut      (keeptradecut.com — scrape playersArray JSON from rankings page)
  - DynastyProcess    (raw.githubusercontent.com/dynastyprocess/data — weekly CSV)

Output: site/rookies/external_adp_2026.json
  {
    "meta": {
      "generated_at_utc": "...",
      "sources": [{"id": "...", "label": "...", "as_of": "...", "n": 123}, ...]
    },
    "by_mfl_id": {
      "17472": {
        "fantasycalc_sf_value": 7842,
        "fantasycalc_sf_overall_rank": 38,
        "fantasycalc_sf_rookie_rank": 4,
        "ktc_sf_value": 7900,
        "ktc_sf_rookie_rank": 5,
        "dp_sf_ecr": 12.4,
        "dp_sf_value": 7651
      },
      ...
    },
    "by_name": { ... }   # for entries we can't resolve to an MFL id
  }

The downstream consumer (build_prospects in build_rookie_draft_hub.py) merges
this into rookie_prospects_2026.json so the hub can show a multi-source
consensus rank alongside the per-source raw values.
"""

from __future__ import annotations
import csv
import io
import json
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

UA = "upsmflproduction/1.0 (rookie-draft-hub adp aggregator)"
TIMEOUT = 20
CURRENT_YEAR = 2026

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
OUT_FILE = REPO_ROOT / "site" / "rookies" / "external_adp_2026.json"


def _http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def _nkey(name: str) -> str:
    """Loose name key for cross-source matching when MFL id isn't available."""
    return re.sub(r"[^a-z]", "", (name or "").lower())


# ── FantasyCalc ──────────────────────────────────────────────────────────────
def fetch_fantasycalc() -> tuple[dict, dict]:
    """Returns (by_mfl_id, by_name). SuperFlex (numQbs=2) trade values."""
    url = (
        "https://api.fantasycalc.com/values/current"
        "?isDynasty=true&numQbs=2&numTeams=12&ppr=1"
    )
    rows = json.loads(_http_get(url))
    rookies = [r for r in rows if (r.get("player") or {}).get("maybeYoe") == 0]
    # Re-rank rookies among themselves
    rookies.sort(key=lambda r: r.get("overallRank") or 999_999)
    by_mfl: dict = {}
    by_name: dict = {}
    for i, r in enumerate(rookies, start=1):
        p = r.get("player") or {}
        mfl_id = str(p.get("mflId") or "").strip()
        # FantasyCalc returns "UNK" (literal) for unmapped MFL ids — treat as
        # missing so the entry falls through to name-key matching.
        if mfl_id.upper() == "UNK":
            mfl_id = ""
        rec = {
            "fantasycalc_sf_value": r.get("value"),
            "fantasycalc_sf_overall_rank": r.get("overallRank"),
            "fantasycalc_sf_rookie_rank": i,
            "fantasycalc_sf_pos_rank": r.get("positionRank"),
            "fantasycalc_sf_trend30": r.get("trend30Day"),
        }
        if mfl_id:
            by_mfl[mfl_id] = rec
        else:
            by_name[_nkey(p.get("name", ""))] = rec
    return by_mfl, by_name, len(rookies)


# ── KeepTradeCut ─────────────────────────────────────────────────────────────
def fetch_ktc() -> tuple[dict, dict]:
    """Scrape KTC's dynasty rankings page; filter to rookies, SuperFlex values.

    KTC embeds the full player list in a JS variable on the rankings page:
      playersArray = [{...}, {...}, ...]
    We pull the page once, regex out the array, parse, filter rookie:true.
    """
    url = "https://keeptradecut.com/dynasty-rankings"
    html = _http_get(url).decode("utf-8", errors="ignore")
    # Find the playersArray definition. It's a long JSON literal — match
    # greedily from `[` to the matching `];` followed by linebreak.
    m = re.search(r"playersArray\s*=\s*(\[.+?\])\s*;", html, re.DOTALL)
    if not m:
        return {}, {}, 0
    try:
        arr = json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}, {}, 0
    rookies = [p for p in arr if p.get("rookie")]
    # Sort by superflexValues.value descending — primary KTC SF rookie order
    def _sfv(p):
        return ((p.get("superflexValues") or {}).get("value")
                or (p.get("oneQBValues") or {}).get("value") or 0)
    rookies.sort(key=lambda p: _sfv(p), reverse=True)
    by_mfl: dict = {}
    by_name: dict = {}
    for i, p in enumerate(rookies, start=1):
        sfv = (p.get("superflexValues") or {})
        rec = {
            "ktc_sf_value": sfv.get("value"),
            "ktc_sf_overall_rank": sfv.get("overallRank") or sfv.get("overallTrend"),
            "ktc_sf_rookie_rank": i,
            "ktc_sf_pos_rank": sfv.get("positionalRank"),
            "ktc_oneqb_value": (p.get("oneQBValues") or {}).get("value"),
        }
        # KTC doesn't expose mflId — match by name + team via build script.
        by_name[_nkey(p.get("playerName", ""))] = rec
    return by_mfl, by_name, len(rookies)


# ── FantasyPros Dynasty Rookie SF rankings (public page, embedded JSON) ─────
def fetch_fantasypros() -> tuple[dict, dict, int]:
    """Scrape https://www.fantasypros.com/nfl/rankings/dynasty-rookies-superflex.php
    — public page with full SF expert-consensus rookie rankings embedded as
    `ecrData = {...}` JS variable. Far cleaner than table-row HTML scraping.

    SF normalization: this is the ONLY FP feed that ranks rookies for
    SuperFlex (the /adp/rookies.php page is 1QB and ignores ?2qb=1). QBs
    rank dramatically higher here — Mendoza is #2 SF vs #9 in 1QB.

    Returns (by_mfl_id (always empty), by_name, n_rookies).
    """
    url = "https://www.fantasypros.com/nfl/rankings/dynasty-rookies-superflex.php"
    html = _http_get(url).decode("utf-8", errors="ignore")
    m = re.search(r'ecrData\s*=\s*(\{.+?\});', html, re.DOTALL)
    if not m:
        return {}, {}, 0
    try:
        data = json.loads(m.group(1))
    except json.JSONDecodeError:
        return {}, {}, 0
    players = data.get("players") or []
    by_mfl: dict = {}  # FP doesn't expose MFL ID
    by_name: dict = {}
    for i, p in enumerate(sorted(players, key=lambda x: x.get("rank_ecr") or 1e9), start=1):
        name = p.get("player_name", "").strip()
        if not name: continue
        rec = {
            "fantasypros_sf_rookie_rank": i,
            "fantasypros_sf_rank_ecr":    p.get("rank_ecr"),
            "fantasypros_sf_rank_min":    p.get("rank_min"),
            "fantasypros_sf_rank_max":    p.get("rank_max"),
            "fantasypros_sf_rank_ave":    p.get("rank_ave"),
            "fantasypros_sf_tier":        p.get("tier"),
            "fantasypros_id":             p.get("player_id"),
        }
        by_name[_nkey(name)] = rec
    return by_mfl, by_name, len(players)


# ── Sleeper ──────────────────────────────────────────────────────────────────
def fetch_sleeper() -> tuple[dict, dict, dict, int]:
    """Sleeper publishes a free /v1/players/nfl endpoint with every NFL player
    + their search_rank (overall fantasy rank). We filter to rookies (years_exp
    == 0), sort by search_rank, and re-rank among themselves to get a
    rookie-only rank.

    Returns (by_rotowire_id, by_mfl_id, by_name, n_rookies). The rotowire_id
    join is rock-solid since both Sleeper and MFL DETAILS=1 expose it.
    """
    url = "https://api.sleeper.app/v1/players/nfl"
    data = json.loads(_http_get(url))
    rookies = []
    for sleeper_id, p in data.items():
        if not isinstance(p, dict): continue
        if p.get("years_exp") != 0: continue
        if not p.get("position"): continue
        # Sleeper's search_rank is the overall fantasy rank — lower is better.
        # Players without a meaningful rank get a sentinel (9999999) — drop them.
        sr = p.get("search_rank")
        if sr is None or sr >= 9999: continue
        rookies.append({
            "sleeper_id": sleeper_id,
            "name": f"{p.get('first_name','').strip()} {p.get('last_name','').strip()}".strip(),
            "rotowire_id": p.get("rotowire_id"),
            "espn_id": p.get("espn_id"),
            "search_rank": sr,
            "position": (p.get("position") or "").upper(),
            "team": p.get("team"),
        })
    rookies.sort(key=lambda r: r["search_rank"])
    by_rotowire: dict = {}
    by_mfl: dict = {}  # always empty — Sleeper doesn't expose MFL ID
    by_name: dict = {}
    for i, r in enumerate(rookies, start=1):
        rec = {
            "sleeper_sf_rookie_rank": i,
            "sleeper_overall_rank": r["search_rank"],
            "sleeper_id": r["sleeper_id"],
        }
        rwid = str(r.get("rotowire_id") or "").strip()
        if rwid and rwid != "None":
            by_rotowire[rwid] = rec
        else:
            by_name[_nkey(r["name"])] = rec
    return by_rotowire, by_mfl, by_name, len(rookies)


# ── DynastyProcess ───────────────────────────────────────────────────────────
def fetch_dynasty_process() -> tuple[dict, dict, str]:
    """DynastyProcess publishes a weekly CSV blending multiple expert sources.

    Columns: player, pos, team, age, draft_year, ecr_1qb, ecr_2qb, ecr_pos,
             value_1qb, value_2qb, scrape_date, fp_id

    ROOKIE IDENTIFICATION — do NOT filter on draft_year == CURRENT_YEAR.
    `draft_year` in this file is the year the player HAS ALREADY been drafted in.
    The INCOMING class has not been drafted yet, so DynastyProcess parks it in an
    "NA" bucket with an "NA" age — there are ZERO rows with the current year in
    them, ever. The old `draft_year == "2026"` filter therefore matched nothing and
    this function had been silently returning an empty dict (verified live
    2026-07-21: 643 rows, draft_year values {NA: 251, 2025: 75, 2024: 63, ...},
    and every one of the 251 NA rows is a 2026 prospect — Jeremiyah Love, Carnell
    Tate, Jordyn Tyson, Fernando Mendoza, ...). `age == NA` is the discriminator
    that separates "undrafted incoming class" from any other NA case: all 251 NA
    rows have NA age, and zero non-NA-draft_year rows do.
    """
    url = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv"
    raw = _http_get(url).decode("utf-8", errors="ignore")
    reader = csv.DictReader(io.StringIO(raw))
    by_mfl: dict = {}
    by_name: dict = {}

    def _blank(v) -> bool:
        return str(v or "").strip().upper() in ("", "NA", "NULL", "NONE")

    def _is_incoming_rookie(r: dict) -> bool:
        dy = str(r.get("draft_year") or "").strip()
        if dy == str(CURRENT_YEAR):
            return True                       # if DP ever starts stamping the year
        return _blank(dy) and _blank(r.get("age"))

    rows = list(reader)
    rookies = [r for r in rows if _is_incoming_rookie(r)]
    if not rookies:
        print(f"  ! DynastyProcess: no incoming-rookie rows matched out of {len(rows)} "
              f"(draft_year buckets: {sorted({str(r.get('draft_year') or '').strip() for r in rows})}) "
              f"— the rookie discriminator needs re-checking against the live CSV")
    # Every numeric column can hold the literal string "NA" (that is how DP encodes
    # a missing value from R) — coerce through _f, never float() directly, or the
    # incoming class blows up on its own NA ages.
    def _f(v):
        return None if _blank(v) else float(v)

    rookies.sort(key=lambda r: (_f(r.get("ecr_2qb")) or 999))
    scrape_date = (rookies[0].get("scrape_date") if rookies else "")
    for i, r in enumerate(rookies, start=1):
        v2 = _f(r.get("value_2qb"))
        rec = {
            "dp_sf_ecr": _f(r.get("ecr_2qb")),
            "dp_sf_value": int(v2) if v2 is not None else None,
            "dp_oneqb_ecr": _f(r.get("ecr_1qb")),
            "dp_pos_ecr": _f(r.get("ecr_pos")),
            "dp_sf_rookie_rank": i,
            "dp_age": _f(r.get("age")),
        }
        # DynastyProcess uses fp_id (FantasyPros), no MFL id. Match by name.
        by_name[_nkey(r.get("player", ""))] = rec
    return by_mfl, by_name, len(rookies), scrape_date


# ── Main ─────────────────────────────────────────────────────────────────────
def main() -> int:
    print(f"Fetching external rookie ADP sources → {OUT_FILE}")
    sources_meta = []
    merged_by_mfl: dict = {}
    merged_by_name: dict = {}

    def _merge(target, key, rec):
        if key not in target:
            target[key] = {}
        target[key].update(rec)

    # FantasyCalc
    try:
        fc_mfl, fc_name, n = fetch_fantasycalc()
        for k, v in fc_mfl.items(): _merge(merged_by_mfl, k, v)
        for k, v in fc_name.items(): _merge(merged_by_name, k, v)
        sources_meta.append({"id": "fantasycalc", "label": "FantasyCalc SF", "n_rookies": n,
                             "as_of": datetime.now(timezone.utc).isoformat()})
        print(f"  FantasyCalc: {n} rookies (mflId hits: {len(fc_mfl)})")
    except Exception as e:
        print(f"  FantasyCalc FAILED: {e}", file=sys.stderr)

    # FantasyPros
    try:
        fp_mfl, fp_name, n = fetch_fantasypros()
        for k, v in fp_mfl.items(): _merge(merged_by_mfl, k, v)
        for k, v in fp_name.items(): _merge(merged_by_name, k, v)
        sources_meta.append({"id": "fantasypros", "label": "FantasyPros Rookie ADP",
                             "n_rookies": n,
                             "as_of": datetime.now(timezone.utc).isoformat()})
        print(f"  FantasyPros: {n} rookies")
    except Exception as e:
        print(f"  FantasyPros FAILED: {e}", file=sys.stderr)

    # KeepTradeCut
    try:
        kt_mfl, kt_name, n = fetch_ktc()
        for k, v in kt_mfl.items(): _merge(merged_by_mfl, k, v)
        for k, v in kt_name.items(): _merge(merged_by_name, k, v)
        sources_meta.append({"id": "ktc", "label": "KeepTradeCut SF", "n_rookies": n,
                             "as_of": datetime.now(timezone.utc).isoformat()})
        print(f"  KeepTradeCut: {n} rookies")
    except Exception as e:
        print(f"  KeepTradeCut FAILED: {e}", file=sys.stderr)

    # DynastyProcess
    try:
        dp_mfl, dp_name, n, scrape_date = fetch_dynasty_process()
        for k, v in dp_mfl.items(): _merge(merged_by_mfl, k, v)
        for k, v in dp_name.items(): _merge(merged_by_name, k, v)
        sources_meta.append({"id": "dynastyprocess", "label": "DynastyProcess SF",
                             "n_rookies": n, "as_of": scrape_date})
        print(f"  DynastyProcess: {n} rookies (scraped {scrape_date})")
    except Exception as e:
        print(f"  DynastyProcess FAILED: {e}", file=sys.stderr)

    # Sleeper
    merged_by_rotowire: dict = {}
    try:
        sl_rwid, sl_mfl, sl_name, n = fetch_sleeper()
        for k, v in sl_rwid.items(): _merge(merged_by_rotowire, k, v)
        for k, v in sl_mfl.items(): _merge(merged_by_mfl, k, v)
        for k, v in sl_name.items(): _merge(merged_by_name, k, v)
        sources_meta.append({"id": "sleeper", "label": "Sleeper SF",
                             "n_rookies": n,
                             "as_of": datetime.now(timezone.utc).isoformat()})
        print(f"  Sleeper: {n} rookies (rotowire_id hits: {len(sl_rwid)})")
    except Exception as e:
        print(f"  Sleeper FAILED: {e}", file=sys.stderr)

    out = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "sources": sources_meta,
        },
        "by_mfl_id": merged_by_mfl,
        "by_name": merged_by_name,
        "by_rotowire_id": merged_by_rotowire,
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2))
    total = len(merged_by_mfl) + len(merged_by_name)
    print(f"Wrote {total} entries ({len(merged_by_mfl)} by mfl_id, {len(merged_by_name)} by name)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
