#!/usr/bin/env python3
"""Measure CBS's touchdown-distance bonuses EXACTLY, using MFL's per-TD lengths.

WHY THIS REPLACES A REGRESSION WITH A MEASUREMENT
=================================================
CBS pays a touchdown bonus banded by the LENGTH of the touchdown (10-39 /
40-69 / 70-100 yards, at most one band per TD). Weekly stat lines carry TD
COUNTS, so the first pass at this recovered the bonus as a residual — score a
season game by game, subtract from CBS's published total, regress what is left
on TD counts. That worked, but it inherits every error in the base.

MFL's keyless `detailed?` report states each touchdown INDIVIDUALLY, with its
length: "35 yd Passing TD", "4 yd Passing TD". So the bands can simply be
applied to real touchdowns and averaged. No fitting, no residual, no
contamination from whatever else the base gets wrong.

⚠️ IT ALSO FIXES A BIAS IN THE OLD NUMBERS. The residual method was
contaminated for quarterbacks: this database has no sack-fumble column, so the
engine's base was too HIGH for a QB, which made the residual too LOW, which
made the fitted QB bonus too SMALL. MFL states "Fumbles Lost (to Opponent)" —
the true total, strip-sacks included — so this script reports that gap too.

Sampling, not a census: the goal is an average bonus per TD type per position,
and a few hundred real touchdowns pin that down far more precisely than
regression on a hundred season totals.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import d1 as fd1                              # noqa: E402
from fantasy.scoring import load_table                     # noqa: E402

WORKER = "https://upsmflproduction.keith-creelman.workers.dev/api/mfl-detailed"
LEAGUE_KEY = "ffl.s2026.l.grffl"

#: MFL stat label -> this league's TD stat id.
TD_LABEL = {"Passing TD": "PaTD", "Rushing TD": "RuTD", "Receiving TD": "ReTD"}
FUMBLE_LABEL = "Fumbles Lost (to Opponent)"
#: "35 yd Passing TD" -> (35, "Passing TD");  a TD with no yardage prefix is
#: still a touchdown and must not be dropped — it is a 0-yard-ish plunge.
_LINE = re.compile(r"^(?P<val>-?[\d.]+)\s*(?:yd\s*)?(?P<label>.+)$")


def fetch(pid: str, week: int, season: int) -> dict | None:
    url = f"{WORKER}?L=74598&P={pid}&W={week}&YEAR={season}"
    try:
        with urllib.request.urlopen(
                urllib.request.Request(url, headers={"User-Agent": "ups-etl"}), timeout=30) as r:
            return json.load(r)
    except Exception:                                       # noqa: BLE001
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=2025)
    ap.add_argument("--rules-season", type=int, default=2026)
    ap.add_argument("--per-position", type=int, default=15)
    ap.add_argument("--weeks", type=int, default=17)
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--board", default="/tmp/cbs_board.json")
    ap.add_argument("--json-out", default="")
    a = ap.parse_args()

    loader = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    table = load_table(loader, platform="cbs", league_key=LEAGUE_KEY, season=a.rules_season)

    board = json.loads(Path(a.board).read_text())
    want: dict[str, list[str]] = {}
    for row in board:
        lst = want.setdefault(row["position"], [])
        if len(lst) < a.per_position:
            lst.append(row["player"])
    names = [n for v in want.values() for n in v]

    esc = lambda t: "'" + t.replace("'", "''") + "'"        # noqa: E731
    # ⚠️ GUARD EVERY EXTERNAL ID. ff_player_ids stores the literal string 'NA'
    # for missing ids; an unguarded join reports full coverage while matching
    # garbage. Same trap as yahoo_id, same fix.
    rows = loader.query(
        f"SELECT name, mfl_id, position FROM ff_player_ids WHERE name IN "
        f"({','.join(map(esc, names))}) AND mfl_id IS NOT NULL "
        f"AND mfl_id NOT IN ('', 'NA');")
    pid_of = {r["name"]: str(r["mfl_id"]) for r in rows}
    missing = [n for n in names if n not in pid_of]
    if missing:
        print(f"  no usable mfl_id for {len(missing)}: {missing[:6]}")

    jobs = [(nm, pos, pid_of[nm], wk)
            for pos, lst in want.items() for nm in lst if nm in pid_of
            for wk in range(1, a.weeks + 1)]
    print(f"fetching {len(jobs)} player-weeks from MFL's detailed report "
          f"({len(pid_of)} players x {a.weeks} weeks)...")

    tds: dict[tuple[str, str], list[float]] = collections.defaultdict(list)
    fumbles: dict[str, list[float]] = collections.defaultdict(list)
    ok = 0

    def work(job):
        nm, pos, pid, wk = job
        return pos, fetch(pid, wk, a.season)

    with ThreadPoolExecutor(max_workers=a.workers) as ex:
        for pos, d in ex.map(work, jobs):
            if not d or not d.get("lines"):
                continue
            ok += 1
            for line in d["lines"]:
                m = _LINE.match(str(line.get("stat", "")).strip())
                if not m:
                    continue
                label = m.group("label").strip()
                val = float(m.group("val"))
                if label in TD_LABEL:
                    tds[(pos, TD_LABEL[label])].append(val)
                elif label == FUMBLE_LABEL:
                    fumbles[pos].append(val)

    print(f"  {ok} player-weeks with data\n")
    print("EXACT expected bonus per TD, from real touchdown lengths:")
    out: dict[str, dict[str, float]] = {}
    for (pos, stat), lengths in sorted(tds.items()):
        if len(lengths) < 10:
            print(f"  {pos} {stat}: only {len(lengths)} touchdowns — too few to average, skipped")
            continue
        # Apply the league's OWN bands to each real touchdown.
        bonuses = [table.score_stat(pos, stat, 1, event_lengths=[L])
                   - table.score_stat(pos, stat, 1) for L in lengths]
        avg = sum(bonuses) / len(bonuses)
        dist = collections.Counter("0-9" if L < 10 else "10-39" if L < 40
                                   else "40-69" if L < 70 else "70+" for L in lengths)
        out.setdefault(pos, {})[stat] = round(avg, 2)
        print(f"  {pos} {stat}: n={len(lengths):>4}  +{avg:5.2f}/TD   "
              + " ".join(f"{k}:{dist[k]}" for k in ("0-9", "10-39", "40-69", "70+")))

    print("\nFUMBLES LOST per game (MFL's total — sack fumbles INCLUDED):")
    for pos, vals in sorted(fumbles.items()):
        if vals:
            print(f"  {pos}: {sum(vals):.0f} over {len(vals)} games = "
                  f"{sum(vals)/len(vals):.3f}/game -> {2*sum(vals)/len(vals):.2f} pts/game missed")

    print("\nPaste into scripts/cbs_build_board.py TD_BONUS:")
    print(json.dumps(out, indent=4))
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(
            {"td_bonus": out,
             "fumbles_per_game": {p: round(sum(v)/len(v), 4) for p, v in fumbles.items() if v}},
            indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
