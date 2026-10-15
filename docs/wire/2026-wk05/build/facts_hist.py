"""History facts appended to facts.json: TE 3-game spans, 20+ target games, start regression."""
import json, collections, statistics as S, polars as pl
from upsscore import ups
import hist_players as HP          # builds first5 + team-game calendars (1999-2026)
F = json.load(open("facts.json"))
ph = pl.read_parquet("ps_hist.parquet"); p26 = pl.read_parquet("ps_2026.parquet")
allp = pl.concat([ph.select(p26.columns), p26], how="vertical_relaxed").filter(pl.col("season_type") == "REG")
# Bowers: best 3-consecutive-game span per TE player-season
by = collections.defaultdict(list)
for r in allp.filter(pl.col("position") == "TE").iter_rows(named=True): by[(r["season"], r["player_display_name"])].append(r)
best = {}
for k, g in by.items():
    g.sort(key=lambda r: r["week"])
    for i in range(len(g) - 2):
        v = round(sum(ups(x, "TE") for x in g[i:i + 3]), 1)
        if v > best.get(k, (0,))[0]: best[k] = (v, [x["week"] for x in g[i:i + 3]])
me = best[(2026, "Brock Bowers")]
F["players"]["bowers_span"] = dict(pts=me[0], weeks=me[1], rank=1 + sum(1 for v in best.values() if v[0] > me[0]), n=len(best),
                                   rank2026=1 + sum(1 for k, v in best.items() if k[0] == 2026 and v[0] > me[0]),
                                   next2026=sorted(((v[0], k[1]) for k, v in best.items() if k[0] == 2026), reverse=True)[1])
# 20+ target games (seasons with target data: 1999-2002, 2009-2026)
reg = allp.filter(~pl.col("season").is_between(2003, 2008))
big = reg.filter(pl.col("targets") >= 20)
games = collections.defaultdict(dict)
for r in reg.filter(pl.col("player_id").is_in(big["player_id"].unique().implode())).iter_rows(named=True): games[(r["season"], r["player_id"])][r["week"]] = r
nxt = []
for r in big.filter(pl.col("season") < 2026).iter_rows(named=True):
    wk = games[(r["season"], r["player_id"])]; after = [w for w in sorted(wk) if w > r["week"]]
    if after: nxt.append(wk[after[0]]["targets"])
F["players"]["targets"] = dict(n20=big.height, n20_pre=big.filter(pl.col("season") < 2026).height, more_than_24=[(r["season"], r["week"], r["player_display_name"], r["targets"]) for r in big.filter(pl.col("targets") > 24).iter_rows(named=True)],
                               at24plus=big.filter(pl.col("targets") >= 24).height, next_n=len(nxt), next_mean=round(S.mean(nxt), 1), next_median=S.median(nxt),
                               y2026=[(r["week"], r["player_display_name"], r["targets"]) for r in big.filter(pl.col("season") == 2026).sort("targets", descending=True).iter_rows(named=True)])
# regression of the top-25 first-five starts (pre-2026)
F5 = json.load(open("first5.json")); out = {}
pg = collections.defaultdict(dict)
for r in allp.filter(pl.col("position").is_in(["WR", "RB"]) & (pl.col("season") < 2026)).iter_rows(named=True): pg[(r["season"], r["player_id"])][r["week"]] = r
for pos in ("WR", "RB"):
    top = sorted([r for r in F5 if r["pos"] == pos and r["season"] < 2026], key=lambda r: -r["pts"])[:25]; rat = []
    for r in top:
        rest = [w for w in HP.TG[(r["season"], r["team"])][5:] if w in pg[(r["season"], r["pid"])]]
        if rest: rat.append((sum(ups(pg[(r["season"], r["pid"])][w], pos) for w in rest) / len(rest)) / (r["pts"] / 5))
    out[pos] = dict(n=len(rat), mean=round(100 * S.mean(rat)), median=round(100 * S.median(rat)))
F["players"]["regression"] = out
json.dump(F, open("facts.json", "w"), indent=1, default=str)
print(F["players"]["bowers_span"], F["players"]["targets"], out)
