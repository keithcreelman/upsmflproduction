#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import difflib
import json
import math
import re
import sqlite3
import statistics
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path


DB_DEFAULT = "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db"
LOG_DIR = Path("etl/logs")
API_BASE = "https://api.myfantasyleague.com"
DEFAULT_TAG_TRACKING_JSON = "/Users/keithcreelman/Documents/mfl_app_codex/tag_tracking.json"
DEFAULT_TAG_EXCLUSIONS_JSON = "/Users/keithcreelman/Documents/mfl_app_codex/reports/tagging_2026_exclusions.json"
DEFAULT_MANUAL_OVERRIDES_JSON = "etl/config/early_projection_2026_overrides.json"
DEFAULT_SLEEPER_SF_ADP_PATH = "etl/config/sleeper_sf_adp_2026_raw.txt"
DEFAULT_SALARY_ADJUSTMENTS_URL = "https://www48.myfantasyleague.com/2025/export?TYPE=salaryAdjustments&L=74598&APIKEY=aRBv1sCXvuWqx0SmP13EaDoeHbox&JSON=0"


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


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build early projection model for a future season (default 2026)."
    )
    parser.add_argument("--db-path", default=DB_DEFAULT)
    parser.add_argument("--projection-season", type=int, default=2026)
    parser.add_argument("--base-season", type=int, default=2025)
    parser.add_argument("--snapshot-week", type=int, default=None)

    # ADP fetch controls.
    parser.add_argument("--adp-source", choices=["auto", "mfl", "sleeper_sf"], default="auto")
    parser.add_argument("--period", default="AUG1")
    parser.add_argument("--fallback-period", default="ALL")
    parser.add_argument("--fcount", type=int, default=12)
    parser.add_argument("--is-ppr", type=int, default=-1)
    parser.add_argument("--is-keeper", default="N")
    parser.add_argument("--fallback-keeper", default="")
    parser.add_argument("--sleeper-sf-adp-path", default=DEFAULT_SLEEPER_SF_ADP_PATH)

    # Optional ADP fallback to base season if projection-season ADP feed is empty.
    parser.add_argument("--allow-base-season-adp-fallback", type=int, default=1)
    parser.add_argument("--qb-superflex-scale-factor", type=float, default=None)

    # Spend assumptions.
    parser.add_argument("--projected-total-spend", type=float, default=None)
    parser.add_argument("--recent-spend-years", type=int, default=3)
    parser.add_argument("--idp-spend-ratio", type=float, default=None)
    parser.add_argument("--cap-start", type=float, default=300000.0)
    parser.add_argument("--min-combined-commitment", type=float, default=3400000.0)
    parser.add_argument("--adjustment-leftover-reserve", type=float, default=200000.0)
    parser.add_argument("--cut-bait-rate-override", type=float, default=None)
    parser.add_argument("--salary-adjustment-volume-override", type=float, default=None)
    parser.add_argument("--salary-adjustments-url", default=DEFAULT_SALARY_ADJUSTMENTS_URL)
    parser.add_argument("--salary-adjustments-timeout", type=int, default=30)

    # Tag assumptions.
    parser.add_argument("--tag-tracking-json", default=DEFAULT_TAG_TRACKING_JSON)
    parser.add_argument("--tag-exclusions-json", default=DEFAULT_TAG_EXCLUSIONS_JSON)
    parser.add_argument("--manual-overrides-json", default=DEFAULT_MANUAL_OVERRIDES_JSON)
    parser.add_argument("--tag-max-adp", type=float, default=140.0)
    parser.add_argument("--tag-min-surplus", type=float, default=0.0)
    parser.add_argument("--tag-min-value-multiple", type=float, default=1.0)

    # Rookie extension assumptions.
    parser.add_argument("--rookie-extend-adp-cutoff", type=float, default=120.0)
    parser.add_argument("--rookie-extend-multiplier", type=float, default=1.5)
    parser.add_argument("--rookie-extend-min-salary", type=int, default=1000)

    # ADP -> points calibration assumptions.
    parser.add_argument("--points-history-years", type=int, default=3)
    parser.add_argument("--points-history-end-season", type=int, default=None)
    parser.add_argument("--points-min-samples", type=int, default=20)
    parser.add_argument("--points-knn", type=int, default=50)

    return parser.parse_args()


def now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def coerce_int(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return int(float(v))
    except Exception:
        return None


def coerce_float(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return float(v)
    except Exception:
        return None


def is_idp_position(position):
    if not position:
        return False
    return str(position).strip().upper() in IDP_POSITIONS


def is_rookie_status(contract_status):
    s = str(contract_status or "").lower()
    return "rookie" in s


def round_up_to_1000(v):
    if v is None:
        return None
    return int(math.ceil(float(v) / 1000.0) * 1000)


def status_factor(status):
    s = str(status or "").upper()
    if s == "TAXI_SQUAD":
        return 0.0
    if s == "INJURED_RESERVE":
        return 0.5
    return 1.0


def adp_weight_inv_sqrt(adp):
    a = coerce_float(adp)
    if a is None or a <= 0:
        return 0.0
    return 1.0 / math.sqrt(float(a))


def normalize_points_group(position):
    p = str(position or "").strip().upper()
    if not p:
        return "UNK"
    if p in IDP_POSITIONS:
        return "IDP"
    if p in ("K", "PK"):
        return "PK"
    if p in ("DEF", "DST", "D/ST", "D"):
        return "DEF"
    return p


def normalize_lookup_key(name):
    if not name:
        return ""
    s = re.sub(r"[^a-z0-9]+", " ", str(name).lower())
    toks = [t for t in s.split() if t and t not in NAME_SUFFIX_TOKENS]
    return "".join(toks)


def positions_compatible(input_pos, roster_pos):
    a = str(input_pos or "").strip().upper()
    b = str(roster_pos or "").strip().upper()
    if not a or not b:
        return False
    if a == b:
        return True
    if {a, b} <= {"PK", "K"}:
        return True
    if (a in IDP_POSITIONS) and (b in IDP_POSITIONS):
        return True
    return False


def to_first_last(name):
    if not name:
        return ""
    s = str(name).strip()
    if "," not in s:
        return s
    last, first = s.split(",", 1)
    return f"{first.strip()} {last.strip()}".strip()


def parse_contract_year_values(contract_info):
    if not contract_info:
        return []
    s = str(contract_info)
    pairs = re.findall(r"Y\s*([0-9]+)\s*-\s*([0-9]+(?:\.[0-9]+)?)(\s*[kK])?", s)
    out = {}
    for yraw, vraw, kraw in pairs:
        y = coerce_int(yraw)
        v = coerce_float(vraw)
        if y is None or v is None:
            continue
        has_k = bool(kraw and str(kraw).strip())
        if has_k or v <= 1000:
            amount = int(round(v * 1000.0))
        else:
            amount = int(round(v))
        out[y] = amount
    return [out[y] for y in sorted(out.keys())]


def infer_next_salary_from_contract_info(contract_info, contract_year_base, salary_base):
    year_vals = parse_contract_year_values(contract_info)
    if len(year_vals) < 2:
        return None, None

    candidates = []
    cy = coerce_int(contract_year_base)
    if cy is not None and cy > 0 and len(year_vals) >= cy:
        idx = len(year_vals) - cy
        if 0 <= idx < len(year_vals):
            candidates.append(("remaining_year_index", idx))

    sal = coerce_int(salary_base)
    if sal is not None and year_vals:
        exact_idxs = [i for i, v in enumerate(year_vals) if int(v) == int(sal)]
        for i in exact_idxs:
            candidates.append(("exact_salary_match", i))
        closest_idx = min(range(len(year_vals)), key=lambda i: abs(float(year_vals[i]) - float(sal)))
        candidates.append(("closest_salary_match", closest_idx))

    seen = set()
    dedup = []
    for m, i in candidates:
        if i in seen:
            continue
        seen.add(i)
        dedup.append((m, i))

    for method, idx in dedup:
        if idx + 1 < len(year_vals):
            return int(year_vals[idx + 1]), method

    if len(year_vals) >= 2:
        return int(year_vals[1]), "fallback_second_year"
    return None, None


def parse_salary_to_dollars(v):
    if v is None:
        return None
    s = str(v).strip().upper().replace("$", "").replace(",", "")
    if not s:
        return None
    is_k = s.endswith("K")
    if is_k:
        s = s[:-1].strip()
    num = coerce_float(s)
    if num is None:
        return None
    if is_k or num <= 1000:
        return int(round(num * 1000.0))
    return int(round(num))


def load_manual_overrides(path):
    p = Path(path)
    if not p.exists():
        return {"tags": [], "extensions": []}, {"path": str(p), "loaded": 0}

    with p.open("r", encoding="utf-8") as f:
        payload = json.load(f)

    tags = []
    for r in payload.get("manual_tags", []):
        name = r.get("player_name")
        salary = parse_salary_to_dollars(r.get("salary_k", r.get("salary")))
        if not name or salary is None:
            continue
        tags.append({"player_name": name, "salary": salary})

    exts = []
    for r in payload.get("manual_extensions", []):
        name = r.get("player_name")
        years = coerce_int(r.get("years"))
        if not name or years is None:
            continue
        exts.append({"player_name": name, "years": max(1, years)})

    return {"tags": tags, "extensions": exts}, {"path": str(p), "loaded": len(tags) + len(exts)}


def build_roster_name_index(roster_rows):
    out = {}
    for r in roster_rows:
        for nm in (r.get("player_name"), to_first_last(r.get("player_name"))):
            key = normalize_lookup_key(nm)
            if key and key not in out:
                out[key] = r
    return out


def resolve_roster_row_by_name(name, name_index):
    key = normalize_lookup_key(name)
    if not key:
        return None, 0.0
    if key in name_index:
        return name_index[key], 1.0
    keys = list(name_index.keys())
    if not keys:
        return None, 0.0
    matches = difflib.get_close_matches(key, keys, n=1, cutoff=0.68)
    if not matches:
        return None, 0.0
    m = matches[0]
    score = difflib.SequenceMatcher(None, key, m).ratio()
    return name_index[m], score


def build_adp_url(season, period, fcount, is_ppr, is_keeper):
    params = [
        ("TYPE", "adp"),
        ("PERIOD", period),
        ("FCOUNT", str(fcount)),
        ("IS_PPR", str(is_ppr)),
        ("IS_KEEPER", str(is_keeper)),
        ("IS_MOCK", "0"),
        ("CUTOFF", ""),
        ("DETAILS", ""),
        ("JSON", "0"),
    ]
    return f"{API_BASE}/{season}/export?{urllib.parse.urlencode(params)}"


def fetch_adp(season, period, fcount, is_ppr, is_keeper):
    url = build_adp_url(season, period, fcount, is_ppr, is_keeper)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "codex-early-projection/1.0",
            "Accept": "application/xml,text/xml,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = resp.read()
    root = ET.fromstring(payload)
    if root.tag.lower() != "adp":
        raise RuntimeError(f"Unexpected ADP payload root: {root.tag}")
    meta = {
        "season": season,
        "source_url": url,
        "dataset_timestamp": root.attrib.get("timestamp"),
        "total_drafts": coerce_int(root.attrib.get("totalDrafts")),
        "total_picks": coerce_int(root.attrib.get("totalPicks")),
    }
    players = []
    for n in root.findall("player"):
        pid = str(n.attrib.get("id") or "").strip()
        if not pid:
            continue
        players.append(
            {
                "player_id": pid,
                "rank": coerce_int(n.attrib.get("rank")),
                "average_pick": coerce_float(n.attrib.get("averagePick")),
                "drafts_selected_in": coerce_int(n.attrib.get("draftsSelectedIn")),
                "draft_sel_pct": coerce_float(n.attrib.get("draftSelPct")),
                "min_pick": coerce_int(n.attrib.get("minPick")),
                "max_pick": coerce_int(n.attrib.get("maxPick")),
            }
        )
    return meta, players


def parse_sleeper_slot_to_overall(slot_text, fcount):
    m = re.match(r"^\s*([0-9]+)\.([0-9]+)\s*$", str(slot_text or ""))
    if not m:
        return None
    rnd = coerce_int(m.group(1))
    pick = coerce_int(m.group(2))
    if rnd is None or pick is None or rnd <= 0 or pick <= 0:
        return None
    return float((int(rnd) - 1) * int(fcount) + int(pick))


def parse_sleeper_slot_to_weight_pick(slot_text, fcount):
    m = re.match(r"^\s*([0-9]+)\.([0-9]+)\s*$", str(slot_text or ""))
    if not m:
        return None
    rnd = coerce_int(m.group(1))
    pick = coerce_int(m.group(2))
    if rnd is None or pick is None or rnd <= 0 or pick <= 0:
        return None
    # Scale pick within round to reduce over-penalizing early pick gaps.
    return float(rnd) + (float(pick - 1) / float(max(1, fcount)))


def parse_sleeper_superflex_text(text, fcount):
    rows = []
    pending = None
    pos_re = r"(QB|RB|WR|TE|PK|K|DEF|DL|DE|DT|LB|DB|CB|S)"
    team_re = r"([A-Z]{2,3}|UNS|RK)"
    name_pos_team_re = re.compile(rf"^([A-Za-z0-9][A-Za-z0-9\.\'\-\s]+?)\s+{pos_re}\s+{team_re}$")

    for raw_line in str(text or "").splitlines():
        line = raw_line.strip()
        if not line:
            continue

        m_player = name_pos_team_re.match(line)
        if m_player:
            pending = {
                "player_name": m_player.group(1).strip(),
                "position": m_player.group(2).strip().upper(),
                "nfl_team": m_player.group(3).strip().upper(),
            }
            continue

        if pending is None:
            continue

        overall = parse_sleeper_slot_to_overall(line, fcount)
        weight_pick = parse_sleeper_slot_to_weight_pick(line, fcount)
        if overall is None or weight_pick is None:
            continue

        rec = dict(pending)
        rec["average_pick"] = float(overall)
        rec["weight_pick"] = float(weight_pick)
        rec["sleeper_slot"] = str(line)
        rows.append(rec)
        pending = None

    # Keep best ADP when duplicate names appear.
    by_name = {}
    for r in rows:
        key = normalize_lookup_key(r["player_name"])
        if not key:
            continue
        existing = by_name.get(key)
        if existing is None or float(r["average_pick"]) < float(existing["average_pick"]):
            by_name[key] = r

    dedup = list(by_name.values())
    dedup.sort(key=lambda x: (float(x["average_pick"]), x["player_name"]))
    return dedup


def fetch_sleeper_sf_adp_for_roster(args, roster_rows):
    path = Path(args.sleeper_sf_adp_path)
    if not path.exists():
        return None

    text = path.read_text(encoding="utf-8", errors="ignore")
    parsed = parse_sleeper_superflex_text(text, args.fcount)
    if not parsed:
        return None

    name_index = build_roster_name_index(roster_rows)
    by_pid = {}
    resolution_rows = []
    for r in parsed:
        resolved, score = resolve_roster_row_by_name(r["player_name"], name_index)
        if not resolved:
            resolution_rows.append(
                {
                    "input_name": r["player_name"],
                    "input_position": r["position"],
                    "input_team": r["nfl_team"],
                    "sleeper_slot": r["sleeper_slot"],
                    "average_pick": r["average_pick"],
                    "resolved_player_name": "",
                    "resolved_player_id": "",
                    "status": "unmatched",
                    "confidence": 0.0,
                }
            )
            continue

        if float(score) < 0.90:
            resolution_rows.append(
                {
                    "input_name": r["player_name"],
                    "input_position": r["position"],
                    "input_team": r["nfl_team"],
                    "sleeper_slot": r["sleeper_slot"],
                    "average_pick": r["average_pick"],
                    "resolved_player_name": resolved["player_name"],
                    "resolved_player_id": str(resolved["player_id"]),
                    "status": "rejected_low_confidence",
                    "confidence": round(float(score), 4),
                }
            )
            continue

        if not positions_compatible(r["position"], resolved.get("position")):
            resolution_rows.append(
                {
                    "input_name": r["player_name"],
                    "input_position": r["position"],
                    "input_team": r["nfl_team"],
                    "sleeper_slot": r["sleeper_slot"],
                    "average_pick": r["average_pick"],
                    "resolved_player_name": resolved["player_name"],
                    "resolved_player_id": str(resolved["player_id"]),
                    "status": "rejected_position_mismatch",
                    "confidence": round(float(score), 4),
                }
            )
            continue

        pid = str(resolved["player_id"])
        existing = by_pid.get(pid)
        if existing is None or float(r["average_pick"]) < float(existing["average_pick"]):
            by_pid[pid] = {
                "player_id": pid,
                "rank": None,
                "average_pick": float(r["average_pick"]),
                "average_pick_overall": float(r["average_pick"]),
                "weight_pick": float(r["weight_pick"]),
                "drafts_selected_in": None,
                "draft_sel_pct": None,
                "min_pick": None,
                "max_pick": None,
            }
        resolution_rows.append(
            {
                "input_name": r["player_name"],
                "input_position": r["position"],
                "input_team": r["nfl_team"],
                "sleeper_slot": r["sleeper_slot"],
                "average_pick": r["average_pick"],
                "resolved_player_name": resolved["player_name"],
                "resolved_player_id": pid,
                "status": "matched",
                "confidence": round(float(score), 4),
            }
        )

    rows = list(by_pid.values())
    rows.sort(key=lambda x: (float(x["average_pick"]), x["player_id"]))
    for idx, r in enumerate(rows, start=1):
        r["rank"] = idx

    meta = {
        "season": args.projection_season,
        "source_url": str(path),
        "dataset_timestamp": now_utc(),
        "total_drafts": None,
        "total_picks": len(parsed),
        "parsed_rows": len(parsed),
        "matched_rows": len(rows),
        "unmatched_rows": max(0, len(parsed) - len(rows)),
    }

    return {
        "adp_source_season": args.projection_season,
        "requested_period": "SLEEPER_SF",
        "used_period": "SLEEPER_SF",
        "requested_keeper": "N/A",
        "used_keeper": "N/A",
        "fallback_used": 0,
        "meta": meta,
        "rows": rows,
        "adp_source_kind": "sleeper_sf",
        "sf_already_normalized": 1,
        "sleeper_resolution_rows": resolution_rows,
    }


def fetch_adp_with_fallback(args, roster_rows=None):
    adp_source = str(args.adp_source or "auto").strip().lower()
    allow_sleeper = adp_source == "sleeper_sf" or (adp_source == "auto" and int(args.projection_season) >= 2026)
    if allow_sleeper and roster_rows:
        sleeper_payload = fetch_sleeper_sf_adp_for_roster(args, roster_rows)
        if sleeper_payload and sleeper_payload.get("rows"):
            return sleeper_payload
        if adp_source == "sleeper_sf":
            raise RuntimeError(
                f"Failed to load Sleeper SF ADP from {args.sleeper_sf_adp_path} "
                "or no roster player matches were found."
            )

    if adp_source == "sleeper_sf":
        raise RuntimeError(
            f"Sleeper SF ADP source requested but unavailable: {args.sleeper_sf_adp_path}"
        )

    attempts = [
        (args.projection_season, args.period, args.is_keeper),
        (args.projection_season, args.fallback_period, args.is_keeper),
        (args.projection_season, args.period, args.fallback_keeper),
        (args.projection_season, args.fallback_period, args.fallback_keeper),
    ]
    if args.allow_base_season_adp_fallback:
        attempts.extend(
            [
                (args.base_season, args.period, args.is_keeper),
                (args.base_season, args.fallback_period, args.is_keeper),
                (args.base_season, args.period, args.fallback_keeper),
                (args.base_season, args.fallback_period, args.fallback_keeper),
            ]
        )

    seen = set()
    for season, period, keeper in attempts:
        key = (season, period, str(keeper))
        if key in seen:
            continue
        seen.add(key)
        meta, rows = fetch_adp(season, period, args.fcount, args.is_ppr, keeper)
        if rows:
            return {
                "adp_source_season": season,
                "requested_period": args.period,
                "used_period": period,
                "requested_keeper": str(args.is_keeper),
                "used_keeper": str(keeper),
                "fallback_used": 1 if (season != args.projection_season or period != args.period or str(keeper) != str(args.is_keeper)) else 0,
                "meta": meta,
                "rows": rows,
                "adp_source_kind": "mfl",
                "sf_already_normalized": 0,
                "sleeper_resolution_rows": [],
            }

    # Return last attempted payload metadata even when empty.
    meta, rows = fetch_adp(args.projection_season, args.period, args.fcount, args.is_ppr, args.is_keeper)
    return {
        "adp_source_season": args.projection_season,
        "requested_period": args.period,
        "used_period": args.period,
        "requested_keeper": str(args.is_keeper),
        "used_keeper": str(args.is_keeper),
        "fallback_used": 0,
        "meta": meta,
        "rows": rows,
        "adp_source_kind": "mfl",
        "sf_already_normalized": 0,
        "sleeper_resolution_rows": [],
    }


def parse_drop_salary_from_adjustment_desc(description):
    s = str(description or "")
    m = re.search(r"Salary:\s*\$([0-9,]+)", s, flags=re.IGNORECASE)
    if not m:
        return None
    return coerce_int(m.group(1).replace(",", ""))


def fetch_salary_adjustments(url, timeout=30):
    req = urllib.request.Request(
        str(url),
        headers={
            "User-Agent": "codex-early-projection/1.0",
            "Accept": "application/xml,text/xml,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = resp.read()
    root = ET.fromstring(payload)
    if root.tag.lower() != "salaryadjustments":
        raise RuntimeError(f"Unexpected salaryAdjustments payload root: {root.tag}")

    rows = []
    for n in root.findall("salaryAdjustment"):
        raw_amt = coerce_float(n.attrib.get("amount"))
        amt = float(raw_amt or 0.0)
        rows.append(
            {
                "id": str(n.attrib.get("id") or "").strip(),
                "franchise_id": str(n.attrib.get("franchise_id") or "").strip(),
                "amount": amt,
                "description": str(n.attrib.get("description") or ""),
                "timestamp": coerce_int(n.attrib.get("timestamp")),
                "drop_salary_in_desc": parse_drop_salary_from_adjustment_desc(n.attrib.get("description") or ""),
            }
        )

    return {
        "source_url": str(url),
        "rows": rows,
        "fetched_at_utc": now_utc(),
    }


def summarize_salary_adjustments(rows):
    tiny_threshold = 1.0  # Ignore tiny scientific-notation marker amounts.
    marker_rows = [r for r in rows if abs(float(r.get("amount") or 0.0)) < tiny_threshold]
    real_rows = [r for r in rows if abs(float(r.get("amount") or 0.0)) >= tiny_threshold]

    marker_drop_salary_total = float(
        sum(float(r.get("drop_salary_in_desc") or 0.0) for r in marker_rows)
    )

    by_ts = defaultdict(list)
    for r in real_rows:
        ts = r.get("timestamp")
        if ts is not None:
            by_ts[int(ts)].append(r)

    used_ids = set()
    trade_transfer_volume = 0.0
    for _ts, items in by_ts.items():
        if len(items) < 2:
            continue
        net = sum(float(x.get("amount") or 0.0) for x in items)
        abs_sum = sum(abs(float(x.get("amount") or 0.0)) for x in items)
        has_pos = any(float(x.get("amount") or 0.0) > 0 for x in items)
        has_neg = any(float(x.get("amount") or 0.0) < 0 for x in items)
        if has_pos and has_neg and abs(net) < 0.01:
            trade_transfer_volume += (abs_sum / 2.0)
            for x in items:
                if x.get("id"):
                    used_ids.add(str(x.get("id")))

    cap_penalty_total = 0.0
    other_abs_total = 0.0
    other_net_total = 0.0
    traded_label_abs_total = 0.0
    for r in real_rows:
        rid = str(r.get("id") or "")
        amt = float(r.get("amount") or 0.0)
        desc = str(r.get("description") or "")
        d = desc.lower()

        if rid in used_ids:
            continue
        if "cap_penalt" in d:
            cap_penalty_total += max(0.0, amt)
            continue
        if "tradedsalary" in d:
            traded_label_abs_total += abs(amt)
            continue
        other_abs_total += abs(amt)
        other_net_total += amt

    effective_volume = (
        float(trade_transfer_volume)
        + float(traded_label_abs_total / 2.0)
        + float(cap_penalty_total)
        + float(other_abs_total)
    )

    return {
        "rows_total": len(rows),
        "rows_real_amount": len(real_rows),
        "rows_marker_amount": len(marker_rows),
        "marker_drop_salary_total": round(marker_drop_salary_total, 2),
        "trade_transfer_volume": round(float(trade_transfer_volume), 2),
        "traded_label_abs_total": round(float(traded_label_abs_total), 2),
        "cap_penalty_total": round(float(cap_penalty_total), 2),
        "other_abs_total": round(float(other_abs_total), 2),
        "other_net_total": round(float(other_net_total), 2),
        "effective_volume": round(float(effective_volume), 2),
    }


def get_snapshot_week(conn, base_season, snapshot_week):
    if snapshot_week is not None:
        return snapshot_week
    cur = conn.cursor()
    cur.execute("SELECT MAX(week) FROM rosters_weekly WHERE season = ?", (base_season,))
    r = cur.fetchone()
    w = coerce_int(r[0]) if r else None
    if w is None:
        raise RuntimeError(f"No rosters_weekly rows for base season {base_season}.")
    return w


def get_roster_snapshot(conn, base_season, snapshot_week):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            franchise_id, team_name,
            player_id, player_name, position, nfl_team,
            status, salary, contract_year, contract_status, contract_info
        FROM rosters_weekly
        WHERE season = ?
          AND week = ?
        ORDER BY franchise_id, player_name
        """,
        (base_season, snapshot_week),
    )
    rows = []
    for r in cur.fetchall():
        rows.append(
            {
                "franchise_id": str(r[0]),
                "team_name": r[1],
                "player_id": str(r[2]),
                "player_name": r[3],
                "position": r[4],
                "nfl_team": r[5],
                "status": r[6],
                "salary": coerce_int(r[7]) or 0,
                "contract_year": coerce_int(r[8]) or 0,
                "contract_status": r[9],
                "contract_info": r[10],
            }
        )
    return rows


def get_cap_start(conn, season, cap_default):
    cur = conn.cursor()
    cur.execute(
        "SELECT salary_cap_amount FROM metadata_leaguedetails WHERE season=? LIMIT 1",
        (season,),
    )
    r = cur.fetchone()
    cap = coerce_float(r[0]) if r else None
    return cap if cap is not None else cap_default


def get_recent_total_spend(conn, base_season, years):
    cur = conn.cursor()
    season_min = base_season - years + 1

    # Prefer summary table if available.
    cur.execute(
        """
        SELECT total_winning_spend
        FROM auction_value_summary_v1
        WHERE season BETWEEN ? AND ?
          AND total_winning_spend IS NOT NULL
        """,
        (season_min, base_season),
    )
    vals = [coerce_float(r[0]) for r in cur.fetchall() if coerce_float(r[0]) is not None]
    if vals:
        return float(sum(vals) / len(vals)), vals

    # Fallback: compute directly from transactions_auction.
    cur.execute(
        """
        SELECT season, SUM(COALESCE(bid_amount, 0)) AS spend
        FROM transactions_auction
        WHERE season BETWEEN ? AND ?
          AND auction_type='FreeAgent'
          AND finalbid_ind=1
        GROUP BY season
        ORDER BY season
        """,
        (season_min, base_season),
    )
    vals = [coerce_float(r[1]) for r in cur.fetchall() if coerce_float(r[1]) is not None]
    if vals:
        return float(sum(vals) / len(vals)), vals
    return 750000.0, []


def get_recent_idp_ratio(conn, base_season, years):
    cur = conn.cursor()
    season_min = base_season - years + 1
    cur.execute(
        """
        SELECT
            season,
            SUM(CASE
                    WHEN UPPER(COALESCE(position,'')) IN ('DL','DE','DT','LB','OLB','ILB','MLB','DB','CB','S','SS','FS','NT','EDGE','IDP')
                    THEN COALESCE(winning_bid, 0)
                    ELSE 0
                END) AS idp_spend,
            SUM(COALESCE(winning_bid, 0)) AS total_spend
        FROM auction_player_value_model_v1
        WHERE season BETWEEN ? AND ?
          AND won_ind=1
        GROUP BY season
        ORDER BY season
        """,
        (season_min, base_season),
    )
    ratios = []
    for _season, idp_spend, total_spend in cur.fetchall():
        t = coerce_float(total_spend) or 0.0
        i = coerce_float(idp_spend) or 0.0
        if t > 0:
            ratios.append(i / t)
    if ratios:
        return float(sum(ratios) / len(ratios)), ratios
    return 0.18, []


def get_recent_salary_adjustment_volume(conn, base_season, years):
    cur = conn.cursor()
    season_min = base_season - years + 1
    cur.execute(
        """
        SELECT
            season,
            SUM(CASE WHEN COALESCE(salaryadjustment_ind,0)=1 THEN ABS(COALESCE(asset_capadjustment,0)) ELSE 0 END) / 2.0 AS adj_volume
        FROM transactions_trades
        WHERE season BETWEEN ? AND ?
        GROUP BY season
        ORDER BY season
        """,
        (season_min, base_season),
    )
    vals = [coerce_float(r[1]) for r in cur.fetchall() if coerce_float(r[1]) is not None]
    if vals:
        return float(sum(vals) / len(vals)), vals
    return 200000.0, []


def get_recent_cut_bait_rate(conn, base_season, years):
    cur = conn.cursor()
    season_min = base_season - years + 1
    cur.execute(
        """
        SELECT
            season,
            SUM(CASE WHEN COALESCE(prior_rollover_expected_under_contract,0)=1 THEN COALESCE(prior_salary,0) ELSE 0 END) AS carry_in_salary,
            SUM(CASE WHEN COALESCE(prior_rollover_expected_under_contract,0)=1
                       AND COALESCE(drop_count_pre_deadline,0)>0
                     THEN COALESCE(prior_salary,0) ELSE 0 END) AS cut_salary
        FROM contract_history_snapshots
        WHERE snapshot_week=1
          AND season BETWEEN ? AND ?
        GROUP BY season
        ORDER BY season
        """,
        (season_min, base_season),
    )
    rates = []
    for _season, carry_in, cut_salary in cur.fetchall():
        carry = coerce_float(carry_in) or 0.0
        cut = coerce_float(cut_salary) or 0.0
        if carry > 0:
            rates.append(cut / carry)
    if rates:
        return float(sum(rates) / len(rates)), rates
    return 0.06, []


def get_team_auction_share(conn, base_season):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            franchise_id,
            MAX(team_name) AS team_name,
            SUM(COALESCE(bid_amount, 0)) AS spend
        FROM transactions_auction
        WHERE season=?
          AND auction_type='FreeAgent'
          AND finalbid_ind=1
          AND substr(date_et, 6, 2) IN ('07', '08')
        GROUP BY franchise_id
        """,
        (base_season,),
    )
    rows = cur.fetchall()
    spends = {}
    team_names = {}
    total = 0.0
    for fid, team_name, spend in rows:
        f = str(fid)
        s = coerce_float(spend) or 0.0
        spends[f] = s
        team_names[f] = team_name
        total += s
    shares = {}
    for fid, s in spends.items():
        shares[fid] = (s / total) if total > 0 else 0.0
    return shares, team_names


def get_qb_superflex_factor(conn, base_season, override):
    if override is not None:
        return float(override)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT normalized_adp, mfl_average_pick
        FROM adp_normalized_values
        WHERE season = ?
          AND UPPER(COALESCE(position,'')) = 'QB'
          AND normalized_adp IS NOT NULL
          AND mfl_average_pick IS NOT NULL
          AND mfl_average_pick > 0
        """,
        (base_season,),
    )
    ratios = []
    for norm, mfl in cur.fetchall():
        n = coerce_float(norm)
        m = coerce_float(mfl)
        if n is None or m is None or m <= 0:
            continue
        ratios.append(n / m)
    if ratios:
        return statistics.median(ratios)
    return 1.0


def load_tag_tracking(path):
    p = Path(path)
    if not p.exists():
        return {}, {"path": str(p), "loaded": 0}
    with p.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    rows = payload.get("rows", [])
    tag_map = {}
    for r in rows:
        fid = str(r.get("franchise_id") or "").strip()
        pid = str(r.get("player_id") or "").strip()
        if not fid or not pid:
            continue
        tag_map[(fid, pid)] = {
            "is_tag_eligible": coerce_int(r.get("is_tag_eligible")) or 0,
            "tag_salary": coerce_int(r.get("tag_salary")) or coerce_int(r.get("tag_bid")) or 0,
            "tag_side": r.get("tag_side") or "",
            "tag_tier": coerce_int(r.get("tag_tier")),
            "eligibility_reason": r.get("eligibility_reason"),
            "contract_status": r.get("contract_status"),
        }
    meta = payload.get("meta", {})
    return tag_map, {
        "path": str(p),
        "loaded": len(tag_map),
        "meta_tracking_for_season": meta.get("tracking_for_season"),
        "meta_count": meta.get("count"),
    }


def load_tag_exclusions(path):
    p = Path(path)
    if not p.exists():
        return set(), {"path": str(p), "loaded": 0}
    with p.open("r", encoding="utf-8") as f:
        payload = json.load(f)
    ineligible = set()
    for r in payload.get("tagged_ineligible_2026", []):
        pid = str(r.get("player_id") or "").strip()
        if pid:
            ineligible.add(pid)
    return ineligible, {"path": str(p), "loaded": len(ineligible)}


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def ensure_column(conn, table_name, column_name, column_def):
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table_name})")
    existing = {r[1] for r in cur.fetchall()}
    if column_name not in existing:
        cur.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_def}")
        conn.commit()


def build_points_training_rows(conn, season_start, season_end):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT
            n.season,
            n.player_id,
            n.player_name,
            n.position,
            n.normalized_adp,
            p.reg_games,
            p.reg_points,
            p.reg_ppg
        FROM adp_normalized_values n
        JOIN player_pointssummary p
          ON p.season = n.season
         AND CAST(p.player_id AS TEXT) = CAST(n.player_id AS TEXT)
        WHERE n.season BETWEEN ? AND ?
          AND n.normalized_adp IS NOT NULL
          AND n.normalized_adp > 0
          AND p.reg_games IS NOT NULL
          AND p.reg_games > 0
          AND p.reg_points IS NOT NULL
        """,
        (season_start, season_end),
    )
    rows = []
    for season, player_id, player_name, position, adp, reg_games, reg_points, reg_ppg in cur.fetchall():
        adp_f = coerce_float(adp)
        points_f = coerce_float(reg_points)
        ppg_f = coerce_float(reg_ppg)
        if adp_f is None or adp_f <= 0 or points_f is None:
            continue
        rows.append(
            {
                "season": coerce_int(season),
                "player_id": str(player_id),
                "player_name": player_name,
                "group": normalize_points_group(position),
                "normalized_adp": float(adp_f),
                "log_adp": math.log1p(float(adp_f)),
                "reg_games": coerce_int(reg_games) or 0,
                "reg_points": float(points_f),
                "reg_ppg": float(ppg_f) if ppg_f is not None else (float(points_f) / float(reg_games)),
            }
        )
    return rows


def build_points_group_index(training_rows):
    groups = defaultdict(list)
    for r in training_rows:
        g = r["group"]
        groups[g].append(r)
        if g == "IDP":
            groups["IDP_ALL"].append(r)
        else:
            groups["OFFENSE_ALL"].append(r)
        groups["ALL"].append(r)
    return groups


def estimate_points_from_adp(
    normalized_adp,
    position,
    group_index,
    min_samples,
    knn,
    season_end,
):
    adp = coerce_float(normalized_adp)
    if adp is None or adp <= 0:
        adp = 400.0
    target_group = normalize_points_group(position)
    if target_group == "IDP":
        fallback_groups = ["IDP", "IDP_ALL", "ALL"]
    else:
        fallback_groups = [target_group, "OFFENSE_ALL", "ALL"]

    chosen_group = None
    chosen = []
    for g in fallback_groups:
        rows = group_index.get(g, [])
        if len(rows) >= max(1, int(min_samples)):
            chosen_group = g
            chosen = rows
            break
    if not chosen:
        chosen_group = fallback_groups[-1]
        chosen = group_index.get(chosen_group, [])
    if not chosen:
        return {
            "expected_reg_points": None,
            "expected_reg_ppg": None,
            "points_model_group": chosen_group,
            "points_model_samples": 0,
            "points_model_method": "no_training_rows",
        }

    # Monotonic ADP curve based on 1/sqrt(ADP) with a bounded linear fit.
    x_target = adp_weight_inv_sqrt(adp)
    sum_w = 0.0
    sum_wx = 0.0
    sum_wxx = 0.0
    sum_wy_points = 0.0
    sum_wxy_points = 0.0
    sum_wy_ppg = 0.0
    sum_wxy_ppg = 0.0
    sum_points = 0.0
    sum_ppg = 0.0
    y_points_vals = []
    y_ppg_vals = []

    for r in chosen:
        x_i = adp_weight_inv_sqrt(r["normalized_adp"])
        if x_i <= 0:
            continue
        season = coerce_int(r.get("season")) or season_end
        year_gap = max(0, int(season_end) - int(season))
        # Mild recency tilt while still using the wider history.
        season_w = 1.0 / (1.0 + 0.2 * year_gap)
        y_points = float(r["reg_points"])
        y_ppg = float(r["reg_ppg"])
        sum_wx += season_w * x_i
        sum_wxx += season_w * x_i * x_i
        sum_wy_points += season_w * y_points
        sum_wxy_points += season_w * x_i * y_points
        sum_wy_ppg += season_w * y_ppg
        sum_wxy_ppg += season_w * x_i * y_ppg
        sum_w += season_w
        sum_points += season_w * y_points
        sum_ppg += season_w * y_ppg
        y_points_vals.append(y_points)
        y_ppg_vals.append(y_ppg)

    if sum_w > 0 and x_target > 0:
        denom = (sum_w * sum_wxx) - (sum_wx * sum_wx)
        if abs(denom) > 1e-9:
            slope_points = ((sum_w * sum_wxy_points) - (sum_wx * sum_wy_points)) / denom
            slope_ppg = ((sum_w * sum_wxy_ppg) - (sum_wx * sum_wy_ppg)) / denom
            # Force non-negative slope to preserve monotonicity.
            slope_points = max(0.0, slope_points)
            slope_ppg = max(0.0, slope_ppg)
            intercept_points = (sum_wy_points - (slope_points * sum_wx)) / sum_w
            intercept_ppg = (sum_wy_ppg - (slope_ppg * sum_wx)) / sum_w
            points = max(0.0, intercept_points + (slope_points * x_target))
            ppg = max(0.0, intercept_ppg + (slope_ppg * x_target))
            method = "inv_sqrt_adp_weighted_linear"
        else:
            points = sum_points / sum_w
            ppg = sum_ppg / sum_w
            method = "inv_sqrt_adp_weighted_fallback_mean"

        # Keep outputs within historical band for stability.
        if y_points_vals:
            ys = sorted(y_points_vals)
            lo = ys[max(0, int(0.05 * (len(ys) - 1)))]
            hi = ys[min(len(ys) - 1, int(0.95 * (len(ys) - 1)))]
            points = max(lo, min(hi, points))
        if y_ppg_vals:
            ys = sorted(y_ppg_vals)
            lo = ys[max(0, int(0.05 * (len(ys) - 1)))]
            hi = ys[min(len(ys) - 1, int(0.95 * (len(ys) - 1)))]
            ppg = max(lo, min(hi, ppg))
    elif sum_w > 0:
        points = sum_points / sum_w
        ppg = sum_ppg / sum_w
        method = "inv_sqrt_adp_weighted_fallback_mean"
    else:
        points = sum(float(r["reg_points"]) for r in chosen) / float(len(chosen))
        ppg = sum(float(r["reg_ppg"]) for r in chosen) / float(len(chosen))
        method = "inv_sqrt_adp_unweighted_fallback_mean"

    return {
        "expected_reg_points": round(float(points), 2),
        "expected_reg_ppg": round(float(ppg), 3),
        "points_model_group": chosen_group,
        "points_model_samples": len(chosen),
        "points_model_method": method,
    }


def ensure_tables(conn):
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS early_projection_adp (
            projection_season INTEGER NOT NULL,
            adp_source_season INTEGER NOT NULL,
            requested_period TEXT,
            used_period TEXT,
            requested_keeper TEXT,
            used_keeper TEXT,
            fallback_used INTEGER DEFAULT 0,
            fetched_at_utc TEXT,
            source_url TEXT,
            dataset_timestamp TEXT,
            total_drafts INTEGER,
            total_picks INTEGER,
            player_id TEXT NOT NULL,
            rank INTEGER,
            average_pick REAL,
            drafts_selected_in INTEGER,
            PRIMARY KEY (projection_season, player_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS early_projection_contract_rollover (
            projection_season INTEGER NOT NULL,
            franchise_id TEXT NOT NULL,
            team_name TEXT,
            player_id TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            nfl_team TEXT,
            status_base TEXT,
            cap_status_factor REAL,
            salary_base INTEGER,
            contract_year_base INTEGER,
            contract_status_base TEXT,
            contract_info_base TEXT,
            projected_contract_year INTEGER,
            action TEXT,
            projected_salary_2026 INTEGER,
            tag_eligible_ind INTEGER,
            tag_selected_ind INTEGER,
            tag_side TEXT,
            tag_salary INTEGER,
            rookie_extend_candidate_ind INTEGER,
            rookie_extend_selected_ind INTEGER,
            rookie_extend_salary INTEGER,
            adp_source_season INTEGER,
            average_pick REAL,
            normalized_adp REAL,
            adp_normalization_source TEXT,
            projected_pool_ind INTEGER,
            estimated_market_value REAL,
            expected_reg_points REAL,
            expected_reg_ppg REAL,
            points_model_group TEXT,
            points_model_samples INTEGER,
            points_model_method TEXT,
            next_salary_method TEXT,
            PRIMARY KEY (projection_season, franchise_id, player_id, status_base)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS early_projection_auction_pool_values (
            projection_season INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            nfl_team TEXT,
            adp_segment TEXT,
            normalized_adp REAL,
            weight REAL,
            projected_perceived_value REAL,
            projected_winning_bid REAL,
            expected_reg_points REAL,
            expected_reg_ppg REAL,
            expected_points_per_1000_bid REAL,
            PRIMARY KEY (projection_season, player_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS early_projection_team_cap (
            projection_season INTEGER NOT NULL,
            franchise_id TEXT NOT NULL,
            team_name TEXT,
            cap_start REAL,
            retained_players INTEGER,
            retained_cap_commitment REAL,
            projected_cap_space_before_auction REAL,
            projected_auction_spend REAL,
            projected_cap_space_after_auction REAL,
            PRIMARY KEY (projection_season, franchise_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS early_projection_summary (
            projection_season INTEGER PRIMARY KEY,
            base_season INTEGER,
            snapshot_week INTEGER,
            adp_source_kind TEXT,
            adp_source_season INTEGER,
            adp_used_period TEXT,
            adp_used_keeper TEXT,
            adp_players INTEGER,
            projected_pool_players INTEGER,
            projected_tagged_players INTEGER,
            projected_rookie_extensions INTEGER,
            projected_total_spend_baseline REAL,
            projected_total_spend REAL,
            projected_idp_spend REAL,
            projected_non_idp_spend REAL,
            projected_combined_commitment REAL,
            projected_leftover_after_commitment REAL,
            projected_combined_after_cut_relief REAL,
            projected_leftover_after_cut_relief REAL,
            combined_commitment_floor REAL,
            adjustment_leftover_reserve REAL,
            salary_adjustment_volume REAL,
            estimated_cut_bait_relief REAL,
            points_history_start_season INTEGER,
            points_history_end_season INTEGER,
            points_training_rows INTEGER,
            notes TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS early_projection_topn_summary (
            projection_season INTEGER PRIMARY KEY,
            top5_count INTEGER,
            top5_value_sum REAL,
            top10_count INTEGER,
            top10_value_sum REAL,
            top25_count INTEGER,
            top25_value_sum REAL,
            top50_count INTEGER,
            top50_value_sum REAL,
            top100_count INTEGER,
            top100_value_sum REAL,
            all_count INTEGER,
            all_value_sum REAL,
            sf_count INTEGER,
            sf_value_sum REAL
        )
        """
    )
    conn.commit()

    # Forward-compatible columns for prior table versions.
    ensure_column(conn, "early_projection_contract_rollover", "contract_info_base", "TEXT")
    ensure_column(conn, "early_projection_contract_rollover", "expected_reg_points", "REAL")
    ensure_column(conn, "early_projection_contract_rollover", "expected_reg_ppg", "REAL")
    ensure_column(conn, "early_projection_contract_rollover", "points_model_group", "TEXT")
    ensure_column(conn, "early_projection_contract_rollover", "points_model_samples", "INTEGER")
    ensure_column(conn, "early_projection_contract_rollover", "points_model_method", "TEXT")
    ensure_column(conn, "early_projection_contract_rollover", "next_salary_method", "TEXT")
    ensure_column(conn, "early_projection_auction_pool_values", "expected_reg_points", "REAL")
    ensure_column(conn, "early_projection_auction_pool_values", "expected_reg_ppg", "REAL")
    ensure_column(conn, "early_projection_auction_pool_values", "expected_points_per_1000_bid", "REAL")
    ensure_column(conn, "early_projection_summary", "points_history_start_season", "INTEGER")
    ensure_column(conn, "early_projection_summary", "points_history_end_season", "INTEGER")
    ensure_column(conn, "early_projection_summary", "points_training_rows", "INTEGER")
    ensure_column(conn, "early_projection_summary", "adp_source_kind", "TEXT")
    ensure_column(conn, "early_projection_summary", "projected_total_spend_baseline", "REAL")
    ensure_column(conn, "early_projection_summary", "projected_combined_commitment", "REAL")
    ensure_column(conn, "early_projection_summary", "projected_leftover_after_commitment", "REAL")
    ensure_column(conn, "early_projection_summary", "projected_combined_after_cut_relief", "REAL")
    ensure_column(conn, "early_projection_summary", "projected_leftover_after_cut_relief", "REAL")
    ensure_column(conn, "early_projection_summary", "combined_commitment_floor", "REAL")
    ensure_column(conn, "early_projection_summary", "adjustment_leftover_reserve", "REAL")
    ensure_column(conn, "early_projection_summary", "salary_adjustment_volume", "REAL")
    ensure_column(conn, "early_projection_summary", "estimated_cut_bait_relief", "REAL")


def clear_projection_rows(conn, projection_season):
    cur = conn.cursor()
    for t in (
        "early_projection_adp",
        "early_projection_contract_rollover",
        "early_projection_auction_pool_values",
        "early_projection_team_cap",
        "early_projection_summary",
        "early_projection_topn_summary",
    ):
        cur.execute(f"DELETE FROM {t} WHERE projection_season = ?", (projection_season,))
    conn.commit()


def main():
    args = parse_args()
    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    ensure_tables(conn)
    clear_projection_rows(conn, args.projection_season)

    snapshot_week = get_snapshot_week(conn, args.base_season, args.snapshot_week)
    roster = get_roster_snapshot(conn, args.base_season, snapshot_week)
    if not roster:
        raise RuntimeError("No roster rows found for projection base season/week.")
    franchise_ids = sorted({r["franchise_id"] for r in roster})
    cap = get_cap_start(conn, args.base_season, args.cap_start)
    league_cap_total = float(cap) * float(len(franchise_ids))

    adp_payload = fetch_adp_with_fallback(args, roster_rows=roster)
    adp_rows = adp_payload["rows"]
    adp_by_pid = {r["player_id"]: r for r in adp_rows}
    adp_source_kind = adp_payload.get("adp_source_kind", "mfl")
    sf_adp_normalized = int(adp_payload.get("sf_already_normalized") or 0) == 1
    sleeper_resolution_rows = adp_payload.get("sleeper_resolution_rows", []) or []

    qb_sf_factor = get_qb_superflex_factor(conn, args.base_season, args.qb_superflex_scale_factor)

    points_history_end = args.points_history_end_season or args.base_season
    points_history_start = points_history_end - max(1, int(args.points_history_years)) + 1
    points_training_rows = build_points_training_rows(conn, points_history_start, points_history_end)
    points_group_index = build_points_group_index(points_training_rows)

    projected_total_spend = args.projected_total_spend
    projected_total_spend_baseline = None
    recent_spend_vals = []
    if projected_total_spend is None:
        projected_total_spend, recent_spend_vals = get_recent_total_spend(
            conn,
            args.base_season,
            args.recent_spend_years,
        )
    projected_total_spend_baseline = float(projected_total_spend)

    salary_adjustment_volume = args.salary_adjustment_volume_override
    recent_salary_adjustment_vals = []
    if salary_adjustment_volume is None:
        salary_adjustment_volume, recent_salary_adjustment_vals = get_recent_salary_adjustment_volume(
            conn,
            args.base_season,
            args.recent_spend_years,
        )
    salary_adjustments_feed_summary = {}
    salary_adjustments_feed_error = ""
    if str(args.salary_adjustments_url or "").strip():
        try:
            feed_payload = fetch_salary_adjustments(
                args.salary_adjustments_url,
                timeout=max(5, int(args.salary_adjustments_timeout)),
            )
            salary_adjustments_feed_summary = summarize_salary_adjustments(feed_payload["rows"])
            feed_effective = coerce_float(salary_adjustments_feed_summary.get("effective_volume")) or 0.0
            if args.salary_adjustment_volume_override is None and feed_effective > 0:
                salary_adjustment_volume = max(float(salary_adjustment_volume), float(feed_effective))
        except Exception as e:
            salary_adjustments_feed_error = str(e)

    cut_bait_rate = args.cut_bait_rate_override
    recent_cut_bait_rates = []
    if cut_bait_rate is None:
        cut_bait_rate, recent_cut_bait_rates = get_recent_cut_bait_rate(
            conn,
            args.base_season,
            args.recent_spend_years,
        )
    cut_bait_rate = max(0.0, min(1.0, float(cut_bait_rate)))

    idp_ratio = args.idp_spend_ratio
    recent_idp_ratios = []
    if idp_ratio is None:
        idp_ratio, recent_idp_ratios = get_recent_idp_ratio(
            conn,
            args.base_season,
            args.recent_spend_years,
        )
    idp_ratio = max(0.0, min(1.0, float(idp_ratio)))

    tag_map, tag_meta = load_tag_tracking(args.tag_tracking_json)
    tag_exclusions, tag_excl_meta = load_tag_exclusions(args.tag_exclusions_json)
    manual_overrides, manual_meta = load_manual_overrides(args.manual_overrides_json)

    # First pass: classify rollover.
    rollover_rows = []
    for r in roster:
        cy = r["contract_year"]
        projected_cy = max(cy - 1, 0)
        expiring = cy <= 1

        adp = adp_by_pid.get(r["player_id"])
        avg_pick = adp["average_pick"] if adp else None
        avg_pick_overall = adp.get("average_pick_overall") if adp else None
        weight_pick = adp.get("weight_pick") if adp else None
        points_pick = avg_pick_overall if avg_pick_overall is not None else avg_pick
        if weight_pick is None:
            weight_pick = avg_pick

        if (
            weight_pick is not None
            and r["position"]
            and str(r["position"]).upper() == "QB"
            and not sf_adp_normalized
        ):
            normalized_adp = round(float(weight_pick) * qb_sf_factor, 2)
            adp_norm_src = "qb_scaled_from_base_superflex_factor"
        else:
            normalized_adp = weight_pick
            adp_norm_src = "sleeper_sf_slot" if adp_source_kind == "sleeper_sf" else "mfl"
        if normalized_adp is None:
            normalized_adp = 400.0
            adp_norm_src = "fallback_missing_adp"
        points_adp_proxy = points_pick if points_pick is not None else normalized_adp
        if points_adp_proxy is None:
            points_adp_proxy = 400.0

        next_salary, next_salary_method = infer_next_salary_from_contract_info(
            r.get("contract_info"),
            cy,
            r["salary"],
        )
        projected_salary_keep = next_salary if next_salary is not None else r["salary"]

        t = tag_map.get((r["franchise_id"], r["player_id"]), {})
        tag_eligible = 1 if (coerce_int(t.get("is_tag_eligible")) or 0) == 1 else 0
        if r["player_id"] in tag_exclusions:
            tag_eligible = 0

        rookie_candidate = 1 if (expiring and is_rookie_status(r["contract_status"])) else 0

        row = {
            "projection_season": args.projection_season,
            "franchise_id": r["franchise_id"],
            "team_name": r["team_name"],
            "player_id": r["player_id"],
            "player_name": r["player_name"],
            "position": r["position"],
            "nfl_team": r["nfl_team"],
            "status_base": r["status"],
            "cap_status_factor": status_factor(r["status"]),
            "salary_base": r["salary"],
            "contract_year_base": cy,
            "contract_status_base": r["contract_status"],
            "contract_info_base": r.get("contract_info"),
            "projected_contract_year": projected_cy,
            "action": "retain_existing" if not expiring else "expiring_to_pool",
            "projected_salary_2026": int(projected_salary_keep) if not expiring else 0,
            "tag_eligible_ind": tag_eligible,
            "tag_selected_ind": 0,
            "tag_side": t.get("tag_side") or ("IDP_K" if is_idp_position(r["position"]) else "OFFENSE"),
            "tag_salary": coerce_int(t.get("tag_salary")) or 0,
            "rookie_extend_candidate_ind": rookie_candidate,
            "rookie_extend_selected_ind": 0,
            "rookie_extend_salary": 0,
            "adp_source_season": adp_payload["adp_source_season"],
            "average_pick": avg_pick,
            "normalized_adp": normalized_adp,
            "points_adp_proxy": points_adp_proxy,
            "adp_normalization_source": adp_norm_src,
            "projected_pool_ind": 1 if expiring else 0,
            "estimated_market_value": 0.0,
            "expected_reg_points": None,
            "expected_reg_ppg": None,
            "points_model_group": "",
            "points_model_samples": 0,
            "points_model_method": "",
            "next_salary_method": next_salary_method or "",
        }
        rollover_rows.append(row)

    # Resolve manual overrides by player name.
    name_index = build_roster_name_index(roster)
    manual_resolution_rows = []
    manual_tag_overrides = {}
    manual_ext_overrides = {}

    for t in manual_overrides.get("tags", []):
        resolved_row, score = resolve_roster_row_by_name(t["player_name"], name_index)
        if not resolved_row:
            manual_resolution_rows.append(
                {
                    "override_type": "tag",
                    "input_name": t["player_name"],
                    "resolved_player_name": "",
                    "franchise_id": "",
                    "status": "unresolved",
                    "confidence": 0.0,
                    "value": t["salary"],
                }
            )
            continue
        k = (str(resolved_row["franchise_id"]), str(resolved_row["player_id"]), str(resolved_row["status"]))
        manual_tag_overrides[k] = int(t["salary"])
        manual_resolution_rows.append(
            {
                "override_type": "tag",
                "input_name": t["player_name"],
                "resolved_player_name": resolved_row["player_name"],
                "franchise_id": resolved_row["franchise_id"],
                "status": "applied",
                "confidence": round(float(score), 4),
                "value": int(t["salary"]),
            }
        )

    for e in manual_overrides.get("extensions", []):
        resolved_row, score = resolve_roster_row_by_name(e["player_name"], name_index)
        if not resolved_row:
            manual_resolution_rows.append(
                {
                    "override_type": "extension",
                    "input_name": e["player_name"],
                    "resolved_player_name": "",
                    "franchise_id": "",
                    "status": "unresolved",
                    "confidence": 0.0,
                    "value": e["years"],
                }
            )
            continue
        k = (str(resolved_row["franchise_id"]), str(resolved_row["player_id"]), str(resolved_row["status"]))
        manual_ext_overrides[k] = int(e["years"])
        manual_resolution_rows.append(
            {
                "override_type": "extension",
                "input_name": e["player_name"],
                "resolved_player_name": resolved_row["player_name"],
                "franchise_id": resolved_row["franchise_id"],
                "status": "applied",
                "confidence": round(float(score), 4),
                "value": int(e["years"]),
            }
        )

    # Apply manual overrides first.
    for r in rollover_rows:
        key = (r["franchise_id"], r["player_id"], r["status_base"])
        if key in manual_tag_overrides:
            r["action"] = "manual_tag_keep"
            r["projected_pool_ind"] = 0
            r["tag_selected_ind"] = 1
            r["tag_eligible_ind"] = 1
            r["tag_salary"] = int(manual_tag_overrides[key])
            r["projected_salary_2026"] = int(manual_tag_overrides[key])
            r["projected_contract_year"] = 1
            continue
        if key in manual_ext_overrides:
            years = max(1, int(manual_ext_overrides[key]))
            ext_salary = max(
                float(args.rookie_extend_min_salary),
                float(r["salary_base"]) * float(args.rookie_extend_multiplier),
            )
            ext_salary = round_up_to_1000(ext_salary)
            r["action"] = "manual_extension_keep"
            r["projected_pool_ind"] = 0
            r["rookie_extend_selected_ind"] = 1
            r["rookie_extend_candidate_ind"] = 1
            r["rookie_extend_salary"] = ext_salary
            r["projected_salary_2026"] = ext_salary
            r["projected_contract_year"] = years

    # Remaining expiring rows (not manually kept) for automatic heuristics.
    expiring_rows = [
        r
        for r in rollover_rows
        if r["contract_year_base"] <= 1 and r["projected_pool_ind"] == 1
    ]

    # Preliminary market values (all remaining expiring in pool) for automatic decisions.
    pre_seg_weights = defaultdict(float)
    for r in expiring_rows:
        seg = "IDP" if is_idp_position(r["position"]) else "NON_IDP"
        w = adp_weight_inv_sqrt(r["normalized_adp"])
        pre_seg_weights[seg] += w

    idp_pool_dollars = float(projected_total_spend) * float(idp_ratio)
    non_idp_pool_dollars = float(projected_total_spend) - idp_pool_dollars

    for r in expiring_rows:
        seg = "IDP" if is_idp_position(r["position"]) else "NON_IDP"
        seg_pool = idp_pool_dollars if seg == "IDP" else non_idp_pool_dollars
        seg_weight = pre_seg_weights.get(seg, 0.0)
        w = adp_weight_inv_sqrt(r["normalized_adp"])
        est = seg_pool * (w / seg_weight) if seg_pool > 0 and seg_weight > 0 else 0.0
        r["estimated_market_value"] = round(est, 2)

    # Select likely tags: max one per side per franchise for remaining rows.
    tag_candidates_by_group = defaultdict(list)
    for r in expiring_rows:
        if r["tag_eligible_ind"] != 1:
            continue
        decision_adp = coerce_float(r.get("points_adp_proxy"))
        if decision_adp is None:
            decision_adp = coerce_float(r.get("normalized_adp")) or 400.0
        if float(decision_adp) > float(args.tag_max_adp):
            continue
        tag_salary = float(r["tag_salary"] or 0.0)
        if tag_salary <= 0:
            continue
        est_val = float(r["estimated_market_value"] or 0.0)
        if est_val < tag_salary * float(args.tag_min_value_multiple):
            continue
        surplus = est_val - tag_salary
        if surplus < float(args.tag_min_surplus):
            continue
        group = (r["franchise_id"], r["tag_side"] or "OFFENSE")
        tag_candidates_by_group[group].append((surplus, decision_adp, r))

    selected_tag_keys = set()
    for _group, items in tag_candidates_by_group.items():
        items.sort(key=lambda x: (-x[0], x[1]))
        best = items[0][2]
        selected_tag_keys.add((best["franchise_id"], best["player_id"], best["status_base"]))

    # Rookie extension assumptions for remaining expiring rookies.
    selected_rookie_ext_keys = set()
    for r in expiring_rows:
        key = (r["franchise_id"], r["player_id"], r["status_base"])
        if key in selected_tag_keys:
            continue
        if r["rookie_extend_candidate_ind"] != 1:
            continue
        decision_adp = coerce_float(r.get("points_adp_proxy"))
        if decision_adp is None:
            decision_adp = coerce_float(r.get("normalized_adp")) or 400.0
        if float(decision_adp) > float(args.rookie_extend_adp_cutoff):
            continue
        selected_rookie_ext_keys.add(key)

    # Apply automatic actions.
    for r in rollover_rows:
        key = (r["franchise_id"], r["player_id"], r["status_base"])
        if r["projected_pool_ind"] != 1:
            continue
        if key in selected_tag_keys:
            r["action"] = "tag_keep"
            r["tag_selected_ind"] = 1
            r["projected_pool_ind"] = 0
            r["projected_salary_2026"] = int(r["tag_salary"] or 0)
            r["projected_contract_year"] = 1
            continue
        if key in selected_rookie_ext_keys:
            ext_salary = max(
                float(args.rookie_extend_min_salary),
                float(r["salary_base"]) * float(args.rookie_extend_multiplier),
            )
            ext_salary = round_up_to_1000(ext_salary)
            r["action"] = "rookie_extend_keep"
            r["rookie_extend_selected_ind"] = 1
            r["rookie_extend_salary"] = ext_salary
            r["projected_pool_ind"] = 0
            r["projected_salary_2026"] = ext_salary
            r["projected_contract_year"] = 1
            continue
        r["action"] = "expiring_to_pool"
        r["projected_pool_ind"] = 1
        r["projected_salary_2026"] = 0
        r["projected_contract_year"] = 0

    # Spend calibration:
    # 1) baseline from recent auction spend,
    # 2) adjust upward to hit minimum league combined commitment floor while
    #    leaving room for salary adjustments + unused cap.
    retained_raw_commitment = sum(
        float(r["projected_salary_2026"] or 0.0)
        for r in rollover_rows
        if r["projected_pool_ind"] != 1
    )
    estimated_cut_bait_relief = retained_raw_commitment * float(cut_bait_rate)
    adjustment_leftover_reserve = max(0.0, float(args.adjustment_leftover_reserve))
    combined_floor_from_reserve = float(league_cap_total) - adjustment_leftover_reserve
    combined_commitment_floor = max(float(args.min_combined_commitment), float(combined_floor_from_reserve))
    spend_floor_from_combined = combined_commitment_floor - max(
        0.0,
        retained_raw_commitment - estimated_cut_bait_relief,
    )
    projected_total_spend = max(float(projected_total_spend), float(spend_floor_from_combined), 0.0)
    projected_total_spend = min(float(projected_total_spend), float(league_cap_total))

    idp_pool_dollars = float(projected_total_spend) * float(idp_ratio)
    non_idp_pool_dollars = float(projected_total_spend) - idp_pool_dollars

    # Refresh estimated market value on final spend level.
    final_expiring_rows = [r for r in rollover_rows if r["projected_pool_ind"] == 1]
    final_pre_seg_weights = defaultdict(float)
    for r in final_expiring_rows:
        seg = "IDP" if is_idp_position(r["position"]) else "NON_IDP"
        final_pre_seg_weights[seg] += adp_weight_inv_sqrt(r["normalized_adp"])
    for r in final_expiring_rows:
        seg = "IDP" if is_idp_position(r["position"]) else "NON_IDP"
        seg_pool = idp_pool_dollars if seg == "IDP" else non_idp_pool_dollars
        seg_weight = final_pre_seg_weights.get(seg, 0.0)
        w = adp_weight_inv_sqrt(r["normalized_adp"])
        est = seg_pool * (w / seg_weight) if seg_pool > 0 and seg_weight > 0 else 0.0
        r["estimated_market_value"] = round(est, 2)

    # Final projected auction pool value allocation.
    pool_rows = [r for r in rollover_rows if r["projected_pool_ind"] == 1]

    # ADP -> expected points calibration from scoring history.
    for r in rollover_rows:
        est = estimate_points_from_adp(
            normalized_adp=r.get("points_adp_proxy"),
            position=r["position"],
            group_index=points_group_index,
            min_samples=args.points_min_samples,
            knn=args.points_knn,
            season_end=points_history_end,
        )
        r["expected_reg_points"] = est["expected_reg_points"]
        r["expected_reg_ppg"] = est["expected_reg_ppg"]
        r["points_model_group"] = est["points_model_group"]
        r["points_model_samples"] = est["points_model_samples"]
        r["points_model_method"] = est["points_model_method"]

    seg_weights = defaultdict(float)
    for r in pool_rows:
        seg = "IDP" if is_idp_position(r["position"]) else "NON_IDP"
        w = adp_weight_inv_sqrt(r["normalized_adp"])
        seg_weights[seg] += w

    pool_value_rows = []
    for r in pool_rows:
        seg = "IDP" if is_idp_position(r["position"]) else "NON_IDP"
        seg_pool = idp_pool_dollars if seg == "IDP" else non_idp_pool_dollars
        seg_weight = seg_weights.get(seg, 0.0)
        w = adp_weight_inv_sqrt(r["normalized_adp"])
        val = seg_pool * (w / seg_weight) if seg_pool > 0 and seg_weight > 0 else 0.0
        exp_pts = coerce_float(r.get("expected_reg_points"))
        pts_per_1k = None
        if exp_pts is not None and val > 0:
            pts_per_1k = round(exp_pts / (float(val) / 1000.0), 3)
        row = {
            "projection_season": args.projection_season,
            "player_id": r["player_id"],
            "player_name": r["player_name"],
            "position": r["position"],
            "nfl_team": r["nfl_team"],
            "adp_segment": seg,
            "normalized_adp": r["normalized_adp"],
            "weight": w,
            "projected_perceived_value": round(val, 2),
            "projected_winning_bid": round(val, 2),
            "expected_reg_points": r.get("expected_reg_points"),
            "expected_reg_ppg": r.get("expected_reg_ppg"),
            "expected_points_per_1000_bid": pts_per_1k,
        }
        pool_value_rows.append(row)

    # Team cap projection.
    shares, share_team_names = get_team_auction_share(conn, args.base_season)
    fids = list(franchise_ids)
    if not shares:
        even = 1.0 / len(fids) if fids else 0.0
        shares = {fid: even for fid in fids}
    else:
        # Ensure all teams exist.
        missing = [fid for fid in fids if fid not in shares]
        rem = max(0.0, 1.0 - sum(shares.values()))
        fill = (rem / len(missing)) if missing else 0.0
        for fid in missing:
            shares[fid] = fill

    team_commit = defaultdict(float)
    team_retained = defaultdict(int)
    for r in rollover_rows:
        if r["projected_pool_ind"] == 1:
            continue
        team_commit[r["franchise_id"]] += float(r["projected_salary_2026"]) * float(r["cap_status_factor"])
        team_retained[r["franchise_id"]] += 1

    team_cap_rows = []
    for fid in fids:
        spend = float(projected_total_spend) * float(shares.get(fid, 0.0))
        retained_commit = round(team_commit.get(fid, 0.0), 2)
        before = round(float(cap) - retained_commit, 2)
        after = round(before - spend, 2)
        team_cap_rows.append(
            {
                "projection_season": args.projection_season,
                "franchise_id": fid,
                "team_name": share_team_names.get(fid) or next((x["team_name"] for x in roster if x["franchise_id"] == fid), None),
                "cap_start": cap,
                "retained_players": team_retained.get(fid, 0),
                "retained_cap_commitment": retained_commit,
                "projected_cap_space_before_auction": before,
                "projected_auction_spend": round(spend, 2),
                "projected_cap_space_after_auction": after,
            }
        )

    # Top-N summary on projected pool.
    pool_sorted = sorted(pool_value_rows, key=lambda x: (x["normalized_adp"], x["player_name"] or ""))
    sf_rows = [x for x in pool_sorted if str(x["position"] or "").upper() == "QB"]

    def topn_value(rows, n=None):
        use = rows if n is None else rows[:n]
        return len(use), round(sum(float(r["projected_perceived_value"] or 0.0) for r in use), 2)

    top5 = topn_value(pool_sorted, 5)
    top10 = topn_value(pool_sorted, 10)
    top25 = topn_value(pool_sorted, 25)
    top50 = topn_value(pool_sorted, 50)
    top100 = topn_value(pool_sorted, 100)
    allv = topn_value(pool_sorted, None)
    sfv = topn_value(sf_rows, None)

    # Persist ADP source rows.
    fetched_at = now_utc()
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT INTO early_projection_adp (
            projection_season, adp_source_season, requested_period, used_period,
            requested_keeper, used_keeper, fallback_used, fetched_at_utc, source_url,
            dataset_timestamp, total_drafts, total_picks, player_id, rank, average_pick,
            drafts_selected_in
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                args.projection_season,
                adp_payload["adp_source_season"],
                adp_payload["requested_period"],
                adp_payload["used_period"],
                adp_payload["requested_keeper"],
                adp_payload["used_keeper"],
                adp_payload["fallback_used"],
                fetched_at,
                adp_payload["meta"]["source_url"],
                adp_payload["meta"]["dataset_timestamp"],
                adp_payload["meta"]["total_drafts"],
                adp_payload["meta"]["total_picks"],
                r["player_id"],
                r["rank"],
                r["average_pick"],
                r["drafts_selected_in"],
            )
            for r in adp_rows
        ],
    )

    cur.executemany(
        """
        INSERT INTO early_projection_contract_rollover (
            projection_season, franchise_id, team_name, player_id, player_name, position, nfl_team,
            status_base, cap_status_factor, salary_base, contract_year_base, contract_status_base,
            contract_info_base,
            projected_contract_year, action, projected_salary_2026, tag_eligible_ind, tag_selected_ind,
            tag_side, tag_salary, rookie_extend_candidate_ind, rookie_extend_selected_ind, rookie_extend_salary,
            adp_source_season, average_pick, normalized_adp, adp_normalization_source, projected_pool_ind,
            estimated_market_value, expected_reg_points, expected_reg_ppg, points_model_group,
            points_model_samples, points_model_method, next_salary_method
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        [
            (
                r["projection_season"],
                r["franchise_id"],
                r["team_name"],
                r["player_id"],
                r["player_name"],
                r["position"],
                r["nfl_team"],
                r["status_base"],
                r["cap_status_factor"],
                r["salary_base"],
                r["contract_year_base"],
                r["contract_status_base"],
                r["contract_info_base"],
                r["projected_contract_year"],
                r["action"],
                r["projected_salary_2026"],
                r["tag_eligible_ind"],
                r["tag_selected_ind"],
                r["tag_side"],
                r["tag_salary"],
                r["rookie_extend_candidate_ind"],
                r["rookie_extend_selected_ind"],
                r["rookie_extend_salary"],
                r["adp_source_season"],
                r["average_pick"],
                r["normalized_adp"],
                r["adp_normalization_source"],
                r["projected_pool_ind"],
                r["estimated_market_value"],
                r["expected_reg_points"],
                r["expected_reg_ppg"],
                r["points_model_group"],
                r["points_model_samples"],
                r["points_model_method"],
                r["next_salary_method"],
            )
            for r in rollover_rows
        ],
    )

    cur.executemany(
        """
        INSERT INTO early_projection_auction_pool_values (
            projection_season, player_id, player_name, position, nfl_team, adp_segment,
            normalized_adp, weight, projected_perceived_value, projected_winning_bid,
            expected_reg_points, expected_reg_ppg, expected_points_per_1000_bid
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                r["projection_season"],
                r["player_id"],
                r["player_name"],
                r["position"],
                r["nfl_team"],
                r["adp_segment"],
                r["normalized_adp"],
                r["weight"],
                r["projected_perceived_value"],
                r["projected_winning_bid"],
                r["expected_reg_points"],
                r["expected_reg_ppg"],
                r["expected_points_per_1000_bid"],
            )
            for r in pool_value_rows
        ],
    )

    cur.executemany(
        """
        INSERT INTO early_projection_team_cap (
            projection_season, franchise_id, team_name, cap_start, retained_players,
            retained_cap_commitment, projected_cap_space_before_auction, projected_auction_spend,
            projected_cap_space_after_auction
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                r["projection_season"],
                r["franchise_id"],
                r["team_name"],
                r["cap_start"],
                r["retained_players"],
                r["retained_cap_commitment"],
                r["projected_cap_space_before_auction"],
                r["projected_auction_spend"],
                r["projected_cap_space_after_auction"],
            )
            for r in team_cap_rows
        ],
    )

    projected_tagged = sum(1 for r in rollover_rows if r["tag_selected_ind"] == 1)
    projected_rookie_ext = sum(1 for r in rollover_rows if r["rookie_extend_selected_ind"] == 1)
    manual_tags_applied = sum(1 for r in rollover_rows if r["action"] == "manual_tag_keep")
    manual_ext_applied = sum(1 for r in rollover_rows if r["action"] == "manual_extension_keep")
    manual_unresolved = sum(1 for r in manual_resolution_rows if r.get("status") == "unresolved")
    rollover_salary_updates = sum(
        1
        for r in rollover_rows
        if r["action"] == "retain_existing" and int(r["projected_salary_2026"] or 0) != int(r["salary_base"] or 0)
    )
    projected_combined_commitment = float(retained_raw_commitment) + float(projected_total_spend)
    projected_leftover_after_commitment = float(league_cap_total) - float(projected_combined_commitment)
    projected_combined_after_cut_relief = (
        float(retained_raw_commitment) - float(estimated_cut_bait_relief) + float(projected_total_spend)
    )
    projected_leftover_after_cut_relief = float(league_cap_total) - float(projected_combined_after_cut_relief)
    salary_adjustments_feed_effective = (
        coerce_float(salary_adjustments_feed_summary.get("effective_volume")) if salary_adjustments_feed_summary else None
    )
    salary_adjustments_feed_effective = (
        float(salary_adjustments_feed_effective) if salary_adjustments_feed_effective is not None else 0.0
    )
    cur.execute(
        """
        INSERT INTO early_projection_summary (
            projection_season, base_season, snapshot_week, adp_source_kind, adp_source_season,
            adp_used_period, adp_used_keeper, adp_players, projected_pool_players,
            projected_tagged_players, projected_rookie_extensions, projected_total_spend_baseline, projected_total_spend,
            projected_idp_spend, projected_non_idp_spend, projected_combined_commitment, projected_leftover_after_commitment,
            projected_combined_after_cut_relief, projected_leftover_after_cut_relief,
            combined_commitment_floor, adjustment_leftover_reserve, salary_adjustment_volume, estimated_cut_bait_relief,
            points_history_start_season, points_history_end_season, points_training_rows,
            notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            args.projection_season,
            args.base_season,
            snapshot_week,
            adp_source_kind,
            adp_payload["adp_source_season"],
            adp_payload["used_period"],
            adp_payload["used_keeper"],
            len(adp_rows),
            len(pool_value_rows),
            projected_tagged,
            projected_rookie_ext,
            round(float(projected_total_spend_baseline), 2),
            round(float(projected_total_spend), 2),
            round(idp_pool_dollars, 2),
            round(non_idp_pool_dollars, 2),
            round(projected_combined_commitment, 2),
            round(projected_leftover_after_commitment, 2),
            round(projected_combined_after_cut_relief, 2),
            round(projected_leftover_after_cut_relief, 2),
            round(float(combined_commitment_floor), 2),
            round(float(adjustment_leftover_reserve), 2),
            round(float(salary_adjustment_volume), 2),
            round(float(estimated_cut_bait_relief), 2),
            points_history_start,
            points_history_end,
            len(points_training_rows),
            (
                "Early projection model. Contract rollover from base season snapshot; "
                f"ADP source={adp_source_kind}; "
                "ADP weighting=1/sqrt(ADP); "
                f"spend_calibration baseline={round(float(projected_total_spend_baseline),2)} "
                f"floor={round(float(combined_commitment_floor),2)} "
                f"cut_bait_rate={round(float(cut_bait_rate),4)} "
                f"est_cut_relief={round(float(estimated_cut_bait_relief),2)} "
                f"salary_adjustments_feed_effective={round(float(salary_adjustments_feed_effective),2)} "
                f"salary_adjustment_volume={round(float(salary_adjustment_volume),2)} "
                f"reserve={round(float(adjustment_leftover_reserve),2)}; "
                "tag decisions from tag_tracking + ADP/surplus heuristic; "
                "rookie extensions from ADP cutoff heuristic; "
                f"ADP->points model from seasons {points_history_start}-{points_history_end} "
                f"(rows={len(points_training_rows)}); "
                f"manual overrides applied (tags={manual_tags_applied}, extensions={manual_ext_applied}, unresolved={manual_unresolved}); "
                f"rollover salary updates from contract_info={rollover_salary_updates}; "
                "Taxi cap=0, IR cap=50%."
            ),
        ),
    )

    cur.execute(
        """
        INSERT INTO early_projection_topn_summary (
            projection_season,
            top5_count, top5_value_sum,
            top10_count, top10_value_sum,
            top25_count, top25_value_sum,
            top50_count, top50_value_sum,
            top100_count, top100_value_sum,
            all_count, all_value_sum,
            sf_count, sf_value_sum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            args.projection_season,
            top5[0], top5[1],
            top10[0], top10[1],
            top25[0], top25[1],
            top50[0], top50[1],
            top100[0], top100[1],
            allv[0], allv[1],
            sfv[0], sfv[1],
        ),
    )
    conn.commit()

    # CSV outputs.
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    write_csv(
        LOG_DIR / "early_projection_2026_summary.csv",
        [
            {
                "projection_season": args.projection_season,
                "base_season": args.base_season,
                "snapshot_week": snapshot_week,
                "adp_source_kind": adp_source_kind,
                "adp_source_season": adp_payload["adp_source_season"],
                "adp_used_period": adp_payload["used_period"],
                "adp_used_keeper": adp_payload["used_keeper"],
                "adp_rows": len(adp_rows),
                "adp_source_url": adp_payload["meta"].get("source_url"),
                "sleeper_rows_parsed": adp_payload["meta"].get("parsed_rows"),
                "sleeper_rows_matched_to_roster": adp_payload["meta"].get("matched_rows"),
                "sleeper_rows_unmatched": adp_payload["meta"].get("unmatched_rows"),
                "projected_pool_players": len(pool_value_rows),
                "projected_tagged_players": projected_tagged,
                "projected_rookie_extensions": projected_rookie_ext,
                "projected_total_spend_baseline": round(float(projected_total_spend_baseline), 2),
                "projected_total_spend": round(float(projected_total_spend), 2),
                "projected_idp_spend": round(idp_pool_dollars, 2),
                "projected_non_idp_spend": round(non_idp_pool_dollars, 2),
                "retained_raw_commitment": round(float(retained_raw_commitment), 2),
                "projected_combined_commitment": round(float(projected_combined_commitment), 2),
                "projected_leftover_after_commitment": round(float(projected_leftover_after_commitment), 2),
                "projected_combined_after_cut_relief": round(float(projected_combined_after_cut_relief), 2),
                "projected_leftover_after_cut_relief": round(float(projected_leftover_after_cut_relief), 2),
                "combined_commitment_floor": round(float(combined_commitment_floor), 2),
                "spend_floor_from_combined": round(float(spend_floor_from_combined), 2),
                "adjustment_leftover_reserve": round(float(adjustment_leftover_reserve), 2),
                "salary_adjustment_volume": round(float(salary_adjustment_volume), 2),
                "cut_bait_rate": round(float(cut_bait_rate), 6),
                "estimated_cut_bait_relief": round(float(estimated_cut_bait_relief), 2),
                "salary_adjustments_feed_url": args.salary_adjustments_url,
                "salary_adjustments_feed_rows_total": salary_adjustments_feed_summary.get("rows_total"),
                "salary_adjustments_feed_rows_real_amount": salary_adjustments_feed_summary.get("rows_real_amount"),
                "salary_adjustments_feed_rows_marker_amount": salary_adjustments_feed_summary.get("rows_marker_amount"),
                "salary_adjustments_feed_marker_drop_salary_total": salary_adjustments_feed_summary.get("marker_drop_salary_total"),
                "salary_adjustments_feed_trade_transfer_volume": salary_adjustments_feed_summary.get("trade_transfer_volume"),
                "salary_adjustments_feed_cap_penalty_total": salary_adjustments_feed_summary.get("cap_penalty_total"),
                "salary_adjustments_feed_other_abs_total": salary_adjustments_feed_summary.get("other_abs_total"),
                "salary_adjustments_feed_effective_volume": salary_adjustments_feed_summary.get("effective_volume"),
                "salary_adjustments_feed_error": salary_adjustments_feed_error,
                "points_history_start_season": points_history_start,
                "points_history_end_season": points_history_end,
                "points_training_rows": len(points_training_rows),
                "qb_superflex_scale_factor": round(qb_sf_factor, 6),
                "recent_spend_values": ",".join(str(int(v)) for v in recent_spend_vals) if recent_spend_vals else "",
                "recent_idp_ratios": ",".join(f"{x:.4f}" for x in recent_idp_ratios) if recent_idp_ratios else "",
                "recent_salary_adjustment_values": ",".join(str(int(v)) for v in recent_salary_adjustment_vals) if recent_salary_adjustment_vals else "",
                "recent_cut_bait_rates": ",".join(f"{x:.4f}" for x in recent_cut_bait_rates) if recent_cut_bait_rates else "",
                "tag_tracking_path": tag_meta.get("path"),
                "tag_tracking_rows_loaded": tag_meta.get("loaded"),
                "tag_exclusions_path": tag_excl_meta.get("path"),
                "tag_exclusions_loaded": tag_excl_meta.get("loaded"),
                "manual_overrides_path": manual_meta.get("path"),
                "manual_overrides_loaded": manual_meta.get("loaded"),
                "manual_tags_applied": manual_tags_applied,
                "manual_extensions_applied": manual_ext_applied,
                "manual_overrides_unresolved": manual_unresolved,
                "rollover_salary_updates": rollover_salary_updates,
            }
        ],
        [
            "projection_season",
            "base_season",
            "snapshot_week",
            "adp_source_kind",
            "adp_source_season",
            "adp_used_period",
            "adp_used_keeper",
            "adp_rows",
            "adp_source_url",
            "sleeper_rows_parsed",
            "sleeper_rows_matched_to_roster",
            "sleeper_rows_unmatched",
            "projected_pool_players",
            "projected_tagged_players",
            "projected_rookie_extensions",
            "projected_total_spend_baseline",
            "projected_total_spend",
            "projected_idp_spend",
            "projected_non_idp_spend",
            "retained_raw_commitment",
            "projected_combined_commitment",
            "projected_leftover_after_commitment",
            "projected_combined_after_cut_relief",
            "projected_leftover_after_cut_relief",
            "combined_commitment_floor",
            "spend_floor_from_combined",
            "adjustment_leftover_reserve",
            "salary_adjustment_volume",
            "cut_bait_rate",
            "estimated_cut_bait_relief",
            "salary_adjustments_feed_url",
            "salary_adjustments_feed_rows_total",
            "salary_adjustments_feed_rows_real_amount",
            "salary_adjustments_feed_rows_marker_amount",
            "salary_adjustments_feed_marker_drop_salary_total",
            "salary_adjustments_feed_trade_transfer_volume",
            "salary_adjustments_feed_cap_penalty_total",
            "salary_adjustments_feed_other_abs_total",
            "salary_adjustments_feed_effective_volume",
            "salary_adjustments_feed_error",
            "points_history_start_season",
            "points_history_end_season",
            "points_training_rows",
            "qb_superflex_scale_factor",
            "recent_spend_values",
            "recent_idp_ratios",
            "recent_salary_adjustment_values",
            "recent_cut_bait_rates",
            "tag_tracking_path",
            "tag_tracking_rows_loaded",
            "tag_exclusions_path",
            "tag_exclusions_loaded",
            "manual_overrides_path",
            "manual_overrides_loaded",
            "manual_tags_applied",
            "manual_extensions_applied",
            "manual_overrides_unresolved",
            "rollover_salary_updates",
        ],
    )

    write_csv(
        LOG_DIR / "early_projection_2026_contract_rollover.csv",
        rollover_rows,
        [
            "projection_season",
            "franchise_id",
            "team_name",
            "player_id",
            "player_name",
            "position",
            "nfl_team",
            "status_base",
            "cap_status_factor",
            "salary_base",
            "contract_year_base",
            "contract_status_base",
            "contract_info_base",
            "projected_contract_year",
            "action",
            "projected_salary_2026",
            "tag_eligible_ind",
            "tag_selected_ind",
            "tag_side",
            "tag_salary",
            "rookie_extend_candidate_ind",
            "rookie_extend_selected_ind",
            "rookie_extend_salary",
            "adp_source_season",
            "average_pick",
            "normalized_adp",
            "points_adp_proxy",
            "adp_normalization_source",
            "projected_pool_ind",
            "estimated_market_value",
            "expected_reg_points",
            "expected_reg_ppg",
            "points_model_group",
            "points_model_samples",
            "points_model_method",
            "next_salary_method",
        ],
    )

    write_csv(
        LOG_DIR / "early_projection_2026_manual_override_resolution.csv",
        manual_resolution_rows,
        [
            "override_type",
            "input_name",
            "resolved_player_name",
            "franchise_id",
            "status",
            "confidence",
            "value",
        ],
    )

    write_csv(
        LOG_DIR / "early_projection_2026_sleeper_adp_resolution.csv",
        sleeper_resolution_rows,
        [
            "input_name",
            "input_position",
            "input_team",
            "sleeper_slot",
            "average_pick",
            "resolved_player_name",
            "resolved_player_id",
            "status",
            "confidence",
        ],
    )

    write_csv(
        LOG_DIR / "early_projection_2026_auction_pool_values.csv",
        pool_value_rows,
        [
            "projection_season",
            "player_id",
            "player_name",
            "position",
            "nfl_team",
            "adp_segment",
            "normalized_adp",
            "weight",
            "projected_perceived_value",
            "projected_winning_bid",
            "expected_reg_points",
            "expected_reg_ppg",
            "expected_points_per_1000_bid",
        ],
    )

    pool_by_pid = {str(r["player_id"]): r for r in pool_value_rows}
    expected_points_rows = []
    for r in rollover_rows:
        pool_rec = pool_by_pid.get(str(r["player_id"]))
        expected_points_rows.append(
            {
                "projection_season": r["projection_season"],
                "franchise_id": r["franchise_id"],
                "team_name": r["team_name"],
                "player_id": r["player_id"],
                "player_name": r["player_name"],
                "position": r["position"],
                "nfl_team": r["nfl_team"],
                "normalized_adp": r["normalized_adp"],
                "points_adp_proxy": r.get("points_adp_proxy"),
                "expected_reg_points": r["expected_reg_points"],
                "expected_reg_ppg": r["expected_reg_ppg"],
                "action": r["action"],
                "projected_pool_ind": r["projected_pool_ind"],
                "projected_salary_2026": r["projected_salary_2026"],
                "projected_perceived_value": pool_rec.get("projected_perceived_value") if pool_rec else 0,
                "expected_points_per_1000_bid": pool_rec.get("expected_points_per_1000_bid") if pool_rec else None,
                "points_model_group": r["points_model_group"],
                "points_model_samples": r["points_model_samples"],
                "points_model_method": r["points_model_method"],
            }
        )

    expected_points_rows.sort(
        key=lambda x: (
            -(coerce_float(x.get("expected_reg_points")) or 0.0),
            coerce_float(x.get("normalized_adp")) or 999999.0,
            x.get("player_name") or "",
        )
    )

    write_csv(
        LOG_DIR / "early_projection_2026_expected_points.csv",
        expected_points_rows,
        [
            "projection_season",
            "franchise_id",
            "team_name",
            "player_id",
            "player_name",
            "position",
            "nfl_team",
            "normalized_adp",
            "points_adp_proxy",
            "expected_reg_points",
            "expected_reg_ppg",
            "action",
            "projected_pool_ind",
            "projected_salary_2026",
            "projected_perceived_value",
            "expected_points_per_1000_bid",
            "points_model_group",
            "points_model_samples",
            "points_model_method",
        ],
    )

    write_csv(
        LOG_DIR / "early_projection_2026_team_cap.csv",
        team_cap_rows,
        [
            "projection_season",
            "franchise_id",
            "team_name",
            "cap_start",
            "retained_players",
            "retained_cap_commitment",
            "projected_cap_space_before_auction",
            "projected_auction_spend",
            "projected_cap_space_after_auction",
        ],
    )

    write_csv(
        LOG_DIR / "early_projection_2026_topn.csv",
        [
            {
                "projection_season": args.projection_season,
                "top5_count": top5[0],
                "top5_value_sum": top5[1],
                "top10_count": top10[0],
                "top10_value_sum": top10[1],
                "top25_count": top25[0],
                "top25_value_sum": top25[1],
                "top50_count": top50[0],
                "top50_value_sum": top50[1],
                "top100_count": top100[0],
                "top100_value_sum": top100[1],
                "all_count": allv[0],
                "all_value_sum": allv[1],
                "sf_count": sfv[0],
                "sf_value_sum": sfv[1],
            }
        ],
        [
            "projection_season",
            "top5_count",
            "top5_value_sum",
            "top10_count",
            "top10_value_sum",
            "top25_count",
            "top25_value_sum",
            "top50_count",
            "top50_value_sum",
            "top100_count",
            "top100_value_sum",
            "all_count",
            "all_value_sum",
            "sf_count",
            "sf_value_sum",
        ],
    )

    conn.close()

    print(f"Projection season: {args.projection_season}")
    print(f"Base season snapshot: {args.base_season} week {snapshot_week}")
    print(
        "ADP source: "
        f"{adp_source_kind} "
        f"season {adp_payload['adp_source_season']} "
        f"period {adp_payload['used_period']} "
        f"IS_KEEPER='{adp_payload['used_keeper']}' "
        f"rows={len(adp_rows)} "
        f"fallback={adp_payload['fallback_used']}"
    )
    print(
        "Outputs: "
        "etl/logs/early_projection_2026_summary.csv, "
        "etl/logs/early_projection_2026_contract_rollover.csv, "
        "etl/logs/early_projection_2026_auction_pool_values.csv, "
        "etl/logs/early_projection_2026_expected_points.csv, "
        "etl/logs/early_projection_2026_team_cap.csv, "
        "etl/logs/early_projection_2026_topn.csv, "
        "etl/logs/early_projection_2026_manual_override_resolution.csv, "
        "etl/logs/early_projection_2026_sleeper_adp_resolution.csv"
    )
    print(
        f"Manual overrides: tags_applied={manual_tags_applied}, "
        f"extensions_applied={manual_ext_applied}, unresolved={manual_unresolved}"
    )
    print(
        "Spend calibration: "
        f"baseline={round(float(projected_total_spend_baseline),2)} "
        f"final={round(float(projected_total_spend),2)} "
        f"retained_raw={round(float(retained_raw_commitment),2)} "
        f"combined_raw={round(float(projected_combined_commitment),2)} "
        f"combined_after_cut_relief={round(float(projected_combined_after_cut_relief),2)} "
        f"floor={round(float(combined_commitment_floor),2)} "
        f"leftover_raw={round(float(projected_leftover_after_commitment),2)} "
        f"leftover_after_cut_relief={round(float(projected_leftover_after_cut_relief),2)} "
        f"cut_bait_rate={round(float(cut_bait_rate),4)} "
        f"est_cut_relief={round(float(estimated_cut_bait_relief),2)} "
        f"salary_adjustments_feed_effective={round(float(salary_adjustments_feed_effective),2)} "
        f"salary_adjustment_volume={round(float(salary_adjustment_volume),2)}"
    )
    print(f"Rollover salary updates from contract_info: {rollover_salary_updates}")


if __name__ == "__main__":
    main()
