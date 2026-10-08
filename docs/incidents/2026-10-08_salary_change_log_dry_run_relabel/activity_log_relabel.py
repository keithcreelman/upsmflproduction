#!/usr/bin/env python3
"""PROPOSED (not applied): mark the 20 dry runs that the Front Office activity timeline shows as real activity.

    python3 docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/activity_log_relabel.py            # check only (default)
    python3 docs/incidents/2026-10-08_salary_change_log_dry_run_relabel/activity_log_relabel.py --apply    # Keith's approval only

Each of these entries in site/rosters/contract_submissions/contract_activity_2026.json was dispatched by a contract-route
DRY RUN with test_flag 0 (the worker hard-coded it until 2026-10-08), so the timeline shows them without its "DRY" badge.
The change sets test_flag = 1 on exactly these entries (matched by activity_id AND player AND submit time) and changes
nothing else; every entry is kept. --apply refuses unless every entry is found in its exact expected state.
The tier is the same as the salary_change_log row the entry belongs to (classification.json).
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
LOG = os.path.join(ROOT, "site", "rosters", "contract_submissions", "contract_activity_2026.json")

# the entries themselves: activity_log_entries.json (activity_id, change_log_id, player, submit time), built from the match


def load_entries():
    cls = {c["id"]: c for c in json.load(open(os.path.join(HERE, "classification.json")))}
    plan = json.load(open(os.path.join(HERE, "activity_log_entries.json")))
    for e in plan:
        e["tier"] = cls[e["change_log_id"]]["tier"]
    return plan


def main(apply):
    plan = load_entries()
    doc = json.load(open(LOG))
    by_id = {a.get("activity_id"): a for a in doc["activities"]}
    problems = []
    for e in plan:
        a = by_id.get(e["activity_id"])
        if not a:
            problems.append(f"{e['activity_id']}: not found")
        elif str(a.get("player_id")) != e["player_id"] or a.get("submitted_at_utc") != e["submitted_at_utc"]:
            problems.append(f"{e['activity_id']}: player/time differ from the plan")
        elif int(a.get("test_flag") or 0) != 0:
            problems.append(f"{e['activity_id']}: test_flag is already {a.get('test_flag')}")
    for e in plan:
        print(f"{e['activity_id']}  change_log {e['change_log_id']}  tier {e['tier']}  {e['activity_type']:<20} {e['player_name']:<24} {e['submitted_at_utc']}")
    if problems:
        print("NOT in the expected state — nothing written:\n  " + "\n  ".join(problems))
        return 1
    if not apply:
        print(f"check OK: {len(plan)} entries in their expected state (test_flag 0). Re-run with --apply only on approval.")
        return 0
    for e in plan:
        by_id[e["activity_id"]]["test_flag"] = 1
    with open(LOG, "w", encoding="utf-8") as f:
        f.write(json.dumps(doc, indent=2))   # byte-for-byte the format pipelines/etl/scripts/log_contract_activity.py writes
    print(f"applied: test_flag = 1 on {len(plan)} entries; nothing else changed")
    return 0


if __name__ == "__main__":
    sys.exit(main("--apply" in sys.argv))
