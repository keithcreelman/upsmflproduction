#!/usr/bin/env python3
"""Prospect / player PROFILE static JSON for the Stats Workbench.

Source : nflreadpy (nflverse mirrors) — three datasets, no DB / wrangler / R:
  - load_players()      : gsis_id, display_name, position, birth_date -> AGE,
                          draft_year / draft_round / draft_pick (OVERALL) / draft_team,
                          rookie_season (entry year for undrafted), pfr_id, weight.
  - load_draft_picks()  : authoritative draft board 1980+ (season, round, pick=OVERALL,
                          team) — carries gsis_id directly, so it's the PRIMARY draft
                          join; load_players() draft_* fields are the fallback. The full
                          board also converts overall pick -> pick-WITHIN-round for the
                          fantasy-style "R1.08" display (comp picks make round sizes vary,
                          so we rank within the (season, round) group instead of doing
                          32*(round-1) arithmetic).
  - load_combine()      : forty / vertical / broad_jump / bench / cone / shuttle + wt.
                          Joined by pfr_id first (players.pfr_id <-> combine.pfr_id),
                          then by normalized name + draft-class year (combine.draft_year
                          or combine.season vs players.draft_year or rookie_season);
                          ambiguous name+year keys are skipped, join hits are reported.

Output : site/stats_workbench/prospect_profile.json — one row per player keyed by
  gsis_id: { gsis_id, name, pos, age, draft_year, draft_cap, draft_round, draft_pick,
  forty, vert, broad, bench, cone, shuttle, speed_score }.
  - age        : years as of TODAY, 1 decimal (birth_date -> today / 365.25).
  - draft_cap  : "R<round>.<pick-in-round 2-digit> '<yy>" (e.g. "R1.08 '23");
                 undrafted -> "UDFA '<yy>" using entry year (draft_year or rookie_season).
  - draft_pick : OVERALL selection number (numeric sort key for the workbench).
  - speed_score: classic Barnwell speed score for RB/WR/TE = weight*200 / forty^4,
                 using combine weight (falling back to players weight).
  Included: anyone with a gsis_id AND at least age or draft/entry info.
Written compact (no indent) — ~25k rows; GitHub Pages gzips it anyway.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from bisect import bisect_right
from datetime import date
from pathlib import Path

SPEED_SCORE_POS = {"RB", "FB", "HB", "WR", "TE"}
_SUFFIX_RE = re.compile(r"\s+(jr|sr|ii|iii|iv|v)\.?$")


def norm_name(n: str | None) -> str:
    """lowercase, strip punctuation + Jr/Sr/II… suffixes, collapse spaces."""
    s = (n or "").lower().replace(".", "").replace("'", "").replace("-", " ")
    s = _SUFFIX_RE.sub("", s.strip())
    return " ".join(s.split())


def fnum(v) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f


def rnd(v, nd: int) -> float | int | None:
    f = fnum(v)
    if f is None:
        return None
    r = round(f, nd)
    return int(r) if nd == 0 else r


def age_years(birth: str | None, today: date) -> float | None:
    """birth 'YYYY-MM-DD' -> age in years, 1 decimal, as of today."""
    if not birth:
        return None
    try:
        y, m, d = (int(x) for x in str(birth)[:10].split("-"))
        b = date(y, m, d)
    except (ValueError, TypeError):
        return None
    return round((today - b).days / 365.25, 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="site/stats_workbench/prospect_profile.json")
    args = ap.parse_args()

    try:
        import nflreadpy as nfl
    except Exception as e:  # noqa: BLE001
        print(f"[profile] nflreadpy unavailable: {e}", file=sys.stderr)
        return 1

    players = nfl.load_players().to_dicts()
    draft = nfl.load_draft_picks().to_dicts()
    combine = nfl.load_combine().to_dicts()
    print(f"[profile] players cols contain draft fields: "
          f"{sorted(k for k in players[0] if 'draft' in k or k in ('birth_date', 'rookie_season', 'pfr_id'))}",
          file=sys.stderr)
    print(f"[profile] draft_picks cols: season/round/pick(overall)/team/gsis_id present="
          f"{all(k in draft[0] for k in ('season', 'round', 'pick', 'team', 'gsis_id'))}", file=sys.stderr)
    print(f"[profile] combine cols: {sorted(k for k in combine[0] if k in ('pfr_id', 'cfb_id', 'draft_year', 'season', 'forty', 'vertical', 'broad_jump', 'bench', 'cone', 'shuttle', 'wt'))}",
          file=sys.stderr)
    print(f"[profile] {len(players)} players / {len(draft)} draft picks / {len(combine)} combine rows",
          file=sys.stderr)

    # --- draft board: gsis join + (season, round) -> sorted overall picks (for pick-in-round)
    draft_by_gsis: dict[str, dict] = {}
    board: dict[tuple[int, int], list[int]] = {}
    for r in draft:
        season, rd, pk = r.get("season"), r.get("round"), r.get("pick")
        if season is None or rd is None or pk is None:
            continue
        board.setdefault((int(season), int(rd)), []).append(int(pk))
        gid = r.get("gsis_id")
        if gid and gid not in draft_by_gsis:
            draft_by_gsis[gid] = r
    for picks in board.values():
        picks.sort()

    def pick_in_round(season: int, rd: int, overall: int) -> int:
        picks = board.get((season, rd))
        if picks:
            return bisect_right(picks, overall)  # rank within the round
        return max(1, overall - 32 * (rd - 1))  # ancient seasons off the board

    # --- combine lookups: pfr_id primary, normalized name + class year fallback
    comb_by_pfr: dict[str, dict] = {}
    comb_by_namey: dict[tuple[str, int], dict | None] = {}  # None = ambiguous
    for r in combine:
        pfr = r.get("pfr_id")
        if pfr and pfr not in comb_by_pfr:
            comb_by_pfr[pfr] = r
        yr = r.get("draft_year") or r.get("season")
        nm = norm_name(r.get("player_name"))
        if nm and yr is not None:
            key = (nm, int(yr))
            comb_by_namey[key] = None if key in comb_by_namey else r

    today = date.today()
    out: list[dict] = []
    hits_pfr = hits_name = misses = 0
    for p in players:
        gid = p.get("gsis_id")
        if not gid:
            continue
        entry_year = p.get("draft_year") or p.get("rookie_season")
        age = age_years(p.get("birth_date"), today)
        if age is None and entry_year is None:
            continue  # no age AND no draft/entry info -> nothing to profile

        # draft capital: draft_picks (by gsis) first, players draft_* fallback
        dp = draft_by_gsis.get(gid)
        if dp:
            season, rd, overall = int(dp["season"]), int(dp["round"]), int(dp["pick"])
        elif p.get("draft_round") is not None and p.get("draft_pick") is not None and p.get("draft_year"):
            season, rd, overall = int(p["draft_year"]), int(p["draft_round"]), int(p["draft_pick"])
        else:
            season = rd = overall = None
        if rd is not None:
            draft_cap = f"R{rd}.{pick_in_round(season, rd, overall):02d} '{season % 100:02d}"
            draft_year = season
        else:
            draft_year = int(entry_year) if entry_year is not None else None
            draft_cap = f"UDFA '{draft_year % 100:02d}" if draft_year is not None else None

        # combine
        c = comb_by_pfr.get(p.get("pfr_id") or "")
        if c is not None:
            hits_pfr += 1
        elif entry_year is not None:
            c = comb_by_namey.get((norm_name(p.get("display_name")), int(entry_year)))
            if c is not None:
                hits_name += 1
        if c is None:
            misses += 1
            c = {}

        pos = (p.get("position") or "").upper()
        forty = fnum(c.get("forty"))
        weight = fnum(c.get("wt")) or fnum(p.get("weight"))
        speed_score = None
        if pos in SPEED_SCORE_POS and forty and forty > 0 and weight:
            speed_score = round(weight * 200 / forty ** 4, 1)

        out.append({
            "gsis_id": gid,
            "name": p.get("display_name"),
            "pos": pos or None,
            "age": age,
            "draft_year": draft_year,
            "draft_cap": draft_cap,
            "draft_round": rd,
            "draft_pick": overall,  # OVERALL selection (sort key)
            "forty": rnd(forty, 2),
            "vert": rnd(c.get("vertical"), 1),
            "broad": rnd(c.get("broad_jump"), 0),
            "bench": rnd(c.get("bench"), 0),
            "cone": rnd(c.get("cone"), 2),
            "shuttle": rnd(c.get("shuttle"), 2),
            "speed_score": speed_score,
        })

    print(f"[profile] combine join: {hits_pfr} by pfr_id + {hits_name} by name+year "
          f"= {hits_pfr + hits_name} matched / {misses} without combine data", file=sys.stderr)

    out.sort(key=lambda r: (-(r["draft_year"] or 0), r["draft_pick"] or 9999, r["name"] or ""))
    payload = {
        "source": "nflverse via nflreadpy: load_players + load_draft_picks + load_combine",
        "metric": "player profile — age (as of build date), NFL draft capital (R<rd>.<pick-in-round> 'yy / UDFA 'yy; draft_pick=overall), combine forty/vert/broad/bench/cone/shuttle, Barnwell speed score (RB/WR/TE, combine weight)",
        "as_of": today.isoformat(),
        "count": len(out),
        "players": out,
    }
    op = Path(args.out)
    op.parent.mkdir(parents=True, exist_ok=True)
    with op.open("w") as fh:
        json.dump(payload, fh, separators=(",", ":"))
        fh.write("\n")
    print(f"[profile] wrote {len(out)} players → {op}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
