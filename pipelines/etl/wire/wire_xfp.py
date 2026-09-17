#!/usr/bin/env python3
"""Expected Fantasy Points (xFP) for one week, in UPS scoring, for the Wire.

WHY (Keith 2026-09-17): "incorporate Expected Fantasy Points (take into
consideration the targets received, where they're received etc.) into the
dialogue ... players that scored more than expected or less than expected."

SOURCE: nflverse ffopportunity (nflreadpy.load_ff_opportunity, weekly). Its model
prices every target, carry and pass attempt from where it happened -- air yards,
field position, down and distance -- and publishes the EXPECTED catches, yards,
touchdowns, first downs and two-pointers for each player-week. Those expected
components are re-scored with this league's rules by the same function the
Stats Workbench uses (pipelines/etl/scripts/build_nfl_xfp.py score_offense), so
Wire xFP and Workbench xFP are one number.

OVER/UNDER EXPECTED = the player's official MFL score minus his xFP. MFL's score
also carries what the model does not price (fumbles, sacks, the 50+ yard TD
bonus), which lands in the over/under -- the same convention as the Workbench.
Offense only: ffopportunity has no defensive model.

The pull is saved to site/wire/data/xfp_<season>_wk<NN>.json so a pack build is
reproducible and never re-downloads mid-build. nflverse can revise a week, so
`fetch` records when it was pulled; re-run it to refresh.

Usage:  python3 wire_xfp.py fetch --season 2026 --week 1
"""

import argparse
import io
import json
import os
import sys
from datetime import datetime, timezone

import wire_data as D

sys.path.insert(0, os.path.join(D.REPO, "pipelines", "etl", "scripts"))
from build_nfl_xfp import score_offense  # noqa: E402

OFFENSE = ("QB", "RB", "WR", "TE")


def _rel(season, week):
    return "site/wire/data/xfp_%d_wk%02d.json" % (int(season), int(week))


def fetch(season, week):
    import nflreadpy as nfl
    df = nfl.load_ff_opportunity(seasons=[int(season)], stat_type="weekly")
    rows = [r for r in df.to_dicts() if r.get("week") is not None and int(float(r["week"])) == int(week)]
    if not rows:
        raise D.DataError("nflverse ffopportunity has no %d week %d rows yet" % (season, week))
    xwalk = dict((str(r["gsis_id"]), str(r["mfl_player_id"])) for r in D.d1(
        "SELECT gsis_id, mfl_player_id FROM player_id_crosswalk WHERE gsis_id IS NOT NULL"))
    # Rookies are often missing from the crosswalk (Jadarian Price, Carnell Tate and
    # Jeremiyah Love in 2026 week 1). Fall back to a name + position + NFL team match,
    # used only when exactly one MFL player fits.
    from ev_projections import norm_name, MFL_TO_NFL_TEAM
    by_key = {}
    for r in D.d1("SELECT player_id, name, position, nfl_team FROM src_players WHERE season = %d "
                  "AND position IN ('QB','RB','WR','TE')" % int(season)):
        team = MFL_TO_NFL_TEAM.get(r["nfl_team"] or "", r["nfl_team"] or "")
        by_key.setdefault((norm_name(r["name"]), r["position"], team), []).append(str(r["player_id"]))
    taken = set(xwalk.values())
    f = lambda r, k: float(r.get(k) or 0.0)
    players = {}
    for r in rows:
        pos = (r.get("position") or "").upper()
        if pos not in OFFENSE or not r.get("player_id"):
            continue
        xfp = score_offense(lambda n: f(r, n + "_exp"), pos)[0]
        mfl, how = xwalk.get(str(r["player_id"])), "crosswalk"
        if mfl is None:
            hits = [m for m in by_key.get((norm_name(r.get("full_name")), pos, r.get("posteam") or ""), [])
                    if m not in taken]
            mfl, how = (hits[0], "name+position+team") if len(hits) == 1 else (None, None)
        players[str(r["player_id"])] = {
            "gsis": str(r["player_id"]), "mfl": mfl, "matchedBy": how, "name": r.get("full_name"),
            "pos": pos, "team": r.get("posteam"), "game": r.get("game_id"),
            "xfp": round(xfp, 2),
            "targets": f(r, "rec_attempt"), "airYards": f(r, "rec_air_yards"), "carries": f(r, "rush_attempt"),
            "passAtt": f(r, "pass_attempt"), "passAirYards": f(r, "pass_air_yards"),
            "receptions": f(r, "receptions"), "receptionsExp": f(r, "receptions_exp"),
            "yards": f(r, "total_yards_gained"), "yardsExp": f(r, "total_yards_gained_exp"),
            "tds": f(r, "total_touchdown"), "tdsExp": f(r, "total_touchdown_exp"),
        }
    doc = {"season": int(season), "week": int(week), "fetchedAtUtc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "source": "nflverse ffopportunity weekly (nflreadpy.load_ff_opportunity), expected components re-scored "
                     "with UPS rules by build_nfl_xfp.score_offense",
           "players": players}
    with io.open(os.path.join(D.REPO, _rel(season, week)), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write("\n")
    return doc


def load(season, week):
    path = os.path.join(D.REPO, _rel(season, week))
    if not os.path.exists(path):
        return None
    doc = json.load(io.open(path, encoding="utf-8"))
    if int(doc["season"]) != int(season) or int(doc["week"]) != int(week):
        raise D.DataError("%s is for %s week %s" % (_rel(season, week), doc["season"], doc["week"]))
    return doc


def usage_phrase(p):
    """'9 targets, 124 air yards' / '23 carries, 3 targets' / '29 passes, 262 air yards, 10 carries'."""
    bits = []
    if p["pos"] == "QB" and p["passAtt"]:
        bits.append("%d passes" % p["passAtt"])
        if p["passAirYards"]:
            bits.append("%d air yards" % p["passAirYards"])
    if p["carries"] and p["pos"] in ("RB", "QB"):
        bits.append("%d carr%s" % (p["carries"], "y" if p["carries"] == 1 else "ies"))
    if p["targets"]:
        bits.append("%d target%s" % (p["targets"], "" if p["targets"] == 1 else "s"))
        if p["pos"] != "QB" and p["airYards"] and p["pos"] != "RB":
            bits.append("%d air yards" % p["airYards"])
    if p["carries"] and p["pos"] in ("WR", "TE"):
        bits.append("%d carr%s" % (p["carries"], "y" if p["carries"] == 1 else "ies"))
    return ", ".join(bits) or "no targets or carries"


def starters_vs_expected(season, week, n=5):
    """UPS starters on offense with an xFP, and the top n over and under it.

    Returns {"over": [...], "under": [...], "byMfl": {mfl_id: row}, "unmatched": [...], "doc": doc}
    or None when no xFP pull exists for the week. A starter the crosswalk cannot
    match to nflverse is listed in "unmatched", never given a zero."""
    doc = load(season, week)
    if doc is None:
        return None
    by_mfl = dict((p["mfl"], p) for p in doc["players"].values() if p.get("mfl"))
    rows = D.d1(
        "SELECT w.roster_franchise_id AS fid, w.player_id, w.pos_group, w.score, p.name AS player_name, p.nfl_team "
        "FROM src_weekly w LEFT JOIN src_players p ON p.season = w.season AND p.player_id = w.player_id "
        "WHERE w.season = %d AND w.week = %d AND w.status = 'starter' AND w.roster_franchise_id IS NOT NULL "
        "AND w.pos_group IN ('QB','RB','WR','TE')" % (int(season), int(week)))
    out, unmatched, by_row = [], [], {}
    for r in rows:
        x = by_mfl.get(str(r["player_id"]))
        name = D.display_name(r["player_name"])
        if x is None or r["score"] is None:
            unmatched.append({"player": name, "fid": str(r["fid"]).zfill(4),
                              "why": "no score from MFL" if r["score"] is None else "not in nflverse's week data"})
            continue
        row = {"fid": str(r["fid"]).zfill(4), "mfl": str(r["player_id"]), "player": name, "pos": r["pos_group"],
               "team": r.get("nfl_team") or x["team"], "score": float(r["score"]), "xfp": x["xfp"],
               "oe": round(float(r["score"]) - x["xfp"], 1), "usage": usage_phrase(x), "x": x}
        out.append(row)
        by_row[row["mfl"]] = row
    return {"over": sorted(out, key=lambda r: -r["oe"])[:n], "under": sorted(out, key=lambda r: r["oe"])[:n],
            "byMfl": by_row, "all": out, "unmatched": unmatched, "doc": doc}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=("fetch",))
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    a = ap.parse_args()
    try:
        doc = fetch(a.season, a.week)
    except D.DataError as exc:
        print("wire_xfp REFUSED: %s" % exc, file=sys.stderr)
        return 1
    matched = sum(1 for p in doc["players"].values() if p.get("mfl"))
    print("wrote %s: %d offensive players, %d matched to MFL ids" % (_rel(a.season, a.week), len(doc["players"]), matched))
    return 0


if __name__ == "__main__":
    sys.exit(main())
