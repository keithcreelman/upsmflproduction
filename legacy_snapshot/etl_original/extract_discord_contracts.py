#!/usr/bin/env python3
import argparse
import csv
import json
import re
import sqlite3
from pathlib import Path

import pandas as pd


CONTRACT_ACTIVITY_FILE = "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/Discord Chat/UPS Dynasty FFL - Automated League Updates - contract-activity [1059113303059730494].csv"
SLACK_HISTORY_FILE = "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/Discord Chat/UPS Dynasty FFL - archived_channels - slack-history [1063835430878969886].csv"


def norm_key(v):
    if v is None:
        return ""
    if isinstance(v, float) and pd.isna(v):
        return ""
    s = str(v).strip().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def normalize_player_name(v):
    if v is None:
        return ""
    s = str(v).strip()
    s = re.sub(r"\s+\(R\)$", "", s, flags=re.IGNORECASE)
    if "," not in s:
        return s
    last, rest = s.split(",", 1)
    rest = " ".join(rest.strip().split())
    return f"{last.strip()}, {rest}".strip()


def to_int_money(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(round(float(v)))
    s = str(v).strip().replace("$", "").replace(",", "")
    if not s:
        return None
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return int(round(float(s)))
    return None


def parse_date_et(date_raw):
    dt = pd.to_datetime(date_raw, errors="coerce", utc=True)
    if pd.isna(dt):
        return None
    dt = dt.tz_convert("US/Eastern")
    return dt.to_pydatetime().replace(tzinfo=None)


def parse_hear_ye(content):
    if "HEAR YE! HEAR YE!" not in content:
        return None

    m_team = re.search(
        r"\*\*(?P<team>.+?)\*\*\s+has just made a(?:\s+MYM)?\s+contract submission!",
        content,
        flags=re.IGNORECASE,
    )
    m_player = re.search(
        r"A new contract for\s+\*\*(?P<player>.+?)\*\*\s+for\s+\*\*(?P<years>\d+)\s+years?\*\*",
        content,
        flags=re.IGNORECASE,
    )
    if not m_team or not m_player:
        return None

    m_tcv = re.search(r"Total Contract Value\s*\(TCV\)\s*:\s*\*\*\$([0-9,]+)\*\*", content, flags=re.IGNORECASE)
    if not m_tcv:
        m_tcv = re.search(r"Total Contract Value\s*\(TCV\)\s*:\s*\$([0-9,]+)", content, flags=re.IGNORECASE)
    m_gtd = re.search(r"Guaranteed Amount\s*:\s*\$([0-9,]+)", content, flags=re.IGNORECASE)
    m_gtd_years = re.search(r"Guaranteed Years\s*:\s*(\d+)", content, flags=re.IGNORECASE)
    year_lines = re.findall(r"-\s*Year\s*(\d+)\s*:\s*\$([0-9,]+)", content, flags=re.IGNORECASE)

    years = int(m_player.group("years"))
    year_values = {}
    for idx_s, val_s in year_lines:
        idx = int(idx_s)
        year_values[idx] = to_int_money(val_s)

    tcv = to_int_money(m_tcv.group(1)) if m_tcv else None
    if tcv is None and year_values:
        tcv = sum(v for _, v in sorted(year_values.items()) if v is not None)
    gtd = to_int_money(m_gtd.group(1)) if m_gtd else None
    if gtd is None and m_gtd_years and year_values:
        g_years = int(m_gtd_years.group(1))
        gtd = sum(v for _, v in sorted(year_values.items())[:g_years] if v is not None)
    if gtd is None and tcv is not None:
        gtd = int(round(tcv * 0.75))

    return {
        "event_type": "mym_submission" if "MYM contract submission" in content else "submission",
        "team_raw": m_team.group("team").strip(),
        "player_raw": normalize_player_name(m_player.group("player")),
        "option_years": years,
        "tcv": tcv,
        "guaranteed": gtd,
        "year_values_indexed": year_values,
        "year_values_explicit": {},
    }


def parse_extension_or_restructure(content):
    m_ext = re.search(r"\*\*(?P<team>.+?)\*\*\s+just dropped a new\s+\*\*contract extension\*\*!", content, flags=re.IGNORECASE)
    m_res = re.search(r"\*\*(?P<team>.+?)\*\*\s+just restructured a contract!", content, flags=re.IGNORECASE)
    if not m_ext and not m_res:
        return None
    event_type = "extension" if m_ext else "restructure"
    team = m_ext.group("team").strip() if m_ext else m_res.group("team").strip()

    m_player = re.search(r"🧾\s+\*\*(?P<player>.+?)\*\*\s+has agreed to terms\.", content)
    m_tcv = re.search(r"Total Contract Value:\*\*\s*\$([0-9,]+)", content, flags=re.IGNORECASE)
    m_years = re.search(r"Total Years:\*\*\s*(\d+)", content, flags=re.IGNORECASE)
    m_gtd = re.search(r"Guaranteed:\*\*\s*\$([0-9,]+)", content, flags=re.IGNORECASE)

    years = int(m_years.group(1)) if m_years else None
    tcv = to_int_money(m_tcv.group(1)) if m_tcv else None
    gtd = to_int_money(m_gtd.group(1)) if m_gtd else None
    if gtd is None and tcv is not None:
        gtd = int(round(tcv * 0.75))

    year_lines = re.findall(r"-\s*(\d{4})\s*:\s*\$([0-9,]+)", content)
    year_values = {}
    for y_s, val_s in year_lines:
        year_values[int(y_s)] = to_int_money(val_s)

    if tcv is None and year_values:
        tcv = sum(v for v in year_values.values() if v is not None)
    if years is None and year_values:
        years = len(year_values)

    if not m_player:
        return None
    return {
        "event_type": event_type,
        "team_raw": team,
        "player_raw": normalize_player_name(m_player.group("player")),
        "option_years": years,
        "tcv": tcv,
        "guaranteed": gtd,
        "year_values_indexed": {},
        "year_values_explicit": year_values,
    }


def parse_contract_message(content):
    if content is None or (isinstance(content, float) and pd.isna(content)):
        return None
    text = str(content).strip()
    if not text:
        return None
    parsed = parse_hear_ye(text)
    if parsed:
        return parsed
    parsed = parse_extension_or_restructure(text)
    if parsed:
        return parsed
    return None


def build_reference_maps(conn):
    cur = conn.cursor()
    franchise_map = {}
    cur.execute("SELECT season, franchise_id, team_name, owner_name, logo FROM franchises")
    for season, fid, team_name, owner_name, logo in cur.fetchall():
        season_map = franchise_map.setdefault(int(season), {})
        keys = {
            norm_key(team_name),
            norm_key(owner_name),
        }
        if norm_key(team_name).startswith("the"):
            keys.add(norm_key(team_name)[3:])
        for k in keys:
            if k:
                season_map[k] = {
                    "franchise_id": fid,
                    "franchise_name": team_name,
                    "owner_name": owner_name,
                    "franchise_logo": logo,
                }

    player_map = {}
    cur.execute("SELECT season, player_id, name, position, nfl_team FROM players")
    for season, pid, name, position, nfl_team in cur.fetchall():
        season_map = player_map.setdefault(int(season), {})
        k = norm_key(name)
        if k and k not in season_map:
            season_map[k] = {
                "player_id": str(pid),
                "player_name": name,
                "position": position,
                "nfl_team": nfl_team,
            }

    available_seasons = sorted(franchise_map.keys())
    return franchise_map, player_map, available_seasons


def resolve_team(franchise_map, available_seasons, season, team_raw):
    key = norm_key(team_raw)
    if key.startswith("the"):
        key_alt = key[3:]
    else:
        key_alt = None

    candidates = [season]
    if season - 1 not in candidates:
        candidates.append(season - 1)
    if season + 1 not in candidates:
        candidates.append(season + 1)
    if available_seasons:
        latest = max(available_seasons)
        if latest not in candidates:
            candidates.append(latest)

    for s in candidates:
        season_map = franchise_map.get(s, {})
        if key in season_map:
            return s, season_map[key]
        if key_alt and key_alt in season_map:
            return s, season_map[key_alt]
    return None, None


def resolve_player(player_map, season, player_raw):
    key = norm_key(normalize_player_name(player_raw))
    candidates = [season, season - 1, season + 1]
    for s in candidates:
        season_map = player_map.get(s, {})
        if key in season_map:
            return s, season_map[key]
    return None, None


def infer_season(dt_local, year_values_explicit):
    if year_values_explicit:
        return min(year_values_explicit.keys())
    return dt_local.year


def parse_file(path, source_channel):
    df = pd.read_csv(path)
    rows = []
    for _, r in df.iterrows():
        parsed = parse_contract_message(r.get("Content"))
        if not parsed:
            continue
        dt_local = parse_date_et(r.get("Date"))
        if not dt_local:
            continue
        season = infer_season(dt_local, parsed["year_values_explicit"])

        # Convert indexed year values (Year 1/2/3) to explicit years anchored at inferred season.
        year_values = {}
        for idx, val in parsed["year_values_indexed"].items():
            year_values[season + idx - 1] = val
        year_values.update(parsed["year_values_explicit"])

        option = parsed["option_years"]
        if option is None and year_values:
            option = len(year_values)
        tcv = parsed["tcv"]
        if tcv is None and year_values:
            tcv = sum(v for v in year_values.values() if v is not None)
        guaranteed = parsed["guaranteed"]
        if guaranteed is None and tcv is not None:
            guaranteed = int(round(tcv * 0.75))
        per_year = int(round(float(tcv) / float(option))) if tcv is not None and option else None

        rows.append(
            {
                "source_channel": source_channel,
                "source_file": path,
                "message_author": r.get("Author"),
                "message_date_raw": r.get("Date"),
                "message_date_et": dt_local.strftime("%Y-%m-%d %H:%M:%S"),
                "season_inferred": season,
                "event_type": parsed["event_type"],
                "team_raw": parsed["team_raw"],
                "player_raw": parsed["player_raw"],
                "option": option,
                "tcv": tcv,
                "guaranteed": guaranteed,
                "per_year": per_year,
                "year_values_json": json.dumps(year_values, sort_keys=True),
                "content": r.get("Content"),
            }
        )
    return rows


def write_csv(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)


def upsert_contract_forum_export(conn, rows):
    seasons = sorted({int(r["season"]) for r in rows})
    if not seasons:
        return
    cur = conn.cursor()
    cur.execute(
        f"""
        DELETE FROM contract_forum_export_v3_all
        WHERE source_section = 'discord_contract_activity'
          AND season IN ({','.join('?' for _ in seasons)})
        """,
        tuple(seasons),
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
                r["created_at"],
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
                None,
                "Veteran",
                r["contract_style"],
                "discord_contract_activity",
                r["source_raw_line"],
                "direct",
                1.0,
                None,
                None,
                None,
                None,
                None,
            ),
        )
        next_id += 1
    conn.commit()



def main():
    parser = argparse.ArgumentParser(description="Extract contract data from Discord exports.")
    parser.add_argument(
        "--db-path",
        default="/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
        help="SQLite DB path for franchise/player resolution",
    )
    parser.add_argument(
        "--write-v3-all",
        action="store_true",
        help="Insert matched rows into contract_forum_export_v3_all (source_section=discord_contract_activity)",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db_path)
    franchise_map, player_map, available_seasons = build_reference_maps(conn)

    parsed_rows = []
    parsed_rows.extend(parse_file(CONTRACT_ACTIVITY_FILE, "contract-activity"))
    parsed_rows.extend(parse_file(SLACK_HISTORY_FILE, "slack-history"))

    parsed_rows = sorted(parsed_rows, key=lambda r: (r["message_date_et"], r["team_raw"], r["player_raw"]))

    matched = []
    unresolved = []

    for r in parsed_rows:
        season = int(r["season_inferred"])
        team_season, team_info = resolve_team(franchise_map, available_seasons, season, r["team_raw"])
        player_season, player_info = resolve_player(player_map, season, r["player_raw"])

        if not team_info or not player_info:
            unresolved.append(
                {
                    "message_date_et": r["message_date_et"],
                    "season_inferred": season,
                    "source_channel": r["source_channel"],
                    "event_type": r["event_type"],
                    "team_raw": r["team_raw"],
                    "player_raw": r["player_raw"],
                    "reason": "franchise_not_found" if not team_info else "player_not_found",
                    "content": r["content"],
                }
            )
            continue

        contract_style = "extension" if r["event_type"] == "extension" else ("restructure" if r["event_type"] == "restructure" else "submission")

        matched_row = {
            "created_at": r["message_date_et"],
            "season": season,
            "season_team_match": team_season,
            "season_player_match": player_season,
            "source_channel": r["source_channel"],
            "event_type": r["event_type"],
            "franchise_id": team_info["franchise_id"],
            "franchise_name": team_info["franchise_name"],
            "franchise_logo": team_info["franchise_logo"],
            "player_id": player_info["player_id"],
            "player_name": player_info["player_name"],
            "option": r["option"],
            "tcv": r["tcv"],
            "guaranteed": r["guaranteed"],
            "per_year": r["per_year"],
            "contract_style": contract_style,
            "year_values_json": r["year_values_json"],
            "source_raw_line": json.dumps(
                {
                    "source_file": r["source_file"],
                    "source_channel": r["source_channel"],
                    "message_author": r["message_author"],
                    "message_date_raw": r["message_date_raw"],
                    "event_type": r["event_type"],
                    "team_raw": r["team_raw"],
                    "player_raw": r["player_raw"],
                    "year_values": json.loads(r["year_values_json"]),
                    "content": r["content"],
                },
                ensure_ascii=True,
            ),
        }
        matched.append(matched_row)

    # Deduplicate same franchise/player/date/tcv rows
    dedup = {}
    for r in matched:
        k = (r["created_at"], r["franchise_id"], r["player_id"], r["event_type"], r["tcv"], r["option"])
        if k not in dedup:
            dedup[k] = r
    matched = list(dedup.values())

    out_dir = Path("etl/logs")
    parsed_csv = out_dir / "discord_contracts_parsed_all.csv"
    matched_csv = out_dir / "discord_contracts_matched.csv"
    unresolved_csv = out_dir / "discord_contracts_unresolved.csv"
    write_csv(parsed_csv, parsed_rows)
    write_csv(matched_csv, matched)
    write_csv(unresolved_csv, unresolved)

    if args.write_v3_all:
        upsert_contract_forum_export(conn, matched)

    # Summary
    by_channel = pd.DataFrame(parsed_rows).groupby("source_channel").size().to_dict() if parsed_rows else {}
    by_season = pd.DataFrame(matched).groupby("season").size().to_dict() if matched else {}
    by_event = pd.DataFrame(matched).groupby("event_type").size().to_dict() if matched else {}

    print(f"parsed_total={len(parsed_rows)}")
    print(f"matched_total={len(matched)}")
    print(f"unresolved_total={len(unresolved)}")
    print(f"by_channel={json.dumps(by_channel, sort_keys=True)}")
    print(f"by_season={json.dumps(by_season, sort_keys=True)}")
    print(f"by_event={json.dumps(by_event, sort_keys=True)}")
    print(f"parsed_csv={parsed_csv}")
    print(f"matched_csv={matched_csv}")
    print(f"unresolved_csv={unresolved_csv}")

    if args.write_v3_all:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT season, COUNT(*)
            FROM contract_forum_export_v3_all
            WHERE source_section = 'discord_contract_activity'
            GROUP BY season
            ORDER BY season
            """
        )
        rows = cur.fetchall()
        for season, cnt in rows:
            print(f"v3_all_discord_season_{season}={cnt}")

    conn.close()


if __name__ == "__main__":
    main()
