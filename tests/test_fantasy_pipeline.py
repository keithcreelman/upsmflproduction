#!/usr/bin/env python3
"""FANTASY PIPELINE TEST — the Yahoo ingestion path, against committed fixtures.

WHAT IS UNDER TEST
==================
Everything in pipelines/fantasy/ that can be exercised without a network, a
token, or a database: the Yahoo JSON shape normalizer, the parsers, the D1
idempotency contract, the data-quality checks, secret redaction, the player
crosswalk, completeness classification, and the raw-payload sink. Every symbol
is IMPORTED from the module that ships. Nothing here re-implements the logic it
is checking — a test that owns its own copy of the parser proves only that the
copy works.

WHY IT EXISTS — THE THREE FAILURES THIS FILE IS BUILT AROUND
============================================================
1. AN UNREADABLE READ MUST NEVER COME BACK AS EMPTY DATA.
   This is the same invariant tests/lineup_parser_test.js was written for, in a
   new domain. Yahoo answers a throttle with HTTP 999 and an HTML body; it
   answers an expired token with a JSON object that has no fantasy_content
   envelope. Every one of those is a REFUSAL. A pipeline that turns them into
   "this season had no transactions" writes a plausible, permanent, silent lie
   into D1. Block B asserts unwrap_content raises on five distinct kinds of bad
   input and never — not once — returns {} or an empty collection.

2. NULL IS NOT ZERO.
   An auction pick with no stated price and an auction pick that genuinely went
   for $0 are different facts. So are an unexposed FAAB budget and a $0 bid.
   Block C asserts `is None` rather than `== 0` on purpose: `== 0` passes for
   both, which is exactly how the distinction gets lost. If a parser is ever
   "simplified" to default a missing cost to zero, this file is what fails.

3. A SHAPE THE PARSER DOES NOT HANDLE PRODUCES ZERO ROWS AND NO EXCEPTION.
   Yahoo's JSON is a mechanical XML transform: collections are objects keyed
   "0","1",… with a sibling `count`; resources are heterogeneous arrays at
   SHIFTING indices; single-element collections collapse to bare objects; and
   sub-resources hide one level down under a numeric wrapper key. Getting any of
   these wrong does not raise. It silently returns fewer rows — or none.
   THAT IS NOT HYPOTHETICAL: writing block C found it live. Against parse.py at
   PARSER_VERSION 1.0.0, yahoo_roster_week.json, yahoo_roster_week_with_stats.json
   and yahoo_scoreboard_week.json each parsed to ZERO rows without raising,
   because `flatten_resource` merges the members of an ARRAY resource but does
   not descend into the numeric-key children of an OBJECT one. The fix was
   `shape.subresource()`; these tests are what keeps it fixed.

WHAT IS DELIBERATELY NOT TESTED HERE
====================================
Anything requiring a live Yahoo call (no API access has ever been granted to
this repo — every fixture is SYNTHETIC and says so in its own `_comment`), and
anything requiring wrangler/D1. The D1 block tests the SQL the loader BUILDS and
the primary-key table it builds it from, never an actual write.

Run: python3 tests/test_fantasy_pipeline.py
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import tempfile
from pathlib import Path
from unittest import mock
from urllib.parse import unquote

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "yahoo"
MIGRATIONS = REPO_ROOT / "worker" / "migrations"
sys.path.insert(0, str(REPO_ROOT))

from pipelines.fantasy import d1 as d1mod                                    # noqa: E402
from pipelines.fantasy.normalize import crosswalk as xw                      # noqa: E402
from pipelines.fantasy.providers import base as pbase                        # noqa: E402
from pipelines.fantasy.providers.yahoo import parse, shape                   # noqa: E402
from pipelines.fantasy.providers.yahoo.adapter import YahooProvider          # noqa: E402
from pipelines.fantasy.providers.yahoo.client import ClientStats, YahooClient # noqa: E402
from pipelines.fantasy.providers.yahoo.oauth import TokenBundle              # noqa: E402
from pipelines.fantasy.quality import checks, completeness                   # noqa: E402
from pipelines.fantasy.raw import sink as rawsink                            # noqa: E402
from pipelines.fantasy.redact import (                                        # noqa: E402
    REDACTED, redact_headers, redact_params, redact_text, redact_url, safe_repr,
)

MISSING = shape.MISSING
YahooShapeError = shape.YahooShapeError


# ─────────────────────────────────────────────────────────────────────────────
# Harness — hand-rolled on purpose. No pytest: this repo's tests are plain
# scripts whose EXIT CODE is the contract, runnable with nothing installed.
# ─────────────────────────────────────────────────────────────────────────────

FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> bool:
    """One named test case. Prints its verdict; records the failure if any."""
    # Details are collapsed to one line: several carry generated SQL, and a
    # multi-line detail breaks the one-line-per-case reading of the output.
    detail = " ".join(str(detail).split())[:160]
    suffix = f"  ({detail})" if detail else ""
    print(f"  {'FAIL' if not cond else 'ok  '}  {name}{suffix}")
    if not cond:
        FAILURES.append(f"{name}{suffix}")
    return bool(cond)


def check_raises(name: str, exc_type, fn, *args, **kwargs) -> bool:
    """Assert `fn` RAISES. A returned value is reported verbatim, because 'it
    returned {} instead of raising' is the exact failure mode block B guards."""
    try:
        got = fn(*args, **kwargs)
    except exc_type:
        return check(name, True)
    except Exception as exc:  # noqa: BLE001 — a different exception is still a fail
        return check(name, False, f"raised {type(exc).__name__}, wanted {exc_type.__name__}")
    return check(name, False, f"RETURNED {got!r} instead of raising {exc_type.__name__}")


def section(title: str) -> None:
    print(f"\n{title}")


def load_fixture(name: str) -> dict:
    """Read a fixture and drop its `_comment` provenance block.

    The comment is the fixture's own account of what it models and what is
    truncated; it is not payload and no parser should ever see it.
    """
    path = FIXTURES / name
    if not path.exists():
        raise SystemExit(
            f"FIXTURE MISSING: {path}\nThe suite refuses to run a partial pass — a "
            "missing fixture is an unverified claim, not a skipped one."
        )
    data = json.loads(path.read_text(encoding="utf-8"))
    data.pop("_comment", None)
    return data


def content(name: str) -> dict:
    return shape.unwrap_content(load_fixture(name))


# The slot vocabulary of the league in the roster fixtures, taken from that
# league's OWN roster_positions (yahoo_league_settings_snake.json). It is passed
# in rather than assumed because 'BN' is not a safe global constant — leagues
# define IR, IR+, IR-R and NA as bench-like slots too.
ROSTER_STARTING = {"QB", "RB", "WR", "TE", "W/R/T", "K", "DEF"}
ROSTER_BENCH = {"BN"}
ROSTER_INJURY = {"IR"}


# ─────────────────────────────────────────────────────────────────────────────
# A. SHAPE — the four pathologies of Yahoo's XML→JSON transform
# ─────────────────────────────────────────────────────────────────────────────

def test_shape() -> None:
    section("A. SHAPE — collections, resources, coercion")

    # PATHOLOGY 1: a collection is an object with a sibling `count`, which is
    # NOT an element. Yielding it produces an int where a dict was expected.
    coll = {"0": {"a": 1}, "1": {"a": 2}, "count": 2}
    check("iter_collection yields elements and SKIPS the count sibling",
          shape.as_list(coll) == [{"a": 1}, {"a": 2}], repr(shape.as_list(coll)))

    # THE 12-TEAM BUG. Lexically "10" < "2", so a lexical sort reorders a
    # 12-team league's matchups and a 12-round draft's picks. Position is
    # meaning in both.
    wide = {str(i): {"i": i} for i in range(12)}
    wide["count"] = 12
    got = [e["i"] for e in shape.as_list(wide)]
    check("numeric-string keys are ordered NUMERICALLY, not lexically",
          got == list(range(12)), f"order was {got}")
    check("element '10' comes AFTER element '2' (the 12-team league case)",
          got.index(10) > got.index(2))

    # PATHOLOGY 3: single-element collapse — a bare object where a wrapper was
    # expected. eligible_positions, bye_weeks, managers and trade
    # transaction_data all do this.
    check("single-element collapse: a bare object is a one-element collection",
          shape.as_list({"position": "QB"}) == [{"position": "QB"}])
    check("an already-materialized list passes through unchanged",
          shape.as_list([{"a": 1}]) == [{"a": 1}])

    # A genuinely empty collection. Distinct from an unreadable one, which
    # raises — see block B.
    check("{'count': 0} is a real EMPTY collection and yields nothing",
          shape.as_list({"count": 0}) == [])
    check("collection_count reports the provider's own declared count",
          shape.collection_count(coll) == 2 and shape.collection_count({"count": 0}) == 0)
    check("collection_count is None when the provider declared none",
          shape.collection_count({"0": {}}) is None)
    check_raises("iter_collection REFUSES a scalar (not a collection at all)",
                 YahooShapeError, shape.as_list, "nope")

    # PATHOLOGY 2: resources are heterogeneous ARRAYS at SHIFTING indices.
    # Metadata is *usually* at index 0. Here it deliberately is not.
    shifted = [
        {"selected_position": {"position": "BN"}},   # index 0: a sub-resource
        {"player_key": "461.p.30977", "player_id": "30977"},   # index 1: metadata
        {"player_stats": {"stats": {"count": 0}}},
    ]
    flat = shape.flatten_resource(shifted)
    check("flatten_resource finds metadata at index 1, not 0 (shifting indices)",
          flat.get("player_key") == "461.p.30977" and "selected_position" in flat)
    nested = [[{"team_key": "t.4"}, {"team_id": "4"}], {"roster": {"week": "5"}}]
    check("flatten_resource descends one level into a nested member array",
          shape.flatten_resource(nested).get("team_key") == "t.4"
          and "roster" in shape.flatten_resource(nested))
    check("flatten_resource skips stray non-dict members without raising",
          shape.flatten_resource([{"a": 1}, "junk", 7, None]) == {"a": 1})

    # PATHOLOGY 6: sub-resources hide under a numeric wrapper key. This is the
    # one that silently produced zero rosters, zero matchups and zero scores.
    wrapped = {"coverage_type": "week", "week": "5", "0": {"players": {"count": 0}}}
    check("subresource descends through the numeric wrapper key '0'",
          shape.subresource(wrapped, "players") == {"count": 0})
    check("subresource prefers a DIRECT key when the wrapper is absent",
          shape.subresource({"players": {"count": 3}}, "players") == {"count": 3})
    check("subresource returns MISSING (not {}) when the key is genuinely absent",
          shape.subresource(wrapped, "matchups") is MISSING)

    # PATHOLOGY 5: MISSING, None and "" are three different claims.
    check("get() returns MISSING for an absent key",
          shape.get({}, "renew") is MISSING)
    check("get() preserves '' — Yahoo's <renew/> means 'NOT renewed', real info",
          shape.get({"renew": ""}, "renew") == "")
    check("get() preserves an explicit None, distinct from MISSING",
          shape.get({"renew": None}, "renew") is None)
    check("MISSING is falsy but is NOT None (so `is None` cannot alias it)",
          bool(MISSING) is False and MISSING is not None)
    check("get(default=None) lets a caller opt out of the distinction",
          shape.get({}, "renew", default=None) is None)

    # PATHOLOGY 4: types are unreliable, and percentages have a LEADING DOT.
    check("to_float('.571') == 0.571 (Yahoo's leading-dot percentage)",
          shape.to_float(".571") == 0.571, repr(shape.to_float(".571")))
    check("to_float('-.5') == -0.5", shape.to_float("-.5") == -0.5)
    check("to_float('') is None — no number stated", shape.to_float("") is None)
    check("to_float('0') == 0.0 — a stated zero survives",
          shape.to_float("0") == 0.0 and shape.to_float("0") is not None)
    check("to_int('') is None, NOT 0", shape.to_int("") is None)
    check("to_int(MISSING) is None, NOT 0", shape.to_int(MISSING) is None)
    check("to_int('0') == 0 — a stated zero is not an absence",
          shape.to_int("0") == 0 and shape.to_int("0") is not None)
    check("to_int('3.0') == 3 (via float; int('3.0') would raise)",
          shape.to_int("3.0") == 3)
    check("to_int(' 12 ') == 12 (whitespace-padded strings are real)",
          shape.to_int(" 12 ") == 12)
    check("to_bool_int('0') == 0", shape.to_bool_int("0") == 0)
    check("to_bool_int('1') == 1", shape.to_bool_int("1") == 1)
    check("to_bool_int(None) is None — 'the provider did not say'",
          shape.to_bool_int(None) is None)
    check("to_bool_int('') is None, not 0", shape.to_bool_int("") is None)
    check("to_text(MISSING) is None but to_text('') == ''",
          shape.to_text(MISSING) is None and shape.to_text("") == "")
    check_raises("to_text REFUSES a container (a dict is not a scalar)",
                 YahooShapeError, shape.to_text, {"a": 1})
    check("first_text picks the first key present with a non-empty value",
          shape.first_text({"display_name": "", "name": "Passing Yards"},
                           "display_name", "name") == "Passing Yards")

    # Unmapped-field tracking: a provider field nobody consumed becomes DATA to
    # look at rather than a silent drop.
    check("unmapped_keys reports unconsumed scalars and ignores containers",
          shape.unmapped_keys({"a": 1, "b": 2, "sub": {"x": 1}}, {"a"}) == ["b"])


# ─────────────────────────────────────────────────────────────────────────────
# B. NO FAIL-OPEN — the most important block in this file
# ─────────────────────────────────────────────────────────────────────────────

def test_no_fail_open() -> None:
    section("B. NO FAIL-OPEN — a read we could not understand is NEVER empty data")

    html = (FIXTURES / "yahoo_error_rate_limit_999.html").read_text(encoding="utf-8")
    expired = json.loads((FIXTURES / "yahoo_error_expired_token.json").read_text(encoding="utf-8"))

    bad_inputs = [
        ("HTTP 999 throttle page (HTML, not JSON)", html),
        ("an empty string body", ""),
        ("a whitespace-only body", "   \n  "),
        ("a JSON ARRAY where an object was required", [{"league": {}}]),
        ("an empty JSON array", []),
        ("a JSON object with NO fantasy_content envelope", {"error": {"description": "x"}}),
        ("the real 401 expired-token body", expired),
        ("None", None),
        ("an integer", 0),
        ("fantasy_content present but NULL", {"fantasy_content": None}),
        ("fantasy_content present but a LIST", {"fantasy_content": []}),
    ]
    for label, payload in bad_inputs:
        check_raises(f"unwrap_content REFUSES: {label}", YahooShapeError,
                     shape.unwrap_content, payload)

    # The negative assertion, stated separately because it is the one that
    # matters: no bad input may ever produce a value at all, let alone {}.
    returned = []
    for label, payload in bad_inputs:
        try:
            returned.append((label, shape.unwrap_content(payload)))
        except YahooShapeError:
            pass
        except Exception:  # noqa: BLE001
            pass
    check("NOT ONE bad payload returned a value — never {}, never an empty collection",
          returned == [], f"these returned instead of raising: {returned}")

    # The refusal has to be diagnosable. A bare 'unreadable' tells an operator
    # nothing about which of eleven inputs it was.
    try:
        shape.unwrap_content({"error": {"description": "token expired"}})
        msg = ""
    except YahooShapeError as exc:
        msg = str(exc)
    check("the refusal names the top-level keys it actually saw",
          "fantasy_content" in msg and "error" in msg, msg[:90])

    # A parser handed a well-formed envelope with the wrong contents must also
    # refuse rather than return an empty row set.
    check_raises("parse_league_metadata REFUSES an envelope with no league node",
                 YahooShapeError, parse.parse_league_metadata, {"users": {"count": 0}})
    check_raises("parse_league_settings REFUSES a league with no settings node",
                 YahooShapeError, parse.parse_league_settings,
                 {"league": {"league_key": "461.l.1"}}, league_key="461.l.1", season=2025)

    # And the D1 read path: a COUNT(*) that returns nothing is unreadable, not 0.
    check_raises("d1._rows_from_wrangler REFUSES output containing no JSON at all",
                 d1mod.D1Error, d1mod._rows_from_wrangler, "wrangler exploded\n")
    check("d1._rows_from_wrangler still parses real output past the ANSI banner",
          d1mod._rows_from_wrangler(
              '\x1b[1m banner \x1b[0m[{"results":[{"n":3}]}]') == [{"n": 3}])


# ─────────────────────────────────────────────────────────────────────────────
# C. PARSER CORRECTNESS — real values off the committed fixtures
# ─────────────────────────────────────────────────────────────────────────────

def test_parse_auction_draft() -> None:
    section("C1. DRAFT — the NULL-vs-ZERO auction price invariant")

    out = parse.parse_draft_results(content("yahoo_draft_auction.json"),
                                    league_key="461.l.576919", season=2025, is_auction=1)
    picks = out["fantasy_draft_events"]
    draft = out["fantasy_drafts"][0]
    by_pick = {p["pick_number"]: p for p in picks}

    check("auction draft parses 11 picks", len(picks) == 11, f"got {len(picks)}")
    check("pick numbers are read in NUMERIC key order, 1..11",
          [p["pick_number"] for p in picks] == list(range(1, 12)),
          str([p["pick_number"] for p in picks]))

    unpriced = [p for p in picks if p["auction_cost"] is None]
    free = [p for p in picks if p["auction_cost"] == 0.0 and p["auction_cost"] is not None]
    priced = [p for p in picks if (p["auction_cost"] or 0) > 0]
    check("exactly ONE pick has NO stated price", len(unpriced) == 1,
          f"got {len(unpriced)}")
    check("exactly ONE pick went for a genuine $0", len(free) == 1, f"got {len(free)}")
    check("nine picks carry a positive price", len(priced) == 9, f"got {len(priced)}")

    # ⚠️ THE REGRESSION GUARD. `is None` — not `== 0`, which passes for both and
    # is precisely how the distinction is lost.
    check("pick 6 auction_cost IS NONE (asserted with `is None`, never `== 0`)",
          by_pick[6]["auction_cost"] is None, repr(by_pick[6]["auction_cost"]))
    check("pick 5 auction_cost IS 0.0 and is NOT None (a real free keeper)",
          by_pick[5]["auction_cost"] == 0.0 and by_pick[5]["auction_cost"] is not None,
          repr(by_pick[5]["auction_cost"]))
    check("pick 7 auction_cost == 1.0 — $1 and $0 are both real prices",
          by_pick[7]["auction_cost"] == 1.0)
    check("the unpriced pick and the free pick are DIFFERENT picks",
          unpriced[0]["pick_number"] != free[0]["pick_number"])

    check("player_uid uses the season-INDEPENDENT editorial key (nfl.p.*)",
          all((p["player_uid"] or "").startswith("nfl.p.") for p in picks))
    check("player_key_at_draft keeps the season-SCOPED key verbatim",
          by_pick[1]["player_key_at_draft"].startswith("461.p."),
          by_pick[1]["player_key_at_draft"])
    check("is_keeper stays NULL — Yahoo exposes no per-pick keeper flag",
          all(p["is_keeper"] is None for p in picks))
    check("keeper_inferred is 0 and carries no basis (nothing was inferred)",
          all(p["keeper_inferred"] == 0 and p["keeper_inference_basis"] is None
              for p in picks))
    check("the draft row is marked auction and PRICE-BEARING",
          draft["draft_kind"] == "auction" and draft["is_price_bearing"] == 1)
    check("draft.has_keepers is NULL — genuinely unknown from this payload",
          draft["has_keepers"] is None)

    # Snake: the same field is MEANINGLESS, not zero.
    snake = parse.parse_draft_results(content("yahoo_draft_snake.json"),
                                      league_key="449.l.529351", season=2024, is_auction=0)
    snake_picks = snake["fantasy_draft_events"]
    check("snake draft parses 14 picks", len(snake_picks) == 14, f"got {len(snake_picks)}")
    check("every snake pick has auction_cost None — meaningless, NOT $0",
          all(p["auction_cost"] is None for p in snake_picks))
    check("the snake draft row is NOT price-bearing",
          snake["fantasy_drafts"][0]["is_price_bearing"] == 0
          and snake["fantasy_drafts"][0]["draft_kind"] == "snake")

    # is_auction unknown must not be guessed into either bucket.
    keeper = parse.parse_draft_results(content("yahoo_draft_keeper.json"),
                                       league_key="449.l.529351", season=2024,
                                       is_auction=None)
    check("is_auction=None yields draft_kind 'unknown', never a guess",
          keeper["fantasy_drafts"][0]["draft_kind"] == "unknown")


def test_parse_transactions() -> None:
    section("C2. TRANSACTIONS — the transaction_data shape trap")

    # TRADE: transaction_data is a LIST OF ONE DICT.
    tr = parse.parse_transactions(content("yahoo_transaction_trade_multi.json"),
                                  league_key="461.l.576919", season=2025)
    parents, legs = tr["fantasy_transactions"], tr["fantasy_transaction_assets"]
    check("the multi-player trade yields exactly ONE parent transaction",
          len(parents) == 1, f"got {len(parents)}")
    check("the trade yields 3+ asset legs (0 is what the list-shape bug produces)",
          len(legs) >= 3, f"got {len(legs)}")
    check("leg_index is 0,1,2 — dense and ordered",
          [l["leg_index"] for l in legs] == [0, 1, 2],
          str([l["leg_index"] for l in legs]))
    check("the parent's asset_count matches the legs actually written",
          parents[0]["asset_count"] == len(legs))
    check("every leg shares the parent's transaction_key",
          {l["transaction_key"] for l in legs} == {parents[0]["transaction_key"]})

    a, b = "461.l.576919.t.4", "461.l.576919.t.11"
    moves = sorted((l["source_team_key"], l["destination_team_key"]) for l in legs)
    check("two players move t.4 -> t.11 and one moves t.11 -> t.4",
          moves == sorted([(a, b), (a, b), (b, a)]), str(moves))
    check("every trade leg carries BOTH a source and a destination team key",
          all(l["source_team_key"] and l["destination_team_key"] for l in legs))
    check("every trade leg's movement_type is 'trade', read verbatim",
          {l["movement_type"] for l in legs} == {"trade"})
    check("provider fields we do not model surface in unmapped_fields",
          "trader_team_key" in (parents[0]["unmapped_fields"] or []),
          str(parents[0]["unmapped_fields"]))
    check("a typographic apostrophe normalizes the same as a plain one",
          parse.normalize_name("Ja’Marr Chase") == parse.normalize_name("Ja'Marr Chase")
          == "jamarr chase", repr(parse.normalize_name("Ja’Marr Chase")))

    # ADD/DROP: transaction_data is a BARE DICT.
    ad = parse.parse_transactions(content("yahoo_transaction_add_drop.json"),
                                  league_key="461.l.576919", season=2025)
    ad_legs = ad["fantasy_transaction_assets"]
    check("the add/drop yields EXACTLY 2 legs", len(ad_legs) == 2, f"got {len(ad_legs)}")
    check("the add/drop legs are one 'add' and one 'drop'",
          sorted(l["movement_type"] for l in ad_legs) == ["add", "drop"])
    add_leg = [l for l in ad_legs if l["movement_type"] == "add"][0]
    check("the add leg is sourced from freeagents with NO source_team_key",
          add_leg["source_type"] == "freeagents" and add_leg["source_team_key"] is None,
          repr(add_leg["source_team_key"]))

    # WAIVERS: absence of source_team_key is the fact that distinguishes a
    # waiver claim from a free-agent pickup. Filling it with '' destroys that.
    fw = parse.parse_transactions(content("yahoo_transaction_faab_waiver.json"),
                                  league_key="461.l.576919", season=2025)
    fw_parents, fw_legs = fw["fantasy_transactions"], fw["fantasy_transaction_assets"]
    waiver_legs = [l for l in fw_legs if l["source_type"] == "waivers"]
    check("both waiver claims parse as legs", len(waiver_legs) == 2, f"got {len(waiver_legs)}")
    check("NO waiver leg carries a source_team_key (absence is the signal)",
          all(l["source_team_key"] is None for l in waiver_legs),
          str([l["source_team_key"] for l in waiver_legs]))
    check("source_team_key is None, NOT the empty string",
          all(l["source_team_key"] != "" for l in waiver_legs))
    check("every waiver leg still has a destination team",
          all(l["destination_team_key"] for l in waiver_legs))

    bids = sorted(p["faab_bid"] for p in fw_parents)
    check("a $17 bid and a $0 bid are both preserved as real numbers",
          bids == [0, 17], str(bids))
    check("the $0 FAAB bid IS 0 and is NOT None (a real zero-dollar claim)",
          any(p["faab_bid"] == 0 and p["faab_bid"] is not None for p in fw_parents))
    check("a transaction with no FAAB bid keeps faab_bid None, not 0",
          parents[0]["faab_bid"] is None, repr(parents[0]["faab_bid"]))


def test_parse_rosters() -> None:
    section("C3. ROSTERS — derived starter status, and the numeric wrapper key")

    payload = content("yahoo_roster_week.json")
    out = parse.parse_rosters(payload, league_key="449.l.529351", season=2024, week=5,
                              starting_slots=ROSTER_STARTING, bench_slots=ROSTER_BENCH,
                              injury_slots=ROSTER_INJURY)
    snaps = out["fantasy_roster_snapshots"]
    players = out["fantasy_players"]

    # ⚠️ THE ZERO-ROWS REGRESSION. This fixture parsed to 0 snapshots and 0
    # players against parse.py 1.0.0 — silently, no exception — because the
    # players collection hides under the numeric wrapper key "0" inside the
    # roster object. A count assertion is the only thing that catches it.
    check("the roster fixture yields 18 snapshots, NOT ZERO (numeric wrapper key)",
          len(snaps) == 18, f"got {len(snaps)}")
    check("and 18 player rows alongside them", len(players) == 18, f"got {len(players)}")
    check("both teams in the batched payload are present",
          len({s["team_key"] for s in snaps}) == 2)
    check("week comes from the roster resource itself (5), not the caller's arg",
          {s["week"] for s in snaps} == {5}, str({s["week"] for s in snaps}))

    by_slot: dict = {}
    for s in snaps:
        by_slot.setdefault(s["selected_position"], []).append(s)

    def every(slot: str, pred) -> bool:
        """all() over an EMPTY list is True — which would make a zero-row parse
        pass every slot assertion. Presence is asserted first, deliberately."""
        rows = by_slot.get(slot) or []
        return bool(rows) and all(pred(s) for s in rows)

    check("BN is NOT a starter", every("BN", lambda s: s["is_starter"] == 0))
    check("BN sets is_bench=1", every("BN", lambda s: s["is_bench"] == 1))
    check("IR is NOT a starter", every("IR", lambda s: s["is_starter"] == 0))
    check("IR sets is_injury_slot=1 and is_bench=0",
          every("IR", lambda s: s["is_injury_slot"] == 1 and s["is_bench"] == 0))
    check("QB/RB/WR/TE/K/DEF are starters",
          all(every(slot, lambda s: s["is_starter"] == 1)
              for slot in ("QB", "RB", "WR", "TE", "K", "DEF")))
    check("the W/R/T flex slot is a starter and is flagged is_flex_slot",
          every("W/R/T", lambda s: s["is_starter"] == 1 and s["is_flex_slot"] == 1))
    check("exactly 14 starters across the two teams (7 slots each)",
          sum(1 for s in snaps if s["is_starter"] == 1) == 14,
          str(sum(1 for s in snaps if s["is_starter"] == 1)))

    # ⚠️ An unknown lineup requirement must produce an UNKNOWN starter flag,
    # never a wrong one. Yahoo has no is_started field to fall back on.
    blind = parse.parse_rosters(payload, league_key="449.l.529351", season=2024, week=5)
    blind_snaps = blind["fantasy_roster_snapshots"]
    check("with NO slot definitions supplied, is_starter is None for EVERY row",
          blind_snaps and all(s["is_starter"] is None for s in blind_snaps),
          str({s["is_starter"] for s in blind_snaps}))
    check("is_bench and is_injury_slot are None too, not 0",
          all(s["is_bench"] is None and s["is_injury_slot"] is None for s in blind_snaps))
    check("selected_position is still recorded when the slots are unknown",
          all(s["selected_position"] for s in blind_snaps))

    # Single-element collapse in the middle of a real roster: the kicker's
    # eligible_positions is a bare object, everyone else's is a collection.
    kickers = [p for p in players if p["display_position"] == "K"]
    check("a single-eligibility kicker still gets a 1-element position list",
          bool(kickers) and kickers[0]["eligible_positions"] == ["K"],
          str([k["eligible_positions"] for k in kickers]))
    multi = [p for p in players if len(p["eligible_positions"]) > 1]
    check("multi-eligible players keep every eligible position", len(multi) >= 1)
    check("a roster payload carries NO points — that needs the chained request",
          "player_points" not in json.dumps(payload))

    # The chained form DOES carry stats and points.
    stats_payload = content("yahoo_roster_week_with_stats.json")
    st = parse.parse_player_week_stats(stats_payload, league_key="449.l.529351",
                                       season=2024, week=5)
    check("the chained roster+stats payload yields stat rows, NOT ZERO",
          len(st["fantasy_player_week_stats"]) > 0,
          f"got {len(st['fantasy_player_week_stats'])}")
    check("it yields 6 player-week point rows (3 players x 2 teams)",
          len(st["fantasy_player_week_points"]) == 6,
          f"got {len(st['fantasy_player_week_points'])}")
    zeros = [r for r in st["fantasy_player_week_stats"] if r["stat_value"] == 0.0]
    check("a stat genuinely reported as 0 stays 0.0, not None", len(zeros) > 0)
    check("projected_points is NULL — historical projections do not exist at all",
          all(r["projected_points"] is None for r in st["fantasy_player_week_points"]))


def test_parse_standings_and_scoreboard() -> None:
    section("C4. STANDINGS + SCOREBOARD")

    rows = parse.parse_standings(content("yahoo_standings_final.json"),
                                 league_key="461.l.576919", season=2025)
    check("standings parse to 6 team rows", len(rows) == 6, f"got {len(rows)}")
    by_rank = {r["rank"]: r for r in rows}
    check("ranks 1..6 are all present", sorted(by_rank) == [1, 2, 3, 4, 5, 6],
          str(sorted(by_rank)))
    check("win_percentage '.571' parses to 0.571 (LEADING DOT)",
          by_rank[4]["win_percentage"] == 0.571, repr(by_rank[4]["win_percentage"]))
    check("win_percentage '.786' parses to 0.786",
          by_rank[1]["win_percentage"] == 0.786, repr(by_rank[1]["win_percentage"]))
    check("wins/losses are ints, not strings",
          by_rank[1]["wins"] == 11 and by_rank[1]["losses"] == 3)
    check("points_for is a float carrying its decimals",
          by_rank[1]["points_for"] == 1781.44, repr(by_rank[1]["points_for"]))
    check("the streak is split into a type and a value",
          by_rank[1]["streak_type"] == "win" and by_rank[1]["streak_value"] == 4)
    check("is_inferred is 0 — this came FROM the provider, not reconstructed",
          all(r["is_inferred"] == 0 and r["inference_basis"] is None for r in rows))

    sb = parse.parse_scoreboard(content("yahoo_scoreboard_week.json"),
                                league_key="461.l.576919", season=2025)
    matchups, scores = sb["fantasy_matchups"], sb["fantasy_team_week_scores"]
    # Second zero-rows regression: scoreboard->matchups and matchup->teams are
    # BOTH behind the numeric wrapper key.
    check("the scoreboard yields 2 matchups, NOT ZERO (numeric wrapper key)",
          len(matchups) == 2, f"got {len(matchups)}")
    check("and 4 team-week score rows", len(scores) == 4, f"got {len(scores)}")
    check("every matchup is week 15", {m["week"] for m in matchups} == {15})

    # A zero-matchup parse must produce clean FAIL lines, not an IndexError
    # traceback — so the empty case is short-circuited with a placeholder rather
    # than indexed into.
    playoffs = [m for m in matchups if m["is_playoffs"] == 1]
    if not check("a playoff matchup is present to assert against", len(playoffs) == 1,
                 f"got {len(playoffs)}"):
        playoffs = [{k: None for k in ("matchup_key", "team_a_key", "team_b_key",
                                       "recap_url", "team_a_grade", "team_b_grade",
                                       "winner_team_key")}]
    playoff = playoffs[0]
    check("matchup_key is a canonically SORTED team pair",
          bool(playoff["team_a_key"]) and playoff["matchup_key"] == "|".join(sorted(
              [playoff["team_a_key"], playoff["team_b_key"]])), playoff["matchup_key"])
    check("team_a is the alphabetically-first key, so re-ingest cannot duplicate",
          bool(playoff["team_a_key"]) and playoff["team_a_key"] < playoff["team_b_key"])
    check("'&amp;' in the recap URL is unescaped to '&'",
          "&amp;" not in (playoff["recap_url"] or "&amp;")
          and "&mid1=4" in (playoff["recap_url"] or ""), playoff["recap_url"])
    check("matchup grades are attached to the RIGHT teams",
          playoff["team_a_grade"] == "B+" and playoff["team_b_grade"] == "A",
          f"{playoff['team_a_grade']}/{playoff['team_b_grade']}")
    check("the winner_team_key is read verbatim",
          playoff["winner_team_key"] == "461.l.576919.t.4")

    tied = [m for m in matchups if m["is_tied"] == 1]
    check("the tied matchup is flagged is_tied=1 with no winner",
          len(tied) == 1 and tied[0]["winner_team_key"] is None)
    check("a matchup with no recap keeps recap_url NULL, not ''",
          tied[0]["recap_url"] is None, repr(tied[0]["recap_url"]))

    # Provider self-consistency: the team scores must agree with the matchups
    # they came out of, or the parse misaligned a team with its points.
    recon = checks.check_score_reconciliation(scores, matchups)
    check("team-week scores reconcile with their own matchups",
          [f for f in recon if f.severity == "error"] == [],
          "; ".join(f.message for f in recon))


def test_parse_league_and_players() -> None:
    section("C5. LEAGUE METADATA, SETTINGS, TEAMS, PLAYERS")

    auction = content("yahoo_league_settings_auction.json")
    meta = parse.parse_league_metadata(auction)
    check("league_key canonicalizes to the numeric game-id form",
          meta["league_key"] == "461.l.576919", meta["league_key"])
    check("renew '449_529351' canonicalizes to '449.l.529351' (NOT a league key)",
          meta["renew_key"] == "449.l.529351", repr(meta["renew_key"]))
    check("an EMPTY renewed ('') becomes NULL — no next season exists yet",
          meta["renewed_key"] is None, repr(meta["renewed_key"]))
    check("season is an int read off the payload", meta["season"] == 2025)

    st = parse.parse_league_settings(auction, league_key=meta["league_key"],
                                     season=meta["season"])
    srow = st["fantasy_league_settings"][0]
    check("settings parse yields all five table buckets",
          set(st) == {"fantasy_league_settings", "fantasy_roster_positions",
                      "fantasy_scoring_rules", "fantasy_scoring_bonuses",
                      "fantasy_divisions"})
    check("is_auction_draft is 1 for the auction league", srow["is_auction_draft"] == 1)
    check("faab_budget stays NULL — Yahoo does not expose a budget on GET",
          srow["faab_budget"] is None, repr(srow["faab_budget"]))
    check("uses_faab is 1 even though the balance is unknown — different facts",
          srow["uses_faab"] == 1)
    check("9 roster slots are defined", len(st["fantasy_roster_positions"]) == 9)

    slots = {r["position"]: r for r in st["fantasy_roster_positions"]}
    check("BN is classified as a bench slot, not a starting one",
          slots["BN"]["is_starting_slot"] == 0 and slots["BN"]["is_bench_slot"] == 1)
    check("IR+ is classified as an INJURY slot, not a starting one",
          slots["IR+"]["is_starting_slot"] == 0 and slots["IR+"]["is_injury_slot"] == 1)
    check("the W/R/T flex slot records its eligibility as ['W','R','T']",
          slots["W/R/T"]["flex_positions"] == ["W", "R", "T"],
          str(slots["W/R/T"]["flex_positions"]))
    check("slot_count is read, so RB=2 and WR=3 are not collapsed to 1",
          slots["RB"]["slot_count"] == 2 and slots["WR"]["slot_count"] == 3)

    rules = {r["stat_id"]: r for r in st["fantasy_scoring_rules"]}
    check("20 scoring rules parse", len(rules) == 20, f"got {len(rules)}")
    check("a stat TRACKED BUT NOT SCORED has modifier NULL, not 0.0",
          rules["1"]["modifier"] is None, repr(rules["1"]["modifier"]))
    check("a stat scored at exactly 0 keeps modifier 0.0, not NULL",
          rules["3"]["modifier"] == 0.0 and rules["3"]["modifier"] is not None,
          repr(rules["3"]["modifier"]))
    check("passing yards scores 0.04/yd and passing TDs 4.0",
          rules["4"]["modifier"] == 0.04 and rules["5"]["modifier"] == 4.0)
    check("a negative modifier survives (INT = -1.0)", rules["6"]["modifier"] == -1.0)
    check("5 threshold bonuses parse with deterministic composite ids",
          len(st["fantasy_scoring_bonuses"]) == 5
          and all(b["bonus_id"] for b in st["fantasy_scoring_bonuses"]))
    check("bonus stat names are backfilled from the stat dictionary",
          all(b["stat_name"] for b in st["fantasy_scoring_bonuses"]))
    check("2 divisions parse and the settings row records that",
          len(st["fantasy_divisions"]) == 2 and srow["uses_divisions"] == 1
          and srow["num_divisions"] == 2)

    snake_st = parse.parse_league_settings(
        content("yahoo_league_settings_snake.json"),
        league_key="449.l.529351", season=2024)
    check("the snake league is is_auction_draft=0, not NULL",
          snake_st["fantasy_league_settings"][0]["is_auction_draft"] == 0)
    check("a division-less league gets uses_divisions NULL and num_divisions NULL",
          snake_st["fantasy_league_settings"][0]["uses_divisions"] is None
          and snake_st["fantasy_league_settings"][0]["num_divisions"] is None)

    # Optional fields absent everywhere: nothing may be invented to fill them.
    thin = parse.parse_league_metadata(content("yahoo_league_missing_optional.json"))
    check("a league with no current_week keeps it NULL, not 0 or 1",
          thin["current_week"] is None, repr(thin["current_week"]))
    check("a brand-new league has renew_key and renewed_key both NULL",
          thin["renew_key"] is None and thin["renewed_key"] is None)
    check("the fields that ARE present still parse",
          thin["num_teams"] == 4 and thin["season"] == 2025)

    # Single-element collapse across a whole teams payload.
    teams = parse.parse_teams(content("yahoo_single_element_collapse.json"),
                              league_key="461.l.590044", season=2025)
    check("a one-team collection that COLLAPSED to a bare object still parses",
          len(teams["fantasy_teams"]) == 1, f"got {len(teams['fantasy_teams'])}")
    check("its collapsed single manager parses too",
          len(teams["fantasy_managers"]) == 1)
    check("the manager is keyed on the stable GUID, never the nickname",
          teams["fantasy_managers"][0]["manager_uid"].startswith("FAKEGUID"))
    check("no manager row carries an email address",
          "email" not in teams["fantasy_managers"][0])
    check("the collapsed single team_logo resolves to a URL",
          teams["fantasy_teams"][0]["logo_url"].startswith("https://"))
    state = teams["fantasy_team_season_state"][0]
    check("number_of_moves '0' (string) and number_of_trades 0 (int) both read as 0",
          state["number_of_moves"] == 0 and state["number_of_trades"] == 0)
    check("an absent draft_position stays NULL on a predraft league",
          state["draft_position"] is None and state["draft_grade"] is None)

    # Players collection + the 25-per-page hard cap.
    p1, c1 = parse.parse_players_collection(content("yahoo_players_page1.json"))
    p2, c2 = parse.parse_players_collection(content("yahoo_players_page2.json"))
    check("page 1 parses 25 players — Yahoo's undocumented per-page hard cap",
          len(p1) == 25, f"got {len(p1)}")
    check("page 1's parsed count matches the provider's own declared count",
          len(p1) == c1, f"{len(p1)} vs declared {c1}")
    check("page 2 is the short final page", len(p2) == 7 and len(p2) == c2,
          f"{len(p2)} vs declared {c2}")
    check("the two pages do not overlap",
          not ({p["player_uid"] for p in p1} & {p["player_uid"] for p in p2}))
    check("every player_uid is the season-independent editorial key",
          all(p["player_uid"].startswith("nfl.p.") for p in p1 + p2))
    check("normalized_name is populated for fallback matching only",
          all(p["normalized_name"] for p in p1))

    # Discovery: users -> games -> leagues, the deepest nesting in the API.
    disc = parse.parse_user_leagues(content("yahoo_users_games_leagues.json"))
    check("discovery walks users->games->leagues into 4 flat league rows",
          len(disc) == 4, f"got {len(disc)}")
    check("every discovered row is tagged with its discovery_source",
          all(r["discovery_source"] == "users_games_leagues" for r in disc))
    seasons = sorted(r["season"] for r in disc)
    check("three NFL seasons plus a second sport's league are all found",
          seasons == [2023, 2024, 2025, 2025], str(seasons))
    chain = {r["league_key"]: r for r in disc}
    check("the renew/renewed chain links 2023 -> 2024 -> 2025",
          chain["449.l.529351"]["renew_key"] == "423.l.481226"
          and chain["449.l.529351"]["renewed_key"] == "461.l.576919")
    check("the OLDEST season has no renew_key (nothing precedes it)",
          chain["423.l.481226"]["renew_key"] is None)


# ─────────────────────────────────────────────────────────────────────────────
# D. IDEMPOTENCY — the upsert contract
# ─────────────────────────────────────────────────────────────────────────────

#: Tables created by 0127-0132 that the PYTHON loader deliberately never writes.
#: They are owned end-to-end by worker/src/yahoo_oauth.js, which uses prepared
#: statements rather than d1.py. Listing them explicitly (instead of loosening
#: the diff) keeps the check honest: a NEW table added to a migration and
#: forgotten in PRIMARY_KEYS still fails.
WORKER_OWNED_TABLES = {"fantasy_oauth_tokens", "fantasy_oauth_states"}

CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)", re.I)


def test_idempotency() -> None:
    section("D. IDEMPOTENCY — PRIMARY_KEYS vs the migrations, and protected columns")

    # ⚠️ Range-based, NOT a hardcoded list of numbers. The previous form globbed
    # "013[0-2]*" and silently stopped auditing at 0132, so migration 0133
    # (fantasy_adp) was invisible to the audit and its table read as "not a real
    # table". Any new fantasy_* migration is picked up automatically now.
    sql_files = sorted(p for p in MIGRATIONS.glob("0*.sql") if p.name >= "0127")
    check("every fantasy_* migration from 0127 on is present on disk",
          len(sql_files) >= 7, ", ".join(p.name for p in sql_files))

    declared: set[str] = set()
    for path in sql_files:
        declared |= set(CREATE_TABLE_RE.findall(path.read_text(encoding="utf-8")))
    # 35 through 0132, +1 for fantasy_adp in 0133. Asserted as a floor with the
    # exact expectation named, so ADDING a table is not a failure but LOSING one
    # still is — the direction that would actually mean something broke.
    check("the migrations declare at least 36 tables (35 through 0132, "
          "+ fantasy_adp in 0133)", len(declared) >= 36, f"got {len(declared)}")

    # ⚠️ A table in the schema with no PRIMARY_KEYS entry cannot be upserted.
    # d1.py refuses to write it at all — but the refusal only fires at runtime,
    # on a real backfill, hours in. This is the same claim, at build time.
    missing = sorted(declared - set(d1mod.PRIMARY_KEYS) - WORKER_OWNED_TABLES)
    check("every loader-written table has a PRIMARY_KEYS entry",
          missing == [], f"missing: {missing}")
    unknown = sorted(set(d1mod.PRIMARY_KEYS) - declared)
    check("PRIMARY_KEYS names no table the migrations do not create",
          unknown == [], f"unknown: {unknown}")
    check("the worker-owned OAuth tables are the ONLY documented exemptions",
          WORKER_OWNED_TABLES <= declared and not (WORKER_OWNED_TABLES & set(d1mod.PRIMARY_KEYS)))

    # Every key column must exist on the table it keys, or the upsert's
    # ON CONFLICT target is nonsense and SQLite falls back to inserting.
    bad_cols = []
    all_sql = "\n".join(p.read_text(encoding="utf-8") for p in sql_files)
    for table, pk in d1mod.PRIMARY_KEYS.items():
        m = re.search(rf"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?{table}\s*\((.*?)\n\);",
                      all_sql, re.S | re.I)
        if not m:
            continue
        body = m.group(1)
        for col in pk:
            if not re.search(rf"(?m)^\s*{col}\b", body):
                bad_cols.append(f"{table}.{col}")
    check("every PRIMARY_KEYS column actually exists on its table",
          bad_cols == [], f"not found: {bad_cols}")
    check("fantasy_api_errors is deliberately keyless (append-only ledger)",
          d1mod.PRIMARY_KEYS["fantasy_api_errors"] == [])
    # ⚠️ fantasy_adp is the one SANCTIONED non-platform-keyed table, and the
    # exemption is listed here explicitly rather than by loosening the rule.
    # Every other fantasy_* row describes something INSIDE one provider's
    # league, so platform belongs in its key. ADP is external market data about
    # NFL players — identical for a Yahoo, ESPN or CBS league — so keying it by
    # platform would store the same numbers N times and invite them to drift
    # apart. It is keyed by SOURCE instead, so two sources may disagree and
    # both survive. Anything ELSE that shows up here is a real bug.
    NON_PLATFORM_KEYED = {"raw_yahoo_api_responses", "fantasy_sync_runs", "fantasy_adp"}
    offenders = sorted(t for t, pk in d1mod.PRIMARY_KEYS.items()
                       if pk and pk[0] != "platform" and t not in NON_PLATFORM_KEYED)
    check("every table's key starts with 'platform' except the documented "
          "exemptions (raw index, run ledger, and external-market fantasy_adp)",
          offenders == [], f"unexpected: {offenders}")
    check("fantasy_adp is keyed by SOURCE so two ADP sources never overwrite "
          "each other", d1mod.PRIMARY_KEYS["fantasy_adp"][0] == "source")

    # ── protected columns in the ON CONFLICT SET clause ──────────────────────
    from lib.d1_io import build_insert  # noqa: E402 — d1.py already put it on sys.path

    cols = ["platform", "player_uid", "full_name",
            "created_at_utc", "first_seen_at_utc", "updated_at_utc"]
    pk = ["platform", "player_uid"]
    sql = build_insert("fantasy_players", cols,
                       [("yahoo", "nfl.p.1", "Josh Allen", "t0", "t0", "t0")], pk_cols=pk)
    out = d1mod._exclude_protected(sql, cols, pk, d1mod._protected_cols("fantasy_players"))
    set_clause = out.split("DO UPDATE SET ", 1)[1] if "DO UPDATE SET " in out else ""

    check("created_at_utc is DROPPED from the SET clause (first sighting)",
          "created_at_utc" not in set_clause, set_clause)
    check("first_seen_at_utc is DROPPED from the SET clause",
          "first_seen_at_utc" not in set_clause, set_clause)
    check("updated_at_utc is KEPT in the SET clause",
          "updated_at_utc = excluded.updated_at_utc" in set_clause, set_clause)
    check("an ordinary column is still updated on conflict",
          "full_name = excluded.full_name" in set_clause, set_clause)
    check("the protected columns still appear in the INSERT arm (they may be NOT NULL)",
          "created_at_utc" in out.split("ON CONFLICT")[0])
    check("primary-key columns are never in the SET clause",
          "player_uid = excluded" not in set_clause)

    # fantasy_sync_runs writes TWICE on one run_id: start, then finish. `mode`
    # must be SENT (it is NOT NULL and SQLite evaluates the INSERT arm first)
    # but must never be SET, or the finish write forgets what the run was.
    run_cols = ["run_id", "mode", "league_key", "status", "finished_at_utc"]
    run_sql = build_insert("fantasy_sync_runs", run_cols,
                           [("r1", "backfill", "461.l.1", "ok", "t1")], pk_cols=["run_id"])
    run_out = d1mod._exclude_protected(run_sql, run_cols, ["run_id"],
                                       d1mod._protected_cols("fantasy_sync_runs"))
    run_set = run_out.split("DO UPDATE SET ", 1)[1] if "DO UPDATE SET " in run_out else ""
    check("fantasy_sync_runs: 'mode' is sent in the INSERT arm",
          "mode" in run_out.split("ON CONFLICT")[0])
    check("fantasy_sync_runs: 'mode' is NOT in the SET clause (finish cannot clobber it)",
          "mode = excluded" not in run_set, run_set)
    check("fantasy_sync_runs: 'status' IS updated by the finish write",
          "status = excluded.status" in run_set, run_set)

    # Nothing left to update must degrade to INSERT OR IGNORE, never an empty
    # SET clause (a syntax error that lands zero rows).
    only_cols = ["platform", "player_uid", "created_at_utc"]
    only_sql = build_insert("fantasy_players", only_cols, [("yahoo", "nfl.p.1", "t0")],
                            pk_cols=pk)
    only_out = d1mod._exclude_protected(only_sql, only_cols, pk,
                                        d1mod._protected_cols("fantasy_players"))
    check("an all-protected row degrades to INSERT OR IGNORE, not an empty SET",
          "INSERT OR IGNORE" in only_out and "DO UPDATE SET ;" not in only_out,
          only_out.split("\n")[0])

    # The loader refuses tables it has no key for, and rows missing key columns.
    loader = d1mod.D1Loader(target="local", dry_run=True, verbose=False,
                            sql_out_dir=Path(tempfile.mkdtemp()) / "sql")
    check_raises("write_rows REFUSES an unknown table rather than guessing a key",
                 d1mod.D1Error, loader.write_rows, "ups_contracts", [{"a": 1}])
    check_raises("write_rows REFUSES rows missing a primary-key column",
                 d1mod.D1Error, loader.write_rows, "fantasy_players",
                 [{"platform": "yahoo", "full_name": "x"}])
    check_raises("D1Loader REFUSES to be constructed without an explicit target",
                 ValueError, d1mod.D1Loader, target="prod")
    check_raises("write_tagged_rows REFUSES a row with no _table tag",
                 d1mod.D1Error, d1mod.write_tagged_rows, loader, [{"platform": "yahoo"}])

    # Serialization must be stable, or an unchanged re-run looks like an update.
    a = d1mod._serialize({"b": 2, "a": 1})
    b = d1mod._serialize({"a": 1, "b": 2})
    check("dict/list columns serialize deterministically (sorted keys)", a == b, f"{a} vs {b}")
    check("None serializes to None, never to the string 'None'",
          d1mod._serialize(None) is None)
    check("booleans serialize to 1/0 for SQLite",
          d1mod._serialize(True) == 1 and d1mod._serialize(False) == 0)


# ─────────────────────────────────────────────────────────────────────────────
# E. LEAGUE + SEASON SEPARATION — the checks that protect UPS
# ─────────────────────────────────────────────────────────────────────────────

def all_parsed_rows() -> list[dict]:
    """Every row every parser produces off every fixture, in one list.

    Used for the blanket platform assertion: one un-tagged row anywhere breaks
    the platform-first primary keys and could collide with another provider.
    """
    rows: list[dict] = []

    def take(obj):
        if isinstance(obj, dict) and "platform" in obj:
            rows.append(obj)
        elif isinstance(obj, dict):
            for v in obj.values():
                take(v)
        elif isinstance(obj, (list, tuple)):
            for v in obj:
                take(v)

    take(parse.parse_league_metadata(content("yahoo_league_settings_auction.json")))
    take(parse.parse_league_settings(content("yahoo_league_settings_auction.json"),
                                     league_key="461.l.576919", season=2025))
    take(parse.parse_league_settings(content("yahoo_league_settings_snake.json"),
                                     league_key="449.l.529351", season=2024))
    take(parse.parse_user_leagues(content("yahoo_users_games_leagues.json")))
    take(parse.parse_league_metadata(content("yahoo_league_missing_optional.json")))
    take(parse.parse_teams(content("yahoo_single_element_collapse.json"),
                           league_key="461.l.590044", season=2025))
    for fx, auc in (("yahoo_draft_auction.json", 1), ("yahoo_draft_snake.json", 0),
                    ("yahoo_draft_keeper.json", None)):
        take(parse.parse_draft_results(content(fx), league_key="461.l.576919",
                                       season=2025, is_auction=auc))
    for fx in ("yahoo_transaction_add_drop.json", "yahoo_transaction_faab_waiver.json",
               "yahoo_transaction_trade_multi.json"):
        take(parse.parse_transactions(content(fx), league_key="461.l.576919", season=2025))
    take(parse.parse_standings(content("yahoo_standings_final.json"),
                               league_key="461.l.576919", season=2025))
    take(parse.parse_scoreboard(content("yahoo_scoreboard_week.json"),
                                league_key="461.l.576919", season=2025))
    take(parse.parse_rosters(content("yahoo_roster_week.json"), league_key="449.l.529351",
                             season=2024, week=5, starting_slots=ROSTER_STARTING,
                             bench_slots=ROSTER_BENCH, injury_slots=ROSTER_INJURY))
    take(parse.parse_player_week_stats(content("yahoo_roster_week_with_stats.json"),
                                       league_key="449.l.529351", season=2024, week=5))
    take(parse.parse_players_collection(content("yahoo_players_page1.json")))
    take(parse.parse_players_collection(content("yahoo_players_page2.json")))
    return rows


def test_separation() -> None:
    section("E. LEAGUE + SEASON SEPARATION")

    # ⚠️ A Yahoo league key EMBEDS a per-season game id: '390.l.576919' IS the
    # 2019 league. The same key carrying two seasons means two years of results
    # were quietly merged.
    mixed = [
        {"league_key": "390.l.576919", "season": 2019},
        {"league_key": "390.l.576919", "season": 2025},
    ]
    f = checks.check_league_season_consistency(mixed)
    check("a league_key carrying TWO seasons is flagged as an error",
          len(f) == 1 and f[0].severity == "error" and f[0].check == "league_key_spans_seasons",
          str(f))
    check("the finding names the offending key and both seasons",
          "390.l.576919" in str(f[0].sample) and "2019" in str(f[0].sample), str(f[0].sample))
    clean = [{"league_key": "390.l.576919", "season": 2019},
             {"league_key": "461.l.576919", "season": 2025}]
    check("two DIFFERENT keys for two seasons is correct and flags nothing",
          checks.check_league_season_consistency(clean) == [])
    check("rows with no season at all are skipped, not flagged",
          checks.check_league_season_consistency(
              [{"league_key": "390.l.1"}, {"league_key": "390.l.1", "season": 2019}]) == [])

    # A UPS row that has somehow reached a fantasy_* table.
    contaminated = [{"platform": "yahoo"}, {"platform": "mfl"}, {"platform": "yahoo"}]
    f = checks.check_platform_tagging(contaminated)
    check("a row tagged platform='mfl' in a fantasy_* bundle is an error",
          len(f) == 1 and f[0].severity == "error" and f[0].count == 1, str(f))
    check("the finding reports the wrong value it actually saw",
          "mfl" in str(f[0].sample), str(f[0].sample))
    f = checks.check_platform_tagging([{"league_key": "x"}])
    check("a row with NO platform at all is an error too", len(f) == 1)
    check("an all-yahoo bundle flags nothing",
          checks.check_platform_tagging([{"platform": "yahoo"}]) == [])

    # The blanket assertion over every fixture.
    rows = all_parsed_rows()
    off = [r for r in rows if r.get("platform") != "yahoo"]
    check(f"EVERY parsed row across every fixture is platform='yahoo' ({len(rows)} rows)",
          off == [], f"{len(off)} row(s) tagged otherwise: {[r.get('platform') for r in off[:5]]}")
    check("no parsed row carries a UPS-prefixed column name",
          not any(k.startswith(("ups_", "mfl_", "src_")) for r in rows for k in r))

    # The cross-contamination check must REFUSE when it cannot read, never pass.
    def exploding_query(_sql):
        raise RuntimeError("D1 unreachable")

    f = checks.check_cross_contamination(exploding_query)
    check("check_cross_contamination REFUSES (error) when the query fails",
          len(f) == 1 and f[0].severity == "error"
          and f[0].check == "cross_contamination_unreadable", str(f))
    f = checks.check_cross_contamination(lambda _s: [{"platform": "yahoo"}])
    check("a readable, clean database yields an info finding, not an error",
          all(x.severity == "info" for x in f), str(f))
    f = checks.check_cross_contamination(lambda _s: [{"platform": "mfl"}])
    check("an unrecognised platform value in fantasy_* is an error",
          any(x.severity == "error" for x in f), str(f))


# ─────────────────────────────────────────────────────────────────────────────
# F. TRANSACTION LEG INTEGRITY
# ─────────────────────────────────────────────────────────────────────────────

def test_transaction_legs() -> None:
    section("F. TRANSACTION LEG INTEGRITY")

    # ⚠️ A trade with one leg is not a trade — it is the signature of a parser
    # that handled the bare-dict transaction_data shape and not the list shape.
    txns = [{"transaction_key": "tr.1", "transaction_type": "trade"}]
    assets = [{"transaction_key": "tr.1", "leg_index": 0}]
    f = checks.check_transaction_legs(txns, assets)
    check("a TRADE with only 1 leg is flagged an error",
          any(x.check == "transaction_too_few_legs" and x.severity == "error" for x in f),
          str(f))

    # A parent with NO legs at all: the total-failure version of the same bug.
    f = checks.check_transaction_legs(
        [{"transaction_key": "tr.2", "transaction_type": "add/drop"}], [])
    check("a parent transaction with ZERO legs is flagged an error",
          any(x.check == "transaction_without_legs" and x.severity == "error" for x in f),
          str(f))
    check("the zero-leg finding says the cause is an unhandled data shape",
          "shape" in " ".join(x.message for x in f))

    # An orphan leg: the parent was dropped, so the leg can never be joined.
    f = checks.check_transaction_legs(
        [{"transaction_key": "tr.3", "transaction_type": "add"}],
        [{"transaction_key": "tr.3", "leg_index": 0},
         {"transaction_key": "tr.NOPE", "leg_index": 0}])
    check("an asset leg with NO parent transaction is flagged an error",
          any(x.check == "asset_leg_without_parent" and x.severity == "error" for x in f),
          str(f))
    check("the orphan finding names the missing parent key",
          "tr.NOPE" in str([x.sample for x in f]))

    # A leg that moves from nowhere to nowhere.
    f = checks.check_transaction_leg_endpoints([{"transaction_key": "tr.4"}])
    check("a leg with neither source nor destination is flagged an error",
          any(x.check == "leg_without_endpoints" for x in f), str(f))
    f = checks.check_transaction_leg_endpoints(
        [{"transaction_key": "tr.5", "source_type": "waivers",
          "source_team_key": "461.l.1.t.3", "destination_type": "team"}])
    check("a waiver leg that DOES carry a source team is flagged (absence is the signal)",
          any(x.check == "waiver_leg_has_source_team" for x in f), str(f))

    # The real fixtures must pass all of it.
    real = parse.parse_transactions(content("yahoo_transaction_trade_multi.json"),
                                    league_key="461.l.576919", season=2025)
    ad = parse.parse_transactions(content("yahoo_transaction_add_drop.json"),
                                  league_key="461.l.576919", season=2025)
    fw = parse.parse_transactions(content("yahoo_transaction_faab_waiver.json"),
                                  league_key="461.l.576919", season=2025)
    parents = real["fantasy_transactions"] + ad["fantasy_transactions"] + fw["fantasy_transactions"]
    legs = (real["fantasy_transaction_assets"] + ad["fantasy_transaction_assets"]
            + fw["fantasy_transaction_assets"])
    f = [x for x in checks.check_transaction_legs(parents, legs) if x.severity == "error"]
    check("the three real transaction fixtures produce NO leg-integrity errors",
          f == [], "; ".join(x.message for x in f))
    f = [x for x in checks.check_transaction_leg_endpoints(legs) if x.severity == "error"]
    check("and no endpoint errors either", f == [], "; ".join(x.message for x in f))

    # run_all over a full bundle: the auction NULL/zero split must be REPORTED,
    # separately, rather than collapsed into one "missing prices" number.
    draft = parse.parse_draft_results(content("yahoo_draft_auction.json"),
                                      league_key="461.l.576919", season=2025, is_auction=1)
    report = checks.run_all({"fantasy_draft_events": draft["fantasy_draft_events"],
                             "fantasy_transactions": parents,
                             "fantasy_transaction_assets": legs}, is_auction=1)
    names = {x.check for x in report.findings}
    check("run_all reports unpriced picks and $0 picks as SEPARATE findings",
          "missing_auction_prices" in names and "zero_auction_prices" in names, str(names))
    check("the $0 finding is info, the unpriced finding is a warning — different facts",
          {x.severity for x in report.findings if x.check == "zero_auction_prices"} == {"info"}
          and {x.severity for x in report.findings
               if x.check == "missing_auction_prices"} == {"warn"})
    check("a duplicated pick number is caught",
          any(x.check == "duplicate_draft_picks" for x in checks.check_duplicate_draft_picks(
              [{"league_key": "l", "season": 2025, "pick_number": 1},
               {"league_key": "l", "season": 2025, "pick_number": 1}])))


# ─────────────────────────────────────────────────────────────────────────────
# G. REDACTION
# ─────────────────────────────────────────────────────────────────────────────

FAKE_ACCESS = "FAKEaccess0000000000000000000000TOKEN"
FAKE_REFRESH = "FAKErefresh1111111111111111111111TOKEN"
FAKE_SECRET = "FAKEclientsecret2222222222222222"


def test_redaction() -> None:
    section("G. REDACTION — secrets never reach a log, a row or an exception")

    url = ("https://fantasysports.yahooapis.com/fantasy/v2/league/461.l.576919/settings"
           f"?access_token={FAKE_ACCESS}&refresh_token={FAKE_REFRESH}"
           f"&client_secret={FAKE_SECRET}&code=AUTHCODE9999"
           "&league_key=461.l.576919&season=2025&format=json")
    out = redact_url(url)
    for label, secret in (("access_token", FAKE_ACCESS), ("refresh_token", FAKE_REFRESH),
                          ("client_secret", FAKE_SECRET), ("code", "AUTHCODE9999")):
        check(f"redact_url strips the {label} VALUE", secret not in out, out)
    # Over-redacting is its own failure: an error nobody can attribute to a
    # request is an error nobody can fix.
    check("redact_url PRESERVES league_key", "league_key=461.l.576919" in out, out)
    check("redact_url PRESERVES season", "season=2025" in out, out)
    check("redact_url PRESERVES format", "format=json" in out, out)
    check("redact_url PRESERVES the host and path",
          "fantasysports.yahooapis.com/fantasy/v2/league/461.l.576919/settings" in out, out)
    # The parameter NAMES survive so you can see what was sent. Note the
    # placeholder comes back percent-encoded (%5Bredacted%5D) because redact_url
    # re-encodes the query structurally — that is the point of parsing rather
    # than regexing, and it is why this asserts against the decoded form.
    check("redact_url keeps the parameter NAMES so you can see what was sent",
          "access_token=" in out and REDACTED in unquote(out), out)
    check("a URL with no query string comes back unchanged",
          redact_url("https://example.com/a/b") == "https://example.com/a/b")
    check("redact_url on empty input returns '' and does not raise",
          redact_url(None) == "" and redact_url("") == "")
    # A token containing '&' cannot slip past a structural parse.
    tricky = redact_url("https://x/y?access_token=aa%26bb&season=2025")
    check("a token containing an encoded '&' still cannot leak",
          "aa" not in tricky.split("season")[0].replace("access_token", ""), tricky)

    # Free text: three shapes, all of which really occur in error bodies.
    bearer = redact_text("Authorization: Bearer " + FAKE_ACCESS)
    check("redact_text catches a bearer token in an echoed header",
          FAKE_ACCESS not in bearer and "Bearer " + REDACTED in bearer, bearer)
    form = redact_text(f"grant_type=refresh_token&refresh_token={FAKE_REFRESH}"
                       f"&client_secret={FAKE_SECRET}")
    check("redact_text catches secrets in a form body",
          FAKE_REFRESH not in form and FAKE_SECRET not in form, form)
    check("redact_text leaves the non-secret grant_type readable",
          "grant_type=refresh_token" in form, form)
    js = redact_text(json.dumps({"access_token": FAKE_ACCESS, "expires_in": 3600,
                                 "token_type": "bearer"}))
    check("redact_text catches a secret in a JSON field",
          FAKE_ACCESS not in js and '"access_token": "[redacted]"' in js, js)
    check("redact_text leaves diagnostic JSON fields intact",
          "expires_in" in js and "3600" in js, js)
    check("redact_text never raises on None or a non-string",
          redact_text(None) == "" and isinstance(redact_text(12), str))
    check("an unrelated field ending in 'code' is NOT over-redacted",
          "error_code=500" in redact_text("error_code=500"), redact_text("error_code=500"))

    heads = redact_headers({"Authorization": f"Bearer {FAKE_ACCESS}",
                            "Cookie": "SID=abc123", "Set-Cookie": "SID=abc123",
                            "Accept": "application/json", "X-Request-Id": "r-42"})
    check("redact_headers masks Authorization", heads["Authorization"] == REDACTED)
    check("redact_headers masks Cookie and Set-Cookie",
          heads["Cookie"] == REDACTED and heads["Set-Cookie"] == REDACTED)
    check("redact_headers preserves Accept and X-Request-Id",
          heads["Accept"] == "application/json" and heads["X-Request-Id"] == "r-42")
    check("redact_headers is case-insensitive on the header name",
          redact_headers({"authorization": "x"})["authorization"] == REDACTED)
    check("redact_headers on None returns {} and does not raise",
          redact_headers(None) == {})

    params = redact_params({"client_id": "id-1", "league_key": "461.l.1", "week": 5})
    check("redact_params masks client_id but keeps league_key and week",
          params["client_id"] == REDACTED and params["league_key"] == "461.l.1"
          and params["week"] == 5, str(params))

    check("safe_repr truncates as well as redacts (an unbounded body kills an insert)",
          len(safe_repr("x" * 5000)) == 400, str(len(safe_repr("x" * 5000))))
    check("safe_repr still redacts inside the truncated window",
          FAKE_ACCESS not in safe_repr(f"access_token={FAKE_ACCESS}"))

    # ⚠️ A bare print(bundle) or an exception repr must not leak the tokens.
    bundle = TokenBundle(access_token=FAKE_ACCESS, refresh_token=FAKE_REFRESH,
                         expires_at_unix=1786036266, scope="fspt-r")
    r = repr(bundle)
    check("TokenBundle repr() contains NEITHER token",
          FAKE_ACCESS not in r and FAKE_REFRESH not in r, r)
    check("TokenBundle str() (which falls back to repr) leaks nothing either",
          FAKE_ACCESS not in str(bundle) and FAKE_REFRESH not in str(bundle))
    check("TokenBundle repr() still shows the expiry and scope (diagnosable)",
          "1786036266" in r and "fspt-r" in r, r)
    check("an f-string interpolation of the bundle leaks nothing",
          FAKE_REFRESH not in f"failed with {bundle}")
    check("a bundle with NO refresh token says 'None', not '[redacted]'",
          "refresh_token=None" in repr(TokenBundle(access_token=FAKE_ACCESS,
                                                   refresh_token=None,
                                                   expires_at_unix=0)))
    check("the fixture directory contains no bearer/token material at all",
          all(FAKE_ACCESS not in p.read_text(encoding="utf-8", errors="replace")
              for p in FIXTURES.iterdir() if p.is_file()))


# ─────────────────────────────────────────────────────────────────────────────
# H. CROSSWALK — identity resolution, and the 'NA' trap
# ─────────────────────────────────────────────────────────────────────────────

def test_crosswalk() -> None:
    section("H. CROSSWALK — the 'NA' trap and the never-auto-merge rule")

    # ⚠️ ff_player_ids stores missing external ids as the LITERAL STRING 'NA'
    # (R's missing idiom serialized to text) — 4,740 of its 12,468 rows carry
    # it. 'NA' passes both IS NOT NULL and != '', so an unguarded join reports
    # 100% coverage while matching garbage.
    check("usable_id('NA') is None — THE 'NA' trap", xw.usable_id("NA") is None)
    check("usable_id('na') and 'N/A' are None too (case and slash variants)",
          xw.usable_id("na") is None and xw.usable_id("N/A") is None)
    check("usable_id('') , 'null', 'none', '0', '-' are all None",
          all(xw.usable_id(v) is None for v in ("", "null", "none", "0", "-")))
    check("usable_id(None) is None", xw.usable_id(None) is None)
    check("a REAL id survives usable_id", xw.usable_id(" 30977 ") == "30977")

    check("usable_gsis('NA') is None", xw.usable_gsis("NA") is None)
    check("usable_gsis('12345') is None — right presence, WRONG SHAPE",
          xw.usable_gsis("12345") is None)
    check("usable_gsis('00-0034796') IS a gsis id",
          xw.usable_gsis("00-0034796") == "00-0034796")
    check("usable_gsis is a FORMAT check, so a truncated value is refused",
          xw.usable_gsis("00-") == "00-" and xw.usable_gsis("0034796") is None)

    check("normalize_team maps OAK/SD/STL/WSH to their modern abbreviations",
          [xw.normalize_team(t) for t in ("OAK", "SD", "STL", "WSH")]
          == ["LV", "LAC", "LAR", "WAS"])
    check("normalize_position folds DEF->DST and K->PK",
          xw.normalize_position("DEF") == "DST" and xw.normalize_position("K") == "PK")
    check("normalize_name handles the MFL 'Last, First' convention",
          xw.normalize_name("Chase, Ja'Marr") == "jamarr chase",
          repr(xw.normalize_name("Chase, Ja'Marr")))
    check("normalize_name strips generational suffixes",
          xw.normalize_name("Marvin Harrison Jr.") == "marvin harrison")

    identities = [
        {"mfl_id": "16000", "yahoo_id": "30977", "gsis_id": "00-0034857",
         "name": "Josh Allen", "merge_name": "josh allen", "position": "QB", "team": "BUF"},
        # Same normalized name+position, different teams — the ambiguity case.
        {"mfl_id": "17001", "yahoo_id": "NA", "gsis_id": "NA", "name": "Mike Williams",
         "merge_name": "mike williams", "position": "WR", "team": "LAC"},
        {"mfl_id": "17002", "yahoo_id": "NA", "gsis_id": "NA", "name": "Mike Williams",
         "merge_name": "mike williams", "position": "WR", "team": "NYJ"},
        {"mfl_id": "18003", "yahoo_id": "NA", "gsis_id": "00-0039163",
         "name": "Bijan Robinson", "merge_name": "bijan robinson",
         "position": "RB", "team": "ATL"},
    ]
    r = xw.CrosswalkResolver(identities)
    check("rows whose yahoo_id is 'NA' never enter the yahoo index",
          list(r.by_yahoo) == ["30977"], str(list(r.by_yahoo)))
    check("rows whose gsis_id is 'NA' never enter the gsis index",
          set(r.by_gsis) == {"00-0034857", "00-0039163"}, str(set(r.by_gsis)))

    hit = r.resolve({"player_uid": "nfl.p.30977", "provider_player_id": "30977",
                     "full_name": "Josh Allen", "display_position": "QB",
                     "editorial_team_abbr": "Buf"})
    check("step 1 — a provider-id hit resolves EXACT via yahoo_id",
          hit["mfl_id"] == "16000" and hit["confidence"] == xw.CONFIDENCE_EXACT
          and hit["match_method"] == xw.METHOD_PROVIDER_ID, str(hit["confidence"]))
    check("an exact hit needs no review", hit["review_status"] == "none")

    gsis = r.resolve({"player_uid": "nfl.p.40000", "provider_player_id": "NA",
                      "gsis_id": "00-0039163", "full_name": "Bijan Robinson",
                      "display_position": "RB", "editorial_team_abbr": "Atl"})
    check("step 2 — a provider gsis_id resolves EXACT when the provider id is 'NA'",
          gsis["mfl_id"] == "18003" and gsis["match_method"] == xw.METHOD_GSIS,
          str(gsis["match_method"]))

    # ⚠️ RULE 1 — A NAME MATCH ALONE NEVER WRITES A MAPPING.
    amb = r.resolve({"player_uid": "nfl.p.31857", "provider_player_id": "NA",
                     "full_name": "Mike Williams", "display_position": "WR",
                     "editorial_team_abbr": None})
    check("an AMBIGUOUS name-only match returns confidence 'fuzzy_review'",
          amb["confidence"] == xw.CONFIDENCE_FUZZY_REVIEW, str(amb["confidence"]))
    check("⚠️ and mfl_id is None — it REFUSES to merge two players",
          amb["mfl_id"] is None, repr(amb["mfl_id"]))
    check("the ambiguous row is flagged for human review",
          amb["review_status"] == "needed" and amb["resolved_by"] == "ambiguous")
    check("the note says how many candidates collided",
          "2 candidates" in (amb["notes"] or ""), str(amb.get("notes")))

    # Name+team+position, all three agreeing: auto-accepted but still fuzzy.
    auto = r.resolve({"player_uid": "nfl.p.31857", "provider_player_id": "NA",
                      "full_name": "Mike Williams", "display_position": "WR",
                      "editorial_team_abbr": "LAC"})
    check("name AND team AND position agreeing resolves as fuzzy_auto, never exact",
          auto["mfl_id"] == "17001" and auto["confidence"] == xw.CONFIDENCE_FUZZY_AUTO,
          f"{auto['mfl_id']}/{auto['confidence']}")

    # ⚠️ RULE 3 — AN UNRESOLVED PLAYER IS A ROW, NOT AN ABSENCE.
    unres = r.resolve({"player_uid": "nfl.p.100014", "provider_player_id": "100014",
                       "full_name": "Baltimore", "display_position": "DEF",
                       "editorial_team_abbr": "Bal"})
    check("an unresolvable player produces a ROW, not a dropped record",
          isinstance(unres, dict) and unres["player_uid"] == "nfl.p.100014")
    check("its confidence is 'unmapped' and mfl_id is None",
          unres["confidence"] == xw.CONFIDENCE_UNMAPPED and unres["mfl_id"] is None)
    check("it retains the provider's own name/position/team for the report",
          unres["provider_name"] == "Baltimore" and unres["provider_position"] == "DEF")

    # resolve_all must never shrink the player universe.
    players, _ = parse.parse_players_collection(content("yahoo_players_page1.json"))
    resolved = r.resolve_all(players)
    check("resolve_all returns exactly one row per player — no silent drops",
          len(resolved) == len(players), f"{len(resolved)} vs {len(players)}")
    cov = xw.coverage_summary(resolved)
    check("coverage_summary counts total = resolved + unresolved",
          cov["total"] == cov["resolved"] + cov["unresolved"], str(cov))
    check("coverage_summary measures the POSITIVE case directly",
          cov["resolved"] == sum(1 for x in resolved if xw.usable_id(x.get("mfl_id"))))
    check("an mfl_id of 'NA' would NOT count as resolved",
          xw.coverage_summary([{"mfl_id": "NA"}])["resolved"] == 0)
    check("render_unresolved lists the unresolved players rather than hiding them",
          "unresolved player" in xw.render_unresolved(resolved))
    check("render_unresolved on a fully-resolved set says so",
          "every player resolved" in xw.render_unresolved([{"mfl_id": "1"}]))


# ─────────────────────────────────────────────────────────────────────────────
# I. COMPLETENESS — the closed status vocabulary
# ─────────────────────────────────────────────────────────────────────────────

def test_completeness() -> None:
    section("I. COMPLETENESS — seven statuses, and never 'complete' by default")

    RO = completeness.ResourceOutcome
    cases = [
        ("not_applicable", RO("draft", applicable=False), completeness.NOT_APPLICABLE),
        ("not_exposed", RO("player_projections", provider_exposes=False),
         completeness.NOT_EXPOSED),
        ("access_denied", RO("rosters", access_denied=True), completeness.ACCESS_DENIED),
        ("failed", RO("transactions", errored=True), completeness.FAILED),
        ("inferred", RO("weekly_standings", row_count=12, inferred=True),
         completeness.INFERRED),
        ("complete (units met)", RO("matchups", row_count=84, expected_units=17,
                                    observed_units=17), completeness.COMPLETE),
        ("complete (rows, no unit expectation)", RO("settings", row_count=1),
         completeness.COMPLETE),
        ("partial (units short)", RO("rosters", row_count=40, expected_units=17,
                                     observed_units=9), completeness.PARTIAL),
        ("partial (no rows, nothing to measure)", RO("transactions", row_count=0),
         completeness.PARTIAL),
        ("failed (units expected, none observed)", RO("rosters", row_count=200,
                                                      expected_units=17,
                                                      observed_units=0),
         completeness.FAILED),
    ]
    for label, outcome, want in cases:
        got = outcome.classify()
        check(f"classify() -> {label}", got == want, f"got {got!r}, wanted {want!r}")

    seen = {o.classify() for _, o, _ in cases}
    check("all seven statuses are reachable from ResourceOutcome",
          seen == set(completeness.ALL_STATUSES), str(sorted(seen)))

    # ⚠️ THE ONE THAT MATTERS. Expected units with NOTHING measurable observed is
    # UNKNOWN, and unknown is not complete.
    blind = RO("rosters", row_count=500, expected_units=17, observed_units=None)
    check("⚠️ expected_units set + observed_units None classifies FAILED, not complete",
          blind.classify() == completeness.FAILED, blind.classify())
    check("and specifically NOT 'complete' even with 500 rows written",
          blind.classify() != completeness.COMPLETE)
    check("a resource with rows but MORE units than expected is still complete",
          RO("matchups", row_count=90, expected_units=17,
             observed_units=18).classify() == completeness.COMPLETE)
    check("units met but ZERO rows is not complete",
          RO("matchups", row_count=0, expected_units=17,
             observed_units=17).classify() == completeness.PARTIAL)
    check("precedence: not_applicable beats every other flag",
          RO("x", applicable=False, errored=True,
             access_denied=True).classify() == completeness.NOT_APPLICABLE)
    check("precedence: access_denied beats errored",
          RO("x", access_denied=True, errored=True).classify() == completeness.ACCESS_DENIED)

    rows = completeness.build_rows(league_key="461.l.576919", season=2025,
                                   outcomes=[o for _, o, _ in cases], run_id="run-1")
    check("build_rows emits one row per outcome, all platform-tagged",
          len(rows) == len(cases) and all(r["platform"] == "yahoo" for r in rows))
    check("the inferred row carries is_inferred=1",
          any(r["is_inferred"] == 1 for r in rows))
    check("rollup over a set containing 'failed' is 'failed'",
          completeness.rollup(rows) == "failed", completeness.rollup(rows))
    check("rollup of an all-complete set is 'complete'",
          completeness.rollup([{"status": "complete"}]) == "complete")
    check("rollup surfaces access_denied ahead of partial",
          completeness.rollup([{"status": "access_denied"},
                               {"status": "partial"}]) == "access_denied")

    ne = completeness.not_exposed_rows(league_key="461.l.576919", season=2025)
    check("the standing not_exposed rows are written for every known gap",
          len(ne) == len(completeness.YAHOO_NOT_EXPOSED) and len(ne) == 7, f"got {len(ne)}")
    check("every not_exposed row has status not_exposed and NULL units (never a default)",
          all(r["status"] == completeness.NOT_EXPOSED and r["expected_units"] is None
              and r["observed_units"] is None for r in ne))
    check("every not_exposed row explains WHY in prose",
          all(len(r["missing_notes"] or "") > 40 for r in ne))
    check("failed waiver claims are documented as permanently unrecoverable",
          "failed_waiver_claims" in completeness.YAHOO_NOT_EXPOSED)
    check("render_report renders without raising and names the seasons",
          "2025" in completeness.render_report(rows))


# ─────────────────────────────────────────────────────────────────────────────
# J. RAW SINK — provenance, and refusing to truncate
# ─────────────────────────────────────────────────────────────────────────────

def test_raw_sink() -> None:
    section("J. RAW SINK — stable request keys, content addressing, no truncation")

    k1 = rawsink.canonical_request_key("league/settings",
                                       {"league_key": "461.l.1", "season": 2025})
    k2 = rawsink.canonical_request_key("league/settings",
                                       {"season": 2025, "league_key": "461.l.1"})
    check("canonical_request_key is STABLE across dict ordering", k1 == k2, f"{k1[:12]} vs {k2[:12]}")
    check("a different param value produces a different key",
          k1 != rawsink.canonical_request_key("league/settings",
                                              {"league_key": "461.l.1", "season": 2024}))
    check("a different resource produces a different key",
          k1 != rawsink.canonical_request_key("league/teams",
                                              {"league_key": "461.l.1", "season": 2025}))
    check("None params and {} params agree (one request, one key)",
          rawsink.canonical_request_key("games", None)
          == rawsink.canonical_request_key("games", {}))
    check("the key is a hex sha256", len(k1) == 64 and all(c in "0123456789abcdef" for c in k1))

    body = '{"fantasy_content":{"league":[]}}'
    check("payload_hash is content-addressed (sha256 of the exact body)",
          rawsink.payload_hash(body) == hashlib.sha256(body.encode()).hexdigest())
    check("an unchanged re-fetch hashes identically (so re-ingest is a no-op)",
          rawsink.payload_hash(body) == rawsink.payload_hash(body))
    check("one changed byte changes the hash",
          rawsink.payload_hash(body) != rawsink.payload_hash(body + " "))

    check_raises("RawSink REFUSES an unknown sink mode", ValueError, rawsink.RawSink, "s3")

    # ⚠️ REFUSE RATHER THAN TRUNCATE. A silently clipped payload is worse than
    # no payload: it looks reparseable and is not.
    big = rawsink.RawSink("d1")
    oversized = "x" * (rawsink.D1_INLINE_MAX_BYTES + 1)
    check_raises("the d1 sink REFUSES a payload over the inline limit (never truncates)",
                 ValueError, big, resource="league/rosters", endpoint_path="/x",
                 request_params={"week": 5}, body=oversized, http_status=200)
    check("the refused payload left NO index row claiming it was stored",
          big.records == [], f"{len(big.records)} record(s)")
    # A DIFFERENT body on purpose: the sink marks a request+payload pair as seen
    # BEFORE it stores it, so replaying the identical refused call comes back
    # deduped rather than refused a second time. That ordering is fine in
    # practice — the first refusal aborts the run — but it means this assertion
    # has to use a payload the sink has not seen.
    try:
        big(resource="league/rosters", endpoint_path="/x", request_params={"week": 6},
            body=oversized + "y", http_status=200)
        msg = ""
    except ValueError as exc:
        msg = str(exc)
    check("the refusal states the size, the limit and the remedy",
          str(rawsink.D1_INLINE_MAX_BYTES) in msg and "--raw-sink=file" in msg, msg[:110])

    small = rawsink.RawSink("d1", run_id="run-7")
    small(resource="league/settings", endpoint_path="/fantasy/v2/league/461.l.1/settings",
          request_params={"format": "json"}, body=body, http_status=200,
          league_key="461.l.1", season=2025)
    rows = small.drain()
    check("a payload UNDER the limit is stored inline", len(rows) == 1
          and rows[0]["payload"] == body)
    check("the index row records the sink, the hash and the parser version",
          rows[0]["payload_sink"] == "d1"
          and rows[0]["response_hash"] == rawsink.payload_hash(body)
          and rows[0]["parser_version"], str(rows[0]["parser_version"]))
    check("drain() is idempotent — a second call yields nothing",
          small.drain() == [])

    # Dedup within a run is content-addressed, not time-based.
    dedup = rawsink.RawSink("none")
    for _ in range(3):
        dedup(resource="games", endpoint_path="/games", request_params={},
              body=body, http_status=200)
    check("an identical re-fetch inside one run is deduped, not re-recorded",
          len(dedup.records) == 1 and dedup.skipped_duplicates == 2,
          f"{len(dedup.records)} records / {dedup.skipped_duplicates} skipped")
    check("the 'none' sink still writes the INDEX row — provenance never depends "
          "on the body surviving",
          dedup.records[0].payload_sink == "none" and dedup.records[0].payload is None)

    # File sink: a real gzip round trip, and a deterministic navigable path.
    with tempfile.TemporaryDirectory() as td:
        fs = rawsink.RawSink("file", archive_dir=Path(td))
        ref = fs(resource="league/transactions", endpoint_path="/x",
                 request_params={"league_key": "461.l.1"}, body=body, http_status=200,
                 league_key="461.l.1", season=2025, week=5)
        check("the file sink writes a gzipped archive and returns its path",
              ref and Path(ref).exists(), str(ref))
        check("read_archived round-trips the payload byte-for-byte",
              rawsink.read_archived(ref) == body)
        check("the archive path is keyed by season and league, not by pull date",
              "/2025/" in ref.replace("\\", "/") and "461.l.1" in ref, ref)
        check("the week is in the object name so weekly pages cannot collide",
              ".wk05." in ref, ref)
        check_raises("read_archived REFUSES a missing file rather than returning ''",
                     FileNotFoundError, rawsink.read_archived, Path(td) / "nope.json.gz")
        summary = fs.summary()
        check("summary() reports the mode and the bytes actually written",
              summary["mode"] == "file" and summary["bytes"] == len(body.encode()))


# ─────────────────────────────────────────────────────────────────────────────

_FULL_CREATE_TABLE_RE = re.compile(
    r"CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\((.*?)\n\);", re.S | re.I)
_CONSTRAINT_KEYWORDS = ("PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT")
_ALTER_ADD_RE = re.compile(
    r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+([a-zA-Z_][a-zA-Z0-9_]*)", re.I)


def _real_columns() -> dict[str, set[str]]:
    """Parse the ACTUAL migration DDL for every table's real column set."""
    sql_files = sorted(p for p in MIGRATIONS.glob("0*.sql") if p.name >= "0127")
    all_sql = "\n".join(p.read_text(encoding="utf-8") for p in sql_files)
    out: dict[str, set[str]] = {}
    for table, body in _FULL_CREATE_TABLE_RE.findall(all_sql):
        cols = set()
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            m = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s+", line)
            if m and m.group(1).upper() not in _CONSTRAINT_KEYWORDS:
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


def test_adapter_full_path_schema() -> None:
    section("K. ADAPTER FULL PATH — extra AND missing columns, through the real "
            "methods, against d1.PRIMARY_KEYS")

    # ⚠️ THIS SECTION EXISTS BECAUSE A LIVE ESPN BACKFILL FOUND THE SAME BUG
    # HERE, DORMANT. fetch_standings's own comment PROMISED "as_of_week is
    # stamped by the loader" — nothing did. Since Yahoo API access is still
    # pending approval, this codepath had never actually run; it was only
    # caught because the identical pattern in the ESPN adapter got exercised
    # against a real league on 2026-08-12. Fixed in both adapters at once.
    # Every other section here calls parse.py functions directly, which is
    # exactly what let this hide — as_of_week is added by the ADAPTER, after
    # parse_standings returns, so testing the parser alone can never see it.
    client = YahooClient(token_provider=lambda: "fake-token", stats=ClientStats())
    provider = YahooProvider(client)
    ref = pbase.LeagueRef(platform="yahoo", league_key="461.l.576919", season=2025,
                          game_key="461", league_id="576919")

    def fake_get_json(path, *, resource, params=None, scope=None):
        if "settings" in path:
            return content("yahoo_league_settings_auction.json")
        if "standings" in path:
            return content("yahoo_standings_final.json")
        raise AssertionError(f"unexpected path in this test: {path}")

    real = _real_columns()
    with mock.patch.object(client, "get_json", side_effect=fake_get_json):
        # Settings must be fetched first — it populates the cache
        # _current_week/_settings_end_week read from, exactly like a real
        # backfill_season always does.
        settings_result = provider.fetch_league_settings(ref)
        standings_result = provider.fetch_standings(ref)

    missing_bad, extra_bad = [], []
    for result in (settings_result, standings_result):
        for row in result.rows:
            table = row.get("_table")
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

    check("no adapter method emits an unknown column", extra_bad == [], "; ".join(extra_bad[:5]))
    check("⚠️ no adapter method emits a row missing part of its table's "
          "PRIMARY KEY (fantasy_standings_snapshots.as_of_week specifically — "
          "the exact bug a live ESPN backfill found in this same pattern)",
          missing_bad == [], "; ".join(missing_bad[:5]))

    standings_rows = [r for r in standings_result.rows
                      if r.get("_table") == "fantasy_standings_snapshots"]
    check("fantasy_standings_snapshots rows carry a real as_of_week (not None)",
          standings_rows and all(r.get("as_of_week") is not None for r in standings_rows),
          [r.get("as_of_week") for r in standings_rows])
    check("as_of_week matches the league's current_week (17 in this fixture)",
          all(r.get("as_of_week") == 17 for r in standings_rows),
          [r.get("as_of_week") for r in standings_rows])


def test_approved_use_case() -> None:
    section("L. APPROVED USE CASE — the signed Yahoo agreement is enforced in "
            "code, not just documented")

    # The API Access and Use Agreement (executed 2026-08-19, effective
    # 2026-08-21) names a NARROW Approved Use Case: completed drafts,
    # transactions, weekly rosters, and final standings. Exhibit A §2.c.x
    # separately bars compiling "all players in a fantasy league". Yahoo may
    # audit (§14) and may terminate immediately for any reason (§6), so the
    # boundary belongs in the code path, not only in a doc.
    from pipelines.fantasy.providers.yahoo.adapter import OutsideApprovedUseCase

    client = YahooClient(token_provider=lambda: "fake-token", stats=ClientStats())
    provider = YahooProvider(client)
    ref = pbase.LeagueRef(platform="yahoo", league_key="461.l.576919", season=2025,
                          game_key="461", league_id="576919")

    # If this ever stops raising, a league-wide player catalog pull became
    # reachable again — that is a contract breach, not a feature.
    raised = None
    called = {"n": 0}

    def must_not_be_called(*a, **k):
        called["n"] += 1
        raise AssertionError("fetch_players must not reach the network")

    with mock.patch.object(client, "get_json", side_effect=must_not_be_called):
        with mock.patch.object(client, "paginate", side_effect=must_not_be_called):
            try:
                provider.fetch_players(ref)
            except OutsideApprovedUseCase as exc:
                raised = exc

    check("fetch_players REFUSES rather than compiling the league player universe",
          raised is not None)
    check("it refuses BEFORE any network call (no partial pull, no wasted quota)",
          called["n"] == 0)
    check("the refusal cites the specific clause, so the reason survives triage",
          raised is not None and "2.c.x" in str(raised),
          str(raised)[:80] if raised else "no exception")
    check("it is a ProviderError subclass — the CLI reports it, never swallows it",
          isinstance(raised, pbase.ProviderError))
    check("error_kind marks it as a scope refusal, distinct from a failure",
          getattr(raised, "error_kind", None) == "outside_approved_use_case",
          getattr(raised, "error_kind", None))
    check("it is NOT retryable — retrying a contract boundary is nonsense",
          getattr(raised, "retryable", True) is False)

    # The whole point of the gate is that legitimate roster data still flows.
    # If backfill quietly started calling fetch_players, the refusal above
    # would turn every backfill into a hard failure — so assert the orchestrator
    # never reaches for it.
    import inspect
    backfill_src = inspect.getsource(YahooProvider.backfill_season)
    sync_src = inspect.getsource(YahooProvider.sync_season)
    check("backfill_season does not call fetch_players",
          "fetch_players" not in backfill_src)
    check("sync_season does not call fetch_players",
          "fetch_players" not in sync_src)
    check("backfill still covers the four APPROVED resources",
          all(r in backfill_src for r in ("fetch_draft_results", "fetch_transactions",
                                          "fetch_rosters", "fetch_standings")))


def main() -> None:
    print("FANTASY PIPELINE TEST — Yahoo shape, parsers, idempotency, redaction, "
          "crosswalk\n")
    print(f"  fixtures: {FIXTURES.relative_to(REPO_ROOT)}  "
          f"({len(list(FIXTURES.glob('*')))} files, all SYNTHETIC)")

    for fn in (test_shape, test_no_fail_open,
               test_parse_auction_draft, test_parse_transactions, test_parse_rosters,
               test_parse_standings_and_scoreboard, test_parse_league_and_players,
               test_idempotency, test_separation, test_transaction_legs,
               test_redaction, test_crosswalk, test_completeness, test_raw_sink,
               test_adapter_full_path_schema, test_approved_use_case):
        fn()

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s) did not hold:")
        for f in FAILURES:
            print("  " + f)
        sys.exit(1)
    print("PASSED — no read can fail open, NULL never became 0, and no shape "
          "silently returned zero rows")


if __name__ == "__main__":
    main()
