#!/usr/bin/env python3
"""Aggregate PFF Route Separation Score into a per-player JSON for the Stats Workbench.

Input  : data/misc_data/PFF_SeparationScore_2025.xlsx  (manual PFF export — per
         (player, coverage_level) rows: avg_score = separation ABOVE/BELOW expected,
         routes_ran, percentile_score). PFF player_id only.
Bridge : DynastyProcess db_playerids.csv (pff_id → mfl_id / gsis_id / position) —
         the same source that populates the D1 ff_player_ids table.
Output : site/stats_workbench/pff_separation_<season>.json — one row per receiver
         keyed by gsis_id + mfl_id, with routes-weighted OVERALL / MAN / ZONE
         separation scores and (within-pool) percentiles.

Rationale (research): separation adjusted for route volume is MORE predictive of
next-season fantasy PPG than YPRR and is QB/target-independent; separation vs MAN
coverage is the stable, repeatable skill signal (zone is noisier). So we surface the
man/zone split, not just a blended number, and gate the splits to a minimum route
sample so tiny coverage buckets don't create noise.

Stdlib + openpyxl only. No DB / wrangler / R.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
from pathlib import Path

import openpyxl

DB_PLAYERIDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv"

# Route-sample gates: below these we keep the score but suppress the percentile
# (too noisy to rank). Tuned to the file's distribution (median 8 routes/bucket).
MIN_OVERALL_ROUTES = 50
MIN_SPLIT_ROUTES = 20
# "man-beater" flag: strong, well-sampled separation vs man coverage.
MAN_BEATER_PCT = 0.75


def norm(v) -> str:
    return "" if v is None else str(v).strip()


def fetch_pff_crosswalk() -> dict[str, dict]:
    """pff_id -> {mfl_id, gsis_id, position, name} from DynastyProcess db_playerids."""
    req = urllib.request.Request(DB_PLAYERIDS_URL, headers={"User-Agent": "ups-mfl-etl/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        text = resp.read().decode("utf-8", "replace")
    out: dict[str, dict] = {}
    for r in csv.DictReader(io.StringIO(text)):
        pff = norm(r.get("pff_id"))
        if not pff:
            continue
        out[pff] = {
            "mfl_id": norm(r.get("mfl_id")) or None,
            "gsis_id": norm(r.get("gsis_id")) or None,
            "position": (norm(r.get("position")) or "").upper() or None,
            "name": norm(r.get("name")) or None,
        }
    return out


def coverage_bucket(cov: str) -> str | None:
    """man | zone | other(contested, e.g. Bracket) | None(exclude)."""
    c = (cov or "").strip().lower()
    if c.startswith("man"):
        return "man"
    if c.startswith("zone"):
        return "zone"
    if c.startswith("bracket"):
        return "other"
    # "No Primary Coverage" (uncovered) + "NA" (missing) are not contested skill.
    return None


def weighted(items: list[tuple[float, float]]) -> tuple[float | None, int]:
    """items = [(avg_score, routes)]; return (routes-weighted mean, total routes)."""
    tot = sum(r for _, r in items)
    if tot <= 0:
        return None, 0
    return sum(s * r for s, r in items) / tot, int(tot)


def pct_rank(values: dict[str, float], min_n: dict[str, int], thresh: int) -> dict[str, float]:
    """Within-pool percentile (0..1, higher score = higher pct) among qualified players."""
    pool = sorted(pid for pid, n in min_n.items() if n >= thresh and values.get(pid) is not None)
    ranked = sorted(pool, key=lambda pid: values[pid])
    n = len(ranked)
    out: dict[str, float] = {}
    for i, pid in enumerate(ranked):
        # midpoint percentile; round to 2 dp
        out[pid] = round((i + 0.5) / n, 4) if n else None
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--xlsx", default="data/misc_data/PFF_SeparationScore_2025.xlsx")
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--out", default="site/stats_workbench/pff_separation_2025.json")
    args = ap.parse_args()

    xw = fetch_pff_crosswalk()
    print(f"[pff-sep] crosswalk: {len(xw)} pff_id rows", file=sys.stderr)

    wb = openpyxl.load_workbook(args.xlsx, data_only=True, read_only=True)
    ws = wb["Sheet1"]
    rows = list(ws.iter_rows(values_only=True))[1:]  # skip header

    # gather per pff_id buckets
    per: dict[str, dict] = {}
    unmapped = 0
    for r in rows:
        pff = norm(r[2])
        if not pff:
            continue
        try:
            score = float(r[5]); routes = float(r[6])
        except (TypeError, ValueError):
            continue
        if routes <= 0:
            continue
        bucket = coverage_bucket(r[4])
        if bucket is None:
            continue
        p = per.setdefault(pff, {"name": norm(r[1]), "man": [], "zone": [], "all": []})
        p["all"].append((score, routes))
        if bucket in ("man", "zone"):
            p[bucket].append((score, routes))

    # aggregate
    recs: dict[str, dict] = {}
    o_score, m_score, z_score = {}, {}, {}
    o_routes, m_routes, z_routes = {}, {}, {}
    for pff, p in per.items():
        meta = xw.get(pff)
        if not meta or not meta.get("mfl_id"):
            unmapped += 1
            continue
        ov, ovr = weighted(p["all"])
        mn, mnr = weighted(p["man"])
        zn, znr = weighted(p["zone"])
        if ovr <= 0:
            continue
        mfl = meta["mfl_id"]
        recs[mfl] = {
            "mfl_id": mfl, "gsis_id": meta.get("gsis_id"), "pff_id": pff,
            "name": meta.get("name") or p["name"], "position": meta.get("position"),
            "overall_score": round(ov, 3) if ov is not None else None, "overall_routes": ovr,
            "man_score": round(mn, 3) if mn is not None else None, "man_routes": mnr,
            "zone_score": round(zn, 3) if zn is not None else None, "zone_routes": znr,
        }
        o_score[mfl] = ov; o_routes[mfl] = ovr
        m_score[mfl] = mn; m_routes[mfl] = mnr
        z_score[mfl] = zn; z_routes[mfl] = znr

    # within-pool percentiles
    o_pct = pct_rank(o_score, o_routes, MIN_OVERALL_ROUTES)
    m_pct = pct_rank(m_score, m_routes, MIN_SPLIT_ROUTES)
    z_pct = pct_rank(z_score, z_routes, MIN_SPLIT_ROUTES)
    for mfl, rec in recs.items():
        rec["overall_pct"] = o_pct.get(mfl)
        rec["man_pct"] = m_pct.get(mfl)
        rec["zone_pct"] = z_pct.get(mfl)
        rec["man_beater"] = bool(rec["man_pct"] is not None and rec["man_pct"] >= MAN_BEATER_PCT)

    out_list = sorted(recs.values(), key=lambda r: -(r["overall_score"] or -9))
    payload = {
        "season": args.season,
        "source": "PFF Route Separation Score (manual export)",
        "metric": "avg_score = separation above/below expected; routes-weighted; man/zone split; within-pool percentiles",
        "qualifiers": {"overall_min_routes": MIN_OVERALL_ROUTES, "split_min_routes": MIN_SPLIT_ROUTES},
        "count": len(out_list),
        "players": out_list,
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w") as fh:
        json.dump(payload, fh, indent=1)
        fh.write("\n")
    print(f"[pff-sep] wrote {len(out_list)} mapped players → {out_path} ({unmapped} unmapped pff_ids dropped)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
