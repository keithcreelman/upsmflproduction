import json, os, unittest
import numpy as np
from _support import *
from punter_models import ups_points

class TierBoundaries(unittest.TestCase):
    def test_any_tiers(self):
        avg = np.array([44.99, 45.0, 49.99, 50.0, 59.99, 60.0])
        self.assertEqual(ups_points(np.zeros(6), avg, np.zeros(6), np.ones(6)).tolist(), [0, 1, 1, 3, 3, 5])
    def test_inside20_blocked_and_no_punts(self):
        self.assertEqual(float(ups_points(np.array(3.0), np.array(46.0), np.array(1.0), np.array(5))), 4 * 3 + 1 - 2)
        self.assertEqual(float(ups_points(np.array(0.0), np.array(60.0), np.array(0.0), np.array(0))), 0.0)   # no punts -> no average tier

class RuleFiles(unittest.TestCase):
    path = os.path.join(P, "pn_rules_by_season.json")
    @unittest.skipUnless(os.path.exists(path), "SKIPPED: run scripts/punter/extract_pn_rules.py")
    def test_core_punter_rules_constant_2012_2026(self):
        r = json.load(open(self.path))
        core = lambda y: sorted((x["event"], x["range"], x["points"]) for x in r[str(y)] if x["event"] in ("PI", "ANY", "HBP"))
        for y in range(2013, 2027):
            self.assertEqual(core(y), core(2012), "core punter rules changed in %d" % y)
        self.assertIn(("PI", "0-20", "*4"), core(2012))
        self.assertNotEqual(core(2011), core(2012), "2011 uses different rules and must stay out of the model window")

class Reconstruction(unittest.TestCase):
    @need("scoring_audit_all_rows.csv")
    def test_exact_agreement_gate(self):
        import polars as pl
        d = pl.read_csv(os.path.join(P, "scoring_audit_all_rows.csv"), infer_schema_length=50000).filter(pl.col("in_mfl") & pl.col("in_pbp") & (pl.col("season") >= 2012))
        exact = (d["diff"].abs() < 0.01).mean(); within1 = (d["diff"].abs() <= 1.01).mean()
        self.assertGreaterEqual(exact, 0.90); self.assertGreaterEqual(within1, 0.97)
        for s in range(2012, 2027):
            x = d.filter(pl.col("season") == s)
            self.assertGreaterEqual((x["diff"].abs() < 0.01).mean(), 0.80, "season %d reconstruction materially wrong" % s)
if __name__ == "__main__": unittest.main()
