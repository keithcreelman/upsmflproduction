#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import difflib
import json
import os
import re
import sqlite3
import urllib.request
from pathlib import Path

from build_early_projection import (
    DEFAULT_SLEEPER_SF_ADP_PATH,
    coerce_float,
    coerce_int,
    normalize_lookup_key,
    positions_compatible,
    to_first_last,
)


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
DB_DEFAULT = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))
LOG_DIR = Path(os.getenv("MFL_ETL_ARTIFACT_DIR", str(ETL_ROOT / "artifacts")))
DEFAULT_FANTASYPROS_URL = "https://www.fantasypros.com/nfl/rankings/consensus-cheatsheets.php"
IDP_POSITIONS = {
    "DL",
    "DE",
    "DT",
    "LB",
    "OLB",
    "ILB",
    "MLB",
    "DB",
    "CB",
    "S",
    "SS",
    "FS",
    "NT",
    "EDGE",
    "IDP",
}
NAME_SUFFIX_TOKENS = {"jr", "sr", "ii", "iii", "iv", "v"}
NICKNAME_TOKEN_ALIASES = {
    "cam": ["cameron"],
    "cameron": ["cam"],
    "chig": ["chigoziem"],
    "chigoziem": ["chig"],
    "hollywood": ["marquise"],
    "marquise": ["hollywood"],
    "tank": ["nathaniel"],
    "nathaniel": ["tank"],
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build current public market sentiment snapshots for player valuation."
    )
    parser.add_argument("--db-path", default=DB_DEFAULT)
    parser.add_argument("--valuation-season", type=int, default=2026)
    parser.add_argument("--snapshot-ts-utc", default="")
    parser.add_argument("--sleeper-sf-adp-path", default=DEFAULT_SLEEPER_SF_ADP_PATH)
    parser.add_argument("--use-fantasypros", type=int, default=1)
    parser.add_argument("--fantasypros-url", default=DEFAULT_FANTASYPROS_URL)
    parser.add_argument("--fantasypros-timeout", type=int, default=30)
    return parser.parse_args()


def now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def normalize_pos_group(position):
    p = str(position or "").strip().upper()
    if not p:
        return "UNK"
    if p in IDP_POSITIONS:
        return p if p in {"DL", "LB", "DB"} else "IDP"
    if p in {"PK", "K"}:
        return "PK"
    if p in {"P", "PN"}:
        return "PN"
    return p


def safe_upper(v):
    return str(v or "").strip().upper()


def clamp_confidence(value):
    score = coerce_float(value)
    if score is None:
        return 0.0
    return max(0.0, min(1.0, float(score)))


def lookup_keys_for_name(name):
    raw = str(name or "").strip().lower().replace(",", " ")
    if not raw:
        return []
    raw = re.sub(r"[^a-z0-9\s]", " ", raw)
    tokens = [tok for tok in raw.split() if tok and tok not in NAME_SUFFIX_TOKENS]
    if not tokens:
        return []

    keys = {"".join(tokens)}
    for idx, token in enumerate(tokens):
        for alias in NICKNAME_TOKEN_ALIASES.get(token, []):
            alt = list(tokens)
            alt[idx] = alias
            keys.add("".join(alt))

    ordered = []
    base = normalize_lookup_key(name)
    if base:
        ordered.append(base)
    for key in sorted(keys):
        if key and key not in ordered:
            ordered.append(key)
    return ordered


def market_positions_compatible(source_pos, internal_pos):
    if positions_compatible(source_pos, internal_pos):
        return True
    a = safe_upper(source_pos)
    b = safe_upper(internal_pos)
    if {a, b} <= {"DEF", "DST", "D/ST", "D"}:
        return True
    if {a, b} <= {"P", "PN"}:
        return True
    return False


def current_snapshot_parts(snapshot_ts_utc):
    if snapshot_ts_utc:
        ts = str(snapshot_ts_utc).strip()
    else:
        ts = now_utc()
    return ts, ts[:10]


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        writer.writeheader()
        for row in rows:
            writer.writerow({h: row.get(h) for h in headers})


def append_jsonl(path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=True) + "\n")


def fetch_text(url, timeout=30):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "codex-player-market-sentiment/1.0",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "ignore")


def extract_json_object_after_marker(text, marker):
    start = text.find(marker)
    if start < 0:
        return None
    start = text.find("{", start)
    if start < 0:
        return None

    depth = 0
    in_string = False
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
            continue
        if ch == "{":
            depth += 1
            continue
        if ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : idx + 1]
    return None


def parse_fantasypros_last_updated(raw, valuation_season):
    txt = str(raw or "").strip()
    m = re.match(r"^\s*([0-9]{1,2})\s*/\s*([0-9]{1,2})\s*$", txt)
    if not m:
        return ""
    month = int(m.group(1))
    day = int(m.group(2))
    try:
        return dt.date(int(valuation_season), month, day).isoformat()
    except Exception:
        return ""


def load_player_master(conn, valuation_season):
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT MAX(season) FROM players")
    latest_players_season = coerce_int(cur.fetchone()[0]) or max(valuation_season - 1, 0)

    cur.execute(
        """
        SELECT player_id, name, position, nfl_team
        FROM players
        WHERE season = ?
        """,
        (latest_players_season,),
    )
    players_latest = {str(r["player_id"]): dict(r) for r in cur.fetchall()}

    cur.execute("SELECT MAX(season), MAX(week) FROM rosters_current")
    roster_season, roster_week = cur.fetchone()
    roster_season = coerce_int(roster_season)
    roster_week = coerce_int(roster_week)
    roster_latest = {}
    if roster_season is not None and roster_week is not None:
        cur.execute(
            """
            SELECT player_id, player_name, position, nfl_team
            FROM rosters_current
            WHERE season = ? AND week = ?
            """,
            (roster_season, roster_week),
        )
        for row in cur.fetchall():
            pid = str(row["player_id"])
            if pid not in roster_latest:
                roster_latest[pid] = dict(row)

    cur.execute(
        """
        SELECT player_id, player_name, position, nfl_team, nfl_draft_year
        FROM dim_player
        """
    )
    master = {}
    for row in cur.fetchall():
        pid = str(row["player_id"])
        players_row = players_latest.get(pid, {})
        roster_row = roster_latest.get(pid, {})
        draft_year = coerce_int(row["nfl_draft_year"])
        exp_years = None
        if draft_year is not None:
            exp_years = max(0, int(valuation_season) - int(draft_year))
        player_name = (
            roster_row.get("player_name")
            or players_row.get("name")
            or row["player_name"]
            or ""
        )
        position = (
            roster_row.get("position")
            or players_row.get("position")
            or row["position"]
            or ""
        )
        team = (
            roster_row.get("nfl_team")
            or players_row.get("nfl_team")
            or row["nfl_team"]
            or ""
        )
        master[pid] = {
            "player_id": pid,
            "player_name": str(player_name or "").strip(),
            "position": safe_upper(position),
            "pos_group": normalize_pos_group(position),
            "team": safe_upper(team),
            "nfl_draft_year": draft_year,
            "experience_years": exp_years,
            "is_rookie": 1 if exp_years == 0 else 0,
        }

    for pid, row in players_latest.items():
        if pid in master:
            continue
        master[pid] = {
            "player_id": pid,
            "player_name": str(row.get("name") or "").strip(),
            "position": safe_upper(row.get("position")),
            "pos_group": normalize_pos_group(row.get("position")),
            "team": safe_upper(row.get("nfl_team")),
            "nfl_draft_year": None,
            "experience_years": None,
            "is_rookie": 0,
        }

    return master


def build_player_name_index(master_rows):
    index = {}
    for row in master_rows.values():
        for candidate in (row.get("player_name"), to_first_last(row.get("player_name"))):
            for key in lookup_keys_for_name(candidate):
                if not key:
                    continue
                index.setdefault(key, []).append(row)
    return index


def score_candidate(candidate, position, team):
    score = 1.0
    if position and market_positions_compatible(position, candidate.get("position")):
        score += 0.04
    elif position:
        score -= 0.08
    if team and safe_upper(team) == safe_upper(candidate.get("team")):
        score += 0.03
    return score


def resolve_player(name, position, team, name_index):
    input_keys = lookup_keys_for_name(name)
    if not input_keys:
        return None, "empty", 0.0

    candidates = []
    for key in input_keys:
        candidates.extend(name_index.get(key, []))
    if candidates:
        ranked = sorted(
            candidates,
            key=lambda row: (
                score_candidate(row, position, team),
                1 if safe_upper(team) == safe_upper(row.get("team")) else 0,
                1 if market_positions_compatible(position, row.get("position")) else 0,
            ),
            reverse=True,
        )
        best = ranked[0]
        return best, "exact", clamp_confidence(score_candidate(best, position, team))

    keys = list(name_index.keys())
    matches = []
    for input_key in input_keys:
        matches = difflib.get_close_matches(input_key, keys, n=3, cutoff=0.75)
        if matches:
            break
    if not matches:
        return None, "unmatched", 0.0

    best = None
    best_score = 0.0
    best_method = "fuzzy"
    base_key = input_keys[0]
    for candidate_key in matches:
        for row in name_index.get(candidate_key, []):
            similarity = difflib.SequenceMatcher(None, base_key, candidate_key).ratio()
            candidate_score = similarity + score_candidate(row, position, team) - 1.0
            if candidate_score > best_score:
                best = row
                best_score = candidate_score
    return best, best_method, round(clamp_confidence(best_score), 4)


def parse_sleeper_slot_to_overall(slot_text, fcount=12):
    m = re.match(r"^\s*([0-9]+)\.([0-9]+)\s*$", str(slot_text or ""))
    if not m:
        return None
    rnd = coerce_int(m.group(1))
    pick = coerce_int(m.group(2))
    if rnd is None or pick is None or rnd <= 0 or pick <= 0:
        return None
    return float((int(rnd) - 1) * int(fcount) + int(pick))


def parse_sleeper_trend_text(path):
    p = Path(path)
    if not p.exists():
        return [], {"source_url": str(p), "rows": 0, "matched_rows": 0, "unmatched_rows": 0}

    lines = [line.strip() for line in p.read_text(encoding="utf-8", errors="ignore").splitlines()]
    pos_re = r"(QB|RB|WR|TE|PK|K|DEF|DL|DE|DT|LB|DB|CB|S)"
    team_re = r"([A-Z]{2,3}|RK|FA|UNS)"
    player_re = re.compile(rf"^([A-Za-z0-9][A-Za-z0-9\.\'\-\s]+?)\s+{pos_re}\s+{team_re}$")
    team_rank_re = re.compile(rf"^{team_re}\s+([0-9]+)$")

    rows = []
    i = 0
    while i < len(lines):
        line = lines[i]
        team_rank = team_rank_re.match(line)
        if not team_rank:
            i += 1
            continue

        team = safe_upper(team_rank.group(1))
        source_rank = coerce_int(team_rank.group(2))
        if i + 2 >= len(lines):
            break

        player_line = lines[i + 1]
        slot_line = lines[i + 2]
        player_match = player_re.match(player_line)
        overall_pick = parse_sleeper_slot_to_overall(slot_line, 12)
        if not player_match or overall_pick is None:
            i += 1
            continue

        trend_delta = None
        if i + 4 < len(lines) and lines[i + 3].lower().startswith("show trend"):
            trend_delta = coerce_int(lines[i + 4].replace("+", ""))
            i += 5
        else:
            i += 3

        rows.append(
            {
                "player_name": player_match.group(1).strip(),
                "position": safe_upper(player_match.group(2)),
                "team": team,
                "source_rank": source_rank,
                "adp_overall": overall_pick,
                "sleeper_slot": slot_line,
                "source_trend_delta": trend_delta,
            }
        )

    rows.sort(key=lambda r: (coerce_float(r["adp_overall"]) or 9999.0, r["player_name"]))
    return rows, {
        "source_url": str(p),
        "rows": len(rows),
    }


def load_sleeper_adp_rows(conn, valuation_season):
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            e.player_id,
            COALESCE(p.name, d.player_name, '') AS player_name,
            UPPER(COALESCE(p.position, d.position, '')) AS position,
            UPPER(COALESCE(p.nfl_team, d.nfl_team, '')) AS team,
            e.rank,
            e.average_pick,
            e.requested_period,
            e.used_period,
            e.source_url,
            e.fetched_at_utc
        FROM early_projection_adp e
        LEFT JOIN players p
          ON p.season = e.projection_season
         AND p.player_id = e.player_id
        LEFT JOIN dim_player d
          ON d.player_id = e.player_id
        WHERE e.projection_season = ?
          AND UPPER(COALESCE(e.used_period, '')) = 'SLEEPER_SF'
        ORDER BY e.rank, e.player_id
        """,
        (valuation_season,),
    )
    rows = []
    for row in cur.fetchall():
        rows.append(
            {
                "player_id": str(row["player_id"]),
                "player_name": str(row["player_name"] or "").strip(),
                "position": safe_upper(row["position"]),
                "team": safe_upper(row["team"]),
                "rank": coerce_int(row["rank"]),
                "adp_overall": coerce_float(row["average_pick"]),
                "source_url": str(row["source_url"] or ""),
                "source_last_updated": str(row["fetched_at_utc"] or ""),
                "source_name": "sleeper_sf_adp",
                "source_category": "adp",
                "source_format": "dynasty_ppr_superflex",
                "source_season": valuation_season,
            }
        )
    return rows


def attach_position_and_percentiles(rows, value_field, rank_field, position_rank_field, percentile_field):
    by_position = {}
    valid = [row for row in rows if row.get(value_field) is not None]
    valid.sort(key=lambda r: (coerce_float(r.get(value_field)) or 999999.0, r.get("player_name") or ""))
    total = len(valid)
    for idx, row in enumerate(valid, start=1):
        row[rank_field] = idx
        row[percentile_field] = rank_to_percentile(idx, total)
        by_position.setdefault(safe_upper(row.get("position")), []).append(row)
    for pos_rows in by_position.values():
        for pos_idx, row in enumerate(pos_rows, start=1):
            row[position_rank_field] = pos_idx


def rank_to_percentile(rank, total):
    r = coerce_int(rank)
    t = coerce_int(total)
    if r is None or t is None or t <= 0:
        return None
    if t == 1:
        return 1.0
    return round(1.0 - ((float(r) - 1.0) / (float(t) - 1.0)), 6)


def resolve_sleeper_trends(parsed_rows, name_index):
    resolved = {}
    unresolved = []
    for row in parsed_rows:
        matched, method, confidence = resolve_player(
            row.get("player_name"), row.get("position"), row.get("team"), name_index
        )
        if matched and confidence >= 0.88 and market_positions_compatible(row.get("position"), matched.get("position")):
            pid = str(matched["player_id"])
            existing = resolved.get(pid)
            if existing is None or (row.get("source_rank") or 999999) < (existing.get("source_rank") or 999999):
                new_row = dict(row)
                new_row["player_id"] = pid
                new_row["match_method"] = method
                new_row["match_confidence"] = confidence
                resolved[pid] = new_row
            continue
        unresolved.append(
            {
                "source_name": "sleeper_sf_adp",
                "input_name": row.get("player_name"),
                "input_position": row.get("position"),
                "input_team": row.get("team"),
                "status": "unmatched" if matched is None else "rejected_low_confidence",
                "match_method": method,
                "match_confidence": confidence,
            }
        )
    return resolved, unresolved


def load_fantasypros_rank_rows(valuation_season, url, timeout):
    html = fetch_text(url, timeout=timeout)
    payload_text = extract_json_object_after_marker(html, "var ecrData = ")
    if not payload_text:
        raise RuntimeError("FantasyPros consensus payload not found in page HTML.")
    payload = json.loads(payload_text)
    players = payload.get("players") or []
    source_last_updated = parse_fantasypros_last_updated(payload.get("last_updated"), valuation_season)
    rows = []
    for player in players:
        rank_ecr = coerce_int(player.get("rank_ecr"))
        pos_rank_raw = str(player.get("pos_rank") or "")
        pos_rank_match = re.search(r"([0-9]+)$", pos_rank_raw)
        pos_rank = coerce_int(pos_rank_match.group(1)) if pos_rank_match else None
        rows.append(
            {
                "input_name": str(player.get("player_name") or "").strip(),
                "input_position": safe_upper(player.get("player_position_id")),
                "input_team": safe_upper(player.get("player_team_id")),
                "expert_rank_overall": rank_ecr,
                "expert_rank_position": pos_rank,
                "source_tier": coerce_int(player.get("tier")),
                "source_url": url,
                "source_last_updated": source_last_updated,
                "source_name": "fantasypros_consensus",
                "source_category": "expert_rank",
                "source_format": f"expert_consensus_{str(payload.get('scoring') or 'std').lower()}_1qb",
                "source_season": coerce_int(payload.get("year")) or valuation_season,
            }
        )
    total = len([r for r in rows if r.get("expert_rank_overall") is not None])
    for row in rows:
        row["expert_rank_percentile"] = rank_to_percentile(row.get("expert_rank_overall"), total)
    meta = {
        "source_url": url,
        "source_last_updated": source_last_updated,
        "source_season": coerce_int(payload.get("year")) or valuation_season,
        "rows": len(rows),
    }
    return rows, meta


def resolve_fantasypros_rows(parsed_rows, name_index):
    resolved = []
    unresolved = []
    for row in parsed_rows:
        matched, method, confidence = resolve_player(
            row.get("input_name"), row.get("input_position"), row.get("input_team"), name_index
        )
        if matched and confidence >= 0.88 and market_positions_compatible(row.get("input_position"), matched.get("position")):
            resolved.append(
                {
                    "player_id": str(matched["player_id"]),
                    "player_name": matched.get("player_name"),
                    "position": matched.get("position"),
                    "team": matched.get("team"),
                    "expert_rank_overall": row.get("expert_rank_overall"),
                    "expert_rank_position": row.get("expert_rank_position"),
                    "expert_rank_percentile": row.get("expert_rank_percentile"),
                    "source_tier": row.get("source_tier"),
                    "source_url": row.get("source_url"),
                    "source_last_updated": row.get("source_last_updated"),
                    "source_name": row.get("source_name"),
                    "source_category": row.get("source_category"),
                    "source_format": row.get("source_format"),
                    "source_season": row.get("source_season"),
                    "match_method": method,
                    "match_confidence": confidence,
                }
            )
            continue
        unresolved.append(
            {
                "source_name": "fantasypros_consensus",
                "input_name": row.get("input_name"),
                "input_position": row.get("input_position"),
                "input_team": row.get("input_team"),
                "status": "unmatched" if matched is None else "rejected_low_confidence",
                "match_method": method,
                "match_confidence": confidence,
            }
        )
    return resolved, unresolved


def load_previous_adp_by_player(conn, valuation_season, snapshot_ts_utc):
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT player_id, adp_source, adp_overall
            FROM player_market_sentiment
            WHERE valuation_season = ?
              AND snapshot_ts_utc < ?
              AND adp_source IS NOT NULL
              AND adp_overall IS NOT NULL
            ORDER BY snapshot_ts_utc DESC
            """,
            (valuation_season, snapshot_ts_utc),
        )
    except sqlite3.OperationalError:
        return {}

    out = {}
    for player_id, adp_source, adp_overall in cur.fetchall():
        key = (str(player_id), str(adp_source))
        if key not in out:
            out[key] = coerce_float(adp_overall)
    return out


def adp_bucket_for_value(adp_overall):
    adp = coerce_float(adp_overall)
    if adp is None:
        return "unranked"
    if adp <= 12:
        return "round_1"
    if adp <= 24:
        return "round_2"
    if adp <= 48:
        return "rounds_3_4"
    if adp <= 72:
        return "rounds_5_6"
    if adp <= 120:
        return "mid_round"
    if adp <= 180:
        return "late_round"
    if adp <= 240:
        return "deep_round"
    return "watchlist"


def adp_tier_for_percentile(percentile):
    pct = coerce_float(percentile)
    if pct is None:
        return "unranked"
    if pct >= 0.95:
        return "elite"
    if pct >= 0.80:
        return "premium"
    if pct >= 0.60:
        return "starter"
    if pct >= 0.35:
        return "depth"
    return "watchlist"


def trend_bucket(adp_change=None, source_trend_delta=None):
    delta = coerce_float(adp_change)
    if delta is None:
        delta = coerce_float(source_trend_delta)
    if delta is None:
        return "unknown"
    if delta >= 5:
        return "surging"
    if delta >= 1.5:
        return "rising"
    if delta <= -5:
        return "sliding"
    if delta <= -1.5:
        return "falling"
    return "steady"


def public_sentiment_score(adp_percentile, expert_percentile):
    adp_pct = coerce_float(adp_percentile)
    exp_pct = coerce_float(expert_percentile)
    if adp_pct is None and exp_pct is None:
        return None
    if adp_pct is not None and exp_pct is not None:
        return round((0.8 * adp_pct + 0.2 * exp_pct) * 100.0, 3)
    if adp_pct is not None:
        return round(adp_pct * 100.0, 3)
    return round(exp_pct * 90.0, 3)


def derive_market_archetype(position, adp_overall, experience_years):
    pos = safe_upper(position)
    adp = coerce_float(adp_overall)
    exp = coerce_int(experience_years)
    rookie = exp == 0 if exp is not None else False
    young = exp is not None and exp <= 2
    veteran = exp is not None and exp >= 7

    if pos == "QB":
        if rookie:
            return "rookie superflex qb"
        if adp is not None and adp <= 18:
            return "cornerstone superflex qb"
        if young and adp is not None and adp <= 72:
            return "ascending qb starter"
        if veteran and adp is not None and adp <= 120:
            return "veteran qb starter"
        return "depth superflex qb"

    if pos == "RB":
        if rookie and adp is not None and adp <= 72:
            return "upside rookie rb"
        if adp is not None and adp <= 24:
            return "elite bellcow rb"
        if young and adp is not None and adp <= 72:
            return "young rb starter"
        if veteran and adp is not None and adp <= 120:
            return "veteran rb producer"
        return "committee or depth rb"

    if pos == "WR":
        if rookie and adp is not None and adp <= 96:
            return "upside rookie wr"
        if adp is not None and adp <= 24:
            return "elite alpha wr"
        if young and adp is not None and adp <= 72:
            return "breakout wr"
        if veteran and adp is not None and adp <= 120:
            return "veteran volume wr"
        return "depth or upside wr"

    if pos == "TE":
        if rookie and adp is not None and adp <= 120:
            return "upside rookie te"
        if adp is not None and adp <= 36:
            return "premium te"
        if young and adp is not None and adp <= 120:
            return "ascending te"
        return "streamer te"

    if pos in {"DL", "LB", "DB"}:
        return f"{pos.lower()} impact starter" if adp is not None and adp <= 180 else f"{pos.lower()} depth"
    if pos in {"PK", "PN"}:
        return f"{pos.lower()} starter" if adp is not None and adp <= 180 else f"{pos.lower()} depth"
    return "market depth piece"


def ensure_tables(conn):
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS player_market_sentiment_source (
            snapshot_ts_utc TEXT NOT NULL,
            snapshot_date TEXT NOT NULL,
            valuation_season INTEGER NOT NULL,
            source_name TEXT NOT NULL,
            source_category TEXT NOT NULL,
            source_format TEXT,
            source_url TEXT,
            source_last_updated TEXT,
            source_season INTEGER,
            player_id TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            pos_group TEXT,
            team TEXT,
            adp_overall REAL,
            adp_position INTEGER,
            adp_percentile REAL,
            expert_rank_overall INTEGER,
            expert_rank_position INTEGER,
            expert_rank_percentile REAL,
            source_tier INTEGER,
            source_trend_delta REAL,
            source_trend_bucket TEXT,
            match_method TEXT,
            match_confidence REAL,
            PRIMARY KEY (snapshot_ts_utc, valuation_season, source_name, player_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS player_market_sentiment (
            snapshot_ts_utc TEXT NOT NULL,
            snapshot_date TEXT NOT NULL,
            valuation_season INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            pos_group TEXT,
            team TEXT,
            nfl_draft_year INTEGER,
            experience_years INTEGER,
            is_rookie INTEGER DEFAULT 0,
            adp_overall REAL,
            adp_position INTEGER,
            adp_percentile REAL,
            adp_source TEXT,
            adp_format TEXT,
            adp_last_updated TEXT,
            adp_prev REAL,
            adp_change REAL,
            adp_trend_bucket TEXT,
            source_trend_delta REAL,
            expert_rank_overall INTEGER,
            expert_rank_position INTEGER,
            expert_rank_percentile REAL,
            expert_rank_source TEXT,
            expert_rank_format TEXT,
            expert_rank_last_updated TEXT,
            adp_bucket TEXT,
            adp_tier TEXT,
            market_archetype TEXT,
            public_sentiment_score REAL,
            source_count INTEGER,
            PRIMARY KEY (snapshot_ts_utc, valuation_season, player_id)
        )
        """
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_player_market_sentiment_latest ON player_market_sentiment (valuation_season, player_id, snapshot_ts_utc)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_player_market_sentiment_source_latest ON player_market_sentiment_source (valuation_season, source_name, player_id, snapshot_ts_utc)"
    )
    conn.commit()


def persist_source_rows(conn, rows):
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT OR REPLACE INTO player_market_sentiment_source (
            snapshot_ts_utc, snapshot_date, valuation_season,
            source_name, source_category, source_format, source_url, source_last_updated, source_season,
            player_id, player_name, position, pos_group, team,
            adp_overall, adp_position, adp_percentile,
            expert_rank_overall, expert_rank_position, expert_rank_percentile,
            source_tier, source_trend_delta, source_trend_bucket,
            match_method, match_confidence
        ) VALUES (
            :snapshot_ts_utc, :snapshot_date, :valuation_season,
            :source_name, :source_category, :source_format, :source_url, :source_last_updated, :source_season,
            :player_id, :player_name, :position, :pos_group, :team,
            :adp_overall, :adp_position, :adp_percentile,
            :expert_rank_overall, :expert_rank_position, :expert_rank_percentile,
            :source_tier, :source_trend_delta, :source_trend_bucket,
            :match_method, :match_confidence
        )
        """,
        rows,
    )
    conn.commit()


def persist_resolved_rows(conn, rows):
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT OR REPLACE INTO player_market_sentiment (
            snapshot_ts_utc, snapshot_date, valuation_season,
            player_id, player_name, position, pos_group, team,
            nfl_draft_year, experience_years, is_rookie,
            adp_overall, adp_position, adp_percentile, adp_source, adp_format, adp_last_updated,
            adp_prev, adp_change, adp_trend_bucket, source_trend_delta,
            expert_rank_overall, expert_rank_position, expert_rank_percentile,
            expert_rank_source, expert_rank_format, expert_rank_last_updated,
            adp_bucket, adp_tier, market_archetype, public_sentiment_score, source_count
        ) VALUES (
            :snapshot_ts_utc, :snapshot_date, :valuation_season,
            :player_id, :player_name, :position, :pos_group, :team,
            :nfl_draft_year, :experience_years, :is_rookie,
            :adp_overall, :adp_position, :adp_percentile, :adp_source, :adp_format, :adp_last_updated,
            :adp_prev, :adp_change, :adp_trend_bucket, :source_trend_delta,
            :expert_rank_overall, :expert_rank_position, :expert_rank_percentile,
            :expert_rank_source, :expert_rank_format, :expert_rank_last_updated,
            :adp_bucket, :adp_tier, :market_archetype, :public_sentiment_score, :source_count
        )
        """,
        rows,
    )
    conn.commit()


def build_source_rows(snapshot_ts_utc, snapshot_date, valuation_season, master, sleeper_rows, sleeper_trends, fantasypros_rows):
    out = []
    for row in sleeper_rows:
        master_row = master.get(str(row["player_id"]))
        trend_row = sleeper_trends.get(str(row["player_id"]), {})
        out.append(
            {
                "snapshot_ts_utc": snapshot_ts_utc,
                "snapshot_date": snapshot_date,
                "valuation_season": valuation_season,
                "source_name": row["source_name"],
                "source_category": row["source_category"],
                "source_format": row["source_format"],
                "source_url": row["source_url"],
                "source_last_updated": row["source_last_updated"],
                "source_season": row["source_season"],
                "player_id": row["player_id"],
                "player_name": master_row.get("player_name") if master_row else row["player_name"],
                "position": master_row.get("position") if master_row else row["position"],
                "pos_group": master_row.get("pos_group") if master_row else normalize_pos_group(row["position"]),
                "team": master_row.get("team") if master_row else row["team"],
                "adp_overall": row.get("adp_overall"),
                "adp_position": row.get("adp_position"),
                "adp_percentile": row.get("adp_percentile"),
                "expert_rank_overall": None,
                "expert_rank_position": None,
                "expert_rank_percentile": None,
                "source_tier": None,
                "source_trend_delta": trend_row.get("source_trend_delta"),
                "source_trend_bucket": trend_bucket(source_trend_delta=trend_row.get("source_trend_delta")),
                "match_method": trend_row.get("match_method", "existing_internal_player_id"),
                "match_confidence": trend_row.get("match_confidence", 1.0),
            }
        )

    for row in fantasypros_rows:
        master_row = master.get(str(row["player_id"]))
        out.append(
            {
                "snapshot_ts_utc": snapshot_ts_utc,
                "snapshot_date": snapshot_date,
                "valuation_season": valuation_season,
                "source_name": row["source_name"],
                "source_category": row["source_category"],
                "source_format": row["source_format"],
                "source_url": row["source_url"],
                "source_last_updated": row["source_last_updated"],
                "source_season": row["source_season"],
                "player_id": row["player_id"],
                "player_name": master_row.get("player_name") if master_row else row["player_name"],
                "position": master_row.get("position") if master_row else row["position"],
                "pos_group": master_row.get("pos_group") if master_row else normalize_pos_group(row["position"]),
                "team": master_row.get("team") if master_row else row["team"],
                "adp_overall": None,
                "adp_position": None,
                "adp_percentile": None,
                "expert_rank_overall": row.get("expert_rank_overall"),
                "expert_rank_position": row.get("expert_rank_position"),
                "expert_rank_percentile": row.get("expert_rank_percentile"),
                "source_tier": row.get("source_tier"),
                "source_trend_delta": None,
                "source_trend_bucket": "unknown",
                "match_method": row.get("match_method"),
                "match_confidence": row.get("match_confidence"),
            }
        )
    return out


def build_resolved_rows(snapshot_ts_utc, snapshot_date, valuation_season, master, source_rows, previous_adp):
    by_player = {}
    for row in source_rows:
        by_player.setdefault(str(row["player_id"]), []).append(row)

    resolved = []
    for player_id, rows in by_player.items():
        master_row = master.get(player_id, {})
        adp_row = None
        expert_row = None
        for row in rows:
            if row["source_category"] == "adp" and adp_row is None:
                adp_row = row
            if row["source_category"] == "expert_rank" and expert_row is None:
                expert_row = row

        adp_prev = None
        adp_change = None
        if adp_row:
            adp_prev = previous_adp.get((player_id, str(adp_row.get("source_name"))))
            if adp_prev is not None and adp_row.get("adp_overall") is not None:
                adp_change = round(float(adp_prev) - float(adp_row["adp_overall"]), 3)

        sentiment = public_sentiment_score(
            adp_row.get("adp_percentile") if adp_row else None,
            expert_row.get("expert_rank_percentile") if expert_row else None,
        )

        adp_overall = adp_row.get("adp_overall") if adp_row else None
        resolved.append(
            {
                "snapshot_ts_utc": snapshot_ts_utc,
                "snapshot_date": snapshot_date,
                "valuation_season": valuation_season,
                "player_id": player_id,
                "player_name": master_row.get("player_name"),
                "position": master_row.get("position"),
                "pos_group": master_row.get("pos_group"),
                "team": master_row.get("team"),
                "nfl_draft_year": master_row.get("nfl_draft_year"),
                "experience_years": master_row.get("experience_years"),
                "is_rookie": master_row.get("is_rookie"),
                "adp_overall": adp_overall,
                "adp_position": adp_row.get("adp_position") if adp_row else None,
                "adp_percentile": adp_row.get("adp_percentile") if adp_row else None,
                "adp_source": adp_row.get("source_name") if adp_row else None,
                "adp_format": adp_row.get("source_format") if adp_row else None,
                "adp_last_updated": adp_row.get("source_last_updated") if adp_row else None,
                "adp_prev": adp_prev,
                "adp_change": adp_change,
                "adp_trend_bucket": trend_bucket(
                    adp_change=adp_change,
                    source_trend_delta=adp_row.get("source_trend_delta") if adp_row else None,
                ),
                "source_trend_delta": adp_row.get("source_trend_delta") if adp_row else None,
                "expert_rank_overall": expert_row.get("expert_rank_overall") if expert_row else None,
                "expert_rank_position": expert_row.get("expert_rank_position") if expert_row else None,
                "expert_rank_percentile": expert_row.get("expert_rank_percentile") if expert_row else None,
                "expert_rank_source": expert_row.get("source_name") if expert_row else None,
                "expert_rank_format": expert_row.get("source_format") if expert_row else None,
                "expert_rank_last_updated": expert_row.get("source_last_updated") if expert_row else None,
                "adp_bucket": adp_bucket_for_value(adp_overall),
                "adp_tier": adp_tier_for_percentile(adp_row.get("adp_percentile") if adp_row else None),
                "market_archetype": derive_market_archetype(
                    master_row.get("position"),
                    adp_overall if adp_overall is not None else (expert_row.get("expert_rank_overall") if expert_row else None),
                    master_row.get("experience_years"),
                ),
                "public_sentiment_score": sentiment,
                "source_count": len(rows),
            }
        )
    resolved.sort(
        key=lambda r: (
            coerce_float(r.get("adp_overall")) if r.get("adp_overall") is not None else 999999.0,
            coerce_int(r.get("expert_rank_overall")) if r.get("expert_rank_overall") is not None else 999999,
            r.get("player_name") or "",
        )
    )
    return resolved


def main():
    args = parse_args()
    snapshot_ts_utc, snapshot_date = current_snapshot_parts(args.snapshot_ts_utc)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(args.db_path)
    ensure_tables(conn)

    master = load_player_master(conn, args.valuation_season)
    name_index = build_player_name_index(master)

    sleeper_rows = load_sleeper_adp_rows(conn, args.valuation_season)
    attach_position_and_percentiles(
        sleeper_rows,
        value_field="adp_overall",
        rank_field="rank",
        position_rank_field="adp_position",
        percentile_field="adp_percentile",
    )

    sleeper_trend_parsed, sleeper_trend_meta = parse_sleeper_trend_text(args.sleeper_sf_adp_path)
    sleeper_trends_by_pid, unresolved = resolve_sleeper_trends(sleeper_trend_parsed, name_index)

    fantasypros_rows = []
    fantasypros_meta = {
        "source_url": args.fantasypros_url,
        "rows": 0,
        "source_last_updated": "",
        "source_season": None,
    }
    if int(args.use_fantasypros or 0) == 1:
        parsed_fp_rows, fantasypros_meta = load_fantasypros_rank_rows(
            args.valuation_season, args.fantasypros_url, args.fantasypros_timeout
        )
        fantasypros_rows, fantasypros_unresolved = resolve_fantasypros_rows(parsed_fp_rows, name_index)
        unresolved.extend(fantasypros_unresolved)

    source_rows = build_source_rows(
        snapshot_ts_utc,
        snapshot_date,
        args.valuation_season,
        master,
        sleeper_rows,
        sleeper_trends_by_pid,
        fantasypros_rows,
    )
    previous_adp = load_previous_adp_by_player(conn, args.valuation_season, snapshot_ts_utc)
    resolved_rows = build_resolved_rows(
        snapshot_ts_utc, snapshot_date, args.valuation_season, master, source_rows, previous_adp
    )

    persist_source_rows(conn, source_rows)
    persist_resolved_rows(conn, resolved_rows)

    source_headers = [
        "snapshot_ts_utc",
        "snapshot_date",
        "valuation_season",
        "source_name",
        "source_category",
        "source_format",
        "source_url",
        "source_last_updated",
        "source_season",
        "player_id",
        "player_name",
        "position",
        "pos_group",
        "team",
        "adp_overall",
        "adp_position",
        "adp_percentile",
        "expert_rank_overall",
        "expert_rank_position",
        "expert_rank_percentile",
        "source_tier",
        "source_trend_delta",
        "source_trend_bucket",
        "match_method",
        "match_confidence",
    ]
    resolved_headers = [
        "snapshot_ts_utc",
        "snapshot_date",
        "valuation_season",
        "player_id",
        "player_name",
        "position",
        "pos_group",
        "team",
        "nfl_draft_year",
        "experience_years",
        "is_rookie",
        "adp_overall",
        "adp_position",
        "adp_percentile",
        "adp_source",
        "adp_format",
        "adp_last_updated",
        "adp_prev",
        "adp_change",
        "adp_trend_bucket",
        "source_trend_delta",
        "expert_rank_overall",
        "expert_rank_position",
        "expert_rank_percentile",
        "expert_rank_source",
        "expert_rank_format",
        "expert_rank_last_updated",
        "adp_bucket",
        "adp_tier",
        "market_archetype",
        "public_sentiment_score",
        "source_count",
    ]
    unresolved_headers = [
        "source_name",
        "input_name",
        "input_position",
        "input_team",
        "status",
        "match_method",
        "match_confidence",
    ]
    write_csv(LOG_DIR / "player_market_sentiment_source.csv", source_rows, source_headers)
    write_csv(LOG_DIR / "player_market_sentiment.csv", resolved_rows, resolved_headers)
    write_csv(LOG_DIR / "player_market_sentiment_unmatched.csv", unresolved, unresolved_headers)

    run_log = {
        "ran_at_utc": snapshot_ts_utc,
        "snapshot_date": snapshot_date,
        "valuation_season": args.valuation_season,
        "db_path": args.db_path,
        "selected_sources": [s for s in [
            "early_projection_adp:SLEEPER_SF",
            "fantasypros_consensus" if int(args.use_fantasypros or 0) == 1 else None,
        ] if s],
        "sleeper_source_url": sleeper_trend_meta.get("source_url"),
        "sleeper_rows_parsed_raw": sleeper_trend_meta.get("rows"),
        "sleeper_rows_from_db": len(sleeper_rows),
        "sleeper_rows_with_trend_match": len(sleeper_trends_by_pid),
        "fantasypros_source_url": fantasypros_meta.get("source_url"),
        "fantasypros_rows_parsed": fantasypros_meta.get("rows"),
        "fantasypros_last_updated": fantasypros_meta.get("source_last_updated"),
        "source_rows": len(source_rows),
        "resolved_rows": len(resolved_rows),
        "unresolved_rows": len(unresolved),
        "artifacts": {
            "source_csv": str(LOG_DIR / "player_market_sentiment_source.csv"),
            "resolved_csv": str(LOG_DIR / "player_market_sentiment.csv"),
            "unmatched_csv": str(LOG_DIR / "player_market_sentiment_unmatched.csv"),
        },
    }
    append_jsonl(LOG_DIR / "player_market_sentiment_run_log.jsonl", run_log)

    print(
        f"Built player_market_sentiment snapshot {snapshot_ts_utc} "
        f"for season {args.valuation_season}: "
        f"{len(resolved_rows)} resolved players, {len(source_rows)} source rows, "
        f"{len(unresolved)} unresolved source rows."
    )
    print(f"Artifacts: {LOG_DIR / 'player_market_sentiment.csv'}")
    print(f"Artifacts: {LOG_DIR / 'player_market_sentiment_source.csv'}")
    print(f"Artifacts: {LOG_DIR / 'player_market_sentiment_unmatched.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
