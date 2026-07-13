#!/usr/bin/env python3
"""Build the commish-only Draft Intel blob for the July/Aug FA Auction.

Produces the `ups_draft_intel` payload (see the blob contract in the War Room
plan): the FA-auction POOL annotated with market-vs-value divergence, LRDG
trait screens (2025 season only — the 2026 season has NOT started), price
bands fit from the 2020-25 FA-auction archive, environment scores, and
contract-length recommendations.

COMMISH-ONLY: output goes to pipelines/etl/data/out/ (gitignored) and, with
--push-d1, to the part-keyed D1 table ups_draft_intel served behind the
commish gate. Nothing here lands in public workbench columns.

Sources (all read-only):
  - /api/auction/fa-value?franchise_id=0008   worth + expected price (REUSED, not rebuilt)
  - /api/adp-board (raw names/teams/values) + trade_grader.fetch_adp_board()
    (the SITE's exact consensus math — never raw endpoint rank fields)
  - trade_grader.fetch_weighted_ppg()          prior-3-season weighted MFL PPG
  - D1 (remote, via wrangler): nfl_player_routes / nfl_player_redzone /
    nfl_player_weekly (QB career TD-rate) / nfl_team_pace / ff_player_ids
  - nflverse stats_player_reg_2025.csv         first downs, 10+ runs, box stats
  - /api/vegas                                 implied team totals (upcoming season)
  - transactions_auction (in-repo archive)     winning-bid price curves 2020-25

Usage:
  python3 pipelines/etl/scripts/build_draft_intel.py
  python3 pipelines/etl/scripts/build_draft_intel.py --fa-json /path/to/fa_value.json
  python3 pipelines/etl/scripts/build_draft_intel.py --fresh          # bypass caches
  python3 pipelines/etl/scripts/build_draft_intel.py --push-d1        # part-keyed D1 push
"""
from __future__ import annotations
import argparse
import csv
import gzip
import hashlib
import io
import json
import math
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parent
REPO = Path(__file__).resolve().parents[3]
OUT_DIR = REPO / "pipelines" / "etl" / "data" / "out"
WORKER_DIR = REPO / "worker"
ARCHIVE_GZ = REPO / "data" / "db-archives" / "mfl_database_2026-06-05.db.gz"
CACHE_DIR = Path(tempfile.gettempdir()) / "ups_draft_intel_cache"
CACHE_TTL_S = 6 * 3600

sys.path.insert(0, str(SCRIPTS))
from trade_grader import fetch_adp_board, fetch_weighted_ppg  # noqa: E402  (site-exact math)

SEASON = 2026          # the auction/draft season this intel is FOR
STAT_SEASON = 2025     # screens read LAST season only (standing rule: never current-season pre-kickoff)
POOL_POS = ("QB", "RB", "WR", "TE")

# Contract constants (calibrated in the trade-timing Phase 2 doc)
REPLACEMENT_PPG = {"QB": 16.5, "RB": 11.4, "WR": 13.4, "TE": 11.1, "PK": 9.1,
                   "PN": 7.7, "DL": 7.6, "LB": 8.0, "DB": 9.0}
DOLLAR_PER_PAR = 1216

ABSTAIN_POSRANK = {"RB": 60, "WR": 60, "QB": 40, "TE": 30}   # beyond → $1K-dart abstention
MS_K = {"RB": 6, "WR": 6, "QB": 4, "TE": 4}
STUD_P50_UPLIFT = 1.10   # 2026: first SF-era auction with legit studs in the pool
STUD_P90_MULT = 1.30     # — stud bands lifted above the stud-less historical curve
RD_PCT = 0.35          # site blend: 65% dynasty / 35% redraft (mirror of fetch_adp_board)

NFLVERSE_CSV = ("https://github.com/nflverse/nflverse-data/releases/download/"
                f"stats_player/stats_player_reg_{STAT_SEASON}.csv")

# nickname / rebrand aliases (normalized-name → normalized-name)
ALIASES = {
    "hollywood brown": "marquise brown",
    "chig okonkwo": "chigoziem okonkwo",
    "tank dell": "nathaniel dell",
    "gabe davis": "gabriel davis",
    "josh palmer": "joshua palmer",
    "cam ward": "cameron ward",
    "tank bigsby": "tank bigsby",
}

# normalize every team code to the nflverse-PBP space (pace/vegas join keys).
TEAM_FIX = {"LAR": "LA", "JAC": "JAX", "OAK": "LV", "LVR": "LV", "NOS": "NO",
            "GBP": "GB", "KCC": "KC", "SFO": "SF", "TBB": "TB", "NEP": "NE",
            "WSH": "WAS", "HST": "HOU", "BLT": "BAL", "CLV": "CLE",
            "ARZ": "ARI", "SDC": "LAC", "SD": "LAC", "STL": "LA"}

_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def worker_base() -> str:
    return os.environ.get("UPS_WORKER_BASE",
                          "https://upsmflproduction.keith-creelman.workers.dev").rstrip("/")


def norm_name(n: str) -> str:
    s = (n or "").strip().lower()
    if "," in s:                      # MFL "Last, First" style
        last, first = [p.strip() for p in s.split(",", 1)]
        s = f"{first} {last}"
    s = s.replace(".", "").replace("'", "").replace("’", "")
    toks = [t for t in s.split() if t not in _SUFFIXES]
    s = " ".join(toks)
    return ALIASES.get(s, s)


def team_norm(t) -> str | None:
    s = str(t or "").strip().upper()
    if not s or s in ("FA", "FA*", "NONE", "NULL"):
        return None
    return TEAM_FIX.get(s, s)


def fnum(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def pctile(vals: list, p: float):
    """Linear-interpolated percentile (p in 0-100)."""
    if not vals:
        return None
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    k = (p / 100.0) * (len(s) - 1)
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# ---------------------------------------------------------------- caching I/O

def _cache_file(kind: str, key: str) -> Path:
    h = hashlib.md5(key.encode()).hexdigest()[:16]
    return CACHE_DIR / f"{kind}_{h}"


def _cache_get(kind: str, key: str, fresh: bool):
    f = _cache_file(kind, key)
    if fresh or not f.exists():
        return None
    if time.time() - f.stat().st_mtime > CACHE_TTL_S:
        return None
    return f.read_bytes()


def _cache_put(kind: str, key: str, data: bytes) -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_file(kind, key).write_bytes(data)


def http_get(url: str, fresh: bool = False, timeout: int = 60) -> bytes:
    hit = _cache_get("http", url, fresh)
    if hit is not None:
        return hit
    log(f"  GET {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "ups-draft-intel-etl"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    _cache_put("http", url, data)
    return data


def http_get_json(url: str, fresh: bool = False, timeout: int = 60):
    return json.loads(http_get(url, fresh, timeout))


def d1_query(sql: str, fresh: bool = False) -> list[dict]:
    """Run a read-only SELECT against remote D1 via wrangler; cached."""
    hit = _cache_get("d1", sql, fresh)
    if hit is not None:
        return json.loads(hit)
    log(f"  D1: {sql[:90].replace(chr(10), ' ')}…")
    proc = subprocess.run(
        ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
         "--remote", "--json", "--command", sql],
        cwd=str(WORKER_DIR), capture_output=True, text=True)
    if proc.returncode != 0:
        sys.exit(f"FATAL: wrangler d1 execute failed:\n{proc.stderr[-2000:]}")
    out = proc.stdout
    start = out.find("[")
    if start < 0:
        sys.exit(f"FATAL: unexpected wrangler output: {out[:500]}")
    results = json.loads(out[start:])[0]["results"]
    _cache_put("d1", sql, json.dumps(results).encode())
    return results


def resolve_db(arg_db: str | None) -> str:
    """Mirror build_auction_intel.resolve_db: explicit --db, else the shared
    decompressed archive cache, else decompress the in-repo gz."""
    if arg_db:
        return arg_db
    cached = Path(tempfile.gettempdir()) / "ups_auction_canon.db"
    if cached.exists():
        return str(cached)
    if not ARCHIVE_GZ.exists():
        sys.exit(f"FATAL: no --db and archive missing at {ARCHIVE_GZ}")
    log(f"decompressing {ARCHIVE_GZ.name} → {cached} …")
    with gzip.open(ARCHIVE_GZ, "rb") as fi, open(cached, "wb") as fo:
        shutil.copyfileobj(fi, fo)
    return str(cached)


# ------------------------------------------------------------- market values

def blend_value(row: dict):
    """ADP-implied market value for a raw board row — the SAME 65/35 dyn/rd
    per-dimension source-mean blend fetch_adp_board() ranks by."""
    dyn, rd = [], []
    for src in ("fc", "ktc", "dp"):
        blk = row.get(src) or {}
        if blk.get("dsf") and blk["dsf"] > 0:
            dyn.append(float(blk["dsf"]))
        if blk.get("rsf") and blk["rsf"] > 0:
            rd.append(float(blk["rsf"]))
    dyn_c = sum(dyn) / len(dyn) if dyn else None
    rd_c = sum(rd) / len(rd) if rd else None
    if dyn_c is None and rd_c is None:
        return None
    if rd_c is None:
        return dyn_c
    if dyn_c is None:
        return rd_c
    return (1 - RD_PCT) * dyn_c + RD_PCT * rd_c


# ---------------------------------------------------------------- price model

def build_price_model(db_path: str) -> dict:
    """Per-position expected winning-bid bands ($K) by posRank, fit from the
    2020-25 FA-auction archive. Historical market posRank isn't derivable, so
    the bucket is the within-(season,pos) PRICE rank; ±1-rank pooling smooths
    the ~6-samples-per-rank noise, then each percentile is forced monotone
    non-increasing down the ranks."""
    conn = sqlite3.connect(db_path)
    rows = conn.execute(
        "SELECT season, UPPER(position), bid_amount FROM transactions_auction "
        "WHERE auction_type='FreeAgent' AND finalbid_ind=1 "
        "AND season BETWEEN 2020 AND 2025 AND UPPER(position) IN ('QB','RB','WR','TE')"
    ).fetchall()
    conn.close()
    by_rank: dict[str, dict[int, list[float]]] = {p: defaultdict(list) for p in POOL_POS}
    per_sp: dict[tuple, list[float]] = defaultdict(list)
    for season, pos, amt in rows:
        # QB: Superflex-era prices only (2022+) — 2020-21 predate the SF cutover
        # and drag the top of the QB curve down (Keith 2026-07-13).
        if pos == "QB" and season < 2022:
            continue
        k = fnum(amt, 0.0) / 1000.0
        per_sp[(season, pos)].append(k)
    for (season, pos), bids in per_sp.items():
        for i, k in enumerate(sorted(bids, reverse=True), 1):
            by_rank[pos][i].append(k)
    model = {}
    for pos in POOL_POS:
        ranks = by_rank[pos]
        if not ranks:
            continue
        max_r = max(ranks)
        points, prev = [], [None, None, None]
        for r in range(1, max_r + 1):
            pool = ranks.get(r, []) + ranks.get(r - 1, []) + ranks.get(r + 1, [])
            if len(pool) < 4:
                continue
            vals = [pctile(pool, 25), pctile(pool, 50), pctile(pool, 90)]
            # monotone non-increasing down the ranks (prices fall with rank)
            vals = [v if prev[i] is None else min(v, prev[i]) for i, v in enumerate(vals)]
            prev = vals
            points.append([r] + [round(v, 1) for v in vals])
        model[pos] = {"points": points}
    return model


def band_at_rank(model: dict, pos: str, pos_rank: int):
    """[p25, p50, p90] interpolated from the position curve at a market posRank."""
    pts = (model.get(pos) or {}).get("points") or []
    if not pts or pos_rank is None:
        return None
    r = max(pts[0][0], min(pts[-1][0], pos_rank))
    lo = pts[0]
    for pt in pts:
        if pt[0] <= r:
            lo = pt
        if pt[0] >= r:
            hi = pt
            break
    else:
        hi = pts[-1]
    if hi[0] == lo[0]:
        return lo[1:]
    f = (r - lo[0]) / (hi[0] - lo[0])
    return [lo[i] + (hi[i] - lo[i]) * f for i in range(1, 4)]


# ---------------------------------------------------------------- D1 pulls

def sql_str_list(vals) -> str:
    return ",".join("'" + str(v).replace("'", "''") + "'" for v in vals)


def pull_crosswalk(mfl_ids: list[str], merge_names: list[str], fresh: bool):
    """ff_player_ids rows for known MFL ids + name-fallback rows."""
    rows = []
    ids = sorted(set(mfl_ids))
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        rows += d1_query(
            "SELECT mfl_id, gsis_id, merge_name, position, birthdate, team "
            f"FROM ff_player_ids WHERE mfl_id IN ({sql_str_list(chunk)})", fresh)
    names = sorted(set(n for n in merge_names if n))
    for i in range(0, len(names), 300):
        chunk = names[i:i + 300]
        rows += d1_query(
            "SELECT mfl_id, gsis_id, merge_name, position, birthdate, team "
            "FROM ff_player_ids WHERE position IN ('QB','RB','WR','TE') "
            f"AND merge_name IN ({sql_str_list(chunk)})", fresh)
    return rows


def pull_stat_tables(fresh: bool):
    routes = {r["gsis_id"]: r for r in d1_query(
        "SELECT gsis_id, routes, routes_tgt, routes_rec_yds FROM nfl_player_routes "
        f"WHERE season={STAT_SEASON} AND routes IS NOT NULL AND routes > 0", fresh)}
    rz = {r["gsis_id"]: (r["rzez"] or 0) for r in d1_query(
        "SELECT gsis_id, SUM(COALESCE(targets_i20,0)) + SUM(COALESCE(targets_ez,0)) AS rzez "
        f"FROM nfl_player_redzone WHERE season={STAT_SEASON} GROUP BY gsis_id HAVING rzez > 0", fresh)}
    qb_career = defaultdict(dict)   # gsis -> {season: td_rate}
    for r in d1_query(
        "SELECT season, gsis_id, SUM(COALESCE(pass_att,0)) att, SUM(COALESCE(pass_tds,0)) td "
        "FROM nfl_player_weekly WHERE pos_group='QB' "
        "AND ((season >= 2021 AND week <= 18) OR (season < 2021 AND week <= 17)) "
        "GROUP BY season, gsis_id HAVING att >= 150", fresh):
        qb_career[r["gsis_id"]][int(r["season"])] = (r["td"] or 0) / float(r["att"])
    pace = {team_norm(r["team"]): fnum(r["off_plays_pg"]) for r in d1_query(
        f"SELECT team, off_plays_pg FROM nfl_team_pace WHERE season={STAT_SEASON}", fresh)}
    return routes, rz, qb_career, pace


def pull_season_csv(fresh: bool) -> dict:
    """nflverse 2025 REG season-level player stats keyed by gsis_id."""
    raw = http_get(NFLVERSE_CSV, fresh, timeout=180)
    out = {}
    for r in csv.DictReader(io.StringIO(raw.decode("utf-8"))):
        gsis = r.get("player_id") or ""
        if not gsis:
            continue
        def num(col):
            return fnum(r.get(col), 0.0) or 0.0
        out[gsis] = {
            "pos": (r.get("position") or "").upper(),
            "team": team_norm(r.get("recent_team")),
            "g": num("games"),
            "carries": num("carries"), "rush_yds": num("rushing_yards"),
            "rush_tds": num("rushing_tds"), "rush_10": num("rushing_10"),
            "targets": num("targets"), "rec": num("receptions"),
            "rec_yds": num("receiving_yards"), "rec_tds": num("receiving_tds"),
            "rec_fd": num("receiving_first_downs"),
            "pass_att": num("attempts"), "pass_tds": num("passing_tds"),
        }
    return out


# ---------------------------------------------------------------- tiers

def build_tiers(pool: list[dict]) -> dict:
    """Local-cliff worth tiers per position (same idea as the site ADP tiers):
    break where the worth gap > 1.5× the median positive gap (and ≥ $1K)."""
    def zone_label(k: float) -> str:
        if k >= 18:
            return "Marquee"
        if k >= 10:
            return "Mid-shelf"
        if k >= 5:
            return "Low-cost"
        return "Cap-free darts"
    tiers = {}
    for pos in POOL_POS:
        rows = sorted((p for p in pool if p["p"] == pos), key=lambda p: -(p["worth"] or 0))
        if not rows:
            continue
        gaps = [(rows[i]["worth"] or 0) - (rows[i + 1]["worth"] or 0) for i in range(len(rows) - 1)]
        pos_gaps = [g for g in gaps if g > 0]
        med = pctile(pos_gaps, 50) or 0.0
        thresh = max(1.0, 1.5 * med)
        groups, cur = [], [rows[0]]
        for i in range(1, len(rows)):
            prev_w, cur_w = rows[i - 1]["worth"] or 0, rows[i]["worth"] or 0
            dart_line = prev_w >= 3 > cur_w      # always split the $1K-dart pile off
            if dart_line or (gaps[i - 1] > thresh and prev_w >= 3):
                groups.append(cur)
                cur = []
            cur.append(rows[i])
        groups.append(cur)
        out = []
        for t, g in enumerate(groups, 1):
            ws = [p["worth"] or 0 for p in g]
            out.append({"t": t, "label": zone_label(max(ws)),
                        "ids": [p["n"] for p in g],
                        "usd": [round(min(ws), 1), round(max(ws), 1)]})
        tiers[pos] = out
    return tiers


# ---------------------------------------------------------------- D1 push

def push_d1(payload_str: str) -> None:
    """Part-keyed push (mirror of build_faa_report.py): the blob exceeds D1's
    100KB single-statement cap, so split the JSON STRING into <90KB chunks and
    the worker concatenates ORDER BY part. DELETE first so a shrinking
    part-count can't leave stale tail rows."""
    ts = int(time.time())
    CHUNK = 85000
    parts = [payload_str[i:i + CHUNK] for i in range(0, len(payload_str), CHUNK)]
    sql = ["DELETE FROM ups_draft_intel;"]
    for i, ch in enumerate(parts):
        stmt = (f"INSERT INTO ups_draft_intel (part, payload, updated_at) "
                f"VALUES ({i}, '{ch.replace(chr(39), chr(39) * 2)}', {ts});")
        if len(stmt) > 99500:
            raise SystemExit(f"  ✘ part {i} statement {len(stmt)} bytes > 99.5KB — lower CHUNK.")
        sql.append(stmt)
    tmp = WORKER_DIR / ".tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    sql_path = tmp / "draft_intel_upsert.sql"
    sql_path.write_text("\n".join(sql) + "\n")
    log(f"  pushing draft_intel blob to D1 ({len(parts)} parts, {len(payload_str)/1024:.1f}KB total) …")
    subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
                    "--remote", "--file", str(sql_path)], cwd=str(WORKER_DIR), check=True)
    log(f"  pushed ups_draft_intel ({len(parts)} parts)")


# ================================================================== main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--fa-json", default=None,
                    help="path to a cached /api/auction/fa-value payload (default: live GET)")
    ap.add_argument("--db", default=None,
                    help="SQLite with transactions_auction (default: in-repo archive)")
    ap.add_argument("--fresh", action="store_true", help="bypass all local caches")
    ap.add_argument("--push-d1", action="store_true",
                    help="part-keyed upsert of the blob to D1 ups_draft_intel")
    args = ap.parse_args()

    base = worker_base()

    # ---- 1. FA pool + worth/expected price (REUSE the fa-value engine) ----
    log("1/8 fa-value pool …")
    if args.fa_json:
        fa = json.loads(Path(args.fa_json).read_text())
    else:
        fa = http_get_json(f"{base}/api/auction/fa-value?franchise_id=0008", args.fresh)
    dyn_w = float(((fa.get("meta") or {}).get("worth_model") or {}).get("default_dyn_weight", 0.5))

    def worth_of(e: dict):
        rw, dw = fnum(e.get("rw")), fnum(e.get("dw"))
        if rw is None and dw is None:
            return None
        if rw is None:
            return round(dw, 1)
        if dw is None:
            return round(rw, 1)
        return round((1 - dyn_w) * rw + dyn_w * dw, 1)

    all_entries = fa.get("fas") or []
    fas = [e for e in all_entries if e.get("o") is None]
    log(f"  {len(all_entries)} valued players, {len(fas)} available FAs")

    # 2026 stud premium: first SF-era auction with legit studs in the pool
    # (Allen/Lamar/Burrow at QB) — the historical curve has never priced their
    # like, so stud bands get an explicit uplift (Keith 2026-07-13: "the studs
    # go even higher"). Stud test = engine E[APWE] p50 >= the fa-value stud bar.
    stud_bar = (fa.get("meta") or {}).get("stud_bar") or {}

    def is_stud(e: dict) -> bool:
        a50 = fnum(e.get("a50"))
        bar = fnum(stud_bar.get(str(e.get("p") or "").upper()))
        return a50 is not None and bar is not None and a50 >= bar

    # value_rank universe = ALL valued players (owned + FA) so it's comparable
    # to the ADP board's league-wide posRank space.
    value_rank: dict[tuple, int] = {}
    for pos in POOL_POS:
        rows = sorted((e for e in all_entries if e.get("p") == pos),
                      key=lambda e: -(worth_of(e) or 0))
        for i, e in enumerate(rows, 1):
            value_rank[(pos, norm_name(e.get("n")))] = i

    # ---- 2. ADP: site-exact consensus + raw board for names/teams/values ----
    log("2/8 ADP board …")
    adp = fetch_adp_board()                      # pid -> overall/pos_rank/pos/trend30
    board = http_get_json(f"{base}/api/adp-board", args.fresh).get("board") or []
    by_key: dict[tuple, dict] = {}
    by_name: dict[str, list] = defaultdict(list)
    for row in board:
        if row.get("isIdp"):
            continue
        nn = norm_name(row.get("name"))
        by_key.setdefault((nn, str(row.get("pos") or "").upper()), row)
        by_name[nn].append(row)

    # ---- 3. match FA names -> board pid ----
    matches: dict[int, dict] = {}                # fa index -> board row
    for i, e in enumerate(fas):
        nn, pos = norm_name(e.get("n")), str(e.get("p") or "").upper()
        row = by_key.get((nn, pos))
        if row is None and len(by_name.get(nn, [])) == 1:
            row = by_name[nn][0]
        if row is not None:
            matches[i] = row
    unmatched = [fas[i]["n"] for i in range(len(fas)) if i not in matches]
    log(f"  matched {len(matches)}/{len(fas)} FAs to board pids"
        + (f"; unmatched e.g. {unmatched[:6]}" if unmatched else ""))

    # ---- 4. crosswalk (gsis + birthdate) ----
    log("3/8 ff_player_ids crosswalk …")
    matched_pids = [str(r.get("pid")) for r in matches.values() if r.get("pid")]
    fallback_names = [norm_name(fas[i]["n"]) for i in range(len(fas)) if i not in matches]
    xwalk_rows = pull_crosswalk(matched_pids, fallback_names, args.fresh)
    x_by_mfl = {str(r["mfl_id"]): r for r in xwalk_rows if r.get("mfl_id")}
    x_by_name: dict[tuple, dict] = {}
    for r in xwalk_rows:
        if r.get("merge_name"):
            x_by_name.setdefault((norm_name(r["merge_name"]), str(r.get("position") or "").upper()), r)

    def xwalk_for(i: int, e: dict):
        row = matches.get(i)
        if row is not None and str(row.get("pid")) in x_by_mfl:
            return x_by_mfl[str(row.get("pid"))]
        return x_by_name.get((norm_name(e.get("n")), str(e.get("p") or "").upper()))

    # ---- 5. prior-3-season weighted PPG (data-layer rule) ----
    log("4/8 weighted 3-season PPG …")
    light = []
    seen_pids = set()
    for i, e in enumerate(fas):
        row = matches.get(i)
        pid = str(row.get("pid")) if row is not None and row.get("pid") else None
        if pid is None:
            xw = xwalk_for(i, e)
            pid = str(xw["mfl_id"]) if xw else None
        if pid and pid not in seen_pids:
            seen_pids.add(pid)
            light.append(SimpleNamespace(player_id=pid, position=str(e.get("p") or "").upper()))
    wppg = fetch_weighted_ppg(light)
    log(f"  weighted PPG for {len(wppg)} of {len(light)} pool pids")

    # ---- 6. 2025 stats: nflverse season CSV + D1 tables ----
    log(f"5/8 {STAT_SEASON} stats (nflverse CSV + D1 routes/redzone/QB-career/pace) …")
    stats = pull_season_csv(args.fresh)
    routes, rz, qb_career, pace = pull_stat_tables(args.fresh)

    # league context for screens (2025 universe, position from the CSV)
    wr_pool = []
    for gsis, rt in routes.items():
        st = stats.get(gsis)
        if st and st["pos"] == "WR" and (rt["routes"] or 0) >= 150:
            r_n = float(rt["routes"])
            wr_pool.append(((rt["routes_tgt"] or 0) / r_n, (rt["routes_rec_yds"] or 0) / r_n))
    wr_tprr_q75 = pctile([t for t, _ in wr_pool], 75) or 999
    wr_yprr_med = pctile([y for _, y in wr_pool], 50) or 0
    te_rz_top12 = set()
    te_rz = sorted(((gsis, n) for gsis, n in rz.items()
                    if (stats.get(gsis) or {}).get("pos") == "TE"), key=lambda t: -t[1])
    te_rz_top12 = {gsis for gsis, _ in te_rz[:12]}

    # ---- 7. environment: vegas + pace + ADP-implied rooms ----
    log("6/8 environment (vegas, pace, pass-catcher rooms) …")
    try:
        vegas = {team_norm(t.get("team")): fnum(t.get("implied"))
                 for t in (http_get_json(f"{base}/api/vegas", args.fresh).get("teams") or [])}
    except Exception as exc:
        log(f"  (vegas skipped: {exc})")
        vegas = {}

    def norm_map(m: dict) -> dict:
        vals = [v for v in m.values() if v is not None]
        if not vals or max(vals) == min(vals):
            return {}
        lo, hi = min(vals), max(vals)
        return {k: 100.0 * (v - lo) / (hi - lo) for k, v in m.items() if v is not None}
    vegas_n, pace_n = norm_map(vegas), norm_map(pace)
    tes_by_team = {}
    for team in set(vegas_n) | set(pace_n):
        comps = [m[team] for m in (vegas_n, pace_n) if team in m]
        if comps:
            tes_by_team[team] = int(round(sum(comps) / len(comps)))

    # ADP-implied rooms (board teams are CURRENT — the 2026 landscape)
    pcs_sum: dict[str, float] = defaultdict(float)      # startable WR+TE value
    wr_room: dict[str, float] = defaultdict(float)      # all board WRs
    rb_rooms: dict[str, list] = defaultdict(list)       # (pid, posRank, val)
    for row in board:
        if row.get("isIdp"):
            continue
        pid = str(row.get("pid") or "")
        a = adp.get(pid)
        team = team_norm(row.get("team"))
        if not a or not team:
            continue
        val = blend_value(row) or 0.0
        pos = a["pos"]
        if (pos == "WR" and a["pos_rank"] <= 60) or (pos == "TE" and a["pos_rank"] <= 30):
            pcs_sum[team] += val
        if pos == "WR":
            wr_room[team] += val
        if pos == "RB":
            rb_rooms[team].append((pid, a["pos_rank"], val))
    pcs_rank = {team: i for i, (team, _) in
                enumerate(sorted(pcs_sum.items(), key=lambda t: -t[1]), 1)}
    max_wr_room = max(wr_room.values(), default=0.0)
    rb_others: dict[str, float] = {}
    rb_elite_mate: dict[str, bool] = {}
    for team, room in rb_rooms.items():
        for pid, pr, _ in room:
            rb_others[pid] = sum(v for p2, _, v in room if p2 != pid)
            rb_elite_mate[pid] = any(p2 != pid and pr2 <= 12 for p2, pr2, _ in room)
    max_rb_others = max(rb_others.values(), default=0.0)

    # ---- 8. price model from the auction archive ----
    log("7/8 price model (FA-auction winning bids: QB 2022-25 SF-era, others 2020-25) …")
    price_model = build_price_model(resolve_db(args.db))
    for pos in POOL_POS:
        n = len((price_model.get(pos) or {}).get("points") or [])
        log(f"  {pos}: {n} rank points")

    # ---------------------------------------------------------- assemble
    log("8/8 assembling players …")
    rb_recppg_vals = []           # for the top-half contract test (filled pass 1)
    players = []
    for i, e in enumerate(fas):
        pos = str(e.get("p") or "").upper()
        row = matches.get(i)
        xw = xwalk_for(i, e)
        pid = (str(row.get("pid")) if row is not None and row.get("pid")
               else (str(xw["mfl_id"]) if xw else None))
        a = adp.get(pid) if pid else None
        gsis = (xw or {}).get("gsis_id")
        st = stats.get(gsis) if gsis else None
        rt = routes.get(gsis) if gsis else None

        team = None
        if row is not None:
            team = team_norm(row.get("team"))
        if team is None and xw:
            team = team_norm(xw.get("team"))
        if team is None and st:
            team = st.get("team")

        age = fnum(row.get("age")) if row is not None else None
        if age is None and xw and xw.get("birthdate"):
            try:
                bd = datetime.strptime(str(xw["birthdate"])[:10], "%Y-%m-%d")
                age = round((datetime.now() - bd).days / 365.25, 1)
            except ValueError:
                age = None

        worth = worth_of(e) or 0.0
        eng_e = fnum(e.get("e"))          # fa-value engine expected price
        pr = a["pos_rank"] if a else None
        t30 = a["trend30"] if a else None

        # band: archive curve at market posRank; p50 reconciled 50/50 with the
        # engine's e, and the curve spread shifted with it (no degenerate clamp).
        # ep = the reconciled p50 when a band exists (with ep == raw engine e the
        # TARGET gate ep<=worth*0.9 can mathematically never fire — e and worth
        # both derive from the same APWE quantities).
        band, ep = None, eng_e
        if pr is not None:
            raw_band = band_at_rank(price_model, pos, pr)
            if raw_band:
                p25, p50, p90 = raw_band
                if eng_e is not None:
                    delta = (0.5 * p50 + 0.5 * eng_e) - p50
                    p25, p50, p90 = p25 + delta, p50 + delta, p90 + delta
                p25 = max(1.0, min(p25, p50))
                p90 = max(p90, p50)
                if p90 - p25 < 0.1:
                    # deep-rank curve tails collapse to a point ($1K pile) and
                    # the e-shift then claims false certainty — floor the spread.
                    p25, p90 = max(1.0, 0.8 * p50), 1.3 * p50
                if is_stud(e):
                    # stud premium: history has never auctioned this caliber in
                    # the SF era — anchor on the stronger of curve/engine, lift
                    # p50 10% and give p90 a 30% bidding-war ceiling.
                    basis = max(p50, eng_e or 0.0)
                    p50 = STUD_P50_UPLIFT * basis
                    p90 = max(p90, STUD_P90_MULT * basis, p50)
                    p25 = max(p25, 0.85 * p50)
                band = [round(p25, 1), round(p50, 1), round(p90, 1)]
                ep = round(p50, 1)

        # market score + verdict (abstain on darts / deep ranks / no ADP)
        ms = verdict = None
        abstain = (worth < 3.0 or pr is None or pr > ABSTAIN_POSRANK.get(pos, 60))
        if not abstain:
            vr = value_rank.get((pos, norm_name(e.get("n"))))
            if vr is not None:
                ms = int(round(50 + 50 * math.tanh((pr - vr) / MS_K[pos])))
                if ms >= 65 and ep is not None and ep <= worth * 0.9:
                    verdict = "TARGET"
                elif ms <= 35 and ep is not None and ep >= worth * 1.15:
                    verdict = "AVOID"
                else:
                    verdict = "FAIR"

        # ---- screens (2025 only) ----
        scr = {}
        g = (st or {}).get("g") or 0.0
        r_n = float(rt["routes"]) if rt and (rt.get("routes") or 0) > 0 else 0.0
        yprr = round((rt["routes_rec_yds"] or 0) / r_n, 2) if r_n >= 50 else None
        tprr = round((rt["routes_tgt"] or 0) / r_n, 3) if r_n >= 50 else None
        fdrr = (round((st["rec_fd"]) / r_n, 3) if (st and r_n >= 50) else None)

        if pos == "QB":
            blk = {"rypg": None, "bucket": None, "konami": None, "xtd_flag": None}
            if st and g > 0 and st["pass_att"] >= 100:
                rypg = st["rush_yds"] / g
                rush_ppg = (0.1 * st["rush_yds"] + 6 * st["rush_tds"]) / g
                bucket = "<2" if rush_ppg < 2 else ("2-4" if rush_ppg < 4 else "4+")
                blk["rypg"] = round(rypg, 1)
                blk["bucket"] = bucket
                blk["konami"] = bucket == "4+" or (bucket == "2-4" and age is not None and age <= 25)
                career = qb_career.get(gsis) or {}
                prior = [r2 for s2, r2 in career.items() if s2 < STAT_SEASON]
                if st["pass_att"] >= 150 and len(prior) >= 2:
                    mean = sum(prior) / len(prior)
                    sd = math.sqrt(sum((x - mean) ** 2 for x in prior) / len(prior))
                    sd = max(sd, 0.004)   # guard: near-zero SD flags everything
                    r25 = st["pass_tds"] / st["pass_att"]
                    if r25 > mean + sd:
                        blk["xtd_flag"] = "-regress"   # hot TD rate → expect fade
                    elif r25 < mean - sd:
                        blk["xtd_flag"] = "+regress"   # cold TD rate → expect bounce
            scr["qb"] = blk
        elif pos == "RB":
            blk = {"rec_ppg": None, "yprr": None, "r10": None, "ambig": None, "bf": None}
            if st and g > 0:
                blk["rec_ppg"] = round((0.8 * st["rec"] + 0.1 * st["rec_yds"] + 6 * st["rec_tds"]) / g, 2)
                rb_recppg_vals.append(blk["rec_ppg"])
            blk["yprr"] = round((rt["routes_rec_yds"] or 0) / r_n, 2) if r_n >= 25 else None
            if st and st["carries"] >= 50:
                blk["r10"] = round(st["rush_10"] / st["carries"], 3)
            if pid in rb_others and max_rb_others > 0:
                blk["ambig"] = int(round(100 * rb_others[pid] / max_rb_others))
                blk["bf"] = ("elite-mate" if rb_elite_mate.get(pid)
                             else ("ambiguous" if blk["ambig"] >= 45 else "solo"))
            scr["rb"] = blk
        elif pos == "WR":
            blk = {"yprr": yprr, "tprr": tprr, "fdrr": fdrr, "fdb": None,
                   "slump": None, "dfr": None}
            if fdrr is not None and r_n >= 100:
                blk["fdb"] = "green" if fdrr >= 0.12 else ("yellow" if fdrr >= 0.08 else "red")
            if r_n >= 150 and tprr is not None and yprr is not None:
                blk["slump"] = bool(tprr >= wr_tprr_q75 and yprr <= wr_yprr_med)
            # dfr (share of targets 15+ air yds) needs a target-depth
            # distribution — not in D1 (NGS/FTN lack it) → null.
            scr["wr"] = blk
        elif pos == "TE":
            chk = {"yprr": (yprr >= 1.6) if yprr is not None else None,
                   "tprr": (tprr >= 0.18) if tprr is not None else None,
                   "fdrr": (fdrr >= 0.10) if fdrr is not None else None,
                   "slot": None,   # slot-rate source not in D1 → null
                   "rz": (gsis in te_rz_top12) if gsis else None}
            blk = {"chk": chk, "chk_n": sum(1 for v in chk.values() if v is True),
                   "tddep": None, "wrcomp": None}
            if st and g > 0:
                te_pts = (1.5 * st["rec"] + 0.1 * st["rec_yds"] + 0.1 * st["rush_yds"]
                          + 6 * (st["rec_tds"] + st["rush_tds"]))
                if te_pts > 0:
                    share = 6 * (st["rec_tds"] + st["rush_tds"]) / te_pts
                    blk["tddep"] = "low" if share < 0.25 else ("high" if share > 0.40 else "med")
            if team and max_wr_room > 0:
                blk["wrcomp"] = int(round(100 * wr_room.get(team, 0.0) / max_wr_room))
            scr["te"] = blk

        w = wppg.get(pid) if pid else None
        gp3 = sum(int(v.get("games") or 0) for v in (w or {}).get("by_season", {}).values()) if w else None

        teband = None
        if pos == "TE" and pr is not None and 7 <= pr <= 18:
            teband = [max(1, pr - 3), pr + 4]

        # contract recommendation
        dt = e.get("dt")
        rec = None
        if worth < 3.0:
            rec = "dart"
        elif dt == "a":
            rec = "anchor"
        players.append({
            "id": pid, "n": e.get("n"), "p": pos, "tm": team,
            "adp": {"ovr": a["overall"] if a else None, "pr": pr, "t30": t30},
            "ppg3": (w or {}).get("ppg"), "gp3": gp3,
            "worth": worth, "ep": ep, "band": band,
            "ms": ms, "verdict": verdict, "dt": dt,
            "scr": scr,
            "env": {"pcs": pcs_rank.get(team) if team else None,
                    "tes": tes_by_team.get(team) if team else None},
            "con": {"rec": rec, "dc_note": None},   # multi-yr recs finalized in pass 2
            "teband": teband,
            "_age": age,                            # pass-2 helper, stripped below
        })

    # pass 2: '2-3yr' needs the RB rec-PPG top-half line (league of THIS pool)
    rb_rec_med = pctile(rb_recppg_vals, 50) or 0.0
    for p in players:
        con = p["con"]
        if con["rec"] is None:
            pos, t30, age = p["p"], p["adp"]["t30"], p.pop("_age", None)
            multi = False
            if pos == "RB":
                rp = (p["scr"].get("rb") or {}).get("rec_ppg")
                multi = (rp is not None and rp >= rb_rec_med
                         and age is not None and age <= 25)
            elif pos == "WR":
                multi = bool(t30 and t30 > 0)
            elif pos == "TE":
                multi = bool(t30 and t30 > 0 and (p["scr"].get("te") or {}).get("chk_n", 0) >= 3)
            con["rec"] = "2-3yr" if multi else "1yr"
        else:
            p.pop("_age", None)
        if con["rec"] in ("2-3yr", "anchor") and p["ep"] is not None:
            yrs = 4 if con["rec"] == "anchor" else 3
            est = round(0.75 * (yrs - 1) * p["ep"], 1)
            con["dc_note"] = (f"cut after yr 1 of a {yrs}-yr @ ~${p['ep']:g}K/yr → dead cap "
                              f"≈ ${est:g}K (75% of remaining TCV)")

    tiers = build_tiers(players)

    payload = {
        "meta": {
            "generated": "build_draft_intel.py",
            "season": SEASON,
            "asof": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "replacement_ppg": REPLACEMENT_PPG,
            "dollar_per_par": DOLLAR_PER_PAR,
            "notes": (f"FA-auction pool intel. worth reused from the fa-value engine "
                      f"(dyn_w={dyn_w}); ADP = site consensus (65/35 dyn/rd SF); screens = "
                      f"{STAT_SEASON} REG season only (pre-season standing rule); price bands "
                      f"fit from FA-auction winning bids by within-season price rank (QB "
                      f"2022-25 SF-era only; RB/WR/TE 2020-25); ep = band p50 reconciled "
                      f"50/50 with the engine's e (raw e where no band). 2026 STUD PREMIUM: "
                      f"players at/above the fa-value stud bar (E[APWE] p50) get p50 x"
                      f"{STUD_P50_UPLIFT} and p90 >= {STUD_P90_MULT}x basis — first SF-era "
                      f"auction with legit studs in the pool (commish 2026-07-13). "
                      f"dfr + TE slot-rate have no D1 source → null."),
        },
        "price_model": price_model,
        "players": players,
        "tiers": tiers,
        "cockpit": {"note": ("Static intel v1 — live cockpit deferred. At the podium: anchor on "
                             "band p50, pounce when the room price sits under worth×0.9 on a "
                             "TARGET, and never chase past p90 on a FAIR/AVOID.")},
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUT_DIR / "draft_intel.json"
    out_path.write_text(json.dumps(payload, indent=1))
    lean = json.dumps(payload, separators=(",", ":"))
    log(f"wrote {out_path.relative_to(REPO)} ({len(players)} players, lean {len(lean)/1024:.1f}KB)")

    # ------------------------------------------------------------ verification
    log("\n=== verification ===")
    n_adp = sum(1 for p in players if p["adp"]["pr"] is not None)
    n_gsis = sum(1 for p in players if p["scr"] and any(
        v is not None for blk in p["scr"].values() for v in blk.values()))
    konami = [p["n"] for p in players if (p["scr"].get("qb") or {}).get("konami")]
    green = [p["n"] for p in players if (p["scr"].get("wr") or {}).get("fdb") == "green"]
    log(f"  players: {len(players)} (with ADP: {n_adp}; with populated screens: {n_gsis})")
    log(f"  konami QBs: {len(konami)} e.g. {konami[:4]}")
    log(f"  green-band WRs: {len(green)} e.g. {green[:4]}")
    log(f"  verdicts: " + json.dumps({v: sum(1 for p in players if p['verdict'] == v)
                                      for v in ('TARGET', 'FAIR', 'AVOID', None)}, default=str))
    problems = []
    for pos in POOL_POS:
        if not (price_model.get(pos) or {}).get("points"):
            problems.append(f"price_model empty for {pos}")
    for p in players:
        pr = p["adp"]["pr"]
        if pr is None:
            continue
        ok_scored = p["band"] is not None and p["ms"] is not None
        ok_abstain = p["ms"] is None and (p["worth"] < 3.0 or pr > ABSTAIN_POSRANK.get(p["p"], 60))
        if not (ok_scored or ok_abstain):
            problems.append(f"{p['n']} ({p['p']}{pr}): no band/ms and not a valid abstention")
    if len(players) < 300:
        problems.append(f"only {len(players)} players (<300)")
    if problems:
        for pr_ in problems[:20]:
            log(f"  ✘ {pr_}")
        sys.exit(f"FATAL: {len(problems)} verification problems")
    log("  ✔ all contract checks passed")

    if args.push_d1:
        push_d1(lean)


if __name__ == "__main__":
    main()
