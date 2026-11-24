import unittest, numpy as np, pandas as pd
from _support import *
class ByeInData(unittest.TestCase):
    @need("team_features.parquet")
    def test_no_rows_for_bye_weeks_and_lag_counts_games(self):
        d = pd.read_parquet(os.path.join(P, "team_features.parquet")); d = d[(d.season == 2024) & d.punts.notna()]
        per_team = d.groupby("team").size()
        self.assertTrue((per_team == 17).all(), "every team plays 17 games in 2024; byes must not create rows")
        t = d[d.team == "DEN"].sort_values("week"); self.assertEqual(t["o_n"].tolist()[:3], [40, 40, 40])   # history already capped by prior seasons
if __name__ == "__main__": unittest.main()
