"""Restore the FULL league salaries table after a partial import blanked it.

WHY THIS EXISTS
    2026-08-22: a one-player salaries import wiped contract fields on 502
    players. MFL's `import?TYPE=salaries` REPLACES the entire <leagueUnit> —
    it does not patch the rows you send. Any player you omit is blanked.

    The prior script guarded that every ATTRIBUTE was present on the single
    row it wrote. That is the wrong axis. The rule is: every PLAYER the league
    has must appear in every salaries import, always.

    Verification failed the same way: it re-read only the row it had written
    and reported success while 502 others sat empty. So the post-write check
    here is a COUNT, not a spot-check.

Usage:  ci_restore_salaries.py <payload.json> [--apply]
        Default is dry-run. Nothing is written without --apply.
"""
import json, os, sys, urllib.parse, urllib.request

LEAGUE, SEASON = "74598", "2026"
FIELDS = ("salary", "contractYear", "contractStatus", "contractInfo")
MIN_ROWS = 500          # league carries ~503; anything less means a truncated payload
MAX_UNCORROBORATED = 10 # rows the independent snapshot could not confirm


def esc(v):
    return (str(v).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def complete_rows(players):
    return [p for p in players
            if str(p.get("salary") or "").strip()
            and str(p.get("contractStatus") or "").strip()]


def read_live():
    url = (f"https://www48.myfantasyleague.com/{SEASON}/export"
           f"?TYPE=salaries&L={LEAGUE}&JSON=1")
    lu = json.load(urllib.request.urlopen(url, timeout=90))["salaries"]["leagueUnit"]
    return lu["player"] if isinstance(lu, dict) else [x for u in lu for x in u.get("player", [])]


def main(path, apply):
    payload = json.load(open(path))
    rows = payload["rows"]

    # ---- fail-closed guards (an unreadable/short input is never "fine") ----
    if len(rows) < MIN_ROWS:
        print(f"REFUSE: payload has {len(rows)} rows, expected >= {MIN_ROWS}. "
              f"A short payload would blank every omitted player."); return 2
    for r in rows:
        missing = [f for f in FIELDS if not str(r.get(f, "")).strip()]
        if missing:
            print(f"REFUSE: player {r.get('id')} missing {missing}."); return 2
    bad = [r for r in rows if not r.get("_corroborated")]
    if len(bad) > MAX_UNCORROBORATED:
        print(f"REFUSE: {len(bad)} rows uncorroborated by the independent snapshot."); return 2

    live = read_live()
    live_ok = complete_rows(live)
    print(f"LIVE NOW    : {len(live)} rows, {len(live_ok)} with contract data")
    print(f"RESTORING   : {len(rows)} rows ({len(rows)-len(bad)} corroborated, {len(bad)} not)")
    # The property that actually protects the league is "never write FEWER rows
    # than are live" — a short payload blanks the difference. Gating on
    # "live has fewer than the payload" instead would be stricter than needed
    # and makes a content-only backfill (same row count) impossible to apply.
    if len(rows) < len(live_ok):
        print(f"REFUSE: payload has {len(rows)} rows but {len(live_ok)} are live. "
              f"Writing it would blank {len(live_ok)-len(rows)} players."); return 2

    live_by_id = {str(p["id"]): {f: str(p.get(f, "") or "") for f in FIELDS} for p in live_ok}
    diff = [r for r in rows
            if live_by_id.get(str(r["id"])) != {f: str(r.get(f, "") or "") for f in FIELDS}]
    print(f"ROWS DIFFERING FROM LIVE: {len(diff)}")
    for r in diff[:15]:
        cur = live_by_id.get(str(r["id"]))
        print(f"    {r['id']}: {cur.get('contractInfo') if cur else '(absent)'}")
        print(f"       -> {r['contractInfo']}")
    if not diff:
        print("NO-OP: live table already matches the payload exactly. Not writing.")
        return 0

    body = "\n".join(
        f'    <player id="{esc(r["id"])}" salary="{esc(r["salary"])}" '
        f'contractStatus="{esc(r["contractStatus"])}" contractYear="{esc(r["contractYear"])}" '
        f'contractInfo="{esc(r["contractInfo"])}" />' for r in rows)
    xml = f'<salaries>\n  <leagueUnit unit="LEAGUE">\n{body}\n  </leagueUnit>\n</salaries>'
    print(f"XML         : {len(xml)} bytes, {xml.count('<player ')} <player> elements")
    print("SAMPLE      : " + body.strip().splitlines()[0].strip())

    if not apply:
        print("\nDRY RUN — nothing written. Re-run with --apply.")
        return 0

    key = os.environ.get("COMMISH_API_KEY", "")
    if not key:
        print("REFUSE: COMMISH_API_KEY not set."); return 2
    data = urllib.parse.urlencode(
        {"TYPE": "salaries", "L": LEAGUE, "APIKEY": key, "DATA": xml}).encode()
    req = urllib.request.Request(
        f"https://www48.myfantasyleague.com/{SEASON}/import", data=data)
    resp = urllib.request.urlopen(req, timeout=120).read().decode("utf-8", "replace")
    print("\nMFL RESPONSE:", resp.strip()[:400])

    # ---- post-write verification: COUNT, never a spot-check ----
    after_ok = complete_rows(read_live())
    print(f"\nAFTER       : {len(after_ok)} rows with contract data (expected {len(rows)})")
    if len(after_ok) < len(rows):
        print(f"FAILED: {len(rows)-len(after_ok)} rows still blank."); return 1
    print("RESTORED OK — full-count verified.")
    return 0


if __name__ == "__main__":
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    sys.exit(main(a[0], "--apply" in sys.argv))
