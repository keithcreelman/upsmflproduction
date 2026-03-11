#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
REPO_ROOT = ETL_ROOT.parent.parent
DB_DEFAULT = os.getenv(
    "MFL_DB_PATH",
    os.path.expanduser("/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db"),
)
OUT_DIR_DEFAULT = REPO_ROOT / "site" / "acquisition"


def parse_args():
    parser = argparse.ArgumentParser(description="Build Acquisition Hub history artifacts.")
    parser.add_argument("--db-path", default=DB_DEFAULT)
    parser.add_argument("--out-dir", default=str(OUT_DIR_DEFAULT))
    parser.add_argument("--current-season", type=int, default=datetime.now().year)
    parser.add_argument("--history-seasons", type=int, default=12)
    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def safe_int(value, default=0):
    try:
        if value in (None, ""):
            return default
        return int(float(value))
    except Exception:
        return default


def safe_float(value, default=0.0):
    try:
        if value in (None, ""):
            return default
        return float(value)
    except Exception:
        return default


def clamp(value, low, high):
    return max(low, min(high, value))


def round2(value):
    if value is None:
        return 0.0
    return round(float(value), 2)


def normalize_pos_group(raw: str) -> str:
    pos = str(raw or "").upper().strip()
    if pos in {"DE", "DT", "EDGE", "DL"}:
        return "DL"
    if pos in {"CB", "S", "FS", "SS", "DB"}:
        return "DB"
    if pos in {"K", "PK"}:
        return "PK"
    if pos in {"P", "PN"}:
        return "PN"
    return pos or "OTHER"


def value_scale(rows, key, bucket_key):
    grouped = {}
    for row in rows:
        bucket = row.get(bucket_key) or "all"
        grouped.setdefault(bucket, []).append(safe_float(row.get(key), 0.0))
    stats = {}
    for bucket, values in grouped.items():
        lo = min(values) if values else 0.0
        hi = max(values) if values else 0.0
        stats[bucket] = (lo, hi)
    for row in rows:
        bucket = row.get(bucket_key) or "all"
        lo, hi = stats.get(bucket, (0.0, 0.0))
        raw = safe_float(row.get(key), 0.0)
        if hi <= lo:
            row[f"{key}_scaled"] = 0.5 if raw else 0.0
        else:
            row[f"{key}_scaled"] = clamp((raw - lo) / (hi - lo), 0.0, 1.0)


def fetch_rows(conn: sqlite3.Connection, sql: str, params=()):
    cur = conn.cursor()
    cur.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def fetch_rows_safe(conn: sqlite3.Connection, sql: str, params=()):
    try:
        return fetch_rows(conn, sql, params)
    except sqlite3.Error:
        return []


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT 1
        FROM sqlite_master
        WHERE type IN ('table', 'view')
          AND name = ?
        LIMIT 1
        """,
        (name,),
    )
    return cur.fetchone() is not None


def rookie_round_segment(pick_in_round: int) -> str:
    pick = safe_int(pick_in_round, 0)
    if 1 <= pick <= 4:
        return "Early"
    if 5 <= pick <= 8:
        return "Middle"
    return "Late"


def pick_label(round_value: int, pick_in_round: int) -> str:
    return f"{safe_int(round_value, 0)}.{safe_int(pick_in_round, 0):02d}"


def build_rookie_history(conn: sqlite3.Connection, current_season: int, history_seasons: int):
    min_season = current_season - max(history_seasons, 3) + 1
    rookie_rows = fetch_rows(
        conn,
        """
        SELECT
          season,
          draft_round,
          pick_in_round,
          pick_overall,
          player_id,
          player_name,
          franchise_id,
          franchise_name,
          owner_name,
          position,
          pos_group,
          offense_defense,
          salary,
          points_y1,
          ppg_y1,
          starts_y1,
          points_y2,
          ppg_y2,
          starts_y2,
          points_y3,
          ppg_y3,
          starts_y3,
          points_rookiecontract,
          games_3yr,
          starts_3yr,
          vam_rookiecontract,
          vorp_rookiecontract,
          vam_career,
          vorp_career,
          points_career,
          games_started
        FROM View_RookieDraft
        WHERE season >= ?
        ORDER BY season DESC, pick_overall ASC
        """,
        (min_season,),
    )

    weekly_rows = fetch_rows(
        conn,
        """
        SELECT
          season,
          player_id,
          elite_week,
          winning_week,
          score
        FROM player_weeklyscoringresults
        WHERE season >= ?
          AND season <= ?
        """,
        (min_season, current_season + 2),
    )
    weekly_by_player_season = {}
    for row in weekly_rows:
        key = (str(row["player_id"]), safe_int(row["season"]))
        entry = weekly_by_player_season.setdefault(
            key,
            {"games": 0, "elite_weeks": 0, "winning_weeks": 0, "points": 0.0},
        )
        entry["games"] += 1
        entry["elite_weeks"] += safe_int(row["elite_week"])
        entry["winning_weeks"] += safe_int(row["winning_week"])
        entry["points"] += safe_float(row["score"])

    bucket_values = {}
    for row in rookie_rows:
        pick_overall = max(1, safe_int(row.get("pick_overall"), 1))
        bucket_start = ((pick_overall - 1) // 6) * 6 + 1
        bucket_end = bucket_start + 5
        bucket = f"{bucket_start:02d}-{bucket_end:02d}"
        row["pick_bucket"] = bucket
        bucket_values.setdefault(bucket, []).append(safe_float(row.get("points_rookiecontract"), 0.0))

    pick_bucket_expectation = {}
    for bucket, values in bucket_values.items():
        clean = sorted(v for v in values if v is not None)
        if not clean:
            pick_bucket_expectation[bucket] = 0.0
        else:
            pick_bucket_expectation[bucket] = clean[len(clean) // 2]

    enriched = []
    for row in rookie_rows:
        season = safe_int(row.get("season"))
        player_id = str(row.get("player_id") or "")
        totals = {"games": 0, "elite": 0, "non_dud": 0, "points": 0.0}
        for year in (season, season + 1, season + 2):
            wk = weekly_by_player_season.get((player_id, year), {})
            totals["games"] += safe_int(wk.get("games"), 0)
            totals["elite"] += safe_int(wk.get("elite_weeks"), 0)
            totals["non_dud"] += safe_int(wk.get("winning_weeks"), 0)
            totals["points"] += safe_float(wk.get("points"), 0.0)
        starts_3yr = safe_float(row.get("starts_3yr"), 0.0)
        games_3yr = max(safe_float(row.get("games_3yr"), 0.0), float(totals["games"]))
        points_3yr = safe_float(row.get("points_rookiecontract"), 0.0)
        expected = safe_float(pick_bucket_expectation.get(row["pick_bucket"]), 0.0)
        roi_score = points_3yr - expected
        impact = safe_float(row.get("vam_rookiecontract"), 0.0) + safe_float(row.get("vorp_rookiecontract"), 0.0)
        starts_share = starts_3yr / games_3yr if games_3yr > 0 else 0.0
        elite_rate = totals["elite"] / games_3yr if games_3yr > 0 else 0.0
        non_dud_rate = totals["non_dud"] / games_3yr if games_3yr > 0 else 0.0
        pos_value = safe_float(row.get("vam_rookiecontract"), 0.0)
        record = {
            "season": season,
            "draft_round": safe_int(row.get("draft_round")),
            "pick_in_round": safe_int(row.get("pick_in_round")),
            "pick_overall": safe_int(row.get("pick_overall")),
            "pick_label": pick_label(row.get("draft_round"), row.get("pick_in_round")),
            "pick_bucket": row["pick_bucket"],
            "round_segment": rookie_round_segment(row.get("pick_in_round")),
            "player_id": player_id,
            "player_name": row.get("player_name") or "",
            "franchise_id": row.get("franchise_id") or "",
            "franchise_name": row.get("franchise_name") or "",
            "owner_name": row.get("owner_name") or "",
            "position": row.get("position") or "",
            "pos_group": normalize_pos_group(row.get("pos_group") or row.get("position")),
            "offense_defense": row.get("offense_defense") or "OFFENSE",
            "salary": safe_int(row.get("salary")),
            "points_y1": round2(row.get("points_y1")),
            "points_y2": round2(row.get("points_y2")),
            "points_y3": round2(row.get("points_y3")),
            "starts_y1": safe_int(row.get("starts_y1")),
            "starts_y2": safe_int(row.get("starts_y2")),
            "starts_y3": safe_int(row.get("starts_y3")),
            "points_rookiecontract": round2(points_3yr),
            "games_3yr": safe_int(games_3yr),
            "starts_3yr": safe_int(starts_3yr),
            "vam_rookiecontract": round2(row.get("vam_rookiecontract")),
            "vorp_rookiecontract": round2(row.get("vorp_rookiecontract")),
            "vam_career": round2(row.get("vam_career")),
            "vorp_career": round2(row.get("vorp_career")),
            "points_career": round2(row.get("points_career")),
            "games_started": safe_int(row.get("games_started")),
            "elite_weeks": safe_int(totals["elite"]),
            "non_dud_weeks": safe_int(totals["non_dud"]),
            "elite_week_rate": round2(elite_rate),
            "non_dud_rate": round2(non_dud_rate),
            "starts_share": round2(starts_share),
            "positional_value_score": round2(pos_value),
            "overall_impact_score": round2(impact),
            "roi_score": round2(roi_score),
        }
        enriched.append(record)

    for metric in (
        "points_rookiecontract",
        "elite_week_rate",
        "non_dud_rate",
        "starts_share",
        "positional_value_score",
        "overall_impact_score",
        "roi_score",
    ):
        value_scale(enriched, metric, "offense_defense")

    for row in enriched:
        score = (
            safe_float(row.get("points_rookiecontract_scaled"), 0.0) * 0.27
            + safe_float(row.get("elite_week_rate_scaled"), 0.0) * 0.15
            + safe_float(row.get("non_dud_rate_scaled"), 0.0) * 0.12
            + safe_float(row.get("starts_share_scaled"), 0.0) * 0.12
            + safe_float(row.get("positional_value_score_scaled"), 0.0) * 0.12
            + safe_float(row.get("overall_impact_score_scaled"), 0.0) * 0.12
            + safe_float(row.get("roi_score_scaled"), 0.0) * 0.10
        )
        row["rookie_value_score"] = round(score * 100.0, 2)
        row["expected_points_3yr"] = round2(pick_bucket_expectation.get(row["pick_bucket"], 0.0))
        row["hit_flag"] = 1 if safe_float(row.get("roi_score"), 0.0) > 0 else 0

    adp_rows = fetch_rows_safe(
        conn,
        """
        SELECT
          season,
          player_id,
          player_name,
          position,
          nfl_team,
          mfl_rank,
          mfl_average_pick,
          normalized_adp,
          normalization_source,
          superflex_source_adp,
          adp_period_used
        FROM adp_normalized_values
        WHERE season >= ?
        ORDER BY season DESC, normalized_adp ASC
        LIMIT 400
        """,
        (current_season - 2,),
    )

    rookie_adp_by_player = {}
    rookie_seed_rows = []
    if table_exists(conn, "player_market_sentiment"):
        rookie_seed_rows = fetch_rows_safe(
            conn,
            """
            WITH latest AS (
              SELECT
                valuation_season,
                player_id,
                MAX(snapshot_ts_utc) AS snapshot_ts_utc
              FROM player_market_sentiment
              WHERE valuation_season = ?
                AND (is_rookie = 1 OR nfl_draft_year = ?)
              GROUP BY valuation_season, player_id
            )
            SELECT
              p.valuation_season,
              p.player_id,
              p.player_name,
              p.position,
              p.pos_group,
              p.team AS nfl_team,
              p.nfl_draft_year,
              p.is_rookie,
              p.adp_overall,
              p.adp_position,
              p.adp_bucket,
              p.adp_tier,
              p.market_archetype,
              p.public_sentiment_score
            FROM latest l
            JOIN player_market_sentiment p
              ON p.valuation_season = l.valuation_season
             AND p.player_id = l.player_id
             AND p.snapshot_ts_utc = l.snapshot_ts_utc
            ORDER BY COALESCE(p.adp_overall, 9999), p.player_name
            """,
            (current_season, current_season),
        )
    adp_current_by_player = {
        str(row.get("player_id") or ""): row
        for row in adp_rows
        if safe_int(row.get("season")) == current_season
    }
    rookie_adp_rows = []
    for row in rookie_seed_rows:
        player_id = str(row.get("player_id") or "")
        adp_row = adp_current_by_player.get(player_id, {})
        normalized_adp_value = adp_row.get("normalized_adp")
        if normalized_adp_value in (None, "") and row.get("adp_overall") not in (None, ""):
            normalized_adp_value = row.get("adp_overall")
        rookie_adp_row = {
            "season": current_season,
            "player_id": player_id,
            "player_name": row.get("player_name") or "",
            "position": row.get("position") or "",
            "nfl_team": row.get("nfl_team") or "",
            "normalized_adp": None if normalized_adp_value in (None, "") else round2(normalized_adp_value),
            "mfl_rank": safe_int(adp_row.get("mfl_rank")),
            "mfl_average_pick": round2(adp_row.get("mfl_average_pick")),
            "superflex_source_adp": round2(adp_row.get("superflex_source_adp")),
            "adp_period_used": adp_row.get("adp_period_used") or "",
            "normalization_source": adp_row.get("normalization_source") or row.get("market_archetype") or "",
            "pos_group": row.get("pos_group") or "",
            "adp_bucket": row.get("adp_bucket") or "",
            "adp_tier": row.get("adp_tier") or "",
            "public_sentiment_score": round2(row.get("public_sentiment_score")),
        }
        rookie_adp_rows.append(rookie_adp_row)
        rookie_adp_by_player[player_id] = rookie_adp_row
    if not rookie_adp_rows:
        rookie_adp_rows = [
            row for row in adp_rows
            if safe_int(row.get("season")) == current_season
        ]

    draftable_rookies_seed = []
    for row in rookie_seed_rows:
        player_id = str(row.get("player_id") or "")
        adp_row = rookie_adp_by_player.get(player_id, adp_current_by_player.get(player_id, {}))
        normalized_adp_value = adp_row.get("normalized_adp")
        draftable_rookies_seed.append(
            {
                "player_id": player_id,
                "player_name": row.get("player_name") or "",
                "position": row.get("position") or "",
                "pos_group": row.get("pos_group") or "",
                "nfl_team": row.get("nfl_team") or "",
                "rookie_class_season": safe_int(row.get("nfl_draft_year") or current_season),
                "normalized_adp": None if normalized_adp_value in (None, "") else round2(normalized_adp_value),
                "mfl_average_pick": round2(adp_row.get("mfl_average_pick")),
                "adp_tier": row.get("adp_tier") or "",
                "public_sentiment_score": round2(row.get("public_sentiment_score")),
            }
        )
    draftable_rookies_seed.sort(
        key=lambda row: (
            safe_float(row.get("normalized_adp"), 9999),
            str(row.get("player_name") or "").lower(),
        )
    )

    current_order = [
        {
            "franchise_id": row["franchise_id"],
            "franchise_name": row["franchise_name"],
            "pick_label": row["pick_label"],
            "pick_overall": safe_int(row["pick_overall"]),
        }
        for row in enriched
        if safe_int(row["season"]) == current_season
    ][:48]

    top_hits = sorted(
        enriched,
        key=lambda row: (safe_float(row.get("rookie_value_score"), 0.0), safe_float(row.get("points_rookiecontract"), 0.0)),
        reverse=True,
    )[:50]

    value_summary = []
    for bucket, values in sorted(pick_bucket_expectation.items()):
        bucket_rows = [row for row in enriched if row["pick_bucket"] == bucket]
        if not bucket_rows:
            continue
        avg_value = sum(safe_float(row.get("rookie_value_score"), 0.0) for row in bucket_rows) / len(bucket_rows)
        avg_points = sum(safe_float(row.get("points_rookiecontract"), 0.0) for row in bucket_rows) / len(bucket_rows)
        value_summary.append(
            {
                "pick_bucket": bucket,
                "expected_points_3yr": round2(values),
                "avg_points_3yr": round2(avg_points),
                "avg_rookie_value_score": round2(avg_value),
                "sample_size": len(bucket_rows),
            }
        )

    available_seasons = sorted({safe_int(row.get("season")) for row in enriched if safe_int(row.get("season")) > 0}, reverse=True)

    owner_summary = {}
    pick_summary = {}
    for row in enriched:
        owner_key = (str(row.get("season") or ""), str(row.get("franchise_id") or ""))
        owner_summary.setdefault(
            owner_key,
            {
                "season": safe_int(row.get("season")),
                "franchise_id": row.get("franchise_id") or "",
                "franchise_name": row.get("franchise_name") or "",
                "owner_name": row.get("owner_name") or "",
                "picks_made": 0,
                "points_total_3yr": 0.0,
                "rookie_value_total": 0.0,
                "hit_count": 0,
                "best_pick_label": "",
                "best_pick_player_name": "",
                "best_pick_score": -1.0,
            },
        )
        owner_row = owner_summary[owner_key]
        owner_row["picks_made"] += 1
        owner_row["points_total_3yr"] += safe_float(row.get("points_rookiecontract"), 0.0)
        owner_row["rookie_value_total"] += safe_float(row.get("rookie_value_score"), 0.0)
        owner_row["hit_count"] += safe_int(row.get("hit_flag"), 0)
        if safe_float(row.get("rookie_value_score"), 0.0) > safe_float(owner_row.get("best_pick_score"), -1.0):
            owner_row["best_pick_score"] = safe_float(row.get("rookie_value_score"), 0.0)
            owner_row["best_pick_label"] = row.get("pick_label") or ""
            owner_row["best_pick_player_name"] = row.get("player_name") or ""

        pick_key = (str(row.get("draft_round") or ""), str(row.get("pick_in_round") or ""))
        pick_summary.setdefault(
            pick_key,
            {
                "draft_round": safe_int(row.get("draft_round")),
                "pick_in_round": safe_int(row.get("pick_in_round")),
                "pick_label": row.get("pick_label") or "",
                "round_segment": row.get("round_segment") or "",
                "sample_size": 0,
                "points_total_3yr": 0.0,
                "rookie_value_total": 0.0,
                "hit_count": 0,
            },
        )
        pick_row = pick_summary[pick_key]
        pick_row["sample_size"] += 1
        pick_row["points_total_3yr"] += safe_float(row.get("points_rookiecontract"), 0.0)
        pick_row["rookie_value_total"] += safe_float(row.get("rookie_value_score"), 0.0)
        pick_row["hit_count"] += safe_int(row.get("hit_flag"), 0)

    owner_summary_rows = []
    for row in owner_summary.values():
        picks_made = max(1, safe_int(row.get("picks_made"), 0))
        owner_summary_rows.append(
            {
                "season": safe_int(row.get("season")),
                "franchise_id": row.get("franchise_id") or "",
                "franchise_name": row.get("franchise_name") or "",
                "owner_name": row.get("owner_name") or "",
                "picks_made": safe_int(row.get("picks_made")),
                "avg_points_3yr": round2(safe_float(row.get("points_total_3yr")) / picks_made),
                "avg_rookie_value_score": round2(safe_float(row.get("rookie_value_total")) / picks_made),
                "hit_count": safe_int(row.get("hit_count")),
                "hit_rate": round2(safe_float(row.get("hit_count")) / picks_made),
                "best_pick": " / ".join([part for part in [row.get("best_pick_label"), row.get("best_pick_player_name")] if part]),
            }
        )
    owner_summary_rows.sort(
        key=lambda row: (
            -safe_float(row.get("avg_rookie_value_score"), 0.0),
            -safe_float(row.get("avg_points_3yr"), 0.0),
            str(row.get("franchise_name") or "").lower(),
        )
    )

    pick_summary_rows = []
    for row in pick_summary.values():
        sample_size = max(1, safe_int(row.get("sample_size"), 0))
        pick_summary_rows.append(
            {
                "draft_round": safe_int(row.get("draft_round")),
                "pick_in_round": safe_int(row.get("pick_in_round")),
                "pick_label": row.get("pick_label") or "",
                "round_segment": row.get("round_segment") or "",
                "sample_size": safe_int(row.get("sample_size")),
                "avg_points_3yr": round2(safe_float(row.get("points_total_3yr")) / sample_size),
                "avg_rookie_value_score": round2(safe_float(row.get("rookie_value_total")) / sample_size),
                "hit_count": safe_int(row.get("hit_count")),
                "hit_rate": round2(safe_float(row.get("hit_count")) / sample_size),
            }
        )
    pick_summary_rows.sort(
        key=lambda row: (
            safe_int(row.get("draft_round")),
            safe_int(row.get("pick_in_round")),
        )
    )

    return {
        "meta": {
            "generated_at": utc_now_iso(),
            "current_season": current_season,
            "history_start_season": min_season,
            "source": "build_acquisition_hub_artifacts.py",
        },
        "available_seasons": available_seasons,
        "current_order": current_order,
        "adp_board": rookie_adp_rows,
        "draftable_rookies_seed": draftable_rookies_seed,
        "history_rows": enriched,
        "value_summary": value_summary,
        "owner_summary_rows": owner_summary_rows,
        "pick_summary_rows": pick_summary_rows,
        "round_segment_definition": {
            "teams_per_round": 12,
            "segments": [
                {"label": "Early", "start_pick_in_round": 1, "end_pick_in_round": 4},
                {"label": "Middle", "start_pick_in_round": 5, "end_pick_in_round": 8},
                {"label": "Late", "start_pick_in_round": 9, "end_pick_in_round": 12},
            ],
        },
        "top_hits": top_hits,
    }


def build_auction_history(conn: sqlite3.Connection, current_season: int, history_seasons: int):
    min_season = current_season - max(history_seasons, 3) + 1
    history_rows = fetch_rows(
        conn,
        """
        SELECT
          season,
          auction_group_id,
          player_id,
          player_name,
          position,
          nfl_team,
          franchise_id,
          team_name,
          owner_name,
          bid_amount,
          auction_type,
          datetime_et,
          unix_timestamp
        FROM transactions_auction
        WHERE finalbid_ind = 1
          AND auction_type = 'FreeAgent'
          AND season >= ?
        ORDER BY season DESC, unix_timestamp DESC
        LIMIT 800
        """,
        (min_season,),
    )

    contract_rows = fetch_rows(
        conn,
        """
        SELECT
          cs.season,
          cs.franchise_id,
          cs.franchise_name,
          cs.player_id,
          cs.player_name,
          cs.position,
          cs.submitted_at_utc,
          ac.auction_type,
          ac.contract_style,
          ac.contract_length,
          ac.tcv,
          ac.aav,
          ac.year_values_json,
          ac.note
        FROM contract_submissions cs
        JOIN auction_contracts ac
          ON ac.submission_uid = cs.detail_id
        WHERE cs.submission_type = 'auction'
          AND cs.match_status = 'matched'
          AND cs.season >= ?
        ORDER BY cs.season DESC, cs.submitted_at_utc DESC
        LIMIT 800
        """,
        (min_season,),
    )

    available_seed = fetch_rows(
        conn,
        """
        SELECT
          pav.valuation_season,
          pav.player_id,
          pav.player_name,
          pav.position,
          pav.pos_group,
          pav.team,
          pav.upcoming_auction_value,
          pav.auction_value_low,
          pav.auction_value_high,
          pav.auction_confidence,
          pav.historical_avg_auction_bid,
          pav.historical_recent_auction_bid,
          pav.market_adp_overall,
          ad.normalized_adp
        FROM player_upcoming_auction_value pav
        LEFT JOIN adp_normalized_values ad
          ON ad.season = pav.valuation_season
         AND ad.player_id = pav.player_id
        WHERE pav.valuation_season = ?
        ORDER BY pav.upcoming_auction_value DESC
        LIMIT 500
        """,
        (current_season,),
    )

    season_summary = fetch_rows(
        conn,
        """
        SELECT
          season,
          COUNT(*) AS won_count,
          ROUND(AVG(bid_amount), 2) AS avg_winning_bid,
          MAX(bid_amount) AS max_winning_bid
        FROM transactions_auction
        WHERE finalbid_ind = 1
          AND auction_type = 'FreeAgent'
          AND season >= ?
        GROUP BY season
        ORDER BY season DESC
        """,
        (min_season,),
    )

    return {
        "meta": {
            "generated_at": utc_now_iso(),
            "current_season": current_season,
            "history_start_season": min_season,
            "source": "build_acquisition_hub_artifacts.py",
        },
        "available_players_seed": available_seed,
        "history_rows": history_rows,
        "contract_rows": contract_rows,
        "season_summary": season_summary,
    }


def build_expired_rookie_history(conn: sqlite3.Connection, current_season: int, history_seasons: int):
    min_season = current_season - max(history_seasons, 3) + 1
    history_rows = fetch_rows(
        conn,
        """
        SELECT
          season,
          auction_group_id,
          player_id,
          player_name,
          position,
          nfl_team,
          franchise_id,
          team_name,
          owner_name,
          bid_amount,
          datetime_et,
          unix_timestamp
        FROM transactions_auction
        WHERE finalbid_ind = 1
          AND auction_type = 'TagOrExpiredRookie'
          AND season >= ?
        ORDER BY season DESC, unix_timestamp DESC
        LIMIT 500
        """,
        (min_season,),
    )

    extension_rows = fetch_rows(
        conn,
        """
        SELECT
          season,
          player_id,
          player_name,
          franchise_id,
          team_name,
          ext_nickname,
          ext_ownername
        FROM current_extensions
        ORDER BY season DESC, player_name ASC
        """,
    )

    current_winners = fetch_rows(
        conn,
        """
        SELECT DISTINCT player_id
        FROM transactions_auction
        WHERE finalbid_ind = 1
          AND auction_type = 'TagOrExpiredRookie'
          AND season = ?
        """,
        (current_season,),
    )

    return {
        "meta": {
            "generated_at": utc_now_iso(),
            "current_season": current_season,
            "history_start_season": min_season,
            "source": "build_acquisition_hub_artifacts.py",
        },
        "history_rows": history_rows,
        "extension_rows": extension_rows,
        "current_winner_player_ids": sorted({str(row["player_id"]) for row in current_winners if row.get("player_id")}),
    }


def build_waiver_history(conn: sqlite3.Connection, current_season: int, history_seasons: int):
    min_season = current_season - max(history_seasons, 3) + 1
    history_rows = fetch_rows(
        conn,
        """
        SELECT
          season,
          franchise_id,
          franchise_name,
          franchise_owner,
          player_id,
          player_name,
          player_position,
          player_nflteam,
          move_type,
          method,
          salary,
          datetime_et,
          unix_timestamp
        FROM transactions_adddrop
        WHERE season >= ?
          AND move_type = 'ADD'
          AND method IN ('BBID', 'FREE_AGENT', 'WAIVER')
        ORDER BY season DESC, unix_timestamp DESC
        LIMIT 800
        """,
        (min_season,),
    )

    method_summary = fetch_rows(
        conn,
        """
        SELECT
          season,
          method,
          COUNT(*) AS acquisition_count
        FROM transactions_adddrop
        WHERE season >= ?
          AND move_type = 'ADD'
          AND method IN ('BBID', 'FREE_AGENT', 'WAIVER')
        GROUP BY season, method
        ORDER BY season DESC, method ASC
        """,
        (min_season,),
    )

    return {
        "meta": {
            "generated_at": utc_now_iso(),
            "current_season": current_season,
            "history_start_season": min_season,
            "source": "build_acquisition_hub_artifacts.py",
        },
        "history_rows": history_rows,
        "method_summary": method_summary,
    }


def write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=True, indent=2)
        handle.write("\n")


def main():
    args = parse_args()
    out_dir = Path(args.out_dir).resolve()
    conn = sqlite3.connect(args.db_path)
    try:
        rookie = build_rookie_history(conn, args.current_season, args.history_seasons)
        auction = build_auction_history(conn, args.current_season, args.history_seasons)
        expired = build_expired_rookie_history(conn, args.current_season, args.history_seasons)
        waivers = build_waiver_history(conn, args.current_season, args.history_seasons)
    finally:
        conn.close()

    manifest = {
        "generated_at": utc_now_iso(),
        "current_season": args.current_season,
        "artifacts": {
            "rookie_draft_history": "rookie_draft_history.json",
            "free_agent_auction_history": "free_agent_auction_history.json",
            "expired_rookie_history": "expired_rookie_history.json",
            "waiver_history": "waiver_history.json",
        },
    }

    write_json(out_dir / "rookie_draft_history.json", rookie)
    write_json(out_dir / "free_agent_auction_history.json", auction)
    write_json(out_dir / "expired_rookie_history.json", expired)
    write_json(out_dir / "waiver_history.json", waivers)
    write_json(out_dir / "manifest.json", manifest)


if __name__ == "__main__":
    main()
