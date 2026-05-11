#!/usr/bin/env python3
"""
Cap-penalty cycle backfill from local mfl_database.db (v2).

Pairs acquisition→drop events per (player_id, franchise_id) into cycles.

DATA SOURCES:
  - transformed_transactions: explicit add/drop/trade/draft events
  - trades:                   resolves NULL player_id on trade rows
  - rosters:                  end-of-year snapshots, used ONLY to detect
                              natural contract expirations (the only
                              inference allowed; per Keith — trades, drops
                              must come from explicit transaction data)

CYCLE-CLOSE LOGIC (in order of preference):
  1. Explicit drop event in transactions → close as 'cut'
  2. Explicit trade event (giving franchise) → close as 'trade'
  3. INFERRED: player on franchise X end of year Y, NOT on any roster
     end of year Y+1, AND no explicit drop/trade in year Y+1 →
     close as 'expired' at March 1 of year Y+1 (rollover)

If a cycle is still open AND player appears on a DIFFERENT franchise in
year Y+1 with NO trade event linking the franchises in our data, that's
flagged as 'data_gap' and surfaced in the report — NOT inferred (per Keith).

EXCLUSIONS:
  - 2010 — pre-dynasty era (FA Auction only, no rookie draft, no dynasty
    cap). Per docs/league_context_v1.md Section 4 line 1243.

Run modes:
  --dry-run           Build cycles, write summary JSON to /tmp; do NOT write to D1.
  --season YYYY       Limit to one season (for spot-checking).
  --apply             Write completed cycles to D1.

Default: dry-run for all seasons 2011-2024.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "pipelines" / "etl" / "lib"))

import cap_penalty as cp  # noqa: E402

LOCAL_DB = "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL- BOT/mfl_database.db"

# 2010 is pre-dynasty era; excluded entirely.
INCLUDED_SEASONS = list(range(2011, 2025))

UPS_REG_SEASON_WEEKS = {y: 16 for y in range(2010, 2025)}
UPS_REG_SEASON_WEEKS.update({2025: 17, 2026: 17, 2027: 17})

WEEK1_FIRST_GAME = {
    2010: date(2010, 9, 9),  2011: date(2011, 9, 8),  2012: date(2012, 9, 5),
    2013: date(2013, 9, 5),  2014: date(2014, 9, 4),  2015: date(2015, 9, 10),
    2016: date(2016, 9, 8),  2017: date(2017, 9, 7),  2018: date(2018, 9, 6),
    2019: date(2019, 9, 5),  2020: date(2020, 9, 10), 2021: date(2021, 9, 9),
    2022: date(2022, 9, 8),  2023: date(2023, 9, 7),  2024: date(2024, 9, 5),
    2025: date(2025, 9, 4),  2026: date(2026, 9, 10), 2027: date(2027, 9, 9),
}

# Mapping local-transaction transaction_type → calculator's acquisition_path.
TXTYPE_TO_PATH = {
    "AUCTION_WON":              "auction",
    "BBID_WAIVER":              "ww",
    "BBID_AUTO_PROCESS_WAIVERS":"ww",
    "BBID_PROCESS_WAIVERS":     "ww",
    "WAIVER":                   "ww",
    "PROCESS_WAIVERS":          "ww",
    "FREE_AGENT":               "fcfs",
    "TRADE":                    "trade",
    "DRAFT_PICK":               "rookie_draft",
}


def parse_ts(ts) -> datetime | None:
    if ts is None or ts == "":
        return None
    if isinstance(ts, int) or (isinstance(ts, str) and ts.isdigit()):
        return datetime.fromtimestamp(int(ts))
    try:
        return datetime.strptime(str(ts).strip(), "%Y-%m-%d %H:%M:%S")
    except Exception:
        try:
            return datetime.fromisoformat(str(ts))
        except Exception:
            return None


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------

def load_transactions(con) -> list[dict]:
    """All transformed_transactions across included seasons, ordered by timestamp."""
    placeholders = ",".join("?" * len(INCLUDED_SEASONS))
    sql = f"""
        SELECT year, franchise_id, franchise2_id, transaction_type, timestamp,
               player_id, action, salary, transaction_id
        FROM transformed_transactions
        WHERE year IN ({placeholders})
        ORDER BY year, timestamp, id
    """
    cur = con.execute(sql, INCLUDED_SEASONS)
    return [dict(zip([c[0] for c in cur.description], r)) for r in cur]


def load_trades_lookup(con) -> dict:
    """{ transaction_id: [(player_id, from_fid, to_fid), ...] } for player-asset trades only."""
    by_txn = defaultdict(list)
    sql = """
        SELECT transaction_id, player_id, previous_franchise_id, acquiring_franchise_id, pick_type
        FROM trades
        WHERE player_id IS NOT NULL AND player_id != ''
    """
    for txn_id, pid, from_fid, to_fid, pick_type in con.execute(sql):
        if pick_type and pick_type.strip():
            continue  # skip pick assets — only player trades drive cycles
        by_txn[txn_id].append((pid, from_fid, to_fid))
    return dict(by_txn)


def load_rosters_by_year(con) -> tuple[dict, dict]:
    """
    Returns:
      by_year_franchise: { (year, player_id): franchise_id } — each player's franchise at end of year
      on_roster:         { year: set(player_ids on any roster) }
    """
    by_year_franchise = {}
    on_roster = defaultdict(set)
    placeholders = ",".join("?" * len(INCLUDED_SEASONS))
    sql = f"SELECT year, franchise_id, player_id FROM rosters WHERE year IN ({placeholders})"
    for year, fid, pid in con.execute(sql, INCLUDED_SEASONS):
        by_year_franchise[(year, pid)] = fid
        on_roster[year].add(pid)
    return by_year_franchise, dict(on_roster)


# ---------------------------------------------------------------------------
# Trade expansion
# ---------------------------------------------------------------------------

def expand_trade_events(events: list[dict], trades_by_txn: dict) -> list[dict]:
    """
    A trade row in transformed_transactions can have NULL player_id. We
    consult the trades table by transaction_id and expand into one event
    per traded player. Each expanded event is also CLONED for the giving
    franchise so we know to close that cycle.
    """
    out = []
    for ev in events:
        action = (ev.get("action") or "").lower()
        if action != "trade" or (ev.get("player_id") and ev["player_id"] != ""):
            out.append(ev)
            continue

        txn_id = ev.get("transaction_id")
        assets = trades_by_txn.get(txn_id, [])
        if not assets:
            # No matching trade row — skip silently (possibly pick-only trade).
            continue

        for pid, from_fid, to_fid in assets:
            # Receiving franchise (acquiring) opens cycle.
            out.append({
                **ev,
                "player_id": pid,
                "franchise_id": to_fid,
                "franchise2_id": from_fid,
                "_trade_role": "receiving",
            })
            # Giving franchise closes cycle. We synthesize a separate event row
            # rather than relying on action='trade' double-handling.
            out.append({
                **ev,
                "player_id": pid,
                "franchise_id": from_fid,
                "franchise2_id": to_fid,
                "_trade_role": "giving",
            })
    # Re-sort by timestamp so the giving + receiving events of the same trade are
    # adjacent (timestamp ties are stable in Python sort).
    return sorted(out, key=lambda e: (e.get("year") or 0, str(e.get("timestamp") or "")))


# ---------------------------------------------------------------------------
# Cycle pairing
# ---------------------------------------------------------------------------

def derive_acquisition_week(acq_dt: datetime, season: int) -> int:
    if not acq_dt:
        return 0
    week1 = WEEK1_FIRST_GAME.get(season)
    if not week1:
        return 0
    acq_d = acq_dt.date()
    if acq_d < week1:
        return 0
    days = (acq_d - week1).days
    week = (days // 7) + 1
    total = UPS_REG_SEASON_WEEKS.get(season, 17)
    return min(week, total)


def pair_cycles(events: list[dict], by_year_franchise: dict | None = None) -> dict:
    """
    Walk events chronologically per (player_id, franchise_id).
    Returns lists: closed_cycles, unmatched_drops, still_open_cycles, stats.

    by_year_franchise: { (year, player_id): franchise_id } from rosters.
        Required for the overlap→expiration inference. If None, overlapping
        re-acquisitions all flag as data_gap.
    """
    by_year_franchise_global = by_year_franchise or {}
    open_cycles: dict[tuple, dict] = {}
    closed_cycles: list[dict] = []
    unmatched_drops: list[dict] = []
    overlapping_warnings: list[dict] = []
    stats = defaultdict(int)

    def open_cycle(ev: dict, path: str):
        key = (ev["player_id"], ev["franchise_id"])
        if key in open_cycles:
            # Already open. Try to infer an expiration close for the prior
            # cycle BEFORE flagging as data_gap. Logic: if there's a year
            # gap between the prior cycle's last roster appearance and the
            # new acquisition (i.e., player wasn't on this franchise's
            # roster at year-end of some intermediate year), the prior
            # cycle expired naturally between the two acquisitions.
            previous = open_cycles[key]
            prev_acq_dt = parse_ts(previous.get("acquisition_date"))
            new_acq_dt = parse_ts(ev["timestamp"])
            inferred = False

            if prev_acq_dt and new_acq_dt:
                prev_year = prev_acq_dt.year
                new_year = new_acq_dt.year
                if new_year > prev_year:
                    # Look for a year between prev_year and new_year where the
                    # player was NOT on this franchise's roster at year-end.
                    pid = ev["player_id"]
                    fid = ev["franchise_id"]
                    last_on_year = prev_year
                    # Walk forward from prev_year until we find a year where
                    # the player is NOT on this franchise's roster — that
                    # year-1 is the last year on roster.
                    for y in range(prev_year, new_year + 1):
                        if (y, pid) in by_year_franchise_global and by_year_franchise_global[(y, pid)] == fid:
                            last_on_year = y
                        else:
                            break
                    # If last_on_year < new_year, the cycle expired between.
                    if last_on_year < new_year:
                        previous["status"] = "closed"
                        previous["drop_date"] = f"{last_on_year + 1}-03-01 00:00:00"
                        previous["drop_reason"] = "expired"
                        previous["drop_transaction_type"] = "INFERRED_EXPIRATION_FROM_OVERLAP"
                        previous["_inferred"] = True
                        closed_cycles.append(previous)
                        stats["inferred_overlap_expirations"] += 1
                        inferred = True

            if not inferred:
                previous["status"] = "closed"
                previous["drop_reason"] = "data_gap_overlapping_open"
                previous["drop_date"] = ev["timestamp"]
                previous["_data_gap"] = True
                closed_cycles.append(previous)
                overlapping_warnings.append({
                    "player_id": ev["player_id"],
                    "franchise_id": ev["franchise_id"],
                    "year": ev["year"],
                    "previous_acq": previous.get("acquisition_date"),
                    "new_acq": ev["timestamp"],
                })
                stats["overlapping_open_warnings"] += 1
        open_cycles[key] = {
            "player_id": ev["player_id"],
            "franchise_id": ev["franchise_id"],
            "season": ev["year"],
            "acquisition_path": path,
            "acquisition_date": ev["timestamp"],
            "salary_at_acquisition_usd": ev.get("salary") or None,
            "transaction_type_at_acq": ev["transaction_type"],
            "status": "open",
        }
        stats[f"open_{path}"] += 1

    def close_cycle(ev: dict, reason: str, role: str | None = None):
        key = (ev["player_id"], ev["franchise_id"])
        if key not in open_cycles:
            unmatched_drops.append({**ev, "_reason": "no_prior_add"})
            stats["unmatched_drops"] += 1
            return
        cy = open_cycles.pop(key)
        cy["drop_date"] = ev["timestamp"]
        cy["drop_reason"] = reason
        cy["drop_transaction_type"] = ev["transaction_type"]
        cy["status"] = "closed"
        if role:
            cy["_trade_role"] = role
        closed_cycles.append(cy)
        stats[f"closed_{reason}"] += 1

    for ev in events:
        if not ev.get("player_id"):
            stats["skipped_null_player"] += 1
            continue
        action = (ev.get("action") or "").lower()
        ttype = ev.get("transaction_type") or ""
        role = ev.get("_trade_role")

        if action == "add":
            path = TXTYPE_TO_PATH.get(ttype, "unknown")
            if path == "unknown":
                stats[f"unknown_add_type_{ttype}"] += 1
            open_cycle(ev, path)
        elif action == "draft":
            open_cycle(ev, "rookie_draft")
        elif action == "drop":
            close_cycle(ev, "cut")
        elif action == "trade":
            if role == "giving":
                close_cycle(ev, "trade", role="giving")
            elif role == "receiving":
                open_cycle(ev, "trade")
            # if no role tag (shouldn't happen post-expansion), skip
        else:
            stats[f"unknown_action_{action}"] += 1

    return {
        "closed_cycles": closed_cycles,
        "still_open": list(open_cycles.values()),
        "unmatched_drops": unmatched_drops,
        "overlapping_warnings": overlapping_warnings,
        "stats": dict(stats),
    }


# ---------------------------------------------------------------------------
# Year-boundary expiration derivation (the only allowed inference)
# ---------------------------------------------------------------------------

def derive_expirations(still_open: list[dict],
                       by_year_franchise: dict,
                       on_roster: dict) -> tuple[list[dict], list[dict]]:
    """
    For each cycle still open at the end of all events:
      - If player is on the SAME franchise's roster at the end of the most
        recent season → cycle stays open (player currently rostered).
      - If player is on a DIFFERENT franchise's roster in some later year
        with NO explicit transition event captured → flag as data_gap.
        DO NOT infer.
      - If player is on NO roster in some later year (and wasn't on this
        franchise's roster either) → close cycle as 'expired' at March 1
        of the first year after the last appearance on THIS franchise.
    """
    inferred_closes: list[dict] = []
    data_gaps: list[dict] = []

    most_recent_year = max(INCLUDED_SEASONS)

    for cy in list(still_open):
        pid = cy["player_id"]
        fid = cy["franchise_id"]
        # Filter rosters to years AT OR AFTER this cycle's acquisition year.
        # Without this, an old cycle that expired years ago could be
        # mis-attributed to a new cycle for the same (player, franchise).
        acq_dt = parse_ts(cy.get("acquisition_date"))
        cycle_start_year = acq_dt.year if acq_dt else cy.get("season", 0)

        # Find the latest year the player was on THIS franchise per rosters.
        years_on_this_franchise = [
            y for y in INCLUDED_SEASONS
            if y >= cycle_start_year and by_year_franchise.get((y, pid)) == fid
        ]
        if not years_on_this_franchise:
            # Player never appears on this franchise's roster snapshot.
            # Could be a transient pickup-and-drop within a season that
            # didn't survive to year-end. With no end-of-year anchor and
            # no explicit drop, can't safely infer; flag.
            cy["status"] = "open"
            cy["_data_gap"] = True
            cy["_gap_reason"] = "no_roster_snapshot_appearance"
            data_gaps.append(cy)
            continue

        last_year_on = max(years_on_this_franchise)

        if last_year_on == most_recent_year:
            # Currently still on this franchise's roster → cycle genuinely open.
            cy["status"] = "open"
            continue

        # Player was on this franchise at end of last_year_on but not in
        # subsequent year. Two cases for year+1:
        next_year = last_year_on + 1
        next_year_franchise = by_year_franchise.get((next_year, pid))

        if next_year_franchise is None:
            # Not on any roster in next_year → infer expiration at March 1.
            cy["status"] = "closed"
            cy["drop_date"] = f"{next_year}-03-01 00:00:00"
            cy["drop_reason"] = "expired"
            cy["drop_transaction_type"] = "INFERRED_EXPIRATION"
            cy["_inferred"] = True
            inferred_closes.append(cy)
        elif next_year_franchise == fid:
            # Same franchise next year — cycle continues. (Shouldn't happen
            # since last_year_on was the MAX; defensive.)
            cy["status"] = "open"
        else:
            # Different franchise next year, no explicit trade/drop in our
            # event stream linking the two. FLAG — don't infer.
            cy["status"] = "open"
            cy["_data_gap"] = True
            cy["_gap_reason"] = (
                f"on franchise {fid} at end of {last_year_on}, "
                f"on franchise {next_year_franchise} at end of {next_year}, "
                f"no explicit trade/drop event in our data"
            )
            data_gaps.append(cy)

    return inferred_closes, data_gaps


# ---------------------------------------------------------------------------
# Calculator hookup (best-effort given Pass-1 data)
# ---------------------------------------------------------------------------

def build_cycle_inputs_for_calc(cy: dict) -> cp.CycleInputs | None:
    if cy["status"] != "closed":
        return None
    drop_dt = parse_ts(cy.get("drop_date"))
    acq_dt = parse_ts(cy.get("acquisition_date"))
    if not drop_dt or not acq_dt:
        return None

    salary = cy.get("salary_at_acquisition_usd")
    if salary is None:
        return None  # Pass 2 enrichment

    season = cy["season"]
    drop_week = cp.derive_nfl_week(
        drop_dt.date(),
        WEEK1_FIRST_GAME.get(season, date(season, 9, 1)),
        UPS_REG_SEASON_WEEKS.get(season, 17),
    )

    return cp.CycleInputs(
        player_id=cy["player_id"], franchise_id=cy["franchise_id"], season=season,
        acquisition_path=cy["acquisition_path"],
        acquisition_week=derive_acquisition_week(acq_dt, season),
        contract_type=cy["acquisition_path"],
        drop_date=drop_dt.date(), drop_week=drop_week,
        drop_reason=cy.get("drop_reason", "cut"),
        salary_at_drop_usd=salary, tcv_at_drop_usd=salary,
        contract_years_remaining=1, original_tcv_usd=salary,
        actual_paid_total_usd=0, weeks_active=0,
        total_eligible_weeks=cp.total_eligible_weeks(
            UPS_REG_SEASON_WEEKS.get(season, 17),
            derive_acquisition_week(acq_dt, season),
        ),
        contract_was_grandfathered=False,
        contract_original_length_years=1,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, help="Limit to one season for inspection")
    ap.add_argument("--apply", action="store_true", help="Write to D1 (default: dry-run)")
    ap.add_argument("--db", default=LOCAL_DB)
    ap.add_argument("--player", help="Inspect a specific player_id (debugging)")
    args = ap.parse_args()

    if not Path(args.db).exists():
        print(f"ERROR: local DB not found at {args.db}", file=sys.stderr)
        sys.exit(1)

    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row

    print(f"Loading transformed_transactions from {args.db}")
    print(f"  scope: seasons {INCLUDED_SEASONS[0]}-{INCLUDED_SEASONS[-1]} (2010 excluded)")
    events = load_transactions(con)
    print(f"  loaded {len(events)} events")

    trades_by_txn = load_trades_lookup(con)
    print(f"  loaded trades lookup: {len(trades_by_txn)} transaction_ids with player_id resolutions")

    by_year_franchise, on_roster = load_rosters_by_year(con)
    print(f"  loaded rosters: {sum(len(s) for s in on_roster.values())} (year, player) pairs across {len(on_roster)} years")

    events = expand_trade_events(events, trades_by_txn)
    print(f"  after trade expansion: {len(events)} events")

    if args.season:
        events = [e for e in events if e["year"] == args.season]
        print(f"  filtered to season {args.season}: {len(events)} events")

    pairing = pair_cycles(events, by_year_franchise=by_year_franchise)
    inferred_closes, data_gaps = derive_expirations(
        pairing["still_open"], by_year_franchise, on_roster,
    )
    pairing["closed_cycles"].extend(inferred_closes)
    pairing["still_open"] = [c for c in pairing["still_open"]
                              if c.get("status") != "closed"]

    closed = pairing["closed_cycles"]
    open_now = pairing["still_open"]
    unmatched = pairing["unmatched_drops"]
    overlap = pairing["overlapping_warnings"]

    print(f"\nCycle results:")
    print(f"  closed:         {len(closed)}")
    print(f"  still open:     {len(open_now)}")
    print(f"  unmatched drops: {len(unmatched)}")
    print(f"  data_gap flagged: {len(data_gaps)}")
    print(f"  overlapping-open warnings: {len(overlap)}")
    print(f"  inferred expirations: {len(inferred_closes)}")

    # Per-cycle compute
    pass1_complete = pass1_needs_enrichment = 0
    for cy in closed:
        ci = build_cycle_inputs_for_calc(cy)
        if ci is None:
            cy["pass"] = "needs_enrichment"
            pass1_needs_enrichment += 1
        else:
            out = cp.compute_cycle(ci)
            cy["pass"] = "complete"
            cy["computed"] = {
                "rule_era_at_drop": out.rule_era_at_drop,
                "earned_legacy_usd": out.earned_legacy_usd,
                "penalty_legacy_usd": out.penalty_legacy_usd,
                "cap_free": out.cap_free,
                "cap_free_reason": out.cap_free_reason,
            }
            pass1_complete += 1

    by_season = defaultdict(lambda: {"closed": 0, "open": 0, "complete": 0, "enrichment": 0,
                                       "expired": 0, "cut": 0, "trade": 0, "data_gap": 0})
    for cy in closed:
        bs = by_season[cy["season"]]
        bs["closed"] += 1
        bs[cy.get("drop_reason", "cut")] = bs.get(cy.get("drop_reason", "cut"), 0) + 1
        if cy.get("pass") == "complete": bs["complete"] += 1
        else: bs["enrichment"] += 1
        if cy.get("_data_gap"): bs["data_gap"] += 1
    for cy in open_now:
        by_season[cy["season"]]["open"] += 1

    print(f"\n{'Season':<8}{'Closed':<8}{'Open':<6}{'Cut':<6}{'Trade':<7}{'Expired':<9}{'DataGap':<9}{'Compl':<7}{'Enrich':<7}")
    print("-" * 70)
    for season in sorted(by_season.keys()):
        bs = by_season[season]
        print(f"{season:<8}{bs['closed']:<8}{bs['open']:<6}{bs.get('cut',0):<6}{bs.get('trade',0):<7}{bs.get('expired',0):<9}{bs['data_gap']:<9}{bs['complete']:<7}{bs['enrichment']:<7}")

    # Optional: per-player debug
    if args.player:
        print(f"\n=== Cycles for player_id={args.player} ===")
        for cy in closed + open_now:
            if cy["player_id"] == args.player:
                print(json.dumps({k: v for k, v in cy.items() if not k.startswith("_") or k == "_inferred"}, default=str, indent=2))

    out_dir = Path("/tmp")
    summary = {
        "scope_seasons": [INCLUDED_SEASONS[0], INCLUDED_SEASONS[-1]],
        "filtered_season": args.season,
        "totals": {
            "events_loaded": len(events),
            "closed": len(closed),
            "still_open": len(open_now),
            "inferred_expirations": len(inferred_closes),
            "unmatched_drops": len(unmatched),
            "data_gaps": len(data_gaps),
            "overlapping_warnings": len(overlap),
            "pass1_complete": pass1_complete,
            "pass1_needs_enrichment": pass1_needs_enrichment,
        },
        "stats": pairing["stats"],
        "by_season": dict(by_season),
    }
    (out_dir / "cycle_backfill_v2_report.json").write_text(json.dumps(summary, indent=2, default=str))
    print(f"\nWrote /tmp/cycle_backfill_v2_report.json")

    # Cycles dump (for review)
    cycles_path = out_dir / f"cycle_backfill_v2_cycles_{args.season or 'all'}.json"
    cycles_path.write_text(json.dumps(closed + open_now, indent=2, default=str))
    print(f"Wrote {cycles_path} ({len(closed) + len(open_now)} cycles)")

    if data_gaps:
        (out_dir / "cycle_backfill_v2_data_gaps.json").write_text(json.dumps(data_gaps, indent=2, default=str))
        print(f"Wrote /tmp/cycle_backfill_v2_data_gaps.json ({len(data_gaps)} flagged)")

    if not args.apply:
        print("\n[DRY-RUN] No D1 writes. Pass --apply to persist cycles.")


if __name__ == "__main__":
    main()
