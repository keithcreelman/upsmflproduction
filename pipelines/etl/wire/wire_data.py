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


def current_roster_players(date):
    """Player-id-level roster for one daily snapshot. Companion to
    roster_salaries(), which only returns per-franchise TOTALS -- this is for
    anything that needs to know WHO is on the roster (position splits,
    per-player value), keyed the same way (ROSTER vs TAXI_SQUAD status)."""
    data = snapshot(date, "rosters")
    out = {}
    for fr in data["rosters"]["franchise"]:
        fid = str(fr["id"]).zfill(4)
        players = fr.get("player") or []
        if isinstance(players, dict):
            players = [players]
        out[fid] = [{"pid": str(p.get("id")), "status": str(p.get("status", "")).upper()}
                    for p in players]
    return out


# Non-player rows MFL mixes into its own player export: team defenses, coach
# slots, and per-team "TM*" mascot placeholders. Left in, these leak into an
# O/D/ST count as phantom players (see project_mobile_player_search memory:
# 422 of 2,610 rows in this same export aren't real players).
_NON_PLAYER_POS = ("Def", "Coach", "Off", "ST")


def player_positions():
    """MFL player id -> position, from the live full player universe.

    Season-agnostic on purpose: a player's position essentially never changes
    year to year, and MFL's players export isn't year-scoped, so this covers
    2026 rookies that src_players (frozen at season 2025) cannot.
    """
    payload = worker_get("/api/mfl-export", TYPE="players", JSON=1)
    players = (payload.get("players") or {}).get("player") or []
    out = {}
    for p in players:
        pos = str(p.get("position") or "").strip()
        if not pos or pos.startswith("TM") or pos in _NON_PLAYER_POS:
            continue
        pid = p.get("id")
        if pid:
            out[str(pid)] = pos
    return out


def adp_value_board():
    """Pre-2026-auction ADP value per player, keyed by MFL player id.

    docs/auction/data/adp_board_current.json, committed 2026-07-21 -- roughly
    12-16 days before that year's FA auction opened (~Aug 2). It is the same
    live FantasyCalc+KeepTradeCut+DynastyProcess blend fetch_adp_board.py
    builds, captured once and committed rather than fetched fresh -- there is
    no auto-refresh, so "start of the year" means THIS snapshot, not literally
    opening day.

    TWO VALUE AXES, and they are not interchangeable:
      dyn_value  dynasty superflex -- what a player is worth as a long-term
                 asset. Prices in age and years of control.
      rsf        REDRAFT superflex -- what a player is worth for THIS SEASON
                 alone. This is the one a single-season preview wants.

    They diverge enormously at the edges. Nick Chubb is 60 on the dynasty
    scale and 3,563 on redraft; Keenan Allen 207 vs 3,735. Reading a win-now
    roster on the dynasty axis makes productive veterans look like dead weight.
    Both axes share a magnitude (each tops out near 10,000), so a caller may
    swap one for the other without rescaling -- but must not mix them in a sum.

    `rsf` IS ABSENT FOR ~1 IN 4 BOARD ENTRIES, and that absence is meaningful
    rather than missing: it is the college quarterbacks (Carson Beck, Cade
    Klubnik, Quinn Ewers) and undraftable NFL backups (Flacco, Minshew,
    Mariota) that a dynasty board carries and a redraft board correctly prices
    out of relevance. On a this-season axis those players really are worth
    ~nothing, so a caller should treat a missing `rsf` as zero and say so --
    NOT as unknown. That is the opposite of the IDP case below.

    OFFENSE positions only (QB/RB/WR/TE) on either axis: ADP does not
    meaningfully rank IDP (see build_auction_tier_dataset.py's own docstring on
    the same point), so a caller must warn() and EXCLUDE a defensive player
    rather than silently price it at zero.
    """
    import io as _io
    path = os.path.join(REPO, "docs", "auction", "data", "adp_board_current.json")
    if not os.path.exists(path):
        raise DataError("no adp_board_current.json at %s" % path)
    raw = json.loads(_io.open(path, encoding="utf-8").read())
    out = {}
    for entry in raw.values():
        pid = str(entry.get("pid") or "")
        if pid:
            out[pid] = entry
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


def allplay_table(season, through_week, playoff=False):
    """All-play win/loss/points-for per franchise, through `through_week`.

    All-play is the league's own quality yardstick (the reference piece Keith
    signed off on leads with it: "strips out schedule luck"). It is NOT the raw
    head-to-head win total -- this league runs double- and triple-header weeks
    (2-3 simultaneous H2H opponents per franchise most weeks), so h2h_wins on
    src_weekly_franchise_summary is inflated relative to a normal one-game week
    and does not reproduce the real standings order on its own.

    Computed by self-joining src_franchise_weekly_score (one row per
    franchise-week, real season points) against itself within each week: every
    other team you outscored that week is a win. Verified to reproduce
    src_standings.allplay_regseason_w/l/t EXACTLY for 2025's full regular
    season (12/12 franchises, weeks 1-14) before being trusted for a
    through-week cutoff.

    playoff=True restricts to is_playoff=1 weeks (>=15) instead of regular
    season (<15) -- the two pools don't mix meaningfully mid-bracket, since a
    playoff bye week has no all-play games at all for that franchise.
    """
    clause = "w.is_playoff = 1" if playoff else "w.is_playoff = 0"
    rows = d1(
        "WITH s AS (SELECT franchise_id, week, team_score, team_opt_pts "
        "FROM src_franchise_weekly_score w "
        "WHERE w.season = %d AND %s AND w.week <= %d) "
        "SELECT a.franchise_id, "
        "SUM(CASE WHEN a.team_score > b.team_score THEN 1 ELSE 0 END) AS w, "
        "SUM(CASE WHEN a.team_score < b.team_score THEN 1 ELSE 0 END) AS l, "
        "SUM(CASE WHEN a.team_score = b.team_score THEN 1 ELSE 0 END) AS t "
        "FROM s a JOIN s b ON a.week = b.week AND a.franchise_id != b.franchise_id "
        "GROUP BY a.franchise_id"
        % (int(season), clause, int(through_week)))
    out = dict((str(r["franchise_id"]).zfill(4),
               {"w": int(r["w"]), "l": int(r["l"]), "t": int(r["t"])}) for r in rows)

    pf = d1("SELECT franchise_id, SUM(team_score) AS pf, SUM(team_opt_pts) AS opt "
            "FROM src_franchise_weekly_score w WHERE season = %d AND %s AND week <= %d "
            "GROUP BY franchise_id" % (int(season), clause, int(through_week)))
    for r in pf:
        fid = str(r["franchise_id"]).zfill(4)
        out.setdefault(fid, {"w": 0, "l": 0, "t": 0})
        out[fid]["pf"] = float(r["pf"] or 0)
        out[fid]["opt"] = float(r["opt"] or 0)
    return out


def clean_discord_text(text, id_to_owner=None):
    """Make a raw Discord message publishable.

    Discord stores mentions as <@1277066460207775801>. Rendered verbatim that
    prints a raw snowflake in the middle of a published sentence -- a critic
    flagged exactly this on a quote reading "A lot at stake here
    <@1277066460207775801>". Resolve to the owner's name where we know them,
    strip the mention otherwise, and tidy custom emoji the same way.
    """
    import re as _re
    s = str(text or "")

    def _mention(m):
        who = (id_to_owner or {}).get(m.group(1))
        return who if who else ""

    s = _re.sub(r'<@!?(\d+)>', _mention, s)
    s = _re.sub(r'<a?:(\w+):\d+>', lambda m: "", s)      # custom emoji -> drop
    s = _re.sub(r'<#\d+>', "", s)                         # channel refs -> drop
    s = _re.sub(r'[ \t]{2,}', " ", s)
    return s.strip()


def discord_id_to_owner():
    """discord_user_id -> owner_name, for resolving mentions inside quotes."""
    rows = d1("SELECT discord_user_id, owner_name FROM discord_owners "
              "WHERE active_owner = 'Y'")
    return dict((str(r["discord_user_id"]), r["owner_name"]) for r in rows)


def week_window(season, week):
    """(start_unix, end_unix) for a fantasy week. Thursday-anchored.

    Same anchoring as the Discord ingest, verified against canon's own 2026
    dates and against real 2025 chat.
    """
    from datetime import datetime, timedelta, timezone
    d = datetime(int(season), 9, 4, tzinfo=timezone.utc)
    while d.weekday() != 3:
        d += timedelta(days=1)
    start = d + timedelta(weeks=int(week) - 1)
    return int(start.timestamp()), int((start + timedelta(days=7)).timestamp())


def week_pickups(season, week, min_score=12.0):
    """Waiver/FA adds made for this week, and what the player then scored.

    Answers "did the pickup come through" -- the add is only a story if you can
    say what it produced. Joins the add to that same week's fantasy score.
    """
    lo, hi = week_window(season, week)
    rows = d1(
        "SELECT a.player_id, a.franchise_id, a.method, a.salary, "
        "p.name AS player_name, w.score, w.status "
        "FROM src_adddrop a "
        "LEFT JOIN src_players p ON p.player_id = a.player_id AND p.season = a.season "
        "LEFT JOIN src_weekly w ON w.player_id = a.player_id AND w.season = a.season "
        "AND w.week = %d "
        "WHERE a.season = %d AND a.move_type = 'ADD' "
        "AND a.unix_timestamp >= %d AND a.unix_timestamp < %d "
        "ORDER BY w.score DESC" % (int(week), int(season), lo, hi))
    out = []
    for r in rows:
        out.append({
            "player": display_name(r.get("player_name")) or ("player %s" % r["player_id"]),
            "fid": str(r["franchise_id"]).zfill(4),
            "method": r.get("method"),
            "salary": _money(r.get("salary")),
            "score": float(r["score"]) if r.get("score") is not None else None,
            "started": (r.get("status") == "starter"),
        })
    return out


def week_trades(season, week):
    """Trades completed inside this week, grouped by deal."""
    lo, hi = week_window(season, week)
    rows = d1(
        "SELECT trade_group_id, franchise_id, franchise_name, asset_role, asset_type, "
        "player_id, player_name, comments FROM src_trades "
        "WHERE season = %d AND unix_timestamp >= %d AND unix_timestamp < %d "
        "ORDER BY trade_group_id" % (int(season), lo, hi))
    deals = {}
    for r in rows:
        d = deals.setdefault(r["trade_group_id"], {"franchises": set(), "assets": []})
        d["franchises"].add(str(r["franchise_id"]).zfill(4))
        d["assets"].append({
            "fid": str(r["franchise_id"]).zfill(4),
            "role": r.get("asset_role"), "type": r.get("asset_type"),
            "player": display_name(r.get("player_name")) or "",
        })
    return deals


def division_names(season):
    """division id -> the name the league actually calls it.

    src_franchises stores only MFL's numeric id ("00".."03"), which is worthless
    in prose -- a game page tagged "00 v 03" tells a reader nothing. The real
    names (ICE UP SON!, LEGION OF BOOM, ...) live on the league record and only
    there. Falls back to the id if MFL is unreachable, so a build never fails
    over a label.
    """
    try:
        payload = worker_get("/api/mfl-export", TYPE="league", YEAR=int(season), JSON=1)
    except DataError:
        return {}
    divs = ((payload.get("league") or {}).get("divisions") or {}).get("division") or []
    if isinstance(divs, dict):
        divs = [divs]
    return dict((str(d.get("id")), str(d.get("name") or "").strip())
                for d in divs if d.get("id") and d.get("name"))


def divisions(season, named=True):
    """franchise_id -> division label, using the league's own division names."""
    raw = dict((str(r["franchise_id"]).zfill(4), str(r["division"])) for r in
               d1("SELECT franchise_id, division FROM src_franchises WHERE season = %d"
                  % int(season)))
    if not named:
        return raw
    names = division_names(season)
    return dict((f, names.get(v, v)) for f, v in raw.items())


def display_name(mfl_name):
    """MFL stores 'Lawrence, Trevor'. Nobody writes that.

    Left unflipped it leaks straight into published prose -- the first rebuilt
    recap printed "sat Pitts, Kyle, who proceeded to post 55.7". Flip once, at
    the data layer, so no builder has to remember.
    """
    s = str(mfl_name or "").strip()
    if "," not in s:
        return s
    last, first = s.split(",", 1)
    return "%s %s" % (first.strip(), last.strip())


def weekly_allplay(season, week):
    """One week's all-play: who beat how many of the other eleven.

    This is the "Eric Martel went 11-0 against the field" line. Season-to-date
    all-play cannot express it -- a 3-9 week vanishes inside a 90-64 season
    record -- and it was the single most-requested missing number.
    """
    rows = d1(
        "WITH s AS (SELECT franchise_id, team_score FROM src_franchise_weekly_score "
        "WHERE season = %d AND week = %d) "
        "SELECT a.franchise_id, "
        "SUM(CASE WHEN a.team_score > b.team_score THEN 1 ELSE 0 END) AS w, "
        "SUM(CASE WHEN a.team_score < b.team_score THEN 1 ELSE 0 END) AS l "
        "FROM s a JOIN s b ON a.franchise_id != b.franchise_id "
        "GROUP BY a.franchise_id" % (int(season), int(week)))
    return dict((str(r["franchise_id"]).zfill(4), {"w": int(r["w"]), "l": int(r["l"])})
                for r in rows)


def top_performers(season, week, limit=12):
    """Highest-scoring STARTERS this week, with the roster they started for.

    src_weekly.status is one of starter / nonstarter / free agent. Only starters
    count -- a bench player's score is a different story (see bench_burns).
    """
    rows = d1(
        "SELECT w.player_id, w.score, w.pos_group, w.pos_rank, w.overall_rank, "
        "w.roster_franchise_id AS fid, p.name AS player_name, p.nfl_team AS nfl_team, "
        "p.position AS position "
        "FROM src_weekly w LEFT JOIN src_players p "
        "ON p.player_id = w.player_id AND p.season = w.season "
        "WHERE w.season = %d AND w.week = %d AND w.status = 'starter' "
        "ORDER BY w.score DESC LIMIT %d" % (int(season), int(week), int(limit)))
    for r in rows:
        r["player_name"] = display_name(r.get("player_name"))
    return rows


def player_prior_form(season, week, player_id):
    """A player's average and best BEFORE this week.

    Strictly week < the week in question. src_pointssummary is a season-final
    snapshot and would leak weeks 15-17 into a week-13 article, so it is never
    used for this.
    """
    rows = d1(
        "SELECT COUNT(*) AS games, AVG(score) AS avg_score, MAX(score) AS best "
        "FROM src_weekly WHERE season = %d AND week < %d AND player_id = '%s' "
        "AND status IN ('starter','nonstarter')"
        % (int(season), int(week), str(player_id).replace("'", "''")))
    if not rows or not rows[0]["games"]:
        return None
    r = rows[0]
    return {"games": int(r["games"]), "avg": float(r["avg_score"] or 0),
            "best": float(r["best"] or 0)}


def bench_burns(season, week, min_diff=15.0):
    """Benched players who outscored a starter at the same position group.

    The "went against the grain" story, with both names and both scores. Kept
    to same pos_group so it is a defensible comparison.

    IMPORTANT: this is NOT "he should have started him" as a lineup fact. The
    league's flex rules mean a naive pos_group swap can overstate what was
    actually startable -- reconstructing the optimal lineup ourselves overstated
    one 2025 week by 9.1 points against MFL's own figure. For "points left on
    the bench" always use MFL's team_opt_pts, never a homemade solver. This
    function is for naming a specific miss, not for totalling one.
    """
    rows = d1(
        "SELECT w.roster_franchise_id AS fid, "
        "COALESCE(w.pos_group, p.position) AS pos_group, w.status, w.score, "
        "w.player_id, p.name AS player_name "
        "FROM src_weekly w LEFT JOIN src_players p "
        "ON p.player_id = w.player_id AND p.season = w.season "
        "WHERE w.season = %d AND w.week = %d AND w.status IN ('starter','nonstarter') "
        "AND w.roster_franchise_id IS NOT NULL" % (int(season), int(week)))

    by = {}
    for r in rows:
        fid = str(r["fid"]).zfill(4)
        by.setdefault((fid, r["pos_group"]), {"starter": [], "bench": []})
        slot = "starter" if r["status"] == "starter" else "bench"
        by[(fid, r["pos_group"])][slot].append(
            {"name": display_name(r["player_name"]) or ("player %s" % r["player_id"]),
             "pid": r["player_id"], "score": float(r["score"] or 0)})

    out = {}
    for (fid, pos), g in by.items():
        if not g["starter"] or not g["bench"]:
            continue
        best_bench = max(g["bench"], key=lambda x: x["score"])
        worst_start = min(g["starter"], key=lambda x: x["score"])
        diff = best_bench["score"] - worst_start["score"]
        if diff < min_diff:
            continue
        if fid not in out or diff > out[fid]["diff"]:
            out[fid] = {"pos": pos, "benched": best_bench["name"],
                        "benched_score": best_bench["score"],
                        "benched_id": best_bench["pid"],
                        "started": worst_start["name"],
                        "started_score": worst_start["score"],
                        "started_id": worst_start["pid"], "diff": diff}

    # PROCESS OR OUTCOME -- the difference between a rippable decision and bad
    # luck, and the only honest basis for roasting anyone. Judged on what each
    # player had been averaging BEFORE this week:
    #   process  -- the benched player was the better player and got benched
    #   variance -- the right man started and had a bad day
    # Starting a stud who busts is not a mistake. Benching him for a scrub is.
    prior = players_prior_form(season, week,
                               [v["benched_id"] for v in out.values()]
                               + [v["started_id"] for v in out.values()])

    def _form(pid):
        """What this player had recently been worth, or None if we cannot say.

        RECENT form wins over the season mean. A player back from a long absence
        carries his pre-injury games in a flat average, which is how a defensible
        start ("Burrow, two big games since returning") got published as "the
        wrong man started". Fewer than two games in the recent window means we
        do not know, and not knowing must never become an accusation.
        """
        f = prior.get(str(pid))
        if not f:
            return None
        if f["recent_games"] >= 2 and f["recent_avg"] is not None:
            return f["recent_avg"]
        if f["games"] >= 3 and f["last_week"] >= int(week) - 2:
            return f["avg"]
        return None

    for v in out.values():
        v["benched_avg"] = _form(v["benched_id"])
        v["started_avg"] = _form(v["started_id"])
        if v["benched_avg"] is None or v["started_avg"] is None:
            v["verdict"] = "unknown"
        elif v["benched_avg"] > v["started_avg"] + 2.0:
            v["verdict"] = "process"
        else:
            v["verdict"] = "variance"
    return out


def did_not_play(season, week):
    """Starters who never took a snap. The one genuinely rippable start.

    A stud who busts is not a bad decision -- starting a top receiver is right
    every time even when he catches nothing, and roasting it is roasting the
    outcome. Starting a man who was INACTIVE is different: that is an information
    failure, and it is fair game.

    THIS FUNCTION PUBLICLY ACCUSES A NAMED OWNER OF NOT CHECKING HIS LINEUP, so
    it fails CLOSED: anything short of positive evidence of absence is treated as
    "he played". The first version did the opposite and got it wrong every single
    time -- 15 flags across 2025 weeks 13-17, all 15 of them men who played, and
    all 8 real cases missed. Two independent bugs:

      1. It inferred participation from a nine-column counting-stat list. That
         list has no def_sacks, no def_qb_hits, no assisted tackles, and nothing
         at all for a blocking tight end, a rotational edge, or a kicker who
         dressed without an attempt. Montez Sweat played 41 defensive snaps and
         was called inactive. Ja'Tavion Sanders played 31 offensive snaps.
      2. The candidate filter was `score <= 0.5`. MFL stores a starter who did
         not play with score NULL, and `NULL <= 0.5` is NULL, so every genuine
         case was filtered out before the check even ran.

    Now: nfl_player_snaps is the participation source -- offensive, defensive AND
    special-teams snaps, 26,612 rows for 2025 and previously unused here. A
    player is only flagged when ALL of these hold:
      * he is startable-but-blank: score IS NULL, or at most half a point
      * he is resolvable at all (present in player_id_crosswalk) -- a crosswalk
        gap is our failure, not the owner's
      * zero snaps of any kind, AND no box row
      * his NFL team PLAYED that week -- otherwise a bye reads as an accusation

    Verified against 2025 weeks 13-17: the 8 true cases are found and all 15
    former false positives are gone.
    """
    # season and week are literals rather than correlated references: SQLite
    # refuses to resolve an outer column from a doubly-nested subquery
    # ("no such column: w.week"), and the team-played check needs that depth.
    sy, sw = int(season), int(week)
    rows = d1(
        "SELECT w.player_id, w.roster_franchise_id AS fid, w.score, "
        "p.name AS player_name, p.position AS position, "
        "(SELECT COALESCE(SUM(COALESCE(s.off_snaps,0) + COALESCE(s.def_snaps,0) "
        "                     + COALESCE(s.st_snaps,0)), 0) "
        " FROM nfl_player_snaps s JOIN player_id_crosswalk cx ON cx.pfr_id = s.pfr_id "
        " WHERE s.season = %d AND s.week = %d "
        "   AND cx.mfl_player_id = w.player_id) AS snaps, "
        "(SELECT COUNT(*) FROM nfl_player_weekly n "
        " JOIN player_id_crosswalk cg ON cg.gsis_id = n.gsis_id "
        " WHERE n.season = %d AND n.week = %d "
        "   AND cg.mfl_player_id = w.player_id) AS box_rows, "
        "(SELECT COUNT(*) FROM player_id_crosswalk ck "
        " WHERE ck.mfl_player_id = w.player_id) AS known, "
        # DID HIS TEAM EVEN PLAY. A bye week must never read as an accusation.
        # The team is resolved from the player's OWN nearest box row rather than
        # from src_players.nfl_team, because MFL and nflverse use different codes
        # -- 'NOS' vs 'NO', 'TBB' vs 'TB' -- and comparing them directly matched
        # nothing, which silently suppressed real cases (Kamara, Tykee Smith).
        # Resolving through the player sidesteps the mapping entirely.
        "(SELECT COUNT(*) FROM nfl_player_weekly t "
        " WHERE t.season = %d AND t.week = %d AND t.team = ("
        "   SELECT n2.team FROM nfl_player_weekly n2 "
        "   JOIN player_id_crosswalk c2 ON c2.gsis_id = n2.gsis_id "
        "   WHERE n2.season = %d AND c2.mfl_player_id = w.player_id "
        "     AND n2.team IS NOT NULL "
        "   ORDER BY ABS(n2.week - %d) LIMIT 1)) AS team_played "
        "FROM src_weekly w LEFT JOIN src_players p "
        "ON p.player_id = w.player_id AND p.season = w.season "
        "WHERE w.season = %d AND w.week = %d AND w.status = 'starter' "
        "AND (w.score IS NULL OR w.score <= 0.5) AND w.roster_franchise_id IS NOT NULL"
        % (sy, sw, sy, sw, sy, sw, sy, sw, sy, sw))
    out = {}
    for r in rows:
        if r.get("snaps") or r.get("box_rows"):
            continue                      # he played; a bad day is not a bad call
        if not r.get("known"):
            continue                      # we cannot resolve him -- our gap, not his
        if not r.get("team_played"):
            continue                      # bye week or no data; never an accusation
        out.setdefault(str(r["fid"]).zfill(4), []).append(
            {"player": display_name(r["player_name"]),
             "position": r.get("position") or "",
             "score": float(r["score"] or 0)})
    return out


def nfl_box_line(season, week, player_id):
    """The real NFL box score, so HOW someone scored can be described instead of
    invented. Returns only columns that are actually populated for the season --
    several nfl_player_weekly columns are 100% NULL for 2025."""
    # Explicit column list, never SELECT *: nfl_player_weekly has 100 columns
    # and D1's remote API refuses the result set ("too many columns").
    # Column names are nflverse-style abbreviations (pass_yds, not
    # passing_yards) and the join key is gsis_id on both sides.
    cols = ("pass_cmp", "pass_att", "pass_yds", "pass_tds", "pass_ints",
            "rush_att", "rush_yds", "rush_tds",
            "receptions", "targets", "rec_yds", "rec_tds",
            "fg_made", "fg_att", "fg_long",
            "def_tackles_total", "def_sacks", "def_ints", "def_tds")
    rows = d1(
        "SELECT %s, w.team, w.opponent FROM nfl_player_weekly w "
        "JOIN player_id_crosswalk x ON x.gsis_id = w.gsis_id "
        "WHERE w.season = %d AND w.week = %d AND x.mfl_player_id = '%s' LIMIT 1"
        % (", ".join("w." + c for c in cols), int(season), int(week),
           str(player_id).replace("'", "''")))
    if not rows:
        return None
    r = rows[0]
    # Drop zeros as well as NULLs -- "0 rushing touchdowns" is not colour, and
    # several columns are 100% NULL for 2025 anyway.
    out = dict((k, r[k]) for k in cols if r.get(k) not in (None, 0))
    if r.get("team"):
        out["matchup"] = "%s vs %s" % (r["team"], r.get("opponent") or "")
    return out


# Fantasy-relevant vocabulary. A quote has to be ABOUT the league to earn a
# place in a recap.
_RELEVANT = (
    "start", "started", "sit", "bench", "benched", "lineup", "roster", "trade",
    "traded", "bid", "waiver", "claim", "pickup", "drop", "cut", "points", "score",
    "scored", "win", "won", "lose", "lost", "beat", "playoff", "bracket", "seed",
    "toilet", "championship", "matchup", "qb", "rb", "wr", "te", "kicker", "defense",
    "injury", "injured", "out", "questionable", "td", "touchdown", "yards", "cap",
    "contract", "salary", "draft", "pick", "week", "season", "streak", "luck",
)

# Chat that is not about football. A recap quoting this would be a liability, and
# "longest message" ranking surfaces exactly this kind of thing first, because
# off-topic riffing runs long while a real reaction is short.
_OFF_TOPIC = (
    "girl", "wasted", "smashed", "drunk", "beer", "bar", "wife", "girlfriend",
    "porn", "sex", "dick", "ass ", "tits", "nude",
)


def score_quote_relevance(text, names):
    """How much this message is about the league. Higher is better; <=0 excludes.

    Ranking chat by LENGTH surfaces the worst possible material -- off-topic
    locker-room riffing runs long, while "Sweet job by Whitman playing Kamara
    lol" is short and is exactly what a recap wants. So rank by relevance and
    hard-exclude anything that trips the off-topic list.
    """
    low = " " + text.lower() + " "
    if any(bad in low for bad in _OFF_TOPIC):
        return -1
    score = 0
    for n in names:
        if n and n.lower() in low:
            score += 3                       # naming another owner or a team
    score += sum(1 for t in _RELEVANT if (" " + t + " ") in low or (" " + t) in low[:60])
    if "@" in text:
        score += 2                           # a direct callout
    if 40 <= len(text) <= 220:
        score += 2                           # pull-quote shaped
    elif len(text) > 320:
        score -= 2                           # a monologue, not a quote
    return score


def week_quotes(season, week, limit=40, min_len=25):
    """League chat for a week, owner-attributed, oldest first.

    Source is ups_discord_messages (migration 0113). Bots and very short
    messages ("lol", a bare link) are excluded -- they are not quotable. The
    caller picks which of these to surface; the pack carries them verbatim so
    the writer can only place them, never paraphrase.
    """
    return d1(
        "SELECT message_id, owner_name, franchise_id, content, posted_at_unix, channel_name "
        "FROM ups_discord_messages "
        "WHERE season = %d AND week = %d AND is_bot = 0 AND owner_name IS NOT NULL "
        "AND length(content) >= %d AND content NOT LIKE 'http%%' "
        "ORDER BY posted_at_unix LIMIT %d"
        % (int(season), int(week), int(min_len), int(limit)))


def _quoted(ids):
    return ", ".join("'%s'" % str(x).replace("'", "''") for x in ids)


def nfl_box_lines(season, week, player_ids):
    """nfl_box_line for many players in ONE query.

    The rebuilt game deck wants a play card per matchup, which is a box lookup
    per card. One round trip each turned a build into a minute of waiting for
    D1; this is the same data in a single call.
    """
    ids = [p for p in dict.fromkeys(player_ids) if p]
    if not ids:
        return {}
    cols = ("pass_cmp", "pass_att", "pass_yds", "pass_tds", "pass_ints",
            "rush_att", "rush_yds", "rush_tds",
            "receptions", "targets", "rec_yds", "rec_tds",
            "fg_made", "fg_att", "fg_long",
            "def_tackles_total", "def_sacks", "def_ints", "def_tds")
    rows = d1(
        "SELECT x.mfl_player_id AS pid, %s, w.team, w.opponent FROM nfl_player_weekly w "
        "JOIN player_id_crosswalk x ON x.gsis_id = w.gsis_id "
        "WHERE w.season = %d AND w.week = %d AND x.mfl_player_id IN (%s)"
        % (", ".join("w." + c for c in cols), int(season), int(week), _quoted(ids)))
    out = {}
    for r in rows:
        d = dict((k, r[k]) for k in cols if r.get(k) not in (None, 0))
        if r.get("team"):
            d["matchup"] = "%s vs %s" % (r["team"], r.get("opponent") or "")
        out[str(r["pid"])] = d
    return out


def players_prior_form(season, week, player_ids, recent=6):
    """player_prior_form for many players in ONE query. Same reason as above.

    Also returns RECENT form -- games inside the last `recent` weeks -- and the
    most recent week the player actually posted a score. A flat season mean is
    not a fair basis for judging a lineup call: it silently averages a player's
    pre-injury games with his post-return ones. In 2025 week 15 that inverted a
    verdict and published a false roast, saying Bo Nix "had been the better
    player all year" than Joe Burrow. Burrow had not played since week 2; in the
    two games since returning he was outscoring Nix comfortably.
    """
    ids = [p for p in dict.fromkeys(player_ids) if p]
    if not ids:
        return {}
    lo = max(0, int(week) - int(recent))
    rows = d1(
        "SELECT player_id, COUNT(*) AS games, AVG(score) AS avg_score, MAX(score) AS best, "
        "MAX(week) AS last_week, "
        "SUM(CASE WHEN week > %d THEN 1 ELSE 0 END) AS recent_games, "
        "AVG(CASE WHEN week > %d THEN score END) AS recent_avg "
        "FROM src_weekly WHERE season = %d AND week < %d AND player_id IN (%s) "
        "AND status IN ('starter','nonstarter') AND score IS NOT NULL GROUP BY player_id"
        % (lo, lo, int(season), int(week), _quoted(ids)))
    return dict((str(r["player_id"]),
                 {"games": int(r["games"]), "avg": float(r["avg_score"] or 0),
                  "best": float(r["best"] or 0),
                  "last_week": int(r["last_week"] or 0),
                  "recent_games": int(r["recent_games"] or 0),
                  "recent_avg": (float(r["recent_avg"]) if r["recent_avg"] is not None
                                 else None)}) for r in rows if r["games"])


def h2h_records(season, through_week):
    """Real W-L-T and DIVISIONAL W-L-T per franchise, through a week.

    src_standings carries div_w/div_l but it is a SEASON-FINAL snapshot with no
    week column, so it cannot answer "what was his division record going into
    week 13". src_schedule can: it stores one row per (franchise, opponent) with
    result and is_divisional, which in a double-header week is exactly the two
    games that franchise played.

    Regular season only -- a playoff result is not a standings result.
    """
    rows = d1("SELECT franchise_id, result, is_divisional FROM src_schedule "
              "WHERE season = %d AND week <= %d AND is_playoff = 0"
              % (int(season), int(through_week)))
    out = {}
    for r in rows:
        fid = str(r["franchise_id"]).zfill(4)
        d = out.setdefault(fid, {"w": 0, "l": 0, "t": 0, "dw": 0, "dl": 0, "dt": 0})
        key = {"W": "w", "L": "l"}.get((r["result"] or "").upper(), "t")
        d[key] += 1
        if r["is_divisional"]:
            d["d" + key] += 1
    for d in out.values():
        played = d["w"] + d["l"] + d["t"]
        d["pct"] = (d["w"] + 0.5 * d["t"]) / played if played else 0.0
        dplayed = d["dw"] + d["dl"] + d["dt"]
        d["div_pct"] = (d["dw"] + 0.5 * d["dt"]) / dplayed if dplayed else 0.0
        d["rec"] = "%d-%d" % (d["w"], d["l"]) + ("-%d" % d["t"] if d["t"] else "")
        d["div_rec"] = "%d-%d" % (d["dw"], d["dl"]) + ("-%d" % d["dt"] if d["dt"] else "")
    return out


def season_form(season, through_week, exclude_week=None):
    """Per franchise: games played, mean, spread, high and low weekly score.

    This is what "did he beat his own average" is measured against. Pass
    exclude_week to answer it honestly for the week being written about -- a
    team's average is not an expectation if the week in question is inside it.
    """
    extra = (" AND week <> %d" % int(exclude_week)) if exclude_week else ""
    rows = d1("SELECT franchise_id, week, team_score FROM src_franchise_weekly_score "
              "WHERE season = %d AND week <= %d AND is_playoff = 0%s"
              % (int(season), int(through_week), extra))
    by = {}
    for r in rows:
        by.setdefault(str(r["franchise_id"]).zfill(4), []).append(float(r["team_score"]))
    out = {}
    for fid, xs in by.items():
        n = len(xs)
        mean = sum(xs) / n
        var = sum((x - mean) ** 2 for x in xs) / (n - 1) if n > 1 else 0.0
        out[fid] = {"games": n, "avg": mean, "sd": var ** 0.5,
                    "high": max(xs), "low": min(xs)}
    return out


def regular_season_weeks(season):
    """Last regular-season week. Derived, because it moved with the NFL's 16->17."""
    rows = d1("SELECT MAX(week) AS w FROM src_schedule WHERE season = %d AND is_playoff = 0"
              % int(season))
    return int(rows[0]["w"]) if rows and rows[0]["w"] else 14


def playoff_odds(season, through_week, sims=4000, seed=20260801):
    """Monte Carlo playoff odds after `through_week`. Deterministic.

    WHY SIMULATE AT ALL. "He is a game back with two to play" is not an answer;
    in a league seeded by all-play percentage it is barely even a clue. The odds
    are the thing an owner actually wants and the one number no page in this
    league has ever shown them.

    THE MODEL. Each remaining week, every franchise draws a score from its own
    season mean and spread (normal, floored at zero). From those scores:
      * all-play accumulates -- every other team you outscored that week
      * the REAL remaining schedule resolves head-to-head wins, so a brutal
        closing slate actually costs you
    Then canon section F.1 seeds it: four division winners are in automatically,
    and the remaining seeds rank on all-play percentage.

    Division winners come from MFL's own chain (PCT -> DIVPCT -> AP%), not from
    all-play -- section F.2 is explicit that conflating the two is wrong.

    WHAT IT IS NOT. It assumes scoring is stable and independent, which ignores
    injuries, bye weeks, trades and anyone who has stopped setting a lineup. It
    is a weather forecast, not a result. Deterministic by construction (fixed
    seed) so two runs of the same week are byte-identical.
    """
    import random

    last = regular_season_weeks(season)
    if through_week >= last:
        return {}

    form = season_form(season, through_week)
    if not form:
        return {}
    ap = allplay_table(season, through_week, playoff=False)
    h2h = h2h_records(season, through_week)
    div = divisions(season, named=False)
    teams = sorted(form)
    if len(teams) < 4:
        return {}

    # The remaining slate, as unordered pairs per week -- results are NOT read.
    remaining = {}
    for r in d1("SELECT week, franchise_id, opponent_franchise_id FROM src_schedule "
                "WHERE season = %d AND is_playoff = 0 AND week > %d AND week <= %d"
                % (int(season), int(through_week), last)):
        a = str(r["franchise_id"]).zfill(4)
        b = str(r["opponent_franchise_id"]).zfill(4)
        remaining.setdefault(int(r["week"]), set()).add(tuple(sorted((a, b))))

    div_of = dict((f, div.get(f) or "?") for f in teams)
    div_names = sorted(set(div_of.values()))
    made = dict((f, 0) for f in teams)
    won_div = dict((f, 0) for f in teams)
    rng = random.Random(seed)

    for _ in range(int(sims)):
        apw = dict((f, ap.get(f, {}).get("w", 0)) for f in teams)
        apl = dict((f, ap.get(f, {}).get("l", 0)) for f in teams)
        pf = dict((f, ap.get(f, {}).get("pf", 0.0)) for f in teams)
        w = dict((f, h2h.get(f, {}).get("w", 0)) for f in teams)
        lo = dict((f, h2h.get(f, {}).get("l", 0)) for f in teams)
        dw = dict((f, h2h.get(f, {}).get("dw", 0)) for f in teams)
        dl = dict((f, h2h.get(f, {}).get("dl", 0)) for f in teams)

        for wk in sorted(remaining):
            score = {}
            for f in teams:
                s = rng.gauss(form[f]["avg"], form[f]["sd"] or 1.0)
                score[f] = s if s > 0 else 0.0
                pf[f] += score[f]
            for f in teams:
                for g in teams:
                    if f == g:
                        continue
                    if score[f] > score[g]:
                        apw[f] += 1
                    elif score[f] < score[g]:
                        apl[f] += 1
            for a, b in remaining[wk]:
                if a not in score or b not in score:
                    continue
                hi, low_ = (a, b) if score[a] >= score[b] else (b, a)
                w[hi] += 1
                lo[low_] += 1
                if div_of[hi] == div_of[low_]:
                    dw[hi] += 1
                    dl[low_] += 1

        def ap_pct(f):
            n = apw[f] + apl[f]
            return apw[f] / float(n) if n else 0.0

        def h2h_pct(f):
            n = w[f] + lo[f]
            return w[f] / float(n) if n else 0.0

        def dv_pct(f):
            n = dw[f] + dl[f]
            return dw[f] / float(n) if n else 0.0

        # Division winner: MFL's chain, not all-play (canon F.2).
        winners = []
        for name in div_names:
            pool = [f for f in teams if div_of[f] == name]
            pool.sort(key=lambda f: (-h2h_pct(f), -dv_pct(f), -ap_pct(f), -pf[f], f))
            winners.append(pool[0])
        for f in winners:
            won_div[f] += 1
        rest = sorted((f for f in teams if f not in winners),
                      key=lambda f: (-ap_pct(f), -h2h_pct(f), -pf[f], f))
        for f in set(winners) | set(rest[:max(0, 6 - len(winners))]):
            made[f] += 1

    n = float(sims)
    return dict((f, {"make": 100.0 * made[f] / n, "win_div": 100.0 * won_div[f] / n,
                     "sims": int(sims)}) for f in teams)


def week_projections(season, week):
    """franchise -> projected total for the lineup they actually started.

    Empty for any week captured before ups_player_projections existed (migration
    0114), which is every week before 2026. Callers omit the row rather than
    invent one -- see the migration header on what a post-hoc capture is worth.
    """
    rows = d1(
        "SELECT w.roster_franchise_id AS fid, SUM(p.projected_score) AS proj, "
        "COUNT(*) AS n FROM src_weekly w "
        "JOIN ups_player_projections p ON p.season = w.season AND p.week = w.week "
        "AND p.player_id = w.player_id "
        "WHERE w.season = %d AND w.week = %d AND w.status = 'starter' "
        "AND w.roster_franchise_id IS NOT NULL GROUP BY w.roster_franchise_id"
        % (int(season), int(week)))
    return dict((str(r["fid"]).zfill(4),
                 {"proj": float(r["proj"] or 0), "players": int(r["n"])}) for r in rows)


def owner_key(name):
    """Stable slug for an owner, for entity ids that survive a rename."""
    out = []
    for ch in str(name or "").lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "owner:" + "".join(out).strip("-")
