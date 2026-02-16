#!/usr/bin/env python3
"""Build MFL XML import artifacts from roster roll-forward CSV."""

from __future__ import annotations

import argparse
import csv
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, List
from xml.sax.saxutils import escape


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent

DEFAULT_CSV_PATH = ETL_ROOT / "artifacts" / "mfl_roster_import_2026.csv"
DEFAULT_SALARIES_XML_PATH = ETL_ROOT / "artifacts" / "mfl_roster_import_2026_salaries.xml"
DEFAULT_ROSTERS_XML_PATH = ETL_ROOT / "artifacts" / "mfl_roster_overlay_2026.xml"
DEFAULT_DB_PATH = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))


def safe_str(v: Any) -> str:
    return "" if v is None else str(v).strip()


def safe_int(v: Any, default: int = 0) -> int:
    try:
        if v is None:
            return default
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        return default


def pad4(v: Any) -> str:
    digits = "".join(ch for ch in safe_str(v) if ch.isdigit())
    return digits.zfill(4)[-4:] if digits else ""


def load_rows(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for r in reader:
            fid = pad4(r.get("franchise_id"))
            pid = safe_str(r.get("player_id"))
            if not fid or not pid:
                continue
            rows.append(
                {
                    "franchise_id": fid,
                    "player_id": pid,
                    "status": safe_str(r.get("status") or "ROSTER").upper() or "ROSTER",
                    "salary": max(0, safe_int(r.get("salary"), 0)),
                    "contract_year": max(0, safe_int(r.get("contract_year"), 0)),
                    "contract_status": safe_str(r.get("contract_status") or "Veteran"),
                    "contract_info": safe_str(r.get("contract_info")),
                }
            )
    return rows


def load_franchise_names(db_path: str, season: int) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not db_path:
        return out
    try:
        conn = sqlite3.connect(db_path)
    except sqlite3.Error:
        return out
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT franchise_id, franchise_name
            FROM metadata_franchise
            WHERE season = ?
            """,
            (season,),
        )
        rows = cur.fetchall()
        if not rows:
            cur.execute(
                """
                SELECT franchise_id, franchise_name
                FROM metadata_franchise
                WHERE season = (SELECT MAX(season) FROM metadata_franchise)
                """
            )
            rows = cur.fetchall()
        for fid, name in rows:
            pfid = pad4(fid)
            if pfid:
                out[pfid] = safe_str(name) or pfid
    finally:
        conn.close()
    return out


def write_salaries_xml(rows: List[Dict[str, Any]], out_path: Path) -> None:
    lines = [
        "<salaries>",
        '  <leagueUnit unit="LEAGUE">',
    ]
    for r in rows:
        lines.append(
            "    <player id=\"{pid}\" salary=\"{salary}\" contractStatus=\"{status}\" contractYear=\"{year}\" contractInfo=\"{info}\" />".format(
                pid=escape(safe_str(r["player_id"])),
                salary=int(r["salary"]),
                status=escape(safe_str(r["contract_status"])),
                year=int(r["contract_year"]),
                info=escape(safe_str(r["contract_info"])),
            )
        )
    lines.extend(
        [
            "  </leagueUnit>",
            "</salaries>",
            "",
        ]
    )
    out_path.write_text("\n".join(lines), encoding="utf-8")


def write_rosters_xml(rows: List[Dict[str, Any]], out_path: Path, franchise_names: Dict[str, str]) -> None:
    by_team: Dict[str, List[Dict[str, Any]]] = {}
    for r in rows:
        by_team.setdefault(r["franchise_id"], []).append(r)

    lines = ["<rosters>"]
    for fid in sorted(by_team.keys()):
        name = safe_str(franchise_names.get(fid, fid)) or fid
        lines.append(
            '  <franchise id="{fid}" name="{name}">'.format(
                fid=escape(fid),
                name=escape(name),
            )
        )
        for r in sorted(by_team[fid], key=lambda x: (safe_str(x["status"]), safe_str(x["player_id"]))):
            lines.append(
                "    <player id=\"{pid}\" status=\"{status}\" salary=\"{salary}\" contractYear=\"{year}\" contractStatus=\"{cstatus}\" />".format(
                    pid=escape(safe_str(r["player_id"])),
                    status=escape(safe_str(r["status"])),
                    salary=int(r["salary"]),
                    year=int(r["contract_year"]),
                    cstatus=escape(safe_str(r["contract_status"])),
                )
            )
        lines.append("  </franchise>")
    lines.extend(["</rosters>", ""])
    out_path.write_text("\n".join(lines), encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--in-csv", default=str(DEFAULT_CSV_PATH))
    parser.add_argument("--season", type=int, default=2026)
    parser.add_argument("--db-path", default=DEFAULT_DB_PATH)
    parser.add_argument("--salaries-out", default=str(DEFAULT_SALARIES_XML_PATH))
    parser.add_argument("--rosters-out", default=str(DEFAULT_ROSTERS_XML_PATH))
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    in_csv = Path(args.in_csv)
    salaries_out = Path(args.salaries_out)
    rosters_out = Path(args.rosters_out)
    salaries_out.parent.mkdir(parents=True, exist_ok=True)
    rosters_out.parent.mkdir(parents=True, exist_ok=True)

    rows = load_rows(in_csv)
    names = load_franchise_names(args.db_path, int(args.season))
    write_salaries_xml(rows, salaries_out)
    write_rosters_xml(rows, rosters_out, names)

    print(f"Wrote {salaries_out} ({len(rows)} players)")
    print(f"Wrote {rosters_out} ({len(set(r['franchise_id'] for r in rows))} franchises)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
