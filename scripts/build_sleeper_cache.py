#!/usr/bin/env python3
"""Resolve MFL players → Sleeper facts once, offline, into D1.

WHY THIS RUNS IN CI AND NOT IN THE WORKER
    /api/player-news fetched Sleeper's 14.6 MB player file and JSON.parse'd it on
    every request. That exceeds the Worker's CPU budget; the surrounding catch is
    fail-soft, so `sleeperIndex` silently stayed {} and EVERY player reported
    sleeper_matched: 0 — no injury status, no depth chart, for anyone. Measured
    2026-08-27 against Trey Benson and Patrick Mahomes.

MATCHING BY ID + BIO, NOT NAME (#1356, 2026-10-21)
    MFL's DETAILS export carries `rotowire_id` and `espn_id`; Sleeper carries the
    same two ids. Candidates are the Sleeper rows sharing either id or the full
    name + team; one is accepted only when at least 2 independent facts agree
    (ids, birthdate, normalized name, team) net of contradictions (a different
    position, a differing id). No single fact is trusted: Sleeper's retired
    rows carry stale RotoWire ids that now belong to active players (6 rows on
    2026-10-21; one even lists a kicker as "DL"), MFL lists Ryan Izzo's ESPN id
    on Tyler Conklin, and birthdates disagree by a year for ~40 real matches.

    Measured 2026-10-21: bare name + team matched 1,771 of 2,694 MFL players and
    missed 25 rostered UPS players (D.J. Moore, Tre Harris, Chris Brazzell II,
    Marvin Harrison Jr., ...).

    The worker's shared news feed reads `full_name` of id-matched rows as
    nicknames ("Kam Curl" for MFL's "Kamren Curl"), so only id-joined rows are
    trusted for that (matched_by IN ('rotowire_id','espn_id')).

WRITES ONLY WHAT CHANGED (#1356)
    This job used to DELETE the whole table and re-INSERT every row daily: 7,082
    D1 rows written per day (2026-10-20 run) whether or not anything changed. It
    now upserts with `WHERE <some value differs>` (pipelines/etl/lib/d1_io.py
    build_insert) and deletes only players that no longer match. `built_at_utc`
    is set when a row changes and never counts as a change by itself, so it now
    means "last changed".

Usage:
    python3 scripts/build_sleeper_cache.py --dry-run
    python3 scripts/build_sleeper_cache.py --apply
    python3 scripts/build_sleeper_cache.py --dry-run --mfl FILE --sleeper FILE --sql-out FILE
        offline: read recorded inputs, write the SQL, touch nothing
    python3 scripts/build_sleeper_cache.py --dry-run ... --diff-against FILE
        offline: count inserts / updates / deletes against a JSON snapshot of the
        table (a list of row objects) — the changed-row measurement in #1356
"""
import argparse, json, os, re, subprocess, sys, unicodedata, urllib.request
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "pipelines", "etl"))
from lib.d1_io import build_insert  # noqa: E402

LEAGUE, SEASON = "74598", "2026"
UA = {"User-Agent": "upsmflproduction-sleeper-cache", "Accept": "application/json"}
TABLE = "sleeper_player_cache"
COLS = ["mfl_player_id", "sleeper_player_id", "full_name", "team", "injury_status",
        "injury_body_part", "injury_notes", "practice_participation", "practice_description",
        "depth_chart_position", "depth_chart_order", "news_updated", "matched_by", "built_at_utc"]
CHUNK = 150          # rows per UPSERT statement (well under d1_io's 95 KB statement limit)

# MFL's team codes -> Sleeper's. MFL pads several to three letters; Sleeper uses
# the NFL's own abbreviations. Only the ones that actually differ are listed.
TEAM_FIX = {
    "KCC": "KC", "GBP": "GB", "SFO": "SF", "TBB": "TB", "NEP": "NE",
    "NOS": "NO", "LVR": "LV", "JAC": "JAX", "WAS": "WAS", "ARZ": "ARI",
}


def get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120))


def norm_team(t):
    t = (t or "").upper()
    return TEAM_FIX.get(t, t)


def _id(v):
    s = str(v if v is not None else "").strip()
    return "" if s in ("", "0", "None") else s


def _blank(v):
    return None if v is None or v == "" else v


def _mfl_dob(m):
    """MFL birthdate (unix seconds at ET midnight) → 'YYYY-MM-DD'."""
    try:
        ts = int(m.get("birthdate") or 0)
    except (TypeError, ValueError):
        return ""
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d") if ts > 0 else ""


# MFL position → Sleeper positions that describe the same player.
POS_COMPAT = {
    "QB": {"QB"}, "RB": {"RB", "FB"}, "WR": {"WR"}, "TE": {"TE"}, "PK": {"K"}, "PN": {"P"},
    "DE": {"DE", "DL", "LB", "OLB", "EDGE"}, "DT": {"DT", "DL", "DE", "NT"}, "LB": {"LB", "OLB", "ILB", "DE", "DL"},
    "CB": {"CB", "DB"}, "S": {"S", "SS", "FS", "DB"},
}


def norm_name(s):
    """Same idea as the worker's normName: accents, punctuation and Jr/II off."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"['’.`]", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r" (jr|sr|ii|iii|iv|v)$", "", s)


def _mfl_full_name(m):
    nm = m.get("name") or ""
    return " ".join(reversed([x.strip() for x in nm.split(",")])) if "," in nm else nm


def _agreement(m, p):
    """How many independent facts say MFL row m and Sleeper row p are one person.

    Counts: same RotoWire id, same ESPN id, same birthdate, same normalized
    name, same team. Minus one for each contradiction: a different position,
    or a RotoWire / ESPN id present on both sides that differs. -1 for
    Sleeper's "Duplicate Player" rows.

    No single fact is trusted on its own (2026-10-21):
      - Sleeper's retired rows carry stale RotoWire ids that now belong to active
        players: Jamar Johnson (DB, born 1999, no team) holds the id of Amar
        Johnson (RB, born 2003, LAC) — 6 such rows.
      - MFL lists Ryan Izzo's ESPN id on Tyler Conklin.
      - Birthdates disagree by a year or a transposed day for ~40 real matches
        (Ladd McConkey 11-01 vs 11-11).
    """
    if (p.get("full_name") or "") == "Duplicate Player":
        return -1
    mpos = str(m.get("position") or "")
    spos = {str(x) for x in ([p.get("position")] + list(p.get("fantasy_positions") or [])) if x}
    # A different position counts AGAINST (players do switch: Connor Heyward
    # TE/FB, Marte Mapu LB/S), it doesn't veto.
    n = -1 if (mpos in POS_COMPAT and spos and not (POS_COMPAT[mpos] & spos)) else 0
    mrw, prw = _id(m.get("rotowire_id")), _id(p.get("rotowire_id"))
    mes, pes = _id(m.get("espn_id")), _id(p.get("espn_id"))
    md, pd = _mfl_dob(m), str(p.get("birth_date") or "").strip()
    mt, st = norm_team(m.get("team")), norm_team(p.get("team"))
    n += 1 if (mrw and mrw == prw) else (-1 if (mrw and prw) else 0)
    n += 1 if (mes and mes == pes) else (-1 if (mes and pes) else 0)
    n += bool(md and md == pd)
    n += bool(norm_name(_mfl_full_name(m)) and norm_name(_mfl_full_name(m)) == norm_name(p.get("full_name")))
    n += bool(mt and mt not in ("FA",) and mt == st)
    return n


def resolve(mfl, sleeper, now=None):
    """MFL DETAILS rows + Sleeper's player map → (rows, stats). Pure.

    Candidates are the Sleeper rows that share MFL's RotoWire id, its ESPN id,
    or its full name + team. The one with the most agreeing facts (_agreement)
    wins if it scores at least 2 and no other candidate ties it. `matched_by`
    names the strongest key it shares: rotowire_id, espn_id, else name_team.
    Never a bare name: name + team alone scores 2 only with no contradiction.
    """
    now = now or datetime.now(timezone.utc).isoformat()
    by_rw, by_espn, by_name_team = {}, {}, {}
    for sid, p in sleeper.items():
        if not p:
            continue
        rw, es = _id(p.get("rotowire_id")), _id(p.get("espn_id"))
        if rw:
            by_rw.setdefault(rw, []).append((sid, p))
        if es:
            by_espn.setdefault(es, []).append((sid, p))
        fn = norm_name(p.get("full_name"))
        tm = norm_team(p.get("team"))
        if fn and tm:
            by_name_team.setdefault(f"{fn}|{tm}", []).append((sid, p))

    stats = {"rotowire_id": 0, "espn_id": 0, "name_team": 0, "ambiguous": 0, "weak": 0, "none": 0}
    rows = []
    for m in mfl:
        pid = str(m.get("id") or "")
        if not pid:
            continue
        rw, es = _id(m.get("rotowire_id")), _id(m.get("espn_id"))
        cands = {}
        for key, idx in ((rw, by_rw), (es, by_espn)):
            for sid, p in (idx.get(key, []) if key else []):
                cands[sid] = p
        for sid, p in by_name_team.get(f"{norm_name(_mfl_full_name(m))}|{norm_team(m.get('team'))}", []):
            cands[sid] = p
        scored = sorted(((_agreement(m, p), sid, p) for sid, p in cands.items()), key=lambda x: -x[0])
        hit, kind = None, ("weak" if cands else "none")
        if scored and scored[0][0] >= 2:
            if len(scored) > 1 and scored[1][0] == scored[0][0]:
                kind = "ambiguous"
            else:
                _, sid, p = scored[0]
                hit = (sid, p)
                kind = ("rotowire_id" if rw and rw == _id(p.get("rotowire_id"))
                        else "espn_id" if es and es == _id(p.get("espn_id")) else "name_team")
        stats[kind] += 1
        if not hit:
            continue
        sid, p = hit
        rows.append((pid, sid, _blank(p.get("full_name")), _blank(norm_team(p.get("team"))),
                     _blank(p.get("injury_status")), _blank(p.get("injury_body_part")), _blank(p.get("injury_notes")),
                     _blank(p.get("practice_participation")), _blank(p.get("practice_description")),
                     _blank(p.get("depth_chart_position")), p.get("depth_chart_order"),
                     p.get("news_updated"), kind, now))
    return rows, stats


def build_sql(rows):
    """Changed-row-only UPSERTs + a delete of players that no longer match."""
    stmts = []
    for i in range(0, len(rows), CHUNK):
        stmts.append(build_insert(TABLE, COLS, rows[i:i + CHUNK], pk_cols=["mfl_player_id"],
                                  changed_only=True, change_ignore_cols=["built_at_utc"]))
    keep = ", ".join("'" + r[0].replace("'", "''") + "'" for r in rows)
    stmts.append(f"DELETE FROM {TABLE} WHERE mfl_player_id NOT IN ({keep});\n")
    return "".join(stmts)


def diff_against(rows, snapshot):
    """Count what build_sql would write against a snapshot of the table."""
    cur = {str(r["mfl_player_id"]): r for r in snapshot}
    new_ids = set()
    ins = upd = 0
    changed_cols = {}
    for r in rows:
        new_ids.add(r[0])
        old = cur.get(r[0])
        if old is None:
            ins += 1
            continue
        diff = [c for c, v in zip(COLS, r) if c not in ("mfl_player_id", "built_at_utc") and old.get(c) != v]
        if diff:
            upd += 1
            for c in diff:
                changed_cols[c] = changed_cols.get(c, 0) + 1
    dele = sum(1 for k in cur if k not in new_ids)
    return {"inserts": ins, "updates": upd, "deletes": dele, "unchanged": len(rows) - ins - upd,
            "rows_touched": ins + upd + dele, "changed_columns": changed_cols}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--dry-run", action="store_true")
    ap.add_argument("--mfl", help="recorded MFL TYPE=players&DETAILS=1 JSON (offline)")
    ap.add_argument("--sleeper", help="recorded Sleeper /v1/players/nfl JSON (offline)")
    ap.add_argument("--sql-out", help="write the SQL here")
    ap.add_argument("--diff-against", help="JSON list of current table rows (offline measurement)")
    a = ap.parse_args(argv)

    if a.apply and (a.mfl or a.sleeper):
        print("REFUSE: --apply reads live MFL + Sleeper, never recorded files.")
        return 2
    mfl = (json.load(open(a.mfl)) if a.mfl else get(
        f"https://www48.myfantasyleague.com/{SEASON}/export?TYPE=players&L={LEAGUE}&DETAILS=1&JSON=1"))["players"]["player"]
    sleeper = json.load(open(a.sleeper)) if a.sleeper else get("https://api.sleeper.app/v1/players/nfl")
    print(f"  MFL players     : {len(mfl):,}")
    print(f"  Sleeper players : {len(sleeper):,}")

    rows, stats = resolve(mfl, sleeper)
    for k in ("rotowire_id", "espn_id", "name_team", "ambiguous", "weak", "none"):
        print(f"  {k:<18}: {stats[k]:,}")
    print(f"  rows to keep    : {len(rows):,}")

    # A collapse to near-zero means the upstream shape changed — writing that
    # would delete a working cache, which is exactly the silent failure this
    # whole file exists to end.
    if len(rows) < 500:
        print(f"REFUSE: only {len(rows)} matches — expected >500. Not writing.")
        return 2

    sql = build_sql(rows)
    if a.sql_out:
        with open(a.sql_out, "w") as fh:
            fh.write(sql)
        print(f"  SQL written     : {a.sql_out} ({len(sql):,} bytes)")
    if a.diff_against:
        d = diff_against(rows, json.load(open(a.diff_against)))
        print("  vs snapshot     : " + json.dumps(d, sort_keys=True))

    if not a.apply:
        print("\n  DRY RUN — nothing written.")
        return 0

    path = "/tmp/sleeper_cache.sql"
    with open(path, "w") as fh:
        fh.write(sql)
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", path],
        capture_output=True, text=True, cwd=os.path.join(ROOT, "worker"))
    tail = (out.stdout + out.stderr)[-500:]
    print(tail)
    return 0 if out.returncode == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
