"""
yoy_signals.py — Multi-year ADP / salary / PPG gatherer and stickiness calculator.

Pulls MFL cross-league ADP and league-specific playerScores YTD for 2017-2025,
joins with existing salary/contract data from raw_rosters_start, and writes to
a SQLite table. Then computes year-over-year correlations to quantify how
"sticky" each signal is — informing the weighted projection model.

Usage:
    python3 yoy_signals.py --gather             # fetch and store data
    python3 yoy_signals.py --correlate          # compute stickiness
    python3 yoy_signals.py --gather --correlate # do both
"""

import argparse
import json
import os
import sqlite3
import statistics
import sys
import time
from pathlib import Path
from urllib.request import urlopen

SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
DATA_DIR = ETL_ROOT / "data"
# Honor MFL_DB_PATH (set by Keith's iCloud workflow). Falls back to the
# legacy hard-coded dev path so older machines keep working.
MFL_DB = Path(os.environ.get("MFL_DB_PATH") or
              "/Users/keithcreelman/Documents/mfl/mfl_python/dev/ups_mfl_database.db")
OUT_DB = DATA_DIR / "yoy_signals.db"
POINTS_HISTORY = Path(
    "/Users/keithcreelman/Documents/New project/site/rosters/player_points_history.json"
)

LEAGUE_ID = "74598"
MFL_HOST = "https://www48.myfantasyleague.com"
API_HOST = "https://api.myfantasyleague.com"
MFL_APIKEY = "aRBv1sCXvuWpx0OmP13EaDoeFbox"
YEARS = range(2017, 2026)  # 2017..2025 inclusive
WEEKS = range(1, 18)       # NFL regular season + playoff weeks; week 18 skipped historically


_THROTTLE_SECONDS = 0.8  # baseline delay between requests to avoid 429s
_last_call_ts = 0.0


def _get(url: str, attempts: int = 5) -> dict:
    """HTTP GET with throttling + exponential backoff on 429."""
    import urllib.error
    global _last_call_ts
    for i in range(attempts):
        # Throttle: ensure at least _THROTTLE_SECONDS between calls
        delta = time.monotonic() - _last_call_ts
        if delta < _THROTTLE_SECONDS:
            time.sleep(_THROTTLE_SECONDS - delta)
        try:
            with urlopen(url, timeout=30) as r:
                _last_call_ts = time.monotonic()
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            _last_call_ts = time.monotonic()
            if e.code == 429:
                wait = 10 * (i + 1)
                print(f"    429 rate-limited; sleeping {wait}s", flush=True)
                time.sleep(wait)
                continue
            if i == attempts - 1:
                raise
            time.sleep(1.5 * (i + 1))
        except Exception:
            _last_call_ts = time.monotonic()
            if i == attempts - 1:
                raise
            time.sleep(1.5 * (i + 1))
    return {}


def fetch_adp(year: int) -> list[dict]:
    """Cross-league ADP from MFL API."""
    url = f"{API_HOST}/{year}/export?TYPE=adp&IS_MOCK=-1&JSON=1"
    data = _get(url)
    return data.get("adp", {}).get("player", []) or []


def fetch_scores(year: int) -> list[dict]:
    """League-specific YTD player scores."""
    url = f"{MFL_HOST}/{year}/export?TYPE=playerScores&L={LEAGUE_ID}&W=YTD&JSON=1"
    data = _get(url)
    return data.get("playerScores", {}).get("playerScore", []) or []


def fetch_players(year: int) -> list[dict]:
    """Player metadata (id, name, position)."""
    url = f"{API_HOST}/{year}/export?TYPE=players&JSON=1"
    data = _get(url)
    return data.get("players", {}).get("player", []) or []


def fetch_weekly_games(year: int) -> dict[str, dict]:
    """For each player, return {games_played, games_started, total_points_from_weeks}.

    games_played = # of weeks with score > 0 (player had real fantasy activity).
    games_started = # of weeks where player was in a franchise's `starters` list
                    (from weeklyResults).
    """
    out: dict[str, dict] = {}
    for wk in WEEKS:
        # Per-week player scores
        url = (f"{MFL_HOST}/{year}/export?TYPE=playerScores&L={LEAGUE_ID}"
               f"&APIKEY={MFL_APIKEY}&W={wk}&JSON=1")
        try:
            data = _get(url)
        except Exception as e:
            print(f"    week {wk} scores failed: {e}")
            continue
        for p in data.get("playerScores", {}).get("playerScore", []) or []:
            pid = p.get("id")
            score = float(p.get("score") or 0)
            if not pid or score <= 0:
                continue
            rec = out.setdefault(pid, {"games_played": 0, "games_started": 0, "weekly_total": 0.0})
            rec["games_played"] += 1
            rec["weekly_total"] += score

        # Per-week starter lineups (to compute games_started)
        url2 = (f"{MFL_HOST}/{year}/export?TYPE=weeklyResults&L={LEAGUE_ID}"
                f"&APIKEY={MFL_APIKEY}&W={wk}&JSON=1")
        try:
            data2 = _get(url2)
        except Exception as e:
            print(f"    week {wk} results failed: {e}")
            continue
        matchups = data2.get("weeklyResults", {}).get("matchup", []) or []
        if isinstance(matchups, dict):
            matchups = [matchups]
        for m in matchups:
            franchises = m.get("franchise", []) or []
            if isinstance(franchises, dict):
                franchises = [franchises]
            for fr in franchises:
                starters_str = fr.get("starters", "") or ""
                # starters is a comma-separated list of player IDs
                for pid in [s.strip() for s in starters_str.split(",") if s.strip()]:
                    rec = out.setdefault(pid, {"games_played": 0, "games_started": 0, "weekly_total": 0.0})
                    rec["games_started"] += 1
    return out


def load_salaries_from_db() -> dict[tuple[int, str], dict]:
    """Map (year, player_id) -> {salary, contract_year, contract_length, ...} from the MFL DB.

    Prefers `contract_history_snapshots` (canonical, current — 2017-2025+).
    Falls back to legacy `raw_rosters_start` if that table still exists on
    older machines that haven't migrated. Keith 2026-04-25 — Phase-2 fix:
    raw_rosters_start was retired so 2025 salaries were silently empty in
    yoy_player_signals; switching the source backfills them.
    """
    if not MFL_DB.exists():
        return {}
    conn = sqlite3.connect(str(MFL_DB))
    out: dict[tuple[int, str], dict] = {}
    import re
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()}
    if "contract_history_snapshots" in tables:
        # contract_history_snapshots has one row per (season, player_id) at
        # snapshot_week=1 (start-of-season). Pick the row from the smallest
        # snapshot_week so we always get the start-of-year contract terms,
        # even on backfilled snapshot batches.
        rows = conn.execute("""
            SELECT chs.season, chs.player_id, chs.salary, chs.contract_year,
                   chs.contract_info, chs.contract_status
              FROM contract_history_snapshots chs
              JOIN (
                SELECT season, player_id, MIN(snapshot_week) AS min_w
                  FROM contract_history_snapshots
                 GROUP BY season, player_id
              ) m
                ON m.season = chs.season AND m.player_id = chs.player_id
               AND m.min_w = chs.snapshot_week
        """).fetchall()
    elif "raw_rosters_start" in tables:
        rows = conn.execute("""
            SELECT year, player_id, salary, contract_year, contract_info, contract_status
              FROM raw_rosters_start
        """).fetchall()
    else:
        conn.close()
        return {}
    for yr, pid, sal, cy, ci, cs in rows:
        cl_match = re.search(r"CL\s*(\d+)", ci or "")
        cl = int(cl_match.group(1)) if cl_match else None
        # Multiple position_filter rows per (season, player) collapse here;
        # last one wins, which is fine — salary/contract terms don't differ
        # across position_filter for the same (season, player_id).
        out[(int(yr), str(pid))] = {
            "salary": int(sal or 0),
            "contract_year": int(cy or 0),
            "contract_length": cl,
            "contract_status": cs or "",
        }
    conn.close()
    return out


def merge_elite_plus_from_points_history():
    """Read player_points_history.json and upsert Elite/Plus/Neutral/Dud counts
    (already z-score-classified by position) into yoy_player_signals.

    Source file schema (compact): players[pid] = {n, p, y: {year: [yearly fields]}}
    Yearly fields index per meta.yearly_fields.
    """
    if not POINTS_HISTORY.exists():
        print(f"points history file missing: {POINTS_HISTORY}")
        return
    raw = json.loads(POINTS_HISTORY.read_text())
    fields = raw.get("meta", {}).get("yearly_fields", [])
    field_idx = {name: i for i, name in enumerate(fields)}
    want = [
        "games", "elite_weeks", "pos_elite_weeks_started", "pos_plus_weeks_started",
        "pos_neutral_weeks_started", "pos_dud_weeks_started",
        "pos_elite_weeks_all", "pos_plus_weeks_all", "pos_neutral_weeks_all", "pos_dud_weeks_all",
    ]
    for w in want:
        if w not in field_idx:
            print(f"  WARN: field missing in points history: {w}")

    conn = sqlite3.connect(str(OUT_DB))
    # Add columns if missing
    existing_cols = {r[1] for r in conn.execute("PRAGMA table_info(yoy_player_signals)").fetchall()}
    for col in ("pos_elite_weeks_started", "pos_plus_weeks_started",
                "pos_neutral_weeks_started", "pos_dud_weeks_started",
                "elite_plus_ratio", "elite_plus_ratio_all"):
        if col not in existing_cols:
            col_type = "REAL" if "ratio" in col else "INTEGER"
            conn.execute(f"ALTER TABLE yoy_player_signals ADD COLUMN {col} {col_type}")

    updates = 0
    missing = 0
    for pid, p in raw.get("players", {}).items():
        pid_s = str(pid)
        yearly = p.get("y") or {}
        for yr_s, row in yearly.items():
            try:
                year = int(yr_s)
            except Exception:
                continue
            def g(name):
                idx = field_idx.get(name)
                return row[idx] if (idx is not None and idx < len(row)) else None
            ew_started = g("pos_elite_weeks_started") or 0
            pw_started = g("pos_plus_weeks_started") or 0
            nw_started = g("pos_neutral_weeks_started") or 0
            dw_started = g("pos_dud_weeks_started") or 0
            ew_all = g("pos_elite_weeks_all") or 0
            pw_all = g("pos_plus_weeks_all") or 0
            nw_all = g("pos_neutral_weeks_all") or 0
            dw_all = g("pos_dud_weeks_all") or 0
            total_started = ew_started + pw_started + nw_started + dw_started
            total_all = ew_all + pw_all + nw_all + dw_all
            ep_ratio = (ew_started + pw_started) / total_started if total_started >= 8 else None
            ep_ratio_all = (ew_all + pw_all) / total_all if total_all >= 8 else None
            r = conn.execute("""
                UPDATE yoy_player_signals
                SET pos_elite_weeks_started=?, pos_plus_weeks_started=?,
                    pos_neutral_weeks_started=?, pos_dud_weeks_started=?,
                    elite_plus_ratio=?, elite_plus_ratio_all=?
                WHERE year=? AND player_id=?
            """, (ew_started, pw_started, nw_started, dw_started,
                  ep_ratio, ep_ratio_all, year, pid_s))
            if r.rowcount:
                updates += 1
            else:
                missing += 1
    conn.commit()
    conn.close()
    print(f"Elite/Plus merge: {updates} rows updated, {missing} (year,pid) pairs absent from yoy DB")


def fetch_and_store_ages():
    """Pull MFL player details (birthdate) and compute age_at_season_start
    for each (year, player_id) in the yoy DB.

    Stores age (int) in yoy_player_signals.age_at_season_start column.
    Adds is_rookie flag from contract_status.
    """
    from datetime import date
    conn = sqlite3.connect(str(OUT_DB))
    existing_cols = {r[1] for r in conn.execute("PRAGMA table_info(yoy_player_signals)").fetchall()}
    for col, typ in (("age_at_season", "INTEGER"), ("is_rookie_contract", "INTEGER")):
        if col not in existing_cols:
            conn.execute(f"ALTER TABLE yoy_player_signals ADD COLUMN {col} {typ}")

    # Fetch current-year player details (one call is sufficient — birthdates are stable)
    url = f"{API_HOST}/2026/export?TYPE=players&DETAILS=1&JSON=1"
    data = _get(url)
    players = data.get("players", {}).get("player", []) or []
    birthdate_map: dict[str, str] = {}
    for p in players:
        pid = p.get("id")
        bday = p.get("birthdate")
        if pid and bday:
            birthdate_map[pid] = bday

    # Age at Sep 1 of each season is the conventional fantasy reference
    conn.execute("CREATE INDEX IF NOT EXISTS idx_yoy_pid_year ON yoy_player_signals (player_id, year)")
    updated = 0
    for pid, bday in birthdate_map.items():
        try:
            # MFL returns unix timestamp string for birthdate
            if bday.isdigit():
                from datetime import datetime, timezone
                born = datetime.fromtimestamp(int(bday), tz=timezone.utc).date()
            else:
                born = date.fromisoformat(bday)
        except Exception:
            continue
        rows = conn.execute(
            "SELECT year FROM yoy_player_signals WHERE player_id=?", (pid,)
        ).fetchall()
        for (yr,) in rows:
            season_ref = date(int(yr), 9, 1)
            age = season_ref.year - born.year - (
                (season_ref.month, season_ref.day) < (born.month, born.day))
            conn.execute(
                "UPDATE yoy_player_signals SET age_at_season=? WHERE player_id=? AND year=?",
                (int(age), pid, int(yr)))
            updated += 1
    # Rookie flag: join contract_status and match /rookie/i. Same source
    # cascade as load_salaries_from_db() — prefer contract_history_snapshots,
    # fall back to legacy raw_rosters_start.
    if MFL_DB.exists():
        src = sqlite3.connect(str(MFL_DB))
        src_tables = {r[0] for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()}
        if "contract_history_snapshots" in src_tables:
            rows = src.execute("""
                SELECT chs.season, chs.player_id, chs.contract_status
                  FROM contract_history_snapshots chs
                  JOIN (
                    SELECT season, player_id, MIN(snapshot_week) AS min_w
                      FROM contract_history_snapshots
                     GROUP BY season, player_id
                  ) m
                    ON m.season = chs.season AND m.player_id = chs.player_id
                   AND m.min_w = chs.snapshot_week
            """).fetchall()
        elif "raw_rosters_start" in src_tables:
            rows = src.execute("""
                SELECT year, player_id, contract_status FROM raw_rosters_start
            """).fetchall()
        else:
            rows = []
        src.close()
        for yr, pid, cs in rows:
            is_rookie = 1 if cs and "rookie" in cs.lower() else 0
            conn.execute(
                "UPDATE yoy_player_signals SET is_rookie_contract=? WHERE year=? AND player_id=?",
                (is_rookie, int(yr), str(pid)))
    conn.commit()
    conn.close()
    print(f"Ages updated: {updated} player-season rows")


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    conn = sqlite3.connect(str(OUT_DB))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS yoy_player_signals (
            year INTEGER,
            player_id TEXT,
            player_name TEXT,
            position TEXT,
            adp_rank INTEGER,
            adp_avg_pick REAL,
            adp_drafts_in INTEGER,
            salary INTEGER,
            contract_year INTEGER,
            contract_length INTEGER,
            ytd_score REAL,
            games_played INTEGER,
            games_started INTEGER,
            ppg REAL,
            ppstart REAL,
            PRIMARY KEY (year, player_id)
        )
    """)
    conn.commit()
    return conn


def gather():
    conn = init_db()
    salaries = load_salaries_from_db()
    print(f"Loaded {len(salaries)} (year, player) salary rows from DB")
    for year in YEARS:
        print(f"\n=== {year} ===", flush=True)
        adp = fetch_adp(year)
        scores = fetch_scores(year)
        players = fetch_players(year)
        games = fetch_weekly_games(year)
        print(f"  adp={len(adp)}, scores={len(scores)}, players={len(players)}, games-map={len(games)}")

        # Index player meta
        meta = {p.get("id"): p for p in players if p.get("id")}
        scores_idx = {s.get("id"): float(s.get("score") or 0) for s in scores if s.get("id")}
        adp_idx = {a.get("id"): a for a in adp if a.get("id")}

        # Union of all player ids seen
        ids = set(meta) | set(scores_idx) | set(adp_idx)
        rows = []
        for pid in ids:
            m = meta.get(pid, {})
            name = m.get("name", "")
            pos = m.get("position", "")
            if pos not in ("QB", "RB", "WR", "TE"):
                continue
            adp_entry = adp_idx.get(pid, {})
            salary_entry = salaries.get((year, pid), {})
            ytd = scores_idx.get(pid)
            g = games.get(pid, {})
            gp = g.get("games_played", 0)
            gs = g.get("games_started", 0)
            ppg = (ytd / gp) if (ytd and gp) else None
            ppstart = (ytd / gs) if (ytd and gs) else None
            rows.append((
                year, pid, name, pos,
                int(adp_entry.get("rank") or 0) or None,
                float(adp_entry.get("averagePick") or 0) or None,
                int(adp_entry.get("draftsSelectedIn") or 0) or None,
                salary_entry.get("salary"),
                salary_entry.get("contract_year"),
                salary_entry.get("contract_length"),
                ytd,
                gp or None,
                gs or None,
                ppg,
                ppstart,
            ))
        conn.executemany("""
            INSERT OR REPLACE INTO yoy_player_signals VALUES
            (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, rows)
        conn.commit()
        print(f"  inserted {len(rows)} rows")
    conn.close()
    print("\nGather complete.")


def _pearson(xs: list[float], ys: list[float]) -> float:
    """Pearson correlation — stdlib only."""
    if len(xs) < 3 or len(xs) != len(ys):
        return 0.0
    mx = statistics.mean(xs)
    my = statistics.mean(ys)
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(len(xs)))
    dx = sum((v - mx) ** 2 for v in xs) ** 0.5
    dy = sum((v - my) ** 2 for v in ys) ** 0.5
    if dx == 0 or dy == 0:
        return 0.0
    return num / (dx * dy)


def _spearman(xs: list[float], ys: list[float]) -> float:
    """Spearman rank correlation — stdlib."""
    if len(xs) < 3:
        return 0.0
    def rank(vs):
        order = sorted(range(len(vs)), key=lambda i: vs[i])
        ranks = [0.0] * len(vs)
        for r, idx in enumerate(order):
            ranks[idx] = r + 1
        return ranks
    return _pearson(rank(xs), rank(ys))


def correlate():
    if not OUT_DB.exists():
        print("No data yet. Run --gather first.")
        return
    conn = sqlite3.connect(str(OUT_DB))

    def fetch(year, min_score=20):
        """Return player signals for a year. Filters on ytd_score (proxy for
        meaningful playing time) since games_played isn't populated yet."""
        rows = conn.execute("""
            SELECT player_id, position, adp_rank, adp_avg_pick, salary,
                   ytd_score, games_played, ppg
            FROM yoy_player_signals
            WHERE year = ? AND (ytd_score IS NOT NULL AND ytd_score >= ?)
        """, (year, min_score)).fetchall()
        return {r[0]: dict(zip(
            ["player_id", "position", "adp_rank", "adp_avg_pick", "salary",
             "ytd_score", "games_played", "ppg"], r)) for r in rows}

    years = sorted(set(r[0] for r in conn.execute(
        "SELECT DISTINCT year FROM yoy_player_signals").fetchall()))
    print(f"Years in dataset: {years}\n")

    # ── Year-over-year stickiness ───────────────────────────────────────
    print("=" * 80)
    print("YEAR-OVER-YEAR STICKINESS (same player, year N vs N+1)")
    print("=" * 80)
    print(f"{'Pair':<12} {'Signal':<16} {'N':<6} {'Pearson':<10} {'Spearman':<10}")
    print("-" * 80)

    stickiness_agg: dict[str, list[float]] = {"adp_avg_pick": [], "salary": [], "ppg": [], "ytd_score": []}

    for i in range(len(years) - 1):
        y1, y2 = years[i], years[i + 1]
        a = fetch(y1)
        b = fetch(y2)
        shared = set(a) & set(b)
        for signal in ["adp_avg_pick", "salary", "ppg", "ytd_score"]:
            xs, ys = [], []
            for pid in shared:
                va, vb = a[pid][signal], b[pid][signal]
                if va is not None and vb is not None:
                    xs.append(float(va))
                    ys.append(float(vb))
            if len(xs) >= 5:
                p = _pearson(xs, ys)
                s = _spearman(xs, ys)
                stickiness_agg[signal].append(p)
                print(f"{y1}->{y2}    {signal:<16} {len(xs):<6} {p:<+10.3f} {s:<+10.3f}")

    print()
    print("AVERAGE STICKINESS (Pearson, across year-pairs):")
    for signal, vals in stickiness_agg.items():
        if vals:
            avg = statistics.mean(vals)
            print(f"  {signal:<16} {avg:+.3f}  (over {len(vals)} year-pairs)")

    # ── Cross predictors ───────────────────────────────────────────────
    print()
    print("=" * 80)
    print("CROSS PREDICTORS (same year, different signals)")
    print("=" * 80)
    print(f"{'Year':<6} {'Signal Pair':<30} {'N':<6} {'Pearson':<10} {'Spearman':<10}")
    print("-" * 80)

    same_year_agg: dict[str, list[float]] = {}
    for year in years:
        a = fetch(year)
        pairs = [
            ("adp_avg_pick -> ytd_score",  "adp_avg_pick", "ytd_score",  -1),  # lower ADP = better → negate
            ("adp_avg_pick -> ppg",         "adp_avg_pick", "ppg",         -1),
            ("salary -> ytd_score",         "salary",       "ytd_score",   +1),
            ("salary -> ppg",               "salary",       "ppg",         +1),
            ("salary -> adp_avg_pick",      "salary",       "adp_avg_pick", -1),
        ]
        for label, s1, s2, sign in pairs:
            xs, ys = [], []
            for pid, row in a.items():
                v1, v2 = row[s1], row[s2]
                if v1 is not None and v2 is not None:
                    xs.append(float(v1))
                    ys.append(float(v2))
            if len(xs) >= 10:
                p = _pearson(xs, ys) * sign
                s = _spearman(xs, ys) * sign
                same_year_agg.setdefault(label, []).append(p)
                print(f"{year:<6} {label:<30} {len(xs):<6} {p:<+10.3f} {s:<+10.3f}")

    print()
    print("AVERAGE CROSS-PREDICTORS (directional Pearson, sign-adjusted):")
    for label, vals in same_year_agg.items():
        if vals:
            avg = statistics.mean(vals)
            print(f"  {label:<30} {avg:+.3f}  (over {len(vals)} years)")

    # ── Predictive: year N signals -> year N+1 ytd_score ──────────────
    print()
    print("=" * 80)
    print("PREDICTIVE (year N signal -> year N+1 performance)")
    print("=" * 80)
    print(f"{'Pair':<12} {'Predictor':<20} {'Target':<14} {'N':<6} {'Pearson':<10}")
    print("-" * 80)

    predictive_agg: dict[str, list[float]] = {}
    for i in range(len(years) - 1):
        y1, y2 = years[i], years[i + 1]
        a = fetch(y1)
        b = fetch(y2)
        shared = set(a) & set(b)
        for label, pred_signal, sign in [
            ("prior_ppg", "ppg", +1),
            ("prior_ytd_score", "ytd_score", +1),
            ("prior_adp_avg_pick", "adp_avg_pick", -1),
            ("prior_salary", "salary", +1),
        ]:
            xs, ys = [], []
            for pid in shared:
                v1 = a[pid][pred_signal]
                v2 = b[pid]["ytd_score"]
                if v1 is not None and v2 is not None:
                    xs.append(float(v1))
                    ys.append(float(v2))
            if len(xs) >= 5:
                p = _pearson(xs, ys) * sign
                predictive_agg.setdefault(label, []).append(p)
                print(f"{y1}->{y2}    {label:<20} ytd_score      {len(xs):<6} {p:<+10.3f}")

    print()
    print("AVERAGE PREDICTIVE POWER (directional Pearson):")
    for label, vals in predictive_agg.items():
        if vals:
            avg = statistics.mean(vals)
            print(f"  {label:<20} {avg:+.3f}  (over {len(vals)} year-pairs)")

    # ── Position breakdowns (uses ytd_score since ppg is null) ─────────
    print()
    print("=" * 80)
    print("POSITION-SEGMENTED STICKINESS (ytd_score year-over-year)")
    print("=" * 80)
    print(f"{'Pair':<12} {'Pos':<4} {'N':<6} {'Score':<10} {'ADP':<10}")
    print("-" * 80)

    pos_agg_score: dict[str, list[float]] = {"QB": [], "RB": [], "WR": [], "TE": []}
    pos_agg_adp: dict[str, list[float]] = {"QB": [], "RB": [], "WR": [], "TE": []}
    for i in range(len(years) - 1):
        y1, y2 = years[i], years[i + 1]
        a = fetch(y1)
        b = fetch(y2)
        shared = set(a) & set(b)
        for pos in ("QB", "RB", "WR", "TE"):
            xs_s, ys_s, xs_a, ys_a = [], [], [], []
            for pid in shared:
                if a[pid]["position"] != pos:
                    continue
                if a[pid]["ytd_score"] is not None and b[pid]["ytd_score"] is not None:
                    xs_s.append(float(a[pid]["ytd_score"]))
                    ys_s.append(float(b[pid]["ytd_score"]))
                if a[pid]["adp_avg_pick"] is not None and b[pid]["adp_avg_pick"] is not None:
                    xs_a.append(float(a[pid]["adp_avg_pick"]))
                    ys_a.append(float(b[pid]["adp_avg_pick"]))
            p_s = _pearson(xs_s, ys_s) if len(xs_s) >= 5 else None
            p_a = _pearson(xs_a, ys_a) if len(xs_a) >= 5 else None
            if p_s is not None:
                pos_agg_score[pos].append(p_s)
            if p_a is not None:
                pos_agg_adp[pos].append(p_a)
            ss = f"{p_s:+.3f}" if p_s is not None else "-"
            sa = f"{p_a:+.3f}" if p_a is not None else "-"
            print(f"{y1}->{y2}    {pos:<4} {len(xs_s):<6} {ss:<10} {sa:<10}")

    print()
    print("AVERAGE STICKINESS BY POSITION:")
    print(f"  {'Pos':<4} {'ytd_score':<12} {'adp_avg_pick':<14}")
    for pos in ("QB", "RB", "WR", "TE"):
        s = statistics.mean(pos_agg_score[pos]) if pos_agg_score[pos] else 0
        a = statistics.mean(pos_agg_adp[pos]) if pos_agg_adp[pos] else 0
        print(f"  {pos:<4} {s:+.3f}       {a:+.3f}")

    conn.close()


def extended_correlate():
    """Stickiness + predictive power comparison across prior_ppg, elite_plus_ratio,
    and current ADP — segmented by position, age bucket, and contract status."""
    if not OUT_DB.exists():
        print("No data. Run --gather + --merge-elite + --ages first.")
        return
    conn = sqlite3.connect(str(OUT_DB))

    def fetch(year):
        rows = conn.execute("""
            SELECT player_id, position, ppg, ytd_score, games_played, games_started,
                   elite_plus_ratio, adp_avg_pick, age_at_season, is_rookie_contract
            FROM yoy_player_signals
            WHERE ytd_score IS NOT NULL AND ytd_score >= 20
        """).fetchall()
        rows = [r for r in rows if r]
        # Re-query with year filter
        rows = conn.execute("""
            SELECT player_id, position, ppg, ytd_score, games_played, games_started,
                   elite_plus_ratio, adp_avg_pick, age_at_season, is_rookie_contract
            FROM yoy_player_signals
            WHERE year = ? AND ytd_score IS NOT NULL AND ytd_score >= 20
        """, (year,)).fetchall()
        cols = ["player_id", "position", "ppg", "ytd_score", "games_played",
                "games_started", "elite_plus_ratio", "adp_avg_pick",
                "age_at_season", "is_rookie_contract"]
        return {r[0]: dict(zip(cols, r)) for r in rows}

    years = sorted(set(r[0] for r in conn.execute(
        "SELECT DISTINCT year FROM yoy_player_signals").fetchall()))
    print(f"Years: {years}\n")

    # ── Overall stickiness comparison ─────────────────────────────────
    print("=" * 90)
    print("OVERALL: prior signal vs. next-year ytd_score (Pearson, avg across pairs)")
    print("=" * 90)
    print(f"  {'Predictor':<25} {'Avg r':<10} {'N pairs':<10}")
    print("-" * 60)
    def run_predictive(filter_fn=None, label=""):
        results: dict[str, list[float]] = {}
        pair_counts: dict[str, int] = {}
        for i in range(len(years) - 1):
            y1, y2 = years[i], years[i + 1]
            a = fetch(y1)
            b = fetch(y2)
            shared = set(a) & set(b)
            if filter_fn:
                shared = {pid for pid in shared if filter_fn(a[pid])}
            for pred_label, pred_signal, sign in [
                ("prior_ppg", "ppg", +1),
                ("prior_ytd_score", "ytd_score", +1),
                ("prior_elite_plus_ratio", "elite_plus_ratio", +1),
                ("prior_adp_avg_pick", "adp_avg_pick", -1),
            ]:
                xs, ys = [], []
                for pid in shared:
                    v1 = a[pid][pred_signal]
                    v2 = b[pid]["ytd_score"]
                    if v1 is not None and v2 is not None:
                        xs.append(float(v1))
                        ys.append(float(v2))
                if len(xs) >= 10:
                    r = _pearson(xs, ys) * sign
                    results.setdefault(pred_label, []).append(r)
                    pair_counts[pred_label] = pair_counts.get(pred_label, 0) + len(xs)
        return results, pair_counts

    overall_results, overall_counts = run_predictive()
    for label in ("prior_ppg", "prior_ytd_score", "prior_elite_plus_ratio", "prior_adp_avg_pick"):
        vals = overall_results.get(label, [])
        if vals:
            print(f"  {label:<25} {statistics.mean(vals):+.3f}    {len(vals):<10}")

    # ── By position ──────────────────────────────────────────────────
    print()
    print("=" * 90)
    print("BY POSITION")
    print("=" * 90)
    print(f"  {'Pos':<6} {'Predictor':<25} {'Avg r':<10} {'N pairs':<10}")
    print("-" * 60)
    for pos in ("QB", "RB", "WR", "TE"):
        res, cnts = run_predictive(lambda row, pos=pos: row["position"] == pos)
        for label in ("prior_ppg", "prior_elite_plus_ratio", "prior_adp_avg_pick"):
            vals = res.get(label, [])
            if vals:
                print(f"  {pos:<6} {label:<25} {statistics.mean(vals):+.3f}    {len(vals):<10}")
        print()

    # ── By age bucket ──────────────────────────────────────────────
    print("=" * 90)
    print("BY AGE BUCKET")
    print("=" * 90)
    print(f"  {'Age':<8} {'Predictor':<25} {'Avg r':<10} {'N pairs':<10}")
    print("-" * 60)
    age_buckets = [
        ("<24", lambda row: row["age_at_season"] and row["age_at_season"] < 24),
        ("24-27", lambda row: row["age_at_season"] and 24 <= row["age_at_season"] <= 27),
        ("28-30", lambda row: row["age_at_season"] and 28 <= row["age_at_season"] <= 30),
        ("31+", lambda row: row["age_at_season"] and row["age_at_season"] >= 31),
    ]
    for name, fn in age_buckets:
        res, _ = run_predictive(fn)
        for label in ("prior_ppg", "prior_elite_plus_ratio", "prior_adp_avg_pick"):
            vals = res.get(label, [])
            if vals:
                print(f"  {name:<8} {label:<25} {statistics.mean(vals):+.3f}    {len(vals):<10}")
        print()

    # ── By contract status ────────────────────────────────────────
    print("=" * 90)
    print("BY CONTRACT (rookie vs non-rookie)")
    print("=" * 90)
    for name, fn in [
        ("Rookie", lambda r: r["is_rookie_contract"] == 1),
        ("Non-rookie", lambda r: r["is_rookie_contract"] == 0),
    ]:
        res, _ = run_predictive(fn)
        for label in ("prior_ppg", "prior_elite_plus_ratio", "prior_adp_avg_pick"):
            vals = res.get(label, [])
            if vals:
                print(f"  {name:<12} {label:<25} {statistics.mean(vals):+.3f}    {len(vals):<10}")
        print()

    conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--gather", action="store_true", help="fetch and store data")
    ap.add_argument("--correlate", action="store_true", help="compute correlations")
    ap.add_argument("--merge-elite", action="store_true",
                    help="merge Elite/Plus buckets from player_points_history.json")
    ap.add_argument("--ages", action="store_true",
                    help="pull player ages + rookie-contract flag")
    ap.add_argument("--extended", action="store_true",
                    help="extended correlate by pos/age/contract")
    args = ap.parse_args()
    if not any([args.gather, args.correlate, args.merge_elite, args.ages, args.extended]):
        ap.print_help()
        sys.exit(1)
    if args.gather:
        gather()
    if args.merge_elite:
        merge_elite_plus_from_points_history()
    if args.ages:
        fetch_and_store_ages()
    if args.correlate:
        correlate()
    if args.extended:
        extended_correlate()
