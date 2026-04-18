#!/usr/bin/env python3
"""
Trace a player's full contract lineage:
  - Acquisition (draft / auction / waiver / trade)
  - Year-by-year snapshot (salary, AAV, contract_info)
  - Extension events (team, term, raise applied)
  - Trade events (from → to)
  - Computed expected AAV path vs stored AAV at each step

Output: structured JSON + human-readable timeline printout.

Usage:
  python3 trace_contract_history.py --player-id 16187
  python3 trace_contract_history.py --player-ids 13630,15753,15290
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import defaultdict
from typing import Any, Optional

DEFAULT_DB = os.environ.get(
    "MFL_DB_PATH",
    "/Users/keithcreelman/Desktop/MFL_Scripts/Datastorage/mfl_database.db",
)


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


def fetch_player_meta(conn, pid: str) -> dict:
    row = conn.execute(
        """SELECT name, position FROM players WHERE player_id=?
           ORDER BY season DESC LIMIT 1""", (pid,)
    ).fetchone()
    return {"player_id": pid,
            "name": row[0] if row else None,
            "position": row[1] if row else None}


def fetch_draft(conn, pid: str) -> Optional[dict]:
    row = conn.execute(
        """SELECT season, draftpick_round, draftpick_roundorder, draftpick_overall,
                  franchise_id, franchise_name
           FROM draftresults_mfl WHERE player_id=? ORDER BY season LIMIT 1""",
        (pid,)
    ).fetchone()
    if not row:
        return None
    return {"event": "DRAFT", "season": row[0],
            "round": row[1], "round_order": row[2], "overall": row[3],
            "franchise_id": row[4], "franchise_name": row[5]}


def fetch_auctions(conn, pid: str) -> list[dict]:
    """Auctions are BASELINE RESETS — a winning bid becomes the new AAV."""
    rows = conn.execute(
        """SELECT season, auction_event_type, franchise_id, team_name,
                  bid_amount, auction_type, datetime_et
           FROM transactions_auction
           WHERE player_id=? AND auction_event_type='WON'
           ORDER BY season, datetime_et""", (pid,)
    ).fetchall()
    return [{"event": "AUCTION_WIN", "season": r[0], "event_type": r[1],
             "franchise_id": r[2], "franchise_name": r[3],
             "winning_bid": r[4], "auction_type": r[5], "datetime": r[6]}
            for r in rows]


def table_has(conn, table: str, column: str) -> bool:
    cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return column in cols


def fetch_trades(conn, pid: str) -> list[dict]:
    rows = conn.execute(
        """SELECT season, txn_index, unix_timestamp, datetime_et, franchise_id,
                  franchise_name, franchise_role, asset_role, trade_group_id
           FROM transactions_trades
           WHERE player_id=? AND asset_type='PLAYER'
           ORDER BY season, txn_index""", (pid,)
    ).fetchall() if table_has(conn, "transactions_trades", "trade_group_id") \
        else conn.execute(
        """SELECT season, txn_index, NULL as unix_timestamp, NULL as datetime_et,
                  franchise_id, franchise_name, franchise_role, asset_role, NULL
           FROM transactions_trades
           WHERE player_id=? AND asset_type='PLAYER'
           ORDER BY season, txn_index""", (pid,)
    ).fetchall()
    out = []
    for r in rows:
        out.append({"event": "TRADE", "season": r[0], "txn_index": r[1],
                    "datetime": r[3], "franchise_id": r[4],
                    "franchise_name": r[5], "role": r[6], "asset_role": r[7],
                    "group_id": r[8]})
    return out


def fetch_adds_drops(conn, pid: str) -> list[dict]:
    rows = conn.execute(
        """SELECT season, txn_index, datetime_et, franchise_id, move_type, method, salary
           FROM transactions_adddrop
           WHERE player_id=?
           ORDER BY season, txn_index""", (pid,)
    ).fetchall()
    return [{"event": "ADD_DROP", "season": r[0], "txn_index": r[1],
             "datetime": r[2], "franchise_id": r[3],
             "move_type": r[4], "method": r[5], "salary": r[6]} for r in rows]


def fetch_extensions(conn, pid: str) -> list[dict]:
    """Extension submissions (if logged)."""
    if not table_has(conn, "extension_submissions", "player_id"):
        return []
    rows = conn.execute(
        """SELECT created_at, franchise_id, franchise_name, option, term_years,
                  total_years, tcv_total
           FROM extension_submissions
           WHERE player_id=?
           ORDER BY created_at""", (pid,)
    ).fetchall()
    return [{"event": "EXT_SUBMISSION", "created_at": r[0],
             "franchise_id": r[1], "franchise_name": r[2],
             "option": r[3], "term_years": r[4],
             "total_years": r[5], "tcv_total": r[6]} for r in rows]


def fetch_weekly_snapshots(conn, pid: str) -> list[dict]:
    """Week 1 and final week of each season."""
    rows = conn.execute(
        """SELECT season, week, franchise_id, team_name, salary, contract_year,
                  contract_status, contract_info
           FROM rosters_weekly WHERE player_id=?
           ORDER BY season, week""", (pid,)
    ).fetchall()
    by_season = defaultdict(list)
    for r in rows:
        by_season[r[0]].append({"season": r[0], "week": r[1], "franchise_id": r[2],
                                "team_name": r[3], "salary": r[4],
                                "contract_year": r[5], "contract_status": r[6],
                                "contract_info": r[7]})
    out = []
    for season, lst in sorted(by_season.items()):
        # keep week 1 and last week to see rollover within the season
        lst_sorted = sorted(lst, key=lambda x: x["week"])
        out.append({"phase": "WEEK_1", **lst_sorted[0]})
        if lst_sorted[-1]["week"] != lst_sorted[0]["week"]:
            out.append({"phase": "FINAL_WEEK", **lst_sorted[-1]})
    # also include rosters_current (latest season)
    rc_rows = conn.execute(
        """SELECT season, week, franchise_id, team_name, salary, contract_year,
                  contract_status, contract_info
           FROM rosters_current WHERE player_id=?
           ORDER BY season, week""", (pid,)
    ).fetchall()
    for r in rc_rows:
        out.append({"phase": "CURRENT", "season": r[0], "week": r[1],
                    "franchise_id": r[2], "team_name": r[3], "salary": r[4],
                    "contract_year": r[5], "contract_status": r[6],
                    "contract_info": r[7]})
    return out


def fetch_extension_rates(conn) -> dict:
    rows = conn.execute(
        """SELECT season, positional_grouping, extensionrate_1yr, extensionrate_2yr
           FROM conformance_extensions"""
    ).fetchall()
    out: dict = defaultdict(dict)
    for r in rows:
        out[r[0]][safe_str(r[1]).upper()] = {1: r[2], 2: r[3]}
    return out


POSITION_GROUP_MAP = {
    "CB": "DB", "S": "DB", "DB": "DB",
    "DE": "DL", "DT": "DL", "DL": "DL",
    "K": "PK", "PK": "PK", "PN": "PN", "P": "PN",
}


def position_group(pos: str) -> str:
    p = safe_str(pos).upper()
    return POSITION_GROUP_MAP.get(p, p)


def compute_expected_aav_after_ext(prior_aav: int, ext_years: int,
                                    season: int, pos_group: str,
                                    rates: dict) -> int:
    yr_rates = rates.get(season, {}).get(pos_group) or \
               rates.get(max(rates.keys(), default=season), {}).get(pos_group) or {}
    raise_amt = yr_rates.get(ext_years, 0)
    return prior_aav + raise_amt


def trace_player(conn, pid: str, rates: dict) -> dict:
    meta = fetch_player_meta(conn, pid)
    pos_group = position_group(meta["position"] or "")

    events = []
    draft = fetch_draft(conn, pid)
    if draft:
        events.append({"ts": f"{draft['season']}-draft", **draft})
    for a in fetch_auctions(conn, pid):
        events.append({"ts": f"{a['season']}-auction", **a})
    for t in fetch_trades(conn, pid):
        events.append({"ts": t["datetime"] or f"{t['season']}-trade-{t['txn_index']}", **t})
    for ad in fetch_adds_drops(conn, pid):
        events.append({"ts": ad["datetime"] or f"{ad['season']}-adddrop-{ad['txn_index']}", **ad})
    for e in fetch_extensions(conn, pid):
        events.append({"ts": e["created_at"], **e})

    snaps = fetch_weekly_snapshots(conn, pid)

    # Build a merged annual timeline
    seasons_seen = sorted({s["season"] for s in snaps})
    annual = []
    for season in seasons_seen:
        season_snaps = [s for s in snaps if s["season"] == season]
        wk1 = next((s for s in season_snaps if s["phase"] == "WEEK_1"), None)
        last = next((s for s in season_snaps if s["phase"] == "FINAL_WEEK"), None)
        cur = next((s for s in season_snaps if s["phase"] == "CURRENT"), None)
        focus = cur or wk1 or last
        if not focus:
            continue
        parsed = parse_contract_info(focus["contract_info"])
        # Fill missing AAV for old rookie strings (pre-AAV-label era): AAV = TCV / CL
        # Only applies when string has TCV and CL but no AAV token AND no Ext (so it's
        # a flat rookie contract). Flag as DERIVED so it's obvious in the trace.
        aav_source = "stored"
        if parsed["aav_canonical"] in (None, 0) and parsed["tcv"] and parsed["cl"]:
            # Derive AAV from TCV/CL when the AAV token is missing.
            # Per RULE-CONTRACT-005 invariant: AAV × CL == TCV.
            # This handles old rookie strings and mid-extension strings that
            # didn't include an explicit AAV segment (e.g., Collins 2024
            # "CL 2| TCV 44K| Ext: C-Town").
            parsed["aav_canonical"] = parsed["tcv"] // parsed["cl"]
            aav_source = "derived_tcv_div_cl"
        # BL/FL/FLAT/RESTRUCTURE detection — RULE-CONTRACT-005
        load_shape = "unknown"
        yv = [y["salary"] for y in parsed["year_values"]]
        if len(yv) >= 2:
            if all(s == yv[0] for s in yv):
                load_shape = "FLAT"
            elif all(yv[i+1] > yv[i] for i in range(len(yv)-1)):
                load_shape = "BL"
            elif all(yv[i+1] < yv[i] for i in range(len(yv)-1)):
                load_shape = "FL"
            else:
                load_shape = "RESTRUCTURE"
        elif len(yv) == 1:
            load_shape = "FLAT"
        annual.append({
            "season": season,
            "franchise_id": focus["franchise_id"],
            "team_name": focus["team_name"],
            "week_label": focus["phase"] + (f" wk{focus['week']}" if focus.get("week") else ""),
            "salary": focus["salary"],
            "contract_year_remaining": focus["contract_year"],
            "contract_status": focus["contract_status"],
            "contract_info": focus["contract_info"],
            "cl": parsed["cl"],
            "tcv": parsed["tcv"],
            "aav_stored": parsed["aav_canonical"],
            "aav_values_list": parsed["aav_values"],
            "extensions_list": parsed["extensions"],
            "year_values": parsed["year_values"],
            "sum_year_salaries": sum(y["salary"] for y in parsed["year_values"]),
            "aav_source": aav_source,
            "load_shape": load_shape,
        })

    # Extension-math verification walking forward.
    # Auctions are baseline resets — when a player is auctioned, the winning bid
    # becomes the new AAV for the new contract, ignoring the prior AAV.
    auctions_by_season = {a["season"]: a for a in fetch_auctions(conn, pid)}
    rate_years = sorted(rates.keys())

    def _rates_for(season: int, group: str) -> dict:
        # Prefer exact season, then nearest prior year, then fall forward to earliest
        # available year if no prior data (handles gap in conformance_extensions).
        cand = rates.get(season, {}).get(group)
        if cand:
            return cand
        for yr in reversed(rate_years):
            if yr <= season and rates.get(yr, {}).get(group):
                return rates[yr][group]
        for yr in rate_years:
            if rates.get(yr, {}).get(group):
                return rates[yr][group]
        return {}

    aav_trace = []
    prev_aav = None
    prev_ext_count = 0
    for idx, yr in enumerate(annual):
        aav_this = yr["aav_stored"]
        ext_count = len(yr["extensions_list"] or [])
        note = []
        event_label = ""
        expected_aav = None

        auction = auctions_by_season.get(yr["season"])
        if auction:
            # Baseline reset from auction win
            expected_aav = auction["winning_bid"]
            event_label = f"AUCTION ${auction['winning_bid']//1000}K to {auction['franchise_name']}"
            if aav_this == expected_aav:
                note.append(f"auction baseline ${auction['winning_bid']//1000}K ✓")
            else:
                note.append(f"auction winning_bid ${auction['winning_bid']} != stored AAV ${aav_this}")
            prev_ext_count = ext_count  # reset
        elif prev_aav is None:
            # First season we have data for — baseline is rookie slot or derived
            event_label = "ROOKIE/BASELINE"
            note.append(f"baseline AAV = {aav_this}")
        else:
            ext_delta = ext_count - prev_ext_count
            if ext_delta == 0:
                expected_aav = prev_aav
                if aav_this != prev_aav:
                    event_label = "RESTRUCTURE/UNKNOWN"
                    note.append(f"AAV changed {prev_aav}→{aav_this} with no new Ext tag (restructure?)")
                else:
                    event_label = ""
            else:
                yr_rates = _rates_for(yr["season"], pos_group)
                r1 = yr_rates.get(1, 0)
                r2 = yr_rates.get(2, 0)
                # HISTORICAL RATE DETECTION: if current rate doesn't match, also try
                # the pre-TE-premium / pre-Super-Flex rate of $6K/$12K for QB/TE.
                # Helps back-validate old extensions without full rate-table history.
                candidates = [(r1, 1, "current-1yr"), (r2, 2, "current-2yr")]
                # Historical pre-premium rates apply ONLY to:
                #   - QB (before league adopted Super Flex)
                #   - TE (before league adopted TE Premium)
                # RB and WR rates have always been 10/20 — do NOT fallback on those.
                if pos_group in ("QB", "TE"):
                    candidates += [(6000, 1, "pre-premium-1yr"), (12000, 2, "pre-premium-2yr")]
                # Also consider multi-ext in one season (2 × 1yr combos)
                matched = None
                for raise_amt, term, label in candidates:
                    exp = prev_aav + raise_amt
                    if aav_this == exp:
                        matched = (raise_amt, term, label, exp)
                        break
                    exp_double = prev_aav + raise_amt * 2
                    if ext_delta >= 2 and aav_this == exp_double:
                        matched = (raise_amt * 2, term, f"2×{label}", exp_double)
                        break
                if matched:
                    raise_amt, term, label, exp = matched
                    expected_aav = exp
                    event_label = f"EXT {term}YR +${raise_amt//1000}K ({label})"
                    note.append(f"{term}YR {label}: {prev_aav}+{raise_amt}={exp} ✓")
                    # If matched at historical rate, note the year/position implies the rate
                    # change happened AFTER this season.
                    if "pre-premium" in label:
                        note.append(f"implies {pos_group} rate was still $6K/$12K in {yr['season']}")
                else:
                    exp1 = prev_aav + r1
                    exp2 = prev_aav + r2
                    event_label = f"EXT? delta={ext_delta}"
                    note.append(
                        f"stored AAV {aav_this} doesn't match 1YR={exp1} or 2YR={exp2} (current rates)"
                    )
        aav_trace.append({
            "season": yr["season"],
            "team": yr["team_name"],
            "salary": yr["salary"],
            "aav_stored": aav_this,
            "event_label": event_label,
            "expected_aav": expected_aav,
            "note": "; ".join(note),
            "verified": bool(expected_aav is not None and expected_aav == aav_this),
        })
        prev_aav = aav_this
        prev_ext_count = ext_count

    return {
        "meta": meta,
        "pos_group": pos_group,
        "draft": draft,
        "events_timeline": sorted(events, key=lambda e: str(e.get("ts") or "")),
        "annual_snapshots": annual,
        "aav_trace": aav_trace,
    }


def format_k(v: int) -> str:
    if not v:
        return "$0"
    if v >= 1000:
        if v % 1000 == 0:
            return f"${v // 1000}K"
        return f"${v/1000:.1f}K"
    return f"${v}"


def print_report(result: dict) -> None:
    m = result["meta"]
    print(f"\n{'='*90}")
    print(f"{m['name']} (pid={m['player_id']}, pos={m['position']}, group={result['pos_group']})")
    print(f"{'='*90}")

    if result["draft"]:
        d = result["draft"]
        print(f"DRAFTED {d['season']} R{d['round']}.{d['round_order']:02d} "
              f"(overall {d['overall']}) by {d['franchise_name']}")
    else:
        print("DRAFTED: not in draft records")

    # Concise Player/Year/Salary/AAV table with load shape
    print(f"\n{'Year':4} {'Team':20} {'Salary':>8} {'AAV':>8} {'Shape':5} {'Event':26} {'Verified'}")
    print("-" * 98)
    annual_by_season = {y["season"]: y for y in result["annual_snapshots"]}
    for t in result["aav_trace"]:
        yr = annual_by_season.get(t["season"], {})
        team = (t["team"] or "")[:19]
        sal = yr.get("salary") or 0
        shape = yr.get("load_shape") or "-"
        status = "✓" if t["verified"] else "⚠"
        if t["expected_aav"] is None and not t["event_label"].startswith("EXT?"):
            status = "—"
        print(f"{t['season']:4} {team:20} {format_k(sal):>8} {format_k(t['aav_stored'] or 0):>8} "
              f"{shape:5} {(t['event_label'] or '')[:25]:26} {status}")

    # Show any mismatch details
    warnings = [t for t in result["aav_trace"] if not t["verified"] and t["expected_aav"] is not None and t["expected_aav"] != t["aav_stored"]]
    if warnings:
        print(f"\n⚠ MISMATCHES:")
        for w in warnings:
            print(f"  {w['season']} {w['team'] or ''}: {w['note']}")

    # Show full contractInfo strings for reference
    print(f"\nContractInfo strings:")
    for yr in result["annual_snapshots"]:
        print(f"  {yr['season']} {(yr['team_name'] or '')[:20]:20}: {yr['contract_info']}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--player-id", default=None)
    ap.add_argument("--player-ids", default=None,
                    help="comma-separated list")
    ap.add_argument("--db-path", default=DEFAULT_DB)
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()

    pids: list[str] = []
    if args.player_id:
        pids = [args.player_id.strip()]
    elif args.player_ids:
        pids = [p.strip() for p in args.player_ids.split(",") if p.strip()]
    if not pids:
        print("ERROR: --player-id or --player-ids required", file=sys.stderr)
        return 2

    conn = sqlite3.connect(args.db_path)
    try:
        rates = fetch_extension_rates(conn)
        results = {}
        for pid in pids:
            r = trace_player(conn, pid, rates)
            results[pid] = r
            print_report(r)
        if args.json_out:
            with open(args.json_out, "w") as f:
                json.dump(results, f, indent=2, default=str)
            print(f"\nJSON saved: {args.json_out}")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
