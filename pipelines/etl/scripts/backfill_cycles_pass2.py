#!/usr/bin/env python3
"""
Pass 2 cycle backfill — uses MFL TYPE=transactions API as canonical source.

Pass 1 (backfill_cap_penalty_cycles.py) used local DB transformed_transactions
which had ingestion gaps (notably 2012 Daniels trades missing entirely).
Pass 2 pulls directly from MFL — the canonical source.

Modes:
  --pull          Fetch all seasons 2011-2024 from MFL, stage canonical
                  events to /tmp/mfl_canonical_events_<year>.json. Idempotent;
                  re-running just refreshes the staged files.
  --pair          Read staged events, run cycle pairing, output cycles to
                  /tmp/cycle_backfill_pass2_cycles_<scope>.json.
  --compare       Read local-DB cycles (Pass 1 output) and canonical cycles
                  (Pass 2 output); surface discrepancies.
  --player <id>   Restrict --pair output to a specific player (debugging).
  --season <yr>   Restrict to a single season.
  --apply         Write cycles to D1 (only valid with --pair). Default: dry-run.
  --fcfs-acquisition-fields
                  SCOPED regeneration (2026-09-26): set salary_at_acquisition_usd = 1000 and contract_years_at_acquisition = 1 on the FCFS cycles
                  that a FREE_AGENT transaction proves (canon §A5). UPDATEs two columns on existing rows — never a DELETE/INSERT, never a cycle
                  created, never a non-FCFS row or a drop-time column. Dry-run by default (before/after export + updates.sql); `--apply --yes` writes.
                  `--simulate` applies the plan to the exported cycles LOCALLY and re-plans (the second-run-is-identical proof).
                  Why not `--pair --apply`? That DELETEs `backfill_pass2%` rows and re-INSERTs every cycle — but passes 3/4 have since enriched the table in
                  place, so a full re-run would duplicate cycles next to the enriched rows. See pipelines/etl/lib/fcfs_cycles.py.

  --fcfs-create-missing
                  INSERT-ONLY creation (2026-09-26) of the FCFS cycles a transaction PROVES and no cycle carries (seasons 2011-2025; 2026 is the live tool's). Built through
                  `cycle_to_row`; each INSERT is one row, guarded by NOT EXISTS on the natural key; the end of a period is set only from a later same-season DROP of the
                  same player by the same franchise; nothing is ever deleted, updated or re-inserted. Dry-run by default (before/after export, inserts.sql, rollback.sql,
                  second-run proof); `--apply --yes --reviewed-inserts <inserts.sql>` writes exactly what was reviewed.
  Both FCFS commands also write the KEY-LEVEL RECONCILIATION (reconciliation.json/.md/.csv): every period and every cycle in exactly one bucket, with the identities
  periods = matched + without_cycle and cycles = matched + orphans. The UPDATE plan is only approvable when they balance.

Default: --pull then --pair, no --apply (full dry-run pipeline).
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import time
from collections import defaultdict
from datetime import datetime, date, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "pipelines" / "etl" / "lib"))

import cap_penalty as cp                                        # noqa: E402
import fcfs_cycles                                              # noqa: E402
from mfl_transactions import (                                  # noqa: E402
    load_seasons, fetch_year_transactions, parse_year,
)

LOCAL_DB = "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Desktop/MFL- BOT/mfl_database.db"
SEASONS_CSV = REPO_ROOT / "services" / "rulebook" / "sources" / "rules" / "mfl_message_boards" / "seasons.csv"
STAGE_DIR = Path("/tmp")

# Seasons to backfill. 2010 is excluded per league_context_v1.md (pre-dynasty era).
INCLUDED_SEASONS = list(range(2011, 2025))

UPS_REG_SEASON_WEEKS = {y: 16 for y in range(2010, 2025)}
UPS_REG_SEASON_WEEKS.update({2025: 17, 2026: 17, 2027: 17})

WEEK1_FIRST_GAME = {
    2010: date(2010, 9, 9),  2011: date(2011, 9, 8),  2012: date(2012, 9, 5),
    2013: date(2013, 9, 5),  2014: date(2014, 9, 4),  2015: date(2015, 9, 10),
    2016: date(2016, 9, 8),  2017: date(2017, 9, 7),  2018: date(2018, 9, 6),
    2019: date(2019, 9, 5),  2020: date(2020, 9, 10), 2021: date(2021, 9, 9),
    2022: date(2022, 9, 8),  2023: date(2023, 9, 7),  2024: date(2024, 9, 5),
    2025: date(2025, 9, 4),
}


# ---------------------------------------------------------------------------
# --pull
# ---------------------------------------------------------------------------

def cmd_pull(api_key: str | None) -> None:
    seasons = load_seasons(SEASONS_CSV)
    seasons = [s for s in seasons if s.year in INCLUDED_SEASONS]
    print(f"Pulling MFL TYPE=transactions for {len(seasons)} seasons:")
    for s in seasons:
        try:
            raw = fetch_year_transactions(s, api_key=api_key)
            events = list(parse_year(s.year, raw))
            stage_path = STAGE_DIR / f"mfl_canonical_events_{s.year}.json"
            stage_path.write_text(json.dumps({
                "season": s.year, "league_id": s.league_id,
                "raw_count": len(raw), "event_count": len(events),
                "events": events,
            }, indent=2, default=str))
            print(f"  {s.year}: {len(raw):>4} raw → {len(events):>4} events  → {stage_path.name}")
            time.sleep(0.5)  # polite throttle
        except Exception as e:
            print(f"  {s.year}: ERROR — {e}")


# ---------------------------------------------------------------------------
# --pair
# ---------------------------------------------------------------------------

def load_staged_events(season_filter: int | None) -> list[dict]:
    """Load staged canonical events from JSON files (sorted globally by timestamp)."""
    events = []
    for s in INCLUDED_SEASONS:
        if season_filter and s != season_filter:
            continue
        p = STAGE_DIR / f"mfl_canonical_events_{s}.json"
        if not p.exists():
            print(f"  WARNING: staged file missing for {s} — run --pull first", file=sys.stderr)
            continue
        d = json.loads(p.read_text())
        events.extend(d["events"])
    events.sort(key=lambda e: (e.get("year") or 0, e.get("timestamp") or 0))
    return events


def load_rosters_by_year() -> dict:
    """{ (year, player_id): franchise_id } from local rosters table.
    Used ONLY for natural-expiration inference (the one allowed inference)."""
    con = sqlite3.connect(LOCAL_DB)
    by_year_franchise = {}
    placeholders = ",".join("?" * len(INCLUDED_SEASONS))
    sql = f"SELECT year, franchise_id, player_id FROM rosters WHERE year IN ({placeholders})"
    for year, fid, pid in con.execute(sql, INCLUDED_SEASONS):
        by_year_franchise[(year, pid)] = fid
    con.close()
    return by_year_franchise


def parse_event_dt(e: dict) -> datetime | None:
    iso = e.get("ts_iso") or ""
    if not iso:
        return None
    try:
        return datetime.strptime(iso, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def derive_acquisition_week(acq_dt: datetime, season: int) -> int:
    if not acq_dt:
        return 0
    week1 = WEEK1_FIRST_GAME.get(season)
    if not week1:
        return 0
    if acq_dt.date() < week1:
        return 0
    days = (acq_dt.date() - week1).days
    week = (days // 7) + 1
    total = UPS_REG_SEASON_WEEKS.get(season, 17)
    return min(week, total)


# Map MFL transaction_type → calculator's acquisition_path.
ACQUISITION_PATH_BY_TYPE = {
    "AUCTION_WON":   "auction",
    "BBID_WAIVER":   "ww",
    "WAIVER":        "ww",
    "FREE_AGENT":    "fcfs",
    "TRADE":         "trade",
    "DRAFT_PICK":    "rookie_draft",
}


def pair_cycles(events: list[dict], by_year_franchise: dict) -> dict:
    """Walk canonical events chronologically per (player_id, franchise_id).
    Cycle-relevant actions: add, drop, trade_in, trade_out, draft_pick.
    State actions (ir_*, taxi_*) don't change cycle state — they update
    weekly status (handled separately later).
    """
    open_cycles: dict[tuple, dict] = {}
    closed_cycles: list[dict] = []
    unmatched_drops: list[dict] = []
    overlapping_warnings: list[dict] = []
    stats = defaultdict(int)

    def open_cycle(ev: dict):
        key = (ev["player_id"], ev["franchise_id"])
        path = ACQUISITION_PATH_BY_TYPE.get(ev["transaction_type"], "unknown")
        if key in open_cycles:
            # Try to infer expiration close on prior cycle before flagging gap.
            previous = open_cycles[key]
            prev_acq_dt = parse_event_dt(previous)
            new_acq_dt = parse_event_dt(ev)
            inferred = False
            if prev_acq_dt and new_acq_dt:
                pid, fid = ev["player_id"], ev["franchise_id"]
                last_on_year = prev_acq_dt.year
                for y in range(prev_acq_dt.year, new_acq_dt.year + 1):
                    if by_year_franchise.get((y, pid)) == fid:
                        last_on_year = y
                    else:
                        break
                if last_on_year < new_acq_dt.year:
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
                previous["drop_date"] = ev["ts_iso"]
                previous["drop_reason"] = "data_gap_overlapping_open"
                previous["_data_gap"] = True
                closed_cycles.append(previous)
                overlapping_warnings.append({
                    "player_id": ev["player_id"], "franchise_id": ev["franchise_id"],
                    "previous_acq": previous.get("ts_iso"),
                    "new_acq": ev["ts_iso"],
                })
                stats["overlapping_open_warnings"] += 1

        open_cycles[key] = {
            "player_id": ev["player_id"],
            "franchise_id": ev["franchise_id"],
            "season": ev["year"],
            "acquisition_path": path,
            "ts_iso": ev["ts_iso"],            # acquisition timestamp
            "acquisition_date": ev["ts_iso"],
            "transaction_type_at_acq": ev["transaction_type"],
            "salary_at_acquisition_usd": ev.get("salary"),
            "status": "open",
            "_open_event": ev,
        }
        stats[f"open_{path}"] += 1

    def close_cycle(ev: dict, reason: str):
        key = (ev["player_id"], ev["franchise_id"])
        if key not in open_cycles:
            unmatched_drops.append({**ev, "_reason": "no_prior_add"})
            stats["unmatched_drops"] += 1
            return
        cy = open_cycles.pop(key)
        cy["drop_date"] = ev["ts_iso"]
        cy["drop_reason"] = reason
        cy["drop_transaction_type"] = ev["transaction_type"]
        cy["status"] = "closed"
        closed_cycles.append(cy)
        stats[f"closed_{reason}"] += 1

    for ev in events:
        if not ev.get("player_id"):
            stats["skipped_empty_player"] += 1
            continue
        action = ev.get("action")
        if action in ("add", "draft_pick"):
            open_cycle(ev)
        elif action == "trade_in":
            open_cycle(ev)
        elif action == "trade_out":
            close_cycle(ev, "trade")
        elif action == "drop":
            close_cycle(ev, "cut")
        # ir_*, taxi_*, _unknown — no cycle effect

    return {
        "closed_cycles": closed_cycles,
        "still_open": list(open_cycles.values()),
        "unmatched_drops": unmatched_drops,
        "overlapping_warnings": overlapping_warnings,
        "stats": dict(stats),
    }


def derive_expirations(still_open: list[dict], by_year_franchise: dict) -> tuple[list[dict], list[dict]]:
    """Same logic as Pass 1 v2's derive_expirations — natural-expiration inference."""
    inferred_closes: list[dict] = []
    data_gaps: list[dict] = []
    most_recent_year = max(INCLUDED_SEASONS)

    for cy in list(still_open):
        pid = cy["player_id"]
        fid = cy["franchise_id"]
        acq_dt = parse_event_dt(cy)
        cycle_start_year = acq_dt.year if acq_dt else cy.get("season", 0)

        years_on_this_franchise = [
            y for y in INCLUDED_SEASONS
            if y >= cycle_start_year and by_year_franchise.get((y, pid)) == fid
        ]
        if not years_on_this_franchise:
            cy["status"] = "open"
            cy["_data_gap"] = True
            cy["_gap_reason"] = "no_roster_snapshot_appearance_after_cycle_start"
            data_gaps.append(cy)
            continue

        last_year_on = max(years_on_this_franchise)
        if last_year_on == most_recent_year:
            cy["status"] = "open"
            continue

        next_year = last_year_on + 1
        next_year_franchise = by_year_franchise.get((next_year, pid))
        if next_year_franchise is None:
            cy["status"] = "closed"
            cy["drop_date"] = f"{next_year}-03-01 00:00:00"
            cy["drop_reason"] = "expired"
            cy["drop_transaction_type"] = "INFERRED_EXPIRATION"
            cy["_inferred"] = True
            inferred_closes.append(cy)
        elif next_year_franchise == fid:
            cy["status"] = "open"
        else:
            cy["status"] = "open"
            cy["_data_gap"] = True
            cy["_gap_reason"] = (
                f"on franchise {fid} at end of {last_year_on}, "
                f"on franchise {next_year_franchise} at end of {next_year}, "
                f"no explicit trade/drop event between"
            )
            data_gaps.append(cy)

    return inferred_closes, data_gaps


def cmd_pair(season_filter: int | None, player_filter: str | None,
             apply_to_d1: bool) -> None:
    print("Loading staged canonical events...")
    events = load_staged_events(season_filter)
    print(f"  {len(events)} events loaded across {len(set(e['year'] for e in events))} seasons")

    print("Loading rosters from local DB (used only for expiration inference)...")
    by_year_franchise = load_rosters_by_year()
    print(f"  {len(by_year_franchise)} (year, player) pairs")

    print("Pairing cycles...")
    pairing = pair_cycles(events, by_year_franchise)
    inferred_closes, data_gaps = derive_expirations(pairing["still_open"], by_year_franchise)
    pairing["closed_cycles"].extend(inferred_closes)
    pairing["still_open"] = [c for c in pairing["still_open"] if c.get("status") != "closed"]

    closed = pairing["closed_cycles"]
    open_now = pairing["still_open"]

    print(f"\nResults:")
    print(f"  closed:                     {len(closed)}")
    print(f"  still open:                 {len(open_now)}")
    print(f"  unmatched drops:            {len(pairing['unmatched_drops'])}")
    print(f"  inferred expirations:       {len(inferred_closes)}")
    print(f"  inferred from overlap:      {pairing['stats'].get('inferred_overlap_expirations', 0)}")
    print(f"  data gaps flagged:          {len(data_gaps)}")
    print(f"  overlapping-open warnings:  {len(pairing['overlapping_warnings'])}")

    by_season = defaultdict(lambda: {"closed": 0, "open": 0,
                                       "cut": 0, "trade": 0, "expired": 0, "data_gap": 0})
    for cy in closed:
        bs = by_season[cy["season"]]
        bs["closed"] += 1
        bs[cy.get("drop_reason", "cut")] = bs.get(cy.get("drop_reason", "cut"), 0) + 1
        if cy.get("_data_gap"): bs["data_gap"] += 1
    for cy in open_now:
        by_season[cy["season"]]["open"] += 1

    print(f"\n{'Season':<8}{'Closed':<8}{'Open':<6}{'Cut':<6}{'Trade':<7}{'Expired':<9}{'DataGap':<9}")
    print("-" * 60)
    for season in sorted(by_season.keys()):
        bs = by_season[season]
        print(f"{season:<8}{bs['closed']:<8}{bs['open']:<6}{bs.get('cut',0):<6}{bs.get('trade',0):<7}{bs.get('expired',0):<9}{bs['data_gap']:<9}")

    out_cycles = closed + open_now
    if player_filter:
        out_cycles = [c for c in out_cycles if c["player_id"] == player_filter]
        print(f"\n=== Filtered cycles for player_id={player_filter} ===")
        for c in sorted(out_cycles, key=lambda x: x.get("acquisition_date", "")):
            fid = c["franchise_id"]
            acq = (c.get("acquisition_date") or "")[:10]
            drop = (c.get("drop_date") or "OPEN")[:10]
            reason = c.get("drop_reason", "-")
            inferred = " [INFERRED]" if c.get("_inferred") else ""
            gap = " [DATA_GAP]" if c.get("_data_gap") else ""
            sal = f" sal=${c.get('salary_at_acquisition_usd','?')}" if c.get('salary_at_acquisition_usd') else ""
            print(f"  fr {fid}  {acq} → {drop}  {c['acquisition_path']}{sal}  reason={reason}{inferred}{gap}")

    scope = season_filter or "all"
    out_path = STAGE_DIR / f"cycle_backfill_pass2_cycles_{scope}.json"
    out_path.write_text(json.dumps(out_cycles, indent=2, default=str))
    print(f"\nWrote {out_path} ({len(out_cycles)} cycles)")

    summary = {
        "totals": {
            "closed": len(closed), "open": len(open_now),
            "inferred_expirations": len(inferred_closes),
            "inferred_from_overlap": pairing["stats"].get("inferred_overlap_expirations", 0),
            "data_gaps": len(data_gaps),
            "unmatched_drops": len(pairing["unmatched_drops"]),
            "overlapping_warnings": len(pairing["overlapping_warnings"]),
        },
        "stats": pairing["stats"],
        "by_season": dict(by_season),
    }
    (STAGE_DIR / f"cycle_backfill_pass2_summary_{scope}.json").write_text(
        json.dumps(summary, indent=2, default=str))

    if data_gaps:
        (STAGE_DIR / f"cycle_backfill_pass2_data_gaps_{scope}.json").write_text(
            json.dumps(data_gaps, indent=2, default=str))

    if not apply_to_d1:
        print("\n[DRY-RUN] No D1 writes. Use --apply once spot-checks pass.")
    else:
        write_cycles_to_d1(out_cycles)


# ---------------------------------------------------------------------------
# D1 write
# ---------------------------------------------------------------------------

D1_BATCH_SIZE = 500   # cycles per SQL file. Each row is ~600B → ~300KB per batch.

def _sql_lit(v) -> str:
    """Render a Python value as a SQL literal."""
    if v is None or v == "":
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def cycle_to_row(cy: dict, source: str = "backfill_pass2_2026_05_09", stamp: str | None = None) -> dict:
    """Map a Pass 2 cycle dict → player_acquisition_cycles row.
    Computes era + acquisition_week + total_eligible_weeks. Leaves financial
    columns NULL where data isn't available (Pass 3 fills these in)."""
    season = cy["season"]
    acq_dt = parse_event_dt(cy)
    acq_week = derive_acquisition_week(acq_dt, season) if acq_dt else 0
    total_weeks = cp.total_eligible_weeks(UPS_REG_SEASON_WEEKS.get(season, 17), acq_week)
    drop_date = cy.get("drop_date")
    drop_week = None
    rule_era = None
    legacy_was_cap_free = 0
    legacy_cap_free_reason = None

    if cy.get("status") == "closed" and drop_date:
        # parse drop_date (might be "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD" for inferred)
        try:
            drop_dt = datetime.strptime(drop_date[:19], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            try:
                drop_dt = datetime.strptime(drop_date[:10], "%Y-%m-%d")
            except ValueError:
                drop_dt = None
        if drop_dt:
            week1 = WEEK1_FIRST_GAME.get(drop_dt.year)
            if week1:
                drop_week = cp.derive_nfl_week(
                    drop_dt.date(), week1,
                    UPS_REG_SEASON_WEEKS.get(drop_dt.year, 17),
                )
            # Era determination based on drop_date (GF flag is False — Pass 3
            # will revise grandfathered cycles by re-running with GF=True).
            rule_era = cp.determine_rule_era(drop_dt.date(), was_grandfathered=False)
            # Cap-free determination using drop_reason.
            if cy.get("drop_reason") in ("trade", "expired"):
                legacy_was_cap_free = 1
                legacy_cap_free_reason = (
                    "trade_away_no_cap_consequence" if cy["drop_reason"] == "trade"
                    else "contract_expired_naturally"
                )

    # FCFS is a fixed $1,000 one-year contract (canon §A5): the generation rule carries it, so a FUTURE pair run never emits a NULL-salary FCFS cycle.
    acq_salary, acq_years, fcfs_salary_differs = fcfs_cycles.canonical_acquisition_fields(cy["acquisition_path"], cy.get("salary_at_acquisition_usd"))

    notes = []
    if cy.get("_inferred"):
        notes.append("inferred_close")
    if cy.get("_data_gap"):
        notes.append(f"data_gap: {cy.get('_gap_reason','overlap')}")
    if fcfs_salary_differs:
        notes.append("fcfs_salary_not_canonical")
    # an FCFS cycle now carries its acquisition salary, but every DROP-side financial column is still NULL — pass 3/4 enrichment is still owed
    if not acq_salary or cy["acquisition_path"] == "fcfs":
        notes.append("needs_pass3_enrichment")

    now_utc = stamp or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    return {
        "player_id": cy["player_id"],
        "franchise_id": cy["franchise_id"],
        "season": season,
        "acquisition_path": cy["acquisition_path"],
        "acquisition_date": cy.get("acquisition_date") or cy.get("ts_iso"),
        "acquisition_week": acq_week,
        "contract_type_at_acquisition": cy.get("acquisition_path"),
        "contract_was_grandfathered_at_acq": 0,
        "salary_at_acquisition_usd": acq_salary,
        "contract_years_at_acquisition": acq_years,
        "total_eligible_weeks": total_weeks,
        "weeks_active": 0,
        "drop_date": drop_date,
        "drop_week": drop_week,
        "drop_reason": cy.get("drop_reason"),
        "contract_was_grandfathered_at_drop": 0,
        "salary_at_drop_usd": None,
        "tcv_at_drop_usd": None,
        "rule_era_at_drop": rule_era,
        "earned_legacy_usd": None,
        "penalty_legacy_usd": None,
        "legacy_was_cap_free": legacy_was_cap_free,
        "legacy_cap_free_reason": legacy_cap_free_reason,
        "earned_pre2019_usd": None,
        "earned_calendar_monthly_usd": None,
        "earned_per_week_usd": None,
        "penalty_pre2019_usd": None,
        "penalty_calendar_monthly_usd": None,
        "penalty_per_week_usd": None,
        "status": cy.get("status", "open"),
        "created_at_utc": now_utc,
        "updated_at_utc": now_utc,
        "source": source,
        "notes": "; ".join(notes) if notes else None,
    }


COL_ORDER = [
    "player_id", "franchise_id", "season", "acquisition_path", "acquisition_date",
    "acquisition_week", "contract_type_at_acquisition",
    "contract_was_grandfathered_at_acq", "salary_at_acquisition_usd",
    "contract_years_at_acquisition", "total_eligible_weeks", "weeks_active",
    "drop_date", "drop_week", "drop_reason",
    "contract_was_grandfathered_at_drop", "salary_at_drop_usd", "tcv_at_drop_usd",
    "rule_era_at_drop", "earned_legacy_usd", "penalty_legacy_usd",
    "legacy_was_cap_free", "legacy_cap_free_reason",
    "earned_pre2019_usd", "earned_calendar_monthly_usd", "earned_per_week_usd",
    "penalty_pre2019_usd", "penalty_calendar_monthly_usd", "penalty_per_week_usd",
    "status", "created_at_utc", "updated_at_utc", "source", "notes",
]


def write_cycles_to_d1(cycles: list[dict]) -> None:
    import subprocess

    print(f"\nWriting {len(cycles)} cycles to D1 in batches of {D1_BATCH_SIZE}...")
    rows = [cycle_to_row(cy) for cy in cycles]
    cols_csv = ", ".join(COL_ORDER)

    # First, clear any prior backfill rows (idempotent re-runs).
    clear_path = STAGE_DIR / "cycle_d1_clear.sql"
    clear_path.write_text("DELETE FROM player_acquisition_cycles WHERE source LIKE 'backfill_pass2%';\n")
    print(f"  Clearing prior backfill rows...")
    _run_wrangler_sql(clear_path)

    total = len(rows)
    for i in range(0, total, D1_BATCH_SIZE):
        batch = rows[i:i + D1_BATCH_SIZE]
        sql_lines = []
        for row in batch:
            values = ", ".join(_sql_lit(row.get(c)) for c in COL_ORDER)
            sql_lines.append(f"INSERT INTO player_acquisition_cycles ({cols_csv}) VALUES ({values});")
        batch_path = STAGE_DIR / f"cycle_d1_batch_{i:06d}.sql"
        batch_path.write_text("\n".join(sql_lines) + "\n")
        print(f"  Batch {i:>5}-{min(i+D1_BATCH_SIZE, total):>5}: writing {batch_path.name}...")
        _run_wrangler_sql(batch_path)

    print(f"\n✓ Wrote {total} cycles to player_acquisition_cycles")


def _run_wrangler_sql(sql_path: Path) -> None:
    import subprocess
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote",
         f"--file={sql_path}"],
        cwd=str(REPO_ROOT / "worker"),
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"    ERROR: {result.stderr[:500]}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# --fcfs-acquisition-fields  (scoped, UPDATE-only regeneration of two columns on FCFS cycles)
# ---------------------------------------------------------------------------

FCFS_SQL = {
    "cycles": "SELECT cycle_id, player_id, franchise_id, season, acquisition_path, acquisition_date, salary_at_acquisition_usd, "
              "contract_years_at_acquisition, source, notes, status, drop_date, updated_at_utc FROM player_acquisition_cycles "
              "WHERE acquisition_path = 'fcfs' ORDER BY cycle_id",
    "adddrop": "SELECT season, player_id, franchise_id, move_type, method, salary, unix_timestamp FROM src_adddrop "
               "WHERE method = 'FREE_AGENT' AND move_type = 'ADD' AND season < 2026",
    "hist": "SELECT season, player_in_id, franchise_id, type, salary, ts_unix FROM mfl_historical_transactions "
            "WHERE type = 'FREE_AGENT' AND season < 2026",
}
# read-only extras: `moves` (every ADD / DROP of an FCFS player — the NEXT move by the franchise must be a DROP to end a period) and `tx2026` (the 2026 FCFS adds — REPORTED as out of scope, never counted or created)
FCFS_SQL_OPTIONAL = {
    "moves": "SELECT season, player_id, franchise_id, move_type, method, unix_timestamp FROM src_adddrop WHERE season BETWEEN 2011 AND 2025 "
             "AND (season, player_id) IN (SELECT season, player_id FROM src_adddrop WHERE method = 'FREE_AGENT' AND move_type = 'ADD' AND season < 2026)",
    "tx2026": "SELECT season, mfl_txn_id, unix_timestamp, franchise_id, added_players FROM ups_transactions WHERE season = '2026' AND type = 'FREE_AGENT' "
              "AND added_players IS NOT NULL AND added_players <> ''",
}


def _load_fcfs_inputs(out: Path, input_dir: str | None) -> dict:
    """The cycles / ledgers (required) and the optional moves / 2026 transactions — from a directory of JSON (offline / tests) or live read-only D1."""
    data: dict = {}
    if input_dir:
        src = Path(input_dir)
        for k in FCFS_SQL:
            data[k] = json.loads((src / f"{k}.json").read_text())
        for k in FCFS_SQL_OPTIONAL:
            p = src / f"{k}.json"
            data[k] = json.loads(p.read_text()) if p.exists() else []
    else:
        for k, q in {**FCFS_SQL, **FCFS_SQL_OPTIONAL}.items():
            data[k] = _d1_select(q)
            (out / f"source_{k}.json").write_text(json.dumps(data[k], indent=1, default=str))
    return data


def _out_of_scope_2026(tx_rows: list[dict]) -> list[dict]:
    """One report-only period per FCFS add in the 2026 transactions (never evidence for creation)."""
    out = []
    for r in tx_rows or []:
        for pid in str(r.get("added_players") or "").split(","):
            pid = "".join(ch for ch in pid if ch.isdigit())
            if pid:
                out.append({"season": int(r.get("season") or 2026), "pid": pid, "fid": fcfs_cycles._norm_fid(r.get("franchise_id")), "ts": int(r.get("unix_timestamp") or 0), "salary": None, "sources": ["ups_transactions"]})
    return out


def _write_reconciliation(out: Path, rec: dict) -> None:
    (out / "reconciliation.json").write_text(json.dumps(rec, indent=1, default=str))
    (out / "reconciliation.md").write_text(fcfs_cycles.reconciliation_markdown(rec))
    (out / "reconciliation.csv").write_text(fcfs_cycles.reconciliation_csv(rec))


def _d1_select(sql: str) -> list[dict]:
    """READ-ONLY D1 query through wrangler (refuses anything but a SELECT)."""
    import subprocess
    if not sql.lstrip().upper().startswith("SELECT"):
        raise ValueError("read-only helper: refusing a non-SELECT statement")
    r = subprocess.run(["npx", "--yes", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql],
                       cwd=str(REPO_ROOT / "worker"), capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"wrangler failed: {r.stderr[:300]}")
    return json.loads(r.stdout)[0].get("results", [])


def _refuse(msg: str) -> None:
    print(f"REFUSED: {msg}", file=sys.stderr)
    sys.exit(2)


def _preflight_apply(apply_to_d1: bool, confirmed: bool, input_dir: str | None, reviewed: str | None, out: Path, own_file: str, flag: str) -> str | None:
    """Every --apply refusal that needs no data — BEFORE any live read and BEFORE any output file is written — and the REVIEWED plan's text, read before this run writes anything: a reused
    --out can never overwrite the reviewed file with the fresh plan and then "match" it."""
    if not apply_to_d1:
        return None
    if not confirmed:
        _refuse("--apply needs --yes (write mode is never implicit).")
    if input_dir:
        _refuse("--apply reads the plan from LIVE D1 — it cannot be combined with --input-dir (an offline snapshot).")
    if not reviewed:
        _refuse(f"--apply needs {flag} <the {own_file} from the dry run you reviewed> (write mode only sends what was reviewed).")
    rp = Path(reviewed)
    if not rp.is_file():
        _refuse(f"the reviewed plan {reviewed} does not exist.")
    if rp.resolve() == (out / own_file).resolve():
        _refuse(f"the reviewed plan is this run's OWN output ({out / own_file}) — use a NEW --out (a reused directory would overwrite the reviewed plan with the fresh one).")
    return rp.read_text()


def cmd_fcfs_fields(out_dir: str | None, input_dir: str | None, simulate: bool, apply_to_d1: bool, confirmed: bool, stamp: str | None, reviewed_updates: str | None = None) -> dict:
    out = Path(out_dir) if out_dir else STAGE_DIR / "fcfs_cycle_fields"
    reviewed_text = _preflight_apply(apply_to_d1, confirmed, input_dir, reviewed_updates, out, "updates.sql", "--reviewed-updates")
    out.mkdir(parents=True, exist_ok=True)
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = _load_fcfs_inputs(out, input_dir)
    cycles, evidence = data["cycles"], fcfs_cycles.evidence_from_rows(data["adddrop"], data["hist"])
    plan = fcfs_cycles.plan_fcfs_cycle_updates(cycles, evidence, stamp)
    rec = fcfs_cycles.reconcile(cycles, evidence, out_of_scope=_out_of_scope_2026(data.get("tx2026")))
    _write_reconciliation(out, rec)
    (out / "cycles_before.json").write_text(json.dumps(cycles, indent=1, default=str))
    (out / "plan_rows.json").write_text(json.dumps(plan["rows"], indent=1, default=str))
    (out / "periods_without_cycle.json").write_text(json.dumps(plan["periods_without_cycle"], indent=1, default=str))
    (out / "updates.sql").write_text("\n".join(u["sql"] for u in plan["updates"]) + ("\n" if plan["updates"] else ""))
    (out / "rollback.sql").write_text(fcfs_cycles.rollback_sql(cycles, plan["updates"]))
    result = {"summary": plan["summary"], "updates": len(plan["updates"]),
              "reconciliation": {"balanced": rec["balanced"], "updates_approvable": rec["updates_approvable"], "unique_periods": rec["unique_periods"], "exactly_one_match": rec["exactly_one_match"],
                                 "periods_without_cycle": rec["periods_without_cycle"]["total"], "cycles": rec["cycles_total"], "orphan_cycles": rec["orphan_cycles"]["total"], "ambiguous": rec["ambiguous"]["total"],
                                 "identity": {k: v["holds"] for k, v in rec["identity"].items()}, "bridge_holds": rec["bridge"]["holds"]}}
    after = fcfs_cycles.apply_updates(cycles, plan["updates"], stamp)
    (out / "cycles_after.json").write_text(json.dumps(after, indent=1, default=str))
    if simulate:
        # the second run, on the state the first run would leave: must plan NOTHING and leave every row identical
        second = fcfs_cycles.plan_fcfs_cycle_updates(after, evidence, stamp)
        again = fcfs_cycles.apply_updates(after, second["updates"], stamp)
        result["second_run"] = {"updates": len(second["updates"]), "identical": again == after}
        (out / "second_run_summary.json").write_text(json.dumps(result["second_run"], indent=1))
    (out / "summary.json").write_text(json.dumps(result, indent=1, default=str))
    print(json.dumps(result, indent=1, default=str))
    if simulate and not (result["second_run"]["updates"] == 0 and result["second_run"]["identical"]):
        print("FAILED: the second run is not a no-op.", file=sys.stderr)
        sys.exit(1)
    if apply_to_d1:
        if not rec["updates_approvable"]:
            print(f"REFUSED: the cycle counts do not balance ({rec['not_approvable_reason']}) — the UPDATE plan is not approvable; see reconciliation.md.", file=sys.stderr)
            sys.exit(2)
        drift = fcfs_cycles.plan_drift(plan["updates"], reviewed_text)
        if not drift["ok"]:
            print(f"REFUSED: the plan changed since it was reviewed (+{drift['added']} / -{drift['removed']} statements) — re-run the dry run and review again.", file=sys.stderr)
            sys.exit(2)
        if not plan["updates"]:
            print("Nothing to apply (already canonical).")
            return result
        sql_path = out / "updates.sql"
        print(f"Applying {len(plan['updates'])} guarded UPDATEs to D1 …")
        _run_wrangler_sql(sql_path)
        print("✓ applied")
    else:
        print("[DRY-RUN] No D1 writes.")
    return result


def cmd_fcfs_create_missing(out_dir: str | None, input_dir: str | None, apply_to_d1: bool, confirmed: bool, stamp: str | None, reviewed_inserts: str | None = None) -> dict:
    """INSERT-ONLY creation of the missing FCFS cycles (see the module doc). Dry run by default."""
    out = Path(out_dir) if out_dir else STAGE_DIR / "fcfs_cycle_create"
    reviewed_text = _preflight_apply(apply_to_d1, confirmed, input_dir, reviewed_inserts, out, "inserts.sql", "--reviewed-inserts")
    out.mkdir(parents=True, exist_ok=True)
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    data = _load_fcfs_inputs(out, input_dir)
    cycles, evidence, moves = data["cycles"], fcfs_cycles.evidence_from_rows(data["adddrop"], data["hist"]), data.get("moves") or []
    oos = _out_of_scope_2026(data.get("tx2026"))
    plan = fcfs_cycles.plan_fcfs_cycle_inserts(cycles, evidence, moves, lambda cy: cycle_to_row(cy, source=fcfs_cycles.CREATE_SOURCE, stamp=stamp), COL_ORDER, stamp, out_of_scope=oos)
    _write_reconciliation(out, plan["reconciliation"])
    after = fcfs_cycles.apply_inserts(cycles, plan["inserts"])
    (out / "cycles_before.json").write_text(json.dumps(cycles, indent=1, default=str))
    (out / "cycles_after.json").write_text(json.dumps(after, indent=1, default=str))
    (out / "insert_rows.json").write_text(json.dumps(plan["rows"], indent=1, default=str))
    (out / "inserts.sql").write_text(fcfs_cycles.inserts_sql_text(plan["inserts"]))
    (out / "rollback.sql").write_text(fcfs_cycles.rollback_inserts_text(plan["inserts"]))
    # the second run, on the state the first run would leave: nothing to insert, nothing changes, and the existing rows are byte-identical to before
    second = fcfs_cycles.plan_fcfs_cycle_inserts(after, evidence, moves, lambda cy: cycle_to_row(cy, source=fcfs_cycles.CREATE_SOURCE, stamp=stamp), COL_ORDER, stamp, out_of_scope=oos)
    again = fcfs_cycles.apply_inserts(after, second["inserts"])
    untouched = all(after_row == dict(before_row) for before_row, after_row in zip(cycles, after[:len(cycles)]))
    result = {"summary": plan["summary"], "reconciliation_balanced": plan["reconciliation"]["balanced"], "existing_rows_untouched": untouched,
              "second_run": {"inserts": len(second["inserts"]), "identical": again == after, "periods_without_cycle_after": second["reconciliation"]["periods_without_cycle"]["total"]}}
    (out / "summary.json").write_text(json.dumps(result, indent=1, default=str))
    print(json.dumps(result, indent=1, default=str))
    if not (untouched and result["second_run"]["inserts"] == 0 and result["second_run"]["identical"]):
        print("FAILED: the plan touches an existing row, or the second run is not a no-op.", file=sys.stderr)
        sys.exit(1)
    if apply_to_d1:
        if not plan["summary"]["approvable"]:
            print(f"REFUSED: the creation plan is not approvable ({plan['summary']['not_approvable_reason']}) — see reconciliation.md.", file=sys.stderr)
            sys.exit(2)
        drift = fcfs_cycles.plan_inserts_drift(plan["inserts"], reviewed_text)
        if not drift["ok"]:
            print(f"REFUSED: the plan changed since it was reviewed (+{drift['added']} / -{drift['removed']} statements) — re-run the dry run and review again.", file=sys.stderr)
            sys.exit(2)
        if not plan["inserts"]:
            print("Nothing to insert (every proven period already has a cycle).")
            return result
        print(f"Applying {len(plan['inserts'])} guarded single-row INSERTs to D1 …")
        _run_wrangler_sql(out / "inserts.sql")
        print("✓ applied")
    else:
        print("[DRY-RUN] No D1 writes.")
    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pull", action="store_true", help="Fetch from MFL API")
    ap.add_argument("--pair", action="store_true", help="Run cycle pairing on staged events")
    ap.add_argument("--player", help="Restrict --pair output to one player")
    ap.add_argument("--season", type=int, help="Restrict to one season")
    ap.add_argument("--apply", action="store_true", help="Write to D1 (only with --pair)")
    ap.add_argument("--api-key", help="MFL APIKEY (defaults to env MFL_APIKEY)")
    ap.add_argument("--fcfs-acquisition-fields", action="store_true", help="Scoped FCFS regeneration (see module doc)")
    ap.add_argument("--out", help="output directory for --fcfs-acquisition-fields")
    ap.add_argument("--input-dir", help="read cycles/adddrop/hist JSON from a directory instead of D1 (offline / tests)")
    ap.add_argument("--simulate", action="store_true", help="also prove the second run plans nothing")
    ap.add_argument("--yes", action="store_true", help="confirm --apply")
    ap.add_argument("--stamp", help="updated_at_utc value (fixed in tests)")
    ap.add_argument("--reviewed-updates", help="the updates.sql of the reviewed dry run — --apply refuses unless the fresh plan is identical")
    ap.add_argument("--fcfs-create-missing", action="store_true", help="INSERT-only creation of the FCFS cycles a transaction proves and no cycle carries (see the module doc)")
    ap.add_argument("--reviewed-inserts", help="the inserts.sql of the reviewed dry run — --apply refuses unless the fresh plan is identical")
    ap.add_argument("--full-pair-delete-and-reinsert", action="store_true", help="REQUIRED for `--pair --apply`: that path DELETEs every backfill_pass2%% cycle and re-INSERTs it — never use it on the enriched table")
    args = ap.parse_args()

    scoped = args.fcfs_acquisition_fields or args.fcfs_create_missing
    if args.fcfs_acquisition_fields and args.fcfs_create_missing:
        ap.error("choose ONE of --fcfs-acquisition-fields / --fcfs-create-missing")
    if not scoped and (args.yes or args.reviewed_updates or args.reviewed_inserts or args.input_dir or args.simulate or args.stamp or args.out):
        ap.error("--yes / --reviewed-updates / --reviewed-inserts / --input-dir / --simulate / --stamp / --out only apply to --fcfs-acquisition-fields or --fcfs-create-missing (they would be silently ignored here)")
    if args.apply and not scoped and not args.full_pair_delete_and_reinsert:
        print("REFUSED: `--apply` without --fcfs-acquisition-fields / --fcfs-create-missing is the FULL pair path: it DELETEs every backfill_pass2% cycle and re-INSERTs them all, "
              "duplicating the cycles passes 3 / 4 enriched in place. If you really mean it, pass --full-pair-delete-and-reinsert.", file=sys.stderr)
        sys.exit(2)

    if args.fcfs_create_missing:
        cmd_fcfs_create_missing(args.out, args.input_dir, args.apply, args.yes, args.stamp, args.reviewed_inserts)
        return

    if args.fcfs_acquisition_fields:
        cmd_fcfs_fields(args.out, args.input_dir, args.simulate, args.apply, args.yes, args.stamp, args.reviewed_updates)
        return

    api_key = args.api_key
    if not api_key:
        import os
        api_key = os.environ.get("MFL_APIKEY")

    if not args.pull and not args.pair:
        # Default: do both
        args.pull = True
        args.pair = True

    if args.pull:
        cmd_pull(api_key)
        print()

    if args.pair:
        cmd_pair(args.season, args.player, args.apply)


if __name__ == "__main__":
    main()
