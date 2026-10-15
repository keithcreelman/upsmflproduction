import polars as pl, json, collections
from upsscore import ups
ph = pl.read_parquet("ps_hist.parquet").filter(pl.col("season_type") == "REG")
p26 = pl.read_parquet("ps_2026.parquet").filter(pl.col("season_type") == "REG")
sh = pl.read_parquet("sched_hist.parquet").filter(pl.col("game_type") == "REG")
s26 = pl.read_parquet("sched_2026.parquet").filter(pl.col("game_type") == "REG")
def team_games(sched):
    tg = collections.defaultdict(list)   # (season, team) -> [weeks in order]
    for r in sched.iter_rows(named=True):
        for t in (r["home_team"], r["away_team"]): tg[(r["season"], t)].append(r["week"])
    return {k: sorted(v) for k, v in tg.items()}
TG = team_games(sh); TG.update(team_games(s26))
def first_n(df, n=5):
    """Per player-season: totals over his TEAM's first n games (missed games count zero)."""
    by = collections.defaultdict(dict)
    for r in df.iter_rows(named=True):
        by[(r["season"], r["player_id"], r["team"])][r["week"]] = r
    out = []
    for (s, pid, team), wk in by.items():
        weeks = TG.get((s, team), [])[:n]
        if len(weeks) < n: continue
        g = [wk[w] for w in weeks if w in wk]
        if not g: continue
        pos = g[0]["position"]
        out.append(dict(season=s, pid=pid, name=g[0]["player_display_name"], team=team, pos=pos, games=len(g),
                        pts=round(sum(ups(x, pos) for x in g), 1), tgt=sum(x["targets"] or 0 for x in g),
                        rec=sum(x["receptions"] or 0 for x in g), recyd=sum(x["receiving_yards"] or 0 for x in g),
                        rectd=sum(x["receiving_tds"] or 0 for x in g), car=sum(x["carries"] or 0 for x in g),
                        rushyd=sum(x["rushing_yards"] or 0 for x in g), rushtd=sum(x["rushing_tds"] or 0 for x in g),
                        ts=sum((x["target_share"] or 0) for x in g) / len(g), ays=sum((x["air_yards_share"] or 0) for x in g) / len(g)))
    return out
allp = pl.concat([ph.select(p26.columns), p26], how="vertical_relaxed")
F5 = first_n(allp, 5)
json.dump(F5, open("first5.json", "w"))
def rank_of(name, season, pos, key="pts", pool=None, label=""):
    pool = pool or [r for r in F5 if r["pos"] == pos]
    me = next(r for r in pool if r["name"] == name and r["season"] == season)
    better = sorted([r for r in pool if r[key] > me[key]], key=lambda r: -r[key])
    print("%s %s %d: %s=%s  rank %d of %d %s-seasons (1999-2026)" % (label, name, season, key, me[key], len(better) + 1, len(pool), pos))
    for r in sorted(pool, key=lambda r: -r[key])[:max(6, len(better) + 2)][:12]:
        print("     %d %-24s %-4s pts %6.1f  g%d tgt %3d rec %3d yds %4d td %d | car %3d ryd %4d rtd %d ts %.2f" % (
            r["season"], r["name"], r["team"], r["pts"], r["games"], r["tgt"], r["rec"], r["recyd"], r["rectd"], r["car"], r["rushyd"], r["rushtd"], r["ts"]))
    return me
rank_of("Jaxon Smith-Njigba", 2026, "WR", label="[JSN first 5 team games, UPS-2026 rules]")
rank_of("Jaxon Smith-Njigba", 2026, "WR", key="recyd", label="[JSN rec yds]")
rank_of("Jahmyr Gibbs", 2026, "RB", label="[Gibbs first 5 team games]")
