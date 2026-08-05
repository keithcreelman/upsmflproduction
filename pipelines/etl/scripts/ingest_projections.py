#!/usr/bin/env python3
"""Capture MFL weekly player projections into D1.

    python pipelines/etl/scripts/ingest_projections.py --season 2026 --week 5
    python pipelines/etl/scripts/ingest_projections.py --current      # infer the week
    python pipelines/etl/scripts/ingest_projections.py --current --dry-run

WHY THIS EXISTS
    MFL serves projections LIVE and never stores them. "Actual vs projected" --
    the most-requested missing piece in the weekly recaps -- is therefore
    unrecoverable for any past week. It is only unrecoverable BACKWARDS, so this
    starts the record now.

    Projections move all week as news lands, so this is meant to run repeatedly.
    `projected_score` is always the newest value; `first_projected` keeps the
    earliest sighting, because the movement is itself a story worth telling.

HONESTY
    A row captured after the games were played is whatever MFL happens to be
    serving now, NOT what was on screen during the week. first_captured_at makes
    that checkable instead of assumed -- see migration 0123.

FAILURE MODES, AND WHY THEY ARE NOT SILENT
    This runs unattended on a cron, so "wrote nothing" must never look like
    "worked". Three distinct outcomes, three distinct exit codes:

      * OUTSIDE THE CAPTURE WINDOW (deep offseason) -> exit 0, loud log.
        Expected and uninteresting; there is genuinely nothing to capture.
      * INSIDE the window but MFL returned ZERO usable rows -> exit 1.
        A week that should have projections and does not is a real failure.
      * The payload could not be READ at all (no `projectedScores` key) -> exit 1
        with the observed top-level keys.

    That last split is the point: an unreadable input is NEVER an empty one.
    The original version returned 0 for all three, so a broken proxy or a
    changed MFL response shape would have shown a green cron run forever while
    the table quietly stopped accumulating.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORKER_DIR = os.path.join(REPO, "worker")
D1_NAME = "ups-mfl-db"
WORKER_BASE = "https://upsmflproduction.keith-creelman.workers.dev"
LEAGUE_ID = "74598"

LAST_WEEK = 17           # UPS fantasy weeks; the NFL's week 18 is not scored
CAPTURE_OPENS_MONTH = 8  # August -- MFL serves camp projections from ~here


def week1_thursday(season):
    d = datetime(int(season), 9, 4, tzinfo=timezone.utc)
    while d.weekday() != 3:
        d += timedelta(days=1)
    return d


def resolve(season=None, week=None):
    """(season, week, basis) for right now. A fantasy week runs Thursday to Thursday.

    `basis` records WHY this week was chosen and is always logged. The previous
    version fell through to a bare `(now.year, 1)` for any date outside a live
    season, which is right during camp and wrong in February -- and said nothing
    either way. Now a February run resolves to "closed" and exits instead of
    silently upserting into next season's week 1 for seven months, inflating
    capture_count and overwriting `first_projected` with a placeholder. That
    matters because `first_projected` is the whole point of the table: it is
    supposed to be the earliest MEANINGFUL sighting, not the earliest cron tick.
    """
    now = datetime.now(timezone.utc)
    if season and week:
        return int(season), int(week), "explicit"

    for s in ([int(season)] if season else [now.year, now.year - 1]):
        start = week1_thursday(s)
        if now < start:
            continue
        wk = int((now - start).days // 7) + 1
        if 1 <= wk <= LAST_WEEK:
            return s, wk, "in-season"

    # Not inside any season's weeks 1..LAST_WEEK. Camp counts -- capturing week 1
    # repeatedly from August to kickoff is exactly the movement we want -- but
    # the deep offseason does not.
    s = int(season) if season else now.year
    if datetime(s, CAPTURE_OPENS_MONTH, 1, tzinfo=timezone.utc) <= now < week1_thursday(s):
        return s, 1, "preseason"
    return s, None, "closed"


def fetch(season, week):
    url = ("%s/api/mfl-export?TYPE=projectedScores&L=%s&YEAR=%d&W=%d&JSON=1"
           % (WORKER_BASE, LEAGUE_ID, int(season), int(week)))
    req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-projections"})
    with urllib.request.urlopen(req, timeout=60) as r:
        payload = json.loads(r.read().decode("utf-8"))

    # UNREADABLE IS NOT EMPTY. If the shape changed or the proxy handed back an
    # error document, refuse -- do not report zero projections and carry on.
    if not isinstance(payload, dict) or "projectedScores" not in payload:
        raise SystemExit(
            "unreadable projectedScores payload for %s wk%s -- top-level keys: %s"
            % (season, week,
               sorted(payload)[:12] if isinstance(payload, dict) else type(payload).__name__))

    scores = (payload.get("projectedScores") or {}).get("playerScore") or []
    if isinstance(scores, dict):
        scores = [scores]
    out = {}
    for row in scores:
        pid = str(row.get("id") or "").strip()
        try:
            val = float(row.get("score"))
        except (TypeError, ValueError):
            continue
        if pid:
            out[pid] = val
    return out


def _rows_from(stdout):
    """Parse wrangler --json. It prints a banner first, and ANSI escapes contain
    '[', so seek the first '[' that actually decodes rather than the first one."""
    i = 0
    while True:
        j = stdout.find("[", i)
        if j < 0:
            return []
        try:
            data, _ = json.JSONDecoder().raw_decode(stdout[j:])
            return (data[0] or {}).get("results", []) if data else []
        except ValueError:
            i = j + 1


def _wrangler(args):
    p = subprocess.run(["npx", "wrangler", "d1", "execute", D1_NAME, "--remote"] + args,
                       cwd=WORKER_DIR, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("D1 call failed: %s" % (p.stderr or p.stdout)[:400])
    return p.stdout


def d1_file(sql):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False, encoding="utf-8") as f:
        f.write(sql)
        path = f.name
    try:
        _wrangler(["--file", path])
    finally:
        os.unlink(path)


def d1_count(season, week):
    out = _wrangler(["--json", "--command",
                     "SELECT COUNT(*) n, MAX(capture_count) cc FROM ups_player_projections "
                     "WHERE season=%d AND week=%d;" % (int(season), int(week))])
    rows = _rows_from(out)
    return (rows[0].get("n"), rows[0].get("cc")) if rows else (None, None)


def main():
    ap = argparse.ArgumentParser(description="Capture MFL weekly projections")
    ap.add_argument("--season", type=int)
    ap.add_argument("--week", type=int)
    ap.add_argument("--current", action="store_true", help="infer season/week from today")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    season, week, basis = resolve(args.season, args.week)

    if week is None:
        # Deep offseason. Genuinely nothing to capture -- not a failure, but say
        # so plainly so a run of green ticks is never mistaken for data landing.
        print("season %s: OUTSIDE the capture window (basis=%s). "
              "Opens %d-%02d-01, closes after week %d. Nothing captured."
              % (season, basis, season, CAPTURE_OPENS_MONTH, LAST_WEEK))
        return 0

    print("season %d week %d (basis=%s)" % (season, week, basis))
    proj = fetch(season, week)
    now = int(datetime.now(timezone.utc).timestamp())
    print("  %d projection(s) returned" % len(proj))

    if not proj:
        # Inside the window and MFL gave us nothing usable -> that is a failure.
        raise SystemExit(
            "REFUSING: 0 usable projections for %d wk%d while INSIDE the capture "
            "window. MFL answered but no row carried a numeric score. Not writing, "
            "and not exiting clean -- a silent no-op here would stall the record "
            "without anyone noticing." % (season, week))

    for pid, v in sorted(proj.items(), key=lambda kv: -kv[1])[:5]:
        print("   %-8s %.1f" % (pid, v))

    if args.dry_run:
        print("(dry run -- nothing written)")
        return 0

    # UPSERT: keep the newest projection, preserve the earliest sighting, and
    # count captures so a single-capture week is distinguishable from a tracked
    # one. first_projected/first_captured_at are deliberately NOT in the UPDATE
    # set -- they must survive every later capture.
    rows = []
    for pid, val in sorted(proj.items()):
        rows.append("(%d,%d,'%s',%f,%f,%d,%d,1)"
                    % (season, week, pid.replace("'", "''"), val, val, now, now))

    written = 0
    for i in range(0, len(rows), 400):
        chunk = rows[i:i + 400]
        d1_file(
            "INSERT INTO ups_player_projections "
            "(season, week, player_id, projected_score, first_projected, "
            "first_captured_at, updated_at, capture_count) VALUES "
            + ",".join(chunk) +
            " ON CONFLICT(season, week, player_id) DO UPDATE SET "
            "projected_score = excluded.projected_score, "
            "updated_at = excluded.updated_at, "
            "capture_count = ups_player_projections.capture_count + 1;")
        written += len(chunk)

    # Read back. A clean wrangler exit means the statement ran, not that the rows
    # are there -- and "write failed" and "could not confirm the write" are
    # different claims. Report the one that is true.
    n, cc = d1_count(season, week)
    if n is None:
        print("sent %d projection(s); COULD NOT CONFIRM (read-back failed)" % written)
        return 1
    if n < written:
        raise SystemExit("REFUSING to report success: sent %d rows but D1 holds "
                         "%d for %d wk%d" % (written, n, season, week))
    print("stored %d projection(s); D1 now holds %d for %d wk%d (capture #%s)"
          % (written, n, season, week, cc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
