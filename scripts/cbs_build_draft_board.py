#!/usr/bin/env python3
"""Build the live draft board page from fresh projections.

Produces docs/cbs_draft_board_2026.html — a standalone, self-contained page
used during the draft itself. Regenerate it whenever ADP moves or ESPN revises
its projections; the template lives beside this script so the page is a BUILD
OUTPUT rather than a hand-edited file that silently drifts from the pipeline.

The page carries both rulebooks (passing TD 4 and 6) so the league can vote on
the change and the board still works either way, and it marks every player with
no NFL games of his own — their totals are ESPN's and are sound, but their
per-game milestone bonuses are a positional average rather than a read on that
specific player, which is a wider error bar and worth seeing on draft night.

⚠️ THE ANALYST OVERLAY IS DELIBERATELY NOT PART OF THE COMMITTED BOARD.
--analyst-dir folds in a paid guide's player ranks and third-party podcast takes.
Those are licensed for personal reference, and a repo — private or not — is a
distribution vector, so this script REFUSES to write an analyst-bearing page
anywhere git tracks. Build the plain board into docs/ and the overlay build into
the gitignored data/analyst/ alongside its sources.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
sys.path.insert(0, str(REPO / "scripts"))

import importlib.util                                            # noqa: E402
_spec = importlib.util.spec_from_file_location(
    "pb", str(REPO / "scripts" / "cbs_projected_board.py"))
pb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pb)

from fantasy import adp as adpmod                                # noqa: E402
from fantasy import d1 as fd1                                    # noqa: E402
from fantasy.scoring import load_table                           # noqa: E402

LEAGUE_KEY = "ffl.s2026.l.grffl"
TEMPLATE = REPO / "scripts" / "_draft_board_template.html"
OUT = REPO / "docs" / "cbs_draft_board_2026.html"
#: Below this VOR an unranked player is noise, not a sleeper. Keeps the page
#: small enough to stay snappy on a phone at the draft table.
VOR_FLOOR = -60
#: Suffix forms differ between sources ("T.J. Hockenson" / "TJ Hockenson",
#: "Kenneth Walker III" / "Kenneth Walker"), so the analyst join runs on a
#: normalised key — 22 of 209 rows miss on the raw string.
SUFFIXES = (" jr", " sr", " ii", " iii", " iv", " v")
#: Paths git tracks. An analyst-bearing page may never be written under one.
TRACKED = ("docs", "site", "worker", "scripts", "pipelines", "tests")


def akey(name: str) -> str:
    k = adpmod.player_key(name or "")
    for suf in SUFFIXES:
        if k.endswith(suf):
            return k[: -len(suf)].strip()
    return k


def load_analyst(root: Path, board_names) -> dict:
    """Join the analyst layer onto board names. Reports what did not join.

    ⚠️ NEVER treats a missing file as "no analyst data" — a guide extract that
    failed to load is an unreadable input, not an empty one, and silently
    shipping a board with the column quietly absent is exactly the failure this
    codebase keeps getting bitten by.
    """
    rec_p, ver_p = root / "reconciled.json", root / "verified_takes.json"
    if not rec_p.exists():
        raise SystemExit(f"--analyst-dir given but {rec_p} is missing. Refusing to "
                         f"build a board that silently drops the analyst layer.")
    by_key = {}
    for name in board_names:
        by_key.setdefault(akey(name), name)

    out, missed = {}, []
    for r in json.loads(rec_p.read_text()):
        nm = by_key.get(akey(r["name"]))
        if nm is None:
            missed.append(r["name"])
            continue
        out[nm] = {"jj": r.get("jj"), "v": r.get("v"), "t": r.get("take"), "p": []}

    verified = 0
    if ver_p.exists():
        for t in json.loads(ver_p.read_text()):
            nm = by_key.get(akey(t.get("player", "")))
            if nm is None:
                missed.append(t.get("player", "?"))
                continue
            out.setdefault(nm, {"jj": None, "v": None, "t": None, "p": []})
            out[nm]["p"].append({"a": t.get("analyst", "?"), "s": t.get("stance", "neutral"),
                                 "t": t.get("take", ""), "u": t.get("source_url", ""),
                                 "y": t.get("season")})
            verified += 1
    else:
        print(f"  note: no {ver_p.name} — JJ's ranks only, no verified podcast takes")

    print(f"  analyst: {len(out)} players joined, {verified} verified takes"
          + (f", {len(missed)} unjoined ({', '.join(sorted(set(missed))[:6])}"
             + (" ..." if len(set(missed)) > 6 else "") + ")" if missed else ""))
    return out


def build(table, projs, shapes, fb, adp, mix):
    out = []
    for p in projs:
        key = pb.pkey(p["name"])
        games, used = pb.to_games(p["raw"], shapes.get(key), p["position"], fb)
        pts = table.score_weeks(p["position"], games, strict=False)
        for stat, bonus in pb.TD_BONUS[p["position"]].items():
            pts += bonus * p["raw"].get(
                {"PaTD": "pass_tds", "RuTD": "rush_tds", "ReTD": "rec_tds"}[stat], 0.0)
        pts += -2.0 * pb.UNRECORDED_FUMBLES[p["position"]] * pb.GAMES
        a = adp.get(adpmod.player_key(p["name"]))
        ru, re_, pa = mix.get(adpmod.player_key(p["name"]), (0, 0, 0))
        total = ru + re_ + pa
        flag = 0
        if p["position"] == "QB" and total >= 5 and ru / total >= 0.20:
            flag = 1
        elif p["position"] == "RB" and total >= 5 and re_ / total >= 0.20:
            flag = 2
        out.append({"player": p["name"], "pos": p["position"], "pts": round(pts, 1),
                    "adp": a["adp"] if a else None, "team": a["nfl_team"] if a else None,
                    "bye": a["bye_week"] if a else None, "flag": flag,
                    "unproven": 1 if used else 0})
    by = collections.defaultdict(list)
    for r in sorted(out, key=lambda r: -r["pts"]):
        by[r["pos"]].append(r)
    starters = dict(pb.BASE_STARTERS)
    starters = {p: n * 12 for p, n in starters.items()}
    pool = [r for p in ("RB", "WR", "TE") for r in by[p][starters[p]:]]
    pool.sort(key=lambda r: -r["pts"])
    for r in pool[:12]:
        starters[r["pos"]] += 1
    repl = {p: by[p][n - 1]["pts"] for p, n in starters.items()}
    for r in out:
        r["vor"] = round(r["pts"] - repl[r["pos"]], 1)
    out.sort(key=lambda r: -r["vor"])
    packed = [[r["player"], r["pos"], r["team"] or "", r["bye"] or 0,
               round(r["pts"]), round(r["vor"]), r["adp"] or 0, r["flag"], r["unproven"]]
              for r in out if not (r["adp"] is None and r["vor"] < VOR_FLOOR)]
    return packed, repl, starters


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--analyst-dir", default=None,
                    help="folder holding reconciled.json / verified_takes.json. "
                         "Adds the analyst column; forces an untracked --out.")
    ap.add_argument("--payload-in", default=None,
                    help="reuse a saved payload instead of re-querying D1")
    ap.add_argument("--payload-out", default=None)
    a = ap.parse_args()

    if a.analyst_dir:
        rel = Path(a.out).resolve()
        try:
            top = rel.relative_to(REPO).parts[0]
        except ValueError:
            top = None
        if top in TRACKED:
            raise SystemExit(
                f"refusing to write the analyst overlay to {a.out} — {top}/ is "
                f"tracked by git, and the guide extract is licensed for personal "
                f"reference only. Write it under data/analyst/ instead.")

    if a.payload_in:
        payload = json.loads(Path(a.payload_in).read_text())
        p4, r4, r6 = payload["p4"], payload["repl4"], payload["repl6"]
        return finish(a, payload, p4, r4, r6)

    loader = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    base = load_table(loader, platform="cbs", league_key=LEAGUE_KEY, season=2026)
    projs = pb.fetch_projections(a.limit)
    shapes, fb = pb.game_shapes(loader)
    adp = {adpmod.player_key(r["player_name"]): r
           for r in adpmod.fetch_ffc(2026, scoring="ppr", teams=12).rows}
    mix = {}
    for r in loader.query(
            "SELECT n.display_name nm, SUM(w.rush_tds) ru, SUM(w.rec_tds) re, "
            "SUM(w.pass_tds) pa FROM nfl_player_weekly w "
            "JOIN nfl_player_names n ON n.gsis_id = w.gsis_id "
            "WHERE w.season = 2025 AND w.week <= 18 GROUP BY 1;"):
        mix[adpmod.player_key(r["nm"])] = (r["ru"] or 0, r["re"] or 0, r["pa"] or 0)

    p4, r4, s4 = build(base, projs, shapes, fb, adp, mix)
    bumped = base.with_override("PaTD", 6.0, positions=[None, "QB"])
    p6, r6, _ = build(bumped, projs, shapes, fb, adp, mix)

    payload = {"p4": p4, "p6": p6, "repl4": r4, "repl6": r6, "starters": s4}
    if a.payload_out:
        Path(a.payload_out).write_text(json.dumps(payload, separators=(",", ":")))
    return finish(a, payload, p4, r4, r6)


def finish(a, payload, p4, r4, r6) -> int:
    if a.analyst_dir:
        payload["an"] = load_analyst(Path(a.analyst_dir), [r[0] for r in payload["p4"]])
    tpl = TEMPLATE.read_text(encoding="utf-8")
    if "__PAYLOAD__" not in tpl:
        raise SystemExit(f"{TEMPLATE} has no __PAYLOAD__ placeholder — refusing "
                         f"to write a board with no data in it.")
    html = tpl.replace("__PAYLOAD__", json.dumps(payload, separators=(",", ":")))
    Path(a.out).write_text(html, encoding="utf-8")
    unproven = sum(1 for r in p4 if r[8])
    print(f"wrote {a.out}  ({len(html)} bytes)")
    print(f"  {len(p4)} players, {unproven} with no NFL games of their own")
    print(f"  replacement (PaTD 4): " + ", ".join(f"{k} {v:.0f}" for k, v in sorted(r4.items())))
    print(f"  replacement (PaTD 6): " + ", ".join(f"{k} {v:.0f}" for k, v in sorted(r6.items())))
    return 0


if __name__ == "__main__":
    sys.exit(main())
