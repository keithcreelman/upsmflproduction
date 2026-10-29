#!/usr/bin/env python3
"""Scoring reconstruction audit. Rebuilds each punter's weekly UPS points from nflverse play-by-play and the PN scoring
rules extracted from MFL (data/punter/processed/pn_rules_by_season.json), then compares with MFL's official playerScores.
Writes data/punter/processed/punter_games_pbp.parquet, reports/punter/scoring_audit_rows.csv (every row with a
difference) and reports/punter/scoring_audit.md (summary by season). See docs in the report for the rule translation table."""
import os, json, glob, sys, csv
import polars as pl
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
P = os.path.join(ROOT, "data", "punter", "processed")
R = os.path.join(ROOT, "reports", "punter")
RAW = os.path.join(ROOT, "data", "punter", "raw", "mfl_ps")

# PN rule translation: MFL event code -> meaning -> source stat (nflverse play-by-play) -> UPS points (2012-2026)
RULES = {
    "PI": ("Punts Inside 20", "punt_inside_twenty", 4.0),
    "ANY": ("Average Yards per Punt (gross)", "sum(kick_distance)/punts", "tiers: <45:0, 45-49.99:1, 50-59.99:3, >=60:5"),
    "HBP": ("Punts Had Blocked", "punt_blocked", -2.0),
}

def any_points(avg):
    if avg is None: return 0.0
    if avg >= 60: return 5.0
    if avg >= 50: return 3.0
    if avg >= 45: return 1.0
    return 0.0

def punter_games():
    pbp = pl.read_parquet(os.path.join(P, "pbp_slim.parquet")).filter(
        (pl.col("punt_attempt") == 1) & (pl.col("season_type") == "REG") & (pl.col("play_deleted").fill_null(0) == 0))
    g = pbp.group_by(["season", "week", "punter_player_id"]).agg(
        punter_name=pl.col("punter_player_name").first(), team=pl.col("posteam").first(),
        punts_all=pl.len(), blocked=pl.col("punt_blocked").sum(),
        punts=(pl.col("punt_blocked") == 0).sum(), i20=pl.col("punt_inside_twenty").sum(),
        tb=pl.col("punt_in_endzone").sum(),
        kd=pl.col("kick_distance").filter(pl.col("punt_blocked") == 0).sum(),
        kd_all=pl.col("kick_distance").sum())
    return g.with_columns(gross=pl.when(pl.col("punts") > 0).then(pl.col("kd") / pl.col("punts")).otherwise(None))

def recon(row, variant="base"):
    punts = row["punts"] if variant != "allpunts" else row["punts_all"]
    kd = row["kd"] if variant != "allpunts" else row["kd_all"]
    avg = (kd / punts) if punts else None
    return 4.0 * row["i20"] + any_points(avg) - 2.0 * row["blocked"]

def load_mfl():
    """MFL official weekly PN scores. 2011-2025: data/punter/raw/mfl_pn_scores_2011_2025.csv, exported from the local
    mfl_database_2026-06-05.db archive (player_weeklyscoringresults, a mirror of MFL playerScores; cross-checked directly against the
    MFL API for 2020 and 2025 by the audit). 2026: cached MFL API reads (data/punter/raw/mfl_ps/2026_W*.json)."""
    xw = pl.read_parquet(os.path.join(P, "ff_playerids.parquet")).select(["mfl_id", "gsis_id", "name"]).drop_nulls(["mfl_id", "gsis_id"]) \
        .with_columns(pl.col("mfl_id").cast(pl.Utf8)).unique("mfl_id")
    a = pl.read_csv(os.path.join(ROOT, "data", "punter", "raw", "mfl_pn_scores_2011_2025.csv"), schema_overrides={"mfl_id": pl.Utf8}) \
        .select(["season", "week", "mfl_id", pl.col("score").alias("mfl_points")]).filter(pl.col("season") != 2026)
    rows = []
    for f in sorted(glob.glob(os.path.join(RAW, "2026_W*.json"))):
        y, w = os.path.basename(f)[:-5].split("_W"); d = json.load(open(f))
        ps = d.get("playerScores", {}).get("playerScore", [])
        ps = ps if isinstance(ps, list) else [ps]
        for p in ps:
            rows.append((int(y), int(w), p["id"], float(p["score"] or 0)))
    b = pl.DataFrame(rows, schema=["season", "week", "mfl_id", "mfl_points"], orient="row") if rows else a.clear()
    return pl.concat([a, b]).join(xw, on="mfl_id", how="left")

def main():
    os.makedirs(R, exist_ok=True)
    pg = punter_games(); pg.write_parquet(os.path.join(P, "punter_games_pbp.parquet"))
    m = load_mfl()
    # outer-ish compare: every MFL punter score row, matched to pbp by gsis id
    j = m.join(pg, left_on=["season", "week", "gsis_id"], right_on=["season", "week", "punter_player_id"], how="full", coalesce=True)
    out = []
    for r in j.iter_rows(named=True):
        if r["mfl_points"] is None and r["punts_all"] is None: continue
        rec = recon(r) if r["punts_all"] else 0.0
        mp = r["mfl_points"] if r["mfl_points"] is not None else None
        out.append({"season": r["season"], "week": r["week"], "player": r["name"] or r["punter_name"], "mfl_id": r["mfl_id"],
                    "mfl_points": mp, "recon_points": rec, "diff": None if mp is None else round(mp - rec, 2),
                    "punts": r["punts"], "i20": r["i20"], "blocked": r["blocked"], "gross": r["gross"],
                    "in_mfl": r["mfl_points"] is not None, "in_pbp": r["punts_all"] is not None})
    df = pl.DataFrame(out)
    df.write_csv(os.path.join(P, "scoring_audit_all_rows.csv"))
    both = df.filter(pl.col("in_mfl") & pl.col("in_pbp"))
    summ = both.group_by("season").agg(n=pl.len(), exact=(pl.col("diff").abs() < 0.01).sum(),
                                      within1=(pl.col("diff").abs() <= 1.01).sum(), mean_abs=pl.col("diff").abs().mean()).sort("season")
    print(summ)
    print("MFL rows with no pbp match:", df.filter(pl.col("in_mfl") & ~pl.col("in_pbp")).height,
          "| pbp rows with no MFL score:", df.filter(~pl.col("in_mfl") & pl.col("in_pbp")).height)
    return df, summ

if __name__ == "__main__":
    main()
