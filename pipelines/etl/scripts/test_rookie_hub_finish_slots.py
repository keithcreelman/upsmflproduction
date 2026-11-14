"""Rookie-draft slot by final finish (canon docs/league_context_v1.md §A1).

The Week-16 fifth-place game WINNER (finish 5) picks .07 and the loser (finish 6)
.08. build_rookie_draft_hub.py had them swapped, so the Rookie Hub projected the
5th-place team at 1.08 and the 6th at 1.07.

Proof: tests/fixtures/draft_slot_by_finish_evidence.json traces 281 recorded picks
(drafts 2012-2025) to their original owner. This test reads the builder's table
without importing the builder (it needs a local DB and MFL), checks it against the
recorded drafts, shows the old table fails, and checks the published projection.

    node scripts/safe_tests/run.mjs --only test_rookie_hub_finish_slots
"""
import ast
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
BUILDER = ROOT / "pipelines" / "etl" / "scripts" / "build_rookie_draft_hub.py"
EVIDENCE = ROOT / "tests" / "fixtures" / "draft_slot_by_finish_evidence.json"
PROJECTION = ROOT / "site" / "rookies" / "rookie_future_picks.json"

CANON = {7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 5: 7, 6: 8, 4: 9, 3: 10, 2: 11, 1: 12}
OLD = {**CANON, 5: 8, 6: 7}   # the table before this fix

failures = []


def check(name, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + name + (("\n         " + detail) if (detail and not ok) else ""))
    if not ok:
        failures.append(name)


def builder_table():
    tree = ast.parse(BUILDER.read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(getattr(t, "id", None) == "FINISH_TO_SLOT" for t in node.targets):
            return ast.literal_eval(node.value)
    return None


def agreement(table, rows, finishes):
    pick = [r for r in rows if r["prior_season_final_finish"] in finishes]
    return sum(1 for r in pick if table[r["prior_season_final_finish"]] == r["slot"]), len(pick)


table = builder_table()
ev = json.loads(EVIDENCE.read_text())
rows = ev["rows"]

check("builder defines FINISH_TO_SLOT at module level", table is not None)
check("builder table equals canon §A1 (5 -> .07, 6 -> .08)", table == CANON, f"got {table}")

by_finish = defaultdict(Counter)
for r in rows:
    by_finish[r["prior_season_final_finish"]][r["slot"]] += 1
modal_ok = all(by_finish[f].most_common(1)[0][0] == CANON[f] for f in CANON if by_finish[f])
check("every finish's most common recorded slot matches the table", modal_ok,
      str({f: by_finish[f].most_common(2) for f in sorted(by_finish)}))

hit, n = agreement(CANON, rows, (5, 6))
check(f"finishes 5 and 6: table matches {hit}/{n} traced picks (at least 90%)", n >= 40 and hit / n >= 0.9)
old_hit, _ = agreement(OLD, rows, (5, 6))
check(f"the old swapped table matches only {old_hit}/{n} (the bug is caught)", old_hit / n < 0.1)

clean = ev["clean_examples"]
check("recorded seasons where the team kept its own pick: 2013 finish 5 -> 2014 2.07 and 5.07",
      {(r["draft_year"], r["round"], r["slot"]) for r in clean if r["original_franchise_id"] == "0009"} >= {(2014, 2, 7), (2014, 5, 7)})
check("... and 2021 finish 6 -> 2022 3.08 and 4.08",
      {(r["draft_year"], r["round"], r["slot"]) for r in clean if r["original_franchise_id"] == "0012"} >= {(2022, 3, 8), (2022, 4, 8)})

proj = json.loads(PROJECTION.read_text())
ordinal = {r["franchise_id"]: r["projected_ordinal"] for r in proj["projection_basis"] if r.get("projected_ordinal")}
bad = [p["asset_id"] for p in proj["picks"]
       if p.get("projected_slot") and p.get("original_owner_fid") in ordinal
       and p["projected_slot"] != CANON[ordinal[p["original_owner_fid"]]]]
check("published Rookie Hub projection uses the table for every projected pick", not bad, ", ".join(bad[:8]))
labels_ok = all(r.get("projected_slot_label") == f"1.{CANON[r['projected_ordinal']]:02d}" for r in proj["projection_basis"] if r.get("projected_ordinal"))
check("projection basis labels agree", labels_ok)

print(f"\ntest_rookie_hub_finish_slots: {'FAILED ' + str(len(failures)) if failures else 'all checks passed'}")
sys.exit(1 if failures else 0)
