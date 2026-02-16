#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
import sqlite3
import time
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

SERVICE_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = SERVICE_ROOT / "data"
WEB_DIR = SERVICE_ROOT / "web"

SEED_PATH = Path(os.getenv("MCM_SEED_PATH", str(DATA_DIR / "mcm_seed.json")))
DB_PATH = Path(os.getenv("MCM_DB_PATH", str(DATA_DIR / "mcm.db")))
ADMIN_TOKEN = os.getenv("MCM_ADMIN_TOKEN", "").strip()

REQUEST_WINDOW_SECONDS = 600
MAX_NOMINATIONS_PER_WINDOW = 6
MAX_VOTES_PER_WINDOW = 25
IP_BUCKETS_NOM = {}
IP_BUCKETS_VOTE = {}


def utc_now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalize_text(value):
    if value is None:
        return ""
    return str(value).strip()


def is_valid_url(value):
    if not value:
        return False
    try:
        p = urlparse(value)
        return p.scheme in {"http", "https"} and bool(p.netloc)
    except Exception:
        return False


def throttle_ok(ip, bucket_map, max_in_window):
    now = int(time.time())
    bucket = bucket_map.get(ip, [])
    bucket = [t for t in bucket if now - t <= REQUEST_WINDOW_SECONDS]
    if len(bucket) >= max_in_window:
        bucket_map[ip] = bucket
        return False
    bucket.append(now)
    bucket_map[ip] = bucket
    return True


def load_seed():
    with SEED_PATH.open("r", encoding="utf-8") as fh:
        seed = json.load(fh)
    if seed.get("schema_version") != "v1":
        raise ValueError("Unsupported seed schema_version")
    genres = seed.get("genres", [])
    genre_ids = {g.get("id") for g in genres if g.get("id")}
    if not genre_ids:
        raise ValueError("Seed must include genres")
    nominees = seed.get("nominees", [])
    for n in nominees:
        if n.get("genre_id") not in genre_ids:
            raise ValueError(f"Unknown genre_id for nominee {n.get('id')}")
    cycle = seed.get("genres_cycle") or [g["id"] for g in genres if "id" in g]
    cycle = [gid for gid in cycle if gid in genre_ids]
    if not cycle:
        raise ValueError("genres_cycle must reference valid genre ids")
    return seed, {g["id"]: g for g in genres if "id" in g}, cycle


def init_db(conn):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS mcm_nominees (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          genre_id TEXT NOT NULL,
          primary_url TEXT NOT NULL,
          image_url TEXT,
          source TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          created_at_utc TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS mcm_nominations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at_utc TEXT NOT NULL,
          source_ip TEXT NOT NULL,
          user_agent TEXT,
          display_name TEXT NOT NULL,
          genre_id TEXT NOT NULL,
          primary_url TEXT NOT NULL,
          image_url TEXT,
          notes TEXT,
          attestation_adult INTEGER NOT NULL,
          attestation_respectful INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          decided_at_utc TEXT,
          decision_reason TEXT,
          payload_json TEXT NOT NULL,
          dedupe_hash TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mcm_nominations_dedupe ON mcm_nominations(dedupe_hash)"
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS mcm_votes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at_utc TEXT NOT NULL,
          source_ip TEXT NOT NULL,
          user_agent TEXT,
          season_year INTEGER NOT NULL,
          week_no INTEGER NOT NULL,
          phase TEXT NOT NULL DEFAULT 'regular',
          genre_id TEXT NOT NULL,
          matchup_key TEXT NOT NULL DEFAULT 'regular',
          nominee_id TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
        """
    )
    # Migration: older DBs only supported one vote per week. Playoffs need one vote per matchup.
    cols = [r[1] for r in conn.execute("PRAGMA table_info(mcm_votes)").fetchall()]
    if "phase" not in cols:
        conn.execute("ALTER TABLE mcm_votes ADD COLUMN phase TEXT NOT NULL DEFAULT 'regular'")
    if "matchup_key" not in cols:
        conn.execute("ALTER TABLE mcm_votes ADD COLUMN matchup_key TEXT NOT NULL DEFAULT 'regular'")
    conn.execute("UPDATE mcm_votes SET phase=COALESCE(phase,'regular'), matchup_key=COALESCE(matchup_key,'regular')")
    conn.execute("DROP INDEX IF EXISTS idx_mcm_votes_one_per_ip_week")
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_mcm_votes_one_per_ip_week_matchup ON mcm_votes(season_year, week_no, source_ip, matchup_key)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_mcm_votes_week ON mcm_votes(season_year, week_no)"
    )
    conn.commit()


def sync_seed_nominees(conn, seed):
    now = utc_now_iso()
    seed_nominees = seed.get("nominees", [])
    existing = {row[0] for row in conn.execute("SELECT id FROM mcm_nominees").fetchall()}
    to_insert = []
    for n in seed_nominees:
        nid = normalize_text(n.get("id"))
        if not nid or nid in existing:
            continue
        to_insert.append(
            (
                nid,
                normalize_text(n.get("display_name")),
                normalize_text(n.get("genre_id")),
                normalize_text(n.get("primary_url")),
                normalize_text(n.get("image_url")),
                "seed",
                1,
                now,
            )
        )
    if to_insert:
        conn.executemany(
            """
            INSERT INTO mcm_nominees (
              id, display_name, genre_id, primary_url, image_url, source, active, created_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            to_insert,
        )
        conn.commit()


def first_monday_of_year(year):
    d = date(year, 1, 1)
    offset = (7 - d.weekday()) % 7  # weekday: Mon=0
    # If Jan 1 is Monday, offset=0, which is correct (first Monday is Jan 1).
    return d + timedelta(days=offset)


def current_season_year(seed):
    mode = normalize_text(seed.get("season", {}).get("year_mode"))
    if mode == "current" or not mode:
        return datetime.now(timezone.utc).date().year
    try:
        return int(mode)
    except Exception:
        return datetime.now(timezone.utc).date().year


def season_start_date(seed, year):
    start = normalize_text(seed.get("season", {}).get("season_start"))
    if start == "first_monday" or not start:
        return first_monday_of_year(year)
    # Allow explicit ISO date in seed later.
    try:
        parts = [int(p) for p in start.split("-")]
        if len(parts) == 3:
            return date(parts[0], parts[1], parts[2])
    except Exception:
        pass
    return first_monday_of_year(year)


def week_info_by_number(seed, cycle, week_no):
    year = current_season_year(seed)
    start = season_start_date(seed, year)
    regular_weeks = int(seed.get("season", {}).get("regular_weeks", 48))
    playoff_weeks = int(seed.get("season", {}).get("playoff_weeks", 4))
    total_weeks = regular_weeks + playoff_weeks
    try:
        w = int(week_no)
    except Exception:
        w = 1
    w = max(1, min(w, total_weeks))
    phase = "regular" if w <= regular_weeks else "playoffs"
    genre_id = cycle[(w - 1) % len(cycle)] if phase == "regular" else "playoffs"
    week_start = start + timedelta(days=(w - 1) * 7)
    week_end = week_start + timedelta(days=6)
    return {
        "season_year": year,
        "season_start": start.isoformat(),
        "regular_weeks": regular_weeks,
        "playoff_weeks": playoff_weeks,
        "total_weeks": total_weeks,
        "week_no": w,
        "phase": phase,
        "genre_id": genre_id,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "today_utc": week_end.isoformat(),
    }


def week_info(seed, cycle, today_utc=None):
    if today_utc is None:
        today_utc = datetime.now(timezone.utc).date()
    year = current_season_year(seed)
    start = season_start_date(seed, year)
    delta_days = (today_utc - start).days
    if delta_days < 0:
        week_no = 1
    else:
        week_no = (delta_days // 7) + 1
    regular_weeks = int(seed.get("season", {}).get("regular_weeks", 48))
    playoff_weeks = int(seed.get("season", {}).get("playoff_weeks", 4))
    total_weeks = regular_weeks + playoff_weeks
    capped_week = max(1, min(week_no, total_weeks))
    phase = "regular" if capped_week <= regular_weeks else "playoffs"
    if phase == "regular":
        genre_id = cycle[(capped_week - 1) % len(cycle)]
    else:
        genre_id = "playoffs"
    week_start = start + timedelta(days=(capped_week - 1) * 7)
    week_end = week_start + timedelta(days=6)
    return {
        "season_year": year,
        "season_start": start.isoformat(),
        "regular_weeks": regular_weeks,
        "playoff_weeks": playoff_weeks,
        "total_weeks": total_weeks,
        "week_no": capped_week,
        "phase": phase,
        "genre_id": genre_id,
        "week_start": week_start.isoformat(),
        "week_end": week_end.isoformat(),
        "today_utc": today_utc.isoformat(),
    }


def playoff_round_for_week(week_no, regular_weeks, playoff_weeks):
    # Fixed 4-week bracket: R16, QF, SF, F (weeks regular_weeks+1..regular_weeks+4).
    if playoff_weeks < 4:
        return None
    offset = week_no - regular_weeks
    if offset == 1:
        return {"id": "R16", "name": "Round of 16", "matchups": 8}
    if offset == 2:
        return {"id": "QF", "name": "Quarterfinals", "matchups": 4}
    if offset == 3:
        return {"id": "SF", "name": "Semifinals", "matchups": 2}
    if offset == 4:
        return {"id": "F", "name": "Final", "matchups": 1}
    return None


def compute_seeds(conn, season_year, regular_weeks, want=16):
    rows = conn.execute(
        """
        SELECT v.nominee_id, COUNT(*) AS votes
        FROM mcm_votes v
        WHERE v.season_year=? AND v.week_no<=? AND v.phase='regular'
        GROUP BY v.nominee_id
        ORDER BY votes DESC, v.nominee_id ASC
        LIMIT ?
        """,
        (season_year, regular_weeks, want),
    ).fetchall()
    seed_ids = [r[0] for r in rows]

    if len(seed_ids) < want:
        missing = want - len(seed_ids)
        fillers = conn.execute(
            """
            SELECT id
            FROM mcm_nominees
            WHERE active=1 AND id NOT IN (
              SELECT nominee_id FROM mcm_votes WHERE season_year=? AND week_no<=? AND phase='regular'
            )
            ORDER BY source DESC, display_name ASC
            LIMIT ?
            """,
            (season_year, regular_weeks, missing),
        ).fetchall()
        seed_ids.extend([r[0] for r in fillers])

    return {nid: i + 1 for i, nid in enumerate(seed_ids)}


def matchup_pairs_for_round(round_id, seed_map, prev_winners):
    # Returns list of (matchup_key, a_id, b_id).
    seeds_by_num = {num: nid for nid, num in seed_map.items()}

    def s(n):
        return seeds_by_num.get(n)

    if round_id == "R16":
        pairs = [(1, 16), (8, 9), (5, 12), (4, 13), (6, 11), (3, 14), (7, 10), (2, 15)]
        return [(f"R16-{i}", s(a), s(b)) for i, (a, b) in enumerate(pairs, start=1)]

    if round_id == "QF":
        return [
            ("QF-1", prev_winners.get("R16-1"), prev_winners.get("R16-2")),
            ("QF-2", prev_winners.get("R16-3"), prev_winners.get("R16-4")),
            ("QF-3", prev_winners.get("R16-5"), prev_winners.get("R16-6")),
            ("QF-4", prev_winners.get("R16-7"), prev_winners.get("R16-8")),
        ]

    if round_id == "SF":
        return [
            ("SF-1", prev_winners.get("QF-1"), prev_winners.get("QF-2")),
            ("SF-2", prev_winners.get("QF-3"), prev_winners.get("QF-4")),
        ]

    if round_id == "F":
        return [("F-1", prev_winners.get("SF-1"), prev_winners.get("SF-2"))]

    return []


def winner_for_matchup(conn, season_year, week_no, matchup_key, a_id, b_id, seed_map):
    if not a_id or not b_id:
        return a_id or b_id
    rows = conn.execute(
        """
        SELECT nominee_id, COUNT(*) AS c
        FROM mcm_votes
        WHERE season_year=? AND week_no=? AND phase='playoffs' AND matchup_key=? AND nominee_id IN (?, ?)
        GROUP BY nominee_id
        """,
        (season_year, week_no, matchup_key, a_id, b_id),
    ).fetchall()
    counts = {r[0]: int(r[1]) for r in rows}
    a_c = counts.get(a_id, 0)
    b_c = counts.get(b_id, 0)
    if a_c > b_c:
        return a_id
    if b_c > a_c:
        return b_id
    a_seed = seed_map.get(a_id, 10_000)
    b_seed = seed_map.get(b_id, 10_000)
    if a_seed < b_seed:
        return a_id
    if b_seed < a_seed:
        return b_id
    return min(a_id, b_id)



def dedupe_hash(canonical):
    raw = json.dumps(canonical, sort_keys=True, ensure_ascii=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def validate_nomination(payload, genre_ids):
    errors = []
    display_name = normalize_text(payload.get("display_name"))
    genre_id = normalize_text(payload.get("genre_id"))
    primary_url = normalize_text(payload.get("primary_url"))
    image_url = normalize_text(payload.get("image_url"))
    notes = normalize_text(payload.get("notes"))
    att_adult = bool(payload.get("attestation_adult"))
    att_respectful = bool(payload.get("attestation_respectful"))

    if len(display_name) < 2 or len(display_name) > 80:
        errors.append("display_name must be 2-80 characters.")
    if genre_id not in genre_ids:
        errors.append("Invalid genre_id.")
    if not is_valid_url(primary_url) or len(primary_url) > 500:
        errors.append("primary_url must be a valid http(s) URL (max 500 chars).")
    if image_url:
        if not is_valid_url(image_url) or len(image_url) > 500:
            errors.append("image_url must be a valid http(s) URL (max 500 chars) or blank.")
    if len(notes) > 500:
        errors.append("notes max length is 500.")
    if not att_adult:
        errors.append("attestation_adult is required.")
    if not att_respectful:
        errors.append("attestation_respectful is required.")

    canonical = {
        "display_name": display_name,
        "genre_id": genre_id,
        "primary_url": primary_url,
        "image_url": image_url,
        "notes": notes,
        "attestation_adult": att_adult,
        "attestation_respectful": att_respectful,
        "submission_format_version": "v1",
    }
    return errors, canonical


def validate_vote(payload):
    errors = []
    nominee_id = normalize_text(payload.get("nominee_id"))
    matchup_key = normalize_text(payload.get("matchup_key")) or "regular"
    if not nominee_id or len(nominee_id) > 120:
        errors.append("nominee_id is required.")
    if len(matchup_key) > 40:
        errors.append("matchup_key is too long.")
    canonical = {
        "nominee_id": nominee_id,
        "matchup_key": matchup_key,
        "submission_format_version": "v1",
    }
    return errors, canonical


def require_admin(handler):
    if not ADMIN_TOKEN:
        return False
    got = normalize_text(handler.headers.get("X-Admin-Token"))
    return got and got == ADMIN_TOKEN


def json_body(handler, max_bytes=65536):
    content_length = int(handler.headers.get("Content-Length", "0"))
    if content_length <= 0 or content_length > max_bytes:
        raise ValueError("Invalid request size.")
    raw = handler.rfile.read(content_length).decode("utf-8")
    return json.loads(raw)


class MCMHandler(BaseHTTPRequestHandler):
    server_version = "MCM/1.0"

    def _send(self, status, body_bytes, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.send_header("Access-Control-Allow-Origin", self.server.cors_origin)
        self.send_header("Access-Control-Allow-Headers", "Content-Type,X-Admin-Token")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body_bytes)

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=True).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _send_html(self, status, html_text):
        self._send(status, html_text.encode("utf-8"), "text/html; charset=utf-8")

    def do_OPTIONS(self):
        self._send_json(200, {"ok": True})

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query or "")

        if path == "/" or path == "/index.html":
            html_path = WEB_DIR / "mcm.html"
            try:
                self._send_html(200, html_path.read_text(encoding="utf-8"))
            except Exception:
                self._send_html(500, "<h1>mcm.html missing</h1>")
            return

        if path == "/health":
            self._send_json(200, {"ok": True, "time_utc": utc_now_iso()})
            return

        try:
            seed, genre_lookup, cycle = load_seed()
        except Exception as e:
            self._send_json(500, {"ok": False, "error": f"Seed load failed: {e}"})
            return

        if path == "/api/config":
            self._send_json(
                200,
                {
                    "ok": True,
                    "schema_version": seed.get("schema_version"),
                    "season": seed.get("season", {}),
                    "genres": list(genre_lookup.values()),
                    "genres_cycle": cycle,
                },
            )
            return

        if path == "/api/week":
            req_week = normalize_text((qs.get("week_no") or [""])[0])
            info = week_info_by_number(seed, cycle, req_week) if req_week else week_info(seed, cycle)
            if info["phase"] == "regular":
                genre = genre_lookup.get(info["genre_id"], {})
            else:
                genre = {"id": "playoffs", "name": "Playoffs", "description": "End-of-year bracket."}
            info["genre"] = genre
            self._send_json(200, {"ok": True, "week": info})
            return

        if path == "/api/babe-of-the-day":
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                init_db(conn)
                sync_seed_nominees(conn, seed)
                rows = conn.execute(
                    "SELECT id, display_name, genre_id, primary_url, image_url FROM mcm_nominees WHERE active=1 ORDER BY id"
                ).fetchall()
                if not rows:
                    self._send_json(200, {"ok": True, "nominee": None})
                    return
                today = datetime.now(timezone.utc).date()
                idx = (today.toordinal() + 1337) % len(rows)
                nominee = dict(rows[idx])
                nominee["genre"] = genre_lookup.get(nominee["genre_id"], {"id": nominee["genre_id"]})
                nominee["date_utc"] = today.isoformat()
                self._send_json(200, {"ok": True, "nominee": nominee})
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        if path == "/api/ballot":
            req_week = normalize_text((qs.get("week_no") or [""])[0])
            info = week_info_by_number(seed, cycle, req_week) if req_week else week_info(seed, cycle)
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                init_db(conn)
                sync_seed_nominees(conn, seed)
                if info["phase"] == "regular":
                    genre_id = info["genre_id"]
                    ballot_size = int(seed.get("season", {}).get("ballot_size", 8))
                    nominees = conn.execute(
                        """
                        SELECT id, display_name, genre_id, primary_url, image_url, source
                        FROM mcm_nominees
                        WHERE active=1 AND genre_id=?
                        ORDER BY source DESC, display_name ASC
                        LIMIT ?
                        """,
                        (genre_id, ballot_size),
                    ).fetchall()
                    nominee_ids = [r["id"] for r in nominees]
                    counts = {}
                    if nominee_ids:
                        q_marks = ",".join(["?"] * len(nominee_ids))
                        rows = conn.execute(
                            f"""
                            SELECT nominee_id, COUNT(*) AS c
                            FROM mcm_votes
                            WHERE season_year=? AND week_no=? AND phase='regular' AND matchup_key='regular'
                              AND nominee_id IN ({q_marks})
                            GROUP BY nominee_id
                            """,
                            (info["season_year"], info["week_no"], *nominee_ids),
                        ).fetchall()
                        counts = {r[0]: int(r[1]) for r in rows}
                    out = []
                    for r in nominees:
                        item = dict(r)
                        item["votes"] = counts.get(item["id"], 0)
                        item["genre"] = genre_lookup.get(item["genre_id"], {"id": item["genre_id"]})
                        out.append(item)
                    self._send_json(200, {"ok": True, "week": info, "ballot": out})
                    return

                # Playoffs
                round_meta = playoff_round_for_week(
                    info["week_no"], info["regular_weeks"], info["playoff_weeks"]
                )
                if not round_meta:
                    self._send_json(400, {"ok": False, "error": "Playoff schedule not configured."})
                    return

                seed_map = compute_seeds(conn, info["season_year"], info["regular_weeks"], want=16)
                # Compute prior round winners so later rounds can resolve matchups.
                r16_pairs = matchup_pairs_for_round("R16", seed_map, {})
                r16_week = info["regular_weeks"] + 1
                r16_winners = {
                    key: winner_for_matchup(conn, info["season_year"], r16_week, key, a, b, seed_map)
                    for (key, a, b) in r16_pairs
                }
                qf_pairs = matchup_pairs_for_round("QF", seed_map, r16_winners)
                qf_week = info["regular_weeks"] + 2
                qf_winners = {
                    key: winner_for_matchup(conn, info["season_year"], qf_week, key, a, b, seed_map)
                    for (key, a, b) in qf_pairs
                }
                sf_pairs = matchup_pairs_for_round("SF", seed_map, qf_winners)
                sf_week = info["regular_weeks"] + 3
                sf_winners = {
                    key: winner_for_matchup(conn, info["season_year"], sf_week, key, a, b, seed_map)
                    for (key, a, b) in sf_pairs
                }

                prev_winners = {}
                if round_meta["id"] == "R16":
                    pairs = r16_pairs
                elif round_meta["id"] == "QF":
                    pairs = qf_pairs
                    prev_winners = r16_winners
                elif round_meta["id"] == "SF":
                    pairs = sf_pairs
                    prev_winners = qf_winners
                else:
                    pairs = matchup_pairs_for_round("F", seed_map, sf_winners)
                    prev_winners = sf_winners

                matchups = []
                for matchup_key, a_id, b_id in pairs:
                    ids = [i for i in [a_id, b_id] if i]
                    if not ids:
                        continue
                    q_marks = ",".join(["?"] * len(ids))
                    nominee_rows = conn.execute(
                        f"""
                        SELECT id, display_name, genre_id, primary_url, image_url, source
                        FROM mcm_nominees
                        WHERE id IN ({q_marks})
                        """,
                        ids,
                    ).fetchall()
                    by_id = {r["id"]: dict(r) for r in nominee_rows}
                    candidates = []
                    for nid in [a_id, b_id]:
                        if not nid or nid not in by_id:
                            continue
                        item = by_id[nid]
                        item["seed"] = seed_map.get(nid)
                        item["matchup_key"] = matchup_key
                        item["genre"] = genre_lookup.get(item["genre_id"], {"id": item["genre_id"]})
                        candidates.append(item)

                    vote_rows = conn.execute(
                        """
                        SELECT nominee_id, COUNT(*) AS c
                        FROM mcm_votes
                        WHERE season_year=? AND week_no=? AND phase='playoffs' AND matchup_key=?
                        GROUP BY nominee_id
                        """,
                        (info["season_year"], info["week_no"], matchup_key),
                    ).fetchall()
                    counts = {r[0]: int(r[1]) for r in vote_rows}
                    for c in candidates:
                        c["votes"] = counts.get(c["id"], 0)

                    label = matchup_key
                    matchups.append(
                        {
                            "matchup_key": matchup_key,
                            "label": label,
                            "candidates": candidates,
                        }
                    )

                self._send_json(
                    200,
                    {
                        "ok": True,
                        "week": info,
                        "round": round_meta,
                        "seeds": seed_map,
                        "prev_winners": prev_winners,
                        "matchups": matchups,
                    },
                )
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        if path == "/api/results":
            req_week = normalize_text((qs.get("week_no") or [""])[0])
            info = week_info_by_number(seed, cycle, req_week) if req_week else week_info(seed, cycle)
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                init_db(conn)
                sync_seed_nominees(conn, seed)
                if info["phase"] == "regular":
                    rows = conn.execute(
                        """
                        SELECT v.nominee_id, n.display_name, n.genre_id, n.primary_url, n.image_url, COUNT(*) AS votes
                        FROM mcm_votes v
                        JOIN mcm_nominees n ON n.id = v.nominee_id
                        WHERE v.season_year=? AND v.week_no=? AND v.phase='regular' AND v.matchup_key='regular'
                        GROUP BY v.nominee_id
                        ORDER BY votes DESC, n.display_name ASC
                        """,
                        (info["season_year"], info["week_no"]),
                    ).fetchall()
                    results = []
                    for r in rows:
                        item = dict(r)
                        item["genre"] = genre_lookup.get(item["genre_id"], {"id": item["genre_id"]})
                        results.append(item)
                    self._send_json(200, {"ok": True, "week": info, "results": results})
                    return

                # Playoffs: results per matchup for the current round.
                round_meta = playoff_round_for_week(
                    info["week_no"], info["regular_weeks"], info["playoff_weeks"]
                )
                if not round_meta:
                    self._send_json(400, {"ok": False, "error": "Playoff schedule not configured."})
                    return

                seed_map = compute_seeds(conn, info["season_year"], info["regular_weeks"], want=16)
                r16_pairs = matchup_pairs_for_round("R16", seed_map, {})
                r16_week = info["regular_weeks"] + 1
                r16_winners = {
                    key: winner_for_matchup(conn, info["season_year"], r16_week, key, a, b, seed_map)
                    for (key, a, b) in r16_pairs
                }
                qf_pairs = matchup_pairs_for_round("QF", seed_map, r16_winners)
                qf_week = info["regular_weeks"] + 2
                qf_winners = {
                    key: winner_for_matchup(conn, info["season_year"], qf_week, key, a, b, seed_map)
                    for (key, a, b) in qf_pairs
                }
                sf_pairs = matchup_pairs_for_round("SF", seed_map, qf_winners)
                sf_week = info["regular_weeks"] + 3
                sf_winners = {
                    key: winner_for_matchup(conn, info["season_year"], sf_week, key, a, b, seed_map)
                    for (key, a, b) in sf_pairs
                }

                if round_meta["id"] == "R16":
                    pairs = r16_pairs
                elif round_meta["id"] == "QF":
                    pairs = qf_pairs
                elif round_meta["id"] == "SF":
                    pairs = sf_pairs
                else:
                    pairs = matchup_pairs_for_round("F", seed_map, sf_winners)

                matchups = []
                for matchup_key, a_id, b_id in pairs:
                    ids = [i for i in [a_id, b_id] if i]
                    if not ids:
                        continue
                    q_marks = ",".join(["?"] * len(ids))
                    nominee_rows = conn.execute(
                        f"""
                        SELECT id, display_name, genre_id, primary_url, image_url
                        FROM mcm_nominees
                        WHERE id IN ({q_marks})
                        """,
                        ids,
                    ).fetchall()
                    by_id = {r["id"]: dict(r) for r in nominee_rows}

                    vote_rows = conn.execute(
                        """
                        SELECT nominee_id, COUNT(*) AS c
                        FROM mcm_votes
                        WHERE season_year=? AND week_no=? AND phase='playoffs' AND matchup_key=?
                        GROUP BY nominee_id
                        """,
                        (info["season_year"], info["week_no"], matchup_key),
                    ).fetchall()
                    counts = {r[0]: int(r[1]) for r in vote_rows}

                    candidates = []
                    for nid in [a_id, b_id]:
                        if not nid or nid not in by_id:
                            continue
                        item = by_id[nid]
                        item["seed"] = seed_map.get(nid)
                        item["matchup_key"] = matchup_key
                        item["votes"] = counts.get(nid, 0)
                        item["genre"] = genre_lookup.get(item["genre_id"], {"id": item["genre_id"]})
                        candidates.append(item)

                    winner_id = winner_for_matchup(
                        conn,
                        info["season_year"],
                        info["week_no"],
                        matchup_key,
                        a_id,
                        b_id,
                        seed_map,
                    )
                    matchups.append(
                        {
                            "matchup_key": matchup_key,
                            "candidates": candidates,
                            "winner_nominee_id": winner_id,
                        }
                    )

                self._send_json(
                    200,
                    {"ok": True, "week": info, "round": round_meta, "matchups": matchups},
                )
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        if path == "/api/admin/nominations":
            if not require_admin(self):
                self._send_json(403, {"ok": False, "error": "Admin token required."})
                return
            status = normalize_text((qs.get("status") or ["pending"])[0]) or "pending"
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                init_db(conn)
                sync_seed_nominees(conn, seed)
                rows = conn.execute(
                    """
                    SELECT id, created_at_utc, display_name, genre_id, primary_url, image_url, notes, status
                    FROM mcm_nominations
                    WHERE status=?
                    ORDER BY id DESC
                    LIMIT 250
                    """,
                    (status,),
                ).fetchall()
                out = []
                for r in rows:
                    item = dict(r)
                    item["genre"] = genre_lookup.get(item["genre_id"], {"id": item["genre_id"]})
                    out.append(item)
                self._send_json(200, {"ok": True, "nominations": out})
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        self._send_json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            seed, genre_lookup, cycle = load_seed()
        except Exception as e:
            self._send_json(500, {"ok": False, "error": f"Seed load failed: {e}"})
            return

        remote_ip = self.client_address[0]
        ua = normalize_text(self.headers.get("User-Agent"))

        if path == "/api/nominations":
            if not throttle_ok(remote_ip, IP_BUCKETS_NOM, MAX_NOMINATIONS_PER_WINDOW):
                self._send_json(429, {"ok": False, "error": "Rate limit exceeded. Try again in a few minutes."})
                return
            try:
                payload = json_body(self)
            except Exception:
                self._send_json(400, {"ok": False, "error": "Invalid JSON payload."})
                return

            errors, canonical = validate_nomination(payload, set(genre_lookup.keys()))
            if errors:
                self._send_json(400, {"ok": False, "errors": errors})
                return

            digest = dedupe_hash(canonical)
            created_at_utc = utc_now_iso()
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                init_db(conn)
                sync_seed_nominees(conn, seed)
                conn.execute(
                    """
                    INSERT INTO mcm_nominations (
                      created_at_utc, source_ip, user_agent,
                      display_name, genre_id, primary_url, image_url, notes,
                      attestation_adult, attestation_respectful,
                      status, payload_json, dedupe_hash
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                    """,
                    (
                        created_at_utc,
                        remote_ip,
                        ua,
                        canonical["display_name"],
                        canonical["genre_id"],
                        canonical["primary_url"],
                        canonical["image_url"],
                        canonical["notes"],
                        1 if canonical["attestation_adult"] else 0,
                        1 if canonical["attestation_respectful"] else 0,
                        json.dumps(canonical, sort_keys=True, ensure_ascii=True),
                        digest,
                    ),
                )
                conn.commit()
                self._send_json(201, {"ok": True, "message": "Nomination submitted for review."})
            except sqlite3.IntegrityError:
                self._send_json(409, {"ok": False, "error": "Duplicate nomination detected."})
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        if path == "/api/vote":
            if not throttle_ok(remote_ip, IP_BUCKETS_VOTE, MAX_VOTES_PER_WINDOW):
                self._send_json(429, {"ok": False, "error": "Rate limit exceeded. Try again in a few minutes."})
                return
            try:
                payload = json_body(self)
            except Exception:
                self._send_json(400, {"ok": False, "error": "Invalid JSON payload."})
                return
            errors, canonical = validate_vote(payload)
            if errors:
                self._send_json(400, {"ok": False, "errors": errors})
                return

            info = week_info(seed, cycle)
            nominee_id = canonical["nominee_id"]
            matchup_key = canonical.get("matchup_key") or "regular"
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                init_db(conn)
                sync_seed_nominees(conn, seed)
                row = conn.execute(
                    "SELECT id, genre_id, display_name FROM mcm_nominees WHERE id=? AND active=1",
                    (nominee_id,),
                ).fetchone()
                if not row:
                    self._send_json(400, {"ok": False, "error": "Unknown nominee_id."})
                    return

                phase = info["phase"]
                if phase == "regular":
                    if matchup_key != "regular":
                        self._send_json(400, {"ok": False, "error": "matchup_key is not used for regular weeks."})
                        return
                    if row["genre_id"] != info["genre_id"]:
                        self._send_json(400, {"ok": False, "error": "Nominee not on this week's ballot."})
                        return
                else:
                    round_meta = playoff_round_for_week(
                        info["week_no"], info["regular_weeks"], info["playoff_weeks"]
                    )
                    if not round_meta:
                        self._send_json(400, {"ok": False, "error": "Playoff schedule not configured."})
                        return
                    if matchup_key == "regular":
                        self._send_json(400, {"ok": False, "error": "matchup_key is required for playoff votes."})
                        return

                    seed_map = compute_seeds(conn, info["season_year"], info["regular_weeks"], want=16)
                    r16_pairs = matchup_pairs_for_round("R16", seed_map, {})
                    r16_week = info["regular_weeks"] + 1
                    r16_winners = {
                        key: winner_for_matchup(conn, info["season_year"], r16_week, key, a, b, seed_map)
                        for (key, a, b) in r16_pairs
                    }
                    qf_pairs = matchup_pairs_for_round("QF", seed_map, r16_winners)
                    qf_week = info["regular_weeks"] + 2
                    qf_winners = {
                        key: winner_for_matchup(conn, info["season_year"], qf_week, key, a, b, seed_map)
                        for (key, a, b) in qf_pairs
                    }
                    sf_pairs = matchup_pairs_for_round("SF", seed_map, qf_winners)
                    sf_week = info["regular_weeks"] + 3
                    sf_winners = {
                        key: winner_for_matchup(conn, info["season_year"], sf_week, key, a, b, seed_map)
                        for (key, a, b) in sf_pairs
                    }

                    if round_meta["id"] == "R16":
                        pairs = r16_pairs
                    elif round_meta["id"] == "QF":
                        pairs = qf_pairs
                    elif round_meta["id"] == "SF":
                        pairs = sf_pairs
                    else:
                        pairs = matchup_pairs_for_round("F", seed_map, sf_winners)

                    matchup = next((p for p in pairs if p[0] == matchup_key), None)
                    if not matchup:
                        self._send_json(400, {"ok": False, "error": "Unknown matchup_key for this round."})
                        return
                    _, a_id, b_id = matchup
                    if nominee_id not in {a_id, b_id}:
                        self._send_json(400, {"ok": False, "error": "Nominee not in this matchup."})
                        return

                created_at_utc = utc_now_iso()
                payload_row = {
                    "nominee_id": nominee_id,
                    "season_year": info["season_year"],
                    "week_no": info["week_no"],
                    "genre_id": info["genre_id"],
                    "phase": phase,
                    "matchup_key": matchup_key,
                    "submission_format_version": canonical["submission_format_version"],
                }
                conn.execute(
                    """
                    INSERT INTO mcm_votes (
	                      created_at_utc, source_ip, user_agent,
	                      season_year, week_no, phase, genre_id, matchup_key, nominee_id,
	                      payload_json
	                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	                    """,
                    (
                        created_at_utc,
                        remote_ip,
                        ua,
                        info["season_year"],
                        info["week_no"],
                        phase,
                        info["genre_id"],
                        matchup_key,
                        nominee_id,
                        json.dumps(payload_row, sort_keys=True, ensure_ascii=True),
                    ),
                )
                conn.commit()
                self._send_json(
                    201,
                    {
                        "ok": True,
                        "message": "Vote recorded.",
                        "week_no": info["week_no"],
                        "season_year": info["season_year"],
                        "phase": phase,
                        "matchup_key": matchup_key,
                        "nominee_id": nominee_id,
                        "nominee_name": row["display_name"],
                    },
                )
            except sqlite3.IntegrityError:
                if phase == "regular":
                    self._send_json(409, {"ok": False, "error": "You already voted this week (per IP)."})
                else:
                    self._send_json(409, {"ok": False, "error": "You already voted in this matchup (per IP)."})
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        if path.startswith("/api/admin/nominations/"):
            if not require_admin(self):
                self._send_json(403, {"ok": False, "error": "Admin token required."})
                return
            m = re.fullmatch(r"/api/admin/nominations/(\d+)/(approve|reject)", path)
            if not m:
                self._send_json(404, {"ok": False, "error": "Not found"})
                return
            nom_id = int(m.group(1))
            action = m.group(2)
            try:
                DB_PATH.parent.mkdir(parents=True, exist_ok=True)
                conn = sqlite3.connect(DB_PATH)
                conn.row_factory = sqlite3.Row
                init_db(conn)
                sync_seed_nominees(conn, seed)
                row = conn.execute(
                    """
                    SELECT id, display_name, genre_id, primary_url, image_url, notes, status
                    FROM mcm_nominations
                    WHERE id=?
                    """,
                    (nom_id,),
                ).fetchone()
                if not row:
                    self._send_json(404, {"ok": False, "error": "Nomination not found."})
                    return
                if row["status"] != "pending":
                    self._send_json(409, {"ok": False, "error": f"Nomination is {row['status']}."})
                    return

                decided_at = utc_now_iso()
                if action == "reject":
                    conn.execute(
                        "UPDATE mcm_nominations SET status='rejected', decided_at_utc=?, decision_reason=? WHERE id=?",
                        (decided_at, "rejected_by_admin", nom_id),
                    )
                    conn.commit()
                    self._send_json(200, {"ok": True, "message": "Nomination rejected."})
                    return

                # approve: add as nominee with deterministic id
                new_id = "user-" + hashlib.sha1(f"{row['display_name']}|{row['primary_url']}".encode("utf-8")).hexdigest()[:18]
                conn.execute(
                    """
                    INSERT OR IGNORE INTO mcm_nominees (
                      id, display_name, genre_id, primary_url, image_url, source, active, created_at_utc
                    ) VALUES (?, ?, ?, ?, ?, 'approved', 1, ?)
                    """,
                    (
                        new_id,
                        normalize_text(row["display_name"]),
                        normalize_text(row["genre_id"]),
                        normalize_text(row["primary_url"]),
                        normalize_text(row["image_url"]),
                        decided_at,
                    ),
                )
                conn.execute(
                    "UPDATE mcm_nominations SET status='approved', decided_at_utc=?, decision_reason=? WHERE id=?",
                    (decided_at, "approved_by_admin", nom_id),
                )
                conn.commit()
                self._send_json(200, {"ok": True, "message": "Nomination approved.", "nominee_id": new_id})
            finally:
                try:
                    conn.close()
                except Exception:
                    pass
            return

        self._send_json(404, {"ok": False, "error": "Not found"})


def run_server(host, port, cors_origin):
    httpd = ThreadingHTTPServer((host, port), MCMHandler)
    httpd.cors_origin = cors_origin
    print(f"mcm_api listening on http://{host}:{port}")
    httpd.serve_forever()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Man Crush Monday API")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--cors-origin", default="*")
    args = parser.parse_args()

    run_server(args.host, args.port, args.cors_origin)
