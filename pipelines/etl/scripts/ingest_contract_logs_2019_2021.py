#!/usr/bin/env python3
import argparse
import csv
import datetime as dt
import json
import os
import re
import sqlite3
from pathlib import Path

import pandas as pd


SCRIPT_DIR = Path(__file__).resolve().parent
ETL_ROOT = SCRIPT_DIR.parent
FILES = {
    2019: str(ETL_ROOT / "inputs" / "2019_contract_transaction_log.xlsx"),
    2020: str(ETL_ROOT / "inputs" / "2020_contract_transaction_log.xlsx"),
    2021: str(ETL_ROOT / "inputs" / "2021_contract_transaction_log.xlsx"),
}
DB_DEFAULT = os.getenv("MFL_DB_PATH", str(ETL_ROOT / "data" / "mfl_database.db"))

SUMMARY_SHEETS = [
    "Auction Contracts",
    "MYM",
    "Extensions",
    "Restructured Contracts",
    "Franchise Tagged",
    "Transition Tagged",
]

TYPE_MAP = {
    "freeagentauction": "auction",
    "expiredrookiewaiver": "auction",
    "preseasonwwmultiyearcontracts": "auction",
    "midseasonmultiyearcontract": "mym",
    "contractextensions": "extension",
    "restructurecontract": "restructure",
    "contractrestructure": "restructure",
    "franchisetag": "franchise_tag",
    "transitiontag": "transition_tag",
    "tag": "tag",
}

TEAM_ALIASES = {
    "rico": "runcmc",
    "aj": "goodindahood",
    "cleoncash": "cleoncah",
    "whitepower": "hawks",
}

AUCTION_VALUE_COLS = [
    "Year 1 Contract Value (Min 20% of Total Contract Value)",
    "Year 2 Contract Value",
    "Year 3 Contract Value (Only use if giving out a 3 year deal)",
]

RESTRUCTURE_VALUE_COLS = [
    "Year 1 Contract Value (Min 20% of Total Contract Value).1",
    "Year 2 Contract Value.1",
    "Year 3 Contract Value (Only use if with extension)",
]

OUTPUT_DIR = Path(os.getenv("MFL_ETL_ARTIFACT_DIR", str(ETL_ROOT / "artifacts")))


def norm_key(value):
    if value is None:
        return ""
    if isinstance(value, float) and pd.isna(value):
        return ""
    s = str(value).strip().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def parse_timestamp(value):
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return None
    ts = pd.to_datetime(value, errors="coerce")
    if pd.isna(ts):
        return None
    return ts.to_pydatetime().replace(tzinfo=None).strftime("%Y-%m-%d %H:%M:%S")


def excel_date_to_number(value):
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        d = value.to_pydatetime()
    elif isinstance(value, dt.datetime):
        d = value
    elif isinstance(value, dt.date):
        d = dt.datetime.combine(value, dt.time.min)
    else:
        return None
    # Excel day serial origin used by pandas/openpyxl for basic dates.
    serial = (d.date() - dt.date(1899, 12, 30)).days
    return serial


def coerce_money(value):
    if value is None or pd.isna(value):
        return None
    if isinstance(value, str):
        s = value.strip().replace("$", "").replace(",", "")
        if not s:
            return None
        if re.fullmatch(r"-?\d+(\.\d+)?", s):
            return int(round(float(s)))
        return None
    if isinstance(value, (int, float)):
        return int(round(float(value)))
    serial = excel_date_to_number(value)
    if serial is not None:
        return int(serial)
    return None


def coerce_years(value):
    if value is None or pd.isna(value):
        return None
    if isinstance(value, (pd.Timestamp, dt.datetime, dt.date)):
        # Years occasionally come through as 1900-01-0N date-like values.
        if hasattr(value, "year") and int(value.year) == 1900:
            return int(value.day)
    if isinstance(value, (int, float)):
        return int(round(float(value)))
    serial = excel_date_to_number(value)
    if serial is not None:
        return int(serial)
    if isinstance(value, str):
        s = value.strip()
        if not s:
            return None
        if re.fullmatch(r"\d+(\.\d+)?", s):
            return int(round(float(s)))
    return None


def parse_player_name(raw):
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return ""
    s = str(raw).strip()
    s = s.split(" - ")[0].strip()
    s = re.sub(r"\s+\(R\)$", "", s, flags=re.IGNORECASE)
    if "," not in s:
        return s
    last, rest = s.split(",", 1)
    toks = rest.strip().split()
    if len(toks) >= 3:
        if re.fullmatch(r"[A-Z*]{1,3}", toks[-1]) and re.fullmatch(r"[A-Z*]{2,3}", toks[-2]):
            toks = toks[:-2]
    return f"{last.strip()}, {' '.join(toks).strip()}".strip()


def parse_player_salary(raw):
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    s = str(raw)
    m = re.search(r"-\s*\$?([0-9,]+)\s*$", s)
    if not m:
        return None
    return coerce_money(m.group(1))


def normalize_team_key(raw):
    key = norm_key(raw)
    key = TEAM_ALIASES.get(key, key)
    if key.startswith("the") and len(key) > 3:
        stripped = key[3:]
        if stripped:
            return stripped
    return key


def normalize_contract_style(raw):
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None
    s = str(raw).strip()
    if not s:
        return None
    s = s.lower().replace("/", "_").replace("-", "_").replace(" ", "_")
    s = re.sub(r"_+", "_", s).strip("_")
    return s


def map_type(raw):
    k = norm_key(raw)
    return TYPE_MAP.get(k)


def build_reference(conn, season_min=2019, season_max=2021):
    franchises = {}
    cur = conn.cursor()
    cur.execute(
        """
        SELECT season, franchise_id, team_name, owner_name, logo
        FROM franchises
        WHERE season BETWEEN ? AND ?
        """,
        (season_min, season_max),
    )
    for season, fid, team_name, owner_name, logo in cur.fetchall():
        season_map = franchises.setdefault(season, {})
        keys = {
            norm_key(team_name),
            normalize_team_key(team_name),
            norm_key(owner_name),
            normalize_team_key(owner_name),
        }
        for k in list(keys):
            if k.startswith("the") and len(k) > 3:
                keys.add(k[3:])
        for k in keys:
            if k:
                season_map[k] = {
                    "franchise_id": fid,
                    "franchise_name": team_name,
                    "owner_name": owner_name,
                    "franchise_logo": logo,
                }

    players = {}
    cur.execute(
        """
        SELECT season, player_id, name, position, nfl_team
        FROM players
        WHERE season BETWEEN ? AND ?
        """,
        (season_min, season_max),
    )
    for season, pid, name, position, nfl_team in cur.fetchall():
        season_map = players.setdefault(season, {})
        key = norm_key(name)
        if key and key not in season_map:
            season_map[key] = {
                "player_id": pid,
                "player_name": name,
                "position": position,
                "nfl_team": nfl_team,
                "match_method": "direct",
                "match_confidence": 1.0,
            }

    auction_winners = {}
    cur.execute(
        """
        SELECT season,
               player_id,
               franchise_currentbid_id,
               franchise_currentbid_team_name,
               bid_amount
        FROM transactions_auction
        WHERE season BETWEEN ? AND ?
          AND finalbid_ind = 1
        """,
        (season_min, season_max),
    )
    for season, player_id, winner_id, winner_team, bid_amount in cur.fetchall():
        auction_winners[(season, str(player_id))] = {
            "winner_id": winner_id,
            "winner_team": winner_team,
            "bid_amount": coerce_money(bid_amount),
        }

    return franchises, players, auction_winners


def match_player(players_ref, season, player_raw):
    parsed_name = parse_player_name(player_raw)
    key = norm_key(parsed_name)
    season_map = players_ref.get(season, {})
    if key in season_map:
        return season_map[key]
    return None


def get_numeric_year_columns(df):
    cols = []
    for c in df.columns:
        if isinstance(c, (int, float)):
            y = int(c)
            if 1900 <= y <= 2100:
                cols.append(c)
    return sorted(cols, key=lambda x: int(x))


def build_year_values_from_summary(row, year_cols, season):
    out = {}
    for idx, col in enumerate(year_cols):
        v = coerce_money(row.get(col))
        if v is None:
            continue
        out[season + idx] = v
    return out


def pick_first_present(row, columns):
    for c in columns:
        if c in row and pd.notna(row[c]) and str(row[c]).strip():
            return row[c]
    return None


def compute_tcv_option_per_year(year_values, years_hint=None):
    values = [v for _, v in sorted(year_values.items()) if v is not None]
    tcv = sum(values) if values else None
    option = years_hint if years_hint else len(values)
    if option is None or option <= 0:
        option = len(values) if values else None
    per_year = None
    if tcv is not None and option and option > 0:
        avg = int(round(float(tcv) / float(option)))
        if avg % 1000 != 0:
            avg = int(round(avg / 1000.0) * 1000)
        per_year = avg
    guaranteed = int(round(tcv * 0.75)) if tcv is not None else None
    return tcv, option, per_year, guaranteed


def make_summary_rows(season, workbook_path):
    rows = []
    for sheet in SUMMARY_SHEETS:
        try:
            df = pd.read_excel(workbook_path, sheet_name=sheet, header=2)
        except Exception:
            continue
        if "Player" not in df.columns:
            continue
        df = df[df["Player"].notna()].copy()
        if df.empty:
            continue

        if sheet == "Auction Contracts":
            source_type = "auction"
            team_col = "Team"
            style_col = "Type Contract"
            years_col = "Years"
        elif sheet == "MYM":
            source_type = "mym"
            team_col = "Team"
            style_col = "Type Contract"
            years_col = "Years"
        elif sheet == "Extensions":
            source_type = "extension"
            team_col = "Extension By:"
            style_col = "Type Extension"
            years_col = "Years Extended"
        elif sheet == "Restructured Contracts":
            source_type = "restructure"
            team_col = "Team"
            style_col = None
            years_col = None
        elif sheet == "Franchise Tagged":
            source_type = "franchise_tag"
            team_col = "Tagged By:"
            style_col = None
            years_col = None
        elif sheet == "Transition Tagged":
            source_type = "transition_tag"
            team_col = "Tagged By:"
            style_col = None
            years_col = None
        else:
            continue

        year_cols = get_numeric_year_columns(df)
        ts_col = None
        for candidate in ("Timestamp", "TimeStamp"):
            if candidate in df.columns:
                ts_col = candidate
                break

        for _, row in df.iterrows():
            team_raw = row.get(team_col)
            player_raw = row.get("Player")
            created_at = parse_timestamp(row.get(ts_col)) if ts_col else None
            style_raw = row.get(style_col) if style_col else None
            years_hint = coerce_years(row.get(years_col)) if years_col else None

            if source_type in {"franchise_tag", "transition_tag"}:
                retained = coerce_money(row.get("Retained"))
                if retained is None:
                    retained = coerce_money(row.get("Opening Bid"))
                year_values = {season: retained} if retained is not None else {}
                style_raw = "Tag"
                years_hint = 1
            else:
                year_values = build_year_values_from_summary(row, year_cols, season)

            tcv, option, per_year, guaranteed = compute_tcv_option_per_year(year_values, years_hint=years_hint)
            if tcv is None:
                continue

            rows.append(
                {
                    "season": season,
                    "created_at": created_at,
                    "team_raw": team_raw,
                    "player_raw": player_raw,
                    "player_parsed": parse_player_name(player_raw),
                    "source_type": source_type,
                    "source_section": sheet,
                    "contract_style_raw": style_raw,
                    "contract_style": normalize_contract_style(style_raw),
                    "option": option,
                    "tcv": tcv,
                    "per_year": per_year,
                    "guaranteed": guaranteed,
                    "year_values": year_values,
                    "source_raw_line": json.dumps(
                        {
                            "sheet": sheet,
                            "team": str(team_raw),
                            "player": str(player_raw),
                            "style": str(style_raw) if style_raw is not None else None,
                            "year_values": year_values,
                        },
                        ensure_ascii=True,
                    ),
                }
            )
    return rows


def extract_response_primary(row):
    pair_candidates = []
    for c in row.index:
        if str(c).startswith("Player's Name"):
            suffix = str(c).replace("Player's Name", "")
            tcol = "Type of Contract" + suffix
            if tcol in row.index:
                pair_candidates.append((c, tcol))
    for pcol, tcol in pair_candidates:
        p = row.get(pcol)
        t = row.get(tcol)
        if pd.notna(p) and str(p).strip() and pd.notna(t) and str(t).strip():
            return p, t
    return None, None


def make_response_supplement_rows(season, workbook_path, summary_keys):
    rows = []
    try:
        df = pd.read_excel(workbook_path, sheet_name="Worksheet")
    except Exception:
        return rows

    if "Timestamp" not in df.columns:
        return rows
    ts = pd.to_datetime(df["Timestamp"], errors="coerce")
    df = df[ts.dt.year == season].copy()
    if df.empty:
        return rows

    for _, row in df.iterrows():
        player_raw, type_raw = extract_response_primary(row)
        if not player_raw or not type_raw:
            continue

        mapped_type = map_type(type_raw)
        if not mapped_type:
            continue

        team_raw = row.get("Contract by")
        if team_raw is None or (isinstance(team_raw, float) and pd.isna(team_raw)) or not str(team_raw).strip():
            team_raw = row.get("What team is player CURRENTLY on")
        team_key = normalize_team_key(team_raw)
        player_key = norm_key(parse_player_name(player_raw))

        key = (team_key, player_key, mapped_type)
        if mapped_type != "tag" and key in summary_keys:
            continue

        created_at = parse_timestamp(row.get("Timestamp"))
        style_raw = None
        years_hint = None
        year_values = {}

        if mapped_type in {"auction", "mym"}:
            years_hint = coerce_years(
                pick_first_present(row, ["How Many Years is Player Receiving?", "How Many Years is Player Receiving?.1"])
            )
            style_raw = pick_first_present(
                row,
                ["Type of Contract.12", "Type of Contract.14", "Type of Contract.13"],
            )
            for idx, c in enumerate(AUCTION_VALUE_COLS):
                if c in row.index:
                    v = coerce_money(row.get(c))
                    if v is not None:
                        year_values[season + idx] = v
            # Some veteran FA/WW entries omit explicit yearly values. Use current salary * years.
            if not year_values and years_hint and years_hint > 0:
                base = parse_player_salary(player_raw)
                if base is None:
                    base = coerce_money(row.get("Current Contract"))
                if base is not None:
                    for idx in range(years_hint):
                        year_values[season + idx] = int(base)
        elif mapped_type == "restructure":
            years_hint = coerce_years(row.get("How many additional years will player be extended?"))
            style_raw = pick_first_present(row, ["Type of Contract.13", "Type of Contract.14"]) or "Restructure"
            for idx, c in enumerate(RESTRUCTURE_VALUE_COLS):
                if c in row.index:
                    v = coerce_money(row.get(c))
                    if v is not None:
                        year_values[season + idx] = v
        elif mapped_type in {"franchise_tag", "transition_tag", "tag"}:
            style_raw = "Tag"
            years_hint = 1
            opening_bid = coerce_money(row.get("How much is your opening bid?"))
            if opening_bid is not None:
                year_values[season] = opening_bid
        else:
            continue

        tcv, option, per_year, guaranteed = compute_tcv_option_per_year(year_values, years_hint=years_hint)
        if tcv is None:
            continue

        rows.append(
            {
                "season": season,
                "created_at": created_at,
                "team_raw": team_raw,
                "player_raw": player_raw,
                "player_parsed": parse_player_name(player_raw),
                "source_type": mapped_type,
                "source_section": "Worksheet (supplement)",
                "contract_style_raw": style_raw,
                "contract_style": normalize_contract_style(style_raw),
                "option": option,
                "tcv": tcv,
                "per_year": per_year,
                "guaranteed": guaranteed,
                "year_values": year_values,
                "source_raw_line": json.dumps(
                    {
                        "worksheet_timestamp": created_at,
                        "team": str(team_raw),
                        "player": str(player_raw),
                        "type": str(type_raw),
                        "year_values": year_values,
                    },
                    ensure_ascii=True,
                ),
            }
        )

    return rows


def resolve_and_build(rows, franchises_ref, players_ref, auction_ref):
    staged = []
    unresolved = []
    for r in rows:
        season = r["season"]
        team_key = normalize_team_key(r["team_raw"])
        player_key = norm_key(r["player_parsed"])

        team_info = franchises_ref.get(season, {}).get(team_key)
        player_info = players_ref.get(season, {}).get(player_key)

        if not team_info or not player_info:
            unresolved.append(
                {
                    "season": season,
                    "team_raw": r["team_raw"],
                    "team_key": team_key,
                    "player_raw": r["player_raw"],
                    "player_parsed": r["player_parsed"],
                    "player_key": player_key,
                    "source_section": r["source_section"],
                    "reason": "franchise_not_found" if not team_info else "player_not_found",
                }
            )
            continue

        winner = auction_ref.get((season, str(player_info["player_id"])))
        in_pool = 1 if winner else 0
        owner_matches = None
        winner_id = None
        winner_team = None
        winner_bid = None
        if winner:
            winner_id = winner["winner_id"]
            winner_team = winner["winner_team"]
            winner_bid = winner["bid_amount"]
            owner_matches = 1 if winner_id == team_info["franchise_id"] else 0

        created_at = r["created_at"] or f"{season}-09-01 00:00:00"
        staged.append(
            {
                "created_at": created_at,
                "created_at_norm": created_at,
                "season": season,
                "franchise_id": team_info["franchise_id"],
                "franchise_name": team_info["franchise_name"],
                "franchise_logo": team_info["franchise_logo"],
                "player_id": str(player_info["player_id"]),
                "player_name": player_info["player_name"],
                "option": r["option"],
                "tcv": r["tcv"],
                "guaranteed": r["guaranteed"],
                "per_year": r["per_year"],
                "xml_payload": None,
                "contract_status": "Veteran",
                "contract_style": r["contract_style"],
                "source_section": r["source_section"],
                "source_raw_line": r["source_raw_line"],
                "player_match_method": "direct",
                "player_match_confidence": 1.0,
                "in_season_auction_pool": in_pool,
                "auction_winner_franchise_id": winner_id,
                "auction_winner_team_name": winner_team,
                "auction_bid": winner_bid,
                "owner_matches_auction": owner_matches,
                "source_type": r["source_type"],
                "year_values_json": json.dumps(r["year_values"], sort_keys=True),
            }
        )

    return staged, unresolved


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        with path.open("w", newline="", encoding="utf-8") as f:
            f.write("")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def insert_rows(conn, rows, replace_seasons):
    cur = conn.cursor()
    cur.execute(
        f"DELETE FROM contract_forum_export_v3_all WHERE season IN ({','.join('?' for _ in replace_seasons)})",
        tuple(replace_seasons),
    )
    cur.execute("SELECT COALESCE(MAX(id), 0) FROM contract_forum_export_v3_all")
    next_id = int(cur.fetchone()[0]) + 1

    insert_sql = """
        INSERT INTO contract_forum_export_v3_all (
            id, created_at, created_at_norm, season, franchise_id, franchise_name, franchise_logo,
            player_id, player_name, option, tcv, guaranteed, per_year, xml_payload,
            contract_status, contract_style, source_section, source_raw_line,
            player_match_method, player_match_confidence, in_season_auction_pool,
            auction_winner_franchise_id, auction_winner_team_name, auction_bid, owner_matches_auction
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
    """

    for r in rows:
        cur.execute(
            insert_sql,
            (
                next_id,
                r["created_at"],
                r["created_at_norm"],
                r["season"],
                r["franchise_id"],
                r["franchise_name"],
                r["franchise_logo"],
                r["player_id"],
                r["player_name"],
                r["option"],
                r["tcv"],
                r["guaranteed"],
                r["per_year"],
                r["xml_payload"],
                r["contract_status"],
                r["contract_style"],
                r["source_section"],
                r["source_raw_line"],
                r["player_match_method"],
                r["player_match_confidence"],
                r["in_season_auction_pool"],
                r["auction_winner_franchise_id"],
                r["auction_winner_team_name"],
                r["auction_bid"],
                r["owner_matches_auction"],
            ),
        )
        next_id += 1
    conn.commit()


def main():
    parser = argparse.ArgumentParser(description="Load 2019-2021 contract logs into contract_forum_export_v3_all.")
    parser.add_argument(
        "--db-path",
        default=DB_DEFAULT,
        help="SQLite DB path",
    )
    parser.add_argument("--file-2019", default=FILES[2019], help="Path to 2019 workbook")
    parser.add_argument("--file-2020", default=FILES[2020], help="Path to 2020 workbook")
    parser.add_argument("--file-2021", default=FILES[2021], help="Path to 2021 workbook")
    parser.add_argument("--dry-run", action="store_true", help="Parse and report only; do not insert.")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db_path)
    franchises_ref, players_ref, auction_ref = build_reference(conn, season_min=2019, season_max=2021)
    files = {
        2019: args.file_2019,
        2020: args.file_2020,
        2021: args.file_2021,
    }

    all_rows = []
    summary_keys = set()

    for season, workbook in files.items():
        summary_rows = make_summary_rows(season, workbook)
        for r in summary_rows:
            key = (
                normalize_team_key(r["team_raw"]),
                norm_key(r["player_parsed"]),
                r["source_type"],
            )
            summary_keys.add(key)
        all_rows.extend(summary_rows)

    # Add response-only rows (mostly 2021 tags and edge-case contract types absent from summary tabs).
    for season, workbook in files.items():
        all_rows.extend(make_response_supplement_rows(season, workbook, summary_keys))

    staged, unresolved = resolve_and_build(all_rows, franchises_ref, players_ref, auction_ref)

    # Deduplicate exact duplicates on season/franchise/player/source/values.
    dedup = {}
    for r in staged:
        k = (
            r["season"],
            r["franchise_id"],
            r["player_id"],
            r["source_section"],
            r["option"],
            r["tcv"],
            r["contract_style"],
            r["year_values_json"],
        )
        if k not in dedup:
            dedup[k] = r
    staged = list(dedup.values())

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    staged_csv = OUTPUT_DIR / "contract_logs_2019_2021_staged.csv"
    unresolved_csv = OUTPUT_DIR / "contract_logs_2019_2021_unresolved.csv"
    write_csv(staged_csv, staged)
    write_csv(unresolved_csv, unresolved)

    if not args.dry_run:
        insert_rows(conn, staged, replace_seasons=[2019, 2020, 2021])

    cur = conn.cursor()
    cur.execute(
        "SELECT season, COUNT(*) FROM contract_forum_export_v3_all WHERE season IN (2019, 2020, 2021) GROUP BY season ORDER BY season"
    )
    season_counts = cur.fetchall()
    conn.close()

    print(f"parsed_rows={len(all_rows)}")
    print(f"staged_rows={len(staged)}")
    print(f"unresolved_rows={len(unresolved)}")
    print(f"staged_csv={staged_csv}")
    print(f"unresolved_csv={unresolved_csv}")
    for season, cnt in season_counts:
        print(f"season_{season}_rows={cnt}")


if __name__ == "__main__":
    main()
