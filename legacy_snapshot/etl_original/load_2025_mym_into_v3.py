#!/usr/bin/env python3
import json
import sqlite3


DB_PATH = "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db"


def norm_franchise_id(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    if s.isdigit():
        return s.zfill(4)
    return s


def parse_option(v):
    s = (str(v) if v is not None else "").strip().lower()
    if s.startswith("mym"):
        num = s.replace("mym", "")
        if num.isdigit():
            return int(num)
    if s.isdigit():
        return int(s)
    return None


def main():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    cur.execute("SELECT COALESCE(MAX(id), 0) FROM contract_forum_export_v3_all")
    next_id = int(cur.fetchone()[0]) + 1

    cur.execute(
        """
        SELECT id, created_at, franchise_id, franchise_name, player_id, player_name, option, tcv, guaranteed, per_year
        FROM mym_submissions
        WHERE strftime('%Y', created_at)='2025'
        ORDER BY created_at, id
        """
    )
    src_rows = cur.fetchall()

    inserted = 0
    skipped = 0

    for sid, created_at, franchise_id, franchise_name, player_id, player_name, option_raw, tcv, guaranteed, per_year in src_rows:
        fid = norm_franchise_id(franchise_id)
        option = parse_option(option_raw)
        if not fid or option is None:
            skipped += 1
            continue

        # Fill team details from franchises table to keep row consistent.
        cur.execute(
            """
            SELECT team_name, logo
            FROM franchises
            WHERE season=2025 AND franchise_id=?
            """,
            (fid,),
        )
        f = cur.fetchone()
        team_name = franchise_name if franchise_name else None
        logo = None
        if f:
            team_name = f[0] or team_name
            logo = f[1]

        # Prevent duplicate MYM row if already loaded for same core identity.
        cur.execute(
            """
            SELECT 1
            FROM contract_forum_export_v3_all
            WHERE season=2025
              AND franchise_id=?
              AND player_id=?
              AND option=?
              AND tcv=?
              AND contract_type='MYM'
            LIMIT 1
            """,
            (fid, str(player_id), option, int(tcv) if tcv is not None else None),
        )
        if cur.fetchone():
            skipped += 1
            continue

        source_raw_line = json.dumps(
            {
                "source_table": "mym_submissions",
                "source_id": sid,
                "option_raw": option_raw,
            },
            ensure_ascii=True,
        )

        cur.execute(
            """
            INSERT INTO contract_forum_export_v3_all (
                id, created_at, created_at_norm, season, franchise_id, franchise_name, franchise_logo,
                player_id, player_name, option, tcv, guaranteed, per_year, xml_payload,
                contract_status, contract_style, source_section, source_raw_line,
                player_match_method, player_match_confidence, in_season_auction_pool,
                auction_winner_franchise_id, auction_winner_team_name, auction_bid, owner_matches_auction,
                legacy_guaranteed, contract_type
            ) VALUES (
                ?, ?, ?, 2025, ?, ?, ?, ?, ?, ?, ?, ?, ?, '',
                'Veteran', 'veteran', 'mym_submissions_2025', ?,
                'direct', 1.0, NULL,
                NULL, NULL, NULL, NULL,
                ?, 'MYM'
            )
            """,
            (
                next_id,
                created_at,
                created_at,
                fid,
                team_name,
                logo,
                str(player_id),
                player_name,
                option,
                int(tcv) if tcv is not None else None,
                int(guaranteed) if guaranteed is not None else None,
                int(per_year) if per_year is not None else None,
                source_raw_line,
                int(guaranteed) if guaranteed is not None else None,
            ),
        )
        next_id += 1
        inserted += 1

    conn.commit()
    conn.close()
    print(f"mym_2025_inserted={inserted}")
    print(f"mym_2025_skipped={skipped}")


if __name__ == "__main__":
    main()
