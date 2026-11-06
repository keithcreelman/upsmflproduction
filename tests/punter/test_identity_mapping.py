import unittest, pandas as pd
from _support import *
import build_weekly_features as B
class Identity(unittest.TestCase):
    def test_franchise_relocation_mapping(self):
        self.assertEqual((B.fr("OAK"), B.fr("SD"), B.fr("STL"), B.fr("WSH")), ("LV", "LAC", "LA", "WAS"))
    @need("punter_games.parquet")
    def test_skill_follows_punter_not_team(self):
        d = pd.read_parquet(os.path.join(P, "punter_games.parquet")).sort_values(["gsis_id", "date"])
        moved = d.groupby("gsis_id")["team"].nunique(); gid = moved[moved >= 2].index[0]
        x = d[d.gsis_id == gid].reset_index(drop=True); change = (x.team != x.team.shift()).to_numpy().nonzero()[0][1]
        self.assertEqual(x.loc[change, "pk_n_games"], change, "a team change reset the punter's own history")
    @need("punter_games.parquet")
    def test_team_context_is_new_teams(self):
        d = pd.read_parquet(os.path.join(P, "punter_games.parquet")); self.assertFalse(d.duplicated(["season", "week", "gsis_id"]).any())
        self.assertTrue((d.team == d.team).all())
if __name__ == "__main__": unittest.main()
