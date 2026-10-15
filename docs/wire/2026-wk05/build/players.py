"""Player-week table: UPS points (MFL weeklyResults) joined to NFL usage (nflverse), 2026 wks 1-5."""
import polars as pl, json, collections
from core import *
ids = pl.read_parquet("ids.parquet").with_columns(pl.col("mfl_id").cast(pl.Utf8))
idm = {r["mfl_id"]: r for r in ids.iter_rows(named=True) if r["mfl_id"]}
ps = pl.read_parquet("ps_2026.parquet")
sn = pl.read_parquet("snaps_2026.parquet")
inj = pl.read_parquet("inj_2026.parquet")
rw = pl.read_parquet("rw_2026.parquet")
PS = {(r["player_id"], r["week"]): r for r in ps.iter_rows(named=True)}
SN = {(r["pfr_player_id"], r["week"]): r for r in sn.iter_rows(named=True)}
INJ = {(r["gsis_id"], r["week"]): r for r in inj.iter_rows(named=True)}
RW = {(r["gsis_id"], r["week"]): r for r in rw.iter_rows(named=True)}
# NFL team games played (byes) per week
sched = pl.read_parquet("sched_2026.parquet").filter(pl.col("game_type") == "REG")
TEAMGAME = {(r["home_team"], r["week"]) for r in sched.iter_rows(named=True)} | {(r["away_team"], r["week"]) for r in sched.iter_rows(named=True)}
# UPS: who rostered/started whom each week
UPS = collections.defaultdict(dict)   # pid -> week -> {fid, score, status}
for (w, f), t in TW.items():
    for p in t["players"]:
        UPS[p["pid"]][w] = {"fid": f, "score": p["score"], "status": p["status"]}
rows = []
for pid, wk in UPS.items():
    m = idm.get(pid, {}); g = m.get("gsis_id"); pfr = m.get("pfr_id")
    for w in WEEKS:
        u = wk.get(w); s = PS.get((g, w)) if g else None; n = SN.get((pfr, w)) if pfr else None
        i = INJ.get((g, w)) if g else None; r = RW.get((g, w)) if g else None
        nflteam = (r or {}).get("team") or pteam(pid)
        rows.append(dict(pid=pid, name=pname(pid), pos=ppos(pid), side=side(ppos(pid)), week=w, gsis=g,
                         fid=(u or {}).get("fid"), ups=(u or {}).get("score"), status=(u or {}).get("status"),
                         nflteam=nflteam, teamgame=(nflteam, w) in TEAMGAME,
                         rstatus=(r or {}).get("status"), inj=(i or {}).get("report_status"), injbody=(i or {}).get("report_primary_injury"),
                         snaps=(n or {}).get("offense_snaps") if side(ppos(pid)) == "O" else (n or {}).get("defense_snaps"),
                         snappct=(n or {}).get("offense_pct") if side(ppos(pid)) == "O" else (n or {}).get("defense_pct"),
                         **{k: (s or {}).get(k) for k in ("targets", "receptions", "receiving_yards", "receiving_tds", "target_share",
                                                          "air_yards_share", "wopr", "carries", "rushing_yards", "rushing_tds",
                                                          "attempts", "passing_yards", "passing_tds", "receiving_air_yards",
                                                          "def_tackles_solo", "def_sacks", "def_qb_hits", "def_tackles_for_loss")}))
json.dump(rows, open("player_weeks.json", "w"))
nomap = {r["pid"] for r in rows if not r["gsis"]}
print("player-weeks:", len(rows), "players:", len(UPS), "unmapped:", len(nomap), sorted({(pname(p), ppos(p)) for p in nomap})[:25])
