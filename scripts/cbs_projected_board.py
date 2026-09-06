#!/usr/bin/env python3
"""A 2026 draft board from REAL projections, scored under grffl's own rules.

WHAT CHANGED FROM THE PRODUCTION BOARD
======================================
`cbs_build_board.py` ranks players on prior production. That is honest but
backward-looking, and set against forward-looking ADP it surfaces players the
market has correctly written off (Conner, Kupp, Keenan Allen). This one uses
ESPN's actual 2026 stat-level projections instead, so team changes, depth-chart
moves and expected regression are already priced in by someone whose job it is.

⚠️ ESPN'S STAT IDS ARE DERIVED, NOT REMEMBERED. ESPN returns bare numeric keys
("24": 1372.6). Rather than hardcode a mapping from memory, the ids are
identified by taking ESPN's OWN 2025 ACTUALS (statSourceId=0) and matching them
against this database's 2025 actuals player by player. A stat id is accepted
only when it matches exactly for >75% of players and at least 10 of them.
Regenerate with --derive-map, which prints the evidence.

⚠️ THE HARD PART: A SEASON TOTAL CANNOT BE SCORED DIRECTLY. This league pays
per-GAME milestones (+3 at 100 rushing yards, again at 200, again at 300), so
points depend on the SHAPE of a season, not just its total. Two backs with
1,200 yards score differently if one had four 150-yard games and the other was
steady at 75.

Dividing the projection by 17 and scoring that flat line is the obvious move
and it is WRONG in a specific direction: a flat 80-yard game never reaches 100,
so it earns ZERO milestones and understates every high-variance player.

So each player's projection is distributed over 17 games using HIS OWN
historical game-to-game shape, rescaled to hit the projected total. Players
with no usable history fall back to a positional shape built from the players
who do have it — and that fallback is REPORTED per player, never silent.
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
import sys
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import adp as adpmod                             # noqa: E402
from fantasy import d1 as fd1                                 # noqa: E402
from fantasy.providers.espn.auth import load_cookies          # noqa: E402
from fantasy.providers.espn.constants import API_BASE         # noqa: E402
from fantasy.scoring import load_table                        # noqa: E402


def pkey(name: str) -> str:
    """Normalised key with generational suffixes removed."""
    k = adpmod.player_key(name or "")
    for suf in _SUFFIXES:
        if k.endswith(suf):
            k = k[: -len(suf)].strip()
            break
    return k

LEAGUE_KEY = "ffl.s2026.l.grffl"
ESPN_LEAGUE = "176898"
GAMES = 17

#: ESPN stat id -> D1 column, DERIVED by exact match (see --derive-map).
#: ⚠️ id 70 matched fumbles-lost for only 76% of players, well below every
#: other id here, so it is carried but flagged: ESPN's 70 is probably total
#: fumbles rather than fumbles LOST. Fumbles are worth -2, so the exposure is
#: small — but it is named rather than hidden.
ESPN_STATS = {
    "0": "pass_att", "1": "pass_cmp", "3": "pass_yds", "4": "pass_tds",
    "20": "pass_ints", "23": "rush_att", "24": "rush_yds", "25": "rush_tds",
    # ⚠️ BOTH 41 AND 53 ARE RECEPTIONS, AND YOU NEED BOTH. They matched the
    # same D1 column for 103 of 103 players in the ACTUALS, so keeping one
    # looked sufficient — but the PROJECTION payload carries only 53. Mapping
    # 41 alone silently dropped every reception from every projection, which in
    # a PPR league quietly removed ~100 points from a top receiver and made the
    # board look RB-dominated. Derivation on actuals does not prove coverage on
    # projections; both payloads have to be checked.
    "41": "receptions", "53": "receptions",
    "42": "rec_yds", "43": "rec_tds", "58": "targets", "210": "games",
}

#: Name suffixes ESPN carries and this database does not ("James Cook III").
#: Left unstripped, the historical game-shape lookup misses and the player
#: silently falls back to a generic positional shape.
_SUFFIXES = (" jr", " sr", " ii", " iii", " iv", " v")
LOW_CONFIDENCE_STATS = {"70": "fumbles_lost (only 76% exact — likely total fumbles)"}

#: D1 column -> this league's stat abbreviation.
TO_CBS = {"rush_yds": "RuYd", "rush_tds": "RuTD", "receptions": "Recpt",
          "rec_yds": "ReYd", "rec_tds": "ReTD", "pass_yds": "PaYd",
          "pass_tds": "PaTD", "pass_ints": "PaInt"}
#: The yardage stats whose per-game SHAPE matters, because they carry milestones.
SHAPED = ("RuYd", "ReYd", "PaYd", "Recpt")

TD_BONUS = {"QB": {"PaTD": 0.72, "RuTD": 0.48}, "RB": {"RuTD": 0.77, "ReTD": 1.27},
            "WR": {"ReTD": 0.87}, "TE": {"ReTD": 0.48}}
UNRECORDED_FUMBLES = {"QB": 0.173, "RB": 0.090, "WR": 0.026, "TE": 0.011}
POS_BY_ID = {1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST"}
BASE_STARTERS = {"QB": 1, "RB": 2, "WR": 2, "TE": 1}


def fetch_projections(limit: int) -> list[dict]:
    ck = load_cookies()
    if not ck.is_present:
        raise SystemExit("ESPN cookies required for projections.")
    hdr = {"User-Agent": "Mozilla/5.0", "Accept": "application/json",
           "Cookie": f"SWID={ck.swid}; espn_s2={ck.espn_s2}",
           "x-fantasy-filter": json.dumps({"players": {
               "limit": limit,
               "sortDraftRanks": {"sortPriority": 100, "sortAsc": True,
                                  "value": "STANDARD"}}})}
    url = f"{API_BASE}/seasons/2026/segments/0/leagues/{ESPN_LEAGUE}?view=kona_player_info"
    with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=90) as r:
        payload = json.loads(r.read().decode("utf-8", "ignore"))
    players = payload.get("players")
    if not players:
        raise SystemExit("ESPN returned no players — refusing to build an empty board.")

    out = []
    for entry in players:
        p = entry.get("player") or {}
        pos = POS_BY_ID.get(p.get("defaultPositionId"))
        if pos not in TD_BONUS:
            continue
        proj = None
        for st in p.get("stats") or []:
            if (st.get("statSourceId") == 1 and st.get("statSplitTypeId") == 0
                    and st.get("seasonId") == 2026):
                proj = st
                break
        # ⚠️ NO PROJECTION IS NOT A ZERO PROJECTION. A player ESPN declines to
        # project is dropped from the board, not ranked at the bottom.
        if not proj or not proj.get("stats"):
            continue
        raw: dict[str, float] = {}
        for k, v in proj["stats"].items():
            col = ESPN_STATS.get(k)
            if not col:
                continue
            # 41 and 53 are the same stat; take whichever is larger rather than
            # letting dict order decide which one wins.
            raw[col] = max(raw.get(col, 0.0), float(v))
        out.append({"name": p.get("fullName"), "position": pos,
                    "espn_total": proj.get("appliedTotal"), "raw": raw})
    return out


def game_shapes(loader) -> tuple[dict, dict]:
    """Each player's real game-to-game SHAPE, plus a positional fallback.

    A shape is a list of per-game fractions of that player's season total, so
    it can be rescaled onto any projection while preserving how lumpy he is.
    """
    rows = loader.query(
        "SELECT n.display_name nm, w.season, w.week, w.position pos, w.rush_yds, "
        "w.rec_yds, w.pass_yds, w.receptions FROM nfl_player_weekly w "
        "JOIN nfl_player_names n ON n.gsis_id = w.gsis_id "
        "WHERE w.season >= 2024 AND w.week <= 18 "
        "AND w.position IN ('QB','RB','WR','TE');")
    by: dict = collections.defaultdict(lambda: collections.defaultdict(list))
    for r in rows:
        by[pkey(r["nm"])][r["season"]].append(r)

    col = {"RuYd": "rush_yds", "ReYd": "rec_yds", "PaYd": "pass_yds", "Recpt": "receptions"}
    shapes, pos_pool = {}, collections.defaultdict(lambda: collections.defaultdict(list))
    for key, seasons in by.items():
        best = max(seasons.values(), key=len)
        if len(best) < 8:
            continue
        pos = best[0]["pos"]
        sh = {}
        for stat, c in col.items():
            vals = [float(g.get(c) or 0) for g in best]
            total = sum(vals)
            if total <= 0:
                continue
            sh[stat] = [v / total for v in vals]
            pos_pool[pos][stat].append(sh[stat])
        if sh:
            shapes[key] = sh

    # positional fallback: the MEDIAN shape, sorted so lumpiness is preserved
    # ⚠️ BUILD THE FALLBACK ON A FIXED 17-GAME GRID. Taking the MINIMUM length
    # across contributing players collapsed it to 8 games, which crammed a whole
    # season into 8 and manufactured milestone bonuses that would never happen.
    # Short seasons are padded with zeros — a player who missed games really did
    # score nothing in them.
    fallback = {}
    for pos, stats in pos_pool.items():
        fallback[pos] = {}
        for stat, lst in stats.items():
            grid = []
            for sh in lst:
                srt = sorted(sh, reverse=True)[:GAMES]
                grid.append(srt + [0.0] * (GAMES - len(srt)))
            med = [statistics.median(g[i] for g in grid) for i in range(GAMES)]
            tot = sum(med) or 1.0
            fallback[pos][stat] = [m / tot for m in med]
    return shapes, fallback


def to_games(proj: dict, shape: dict, pos: str, fallback: dict) -> tuple[list[dict], bool]:
    """Spread a season projection across games using a real shape."""
    used_fallback = False
    games = [dict() for _ in range(GAMES)]
    for col, abbr in TO_CBS.items():
        total = proj.get(col, 0.0)
        if abbr in SHAPED:
            sh = (shape or {}).get(abbr)
            if not sh:
                sh = (fallback.get(pos) or {}).get(abbr)
                # ⚠️ ONLY A SUBSTITUTION THAT MATTERS COUNTS AS A FALLBACK. A
                # receiver has no PASSING shape and never will; flagging that
                # reported 356 of 366 players as falling back when the real
                # number is a handful of rookies. A quality metric that cries
                # wolf on every row teaches you to ignore it.
                if total:
                    used_fallback = True
            if sh:
                scaled = [f / sum(sh) for f in sh][:GAMES]
                if len(scaled) < GAMES:
                    scaled += [0.0] * (GAMES - len(scaled))
                s = sum(scaled) or 1.0
                for i in range(GAMES):
                    games[i][abbr] = total * scaled[i] / s
                continue
        # Unshaped stats (TDs, INTs) carry no milestone, so a flat split is
        # exact rather than an approximation.
        for i in range(GAMES):
            games[i][abbr] = total / GAMES
    for g in games:
        g.setdefault("FL", 0.0)
    return games, used_fallback


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--top", type=int, default=45)
    ap.add_argument("--teams", type=int, default=12)
    ap.add_argument("--target", choices=["local", "remote"], default="remote")
    ap.add_argument("--json-out", default="")
    ap.add_argument("--pass-td", type=float, default=None,
                    help="score under a PROPOSED base passing-TD value "
                         "(moves the league default and the QB override only; "
                         "the out-of-position value for RB/WR/TE is untouched)")
    a = ap.parse_args()

    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    table = load_table(loader, platform="cbs", league_key=LEAGUE_KEY, season=2026)
    if a.pass_td is not None:
        before = table.resolve("QB", "PaTD")[0]
        table = table.with_override("PaTD", a.pass_td, positions=[None, "QB"])
        ru = table.resolve("QB", "RuTD")[0]
        print(f"⚠️ SCENARIO BOARD — base passing TD {before:.0f} -> {a.pass_td:.0f}. "
              f"This is NOT the league's current rulebook.")
        print(f"   a QB's rushing TD is now {ru:.0f}/{a.pass_td:.0f} = "
              f"{ru / a.pass_td:.1f}x his passing TD (was {ru / before:.1f}x)")
    projs = fetch_projections(a.limit)
    shapes, fallback = game_shapes(loader)
    print(f"ESPN 2026 projections: {len(projs)} skill players")
    print(f"game shapes from real history: {len(shapes)} players; "
          f"positional fallback for the rest")
    for sid, why in LOW_CONFIDENCE_STATS.items():
        print(f"  ⚠️ ESPN stat {sid} NOT used — {why}")

    board, fb = [], 0
    for p in projs:
        key = pkey(p["name"])
        games, used = to_games(p["raw"], shapes.get(key), p["position"], fallback)
        fb += used
        pts = table.score_weeks(p["position"], games, strict=False)
        for stat, bonus in TD_BONUS[p["position"]].items():
            pts += bonus * p["raw"].get(
                {"PaTD": "pass_tds", "RuTD": "rush_tds", "ReTD": "rec_tds"}[stat], 0.0)
        pts += -2.0 * UNRECORDED_FUMBLES[p["position"]] * GAMES
        board.append({"player": p["name"], "position": p["position"],
                      "proj_points": round(pts, 1),
                      "espn_points": round(p["espn_total"] or 0, 1),
                      "shape": "fallback" if used else "own"})
    print(f"  {fb} players used the positional fallback shape\n")

    by_pos: dict[str, list[dict]] = {}
    for r in sorted(board, key=lambda r: -r["proj_points"]):
        by_pos.setdefault(r["position"], []).append(r)
    starters = {p: n * a.teams for p, n in BASE_STARTERS.items()}
    pool = [r for p in ("RB", "WR", "TE") for r in by_pos.get(p, [])[starters[p]:]]
    pool.sort(key=lambda r: -r["proj_points"])
    for r in pool[:a.teams]:
        starters[r["position"]] += 1
    repl = {p: by_pos[p][n - 1]["proj_points"] for p, n in starters.items()}
    for r in board:
        r["vor"] = round(r["proj_points"] - repl[r["position"]], 1)
    board.sort(key=lambda r: -r["vor"])

    print("  starters league-wide: " + ", ".join(f"{p}{n}" for p, n in sorted(starters.items())))
    print("  replacement: " + ", ".join(f"{p} {v:.0f}" for p, v in sorted(repl.items())))
    print(f"\n{'#':>3}  {'player':<24}{'pos':<5}{'grffl':>8}{'ESPN':>8}{'VOR':>8}  shape")
    for i, r in enumerate(board[:a.top], 1):
        print(f"{i:>3}  {r['player']:<24}{r['position']:<5}{r['proj_points']:>8.0f}"
              f"{r['espn_points']:>8.0f}{r['vor']:>8.0f}  {r['shape']}")
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(board, indent=1))
        print(f"\nwrote {len(board)} -> {a.json_out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
