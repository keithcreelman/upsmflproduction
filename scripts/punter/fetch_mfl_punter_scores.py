#!/usr/bin/env python3
"""Read-only: cache MFL playerScores (POSITION=PN) per season/week + players list, using the season's UPS league id.
MFL rate-limits ~100-150 reads/10 min per IP+UA, so this sleeps between calls and backs off on 429. Cache files are
reused on rerun. Output: data/punter/raw/mfl_ps/<year>_W<week>.json and mfl_ps/players_<year>.json"""
import os, sys, time, json, urllib.request, urllib.error
ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
OUT = os.path.join(ROOT, "data", "punter", "raw", "mfl_ps")
LEAGUE = {2011: 40832, 2012: 37227, 2013: 42721, 2014: 30590, 2015: 29015, 2016: 27191}
UA = "ups-punter-model/1.0"
def lid(y): return LEAGUE.get(y, 74598)
def get(url, tries=6):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=40).read().decode()
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(90 * (i + 1)); continue
            raise
    raise RuntimeError("rate limited: " + url)
def main(years, weeks=range(1, 19), pause=5):
    os.makedirs(OUT, exist_ok=True)
    for y in years:
        pf = os.path.join(OUT, "players_%d.json" % y)
        if not os.path.exists(pf):
            open(pf, "w").write(get("https://api.myfantasyleague.com/%d/export?TYPE=players&L=%d&DETAILS=1&JSON=1" % (y, lid(y)))); time.sleep(pause)
        for w in weeks:
            f = os.path.join(OUT, "%d_W%d.json" % (y, w))
            if os.path.exists(f): continue
            open(f, "w").write(get("https://api.myfantasyleague.com/%d/export?TYPE=playerScores&L=%d&W=%d&YEAR=%d&POSITION=PN&RULES=1&JSON=1" % (y, lid(y), w, y)))
            print(y, w, flush=True); time.sleep(pause)
if __name__ == "__main__":
    ys = [int(a) for a in sys.argv[1:]] or list(range(2012, 2027))
    main(ys)
