#!/usr/bin/env python3
"""Extract the MFL scoring rules that apply to position PN, per season, from data/punter/raw/rules_<year>.json
(MFL export TYPE=rules, league ids per season: 2011 40832, 2012 37227, 2013 42721, 2014 30590, 2015 29015,
2016 27191, 2017+ 74598). Writes data/punter/processed/pn_rules_by_season.json and prints a season diff."""
import json, glob, os, sys
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
RAW = os.path.join(ROOT, "data", "punter", "raw")
OUT = os.path.join(ROOT, "data", "punter", "processed", "pn_rules_by_season.json")

def as_list(x):
    return x if isinstance(x, list) else [x]

def pn_rules(doc):
    out = []
    for pr in as_list(doc["rules"]["positionRules"]):
        if "PN" not in pr.get("positions", "").split("|"):
            continue
        for r in as_list(pr["rule"]):
            out.append({"event": r["event"]["$t"], "range": r["range"]["$t"], "points": r["points"]["$t"]})
    return sorted(out, key=lambda r: (r["event"], r["range"], r["points"]))

def main():
    res = {}
    for f in sorted(glob.glob(os.path.join(RAW, "rules_*.json"))):
        y = int(os.path.basename(f)[6:10])
        res[y] = pn_rules(json.load(open(f)))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(res, open(OUT, "w"), indent=1, sort_keys=True)
    prev = None
    for y in sorted(res):
        cur = {json.dumps(r, sort_keys=True) for r in res[y]}
        if prev is None:
            print(y, "rules:", len(cur))
            for r in res[y]: print("   ", r)
        else:
            add, rem = cur - prev, prev - cur
            print(y, "changed" if add or rem else "same", "+%d -%d" % (len(add), len(rem)))
            for a in sorted(add): print("   +", a)
            for a in sorted(rem): print("   -", a)
        prev = cur

if __name__ == "__main__":
    main()
