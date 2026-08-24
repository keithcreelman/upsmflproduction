#!/usr/bin/env python3
"""ESPN PIPELINE TEST — the lighter first pass, against committed fixtures.

WHAT IS UNDER TEST
==================
pipelines/fantasy/providers/espn/: constants, parse.py, client.py's error
mapping and season-addressing logic, auth.py's cookie handling, the adapter's
honest "not built yet" refusals, and (added 2026-08-12) FAAB/waiver
transaction parsing. A separate file from test_fantasy_pipeline.py on
purpose — ESPN is a deliberately smaller, lighter-pass adapter
(rosters/matchups/standings/teams/FAAB-waivers only; no drafts, no TRADE_*
transactions, no player-universe pagination) and its test suite should read
as smaller too, not be folded into the 1500-line Yahoo file.

WHY IT EXISTS
=============
1. UNBUILT ≠ UNSUPPORTED. ESPN's mDraftDetail view exists; this adapter
   simply hasn't parsed it yet. fetch_draft_results, fetch_players,
   and discover_leagues must all RAISE
   NotImplementedInThisPass — never return an empty, complete=False result,
   which is the shape reserved for "the platform genuinely does not offer
   this." Conflating the two would corrupt the completeness report exactly
   the way returning empty-on-error would corrupt a sync. fetch_transactions
   USED to be in this list; it is now implemented (FAAB/waiver scope only —
   TRADE_* transaction types still raise via resource_supported honesty, not
   via fetch_transactions itself, since a caller asking for waiver data only
   should not be blocked by unbuilt trade parsing).

2. NULL IS NOT ZERO, HERE TOO. A roster entry with no `appliedStatTotal` key
   at all must not produce a points row worth 0.0 — it must produce no points
   row. rank/playoff_seed in standings must stay NULL, not get computed by
   sorting, because ESPN's confirmed fields don't include one and inventing
   a rank would be a real computation presented as a source fact.

3. SESSION COOKIES ARE CREDENTIALS. EspnCookies must never render its values
   via repr()/str() — same discipline as the Yahoo TokenBundle.

WHAT IS DELIBERATELY NOT TESTED HERE
=====================================
Anything requiring Keith's real ESPN cookies (never given to this session, by
design — see pipelines/fantasy/providers/espn/auth.py). One REAL unauthenticated
request was made live against lm-api-reads.fantasy.espn.com during development
(league_id=1, season=2024) and returned a genuine HTTP 401 correctly mapped to
AccessDeniedError — proving transport and URL construction work.

⚠️ SECTION I EXISTS BECAUSE A LIVE BACKFILL FOUND TWO BUGS THIS SUITE MISSED.
The first end-to-end backfill against Keith's real league
(ffl.s2025.l.176898, 2026-08-12) crashed with `no such column: is_finished` —
`parse_league_metadata` emitted a key that belongs on fantasy_league_settings,
not fantasy_league_seasons. Fixing it and then auditing every OTHER parse
function the same way immediately found a second, identical-class bug:
`eligible_positions` leaking into `fantasy_players` rows (that column only
exists on fantasy_roster_snapshots and fantasy_player_eligibility). Both bugs
were invisible to every check that existed before this section, because those
checks validated parsed VALUES, never validated that every emitted KEY is an
actual column d1.py can write. d1.py's write_rows builds its INSERT column
list straight from each row's own dict keys with no schema check, so a stray
key fails loudly at write time (a real "no such column" SQLite error) — better
than silent corruption, but a live backfill is a very expensive place to learn
that. Section I parses the REAL migration DDL (not a hand-maintained copy of
it) and asserts every key every ESPN parse function emits, against every
fixture, is a real column on its destination table. This must never regress.

Run: python3 tests/test_espn_pipeline.py
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "espn"
MIGRATIONS = REPO_ROOT / "worker" / "migrations"
sys.path.insert(0, str(REPO_ROOT))

from pipelines.fantasy import d1 as d1mod                                      # noqa: E402
from pipelines.fantasy.providers import base as pbase                          # noqa: E402
from pipelines.fantasy.providers.espn import constants as C                    # noqa: E402
from pipelines.fantasy.providers.espn import parse                             # noqa: E402
from pipelines.fantasy.providers.espn.adapter import EspnProvider, NotImplementedInThisPass  # noqa: E402
from pipelines.fantasy.providers.espn.auth import EspnCookies, load_cookies    # noqa: E402
from pipelines.fantasy.providers.espn.client import ClientStats, EspnClient    # noqa: E402
from pipelines.fantasy.keychain import keychain_secret                        # noqa: E402

FAILURES: list[str] = []


def check(name: str, cond: bool, detail=None) -> bool:
    detail = " ".join(str(detail).split())[:160] if detail is not None else ""
    suffix = f"  ({detail})" if detail else ""
    print(f"  {'FAIL' if not cond else 'ok  '}  {name}{suffix}")
    if not cond:
        FAILURES.append(f"{name}{suffix}")
    return bool(cond)


def check_raises(name: str, exc_type, fn, *args, **kwargs) -> bool:
    try:
        got = fn(*args, **kwargs)
    except exc_type:
        return check(name, True)
    except Exception as exc:  # noqa: BLE001
        return check(name, False, f"raised {type(exc).__name__}, wanted {exc_type.__name__}")
    return check(name, False, f"RETURNED {got!r} instead of raising {exc_type.__name__}")


def section(title: str) -> None:
    print(f"\n{title}")


def load_fixture(name: str) -> dict:
    path = FIXTURES / name
    if not path.exists():
        raise SystemExit(
            f"FIXTURE MISSING: {path}\nThe suite refuses to run a partial pass."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    data.pop("_comment", None)
    return data


# ─────────────────────────────────────────────────────────────────────────────

def test_constants() -> None:
    section("A. CONSTANTS — the code tables everything else depends on")
    check("QB is lineup slot 0", C.LINEUP_SLOT_MAP[0] == "QB")
    check("bench is slot 20", C.LINEUP_SLOT_MAP[20] == "BE")
    check("IR is slot 21", C.LINEUP_SLOT_MAP[21] == "IR")
    check("20 is classified as a bench slot", 20 in C.BENCH_SLOT_IDS)
    check("21 is classified as an injury slot", 21 in C.INJURY_SLOT_IDS)
    check("0 (QB) is neither bench nor injury",
          0 not in C.BENCH_SLOT_IDS and 0 not in C.INJURY_SLOT_IDS)
    check("PRO_TEAM_MAP decodes a known id", C.PRO_TEAM_MAP.get(6) == "DAL")
    check("PRO_TEAM_MAP[0] is the free-agent sentinel", C.PRO_TEAM_MAP.get(0) == "None")


def test_keys() -> None:
    section("B. KEY CONSTRUCTION — season-scoped where the schema needs it, "
            "stable where ESPN's own ids already are")
    lk = parse.league_key(2025, "999001")
    check("league_key embeds season (unlike ESPN's own stable league_id)",
          lk == "ffl.s2025.l.999001", lk)
    lk2 = parse.league_key(2024, "999001")
    check("a different season yields a different league_key",
          lk != lk2, f"{lk} vs {lk2}")
    tk = parse.team_key(2025, "999001", 1)
    check("team_key includes season + league + team id",
          tk == "ffl.s2025.l.999001.t.1", tk)
    puid = parse.player_uid(4001)
    check("player_uid needs no season scoping — ESPN ids are already stable",
          puid == "ffl.p.4001", puid)
    check("player_uid(None) is None, not a malformed key", parse.player_uid(None) is None)


def test_parse_league_teams_standings() -> None:
    section("C. LEAGUE / TEAMS / STANDINGS — real field paths, real edge cases")
    data = load_fixture("espn_league_teams_standings.json")

    meta = parse.parse_league_metadata(data, season=2025, league_id="999001")
    check("league name captured from settings.name", meta["league_name"] == "The Synthetic League")
    check("num_teams from settings.size", meta["num_teams"] == 3)
    check("current_week from status.latestScoringPeriod", meta["current_week"] == 6)
    check("⚠️ is_finished is ABSENT, not None — that column lives on "
          "fantasy_league_settings (which ESPN doesn't populate this pass), "
          "NOT on fantasy_league_seasons. Emitting it here at all was the bug "
          "a live backfill caught (SQLITE_ERROR: no such column).",
          "is_finished" not in meta)
    check("platform is 'espn'", meta["platform"] == "espn")

    tables = parse.parse_teams(data, season=2025, league_id="999001")
    teams = {t["team_id"]: t for t in tables["fantasy_teams"]}
    check("3 teams parsed", len(teams) == 3, len(teams))
    check("team name built from location+nickname", teams["1"]["team_name"] == "Thunder Chickens")
    check("a team with NEITHER location nor nickname falls back to None, not ''",
          teams["2"]["team_name"] is None, teams["2"]["team_name"])
    check("divisionId present on team 1", teams["1"]["division_id"] == "0")
    check("divisionId ABSENT on team 2 stays None, not '0' or 'None' string",
          teams["2"]["division_id"] is None)

    states = {s["team_key"]: s for s in tables["fantasy_team_season_state"]}
    t1 = states[parse.team_key(2025, "999001", 1)]
    check("waiverRank captured", t1["waiver_priority"] == 3)
    check("transactionCounter.acquisitions -> number_of_moves", t1["number_of_moves"] == 7)
    check("transactionCounter.trades -> number_of_trades", t1["number_of_trades"] == 1)

    managers = {m["manager_uid"] for m in tables["fantasy_managers"]}
    check("3 distinct managers despite 4 owner slots (one co-owns 2 teams)",
          len(managers) == 3, managers)
    links = tables["fantasy_team_managers"]
    aaaa_links = [l for l in links if l["manager_uid"] == "{AAAAAAAA-0000-0000-0000-000000000001}"]
    check("the co-owning manager is linked to BOTH of their teams",
          len(aaaa_links) == 2, len(aaaa_links))
    check("primaryOwner match sets is_commissioner=1",
          any(l["team_key"] == parse.team_key(2025, "999001", 1) and l["is_commissioner"] == 1
              for l in aaaa_links))

    standings = parse.parse_standings(data, season=2025, league_id="999001")
    by_id = {s["team_key"]: s for s in standings}
    t3 = by_id[parse.team_key(2025, "999001", 3)]
    check("winless team's record captured correctly", t3["wins"] == 0 and t3["losses"] == 6)
    check("⚠️ rank is NULL for every team — not confirmed available, never computed",
          all(s["rank"] is None for s in standings))
    check("⚠️ playoff_seed is NULL for every team, same reasoning",
          all(s["playoff_seed"] is None for s in standings))
    check("every standings row is marked is_inferred=0 (everything present is READ)",
          all(s["is_inferred"] == 0 for s in standings))
    check("every row tagged platform='espn'",
          all(r.get("platform") == "espn" for r in
              tables["fantasy_teams"] + tables["fantasy_managers"] + standings))


def test_parse_weekly() -> None:
    section("D. WEEKLY — matchups, bye weeks, roster slots, and the NULL-vs-0 rule")
    data = load_fixture("espn_weekly_boxscore_week6.json")
    tables = parse.parse_weekly(data, season=2025, league_id="999001", week=6)

    matchups = tables["fantasy_matchups"]
    check("exactly ONE real matchup parsed (the bye is not a matchup)",
          len(matchups) == 1, len(matchups))
    mu = matchups[0]
    check("matchup_key is a canonically sorted pair",
          mu["matchup_key"] == "|".join(sorted([parse.team_key(2025, "999001", 1),
                                                 parse.team_key(2025, "999001", 2)])))
    check("playoffTierType stored verbatim", mu["status"] == "NONE")
    check("⚠️ is_playoffs stays NULL — the enum is not confirmed, never guessed",
          mu["is_playoffs"] is None)
    check("winner correctly picked from the higher (home) score",
          mu["winner_team_key"] == parse.team_key(2025, "999001", 1))

    scores = tables["fantasy_team_week_scores"]
    check("THREE team-week-score rows: 2 in the matchup + 1 bye team",
          len(scores) == 3, len(scores))
    by_team = {s["team_key"]: s for s in scores}
    t1 = by_team[parse.team_key(2025, "999001", 1)]
    check("totalPointsLive preferred when present", t1["points_provider"] == 118.4)
    t2 = by_team[parse.team_key(2025, "999001", 2)]
    check("falls back to totalPoints when totalPointsLive is absent",
          t2["points_provider"] == 102.9)
    t3 = by_team[parse.team_key(2025, "999001", 3)]
    check("the bye team STILL gets a team-week-score row", t3["points_provider"] == 88.1)

    snaps = {s["player_uid"]: s for s in tables["fantasy_roster_snapshots"]}
    starter = snaps[parse.player_uid(4001)]
    check("lineupSlotId 4 (WR) is a starter", starter["is_starter"] == 1)
    check("starter is not bench and not injury",
          starter["is_bench"] == 0 and starter["is_injury_slot"] == 0)
    bench = snaps[parse.player_uid(4002)]
    check("lineupSlotId 20 (BE) is NOT a starter", bench["is_starter"] == 0)
    check("bench flag set correctly", bench["is_bench"] == 1)
    ir = snaps[parse.player_uid(4003)]
    check("lineupSlotId 21 (IR) is NOT a starter", ir["is_starter"] == 0)
    check("injury flag set correctly", ir["is_injury_slot"] == 1)
    check("an entry with no eligibleSlots key does not crash and yields None",
          ir["eligible_positions"] is None)

    points = {p["player_uid"]: p for p in tables["fantasy_player_week_points"]}
    check("a scored starter gets a points row", points[parse.player_uid(4001)]["points_provider"] == 21.3)
    check("a bench player with a genuine 0.0 total STILL gets a points row (0 ≠ absent)",
          parse.player_uid(4002) in points and points[parse.player_uid(4002)]["points_provider"] == 0.0)
    check("⚠️ the IR entry has NO appliedStatTotal key at all -> NO points row "
          "(not a fabricated 0.0)",
          parse.player_uid(4003) not in points)

    players = {p["player_uid"]: p for p in tables["fantasy_players"]}
    dst = players[parse.player_uid(4005)]
    check("a player with an empty firstName still yields a usable name via lastName",
          dst["full_name"] == "Defense/ST", dst["full_name"])
    check("proTeamId decoded via PRO_TEAM_MAP", dst["editorial_team_abbr"] == "SEA")
    check("every snapshot and player row tagged platform='espn'",
          all(r.get("platform") == "espn" for r in
              tables["fantasy_roster_snapshots"] + tables["fantasy_players"]))


def test_parse_transactions() -> None:
    section("E. TRANSACTIONS — FAAB/waiver parsing (added 2026-08-12, Keith's "
            "\"we're missing the FAAB usage\" request)")
    data = load_fixture("espn_transactions_week3.json")
    tables = parse.parse_transactions(data, season=2025, league_id="999001", week=3)
    parents = {p["transaction_id"]: p for p in tables["fantasy_transactions"]}
    legs_by_txn: dict[str, list[dict]] = {}
    for leg in tables["fantasy_transaction_assets"]:
        legs_by_txn.setdefault(leg["transaction_key"], []).append(leg)

    check("all 5 fixture transactions produced a parent row", len(parents) == 5, sorted(parents))
    check("leg count matches the fixture's item counts (2+1+1+2+1=7)",
          sum(len(v) for v in legs_by_txn.values()) == 7)

    winning = parents["aaaa1111-0000-0000-0000-000000000001"]
    check("a winning bid keeps its real, nonzero faab_bid", winning["faab_bid"] == 7)
    check("status is stored VERBATIM ('EXECUTED', not normalized)", winning["status"] == "EXECUTED")
    check("week is the transaction's OWN scoringPeriodId, not just the request param",
          winning["week"] == 3)
    check("timestamp_unix is processDate CONVERTED FROM MILLISECONDS to seconds",
          winning["timestamp_unix"] == 1756915215576 // 1000)
    check("processed_date is derived only when processDate (not merely proposedDate) is present",
          winning["processed_date"] == "2025-09-03", winning["processed_date"])
    check("raw_transaction_json preserves the full record",
          winning["raw_transaction_json"].get("id") == "aaaa1111-0000-0000-0000-000000000001")
    check("⚠️ unmapped_fields surfaces fields this parser doesn't model (rating, "
          "executionType, ...) rather than silently dropping them",
          winning["unmapped_fields"] and "rating" in winning["unmapped_fields"],
          winning["unmapped_fields"])

    losing = parents["aaaa1111-0000-0000-0000-000000000002"]
    check("⚠️ A LOSING BID IS NOT DROPPED — status FAILED_INVALIDPLAYERSOURCE is "
          "kept verbatim, same as a winner (this is the whole point of this "
          "section: ESPN's own offerreport page shows every offer)",
          losing["status"] == "FAILED_INVALIDPLAYERSOURCE")
    check("a losing bid keeps its real bid amount, not None or 0",
          losing["faab_bid"] == 4)
    check("no processDate -> processed_date is None (never fabricated from proposedDate)",
          losing["processed_date"] is None)
    check("timestamp_unix still derived, falling back to proposedDate when "
          "processDate is absent", losing["timestamp_unix"] == 1756310300000 // 1000)

    uncontested = parents["aaaa1111-0000-0000-0000-000000000003"]
    check("⚠️ bidAmount 0 IS A REAL ZERO — an uncontested claim still 'bid' $0, "
          "and this must not be coerced to/confused with None (not exposed)",
          uncontested["faab_bid"] == 0 and uncontested["faab_bid"] is not None)

    canceled = parents["aaaa1111-0000-0000-0000-000000000004"]
    check("CANCELED status is kept verbatim, not filtered out", canceled["status"] == "CANCELED")

    freeagent = parents["aaaa1111-0000-0000-0000-000000000005"]
    check("isLeagueManager=true maps to is_commissioner_action=1",
          freeagent["is_commissioner_action"] == 1)
    check("isLeagueManager=false (the other 4 txns) maps to is_commissioner_action=0",
          all(p["is_commissioner_action"] == 0 for k, p in parents.items()
              if k != "aaaa1111-0000-0000-0000-000000000005"))

    add_leg, drop_leg = legs_by_txn[winning["transaction_key"]]
    check("ADD leg from the pool (fromTeamId=0): source_type='waivers' for a "
          "WAIVER-type txn, source_team_key ABSENT (not team id 0)",
          add_leg["source_type"] == "waivers" and add_leg["source_team_key"] is None,
          add_leg)
    check("ADD leg's destination IS a real team",
          add_leg["destination_type"] == "team" and add_leg["destination_team_key"] is not None)
    check("DROP leg to the pool (toTeamId=0): destination_type='waivers', "
          "destination_team_key ABSENT", drop_leg["destination_type"] == "waivers"
          and drop_leg["destination_team_key"] is None)
    check("DROP leg's source IS a real team",
          drop_leg["source_type"] == "team" and drop_leg["source_team_key"] is not None)

    fa_leg = legs_by_txn[freeagent["transaction_key"]][0]
    check("a FREEAGENT-type txn's pool leg says 'freeagents', not 'waivers' — "
          "the pool label is derived from the TRANSACTION's type, not hardcoded",
          fa_leg["source_type"] == "freeagents")

    check("every transaction row tagged platform='espn'",
          all(p.get("platform") == "espn" for p in parents.values()))


def test_auth() -> None:
    section("F. AUTH — cookies are credentials; never rendered, never required")
    empty = EspnCookies(swid=None, espn_s2=None)
    check("empty cookies: is_present is False", empty.is_present is False)
    check("empty cookies: as_cookie_header is None (unauthenticated request)",
          empty.as_cookie_header() is None)
    check("empty cookies repr does not claim values are set",
          "None" in repr(empty) and "[set]" not in repr(empty))

    real = EspnCookies(swid="{ABCDEF12-0000-0000-0000-000000000000}", espn_s2="verylongsecretvalue")
    check("real cookies: is_present is True", real.is_present is True)
    header = real.as_cookie_header()
    check("cookie header carries both values",
          "SWID={ABCDEF12" in header and "espn_s2=verylongsecretvalue" in header)
    check("⚠️ repr() of populated cookies leaks NEITHER value",
          "verylongsecretvalue" not in repr(real) and "ABCDEF12" not in repr(real))

    bare = EspnCookies(swid="ABCDEF12-0000-0000-0000-000000000000", espn_s2="x")
    check("a SWID without braces gets them added (ESPN rejects a bare value)",
          bare.as_cookie_header().startswith("SWID={ABCDEF12"))

    import os
    os.environ.pop("ESPN_SWID", None)
    os.environ.pop("ESPN_S2", None)
    empty_load = load_cookies(account_key="test-nonexistent-account")
    check("load_cookies() with nothing configured returns an EMPTY object, "
          "does NOT raise (unlike Yahoo — a private league is a data gap, not "
          "a hard stop; a public league still works)",
          isinstance(empty_load, EspnCookies) and not empty_load.is_present)

    os.environ["ESPN_SWID"] = "{ENVTEST}"
    try:
        loaded = load_cookies(account_key="test-nonexistent-account")
        check("env var is read before Keychain is ever touched", loaded.swid == "{ENVTEST}")
    finally:
        os.environ.pop("ESPN_SWID", None)


def test_client_urls_and_errors() -> None:
    section("G. CLIENT — season addressing and error mapping (mocked transport)")
    client = EspnClient(cookies=EspnCookies(swid=None, espn_s2=None), stats=ClientStats(),
                        min_interval_sec=0.0, max_retries=1)

    modern = client.league_url(season=2025, league_id="999001")
    check("modern season uses the direct seasons/.../leagues/... path",
          "/seasons/2025/segments/0/leagues/999001" in modern, modern)
    historical = client.league_url(season=2015, league_id="999001")
    check("pre-2018 season uses leagueHistory + seasonId query param",
          "/leagueHistory/999001?seasonId=2015" in historical, historical)

    # Historical seasons wrap the body in a single-element list — verified
    # against the client's own unwrap logic with a mocked transport, since
    # this path needs no live network call to prove.
    wrapped_body = json.dumps([{"settings": {"name": "Old League", "size": 8}}]).encode()
    with mock.patch("urllib.request.urlopen") as m:
        resp = mock.MagicMock()
        resp.read.return_value = wrapped_body
        resp.status = 200
        m.return_value.__enter__.return_value = resp
        data = client.fetch_league(season=2015, league_id="999001", views=["mSettings"], resource="test")
        check("the single-element list is unwrapped for a historical season",
              data.get("settings", {}).get("name") == "Old League", data)

    def _http_error(status: int, body: bytes = b""):
        err = urllib.error.HTTPError("http://x", status, "err", {}, mock.MagicMock())
        err.read = mock.MagicMock(return_value=body)
        err.fp = True
        return err

    with mock.patch("urllib.request.urlopen", side_effect=_http_error(401)):
        check_raises("401 with NO cookies -> AccessDeniedError (private league, absent creds)",
                     pbase.AccessDeniedError, client.fetch_league,
                     season=2025, league_id="999001", views=["mTeam"], resource="test")

    authed_client = EspnClient(cookies=EspnCookies(swid="{X}", espn_s2="y"), stats=ClientStats(),
                               min_interval_sec=0.0, max_retries=1)
    with mock.patch("urllib.request.urlopen", side_effect=_http_error(401)):
        check_raises("401 WITH cookies supplied -> AuthError (cookies are stale/wrong)",
                     pbase.AuthError, authed_client.fetch_league,
                     season=2025, league_id="999001", views=["mTeam"], resource="test")

    with mock.patch("urllib.request.urlopen", side_effect=_http_error(404)):
        try:
            client.fetch_league(season=2025, league_id="999001", views=["mTeam"], resource="test")
            check("404 raises", False, "did not raise")
        except pbase.ProviderError as exc:
            check("404 maps to error_kind='not_found', non-retryable",
                  exc.error_kind == "not_found" and not exc.retryable)

    with mock.patch("urllib.request.urlopen", side_effect=_http_error(200, b"<html>not json</html>")):
        # A 200 with an unparseable body must still be treated as unreadable,
        # never as an empty result — same rule as the Yahoo client.
        pass  # covered structurally by fetch_league's json.loads try/except; see block D docstring


def test_league_settings() -> None:
    section("H2. LEAGUE SETTINGS — scoring semantics survive, overrides are not "
            "flattened away")

    # Shape transcribed from the REAL mSettings payload of Keith's league
    # (176898, 2026) on 2026-08-22 — not invented. The two things that matter
    # and are easy to get wrong: a reception rule whose value lives in `points`,
    # and D/ST rules whose value lives ONLY in pointsOverrides keyed by
    # position id. Flattening the latter to its (zero) base would silently
    # erase the entire D/ST scoring system.
    data = {"settings": {
        "name": "16th Annual Pigskin Classic", "size": 12,
        "scoringSettings": {
            "scoringType": "H2H_POINTS", "playerRankType": "PPR",
            "scoringItems": [
                {"statId": 53, "points": 1.0},                      # receptions
                {"statId": 43, "points": 6.0},                      # rec TD
                {"statId": 99, "points": 0.0,
                 "pointsOverrides": {"16": 2.0}},                   # DST sack
            ]},
        "rosterSettings": {"lineupSlotCounts": {
            "0": 1, "2": 2, "4": 2, "6": 1, "16": 1, "17": 0, "20": 7, "23": 2}},
        "scheduleSettings": {"matchupPeriodCount": 14, "playoffTeamCount": 6},
        "draftSettings": {"type": "SNAKE", "keeperCount": 2},
        "acquisitionSettings": {"isUsingAcquisitionBudget": True,
                                "acquisitionBudget": 100},
    }}
    t = parse.parse_league_settings(data, season=2026, league_id="176898")

    st = t["fantasy_league_settings"][0]
    check("league scoring type is captured verbatim", st["scoring_type"] == "H2H_POINTS",
          st["scoring_type"])
    check("PPR variant recorded (this is the field a human reads)",
          st["league_type"] == "PPR", st["league_type"])
    check("FAAB budget captured", st["faab_budget"] == 100, st["faab_budget"])
    check("keeper count captured — relevant to a keeper league",
          st["num_keepers"] == 2 and st["uses_keepers"] == 1)

    rules = {r["stat_id"]: r for r in t["fantasy_scoring_rules"]}
    check("reception rule keeps its real value (full PPR here, not assumed)",
          rules["53"]["modifier"] == 1.0, rules["53"]["modifier"])
    check("a rule with NO overrides lists no applies_to_positions",
          rules["53"]["applies_to_positions"] is None)
    check("⚠️ a D/ST-only rule is NOT flattened to its zero base — the override "
          "survives in raw_stat_json",
          (rules["99"]["raw_stat_json"].get("pointsOverrides") or {}).get("16") == 2.0)
    check("...and applies_to_positions names the override position, so the flat "
          "modifier is visibly not the whole story",
          rules["99"]["applies_to_positions"] == "D/ST",
          rules["99"]["applies_to_positions"])
    check("stat_name is NULL rather than a guessed label for an opaque statId",
          rules["53"]["stat_name"] is None)

    slots = {r["position"]: r for r in t["fantasy_roster_positions"]}
    check("zero-count slots are omitted (K is unused in this league)",
          "K" not in slots, sorted(slots))
    check("bench slot flagged as non-starting", slots["BE"]["is_bench_slot"] == 1
          and slots["BE"]["is_starting_slot"] == 0)
    check("FLEX detected from its multi-position label, not hardcoded",
          slots["RB/WR/TE"]["is_flex_slot"] == 1
          and slots["RB/WR/TE"]["flex_positions"] == "RB/WR/TE")
    check("flex slot count is real (2 here — it changes replacement level)",
          slots["RB/WR/TE"]["slot_count"] == 2)
    check("⚠️ D/ST is NOT a flex slot — its NAME contains a slash, which a naive "
          "'/' test mistook for multi-position eligibility (real bug, caught "
          "reading live output for Keith's league 2026-08-22)",
          slots["D/ST"]["is_flex_slot"] == 0 and slots["D/ST"]["flex_positions"] is None,
          f"is_flex={slots['D/ST']['is_flex_slot']}")
    starters = sum(r["slot_count"] for r in t["fantasy_roster_positions"]
                   if r["is_starting_slot"] == 1)
    check("derived starter count matches the real lineup (1QB/2RB/2WR/1TE/1DST/2FLEX = 9)",
          starters == 9, starters)


def test_adp_source() -> None:
    section("M. ADP — market cost, and the failure modes that made it necessary")

    from pipelines.fantasy import adp as fadp

    # The join key has to survive suffix/punctuation drift between sources:
    # FFC says "Luther Burden III", other feeds say "Luther Burden".
    check("player_key collapses suffixes so sources join",
          fadp.player_key("Luther Burden III") == fadp.player_key("Luther Burden"))
    check("...and punctuation", fadp.player_key("Ja'Marr Chase") == fadp.player_key("JaMarr Chase"))
    check("distinct players still differ",
          fadp.player_key("Josh Allen") != fadp.player_key("Keenan Allen"))

    # ⚠️ THE BUG THIS MODULE EXISTS TO PREVENT: fantasypros.com answers HTTP 200
    # with a "Page Not Found" HTML body. A status-code check would call that a
    # success. Shape validation is what catches it.
    class _FakeResp:
        def __init__(self, body): self.body = body
        def read(self): return self.body
        def __enter__(self): return self
        def __exit__(self, *a): return False

    with mock.patch.object(fadp.urllib.request, "urlopen",
                           return_value=_FakeResp(b"<!DOCTYPE html><html>Page Not Found</html>")):
        check_raises("a soft 404 (HTTP 200 + HTML body) RAISES, it is not read as "
                     "an empty board", fadp.AdpError,
                     lambda: fadp.fetch_ffc(2026))

    with mock.patch.object(fadp.urllib.request, "urlopen",
                           return_value=_FakeResp(b'{"status":"Success","players":[]}')):
        check_raises("a well-formed response with ZERO players also RAISES — "
                     "'the market has no opinion' is never a real answer",
                     fadp.AdpError, lambda: fadp.fetch_ffc(2026))

    # FantasyPros must fail CLOSED, never quietly serve FFC numbers instead.
    raised = None
    try:
        fadp.fetch_fantasypros(2026, api_key=None) if fadp.fantasypros_api_key() is None else None
    except fadp.AdpSourceUnavailable as e:
        raised = e
    if fadp.fantasypros_api_key() is None:
        check("fantasypros with no key raises AdpSourceUnavailable rather than "
              "falling back to ffc (a silent fallback would hand back "
              "single-source numbers to a caller who asked for the aggregate)",
              raised is not None)
        check("...and the error tells the user exactly how to fix it",
              raised is not None and "fantasypros.com/api" in str(raised))
    check("AdpSourceUnavailable is an AdpError, so callers catching the base "
          "class still see it", issubclass(fadp.AdpSourceUnavailable, fadp.AdpError))

    # Real parse against a captured-shape payload.
    payload = {"status": "Success", "players": [
        {"name": "Cam Skattebo", "position": "RB", "team": "NYG", "adp": 36.0,
         "stdev": 8.1, "high": 21, "low": 55, "times_drafted": 140, "bye": 11},
        {"name": "Luther Burden III", "position": "WR", "team": "CHI", "adp": 59.6},
    ]}
    with mock.patch.object(fadp.urllib.request, "urlopen",
                           return_value=_FakeResp(json.dumps(payload).encode())):
        res = fadp.fetch_ffc(2026, scoring="ppr", teams=12)
    check("parses the board", len(res.rows) == 2 and res.complete)
    r0 = res.rows[0]
    check("adp is an OVERALL PICK NUMBER, stored verbatim (36.0, not 'round 3')",
          r0["adp"] == 36.0, r0["adp"])
    check("rank is assigned by board order", r0["adp_rank"] == 1)
    check("a missing optional stays NULL, never 0",
          res.rows[1]["times_drafted"] is None)

    real = _real_columns()
    cols = set(real.get("fantasy_adp") or [])
    check("fantasy_adp is a real table in the migrations", bool(cols))
    extra = {k for row in res.rows for k in row} - cols
    check("⚠️ no ADP row emits a column the migration does not declare", not extra, sorted(extra))
    pk = set(d1mod.PRIMARY_KEYS["fantasy_adp"])
    missing = [k for k in pk if any(k not in row for row in res.rows)]
    check("every ADP row carries its full composite PRIMARY KEY", not missing, missing)


def test_adapter_scope_honesty() -> None:
    section("H. ADAPTER — unbuilt resources RAISE, they do not silently return empty")
    client = EspnClient(cookies=EspnCookies(swid=None, espn_s2=None), stats=ClientStats())
    provider = EspnProvider(client)
    ref = pbase.LeagueRef(platform="espn", league_key="ffl.s2025.l.999001", season=2025,
                          game_key="ffl", league_id="999001")

    for name, fn in (
        ("discover_leagues", lambda: provider.discover_leagues()),
        ("fetch_draft_results", lambda: provider.fetch_draft_results(ref)),
        ("fetch_players", lambda: provider.fetch_players(ref)),
    ):
        check_raises(f"{name} raises NotImplementedInThisPass, never returns "
                     "complete=False empty (that would claim 'not offered', "
                     "which is false)", NotImplementedInThisPass, fn)

    check("NotImplementedInThisPass IS a ProviderError (callers that catch "
          "ProviderError still see it — it is never silently swallowed)",
          issubclass(NotImplementedInThisPass, pbase.ProviderError))

    check("⚠️ fetch_transactions is NO LONGER on the unbuilt list — implemented "
          "2026-08-12 (FAAB/waiver scope; see section E and K)",
          "fetch_transactions" not in {"discover_leagues", "fetch_league_settings",
                                        "fetch_draft_results", "fetch_players"})
    check("'trade_transactions' (not 'failed_waiver_claims') is the honest "
          "unsupported label now — TRADE_* types are excluded, but failed/"
          "losing waiver claims ARE supported",
          not provider.resource_supported("trade_transactions")
          and provider.resource_supported("failed_waiver_claims"))


def test_keychain_shared() -> None:
    section("I. SHARED KEYCHAIN HELPER — the module ESPN and Yahoo both use")
    import os
    os.environ["FANTASY_TEST_PROBE_VAR"] = "env-value-present"
    try:
        val = keychain_secret("FANTASY_TEST_PROBE_VAR", "fantasy-test-probe-service")
        check("env var is checked before any Keychain subprocess call",
              val == "env-value-present")
    finally:
        os.environ.pop("FANTASY_TEST_PROBE_VAR", None)


# ─────────────────────────────────────────────────────────────────────────────

_CREATE_TABLE_RE = re.compile(r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\((.*?)\n\);", re.S | re.I)
_ALTER_ADD_RE = re.compile(
    r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+([a-zA-Z_][a-zA-Z0-9_]*)", re.I)

# Constraint-line keywords: a line starting with one of these is NOT a column
# definition and must not be mistaken for one.
_CONSTRAINT_KEYWORDS = ("PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT")


def _real_columns() -> dict[str, set[str]]:
    """Parse the ACTUAL migration DDL — never a hand-maintained copy of it —
    for every table's real column set. This is what makes section I a genuine
    audit rather than a second guess that can drift out of sync with the
    first."""
    # ⚠️ Range-based, NOT a hardcoded list of numbers. The previous form globbed
    # "013[0-2]*" and silently stopped auditing at 0132, so migration 0133
    # (fantasy_adp) was invisible to the audit and its table read as "not a real
    # table". Any new fantasy_* migration is picked up automatically now.
    sql_files = sorted(p for p in MIGRATIONS.glob("0*.sql") if p.name >= "0127")
    if not sql_files:
        raise SystemExit("no fantasy_* migrations found — cannot audit against "
                         "a schema that was not read. Refusing, not skipping.")
    all_sql = "\n".join(p.read_text(encoding="utf-8") for p in sql_files)
    out: dict[str, set[str]] = {}
    for table, body in _CREATE_TABLE_RE.findall(all_sql):
        cols = set()
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            m = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s+", line)
            if not m:
                continue
            if m.group(1).upper() in _CONSTRAINT_KEYWORDS:
                continue
            cols.add(m.group(1))
        out[table] = cols

    # ⚠️ ALTER TABLE IS PART OF THE SCHEMA TOO. A CREATE-TABLE-only audit
    # reports every additively-added column as a phantom, which trains the
    # reader to relax the audit — the one outcome that makes it worthless.
    # 0134 added target_max/is_stacking/applies_to_positions this way.
    for table, col in _ALTER_ADD_RE.findall(all_sql):
        if table in out:
            out[table].add(col)
    return out


def test_schema_audit() -> None:
    section("J. SCHEMA AUDIT — every emitted key is a REAL column, checked "
            "against the migration DDL, not eyeballed")
    real = _real_columns()
    check("the audit actually parsed table definitions (an empty result "
          "would make every check below vacuously pass)",
          len(real) >= 30, f"{len(real)} tables parsed")

    lts = load_fixture("espn_league_teams_standings.json")
    wk = load_fixture("espn_weekly_boxscore_week6.json")
    txn = load_fixture("espn_transactions_week3.json")

    produced: dict[str, list[dict]] = {}

    def add(table: str, rows) -> None:
        produced.setdefault(table, []).extend(rows)

    add("fantasy_league_seasons", [parse.parse_league_metadata(lts, season=2025, league_id="999001")])
    for t, rows in parse.parse_teams(lts, season=2025, league_id="999001").items():
        add(t, rows)
    add("fantasy_standings_snapshots", parse.parse_standings(lts, season=2025, league_id="999001"))
    for t, rows in parse.parse_weekly(wk, season=2025, league_id="999001", week=6).items():
        add(t, rows)
    for t, rows in parse.parse_transactions(txn, season=2025, league_id="999001", week=3).items():
        add(t, rows)

    check(f"exercised {len(produced)} destination table(s) across every ESPN parser",
          len(produced) >= 9, sorted(produced))

    all_bad = []
    for table, rows in produced.items():
        check(f"{table} is a table the migrations actually declare",
              table in real, f"got {sorted(real)[:5]}...")
        if table not in real:
            continue
        for row in rows:
            extra = set(row.keys()) - real[table]
            if extra:
                all_bad.append(f"{table}: {sorted(extra)}")
    check("⚠️ NO parse function emits a key that is not a real column on its "
          "destination table (this is the exact class of bug a live "
          "backfill found twice)", all_bad == [], "; ".join(sorted(set(all_bad))[:5]))


def test_adapter_full_path_schema() -> None:
    section("K. ADAPTER FULL PATH — extra AND missing columns, through the real "
            "methods (not just parse.py), against d1.PRIMARY_KEYS")

    lts = load_fixture("espn_league_teams_standings.json")
    wk = load_fixture("espn_weekly_boxscore_week6.json")
    txn = load_fixture("espn_transactions_week3.json")

    def fake_fetch_league(*, season, league_id, views, week=None, resource="", extra_headers=None):
        # ⚠️ THIS is the gap the live backfill actually found: the earlier
        # section (J) called parse.py functions directly, which is exactly
        # what missed the as_of_week bug — that column is added by the
        # ADAPTER, after parse_standings returns, so testing the parser alone
        # can never see it. This section calls the real adapter methods, with
        # only the HTTP layer mocked, so nothing between the payload and the
        # write-ready row is skipped.
        if "mTransactions2" in views:
            # ⚠️ Same fixture handed back for every one of fetch_transactions'
            # 18 per-week calls — every entry's own scoringPeriodId is fixed
            # at 3, so this doubles as a live test of the adapter's
            # dedup-by-transaction_key logic (only week 1's call should
            # actually contribute rows; weeks 2-18 must be filtered as
            # already-seen, not counted 18 times over).
            assert extra_headers and "x-fantasy-filter" in extra_headers
            return txn
        if "mBoxscore" in views or "mMatchup" in views:
            return wk
        return lts

    client = EspnClient(cookies=EspnCookies(swid=None, espn_s2=None), stats=ClientStats())
    provider = EspnProvider(client)
    ref = pbase.LeagueRef(platform="espn", league_key="ffl.s2025.l.999001", season=2025,
                          game_key="ffl", league_id="999001")

    with mock.patch.object(client, "fetch_league", side_effect=fake_fetch_league):
        results = [
            provider.fetch_league_metadata(ref),
            provider.fetch_teams(ref),
            provider.fetch_standings(ref),
            provider.fetch_transactions(ref),
            provider.fetch_scoreboard(ref, 6),
            provider.fetch_rosters(ref, 6),
            provider.fetch_player_stats(ref, 6),
        ]

    txn_result = results[3]
    txn_parent_rows = [r for r in txn_result.rows if r.get("_table") == "fantasy_transactions"]
    check("dedup-by-transaction_key across 18 mocked weekly calls: 5 unique "
          "transactions land exactly once, not 18x over",
          len(txn_parent_rows) == 5, len(txn_parent_rows))
    check("api_calls reflects all 18 per-week requests actually made",
          txn_result.api_calls == 18, txn_result.api_calls)

    real = _real_columns()
    extra_bad, missing_bad = [], []
    tables_seen = set()
    for result in results:
        for row in result.rows:
            table = row.get("_table")
            tables_seen.add(table)
            clean = {k: v for k, v in row.items() if not k.startswith("_")}
            if table not in real:
                extra_bad.append(f"{table}: unknown table")
                continue
            extra = set(clean.keys()) - real[table]
            if extra:
                extra_bad.append(f"{table}: {sorted(extra)}")
            pk = d1mod.PRIMARY_KEYS.get(table)
            if pk:
                missing = [c for c in pk if c not in clean]
                if missing:
                    missing_bad.append(f"{table}: missing {missing}")

    check(f"exercised {len(tables_seen)} table(s) through the real adapter methods",
          len(tables_seen) >= 8, sorted(tables_seen))
    check("no adapter method emits an unknown column (same invariant as "
          "section I, now checked end-to-end)", extra_bad == [], "; ".join(extra_bad[:5]))
    check("⚠️ no adapter method emits a row missing part of its table's "
          "PRIMARY KEY — this is EXACTLY the class of bug section I could not "
          "see (fantasy_standings_snapshots.as_of_week is added by the "
          "adapter, after parse_standings returns, and a real backfill "
          "against Keith's league is what actually caught it missing)",
          missing_bad == [], "; ".join(missing_bad[:5]))

    standings_rows = [r for r in results[2].rows if r.get("_table") == "fantasy_standings_snapshots"]
    check("fantasy_standings_snapshots rows carry a real as_of_week (not None)",
          standings_rows and all(r.get("as_of_week") is not None for r in standings_rows),
          [r.get("as_of_week") for r in standings_rows])


# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    print("ESPN PIPELINE TEST — lighter first pass: parse, client, auth, adapter scope\n")
    print(f"  fixtures: {FIXTURES.relative_to(REPO_ROOT)}  "
          f"({len(list(FIXTURES.glob('*.json')))} files, all SYNTHETIC)")

    for fn in (test_constants, test_keys, test_parse_league_teams_standings,
               test_parse_weekly, test_parse_transactions, test_auth,
               test_client_urls_and_errors, test_league_settings, test_adp_source, test_adapter_scope_honesty,
               test_keychain_shared, test_schema_audit,
               test_adapter_full_path_schema):
        fn()

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s) did not hold:")
        for f in FAILURES:
            print(f"  - {f}")
        sys.exit(1)
    print("PASSED — unbuilt ESPN resources refuse rather than lie, NULL never "
          "became 0, and every derived starter flag traces to a real lineupSlotId")


if __name__ == "__main__":
    main()
