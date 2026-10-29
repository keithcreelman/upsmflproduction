import glob, json, hashlib, unittest, numpy as np
from _support import *
class Repro(unittest.TestCase):
    def test_simulation_is_deterministic_given_seed(self):
        from punter_models import ups_points
        rng1, rng2 = np.random.default_rng(3), np.random.default_rng(3)
        a = ups_points(rng1.binomial(5, .4, 100), 46 + rng1.normal(0, 2, 100), np.zeros(100), np.full(100, 5))
        b = ups_points(rng2.binomial(5, .4, 100), 46 + rng2.normal(0, 2, 100), np.zeros(100), np.full(100, 5)); self.assertTrue((a == b).all())
    def test_archive_manifests_match_outputs(self):
        ms = glob.glob(os.path.join(ROOT, "data", "punter", "manifests", "projections_*.manifest.json"))
        if not ms: self.skipTest("SKIPPED: no projection archive yet")
        for m in ms:
            man = json.load(open(m)); f = os.path.join(ROOT, "data", "punter", "projections", man["output"])
            self.assertEqual(hashlib.sha256(open(f, "rb").read()).hexdigest()[:16], man["output_sha256_16"], "archived projection was modified: " + man["output"])
            self.assertIn("data_through_game_date", man); self.assertIn("created_utc", man)
    @need("punter_games.parquet", "team_features.parquet")
    def test_same_inputs_same_projection(self):
        import run_backtest
        e1, *_ = run_backtest.project_all(final=False, S=200, year=2021); e2, *_ = run_backtest.project_all(final=False, S=200, year=2021)
        self.assertTrue(np.allclose(e1["mc_mean"], e2["mc_mean"]))
if __name__ == "__main__": unittest.main()
