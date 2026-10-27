#!/usr/bin/env python3
"""Build site/standings/h2h_history.json: every recorded head-to-head game of finished seasons, plus each season's
owner of record, for the Standings matchup sheet ("Tale of the Tape", #1329).

Inputs are two read-only D1 exports (wrangler JSON, `[0].results`):
  --schedule    SELECT season, week, franchise_id, opponent_franchise_id, team_score, opponent_score, is_playoff
                  FROM src_schedule WHERE season <= <through>
  --franchises  SELECT season, franchise_id, owner_name FROM src_franchises WHERE season <= <through>

Owners come from src_franchises (the owner who ran that season's auction, canon §D.2), never from the owner names
src_schedule carries (those are stamped when the data was pulled). The client matches owners by exact name, so a
person's games follow them across franchise ids and team names, and a new owner never inherits the old one's games.

Fails (exit 1, nothing written) unless every game has both teams' rows with matching scores and every franchise in a
game has an owner that season. MFL never exported the regular-season pairings of 2010-2011 and 2013-2019, so those
seasons contribute playoff games only; the file lists the seasons whose regular-season games are present.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[3]
DEFAULT_OUT = ROOT_DIR / "site" / "standings" / "h2h_history.json"


def rows_of(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if isinstance(data, list) and data and isinstance(data[0], dict) and "results" in data[0]:
        return data[0]["results"]
    raise SystemExit(f"{path}: expected wrangler JSON ([0].results)")


def pad4(v) -> str:
    return str(v).strip().zfill(4)


def build(schedule: list[dict], franchises: list[dict], through: int, source_note: str) -> dict:
    problems: list[str] = []
    owners: dict[str, dict[str, str]] = {}
    for r in franchises:
        season = int(r["season"])
        if season > through:
            continue
        name = (r.get("owner_name") or "").strip()
        if not name:
            problems.append(f"{season} {pad4(r['franchise_id'])}: no owner")
            continue
        owners.setdefault(str(season), {})[pad4(r["franchise_id"])] = name

    sides: dict[tuple, dict] = {}
    pairing_seasons: set[int] = set()
    for r in schedule:
        season = int(r["season"])
        if season > through:
            continue
        fid, opp = pad4(r["franchise_id"]), pad4(r["opponent_franchise_id"])
        ts, os_ = r.get("team_score"), r.get("opponent_score")
        if ts is None or os_ is None:
            problems.append(f"{season} wk{r['week']} {fid}-{opp}: missing score")
            continue
        po = int(r.get("is_playoff") or 0)
        if po not in (0, 1):
            problems.append(f"{season} wk{r['week']} {fid}-{opp}: bad is_playoff {r.get('is_playoff')!r}")
            continue
        if po == 0:
            pairing_seasons.add(season)
        key = (season, int(r["week"]), min(fid, opp), max(fid, opp))
        sides.setdefault(key, {})[fid] = (round(float(ts), 2), round(float(os_), 2), po)

    games = []
    for (season, week, lo, hi), by in sorted(sides.items()):
        if lo not in by or hi not in by:
            problems.append(f"{season} wk{week} {lo}-{hi}: only one side's row")
            continue
        (lts, los, lpo), (hts, hos, hpo) = by[lo], by[hi]
        if lts != hos or los != hts or lpo != hpo:
            problems.append(f"{season} wk{week} {lo}-{hi}: the two rows disagree")
            continue
        for f in (lo, hi):
            if f not in owners.get(str(season), {}):
                problems.append(f"{season} {f}: in a game but has no owner")
        games.append([season, week, lo, hi, lts, los, lpo])

    if problems:
        print("Refusing to build h2h_history.json:", file=sys.stderr)
        for p in problems[:25]:
            print("  " + p, file=sys.stderr)
        raise SystemExit(1)

    return {
        "built_from": source_note,
        "through_season": through,
        "regular_season_pairings": sorted(pairing_seasons),
        "owners": owners,
        "columns": ["season", "week", "franchise_id", "opponent_franchise_id", "franchise_score", "opponent_score", "is_playoff"],
        "games": games,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--schedule", required=True, type=Path)
    ap.add_argument("--franchises", required=True, type=Path)
    ap.add_argument("--through", required=True, type=int, help="last finished season to include")
    ap.add_argument("--source-note", required=True, help="where and when the two exports were read")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    a = ap.parse_args()
    out = build(rows_of(a.schedule), rows_of(a.franchises), a.through, a.source_note)
    a.out.write_text(json.dumps(out, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"wrote {a.out}: {len(out['games'])} games, seasons {min(map(int, out['owners']))}-{a.through}")


if __name__ == "__main__":
    main()
