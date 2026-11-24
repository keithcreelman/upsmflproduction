import unittest, numpy as np, pandas as pd
from _support import *
import build_weekly_features as B

def frame(vals, seasons=None, weeks=None):
    n = len(vals)
    return pd.DataFrame({"team": ["AAA"] * n, "game_id": ["g%d" % i for i in range(n)], "season": seasons or [2020] * n, "week": weeks or list(range(1, n + 1)),
                         "date": pd.to_datetime("2020-09-01") + pd.to_timedelta(np.arange(n) * 7, unit="D"), "x": vals,
                         "sec_idx": [(s * 100 + w) for s, w in zip(seasons or [2020] * n, weeks or list(range(1, n + 1)))]})

class Cutoff(unittest.TestCase):
    def test_feature_ignores_current_and_future_outcomes(self):
        a = frame([1.0, 2.0, 3.0, 4.0, 5.0, 6.0]); b = a.copy(); b.loc[3:, "x"] = [999.0, -999.0, 50.0]   # change game 3 (the game itself) and later games
        fa = B.ew_features(a, ["x"], "o_", "team", None); fb = B.ew_features(b, ["x"], "o_", "team", None)
        self.assertTrue(np.allclose(fa["o_x"].iloc[:4], fb["o_x"].iloc[:4], equal_nan=True), "feature for game i depends on game i or later")
        self.assertFalse(np.allclose(fa["o_x"].iloc[4], fb["o_x"].iloc[4]))
    def test_unplayed_games_are_not_history(self):
        a = frame([1.0, 2.0, 3.0, np.nan, 5.0]); f = B.ew_features(a, ["x"], "o_", "team", None)
        c = frame([1.0, 2.0, 3.0, 5.0]); g = B.ew_features(c, ["x"], "o_", "team", None)
        self.assertAlmostEqual(f["o_x"].iloc[4], g["o_x"].iloc[3], places=9)

class Bye(unittest.TestCase):
    def test_bye_week_is_not_a_zero_game(self):
        no_bye = frame([4.0, 5.0, 6.0, 7.0], weeks=[1, 2, 3, 4]); bye = frame([4.0, 5.0, 6.0, 7.0], weeks=[1, 2, 4, 5])   # team idle in week 3
        f1 = B.ew_features(no_bye, ["x"], "o_", "team", None); f2 = B.ew_features(bye, ["x"], "o_", "team", None)
        self.assertTrue(np.allclose(f1["o_x"].iloc[1:], f2["o_x"].iloc[1:]), "a bye changed the weighting")
        self.assertGreater(f2["o_x"].iloc[3], 4.5, "bye treated as a zero-performance game")

class RealData(unittest.TestCase):
    @need("punter_games.parquet")
    def test_punter_state_counts_only_earlier_games(self):
        d = pd.read_parquet(os.path.join(P, "punter_games.parquet")).sort_values(["gsis_id", "date", "game_id"])
        k = d.groupby("gsis_id").cumcount()
        self.assertTrue((d["pk_n_games"].to_numpy() == k.to_numpy()).all())
    @need("punter_games.parquet")
    def test_first_game_has_no_history(self):
        d = pd.read_parquet(os.path.join(P, "punter_games.parquet")); first = d[d.pk_n_games == 0]
        self.assertTrue(first["pk_ups_last4"].isna().all() and first["pk_ups_ew"].isna().all())
    def test_locked_season_guard(self):
        import run_backtest
        with self.assertRaises(AssertionError): run_backtest.project_all(final=False, S=10, year=2025)
if __name__ == "__main__": unittest.main()

class RealDataCutoffProof(unittest.TestCase):
    """Scramble every 2025+ outcome in team_games, rebuild features, and require 2012-2024 features to be byte-identical."""
    @need("team_games.parquet")
    def test_scrambling_future_outcomes_changes_no_past_feature(self):
        import tempfile, shutil, numpy as np, pandas as pd, build_weekly_features as BW
        base = os.path.join(P, "team_features.parquet")
        tg = pd.read_parquet(os.path.join(P, "team_games.parquet")); fut = tg.season >= 2025
        rng = np.random.default_rng(0)
        for c in ["epa", "sr", "punts", "drives", "tos", "pf", "fgs", "tds", "plays", "third_conv", "sacks", "yds"]:
            if c in tg.columns: tg.loc[fut, c] = rng.permutation(tg.loc[fut, c].to_numpy())
        tmp = tempfile.mkdtemp(); tg.to_parquet(os.path.join(tmp, "team_games.parquet")); old = BW.P; BW.P = tmp
        try:
            BW.main(); new = pd.read_parquet(os.path.join(tmp, "team_features.parquet"))
        finally:
            BW.P = old; shutil.rmtree(tmp, ignore_errors=True)
        ref = pd.read_parquet(base); key = ["game_id", "team"]
        cols = [c for c in ref.columns if c.startswith(("o_", "d_", "opp_o_", "opp_d_"))]
        a = ref[ref.season <= 2024].sort_values(key)[key + cols].reset_index(drop=True); b = new[new.season <= 2024].sort_values(key)[key + cols].reset_index(drop=True)
        self.assertTrue(np.allclose(a[cols].to_numpy(float), b[cols].to_numpy(float), equal_nan=True), "a pre-2025 feature depends on 2025+ outcomes")
