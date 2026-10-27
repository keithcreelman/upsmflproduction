#!/usr/bin/env python3
"""Build site/standings/allplay_history.json: every finished regular season's All-Play record, week by week, for the
Standings page's "how strong is this season so far" comparison (Keith 2026-10-22).

Source: a SQLite copy of the D1 history tables (src_franchise_weekly_score, src_franchises), e.g. the replica made
for the League History audit. Production D1 is never read here; pass --db explicitly.

For each season and franchise: the cumulative All-Play W-L-T after each regular-season week (each week = 11 results:
the team's score against every other team's score; equal scores are ties). The page ranks the current season's teams
against every team-season through the SAME week, so seasons of 13 and 14 regular weeks compare fairly; a season
shorter than the week asked about is left out of that comparison.

usage: python3 scripts/build_allplay_history.py --db <d1_copy.sqlite> [--out site/standings/allplay_history.json]
"""
import argparse, json, sqlite3, sys
from collections import defaultdict


def build(db_path):
    con = sqlite3.connect(db_path)
    names = {(s, f): (t, o) for s, f, t, o in con.execute(
        "SELECT season, franchise_id, team_name, owner_name FROM src_franchises")}
    scores = defaultdict(lambda: defaultdict(dict))
    for s, w, f, t in con.execute(
            "SELECT season, week, franchise_id, team_score FROM src_franchise_weekly_score "
            "WHERE is_playoff = 0 AND team_score IS NOT NULL ORDER BY season, week"):
        scores[int(s)][int(w)][str(f).zfill(4)] = float(t)
    out = {}
    for s in sorted(scores):
        weeks = sorted(scores[s])
        fids = sorted(scores[s][weeks[0]])
        if weeks != list(range(1, len(weeks) + 1)) or any(sorted(scores[s][w]) != fids for w in weeks):
            sys.exit("season %d: weeks or franchises are incomplete; nothing written" % s)
        cum = {f: [0, 0, 0] for f in fids}
        teams = {f: {"team": names.get((s, f), (None, None))[0], "owner": names.get((s, f), (None, None))[1], "ap": []} for f in fids}
        for w in weeks:
            sc = scores[s][w]
            for f in fids:
                for g in fids:
                    if g != f:
                        cum[f][0 if sc[f] > sc[g] else 1 if sc[f] < sc[g] else 2] += 1
                teams[f]["ap"].append(list(cum[f]))
        out[str(s)] = {"regularWeeks": len(weeks), "teams": len(fids), "franchises": teams}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", default="site/standings/allplay_history.json")
    a = ap.parse_args()
    seasons = build(a.db)
    doc = {"schema": 1,
           "what": "Regular-season All-Play W-L-T after each week, every finished season (one score a week vs every other team).",
           "source": "D1 src_franchise_weekly_score + src_franchises (team and owner names as stored)",
           "seasons": seasons}
    open(a.out, "w", encoding="utf-8").write(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n")
    print("wrote", a.out, "seasons", ", ".join(sorted(seasons)))


if __name__ == "__main__":
    main()
