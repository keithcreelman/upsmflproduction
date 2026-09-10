#!/usr/bin/env python3
"""What was available on the CBS waiver wire, reconstructed by subtraction.

CBS serves NO transaction data — the /transactions page is a JS shell with no
player data in the HTML, and every API spelling 404s. So the waiver wire cannot
be observed directly.

It can, however, be RECOVERED. Two things are known for each season:
  * every player who was DRAFTED (216 picks, from the draft-results pages)
  * every player who FINISHED in CBS's top 100 at his position, with his season
    points under this league's own scoring (from the stats pages)

Whatever is in the second set and not the first was available to anyone, all
season, for nothing but a waiver claim. That is a floor on what the wire held —
a floor, not a total, because CBS publishes only the top 100 per position.

⚠️ IT IS A FLOOR IN THE OTHER DIRECTION TOO. A player who went undrafted and
finished 40th at his position may have been claimed in week 2 and held all year,
or churned between four rosters. Without transactions this cannot distinguish
"available" from "available and taken early". It measures the SUPPLY of value
outside the draft, which is the question worth answering before a draft anyway.
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import adp as adpmod                                # noqa: E402
from fantasy import d1 as fd1                                    # noqa: E402
from fantasy.providers.cbs.auth import load_cookies              # noqa: E402
from fantasy.providers.cbs.client import CbsClient               # noqa: E402
from fantasy.providers.cbs.stats import (                        # noqa: E402
    _Tables, parse_stats_table)
import re                                                        # noqa: E402

POSITIONS = ("QB", "RB", "WR", "TE")


def stats_page(client, pos: str, season: int, league_id: str) -> list[tuple[str, float]]:
    html = client.get_html(
        f"https://{league_id}.football.cbssports.com/stats/stats-main/all:{pos}/{season}")
    _, rows = parse_stats_table(html)
    tb = _Tables()
    tb.feed(html)
    hi = next(i for i, r in enumerate(tb.rows)
              if len(r) > 10 and r and r[0].strip().lower() == "action")
    names = []
    for row in tb.rows:
        if len(row) != len(tb.rows[hi]):
            continue
        low = [c.strip().lower() for c in row[:3]]
        if "action" in low or "totals" in low:
            continue
        if len(row) < 3 or not row[2] or not re.search(r"[A-Za-z]", row[2]):
            continue
        names.append(re.split(r"\s+[A-Z/]{1,4}\s*•", row[2])[0].strip())
    if len(names) != len(rows):
        raise SystemExit(f"{pos} {season}: {len(names)} names vs {len(rows)} rows")
    return [(n, float(r["y"])) for n, r in zip(names, rows) if r["y"]]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-id", default="grffl")
    ap.add_argument("--seasons", default="2021,2022,2023,2024,2025")
    ap.add_argument("--top", type=int, default=8)
    a = ap.parse_args()
    seasons = [int(s) for s in a.seasons.split(",")]

    loader = fd1.D1Loader(target="remote", db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    ev = loader.query(
        "SELECT season, round_number rd, player_position_at_draft pos, raw_pick_json "
        "FROM fantasy_draft_events WHERE platform = 'cbs';")
    drafted: dict[int, set] = collections.defaultdict(set)
    for e in ev:
        raw = e["raw_pick_json"]
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = {}
        nm = (raw or {}).get("player_name")
        if nm:
            drafted[e["season"]].add(adpmod.player_key(nm))

    client = CbsClient(load_cookies(), min_interval_sec=0.6)
    print("VALUE AVAILABLE OUTSIDE THE DRAFT — CBS grffl\n")
    print(f"{'season':<8}{'pos':<5}{'in top100':>10}{'UNDRAFTED':>11}{'%':>5}"
          f"{'best undrafted':>26}{'pts':>7}{'posRk':>7}")
    tally = collections.Counter()
    starters = {"QB": 12, "RB": 28, "WR": 31, "TE": 13}   # league-wide starters
    startable = collections.Counter()
    for season in seasons:
        for pos in POSITIONS:
            board = stats_page(client, pos, season, a.league_id)
            board.sort(key=lambda t: -t[1])
            und = [(n, p, i + 1) for i, (n, p) in enumerate(board)
                   if adpmod.player_key(n) not in drafted[season]]
            if not und:
                continue
            tally[pos] += len(und)
            # how many undrafted players finished inside STARTER range?
            startable[pos] += sum(1 for _, _, rk in und if rk <= starters[pos])
            n, p, rk = und[0]
            print(f"{season:<8}{pos:<5}{len(board):>10}{len(und):>11}"
                  f"{100*len(und)/len(board):>4.0f}%{n[:24]:>26}{p:>7.0f}{rk:>7}")
    print(f"\nUNDRAFTED players finishing inside LEAGUE-STARTER range "
          f"(QB{starters['QB']}/RB{starters['RB']}/WR{starters['WR']}/TE{starters['TE']}):")
    for pos in POSITIONS:
        per = startable[pos] / len(seasons)
        print(f"   {pos}: {startable[pos]} over {len(seasons)} seasons "
              f"= {per:.1f} per season")
    print(f"\n   total startable-quality players available for free: "
          f"{sum(startable.values())/len(seasons):.1f} per season, "
          f"across {sum(tally.values())} undrafted top-100 finishes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
