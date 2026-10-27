#!/usr/bin/env python3
"""Exact-membership proof for worker/src/rank_pending.js (#1307 / PR #1372).

Regenerates the held 2025 ranks from the committed inputs table and compares
every player and field with the committed manifest and worker module, then
proves that removing, adding or swapping a single ID (or editing one record or
one input) fails the check.

Usage:
  python3 pipelines/etl/scripts/test_rank_pending_1307.py
"""
import importlib.util
import json
import re
import shutil
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
spec = importlib.util.spec_from_file_location("rp1307", HERE / "rank_pending_1307.py")
rp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rp)

INPUTS = ROOT / "docs/data_fixes/1307_rank_pending/inputs_2025.json"
MANIFEST = ROOT / "docs/data_fixes/1307_rank_pending/manifest_2025.json"
JS = ROOT / "worker/src/rank_pending.js"


def js_sets(text):
    out = {}
    for f in rp.FIELDS:
        body = text.split(f + ": new Set([", 1)[1].split("])", 1)[0]
        out[f] = re.findall(r'"(\d+)"', body)
    return out


class CommittedFilesAreExact(unittest.TestCase):
    def test_manifest_and_module_equal_a_fresh_regeneration(self):
        self.assertEqual(rp.check(INPUTS, MANIFEST, JS), [])

    def test_every_held_field_is_recorded_and_proven(self):
        inputs = json.loads(INPUTS.read_text())
        m = json.loads(MANIFEST.read_text())
        rows = {r[0]: dict(zip(inputs["columns"], r)) for r in inputs["rows"]}
        self.assertEqual(m["inputs_sha256"], rp.sha256_bytes(rp.canon(inputs)))
        self.assertEqual(m["counts"]["pos_rank"], 253)
        self.assertEqual(m["counts"]["pos_ppg_rank"], 448)
        sets = js_sets(JS.read_text())
        for f in rp.FIELDS:
            self.assertEqual(sorted(sets[f], key=int), sorted((x["player_id"] for x in m["held"][f]), key=int), f)
            for x in m["held"][f]:
                r = rows[x["player_id"]]
                for k in ("player_id", "pos_group", "stored_rank", "clean_rank", "points", "scored_weeks", "ppg",
                          "comparison_value", "input_row_sha256", "inputs_sha256"):
                    self.assertIn(k, x)
                self.assertEqual(x["input_row_sha256"], rp.sha256_bytes(rp.canon([r[k] for k in inputs["columns"]])))
                self.assertEqual(x["stored_rank"], r["stored_" + f])
                self.assertNotEqual(x["stored_rank"], x["clean_rank"])
                self.assertEqual(x["comparison_value"],
                                 round(r["mfl_points"], 4) if f == "pos_rank" else round(r["mfl_points"] / r["mfl_weeks"], 4))
                # Newly shown by Batch 1A: matches the rank's basis after 1A, not before.
                self.assertTrue(rp.card_shows(r["d1_after_points"], r["d1_after_weeks"], r["basis_points"], r["basis_weeks"]))
                self.assertFalse(rp.card_shows(r["d1_before_points"], r["d1_before_weeks"], r["basis_points"], r["basis_weeks"]))

    def test_already_visible_questionable_ranks_are_recorded_not_held(self):
        m = json.loads(MANIFEST.read_text())
        a = m["not_held_already_visible"]
        self.assertEqual(a["counts"], {"pos_rank": 139, "pos_ppg_rank": 180})
        self.assertIn("BLOCKER", a["status"])
        sets = js_sets(JS.read_text())
        for f in rp.FIELDS:
            self.assertFalse(set(a[f]) & set(sets[f]), f)

    def test_the_known_cases(self):
        m = json.loads(MANIFEST.read_text())
        held = {f: {x["player_id"]: x for x in m["held"][f]} for f in rp.FIELDS}
        self.assertEqual((held["pos_rank"]["17086"]["stored_rank"], held["pos_rank"]["17086"]["clean_rank"]), (211, 208))
        self.assertEqual((held["pos_ppg_rank"]["17086"]["stored_rank"], held["pos_ppg_rank"]["17086"]["clean_rank"]), (225, 224))
        self.assertIn("16390", held["pos_rank"]); self.assertNotIn("16390", held["pos_ppg_rank"])   # McLaughlin
        self.assertIn("17124", held["pos_ppg_rank"]); self.assertNotIn("17124", held["pos_rank"])   # Carter
        for f in rp.FIELDS:
            self.assertNotIn("12620", held[f])   # Dak: 4 / 5 equal the recount
            self.assertNotIn("12616", held[f])   # Brissett


class OneChangeFails(unittest.TestCase):
    """Removing, adding or swapping one ID, editing one record or one input: the check must fail."""
    def setUp(self):
        self.d = Path(tempfile.mkdtemp(prefix="rp1307_"))
        for p in (INPUTS, MANIFEST, JS):
            shutil.copy(p, self.d / p.name)
        self.inputs, self.manifest, self.js = (self.d / p.name for p in (INPUTS, MANIFEST, JS))
        inputs = json.loads(INPUTS.read_text())
        held = {x["player_id"] for f in rp.FIELDS for x in json.loads(MANIFEST.read_text())["held"][f]}
        self.outsider = next(r[0] for r in inputs["rows"] if r[0] not in held)   # a real 2025 player, not held

    def tearDown(self):
        shutil.rmtree(self.d)

    def fails(self):
        return bool(rp.check(self.inputs, self.manifest, self.js))

    def edit_js(self, fn):
        t = self.js.read_text()
        self.js.write_text(fn(t))

    def test_clean_copy_passes(self):
        self.assertFalse(self.fails())

    def test_removing_one_id_fails(self):
        for f in rp.FIELDS:
            first = js_sets(JS.read_text())[f][0]
            self.setUp()
            self.edit_js(lambda t: t.replace(f + ": new Set([\n      \"" + first + "\", ", f + ": new Set([\n      ", 1))
            self.assertNotIn(first, js_sets(self.js.read_text())[f])
            self.assertTrue(self.fails(), f)

    def test_adding_one_id_fails(self):
        self.edit_js(lambda t: t.replace("pos_ppg_rank: new Set([\n", "pos_ppg_rank: new Set([\n      \"" + self.outsider + "\",\n", 1))
        self.assertTrue(self.fails())

    def test_swapping_one_id_fails(self):
        first = js_sets(JS.read_text())["pos_rank"][0]
        self.edit_js(lambda t: t.replace("\"" + first + "\"", "\"" + self.outsider + "\"", 1))
        self.assertEqual(len(js_sets(self.js.read_text())["pos_rank"]), 253)   # same count, wrong member
        self.assertTrue(self.fails())

    def test_moving_one_id_between_fields_fails(self):
        s = js_sets(JS.read_text())
        only_pts = next(i for i in s["pos_rank"] if i not in s["pos_ppg_rank"])
        self.edit_js(lambda t: t.replace("pos_ppg_rank: new Set([\n", "pos_ppg_rank: new Set([\n      \"" + only_pts + "\",\n", 1))
        self.assertTrue(self.fails())

    def test_editing_one_manifest_record_fails(self):
        m = json.loads(self.manifest.read_text())
        m["held"]["pos_ppg_rank"][0]["clean_rank"] += 1
        self.manifest.write_text(rp.manifest_text(m))
        self.assertTrue(any("record differs" in p for p in rp.check(self.inputs, self.manifest, self.js)))

    def test_dropping_one_manifest_record_fails(self):
        m = json.loads(self.manifest.read_text())
        gone = m["held"]["pos_rank"].pop(5)["player_id"]
        self.manifest.write_text(rp.manifest_text(m))
        self.assertIn(f"manifest pos_rank: {gone} missing", rp.check(self.inputs, self.manifest, self.js))

    def test_editing_one_input_fails(self):
        i = json.loads(self.inputs.read_text())
        i["rows"][0][2] += 1   # one stored rank
        self.inputs.write_text(json.dumps(i, indent=0) + "\n")
        self.assertTrue(self.fails())


if __name__ == "__main__":
    unittest.main(verbosity=2)
