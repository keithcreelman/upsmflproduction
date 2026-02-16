#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
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


# User-provided Superflex QB ADP reference (2023-2025).
SUPERFLEX_QB_ADP = {
    2023: [
        ("Patrick Mahomes", "QB1", 1.4),
        ("Josh Allen", "QB2", 2.5),
        ("Jalen Hurts", "QB3", 3.4),
        ("Joe Burrow", "QB4", 6.5),
        ("Lamar Jackson", "QB5", 8.6),
        ("Justin Herbert", "QB6", 11.3),
        ("Justin Fields", "QB7", 13.3),
        ("Trevor Lawrence", "QB8", 19.1),
        ("Dak Prescott", "QB9", 26.2),
        ("Aaron Rodgers", "QB10", 28.6),
        ("Tua Tagovailoa", "QB11", 32.4),
        ("Kirk Cousins", "QB12", 36.2),
        ("Daniel Jones", "QB13", 42.4),
        ("Deshaun Watson", "QB14", 42.9),
        ("Russell Wilson", "QB15", 51.3),
        ("Jared Goff", "QB16", 51.7),
        ("Anthony Richardson Sr.", "QB17", 54.8),
        ("Derek Carr", "QB18", 63.5),
        ("Geno Smith", "QB19", 66.5),
        ("Kyler Murray", "QB20", 68.2),
        ("Matthew Stafford", "QB21", 79.1),
        ("Kenny Pickett", "QB22", 100.2),
        ("Brock Purdy", "QB23", 105.4),
        ("Jimmy Garoppolo", "QB24", 110.6),
        ("Jordan Love", "QB25", 114.0),
        ("Sam Howell", "QB26", 121.9),
        ("Ryan Tannehill", "QB27", 129.9),
        ("Desmond Ridder", "QB28", 129.9),
        ("Mac Jones", "QB29", 131.5),
        ("Bryce Young", "QB30", 133.1),
    ],
    2024: [
        ("Josh Allen", "QB1", 1.6),
        ("Jalen Hurts", "QB2", 1.9),
        ("Patrick Mahomes", "QB3", 3.9),
        ("Lamar Jackson", "QB4", 4.2),
        ("C.J. Stroud", "QB5", 6.3),
        ("Anthony Richardson Sr.", "QB6", 8.7),
        ("Joe Burrow", "QB7", 9.6),
        ("Jordan Love", "QB8", 12.3),
        ("Dak Prescott", "QB9", 14.6),
        ("Kyler Murray", "QB10", 15.6),
        ("Tua Tagovailoa", "QB11", 16.5),
        ("Justin Herbert", "QB12", 22.2),
        ("Caleb Williams", "QB13", 25.6),
        ("Matthew Stafford", "QB14", 28.2),
        ("Aaron Rodgers", "QB15", 31.5),
        ("Kirk Cousins", "QB16", 32.1),
        ("Jayden Daniels", "QB17", 32.6),
        ("Deshaun Watson", "QB18", 41.6),
        ("Baker Mayfield", "QB19", 45.0),
        ("Geno Smith", "QB20", 50.6),
        ("Will Levis", "QB21", 56.8),
        ("Jared Goff", "QB22", 64.0),
        ("Brock Purdy", "QB23", 65.6),
        ("Derek Carr", "QB24", 71.8),
        ("Russell Wilson", "QB25", 81.1),
        ("Trevor Lawrence", "QB26", 81.2),
        ("Bryce Young", "QB27", 94.8),
        ("Daniel Jones", "QB28", 98.8),
        ("Bo Nix", "QB29", 104.9),
        ("Gardner Minshew", "QB30", 113.4),
        ("Justin Fields", "QB31", 127.7),
        ("Sam Darnold", "QB32", 132.2),
        ("Jacoby Brissett", "QB33", 139.7),
        ("Drake Maye", "QB34", 142.2),
        ("Taysom Hill", "QB35", 152.1),
    ],
    2025: [
        ("Lamar Jackson", "QB1", 1.7),
        ("Josh Allen", "QB2", 1.9),
        ("Joe Burrow", "QB3", 3.4),
        ("Jayden Daniels", "QB4", 4.0),
        ("Jalen Hurts", "QB5", 5.7),
        ("Patrick Mahomes", "QB6", 9.6),
        ("Baker Mayfield", "QB7", 10.4),
        ("Bo Nix", "QB8", 15.8),
        ("Brock Purdy", "QB9", 18.0),
        ("Dak Prescott", "QB10", 23.3),
        ("Kyler Murray", "QB11", 23.8),
        ("Jared Goff", "QB12", 31.0),
        ("Caleb Williams", "QB13", 31.9),
        ("J.J. McCarthy", "QB14", 37.4),
        ("Drake Maye", "QB15", 40.0),
        ("Justin Fields", "QB16", 42.2),
        ("Justin Herbert", "QB17", 43.2),
        ("Jordan Love", "QB18", 48.2),
        ("Trevor Lawrence", "QB19", 50.8),
        ("C.J. Stroud", "QB20", 53.2),
        ("Tua Tagovailoa", "QB21", 65.0),
        ("Geno Smith", "QB22", 69.7),
        ("Matthew Stafford", "QB23", 78.5),
        ("Bryce Young", "QB24", 83.1),
        ("Michael Penix Jr.", "QB25", 83.3),
        ("Sam Darnold", "QB26", 98.2),
        ("Cam Ward", "QB27", 100.1),
        ("Aaron Rodgers", "QB28", 113.9),
        ("Daniel Jones", "QB29", 130.1),
        ("Russell Wilson", "QB30", 134.1),
        ("Joe Flacco", "QB31", 136.9),
        ("Jaxson Dart", "QB32", 137.0),
        ("Anthony Richardson Sr.", "QB33", 140.7),
    ],
}


def parse_args():
    parser = argparse.ArgumentParser(
        description="Build ADP + Superflex normalized auction value model (V1)."
    )
    parser.add_argument("--db-path", default=DB_DEFAULT)
    parser.add_argument("--start-year", type=int, default=2011)
    parser.add_argument("--end-year", type=int, default=None)
    parser.add_argument("--current-season", type=int, default=None)
    parser.add_argument("--historical-period", default="AUG1")
    parser.add_argument("--current-period", default="AUG1")
    parser.add_argument("--fallback-period", default="ALL")
    parser.add_argument("--fcount", type=int, default=12)
    parser.add_argument("--is-ppr", type=int, default=-1)
    parser.add_argument("--is-keeper", default="N")
    parser.add_argument("--superflex-start-year", type=int, default=2023)
    parser.add_argument("--cap-start", type=float, default=300000.0)
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


def normalize_name_key(name):
    if not name:
        return ""
    s = str(name).strip().lower()
    s = s.replace(",", " ")
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    toks = [t for t in s.split() if t]
    suffixes = {"jr", "sr", "ii", "iii", "iv", "v"}
    while toks and toks[-1] in suffixes:
        toks.pop()
    return "".join(toks)


def to_first_last(name):
    if not name:
        return ""
    s = str(name).strip()
    if "," not in s:
        return s
    last, first = s.split(",", 1)
    return f"{first.strip()} {last.strip()}".strip()


def is_idp_position(position):
    if not position:
        return False
    p = str(position).strip().upper()
    idp_positions = {
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
    return p in idp_positions


def ensure_tables(conn):
    cur = conn.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS adp_mfl_history (
            season INTEGER NOT NULL,
            league_id TEXT,
            requested_period TEXT NOT NULL,
            used_period TEXT NOT NULL,
            fallback_used INTEGER NOT NULL DEFAULT 0,
            fetched_at_utc TEXT NOT NULL,
            source_url TEXT NOT NULL,
            dataset_timestamp TEXT,
            total_drafts INTEGER,
            total_picks INTEGER,
            player_id TEXT NOT NULL,
            rank INTEGER,
            drafts_selected_in INTEGER,
            average_pick REAL,
            draft_sel_pct REAL,
            min_pick INTEGER,
            max_pick INTEGER,
            PRIMARY KEY (season, player_id, used_period)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS adp_superflex_qb_ref (
            season INTEGER NOT NULL,
            sf_rank INTEGER NOT NULL,
            player_name TEXT NOT NULL,
            qb_rank TEXT,
            sf_adp REAL NOT NULL,
            player_id TEXT,
            matched_player_name TEXT,
            PRIMARY KEY (season, sf_rank)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS adp_normalized_values (
            season INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            nfl_team TEXT,
            mfl_rank INTEGER,
            mfl_average_pick REAL,
            normalized_adp REAL,
            normalization_source TEXT,
            superflex_source_adp REAL,
            qb_scale_factor REAL,
            adp_period_used TEXT,
            PRIMARY KEY (season, player_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS auction_player_value_model_v1 (
            season INTEGER NOT NULL,
            player_id TEXT NOT NULL,
            player_name TEXT,
            position TEXT,
            nfl_team TEXT,
            available_in_auction INTEGER NOT NULL DEFAULT 1,
            won_ind INTEGER NOT NULL DEFAULT 0,
            winner_franchise_id TEXT,
            winner_team_name TEXT,
            winning_bid INTEGER,
            first_bid_ts INTEGER,
            first_bid_datetime TEXT,
            last_cut_ts INTEGER,
            last_cut_datetime TEXT,
            auction_window TEXT,
            last_move_before_first_bid TEXT,
            last_move_method_before_first_bid TEXT,
            normalized_adp REAL,
            mfl_average_pick REAL,
            normalization_source TEXT,
            weight REAL,
            perceived_value_from_spend REAL,
            value_delta_vs_winning_bid REAL,
            winning_bid_to_value_ratio REAL,
            PRIMARY KEY (season, player_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS auction_value_summary_v1 (
            season INTEGER PRIMARY KEY,
            first_bid_ts INTEGER,
            first_bid_datetime TEXT,
            last_cut_ts INTEGER,
            last_cut_datetime TEXT,
            auction_window TEXT,
            auction_players_count INTEGER,
            auction_winners_count INTEGER,
            adp_matched_count INTEGER,
            total_winning_spend INTEGER,
            value_pool_used INTEGER,
            cap_per_team REAL,
            team_count INTEGER,
            total_league_cap REAL,
            spend_pct_of_league_cap REAL,
            notes TEXT
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS auction_team_budget_proxy_v1 (
            season INTEGER NOT NULL,
            franchise_id TEXT NOT NULL,
            team_name TEXT,
            cap_start REAL,
            prior_season INTEGER,
            prior_end_week INTEGER,
            prior_end_salary INTEGER,
            proxy_cap_space_before_txn REAL,
            freeagent_winning_spend INTEGER,
            proxy_cap_space_after_freeagent_auction REAL,
            PRIMARY KEY (season, franchise_id)
        )
        """
    )
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS auction_value_topn_summary_v1 (
            season INTEGER PRIMARY KEY,
            top5_count INTEGER,
            top5_winning_bid_sum INTEGER,
            top5_perceived_value_sum REAL,
            top5_value_delta REAL,
            top10_count INTEGER,
            top10_winning_bid_sum INTEGER,
            top10_perceived_value_sum REAL,
            top10_value_delta REAL,
            top25_count INTEGER,
            top25_winning_bid_sum INTEGER,
            top25_perceived_value_sum REAL,
            top25_value_delta REAL,
            top50_count INTEGER,
            top50_winning_bid_sum INTEGER,
            top50_perceived_value_sum REAL,
            top50_value_delta REAL,
            top100_count INTEGER,
            top100_winning_bid_sum INTEGER,
            top100_perceived_value_sum REAL,
            top100_value_delta REAL,
            all_count INTEGER,
            all_winning_bid_sum INTEGER,
            all_perceived_value_sum REAL,
            all_value_delta REAL,
            sf_count INTEGER,
            sf_winning_bid_sum INTEGER,
            sf_perceived_value_sum REAL,
            sf_value_delta REAL,
            idp_count INTEGER,
            idp_winning_bid_sum INTEGER,
            idp_perceived_value_sum REAL,
            idp_value_delta REAL,
            non_idp_count INTEGER,
            non_idp_winning_bid_sum INTEGER,
            non_idp_perceived_value_sum REAL,
            non_idp_value_delta REAL
        )
        """
    )
    conn.commit()


def clear_existing(conn, seasons):
    if not seasons:
        return
    cur = conn.cursor()
    qmarks = ",".join(["?"] * len(seasons))
    for table in (
        "adp_mfl_history",
        "adp_superflex_qb_ref",
        "adp_normalized_values",
        "auction_player_value_model_v1",
        "auction_value_summary_v1",
        "auction_team_budget_proxy_v1",
        "auction_value_topn_summary_v1",
    ):
        cur.execute(f"DELETE FROM {table} WHERE season IN ({qmarks})", seasons)
    conn.commit()


def get_target_seasons(conn, start_year, end_year):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT season, league_id, base_url
        FROM metadata_leaguedetails
        WHERE uses_salaries = 1
          AND season >= ?
        ORDER BY season
        """,
        (start_year,),
    )
    rows = []
    for season, league_id, base_url in cur.fetchall():
        if end_year is not None and int(season) > end_year:
            continue
        rows.append(
            {
                "season": int(season),
                "league_id": str(league_id) if league_id is not None else None,
                "base_url": base_url,
            }
        )
    return rows


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
    query = urllib.parse.urlencode(params)
    return f"{API_BASE}/{season}/export?{query}"


def fetch_adp_xml(season, period, fcount, is_ppr, is_keeper, timeout=30):
    url = build_adp_url(season, period, fcount, is_ppr, is_keeper)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "codex-adp-loader/1.0",
            "Accept": "application/xml,text/xml,*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        payload = resp.read()
    root = ET.fromstring(payload)
    if root.tag.lower() != "adp":
        raise RuntimeError(f"Unexpected root tag for season {season}: {root.tag}")
    meta = {
        "dataset_timestamp": root.attrib.get("timestamp"),
        "total_drafts": coerce_int(root.attrib.get("totalDrafts")),
        "total_picks": coerce_int(root.attrib.get("totalPicks")),
        "source_url": url,
    }
    players = []
    for node in root.findall("player"):
        players.append(
            {
                "player_id": str(node.attrib.get("id") or "").strip(),
                "rank": coerce_int(node.attrib.get("rank")),
                "drafts_selected_in": coerce_int(node.attrib.get("draftsSelectedIn")),
                "average_pick": coerce_float(node.attrib.get("averagePick")),
                "draft_sel_pct": coerce_float(node.attrib.get("draftSelPct")),
                "min_pick": coerce_int(node.attrib.get("minPick")),
                "max_pick": coerce_int(node.attrib.get("maxPick")),
            }
        )
    players = [p for p in players if p["player_id"]]
    return meta, players


def load_players_index(conn, seasons):
    if not seasons:
        return {}, {}, {}
    season_min, season_max = min(seasons), max(seasons)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT season, player_id, name, position, nfl_team
        FROM players
        WHERE season BETWEEN ? AND ?
        """,
        (season_min, season_max),
    )
    by_season_pid = {}
    by_season_name = defaultdict(dict)
    by_season_position = defaultdict(lambda: defaultdict(list))
    for season, player_id, name, position, nfl_team in cur.fetchall():
        season = int(season)
        pid = str(player_id)
        rec = {
            "season": season,
            "player_id": pid,
            "name": name,
            "position": position,
            "nfl_team": nfl_team,
        }
        by_season_pid[(season, pid)] = rec
        key_a = normalize_name_key(to_first_last(name))
        key_b = normalize_name_key(name)
        if key_a and key_a not in by_season_name[season]:
            by_season_name[season][key_a] = rec
        if key_b and key_b not in by_season_name[season]:
            by_season_name[season][key_b] = rec
        if position:
            by_season_position[season][position].append(rec)
    return by_season_pid, by_season_name, by_season_position


def materialize_superflex_ref(by_season_name):
    rows = []
    by_season_pid = defaultdict(dict)
    for season, vals in SUPERFLEX_QB_ADP.items():
        for idx, (player_name, qb_rank, sf_adp) in enumerate(vals, start=1):
            key = normalize_name_key(player_name)
            match = by_season_name.get(season, {}).get(key)
            player_id = None
            matched_name = None
            if match:
                player_id = match["player_id"]
                matched_name = match["name"]
                by_season_pid[season][player_id] = sf_adp
            rows.append(
                {
                    "season": season,
                    "sf_rank": idx,
                    "player_name": player_name,
                    "qb_rank": qb_rank,
                    "sf_adp": sf_adp,
                    "player_id": player_id,
                    "matched_player_name": matched_name,
                }
            )
    return rows, by_season_pid


def get_first_freeagent_bid(conn, season):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT unix_timestamp, datetime_et
        FROM transactions_auction
        WHERE season = ?
          AND auction_type = 'FreeAgent'
          AND substr(date_et, 6, 2) IN ('07', '08')
        ORDER BY unix_timestamp, txn_index
        LIMIT 1
        """,
        (season,),
    )
    row = cur.fetchone()
    if row:
        return row[0], row[1], "JUL_AUG"
    cur.execute(
        """
        SELECT unix_timestamp, datetime_et
        FROM transactions_auction
        WHERE season = ?
          AND auction_type = 'FreeAgent'
        ORDER BY unix_timestamp, txn_index
        LIMIT 1
        """,
        (season,),
    )
    row = cur.fetchone()
    if row:
        return row[0], row[1], "ALL_FREEAGENT"
    return None, None, None


def get_last_cut_before(conn, season, first_bid_ts):
    if first_bid_ts is None:
        return None, None
    cur = conn.cursor()
    cur.execute(
        """
        SELECT unix_timestamp, datetime_et
        FROM transactions_adddrop
        WHERE season = ?
          AND move_type = 'DROP'
          AND unix_timestamp < ?
        ORDER BY unix_timestamp DESC, txn_index DESC
        LIMIT 1
        """,
        (season, first_bid_ts),
    )
    row = cur.fetchone()
    if not row:
        return None, None
    return row[0], row[1]


def fetch_freeagent_window_rows(conn, season, first_bid_ts, auction_window):
    if first_bid_ts is None:
        return []
    cur = conn.cursor()
    if auction_window == "JUL_AUG":
        cur.execute(
            """
            SELECT
                player_id,
                player_name,
                position,
                nfl_team,
                franchise_id,
                team_name,
                bid_amount,
                bid_sequence,
                finalbid_ind,
                unix_timestamp
            FROM transactions_auction
            WHERE season = ?
              AND auction_type = 'FreeAgent'
              AND unix_timestamp >= ?
              AND substr(date_et, 6, 2) IN ('07', '08')
            ORDER BY player_id, bid_sequence, txn_index
            """,
            (season, first_bid_ts),
        )
    else:
        cur.execute(
            """
            SELECT
                player_id,
                player_name,
                position,
                nfl_team,
                franchise_id,
                team_name,
                bid_amount,
                bid_sequence,
                finalbid_ind,
                unix_timestamp
            FROM transactions_auction
            WHERE season = ?
              AND auction_type = 'FreeAgent'
              AND unix_timestamp >= ?
            ORDER BY player_id, bid_sequence, txn_index
            """,
            (season, first_bid_ts),
        )
    out = []
    for r in cur.fetchall():
        out.append(
            {
                "player_id": str(r[0]),
                "player_name": r[1],
                "position": r[2],
                "nfl_team": r[3],
                "franchise_id": r[4],
                "team_name": r[5],
                "bid_amount": coerce_int(r[6]),
                "bid_sequence": coerce_int(r[7]) or 0,
                "finalbid_ind": coerce_int(r[8]) or 0,
                "unix_timestamp": coerce_int(r[9]),
            }
        )
    return out


def build_last_move_map(conn, season, first_bid_ts):
    if first_bid_ts is None:
        return {}
    cur = conn.cursor()
    cur.execute(
        """
        SELECT player_id, move_type, method, unix_timestamp, txn_index
        FROM transactions_adddrop
        WHERE season = ?
          AND unix_timestamp < ?
        ORDER BY unix_timestamp, txn_index
        """,
        (season, first_bid_ts),
    )
    latest = {}
    for player_id, move_type, method, unix_ts, _txn_index in cur.fetchall():
        latest[str(player_id)] = {
            "move_type": move_type,
            "method": method,
            "unix_timestamp": unix_ts,
        }
    return latest


def build_auction_pool(rows):
    per_player = {}
    for r in rows:
        pid = r["player_id"]
        rec = per_player.setdefault(
            pid,
            {
                "player_id": pid,
                "player_name": r["player_name"],
                "position": r["position"],
                "nfl_team": r["nfl_team"],
                "won_ind": 0,
                "winner_franchise_id": None,
                "winner_team_name": None,
                "winning_bid": None,
                "max_final_bid_sequence": -1,
            },
        )
        if r["finalbid_ind"] == 1:
            seq = r["bid_sequence"] if r["bid_sequence"] is not None else -1
            if seq >= rec["max_final_bid_sequence"]:
                rec["max_final_bid_sequence"] = seq
                rec["won_ind"] = 1
                rec["winner_franchise_id"] = r["franchise_id"]
                rec["winner_team_name"] = r["team_name"]
                rec["winning_bid"] = r["bid_amount"]
    for rec in per_player.values():
        rec.pop("max_final_bid_sequence", None)
    return per_player


def get_cap_and_team_count(conn, season, cap_default):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT salary_cap_amount
        FROM metadata_leaguedetails
        WHERE season = ?
        LIMIT 1
        """,
        (season,),
    )
    row = cur.fetchone()
    cap = coerce_float(row[0]) if row else None
    if cap is None:
        cap = cap_default

    cur.execute(
        """
        SELECT COUNT(DISTINCT franchise_id)
        FROM franchises
        WHERE season = ?
        """,
        (season,),
    )
    team_count = coerce_int(cur.fetchone()[0]) or 0
    return cap, team_count


def get_team_names(conn, season):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT franchise_id, MAX(team_name) AS team_name
        FROM franchises
        WHERE season = ?
        GROUP BY franchise_id
        """,
        (season,),
    )
    out = {}
    for fid, team_name in cur.fetchall():
        out[str(fid)] = team_name
    return out


def get_prior_end_salary_by_team(conn, season):
    prior = season - 1
    cur = conn.cursor()
    cur.execute(
        "SELECT MAX(week) FROM rosters_weekly WHERE season = ?",
        (prior,),
    )
    w = cur.fetchone()
    if not w or w[0] is None:
        return prior, None, {}
    prior_end_week = int(w[0])
    cur.execute(
        """
        SELECT franchise_id, SUM(COALESCE(salary, 0)) AS total_salary
        FROM rosters_weekly
        WHERE season = ?
          AND week = ?
        GROUP BY franchise_id
        """,
        (prior, prior_end_week),
    )
    salaries = {}
    for fid, total_salary in cur.fetchall():
        salaries[str(fid)] = coerce_int(total_salary) or 0
    return prior, prior_end_week, salaries


def write_csv(path, rows, headers):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=headers)
        w.writeheader()
        for row in rows:
            w.writerow(row)


def main():
    args = parse_args()
    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    ensure_tables(conn)

    season_meta = get_target_seasons(conn, args.start_year, args.end_year)
    if not season_meta:
        raise RuntimeError("No seasons found for the requested range.")
    seasons = [r["season"] for r in season_meta]
    current_season = args.current_season if args.current_season else max(seasons)
    clear_existing(conn, seasons)

    by_season_pid, by_season_name, _by_season_position = load_players_index(conn, seasons)

    fetched_rows = []
    fetch_summary = []
    fetched_at = now_utc()
    for sm in season_meta:
        season = sm["season"]
        requested_period = args.current_period if season == current_season else args.historical_period
        used_period = requested_period
        fallback_used = 0

        meta, adp_rows = fetch_adp_xml(
            season,
            requested_period,
            args.fcount,
            args.is_ppr,
            args.is_keeper,
        )
        if (
            season != current_season
            and requested_period != args.fallback_period
            and len(adp_rows) == 0
        ):
            meta_fb, adp_rows_fb = fetch_adp_xml(
                season,
                args.fallback_period,
                args.fcount,
                args.is_ppr,
                args.is_keeper,
            )
            if len(adp_rows_fb) > 0:
                used_period = args.fallback_period
                fallback_used = 1
                meta, adp_rows = meta_fb, adp_rows_fb

        fetch_summary.append(
            {
                "season": season,
                "league_id": sm["league_id"],
                "requested_period": requested_period,
                "used_period": used_period,
                "fallback_used": fallback_used,
                "players_fetched": len(adp_rows),
                "total_drafts": meta.get("total_drafts"),
                "total_picks": meta.get("total_picks"),
            }
        )

        for p in adp_rows:
            fetched_rows.append(
                (
                    season,
                    sm["league_id"],
                    requested_period,
                    used_period,
                    fallback_used,
                    fetched_at,
                    meta["source_url"],
                    meta.get("dataset_timestamp"),
                    meta.get("total_drafts"),
                    meta.get("total_picks"),
                    p["player_id"],
                    p["rank"],
                    p["drafts_selected_in"],
                    p["average_pick"],
                    p["draft_sel_pct"],
                    p["min_pick"],
                    p["max_pick"],
                )
            )

    cur = conn.cursor()
    cur.executemany(
        """
        INSERT INTO adp_mfl_history (
            season, league_id, requested_period, used_period, fallback_used, fetched_at_utc,
            source_url, dataset_timestamp, total_drafts, total_picks, player_id, rank,
            drafts_selected_in, average_pick, draft_sel_pct, min_pick, max_pick
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        fetched_rows,
    )
    conn.commit()

    sf_rows, sf_by_season_pid = materialize_superflex_ref(by_season_name)
    cur.executemany(
        """
        INSERT INTO adp_superflex_qb_ref (
            season, sf_rank, player_name, qb_rank, sf_adp, player_id, matched_player_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                r["season"],
                r["sf_rank"],
                r["player_name"],
                r["qb_rank"],
                r["sf_adp"],
                r["player_id"],
                r["matched_player_name"],
            )
            for r in sf_rows
            if r["season"] in seasons
        ],
    )
    conn.commit()

    cur.execute(
        """
        SELECT season, player_id, rank, average_pick, used_period
        FROM adp_mfl_history
        WHERE season BETWEEN ? AND ?
        """,
        (min(seasons), max(seasons)),
    )
    mfl_rows = cur.fetchall()

    mfl_by_season_pid = defaultdict(dict)
    mfl_period_by_season = {}
    for r in mfl_rows:
        season = int(r["season"])
        pid = str(r["player_id"])
        mfl_by_season_pid[season][pid] = {
            "rank": coerce_int(r["rank"]),
            "average_pick": coerce_float(r["average_pick"]),
            "used_period": r["used_period"],
        }
        mfl_period_by_season[season] = r["used_period"]

    qb_factor_by_season = {}
    for season in seasons:
        ratios = []
        sf_map = sf_by_season_pid.get(season, {})
        for pid, sf_adp in sf_map.items():
            m = mfl_by_season_pid.get(season, {}).get(pid)
            if not m:
                continue
            avg_pick = m.get("average_pick")
            if avg_pick is None or avg_pick <= 0:
                continue
            ratios.append(float(sf_adp) / float(avg_pick))
        if ratios:
            qb_factor_by_season[season] = statistics.median(ratios)
        else:
            qb_factor_by_season[season] = 1.0

    normalized_rows = []
    normalized_by_season_pid = defaultdict(dict)

    for season in seasons:
        sf_map = sf_by_season_pid.get(season, {})
        factor = qb_factor_by_season.get(season, 1.0)
        for pid, mfl in mfl_by_season_pid.get(season, {}).items():
            player = by_season_pid.get((season, pid))
            player_name = player["name"] if player else None
            position = player["position"] if player else None
            nfl_team = player["nfl_team"] if player else None
            mfl_avg = mfl.get("average_pick")
            norm_adp = mfl_avg
            norm_src = "mfl"
            sf_src_adp = None
            if season >= args.superflex_start_year and position == "QB":
                if pid in sf_map:
                    norm_adp = sf_map[pid]
                    norm_src = "superflex_direct"
                    sf_src_adp = sf_map[pid]
                elif mfl_avg is not None and mfl_avg > 0:
                    norm_adp = round(float(mfl_avg) * float(factor), 2)
                    norm_src = "superflex_scaled_qb"
            rec = {
                "season": season,
                "player_id": pid,
                "player_name": player_name,
                "position": position,
                "nfl_team": nfl_team,
                "mfl_rank": mfl.get("rank"),
                "mfl_average_pick": mfl_avg,
                "normalized_adp": norm_adp,
                "normalization_source": norm_src,
                "superflex_source_adp": sf_src_adp,
                "qb_scale_factor": factor if season >= args.superflex_start_year else None,
                "adp_period_used": mfl.get("used_period"),
            }
            normalized_rows.append(rec)
            normalized_by_season_pid[season][pid] = rec

        # Add superflex-only QBs that did not appear in MFL ADP rows.
        for pid, sf_adp in sf_map.items():
            if pid in normalized_by_season_pid[season]:
                continue
            player = by_season_pid.get((season, pid))
            rec = {
                "season": season,
                "player_id": pid,
                "player_name": player["name"] if player else None,
                "position": "QB",
                "nfl_team": player["nfl_team"] if player else None,
                "mfl_rank": None,
                "mfl_average_pick": None,
                "normalized_adp": sf_adp,
                "normalization_source": "superflex_only",
                "superflex_source_adp": sf_adp,
                "qb_scale_factor": qb_factor_by_season.get(season),
                "adp_period_used": mfl_period_by_season.get(season),
            }
            normalized_rows.append(rec)
            normalized_by_season_pid[season][pid] = rec

    cur.executemany(
        """
        INSERT INTO adp_normalized_values (
            season, player_id, player_name, position, nfl_team, mfl_rank, mfl_average_pick,
            normalized_adp, normalization_source, superflex_source_adp, qb_scale_factor, adp_period_used
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                r["season"],
                r["player_id"],
                r["player_name"],
                r["position"],
                r["nfl_team"],
                r["mfl_rank"],
                r["mfl_average_pick"],
                r["normalized_adp"],
                r["normalization_source"],
                r["superflex_source_adp"],
                r["qb_scale_factor"],
                r["adp_period_used"],
            )
            for r in normalized_rows
        ],
    )
    conn.commit()

    auction_player_rows = []
    auction_summary_rows = []
    team_budget_rows = []
    topn_summary_rows = []

    for season in seasons:
        first_bid_ts, first_bid_dt, auction_window = get_first_freeagent_bid(conn, season)
        if first_bid_ts is None:
            auction_summary_rows.append(
                (
                    season,
                    None,
                    None,
                    None,
                    None,
                    "NONE",
                    0,
                    0,
                    0,
                    0,
                    0,
                    args.cap_start,
                    0,
                    0.0,
                    None,
                    "No FreeAgent auction rows found.",
                )
            )
            topn_summary_rows.append(
                (
                    season,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                    0, 0, 0.0, 0.0,
                )
            )
            continue

        last_cut_ts, last_cut_dt = get_last_cut_before(conn, season, first_bid_ts)
        fa_rows = fetch_freeagent_window_rows(conn, season, first_bid_ts, auction_window)
        pool = build_auction_pool(fa_rows)
        last_move_map = build_last_move_map(conn, season, first_bid_ts)

        total_winning_spend = 0
        winner_count = 0
        spend_by_team = defaultdict(int)
        for rec in pool.values():
            if rec["won_ind"] == 1 and rec["winning_bid"] is not None:
                winner_count += 1
                total_winning_spend += int(rec["winning_bid"])
                if rec["winner_franchise_id"]:
                    spend_by_team[str(rec["winner_franchise_id"])] += int(rec["winning_bid"])

        cap_per_team, team_count = get_cap_and_team_count(conn, season, args.cap_start)
        total_league_cap = float(cap_per_team) * float(team_count)
        spend_pct_cap = (float(total_winning_spend) / float(total_league_cap)) if total_league_cap > 0 else None

        # V1 value pool: use actual FreeAgent winning spend only.
        value_pool = int(total_winning_spend)

        season_norm = normalized_by_season_pid.get(season, {})
        season_max_adp = None
        for rec in season_norm.values():
            x = rec.get("normalized_adp")
            if x is None:
                continue
            if season_max_adp is None or x > season_max_adp:
                season_max_adp = x
        if season_max_adp is None:
            season_max_adp = 400.0
        fallback_adp = max(400.0, float(season_max_adp) * 1.2)

        tmp_rows = []
        adp_matched_count = 0
        for pid, p in pool.items():
            n = season_norm.get(pid)
            player_ref = by_season_pid.get((season, pid))
            if n and n.get("normalized_adp") and n.get("normalized_adp") > 0:
                norm_adp = float(n["normalized_adp"])
                mfl_avg = n.get("mfl_average_pick")
                norm_src = n.get("normalization_source")
                adp_matched_count += 1
            else:
                norm_adp = fallback_adp
                mfl_avg = None
                norm_src = "fallback_missing_adp"

            position = (
                p.get("position")
                or (n.get("position") if n else None)
                or (player_ref.get("position") if player_ref else None)
            )
            nfl_team = (
                p.get("nfl_team")
                or (n.get("nfl_team") if n else None)
                or (player_ref.get("nfl_team") if player_ref else None)
            )
            adp_segment = "IDP" if is_idp_position(position) else "NON_IDP"

            weight = 1.0 / norm_adp if norm_adp > 0 else 0.0

            last_move = last_move_map.get(pid)
            last_move_type = last_move["move_type"] if last_move else None
            last_move_method = last_move["method"] if last_move else None

            tmp_rows.append(
                {
                    "season": season,
                    "player_id": pid,
                    "player_name": p["player_name"],
                    "position": position,
                    "nfl_team": nfl_team,
                    "available_in_auction": 1,
                    "won_ind": p["won_ind"],
                    "winner_franchise_id": p["winner_franchise_id"],
                    "winner_team_name": p["winner_team_name"],
                    "winning_bid": p["winning_bid"],
                    "first_bid_ts": first_bid_ts,
                    "first_bid_datetime": first_bid_dt,
                    "last_cut_ts": last_cut_ts,
                    "last_cut_datetime": last_cut_dt,
                    "auction_window": auction_window,
                    "last_move_before_first_bid": last_move_type,
                    "last_move_method_before_first_bid": last_move_method,
                    "normalized_adp": norm_adp,
                    "mfl_average_pick": mfl_avg,
                    "normalization_source": norm_src,
                    "adp_segment": adp_segment,
                    "weight": weight,
                }
            )

        # Split ADP/value allocation into IDP and NON_IDP buckets.
        segment_weight_sum = defaultdict(float)
        segment_winning_spend = defaultdict(int)
        for r in tmp_rows:
            segment_weight_sum[r["adp_segment"]] += r["weight"]
            if r["won_ind"] == 1 and r["winning_bid"] is not None:
                segment_winning_spend[r["adp_segment"]] += int(r["winning_bid"])

        season_rows = []
        for r in tmp_rows:
            seg = r["adp_segment"]
            seg_weight = segment_weight_sum.get(seg, 0.0)
            seg_pool = float(segment_winning_spend.get(seg, 0))
            if seg_weight > 0 and seg_pool > 0:
                perceived_value = seg_pool * (r["weight"] / seg_weight)
            else:
                perceived_value = 0.0
            win_bid = r["winning_bid"]
            value_delta = None
            ratio = None
            if win_bid is not None:
                value_delta = round(perceived_value - float(win_bid), 2)
                if perceived_value > 0:
                    ratio = round(float(win_bid) / float(perceived_value), 4)

            season_row = dict(r)
            season_row["perceived_value_from_spend"] = round(perceived_value, 2)
            season_row["value_delta_vs_winning_bid"] = value_delta
            season_row["winning_bid_to_value_ratio"] = ratio
            season_rows.append(season_row)

            auction_player_rows.append(
                (
                    r["season"],
                    r["player_id"],
                    r["player_name"],
                    r["position"],
                    r["nfl_team"],
                    r["available_in_auction"],
                    r["won_ind"],
                    r["winner_franchise_id"],
                    r["winner_team_name"],
                    r["winning_bid"],
                    r["first_bid_ts"],
                    r["first_bid_datetime"],
                    r["last_cut_ts"],
                    r["last_cut_datetime"],
                    r["auction_window"],
                    r["last_move_before_first_bid"],
                    r["last_move_method_before_first_bid"],
                    r["normalized_adp"],
                    r["mfl_average_pick"],
                    r["normalization_source"],
                    r["weight"],
                    season_row["perceived_value_from_spend"],
                    season_row["value_delta_vs_winning_bid"],
                    season_row["winning_bid_to_value_ratio"],
                )
            )

        auction_summary_rows.append(
            (
                season,
                first_bid_ts,
                first_bid_dt,
                last_cut_ts,
                last_cut_dt,
                auction_window,
                len(pool),
                winner_count,
                adp_matched_count,
                total_winning_spend,
                value_pool,
                cap_per_team,
                team_count,
                total_league_cap,
                round(spend_pct_cap, 6) if spend_pct_cap is not None else None,
                "V1 uses FreeAgent winning bids as auction money spent and splits perceived values across IDP vs NON_IDP pools. Taxi/IR and salary-adjustment lineage not yet applied.",
            )
        )

        winners_sorted = [
            r for r in season_rows if r["won_ind"] == 1 and r["winning_bid"] is not None
        ]
        winners_sorted.sort(
            key=lambda x: (
                x["normalized_adp"] if x["normalized_adp"] is not None else 999999.0,
                x["player_name"] or "",
            )
        )

        def summarize_cohort(rows):
            count = len(rows)
            bid_sum = int(sum(int(r["winning_bid"] or 0) for r in rows))
            perceived_sum = round(
                sum(float(r["perceived_value_from_spend"] or 0.0) for r in rows), 2
            )
            delta = round(perceived_sum - float(bid_sum), 2)
            return count, bid_sum, perceived_sum, delta

        top5 = summarize_cohort(winners_sorted[:5])
        top10 = summarize_cohort(winners_sorted[:10])
        top25 = summarize_cohort(winners_sorted[:25])
        top50 = summarize_cohort(winners_sorted[:50])
        top100 = summarize_cohort(winners_sorted[:100])
        all_rows = summarize_cohort(winners_sorted)

        sf_rows = []
        if season >= args.superflex_start_year:
            sf_rows = [r for r in winners_sorted if str(r.get("position") or "").upper() == "QB"]
        sf_summary = summarize_cohort(sf_rows)

        idp_rows = [r for r in winners_sorted if r["adp_segment"] == "IDP"]
        non_idp_rows = [r for r in winners_sorted if r["adp_segment"] == "NON_IDP"]
        idp_summary = summarize_cohort(idp_rows)
        non_idp_summary = summarize_cohort(non_idp_rows)

        topn_summary_rows.append(
            (
                season,
                *top5,
                *top10,
                *top25,
                *top50,
                *top100,
                *all_rows,
                *sf_summary,
                *idp_summary,
                *non_idp_summary,
            )
        )

        # Team-level proxy (for quick-win context only).
        team_names = get_team_names(conn, season)
        prior_season, prior_end_week, prior_salary = get_prior_end_salary_by_team(conn, season)
        all_fids = sorted(set(team_names.keys()) | set(spend_by_team.keys()) | set(prior_salary.keys()))
        for fid in all_fids:
            prior_sal = prior_salary.get(fid)
            spend = int(spend_by_team.get(fid, 0))
            proxy_before = None
            proxy_after = None
            if prior_sal is not None:
                proxy_before = float(cap_per_team) - float(prior_sal)
                proxy_after = proxy_before - float(spend)
            team_budget_rows.append(
                (
                    season,
                    fid,
                    team_names.get(fid),
                    cap_per_team,
                    prior_season,
                    prior_end_week,
                    prior_sal,
                    round(proxy_before, 2) if proxy_before is not None else None,
                    spend,
                    round(proxy_after, 2) if proxy_after is not None else None,
                )
            )

    cur.executemany(
        """
        INSERT INTO auction_player_value_model_v1 (
            season, player_id, player_name, position, nfl_team, available_in_auction, won_ind,
            winner_franchise_id, winner_team_name, winning_bid, first_bid_ts, first_bid_datetime,
            last_cut_ts, last_cut_datetime, auction_window, last_move_before_first_bid,
            last_move_method_before_first_bid, normalized_adp, mfl_average_pick, normalization_source,
            weight, perceived_value_from_spend, value_delta_vs_winning_bid, winning_bid_to_value_ratio
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        auction_player_rows,
    )

    cur.executemany(
        """
        INSERT INTO auction_value_summary_v1 (
            season, first_bid_ts, first_bid_datetime, last_cut_ts, last_cut_datetime, auction_window,
            auction_players_count, auction_winners_count, adp_matched_count, total_winning_spend,
            value_pool_used, cap_per_team, team_count, total_league_cap, spend_pct_of_league_cap, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        auction_summary_rows,
    )

    cur.executemany(
        """
        INSERT INTO auction_team_budget_proxy_v1 (
            season, franchise_id, team_name, cap_start, prior_season, prior_end_week, prior_end_salary,
            proxy_cap_space_before_txn, freeagent_winning_spend, proxy_cap_space_after_freeagent_auction
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        team_budget_rows,
    )
    cur.executemany(
        """
        INSERT INTO auction_value_topn_summary_v1 (
            season,
            top5_count, top5_winning_bid_sum, top5_perceived_value_sum, top5_value_delta,
            top10_count, top10_winning_bid_sum, top10_perceived_value_sum, top10_value_delta,
            top25_count, top25_winning_bid_sum, top25_perceived_value_sum, top25_value_delta,
            top50_count, top50_winning_bid_sum, top50_perceived_value_sum, top50_value_delta,
            top100_count, top100_winning_bid_sum, top100_perceived_value_sum, top100_value_delta,
            all_count, all_winning_bid_sum, all_perceived_value_sum, all_value_delta,
            sf_count, sf_winning_bid_sum, sf_perceived_value_sum, sf_value_delta,
            idp_count, idp_winning_bid_sum, idp_perceived_value_sum, idp_value_delta,
            non_idp_count, non_idp_winning_bid_sum, non_idp_perceived_value_sum, non_idp_value_delta
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        """,
        topn_summary_rows,
    )
    conn.commit()

    LOG_DIR.mkdir(parents=True, exist_ok=True)

    write_csv(
        LOG_DIR / "adp_fetch_summary.csv",
        fetch_summary,
        [
            "season",
            "league_id",
            "requested_period",
            "used_period",
            "fallback_used",
            "players_fetched",
            "total_drafts",
            "total_picks",
        ],
    )

    cur.execute(
        """
        SELECT
            season, first_bid_datetime, last_cut_datetime, auction_window,
            auction_players_count, auction_winners_count, adp_matched_count,
            total_winning_spend, cap_per_team, team_count, total_league_cap,
            spend_pct_of_league_cap, notes
        FROM auction_value_summary_v1
        WHERE season BETWEEN ? AND ?
        ORDER BY season
        """,
        (min(seasons), max(seasons)),
    )
    summary_export = [dict(r) for r in cur.fetchall()]
    write_csv(
        LOG_DIR / "auction_value_summary_v1.csv",
        summary_export,
        [
            "season",
            "first_bid_datetime",
            "last_cut_datetime",
            "auction_window",
            "auction_players_count",
            "auction_winners_count",
            "adp_matched_count",
            "total_winning_spend",
            "cap_per_team",
            "team_count",
            "total_league_cap",
            "spend_pct_of_league_cap",
            "notes",
        ],
    )

    cur.execute(
        """
        SELECT
            season,
            top5_count, top5_winning_bid_sum, top5_perceived_value_sum, top5_value_delta,
            top10_count, top10_winning_bid_sum, top10_perceived_value_sum, top10_value_delta,
            top25_count, top25_winning_bid_sum, top25_perceived_value_sum, top25_value_delta,
            top50_count, top50_winning_bid_sum, top50_perceived_value_sum, top50_value_delta,
            top100_count, top100_winning_bid_sum, top100_perceived_value_sum, top100_value_delta,
            all_count, all_winning_bid_sum, all_perceived_value_sum, all_value_delta,
            sf_count, sf_winning_bid_sum, sf_perceived_value_sum, sf_value_delta,
            idp_count, idp_winning_bid_sum, idp_perceived_value_sum, idp_value_delta,
            non_idp_count, non_idp_winning_bid_sum, non_idp_perceived_value_sum, non_idp_value_delta
        FROM auction_value_topn_summary_v1
        WHERE season BETWEEN ? AND ?
        ORDER BY season
        """,
        (min(seasons), max(seasons)),
    )
    topn_export = [dict(r) for r in cur.fetchall()]
    write_csv(
        LOG_DIR / "auction_value_topn_summary_v1.csv",
        topn_export,
        [
            "season",
            "top5_count",
            "top5_winning_bid_sum",
            "top5_perceived_value_sum",
            "top5_value_delta",
            "top10_count",
            "top10_winning_bid_sum",
            "top10_perceived_value_sum",
            "top10_value_delta",
            "top25_count",
            "top25_winning_bid_sum",
            "top25_perceived_value_sum",
            "top25_value_delta",
            "top50_count",
            "top50_winning_bid_sum",
            "top50_perceived_value_sum",
            "top50_value_delta",
            "top100_count",
            "top100_winning_bid_sum",
            "top100_perceived_value_sum",
            "top100_value_delta",
            "all_count",
            "all_winning_bid_sum",
            "all_perceived_value_sum",
            "all_value_delta",
            "sf_count",
            "sf_winning_bid_sum",
            "sf_perceived_value_sum",
            "sf_value_delta",
            "idp_count",
            "idp_winning_bid_sum",
            "idp_perceived_value_sum",
            "idp_value_delta",
            "non_idp_count",
            "non_idp_winning_bid_sum",
            "non_idp_perceived_value_sum",
            "non_idp_value_delta",
        ],
    )

    cur.execute(
        """
        SELECT
            season, franchise_id, team_name, cap_start, prior_season, prior_end_week, prior_end_salary,
            proxy_cap_space_before_txn, freeagent_winning_spend, proxy_cap_space_after_freeagent_auction
        FROM auction_team_budget_proxy_v1
        WHERE season BETWEEN ? AND ?
        ORDER BY season, franchise_id
        """,
        (min(seasons), max(seasons)),
    )
    team_export = [dict(r) for r in cur.fetchall()]
    write_csv(
        LOG_DIR / "auction_team_budget_proxy_v1.csv",
        team_export,
        [
            "season",
            "franchise_id",
            "team_name",
            "cap_start",
            "prior_season",
            "prior_end_week",
            "prior_end_salary",
            "proxy_cap_space_before_txn",
            "freeagent_winning_spend",
            "proxy_cap_space_after_freeagent_auction",
        ],
    )

    cur.execute(
        """
        SELECT
            season, player_id, player_name, position,
            CASE WHEN UPPER(COALESCE(position,'')) IN ('DL','DE','DT','LB','OLB','ILB','MLB','DB','CB','S','SS','FS','NT','EDGE','IDP')
                 THEN 'IDP' ELSE 'NON_IDP' END AS adp_segment,
            nfl_team, won_ind, winner_franchise_id, winner_team_name,
            winning_bid, first_bid_datetime, last_cut_datetime, auction_window,
            last_move_before_first_bid, last_move_method_before_first_bid,
            normalized_adp, mfl_average_pick, normalization_source, perceived_value_from_spend,
            value_delta_vs_winning_bid, winning_bid_to_value_ratio
        FROM auction_player_value_model_v1
        WHERE season BETWEEN ? AND ?
        ORDER BY season, normalized_adp ASC, player_name
        """,
        (min(seasons), max(seasons)),
    )
    player_export = [dict(r) for r in cur.fetchall()]
    write_csv(
        LOG_DIR / "auction_player_value_model_v1.csv",
        player_export,
        [
            "season",
            "player_id",
            "player_name",
            "position",
            "adp_segment",
            "nfl_team",
            "won_ind",
            "winner_franchise_id",
            "winner_team_name",
            "winning_bid",
            "first_bid_datetime",
            "last_cut_datetime",
            "auction_window",
            "last_move_before_first_bid",
            "last_move_method_before_first_bid",
            "normalized_adp",
            "mfl_average_pick",
            "normalization_source",
            "perceived_value_from_spend",
            "value_delta_vs_winning_bid",
            "winning_bid_to_value_ratio",
        ],
    )

    cur.execute(
        """
        SELECT
            season,
            COUNT(*) AS players,
            SUM(CASE WHEN normalization_source IN ('superflex_direct', 'superflex_only') THEN 1 ELSE 0 END) AS sf_direct_rows,
            SUM(CASE WHEN normalization_source='superflex_scaled_qb' THEN 1 ELSE 0 END) AS sf_scaled_rows
        FROM adp_normalized_values
        WHERE season BETWEEN ? AND ?
        GROUP BY season
        ORDER BY season
        """,
        (min(seasons), max(seasons)),
    )
    norm_summary = [dict(r) for r in cur.fetchall()]
    write_csv(
        LOG_DIR / "adp_normalization_summary.csv",
        norm_summary,
        ["season", "players", "sf_direct_rows", "sf_scaled_rows"],
    )

    conn.close()

    print(f"Seasons processed: {min(seasons)}-{max(seasons)}")
    print(f"Current season period rule: season {current_season} -> {args.current_period}")
    print(
        "Outputs: "
        "etl/logs/adp_fetch_summary.csv, "
        "etl/logs/adp_normalization_summary.csv, "
        "etl/logs/auction_value_summary_v1.csv, "
        "etl/logs/auction_value_topn_summary_v1.csv, "
        "etl/logs/auction_team_budget_proxy_v1.csv, "
        "etl/logs/auction_player_value_model_v1.csv"
    )
    print("SQLite tables updated: adp_mfl_history, adp_superflex_qb_ref, adp_normalized_values, auction_player_value_model_v1, auction_value_summary_v1, auction_team_budget_proxy_v1, auction_value_topn_summary_v1")


if __name__ == "__main__":
    main()
