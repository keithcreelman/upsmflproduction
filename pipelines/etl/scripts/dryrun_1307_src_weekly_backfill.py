#!/usr/bin/env python3
"""dryrun_1307_src_weekly_backfill.py -- DRY RUN for the #1307 repair of D1 src_weekly.

Builds the rows a repair WOULD write, the exact SQL, its rollback, and a
reconciliation report. It never writes to production: there is no code path
here that runs `wrangler d1 execute --remote` with anything but a SELECT.

WHAT IT PLANS (each phase is separately approvable)
  A  2011-2020: insert UPS playoff weeks 14-16 (absent from src_weekly).
  B  2021-2025: insert every free agent MFL scored in playoff weeks 15-17
     (those weeks hold rostered players only).
  C  2021-2025: correct existing playoff rows where MFL now differs (score,
     ranks over the full universe, missing pos_group).
  E  optional: status / ownership for 2011-2020 regular-season rows from MFL's
     lineup records (2012-2019 rows are all 'fa' today).

SOURCES
  * MFL public exports on api.myfantasyleague.com, read once into a local cache
    (fetch-mfl) and reused: league, players (DETAILS=1), playerScores (W=<n>,
    W=YTD), weeklyResults (W=<n>, MISSING_AS_BYE=1), rosters (W=<n>).
  * A small, budget-guarded production D1 READ (extract-d1, opt-in only): the
    playoff-week rows, sample regular weeks, src_pointssummary, src_franchises
    team names, and the representative players.
  * The archived local database (data/db-archives/mfl_database_2026-06-05.db.gz)
    stands in for D1's regular-season rows, which are not read. The build
    refuses to run unless every sampled D1 week equals the archive exactly.

STATUS RULES (never inferred; every row carries its provenance class)
  lineup  weeklyResults lists the player in a franchise's lineup that week ->
          its own 'starter' / 'nonstarter' and that franchise.
  taxi    not in any lineup; TAXI_SQUAD on that week's rosters export ->
          'nonstarter' + franchise (src_weekly's convention, verified by the
          live sync on 2025 Wk 1).
  ir      same, INJURED_RESERVE -> 'nonstarter' + franchise (the table's
          convention; listed separately because the sync calls it reasoned).
  fa      in no lineup and on no rosters export that week -> 'fa' / 'FA' /
          'Free Agent', but ONLY in weeks where that export lists every lineup
          player on the same franchise (always 2018+; often not 2011-2017).
          Otherwise the class is unproven_fa_rosters_export_incomplete.
  unresolved_* / unproven_*  anything else: a rostered player whose franchise
          submitted no lineup, a rosters export that contradicts the lineup
          record, or a "free agent" the export cannot prove. --unproven picks
          what the plan does with these rows: null (default) writes the score
          with status NULL and the franchise only where a consistent export
          proves it; hold writes nothing; sync labels them 'fa' as the live
          sync would. All three counts are reported; nothing is guessed.
  Phase E changes a regular-season row only on positive evidence (lineup,
  taxi, IR); it never downgrades an attributed row on an absence.

SUBCOMMANDS
  fetch-mfl   --cache DIR                       read MFL into the cache (throttled)
  extract-d1  --out DIR --allow-prod-d1         budget-guarded production READ
  build       --cache DIR --d1 DIR --archive DB --out DIR
                                                offline plan + SQL + reconciliation
  local-proof --out DIR                         offline: forward twice + rollback on a
                                                LOCAL SQLite copy, exact-hash checks
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR.parent))
from lib.d1_io import STATEMENT_BYTE_LIMIT, build_insert, sql_escape  # noqa: E402

SEASONS = list(range(2011, 2026))
STATUS_SEASONS = list(range(2011, 2021))  # phase E scope + 2020 as the calibration season
REP_PLAYERS = {"12620": "Dak Prescott", "12616": "Jacoby Brissett"}

# MFL league ids before 2017 (verified 2026-10-15; docs/MFL_API.md, fpa_engine.js).
LEAGUE_IDS = {2011: "40832", 2012: "37227", 2013: "42721", 2014: "30590",
              2015: "29015", 2016: "27191"}
MFL_HOST = "https://api.myfantasyleague.com"
USER_AGENT = "ups-1307-dryrun/1.0 (read-only; replies cached and reused)"

# Same 9-group taxonomy as sync_live_weekly_scores_to_d1.py (POSMAP).
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

# src_weekly's IDP group names changed in 2024: 2011-2023 rows say CB+S / DT+DE,
# 2024+ say DB / DL. A new row uses its season's own vocabulary.
LEGACY_IDP_NAMES = {"DB": "CB+S", "DL": "DT+DE"}

TABLE = "src_weekly"
COLS = ["season", "week", "player_id", "pos_group", "status", "score", "is_reg",
        "roster_franchise_id", "roster_franchise_name", "pos_rank", "overall_rank",
        "win_chunks"]
PK = ["season", "week", "player_id"]
INSERT_CHUNK_ROWS = 80          # D1Writer.DEFAULT_CHUNK_SIZE
DELETE_CHUNK_IDS = 400
ALLTIME_MIN_SHARE = 0.75        # proposed all-time rank: >= 75% of the season's UPS weeks
ALLTIME_TOP = 100


def league_id(season: int) -> str:
    return LEAGUE_IDS.get(season, "74598")


def canon_weeks(season: int) -> tuple[int, int]:
    """(last regular-season week, last UPS week) per docs/league_context_v1.md:
    2021+ = Wks 1-14 + playoffs 15-17; 2011-2020 = Wks 1-13 + playoffs 14-16."""
    return (14, 17) if season >= 2021 else (13, 16)


def as_list(v):
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def pad4(v) -> str:
    d = "".join(ch for ch in str(v or "") if ch.isdigit())
    return d.zfill(4)[-4:] if d else ""


def num(v):
    """MFL score string -> float; None when MFL posted no number."""
    s = "" if v is None else str(v).strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ──────────────────────────────────────────────────────────────────────
# MFL cache
# ──────────────────────────────────────────────────────────────────────

def mfl_url(season: int, params: dict) -> str:
    return f"{MFL_HOST}/{season}/export?{urllib.parse.urlencode({**params, 'JSON': '1'})}"


def cache_key(url: str) -> str:
    # Same key rule as the FPA store build's MFL cache: https:// stripped,
    # every non-alphanumeric character -> "_".
    return re.sub(r"[^A-Za-z0-9]", "_", url.replace("https://", "")) + ".json"


class MflCache:
    """Read-through cache of MFL GET replies. A reply is fetched at most once;
    its fetch time is kept in manifest.jsonl beside it."""

    def __init__(self, root: Path, min_interval: float = 6.0, offline: bool = False):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.min_interval = min_interval
        self.offline = offline
        self._last = 0.0
        self.fetched = 0
        self.hits = 0

    def path_for(self, url: str) -> Path:
        return self.root / cache_key(url)

    def has(self, season: int, params: dict) -> bool:
        return self.path_for(mfl_url(season, params)).exists()

    def get(self, season: int, params: dict):
        url = mfl_url(season, params)
        p = self.path_for(url)
        if p.exists():
            self.hits += 1
            return json.loads(p.read_text())
        if self.offline:
            raise FileNotFoundError(f"not in MFL cache (offline): {url}")
        data = self._fetch(url)
        if isinstance(data, dict) and "error" in data:
            raise RuntimeError(f"MFL error for {url}: {data['error']}")
        body = json.dumps(data, separators=(",", ":"))
        p.write_text(body)
        with open(self.root / "manifest.jsonl", "a") as m:
            m.write(json.dumps({"url": url, "fetched_at_utc": utc_now(), "bytes": len(body),
                                "sha256": hashlib.sha256(body.encode()).hexdigest()}) + "\n")
        self.fetched += 1
        return data

    def _fetch(self, url: str):
        backoff = 60
        for attempt in range(6):
            wait = self.min_interval - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                if e.code not in (429, 500, 502, 503, 504) or attempt == 5:
                    raise
                sys.stderr.write(f"  [mfl] HTTP {e.code}; backing off {backoff}s\n")
                time.sleep(backoff)
                backoff = min(backoff * 2, 600)
            except (urllib.error.URLError, TimeoutError) as e:
                if attempt == 5:
                    raise
                sys.stderr.write(f"  [mfl] {e}; retrying in 30s\n")
                time.sleep(30)
        raise RuntimeError("unreachable")


def fetch_plan(seasons: list[int], status_seasons: list[int]) -> list[tuple[int, dict]]:
    """Every MFL read the build needs, most important first, so a partial
    download already supports the playoff-week inventory."""
    plan: list[tuple[int, dict]] = []
    for s in seasons:
        lid = league_id(s)
        last_reg, end = canon_weeks(s)
        plan.append((s, {"TYPE": "league", "L": lid}))
        plan.append((s, {"TYPE": "players", "L": lid, "DETAILS": "1"}))
        for w in range(last_reg + 1, end + 1):
            plan.append((s, {"TYPE": "playerScores", "L": lid, "W": str(w)}))
            plan.append((s, {"TYPE": "weeklyResults", "L": lid, "W": str(w), "MISSING_AS_BYE": "1"}))
            plan.append((s, {"TYPE": "rosters", "L": lid, "W": str(w)}))
        plan.append((s, {"TYPE": "playerScores", "L": lid, "W": "YTD"}))
    for s in seasons:
        last_reg, _ = canon_weeks(s)
        for w in range(1, last_reg + 1):
            plan.append((s, {"TYPE": "playerScores", "L": league_id(s), "W": str(w)}))
    for s in status_seasons:
        last_reg, _ = canon_weeks(s)
        for w in range(1, last_reg + 1):
            plan.append((s, {"TYPE": "weeklyResults", "L": league_id(s), "W": str(w), "MISSING_AS_BYE": "1"}))
            plan.append((s, {"TYPE": "rosters", "L": league_id(s), "W": str(w)}))
    return plan


def cmd_fetch_mfl(args) -> int:
    cache = MflCache(Path(args.cache), min_interval=args.min_interval)
    plan = fetch_plan(SEASONS, STATUS_SEASONS)
    todo = [(s, p) for s, p in plan if not cache.has(s, p)]
    print(f"MFL plan: {len(plan)} reads, {len(plan) - len(todo)} already cached, {len(todo)} to fetch "
          f"(~{len(todo) * args.min_interval / 60:.0f} min at {args.min_interval}s spacing)", flush=True)
    for i, (s, p) in enumerate(todo, 1):
        cache.get(s, p)
        if i % 20 == 0 or i == len(todo):
            print(f"  {i}/{len(todo)} fetched ({s} {p.get('TYPE')} W={p.get('W', '-')})", flush=True)
    print(f"done: fetched {cache.fetched}, cache hits {cache.hits}")
    return 0


class MflData:
    """Parsed views of the cached MFL replies."""

    def __init__(self, cache: MflCache):
        self.c = cache

    def meta(self, s: int) -> dict:
        lg = self.c.get(s, {"TYPE": "league", "L": league_id(s)})["league"]
        names = {pad4(f.get("id")): str(f.get("name") or "").strip()
                 for f in as_list((lg.get("franchises") or {}).get("franchise"))}
        return {"last_reg": int(lg["lastRegularSeasonWeek"]), "end_week": int(lg["endWeek"]), "names": names}

    def players(self, s: int) -> dict:
        d = self.c.get(s, {"TYPE": "players", "L": league_id(s), "DETAILS": "1"})
        return {str(p.get("id")): {"position": str(p.get("position") or "").upper(),
                                   "name": str(p.get("name") or "")}
                for p in as_list((d.get("players") or {}).get("player"))}

    def scores(self, s: int, w) -> tuple[dict, int]:
        d = self.c.get(s, {"TYPE": "playerScores", "L": league_id(s), "W": str(w)})
        out, blank = {}, 0
        for p in as_list((d.get("playerScores") or {}).get("playerScore")):
            v = num(p.get("score"))
            if v is None:
                blank += 1
            else:
                out[str(p.get("id"))] = v
        return out, blank

    def lineups(self, s: int, w: int) -> tuple[dict, dict, list]:
        """{pid: (fid, status)}, {fid: players listed}, conflicts. Doubleheader
        seasons list a franchise in two matchups; that is the same lineup."""
        d = self.c.get(s, {"TYPE": "weeklyResults", "L": league_id(s), "W": str(w),
                           "MISSING_AS_BYE": "1"})["weeklyResults"]
        lineup, size, conflicts = {}, {}, []
        frs = [fr for m in as_list(d.get("matchup")) for fr in as_list(m.get("franchise"))]
        frs += as_list(d.get("franchise"))
        for fr in frs:
            if str(fr.get("id", "")).upper() == "BYE":
                continue
            fid = pad4(fr.get("id"))
            players = as_list(fr.get("player"))
            size[fid] = max(size.get(fid, 0), len(players))
            for p in players:
                pid, st = str(p.get("id")), str(p.get("status") or "").strip()
                if pid in lineup and lineup[pid] != (fid, st):
                    conflicts.append((pid, lineup[pid], (fid, st)))
                lineup[pid] = (fid, st)
        return lineup, size, conflicts

    def rosters(self, s: int, w: int) -> dict:
        d = self.c.get(s, {"TYPE": "rosters", "L": league_id(s), "W": str(w)})["rosters"]
        return {str(p.get("id")): (pad4(fr.get("id")), str(p.get("status") or ""))
                for fr in as_list(d.get("franchise")) for p in as_list(fr.get("player"))}


# ──────────────────────────────────────────────────────────────────────
# Production D1 READ (opt-in, budget-guarded)
# ──────────────────────────────────────────────────────────────────────

D1_DB = "ups-mfl-db"
D1_OPT_IN_ENV = "UPS_ALLOW_PROD_D1_READS"


def d1_read_plan() -> list[tuple[str, str]]:
    """The complete, fixed list of production reads. Each data query is keyed on
    an indexed prefix; the guard refuses any query whose plan SCANs a table."""
    q: list[tuple[str, str]] = [(
        "schema",
        "SELECT type, name, tbl_name, sql FROM sqlite_master "
        "WHERE tbl_name IN ('src_weekly','src_pointssummary','player_season_wc_rank')",
    )]
    for s in SEASONS:
        last_reg, _ = canon_weeks(s)
        q.append((f"playoff_{s}", f"SELECT * FROM src_weekly WHERE season = {s} AND week > {last_reg}"))
    for s in SEASONS:
        last_reg, _ = canon_weeks(s)
        weeks = [1, last_reg] if s in (2011, 2012, 2020) else [last_reg]
        for w in weeks:
            q.append((f"sample_{s}_w{w}", f"SELECT * FROM src_weekly WHERE season = {s} AND week = {w}"))
    for s in [2010] + SEASONS:
        q.append((f"pointssummary_{s}", f"SELECT * FROM src_pointssummary WHERE season = {s}"))
    ids = ",".join(f"'{p}'" for p in REP_PLAYERS)
    q.append(("rep_players", f"SELECT * FROM src_weekly WHERE player_id IN ({ids})"))
    q.append(("franchises", "SELECT season, franchise_id, team_name FROM src_franchises "
                            "WHERE season BETWEEN 2011 AND 2025"))
    return q


def wrangler_json(sql: str) -> list:
    if not re.match(r"^\s*(EXPLAIN QUERY PLAN\s+)?SELECT\b", sql, re.I):
        raise ValueError("extract-d1 only runs SELECT statements")
    res = subprocess.run(
        ["npx", "wrangler", "d1", "execute", D1_DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, cwd=str(REPO_ROOT / "worker"),
        env={**os.environ, "WRANGLER_SEND_METRICS": "false"},
    )
    if res.returncode != 0:
        raise RuntimeError(f"wrangler failed: {res.stderr[-800:]}")
    return json.loads(res.stdout)


def plan_is_indexed(plan_rows: list[dict]) -> tuple[bool, str]:
    """A SCAN of any data table -- even a covering-index scan -- reads every row."""
    text = " | ".join(str(r.get("detail", "")) for r in plan_rows)
    if re.search(r"\bSCAN (?!sqlite_master\b)", text) or "SEARCH" not in text:
        return False, text
    return True, text


def cmd_extract_d1(args, runner=wrangler_json) -> int:
    if not (args.allow_prod_d1 or os.environ.get(D1_OPT_IN_ENV) == "1"):
        print("SKIPPED: production D1 read not opted in (pass --allow-prod-d1). Nothing was read.")
        return 0
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    budget, spent, log = args.max_rows_read, 0, []
    for name, sql in d1_read_plan():
        dest = out / f"{name}.json"
        if dest.exists():
            prev = json.loads(dest.read_text())
            spent += prev.get("rows_read", 0)
            log.append({"name": name, "rows_read": prev.get("rows_read", 0), "read_at_utc": prev.get("read_at_utc")})
            continue
        if spent >= budget:
            print(f"STOP: budget of {budget} rows read reached ({spent}); {name} not read.")
            break
        if name != "schema":
            ok, text = plan_is_indexed(runner("EXPLAIN QUERY PLAN " + sql)[0].get("results", []))
            if not ok:
                print(f"REFUSED {name}: plan scans a table: {text}")
                return 2
        res = runner(sql)[0]
        rows_read = int((res.get("meta") or {}).get("rows_read") or 0)
        spent += rows_read
        at = utc_now()
        dest.write_text(json.dumps({"name": name, "sql": sql, "read_at_utc": at,
                                    "rows_read": rows_read, "rows": res.get("results", [])}))
        log.append({"name": name, "rows_read": rows_read, "rows": len(res.get("results", [])), "read_at_utc": at})
        print(f"  {name}: {len(res.get('results', []))} rows, rows_read={rows_read} (total {spent})", flush=True)
    (out / "_read_log.json").write_text(json.dumps({"total_rows_read": spent, "budget": budget,
                                                    "queries": log}, indent=1))
    print(f"production D1 rows_read total: {spent} (budget {budget})")
    return 0


# ──────────────────────────────────────────────────────────────────────
# Pure rules (unit-tested)
# ──────────────────────────────────────────────────────────────────────

ROSTER_EXPORT_CLASSES = ("taxi", "ir", "fa")


def export_is_weekly(lineup: dict, rosters: dict) -> bool:
    """MFL's rosters&W= export is retroactive for old seasons (it shows a later
    owner: 2011 player 6997 sat in 0001's lineups Wks 1-11 but the export puts
    him on 0006 all year). It can stand for that week only when it lists every
    lineup player on that same franchise."""
    return all(rosters.get(pid, ("",))[0] == fid for pid, (fid, _) in lineup.items())


def classify_week(pid: str, lineup: dict, lineup_size: dict, rosters: dict, weekly_export: bool) -> tuple:
    """classify(), except that taxi / IR / free agent -- which rest on the rosters
    export -- become unproven in a week where that export is not weekly."""
    status, fid, cls = classify(pid, lineup, lineup_size, rosters)
    if cls in ROSTER_EXPORT_CLASSES and not weekly_export:
        return None, None, f"unproven_{cls}_rosters_export_not_weekly"
    return status, fid, cls


def classify(pid: str, lineup: dict, lineup_size: dict, rosters: dict) -> tuple:
    """(status, roster_franchise_id, provenance class); status None = unresolved."""
    if pid in lineup:
        fid, st = lineup[pid]
        if st in ("starter", "nonstarter"):
            return st, fid, "lineup"
        return None, fid, "unresolved_lineup_status"
    on = rosters.get(pid)
    if on is None:
        return "fa", "FA", "fa"
    fid, rstatus = on
    if rstatus == "TAXI_SQUAD":
        return "nonstarter", fid, "taxi"
    if rstatus == "INJURED_RESERVE":
        return "nonstarter", fid, "ir"
    if not lineup_size.get(fid):
        return None, fid, "unresolved_no_lineup"
    return None, fid, "unresolved_roster_not_in_lineup"


def _pid_order(pid: str):
    return (0, int(pid), "") if str(pid).isdigit() else (1, 0, str(pid))


def table_ranks(scores: dict, group_of: dict) -> tuple[dict, dict]:
    """src_weekly's own weekly rank rule, reproduced on every sampled D1 week:
    sequential 1,2,3,... by score desc, ties broken by NUMERIC player id; overall
    across every player MFL scored that week, and within pos_group (no group ->
    no pos rank). (/admin/backfill-playoff-weekly used 1,2,2,4 instead, so the
    2021-2025 playoff rows disagree with the rest of the table.)"""
    def rank(items):
        ordered = sorted(items, key=lambda x: (-x[1], _pid_order(x[0])))
        return {pid: i for i, (pid, _) in enumerate(ordered, start=1)}
    overall = rank(scores.items())
    by_group = defaultdict(list)
    for pid, sc in scores.items():
        g = group_of.get(pid)
        if g:
            by_group[g].append((pid, sc))
    pos = {}
    for items in by_group.values():
        pos.update(rank(items))
    return overall, pos


def dense_ranks(values: dict) -> dict:
    """DENSE rank, desc, on the exact value: src_pointssummary's rule (reproduces
    all 25,410 stored pos/overall points and PPG ranks, 2010-2025)."""
    out, prev, d = {}, object(), 0
    for k, v in sorted(values.items(), key=lambda x: -x[1]):
        if v != prev:
            d, prev = d + 1, v
        out[k] = d
    return out


def alltime_min_games(end_week: int) -> int:
    return math.ceil(ALLTIME_MIN_SHARE * end_week)


def row_tuple(r: dict) -> tuple:
    return tuple(r.get(c) for c in COLS)


def rows_fingerprint(rows: list[dict]) -> str:
    items = sorted("|".join(repr(r.get(c)) for c in COLS) for r in rows)
    return "v1:%d:%s" % (len(items), hashlib.sha256("\n".join(items).encode()).hexdigest())


def insert_statements(rows: list[dict]) -> list[str]:
    """The exact statements D1Writer would send: changed-only upserts, at most
    INSERT_CHUNK_ROWS rows and STATEMENT_BYTE_LIMIT bytes each."""
    out, i = [], 0
    while i < len(rows):
        n = min(INSERT_CHUNK_ROWS, len(rows) - i)
        while True:
            sql = build_insert(TABLE, COLS, [row_tuple(r) for r in rows[i:i + n]], pk_cols=PK, changed_only=True)
            if len(sql.encode()) <= STATEMENT_BYTE_LIMIT or n == 1:
                break
            n = max(1, n // 2)
        out.append(sql.strip())
        i += n
    return out


def delete_statements(rows: list[dict]) -> list[str]:
    """Rollback of inserted rows: delete exactly those keys, grouped by week."""
    by_week = defaultdict(list)
    for r in rows:
        by_week[(r["season"], r["week"])].append(r["player_id"])
    out = []
    for (s, w), pids in sorted(by_week.items()):
        pids = sorted(pids)
        for i in range(0, len(pids), DELETE_CHUNK_IDS):
            ids = ",".join(sql_escape(p) for p in pids[i:i + DELETE_CHUNK_IDS])
            out.append(f"DELETE FROM {TABLE} WHERE season = {int(s)} AND week = {int(w)} AND player_id IN ({ids});")
    return out


def _key_where(u: dict) -> str:
    return (f"season = {int(u['season'])} AND week = {int(u['week'])} "
            f"AND player_id = {sql_escape(u['player_id'])}")


def update_statements(updates: list[dict]) -> list[str]:
    """Forward UPDATE per row; the IS NOT guard makes a re-run write nothing."""
    out = []
    for u in updates:
        sets = ", ".join(f"{c} = {sql_escape(v)}" for c, v in sorted(u["new"].items()))
        diff = " OR ".join(f"{c} IS NOT {sql_escape(v)}" for c, v in sorted(u["new"].items()))
        out.append(f"UPDATE {TABLE} SET {sets} WHERE {_key_where(u)} AND ({diff});")
    return out


def restore_statements(updates: list[dict]) -> list[str]:
    """Rollback UPDATE per row: restores the before-image, only where the row
    still holds exactly the values the forward step wrote."""
    out = []
    for u in updates:
        sets = ", ".join(f"{c} = {sql_escape(u['old'][c])}" for c in sorted(u["new"]))
        same = " AND ".join(f"{c} IS {sql_escape(v)}" for c, v in sorted(u["new"].items()))
        out.append(f"UPDATE {TABLE} SET {sets} WHERE {_key_where(u)} AND {same};")
    return out


# ──────────────────────────────────────────────────────────────────────
# Inputs for the build
# ──────────────────────────────────────────────────────────────────────

class D1Snapshot:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.files = {p.stem: json.loads(p.read_text()) for p in self.root.glob("*.json")}
        if "schema" not in self.files:
            raise SystemExit(f"{root}: no schema.json -- run extract-d1 first")
        self.read_log = self.files.get("_read_log", {})
        self.playoff = {}
        for s in SEASONS:
            for r in self.files.get(f"playoff_{s}", {}).get("rows", []):
                self.playoff[(r["season"], r["week"], str(r["player_id"]))] = r
        self.samples = {}
        for name, f in self.files.items():
            m = re.match(r"sample_(\d+)_w(\d+)$", name)
            if m:
                self.samples[(int(m.group(1)), int(m.group(2)))] = {str(r["player_id"]): r for r in f["rows"]}
        self.ps = {}
        for name, f in self.files.items():
            if name.startswith("pointssummary_"):
                for r in f["rows"]:
                    self.ps[(int(r["season"]), str(r["player_id"]))] = r
        self.rep = self.files.get("rep_players", {}).get("rows", [])
        self.franchise_names = {(int(r["season"]), pad4(r["franchise_id"])): r["team_name"]
                                for r in self.files.get("franchises", {}).get("rows", [])}
        self.schema = self.files["schema"]["rows"]


def load_archive_weekly(path: Path) -> tuple[dict, set]:
    """{(season, week, player_id): row dict} from the archive copy of the legacy
    weekly table, plus the keys that appear more than once there."""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    rows, dups = {}, set()
    q = ("SELECT season, week, CAST(player_id AS TEXT), pos_group, status, score, is_reg, "
         "roster_franchise_id, roster_franchise_name, pos_rank, overall_rank, win_chunks "
         "FROM player_weeklyscoringresults WHERE season BETWEEN 2010 AND 2025")
    for t in conn.execute(q):
        r = dict(zip(COLS, t))
        k = (r["season"], r["week"], r["player_id"])
        if k in rows:
            dups.add(k)
            continue
        rows[k] = r
    conn.close()
    return rows, dups


def same_value(a, b, col: str) -> bool:
    if a is None or b is None:
        return (a is None) == (b is None) or (col == "roster_franchise_name" and not a and not b)
    if col in ("score", "win_chunks"):
        return abs(float(a) - float(b)) < 1e-6
    if col in ("season", "week", "is_reg", "pos_rank", "overall_rank"):
        return int(a) == int(b)
    return str(a) == str(b)


# ──────────────────────────────────────────────────────────────────────
# build
# ──────────────────────────────────────────────────────────────────────

def write_jsonl(path: Path, rows: list) -> None:
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True) + "\n")


def cmd_build(args) -> int:
    mfl = MflData(MflCache(Path(args.cache), offline=True))
    d1 = D1Snapshot(Path(args.d1))
    arc, arc_dups = load_archive_weekly(Path(args.archive))
    arc_by_week = defaultdict(dict)
    for k, v in arc.items():
        arc_by_week[(k[0], k[1])][k[2]] = v
    out = Path(args.out)
    for sub in ("proposed", "sql", "statements"):
        (out / sub).mkdir(parents=True, exist_ok=True)

    rep = {"generated_at_utc": utc_now(), "checks": {}, "seasons": {}, "phases": {},
           "unresolved": [], "sources": {}}
    checks = rep["checks"]

    # ── Check 1: the archive equals D1 on every sampled week (else refuse) ──
    c1 = {"weeks": 0, "rows": 0, "mismatched_cells": 0, "missing": 0, "extra": 0}
    for (s, w), d1rows in sorted(d1.samples.items()):
        c1["weeks"] += 1
        arows = arc_by_week.get((s, w), {})
        c1["missing"] += len(set(d1rows) - set(arows))
        c1["extra"] += len(set(arows) - set(d1rows))
        for pid, r in d1rows.items():
            c1["rows"] += 1
            a = arows.get(pid)
            if a and not all(same_value(r[c], a[c], c) for c in COLS):
                c1["mismatched_cells"] += 1
    c1["ok"] = c1["mismatched_cells"] == 0 and c1["missing"] == 0 and c1["extra"] == 0
    checks["archive_equals_d1_on_samples"] = c1
    # The rank rule new rows use must reproduce the stored ranks of real weeks.
    c5 = Counter()
    for (s, w), d1rows in sorted(d1.samples.items()):
        sc = {pid: r["score"] for pid, r in d1rows.items() if r["score"] is not None}
        overall, posr = table_ranks(sc, {pid: r["pos_group"] for pid, r in d1rows.items()})
        for pid, r in d1rows.items():
            c5["overall_match" if r["overall_rank"] == overall.get(pid) else "overall_differs"] += 1
            c5["pos_match" if r["pos_rank"] == posr.get(pid) else "pos_differs"] += 1
    checks["table_rank_rule_reproduces_d1_sample_weeks"] = dict(c5)
    if not c1["ok"]:
        print(json.dumps(c1))
        raise SystemExit("REFUSED: the archive is not an exact stand-in for D1 on the sampled weeks")

    phase_rows = {"A": [], "B": []}
    phase_updates = {"C": [], "E": []}
    before_rows: dict = {}          # the local before-state for every touched key
    totals = {"before": defaultdict(lambda: [0.0, 0]), "after": defaultdict(lambda: [0.0, 0]),
              "mfl": defaultdict(lambda: [0.0, 0])}
    pos_of_ps = {}                  # (season, pid) -> src_weekly pos_group after the repair
    names_of = {}
    unresolved = rep["unresolved"]
    blank_rows = []

    for s in SEASONS:
        meta = mfl.meta(s)
        last_reg, end = canon_weeks(s)
        sres = {"mfl_last_regular_week": meta["last_reg"], "mfl_end_week": meta["end_week"],
                "canon_matches_mfl": (meta["last_reg"], meta["end_week"]) == (last_reg, end)}
        rep["seasons"][s] = sres
        if not sres["canon_matches_mfl"]:
            raise SystemExit(f"REFUSED: {s} MFL weeks {meta['last_reg']}/{meta['end_week']} != canon {last_reg}/{end}")
        players = mfl.players(s)
        names_of.update({pid: p["name"] for pid, p in players.items()})

        # The current table for season s: regular weeks from the archive stand-in,
        # playoff weeks from the D1 snapshot.
        cur = {(s, w, pid): v for w in range(1, last_reg + 1) for pid, v in arc_by_week.get((s, w), {}).items()}
        cur.update({k: v for k, v in d1.playoff.items() if k[0] == s})
        existing_pg = defaultdict(Counter)
        existing_name = defaultdict(Counter)
        for (_, _, pid), r in cur.items():
            if r["pos_group"]:
                existing_pg[pid][r["pos_group"]] += 1
            if r["roster_franchise_id"] not in (None, "FA") and r["roster_franchise_name"]:
                existing_name[r["roster_franchise_id"]][r["roster_franchise_name"]] += 1

        def name_for(fid):
            """(name, source): the name src_weekly already uses for this franchise
            this season, else src_franchises, else MFL's league export."""
            if fid == "FA":
                return "Free Agent", "fixed"
            if existing_name.get(fid):
                return existing_name[fid].most_common(1)[0][0], "src_weekly"
            if (s, fid) in d1.franchise_names:
                return d1.franchise_names[(s, fid)], "src_franchises"
            return meta["names"].get(fid) or fid, "mfl_league"

        pg_src = Counter()
        pg_disagree = []
        legacy_vocab = any("CB+S" in c or "DT+DE" in c for c in existing_pg.values())

        def pos_group_for(pid):
            mfl_g = POSMAP.get(players.get(pid, {}).get("position", ""))
            if legacy_vocab and mfl_g:
                mfl_g = LEGACY_IDP_NAMES.get(mfl_g, mfl_g)
            if existing_pg.get(pid):
                g = existing_pg[pid].most_common(1)[0][0]
                pg_src["src_weekly_same_season"] += 1
                if mfl_g and mfl_g != g:
                    pg_disagree.append({"season": s, "player_id": pid, "src_weekly": g, "mfl_players": mfl_g})
                return g
            pg_src["mfl_players_export" if mfl_g else "none"] += 1
            return mfl_g

        # ── Regular weeks: table vs MFL (scores), the before/after totals ──
        reg_check = {"rows": 0, "missing": 0, "extra": 0, "score_diff": 0}
        for w in range(1, end + 1):
            sc, blank = mfl.scores(s, w)
            for pid, v in sc.items():
                t = totals["mfl"][(s, pid)]
                t[0] += v
                t[1] += 1
            if w <= last_reg:
                table = {k[2]: r for k, r in cur.items() if k[1] == w}
                reg_check["rows"] += len(table)
                reg_check["missing"] += len(set(sc) - set(table))
                reg_check["extra"] += len(set(table) - set(sc))
                reg_check["score_diff"] += sum(1 for pid, r in table.items()
                                               if pid in sc and r["score"] is not None and abs(r["score"] - sc[pid]) > 1e-6)
        sres["regular_weeks_vs_mfl"] = reg_check

        for (_, w, pid), r in cur.items():
            if r["score"] is not None:
                for k in ("before", "after"):
                    t = totals[k][(s, pid)]
                    t[0] += r["score"]
                    t[1] += 1
            if r["pos_group"]:
                pos_of_ps[(s, pid)] = min(r["pos_group"], pos_of_ps.get((s, pid), r["pos_group"]))

        # ── Playoff weeks: phases A / B / C ──
        sres["playoff_weeks"] = {}
        for w in range(last_reg + 1, end + 1):
            sc, blank = mfl.scores(s, w)
            lineup, size, conflicts = mfl.lineups(s, w)
            ros = mfl.rosters(s, w)
            existing = {k[2]: r for k, r in cur.items() if k[1] == w}
            # MFL's rosters&W= export is a true weekly snapshot only when it lists
            # every lineup player on that same franchise (2018+ always; 2011-2017
            # often not). Only then does "on no roster" prove a free agent.
            export_ok = export_is_weekly(lineup, ros)
            group_of = {}
            new_rows = []
            cls_count = Counter()
            for pid in sc:
                if pid in existing:
                    group_of[pid] = existing[pid]["pos_group"] or pos_group_for(pid)
                    continue
                status, fid, cls = classify_week(pid, lineup, size, ros, export_ok)
                cls_count[cls] += 1
                g = pos_group_for(pid)
                group_of[pid] = g
                if status is None:
                    # Never a guess. 'null' writes the score with status NULL and the
                    # franchise only where a consistent export proves it; 'hold'
                    # writes nothing; 'sync' is the live sync's rule ('fa').
                    keep_fid = fid if (cls == "unresolved_no_lineup" and export_ok) else None
                    unresolved.append({"phase": "A" if s <= 2020 else "B", "season": s, "week": w,
                                       "player_id": pid, "class": cls, "export_franchise_id": fid,
                                       "score": sc[pid], "policy": args.unproven})
                    if args.unproven == "hold":
                        continue
                    if args.unproven == "sync":
                        status, fid = "fa", "FA"
                    else:
                        fid = keep_fid
                name, name_src = name_for(fid) if fid else (None, "none")
                new_rows.append({"season": s, "week": w, "player_id": pid, "pos_group": g,
                                 "status": status, "score": sc[pid], "is_reg": 0,
                                 "roster_franchise_id": fid, "roster_franchise_name": name,
                                 "pos_rank": None, "overall_rank": None, "win_chunks": None,
                                 "_class": cls, "_name_source": name_src})
            overall, posr = table_ranks(sc, group_of)
            for r in new_rows:
                # --weekly-ranks null: a tie's order is a definition still under review,
                # so the score rows go in without weekly ranks (filled later, 1 write/row).
                r["overall_rank"] = overall[r["player_id"]] if args.weekly_ranks == "table" else None
                r["pos_rank"] = posr.get(r["player_id"]) if args.weekly_ranks == "table" else None
                t = totals["after"][(s, r["player_id"])]
                t[0] += r["score"]
                t[1] += 1
                if r["pos_group"]:  # the player card groups a season by MIN(pos_group)
                    k = (s, r["player_id"])
                    pos_of_ps[k] = min(r["pos_group"], pos_of_ps.get(k, r["pos_group"]))
            phase_rows["A" if s <= 2020 else "B"].extend(new_rows)

            # Existing rows (2021-2025): what MFL says now.
            wk_c = Counter()
            for pid, r in existing.items():
                new = {}
                if pid in sc:
                    if r["score"] is None or abs(r["score"] - sc[pid]) > 1e-6:
                        new["score"] = sc[pid]
                    if r["overall_rank"] != overall[pid]:
                        new["overall_rank"] = overall[pid]
                    if r["pos_rank"] != posr.get(pid):
                        new["pos_rank"] = posr.get(pid)
                else:
                    blank_rows.append({"season": s, "week": w, "player_id": pid, "status": r["status"],
                                       "stored_score": r["score"], "mfl_has_score": False})
                if r["pos_group"] is None and group_of.get(pid):
                    new["pos_group"] = group_of[pid]
                lst = lineup.get(pid)
                if not lst:
                    wk_c["existing_row_not_in_lineup"] += 1
                elif (r["status"], r["roster_franchise_id"]) != (lst[1], lst[0]):
                    wk_c["status_differs_from_lineup"] += 1
                if new:
                    old = {c: r[c] for c in new}
                    phase_updates["C"].append({"season": s, "week": w, "player_id": pid, "old": old, "new": new})
                    for c in new:
                        wk_c[f"update_{c}"] += 1
                    if "score" in new:
                        t = totals["after"][(s, pid)]
                        t[0] += new["score"] - (r["score"] or 0)
                        t[1] += 0 if r["score"] is not None else 1
                    before_rows[(s, w, pid)] = r
            # Cross-check (validation only): the legacy table's own copy of this week.
            arc_wk = arc_by_week.get((s, w), {})
            xc = Counter()
            xc["mfl_not_in_archive"] = len(set(sc) - set(arc_wk))
            xc["archive_not_in_mfl"] = len(set(arc_wk) - set(sc))
            xc["score_differs_from_archive"] = sum(1 for pid, v in sc.items() if pid in arc_wk and (
                arc_wk[pid]["score"] is None or abs(arc_wk[pid]["score"] - v) > 1e-6))
            for r in new_rows:
                a = arc_wk.get(r["player_id"])
                if a is None:
                    continue
                if a["win_chunks"] is not None:
                    xc["new_row_has_legacy_win_chunks"] += 1
                xc["rank_equals_legacy" if (a["overall_rank"], a["pos_rank"]) == (r["overall_rank"], r["pos_rank"])
                   else "rank_differs_from_legacy"] += 1
                if a["status"] != "fa" or r["status"] != "fa":
                    xc[f"legacy_{a['status']}_vs_proposed_{r['status']}"] += 1
            for u in unresolved:
                if (u["season"], u.get("week")) == (s, w) and u["phase"] in ("A", "B"):
                    a = arc_wk.get(u["player_id"])
                    xc[f"unresolved_legacy_{a['status'] if a else 'absent'}"] += 1
            ros_lineup_fit = sum(1 for pid, (fid, _) in lineup.items() if ros.get(pid, ("",))[0] == fid)
            sres["playoff_weeks"][w] = {
                "mfl_scored": len(sc), "mfl_blank_scores": blank, "existing_rows": len(existing),
                "existing_null_score": sum(1 for r in existing.values() if r["score"] is None),
                "proposed_inserts": len(new_rows), "classes": dict(cls_count),
                "lineup_players": len(lineup), "lineup_conflicts": len(conflicts),
                "franchises_with_empty_lineup": sorted(f for f, n in size.items() if n == 0),
                "rosters_export_consistent": export_ok,
                "lineup_players_on_same_franchise_roster_export": ros_lineup_fit,
                "existing_row_checks": dict(wk_c),
                "archive_cross_check": dict(xc),
            }

        # ── Phase E: regular-season status / ownership (2011-2020) ──
        if s in STATUS_SEASONS and all(
                mfl.c.has(s, {"TYPE": "weeklyResults", "L": league_id(s), "W": str(w), "MISSING_AS_BYE": "1"})
                and mfl.c.has(s, {"TYPE": "rosters", "L": league_id(s), "W": str(w)})
                for w in range(1, last_reg + 1)):
            e_c = Counter()
            fit = [0, 0]
            for w in range(1, last_reg + 1):
                lineup, size, conflicts = mfl.lineups(s, w)
                ros = mfl.rosters(s, w)
                weekly = export_is_weekly(lineup, ros)
                fit[0] += sum(1 for pid, (fid, _) in lineup.items() if ros.get(pid, ("",))[0] == fid)
                fit[1] += len(lineup)
                e_c["weeks_rosters_export_weekly" if weekly else "weeks_rosters_export_not_weekly"] += 1
                for (_, _, pid), r in sorted((k, v) for k, v in cur.items() if k[1] == w):
                    status, fid, cls = classify_week(pid, lineup, size, ros, weekly)
                    if cls.startswith("unproven_fa") and r["status"] == "fa":
                        e_c["unchanged"] += 1  # 'fa' today, and MFL cannot say otherwise
                        e_c[f"class_{cls}"] += 1
                        continue
                    if cls == "lineup" and r["roster_franchise_id"] not in (None, "FA", fid):
                        cls = "lineup_corrects_franchise"
                    if cls in ("fa", "unproven_fa_rosters_export_not_weekly") and r["status"] != "fa":
                        # The legacy row is attributed but MFL's lineup record does not
                        # list the player: never downgrade on an absence.
                        status, cls = None, "conflict_attributed_but_not_in_mfl_lineup"
                    e_c[f"class_{cls}"] += 1
                    if cls == "fa":
                        e_c["unchanged"] += 1
                        continue
                    if status is None:
                        e_c["unresolved_kept_as_is"] += 1
                        if s != 2020:
                            unresolved.append({"phase": "E", "season": s, "week": w, "player_id": pid,
                                               "class": cls, "roster_franchise_id": fid,
                                               "current_status": r["status"]})
                        continue
                    name, _ = name_for(fid)
                    new = {}
                    if r["status"] != status:
                        new["status"] = status
                    if r["roster_franchise_id"] != fid:
                        new["roster_franchise_id"] = fid
                    if (r["roster_franchise_name"] or None) != name:
                        new["roster_franchise_name"] = name
                    if not new:
                        e_c["unchanged"] += 1
                        continue
                    e_c[f"{r['status']}->{status}"] += 1
                    if s == 2020:
                        continue  # calibration only: 2020 is already attributed
                    phase_updates["E"].append({"season": s, "week": w, "player_id": pid,
                                               "old": {c: r[c] for c in new}, "new": new, "class": cls})
                    before_rows[(s, w, pid)] = r
            sres["regular_status_check"] = dict(e_c)
            sres["regular_lineup_players_on_same_franchise_roster_export"] = fit
        sres["pos_group_vocabulary"] = "CB+S/DT+DE" if legacy_vocab else "DB/DL"
        sres["pos_group_sources"] = dict(pg_src)
        sres["pos_group_disagreements"] = len(pg_disagree)
        rep.setdefault("pos_group_disagreements", []).extend(pg_disagree[:50])

    # Every existing row in a touched playoff week belongs to the local before-state.
    for k, r in d1.playoff.items():
        before_rows.setdefault(k, r)

    # ── Write phase files, SQL and statements ──
    fp = {}
    for ph, rows in phase_rows.items():
        for s in sorted({r["season"] for r in rows}):
            rs = sorted((r for r in rows if r["season"] == s), key=lambda r: (r["week"], r["player_id"]))
            write_jsonl(out / "proposed" / f"{ph}_{s}.jsonl", rs)
            clean = [{c: r[c] for c in COLS} for r in rs]
            fwd, back = insert_statements(clean), delete_statements(clean)
            (out / "sql" / f"{ph}_{s}.sql").write_text("\n".join(fwd) + "\n")
            (out / "sql" / f"{ph}_{s}.rollback.sql").write_text("\n".join(back) + "\n")
            (out / "statements" / f"{ph}_{s}.json").write_text(json.dumps({"forward": fwd, "rollback": back}))
            fp[f"{ph}_{s}"] = rows_fingerprint(clean)
    for ph, ups in phase_updates.items():
        for s in sorted({u["season"] for u in ups}):
            us = sorted((u for u in ups if u["season"] == s), key=lambda u: (u["week"], u["player_id"]))
            write_jsonl(out / "proposed" / f"{ph}_{s}.jsonl", us)
            fwd, back = update_statements(us), restore_statements(us)
            (out / "sql" / f"{ph}_{s}.sql").write_text("\n".join(fwd) + "\n")
            (out / "sql" / f"{ph}_{s}.rollback.sql").write_text("\n".join(back) + "\n")
            (out / "statements" / f"{ph}_{s}.json").write_text(json.dumps({"forward": fwd, "rollback": back}))
            fp[f"{ph}_{s}"] = "v1:%d:%s" % (len(us), hashlib.sha256(
                "\n".join(json.dumps(u, sort_keys=True) for u in us).encode()).hexdigest())
    write_jsonl(out / "before_rows.jsonl", [before_rows[k] for k in sorted(before_rows)])
    (out / "schema.json").write_text(json.dumps([r for r in d1.schema if r["tbl_name"] == TABLE]))
    write_jsonl(out / "unresolved.jsonl", unresolved)
    write_jsonl(out / "blank_score_rows.jsonl", blank_rows)

    # ── Phase summaries ──
    for ph, rows in phase_rows.items():
        by = defaultdict(Counter)
        for r in rows:
            by[(r["season"], r["week"])][f"{r['_class']}:{r['status']}"] += 1
        rep["phases"][ph] = {
            "rows": len(rows),
            "by_season_week": {f"{s}-W{w}": dict(c) for (s, w), c in sorted(by.items())},
            "by_class": dict(Counter(r["_class"] for r in rows)),
            "by_status": dict(Counter(r["status"] for r in rows)),
            "name_sources": dict(Counter(r["_name_source"] for r in rows)),
            "null_pos_group": sum(1 for r in rows if r["pos_group"] is None),
            "null_pos_rank": sum(1 for r in rows if r["pos_rank"] is None),
        }
    for ph, ups in phase_updates.items():
        rep["phases"][ph] = {
            "rows": len(ups),
            "by_season": dict(Counter(u["season"] for u in ups)),
            "by_column": dict(Counter(c for u in ups for c in u["new"])),
            "by_change": dict(Counter(f"{u['old'].get('status')}->{u['new'].get('status')}"
                                      for u in ups if "status" in u["new"])),
            "by_class": dict(Counter(u.get("class") for u in ups if u.get("class"))),
        }
    rep["unresolved_summary"] = dict(Counter(f"{u['phase']} {u['class']}" for u in unresolved))
    rep["unresolved_by_season"] = dict(Counter(f"{u['phase']} {u['season']}" for u in unresolved))
    rep["blank_score_rows"] = {"rows": len(blank_rows),
                               "by_season": dict(Counter(r["season"] for r in blank_rows))}
    rep["fingerprints"] = fp
    rep["archive_duplicate_keys"] = len(arc_dups)
    rep["archive_duplicate_player_seasons"] = sorted({f"{k[0]}:{k[2]}" for k in arc_dups})

    man = []
    if (Path(args.cache) / "manifest.jsonl").exists():
        man = [json.loads(line) for line in open(Path(args.cache) / "manifest.jsonl")]
    reads = [q.get("read_at_utc") for q in d1.read_log.get("queries", []) if q.get("read_at_utc")]
    rep["sources"] = {
        "mfl_replies_cached": len(list(Path(args.cache).glob("*.json"))),
        "mfl_fetched_first_utc": min((m["fetched_at_utc"] for m in man), default=None),
        "mfl_fetched_last_utc": max((m["fetched_at_utc"] for m in man), default=None),
        "d1_rows_read_total": d1.read_log.get("total_rows_read"),
        "d1_read_first_utc": min(reads, default=None), "d1_read_last_utc": max(reads, default=None),
        "archive": Path(args.archive).name, "unproven_policy": args.unproven,
    }
    reconcile(rep, d1, mfl, totals, pos_of_ps, names_of, arc_dups)
    (out / "reconciliation.json").write_text(json.dumps(rep, indent=1, default=str))
    print(json.dumps({"A": rep["phases"]["A"]["rows"], "B": rep["phases"]["B"]["rows"],
                      "C": rep["phases"]["C"]["rows"], "E": rep["phases"]["E"]["rows"],
                      "unresolved": len(unresolved), "out": str(out)}))
    return 0


def reconcile(rep, d1, mfl, totals, pos_of_ps, names_of, arc_dups) -> None:
    """src_pointssummary (the card's rank source) vs the weekly table, before and
    after the repair; true ranks; MFL YTD; the proposed all-time rank."""
    dup_ps = {(k[0], k[2]) for k in arc_dups}
    seasons = defaultdict(Counter)
    examples = defaultdict(list)
    for (s, pid), p in sorted(d1.ps.items()):
        if s not in SEASONS:
            continue
        basis = (float(p["points_total"] or 0), int(p["games_played"] or 0))
        for k in ("before", "after"):
            pts, g = totals[k].get((s, pid), (0.0, 0))
            shown = abs(basis[0] - round(pts, 1)) < 0.05 and basis[1] == g
            seasons[s][f"rank_shown_{k}"] += shown
            # #1353 shows the PPG rank only with at least half the season's UPS weeks.
            seasons[s][f"ppg_rank_shown_{k}"] += shown and g >= math.ceil(canon_weeks(s)[1] / 2)
            if k == "after" and not shown:
                mt = totals["mfl"].get((s, pid), (0.0, 0))
                why = ("duplicate_rows_in_legacy_table" if (s, pid) in dup_ps
                       else "mfl_total_differs_from_rank_basis" if abs(mt[0] - basis[0]) >= 0.05 or mt[1] != basis[1]
                       else "other")
                seasons[s][f"after_mismatch_{why}"] += 1
                if len(examples[why]) < 12:
                    examples[why].append({"season": s, "player_id": pid, "name": names_of.get(pid),
                                          "rank_basis": [round(basis[0], 2), basis[1]],
                                          "after": [round(pts, 2), g], "mfl": [round(mt[0], 2), mt[1]]})
        seasons[s]["pointssummary_rows"] += 1

    # Clean recompute: the stored rule (dense, every player in the table that
    # season, no minimum) on values rounded to 4 dp, so float noise cannot split a
    # tie. Stored ranks used unrounded sums, so they differ from a clean rank in
    # two ways: float noise (clean rank of the STORED totals already differs) and
    # real drift (another player's stored total is wrong, e.g. duplicate rows).
    def clean(group_vals):
        return dense_ranks({k: round(v, 4) for k, v in group_vals.items()})
    true_rank = {}
    drift = Counter()
    for s in SEASONS:
        grp, grp_ppg, st, st_ppg = (defaultdict(dict) for _ in range(4))
        for (ss, pid), p in d1.ps.items():
            if ss != s:
                continue
            pts, g = totals["mfl"].get((s, pid), (0.0, 0))
            gn = p["positional_grouping"]
            grp[gn][pid] = round(pts, 4)
            grp_ppg[gn][pid] = round(pts, 4) / g if g else 0.0
            st[gn][pid] = float(p["points_total"] or 0)
            st_ppg[gn][pid] = float(p["ppg"] or 0)
        clean_stored = {}
        for gname in grp:
            a, b = clean(grp[gname]), clean(grp_ppg[gname])
            c, d = clean(st[gname]), clean(st_ppg[gname])
            for pid in grp[gname]:
                true_rank[(s, pid)] = (a[pid], b[pid])
                clean_stored[pid] = (c[pid], d[pid])
        for (ss, pid), p in d1.ps.items():
            if ss != s or (s, pid) not in true_rank:
                continue
            pts, g = totals["after"].get((s, pid), (0.0, 0))
            shown = abs(float(p["points_total"] or 0) - round(pts, 1)) < 0.05 and int(p["games_played"] or 0) == g
            stored = (int(p["pos_rank"] or 0), int(p["pos_ppg_rank"] or 0))
            if not shown or stored == true_rank[(s, pid)]:
                continue
            seasons[s]["after_shown_but_rank_differs_from_mfl_recompute"] += 1
            why = "real_drift" if clean_stored[pid] != true_rank[(s, pid)] else "float_noise_only"
            seasons[s][f"after_shown_rank_differs_{why}"] += 1
            for i, lab in ((0, "pts"), (1, "ppg")):
                drift[f"{why}_{lab}_off_by_{min(abs(stored[i] - true_rank[(s, pid)][i]), 5)}{'+' if abs(stored[i] - true_rank[(s, pid)][i]) >= 5 else ''}"] += 1
    rep["pointssummary"] = {"by_season": {s: dict(c) for s, c in sorted(seasons.items())},
                            "shown_but_stale_rank_offsets": dict(drift),
                            "examples": dict(examples),
                            "rule": "DENSE rank on exact points_total / ppg within (season, positional_grouping); "
                                    "population = every player in src_pointssummary that season; no games minimum; "
                                    "weeks = 1 .. last UPS week (playoffs included)"}

    # MFL W=YTD vs the per-week sum.
    ytd_c = {}
    for s in SEASONS:
        _, end = canon_weeks(s)
        ytd, _ = mfl.scores(s, "YTD")
        c = Counter()
        for pid in set(ytd) | {k[1] for k in totals["mfl"] if k[0] == s}:
            a = ytd.get(pid)
            b = totals["mfl"].get((s, pid), (None, 0))[0]
            c["match" if a is not None and b is not None and abs(a - b) < 0.05 else
              ("ytd_only" if b is None or (s, pid) not in totals["mfl"] else
               "weekly_only" if a is None else "differs")] += 1
            aft = totals["after"].get((s, pid))
            if a is not None and aft is not None:
                c["after_matches_ytd" if abs(aft[0] - a) < 0.05 else "after_differs_from_ytd"] += 1
        ytd_c[s] = dict(c)
    rep["mfl_ytd_vs_weekly"] = ytd_c

    # Representative players.
    reps = {}
    d1_rep = defaultdict(lambda: [0.0, 0])
    for r in d1.rep:
        if r["score"] is not None:
            t = d1_rep[(int(r["season"]), str(r["player_id"]))]
            t[0] += r["score"]
            t[1] += 1
    for pid, nm in REP_PLAYERS.items():
        rows = []
        for s in SEASONS:
            p = d1.ps.get((s, pid))
            b, a = totals["before"].get((s, pid)), totals["after"].get((s, pid))
            if not p and not b:
                continue
            live = d1_rep.get((s, pid))
            rows.append({
                "season": s,
                "d1_today": [round(live[0], 1), live[1]] if live else None,
                "before": [round(b[0], 1), b[1]] if b else None,
                "after": [round(a[0], 1), a[1]] if a else None,
                "rank_basis": [round(float(p["points_total"]), 1), int(p["games_played"])] if p else None,
                "pos_rank": p and p["pos_rank"], "pos_ppg_rank": p and p["pos_ppg_rank"],
                "true_rank": true_rank.get((s, pid)),
                "mfl_ytd": round(mfl.scores(s, "YTD")[0].get(pid, 0.0), 1),
            })
        reps[pid] = {"name": nm, "seasons": rows}
    rep["representative_players"] = reps
    rep["before_proxy_matches_d1_for_rep_players"] = all(
        (round(totals["before"][k][0], 1), totals["before"][k][1]) == (round(v[0], 1), v[1])
        for k, v in d1_rep.items() if k[0] in SEASONS)

    # Proposed all-time positional season rank.
    entries = {"before": [], "after": []}
    for k in ("before", "after"):
        for (s, pid), (pts, g) in totals[k].items():
            if s not in SEASONS or g == 0:
                continue
            _, end = canon_weeks(s)
            if g >= alltime_min_games(end):
                g_now = pos_of_ps.get((s, pid))
                modern = {v: k2 for k2, v in LEGACY_IDP_NAMES.items()}  # one vocabulary across eras
                entries[k].append({"season": s, "player_id": pid, "pos_group": modern.get(g_now, g_now),
                                   "pts": round(pts, 1), "games": g, "ppg": round(round(pts, 4) / g, 6)})
    board = {}
    for k, lst in entries.items():
        by = defaultdict(list)
        for e in lst:
            by[e["pos_group"]].append(e)
        out = {}
        for g, es in by.items():
            es.sort(key=lambda e: (-e["ppg"], e["season"], e["player_id"]))
            prev, r = None, 0
            for i, e in enumerate(es, 1):
                if e["ppg"] != prev:
                    r, prev = i, e["ppg"]
                e["rank"] = r
            out[g] = es
        board[k] = out
    def key(e):
        return (e["season"], e["player_id"])
    summary = {}
    for g in sorted(board["after"], key=str):
        aft = board["after"][g]
        bef = {key(e): e["rank"] for e in board["before"].get(g, [])}
        top = [e for e in aft if e["rank"] <= ALLTIME_TOP]
        summary[str(g)] = {
            "eligible_after": len(aft), "eligible_before": len(bef),
            "top100_changed_vs_before": sum(1 for e in top if bef.get(key(e)) != e["rank"]),
            "top5": [{"season": e["season"], "player_id": e["player_id"], "name": names_of.get(e["player_id"]),
                      "ppg": round(e["ppg"], 2), "games": e["games"], "rank": e["rank"]} for e in aft[:5]],
        }
    rep["alltime_rank_proposal"] = {
        "definition": f"completed seasons 2011-2025; PPG = all MFL points over every UPS week / weeks with a "
                      f"posted score; eligible when weeks scored >= ceil({ALLTIME_MIN_SHARE} x the season's UPS "
                      f"weeks) (12 of 16, 13 of 17); competition rank within src_weekly pos_group; top "
                      f"{ALLTIME_TOP} shown",
        "by_pos_group": summary,
        "rep_players": {pid: [{"season": e["season"], "ppg": round(e["ppg"], 2), "games": e["games"],
                               "rank": e["rank"], "pos_group": g}
                              for g, es in board["after"].items() for e in es if e["player_id"] == pid]
                        for pid in REP_PLAYERS},
    }


# ──────────────────────────────────────────────────────────────────────
# local-proof: forward twice + rollback on a LOCAL SQLite copy
# ──────────────────────────────────────────────────────────────────────

def table_hash(conn: sqlite3.Connection) -> tuple[int, str]:
    h = hashlib.sha256()
    n = 0
    for row in conn.execute(f"SELECT {', '.join(COLS)} FROM {TABLE} ORDER BY season, week, player_id"):
        h.update(repr(row).encode())
        n += 1
    return n, h.hexdigest()


def load_local(out: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    schema = json.loads((out / "schema.json").read_text())
    for r in sorted(schema, key=lambda r: r["type"] != "table"):
        if r["sql"]:
            conn.execute(r["sql"])
    if "win_chunks" not in [c[1] for c in conn.execute(f"PRAGMA table_info({TABLE})")]:
        conn.execute(f"ALTER TABLE {TABLE} ADD COLUMN win_chunks REAL")
    with open(out / "before_rows.jsonl") as f:
        rows = [json.loads(line) for line in f]
    conn.executemany(f"INSERT INTO {TABLE} ({', '.join(COLS)}) VALUES ({', '.join('?' * len(COLS))})",
                     [tuple(r.get(c) for c in COLS) for r in rows])
    conn.commit()
    return conn


def run_statements(conn: sqlite3.Connection, stmts: list[str]) -> int:
    before = conn.total_changes
    for st in stmts:
        conn.execute(st)
    conn.commit()
    return conn.total_changes - before


def cmd_local_proof(args) -> int:
    out = Path(args.out)
    files = sorted((out / "statements").glob("*.json"))
    phases = {p.stem: json.loads(p.read_text()) for p in files}
    order = sorted(phases, key=lambda n: ("ABCE".index(n[0]), n))
    conn = load_local(out)
    n0, h0 = table_hash(conn)
    proof = {"run_at_utc": utc_now(), "before": {"rows": n0, "sha256": h0}, "phases": {}}
    for name in order:
        proof["phases"][name] = {"forward_changes": run_statements(conn, phases[name]["forward"])}
    n1, h1 = table_hash(conn)
    proof["after_forward"] = {"rows": n1, "sha256": h1}
    for name in order:
        proof["phases"][name]["rerun_changes"] = run_statements(conn, phases[name]["forward"])
    n2, h2 = table_hash(conn)
    proof["after_rerun"] = {"rows": n2, "sha256": h2, "identical_to_after_forward": h2 == h1}
    expected = expected_after(out)
    proof["after_forward_equals_proposal"] = all(
        tuple(conn.execute(f"SELECT {', '.join(COLS)} FROM {TABLE} WHERE season=? AND week=? AND player_id=?",
                           (r["season"], r["week"], r["player_id"])).fetchone() or ()) == tuple(r[c] for c in COLS)
        for r in expected)
    for name in reversed(order):
        proof["phases"][name]["rollback_changes"] = run_statements(conn, phases[name]["rollback"])
    n3, h3 = table_hash(conn)
    proof["after_rollback"] = {"rows": n3, "sha256": h3, "identical_to_before": h3 == h0}
    proof["ok"] = (proof["after_rerun"]["identical_to_after_forward"]
                   and proof["after_rollback"]["identical_to_before"]
                   and proof["after_forward_equals_proposal"]
                   and all(p["rerun_changes"] == 0 for p in proof["phases"].values()))
    (out / "local_proof.json").write_text(json.dumps(proof, indent=1))
    print(json.dumps({k: proof[k] for k in ("before", "after_forward", "after_rerun", "after_rollback", "ok")}))
    return 0 if proof["ok"] else 1


def expected_after(out: Path) -> list[dict]:
    """Every row the proposal touches, as it should read after the forward run."""
    rows = []
    for p in sorted((out / "proposed").glob("*.jsonl")):
        with open(p) as f:
            for line in f:
                r = json.loads(line)
                if "new" in r:
                    continue
                rows.append({c: r[c] for c in COLS})
    before = {}
    with open(out / "before_rows.jsonl") as f:
        for line in f:
            r = json.loads(line)
            before[(r["season"], r["week"], r["player_id"])] = r
    for p in sorted((out / "proposed").glob("*.jsonl")):
        with open(p) as f:
            for line in f:
                u = json.loads(line)
                if "new" not in u:
                    continue
                r = dict(before[(u["season"], u["week"], u["player_id"])])
                r.update(u["new"])
                rows.append({c: r[c] for c in COLS})
    return rows


# ──────────────────────────────────────────────────────────────────────
# report: markdown tables from the build + proofs
# ──────────────────────────────────────────────────────────────────────

CLASS_COLS = [("lineup:starter", "Started"), ("lineup:nonstarter", "Bench"), ("taxi:nonstarter", "Taxi"),
              ("ir:nonstarter", "IR"), ("fa:fa", "FA")]


def md_table(head: list, rows: list) -> str:
    out = ["| " + " | ".join(str(h) for h in head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join("" if v is None else str(v) for v in r) + " |" for r in rows]
    return "\n".join(out)


def cmd_report(args) -> int:
    out = Path(args.out)
    rep = json.loads((out / "reconciliation.json").read_text())
    proof = json.loads((out / "local_proof.json").read_text()) if (out / "local_proof.json").exists() else None
    meas = json.loads((out / "d1_measure.json").read_text()) if (out / "d1_measure.json").exists() else None
    md = []

    # 1. rows proposed by season, week and source
    rows = []
    for ph in ("A", "B"):
        for sw, c in rep["phases"][ph]["by_season_week"].items():
            s, w = sw.split("-W")
            pw = rep["seasons"][s]["playoff_weeks"][w]
            known = sum(c.get(k, 0) for k, _ in CLASS_COLS)
            rows.append([s, w, ph, pw["mfl_scored"], pw["existing_rows"], sum(c.values())]
                        + [c.get(k, 0) for k, _ in CLASS_COLS] + [sum(c.values()) - known,
                        "yes" if pw.get("rosters_export_consistent") else "**no**"])
    md.append("### Rows proposed (inserts), by season and week\n")
    md.append(md_table(["Season", "Wk", "Phase", "MFL scored", "In D1 now", "Insert"]
                       + [h for _, h in CLASS_COLS] + ["Not recorded", "Rosters export = lineups"], rows))
    tot = Counter()
    for r in rows:
        tot[r[2]] += r[5]
    md.append(f"\nTotals: phase A {tot['A']:,} rows, phase B {tot['B']:,} rows.\n")

    # 2. updates
    for ph in ("C", "E"):
        pinfo = rep["phases"][ph]
        md.append(f"### Phase {ph} updates: {pinfo['rows']:,} rows\n")
        md.append(md_table(["Season", "Rows"], sorted(pinfo["by_season"].items())))
        md.append("\nColumns changed: " + ", ".join(f"{k} {v:,}" for k, v in sorted(pinfo["by_column"].items())))
        if pinfo.get("by_change"):
            md.append("\nStatus changes: " + ", ".join(f"{k} {v:,}" for k, v in sorted(pinfo["by_change"].items())))
        md.append("")

    # 3. representative players
    for pid, info in rep["representative_players"].items():
        md.append(f"### {info['name']} ({pid})\n")
        md.append(md_table(["Season", "D1 today pts / wks", "After pts / wks", "Rank basis pts / wks",
                            "Pts Rk", "PPG Rk", "Recomputed (Pts, PPG)", "MFL YTD"],
                           [[r["season"], r["d1_today"] and f"{r['d1_today'][0]} / {r['d1_today'][1]}",
                             r["after"] and f"{r['after'][0]} / {r['after'][1]}",
                             r["rank_basis"] and f"{r['rank_basis'][0]} / {r['rank_basis'][1]}",
                             r["pos_rank"], r["pos_ppg_rank"], r["true_rank"], r["mfl_ytd"]]
                            for r in info["seasons"]]))
        md.append("")

    # 4. pointssummary ranks shown before / after
    md.append("### Earlier-season ranks the player card can show (totals agree)\n")
    prs = []
    for s, c in sorted(rep["pointssummary"]["by_season"].items()):
        prs.append([s, c.get("pointssummary_rows", 0), c.get("rank_shown_before", 0), c.get("rank_shown_after", 0),
                    c.get("ppg_rank_shown_before", 0), c.get("ppg_rank_shown_after", 0),
                    c.get("after_mismatch_duplicate_rows_in_legacy_table", 0),
                    c.get("after_mismatch_mfl_total_differs_from_rank_basis", 0),
                    c.get("after_mismatch_other", 0),
                    c.get("after_shown_but_rank_differs_from_mfl_recompute", 0)])
    md.append(md_table(["Season", "Ranked rows", "Pts Rk shown today", "Pts Rk shown after", "PPG Rk today",
                        "PPG Rk after", "Still hidden: dup rows", "Still hidden: MFL total differs",
                        "Still hidden: other", "Shown but stale rank"], prs))
    md.append("")

    # 5. unresolved
    md.append("### Unresolved (never inferred)\n")
    md.append(md_table(["Phase and class", "Rows"], sorted(rep["unresolved_summary"].items())))
    md.append("")

    # 6. MFL YTD vs weekly
    md.append("### MFL season totals (W=YTD) vs the per-week sum\n")
    md.append(md_table(["Season", "Match", "Differ", "YTD only", "Weekly only", "After = YTD", "After != YTD"],
                       [[s, c.get("match", 0), c.get("differs", 0), c.get("ytd_only", 0), c.get("weekly_only", 0),
                         c.get("after_matches_ytd", 0), c.get("after_differs_from_ytd", 0)]
                        for s, c in sorted(rep["mfl_ytd_vs_weekly"].items())]))
    md.append("")

    # 7. cost + proofs
    if meas:
        md.append("### D1 cost, measured on a local Miniflare D1 (index entries included)\n")
        md.append(md_table(["Phase file", "Statements", "Rows written", "Rows read", "Re-run written", "Rollback written"],
                           [[n, p["forward"]["statements"], p["forward"]["rows_written"], p["forward"]["rows_read"],
                             p["rerun"]["rows_written"], p["rollback"]["rows_written"]]
                            for n, p in meas["phases"].items()]))
        md.append(f"\nTotals: {json.dumps(meas['totals'])}; before/after-rollback hash equal: "
                  f"{meas['after_rollback']['sha256'] == meas['before']['sha256']}\n")
    if proof:
        md.append("### Local SQLite proof\n")
        md.append("```\n" + json.dumps({k: proof[k] for k in ("before", "after_forward", "after_rerun",
                                                               "after_rollback", "after_forward_equals_proposal", "ok")},
                                         indent=1) + "\n```\n")

    # 8. all-time rank proposal
    at = rep["alltime_rank_proposal"]
    md.append("### Proposed all-time positional season rank\n")
    md.append(at["definition"] + "\n")
    md.append(md_table(["Pos", "Eligible", "Top-100 entries that change", "#1", "#2", "#3"],
                       [[g, v["eligible_after"], v["top100_changed_vs_before"]]
                        + [f"{e['name']} {e['season']} {e['ppg']}" for e in v["top5"][:3]]
                        for g, v in sorted(at["by_pos_group"].items())]))
    (out / "report.md").write_text("\n".join(md) + "\n")
    print(f"wrote {out / 'report.md'}")
    return 0


# ──────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────

def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch-mfl")
    f.add_argument("--cache", required=True)
    f.add_argument("--min-interval", type=float, default=6.0)
    e = sub.add_parser("extract-d1")
    e.add_argument("--out", required=True)
    e.add_argument("--allow-prod-d1", action="store_true")
    e.add_argument("--max-rows-read", type=int, default=80_000)
    b = sub.add_parser("build")
    b.add_argument("--cache", required=True)
    b.add_argument("--d1", required=True)
    b.add_argument("--archive", required=True, help="decompressed mfl_database_2026-06-05.db")
    b.add_argument("--out", required=True)
    b.add_argument("--weekly-ranks", choices=["table", "null"], default="table",
                   help="new rows' pos_rank / overall_rank: src_weekly's own rule, or NULL until the rank "
                        "definition is reviewed")
    b.add_argument("--unproven", choices=["null", "hold", "sync"], default="null",
                   help="rows whose status MFL cannot prove: write status NULL (default), hold them back, "
                        "or label them 'fa' like the live sync")
    p = sub.add_parser("local-proof")
    p.add_argument("--out", required=True)
    r = sub.add_parser("report")
    r.add_argument("--out", required=True)
    args = ap.parse_args(argv)
    return {"fetch-mfl": cmd_fetch_mfl, "extract-d1": cmd_extract_d1, "build": cmd_build,
            "local-proof": cmd_local_proof, "report": cmd_report}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
