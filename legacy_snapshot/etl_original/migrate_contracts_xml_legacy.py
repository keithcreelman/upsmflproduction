#!/usr/bin/env python3
import argparse
import json
import sqlite3
from html import escape


def fmt_k(value):
    if value is None:
        return "0"
    return f"{float(value)/1000.0:.1f}".rstrip("0").rstrip(".")


def parse_year_values(source_raw_line):
    if not source_raw_line:
        return {}
    try:
        obj = json.loads(source_raw_line)
    except Exception:
        return {}
    yv = obj.get("year_values")
    if isinstance(yv, dict):
        out = {}
        for k, v in yv.items():
            try:
                out[int(k)] = int(v)
            except Exception:
                continue
        return dict(sorted(out.items()))
    return {}


def build_year_values(row):
    season = int(row["season"])
    option = int(row["option"]) if row["option"] is not None else 0
    per_year = int(row["per_year"]) if row["per_year"] is not None else None
    tcv = int(row["tcv"]) if row["tcv"] is not None else None

    yv = parse_year_values(row["source_raw_line"])
    if yv:
        return yv

    if option > 0 and per_year is not None:
        return {season + i: per_year for i in range(option)}

    if option > 0 and tcv is not None:
        avg = int(round(float(tcv) / float(option)))
        return {season + i: avg for i in range(option)}

    return {}


def build_contract_info(row, year_values):
    option = int(row["option"]) if row["option"] is not None else 0
    tcv = int(row["tcv"]) if row["tcv"] is not None else 0
    per_year = int(row["per_year"]) if row["per_year"] is not None else 0
    guaranteed = int(row["guaranteed"]) if row["guaranteed"] is not None else 0
    legacy_gtd = int(row["legacy_guaranteed"]) if row["legacy_guaranteed"] is not None else guaranteed

    year_parts = []
    for i, (year, val) in enumerate(sorted(year_values.items()), start=1):
        year_parts.append(f"Y{i}-{fmt_k(val)}K")
    year_blob = ", ".join(year_parts) if year_parts else ""

    bits = [
        f"CL {option}",
        f"TCV {fmt_k(tcv)}K",
        f"AAV {fmt_k(per_year)}K",
    ]
    if year_blob:
        bits.append(year_blob)
    bits.append(f"GTD_N: {fmt_k(guaranteed)}K")
    bits.append(f"GTD_L: {fmt_k(legacy_gtd)}K")
    return "| ".join(bits)


def build_xml_payload(row):
    player_id = str(row["player_id"])
    contract_status = row["contract_status"] or "Veteran"
    option = int(row["option"]) if row["option"] is not None else 0
    year_values = build_year_values(row)
    salary = None
    if year_values:
        salary = next(iter(sorted(year_values.items())))[1]
    if salary is None:
        salary = int(row["per_year"]) if row["per_year"] is not None else 0

    info = build_contract_info(row, year_values)
    xml = (
        "<salaries>\n"
        '  <leagueUnit unit="LEAGUE">\n'
        f'    <player id="{escape(player_id)}" salary="{int(salary)}" '
        f'contractStatus="{escape(str(contract_status))}" contractYear="{option}" '
        f'contractInfo="{escape(info)}" />\n'
        "  </leagueUnit>\n"
        "</salaries>"
    )
    return xml


def delete_discord_ext_restructure_dupes(conn):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT season, franchise_id, player_id, tcv, option
        FROM contract_forum_export_v3_all
        WHERE source_section='discord_contract_activity'
        GROUP BY season, franchise_id, player_id, tcv, option
        HAVING SUM(CASE WHEN contract_style='restructure' THEN 1 ELSE 0 END) > 0
           AND SUM(CASE WHEN contract_style='extension' THEN 1 ELSE 0 END) > 0
        """
    )
    dup_groups = cur.fetchall()
    deleted = 0
    for season, franchise_id, player_id, tcv, option in dup_groups:
        cur.execute(
            """
            DELETE FROM contract_forum_export_v3_all
            WHERE source_section='discord_contract_activity'
              AND season=?
              AND franchise_id=?
              AND player_id=?
              AND tcv=?
              AND option=?
              AND contract_style='extension'
            """,
            (season, franchise_id, player_id, tcv, option),
        )
        deleted += cur.rowcount
    conn.commit()
    return deleted


def ensure_legacy_column(conn):
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(contract_forum_export_v3_all)")
    cols = {r[1] for r in cur.fetchall()}
    if "legacy_guaranteed" not in cols:
        cur.execute("ALTER TABLE contract_forum_export_v3_all ADD COLUMN legacy_guaranteed INT")
        conn.commit()


def backfill_legacy_guaranteed(conn):
    cur = conn.cursor()
    # 2018 and earlier are legacy era.
    cur.execute(
        """
        UPDATE contract_forum_export_v3_all
        SET legacy_guaranteed = guaranteed
        WHERE legacy_guaranteed IS NULL
          AND season <= 2018
        """
    )
    a = cur.rowcount

    # Keep legacy_guaranteed populated for modern rows too for future rule-versioning.
    cur.execute(
        """
        UPDATE contract_forum_export_v3_all
        SET legacy_guaranteed = guaranteed
        WHERE legacy_guaranteed IS NULL
          AND season >= 2019
        """
    )
    b = cur.rowcount
    conn.commit()
    return a + b


def backfill_xml(conn):
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, season, player_id, option, tcv, guaranteed, per_year, contract_status,
               source_raw_line, legacy_guaranteed
        FROM contract_forum_export_v3_all
        WHERE xml_payload IS NULL OR TRIM(xml_payload)=''
        """
    )
    rows = cur.fetchall()
    updates = []
    for r in rows:
        row = {
            "id": r[0],
            "season": r[1],
            "player_id": r[2],
            "option": r[3],
            "tcv": r[4],
            "guaranteed": r[5],
            "per_year": r[6],
            "contract_status": r[7],
            "source_raw_line": r[8],
            "legacy_guaranteed": r[9],
        }
        xml = build_xml_payload(row)
        updates.append((xml, row["id"]))

    cur.executemany(
        "UPDATE contract_forum_export_v3_all SET xml_payload=? WHERE id=?",
        updates,
    )
    conn.commit()
    return len(updates)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--db-path",
        default="/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
    )
    args = parser.parse_args()

    conn = sqlite3.connect(args.db_path)
    deleted = delete_discord_ext_restructure_dupes(conn)
    ensure_legacy_column(conn)
    legacy_updates = backfill_legacy_guaranteed(conn)
    xml_updates = backfill_xml(conn)

    cur = conn.cursor()
    cur.execute(
        """
        SELECT COUNT(*)
        FROM contract_forum_export_v3_all
        WHERE xml_payload IS NULL OR TRIM(xml_payload)=''
        """
    )
    xml_remaining = cur.fetchone()[0]

    cur.execute(
        """
        SELECT COUNT(*)
        FROM contract_forum_export_v3_all
        WHERE legacy_guaranteed IS NULL
        """
    )
    legacy_remaining = cur.fetchone()[0]

    cur.execute(
        """
        SELECT season, COUNT(*) AS cnt
        FROM contract_forum_export_v3_all
        WHERE source_section='discord_contract_activity'
        GROUP BY season
        ORDER BY season
        """
    )
    discord_counts = cur.fetchall()
    conn.close()

    print(f"deleted_discord_extension_dupes={deleted}")
    print(f"legacy_guaranteed_updates={legacy_updates}")
    print(f"xml_payload_updates={xml_updates}")
    print(f"xml_payload_remaining_null={xml_remaining}")
    print(f"legacy_guaranteed_remaining_null={legacy_remaining}")
    for season, cnt in discord_counts:
        print(f"discord_rows_season_{season}={cnt}")


if __name__ == "__main__":
    main()
