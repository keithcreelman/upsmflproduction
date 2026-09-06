#!/usr/bin/env python3
"""Backfill CBS draft history into fantasy_drafts / fantasy_draft_events.

⚠️ SEASON RANGE IS PROBED, NOT ASSUMED. CBS's own season dropdown starts at
2013 — but 2007, 2008, 2010, 2011 and 2012 all serve real drafts anyway. The
dropdown is a UI affordance, not a statement about what exists. 2005/2006/2009
genuinely return nothing and are recorded as gaps, not as failures.
"""
from __future__ import annotations

import argparse, sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import d1 as fd1                                    # noqa: E402
from fantasy.providers.cbs.auth import load_cookies              # noqa: E402
from fantasy.providers.cbs.client import CbsClient, CbsFetchError  # noqa: E402
from fantasy.providers.cbs.parse import parse_draft_results      # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-id", default="grffl")
    ap.add_argument("--start", type=int, default=2007)
    ap.add_argument("--end", type=int, default=2026)
    ap.add_argument("--target", choices=["local", "remote"], default="local")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    client = CbsClient(load_cookies(), min_interval_sec=0.6)
    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=a.dry_run, verbose=False)

    drafts, events, gaps, failures = [], [], [], []
    for yr in range(a.start, a.end + 1):
        try:
            html = client.fetch_draft_results(yr, a.league_id)
        except CbsFetchError as e:
            failures.append((yr, str(e)[:70])); print(f"  {yr}: FETCH FAILED — {str(e)[:60]}"); continue
        try:
            t = parse_draft_results(html, season=yr, league_id=a.league_id)
        except ValueError:
            # A season with no draft page is a GAP, not an error — recorded so
            # a later reader can tell "we looked and there was nothing" apart
            # from "we never looked".
            gaps.append(yr); print(f"  {yr}: no draft data (gap)"); continue
        ev = t["fantasy_draft_events"]; d = t["fantasy_drafts"][0]
        fr = len({e['team_key'] for e in ev if e['team_key']})
        drafts += t["fantasy_drafts"]; events += ev
        print(f"  {yr}: {len(ev):>3} picks | {d['num_rounds']:>2} rounds | {fr} franchises")

    print(f"\nparsed {len(events)} picks across {len(drafts)} seasons "
          f"(gaps: {gaps or 'none'}, failures: {len(failures)})")
    if failures:
        print("REFUSING to write — a fetch failure means the picture is incomplete:")
        for yr, e in failures: print(f"   {yr}: {e}")
        return 1
    if not events:
        print("REFUSING to write — zero picks parsed is never a successful backfill.")
        return 1
    if a.dry_run:
        print("dry-run: nothing written"); return 0

    n1 = loader.write_rows("fantasy_drafts", drafts)
    n2 = loader.write_rows("fantasy_draft_events", events)
    print(f"wrote fantasy_drafts={n1}  fantasy_draft_events={n2}  -> {a.target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
