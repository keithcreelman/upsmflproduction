#!/usr/bin/env python3
"""Backfill CBS league history — 23 seasons of records AND per-season managers.

Reads /history/team-overview/<ID> for every franchise the league has ever had,
retired ones included, and writes season standings plus the manager who ran each
franchise that year.

⚠️ WHY THIS MATTERS MORE THAN THE RECORDS. Every other CBS surface names
FRANCHISES and never PEOPLE, so owner continuity across seasons previously had
to be taken on somebody's word. This page states it. In Keith's league it
confirmed that all twelve 2021-2025 franchises had exactly ONE manager each,
and identified the franchise missing from 2026 (history id 14) and the person
who ran it — a record that had been provisionally attributed to the incoming
owner of that slot.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import d1 as fd1                                   # noqa: E402
from fantasy.providers.cbs.auth import load_cookies             # noqa: E402
from fantasy.providers.cbs.client import CbsClient, CbsFetchError  # noqa: E402
from fantasy.providers.cbs import history as H                  # noqa: E402

BASE = "https://{lid}.football.cbssports.com"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--league-id", default="grffl")
    ap.add_argument("--target", choices=["local", "remote"], default="local")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--xwalk-from", type=int, default=2021)
    ap.add_argument("--xwalk-to", type=int, default=2025)
    a = ap.parse_args()

    client = CbsClient(load_cookies(), min_interval_sec=0.5)
    base = BASE.format(lid=a.league_id)
    ids = H.franchise_ids(client.get_html(f"{base}/history"))
    print(f"{len(ids)} franchises have existed in this league: {ids}\n")

    hist, empty, failed = {}, [], []
    for tid in ids:
        try:
            rows = H.parse_team_overview(
                client.get_html(f"{base}/history/team-overview/{tid}"), tid)
        except (CbsFetchError, H.CbsHistoryError) as e:
            failed.append((tid, str(e)[:70]))
            continue
        if not rows:
            # A franchise with no rows is REAL — a slot created this season.
            empty.append(tid)
            continue
        hist[tid] = rows
        mg = sorted({r["manager"] for r in rows if r["manager"] not in ("", "-")})
        print(f"  id {tid:>4}: {len(rows):>2} seasons "
              f"{min(r['season'] for r in rows)}-{max(r['season'] for r in rows)}  "
              f"managers: {', '.join(mg)[:52]}")
    if empty:
        print(f"\n  no history (new franchise slots): {empty}")
    if failed:
        # ⚠️ A page we could not read is NOT a franchise with no history.
        print("\nREFUSING to write — some franchises could not be read, and an "
              "unreadable page is not an empty one:")
        for tid, e in failed:
            print(f"   {tid}: {e}")
        return 1

    # ⚠️ RECONCILE AGAINST THE API'S REAL GUIDs, or the same person is stored
    # twice — once per identifier space — and every career query halves him.
    loader_ro = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                             worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    known = {}
    for r in loader_ro.query(
            "SELECT manager_uid, display_name FROM fantasy_managers "
            "WHERE platform = 'cbs' AND manager_uid NOT LIKE 'name:%';"):
        if r.get("display_name"):
            known[H.manager_key(r["display_name"])] = r["manager_uid"]
    print(f"reconciling against {len(known)} manager GUIDs already known from the API")
    # Bind franchise NAMES to history ids via the standings' season records —
    # the only surface carrying both. Seasons chosen to overlap the drafts.
    st = {}
    for yr in range(a.xwalk_from, a.xwalk_to + 1):
        try:
            st[yr] = H.parse_standings_names(
                client.get_html(f"{base}/standings/overall/{yr}"))
        except CbsFetchError:
            continue
    names_by_id = {tid: nm for nm, tid in H.crosswalk(hist, st).items()}
    print(f"crosswalk: {len(names_by_id)} franchise names bound to history ids "
          f"from {a.xwalk_from}-{a.xwalk_to} standings")
    t = H.to_rows(hist, league_id=a.league_id, known_managers=known,
                  names_by_id=names_by_id)
    matched = sum(1 for m in t["fantasy_managers"] if not m["manager_uid"].startswith("name:"))
    print(f"  {matched} of {len(t['fantasy_managers'])} managers matched a real GUID; "
          f"the rest predate the API and keep a name-derived id")
    print(f"\nparsed {sum(len(v) for v in hist.values())} franchise-seasons -> "
          + ", ".join(f"{k}={len(v)}" for k, v in t.items()))

    # Manager continuity, stated rather than assumed.
    by_team: dict[str, set] = {}
    for link in t["fantasy_team_managers"]:
        by_team.setdefault(link["team_key"].split(".t.")[-1], set()).add(link["manager_uid"])
    changed = {k: v for k, v in by_team.items() if len(v) > 1}
    print(f"franchises whose manager CHANGED at some point: "
          f"{sorted(changed) if changed else 'none'}")

    # ⚠️ AUDIT BEFORE WRITING, EVERY RUN — not only in the test suite. This
    # pipeline has shipped phantom columns twice; the cost of checking here is
    # one regex pass over the migrations, and the cost of not checking is a
    # silent partial write.
    import re as _re
    ddl = "\n".join(f.read_text(encoding="utf-8")
                     for f in sorted((REPO / "worker" / "migrations").glob("0*.sql"))
                     if f.name >= "0127")
    real: dict[str, set] = {}
    for tbl, body in _re.findall(
            r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\n\);", ddl, _re.S):
        cols = set()
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            m = _re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s+", line)
            if m and m.group(1).upper() not in (
                    "PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"):
                cols.add(m.group(1))
        real[tbl] = cols
    for tbl, col in _re.findall(
            r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+([a-zA-Z_][a-zA-Z0-9_]*)", ddl, _re.I):
        real.setdefault(tbl, set()).add(col)
    problems = []
    for tbl, rows in t.items():
        extra = sorted({k for r in rows for k in r} - real.get(tbl, set()))
        if extra:
            problems.append(f"{tbl}: phantom columns {extra}")
        for c in fd1.PRIMARY_KEYS[tbl]:
            if any(r.get(c) in (None, "") for r in rows):
                problems.append(f"{tbl}: empty primary-key column {c!r}")
    if problems:
        print("REFUSING to write — the rows do not match the schema:")
        for pr in problems:
            print("   " + pr)
        return 1
    print("schema audit: no phantom columns, every primary key populated")

    if a.dry_run:
        print("dry-run: nothing written")
        return 0
    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)
    for table, rows in t.items():
        n = loader.write_rows(table, rows)
        print(f"  wrote {n:>4} -> {table} ({a.target})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
