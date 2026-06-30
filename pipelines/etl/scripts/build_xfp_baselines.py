#!/usr/bin/env python3
"""Personal "vs Self" baselines for xFP — regress a player toward HIS OWN history,
not the league mean, so a perennial over-converter (Kelce/CMC) isn't flagged a sell
just for being good. For young players (years 1-3) with thin history, the baseline
ramps off a UPS rookie-draft-slot prior (the 1.01 pick is expected to outperform the
5.01) and shifts to his own emerging data as he accumulates games.

Pipeline:
  1. Compute every player-season's Sustainable±/g over 2006-2025 (reuses
     build_nfl_xfp.component_points + xfp_reliability.json — identical math to the
     per-season export, just run across history).
  2. Draft-slot prior: join the UPS rookie draft (site/rookies/rookie_draft_history.json,
     MFL player_id) to gsis_id via DynastyProcess db_playerids, take each drafted
     player's early-career (exp 1-3) Sustainable±/g, and median it within slot-band ×
     position bucket. Bands: 1.01-1.04 / 1.05-1.08 / 1.09-1.12 / R2 / R3 / R4+.
  3. Personal baseline for the current season:
       own = decayed mean of PRIOR seasons' Sustainable±/g (half-life 2 yr, excl. current)
       prior_mean = draft-slot prior (young w/ slot) else position-group mean (~0)
       w = G_prior / (G_prior + K_BASELINE)         # ramps 0->1 over years 1-3
       PersonalBaseline/g = w*own + (1-w)*prior_mean
       RegressionSignal/g = current Sustainable±/g - PersonalBaseline/g
  4. Merge personal_baseline_pg / regression_signal_pg / is_rookie / exp / slot_band
     into site/stats_workbench/nfl_xfp_2025.json (in place).

Run AFTER build_nfl_xfp.py (it reads + rewrites that file).
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import statistics
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_nfl_xfp import BUCKET, component_points, load_reliability  # noqa: E402

SEASONS = list(range(2006, 2026))
CURRENT = 2025
REG_MAX_WEEK = 17
HALF_LIFE = 2.0          # seasons; recency decay of own history
K_BASELINE = 24.0        # games at which own-history weight = 0.5 (~1.5 seasons)
YOUNG_MAX_EXP = 3
DB_PLAYERIDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"


def slot_band(rnd, slot):
    try:
        rnd = int(rnd); slot = int(slot)
    except (TypeError, ValueError):
        return None
    if rnd == 1:
        return "1.01-1.04" if slot <= 4 else ("1.05-1.08" if slot <= 8 else "1.09-1.12")
    if rnd == 2:
        return "R2"
    if rnd == 3:
        return "R3"
    return "R4+"


def sustain_by_player_season(reliability):
    """{(season, gsis): {sustain_pg, g, bucket}} over all seasons."""
    import nflreadpy as nfl
    df = nfl.load_ff_opportunity(seasons=SEASONS, stat_type="weekly")
    agg = defaultdict(lambda: {"td": 0.0, "yds": 0.0, "rec": 0.0, "fd": 0.0, "misc": 0.0,
                               "opps": 0.0, "rec_opps": 0.0, "g": 0, "pos": ""})
    for r in df.to_dicts():
        try:
            if int(r.get("week")) > REG_MAX_WEEK:
                continue
        except (TypeError, ValueError):
            continue
        pid = r.get("player_id")
        pos = (r.get("position") or "")
        bucket = BUCKET.get(pos.upper())
        if not pid or not bucket:
            continue

        def fexp(name, _r=r):
            v = _r.get(name + "_exp"); return float(v) if v not in (None, "") else 0.0

        def fact(name, _r=r):
            v = _r.get(name); return float(v) if v not in (None, "") else 0.0

        ep = component_points(fexp, pos); ap = component_points(fact, pos)
        a = agg[(int(r["season"]), pid)]
        a["pos"] = pos or a["pos"]
        for c in ("td", "yds", "rec", "fd", "misc"):
            a[c] += ap[c] - ep[c]
        a["opps"] += fact("pass_attempt") if bucket == "QB" else (fact("rec_attempt") + fact("rush_attempt"))
        a["rec_opps"] += fact("rec_attempt")
        if any(fexp(n) for n in ("pass_yards_gained", "rush_yards_gained", "rec_yards_gained", "receptions")):
            a["g"] += 1

    out = {}
    for (s, pid), a in agg.items():
        if a["g"] <= 0:
            continue
        bucket = BUCKET.get((a["pos"] or "").upper(), "WR_TE")
        rel = reliability.get(bucket, {})

        def shrink(c, n):
            r_c, k_c = rel.get(c, (0.0, 9999.0))
            return r_c * (n / (n + k_c)) if (n + k_c) > 0 else 0.0

        sustain = (a["td"] * shrink("td", a["opps"]) + a["yds"] * shrink("yds", a["opps"])
                   + a["rec"] * shrink("rec", a["rec_opps"]) + a["fd"] * shrink("fd", a["opps"]))
        out[(s, pid)] = {"sustain_pg": sustain / a["g"], "g": a["g"], "bucket": bucket}
    return out


def load_draft_slots():
    """{gsis_id: {draft_season, band, bucket}} from the UPS rookie draft, joined via db_playerids."""
    # mfl_id -> gsis_id
    req = urllib.request.Request(DB_PLAYERIDS_URL, headers={"User-Agent": "ups-mfl-etl/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8", "replace")
    mfl2gsis = {}
    for row in csv.DictReader(io.StringIO(text)):
        m = (row.get("mfl_id") or "").strip(); g = (row.get("gsis_id") or "").strip()
        if m and g:
            mfl2gsis[m] = g
    picks = json.loads(Path("site/rookies/rookie_draft_history.json").read_text())
    if isinstance(picks, dict):
        picks = next((v for v in picks.values() if isinstance(v, list)), [])
    out = {}
    for p in picks:
        mfl = str(p.get("player_id") or "").strip()
        gsis = mfl2gsis.get(mfl)
        band = slot_band(p.get("round"), p.get("slot"))
        season = p.get("season") or p.get("draft_year")
        if gsis and band and season:
            out[gsis] = {"draft_season": int(season), "band": band,
                         "bucket": BUCKET.get((p.get("position") or "").upper(), "WR_TE")}
    return out, len(mfl2gsis)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xfp", default="site/stats_workbench/nfl_xfp_2025.json")
    args = ap.parse_args()

    reliability = load_reliability("site/stats_workbench/xfp_reliability.json")
    ts = sustain_by_player_season(reliability)
    draft, n_xwalk = load_draft_slots()
    print(f"[baselines] {len(ts)} player-seasons; {len(draft)} drafted players joined (xwalk {n_xwalk})", file=sys.stderr)

    # per-player time series {gsis: {season: (sustain_pg, g)}}
    by_player = defaultdict(dict)
    for (s, pid), v in ts.items():
        by_player[pid][s] = v

    # ---- draft-slot prior: median early-career (exp 1-3) Sustainable±/g per (band, bucket) ----
    slot_samples = defaultdict(list)
    for gsis, d in draft.items():
        ds = d["draft_season"]
        early = [by_player[gsis][s]["sustain_pg"] for s in range(ds, ds + 3) if s in by_player.get(gsis, {})]
        if early:
            slot_samples[(d["band"], d["bucket"])].append(sum(early) / len(early))
    slot_prior = {}
    for key, vals in slot_samples.items():
        if len(vals) >= 4:
            slot_prior[key] = statistics.median(vals)
    # position-group fallback mean (≈0)
    pos_mean = {}
    for b in ("QB", "RB", "WR_TE"):
        vv = [v["sustain_pg"] for (s, _), v in ts.items() if v["bucket"] == b]
        pos_mean[b] = statistics.median(vv) if vv else 0.0

    print("\n  draft-slot prior (median early-career Sustainable±/g):", file=sys.stderr)
    for b in ("QB", "RB", "WR_TE"):
        cells = [f"{band}={slot_prior.get((band,b),float('nan')):+.2f}({len(slot_samples.get((band,b),[]))})"
                 for band in ("1.01-1.04", "1.05-1.08", "1.09-1.12", "R2", "R3", "R4+")]
        print(f"    {b:5}: " + "  ".join(cells), file=sys.stderr)

    # ---- personal baseline for each 2025 player ----
    doc = json.loads(Path(args.xfp).read_text())
    merged = 0
    for p in doc["players"]:
        gsis = p["gsis_id"]
        bucket = BUCKET.get((p.get("position") or "").upper(), "WR_TE")
        cur = by_player.get(gsis, {}).get(CURRENT)
        cur_pg = cur["sustain_pg"] if cur else (p.get("sustainable_diff", 0) / max(1, p.get("games", 1)))
        # own decayed prior (seasons < CURRENT)
        num = den = g_prior = 0.0
        for s, v in by_player.get(gsis, {}).items():
            if s >= CURRENT:
                continue
            w = 0.5 ** ((CURRENT - s - 1) / HALF_LIFE)
            num += w * v["sustain_pg"]; den += w; g_prior += v["g"]
        own = (num / den) if den > 0 else 0.0
        # experience + prior_mean
        d = draft.get(gsis)
        exp = (CURRENT - d["draft_season"] + 1) if d else None
        if d and exp is not None and exp <= YOUNG_MAX_EXP and (d["band"], d["bucket"]) in slot_prior:
            prior_mean = slot_prior[(d["band"], d["bucket"])]
            slot_lbl = d["band"]
        else:
            prior_mean = pos_mean.get(bucket, 0.0)
            slot_lbl = None
        w = g_prior / (g_prior + K_BASELINE) if (g_prior + K_BASELINE) > 0 else 0.0
        baseline = w * own + (1 - w) * prior_mean
        p["personal_baseline_pg"] = round(baseline, 2)
        p["regression_signal_pg"] = round(cur_pg - baseline, 2)
        p["is_rookie"] = bool(g_prior <= 0)
        p["exp"] = exp
        p["slot_band"] = slot_lbl
        merged += 1

    Path(args.xfp).write_text(json.dumps(doc, indent=1) + "\n")
    print(f"\n[baselines] merged baselines into {merged} players → {args.xfp}", file=sys.stderr)
    # sample
    show = {pp["name"]: pp for pp in doc["players"]}
    print("\n  sample:", file=sys.stderr)
    for nm in ("Christian McCaffrey", "Puka Nacua", "Justin Jefferson", "Jonathan Taylor"):
        p = show.get(nm)
        if p:
            print(f"    {nm:20} sustain/g={p.get('sustainable_diff',0)/max(1,p['games']):+.2f}  baseline/g={p['personal_baseline_pg']:+.2f}  vsSelf/g={p['regression_signal_pg']:+.2f}  exp={p['exp']} slot={p['slot_band']}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
