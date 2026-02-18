#!/usr/bin/env python3
"""Build static standings snapshot JSON for standalone HPM rendering."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, List


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_OUT = ROOT_DIR / "site" / "standings" / "standings_25625_2026.json"
API_BASE = "https://api.myfantasyleague.com"


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        return int(float(safe_str(v)))
    except Exception:
        return default


def safe_float(v: Any, default: float = 0.0) -> float:
    try:
        return float(safe_str(v))
    except Exception:
        return default


def pad4(v: Any) -> str:
    d = "".join(ch for ch in safe_str(v) if ch.isdigit())
    if not d:
        return ""
    return d.zfill(4)[-4:]


def as_list(v: Any) -> List[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def pct_from_wlt(w: int, l: int, t: int) -> float:
    games = max(0, w + l + t)
    if games <= 0:
        return 0.0
    return (w + 0.5 * t) / float(games)


def fetch_json(year: int, league_id: str, type_name: str) -> Dict[str, Any]:
    qs = urllib.parse.urlencode({"TYPE": type_name, "L": league_id, "JSON": "1"})
    url = f"{API_BASE}/{year}/export?{qs}"
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_wlt(text: str) -> Dict[str, int]:
    raw = safe_str(text)
    parts = raw.replace("/", "-").split("-")
    if len(parts) < 2:
        return {"w": 0, "l": 0, "t": 0}
    w = safe_int(parts[0], 0)
    l = safe_int(parts[1], 0)
    t = safe_int(parts[2], 0) if len(parts) > 2 else 0
    return {"w": w, "l": l, "t": t}


def add_h2h_record(h2h: Dict[str, Dict[str, Dict[str, float]]], team_id: str, opp_id: str, w: int, l: int, t: int) -> None:
    if not team_id or not opp_id:
        return
    if team_id not in h2h:
        h2h[team_id] = {}
    if opp_id not in h2h[team_id]:
        h2h[team_id][opp_id] = {"w": 0, "l": 0, "t": 0, "games": 0, "pct": 0.0}
    rec = h2h[team_id][opp_id]
    rec["w"] = safe_int(rec.get("w")) + w
    rec["l"] = safe_int(rec.get("l")) + l
    rec["t"] = safe_int(rec.get("t")) + t
    rec["games"] = safe_int(rec.get("games")) + 1
    rec["pct"] = pct_from_wlt(safe_int(rec.get("w")), safe_int(rec.get("l")), safe_int(rec.get("t")))


def build_h2h_from_schedule(schedule_payload: Dict[str, Any]) -> Dict[str, Dict[str, Dict[str, float]]]:
    h2h: Dict[str, Dict[str, Dict[str, float]]] = {}
    weekly = as_list((schedule_payload.get("schedule") or {}).get("weeklySchedule"))
    for week in weekly:
        for matchup in as_list((week or {}).get("matchup")):
            franchises = as_list((matchup or {}).get("franchise"))
            if len(franchises) != 2:
                continue
            a, b = franchises[0], franchises[1]
            aid = pad4((a or {}).get("id"))
            bid = pad4((b or {}).get("id"))
            if not aid or not bid:
                continue
            a_score = safe_float((a or {}).get("score"), 0.0)
            b_score = safe_float((b or {}).get("score"), 0.0)
            played = (a_score > 0.0) or (b_score > 0.0)
            if not played:
                continue
            if a_score > b_score:
                add_h2h_record(h2h, aid, bid, 1, 0, 0)
                add_h2h_record(h2h, bid, aid, 0, 1, 0)
            elif a_score < b_score:
                add_h2h_record(h2h, aid, bid, 0, 1, 0)
                add_h2h_record(h2h, bid, aid, 1, 0, 0)
            else:
                add_h2h_record(h2h, aid, bid, 0, 0, 1)
                add_h2h_record(h2h, bid, aid, 0, 0, 1)
    return h2h


def build_weekly_payloads(schedule_payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    weekly_scores: Dict[str, Dict[str, float]] = {}
    weekly_matchups: Dict[str, List[Dict[str, Any]]] = {}

    weekly = as_list((schedule_payload.get("schedule") or {}).get("weeklySchedule"))
    for idx, week in enumerate(weekly, start=1):
        week_no = safe_int((week or {}).get("week"), idx)
        week_key = str(week_no)
        weekly_scores.setdefault(week_key, {})
        weekly_matchups.setdefault(week_key, [])

        for matchup in as_list((week or {}).get("matchup")):
            franchises = as_list((matchup or {}).get("franchise"))
            if len(franchises) != 2:
                continue

            home = franchises[0] or {}
            away = franchises[1] or {}

            home_id = pad4(home.get("id"))
            away_id = pad4(away.get("id"))
            if not home_id or not away_id:
                continue

            home_score = safe_float(home.get("score"), 0.0)
            away_score = safe_float(away.get("score"), 0.0)

            weekly_scores[week_key][home_id] = home_score
            weekly_scores[week_key][away_id] = away_score
            weekly_matchups[week_key].append(
                {
                    "home": home_id,
                    "away": away_id,
                    "homeScore": home_score,
                    "awayScore": away_score,
                }
            )

    return {"weeklyScores": weekly_scores, "weeklyMatchups": weekly_matchups}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--league-id", default="25625")
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--out", default=str(DEFAULT_OUT))
    args = parser.parse_args()

    standings_payload = fetch_json(args.season, args.league_id, "leagueStandings")
    league_payload = fetch_json(args.season, args.league_id, "league")
    schedule_payload = fetch_json(args.season, args.league_id, "schedule")

    standings_rows = as_list((standings_payload.get("leagueStandings") or {}).get("franchise"))
    league = league_payload.get("league") or {}
    league_rows = as_list(((league.get("franchises") or {}).get("franchise")))
    division_rows = as_list(((league.get("divisions") or {}).get("division")))

    division_names = {}
    for d in division_rows:
        did = safe_str((d or {}).get("id"))
        if not did:
            continue
        division_names[did] = safe_str((d or {}).get("name")) or f"Division {did}"

    franchise_meta = {}
    for r in league_rows:
        fid = pad4((r or {}).get("id"))
        if not fid:
            continue
        division_id = safe_str((r or {}).get("division"))
        franchise_meta[fid] = {
            "name": safe_str((r or {}).get("name")) or fid,
            "icon": safe_str((r or {}).get("icon")),
            "logo": safe_str((r or {}).get("logo")),
            "division": division_id,
            "division_name": division_names.get(division_id) or f"Division {division_id or '?'}",
        }

    h2h_map = build_h2h_from_schedule(schedule_payload)
    weekly_payloads = build_weekly_payloads(schedule_payload)

    rows: List[Dict[str, Any]] = []
    for r in standings_rows:
        fid = pad4((r or {}).get("id"))
        ap = parse_wlt((r or {}).get("all_play_wlt"))
        meta = franchise_meta.get(fid, {})
        overall_w = safe_int((r or {}).get("h2hw"), 0)
        overall_l = safe_int((r or {}).get("h2hl"), 0)
        overall_t = 0
        div_w = safe_int((r or {}).get("divw"), 0)
        div_l = safe_int((r or {}).get("divl"), 0)
        div_t = 0
        rows.append(
            {
                "franchise_id": fid,
                "franchise_name": safe_str(meta.get("name")) or fid,
                "icon": safe_str(meta.get("icon")),
                "logo": safe_str(meta.get("logo")),
                "division": safe_str(meta.get("division")),
                "division_name": safe_str(meta.get("division_name")),
                "all_play": ap,
                "all_play_pct": safe_float((r or {}).get("all_play_pct")),
                "overall": {"w": overall_w, "l": overall_l, "t": overall_t},
                "overall_pct": safe_float((r or {}).get("h2hpct")),
                "divisional": {"w": div_w, "l": div_l, "t": div_t},
                "divisional_pct": safe_float((r or {}).get("divpct")),
                "points_for": safe_float((r or {}).get("pf")),
                "off_points": safe_float((r or {}).get("op")),
                "def_points": safe_float((r or {}).get("dp")),
                "potential_points": safe_float((r or {}).get("pp")),
                "efficiency": safe_float((r or {}).get("eff")),
                "h2h": h2h_map.get(fid, {}),
            }
        )

    rows.sort(
        key=lambda x: (
            -safe_float(x.get("overall_pct")),
            -safe_float(x.get("divisional_pct")),
            -safe_float(x.get("points_for")),
            x.get("franchise_name", ""),
        )
    )

    out = {
        "meta": {
            "league_id": safe_str(args.league_id),
            "season": int(args.season),
            "generated_at_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
            "source": "mfl_export",
        },
        "rows": rows,
        "weeklyScores": weekly_payloads["weeklyScores"],
        "weeklyMatchups": weekly_payloads["weeklyMatchups"],
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {out_path} ({len(rows)} rows)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
