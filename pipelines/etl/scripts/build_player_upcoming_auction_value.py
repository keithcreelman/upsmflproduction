#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import json
import math
import os
import sqlite3
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
DB_DEFAULT = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))
LOG_DIR = Path(os.getenv("MFL_ETL_ARTIFACT_DIR", str(ETL_ROOT / "artifacts")))


def parse_args():
    parser = argparse.ArgumentParser(
        description="Rebuild player upcoming auction value by blending public sentiment into the current auction model baseline."
    )
    parser.add_argument("--db-path", default=DB_DEFAULT)
    parser.add_argument("--valuation-season", type=int, default=2026)
    parser.add_argument("--topn", type=int, default=100)
    return parser.parse_args()


def now_utc():
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S%z")


def coerce_float(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return float(v)
    except Exception:
        return None


def coerce_int(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return int(float(v))
    except Exception:
        return None


def clamp(value, low, high):
    return max(low, min(high, value))


def round_nearest_1000(value):
    if value is None:
        return ""
    return f"{int(round(float(value) / 1000.0) * 1000):,}"


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


def ensure_column(conn, table_name, column_name, ddl_fragment):
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table_name})")
    existing = {str(row[1]) for row in cur.fetchall()}
    if column_name in existing:
        return
    cur.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {ddl_fragment}")
    conn.commit()


def ensure_table_columns(conn):
    additions = {
        "pre_sentiment_auction_value": "REAL",
        "pre_sentiment_auction_value_low": "REAL",
        "pre_sentiment_auction_value_high": "REAL",
        "market_sentiment_snapshot_ts_utc": "TEXT",
        "market_public_sentiment_score": "REAL",
        "market_adp_overall": "REAL",
        "market_expert_rank_overall": "INTEGER",
        "market_archetype": "TEXT",
        "public_market_curve_value": "REAL",
        "public_market_weight": "REAL",
        "auction_cold_room": "REAL",
        "auction_base_value": "REAL",
        "auction_hot_room": "REAL",
    }
    for column_name, ddl_fragment in additions.items():
        ensure_column(conn, "player_upcoming_auction_value", column_name, ddl_fragment)


def load_latest_sentiment(conn, valuation_season):
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        """
        SELECT MAX(snapshot_ts_utc)
        FROM player_market_sentiment
        WHERE valuation_season = ?
        """,
        (valuation_season,),
    )
    snapshot_ts_utc = cur.fetchone()[0]
    if not snapshot_ts_utc:
        return {}, None

    cur.execute(
        """
        SELECT *
        FROM player_market_sentiment
        WHERE valuation_season = ?
          AND snapshot_ts_utc = ?
        """,
        (valuation_season, snapshot_ts_utc),
    )
    return {str(row["player_id"]): dict(row) for row in cur.fetchall()}, snapshot_ts_utc


def load_contract_anchors(conn, valuation_season):
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        """
        SELECT season, week
        FROM rosters_current
        WHERE season < ?
        GROUP BY season, week
        ORDER BY season DESC, week DESC
        LIMIT 1
        """
        ,
        (valuation_season,),
    )
    row = cur.fetchone()
    if not row:
        cur.execute(
            """
            SELECT season, week
            FROM rosters_current
            GROUP BY season, week
            ORDER BY season DESC, week DESC
            LIMIT 1
            """
        )
        row = cur.fetchone()
    season = row["season"] if row else None
    week = row["week"] if row else None
    season = coerce_int(season)
    week = coerce_int(week)
    if season is None or week is None:
        return {}, {"season": None, "week": None}

    cur.execute(
        """
        SELECT
            player_id,
            MAX(COALESCE(salary, 0)) AS salary,
            MAX(COALESCE(salary_yearplus1, 0)) AS salary_yearplus1,
            MAX(COALESCE(salary_yearplus2, 0)) AS salary_yearplus2
        FROM rosters_current
        WHERE season = ?
          AND week = ?
        GROUP BY player_id
        """,
        (season, week),
    )
    anchors = {}
    for row in cur.fetchall():
        vals = [
            coerce_float(row["salary"]) or 0.0,
            coerce_float(row["salary_yearplus1"]) or 0.0,
            coerce_float(row["salary_yearplus2"]) or 0.0,
        ]
        anchors[str(row["player_id"])] = max(vals)
    return anchors, {"season": season, "week": week}


def load_baseline_rows(conn, valuation_season):
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute(
        """
        SELECT *
        FROM player_upcoming_auction_value
        WHERE valuation_season = ?
        ORDER BY pos_group, player_name
        """,
        (valuation_season,),
    )
    rows = [dict(row) for row in cur.fetchall()]
    for row in rows:
        if coerce_float(row.get("pre_sentiment_auction_value")) is None:
            row["pre_sentiment_auction_value"] = coerce_float(row.get("upcoming_auction_value")) or 0.0
        if coerce_float(row.get("pre_sentiment_auction_value_low")) is None:
            row["pre_sentiment_auction_value_low"] = coerce_float(row.get("auction_value_low")) or 0.0
        if coerce_float(row.get("pre_sentiment_auction_value_high")) is None:
            row["pre_sentiment_auction_value_high"] = coerce_float(row.get("auction_value_high")) or 0.0
    return rows


def quantile(sorted_values, percentile):
    if not sorted_values:
        return 0.0
    p = clamp(coerce_float(percentile) or 0.0, 0.0, 1.0)
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    x = (len(sorted_values) - 1) * p
    left = int(math.floor(x))
    right = min(len(sorted_values) - 1, left + 1)
    frac = x - left
    return float(sorted_values[left]) * (1.0 - frac) + float(sorted_values[right]) * frac


def build_market_distributions(rows, contract_anchors):
    by_group = {}
    for row in rows:
        player_id = str(row["player_id"])
        pos_group = str(row.get("pos_group") or "UNK")
        pre_value = coerce_float(row.get("pre_sentiment_auction_value")) or 0.0
        contract_anchor = coerce_float(contract_anchors.get(player_id)) or 0.0
        recent_bid = coerce_float(row.get("historical_recent_auction_bid")) or 0.0
        market_anchor = max(pre_value, contract_anchor, recent_bid)
        by_group.setdefault(pos_group, []).append(market_anchor)

    for pos_group in by_group:
        by_group[pos_group].sort()
    return by_group


def market_archetype_label(sentiment_row):
    return str((sentiment_row or {}).get("market_archetype") or "").strip().lower()


def market_adp(sentiment_row):
    return coerce_float((sentiment_row or {}).get("adp_overall"))


def player_experience_years(row):
    return coerce_int(row.get("experience_years"))


def cornerstone_superflex_qb(row, sentiment_row):
    if str(row.get("pos_group") or "") != "QB" or not sentiment_row:
        return False
    archetype = market_archetype_label(sentiment_row)
    adp_overall = market_adp(sentiment_row)
    experience_years = player_experience_years(row)
    if "cornerstone superflex qb" in archetype:
        return True
    return adp_overall is not None and adp_overall <= 12.0 and (
        experience_years is None or experience_years >= 2
    )


def young_cornerstone_superflex_qb(row, sentiment_row):
    experience_years = player_experience_years(row)
    return cornerstone_superflex_qb(row, sentiment_row) and (
        experience_years is not None and experience_years <= 2
    )


def premium_superflex_qb(row, sentiment_row):
    if str(row.get("pos_group") or "") != "QB" or not sentiment_row:
        return False
    if cornerstone_superflex_qb(row, sentiment_row):
        return True
    adp_overall = market_adp(sentiment_row)
    return adp_overall is not None and adp_overall <= 24.0


def elite_alpha_wr(row, sentiment_row):
    return str(row.get("pos_group") or "") == "WR" and "elite alpha wr" in market_archetype_label(sentiment_row)


def elite_bellcow_rb(row, sentiment_row):
    return str(row.get("pos_group") or "") == "RB" and "elite bellcow rb" in market_archetype_label(sentiment_row)


def market_curve_percentile(row, sentiment_row):
    p = (coerce_float((sentiment_row or {}).get("public_sentiment_score")) or 0.0) / 100.0
    pos_group = str(row.get("pos_group") or "")
    adp_overall = market_adp(sentiment_row)

    if pos_group == "QB":
        if cornerstone_superflex_qb(row, sentiment_row):
            if young_cornerstone_superflex_qb(row, sentiment_row):
                if adp_overall is not None and adp_overall <= 3.0:
                    p = max(p, 0.978)
                elif adp_overall is not None and adp_overall <= 6.0:
                    p = max(p, 0.968)
                elif adp_overall is not None and adp_overall <= 12.0:
                    p = max(p, 0.955)
                p = min(0.988, p + 0.005)
            else:
                if adp_overall is not None and adp_overall <= 3.0:
                    p = max(p, 0.990)
                elif adp_overall is not None and adp_overall <= 6.0:
                    p = max(p, 0.982)
                elif adp_overall is not None and adp_overall <= 12.0:
                    p = max(p, 0.968)
                elif adp_overall is not None and adp_overall <= 18.0:
                    p = max(p, 0.950)
                p = min(0.996, p + 0.015)
        elif premium_superflex_qb(row, sentiment_row):
            p = min(0.982, p + 0.005)
            if (player_experience_years(row) or 99) <= 1:
                p = min(p, 0.925)

    elif pos_group == "WR":
        if elite_alpha_wr(row, sentiment_row):
            if adp_overall is not None and adp_overall <= 6.0:
                p = max(p, 0.980)
            elif adp_overall is not None and adp_overall <= 12.0:
                p = max(p, 0.968)
            elif adp_overall is not None and adp_overall <= 24.0:
                p = max(p, 0.952)
            p = min(0.990, p + 0.010)
        elif "breakout wr" in market_archetype_label(sentiment_row) and adp_overall is not None and adp_overall <= 60.0:
            p = min(0.955, p + 0.005)

    elif pos_group == "RB" and elite_bellcow_rb(row, sentiment_row):
        if adp_overall is not None and adp_overall <= 12.0:
            p = max(p, 0.972)
        elif adp_overall is not None and adp_overall <= 24.0:
            p = max(p, 0.942)
        p = min(0.988, p + 0.008)

    return clamp(p, 0.0, 0.996)


def market_anchor_discount(row, sentiment_row):
    if not sentiment_row:
        return 1.0

    pos_group = str(row.get("pos_group") or "")
    sentiment_pct = (coerce_float(sentiment_row.get("public_sentiment_score")) or 50.0) / 100.0
    adp_overall = market_adp(sentiment_row)
    experience_years = player_experience_years(row)

    if pos_group == "QB":
        if cornerstone_superflex_qb(row, sentiment_row):
            if young_cornerstone_superflex_qb(row, sentiment_row):
                return 0.86 if adp_overall is not None and adp_overall <= 6.0 else 0.82
            if adp_overall is not None and adp_overall <= 3.0:
                return 1.00
            if adp_overall is not None and adp_overall <= 6.0:
                return 0.98
            if adp_overall is not None and adp_overall <= 12.0:
                return 0.96
            return 0.93
        if premium_superflex_qb(row, sentiment_row):
            return 0.78 if (experience_years or 99) <= 1 else 0.84
        return clamp(0.58 + (0.22 * sentiment_pct), 0.55, 0.82)

    if pos_group == "WR":
        if elite_alpha_wr(row, sentiment_row):
            return 0.90
        if experience_years is not None and experience_years >= 7 and (adp_overall is None or adp_overall > 96.0):
            return clamp(0.52 + (0.26 * sentiment_pct), 0.52, 0.78)
        if experience_years is not None and experience_years >= 7:
            return clamp(0.66 + (0.16 * sentiment_pct), 0.66, 0.84)
        return clamp(0.72 + (0.12 * sentiment_pct), 0.72, 0.84)

    if pos_group == "RB":
        if elite_bellcow_rb(row, sentiment_row):
            return 0.92
        if experience_years is not None and experience_years >= 7 and (adp_overall is None or adp_overall > 120.0):
            return clamp(0.54 + (0.24 * sentiment_pct), 0.54, 0.80)
        return clamp(0.72 + (0.12 * sentiment_pct), 0.72, 0.86)

    return 1.0


def sentiment_weight(row, sentiment_row):
    if not sentiment_row:
        return 0.0
    weight = 0.16
    weight += 0.16 * (coerce_float(row.get("uncertainty_penalty")) or 0.0)
    weight += 0.10 * (coerce_float(row.get("small_sample_penalty")) or 0.0)
    rookie_or_unproven_penalty = coerce_float(row.get("rookie_or_unproven_penalty")) or 0.0
    if str(row.get("pos_group") or "") == "QB" and not cornerstone_superflex_qb(row, sentiment_row):
        weight += 0.04 * rookie_or_unproven_penalty
    else:
        weight += 0.10 * rookie_or_unproven_penalty
    weight += 0.10 * max(0.0, 1.0 - (coerce_float(row.get("latest_reliability_factor")) or 0.0))
    if sentiment_row.get("adp_overall") is not None:
        weight += 0.08
    if str(row.get("pos_group") or "") in {"QB", "RB", "WR", "TE"}:
        weight += 0.04
    if cornerstone_superflex_qb(row, sentiment_row):
        weight += 0.08
    elif premium_superflex_qb(row, sentiment_row):
        weight += 0.04
    return clamp(weight, 0.12, 0.58)


def base_keep_factor(row):
    factor = 0.92
    factor -= 0.12 * (coerce_float(row.get("rookie_or_unproven_penalty")) or 0.0)
    factor -= 0.10 * (coerce_float(row.get("small_sample_penalty")) or 0.0)
    factor -= 0.06 * (coerce_float(row.get("uncertainty_penalty")) or 0.0)
    return clamp(factor, 0.78, 0.92)


def elite_superflex_qb(row, sentiment_row):
    return cornerstone_superflex_qb(row, sentiment_row)


def compute_cold_room(row, sentiment_row, public_curve_value, contract_anchor):
    pos_group = str(row.get("pos_group") or "")
    recent_bid = coerce_float(row.get("historical_recent_auction_bid")) or 0.0
    anchor_discount = market_anchor_discount(row, sentiment_row)
    if elite_superflex_qb(row, sentiment_row):
        curve_floor = 0.80 if young_cornerstone_superflex_qb(row, sentiment_row) else 0.84
        return max(contract_anchor * anchor_discount, public_curve_value * curve_floor, recent_bid * 0.92 * anchor_discount)
    if pos_group == "QB":
        return max(contract_anchor * 0.75 * anchor_discount, public_curve_value * 0.56, recent_bid * 0.85 * anchor_discount)
    if pos_group in {"RB", "WR", "TE"}:
        return max(contract_anchor * 0.65 * anchor_discount, public_curve_value * 0.58, recent_bid * 0.85 * anchor_discount)
    return max(contract_anchor * 0.50, public_curve_value * 0.55, recent_bid * 0.80)


def compute_hot_room(row, sentiment_row, public_curve_value, contract_anchor, auction_base_value):
    pos_group = str(row.get("pos_group") or "")
    recent_bid = coerce_float(row.get("historical_recent_auction_bid")) or 0.0
    anchor_discount = market_anchor_discount(row, sentiment_row)
    curve_factor = 1.10 if pos_group == "QB" else 1.14
    contract_factor = 1.04 if elite_superflex_qb(row, sentiment_row) else 1.01
    return max(
        auction_base_value * 1.12,
        public_curve_value * curve_factor,
        contract_anchor * anchor_discount * contract_factor,
        recent_bid * 1.05 * anchor_discount,
    )


def confidence_with_sentiment(row, sentiment_row, public_curve_value):
    prior_conf = coerce_float(row.get("auction_confidence")) or 0.0
    if not sentiment_row:
        return clamp(prior_conf, 0.1, 0.97)

    coverage = 0.0
    if sentiment_row.get("adp_overall") is not None:
        coverage += 0.6
    if sentiment_row.get("expert_rank_overall") is not None:
        coverage += 0.4

    pre_value = coerce_float(row.get("pre_sentiment_auction_value")) or 1.0
    disagreement = abs(public_curve_value - pre_value) / max(pre_value, 1.0)
    updated = prior_conf + 0.05 * coverage - min(0.18, disagreement * 0.10)
    return clamp(updated, 0.15, 0.97)


def percentile_from_rank(rank, total):
    if total <= 1:
        return 1.0
    return 1.0 - ((float(rank) - 1.0) / float(total - 1))


def value_tier(percentile):
    p = coerce_float(percentile) or 0.0
    if p >= 0.95:
        return "elite"
    if p >= 0.90:
        return "core"
    if p >= 0.80:
        return "starter"
    if p >= 0.50:
        return "market_mid"
    return "fringe"


def update_tiers(rows):
    by_group = {}
    for row in rows:
        by_group.setdefault(str(row.get("pos_group") or "UNK"), []).append(row)

    for pos_group, group_rows in by_group.items():
        ordered = sorted(
            group_rows,
            key=lambda r: (
                -(coerce_float(r.get("auction_base_value")) or 0.0),
                r.get("player_name") or "",
            ),
        )
        total = len(ordered)
        for rank, row in enumerate(ordered, start=1):
            pct = percentile_from_rank(rank, total)
            row["auction_value_tier"] = value_tier(pct)


def rebuild_values(rows, sentiment_rows, sentiment_snapshot_ts_utc, contract_anchors, market_distributions):
    for row in rows:
        player_id = str(row["player_id"])
        sentiment_row = sentiment_rows.get(player_id)
        contract_anchor = coerce_float(contract_anchors.get(player_id)) or 0.0
        pre_value = coerce_float(row.get("pre_sentiment_auction_value")) or 0.0

        if sentiment_row:
            sentiment_score = (coerce_float(sentiment_row.get("public_sentiment_score")) or 0.0) / 100.0
            public_curve_value = quantile(
                market_distributions.get(str(row.get("pos_group") or "UNK"), []),
                market_curve_percentile(row, sentiment_row),
            )
            public_weight = sentiment_weight(row, sentiment_row)
            blended_value = ((1.0 - public_weight) * pre_value) + (public_weight * public_curve_value)
            downside_cap = pre_value * base_keep_factor(row)
            cold_room = compute_cold_room(row, sentiment_row, public_curve_value, contract_anchor)
            auction_base_value = max(blended_value, downside_cap, cold_room)
            adp_overall = market_adp(sentiment_row)
            if cornerstone_superflex_qb(row, sentiment_row):
                if young_cornerstone_superflex_qb(row, sentiment_row):
                    if adp_overall is not None and adp_overall <= 3.0:
                        elite_qb_curve_floor = 0.82
                    elif adp_overall is not None and adp_overall <= 6.0:
                        elite_qb_curve_floor = 0.78
                    else:
                        elite_qb_curve_floor = 0.74
                else:
                    if adp_overall is not None and adp_overall <= 3.0:
                        elite_qb_curve_floor = 0.92
                    elif adp_overall is not None and adp_overall <= 6.0:
                        elite_qb_curve_floor = 0.89
                    elif adp_overall is not None and adp_overall <= 12.0:
                        elite_qb_curve_floor = 0.86
                    else:
                        elite_qb_curve_floor = 0.83
                auction_base_value = max(auction_base_value, public_curve_value * elite_qb_curve_floor)
            hot_room = compute_hot_room(row, sentiment_row, public_curve_value, contract_anchor, auction_base_value)
            auction_confidence = confidence_with_sentiment(row, sentiment_row, public_curve_value)
        else:
            public_curve_value = None
            public_weight = 0.0
            pos_group = str(row.get("pos_group") or "")
            recent_bid = coerce_float(row.get("historical_recent_auction_bid")) or 0.0
            if pos_group == "QB":
                cold_room = max(contract_anchor * 0.75, pre_value * 0.85, recent_bid * 0.85)
            elif pos_group in {"RB", "WR", "TE"}:
                cold_room = max(contract_anchor * 0.65, pre_value * 0.82, recent_bid * 0.80)
            else:
                cold_room = max(contract_anchor * 0.50, pre_value * 0.80, recent_bid * 0.75)
            cold_room = min(cold_room, pre_value)
            auction_base_value = pre_value
            hot_room = max(coerce_float(row.get("pre_sentiment_auction_value_high")) or pre_value, pre_value * 1.12)
            auction_confidence = clamp(coerce_float(row.get("auction_confidence")) or 0.0, 0.15, 0.97)

        row["market_sentiment_snapshot_ts_utc"] = sentiment_snapshot_ts_utc
        row["market_public_sentiment_score"] = coerce_float(sentiment_row.get("public_sentiment_score")) if sentiment_row else None
        row["market_adp_overall"] = coerce_float(sentiment_row.get("adp_overall")) if sentiment_row else None
        row["market_expert_rank_overall"] = coerce_int(sentiment_row.get("expert_rank_overall")) if sentiment_row else None
        row["market_archetype"] = sentiment_row.get("market_archetype") if sentiment_row else None
        row["public_market_curve_value"] = public_curve_value
        row["public_market_weight"] = public_weight
        row["auction_cold_room"] = cold_room
        row["auction_base_value"] = auction_base_value
        row["auction_hot_room"] = hot_room

        row["upcoming_auction_value"] = auction_base_value
        row["auction_value_low"] = cold_room
        row["auction_value_high"] = hot_room
        row["auction_confidence"] = auction_confidence

    update_tiers(rows)
    return rows


def persist_rows(conn, rows):
    cur = conn.cursor()
    cur.executemany(
        """
        UPDATE player_upcoming_auction_value
        SET
            pre_sentiment_auction_value = :pre_sentiment_auction_value,
            pre_sentiment_auction_value_low = :pre_sentiment_auction_value_low,
            pre_sentiment_auction_value_high = :pre_sentiment_auction_value_high,
            market_sentiment_snapshot_ts_utc = :market_sentiment_snapshot_ts_utc,
            market_public_sentiment_score = :market_public_sentiment_score,
            market_adp_overall = :market_adp_overall,
            market_expert_rank_overall = :market_expert_rank_overall,
            market_archetype = :market_archetype,
            public_market_curve_value = :public_market_curve_value,
            public_market_weight = :public_market_weight,
            auction_cold_room = :auction_cold_room,
            auction_base_value = :auction_base_value,
            auction_hot_room = :auction_hot_room,
            upcoming_auction_value = :upcoming_auction_value,
            auction_value_low = :auction_value_low,
            auction_value_high = :auction_value_high,
            auction_confidence = :auction_confidence,
            auction_value_tier = :auction_value_tier
        WHERE valuation_season = :valuation_season
          AND player_id = :player_id
        """,
        rows,
    )
    conn.commit()


def export_full_csv(path, rows):
    if not rows:
        return
    headers = list(rows[0].keys())
    write_csv(path, rows, headers)


def export_summary_csv(path, rows):
    summary = []
    by_group = {}
    for row in rows:
        by_group.setdefault(str(row.get("pos_group") or "UNK"), []).append(row)
    for pos_group, group_rows in sorted(by_group.items()):
        vals = [coerce_float(r.get("auction_base_value")) or 0.0 for r in group_rows]
        cold = [coerce_float(r.get("auction_cold_room")) or 0.0 for r in group_rows]
        hot = [coerce_float(r.get("auction_hot_room")) or 0.0 for r in group_rows]
        summary.append(
            {
                "pos_group": pos_group,
                "players": len(group_rows),
                "avg_cold_room": round(sum(cold) / len(cold), 3),
                "avg_base": round(sum(vals) / len(vals), 3),
                "avg_hot_room": round(sum(hot) / len(hot), 3),
                "max_base": round(max(vals), 3),
                "min_base": round(min(vals), 3),
            }
        )
    write_csv(
        path,
        summary,
        ["pos_group", "players", "avg_cold_room", "avg_base", "avg_hot_room", "min_base", "max_base"],
    )


def export_topn_csv(path, rows, topn):
    ordered = sorted(
        rows,
        key=lambda r: (
            -(coerce_float(r.get("auction_base_value")) or 0.0),
            r.get("player_name") or "",
        ),
    )[:topn]
    out = []
    for idx, row in enumerate(ordered, start=1):
        out.append(
            {
                "rank": idx,
                "player_name": row.get("player_name"),
                "position": row.get("position"),
                "pos_group": row.get("pos_group"),
                "team": row.get("team"),
                "cold_room": round_nearest_1000(row.get("auction_cold_room")),
                "base": round_nearest_1000(row.get("auction_base_value")),
                "hot_room": round_nearest_1000(row.get("auction_hot_room")),
            }
        )
    write_csv(path, out, ["rank", "player_name", "position", "pos_group", "team", "cold_room", "base", "hot_room"])


def validate(rows):
    out = {
        "players": len(rows),
        "null_cold_room": 0,
        "null_base": 0,
        "null_hot_room": 0,
        "base_lt_cold": 0,
        "hot_lt_base": 0,
    }
    for row in rows:
        cold = coerce_float(row.get("auction_cold_room"))
        base = coerce_float(row.get("auction_base_value"))
        hot = coerce_float(row.get("auction_hot_room"))
        if cold is None:
            out["null_cold_room"] += 1
        if base is None:
            out["null_base"] += 1
        if hot is None:
            out["null_hot_room"] += 1
        if cold is not None and base is not None and base + 1e-9 < cold:
            out["base_lt_cold"] += 1
        if hot is not None and base is not None and hot + 1e-9 < base:
            out["hot_lt_base"] += 1
    return out


def main():
    args = parse_args()
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(args.db_path)
    ensure_table_columns(conn)

    baseline_rows = load_baseline_rows(conn, args.valuation_season)
    if not baseline_rows:
        raise SystemExit(f"No player_upcoming_auction_value rows found for season {args.valuation_season}")

    sentiment_rows, sentiment_snapshot_ts_utc = load_latest_sentiment(conn, args.valuation_season)
    if not sentiment_snapshot_ts_utc:
        raise SystemExit(f"No player_market_sentiment snapshot found for season {args.valuation_season}")

    contract_anchors, contract_meta = load_contract_anchors(conn, args.valuation_season)
    market_distributions = build_market_distributions(baseline_rows, contract_anchors)
    rebuilt_rows = rebuild_values(
        baseline_rows,
        sentiment_rows,
        sentiment_snapshot_ts_utc,
        contract_anchors,
        market_distributions,
    )
    persist_rows(conn, rebuilt_rows)

    export_full_csv(LOG_DIR / "player_upcoming_auction_value.csv", rebuilt_rows)
    export_summary_csv(LOG_DIR / "player_upcoming_auction_value_summary.csv", rebuilt_rows)
    export_topn_csv(LOG_DIR / "player_upcoming_auction_value_top100_bases.csv", rebuilt_rows, args.topn)

    validation = validate(rebuilt_rows)
    run_log = {
        "built_at_utc": now_utc(),
        "db_path": args.db_path,
        "valuation_season": args.valuation_season,
        "sentiment_snapshot_ts_utc": sentiment_snapshot_ts_utc,
        "contract_anchor_season": contract_meta.get("season"),
        "contract_anchor_week": contract_meta.get("week"),
        "rows": len(rebuilt_rows),
        "sentiment_rows_used": len(sentiment_rows),
        "validation": validation,
        "formula": {
            "public_market_curve": "position-group quantile of max(pre_sentiment_value, contract_anchor, recent_auction_bid) at a tail-adjusted market percentile for premium QB/WR/RB archetypes",
            "base_value": "max(weighted blend of pre-sentiment value and public market curve, downside cap, cold room, plus a curve floor for cornerstone superflex QBs)",
            "cold_room": "contract-aware room floor with stale-anchor discounts for weak-market veterans and non-cornerstone QBs",
            "hot_room": "max(base*1.12, market curve premium, discounted contract premium, discounted recent auction premium)",
        },
    }
    append_jsonl(LOG_DIR / "player_upcoming_auction_value_run_log.jsonl", run_log)

    print(
        f"Rebuilt player_upcoming_auction_value for season {args.valuation_season} "
        f"using sentiment snapshot {sentiment_snapshot_ts_utc}: {len(rebuilt_rows)} rows."
    )
    print(f"Artifacts: {LOG_DIR / 'player_upcoming_auction_value.csv'}")
    print(f"Artifacts: {LOG_DIR / 'player_upcoming_auction_value_summary.csv'}")
    print(f"Artifacts: {LOG_DIR / 'player_upcoming_auction_value_top100_bases.csv'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
