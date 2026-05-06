"""
rookie_pick_value_realization.py — Empirical rookie-pick → market-value conversion.

For each rookie pick in site/acquisition/rookie_draft_history.json (2015-2025), walk
the player's per-season timeline in pipelines/reports/contract_history_<pos>.csv
forward from the draft season and record the FIRST market event:

  * extension       — extension_inferred row; $ = aav (fallback tcv/length, then salary)
  * tagged          — tag row; $ = salary (tag price IS the market signal)
  * fa_auction      — fa_auction or expired_rookie_or_tag_auction row; $ = auction_bid_amount
  * waiver_add      — waiver_contract_add row; $ = max(salary, auction_bid_amount)
  * cut_unsigned    — drops with no future re-acquisition; $ = 0
  * pending         — no resolving event yet (right-censored 2022+ cohorts)
  * never_rostered  — pick player has no contract_history row at all; $ = 0

Outputs:
  - pipelines/reports/rookie_pick_value_realization.csv   (per-pick detail)
  - site/analytics/rookie_pick_value_summary.json         (slot + tier rollup)

Run:
    python3 pipelines/analytics/rookie_pick_value_realization.py
"""

from __future__ import annotations

import csv
import json
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ROOKIE_HISTORY = ROOT / "site" / "acquisition" / "rookie_draft_history.json"
CONTRACT_DIR = ROOT / "pipelines" / "reports"
OUT_CSV = ROOT / "pipelines" / "reports" / "rookie_pick_value_realization.csv"
OUT_JSON = ROOT / "site" / "analytics" / "rookie_pick_value_summary.json"

POSITIONS = ("qb", "rb", "wr", "te")
MAX_SEASON = 2025
DATA_START_SEASON = 2017  # contract_history coverage begins
RIGHT_CENSOR_CUTOFF = MAX_SEASON - 4  # picks drafted <= this year are fully resolvable
ROLLUP_COHORTS = range(DATA_START_SEASON, RIGHT_CENSOR_CUTOFF + 1)  # 2017..2021

OFFENSE_TOKENS = {"OFFENSE", "Offense", "offense", "O"}

NON_EVENT_CATEGORIES = {
    "carryover_contract",
    "manual_review",
    "missing_week1_snapshot",
    "week1_not_under_contract",
}
DROP_CATEGORIES = {"dropped_off_roster", "dropped_then_waiver_readd"}


def safe_float(x) -> float:
    try:
        return float(x) if x not in (None, "", "None") else 0.0
    except (TypeError, ValueError):
        return 0.0


def safe_int(x) -> int:
    try:
        return int(float(x)) if x not in (None, "", "None") else 0
    except (TypeError, ValueError):
        return 0


def load_timelines() -> dict[str, list[dict]]:
    """Concatenate per-position contract_history CSVs into one dict keyed by player_id."""
    timelines: dict[str, list[dict]] = defaultdict(list)
    for pos in POSITIONS:
        path = CONTRACT_DIR / f"contract_history_{pos}.csv"
        if not path.exists():
            continue
        with path.open() as f:
            for row in csv.DictReader(f):
                pid = row.get("player_id")
                if pid:
                    timelines[pid].append(row)
    for pid in timelines:
        timelines[pid].sort(key=lambda r: safe_int(r.get("season")))
    return timelines


def classify_event(row: dict) -> tuple[str, float] | None:
    """Return (event_tag, dollar_value) if this row is a resolving market event, else None."""
    cat = row.get("change_category") or ""

    if cat == "extension_inferred" or row.get("extension_flag") == "1":
        aav = safe_float(row.get("aav"))
        if aav <= 0:
            tcv = safe_float(row.get("tcv"))
            clen = safe_float(row.get("contract_length"))
            aav = tcv / clen if clen > 0 else 0.0
        if aav <= 0:
            aav = safe_float(row.get("salary"))
        return ("extension", aav)

    if cat == "tagged":
        return ("tagged", safe_float(row.get("salary")))

    if cat in ("fa_auction", "expired_rookie_or_tag_auction"):
        bid = safe_float(row.get("auction_bid_amount"))
        if bid <= 0:
            bid = safe_float(row.get("salary"))
        return ("fa_auction", bid)

    if cat == "waiver_contract_add":
        bid = safe_float(row.get("auction_bid_amount"))
        sal = safe_float(row.get("salary"))
        return ("waiver_add", max(bid, sal))

    return None


def resolve_pick(pick: dict, timelines: dict[str, list[dict]]) -> dict:
    """Walk the player's timeline forward from draft_season and find the first market event."""
    pid = pick.get("player_id")
    draft_season = safe_int(pick.get("season"))

    rows = timelines.get(pid, [])
    future_rows = [r for r in rows if safe_int(r.get("season")) > draft_season]

    # Pre-data cohorts (rookie deal entirely before contract_history starts).
    if draft_season < DATA_START_SEASON:
        # Their first visible row may be Y3 of the rookie deal or later. Allow walking from
        # any row >= draft_season, but flag scope.
        future_rows = [r for r in rows if safe_int(r.get("season")) >= DATA_START_SEASON]
        if not future_rows:
            return _result(pick, event="pre_data_no_trace", value=0.0,
                           event_season=None, resolving_franchise_id=None,
                           notes=f"draft_season={draft_season} < data_start={DATA_START_SEASON}; no rows in window")

    if not rows:
        # Drafted but never appears in any contract_history row.
        if draft_season > RIGHT_CENSOR_CUTOFF:
            return _result(pick, event="pending", value=0.0,
                           event_season=None, resolving_franchise_id=None,
                           notes="right-censored; no contract_history rows yet")
        return _result(pick, event="never_rostered", value=0.0,
                       event_season=None, resolving_franchise_id=None,
                       notes="no contract_history row (drafted but cut pre-snapshot?)")

    if not future_rows:
        # Player has only rookie-year row(s) and nothing after.
        if draft_season > RIGHT_CENSOR_CUTOFF:
            return _result(pick, event="pending", value=0.0,
                           event_season=safe_int(rows[-1].get("season")),
                           resolving_franchise_id=None,
                           notes="right-censored; only rookie-year row visible")
        # Older cohort: dropped during/after rookie year, never re-rostered.
        return _result(pick, event="cut_unsigned", value=0.0,
                       event_season=safe_int(rows[-1].get("season")),
                       resolving_franchise_id=None,
                       notes="rookie-year-only timeline; presumed dropped + cleared")

    saw_drop = False
    last_seen_season = draft_season
    for row in future_rows:
        last_seen_season = safe_int(row.get("season"))
        cat = row.get("change_category") or ""

        if cat in NON_EVENT_CATEGORIES:
            # Even non-event rows can carry an in-season drop signal.
            if row.get("drop_in_season_flag") == "1":
                saw_drop = True
            continue
        if cat in DROP_CATEGORIES:
            saw_drop = True
            continue

        event = classify_event(row)
        if event is None:
            continue
        tag, value = event
        return _result(
            pick, event=tag, value=value,
            event_season=safe_int(row.get("season")),
            resolving_franchise_id=row.get("franchise_id"),
            notes=cat,
        )

    # No resolving event found.
    if draft_season <= RIGHT_CENSOR_CUTOFF:
        # Cohort old enough that we should have seen a resolution. Either the player was
        # dropped (cut_unsigned) or the rookie deal expired without a market signal
        # (no team bid, never tagged, never extended) → expired_unsigned.
        if saw_drop:
            return _result(pick, event="cut_unsigned", value=0.0,
                           event_season=last_seen_season,
                           resolving_franchise_id=None,
                           notes="dropped, no future re-acquisition")
        return _result(pick, event="expired_unsigned", value=0.0,
                       event_season=last_seen_season,
                       resolving_franchise_id=None,
                       notes="rookie deal lapsed; no extension/tag/FA-auction event")
    # Right-censored
    return _result(pick, event="pending", value=0.0,
                   event_season=last_seen_season,
                   resolving_franchise_id=None,
                   notes="right-censored (rookie deal not yet expired)")


def derive_tier(draft_round: int, segment: str | None) -> str:
    """Combine draft_round (1-6) with round_segment (Early/Middle/Late) into a tier label.

    Mirrors the heuristic table in dynasty_vs_redraft_strategy.md section 5.
    """
    seg = (segment or "").lower()
    if draft_round == 1:
        if seg == "early":
            return "early_1st"
        if seg == "middle":
            return "mid_1st"
        if seg == "late":
            return "late_1st"
        return "1st_unknown"
    if draft_round == 2:
        if seg == "early":
            return "early_2nd"
        if seg == "middle":
            return "mid_2nd"
        if seg == "late":
            return "late_2nd"
        return "2nd_unknown"
    if draft_round == 3:
        if seg == "early":
            return "early_3rd"
        if seg == "middle":
            return "mid_3rd"
        if seg == "late":
            return "late_3rd"
        return "3rd_unknown"
    if draft_round >= 4:
        return "4th_plus"
    return "unknown"


TIER_PICK_RANGES = {
    "early_1st": "1.01-1.04",
    "mid_1st":   "1.05-1.08",
    "late_1st":  "1.09-1.12",
    "early_2nd": "2.01-2.04",
    "mid_2nd":   "2.05-2.08",
    "late_2nd":  "2.09-2.12",
    "early_3rd": "3.01-3.04",
    "mid_3rd":   "3.05-3.08",
    "late_3rd":  "3.09-3.12",
    "4th_plus":  "4.01-6.12",
}

TIER_ORDER = ["early_1st", "mid_1st", "late_1st",
              "early_2nd", "mid_2nd", "late_2nd",
              "early_3rd", "mid_3rd", "late_3rd",
              "4th_plus"]


def _result(pick: dict, *, event: str, value: float,
            event_season: int | None, resolving_franchise_id: str | None,
            notes: str) -> dict:
    draft_season = safe_int(pick.get("season"))
    event_year_offset = (event_season - draft_season) if event_season else None
    tier = derive_tier(safe_int(pick.get("draft_round")), pick.get("round_segment"))
    return {
        "season": draft_season,
        "pick_label": pick.get("pick_label"),
        "pick_overall": safe_int(pick.get("pick_overall")),
        "draft_round": safe_int(pick.get("draft_round")),
        "round_segment": pick.get("round_segment"),
        "tier": tier,
        "player_id": pick.get("player_id"),
        "player_name": pick.get("player_name"),
        "position": pick.get("position"),
        "offense_defense": pick.get("offense_defense"),
        "rookie_salary_y1": safe_int(pick.get("salary")),
        "event": event,
        "event_season": event_season,
        "event_year_offset": event_year_offset,
        "event_dollar_value": int(round(value)),
        "resolving_franchise_id": resolving_franchise_id,
        "notes": notes,
    }


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = (len(s) - 1) * pct
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


# Events that count as "resolved" for rollup statistics.
RESOLVED_EVENTS = {"extension", "tagged", "fa_auction", "waiver_add",
                   "cut_unsigned", "expired_unsigned", "never_rostered"}
ZERO_VALUE_EVENTS = {"cut_unsigned", "expired_unsigned", "never_rostered"}


def summarize(records: list[dict], group_key: str, pick_range_lookup=None) -> list[dict]:
    groups: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        # Offense-only rollup (matches heuristic table being replaced).
        if r.get("offense_defense") not in OFFENSE_TOKENS:
            continue
        # Restrict rollup to fully-resolvable cohorts (2017..2021).
        if r.get("season") not in ROLLUP_COHORTS:
            continue
        groups[r.get(group_key)].append(r)

    out = []
    for key, rs in groups.items():
        if key is None:
            continue
        n_total = len(rs)
        resolved = [r for r in rs if r["event"] in RESOLVED_EVENTS]
        pending = [r for r in rs if r["event"] == "pending"]

        values = [r["event_dollar_value"] for r in resolved]
        ext_share = sum(1 for r in resolved if r["event"] == "extension") / len(resolved) if resolved else 0
        fa_share = sum(1 for r in resolved if r["event"] in ("fa_auction", "tagged", "waiver_add")) / len(resolved) if resolved else 0
        zero_share = sum(1 for r in resolved if r["event"] in ZERO_VALUE_EVENTS) / len(resolved) if resolved else 0

        entry = {
            group_key: key,
            "n_total": n_total,
            "n_resolved": len(resolved),
            "n_pending": len(pending),
            "mean": int(round(statistics.mean(values))) if values else 0,
            "median": int(round(statistics.median(values))) if values else 0,
            "p10": int(round(percentile(values, 0.10))),
            "p90": int(round(percentile(values, 0.90))),
            "share_extension": round(ext_share, 3),
            "share_fa_auction": round(fa_share, 3),
            "share_zero": round(zero_share, 3),
        }
        if pick_range_lookup and key in pick_range_lookup:
            entry["pick_range"] = pick_range_lookup[key]
        out.append(entry)

    # Sort: by_pick_slot by pick_overall via label; by_round_segment by canonical order.
    if group_key == "pick_label":
        out.sort(key=lambda e: (
            int(e["pick_label"].split(".")[0]),
            int(e["pick_label"].split(".")[1]),
        ))
    return out


def main() -> int:
    print(f"Loading rookie picks from {ROOKIE_HISTORY.relative_to(ROOT)}", flush=True)
    with ROOKIE_HISTORY.open() as f:
        rookie_doc = json.load(f)
    picks = rookie_doc.get("history_rows", [])
    segment_def = rookie_doc.get("round_segment_definition", {})
    print(f"  {len(picks)} picks, seasons {min(p['season'] for p in picks)}-{max(p['season'] for p in picks)}", flush=True)

    print(f"Loading contract_history timelines from {CONTRACT_DIR.relative_to(ROOT)}", flush=True)
    timelines = load_timelines()
    print(f"  {len(timelines)} unique player_ids across {len(POSITIONS)} positions", flush=True)

    print("Resolving picks → market events...", flush=True)
    records = [resolve_pick(p, timelines) for p in picks]

    event_counter = Counter(r["event"] for r in records
                            if r["offense_defense"] in OFFENSE_TOKENS)
    print(f"  Offense pick event distribution: {dict(event_counter)}", flush=True)

    # Write per-pick CSV
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = ["season", "pick_label", "pick_overall", "draft_round", "round_segment",
                  "tier", "player_id", "player_name", "position", "offense_defense",
                  "rookie_salary_y1", "event", "event_season", "event_year_offset",
                  "event_dollar_value", "resolving_franchise_id", "notes",
                  "generated_at_utc"]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with OUT_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in records:
            r_out = dict(r)
            r_out["generated_at_utc"] = now
            w.writerow(r_out)
    print(f"  Wrote {OUT_CSV.relative_to(ROOT)} ({len(records)} rows)", flush=True)

    # Rollups
    by_slot = summarize(records, "pick_label")
    by_tier = summarize(records, "tier", pick_range_lookup=TIER_PICK_RANGES)
    by_tier.sort(key=lambda e: (TIER_ORDER.index(e["tier"])
                                if e["tier"] in TIER_ORDER else 99))

    offense_records = [r for r in records if r.get("offense_defense") in OFFENSE_TOKENS]
    rollup_records = [r for r in offense_records if r.get("season") in ROLLUP_COHORTS]
    rollup_event_counter = Counter(r["event"] for r in rollup_records)
    summary = {
        "meta": {
            "generated_at": now,
            "draft_seasons_min": min(p["season"] for p in picks),
            "draft_seasons_max": max(p["season"] for p in picks),
            "data_start_season": DATA_START_SEASON,
            "right_censor_cutoff_season": RIGHT_CENSOR_CUTOFF,
            "max_data_season": MAX_SEASON,
            "rollup_cohort_seasons": list(ROLLUP_COHORTS),
            "n_total_picks_offense": len(offense_records),
            "n_rollup_picks": len(rollup_records),
            "n_resolved_in_rollup": sum(1 for r in rollup_records if r["event"] in RESOLVED_EVENTS),
            "event_counts_offense_all_years": dict(event_counter),
            "event_counts_rollup_only": dict(rollup_event_counter),
            "rollup_scope": (f"offense_only AND draft_season in [{DATA_START_SEASON}..{RIGHT_CENSOR_CUTOFF}]; "
                             f"pre-data cohorts (<{DATA_START_SEASON}) and right-censored cohorts "
                             f"(>{RIGHT_CENSOR_CUTOFF}) excluded from rollup but present in per-pick CSV"),
        },
        "by_pick_slot": by_slot,
        "by_tier": by_tier,
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    with OUT_JSON.open("w") as f:
        json.dump(summary, f, indent=2)
    print(f"  Wrote {OUT_JSON.relative_to(ROOT)}", flush=True)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
