#!/usr/bin/env python3
"""The daily snapshot and the draft-day trades file are committed without a trade's free-text `comments` field, and
nothing that reads them needs it.

Synthetic data only; offline. Run:  python3 pipelines/etl/scripts/test_public_data_comments.py
"""
import json
import re
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import strip_snapshot_comments as sc  # noqa: E402

NOTE = "SYNTHETIC-NOTE"


def trade(i, note=NOTE):
    return {"type": "TRADE", "timestamp": str(1700000000 + i), "franchise": "0001", "franchise2": "0002",
            "franchise1_gave_up": "14056,", "franchise2_gave_up": "13100,", "comments": note, "expires": "1700999999"}


def snapshot(rows):
    return {"version": "1.0", "encoding": "utf-8", "transactions": {"transaction": rows}}


class StripComments(unittest.TestCase):
    def test_list_of_rows(self):
        doc, n = sc.strip_comments(snapshot([trade(1), trade(2, ""), {"type": "ADD", "franchise": "0003"}]))
        self.assertEqual(n, 2)
        self.assertNotIn("comments", json.dumps(doc))
        self.assertEqual(doc["transactions"]["transaction"][0]["franchise1_gave_up"], "14056,")
        self.assertEqual(doc["transactions"]["transaction"][2], {"type": "ADD", "franchise": "0003"})

    def test_single_row_is_an_object_not_a_list(self):
        doc, n = sc.strip_comments(snapshot(trade(1)))
        self.assertEqual(n, 1)
        self.assertEqual(sorted(doc["transactions"]["transaction"]), ["expires", "franchise", "franchise1_gave_up",
                                                                       "franchise2", "franchise2_gave_up", "timestamp", "type"])

    def test_nested_and_only_inside_transactions(self):
        doc = snapshot([{"type": "TRADE", "extra": {"deep": [{"comments": NOTE}]}}])
        doc["other"] = {"comments": "kept: not a transactions field"}
        out, n = sc.strip_comments(doc)
        self.assertEqual(n, 1)
        self.assertNotIn(NOTE, json.dumps(out))
        self.assertEqual(out["other"]["comments"], "kept: not a transactions field")

    def test_error_envelope_and_empty_transactions_are_untouched(self):
        for doc in ({"error": {"$t": "x"}}, {"transactions": {}}, {"version": "1.0", "transactions": {"transaction": []}}):
            before = json.dumps(doc, sort_keys=True)
            out, n = sc.strip_comments(json.loads(before))
            self.assertEqual(n, 0)
            self.assertEqual(json.dumps(out, sort_keys=True), before)

    def test_everything_but_comments_is_identical(self):
        rows = [trade(i) for i in range(5)]
        out, _ = sc.strip_comments(snapshot([dict(r) for r in rows]))
        expected = [{k: v for k, v in r.items() if k != "comments"} for r in rows]
        self.assertEqual(out["transactions"]["transaction"], expected)

    def test_file_is_updated_in_the_workflows_own_format(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "transactions.json"
            p.write_text(sc.dumps(snapshot([trade(1), trade(2)])))
            self.assertEqual(sc.main(["x", str(p)]), 0)
            text = p.read_text()
            self.assertNotIn("comments", text)
            self.assertEqual(text, sc.dumps(json.loads(text)))     # indent=2, sorted keys, ASCII: what the workflow writes
            self.assertEqual(sc.main(["x", str(p)]), 0)            # idempotent
            self.assertEqual(p.read_text(), text)

    def test_unreadable_file_fails_so_nothing_is_committed(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "transactions.json"
            p.write_text("{not json")
            self.assertEqual(sc.main(["x", str(p)]), 1)
            self.assertEqual(sc.main(["x", str(Path(d) / "missing.json")]), 1)
            self.assertEqual(sc.main(["x"]), 1)


class WiringGuards(unittest.TestCase):
    def test_workflow_strips_before_the_commit_and_stops_on_failure(self):
        wf = (REPO / ".github/workflows/mfl-daily-snapshot.yml").read_text()
        fetch = wf[wf.index("- name: Fetch MFL exports"):wf.index("- name: Commit")]
        self.assertIn("set -euo pipefail", fetch)
        call = fetch.index('strip_snapshot_comments.py "$DIR/transactions.json"')
        self.assertGreater(call, fetch.index("done"), "the strip runs after every export is written")
        self.assertLess(call, fetch.index("_snapshot_meta.json"))
        self.assertEqual(wf.count("strip_snapshot_comments.py"), 1)

    def test_draft_day_builder_no_longer_copies_the_note(self):
        src = (REPO / "pipelines/etl/scripts/build_rookie_draft_hub.py").read_text()
        block = src[src.index("by_group: dict[str, dict] = {}"):src.index("by_group[gid][\"sides\"]") if 'by_group[gid]["sides"]' in src else None]
        self.assertNotIn('d["comments"]', block)
        self.assertRegex(block, r'"comments": "",')

    def test_site_reader_shows_a_note_only_when_present(self):
        js = (REPO / "site/rookies/rookie_draft_hub.js").read_text()
        self.assertRegex(js, r't\.comments \? `<div class="small"[^`]*\$\{t\.comments\.slice\(0, 120\)\}[^`]*` : ""')

    def test_no_snapshot_reader_uses_a_trade_note(self):
        """The scripts that read data/mfl-snapshots (other than the manual A/B bot script) never touch `comments`."""
        readers = ["check_roster_anomalies", "build_valuation_snapshot", "rebuild_valuation_snapshot", "extract_valuation_inputs",
                   "ingest_mfl_snapshot_contracts", "build_contract_unification_proposal", "build_unification_before_after",
                   "replay_2026_trade_grades", "sync_config_to_d1"]
        for name in readers:
            src = (SCRIPT_DIR / f"{name}.py").read_text()
            self.assertIsNone(re.search(r"""\[["']comments["']\]|\.get\(["']comments["']""", src), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
