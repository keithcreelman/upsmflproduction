#!/usr/bin/env python3
"""
Build per-player contract lineage JSON for all currently rostered players.

For each player currently on a 2026 roster, this script pulls their last 10
seasons of end-of-season contract snapshots and merges in draft, auction,
trade, drop, and cap-penalty events.

Output JSON feeds /site/reports/roster_lineage.html which renders an
interactive table: dropdown for anchor year (2022-2026), shows 5 years of
history per player, with search + filter.

Columns per year-row:
  - team (end of year)
  - salary (end-of-year salary snapshot)
  - aav (parsed from contractInfo; derived TCV/CL if missing)
  - tcv
  - contract_type  (Rookie / Auction / Tag / Ext1 / Ext2 ± BL/FL/Restructure)
  - load_shape     (FLAT / BL / FL / RESTRUCTURE / UNKNOWN)
  - salary_earned  (cumulative within current contract epoch)
  - major_events   (rookie draft, auction, trades, drops, cap penalties, restructures)

Usage:
  python3 build_rostered_players_lineage.py
  python3 build_rostered_players_lineage.py --anchor-years 5 --out-path /tmp/lineage.json
"""
from __future__ import annotations

import argparse
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
DEFAULT_OUT = "/Users/keithcreelman/Documents/mfl/Codex/_worktrees/rulebook-mobile-preview/site/reports/roster_lineage.json"
SAL_ADJ_DIR = "/Users/keithcreelman/Documents/mfl/Codex/_worktrees/rulebook-mobile-preview/site/reports/salary_adjustments"


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
    txt = safe_str(s)
    out = {"cl": None, "tcv": None, "aav_values": [], "aav_canonical": None,
           "year_values": [], "extensions": [], "gtd": None}
    if not txt:
        return out
    m = re.search(r"(?:^|[|\s])CL\s+(\d+)", txt, re.IGNORECASE)
    if m:
        out["cl"] = safe_int(m.group(1))
    m = re.search(r"(?:^|[|\s])TCV\s+([0-9.]+K?)", txt, re.IGNORECASE)
    if m:
        out["tcv"] = parse_money_token(m.group(1))
    m = re.search(r"(?:^|\|)\s*AAV\s+([^|]+)", txt, re.IGNORECASE)
    if m:
        tokens = [t for t in re.split(r"[,/]", m.group(1)) if t.strip()]
        out["aav_values"] = [parse_money_token(t) for t in tokens if parse_money_token(t) > 0]
        if out["aav_values"]:
            out["aav_canonical"] = out["aav_values"][-1]
    for y, v in re.findall(r"Y(\d+)\s*[-:]\s*([0-9.]+K?)", txt, re.IGNORECASE):
        if parse_money_token(v) > 0:
            out["year_values"].append({"year": safe_int(y), "salary": parse_money_token(v)})
    m = re.search(r"(?:^|\|)\s*Ext\s*:\s*([^|]+)", txt, re.IGNORECASE)
    if m:
        out["extensions"] = [t.strip() for t in re.split(r"[,/]", m.group(1)) if t.strip()]
    m = re.search(r"(?:^|\|)\s*GTD\s*:?\s*([0-9.]+K?)", txt, re.IGNORECASE)
    if m:
        out["gtd"] = parse_money_token(m.group(1))
    return out


def detect_load_shape(year_values: list, contract_status: str) -> str:
    """BL/FL/FLAT/RESTRUCTURE based on year salary pattern."""
    cs = safe_str(contract_status).upper()
    if cs == "BL":
        return "BL"
    if cs == "FL":
        return "FL"
    yv = [y["salary"] for y in year_values]
    if not yv:
        return "UNKNOWN"
    if len(yv) == 1 or all(s == yv[0] for s in yv):
        return "FLAT"
    if all(yv[i + 1] > yv[i] for i in range(len(yv) - 1)):
        return "BL"
    if all(yv[i + 1] < yv[i] for i in range(len(yv) - 1)):
        return "FL"
    return "RESTRUCTURE"


def derive_contract_type(
    *,
    parsed: dict,
    contract_status: str,
    is_auction_year: bool,
    is_draft_year: bool,
    load_shape: str,
) -> str:
    """Returns 'Rookie' | 'Auction' | 'Tag' | 'ExtN' | 'Veteran' + optional load suffix."""
    cs = safe_str(contract_status)
    ext_count = len(parsed.get("extensions") or [])

    base = None
    if is_draft_year:
        base = "Rookie"
    elif is_auction_year:
        base = "Auction"
    elif "tag" in cs.lower():
        base = "Tag"
    elif ext_count > 0:
        base = f"Ext{ext_count}"
    elif cs.lower() == "rookie":
        base = "Rookie"
    else:
        base = "Veteran"

    if load_shape in ("BL", "FL", "RESTRUCTURE"):
        return f"{base} {load_shape}"
    return base


def load_salary_adjustments(years: list) -> dict:
    """Return dict of (season, player_id, franchise_id) -> list of adjustment events."""
    out = {}
    for yr in years:
        path = Path(SAL_ADJ_DIR) / f"salary_adjustments_{yr}.json"
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text())
        except Exception:
            continue
        for row in data.get("rows", []) or []:
            pid = safe_str(row.get("player_id"))
            if not pid:
                continue
            # Two time contexts matter: when the event occurred, and when the penalty is applied.
            # Primary key: adjustment_season (when the charge hits).
            key = (safe_int(row.get("adjustment_season")), pid)
            out.setdefault(key, []).append(row)
    return out


def load_end_of_season_snapshot(conn, player_id: str) -> dict:
    """Return {season: {...snapshot...}} using rosters_weekly final week per season."""
    rows = conn.execute(
        """
        SELECT season, week, franchise_id, team_name, salary, contract_year,
               contract_status, contract_info
        FROM rosters_weekly WHERE player_id=?
        """,
        (player_id,),
    ).fetchall()
    by_season: dict = {}
    for r in rows:
        s = r[0]
        existing = by_season.get(s)
        if existing is None or r[1] > existing["week"]:
            by_season[s] = {
                "season": s, "week": r[1], "franchise_id": r[2],
                "team_name": r[3], "salary": r[4], "contract_year": r[5],
                "contract_status": r[6], "contract_info": r[7],
            }
    # Pull CURRENT snapshot for latest season (rosters_current)
    rc_rows = conn.execute(
        """
        SELECT season, week, franchise_id, team_name, salary, contract_year,
               contract_status, contract_info
        FROM rosters_current WHERE player_id=?
        """,
        (player_id,),
    ).fetchall()
    for r in rc_rows:
        s = r[0]
        existing = by_season.get(s)
        if existing is None or r[1] > existing["week"]:
            by_season[s] = {
                "season": s, "week": r[1], "franchise_id": r[2],
                "team_name": r[3], "salary": r[4], "contract_year": r[5],
                "contract_status": r[6], "contract_info": r[7],
            }
    return by_season


def format_k(v: int) -> str:
    if not v:
        return "$0"
    if v >= 1000:
        if v % 1000 == 0:
            return f"${v // 1000}K"
        return f"${v/1000:.1f}K"
    return f"${v}"


def build_major_events(
    *,
    player_id: str,
    season: int,
    draft_row,
    auctions_in_season: list,
    trades_in_season: list,
    drops_in_season: list,
    adds_in_season: list,
    adj_in_season: list,
    prior_snap: dict | None,
    this_snap: dict,
    franchise_name_map: dict,
) -> list:
    def team_label(fid) -> str:
        nm = franchise_name_map.get(safe_str(fid))
        return nm or safe_str(fid) or "?"

    events = []

    # Rookie draft
    if draft_row and draft_row["season"] == season:
        events.append({
            "type": "DRAFT",
            "text": (f"R{draft_row['round']}.{draft_row['round_order']:02d} draft "
                     f"(overall {draft_row['overall']}) by {draft_row['franchise_name']}"),
        })
    # Auction wins
    for a in auctions_in_season:
        events.append({
            "type": "AUCTION",
            "text": f"FA AUCTION {format_k(a['bid'])} by {a['team']} ({a['auction_type']})",
            "datetime": a.get("datetime"),
        })
    # Trades — upstream-deduped into from→to pairs
    for t in trades_in_season:
        frm = t.get("from_team") or ""
        to = t.get("to_team") or ""
        if frm and to:
            txt = f"Traded from {frm} to {to}"
        elif to:
            txt = f"Traded to {to}"
        elif frm:
            txt = f"Traded from {frm}"
        else:
            txt = "Trade"
        events.append({
            "type": "TRADE",
            "text": txt,
            "datetime": t.get("datetime"),
            "txn_index": t.get("txn_index"),
            "trade_group_id": t.get("group_id"),
            "link_txn_id": (f"{season}_{t.get('txn_index')}" if t.get("txn_index") is not None else None),
        })
    # Pair drops with same-season ADDs by matching method → "WAIVER_SWAP" event.
    # MFL logs BBID pickups as DROP on prior team + ADD on new team with method='BBID'.
    used_adds = set()
    unmatched_drops = []
    for drop in drops_in_season:
        match = None
        for i, add in enumerate(adds_in_season):
            if i in used_adds:
                continue
            if safe_str(add.get("method")).upper() == safe_str(drop.get("method")).upper():
                match = (i, add)
                break
        if match:
            idx, add = match
            used_adds.add(idx)
            dr_team = team_label(drop.get("franchise_id"))
            ad_team = team_label(add.get("franchise_id"))
            method = safe_str(drop.get("method")) or "FA"
            add_salary = safe_int(add.get("salary"))
            this_ci = parse_contract_info(this_snap.get("contract_info") or "")
            cl_hint = f" → new {this_ci.get('cl')}yr contract" if this_ci.get("cl") else ""
            events.append({
                "type": "WAIVER_SWAP",
                "text": (f"{method} waiver: {dr_team} dropped → {ad_team} claimed "
                         f"{format_k(add_salary) if add_salary else 'salary n/a'}{cl_hint}"),
                "drop_datetime": drop.get("datetime"),
                "add_datetime": add.get("datetime"),
                "drop_franchise_id": drop.get("franchise_id"),
                "add_franchise_id": add.get("franchise_id"),
                "method": method,
            })
        else:
            unmatched_drops.append(drop)
    for drop in unmatched_drops:
        tm = team_label(drop.get("franchise_id"))
        events.append({
            "type": "DROP",
            "text": f"DROP by {tm} ({drop.get('method') or 'FA'})",
            "datetime": drop.get("datetime"),
            "franchise_id": drop.get("franchise_id"),
        })
    for i, add in enumerate(adds_in_season):
        if i in used_adds:
            continue
        tm = team_label(add.get("franchise_id"))
        sal = safe_int(add.get("salary"))
        events.append({
            "type": "ADD",
            "text": f"ADD by {tm} ({add.get('method') or 'FA'})"
                    + (f" {format_k(sal)}" if sal else ""),
            "datetime": add.get("datetime"),
            "franchise_id": add.get("franchise_id"),
        })

    # Rookie-to-new-contract transition: rookie was dropped+reclaimed
    prior_status = safe_str(prior_snap.get("contract_status") if prior_snap else "").lower()
    this_status = safe_str(this_snap.get("contract_status") or "").lower()
    if prior_status == "rookie" and this_status and this_status != "rookie":
        this_ci = parse_contract_info(this_snap.get("contract_info") or "")
        events.append({
            "type": "CONTRACT_RESET",
            "text": (f"Contract reset: rookie deal ended — now on "
                     f"{this_ci.get('cl') or 'N'}yr "
                     f"{format_k(this_ci.get('aav_canonical') or 0)}/yr "
                     f"{format_k(this_ci.get('tcv') or 0)} TCV"),
        })

    # Extensions (new Ext: tag entries)
    prior_exts = set(parse_contract_info(prior_snap.get("contract_info") if prior_snap else "").get("extensions") or [])
    this_exts = set(parse_contract_info(this_snap.get("contract_info", "")).get("extensions") or [])
    for e in sorted(this_exts - prior_exts):
        events.append({"type": "EXTENSION", "text": f"Extended by {e}"})

    # Restructure detection
    if prior_snap and (this_exts == prior_exts):
        prior_yv = parse_contract_info(prior_snap.get("contract_info") or "").get("year_values") or []
        this_yv = parse_contract_info(this_snap.get("contract_info") or "").get("year_values") or []
        prior_salaries = tuple(y["salary"] for y in prior_yv)
        this_salaries = tuple(y["salary"] for y in this_yv)
        if prior_salaries and this_salaries:
            shifted = prior_salaries[1:] if len(prior_salaries) > 1 else ()
            if shifted != this_salaries and prior_salaries != this_salaries:
                events.append({
                    "type": "RESTRUCTURE",
                    "text": "Restructured (year salaries changed)",
                })

    # Cap penalties / traded-salary adjustments — include WHICH team ate them
    for adj in adj_in_season:
        at = safe_str(adj.get("adjustment_type"))
        amt = safe_int(adj.get("amount"))
        direction = safe_str(adj.get("direction"))
        sign = "-" if direction == "charge" else "+"
        fr_name = safe_str(adj.get("franchise_name")) or team_label(adj.get("franchise_id"))
        label = "Cap penalty" if at == "DROP_PENALTY_CANDIDATE" else (
            "Traded salary" if at == "TRADED_SALARY" else at
        )
        events.append({
            "type": "CAP_ADJUSTMENT",
            "text": f"{label} {sign}{format_k(amt)} on {fr_name}",
            "franchise_id": adj.get("franchise_id"),
            "source_id": adj.get("source_id"),
        })
    return events


def build_player_record(
    conn,
    pid: str,
    meta_anchor_years: list,
    salary_adjustments: dict,
    current_franchise_map: dict,
    latest_season: int,
) -> dict:
    # Player identity (use latest players row)
    prow = conn.execute(
        """SELECT name, position, nfl_team FROM players WHERE player_id=?
           ORDER BY season DESC LIMIT 1""",
        (pid,),
    ).fetchone()
    name = prow[0] if prow else ""
    position = prow[1] if prow else ""
    nfl_team = prow[2] if prow else ""

    # End-of-season snapshots per year (across all seasons we have)
    by_season = load_end_of_season_snapshot(conn, pid)

    # Draft row (if rookie-drafted)
    drow = conn.execute(
        """SELECT season, draftpick_round AS "round", draftpick_roundorder AS round_order,
                  draftpick_overall AS overall, franchise_name
           FROM draftresults_mfl WHERE player_id=? ORDER BY season LIMIT 1""",
        (pid,),
    ).fetchone()
    draft_row = None
    if drow:
        draft_row = {
            "season": drow[0], "round": drow[1], "round_order": drow[2],
            "overall": drow[3], "franchise_name": drow[4],
        }

    # Auctions won
    auctions = conn.execute(
        """SELECT season, bid_amount, team_name, auction_type, datetime_et
           FROM transactions_auction
           WHERE player_id=? AND auction_event_type='WON'
           ORDER BY season, datetime_et""",
        (pid,),
    ).fetchall()
    auctions_by_season: dict = {}
    for a in auctions:
        auctions_by_season.setdefault(a[0], []).append({
            "bid": a[1], "team": a[2], "auction_type": a[3], "datetime": a[4],
        })

    # Trades: group by (season, txn_index) so SENDER + RECEIVER become ONE event
    trade_rows = conn.execute(
        """SELECT season, txn_index, datetime_et, franchise_name, franchise_role, trade_group_id
           FROM transactions_trades
           WHERE player_id=? AND asset_type='PLAYER'
           ORDER BY season, txn_index, franchise_role""",
        (pid,),
    ).fetchall()
    trades_by_season: dict = {}
    by_txn: dict = {}
    for t in trade_rows:
        key = (t[0], t[1])
        entry = by_txn.setdefault(key, {"season": t[0], "txn_index": t[1], "datetime": t[2],
                                       "from_team": None, "to_team": None, "group_id": t[5]})
        if t[4] == "SENDER":
            entry["from_team"] = t[3]
        elif t[4] == "RECEIVER":
            entry["to_team"] = t[3]
    for (season, _), v in by_txn.items():
        trades_by_season.setdefault(season, []).append(v)

    # Add/drops (BOTH sides so we can show BBID waiver pickups, not just drops)
    adddrops = conn.execute(
        """SELECT season, txn_index, datetime_et, franchise_id, move_type, method, salary
           FROM transactions_adddrop
           WHERE player_id=?
           ORDER BY season, txn_index""",
        (pid,),
    ).fetchall()
    drops_by_season: dict = {}
    adds_by_season: dict = {}
    for d in adddrops:
        entry = {
            "txn_index": d[1], "datetime": d[2], "franchise_id": d[3],
            "move_type": d[4], "method": d[5], "salary": d[6],
        }
        if safe_str(d[4]).upper() == "DROP":
            drops_by_season.setdefault(d[0], []).append(entry)
        elif safe_str(d[4]).upper() == "ADD":
            adds_by_season.setdefault(d[0], []).append(entry)

    # Build lineage
    seasons_sorted = sorted(by_season.keys())
    lineage: dict = {}

    # Epoch tracker for salary_earned: resets at auction win or drop-then-add
    epoch_earned = 0
    last_franchise = None
    for season in seasons_sorted:
        snap = by_season[season]
        prior = by_season.get(season - 1)
        parsed = parse_contract_info(snap["contract_info"] or "")

        # Detect epoch reset events
        auctions_this = auctions_by_season.get(season, [])
        drops_this = drops_by_season.get(season, [])
        adds_this = adds_by_season.get(season, [])
        trades_this = trades_by_season.get(season, [])
        adj_this = salary_adjustments.get((season, pid), [])

        is_auction_year = bool(auctions_this)
        is_draft_year = bool(draft_row and draft_row["season"] == season)

        # Salary-earned epoch management:
        # - Draft year = start epoch
        # - Auction-win year = reset epoch
        # - Drop-then-re-add in same year counts as reset (handled via auction if auctioned, else partial)
        if is_draft_year or is_auction_year:
            epoch_earned = 0

        salary = safe_int(snap["salary"])
        epoch_earned += salary

        # AAV: parsed or derived from TCV/CL
        aav = parsed["aav_canonical"]
        aav_source = "stored"
        if (aav is None or aav == 0) and parsed["tcv"] and parsed["cl"]:
            aav = parsed["tcv"] // parsed["cl"]
            aav_source = "derived_tcv_div_cl"
        tcv = parsed["tcv"]

        load_shape = detect_load_shape(parsed["year_values"], snap.get("contract_status") or "")
        contract_type = derive_contract_type(
            parsed=parsed,
            contract_status=safe_str(snap.get("contract_status")),
            is_auction_year=is_auction_year,
            is_draft_year=is_draft_year,
            load_shape=load_shape,
        )

        events = build_major_events(
            player_id=pid, season=season, draft_row=draft_row,
            auctions_in_season=auctions_this, trades_in_season=trades_this,
            drops_in_season=drops_this, adds_in_season=adds_this,
            adj_in_season=adj_this,
            prior_snap=prior, this_snap=snap,
            franchise_name_map=current_franchise_map,
        )
        # Sort events within each year chronologically when timestamps are present.
        # Events without a datetime (DRAFT, EXTENSION, RESTRUCTURE, CONTRACT_RESET,
        # CAP_ADJUSTMENT) fall back to a type-weighted order so the story reads right.
        type_order = {
            "DRAFT": 0, "AUCTION": 1, "TRADE": 2, "DROP": 3, "ADD": 4,
            "WAIVER_SWAP": 5, "CONTRACT_RESET": 6, "EXTENSION": 7,
            "RESTRUCTURE": 8, "CAP_ADJUSTMENT": 9,
        }
        def _key(ev):
            dt = ev.get("datetime") or ev.get("drop_datetime") or ev.get("add_datetime") or ""
            return (dt or "9999", type_order.get(ev.get("type"), 99))
        events = sorted(events, key=_key)

        team_id_resolved = safe_str(snap.get("franchise_id"))
        team_name_resolved = safe_str(snap.get("team_name"))
        if not team_name_resolved and team_id_resolved:
            # Fall back to current franchise map for seasons where team_name is missing
            team_name_resolved = current_franchise_map.get(team_id_resolved, "")
        lineage[str(season)] = {
            "team_id": team_id_resolved,
            "team_name": team_name_resolved,
            "salary": salary,
            "aav": aav,
            "aav_source": aav_source,
            "tcv": tcv,
            "contract_type": contract_type,
            "load_shape": load_shape,
            "contract_status_raw": safe_str(snap.get("contract_status")),
            "contract_year_raw": snap.get("contract_year"),
            "contract_info_raw": safe_str(snap.get("contract_info")),
            "year_values": parsed["year_values"],
            "extensions_list": parsed["extensions"],
            "salary_earned": epoch_earned,
            "major_events": events,
        }

    # Current-season fields for filtering in the UI
    cur_snap = by_season.get(latest_season, {})
    current_team_id = safe_str(cur_snap.get("franchise_id"))
    current_team_name = current_franchise_map.get(current_team_id) or safe_str(cur_snap.get("team_name"))

    return {
        "player_id": pid,
        "name": name,
        "position": position,
        "nfl_team": nfl_team,
        "current_team_id": current_team_id,
        "current_team_name": current_team_name,
        "drafted": draft_row,
        "lineage": lineage,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db-path", default=DEFAULT_DB)
    ap.add_argument("--out-path", default=DEFAULT_OUT)
    ap.add_argument("--anchor-years", type=int, default=5,
                    help="How many anchor years to surface in the dropdown (default 5)")
    ap.add_argument("--current-season", type=int, default=None)
    args = ap.parse_args()

    conn = sqlite3.connect(args.db_path)
    conn.row_factory = sqlite3.Row
    try:
        # Determine current season
        latest_season = args.current_season
        if latest_season is None:
            r = conn.execute("SELECT MAX(season) FROM rosters_current").fetchone()
            latest_season = r[0] if r else 2026
        latest_week_row = conn.execute(
            "SELECT MAX(week) FROM rosters_current WHERE season=?", (latest_season,)
        ).fetchone()
        latest_week = latest_week_row[0] if latest_week_row else 1

        # Build franchise name map (latest season)
        frs = conn.execute(
            """SELECT franchise_id, team_name FROM franchises
               WHERE season=(SELECT MAX(season) FROM franchises)"""
        ).fetchall()
        franchise_map = {r[0]: r[1] for r in frs}

        # Pull currently rostered player ids (latest week of latest season)
        pids = [r[0] for r in conn.execute(
            """SELECT DISTINCT player_id FROM rosters_current
               WHERE season=? AND week=? AND (status IS NULL OR status IN ('ROSTER','TAXI_SQUAD','INJURED_RESERVE',''))
               AND COALESCE(contract_info,'') != ''""",
            (latest_season, latest_week),
        ).fetchall()]

        # Load all-season salary adjustments
        years_for_adj = list(range(latest_season - 15, latest_season + 1))
        sal_adj = load_salary_adjustments(years_for_adj)

        # Build players
        players = []
        for pid in pids:
            try:
                rec = build_player_record(conn, pid, [], sal_adj, franchise_map, latest_season)
                players.append(rec)
            except Exception as e:
                print(f"ERROR pid={pid}: {e}", flush=True)

        anchor_years = list(range(latest_season - args.anchor_years + 1, latest_season + 1))

        payload = {
            "meta": {
                "generated_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "current_season": latest_season,
                "current_week": latest_week,
                "anchor_years": anchor_years,
                "current_franchises": franchise_map,
                "player_count": len(players),
            },
            "players": sorted(players, key=lambda p: (p.get("current_team_name") or "", p.get("position") or "", p.get("name") or "")),
        }

        out_path = Path(args.out_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2))
        print(json.dumps({
            "ok": True,
            "players": len(players),
            "anchor_years": anchor_years,
            "out_path": str(out_path),
            "size_bytes": out_path.stat().st_size,
        }, indent=2))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
