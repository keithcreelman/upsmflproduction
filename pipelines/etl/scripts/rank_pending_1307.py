#!/usr/bin/env python3
"""rank_pending_1307.py -- the exact membership of worker/src/rank_pending.js (#1307 / PR #1372).

Which 2025 season ranks /api/player-bundle holds back ("—", "Rank pending
historical reconciliation") until the clean rank recount is approved. A rank
is held when BOTH:
  1. Batch 1A newly exposes it: the player's src_weekly total (points rounded
     to 0.1 and scored weeks) equals src_pointssummary's own basis after 1A's
     inserts but not before (the player card's rule, #1353); and
  2. the stored rank differs from a clean recount: dense rank within the
     positional group, over every player in src_pointssummary 2025, on MFL's
     Wks 1-17 points and PPG (points / MFL scored weeks), each rounded to 4 dp.
Already-visible questionable ranks (exposed before 1A) are NOT held; they are
listed as a rank-table-rebuild blocker (Keith 2026-10-21).

  inputs  --artifacts DIR --archive DB.gz --out INPUTS.json   reads the private dry-run artifacts (offline)
  build   --inputs INPUTS.json --manifest M.json --js JS       deterministic: manifest + worker module
  check   --inputs INPUTS.json --manifest M.json --js JS       regenerate both and compare exactly (exit 1 on any difference)

Nothing here reads production D1 or calls MFL; `inputs` hashes every source it reads.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

SEASON = 2025
SEASON_WEEKS = 17
REG_LAST_WEEK = 14
LEAGUE = "74598"
FIELDS = ("pos_rank", "pos_ppg_rank")
INPUT_KEYS = ["player_id", "pos_group", "stored_pos_rank", "stored_pos_ppg_rank", "basis_points", "basis_weeks",
              "mfl_points", "mfl_weeks", "d1_before_points", "d1_before_weeks", "d1_after_points", "d1_after_weeks"]
REASON = "Rank pending historical reconciliation (#1307)"


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def canon(o) -> bytes:
    return json.dumps(o, sort_keys=True, separators=(",", ":")).encode()


def num(v):
    s = "" if v is None else str(v).strip()
    try:
        return float(s) if s else None
    except ValueError:
        return None


def as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])


# ── inputs: private dry-run artifacts -> one committed table ──────────────
def cmd_inputs(args) -> int:
    art, sources = Path(args.artifacts), []

    def src(path: Path, what: str) -> bytes:
        b = path.read_bytes()
        sources.append({"file": str(path.relative_to(art)) if art in path.parents else path.name, "what": what,
                        "sha256": sha256_bytes(b)})
        return b

    ps = json.loads(src(art / "d1_snapshot" / f"pointssummary_{SEASON}.json", "D1 src_pointssummary 2025 (2026-10-21 snapshot)"))["rows"]
    snap = json.loads(src(art / "d1_snapshot" / f"playoff_{SEASON}.json", "D1 src_weekly 2025 Wks 15-17 (2026-10-21 snapshot)"))["rows"]
    new = [json.loads(x) for x in src(art / "out_ranks_null" / "proposed" / f"B_{SEASON}.jsonl", "Batch 1A rows (dry run)").decode().splitlines() if x.strip()]
    gz = Path(args.archive)
    src(gz, "archive src_weekly 2025 Wks 1-14 (data/db-archives, equals D1 on all sampled weeks)")
    mfl_pts, mfl_wks = {}, {}
    for w in range(1, SEASON_WEEKS + 1):
        f = art / "mflcache" / f"api_myfantasyleague_com_{SEASON}_export_TYPE_playerScores_L_{LEAGUE}_W_{w}_JSON_1.json"
        for p in as_list((json.loads(src(f, f"MFL playerScores 2025 W={w}")).get("playerScores") or {}).get("playerScore")):
            v = num(p.get("score"))
            if v is not None:
                pid = str(p.get("id"))
                mfl_pts[pid] = mfl_pts.get(pid, 0.0) + v
                mfl_wks[pid] = mfl_wks.get(pid, 0) + 1
    with tempfile.TemporaryDirectory() as d:
        db = Path(d) / "a.db"
        with gzip.open(gz, "rb") as fi, open(db, "wb") as fo:
            shutil.copyfileobj(fi, fo)
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        reg = c.execute("SELECT CAST(player_id AS TEXT), score FROM player_weeklyscoringresults "
                        "WHERE season = ? AND week <= ? ORDER BY week, player_id", (SEASON, REG_LAST_WEEK)).fetchall()
        c.close()

    def totals(rows):
        t = {}
        for pid, s in rows:
            if s is not None:
                a = t.setdefault(str(pid), [0.0, 0])
                a[0] += s
                a[1] += 1
        return t
    before = totals(reg + [(r["player_id"], r["score"]) for r in snap])
    after = totals(reg + [(r["player_id"], r["score"]) for r in snap] + [(r["player_id"], r["score"]) for r in new])
    players = []
    for r in sorted(ps, key=lambda r: int(r["player_id"])):
        pid = str(r["player_id"])
        b, a = before.get(pid, [0.0, 0]), after.get(pid, [0.0, 0])
        players.append(dict(zip(INPUT_KEYS, [pid, r["positional_grouping"], int(r["pos_rank"]), int(r["pos_ppg_rank"]),
                                             float(r["points_total"]), int(r["games_played"]),
                                             mfl_pts.get(pid, 0.0), mfl_wks.get(pid, 0), b[0], b[1], a[0], a[1]])))
    out = {"season": SEASON, "season_weeks": SEASON_WEEKS,
           "note": "One row per src_pointssummary 2025 player. basis = src_pointssummary points_total / games_played; "
                   "mfl = MFL playerScores Wks 1-17 (posted scores, 0.0 included); d1_before / d1_after = src_weekly "
                   "totals without / with Batch 1A's inserts.",
           "sources": sources, "columns": INPUT_KEYS, "rows": [[p[k] for k in INPUT_KEYS] for p in players]}
    Path(args.out).write_text(json.dumps(out, indent=0) + "\n")
    print(json.dumps({"players": len(players), "sources": len(sources)}))
    return 0


# ── build: inputs -> manifest + worker module (pure, deterministic) ─────────
def dense(values: dict) -> dict:
    """Dense rank, descending, on the given (already rounded) value."""
    order = sorted(set(values.values()), reverse=True)
    pos = {v: i + 1 for i, v in enumerate(order)}
    return {k: pos[v] for k, v in values.items()}


def card_shows(points: float, weeks: int, basis_points: float, basis_weeks: int) -> bool:
    """The player card's rule (#1353): the weekly total matches the rank's own basis."""
    return weeks > 0 and abs(basis_points - round(points, 1)) < 0.05 and basis_weeks == weeks


def derive(inputs: dict) -> dict:
    rows = [dict(zip(inputs["columns"], r)) for r in inputs["rows"]]
    inputs_sha = sha256_bytes(canon(inputs))
    half = -(-inputs["season_weeks"] // 2)
    cmp_pts = {r["player_id"]: round(r["mfl_points"], 4) for r in rows}
    cmp_ppg = {r["player_id"]: (round(r["mfl_points"] / r["mfl_weeks"], 4) if r["mfl_weeks"] else 0.0) for r in rows}
    clean = {}
    # A player with no positional group (null) is ranked within the null group, as src_pointssummary does.
    for g in sorted({r["pos_group"] for r in rows}, key=lambda g: (g is None, g or "")):
        ids = [r["player_id"] for r in rows if r["pos_group"] == g]
        dp, dq = dense({i: cmp_pts[i] for i in ids}), dense({i: cmp_ppg[i] for i in ids})
        for i in ids:
            clean[i] = {"pos_rank": dp[i], "pos_ppg_rank": dq[i]}
    held = {f: [] for f in FIELDS}
    already = {f: [] for f in FIELDS}
    for r in rows:
        pid = r["player_id"]
        before = card_shows(r["d1_before_points"], r["d1_before_weeks"], r["basis_points"], r["basis_weeks"])
        after = card_shows(r["d1_after_points"], r["d1_after_weeks"], r["basis_points"], r["basis_weeks"])
        for f in FIELDS:
            stored = r["stored_" + f]
            if stored == clean[pid][f]:
                continue
            if after and not before:
                ppg = r["mfl_points"] / r["mfl_weeks"] if r["mfl_weeks"] else 0.0
                held[f].append({
                    "player_id": pid, "pos_group": r["pos_group"], "field": f,
                    "stored_rank": stored, "clean_rank": clean[pid][f],
                    "points": r["mfl_points"], "scored_weeks": r["mfl_weeks"], "ppg": ppg,
                    "comparison_value": cmp_pts[pid] if f == "pos_rank" else cmp_ppg[pid],
                    "comparison_rounding": "4 dp of points" if f == "pos_rank" else "4 dp of points / scored weeks",
                    "basis_points": r["basis_points"], "basis_weeks": r["basis_weeks"],
                    "d1_before": [r["d1_before_points"], r["d1_before_weeks"]],
                    "d1_after": [r["d1_after_points"], r["d1_after_weeks"]],
                    "ppg_half_season": r["mfl_weeks"] >= half,
                    "input_row_sha256": sha256_bytes(canon([r[k] for k in inputs["columns"]])),
                    "inputs_sha256": inputs_sha,
                })
            elif before:
                already[f].append(pid)
    return {
        "season": inputs["season"], "issue": 1307, "pr": 1372,
        "rule": "held = newly shown by Batch 1A (card rule: src_weekly total rounded to 0.1 and weeks equal "
                "src_pointssummary's basis after 1A, not before) AND stored rank != clean recount (dense rank within "
                "pos_group over every src_pointssummary 2025 player, on MFL Wks 1-17 points and PPG, each rounded to 4 dp)",
        "reason": REASON, "generator": "pipelines/etl/scripts/rank_pending_1307.py",
        "inputs_file": "docs/data_fixes/1307_rank_pending/inputs_2025.json", "inputs_sha256": inputs_sha,
        "sources": inputs["sources"],
        "counts": {f: len(held[f]) for f in FIELDS}
                  | {"pos_ppg_rank_with_half_season": sum(1 for x in held["pos_ppg_rank"] if x["ppg_half_season"])},
        "held": held,
        "not_held_already_visible": {
            "status": "rank-table-rebuild BLOCKER (Keith 2026-10-21): these stored ranks already display today and "
                      "differ from the clean recount; Batch 1A does not change them. They must be rebuilt or clearly "
                      "labeled before #1353 is release-ready. Not held by #1372 without a separate ruling.",
            "counts": {f: len(already[f]) for f in FIELDS},
            **{f: already[f] for f in FIELDS}},
    }


def manifest_text(m: dict) -> str:
    return json.dumps(m, indent=1) + "\n"


def js_text(m: dict) -> str:
    def arr(ids):
        lines = []
        for i in range(0, len(ids), 12):
            lines.append("      " + ", ".join(f'"{x}"' for x in ids[i:i + 12]) + ",")
        return "\n".join(lines)
    ids = {f: sorted((x["player_id"] for x in m["held"][f]), key=int) for f in FIELDS}
    return f'''// rank_pending.js -- season ranks held back from /api/player-bundle until the
// clean rank recount is approved (#1307, Keith 2026-10-21).
//
// GENERATED by pipelines/etl/scripts/rank_pending_1307.py from
// docs/data_fixes/1307_rank_pending/manifest_2025.json (inputs sha256
// {m["inputs_sha256"][:16]}...). Do not edit by hand: the safe suite regenerates it
// and fails on any difference.
//
// WHY: career_summary's pos_rank / pos_ppg_rank come from src_pointssummary,
// whose ranks are DENSE ranks on unrounded float totals (float noise splits
// ties) and predate later MFL stat corrections. #1307 Batch 1A restores 2025's
// missing playoff-week scores, so for 1,059 more 2025 player-seasons the
// weekly total starts to equal the rank's own basis -- and a stored rank that
// differs from a clean recount would then look verified. Every live player
// screen prints these fields, so the listed ranks come back null with
// rank_pending {{fields, reason}} until the recount is approved; screens show
// "—". Scores, other fields and other seasons are untouched.
//
// Held: newly shown by Batch 1A AND stored rank != clean recount (dense ranks
// within the positional group over every player in src_pointssummary, on MFL
// Wks 1-17 points and PPG, each rounded to 4 dp): pos_rank {len(ids["pos_rank"])}, pos_ppg_rank
// {len(ids["pos_ppg_rank"])} (PPG without the half-season rule, as live screens show it).
export const RANK_PENDING_REASON = "{m["reason"]}";

const PENDING = {{
  {m["season"]}: {{
    pos_rank: new Set([
{arr(ids["pos_rank"])}
    ]),
    pos_ppg_rank: new Set([
{arr(ids["pos_ppg_rank"])}
    ]),
  }},
}};

export function rankPendingCounts() {{
  const out = {{}};
  for (const [season, f] of Object.entries(PENDING)) {{
    out[season] = {{ pos_rank: f.pos_rank.size, pos_ppg_rank: f.pos_ppg_rank.size }};
  }}
  return out;
}}

// One career_summary row in, the same row out -- a pending rank nulled and
// named in rank_pending. Rows not on a list come back unchanged.
export function applyRankPending(pid, row) {{
  const f = row && PENDING[Number(row.season)];
  if (!f) return row;
  const id = String(pid);
  const held = ["pos_rank", "pos_ppg_rank"].filter((k) => f[k].has(id) && row[k] != null);
  if (!held.length) return row;
  const out = {{ ...row, rank_pending: {{ fields: held, reason: RANK_PENDING_REASON }} }};
  for (const k of held) out[k] = null;
  return out;
}}
'''


def cmd_build(args) -> int:
    m = derive(json.loads(Path(args.inputs).read_text()))
    Path(args.manifest).write_text(manifest_text(m))
    Path(args.js).write_text(js_text(m))
    print(json.dumps(m["counts"]))
    return 0


def check(inputs_path, manifest_path, js_path) -> list:
    """Every difference between the committed manifest / module and a fresh regeneration."""
    m = derive(json.loads(Path(inputs_path).read_text()))
    problems = []
    if Path(manifest_path).read_text() != manifest_text(m):
        old = json.loads(Path(manifest_path).read_text())
        for f in FIELDS:
            a = {x["player_id"]: x for x in old.get("held", {}).get(f, [])}
            b = {x["player_id"]: x for x in m["held"][f]}
            problems += [f"manifest {f}: {p} not held by the rule" for p in sorted(set(a) - set(b))]
            problems += [f"manifest {f}: {p} missing" for p in sorted(set(b) - set(a))]
            problems += [f"manifest {f}: {p} record differs" for p in sorted(set(a) & set(b)) if a[p] != b[p]]
        problems.append("manifest differs from a fresh regeneration")
    js = Path(js_path).read_text()
    if js != js_text(m):
        problems.append("worker module differs from a fresh regeneration")
    return problems


def cmd_check(args) -> int:
    problems = check(args.inputs, args.manifest, args.js)
    print(json.dumps({"ok": not problems, "problems": problems[:50]}, indent=1))
    return 1 if problems else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("inputs")
    i.add_argument("--artifacts", required=True)
    i.add_argument("--archive", required=True)
    i.add_argument("--out", required=True)
    for name in ("build", "check"):
        s = sub.add_parser(name)
        s.add_argument("--inputs", required=True)
        s.add_argument("--manifest", required=True)
        s.add_argument("--js", required=True)
    args = ap.parse_args(argv)
    return {"inputs": cmd_inputs, "build": cmd_build, "check": cmd_check}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
