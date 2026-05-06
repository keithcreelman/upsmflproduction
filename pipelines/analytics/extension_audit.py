"""
extension_audit.py — Audit the extension_flag column in pipelines/reports/contract_history_*.csv.

The flag is currently set in build_contract_history_snapshots.py via a simple substring
match: `extension_flag = 1 if "EXT:" in contract_info.upper() else 0`. This audit
surfaces cases where that heuristic likely under- or over-counts:

  1. **Missing extensions:** prior-season contract_status was Rookie/Rookie GF, current
     season is Veteran-class with a salary increase, but extension_flag = 0.
  2. **Salary-jump extensions:** salary jumps ≥1.5× prior season's salary without
     extension_flag set. Possible MYM-extension or restructure mis-categorization.
  3. **Contract-year resets:** prior contract_year < current contract_year (e.g., 1 → 3)
     suggests a new contract started but extension_flag = 0.
  4. **Status flips:** prior contract_status contains 'Rookie', current contains
     'Veteran' or 'Tag', no extension_flag.
  5. **MYM contract_status entries** (e.g., "MYM - Vet") that have no extension_flag —
     MYM is essentially a hidden extension when AAV jumps materially.

Outputs:
  - site/rookies/_extension_audit_anomalies.csv — per-suspect-row, with reason codes.
  - docs/league-context/extension_audit_summary.md — counts + spot-checks.

Run:
    python3 pipelines/analytics/extension_audit.py
"""

from __future__ import annotations

import csv
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = ROOT / "pipelines" / "reports"
OUT_CSV = ROOT / "site" / "rookies" / "_extension_audit_anomalies.csv"
OUT_MD = ROOT / "docs" / "league-context" / "extension_audit_summary.md"


def safe_float(x):
    try:
        return float(x) if x not in (None, "", "None") else 0.0
    except (TypeError, ValueError):
        return 0.0


def safe_int(x):
    try:
        return int(float(x)) if x not in (None, "", "None") else 0
    except (TypeError, ValueError):
        return 0


def main() -> int:
    suspects: list[dict] = []
    counts_per_pos: dict[str, dict] = defaultdict(Counter)

    for pos_code in ("QB", "RB", "WR", "TE"):
        path = CONTRACT_DIR / f"contract_history_{pos_code}.csv"
        if not path.exists():
            continue
        with path.open() as f:
            rows = list(csv.DictReader(f))

        # Sort to walk player timelines forward
        rows.sort(key=lambda r: (r["player_id"], safe_int(r["season"])))

        for r in rows:
            counts_per_pos[pos_code]["total_rows"] += 1
            if r.get("extension_flag") == "1":
                counts_per_pos[pos_code]["flagged_extensions"] += 1

            reasons = []

            ext = r.get("extension_flag") == "1"
            prior_status = (r.get("prior_contract_status") or "").lower()
            cur_status = (r.get("contract_status") or "").lower()
            prior_salary = safe_float(r.get("prior_salary"))
            cur_salary = safe_float(r.get("salary"))
            prior_cy = safe_int(r.get("prior_contract_year"))
            cur_cy = safe_int(r.get("contract_year"))
            prior_season = safe_int(r.get("prior_season"))
            cur_season = safe_int(r.get("season"))

            # Skip if no prior season (first observation of player)
            if not prior_season:
                continue

            # 1. Rookie → Veteran transition without extension_flag
            if (
                "rookie" in prior_status
                and ("veteran" in cur_status or "tag" in cur_status or "front" in cur_status or "extension" in cur_status)
                and not ext
                and prior_salary > 0
                and cur_salary > prior_salary * 1.2
            ):
                reasons.append("rookie_to_vet_no_flag")

            # 2. Salary jump >= 1.5x without extension_flag
            if not ext and prior_salary > 0 and cur_salary >= prior_salary * 1.5:
                reasons.append("salary_jump_no_flag")

            # 3. Contract-year reset upward (cy goes from low to high) without extension_flag
            # New contracts typically start at cy = 2 or 3 (term length); cy decrements yearly.
            if not ext and prior_cy and cur_cy and cur_cy > prior_cy + 1:
                reasons.append("contract_year_reset_no_flag")

            # 4. MYM contract_status without extension flag
            if "mym" in cur_status and not ext:
                reasons.append("mym_status_no_flag")

            # 5. Restructure flag set without extension flag (these are technically distinct
            # but worth flagging for review since the data sometimes conflates them)
            if r.get("restructure_flag") == "1" and not ext:
                reasons.append("restructure_only")

            if reasons:
                suspects.append({
                    "position": pos_code,
                    "season": cur_season,
                    "prior_season": prior_season,
                    "player_id": r.get("player_id"),
                    "player_name": r.get("player_name"),
                    "franchise_id": r.get("franchise_id"),
                    "prior_team_name": r.get("prior_team_name"),
                    "team_name": r.get("team_name"),
                    "prior_status": r.get("prior_contract_status"),
                    "cur_status": r.get("contract_status"),
                    "prior_salary": int(prior_salary) if prior_salary else 0,
                    "cur_salary": int(cur_salary) if cur_salary else 0,
                    "salary_jump_x": round(cur_salary / prior_salary, 2) if prior_salary else "",
                    "prior_cy": prior_cy,
                    "cur_cy": cur_cy,
                    "extension_flag": r.get("extension_flag"),
                    "restructure_flag": r.get("restructure_flag"),
                    "mym_flag": r.get("mym_flag"),
                    "contract_info": (r.get("contract_info") or "")[:120],
                    "inferred_extension_term": r.get("inferred_extension_term"),
                    "inferred_extension_rate": r.get("inferred_extension_rate"),
                    "reasons": ";".join(reasons),
                })
                for reason in reasons:
                    counts_per_pos[pos_code][reason] += 1

    # Write suspects CSV
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    if suspects:
        fieldnames = list(suspects[0].keys())
        with OUT_CSV.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=fieldnames)
            w.writeheader()
            w.writerows(suspects)
    print(f"wrote {OUT_CSV.relative_to(ROOT)}: {len(suspects)} suspect rows")

    # Build summary markdown
    lines: list[str] = []
    lines.append("# Extension Flag Audit — pipelines/reports/contract_history_*.csv\n")
    lines.append(
        "The `extension_flag` column is set in `build_contract_history_snapshots.py` "
        "via a simple substring match: `extension_flag = 1 if 'EXT:' in contract_info.upper()`. "
        "This audit walks every player's season-by-season timeline and flags transitions "
        "that *look like* extensions but where the flag wasn't set, plus cases where a "
        "different signal (MYM, restructure) was set without an accompanying extension flag.\n"
    )

    lines.append("\n## Counts per position\n")
    lines.append(
        "| Pos | Total rows | Flagged extensions | Rookie→Vet (no flag) | Salary jump ≥1.5× (no flag) | "
        "CY reset (no flag) | MYM status (no flag) | Restructure only |\n"
        "|----:|-----------:|-------------------:|---------------------:|----------------------------:|"
        "-------------------:|---------------------:|-----------------:|"
    )
    for pos in ("QB", "RB", "WR", "TE"):
        c = counts_per_pos[pos]
        lines.append(
            f"| {pos} | {c['total_rows']} | {c['flagged_extensions']} | "
            f"{c['rookie_to_vet_no_flag']} | {c['salary_jump_no_flag']} | "
            f"{c['contract_year_reset_no_flag']} | {c['mym_status_no_flag']} | "
            f"{c['restructure_only']} |"
        )

    # Show a few suspicious examples per category
    lines.append("\n## Sample suspects per category\n")
    by_reason: dict[str, list[dict]] = defaultdict(list)
    for s in suspects:
        # Pick the strongest single reason for grouping
        first_reason = s["reasons"].split(";")[0]
        by_reason[first_reason].append(s)

    for reason, samples in by_reason.items():
        lines.append(f"\n### {reason} (n={len(samples)})\n")
        # Show top 10 by salary
        samples.sort(key=lambda s: -safe_float(s["cur_salary"]))
        lines.append(
            "| Pos | Season | Player | Prior status | Cur status | Prior $ | Cur $ | Jump× | Prior cy | Cur cy | Ext flag | Notes |\n"
            "|----:|-------:|:-------|:-------------|:-----------|--------:|------:|------:|---------:|-------:|:--------:|:------|"
        )
        for s in samples[:12]:
            jump = f"{s['salary_jump_x']}×" if s['salary_jump_x'] else "—"
            ci = s["contract_info"][:40].replace("|", "\\|")
            lines.append(
                f"| {s['position']} | {s['season']} | {s['player_name']} | {s['prior_status']} | "
                f"{s['cur_status']} | {s['prior_salary']} | {s['cur_salary']} | {jump} | "
                f"{s['prior_cy']} | {s['cur_cy']} | {s['extension_flag']} | {ci} |"
            )

    lines.append("\n## What to do with this\n")
    lines.append(
        "1. **Hand-audit a sample of each category.** If the rookie→vet or salary-jump "
        "rows are mostly legitimate extensions that the EXT: heuristic missed, the "
        "extension counts in our analysis are undercounted by this many. Re-run "
        "`rookie_extension_followthrough.py` after the underlying flag is fixed.\n"
        "2. **MYM-status rows are extensions in disguise.** UPS treats MYM with a "
        "raise as a contract extension functionally. Suggest extending the parser in "
        "`build_contract_history_snapshots.py` to also set `extension_flag = 1` when "
        "`contract_status` contains 'MYM' AND `inferred_extension_rate > prior_salary × 1.5`.\n"
        "3. **Contract-year resets are often extensions.** When prior_cy=1 and cur_cy=3 "
        "in consecutive seasons for the same player+franchise, a new contract started "
        "between the two snapshots. If contract_info doesn't carry 'EXT:', the parser "
        "should still set the flag based on the cy delta.\n"
        "4. **Cross-check with `site/ccc/extension_submissions.json`** if such a file "
        "exists — those are the source-of-truth submissions; flag mismatches.\n"
    )

    OUT_MD.parent.mkdir(parents=True, exist_ok=True)
    OUT_MD.write_text("\n".join(lines))
    print(f"wrote {OUT_MD.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
