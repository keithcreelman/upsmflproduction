#!/usr/bin/env python3
"""Do elite players age differently? — Keith's Derrick Henry vs Raheem Mostert question.

THE TRAP THIS IS BUILT AROUND
    The obvious test — split by PPG in year N, measure decline into N+1 — is
    invalid. A player who was elite in year N is partly good and partly lucky, so
    he regresses down; a marginal player regresses up. That yields "elite players
    decline faster", which is regression to the mean wearing an aging costume.

    So talent is measured from a window that EXCLUDES year N: career PPG over all
    seasons up to and including N-1. The naive version is computed too, and
    printed alongside, precisely to show how far it misleads.
"""
import json, sys, subprocess, collections, statistics
from pathlib import Path

W = "/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/admiring-easley-c3b36d/worker"
CACHE = Path("/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-admiring-easley-c3b36d/c8c3abb7-1d18-4df3-abf3-a8ffcf14a4c2/scratchpad/age_panel.json")


def d1(sql):
    p = subprocess.run(["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote",
                        "--json", "--command", sql], cwd=W, capture_output=True, text=True)
    s, i = p.stdout, 0
    while True:
        j = s.find("[", i)
        if j < 0:
            raise SystemExit(f"unparseable: {(p.stderr or s)[:200]}")
        try:
            d, _ = json.JSONDecoder().raw_decode(s[j:])
            if isinstance(d, list) and d and "results" in d[0]:
                return d[0]["results"]
        except ValueError:
            pass
        i = j + 1


if CACHE.exists():
    panel = json.loads(CACHE.read_text())
else:
    panel = []
    for ssn in range(2016, 2026):
        rows = d1("SELECT p.gsis_id gs, COUNT(*) g, AVG(s.score) ppg"
                  " FROM src_weekly s JOIN ff_player_ids p"
                  " ON CAST(p.mfl_id AS INTEGER)=s.player_id"
                  f" WHERE s.season={ssn} AND s.score>0 AND s.week BETWEEN 1 AND 17"
                  "   AND COALESCE(p.gsis_id,'') LIKE '00-%' GROUP BY p.gsis_id")
        for r in rows:
            panel.append({"season": ssn, "gs": r["gs"], "g": r["g"], "ppg": r["ppg"]})
        print(f"  {ssn}: {len(rows)}", file=sys.stderr)
    CACHE.write_text(json.dumps(panel))

# age + position from nflverse
import nflreadpy as nfl
from datetime import datetime
meta = {}
for ssn in range(2016, 2026):
    d = nfl.load_rosters([ssn]); d = d.to_pandas() if hasattr(d, "to_pandas") else d
    d.columns = [c.lower() for c in d.columns]
    ref = datetime(ssn, 9, 1)
    for r in d.to_dict(orient="records"):
        g, bd, pos = r.get("gsis_id"), r.get("birth_date"), r.get("position")
        if not g or bd is None or str(bd) in ("", "NaT", "None"):
            continue
        try:
            age = (ref - datetime.fromisoformat(str(bd)[:10])).days / 365.25
        except ValueError:
            continue
        meta[(ssn, str(g))] = (age, str(pos or ""))

by_p = collections.defaultdict(dict)
for r in panel:
    by_p[r["gs"]][r["season"]] = (r["ppg"], r["g"])

MING = 8            # both seasons must be reasonably full to compare
POS = ("RB", "WR", "TE", "QB")

pairs = []
for gs, seasons in by_p.items():
    for n in sorted(seasons):
        if n + 1 not in seasons:
            continue
        ppg_n, g_n = seasons[n]
        ppg_n1, g_n1 = seasons[n + 1]
        if g_n < MING or g_n1 < MING or not ppg_n:
            continue
        m = meta.get((n, gs))
        if not m:
            continue
        age, pos = m
        if pos not in POS:
            continue
        prior = [seasons[y][0] for y in seasons if y <= n - 1 and seasons[y][1] >= MING]
        pairs.append({
            "gs": gs, "age": age, "pos": pos, "n": n,
            "ppg_n": ppg_n, "ppg_n1": ppg_n1,
            "retention": ppg_n1 / ppg_n,
            "career_prior": statistics.mean(prior) if prior else None,
        })

print(f"\nplayer-season pairs (both seasons >= {MING} games): {len(pairs)}")


def bucket_age(a):
    if a < 26: return "<26"
    if a < 29: return "26-28"
    if a < 31: return "29-30"
    return "31+"


def report(title, tier_key, elig):
    print(f"\n{'='*74}\n{title}\n{'='*74}")
    print(f"{'pos':<5}{'age':<8}{'tier':<10}{'n':>5}{'med retention':>16}")
    for pos in POS:
        rows = [p for p in pairs if p["pos"] == pos and elig(p)]
        if len(rows) < 30:
            continue
        for ab in ("<26", "26-28", "29-30", "31+"):
            sub = [p for p in rows if bucket_age(p["age"]) == ab]
            if len(sub) < 12:
                continue
            vals = sorted(tier_key(p) for p in sub)
            cut = vals[len(vals) // 2]
            for label, sel in (("elite", lambda p: tier_key(p) >= cut),
                               ("rest", lambda p: tier_key(p) < cut)):
                s2 = [p["retention"] for p in sub if sel(p)]
                if len(s2) < 6:
                    continue
                print(f"{pos:<5}{ab:<8}{label:<10}{len(s2):>5}{statistics.median(s2):>15.2f}")
        print()


report("NAIVE — tier from year N itself (THE TRAP: this is regression to the mean)",
       lambda p: p["ppg_n"], lambda p: True)

report("CORRECTED — tier from career PPG through N-1 (excludes the measured year)",
       lambda p: p["career_prior"], lambda p: p["career_prior"] is not None)
