#!/usr/bin/env python3
"""Build row-level derived-vs-MFL comparison artifacts for salary adjustments."""

from __future__ import annotations

import argparse
import csv
import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List

from salary_adjustments_feed import (
    fetch_salary_adjustments,
    infer_feed_export_season,
    load_salary_adjustments_file,
    normalize_player_name,
    redact_feed_source,
    rewrite_feed_export_season,
    safe_float,
    safe_int,
    safe_str,
)


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
ROOT_DIR = ETL_ROOT.parent.parent
DEFAULT_OUT_DIR = ROOT_DIR / "site" / "reports" / "salary_adjustments"
DEFAULT_SALARY_ADJUSTMENTS_URL = os.getenv("MFL_SALARY_ADJUSTMENTS_URL", "")
DEFAULT_SALARY_ADJUSTMENTS_FILE = os.getenv("MFL_SALARY_ADJUSTMENTS_FILE", "")
DEFAULT_SALARY_ADJUSTMENTS_TIMEOUT = 30
DEFAULT_SEASON = 2025
MATCH_TOLERANCE_SECONDS = 24 * 60 * 60
CSV_FIELDS = [
    "source_id",
    "marker_id",
    "marker_feed_export_season",
    "franchise_id",
    "player_id",
    "player_name",
    "transaction_datetime_et",
    "derived_penalty_amount",
    "candidate_rule",
    "contract_basis_source",
    "pre_drop_salary",
    "pre_drop_contract_status",
    "marker_amount_raw_text",
    "marker_amount_numeric",
    "marker_description",
    "marker_created_at_et",
    "row_amount_equal",
    "row_amount_delta",
    "row_amount_mismatch_reason",
    "posted_team_season_cap_penalty",
    "computed_team_season_cap_penalty",
    "team_season_cap_penalty_delta",
    "team_total_match_status",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--season", type=int, default=DEFAULT_SEASON)
    parser.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    parser.add_argument("--report-json", default="")
    parser.add_argument("--out-json", default="")
    parser.add_argument("--out-csv", default="")
    parser.add_argument("--salary-adjustments-url", default=DEFAULT_SALARY_ADJUSTMENTS_URL)
    parser.add_argument("--salary-adjustments-file", default=DEFAULT_SALARY_ADJUSTMENTS_FILE)
    parser.add_argument("--salary-adjustments-timeout", type=int, default=DEFAULT_SALARY_ADJUSTMENTS_TIMEOUT)
    return parser.parse_args()


def now_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_datetime_et(value: Any) -> datetime | None:
    text = safe_str(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def default_report_json_path(out_dir: Path, season: int) -> Path:
    return out_dir / f"salary_adjustments_{season}.json"


def default_out_json_path(out_dir: Path, season: int) -> Path:
    return out_dir / f"salary_adjustments_{season}_derived_vs_mfl_mismatches.json"


def default_out_csv_path(out_dir: Path, season: int) -> Path:
    return out_dir / f"salary_adjustments_{season}_derived_vs_mfl_mismatches.csv"


def load_report_json(path: Path, season: int) -> Dict[str, Any]:
    if not path.is_file():
        raise SystemExit(f"Comparison export requires an existing report JSON at {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    meta = payload.get("meta") or {}
    payload_season = safe_int(meta.get("season"), 0)
    if payload_season and payload_season != safe_int(season, 0):
        raise SystemExit(
            f"Comparison export expected season {season}, but report JSON metadata says {payload_season}: {path}"
        )
    return payload


def required_feed_seasons(rows: Iterable[Dict[str, Any]], season: int) -> List[int]:
    seasons = {safe_int(season, 0)}
    for row in rows:
        if safe_str(row.get("adjustment_type")) != "DROP_PENALTY_CANDIDATE":
            continue
        marker_feed_export_season = safe_int(row.get("marker_feed_export_season"), 0)
        source_season = safe_int(row.get("source_season"), 0)
        if marker_feed_export_season > 0:
            seasons.add(marker_feed_export_season)
        elif source_season > 0:
            seasons.add(source_season)
    return sorted(value for value in seasons if value > 0)


def load_feed_payloads(
    url: str,
    file_path: str,
    timeout: int,
    seasons: Iterable[int],
) -> tuple[List[Dict[str, Any]], List[str], List[int]]:
    feeds: List[Dict[str, Any]] = []
    sources: List[str] = []
    if safe_str(url):
        fetched_urls: set[str] = set()
        for season in seasons:
            season_url = rewrite_feed_export_season(url, safe_int(season, 0))
            if season_url in fetched_urls:
                continue
            fetched_urls.add(season_url)
            feed = fetch_salary_adjustments(season_url, timeout=timeout)
            feeds.append(feed)
            sources.append(redact_feed_source(feed.get("source") or season_url))
    elif safe_str(file_path):
        feed = load_salary_adjustments_file(file_path)
        feeds.append(feed)
        sources.append(redact_feed_source(feed.get("source") or file_path))
    else:
        raise SystemExit("Comparison export requires either --salary-adjustments-url or --salary-adjustments-file")

    rows: List[Dict[str, Any]] = []
    seen: set[tuple[Any, ...]] = set()
    loaded_seasons: set[int] = set()
    for feed in feeds:
        loaded_season = safe_int(feed.get("feed_export_season"), 0) or infer_feed_export_season(feed.get("source"))
        if loaded_season > 0:
            loaded_seasons.add(loaded_season)
        for row in feed.get("rows") or []:
            key = (
                safe_int(row.get("feed_export_season"), loaded_season),
                safe_str(row.get("salary_adjustment_id") or row.get("id")),
                safe_str(row.get("franchise_id")),
                safe_str(row.get("timestamp")),
                safe_str(row.get("description")),
            )
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
    return rows, sources, sorted(loaded_seasons)


def build_marker_id_lookup(
    feed_rows: Iterable[Dict[str, Any]],
) -> tuple[Dict[tuple[int, str], Dict[str, Any]], Dict[str, List[Dict[str, Any]]]]:
    exact: Dict[tuple[int, str], Dict[str, Any]] = {}
    by_id: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in feed_rows:
        if safe_str(row.get("category")) != "drop_marker":
            continue
        marker_id = safe_str(row.get("salary_adjustment_id") or row.get("id"))
        if not marker_id:
            continue
        season = safe_int(row.get("feed_export_season"), 0)
        exact[(season, marker_id)] = row
        by_id[marker_id].append(row)
    return exact, by_id


def build_marker_lookup(feed_rows: Iterable[Dict[str, Any]]) -> Dict[tuple[int, str, str], List[Dict[str, Any]]]:
    lookup: Dict[tuple[int, str, str], List[Dict[str, Any]]] = defaultdict(list)
    for row in feed_rows:
        if safe_str(row.get("category")) != "drop_marker":
            continue
        key = (
            safe_int(row.get("feed_export_season"), 0),
            safe_str(row.get("franchise_id")),
            safe_str(row.get("marker_player_name_normalized")),
        )
        if not key[1] or not key[2]:
            continue
        lookup[key].append(row)
    for candidates in lookup.values():
        candidates.sort(key=lambda item: (safe_str(item.get("created_at_et")), safe_str(item.get("salary_adjustment_id"))))
    return dict(lookup)


def match_marker_fallback(
    report_row: Dict[str, Any],
    marker_lookup: Dict[tuple[int, str, str], List[Dict[str, Any]]],
) -> Dict[str, Any] | None:
    feed_export_season = safe_int(report_row.get("marker_feed_export_season"), 0) or safe_int(
        report_row.get("source_season"), 0
    )
    franchise_id = safe_str(report_row.get("franchise_id"))
    player_key = normalize_player_name(report_row.get("player_name"))
    candidates = marker_lookup.get((feed_export_season, franchise_id, player_key)) or []
    if not candidates:
        return None
    transaction_dt = parse_datetime_et(report_row.get("transaction_datetime_et"))
    if transaction_dt is None:
        return candidates[0] if len(candidates) == 1 else None

    ranked: List[tuple[float, Dict[str, Any], bool]] = []
    for row in candidates:
        created_at = parse_datetime_et(row.get("created_at_et"))
        if created_at is None:
            continue
        delta = abs((created_at - transaction_dt).total_seconds())
        if delta <= MATCH_TOLERANCE_SECONDS:
            ranked.append((delta, row, delta < 1))
    if not ranked:
        return None
    exact = [item for item in ranked if item[2]]
    if len(exact) == 1:
        return exact[0][1]
    if len(exact) > 1:
        return None
    ranked.sort(key=lambda item: item[0])
    if len(ranked) > 1 and abs(ranked[0][0] - ranked[1][0]) < 1:
        return None
    return ranked[0][1]


def match_marker_row(
    report_row: Dict[str, Any],
    marker_id_lookup: Dict[tuple[int, str], Dict[str, Any]],
    marker_id_fallback_lookup: Dict[str, List[Dict[str, Any]]],
    marker_lookup: Dict[tuple[int, str, str], List[Dict[str, Any]]],
) -> tuple[Dict[str, Any] | None, str]:
    marker_id = safe_str(report_row.get("marker_id"))
    marker_feed_export_season = safe_int(report_row.get("marker_feed_export_season"), 0)
    if marker_id and marker_feed_export_season > 0:
        row = marker_id_lookup.get((marker_feed_export_season, marker_id))
        if row is not None:
            return row, "marker_id"
    if marker_id:
        candidates = marker_id_fallback_lookup.get(marker_id) or []
        if len(candidates) == 1:
            return candidates[0], "marker_id_fallback"
    row = match_marker_fallback(report_row, marker_lookup)
    if row is not None:
        return row, "name_time_fallback"
    return None, "missing"


def team_total_match_status(report_row: Dict[str, Any]) -> str:
    posted_value = report_row.get("posted_team_season_cap_penalty")
    if posted_value is None:
        return "no_posted_team_total"
    posted_total = safe_int(posted_value, 0)
    computed_total = safe_int(report_row.get("computed_team_season_cap_penalty"), 0)
    return "matched" if computed_total == posted_total else "mismatched"


def build_mismatch_rows(
    report_rows: Iterable[Dict[str, Any]],
    marker_id_lookup: Dict[tuple[int, str], Dict[str, Any]],
    marker_id_fallback_lookup: Dict[str, List[Dict[str, Any]]],
    marker_lookup: Dict[tuple[int, str, str], List[Dict[str, Any]]],
) -> tuple[List[Dict[str, Any]], Dict[str, Any]]:
    mismatches: List[Dict[str, Any]] = []
    lookup_method_counts: Counter[str] = Counter()
    team_total_counts: Counter[str] = Counter()
    row_amount_equal_count = 0

    for report_row in report_rows:
        if safe_str(report_row.get("adjustment_type")) != "DROP_PENALTY_CANDIDATE":
            continue

        matched_marker, lookup_method = match_marker_row(
            report_row,
            marker_id_lookup,
            marker_id_fallback_lookup,
            marker_lookup,
        )
        lookup_method_counts[lookup_method] += 1

        derived_penalty_amount = safe_int(report_row.get("penalty_amount"), safe_int(report_row.get("amount"), 0))
        marker_amount_raw_text = ""
        marker_amount_numeric: float | None = None
        marker_description = ""
        marker_created_at_et = ""
        row_amount_equal = False
        row_amount_delta: float | None = None
        row_amount_mismatch_reason = "marker_not_found"

        if matched_marker is not None:
            marker_amount_raw_text = safe_str(matched_marker.get("amount_raw_text"))
            marker_amount_numeric = safe_float(matched_marker.get("amount"), 0.0)
            marker_description = safe_str(matched_marker.get("description"))
            marker_created_at_et = safe_str(matched_marker.get("created_at_et"))
            row_amount_equal = abs(float(derived_penalty_amount) - marker_amount_numeric) < 1e-9
            row_amount_delta = float(derived_penalty_amount) - marker_amount_numeric
            if safe_str(matched_marker.get("category")) == "drop_marker" and abs(marker_amount_numeric) < 1.0:
                row_amount_mismatch_reason = "marker_sentinel_amount"
            else:
                row_amount_mismatch_reason = "amount_mismatch"

        if row_amount_equal:
            row_amount_equal_count += 1
            continue

        team_status = team_total_match_status(report_row)
        team_total_counts[team_status] += 1
        mismatches.append(
            {
                "source_id": safe_str(report_row.get("source_id")),
                "marker_id": safe_str(report_row.get("marker_id")),
                "marker_feed_export_season": safe_int(report_row.get("marker_feed_export_season"), 0),
                "franchise_id": safe_str(report_row.get("franchise_id")),
                "player_id": safe_str(report_row.get("player_id")),
                "player_name": safe_str(report_row.get("player_name")),
                "transaction_datetime_et": safe_str(report_row.get("transaction_datetime_et")),
                "derived_penalty_amount": derived_penalty_amount,
                "candidate_rule": safe_str(report_row.get("candidate_rule")),
                "contract_basis_source": safe_str(report_row.get("contract_basis_source")),
                "pre_drop_salary": safe_int(report_row.get("pre_drop_salary"), 0),
                "pre_drop_contract_status": safe_str(report_row.get("pre_drop_contract_status")),
                "marker_amount_raw_text": marker_amount_raw_text,
                "marker_amount_numeric": marker_amount_numeric,
                "marker_description": marker_description,
                "marker_created_at_et": marker_created_at_et,
                "row_amount_equal": row_amount_equal,
                "row_amount_delta": row_amount_delta,
                "row_amount_mismatch_reason": row_amount_mismatch_reason,
                "posted_team_season_cap_penalty": report_row.get("posted_team_season_cap_penalty"),
                "computed_team_season_cap_penalty": report_row.get("computed_team_season_cap_penalty"),
                "team_season_cap_penalty_delta": report_row.get("team_season_cap_penalty_delta"),
                "team_total_match_status": team_status,
            }
        )

    return mismatches, {
        "lookup_method_counts": dict(lookup_method_counts),
        "team_total_match_status_counts": dict(team_total_counts),
        "row_amount_equal_count": row_amount_equal_count,
    }


def write_csv(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field) for field in CSV_FIELDS})


def main() -> None:
    args = parse_args()
    out_dir = Path(args.out_dir).expanduser()
    season = safe_int(args.season, DEFAULT_SEASON)
    report_json_path = Path(args.report_json).expanduser() if safe_str(args.report_json) else default_report_json_path(out_dir, season)
    out_json_path = Path(args.out_json).expanduser() if safe_str(args.out_json) else default_out_json_path(out_dir, season)
    out_csv_path = Path(args.out_csv).expanduser() if safe_str(args.out_csv) else default_out_csv_path(out_dir, season)

    report_payload = load_report_json(report_json_path, season)
    report_rows = list(report_payload.get("rows") or [])
    feed_seasons = required_feed_seasons(report_rows, season)
    feed_rows, feed_sources, loaded_feed_seasons = load_feed_payloads(
        safe_str(args.salary_adjustments_url),
        safe_str(args.salary_adjustments_file),
        safe_int(args.salary_adjustments_timeout, DEFAULT_SALARY_ADJUSTMENTS_TIMEOUT),
        feed_seasons,
    )

    marker_id_lookup, marker_id_fallback_lookup = build_marker_id_lookup(feed_rows)
    marker_lookup = build_marker_lookup(feed_rows)
    mismatch_rows, counts = build_mismatch_rows(
        report_rows,
        marker_id_lookup,
        marker_id_fallback_lookup,
        marker_lookup,
    )

    out_json_path.parent.mkdir(parents=True, exist_ok=True)
    output_payload = {
        "meta": {
            "season": season,
            "generated_at_utc": now_utc(),
            "report_json": str(report_json_path),
            "feed_sources": feed_sources,
            "required_feed_seasons": feed_seasons,
            "loaded_feed_export_seasons": loaded_feed_seasons,
            "drop_row_count": sum(
                1 for row in report_rows if safe_str(row.get("adjustment_type")) == "DROP_PENALTY_CANDIDATE"
            ),
            "mismatch_row_count": len(mismatch_rows),
            "lookup_method_counts": counts["lookup_method_counts"],
            "team_total_match_status_counts": counts["team_total_match_status_counts"],
            "row_amount_equal_count": counts["row_amount_equal_count"],
        },
        "rows": mismatch_rows,
    }
    out_json_path.write_text(json.dumps(output_payload, indent=2), encoding="utf-8")
    write_csv(out_csv_path, mismatch_rows)
    print(
        f"Wrote {len(mismatch_rows)} mismatch rows to {out_json_path} and {out_csv_path}"
    )


if __name__ == "__main__":
    main()
