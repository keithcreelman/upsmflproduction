#!/usr/bin/env python3
"""Grade a published week preview against what actually happened.

WHY (Keith 2026-09-16, item 4): the Week 2 preview ends "We check how these
calls did after week two", so the Week 2 recap has to open with that check:
how the favorites did, whether each owner's score landed inside the range the
preview gave him, what happened to the flip factors, and whether the
injury-watch starters played. A forecast that is never graded is just copy.

INPUT is the preview exactly as published -- site/wire/data/
week_preview_<season>_wk<NN>.json -- never a re-run, so the grade is of the
calls readers saw. OUTCOMES come from D1: src_schedule (head-to-head results),
src_franchise_weekly_score (owner scores), src_weekly (who started, player
points) and nfl_player_snaps (whether a player took a snap at all).

FAIL CLOSED. A week that is not final is refused, never half-graded: every
previewed game needs a result and every ranged owner a score. A player whose
snap count cannot be resolved is "unknown", never "did not play" -- the same
rule as wire_data.did_not_play.

Usage:  python3 preview_grade.py --season 2026 --week 2
"""

import argparse
import io
import json
import os
import sys

import wire_data as D

# Confidence bands for the favorites' record. Named for how the desk talks
# about them, and wide enough that a week of 18 games puts games in each.
BANDS = (("coin flips (50-55%)", 0.50, 0.55), ("leans (55-65%)", 0.55, 0.65), ("favorites (65%+)", 0.65, 1.01))
RANGE_COVERAGE = 0.80          # the preview's likely range is the 10th-90th percentile


def preview_path(season, week):
    return "site/wire/data/week_preview_%d_wk%02d.json" % (int(season), int(week))


def load_preview(season, week):
    """The preview as published, or None when that week never had one.

    Working copy first: the preview is hand-built and committed with the recap
    that carries it, so origin/main can lag the checkout that is being built
    (the trap tracked_data_file sets for hand-built files -- see
    weekly_recap.load_live_forecast)."""
    path = os.path.join(D.REPO, preview_path(season, week))
    if not os.path.exists(path):
        return None
    doc = json.load(io.open(path, encoding="utf-8"))
    if int(doc["season"]) != int(season) or int(doc["week"]) != int(week):
        raise D.DataError("%s is for %s week %s" % (preview_path(season, week), doc["season"], doc["week"]))
    return doc


def featured(preview, n=3):
    """The games the desk featured: biggest combined playoff-odds swing first, one
    game per owner so three segments are not one team's triple-header. Shared with
    weekly_recap so the grade covers exactly the games that were featured."""
    out, used = [], set()
    for g in preview["games"]:
        if g["a"] in used or g["b"] in used:
            continue
        out.append(g)
        used |= {g["a"], g["b"]}
        if len(out) == n:
            break
    return out


def outcomes(preview):
    """Everything the grade needs from D1, or DataError if the week is not final."""
    season, week = int(preview["season"]), int(preview["week"])
    results = dict(((str(r["franchise_id"]).zfill(4), str(r["opponent_franchise_id"]).zfill(4)), r) for r in D.d1(
        "SELECT franchise_id, opponent_franchise_id, result, team_score, opponent_score FROM src_schedule "
        "WHERE season = %d AND week = %d AND is_playoff = 0 AND team_score IS NOT NULL "
        "AND opponent_score IS NOT NULL" % (season, week)))
    missing = ["%s-%s" % (g["a"], g["b"]) for g in preview["games"] if (g["a"], g["b"]) not in results]
    if missing:
        raise D.DataError("week %d is not final: %d of %d previewed games have no result in src_schedule (%s)"
                          % (week, len(missing), len(preview["games"]), ", ".join(missing[:6])))
    scores = dict((str(r["franchise_id"]).zfill(4), float(r["team_score"])) for r in D.d1(
        "SELECT franchise_id, team_score FROM src_franchise_weekly_score WHERE season = %d AND week = %d "
        "AND team_score IS NOT NULL" % (season, week)))
    ranged = set(f for g in preview["games"] for f in g["scoreRange"])
    unscored = sorted(ranged - set(scores))
    if unscored:
        raise D.DataError("week %d is not final: no team score for %s" % (week, ", ".join(unscored)))

    pids = sorted(set([g["flip"]["pid"] for g in preview["games"] if g.get("flip")] +
                      [x["pid"] for x in preview.get("injuryWatch") or []]))
    players = {}
    if pids:
        weekly = dict((str(r["player_id"]), r) for r in D.d1(
            "SELECT player_id, roster_franchise_id, status, score FROM src_weekly WHERE season = %d "
            "AND week = %d AND player_id IN (%s)" % (season, week, D._quoted(pids))))
        snaps_loaded = D.d1("SELECT COUNT(*) AS n FROM nfl_player_snaps WHERE season = %d AND week = %d"
                            % (season, week))[0]["n"] > 0
        snaps = dict((str(r["mfl_player_id"]), r) for r in D.d1(
            "SELECT cx.mfl_player_id, COALESCE(SUM(COALESCE(s.off_snaps,0) + COALESCE(s.def_snaps,0) "
            "+ COALESCE(s.st_snaps,0)), 0) AS snaps, COUNT(s.pfr_id) AS rows_ FROM player_id_crosswalk cx "
            "LEFT JOIN nfl_player_snaps s ON s.pfr_id = cx.pfr_id AND s.season = %d AND s.week = %d "
            "WHERE cx.mfl_player_id IN (%s) AND cx.pfr_id IS NOT NULL GROUP BY cx.mfl_player_id"
            % (season, week, ", ".join(str(int(p)) for p in pids))))
        for pid in pids:
            w, sn = weekly.get(pid) or {}, snaps.get(pid)
            if not snaps_loaded or sn is None:
                played = None                 # snaps not loaded yet, or he cannot be resolved
            else:
                played = int(sn["snaps"] or 0) > 0
            players[pid] = {"status": w.get("status"), "score": None if w.get("score") is None else float(w["score"]),
                            "played": played}
    return {"results": results, "scores": scores, "players": players}


def grade(preview, out):
    """The scorecard. Pure: `out` is outcomes(preview), or a hand-built test double."""
    games = []
    for g in preview["games"]:
        fav, dog, p = g["favorite"], g["underdog"], float(g["favoriteP"])
        r = out["results"][(fav, dog)]
        res = (r["result"] or "").upper()
        games.append({"favorite": fav, "underdog": dog, "favoriteP": p,
                      "favScore": float(r["team_score"]), "dogScore": float(r["opponent_score"]),
                      "outcome": 1.0 if res == "W" else 0.0 if res == "L" else 0.5})
    n = len(games)
    fav_w = sum(1 for x in games if x["outcome"] == 1.0)
    fav_t = sum(1 for x in games if x["outcome"] == 0.5)
    summary = {"games": n, "favWins": fav_w, "favLosses": n - fav_w - fav_t, "ties": fav_t,
               "expectedFavWins": round(sum(x["favoriteP"] for x in games), 2),
               # Brier: mean squared miss of the favorite's chance. 0.25 is what calling
               # every game 50-50 scores; lower is better.
               "brier": round(sum((x["favoriteP"] - x["outcome"]) ** 2 for x in games) / n, 4) if n else None,
               "brierCoinFlip": 0.25, "bands": []}
    for name, lo, hi in BANDS:
        inb = [x for x in games if lo <= x["favoriteP"] < hi]
        summary["bands"].append({"band": name, "games": len(inb),
                                 "favWins": sum(1 for x in inb if x["outcome"] == 1.0),
                                 "expected": round(sum(x["favoriteP"] for x in inb), 2)})

    ranges, seen = [], set()
    for g in preview["games"]:
        for fid, rg in g["scoreRange"].items():
            if fid in seen:
                continue
            seen.add(fid)
            actual = out["scores"][fid]
            where = "below" if actual < rg["p10"] else "above" if actual > rg["p90"] else "inside"
            ranges.append({"fid": fid, "proj": rg["proj"], "p10": rg["p10"], "p90": rg["p90"],
                           "actual": actual, "where": where, "miss": round(actual - rg["proj"], 1)})
    inside = sum(1 for x in ranges if x["where"] == "inside")
    range_summary = {"owners": len(ranges), "inside": inside,
                     "expectedInside": round(RANGE_COVERAGE * len(ranges), 1),
                     "below": [x["fid"] for x in ranges if x["where"] == "below"],
                     "above": [x["fid"] for x in ranges if x["where"] == "above"],
                     "meanAbsMiss": round(sum(abs(x["miss"]) for x in ranges) / len(ranges), 1) if ranges else None}

    feats = []
    for g in featured(preview):
        fav, dog = g["favorite"], g["underdog"]
        r = out["results"][(fav, dog)]
        fl = g.get("flip") or {}
        pl = out["players"].get(fl.get("pid"), {}) if fl else {}
        feats.append({"favorite": fav, "underdog": dog, "favoriteP": g["favoriteP"],
                      "favWon": (r["result"] or "").upper() == "W", "tie": (r["result"] or "").upper() not in ("W", "L"),
                      "favScore": float(r["team_score"]), "dogScore": float(r["opponent_score"]),
                      "flip": None if not fl else {
                          "player": fl["player"], "owner": fl["owner"], "proj": fl["proj"],
                          "statusAtCutoff": fl.get("status"), "started": pl.get("status") == "starter",
                          "score": pl.get("score"), "played": pl.get("played")}})

    injuries = []
    for x in preview.get("injuryWatch") or []:
        pl = out["players"].get(x["pid"], {})
        injuries.append({"player": x["player"], "owner": x["owner"], "tag": x["status"], "proj": x["proj"],
                         "started": pl.get("status") == "starter", "played": pl.get("played"),
                         "score": pl.get("score")})
    return {"season": preview["season"], "week": preview["week"], "cutoff": preview["generatedAtUtc"],
            "games": games, "summary": summary, "ranges": ranges, "rangeSummary": range_summary,
            "featured": feats, "injuries": injuries}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    a = ap.parse_args()
    pv = load_preview(a.season, a.week)
    if pv is None:
        print("no preview was published for %d week %d (%s)" % (a.season, a.week, preview_path(a.season, a.week)),
              file=sys.stderr)
        return 1
    try:
        g = grade(pv, outcomes(pv))
    except D.DataError as exc:
        print("preview_grade REFUSED: %s" % exc, file=sys.stderr)
        return 1
    print(json.dumps(g, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
