#!/usr/bin/env python3
"""Pick-by-pick comparison of two owners' draft histories.

WHY A HEAD-TO-HEAD AND NOT A LEADERBOARD. The per-owner table says chuck
shcoolcraft is +349 points a season over slot and Keith is -56. That is a
result, not an explanation — it does not say WHERE the ~400-point gap comes
from, and the three candidate answers call for completely different fixes:

  * ROUND    — one of them wins the early rounds and the other the late ones
  * POSITION — a structural preference (waiting on QB, chasing TE)
  * HIT RATE — same strategy, better player evaluation

This splits the gap those three ways.

⚠️ WHAT THE POINTS MEAN. `total_fantasy_points` in the draft payload is what
the PLAYER scored that season under this league's scoring — not what he scored
FOR THE TEAM THAT DREW HIM. A player cut in week 3 still carries his full
season. So this measures DRAFT-DAY judgment and nothing else: it cannot see
waivers, trades, or lineup decisions, and it will flatter an owner who drafted
well and managed badly.

⚠️ CBS STOPPED SERVING DRAFT-PAGE POINTS AFTER 2023. The draft-results table
carried "Total Fpts"/"Active Fpts" columns through 2023 and DROPPED them in
2024 — 7 header cells became 5. So `total_fantasy_points` is NULL for all 432
picks in 2024-2025, and any outcome analysis reading only the draft payload is
silently running on three seasons while appearing to run on five. (It did.)

Those seasons are recovered here from CBS's own STATS pages
(/stats/stats-main/all:<POS>/<YEAR>), which still publish each player's season
total under this league's scoring. That source is TOP-100-PER-POSITION, so deep
picks stay unpriced — reported per season, never silently zero-filled.

⚠️ 'ABOVE SLOT' IS RELATIVE TO THIS LEAGUE, NOT TO ADP. The benchmark is the
MEDIAN points the whole league actually got from that round, so it already
absorbs the fact that later rounds return less. A pick beats its slot by
out-producing what the other eleven owners got from the same round that year.
"""
from __future__ import annotations

import argparse
import collections
import itertools
import json
import re
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import adp as adpmod                          # noqa: E402
from fantasy import d1 as fd1                              # noqa: E402
from fantasy.providers.cbs.auth import load_cookies        # noqa: E402
from fantasy.providers.cbs.client import CbsClient         # noqa: E402
from fantasy.providers.cbs.stats import season_points_by_player   # noqa: E402

PLATFORM = "cbs"
#: The last season whose draft page still carried the fantasy-points columns.
LAST_SEASON_WITH_DRAFT_POINTS = 2023
STATS_POSITIONS = ("QB", "RB", "WR", "TE")


def stats_points(season: int, league_id: str = "grffl") -> dict[str, float]:
    return season_points_by_player(
        CbsClient(load_cookies(), min_interval_sec=0.6), season, league_id,
        positions=STATS_POSITIONS, key_fn=adpmod.player_key)

def owner_label(loader, slug: str, seasons: list[int]) -> str:
    """'<manager> (<franchise>)' for a franchise slug, read from D1.

    Names every manager who ran it in the window rather than picking one, so a
    franchise that changed hands is visibly two people instead of silently one.
    """
    from fantasy.providers.cbs.constants import team_key      # noqa: PLC0415
    rows = loader.query(
        "SELECT t.team_name, m.display_name, tm.season FROM fantasy_team_managers tm "
        "JOIN fantasy_managers m ON m.manager_uid = tm.manager_uid "
        "AND m.platform = tm.platform "
        "JOIN fantasy_teams t ON t.team_key = tm.team_key AND t.platform = tm.platform "
        f"WHERE tm.platform = '{PLATFORM}';")
    names, franchise = set(), None
    for r in rows:
        if not r.get("team_name") or not r.get("display_name"):
            continue
        if team_key(2000, "grffl", r["team_name"]).split(".t.")[-1] != slug:
            continue
        franchise = r["team_name"]
        if int(r["season"]) in seasons:
            names.add(r["display_name"])
    if not names:
        # ⚠️ Never fall back to the slug dressed up as a person's name.
        return f"(owner unknown) [{slug}]"
    return f"{' / '.join(sorted(names))} ({franchise})"


def load(loader):
    rows = loader.query(
        "SELECT season, pick_number, round_number, team_key, "
        "player_position_at_draft pos, raw_pick_json FROM fantasy_draft_events "
        f"WHERE platform = '{PLATFORM}' ORDER BY season, pick_number;")
    out = []
    for r in rows:
        raw = r["raw_pick_json"]
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = {}
        raw = raw or {}
        out.append({**r, "name": raw.get("player_name"),
                    "pts": raw.get("total_fantasy_points"),
                    "slug": r["team_key"].split(".t.")[-1]})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", default="bayou-billy", help="franchise slug A")
    ap.add_argument("--b", default="raining-bullets", help="franchise slug B")
    # ⚠️ LABELS ARE RESOLVED FROM D1, NOT TYPED IN. Hand-written labels are how
    # five seasons of Corey Smith's picks ended up displayed under the name of
    # the person who took over his franchise slot in 2026. The owner who
    # actually ran a franchise is a fact in fantasy_team_managers now, so it is
    # read rather than asserted. --label-* remain as overrides only.
    ap.add_argument("--label-a", default=None)
    ap.add_argument("--label-b", default=None)
    ap.add_argument("--teams", type=int, default=12)
    ap.add_argument("--rounds", type=int, default=18)
    ap.add_argument("--target", choices=["local", "remote"], default="remote")
    a = ap.parse_args()

    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    picks = load(loader)
    seasons = sorted({p["season"] for p in picks})
    label_a = a.label_a or owner_label(loader, a.a, seasons)
    label_b = a.label_b or owner_label(loader, a.b, seasons)
    a.label_a, a.label_b = label_a, label_b

    # ── recover the seasons CBS stopped publishing on the draft page ─────────
    need = sorted({p["season"] for p in picks
                   if p["pts"] is None and p["season"] > LAST_SEASON_WITH_DRAFT_POINTS})
    for yr in need:
        table = stats_points(yr)
        got = miss = 0
        for p in picks:
            if p["season"] != yr or p["pts"] is not None:
                continue
            hit = table.get(adpmod.player_key(p["name"] or ""))
            if hit is None:
                miss += 1
            else:
                p["pts"] = hit
                got += 1
        print(f"  {yr}: draft page carries no points (CBS dropped the columns "
              f"after {LAST_SEASON_WITH_DRAFT_POINTS}); recovered {got} of "
              f"{got + miss} from the stats pages, {miss} unpriced "
              f"(outside the top 100 at their position)")
    if need:
        print()
    have = {p["slug"] for p in picks}
    for slug in (a.a, a.b):
        if slug not in have:
            raise SystemExit(f"no picks for franchise {slug!r}; known: {sorted(have)}")

    # Benchmark: the league's own median return from each (season, round).
    med: dict[tuple[int, int], float] = {}
    for (yr, rnd), grp in itertools.groupby(
            sorted(picks, key=lambda p: (p["season"], p["round_number"])),
            key=lambda p: (p["season"], p["round_number"])):
        vals = [float(p["pts"]) for p in grp if p["pts"] is not None]
        if vals:
            med[(yr, rnd)] = statistics.median(vals)

    A = [p for p in picks if p["slug"] == a.a]
    B = [p for p in picks if p["slug"] == a.b]

    def above(p):
        m = med.get((p["season"], p["round_number"]))
        return None if (m is None or p["pts"] is None) else float(p["pts"]) - m

    # ── 1. side by side, round by round, per season ──────────────────────────
    print(f"PICK-BY-PICK — {a.label_a}  vs  {a.label_b}")
    print("(pts = what that player scored that season under this league's "
          "scoring; ± = vs the league median for the same round)\n")
    for yr in seasons:
        ay = {p["round_number"]: p for p in A if p["season"] == yr}
        by = {p["round_number"]: p for p in B if p["season"] == yr}
        ta = sum(x for x in (above(p) for p in ay.values()) if x is not None)
        tb = sum(x for x in (above(p) for p in by.values()) if x is not None)
        print(f"── {yr}   {a.label_a} {ta:+.0f}   |   {a.label_b} {tb:+.0f}")
        print(f"{'rd':>3}  {'':<26}{'pos':<4}{'pts':>6}{'±':>7}   "
              f"{'':<26}{'pos':<4}{'pts':>6}{'±':>7}")
        for rnd in range(1, a.rounds + 1):
            pa, pb = ay.get(rnd), by.get(rnd)
            if not pa and not pb:
                continue

            def cell(p):
                if not p:
                    return f"{'—':<26}{'':<4}{'':>6}{'':>7}"
                d = above(p)
                # ⚠️ An unpriced pick shows as '—', never as 0. A kicker CBS
                # does not publish is not a kicker who scored nothing.
                pts = f"{p['pts']:>6.0f}" if p["pts"] is not None else f"{'—':>6}"
                return (f"{(p['name'] or '?')[:25]:<26}{p['pos'] or '?':<4}"
                        f"{pts}{(f'{d:+.0f}' if d is not None else '—'):>7}")
            print(f"{rnd:>3}  {cell(pa)}   {cell(pb)}")
        print()

    # ── 2. where the gap comes from: ROUND ───────────────────────────────────
    print("WHERE THE GAP COMES FROM — BY ROUND (summed over all seasons)")
    print(f"{'rounds':<10}{a.label_a:>24}{a.label_b:>26}{'gap':>9}")
    buckets = [("1-3", 1, 3), ("4-6", 4, 6), ("7-9", 7, 9),
               ("10-12", 10, 12), ("13-18", 13, 18)]
    for lbl, lo, hi in buckets:
        va = sum(x for x in (above(p) for p in A if lo <= p["round_number"] <= hi)
                 if x is not None)
        vb = sum(x for x in (above(p) for p in B if lo <= p["round_number"] <= hi)
                 if x is not None)
        print(f"{lbl:<10}{va:>+24.0f}{vb:>+26.0f}{va - vb:>+9.0f}")

    # ── 3. by POSITION ───────────────────────────────────────────────────────
    print("\nBY POSITION — picks taken, and points above slot")
    print(f"{'pos':<6}{'A n':>5}{'A ±':>9}{'B n':>6}{'B ±':>9}{'gap':>9}")
    for pos in ("QB", "RB", "WR", "TE", "K", "DST"):
        pa = [p for p in A if p["pos"] == pos]
        pb = [p for p in B if p["pos"] == pos]
        va = sum(x for x in (above(p) for p in pa) if x is not None)
        vb = sum(x for x in (above(p) for p in pb) if x is not None)
        if not pa and not pb:
            continue
        print(f"{pos:<6}{len(pa):>5}{va:>+9.0f}{len(pb):>6}{vb:>+9.0f}{va - vb:>+9.0f}")

    # ── 4. HIT RATE, which separates strategy from evaluation ────────────────
    print("\nHIT RATE — share of picks that beat the league median for their round")
    for lbl, lst in ((a.label_a, A), (a.label_b, B)):
        d = [x for x in (above(p) for p in lst) if x is not None]
        hits = sum(1 for x in d if x > 0)
        big = sum(1 for x in d if x > 100)
        bust = sum(1 for x in d if x < -50)
        print(f"  {lbl:<26} {hits}/{len(d)} ({100*hits/len(d):.0f}%)   "
              f"100+ hits: {big:>2}   busts (-50 or worse): {bust:>2}   "
              f"median {statistics.median(d):+.0f}")

    # ── 5. the individual picks that moved it ────────────────────────────────
    print("\nBIGGEST SWINGS")
    for lbl, lst in ((a.label_a, A), (a.label_b, B)):
        ranked = sorted(((above(p), p) for p in lst if above(p) is not None),
                        key=lambda t: -t[0])
        print(f"  {lbl}")
        for d, p in ranked[:3]:
            print(f"      +{d:>5.0f}  {p['season']} rd{p['round_number']:<3} "
                  f"{p['name']} ({p['pos']})")
        for d, p in ranked[-2:]:
            print(f"      {d:>6.0f}  {p['season']} rd{p['round_number']:<3} "
                  f"{p['name']} ({p['pos']})")

    # ── 6. when each takes each position ─────────────────────────────────────
    print("\nFIRST PICK AT EACH POSITION (mean round across seasons)")
    print(f"{'':<26}{'QB':>6}{'RB':>6}{'WR':>6}{'TE':>6}")
    for lbl, lst in ((a.label_a, A), (a.label_b, B)):
        cells = []
        for pos in ("QB", "RB", "WR", "TE"):
            rs = [min((p["round_number"] for p in lst
                       if p["season"] == y and p["pos"] == pos), default=None)
                  for y in seasons]
            rs = [r for r in rs if r]
            cells.append(f"{statistics.mean(rs):>6.1f}" if rs else f"{'—':>6}")
        print(f"{lbl:<26}" + "".join(cells))
    return 0


if __name__ == "__main__":
    sys.exit(main())
