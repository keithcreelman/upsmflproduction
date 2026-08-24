#!/usr/bin/env python3
"""CBS draft-results scraper tests.

WHY A THIRD TEST FILE. CBS is not a JSON API like Yahoo/ESPN — its history is
server-rendered HTML, so the failure modes are different (markup drift, silent
row truncation, identifiers hidden in anchors) and deserve their own suite.

THE FINDING THAT SHAPED THIS FILE: CBS's JSON API serves ONLY the current
season. `&season=` is ignored under every spelling, and a payload-HASH compare
falsely reported that league/stats had history — a CONTENT compare showed
0 of 1,941 players differed. History exists only in the website HTML.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURES = REPO_ROOT / "tests" / "fixtures" / "cbs"
sys.path.insert(0, str(REPO_ROOT / "pipelines"))

import re                                                   # noqa: E402
sys.path.insert(0, str(REPO_ROOT))
from fantasy.providers.cbs import constants as C          # noqa: E402
from fantasy.providers.cbs.parse import parse_draft_results  # noqa: E402
from fantasy.providers.cbs import parse_api                     # noqa: E402
from fantasy.providers.cbs.api import CbsApiClient              # noqa: E402
from fantasy.providers.cbs.adapter import (                     # noqa: E402
    CbsProvider, SeasonNotServedByApi, NotImplementedInThisPass)
from fantasy.providers.base import (                            # noqa: E402
    LeagueRef, ProviderError, UnreadableResponseError)
from fantasy.scoring import ScoringError, ScoringTable          # noqa: E402
from fantasy.providers.cbs.rules import parse_rules, is_secret_row  # noqa: E402
from fantasy.providers.cbs.stats import (                          # noqa: E402
    MIN_ROWS, StatsError, coverage, diff_seasons, implausible, parse_stats_table,
    solve_season)
from pipelines.fantasy import d1 as d1mod                  # noqa: E402

MIGRATIONS = REPO_ROOT / "worker" / "migrations"
_CREATE_RE = re.compile(r"CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\((.*?)\n\);", re.S)
_ALTER_ADD_RE = re.compile(
    r"ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+([a-zA-Z_][a-zA-Z0-9_]*)", re.I)
_CONSTRAINTS = {"PRIMARY", "FOREIGN", "UNIQUE", "CHECK", "CONSTRAINT"}


def real_columns() -> dict[str, set[str]]:
    """Parse the ACTUAL migration DDL. The CBS suite shipped without this and
    the parser emitted SEVEN phantom columns (overall_pick_number,
    total_fantasy_points, player_name_at_draft, ...) that no table has — the
    same bug class a live backfill hit twice on ESPN."""
    files = sorted(p for p in MIGRATIONS.glob("0*.sql") if p.name >= "0127")
    if not files:
        raise SystemExit("no fantasy migrations found — refusing to audit nothing")
    all_sql = "\n".join(p.read_text(encoding="utf-8") for p in files)
    out: dict[str, set[str]] = {}
    for table, body in _CREATE_RE.findall(all_sql):
        cols = set()
        for line in body.splitlines():
            line = line.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            m = re.match(r"^([a-zA-Z_][a-zA-Z0-9_]*)\s+", line)
            if m and m.group(1).upper() not in _CONSTRAINTS:
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

FAILURES: list[str] = []


def section(t: str) -> None:
    print(f"\n{t}")


def check(desc: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'}  {desc}" + (f"  ({detail})" if detail else ""))
    if not ok:
        FAILURES.append(desc)


def check_raises(desc: str, exc, fn) -> None:
    try:
        fn()
    except exc:
        check(desc, True); return
    except Exception as e:                                  # noqa: BLE001
        check(desc, False, f"raised {type(e).__name__}"); return
    check(desc, False, "did not raise")


def fixture() -> str:
    return (FIXTURES / "cbs_draft_results_2019.html").read_text(encoding="utf-8")


def test_urls() -> None:
    section("A. URL SHAPE — the path form is authoritative")
    check("league_id is the SUBDOMAIN STRING, not a number "
          "(every numeric guess returns HTTP 400 'Missing league_id')",
          C.DEFAULT_LEAGUE_ID == "grffl")
    u = C.draft_results_url(2019)
    check("draft history uses the PATH form /draft/results/<YEAR>", u.endswith("/draft/results/2019"), u)
    check("⚠️ NOT the query form — /draft/results?season=2019 also returns HTTP 200 "
          "but with FEWER rows (252 vs 294), silently dropping real picks",
          "?" not in u)
    check("team_key slugs a franchise NAME (CBS history exposes no team id)",
          C.team_key(2019, "grffl", '"Sweet"ish Chef').endswith(".t.sweet-ish-chef"))


def test_parse() -> None:
    section("B. PARSE — real markup, derived numbering, nothing invented")
    t = parse_draft_results(fixture(), season=2019, league_id="grffl", teams_in_league=12)
    ev = t["fantasy_draft_events"]
    d = t["fantasy_drafts"][0]

    check("round banners drive round_number (not row position)",
          [e["round_number"] for e in ev] == [1, 1, 1, 2, 2],
          str([e["round_number"] for e in ev]))
    check("the REPEATED per-round 'Pick' header row is skipped, not parsed as a pick",
          len(ev) == 5, f"{len(ev)} picks")
    check("the second table (Draft Room Chat Log) is ignored entirely",
          all(e["raw_pick_json"]["player_name"] != "Bye" for e in ev))
    check("overall_pick_number is DERIVED from league width, not row order "
          "(R2.01 in a 12-team league is pick 13)",
          ev[3]["pick_number"] == 13, str(ev[3]["pick_number"]))

    check("⚠️ the CBS player id is recovered from the ANCHOR href — a text-only "
          "scrape loses the only stable cross-season identifier the page has",
          ev[0]["player_uid"] == "ffl.p.2185957", str(ev[0]["player_uid"]))
    check("a player with no anchor yields player_uid None rather than a fake id",
          ev[3]["player_uid"] is None)
    check("position and NFL team split out of the display cell",
          (ev[0]["player_position_at_draft"], ev[0]["nfl_team_at_draft"]) == ("RB", "PHI"))
    check("a player with NO nfl team parses rather than being dropped",
          ev[3]["raw_pick_json"]["player_name"] == "Test Retired"
          and ev[3]["nfl_team_at_draft"] is None)

    check("⚠️ the leading '*' is CAPTURED but NOT interpreted — it is stored as a "
          "flag with the raw cell kept, because CBS never labels it and this "
          "league reports uses_keepers=0 (calling it is_keeper would be a guess)",
          ev[0]["keeper_inferred"] == 1 and ev[0]["is_keeper"] is None
          and ev[0]["keeper_inference_basis"]
          and ev[1]["keeper_inferred"] == 0)

    check("⚠️ a BLANK points cell is None, never 0.0",
          ev[4]["raw_pick_json"]["total_fantasy_points"] is None
          and ev[4]["raw_pick_json"]["active_fantasy_points"] is None)
    check("...while a REAL zero stays 0.0 — the two must never collapse",
          ev[3]["raw_pick_json"]["total_fantasy_points"] == 0.0)
    check("league-scored points survive in raw_pick_json (this is WHY the draft "
          "table is worth scraping — points under the league's OWN rules)",
          ev[0]["raw_pick_json"]["total_fantasy_points"] == 252.1
          and ev[0]["raw_pick_json"]["active_fantasy_points"] == 229.9)

    check("franchise name survives quoting/punctuation intact",
          ev[1]["raw_pick_json"]["team_name"] == '"Sweet"ish Chef')
    check("draft summary counts rounds and picks from the parsed rows",
          (d["num_rounds"], d["num_picks"]) == (2, 5), f"{d['num_rounds']}/{d['num_picks']}")
    check("every row carries platform + league_key + season",
          all(e["platform"] == "cbs" and e["league_key"] == "ffl.s2019.l.grffl"
              and e["season"] == 2019 for e in ev))


def test_no_fail_open() -> None:
    section("C. NO FAIL-OPEN — an unreadable page is never an empty draft")
    check_raises("a page with NO table RAISES rather than reporting 0 picks",
                 ValueError, lambda: parse_draft_results("<html><body>nope</body></html>",
                                                         season=2019, league_id="grffl"))
    check_raises("⚠️ a page that RENDERS a table but yields zero picks RAISES — "
                 "this is the exact shape of a login redirect or a markup change, "
                 "and reporting it as 'this season had no draft' would be a lie",
                 ValueError,
                 lambda: parse_draft_results(
                     '<table class="data"><tr><td colspan="7">Round 1</td></tr>'
                     '<tr><th>Pick</th><th>Team</th><th>Player</th></tr></table>',
                     season=2019, league_id="grffl"))

    # width guard: without a known league width, overall numbering must not be invented
    t = parse_draft_results(fixture(), season=2019, league_id="grffl")   # no teams_in_league
    ev = t["fantasy_draft_events"]
    check("with league width UNKNOWN, overall_pick_number is inferred from the "
          "widest round seen rather than assumed to be 12",
          ev[3]["pick_number"] == 4, str(ev[3]["pick_number"]))


def test_schema_audit() -> None:
    section("D. SCHEMA AUDIT — every emitted key is a REAL column")
    real = real_columns()
    t = parse_draft_results(fixture(), season=2019, league_id="grffl", teams_in_league=12)
    check("the audit parsed real DDL (an empty result would pass vacuously)",
          len(real) > 30, f"{len(real)} tables")
    for table, rows in t.items():
        cols = real.get(table) or set()
        check(f"{table} is a table the migrations declare", bool(cols))
        extra = {k for row in rows for k in row} - cols
        check(f"⚠️ {table}: no phantom columns", not extra, sorted(extra))
        pk = d1mod.PRIMARY_KEYS[table]
        missing = [k for k in pk if any(k not in row for row in rows)]
        check(f"⚠️ {table}: every row carries its full PRIMARY KEY {pk}",
              not missing, str(missing))


def rules_fixture() -> str:
    return (FIXTURES / "cbs_rules_scoring.html").read_text(encoding="utf-8")


def test_rules() -> None:
    section("E. RULES — scoring vs settings, and the bug that hid the real rules")
    t = parse_rules(rules_fixture(), season=2026, league_id="grffl")
    sc = t["fantasy_scoring_rules"]
    by = {(r["position_type"], r["stat_abbr"]): r for r in sc}

    # ── THE REGRESSION THAT MATTERS MOST ────────────────────────────────────
    # CBS writes "4 pointsPlus 1 point for a PaTD of 10 to 39 Yds" with NO
    # separator. The first regex used `points?\b`, which never matches there,
    # so EVERY touchdown rule carrying a distance bonus was silently misfiled
    # as a league setting. The parser still returned clean output and no error
    # — it just omitted the rules that define the league (32 rules instead of
    # 48 on the live page).
    check("⚠️ a bonus concatenated with NO separator still parses "
          "('4 pointsPlus 1 point for a PaTD…')",
          ("QB", "PaTD") in by and by[("QB", "PaTD")]["modifier"] == 4.0,
          str(by.get(("QB", "PaTD"), {}).get("modifier")))
    check("...and the bonus prose is PRESERVED, because `modifier` alone "
          "understates what a long touchdown is worth",
          "Plus 1 point" in (by[("QB", "PaTD")]["raw_stat_json"]["bonus_text"] or ""))
    check("every TD rule in the fixture carries its bonus text",
          all(by[k]["raw_stat_json"]["bonus_text"]
              for k in by if k[1] in ("PaTD", "ReTD", "RuTD")))

    # ── position scoping ────────────────────────────────────────────────────
    check("⚠️ the SAME abbreviation scores differently by position — ReTD is 12 "
          "for a QB and 6 for a WR, so a rule is meaningless without its position",
          by[("QB", "ReTD")]["modifier"] == 12.0 and by[("WR", "ReTD")]["modifier"] == 6.0)
    check("stat_id is scoped by position so the two never collide on the PK",
          by[("QB", "ReTD")]["stat_id"] != by[("WR", "ReTD")]["stat_id"])
    check("negative modifiers survive as negatives",
          by[("QB", "PaInt")]["modifier"] == -2.0)

    # ── shape conflation: numbers that are NOT scoring ──────────────────────
    # A first version treated any numerically-valued row as a scoring rule,
    # which classified Teams/Draft Rounds/League Entry Fee as scoring.
    labels = {r["stat_name"] for r in sc}
    check("⚠️ 'Teams', 'Draft Rounds' and 'League Entry Fee' are SETTINGS, not "
          "scoring rules, despite having numeric values",
          not ({"Teams", "Draft Rounds", "League Entry Fee"} & labels), str(sorted(labels)))
    setting_desc = {s_["description"] for s_ in t["_settings"]}
    check("...and they are kept as settings rather than dropped",
          {"Teams", "Draft Rounds"} <= setting_desc)

    # ── credentials ─────────────────────────────────────────────────────────
    check("⚠️ the league PASSWORD row is redacted, never emitted",
          t["_redacted_rows"] >= 1
          and not any("password" in (s_["description"] or "").lower() for s_ in t["_settings"])
          and not any("password" in r["stat_name"].lower() for r in sc))
    check("is_secret_row catches the credential-bearing labels",
          is_secret_row("League Password") and is_secret_row("Invite Code")
          and not is_secret_row("Draft Rounds"))

    # ── prose / inlined JS must not become rules ────────────────────────────
    check("⚠️ parsing STOPS at the Constitution banner, so league prose and the "
          "inlined JavaScript after it never become scoring rules",
          not any("f.push" in r["stat_name"] for r in sc)
          and not any("f.push" in (s_["description"] or "") for s_ in t["_settings"]))

    # ── unreadable values ───────────────────────────────────────────────────
    check("a value that is not points is KEPT and flagged, never given a "
          "made-up number",
          any(s_.get("unparsed_scoring_value") and "Weighting" in s_["description"]
              for s_ in t["_settings"]))

    # ── no-fail-open ────────────────────────────────────────────────────────
    check_raises("a page with no rows RAISES rather than reporting an empty rulebook",
                 ValueError, lambda: parse_rules("<html><body></body></html>",
                                                 season=2026, league_id="grffl"))
    check_raises("⚠️ a page that renders SETTINGS but no per-position scoring "
                 "blocks RAISES — that is the signature of /league/rules (the CBS "
                 "shell, 358KB, zero scoring terms) being scraped by mistake",
                 ValueError,
                 lambda: parse_rules('<table><tr><td>Description</td><td>Setting</td></tr>'
                                     '<tr><td>Teams</td><td>12</td></tr></table>',
                                     season=2026, league_id="grffl"))

    # ── schema ──────────────────────────────────────────────────────────────
    real = real_columns()
    cols = real.get("fantasy_scoring_rules") or set()
    check("fantasy_scoring_rules is a real table", bool(cols))
    extra = {k for r in sc for k in r} - cols
    check("⚠️ no phantom columns on fantasy_scoring_rules", not extra, sorted(extra))
    pk = d1mod.PRIMARY_KEYS["fantasy_scoring_rules"]
    missing = [k for k in pk if any(k not in r for r in sc)]
    check(f"every rule carries its full PRIMARY KEY {pk}", not missing, str(missing))


def stats_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def test_stats_solver() -> None:
    section("F. STATS SOLVER — coefficients are SOLVED, and bad fits are refused")

    # ── round trip: the fixture PLANTS known scoring, the solver must recover it
    qb = solve_season(stats_fixture("cbs_stats_qb_2022.html"), season=2022, position="QB")
    c = qb.coefficients
    def near(k, want, tol=0.02):
        return k in c and abs(c[k] - want) <= tol
    check("QB round trip: passing yards recovered (0.04)", near("Passing.Yds", 0.04), str(c.get("Passing.Yds")))
    check("QB round trip: passing TD recovered (4)", near("Passing.TD", 4.0), str(c.get("Passing.TD")))
    check("QB round trip: interception recovered (-2)", near("Passing.Int", -2.0), str(c.get("Passing.Int")))
    check("QB round trip: rushing TD recovered (12)", near("Rushing.TD", 12.0, 0.05), str(c.get("Rushing.TD")))
    check("a stat that does NOT score solves to ~0 rather than absorbing signal",
          abs(c.get("Passing.ATT", 9)) < 0.02 and abs(c.get("Passing.Comp", 9)) < 0.02)

    # ── the bug that made the first solver produce 5.15 pts per rushing yard ──
    # Column layout is POSITION-DEPENDENT: QB has NO receiving group at all,
    # and WR puts Receiving BEFORE Rushing. A fixed offset map cannot express
    # both; only reading the group banner's colspans can.
    feats_qb, _ = parse_stats_table(stats_fixture("cbs_stats_qb_2022.html"))
    feats_wr, _ = parse_stats_table(stats_fixture("cbs_stats_wr_2022.html"))
    check("⚠️ QB has NO receiving columns — a fixed offset map that assumes them "
          "mislabels every column to its right",
          not any(x.startswith("Receiving.") for x in feats_qb), str(feats_qb))
    check("⚠️ WR orders Receiving BEFORE Rushing (QB is Passing→Rushing), so "
          "group ORDER varies by position and must come from colspans",
          feats_wr.index("Receiving.Rec") < feats_wr.index("Rushing.Att"), str(feats_wr))
    check("⚠️ the derived 'Avg' column (yards per carry) is EXCLUDED — it is not "
          "a scoring input and would corrupt the fit",
          not any(x.endswith(".Avg") for x in feats_qb + feats_wr))

    wr = solve_season(stats_fixture("cbs_stats_wr_2022.html"), season=2022, position="WR")
    w = wr.coefficients
    check("WR round trip: reception recovered (1.0)", abs(w["Receiving.Rec"] - 1.0) <= 0.02)
    check("WR round trip: receiving TD (6) and rushing TD (12) are DIFFERENT — "
          "this league pays double for out-of-position TDs",
          abs(w["Receiving.TD"] - 6.0) <= 0.05 and abs(w["Rushing.TD"] - 12.0) <= 0.05,
          f"rec={w['Receiving.TD']} rush={w['Rushing.TD']}")

    # ── refusals ─────────────────────────────────────────────────────────────
    whole, top, _ = coverage(parse_stats_table(
        stats_fixture("cbs_stats_wr_partial.html"))[1])
    check("coverage() separates the two numbers: shallow overall, healthy at top",
          whole < 0.6 <= top, f"whole={whole:.2f} top={top:.2f}")

    check_raises("⚠️ a full-size table of numeric ZEROS is REFUSED, not fitted. "
                 "CBS returns 100 rows with no data for old seasons (2010 RB: "
                 "0/100 populated) and least squares reports 'a touchdown is "
                 "worth 0.0' with a clean R²",
                 StatsError,
                 lambda: solve_season(stats_fixture("cbs_stats_rb_zeros.html"),
                                      season=2010, position="RB"))
    # ⚠️ THIS TEST WAS INVERTED ON 2026-08-23. It used to assert that partial
    # coverage is REFUSED, which encoded a guard that measured coverage across
    # the WHOLE list. That guard rejected QB 2022 — a complete season — because
    # a 100-deep QB list is mostly third-stringers with real zeros (63/100).
    # Coverage is now judged at the TOP of the list, so "leaders have stats,
    # tail is zero-stat backups" is ACCEPTED, and only a season whose LEADERS
    # have no stats is refused.
    partial = solve_season(stats_fixture("cbs_stats_wr_partial.html"),
                           season=2019, position="WR")
    check("a long tail of zero-stat players is ACCEPTED when the leaders have "
          "data (this is what a real season looks like at QB)",
          partial.n >= MIN_ROWS)
    check("...and the shallow whole-list coverage is still REPORTED so a caller "
          "can see how deep the data goes",
          partial.populated_fraction < 0.6, str(partial.populated_fraction))

    check_raises("a table with no parsable rows is refused",
                 StatsError,
                 lambda: solve_season(stats_fixture("cbs_stats_rb_empty.html"),
                                      season=2010, position="RB"))
    check_raises("a page that is not a stats table is refused",
                 StatsError,
                 lambda: parse_stats_table("<html><body><p>nope</p></body></html>"))

    # ── the guard R² cannot replace ──────────────────────────────────────────
    check("⚠️ implausible() rejects a misaligned fit — 5.15 pts per rushing yard "
          "scored R²=0.999 and was still nonsense, so bounds, not fit quality, "
          "are what catch a column-mapping error",
          implausible({"Rushing.Yds": 5.147}) and implausible({"Rushing.TD": -2.2}))
    check("...and accepts this league's genuinely unusual values (a 12-point "
          "out-of-position TD must NOT be flagged)",
          not implausible({"Rushing.TD": 12.0, "Receiving.TD": 6.0,
                           "Receiving.Rec": 1.0, "Passing.Yds": 0.04}))
    check("a perfect R² is reported but is NOT the acceptance criterion",
          qb.r2 >= 0.99 and qb.rmse < 1.0, f"r2={qb.r2} rmse={qb.rmse}")
    check("populated_fraction is reported so a caller can see coverage",
          qb.populated_fraction == 1.0)

    # ── season diffing ───────────────────────────────────────────────────────
    d = diff_seasons([qb, wr])
    check("diff_seasons keys by position.stat so a rules change is visible "
          "year over year", "QB.Passing.TD" in d and d["QB.Passing.TD"][2022] == c["Passing.TD"])



# ═════════════════════════════════════════════════════════════════════════════
# JSON API — league state (Step 1). Everything below runs against captured,
# PSEUDONYMISED payloads: real leaguemates' names and CBS account GUIDs were
# replaced with deterministic stand-ins, and team names with 'Team NN'. The
# STRUCTURE is what these assert on, so the substitution costs nothing.
# ═════════════════════════════════════════════════════════════════════════════

def api_fixture(name: str) -> dict:
    """Load a captured envelope and return its unwrapped `body`, through the
    REAL unwrap path — so the envelope guards are exercised on every use
    rather than only in the section that targets them."""
    raw = (FIXTURES / name).read_text(encoding="utf-8")
    return CbsApiClient._unwrap(raw, endpoint=name, safe_url=name, http_status=200)


def test_api_envelope() -> None:
    section("G. API ENVELOPE — CBS's three ways of answering without saying so")

    body = api_fixture("cbs_api_league_details.json")
    check("a good envelope unwraps to its body", "league_details" in body)

    # ⚠️ THE REASON THIS GUARD EXISTS. CBS answers an endpoint that does not
    # exist with ~95KB of HTML and an HTTP 404 — never a JSON error. Left
    # unguarded, json.loads raises somewhere up the stack and the natural
    # (wrong) fix is a try/except that yields an empty result.
    check_raises("HTML masquerading as a response raises, never returns empty",
                 UnreadableResponseError,
                 lambda: CbsApiClient._unwrap(
                     "Not Found<!DOCTYPE html><html>...</html>",
                     endpoint="league/nope", safe_url="league/nope", http_status=404))
    try:
        CbsApiClient._unwrap("Not Found<!DOCTYPE html>", endpoint="x",
                             safe_url="x", http_status=404)
    except UnreadableResponseError as e:
        check("...and the error names the CBS-404 signature so the reader is not "
              "left guessing why JSON parsing failed",
              "does not exist" in str(e))

    # A rejected request arrives as HTTP 400 with the reason nested in the body.
    check_raises("body.exceptions is surfaced as a rejection, not an odd shape",
                 ProviderError,
                 lambda: CbsApiClient._unwrap(
                     json.dumps({"statusCode": 400,
                                 "body": {"exceptions": [{"message": "Missing league_id"}]}}),
                     endpoint="x", safe_url="x", http_status=400))
    check_raises("an envelope whose OWN statusCode disagrees with the HTTP "
                 "status is refused",
                 ProviderError,
                 lambda: CbsApiClient._unwrap(
                     json.dumps({"statusCode": 500, "statusMessage": "boom", "body": {"a": 1}}),
                     endpoint="x", safe_url="x", http_status=200))
    check_raises("a missing body is 'we do not know', not 'the collection was empty'",
                 UnreadableResponseError,
                 lambda: CbsApiClient._unwrap(json.dumps({"statusCode": 200}),
                                              endpoint="x", safe_url="x", http_status=200))


def test_api_parsers() -> None:
    section("H. API PARSERS — settings, the two-list scoring system, roster slots")

    details = api_fixture("cbs_api_league_details.json")
    rules = api_fixture("cbs_api_league_rules.json")
    scoring = api_fixture("cbs_api_scoring_rules.json")
    teams_body = api_fixture("cbs_api_teams.json")

    sc = parse_api.parse_scoring_rules(scoring, season=2026, league_id="grffl")
    rows = sc["fantasy_scoring_rules"]
    bonuses = sc["fantasy_scoring_bonuses"]
    by_id = {r["stat_id"]: r for r in rows}

    # ── the whole reason this league needs its own board ─────────────────────
    # A receiving touchdown is worth 6 to a receiver and 12 to a running back.
    # A parser that read `categories` alone would score both at 6; one that read
    # `positions` alone would have no value at all for a stat with no override.
    check("league-DEFAULT rules keep the bare stat id", by_id["ReTD"]["modifier"] == 6.0)
    check("position OVERRIDES are namespaced and do not collide with the default",
          by_id["RB:ReTD"]["modifier"] == 12.0 and by_id["WR:ReTD"]["modifier"] == 6.0)
    check("an out-of-position touchdown really does pay double — the fact the "
          "whole league-specific ranking rests on",
          by_id["RB:RuTD"]["modifier"] == 6.0 and by_id["WR:RuTD"]["modifier"] == 12.0)
    check("the override carries applies_to_positions so a consumer can resolve "
          "'<pos>:<stat>' then fall back to '<stat>', which is CBS's own order",
          json.loads(by_id["RB:ReTD"]["applies_to_positions"]) == ["RB"]
          and by_id["ReTD"]["applies_to_positions"] is None)
    check("the TE premium survives (1.5/reception vs 1.0)",
          by_id["TE:Recpt"]["modifier"] == 1.5 and by_id["RB:Recpt"]["modifier"] == 1.0)

    # ⚠️ CBS states a per-yard rate in `ranges`, leaving `points` null. Reading
    # `points` alone yields a league where passing yards are worth nothing.
    check("a yardage rate is read out of `ranges`, not from the null `points`",
          by_id["RuYd"]["modifier"] == 0.1 and by_id["ReYd"]["modifier"] == 0.1)

    # ⚠️ THE `per` DIVISOR. Passing yards and receiving yards arrive as ranges
    # that differ in exactly ONE field: per=2.5 vs per=1. Dropping it scores
    # every passing yard at 2.5x — a 4,500-yard QB gains 270 phantom points.
    # This shipped wrong and was caught only because an empirical fit of CBS's
    # OWN displayed points said 0.05/yd where the parser claimed 0.1, and the
    # HTML rules page said it in words: ".1 points for every 2.5 PaYds".
    check("PASSING yards divide by `per` (2.5) and RECEIVING yards do not (1) — "
          "the one field that separates two otherwise identical ranges",
          by_id["PaYd"]["modifier"] == 0.04 and by_id["ReYd"]["modifier"] == 0.1)
    check("...and 0.04 base reconciles with the 0.050 empirical fit once the "
          "300/400/500/600-yard milestones are added back",
          0.04 < 0.050 < 0.04 * 1.5)
    check_raises("a present-but-unreadable `per` raises rather than defaulting "
                 "to 1, which would silently change the rate",
                 parse_api.CbsPayloadError,
                 lambda: parse_api._rate_and_tiers(
                     {"ranges": [{"from": "0", "to": "+", "points": ".1", "per": "x"}]},
                     stat_id="PaYd"))
    check_raises("a `per` of zero raises instead of dividing by zero",
                 parse_api.CbsPayloadError,
                 lambda: parse_api._rate_and_tiers(
                     {"ranges": [{"from": "0", "to": "+", "points": ".1", "per": "0"}]},
                     stat_id="PaYd"))

    # ⚠️ `ranges` CARRIES TWO INCOMPATIBLE MEANINGS. DSTPA is a piecewise
    # LOOKUP TABLE — seven closed tiers mapping points-allowed to a flat score —
    # not a rate. The original parser took ranges[0], reducing the whole table
    # to its shutout tier and scoring every defense as if it had pitched one.
    dst = [b for b in bonuses if b["stat_id"] == "DSTPA"]
    check("a 7-tier lookup table is NOT collapsed to its first tier",
          len(dst) == 7, f"{len(dst)} tiers")
    check("the tiers cover the real range including the NEGATIVE ones — a "
          "defense that concedes 50 loses 6 points",
          sorted(t["bonus_points"] for t in dst) == [-6.0, -4.0, -2.0, 2.0, 4.0, 6.0, 12.0])
    check("every tier is mutually exclusive (is_stacking 0) and bounded",
          all(t["is_stacking"] == 0 and t["target_max"] is not None for t in dst))
    check("a tiered stat has modifier NULL but is NOT display-only — the tiers "
          "ARE its score, so 'no rate' must not read as 'never scored'",
          by_id["DSTPA"]["modifier"] is None
          and by_id["DSTPA"]["is_display_only"] == 0)
    check_raises("ranges that are BOTH multiple and carry a `per` are refused "
                 "as a shape never observed, rather than guessed at",
                 parse_api.CbsPayloadError,
                 lambda: parse_api._rate_and_tiers(
                     {"ranges": [{"from": "0", "to": "9", "points": "1", "per": "2"},
                                 {"from": "10", "to": "20", "points": "2"}]},
                     stat_id="X"))

    # ── bonus bands: the 0134 columns ────────────────────────────────────────
    bb = {b["bonus_id"]: b for b in bonuses}
    check("77 bands total: 70 threshold bonuses + the 7 DSTPA tiers",
          len(bonuses) == 77, f"{len(bonuses)}")
    check("an OPEN-ENDED milestone records target_max NULL and is_stacking 1",
          bb["RuYd:100"]["target_max"] is None and bb["RuYd:100"]["is_stacking"] == 1)
    check("a CLOSED band records its upper edge and is_stacking 0 — without "
          "which a 45-yard TD collects the 10-39 bonus AND the 40-69 bonus",
          bb["RB:RuTD:10"]["target_max"] == 39.0 and bb["RB:RuTD:10"]["is_stacking"] == 0)
    check("the SAME stat carries a different band scale by position",
          bb["RB:ReTD:40"]["bonus_points"] == 6.0 and bb["WR:ReTD:40"]["bonus_points"] == 3.0)
    check_raises("a bonus band with no threshold raises rather than being "
                 "silently dropped (a dropped bonus understates every score)",
                 parse_api.CbsPayloadError,
                 lambda: parse_api._bonus_rows([{"to": "39", "points": "2"}],
                                               stat_id="X", stat_name="X", positions=None,
                                               league_key_="k", season=2026))

    # ── roster slots ─────────────────────────────────────────────────────────
    slots = parse_api.parse_roster_positions(rules, season=2026, league_id="grffl")
    starters = sum(s["slot_count"] for s in slots if s["is_starting_slot"])
    bench = sum(s["slot_count"] for s in slots if s["is_bench_slot"])
    check("the ACTIVE lineup adds up to nine", starters == 9, f"{starters}")
    # ⚠️ The bench lives in `statuses`, not `positions`. Reading positions alone
    # yields a 9-man roster for an 18-man league.
    check("the bench is found in `statuses` and adds the other nine",
          bench == 9, f"{bench}")
    flex = [s for s in slots if s["is_flex_slot"]]
    check("the flex slot is detected from its label and lists its eligible "
          "positions, rather than being matched against hardcoded flex names",
          len(flex) == 1 and json.loads(flex[0]["flex_positions"]) == ["RB", "WR", "TE"])
    check("a zero-capacity status is stored as a real 0 — this league genuinely "
          "has no IR slot, which is not the same as not knowing",
          any(s["is_injury_slot"] and s["slot_count"] == 0 for s in slots))
    check("'Active Players' and 'Total Players' are totals, not slots, and are "
          "excluded so the roster is not double-counted",
          not any(s["position"].lower().startswith(("active", "total")) for s in slots))

    # ── settings ─────────────────────────────────────────────────────────────
    st = parse_api.parse_league_settings(details, rules, season=2026,
                                         league_id="grffl", scoring_rows=rows)
    check("uses_keepers reads 0 — CBS says so explicitly, so this is a fact, "
          "not a default", st["uses_keepers"] == 0)
    check("playoff start is parsed from the label 'Week 15'",
          st["playoff_start_week"] == 15)
    check("the trade deadline is reformatted from 20261115 to ISO",
          st["trade_end_date"] == "2026-11-15")
    # ⚠️ NULL vs 0 — the distinction this whole schema is built around.
    check("uses_faab is NULL, not 0: CBS's rules carry no FAAB field under any "
          "spelling, and 'did not say' is not 'said no'", st["uses_faab"] is None)
    check("uses_fractional_points is DERIVED from the modifiers actually "
          "present, because CBS states no such flag",
          st["uses_fractional_points"] == 1 and st["uses_negative_points"] == 1)
    check("provider vocabulary is preserved verbatim, not normalised",
          st["waiver_type"] == "waivers" and st["trade_ratify_type"] == "approve"
          and st["draft_type"] == "live" and st["player_pool"] == "both")

    # ── teams / managers / divisions ─────────────────────────────────────────
    t = parse_api.parse_teams(teams_body, season=2026, league_id="grffl",
                              my_team_id="10", expected_num_teams=12)
    check("twelve teams, twelve managers, twelve links",
          len(t["fantasy_teams"]) == 12 and len(t["fantasy_managers"]) == 12
          and len(t["fantasy_team_managers"]) == 12)
    check("team_key uses CBS's STABLE numeric id, unlike the history pages "
          "which expose only a franchise name",
          any(x["team_key"] == "ffl.s2026.l.grffl.t.10" for x in t["fantasy_teams"]))
    check("exactly one team is flagged as the authenticating user's",
          sum(x["is_owned_by_current_login"] for x in t["fantasy_teams"]) == 1)
    check("managers key on the account GUID, never on a display name",
          all(len(m["manager_uid"]) > 8 and m["manager_uid"] != m["display_name"]
              for m in t["fantasy_managers"]))

    # ⚠️ THE COUNT ASSERTION. Two CBS endpoints already default to a one-row
    # slice at HTTP 200 with no marker; this is what stops a third from
    # becoming a league with one team.
    check_raises("a team count that disagrees with league/details is refused",
                 parse_api.CbsPayloadError,
                 lambda: parse_api.parse_teams(teams_body, season=2026,
                                               league_id="grffl", expected_num_teams=14))

    divs = parse_api.parse_divisions(teams_body, season=2026, league_id="grffl")
    check("three divisions are derived from the teams' own labels",
          sorted(d["division_id"] for d in divs) == ["Central", "East", "West"])

    # ── schedule ─────────────────────────────────────────────────────────────
    sched_all = api_fixture("cbs_api_schedules_all.json")
    periods = parse_api.parse_schedule_periods(sched_all, season=2026,
                                               league_id="grffl",
                                               playoff_start_week=15,
                                               expected_periods=17)
    check("seventeen periods parse from the period=all payload", len(periods) == 17)
    check("weeks 15-17 are playoffs and only week 17 is the championship",
          [p["week"] for p in periods if p["is_playoff"]] == [15, 16, 17]
          and [p["week"] for p in periods if p["is_championship"]] == [17])
    check("a start date converts from m/d/yy to ISO",
          periods[0]["week_start"] == "2026-09-09")
    check("an unparseable date yields NULL rather than a guessed century",
          parse_api._mdy("9/9") is None and parse_api._mdy("") is None)

    # ⚠️ SILENT NARROWING, ENDPOINT #2. This fixture was captured WITHOUT
    # period=all: HTTP 200, one period, no marker that it filtered.
    check_raises("the one-period payload is REFUSED, not stored as a one-week "
                 "season", parse_api.CbsPayloadError,
                 lambda: parse_api.parse_schedule_periods(
                     api_fixture("cbs_api_schedules_narrowed.json"),
                     season=2026, league_id="grffl", expected_periods=17))

    # ── draft order ──────────────────────────────────────────────────────────
    o = parse_api.parse_draft_order(api_fixture("cbs_api_draft_order.json"),
                                    season=2026, league_id="grffl")
    check("216 slots = 12 teams x 18 rounds", o["num_picks"] == 216)
    check("every team gets a draft_position taken from its ROUND-1 pick",
          len(o["fantasy_team_season_state"]) == 12
          and sorted(s["draft_position"] for s in o["fantasy_team_season_state"])
          == list(range(1, 13)))
    check("faab_balance stays NULL — not exposed is not zero",
          all(s["faab_balance"] is None for s in o["fantasy_team_season_state"]))

    # ── the pre-draft placeholder board ──────────────────────────────────────
    # ⚠️ THE OBVIOUS TEST IS WRONG AND THIS IS THE PROOF. Every placeholder pick
    # HAS a populated `player` object, so `if pick.get("player")` passes for all
    # of them and a parser would store a complete draft of nobody.
    upcoming = api_fixture("cbs_api_draft_results_upcoming.json")
    picks = upcoming["draft_results"]["picks"]
    check("every placeholder pick has a truthy `player`, so truthiness cannot "
          "be the test", all(p.get("player") for p in picks))
    check("draft_has_started sees through it via the UpcomingPick sentinel",
          parse_api.draft_has_started(upcoming) is False)
    real = json.loads(json.dumps(upcoming))
    real["draft_results"]["picks"][0]["player"] = {"id": "2185957", "name": "A Player"}
    check("...and returns True the moment one pick names a real player",
          parse_api.draft_has_started(real) is True)


def test_api_schema_audit() -> None:
    section("I. API SCHEMA AUDIT — every emitted key is a REAL column, and "
            "every primary-key column is populated")
    real = real_columns()
    check("the audit parsed table definitions (an empty result would make "
          "every check below vacuously pass)", len(real) >= 36, f"{len(real)} tables")
    check("the audit understands ALTER TABLE, not just CREATE TABLE — 0134 "
          "adds three columns that way",
          {"target_max", "is_stacking", "applies_to_positions"}
          <= real["fantasy_scoring_bonuses"])

    details = api_fixture("cbs_api_league_details.json")
    rules = api_fixture("cbs_api_league_rules.json")
    scoring = api_fixture("cbs_api_scoring_rules.json")
    teams_body = api_fixture("cbs_api_teams.json")

    sc = parse_api.parse_scoring_rules(scoring, season=2026, league_id="grffl")
    produced: dict[str, list[dict]] = {
        "fantasy_league_seasons": [parse_api.parse_league_metadata(
            details, season=2026, league_id="grffl", my_team_id="10")],
        "fantasy_league_settings": [parse_api.parse_league_settings(
            details, rules, season=2026, league_id="grffl",
            scoring_rows=sc["fantasy_scoring_rules"])],
        "fantasy_scoring_rules": sc["fantasy_scoring_rules"],
        "fantasy_scoring_bonuses": sc["fantasy_scoring_bonuses"],
        "fantasy_roster_positions": parse_api.parse_roster_positions(
            rules, season=2026, league_id="grffl"),
        "fantasy_divisions": parse_api.parse_divisions(
            teams_body, season=2026, league_id="grffl"),
        "fantasy_schedule_periods": parse_api.parse_schedule_periods(
            api_fixture("cbs_api_schedules_all.json"), season=2026,
            league_id="grffl", playoff_start_week=15, expected_periods=17),
        "fantasy_team_season_state": parse_api.parse_draft_order(
            api_fixture("cbs_api_draft_order.json"), season=2026,
            league_id="grffl")["fantasy_team_season_state"],
    }
    produced.update(parse_api.parse_teams(teams_body, season=2026, league_id="grffl",
                                          my_team_id="10", expected_num_teams=12))

    phantom, unpopulated = {}, {}
    for table, rows in produced.items():
        cols = real.get(table)
        if cols is None:
            phantom[table] = ["<TABLE NOT IN THE MIGRATIONS>"]; continue
        extra = sorted({k for r in rows for k in r} - cols)
        if extra:
            phantom[table] = extra
        pk = d1mod.PRIMARY_KEYS[table]
        empty = sorted({c for r in rows for c in pk if r.get(c) in (None, "")})
        if empty:
            unpopulated[table] = empty
    check(f"no emitted key is a phantom column ({sum(len(v) for v in produced.values())} "
          f"rows across {len(produced)} tables)", phantom == {}, str(phantom))
    check("every primary-key column is populated on every row — an empty PK "
          "component upserts into the wrong row forever",
          unpopulated == {}, str(unpopulated))

    # ⚠️ MUTATION CHECK. An audit that cannot fail proves nothing. This injects
    # a column that does not exist and asserts the audit notices.
    poisoned = dict(produced["fantasy_teams"][0], not_a_real_column=1)
    check("the audit BITES — a deliberately invented column is caught",
          "not_a_real_column" in (set(poisoned) - real["fantasy_teams"]))


def test_adapter_guards() -> None:
    section("J. ADAPTER GUARDS — the season lie, and the narrowed collections")

    class FakeApi:
        """Serves the captured fixtures with no network and no credential."""
        api_calls = 0

        def __init__(self, overrides=None):
            self.map = {
                "league/details": "cbs_api_league_details.json",
                "league/rules": "cbs_api_league_rules.json",
                "league/scoring/rules": "cbs_api_scoring_rules.json",
                "league/teams": "cbs_api_teams.json",
                "league/draft/order": "cbs_api_draft_order.json",
                "league/draft/results": "cbs_api_draft_results_upcoming.json",
                "league/schedules": "cbs_api_schedules_all.json",
                "league/rosters": "cbs_api_rosters_narrowed.json",
            }
            self.overrides = overrides or {}

        def fetch(self, endpoint, *, params=None, attempts=3):
            self.api_calls += 1
            if endpoint in self.overrides:
                return self.overrides[endpoint]
            if endpoint == "league/draft/config":
                return {"draft": {"rounds": 18, "order_type": "snake",
                                  "timestamp": 1788910200, "time_limit": "60"}}
            if endpoint == "league/scoring/live":
                # ⚠️ Must be a REAL payload, not a my_team_id stub: sync_season
                # now walks the played weeks, so a stub here would make the
                # adapter test pass against a shape that cannot occur.
                body = api_fixture("cbs_api_scoring_live_unplayed.json")
                return {"live_scoring": {**body["live_scoring"], "my_team_id": "10"}}
            return api_fixture(self.map[endpoint])

    p = CbsProvider(FakeApi())
    check("the current season is read from CBS's own schedule dates, never "
          "from the system clock", p.current_season() == 2026)

    ref = LeagueRef(platform="cbs", league_key="ffl.s2019.l.grffl", season=2019,
                    game_key="ffl", league_id="grffl")
    # ⚠️ THE WORST CBS FAILURE MODE. The API answers a 2019 request with 2026
    # data at HTTP 200. Ungated, a 2013-2026 backfill writes the SAME current
    # rows under fourteen season stamps, all looking successful.
    check_raises("a historical season is REFUSED by every API-backed method, "
                 "rather than served today's data under an old stamp",
                 SeasonNotServedByApi, lambda: p.fetch_teams(ref))
    check_raises("...settings too", SeasonNotServedByApi,
                 lambda: p.fetch_league_settings(ref))
    check_raises("...and the schedule", SeasonNotServedByApi,
                 lambda: p.fetch_schedule(ref))

    cur = CbsProvider(FakeApi()).probe_league()
    check("probe_league identifies the league and the caller's own team",
          cur.league_key == "ffl.s2026.l.grffl" and cur.my_team_key.endswith(".t.10"))

    p2 = CbsProvider(FakeApi())
    tables = {}
    for fr in p2.sync_season(cur):
        for row in fr.rows:
            tables.setdefault(row["_table"], 0)
            tables[row["_table"]] += 1
    check("a full sync_season emits every league-state table, weekly scores "
          "included", len(tables) == 13, ", ".join(f"{k}={v}" for k, v in sorted(tables.items())))

    # ⚠️ SILENT NARROWING, ENDPOINT #1. The rosters fixture was captured
    # WITHOUT team_id=all: one team, HTTP 200, no marker.
    check_raises("a one-team roster response is refused, not ingested as 1/12 "
                 "of a league", ProviderError,
                 lambda: CbsProvider(FakeApi()).fetch_rosters(cur, 1))

    # A pre-draft board is EMPTY-but-COMPLETE: CBS genuinely says there are no
    # picks yet. That is different from a resource we failed to read.
    dr = CbsProvider(FakeApi()).fetch_draft_results(cur)
    check("the pre-draft board yields zero picks, complete=True, and a note "
          "saying why — not 216 picks of nobody",
          dr.rows == [] and dr.complete and "not happened" in dr.notes)

    # 'Not built' must never be recorded as 'not offered by the platform'.
    check_raises("an unbuilt resource raises instead of returning an empty "
                 "complete=False result that would read as 'CBS has none'",
                 NotImplementedInThisPass,
                 lambda: CbsProvider(FakeApi()).fetch_transactions(cur))
    check("resource_supported still reports CBS-offered-but-unbuilt resources "
          "as supported, so they stay on the build list",
          CbsProvider(FakeApi()).resource_supported("transactions") is True)


# ═════════════════════════════════════════════════════════════════════════════
# SCORING ENGINE — applying the rulebook. The bugs guarded here are the ones
# that produce a PLAUSIBLE wrong number, which is the only kind that ships.
# ═════════════════════════════════════════════════════════════════════════════

def _grffl_table():
    sc = parse_api.parse_scoring_rules(api_fixture("cbs_api_scoring_rules.json"),
                                       season=2026, league_id="grffl")
    return ScoringTable.from_rows(sc["fantasy_scoring_rules"],
                                  sc["fantasy_scoring_bonuses"],
                                  platform="cbs", league_key="ffl.s2026.l.grffl",
                                  season=2026)


def test_scoring_engine() -> None:
    section("K. SCORING ENGINE — position overrides, the three bonus shapes, "
            "and the season-total trap")
    T = _grffl_table()

    # ── resolution order: position override, then league default ─────────────
    check("a position override wins over the league default",
          T.resolve("RB", "ReTD")[0] == 12.0 and T.resolve("WR", "ReTD")[0] == 6.0)
    check("a stat with no override falls back to the league default for every "
          "position", T.resolve("RB", "RuYd")[0] == T.resolve("WR", "RuYd")[0] == 0.1)
    # ⚠️ An unknown stat must never score 0.0. "This league does not score X"
    # and "I have never heard of X" are different claims and only one is safe.
    check_raises("an unknown stat RAISES rather than quietly scoring zero",
                 ScoringError, lambda: T.score_stat("RB", "NotAStat", 5))

    # ── shape 1: stacking milestones, per GAME ───────────────────────────────
    check("a 100-yard game earns one milestone (10.0 + 3)",
          T.score_stat("RB", "RuYd", 100) == 13.0)
    check("a 250-yard game earns the 100 AND 200 milestones, not the 300",
          T.score_stat("RB", "RuYd", 250) == 25.0 + 6.0)
    check("99 yards earns none of them", T.score_stat("RB", "RuYd", 99) == 9.9)

    # ── shape 2: exclusive bands, per EVENT ──────────────────────────────────
    # ⚠️ A COUNT OF TOUCHDOWNS CANNOT PRICE A DISTANCE BAND. Without the
    # individual lengths the base rate applies and the bands are skipped — a
    # documented understatement, never a guess.
    check("two touchdowns with no lengths supplied score base only",
          T.score_stat("RB", "ReTD", 2) == 24.0)
    check("supplying the lengths fires AT MOST ONE band per touchdown: a "
          "45-yard TD takes the 40-69 band (+6) and NOT the 10-39 band too",
          T.score_stat("RB", "ReTD", 1, event_lengths=[45]) == 12.0 + 6.0)
    check("a 5-yard touchdown is below every band and earns no bonus",
          T.score_stat("RB", "ReTD", 1, event_lengths=[5]) == 12.0)
    check("the same touchdown length is worth different amounts by position — "
          "the whole reason a generic board misprices this league",
          T.score_stat("RB", "ReTD", 1, event_lengths=[45]) == 18.0
          and T.score_stat("WR", "ReTD", 1, event_lengths=[45]) == 9.0)

    # ── shape 3: tier lookup ─────────────────────────────────────────────────
    check("a shutout hits the top defensive tier", T.score_stat(None, "DSTPA", 0) == 12.0)
    check("exactly ONE tier fires — 10 points allowed is 6, not 6+12",
          T.score_stat(None, "DSTPA", 10) == 6.0)
    check("the negative tiers are real: conceding 52 costs 6 points",
          T.score_stat(None, "DSTPA", 52) == -6.0)
    check_raises("a value outside every tier RAISES — 0.0 would be a guess, and "
                 "for a defense 0.0 sits between a good and a bad outcome",
                 ScoringError, lambda: T.score_stat(None, "DSTPA", 120))

    # ── the trap that actually shipped ───────────────────────────────────────
    # ⚠️ THIS IS THE BUG THAT REACHED A VALIDATION RUN. Feeding a SEASON total
    # to score_game awards each stacking milestone once for the year. Scored
    # that way against CBS's own 2025 page, 63 of 100 running backs came out
    # ABOVE what CBS says they scored — impossible, since every bonus adds.
    season_total = {"RuYd": 1202, "RuTD": 10, "Recpt": 102, "ReYd": 924, "ReTD": 7, "FL": 0}
    wrong = T.score_game("RB", season_total)
    games = ([{"RuYd": 75.125, "RuTD": 0.625, "Recpt": 6.375, "ReYd": 57.75,
               "ReTD": 0.4375, "FL": 0}] * 16)
    right = T.score_weeks("RB", games)
    check("a season total run through score_game OVERSTATES, because the "
          "milestones fire once for the year instead of once per big game",
          wrong > right, f"season-as-one-game {wrong} vs per-game {right}")
    # The per-game line never clears 100 rushing or receiving yards, so the
    # correct answer contains NO milestone at all — it is exactly the sum of
    # the base rates. Stated as an equality so this cannot pass vacuously.
    base_only = (1202 * 0.1 + 10 * 6.0 + 102 * 1.0 + 924 * 0.1 + 7 * 12.0)
    check("...and the per-game path earns NO yardage milestones here, because "
          "no single game cleared 100 yards — it is exactly the base rates",
          abs(right - base_only) < 0.05, f"{right} vs base-only {base_only:.1f}")
    check("the overstatement is exactly the six milestones wrongly fired "
          "(3 rushing + 3 receiving, +3 each = +18)",
          abs((wrong - right) - 18.0) < 0.05, f"+{wrong - right:.1f}")
    check_raises("score_weeks refuses an empty season rather than returning "
                 "0.0, which is indistinguishable from a real zero",
                 ScoringError, lambda: T.score_weeks("RB", []))

    # ── construction guards ──────────────────────────────────────────────────
    check_raises("an empty rulebook raises — scoring against it would return "
                 "0.0 for every player in the league",
                 ScoringError,
                 lambda: ScoringTable.from_rows([], [], platform="cbs",
                                                league_key="k", season=2026))
    check_raises("a bonus referencing a stat with no rule row raises",
                 ScoringError,
                 lambda: ScoringTable.from_rows(
                     [{"stat_id": "RuYd", "modifier": 0.1, "is_enabled": 1}],
                     [{"bonus_id": "b", "stat_id": "Ghost", "target_value": 1,
                       "target_max": None, "bonus_points": 1, "is_stacking": 1}],
                     platform="cbs", league_key="k", season=2026))
    check_raises("OVERLAPPING tiers raise — otherwise the score depends on "
                 "iteration order and changes between runs",
                 ScoringError,
                 lambda: ScoringTable.from_rows(
                     [{"stat_id": "X", "modifier": None, "is_enabled": 1}],
                     [{"bonus_id": "a", "stat_id": "X", "target_value": 0,
                       "target_max": 10, "bonus_points": 5, "is_stacking": 0},
                      {"bonus_id": "b", "stat_id": "X", "target_value": 5,
                       "target_max": 20, "bonus_points": 3, "is_stacking": 0}],
                     platform="cbs", league_key="k", season=2026))

    # ── scenario overrides ───────────────────────────────────────────────────
    # A proposed rules change has to be SCORED, not argued about. The override
    # must move exactly the scopes named and nothing else.
    bumped = T.with_override("PaTD", 6.0, positions=[None, "QB"])
    check("an override moves the league default and the named position",
          bumped.resolve("QB", "PaTD")[0] == 6.0
          and bumped.resolve(None, "PaTD")[0] == 6.0)
    # ⚠️ THE OUT-OF-POSITION VALUE MUST SURVIVE. 'Raise the base passing TD'
    # means the base — a running back's passing touchdown is 8 because it is
    # out of position, and sweeping it along would erase the premium the whole
    # league is built on.
    check("...and LEAVES the out-of-position override alone",
          bumped.resolve("RB", "PaTD")[0] == 8.0 == T.resolve("RB", "PaTD")[0])
    check("the bands survive the override (a 45-yard passing TD still bands)",
          bumped.score_stat("QB", "PaTD", 1, event_lengths=[45]) == 6.0 + 3.0)
    check("the ORIGINAL table is untouched — a scenario must never leak into "
          "the baseline it is compared against",
          T.resolve("QB", "PaTD")[0] == 4.0)
    check("the rushing premium it quietly shrinks is visible: a QB rushing TD "
          "falls from 3.0x his passing TD to 2.0x",
          abs(T.resolve("QB", "RuTD")[0] / T.resolve("QB", "PaTD")[0] - 3.0) < 1e-9
          and abs(bumped.resolve("QB", "RuTD")[0] / 6.0 - 2.0) < 1e-9)
    check_raises("an override that would change NOTHING raises, rather than "
                 "returning a scenario identical to the baseline",
                 ScoringError,
                 lambda: T.with_override("NotAStat", 1.0, positions=[None]))

    # ⚠️ Derived coefficients live in the same table under a reserved prefix.
    # They are EVIDENCE about past seasons, not rules, and applying them as
    # rules would double-count every bonus they already have baked in.
    t2 = ScoringTable.from_rows(
        [{"stat_id": "RuYd", "modifier": 0.1, "is_enabled": 1},
         {"stat_id": "fit:RB:Rushing.Yds", "modifier": 0.14, "is_enabled": 1}],
        [], platform="cbs", league_key="k", season=2026)
    check("'fit:' rows are EXCLUDED from the live rulebook — they are fitted "
          "evidence with bonuses already inside them, not rules",
          t2.resolve("RB", "RuYd")[0] == 0.1 and len(t2.rates) == 1)


def test_scoreboard() -> None:
    section("L. SCOREBOARD — every team appears twice, and zero is not 'unplayed'")
    unplayed = api_fixture("cbs_api_scoring_live_unplayed.json")
    played = api_fixture("cbs_api_scoring_live_played.json")

    t = parse_api.parse_scoreboard(played, season=2026, league_id="grffl",
                                   week=1, expected_teams=12)
    ms, sc = t["fantasy_matchups"], t["fantasy_team_week_scores"]
    # ⚠️ CBS lists every team AND lists it again as somebody's opponent. Taking
    # one matchup per team would double every game in the league.
    check("12 teams collapse to 6 matchups, not 12", len(ms) == 6 and len(sc) == 12)
    check("each team appears in exactly one matchup",
          sorted([m["team_a_key"] for m in ms] + [m["team_b_key"] for m in ms])
          == sorted(r["team_key"] for r in sc))
    check_raises("a team count that cannot pair up is refused — a bye or a "
                 "duplicated pair would make the week's records wrong",
                 parse_api.CbsPayloadError,
                 lambda: parse_api.parse_scoreboard(
                     {"live_scoring": {"teams": played["live_scoring"]["teams"][:3]}},
                     season=2026, league_id="grffl", week=1))

    won = [m for m in ms if m["winner_team_key"]]
    tied = [m for m in ms if m["is_tied"]]
    check("a winner is named only where the scores actually differ",
          len(won) == 5 and len(tied) == 1)
    check("...and the winner is the higher score, not the first listed",
          all((m["team_a_points"] > m["team_b_points"])
              == (m["winner_team_key"] == m["team_a_key"]) for m in won))
    check("a TIE names no winner rather than defaulting to one",
          tied[0]["winner_team_key"] is None
          and tied[0]["team_a_points"] == tied[0]["team_b_points"])

    # ⚠️ THE DISTINCTION THAT MATTERS PRE-SEASON. An unplayed week and a week
    # nobody scored are byte-identical in this payload apart from
    # matchup_status, so the status is carried and never inferred from zeros.
    u = parse_api.parse_scoreboard(unplayed, season=2026, league_id="grffl", week=1)
    check("an unplayed week still emits its 12 rows — that is what CBS says",
          len(u["fantasy_team_week_scores"]) == 12)
    check("...with every score a real 0.0, never NULL",
          all(r["points_provider"] == 0.0 for r in u["fantasy_team_week_scores"]))
    check("...and the provider's own status is preserved so a caller can tell "
          "'not played' from 'shut out'",
          u["fantasy_matchups"][0]["status"] == "scheduled"
          and ms[0]["status"] == "final")

    # ⚠️ NULL, not a computed guess: the optimal lineup depends on slot
    # eligibility this payload does not carry.
    check("points_optimal and lineup_efficiency stay NULL rather than being "
          "invented from data that is not in the payload",
          all(r["points_optimal"] is None and r["lineup_efficiency"] is None
              for r in sc))

    real = real_columns()
    for tbl, rows in t.items():
        extra = sorted({k for r in rows for k in r} - real[tbl])
        pk = d1mod.PRIMARY_KEYS[tbl]
        empty = sorted({c for r in rows for c in pk if r.get(c) in (None, "")})
        check(f"{tbl}: no phantom columns", extra == [], str(extra))
        check(f"{tbl}: every primary-key column populated", empty == [], str(empty))

def main() -> None:
    print("CBS PIPELINE TEST — draft-results HTML scraper")
    print(f"  fixture: {FIXTURES.name}/cbs_draft_results_2019.html "
          f"(SYNTHETIC content, markup shape transcribed from the live 2019 page)")
    for fn in (test_urls, test_parse, test_no_fail_open, test_schema_audit,
               test_rules, test_stats_solver, test_api_envelope,
               test_api_parsers, test_api_schema_audit, test_adapter_guards,
               test_scoring_engine, test_scoreboard):
        fn()
    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s) did not hold:")
        for f in FAILURES:
            print("  " + f)
        sys.exit(1)
    print("PASSED — history parses, ids come from anchors, blank never became zero")


if __name__ == "__main__":
    main()
