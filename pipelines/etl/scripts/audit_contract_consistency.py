#!/usr/bin/env python3
"""
Audit internal consistency of every rostered player's contractInfo for a given season.

What this checks (self-contained — does not need prior-year data):
  1. TCV stated == sum(year salaries)                      -> TCV_MATH
  2. CL stated == count(year salaries)                     -> CL_COUNT
  3. For CONTRACTS WITH Ext (extended): canonical AAV
     (last value in the AAV list) must equal the LAST year
     salary in the year breakdown                          -> AAV_EXT_MISMATCH
     (Per RULE-EXT-001: extensions raise AAV by +$10K for
     offense / +$5K for kickers / +$3K for PN; the extended
     year(s) salary should equal the new AAV.)
  4. For rookie/auction contracts (no Ext, no front/back-
     load): AAV * CL should approximately equal TCV        -> AAV_TCV_RATIO
  5. Warn if >1 AAV value is stored but years don't vary   -> MULTI_AAV_FLAT_YEARS

Output: writes results to table `player_contract_audit` and emits a CSV to
`reports/contract_audit_<season>.csv` for review.

Usage:
  python3 audit_contract_consistency.py --season 2026
  python3 audit_contract_consistency.py --season 2026 --db-path /path/to.db
  python3 audit_contract_consistency.py --season 2025  # audit end-of-season snapshot
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = os.environ.get(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
)


def safe_str(x) -> str:
    return "" if x is None else str(x).strip()


def safe_int(x, default: int = 0) -> int:
    try:
        return int(float(str(x).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def parse_money_token(token: str) -> int:
    t = safe_str(token).upper().replace("$", "").replace(",", "")
    if not t:
        return 0
    t = re.sub(r"[^0-9K.\-]", "", t)
    if not t:
        return 0
    mult = 1000 if "K" in t else 1
    t = t.replace("K", "")
    if not t:
        return 0
    try:
        val = float(t)
    except ValueError:
        return 0
    out = int(round(val * mult))
    if mult == 1 and 0 < out < 1000:
        out *= 1000
    return out


def parse_contract_info(s: str) -> dict:
    """Extract CL, TCV, AAV values, year salaries, extensions, GTD from the string."""
    txt = safe_str(s)
    out = {
        "raw": txt,
        "cl": None,
        "tcv": None,
        "aav_values": [],
        "aav_canonical": None,
        "year_values": [],
        "extensions": [],
        "gtd": None,
    }
    if not txt:
        return out

    m = re.search(r"(?:^|[|\s])CL\s+(\d+)", txt, re.IGNORECASE)
    if m:
        out["cl"] = safe_int(m.group(1))

    m = re.search(r"(?:^|[|\s])TCV\s+([0-9.]+K?)", txt, re.IGNORECASE)
    if m:
        out["tcv"] = parse_money_token(m.group(1))

    # AAV: everything after "AAV " up to next "|" (may contain comma-separated values)
    m = re.search(r"(?:^|\|)\s*AAV\s+([^|]+)", txt, re.IGNORECASE)
    if m:
        raw_aav = m.group(1)
        tokens = [t for t in re.split(r"[,/]", raw_aav) if t.strip()]
        out["aav_values"] = [parse_money_token(t) for t in tokens if parse_money_token(t) > 0]
        if out["aav_values"]:
            out["aav_canonical"] = out["aav_values"][-1]

    # Year salaries: "Y1-2K, Y2-12K" or "Y1-2 Y2-12" (space or comma separated, K optional)
    year_matches = re.findall(r"Y(\d+)\s*[-:]\s*([0-9.]+K?)", txt, re.IGNORECASE)
    out["year_values"] = [
        {"year": safe_int(y), "salary": parse_money_token(v)}
        for y, v in year_matches
        if parse_money_token(v) > 0
    ]

    # Extensions: "Ext: Team1, Team2, ..."
    m = re.search(r"(?:^|\|)\s*Ext\s*:\s*([^|]+)", txt, re.IGNORECASE)
    if m:
        raw_ext = m.group(1)
        out["extensions"] = [t.strip() for t in re.split(r"[,/]", raw_ext) if t.strip()]

    # GTD
    m = re.search(r"(?:^|\|)\s*GTD\s*:?\s*([0-9.]+K?)", txt, re.IGNORECASE)
    if m:
        out["gtd"] = parse_money_token(m.group(1))

    return out


def audit_row(row: dict) -> dict:
    """Run consistency checks on one player row and return issues."""
    parsed = parse_contract_info(row.get("contract_info", ""))
    issues = []
    warnings = []

    cl = parsed["cl"]
    tcv = parsed["tcv"]
    aav_vals = parsed["aav_values"]
    aav_canonical = parsed["aav_canonical"]
    year_vals = parsed["year_values"]
    exts = parsed["extensions"]

    salary_sum = sum(y["salary"] for y in year_vals) if year_vals else 0
    year_count = len(year_vals)

    # Check 1: TCV math
    if tcv and year_count > 0 and salary_sum != tcv:
        issues.append({
            "code": "TCV_MATH",
            "detail": f"TCV {tcv} != sum of year salaries {salary_sum} "
                      f"({', '.join(str(y['salary']) for y in year_vals)})",
        })

    # Check 2: CL vs year count
    if cl and year_count > 0 and cl != year_count:
        issues.append({
            "code": "CL_COUNT",
            "detail": f"CL {cl} != count of year tokens {year_count}",
        })

    # Check 3: Extended contract → canonical AAV should match LAST year salary
    if exts and aav_canonical and year_vals:
        last_year_salary = year_vals[-1]["salary"]
        if aav_canonical != last_year_salary:
            issues.append({
                "code": "AAV_EXT_MISMATCH",
                "detail": f"Extended contract: canonical AAV {aav_canonical} != "
                          f"last year salary {last_year_salary}",
                "fix_hint": f"AAV should be {last_year_salary}",
            })

    # Check 4: Non-extended, non-varying-year: AAV * CL ≈ TCV
    if not exts and aav_canonical and cl and tcv and len(set(y["salary"] for y in year_vals)) <= 1:
        expected_tcv = aav_canonical * cl
        if abs(expected_tcv - tcv) > 1000:  # allow $1K rounding tolerance
            issues.append({
                "code": "AAV_TCV_RATIO",
                "detail": f"Non-extended contract: AAV {aav_canonical} × CL {cl} = "
                          f"{expected_tcv} != TCV {tcv}",
            })

    # Check 5: Multiple AAV values but flat year salaries
    if len(aav_vals) > 1 and year_vals and len(set(y["salary"] for y in year_vals)) == 1:
        warnings.append({
            "code": "MULTI_AAV_FLAT_YEARS",
            "detail": f"Multiple AAV values {aav_vals} but year salaries are flat",
        })

    # Build recommended fix for the most common issue (AAV_EXT_MISMATCH):
    recommendation = None
    if any(i["code"] == "AAV_EXT_MISMATCH" for i in issues) and year_vals and cl and exts:
        last_year_salary = year_vals[-1]["salary"]
        format_k = lambda v: f"{v // 1000}K" if v % 1000 == 0 else f"{v/1000:.1f}K"
        year_breakdown = ", ".join(f"Y{y['year']}-{format_k(y['salary'])}" for y in year_vals)
        rec_parts = [
            f"CL {cl}",
            f"TCV {format_k(salary_sum if salary_sum else tcv)}",
            f"AAV {format_k(last_year_salary)}",
            year_breakdown,
        ]
        if exts:
            rec_parts.append(f"Ext: {', '.join(exts)}")
        if parsed["gtd"]:
            rec_parts.append(f"GTD: {format_k(parsed['gtd'])}")
        recommendation = "| ".join(rec_parts)

    return {
        "player_id": row.get("player_id"),
        "player_name": row.get("player_name"),
        "position": row.get("position"),
        "franchise_id": row.get("franchise_id"),
        "team_name": row.get("team_name"),
        "salary": row.get("salary"),
        "contract_year": row.get("contract_year"),
        "contract_info_raw": row.get("contract_info"),
        "parsed": parsed,
        "salary_sum": salary_sum,
        "issues": issues,
        "warnings": warnings,
        "has_issues": bool(issues),
        "recommendation_contract_info": recommendation,
    }


def ensure_audit_table(conn: sqlite3.Connection) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS player_contract_audit (
            season INTEGER NOT NULL,
            week INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            audit_ts TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            franchise_id TEXT,
            team_name TEXT,
            contract_info_raw TEXT,
            contract_info_parsed_json TEXT,
            issues_json TEXT,
            warnings_json TEXT,
            has_issues INTEGER,
            issue_codes TEXT,
            recommendation_contract_info TEXT,
            confirmed_status TEXT DEFAULT 'pending',
            confirmed_ts TEXT,
            confirmed_by TEXT,
            fix_applied_2025 INTEGER DEFAULT 0,
            fix_applied_2026 INTEGER DEFAULT 0,
            notes TEXT,
            PRIMARY KEY (season, week, player_id, audit_ts)
        )
    """)
    conn.commit()


def audit_season(conn: sqlite3.Connection, season: int, week: int | None = None) -> list[dict]:
    # Pick the latest week if not specified
    if week is None:
        row = conn.execute(
            "SELECT MAX(week) FROM rosters_current WHERE season = ?", (season,)
        ).fetchone()
        week = row[0] if row else None
    if week is None:
        raise ValueError(f"No rosters_current rows for season {season}")

    # Enrich with player + franchise names via JOIN. We intentionally
    # re-join names every audit run so renamed teams get fresh labels.
    query = """
        SELECT rc.season, rc.week, rc.player_id,
               COALESCE(p.name, rc.player_name) AS player_name,
               COALESCE(p.position, rc.position) AS position,
               COALESCE(p.nfl_team, rc.nfl_team) AS nfl_team,
               rc.franchise_id,
               COALESCE(f.team_name, rc.team_name) AS team_name,
               rc.salary, rc.contract_year, rc.contract_status,
               rc.contract_info, rc.status,
               rc.contract_length, rc.tcv, rc.aav
        FROM rosters_current rc
        LEFT JOIN players p ON p.player_id = rc.player_id
             AND p.season = (SELECT MAX(season) FROM players WHERE player_id = rc.player_id)
        LEFT JOIN franchises f ON f.franchise_id = rc.franchise_id
             AND f.season = (SELECT MAX(season) FROM franchises)
        WHERE rc.season = ? AND rc.week = ?
          AND (rc.status IS NULL OR rc.status IN ('ROSTER','TAXI_SQUAD','INJURED_RESERVE',''))
          AND COALESCE(rc.contract_info, '') != ''
        ORDER BY f.team_name, COALESCE(p.position, rc.position), COALESCE(p.name, rc.player_name)
    """
    cur = conn.execute(query, (season, week))
    cols = [c[0] for c in cur.description]
    dicts = [dict(zip(cols, r)) for r in cur.fetchall()]

    audit_ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    results = []
    for r in dicts:
        result = audit_row(r)
        result["season"] = season
        result["week"] = week
        result["audit_ts"] = audit_ts
        results.append(result)
    return results


def persist_audit(conn: sqlite3.Connection, results: list[dict]) -> None:
    ensure_audit_table(conn)
    rows = []
    for r in results:
        rows.append((
            r["season"], r["week"], r["player_id"], r["audit_ts"],
            r.get("player_name"), r.get("position"),
            r.get("franchise_id"), r.get("team_name"),
            r.get("contract_info_raw"),
            json.dumps(r["parsed"]),
            json.dumps(r["issues"]),
            json.dumps(r["warnings"]),
            1 if r["has_issues"] else 0,
            ",".join(sorted({i["code"] for i in r["issues"]})),
            r.get("recommendation_contract_info"),
        ))
    conn.executemany("""
        INSERT OR REPLACE INTO player_contract_audit (
            season, week, player_id, audit_ts, player_name, position,
            franchise_id, team_name, contract_info_raw,
            contract_info_parsed_json, issues_json, warnings_json,
            has_issues, issue_codes, recommendation_contract_info
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()


def write_csv(results: list[dict], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "season", "week", "franchise_id", "team_name", "player_id",
            "player_name", "position", "salary", "contract_year",
            "contract_info_raw", "issue_codes", "issues",
            "recommendation_contract_info",
        ])
        for r in sorted(results, key=lambda x: (not x["has_issues"], x.get("team_name") or "", x.get("player_name") or "")):
            w.writerow([
                r["season"], r["week"], r.get("franchise_id"), r.get("team_name"),
                r["player_id"], r.get("player_name"), r.get("position"),
                r.get("salary"), r.get("contract_year"),
                r.get("contract_info_raw"),
                ",".join(sorted({i["code"] for i in r["issues"]})),
                "; ".join(i["detail"] for i in r["issues"]),
                r.get("recommendation_contract_info") or "",
            ])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, default=None)
    ap.add_argument("--db-path", default=DEFAULT_DB)
    ap.add_argument("--csv-out", default=None)
    ap.add_argument("--issues-only", action="store_true")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db_path)
    try:
        results = audit_season(conn, args.season, args.week)
        persist_audit(conn, results)

        csv_path = Path(args.csv_out) if args.csv_out else Path(
            f"/tmp/contract_audit_{args.season}.csv"
        )
        filtered = [r for r in results if r["has_issues"]] if args.issues_only else results
        write_csv(filtered, csv_path)

        total = len(results)
        flagged = sum(1 for r in results if r["has_issues"])
        print(json.dumps({
            "ok": True,
            "season": args.season,
            "week": results[0]["week"] if results else None,
            "total_players": total,
            "flagged": flagged,
            "clean": total - flagged,
            "csv": str(csv_path),
            "db": args.db_path,
        }, indent=2))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
