#!/usr/bin/env python3
"""Rebuild one season's red-zone, team red-zone and EPA rows under the 0169
rules WITHOUT readers ever seeing an empty or half-rebuilt season.

    python3 pipelines/etl/scripts/players_data_backfill.py stage    --season 2026 --tag t20261011 [--db ups-mfl-db]
    python3 pipelines/etl/scripts/players_data_backfill.py swap     --season 2026 --tag t20261011 --yes
    python3 pipelines/etl/scripts/players_data_backfill.py rollback --season 2026 --tag t20261011 --yes
    python3 pipelines/etl/scripts/players_data_backfill.py cleanup  --season 2026 --tag t20261011 --yes

WHY (Keith 2026-10-10, #1219). The 0169 rules (two-point tries out, sacks not
attempts, team totals per game, EPA = box-score plays) change rows that already
exist, and an upsert can't remove a row the new rules no longer produce. The
first plan — DELETE the season, then re-run the fetchers — would leave every
reader of nfl_player_redzone / nfl_player_epa (player pages, game logs, the
EPA route) looking at an empty, then partly written, season for minutes.

stage   (nothing a reader sees changes)
  1. snapshot: bk_<table>_<tag> = the season's live rows, made in ONE import
     file (D1 runs an import file as one transaction); read back and checked
     row-for-row against the live table; written to --out as JSON + sha256.
  2. compute: the real ETL code (fetch_nflverse_pbp.process_season,
     fetch_nflverse_epa.compute) into a throwaway local SQLite.
  3. load: stg_<table>_<tag> (the live table's own DDL, so the same columns and
     primary key), read back and compared row-for-row with step 2.
  4. validate against independent oracles: the red-zone rows and the team
     totals recomputed from the play-by-play by separate code below; EPA play
     counts against nflverse's published box score (attempts + sacks, carries,
     targets) and EPA against nflverse's published EPA minus two-point tries.
  5. record the fingerprints and the report in bf_meta_<tag>.
swap    ONE import file, all or nothing: guards (stg unchanged since
        validation; live unchanged since the snapshot), then DELETE + INSERT the
        season's redzone and EPA rows from stg and reset + upsert the team
        red-zone columns, then a final guard that live now equals stg. A failed
        guard raises a CHECK violation and D1 rolls the whole file back.
        Afterwards every row is read back and compared with stg; any
        difference runs the rollback.
rollback ONE import file restoring the season from bk_*, then read back and
        compared row-for-row with the snapshot.
cleanup drops the tag's bk_/stg_/bf_ tables once the result is accepted.

nfl_player_weekly_ext.def_targets is NOT staged: it is a new column (NULL
until written) read only by the leaderboard precompute, which is rebuilt after
the swap; the ordinary PFR fetcher fills it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shlex
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE)); sys.path.insert(0, str(HERE.parent))

RZ_TEAM_COLS = ["rz_pass_att", "rz_pass_cmp", "rz_sacks", "rz_carries", "rz_scrambles",
                "i5_carries", "rz_targets", "ez_targets", "ez_targets_i20", "rz_rec"]
RZ_PLAYER_COLS = ["rush_att_i20", "rush_att_i10", "rush_att_i5", "rush_yds_i20", "rush_tds_i20",
                  "targets_i20", "targets_i10", "targets_i5", "targets_ez", "rec_i20", "rec_tds_i20",
                  "pass_att_i20", "pass_tds_i20", "pass_att_ez", "pass_cmp_i20", "sacks_i20"]
EPA_COLS = ["pass_plays", "pass_epa_sum", "pass_cpoe_sum", "pass_cpoe_n", "pass_succ_sum",
            "rush_plays", "rush_epa_sum", "rush_succ_sum", "rec_tgt", "rec_epa_sum", "rec_succ_sum", "through_week"]
# name -> (live table, primary key, the columns this procedure owns)
TABLES = {
    "rz":  ("nfl_player_redzone", ["season", "week", "gsis_id"], RZ_PLAYER_COLS),
    "tw":  ("nfl_team_weekly",    ["season", "week", "team"],    RZ_TEAM_COLS),
    "epa": ("nfl_player_epa",     ["season", "gsis_id"],         EPA_COLS),
}


# ── D1 ────────────────────────────────────────────────────────────────────────
class D1:
    def __init__(self, db: str):
        self.db = db
        self.prefix = shlex.split(os.environ.get("D1_WRANGLER") or "npx --yes wrangler@latest")
        self.cwd = str(REPO / "worker")

    def _run(self, args: list[str]) -> str:
        p = subprocess.run(self.prefix + ["d1", "execute", self.db, "--remote"] + args, cwd=self.cwd,
                           capture_output=True, text=True, env={**os.environ, "WRANGLER_SEND_METRICS": "false"})
        if p.returncode != 0:
            raise D1Error((p.stderr or "") + (p.stdout or "")[-3000:])
        return p.stdout

    def q(self, sql: str) -> list[dict]:
        """One read statement; its rows."""
        out = json.loads(self._run(["--json", "--command", sql]))
        return out[0].get("results", []) if out else []

    def file(self, sql: str) -> None:
        """Run a SQL file as ONE import (D1 commits it all or rolls it all back)."""
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
            f.write(sql)
            path = f.name
        try:
            self._run(["--file", path, "-y"])
        finally:
            os.unlink(path)


class D1Error(RuntimeError):
    pass


def cols_of(d1: D1, table: str) -> list[str]:
    return [r["name"] for r in d1.q(f"SELECT name, hidden FROM pragma_table_xinfo('{table}')") if not r.get("hidden")]


def lit(v) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and v != v:
            return "NULL"
        return repr(v)
    return "'" + str(v).replace("'", "''") + "'"


# ── canonical rows, sha256, in-database fingerprints ─────────────────────────
def canon(rows: list[dict], key: list[str], cols: list[str]) -> list[list]:
    def norm(v):
        if isinstance(v, float):
            return round(v, 4) if v == v else None
        return v
    out = [[norm(r.get(c)) for c in key + cols] for r in rows]
    out.sort(key=lambda r: [str(x) for x in r[:len(key)]])
    return out


def sha(rows: list[list]) -> str:
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def fp_sql(table: str, season: int, key: list[str], cols: list[str]) -> str:
    """An all-integer fingerprint of a season's rows, comparable inside SQL (a
    guard inside the swap; the row-for-row sha256 read-backs are the proof)."""
    parts = ["COUNT(*)"]
    for k in key:
        if k == "season":
            continue
        if k == "week":
            parts.append("COALESCE(SUM(week),0)")
            continue
        parts.append(f"COALESCE(SUM(LENGTH({k})),0)")
        parts.append(f"COALESCE(SUM(CAST(substr({k},4) AS INTEGER) % 1000003),0)")
        parts.append("COALESCE(SUM(" + " + ".join(f"{m}*COALESCE(unicode(substr({k},{i},1)),0)" for i, m in
                                                     ((1, 1), (2, 7), (3, 31), (-1, 127), (-2, 1009), (-3, 9973))) + "),0)")
    for c in cols:
        parts.append(f"COALESCE(SUM(CAST(ROUND(COALESCE({c},0)*10000) AS INTEGER)),0)")
        parts.append(f"SUM({c} IS NULL)")
    def joined(p: list[str]) -> str:   # a BALANCED || tree: D1's import caps expression depth at 100
        if len(p) == 1:
            return p[0]
        m = len(p) // 2
        return "(" + joined(p[:m]) + " || ',' || " + joined(p[m:]) + ")"
    return f"SELECT {joined(parts)} AS fp FROM {table} WHERE season = {int(season)}"


def fingerprint(d1: D1, table: str, season: int, key: list[str], cols: list[str]) -> str:
    return d1.q(fp_sql(table, season, key, cols))[0]["fp"]


def read_rows(d1: D1, table: str, season: int, key: list[str], cols: list[str]) -> list[list]:
    return canon(d1.q(f"SELECT {', '.join(key + cols)} FROM {table} WHERE season = {int(season)}"), key, cols)


# ── compute with the real ETL code ────────────────────────────────────────────
def compute(d1: D1, season: int, pbp_parquet: str | None) -> dict:
    import nflreadpy
    if pbp_parquet:
        import polars as pl
        frame = pl.read_parquet(pbp_parquet)
        nflreadpy.load_pbp = lambda seasons=None: frame
    import fetch_nflverse_pbp as F
    import fetch_nflverse_epa as E
    local = sqlite3.connect(":memory:")
    for t in ("nfl_player_redzone", "nfl_team_weekly"):
        local.execute(d1.q(f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{t}'")[0]["sql"])
    F.ensure_table(local)
    F.process_season(local, season, argparse.Namespace(skip_d1=True, skip_local=False),
                     do_redzone=True, do_fg=False, do_punts=False, do_team=False)
    local.row_factory = sqlite3.Row
    rz = [dict(r) for r in local.execute("SELECT * FROM nfl_player_redzone WHERE season = ?", (season,))]
    tw = [dict(r) for r in local.execute("SELECT * FROM nfl_team_weekly WHERE season = ?", (season,))]
    epa = [dict(zip(E.COLS, r)) for r in E.compute([season])]
    return {"rz": rz, "tw": tw, "epa": epa}


# ── independent oracles (separate code from the ETL) ──────────────────────────
def oracle_redzone(season: int, pbp_parquet: str | None) -> tuple[dict, dict]:
    import polars as pl
    import nflreadpy
    df = pl.read_parquet(pbp_parquet) if pbp_parquet else nflreadpy.load_pbp([season])
    if not isinstance(df, pl.DataFrame):
        df = pl.from_pandas(df)
    df = df.filter(pl.col("season_type").is_in(["REG", "POST"]) & pl.col("play_type").is_in(["run", "pass"])
                   & pl.col("yardline_100").is_not_null() & (pl.col("two_point_attempt").fill_null(0) != 1))
    yl = pl.col("yardline_100").cast(pl.Int64, strict=False)
    one = lambda c: pl.col(c).fill_null(0).cast(pl.Float64) == 1   # noqa: E731
    run, pas = pl.col("play_type") == "run", pl.col("play_type") == "pass"
    sack = one("sack")
    ez = pas & ~sack & pl.col("air_yards").is_not_null() & (pl.col("air_yards").cast(pl.Float64).cast(pl.Int64) >= yl)
    ok = lambda c: pl.col(c).is_not_null() & (pl.col(c).cast(pl.Utf8).str.strip_chars() != "") & (pl.col(c).cast(pl.Utf8).str.to_lowercase() != "nan")  # noqa: E731
    i = lambda e: e.cast(pl.Int64)   # noqa: E731
    rush = df.filter(run & ok("rusher_player_id")).group_by(["week", "rusher_player_id"]).agg(
        i((yl <= 20)).sum().alias("rush_att_i20"), i((yl <= 10)).sum().alias("rush_att_i10"), i((yl <= 5)).sum().alias("rush_att_i5"),
        pl.when(yl <= 20).then(pl.col("yards_gained").fill_null(0)).otherwise(0).sum().cast(pl.Int64).alias("rush_yds_i20"),
        i((yl <= 20) & one("rush_touchdown")).sum().alias("rush_tds_i20")).rename({"rusher_player_id": "gsis_id"})
    pasr = df.filter(pas & ok("passer_player_id")).group_by(["week", "passer_player_id"]).agg(
        i((yl <= 20) & ~sack).sum().alias("pass_att_i20"), i((yl <= 20) & ~sack & one("complete_pass")).sum().alias("pass_cmp_i20"),
        i((yl <= 20) & ~sack & one("pass_touchdown")).sum().alias("pass_tds_i20"), i((yl <= 20) & sack).sum().alias("sacks_i20"),
        i(ez).sum().alias("pass_att_ez")).rename({"passer_player_id": "gsis_id"})
    rec = df.filter(pas & ok("receiver_player_id")).group_by(["week", "receiver_player_id"]).agg(
        i(yl <= 20).sum().alias("targets_i20"), i(yl <= 10).sum().alias("targets_i10"), i(yl <= 5).sum().alias("targets_i5"),
        i(ez).sum().alias("targets_ez"), i((yl <= 20) & one("complete_pass")).sum().alias("rec_i20"),
        i((yl <= 20) & one("complete_pass") & one("pass_touchdown")).sum().alias("rec_tds_i20")).rename({"receiver_player_id": "gsis_id"})
    players: dict = {}
    for part in (rush, pasr, rec):
        for r in part.iter_rows(named=True):
            d = players.setdefault((int(r["week"]), str(r["gsis_id"]).strip()), {c: 0 for c in RZ_PLAYER_COLS})
            for c in RZ_PLAYER_COLS:
                if c in r and r[c] is not None:
                    d[c] += int(r[c])
    has_rcv = ok("receiver_player_id")
    team = df.filter(pl.col("posteam").is_not_null() & (pl.col("posteam") != "")).group_by(["week", "posteam"]).agg(
        i(pas & (yl <= 20) & ~sack).sum().alias("rz_pass_att"), i(pas & (yl <= 20) & ~sack & one("complete_pass")).sum().alias("rz_pass_cmp"),
        i(pas & (yl <= 20) & sack).sum().alias("rz_sacks"), i(run & (yl <= 20)).sum().alias("rz_carries"),
        i(run & (yl <= 20) & one("qb_scramble")).sum().alias("rz_scrambles"), i(run & (yl <= 5)).sum().alias("i5_carries"),
        i(pas & (yl <= 20) & has_rcv).sum().alias("rz_targets"), i(ez & has_rcv).sum().alias("ez_targets"),
        i(ez & has_rcv & (yl <= 20)).sum().alias("ez_targets_i20"), i(pas & (yl <= 20) & has_rcv & one("complete_pass")).sum().alias("rz_rec"))
    teams = {(int(r["week"]), r["posteam"]): {c: int(r[c]) for c in RZ_TEAM_COLS} for r in team.iter_rows(named=True)}
    return players, teams


def oracle_epa(season: int, through: int, pbp_parquet: str | None, stats_parquet: str | None) -> dict:
    """nflverse's published weekly player stats: plays and EPA per player through `through`."""
    import polars as pl
    import nflreadpy
    ps = pl.read_parquet(stats_parquet) if stats_parquet else nflreadpy.load_player_stats([season], summary_level="week")
    if not isinstance(ps, pl.DataFrame):
        ps = pl.from_pandas(ps)
    ps = ps.filter((pl.col("season_type") == "REG") & (pl.col("week") <= through))
    box = {r["player_id"]: r for r in ps.group_by("player_id").agg(
        [pl.col(c).fill_null(0).sum() for c in ("attempts", "sacks_suffered", "carries", "targets", "passing_epa", "rushing_epa", "receiving_epa")]
    ).iter_rows(named=True)}
    df = pl.read_parquet(pbp_parquet) if pbp_parquet else nflreadpy.load_pbp([season])
    if not isinstance(df, pl.DataFrame):
        df = pl.from_pandas(df)
    df = df.filter((pl.col("season_type") == "REG") & (pl.col("week") <= through) & (pl.col("two_point_attempt").fill_null(0) == 1))
    def tries(types, idcol, ecol):
        g = df.filter(pl.col("play_type").is_in(types) & pl.col(ecol).is_not_null() & pl.col(idcol).is_not_null())
        return {r[idcol]: r["e"] for r in g.group_by(idcol).agg(pl.col(ecol).sum().alias("e")).iter_rows(named=True)}
    return {"box": box, "pass_tries": tries(["pass", "qb_spike"], "passer_player_id", "qb_epa"),
            "rush_tries": tries(["run", "qb_kneel"], "rusher_player_id", "epa"), "rec_tries": tries(["pass"], "receiver_player_id", "epa")}


def validate(computed: dict, season: int, pbp_parquet: str | None, stats_parquet: str | None) -> dict:
    rep: dict = {}
    players, teams = oracle_redzone(season, pbp_parquet)
    got = {(int(r["week"]), r["gsis_id"]): r for r in computed["rz"]}
    bad = [k for k in set(got) | set(players)
           if k not in got or k not in players or any(int(got[k][c] or 0) != players[k][c] for c in RZ_PLAYER_COLS)]
    rep["redzone_vs_play_by_play"] = {"rows": len(got), "oracle_rows": len(players), "mismatches": len(bad), "examples": [list(k) for k in sorted(bad)[:5]]}
    gt = {(int(r["week"]), r["team"]): r for r in computed["tw"] if r.get("rz_pass_att") is not None}
    badt = [k for k in set(gt) | set(teams) if k not in gt or k not in teams or any(int(gt[k][c]) != teams[k][c] for c in RZ_TEAM_COLS)]
    rep["team_redzone_vs_play_by_play"] = {"team_games": len(gt), "oracle": len(teams), "mismatches": len(badt), "examples": [list(k) for k in sorted(badt)[:5]]}
    through = max((r["through_week"] or 0) for r in computed["epa"]) if computed["epa"] else 0
    o = oracle_epa(season, through, pbp_parquet, stats_parquet)
    box = o["box"]
    for role, n, e, fn, pub, tries in (
        ("pass", "pass_plays", "pass_epa_sum", lambda b: b["attempts"] + b["sacks_suffered"], "passing_epa", o["pass_tries"]),
        ("rush", "rush_plays", "rush_epa_sum", lambda b: b["carries"], "rushing_epa", o["rush_tries"]),
        ("rec", "rec_tgt", "rec_epa_sum", lambda b: b["targets"], "receiving_epa", o["rec_tries"])):
        rows = [r for r in computed["epa"] if r[n]]
        have = {r["gsis_id"] for r in rows}
        bn = [r["gsis_id"] for r in rows if r["gsis_id"] not in box or r[n] != fn(box[r["gsis_id"]])]
        bn += [g for g, b in box.items() if fn(b) > 0 and g not in have]   # a box-score player with no EPA row
        be = [r["gsis_id"] for r in rows if r["gsis_id"] in box and abs(r[e] + (tries.get(r["gsis_id"]) or 0) - box[r["gsis_id"]][pub]) > 0.01]
        rep[f"epa_{role}_vs_nflverse_box_score"] = {"players": len(rows), "play_count_mismatches": len(bn), "epa_mismatches": len(be),
                                                   "examples": sorted(set(bn + be))[:5]}
    rep["epa_through_week"] = through
    rep["ok"] = all(v.get("mismatches", 0) == 0 and v.get("play_count_mismatches", 0) == 0 and v.get("epa_mismatches", 0) == 0
                    for v in rep.values() if isinstance(v, dict))
    return rep


# ── the procedure ─────────────────────────────────────────────────────────────
def names(tag: str) -> dict:
    if not tag.replace("_", "").isalnum():
        raise SystemExit("--tag must be letters, digits and _")
    return {k: {"bk": f"bk_{k}_{tag}", "stg": f"stg_{k}_{tag}"} for k in TABLES} | {"meta": f"bf_meta_{tag}", "guard": f"bf_guard_{tag}"}


def guard(n: dict, cond: str) -> str:
    """A statement that violates CHECK (ok = 1) — rolling the whole import back — unless cond holds."""
    return f"INSERT INTO {n['guard']} (ok) SELECT 0 WHERE NOT ({cond});"


def require_0169(d1: D1) -> None:
    rz, tw = cols_of(d1, "nfl_player_redzone"), cols_of(d1, "nfl_team_weekly")
    missing = [c for c in ("pass_cmp_i20", "sacks_i20") if c not in rz] + [c for c in RZ_TEAM_COLS if c not in tw] + \
              [c for c in ("through_week",) if c not in cols_of(d1, "nfl_player_epa")]
    if missing:
        raise SystemExit("migration 0169 is not applied (missing " + ", ".join(missing) + "): apply it first")


def cmd_stage(a, d1: D1) -> None:
    require_0169(d1)
    n, out = names(a.tag), Path(a.out); out.mkdir(parents=True, exist_ok=True)
    if d1.q(f"SELECT name FROM sqlite_master WHERE name = '{n['meta']}'"):
        raise SystemExit(f"tag {a.tag} already staged: cleanup it or use a new tag")
    # 1. snapshot, one transaction
    sql = [f"CREATE TABLE {n['guard']} (ok INTEGER CHECK (ok = 1));",
           f"CREATE TABLE {n['meta']} (k TEXT PRIMARY KEY, v TEXT);"]
    for k, (t, key, _) in TABLES.items():
        sql.append(f"CREATE TABLE {n[k]['bk']} AS SELECT * FROM {t} WHERE season = {a.season};")
    d1.file("\n".join(sql))
    report = {"season": a.season, "tag": a.tag, "db": a.db, "snapshot": {}, "staged": {}}
    for k, (t, key, cols) in TABLES.items():
        allc = cols_of(d1, n[k]["bk"])
        rest = [c for c in allc if c not in key]
        live, bk = read_rows(d1, t, a.season, key, rest), read_rows(d1, n[k]["bk"], a.season, key, rest)
        if live != bk:
            raise SystemExit(f"{t} changed while the snapshot was taken: rerun stage with a new tag")
        full = d1.q(f"SELECT * FROM {n[k]['bk']}")
        (out / f"{n[k]['bk']}.json").write_text(json.dumps(full))
        report["snapshot"][k] = {"table": t, "backup": n[k]["bk"], "rows": len(bk), "sha256_all_columns": sha(bk),
                                 "sha256": sha(read_rows(d1, n[k]["bk"], a.season, key, cols)),
                                 "fp": fingerprint(d1, n[k]["bk"], a.season, key, cols), "all_columns": allc,
                                 "file": str(out / f"{n[k]['bk']}.json"),
                                 "file_sha256": hashlib.sha256((out / f"{n[k]['bk']}.json").read_bytes()).hexdigest()}
    # 2. compute with the ETL
    comp = compute(d1, a.season, a.pbp_parquet)
    # 3. stage tables with the live DDL, then load
    sql = []
    for k, (t, key, cols) in TABLES.items():
        ddl = d1.q(f"SELECT sql FROM sqlite_master WHERE type='table' AND name='{t}'")[0]["sql"]
        sql.append(ddl.replace(t, n[k]["stg"], 1).rstrip(";") + ";")
    d1.file("\n".join(sql))
    for k, (t, key, cols) in TABLES.items():
        rows = comp[k] if k != "tw" else [r for r in comp["tw"] if r.get("rz_pass_att") is not None]
        load_cols = key + cols
        for i in range(0, len(rows), 150):
            chunk = rows[i:i + 150]
            d1.file(f"INSERT INTO {n[k]['stg']} ({', '.join(load_cols)}) VALUES\n" +
                    ",\n".join("(" + ", ".join(lit(r.get(c)) for c in load_cols) + ")" for r in chunk) + ";")
        back, want = read_rows(d1, n[k]["stg"], a.season, key, cols), canon(rows, key, cols)
        if back != want:
            raise SystemExit(f"{n[k]['stg']} read back differs from the computed rows")
        report["staged"][k] = {"table": n[k]["stg"], "rows": len(back), "sha256": sha(back),
                               "fp": fingerprint(d1, n[k]["stg"], a.season, key, cols)}
    # 4. validate
    report["validation"] = validate(comp, a.season, a.pbp_parquet, a.stats_parquet)
    # what changes for readers, old -> new
    report["diff"] = {}
    for k, (t, key, cols) in TABLES.items():
        old = {tuple(r[:len(key)]): r for r in read_rows(d1, n[k]["bk"], a.season, key, cols)}
        new = {tuple(r[:len(key)]): r for r in read_rows(d1, n[k]["stg"], a.season, key, cols)}
        changed = [kk for kk in set(old) & set(new) if old[kk] != new[kk]]
        report["diff"][k] = {"removed": len(set(old) - set(new)), "added": len(set(new) - set(old)), "changed": len(changed),
                             "unchanged": len(set(old) & set(new)) - len(changed),
                             "removed_examples": sorted([list(x) for x in set(old) - set(new)])[:5]}
    d1.file(f"INSERT INTO {n['meta']} (k, v) VALUES ('report', {lit(json.dumps(report))});")
    (out / f"stage_report_{a.tag}.json").write_text(json.dumps(report, indent=1))
    print(json.dumps({k: report[k] for k in ("snapshot", "staged", "validation", "diff")}, indent=1))
    if not report["validation"]["ok"]:
        raise SystemExit("VALIDATION FAILED: nothing swapped. Report: " + str(out / f"stage_report_{a.tag}.json"))
    print(f"\nstaged and validated: swap with  swap --season {a.season} --tag {a.tag} --yes")


def load_report(d1: D1, n: dict) -> dict:
    r = d1.q(f"SELECT v FROM {n['meta']} WHERE k = 'report'")
    if not r:
        raise SystemExit("no stage report for this tag")
    return json.loads(r[0]["v"])


def swap_sql(n: dict, season: int, rep: dict, live_cols: dict) -> str:
    s = [f"DELETE FROM {n['guard']};"]
    for k, (t, key, cols) in TABLES.items():
        s.append(guard(n, f"({fp_sql(n[k]['stg'], season, key, cols)}) = {lit(rep['staged'][k]['fp'])}"))
        s.append(guard(n, f"({fp_sql(t, season, key, cols)}) = {lit(rep['snapshot'][k]['fp'])}"))
    for k in ("rz", "epa"):
        t, key, cols = TABLES[k]
        c = [x for x in live_cols[k] if x in set(key + cols)]
        s.append(f"DELETE FROM {t} WHERE season = {season};")
        s.append(f"INSERT INTO {t} ({', '.join(c)}) SELECT {', '.join(c)} FROM {n[k]['stg']};")
    s.append(f"UPDATE nfl_team_weekly SET {', '.join(c + ' = NULL' for c in RZ_TEAM_COLS)} WHERE season = {season};")
    s.append(f"INSERT INTO nfl_team_weekly (season, week, team, {', '.join(RZ_TEAM_COLS)}) "
             f"SELECT season, week, team, {', '.join(RZ_TEAM_COLS)} FROM {n['tw']['stg']} WHERE true "
             f"ON CONFLICT(season, week, team) DO UPDATE SET {', '.join(f'{c} = excluded.{c}' for c in RZ_TEAM_COLS)};")
    for k, (t, key, cols) in TABLES.items():   # the result, inside the same transaction
        if k == "tw":
            cond = f"({fp_sql(t, season, key, cols).replace('WHERE season', 'WHERE rz_pass_att IS NOT NULL AND season')}) = {lit(rep['staged'][k]['fp'])}"
        else:
            cond = f"({fp_sql(t, season, key, cols)}) = {lit(rep['staged'][k]['fp'])}"
        s.append(guard(n, cond))
    return "\n".join(s)


def rollback_sql(n: dict, season: int, rep: dict, live_cols: dict) -> str:
    s = [f"DELETE FROM {n['guard']};"]
    for k, (t, key, cols) in TABLES.items():
        s.append(guard(n, f"({fp_sql(n[k]['bk'], season, key, cols)}) = {lit(rep['snapshot'][k]['fp'])}"))
    for k, (t, key, cols) in TABLES.items():
        c = [x for x in live_cols[k] if x in set(rep["snapshot"][k]["all_columns"])]
        s.append(f"DELETE FROM {t} WHERE season = {season};")
        s.append(f"INSERT INTO {t} ({', '.join(c)}) SELECT {', '.join(c)} FROM {n[k]['bk']};")
    return "\n".join(s)


def check_equal(d1: D1, n: dict, season: int, which: str, rep: dict | None = None) -> list[str]:
    """Tables whose live season differs row-for-row from stg (the owned columns)
    or from bk (every column the snapshot holds)."""
    bad = []
    for k, (t, key, cols) in TABLES.items():
        src = n[k][which]
        if which == "bk":
            cols = [c for c in rep["snapshot"][k]["all_columns"] if c not in key]
        live = read_rows(d1, t, season, key, cols)
        if k == "tw" and which == "stg":
            live = [r for r in live if r[len(key)] is not None]
        if live != read_rows(d1, src, season, key, cols):
            bad.append(t)
    return bad


def cmd_swap(a, d1: D1) -> None:
    n = names(a.tag)
    rep = load_report(d1, n)
    if not rep.get("validation", {}).get("ok"):
        raise SystemExit("the stage report is not validated: nothing swapped")
    if not a.yes:
        raise SystemExit("swap changes what readers see: pass --yes")
    live_cols = {k: cols_of(d1, t) for k, (t, _, _) in TABLES.items()}
    sql = swap_sql(n, a.season, rep, live_cols)
    before = {k: fingerprint(d1, t, a.season, key, cols) for k, (t, key, cols) in TABLES.items()}
    if a.fail_after_writes:     # rehearsal only: prove the import rolls back
        sql += f"\nINSERT INTO {n['guard']} (ok) VALUES (0);"
    try:
        d1.file(sql)
    except D1Error as e:
        msg = str(e)
        after = {k: fingerprint(d1, t, a.season, key, cols) for k, (t, key, cols) in TABLES.items()}
        why = [ln.strip() for ln in msg.splitlines() if "ERROR" in ln or "constraint" in ln.lower() or "SQLITE" in ln]
        print(json.dumps({"swap": "REFUSED / ROLLED BACK by D1 - nothing changed",
                          "live_unchanged_by_this_run": before == after,
                          "live_matched_snapshot_before_run": all(before[k] == rep["snapshot"][k]["fp"] for k in TABLES),
                          "error": why[:4] or [msg[-600:]]}, indent=1))
        raise SystemExit(2)
    bad = check_equal(d1, n, a.season, "stg")
    if bad:
        print(f"post-check FAILED for {bad}: restoring the snapshot", file=sys.stderr)
        d1.file(rollback_sql(n, a.season, rep, live_cols))
        raise SystemExit(3)
    print(json.dumps({"swap": "ok", "live_now_equals_staged": True,
                      "rows": {k: rep["staged"][k]["rows"] for k in TABLES},
                      "sha256": {k: rep["staged"][k]["sha256"] for k in TABLES}}, indent=1))
    print("next: POST /admin/leaderboard-precompute/build {\"season\": %d, \"force\": true}" % a.season)


def cmd_rollback(a, d1: D1) -> None:
    n = names(a.tag)
    rep = load_report(d1, n)
    if not a.yes:
        raise SystemExit("rollback changes what readers see: pass --yes")
    live_cols = {k: cols_of(d1, t) for k, (t, _, _) in TABLES.items()}
    d1.file(rollback_sql(n, a.season, rep, live_cols))
    bad = check_equal(d1, n, a.season, "bk", rep)
    shas = {k: sha(read_rows(d1, t, a.season, key, [c for c in rep["snapshot"][k]["all_columns"] if c not in key]))
            for k, (t, key, cols) in TABLES.items()}
    ok = not bad and all(shas[k] == rep["snapshot"][k]["sha256_all_columns"] for k in TABLES)
    print(json.dumps({"rollback": "ok" if ok else "MISMATCH", "differs": bad, "sha256": shas}, indent=1))
    if not ok:
        raise SystemExit(4)
    print("next: POST /admin/leaderboard-precompute/build {\"season\": %d, \"force\": true}" % a.season)


def cmd_cleanup(a, d1: D1) -> None:
    n = names(a.tag)
    if not a.yes:
        raise SystemExit("cleanup drops the backup: pass --yes")
    d1.file("\n".join([f"DROP TABLE IF EXISTS {n[k][w]};" for k in TABLES for w in ("bk", "stg")] +
                      [f"DROP TABLE IF EXISTS {n['meta']};", f"DROP TABLE IF EXISTS {n['guard']};"]))
    print("dropped", a.tag)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["stage", "swap", "rollback", "cleanup"])
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--tag", required=True)
    ap.add_argument("--db", required=True, help="the D1 database; no default, so a rehearsal can never touch production by accident")
    ap.add_argument("--out", default=str(REPO / "worker" / ".tmp" / "players_backfill"))
    ap.add_argument("--pbp-parquet", default=None, help="use this play-by-play file instead of downloading")
    ap.add_argument("--stats-parquet", default=None, help="use this nflverse weekly player-stats file instead of downloading")
    ap.add_argument("--yes", action="store_true")
    ap.add_argument("--fail-after-writes", action="store_true", help=argparse.SUPPRESS)
    a = ap.parse_args()
    d1 = D1(a.db)
    {"stage": cmd_stage, "swap": cmd_swap, "rollback": cmd_rollback, "cleanup": cmd_cleanup}[a.step](a, d1)


if __name__ == "__main__":
    main()
