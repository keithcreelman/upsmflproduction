#!/usr/bin/env python3
"""Historical DYNASTY Superflex ADP/ECR as-of each FA-auction date.

MFL's native ADP is REDRAFT (Herbert post-injury = QB20). For a dynasty SF
auction the right lens is dynasty SF rank. DynastyProcess publishes
files/values-players.csv with `ecr_2qb` (superflex dynasty ECR) + `value_2qb`,
and keeps weekly GIT HISTORY — the commit nearest each year's late-July auction
gives the dynasty board AS-OF auction time. Verified: Herbert 2025 = dynasty
SF QB8 (vs redraft QB20); Rodgers 2025 = QB32 (age 41, the real overpay).

Outputs:
  docs/auction/data/dynasty_adp_history.csv  (season, player, pos, age, sf_ecr,
      sf_pos_rank, value_2qb, fp_id, asof) for 2020-2025
  patches docs/auction/data/segments.json marquee_adp[*] with dyn_pos_rank + dyn_value
"""
from __future__ import annotations
import csv, io, json, re, sqlite3, urllib.request, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
OUT = REPO / "docs" / "auction" / "data" / "dynasty_adp_history.csv"
SEG = REPO / "docs" / "auction" / "data" / "segments.json"
DB = "/tmp/ups_auction_canon.db"
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "ups", "Accept": "*/*"}), timeout=30).read()


def nkey(name):
    s = (name or "").strip().lower()
    if "," in s:                                   # "Herbert, Justin" -> "justin herbert"
        a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    s = SUFFIX.sub("", s)
    return re.sub(r"\s+", " ", s).strip()


def commit_for(year):
    j = json.loads(get(f"https://api.github.com/repos/dynastyprocess/data/commits?path=files/values-players.csv&until={year}-08-05T00:00:00Z&per_page=1"))
    return (j[0]["sha"], j[0]["commit"]["committer"]["date"][:10]) if j else (None, None)


def main():
    rows, by_year = [], {}
    for yr in range(2020, 2026):
        sha, dt = commit_for(yr)
        if not sha:
            print(f"  {yr}: no commit"); continue
        data = get(f"https://raw.githubusercontent.com/dynastyprocess/data/{sha}/files/values-players.csv").decode("utf-8", "ignore")
        recs = list(csv.DictReader(io.StringIO(data)))
        # SF dynasty positional rank from ecr_2qb
        bypos = collections.defaultdict(list)
        for r in recs:
            try: e = float(r["ecr_2qb"])
            except (ValueError, KeyError): continue
            bypos[r["pos"]].append((e, r))
        idx = {}
        for pos, lst in bypos.items():
            lst.sort(key=lambda x: x[0])
            for i, (e, r) in enumerate(lst, 1): idx[id(r)] = i
        ymap = {}
        for r in recs:
            try: e = float(r["ecr_2qb"])
            except (ValueError, KeyError): continue
            pr = idx.get(id(r))
            rows.append([yr, r["player"], r["pos"], r.get("age"), round(e, 1), f"{r['pos']}{pr}",
                         r.get("value_2qb"), r.get("fp_id"), dt])
            ymap[nkey(r["player"])] = {"sf_ecr": round(e, 1), "pos_rank": f"{r['pos']}{pr}", "value": r.get("value_2qb")}
        by_year[yr] = ymap
        print(f"  {yr}: {len(recs)} players (as-of {dt}, commit {sha[:8]})")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["season", "player", "pos", "age", "sf_ecr", "sf_pos_rank", "value_2qb", "fp_id", "asof"])
        w.writerows(rows)
    print(f"wrote {OUT.relative_to(REPO)} ({len(rows)} rows) — dynasty SF (DynastyProcess ecr_2qb)")

    # ---- re-join the marquee wins in segments.json ----
    if SEG.exists():
        seg = json.loads(SEG.read_text())
        c = sqlite3.connect(DB)
        for m in seg.get("marquee_adp", []):
            ym = by_year.get(m["season"], {})
            d = ym.get(nkey(m["player"]))
            if d:
                m["dyn_pos_rank"] = d["pos_rank"]; m["dyn_sf_ecr"] = d["sf_ecr"]; m["dyn_value"] = d["value"]
            else:
                m["dyn_pos_rank"] = None
        seg.setdefault("meta", {})["adp_note"] = ("marquee_adp now carries BOTH redraft (pos_adp, from MFL) and "
            "dynasty-SF (dyn_pos_rank, from DynastyProcess ecr_2qb as-of auction date). Herbert 2025: redraft QB20 vs dynasty QB8.")
        SEG.write_text(json.dumps(seg, indent=2))
        n = sum(1 for m in seg.get("marquee_adp", []) if m.get("dyn_pos_rank"))
        print(f"patched segments.json marquee_adp: {n}/{len(seg.get('marquee_adp', []))} matched to dynasty rank")


if __name__ == "__main__":
    main()
