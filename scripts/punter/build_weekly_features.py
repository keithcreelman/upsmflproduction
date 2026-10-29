#!/usr/bin/env python3
"""Point-in-time feature builder. For every team-game it computes features from games the team (and its opponent)
played STRICTLY BEFORE this game (exponentially weighted, shrunk toward the league mean as of that date), plus
this game's pregame context (home/road, spread, implied total, game total, roof, weather, altitude, coach id).
Output: data/punter/processed/team_features.parquet. Cutoff integrity is enforced by tests/punter/test_point_in_time_features.py:
a feature for game i is a function of rows with an earlier (season, week) only.

Known limits, documented in the data dictionary: nflverse spread_line/total_line are the lines nflverse stored for the game
(closing-style), so 'pregame Vegas' is a close proxy for what was knowable at kickoff, not the Wednesday/Sunday-morning number;
temp/wind are observed game-time weather used as a stand-in for the forecast; the starting QB is not used (not known pregame)."""
import os, numpy as np, pandas as pd
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
P = os.path.join(ROOT, "data", "punter", "processed")
FRANCHISE = {"OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "WSH": "WAS", "JAC": "JAX"}
ALTITUDE_FT = {"DEN": 5280}
H = 6.0            # half-life in games
XSEASON = 0.65     # extra weight multiplier for games from an earlier season
W0 = 2.0           # pseudo-games of shrinkage toward the league mean

OFF = ["epa", "sr", "early_epa", "pass_rate", "sack_rate", "third_rate", "third_ytg", "to_rate", "tod_rate", "punt_rate",
       "fg_rate", "td_rate", "tno_rate", "ppd", "go_rate", "plays", "drives", "ypd", "start_yl", "punt_los", "i20_rate", "seconds_per_play"]

def fr(t): return FRANCHISE.get(t, t)

def load():
    g = pd.read_parquet(os.path.join(P, "team_games.parquet"))
    g["team"] = g["posteam"].map(fr); g["opp"] = g["opp"].map(fr)
    g["date"] = pd.to_datetime(g["gameday"])
    g = g.sort_values(["date", "game_id", "team"]).reset_index(drop=True)
    g["sack_rate"] = g["sacks"] / g["dropbacks"].replace(0, np.nan)
    g["third_rate"] = g["third_conv"] / g["third_att"].replace(0, np.nan)
    g["third_ytg"] = g["third_ytg"]
    g["to_rate"] = g["tos"] / g["drives"]; g["tod_rate"] = g["tods"] / g["drives"]
    g["punt_rate"] = g["punts"] / g["drives"]; g["fg_rate"] = g["fgs"] / g["drives"]
    g["td_rate"] = g["tds"] / g["drives"]; g["tno_rate"] = g["tno"] / g["drives"]
    g["ppd"] = g["pf"] / g["drives"]; g["ypd"] = g["yds"] / g["drives"]
    g["go_rate"] = g["fourth_go"] / (g["fourth_go"] + g["fourth_punt"] + g["fourth_fg"]).replace(0, np.nan)
    g["i20_rate"] = np.where(g["punts"] > 0, g["punt_i20"] / g["punts"].replace(0, np.nan), np.nan)
    g["punt_los"] = g["punt_los"].where(g["punts"] > 0)
    g["seconds_per_play"] = np.nan  # not available point-in-time without game clock aggregation; left empty by design
    g["sec_idx"] = g["season"] * 100 + g["week"]
    return g

def ew_features(g, cols, prefix, key, sel):
    """Return a frame (index = g.index) of pre-game exponentially weighted means of `cols` over this key's earlier games."""
    out = pd.DataFrame(index=g.index, columns=[prefix + c for c in cols], dtype=float)
    out[prefix + "n"] = 0.0
    lg_sum = {c: 0.0 for c in cols}; lg_cnt = {c: 0 for c in cols}
    # league mean as of each week: cumulative over strictly earlier sec_idx
    by_week = g.groupby("sec_idx")[cols].agg(["sum", "count"])
    league_before = {}
    s = {c: 0.0 for c in cols}; n = {c: 0 for c in cols}
    for idx, row in by_week.iterrows():
        league_before[idx] = {c: (s[c] / n[c] if n[c] else np.nan) for c in cols}
        for c in cols:
            s[c] += row[(c, "sum")]; n[c] += row[(c, "count")]
    for t, sub in g.groupby(key):
        sub = sub.sort_values(["date", "game_id"])
        idxs = sub.index.to_list(); vals = sub[cols].to_numpy(float); seas = sub["season"].to_numpy(); secs = sub["sec_idx"].to_numpy()
        valid = ~np.isnan(vals).all(axis=1)          # scheduled-but-unplayed games carry no stats and are not history
        cv = np.cumsum(valid)
        for i, ix in enumerate(idxs):
            if i == 0 or cv[i - 1] == 0:
                for j, c in enumerate(cols): out.at[ix, prefix + c] = league_before[secs[i]][c]
                continue
            lag = (cv[i - 1] - cv[:i]).astype(float)
            w = 0.5 ** (lag / H) * np.where(seas[:i] < seas[i], XSEASON, 1.0) * valid[:i]
            for j, c in enumerate(cols):
                v = vals[:i, j]; ok = (~np.isnan(v)) & valid[:i]
                lm = league_before[secs[i]][c]
                if ok.any():
                    out.at[ix, prefix + c] = ((w[ok] * v[ok]).sum() + W0 * lm) / (w[ok].sum() + W0) if not np.isnan(lm) else (w[ok] * v[ok]).sum() / w[ok].sum()
                else:
                    out.at[ix, prefix + c] = lm
            out.at[ix, prefix + "n"] = min(i, 40)
    return out

def main():
    g = load()
    # defense-allowed table: what the opponent's offense did against this team in each game
    key = g[["game_id", "team"] + OFF].rename(columns={"team": "opp"})
    d = g[["game_id", "team", "opp"]].merge(key, on=["game_id", "opp"], how="left")
    dallowed = g[["game_id", "team", "season", "week", "sec_idx", "date"]].merge(
        key.rename(columns={"opp": "team"}), on=["game_id", "team"], how="left")
    # NOTE: key renamed so that rows are (game, team) with the opponent offense numbers, i.e. defense-allowed for 'team'
    dallowed = g[["game_id", "team", "opp", "season", "week", "sec_idx", "date"]].merge(
        g[["game_id", "team"] + OFF].rename(columns={"team": "opp"}), on=["game_id", "opp"], how="left")
    dallowed = dallowed.reset_index(drop=True)
    f_off = ew_features(g, OFF, "o_", "team", None)
    f_def = ew_features(dallowed, OFF, "d_", "team", None)
    f_off.index = g.index; f_def.index = dallowed.index
    base = g[["game_id", "season", "week", "date", "team", "opp", "home", "spread", "total_line", "implied", "roof", "temp", "wind",
              "surface", "stadium", "coach", "overtime", "punts", "punt_i20", "punt_blk", "punt_kd", "punt_tb", "punt_los", "drives", "plays",
              "fourth_go", "tos", "tods", "pf", "pa"]].copy()
    base = pd.concat([base, f_off], axis=1)
    base = base.merge(pd.concat([dallowed[["game_id", "team"]], f_def], axis=1), on=["game_id", "team"], how="left")
    # opponent's own offense / defense features (what the opponent brings), for the matchup
    opp_cols = [c for c in base.columns if c.startswith(("o_", "d_"))]
    opp = base[["game_id", "team"] + opp_cols].rename(columns={"team": "opp", **{c: "opp_" + c for c in opp_cols}})
    base = base.merge(opp, on=["game_id", "opp"], how="left")
    base["altitude"] = base["stadium"].map(lambda s: 0)  # filled by stadium table below
    base["altitude"] = np.where((base["home"] == 1) & (base["team"] == "DEN"), 5280, 0)
    base["altitude"] = base.groupby("game_id")["altitude"].transform("max")
    base["dome"] = base["roof"].isin(["dome", "closed"]).astype(int)
    base["fav"] = base["spread"]  # + = favored
    base["total_scaled"] = base["total_line"]
    base.to_parquet(os.path.join(P, "team_features.parquet"))
    print(base.shape)

if __name__ == "__main__":
    main()
