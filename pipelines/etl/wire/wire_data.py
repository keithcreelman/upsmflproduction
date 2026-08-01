#!/usr/bin/env python3
"""UPS Wire data access. READ ONLY.

Every source a pack builder is allowed to touch, behind one module, so the
landmines are handled once instead of in every builder:

  d1(sql)                 SELECT against ups-mfl-db via wrangler --remote
  worker_get(path, **qs)  the worker's HTTP API, with the mandatory &L=
  snapshot(date, name)    a daily MFL export from data/mfl-snapshots/
  contract_activity()     the off-season contract-mutation log
  owner_map(season)       (season, franchise_id) -> owner, the ONLY correct
                          way to attribute anything in this league

LANDMINES HANDLED HERE (all verified, see docs/ + site/wire/README.md):
  * franchise_id and player_id are zero-padded TEXT ('0008'), never ints.
  * `season` is INTEGER in src_* tables but TEXT in most ups_* tables.
  * Worker routes 400 with "Missing L param" before any route-level default
    fires, so L is always appended.
  * D1's remote HTTP API intermittently returns "D1 is overloaded" with no
    query-side cause; one retry.
  * Owner attribution: franchise_id alone is NOT a stable owner lineage.
    Keith held 0007 then 0008; 0003 has titles from two different owners.
    Always join on (season, franchise_id) through src_franchises.

WHY NOT ups_owner_career_stats: it is a 12-row derived cache keyed on
franchise_id alone, with no refresh job and known attribution drift. Rebuild
from src_franchises instead.
"""

import io
import json
import os
import subprocess
import time

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SNAPSHOT_DIR = os.path.join(REPO, "data", "mfl-snapshots")
WORKER_DIR = os.path.join(REPO, "worker")
CONTRACT_ACTIVITY = os.path.join(
    REPO, "site", "rosters", "contract_submissions", "contract_activity_%s.json")

LEAGUE_ID = "74598"
D1_NAME = "ups-mfl-db"
WORKER_BASE = "https://upsmflproduction.keith-creelman.workers.dev"

_WRITE_WORDS = ("insert", "update", "delete", "drop", "alter", "create",
                "replace", "attach", "detach", "pragma", "vacuum", "reindex")


class DataError(RuntimeError):
    pass


# ------------------------------------------------------------------ D1

def d1(sql, retries=1):
    """Run a single SELECT against the remote D1 and return list-of-dicts.

    Read-only by construction: anything that is not a SELECT/WITH is refused
    here rather than trusted to be harmless. Contract data lives in this
    database and a stray write is not recoverable from a report builder.
    """
    stripped = sql.strip().lstrip("(").lower()
    if not (stripped.startswith("select") or stripped.startswith("with")):
        raise DataError("d1() is read-only; refused: %s..." % sql.strip()[:60])
    for word in _WRITE_WORDS:
        # Whole-word check so a column named e.g. `created_at` is fine.
        if (" %s " % word) in (" " + stripped.replace("\n", " ") + " "):
            raise DataError("d1() refused a statement containing %r" % word)

    cmd = ["npx", "wrangler", "d1", "execute", D1_NAME, "--remote", "--json",
           "--command", sql]
    last = None
    for attempt in range(retries + 1):
        proc = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True)
        out = proc.stdout.strip()
        if proc.returncode == 0 and out:
            try:
                payload = json.loads(out)
                return payload[0]["results"]
            except Exception as exc:          # noqa: BLE001 - report the raw text
                last = "unparseable wrangler output: %s / %s" % (exc, out[:200])
        else:
            last = (proc.stderr or out or "").strip()[:300]
        # "D1 is overloaded" and transient internal errors have no query-side
        # cause and clear on retry.
        if attempt < retries:
            time.sleep(2)
    raise DataError("D1 query failed: %s\nSQL: %s" % (last, sql[:200]))


# --------------------------------------------------------------- worker

def worker_get(path, **params):
    """GET a worker route. L is mandatory -- the global gate 400s without it."""
    import urllib.parse
    import urllib.request

    qs = dict(params)
    qs.setdefault("L", LEAGUE_ID)
    url = "%s%s?%s" % (WORKER_BASE, path, urllib.parse.urlencode(qs))
    req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-pack-builder"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:                  # noqa: BLE001
        raise DataError("worker GET failed: %s (%s)" % (url, exc))


# ------------------------------------------------------------- snapshots

def snapshot_dates():
    if not os.path.isdir(SNAPSHOT_DIR):
        return []
    return sorted(d for d in os.listdir(SNAPSHOT_DIR)
                  if len(d) == 10 and d[4] == "-" and os.path.isdir(os.path.join(SNAPSHOT_DIR, d)))


def snapshot(date, name):
    """One daily MFL export. `name` is e.g. 'rosters' or 'salaries'."""
    path = os.path.join(SNAPSHOT_DIR, date, "%s.json" % name)
    if not os.path.exists(path):
        raise DataError("no snapshot %s/%s.json" % (date, name))
    return json.load(io.open(path, encoding="utf-8"))


def roster_salaries(date):
    """Per-franchise active-roster salary total from a daily snapshot.

    Matches the league's cap formula on the roster side: TAXI_SQUAD is excluded
    (it does not count against the cap). It does NOT include salaryAdjustments,
    because the daily snapshot does not capture them -- any pack using this for
    an opening cap position must say so in warnings[].
    """
    data = snapshot(date, "rosters")
    out = {}
    for fr in data["rosters"]["franchise"]:
        fid = str(fr["id"]).zfill(4)
        players = fr.get("player") or []
        if isinstance(players, dict):
            players = [players]
        active = [p for p in players if str(p.get("status", "")).upper() == "ROSTER"]
        taxi = [p for p in players if str(p.get("status", "")).upper() == "TAXI_SQUAD"]
        out[fid] = {
            "salary_total": sum(_money(p.get("salary")) for p in active),
            "active_count": len(active),
            "taxi_count": len(taxi),
        }
    return out


def _money(v):
    """MFL salary strings: '15000', '$15,000', '' -> int dollars."""
    s = str(v or "").replace("$", "").replace(",", "").strip()
    if not s:
        return 0
    try:
        return int(round(float(s)))
    except ValueError:
        return 0


# ------------------------------------------------------- contract activity

def commits_behind_main():
    """How many commits origin/main has that this checkout does not.

    Repo-tracked data (daily snapshots, the contract-activity log) is written by
    GitHub Actions and committed to main, so a feature branch drifts from the
    league's actual state just by existing. Any pack built from a stale checkout
    is quietly out of date -- which for a published report is worse than an
    error, because nothing looks wrong.
    """
    subprocess.run(["git", "fetch", "origin", "main", "-q"], cwd=REPO,
                   capture_output=True, text=True)
    proc = subprocess.run(["git", "rev-list", "--count", "HEAD..origin/main"],
                          cwd=REPO, capture_output=True, text=True)
    if proc.returncode != 0:
        return None
    try:
        return int(proc.stdout.strip())
    except ValueError:
        return None


def tracked_data_file(rel_path):
    """Read a repo data file, preferring origin/main over the local checkout.

    WHY: files like contract_activity_2026.json are written by a GitHub Action
    and auto-committed to main. A feature branch or worktree goes stale against
    them within days -- this worktree was 43 commits behind and would have built
    a Pre-Season Review claiming 89 contract moves when the league had made 102.
    Nothing would have looked wrong; the number would just have been old.

    These files are machine-written on main and never hand-edited on a branch,
    so main is always the right version to read. Falls back to the working copy
    when origin/main is unavailable (a fresh clone, or offline).

    Returns (parsed_json, provenance_string).
    """
    proc = subprocess.run(["git", "show", "origin/main:%s" % rel_path],
                          cwd=REPO, capture_output=True, text=True)
    local_path = os.path.join(REPO, rel_path)
    local_raw = io.open(local_path, encoding="utf-8").read() if os.path.exists(local_path) else None

    if proc.returncode == 0 and proc.stdout.strip():
        if local_raw is not None and local_raw == proc.stdout:
            return json.loads(proc.stdout), "working copy (identical to origin/main)"
        return json.loads(proc.stdout), "origin/main (local checkout is behind)"

    if local_raw is None:
        raise DataError("no such data file: %s" % rel_path)
    return json.loads(local_raw), "working copy (origin/main unavailable)"


def contract_activity(season="2026"):
    """The off-season contract-mutation log (extensions, MYM, restructures,
    tags, FA contracts). FL/BL loading is encoded in contract_status.

    KNOWN GAP: a chunk of rows carry blank franchise_name and player_name. The
    ids are always present, so callers must resolve names themselves rather
    than render a blank. Count it and warn.

    Returns (rows, provenance).
    """
    rel_path = "site/rosters/contract_submissions/contract_activity_%s.json" % season
    raw, provenance = tracked_data_file(rel_path)
    rows = raw if isinstance(raw, list) else (raw.get("activities") or raw.get("rows") or [])
    for r in rows:
        if r.get("franchise_id") is not None:
            r["franchise_id"] = str(r["franchise_id"]).zfill(4)
    return rows, provenance


# ------------------------------------------------------------ attribution

def owner_map(season):
    """(season, franchise_id) -> {owner_name, team_name}. The ONLY correct
    attribution path. Verified to agree with /api/standings on all four
    mid-season-takeover seasons the worker hardcodes."""
    rows = d1("SELECT franchise_id, owner_name, team_name FROM src_franchises "
              "WHERE season = %d ORDER BY franchise_id" % int(season))
    return dict((str(r["franchise_id"]).zfill(4),
                 {"owner_name": r["owner_name"], "team_name": r["team_name"]})
                for r in rows)


# Mid-season ownership changes the commish ruled on: the owner who ran the
# auction is credited with the season. The worker hardcodes these at
# worker/src/index.js:14600 and pipelines/etl/config/owner_tenure_overrides.json
# encodes the same ruling. MFL itself reports END-OF-SEASON ownership, so any
# independent derivation risks disagreeing on exactly these cells.
ATTRIBUTION_FIXTURES = [
    (2017, "0002", "Derrick Whitman"),
    (2022, "0002", "AJ Balderelli"),
    (2022, "0005", "Rico Balderelli"),
    (2024, "0006", "Josh Lima"),
]


def check_attribution():
    """Prove src_franchises agrees with /api/standings on every contested season.

    If this ever fails, a report built from src_franchises would credit the
    wrong person for a season -- the single worst error this project can make,
    and one that reads as authoritative. Returns a list of disagreements.
    """
    problems = []
    for season, fid, expected in ATTRIBUTION_FIXTURES:
        ours = owner_map(season).get(fid, {}).get("owner_name")
        try:
            payload = worker_get("/api/standings", year=season)
        except DataError as exc:
            problems.append("%d/%s: could not reach /api/standings (%s)" % (season, fid, exc))
            continue
        rows = payload.get("standings") or payload.get("rows") or payload.get("data") or []
        theirs = next((r.get("owner_name") for r in rows
                       if str(r.get("franchise_id") or r.get("id") or "").zfill(4) == fid), None)
        if ours != expected:
            problems.append("%d/%s: src_franchises says %r, commish ruling is %r"
                            % (season, fid, ours, expected))
        if theirs != expected:
            problems.append("%d/%s: /api/standings says %r, commish ruling is %r"
                            % (season, fid, theirs, expected))
    return problems


def owner_key(name):
    """Stable slug for an owner, for entity ids that survive a rename."""
    out = []
    for ch in str(name or "").lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "owner:" + "".join(out).strip("-")
