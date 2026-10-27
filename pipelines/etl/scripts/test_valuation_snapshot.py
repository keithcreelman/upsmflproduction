#!/usr/bin/env python3
"""The trade grader grades only on a valid valuation snapshot (Keith 2026-10-20, #1343 decision 3).

data/valuation/trade_valuation_snapshot.json is the grader's one valuation
input. Each invalid condition below is shown to stop all three things a grade
feeds:
  the grade       analyze_trade returns NO GRADE: no letter, no score, and the
                  failed input named;
  the roast call  build_trade_roast_context raises NoGradeError before any
                  context (so no model call);
  the post        roast_bot_fire_ab.fire_one returns before any embed, model
                  call or Discord request; trade_roast_bot returns before its
                  announcement (checked on the source: discord.py is not
                  installed in CI).
The old silent substitutes (built-in pick curve, $60/point, salary as auction
price, ADP 999, the projection DB, career-file x.06) are banned from the grade
path, and a snapshot's own values are shown to be the ones used.

Two layers, so a weekly rebuild of the production snapshot never breaks the
suite (Keith 2026-10-21):
  PINNED    tests/fixtures/valuation_snapshot_2026-10-20/ is a frozen copy of
            the 2026-10-20 / week 6 snapshot and every input it was built from,
            in the repo's layout. Every fixed expectation (its date, week and
            values, the Gride <-> Blake grades, each NO GRADE mutation, the
            replay) runs on it. Its golden rebuild fails only if the
            generator's output for the same inputs changes; refresh the
            fixture deliberately then.
  CONTRACT  the committed production snapshot, whatever week it holds:
            schema, metadata, freshness fields, input checksums, internal
            consistency and a byte-for-byte rebuild, all checked at the
            snapshot's own as-of time. Today's clock is never used: in
            production a stale snapshot is NO GRADE, not a red build.
A simulated later week passes the contract and the whole module; a broken or
stale snapshot still fails.

Offline: no D1, no MFL, no network. The clock is pinned.
  python3 pipelines/etl/scripts/test_valuation_snapshot.py
"""
import ast
import hashlib
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import types
import unittest
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import build_valuation_snapshot as bvs  # noqa: E402
import pick_valuation as pv  # noqa: E402
import trade_grader as tg  # noqa: E402
import valuation_snapshot as vs  # noqa: E402
from replay_2026_trade_grades import REPLAY, grader_inputs  # noqa: E402

SNAPSHOT_REL = Path("data") / "valuation" / "trade_valuation_snapshot.json"
COEFFICIENTS_REL = Path("pipelines") / "etl" / "config" / "future_pick_inseason_coefficients.json"
INPUTS_REL = Path("pipelines") / "etl" / "inputs" / "valuation"

# PINNED: the frozen 2026-10-20 / week 6 snapshot and its inputs.
PINNED_ROOT = REPO / "tests" / "fixtures" / "valuation_snapshot_2026-10-20"
PINNED_SNAPSHOT = PINNED_ROOT / SNAPSHOT_REL
AS_OF, GENERATED_AT = "2026-10-20", "2026-10-20T20:00:00Z"
NOW = datetime(2026, 10, 21, 12, tzinfo=timezone.utc).timestamp()   # 1.5 days after the data
DAY = 86400
SNAP_BYTES = PINNED_SNAPSHOT.read_bytes()
TRADES = {t["key"]: t for t in json.loads(REPLAY.read_text())["trades"]}
GRIDE_BLAKE = "1791320240"   # 10-06: Gride's 2027 R1 + R3 for Hampton, Golden and Blake's 2027 R4
STANDINGS = json.loads((PINNED_ROOT / "data" / "mfl-snapshots" / AS_OF / "leagueStandings.json").read_text())
GRADE_LETTERS = {"A+", "A", "A-", "B+", "B", "B-", "C+", "C", "C-", "D+", "D", "F"}

# CONTRACT: the committed production snapshot. The environment variable points
# a whole-module run at another repo-shaped tree (the replacement tests use it).
CONTRACT_ROOT_ENV = "UPS_TEST_VALUATION_CONTRACT_ROOT"
CONTRACT_ROOT = Path(os.environ.get(CONTRACT_ROOT_ENV) or REPO).resolve()


def snapshot() -> dict:
    return json.loads(SNAP_BYTES)


def reseal(snap: dict) -> dict:
    """Re-sign a mutated snapshot so only the targeted check can fail."""
    snap["content_sha256"] = hashlib.sha256(vs.canonical_body(snap)).hexdigest()
    return snap


def live_state(weeks: int = 6) -> "pv.SeasonState":
    rows = STANDINGS["leagueStandings"]["franchise"]
    return pv.SeasonState(2026, "in_season", weeks, {r["id"]: float(r["all_play_pct"]) for r in rows},
                          {r["id"]: float(r["pf"]) for r in rows}, "2026-10-20T09:05:00Z")


def build_at(root: Path, as_of: str, generated_at: str, generator: dict | None = None) -> dict:
    """build_valuation_snapshot.build on a repo-shaped tree: inputs, coefficients
    and MFL folder all under `root`. The generator's identity is the committed
    generator's (or `generator`), since `root` need not be a git checkout."""
    root = Path(root).resolve()
    if root == REPO.resolve() and generator is None:
        return bvs.build(as_of, generated_at)
    ident = generator or bvs.generator_identity(False)
    saved = (bvs.REPO, bvs.INPUT_DIR, bvs.COEFFICIENTS, bvs.generator_identity)
    bvs.REPO, bvs.INPUT_DIR, bvs.COEFFICIENTS = root, root / INPUTS_REL, root / COEFFICIENTS_REL
    bvs.generator_identity = lambda allow_dirty=False: ident
    try:
        return bvs.build(as_of, generated_at)
    finally:
        bvs.REPO, bvs.INPUT_DIR, bvs.COEFFICIENTS, bvs.generator_identity = saved


def grade(snap=None, state=None, now=NOW, gave=None, path=None, repo=None):
    """analyze_trade on the 10-06 Gride <-> Blake trade. gave: replace what each side gave.
    snap=None reads the snapshot file the way the bot does: `path`, else the tree's own.
    repo: the tree the snapshot's inputs and coefficients come from (default: PINNED)."""
    t = TRADES[GRIDE_BLAKE]
    txn, rosters = grader_inputs(t)
    if gave:
        txn["franchise1_gave_up"], txn["franchise2_gave_up"] = gave
    root = Path(repo) if repo is not None else PINNED_ROOT
    saved = (tg.load_salary_adjustments, vs.SNAPSHOT_PATH, vs.REPO, pv.INSEASON_COEFFICIENTS, pv._COEFFICIENTS)
    tg.load_salary_adjustments = lambda: {}
    vs.SNAPSHOT_PATH = Path(path) if path is not None else root / SNAPSHOT_REL
    vs.REPO = root
    if (root / COEFFICIENTS_REL).exists():
        pv.INSEASON_COEFFICIENTS, pv._COEFFICIENTS = root / COEFFICIENTS_REL, None
    try:
        return tg.analyze_trade(txn, {}, t["names"], rosters, season_state=state or live_state(),
                                snapshot=snap, now=now)
    finally:
        (tg.load_salary_adjustments, vs.SNAPSHOT_PATH, vs.REPO,
         pv.INSEASON_COEFFICIENTS, pv._COEFFICIENTS) = saved


def roast_context(snap=None, state=None, now=NOW, gave=None, path=None, repo=None):
    """build_trade_roast_context with its loaders faked; returns the error or the context."""
    import trade_roast_context as trc
    t = TRADES[GRIDE_BLAKE]
    _txn, rosters = grader_inputs(t)
    built = []
    saved = {n: getattr(trc, n) for n in ("load_franchises", "load_players_map", "load_rosters",
                                          "load_career_stats", "load_discord_users", "analyze_trade",
                                          "build_franchise_context")}
    trc.load_franchises = lambda: t["names"]
    trc.load_players_map = lambda: {}
    trc.load_rosters = lambda: rosters
    trc.load_career_stats = lambda: {}
    trc.load_discord_users = lambda: {}
    trc.analyze_trade = lambda txn, *_a, **_k: grade(snap, state, now, gave, path, repo)
    trc.build_franchise_context = lambda *a, **k: built.append(a) or {}
    try:
        txn, _ = grader_inputs(t)
        try:
            return trc.build_trade_roast_context(txn), built
        except trc.NoGradeError as exc:
            return exc, built
    finally:
        for n, f in saved.items():
            setattr(trc, n, f)


def load_fire_ab():
    """roast_bot_fire_ab with a stand-in anthropic module when the SDK is absent (CI)."""
    if importlib.util.find_spec("anthropic") is None and "anthropic" not in sys.modules:
        sys.modules["anthropic"] = types.SimpleNamespace(Anthropic=object)
    spec = importlib.util.spec_from_file_location("roast_bot_fire_ab_under_test", SCRIPT_DIR / "roast_bot_fire_ab.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


FIRE = load_fire_ab()


def fire(snap=None, state=None, now=NOW, gave=None, path=None, repo=None):
    """fire_one(send=True) with every outward step recorded instead of run."""
    t = TRADES[GRIDE_BLAKE]
    txn, rosters = grader_inputs(t)
    calls = []
    record = lambda name: (lambda *a, **k: calls.append(name) or {"id": "1"})  # noqa: E731
    saved = {n: getattr(FIRE, n) for n in ("find_trade", "load_franchises", "load_players_map", "load_rosters",
                                           "analyze_trade", "build_announcement_embed",
                                           "build_trade_roast_context", "generate_roast", "giphy_search",
                                           "discord_post_message", "discord_create_thread_from_message",
                                           "_discord_request")}
    FIRE.find_trade = lambda ts: txn
    FIRE.load_franchises = lambda: t["names"]
    FIRE.load_players_map = lambda: {}
    FIRE.load_rosters = lambda: rosters
    FIRE.analyze_trade = lambda *_a, **_k: grade(snap, state, now, gave, path, repo)
    for n in ("build_announcement_embed", "build_trade_roast_context", "generate_roast", "giphy_search",
              "discord_post_message", "discord_create_thread_from_message", "_discord_request"):
        setattr(FIRE, n, record(n))
    try:
        return FIRE.fire_one(None, "fake-token", "", "opus", "model-id", int(txn["timestamp"]), True), calls
    finally:
        for n, f in saved.items():
            setattr(FIRE, n, f)


class PinnedDeterminism(unittest.TestCase):
    """The frozen 10-20 fixture: fixed expectations live here, never on the production file."""

    def test_golden_rebuild_from_pinned_inputs(self):
        pinned_generator = snapshot()["generator"]
        self.assertEqual(bvs.render(build_at(PINNED_ROOT, AS_OF, GENERATED_AT, pinned_generator)), SNAP_BYTES)
        self.assertEqual(bvs.render(build_at(PINNED_ROOT, AS_OF, GENERATED_AT, pinned_generator)), SNAP_BYTES)

    def test_pinned_provenance(self):
        snap = snapshot()
        self.assertEqual((snap["schema_version"], snap["model_version"], snap["season"], snap["as_of"]),
                         (vs.SCHEMA_VERSION, vs.MODEL_VERSION, 2026, AS_OF))
        self.assertEqual(snap["generator"]["commit"], "af9b6560872aa244b5df857afaeefb47df2a03ac")
        for inp in snap["inputs"]:
            self.assertEqual(hashlib.sha256((PINNED_ROOT / inp["path"]).read_bytes()).hexdigest(), inp["sha256"])
        self.assertEqual(snap["counts"], {"franchises": 12, "picks": 36, "players": 486})
        self.assertEqual(snap["season_state"]["weeks_completed"], 6)
        self.assertEqual(snap["content_sha256"], "84374cdb58c6224b8ec0ce731b5079a4aeb2335e0c9668e8dd764cd89e57baaf")

    def test_generator_refuses_uncommitted_changes(self):
        saved = bvs.subprocess
        for log, diff_rc in ((b"", 0), (b"af9b6560\n", 1)):     # never committed; edited since
            bvs.subprocess = types.SimpleNamespace(check_output=lambda *a, _o=log, **k: _o,
                                                   call=lambda *a, _rc=diff_rc, **k: _rc)
            try:
                with self.assertRaises(SystemExit):
                    bvs.generator_identity(allow_dirty=False)
                self.assertTrue(bvs.generator_identity(allow_dirty=True)["dirty"])
            finally:
                bvs.subprocess = saved


class ValidGrade(unittest.TestCase):
    def test_pinned_snapshot_validates(self):
        self.assertEqual(vs.validate_snapshot(snapshot(), now=NOW, league_season=2026, live_weeks_completed=6,
                                              repo=PINNED_ROOT), [])

    def test_valid_grade(self):
        an = grade(snapshot())
        self.assertFalse(an.no_grade, an.no_grade_reasons)
        self.assertIn(an.side_a.grade, GRADE_LETTERS)
        self.assertIn(an.side_b.grade, GRADE_LETTERS)
        self.assertAlmostEqual(an.side_a.grade_score, -an.side_b.grade_score)
        self.assertTrue(an.valuation_as_of.startswith(AS_OF))
        self.assertTrue(an.regrade_label.startswith("PRESENT-DAY REGRADE"))     # a 10-06 trade on 10-20 data
        self.assertEqual(tg.no_grade_report(an), "")
        report = tg.format_discord_report(an, {})
        self.assertIn(f"VALUATIONS: repo valuation snapshot as of {AS_OF} (", report)
        self.assertIn("PRESENT-DAY REGRADE: valuations as of 2026-10-20 postdate this trade", report)
        self.assertIn("NOTE: ADP is not in valuation snapshot v1", report)

    def test_read_from_disk_like_the_bot(self):
        an = grade(None)
        self.assertFalse(an.no_grade, an.no_grade_reasons)

    def test_valid_grade_reaches_the_roast_context(self):
        ctx, built = roast_context(snapshot())
        self.assertIsInstance(ctx, dict)
        self.assertEqual(len(built), 2)

    def test_cbp_and_hammertime_project_normally(self):
        pv.use_snapshot(snapshot())
        for fid in ("0002", "0005"):          # canon §D.2 known transitions: Whitman, Martel
            self.assertEqual(snapshot()["career"][fid]["d2_check"], "pass")
            proj = pv.project_future_pick(fid, 2027, 1, live_state())
            self.assertEqual((proj.blocking, proj.issues), ([], []), fid)
            self.assertEqual(proj.basis, "in_season")
            self.assertFalse(pv.describe_pick_odds(proj).startswith(("PROVISIONAL", "UNAVAILABLE")))
        owner = snapshot()["career"]["0002"]["owner"]
        self.assertIn(2017, owner["seasons_by_franchise"]["0002"])
        self.assertNotIn(2022, owner["seasons_by_franchise"]["0002"])
        pv.clear_valuation()

    def test_d2_conflict_in_a_valid_snapshot_is_provisional_not_no_grade(self):
        snap = snapshot()
        snap["career"]["0002"]["owner"]["seasons_by_franchise"]["0002"].remove(2017)
        an = grade(reseal(snap), gave=("FP_0002_2027_1", "17044"))
        self.assertFalse(an.no_grade, an.no_grade_reasons)
        self.assertTrue(an.provisional_reasons)
        self.assertIn("leaves out 2017 (0002)", an.provisional_reasons[0])

    def test_round_4_pick_without_standings_is_graded_with_a_note(self):
        lagged = pv.SeasonState(2026, "unavailable", weeks_completed=6,
                                reason="2026 standings were read 340h after the trade and may include later weeks")
        an = grade(snapshot(), lagged, gave=("FP_0003_2027_4", "17044"))
        self.assertFalse(an.no_grade, an.no_grade_reasons)
        self.assertTrue(any("standings were read" in n for n in an.display_notes))


def _drop(pid):
    def f(s):
        del s["players"][pid]
        s["counts"]["players"] -= 1
    return f


def _set(path, value):
    def f(s):
        node = s
        for k in path[:-1]:
            node = node[k]
        node[path[-1]] = value
    return f


def _input(name, key, value):
    def f(s):
        next(i for i in s["inputs"] if i["name"] == name)[key] = value
    return f


def _career_drop(s):
    del s["career"]["0012"]
    s["counts"]["franchises"] = 11


def _no_owner(s):
    del s["career"]["0003"]["owner"]


# name: (mutation of a resealed snapshot, grade() overrides, text the NO GRADE report must name)
SNAPSHOT_MUTATIONS = {
    "wrong schema": (_set(["schema_version"], 2), {}, "schema version 2, the grader reads 1"),
    "wrong model": (_set(["model_version"], "trade-valuation-0"), {}, "model version 'trade-valuation-0'"),
    "wrong season": (_set(["season"], 2025), {}, "built for season 2025, but the league season is 2026"),
    "stale in season": (None, {"now": NOW + 8 * DAY}, "limit 8 days in season"),
    "stale offseason": (_set(["season_state", "weeks_completed"], 0),
                        {"now": NOW + 14 * DAY, "state": pv.SeasonState(2026, "offseason")},
                        "limit 14 days in the offseason"),
    "missing the latest week": (None, {"state": live_state(7)},
                                "covers 2026 standings through week 6, but week 7 is complete"),
    "input checksum": (_input("player_seasons", "sha256", "0" * 64), {},
                       "input player_seasons (pipelines/etl/inputs/valuation/player_seasons_2023_2025.json): "
                       "changed since the snapshot was built (checksum mismatch)"),
    "input missing": (_input("rosters", "path", "data/mfl-snapshots/2026-10-20/rosters_gone.json"), {},
                      "rosters_gone.json): file is missing"),
    "non-finite PPG": (_set(["players", "17044", "ppg"], float("nan")), {},
                       "player 17044 has a non-finite PPG (nan)"),
    "zero dollars per point": (_set(["dollars_per_point", "value"], 0), {}, "dollars per point: 0 is not a positive number"),
    "rising pick curve": (_set(["pick_curve", "B"], -0.01), {}, "is not a decreasing positive curve"),
    "pick curve below round 4": (_set(["pick_curve", "A"], 100.0), {},
                                 "pick values are not strictly decreasing through 3.12 and above round 4"),
    "player count": (_set(["counts", "players"], 1), {}, "player count does not match"),
    "eleven franchises": (_career_drop, {}, "career: expected 12 franchises, found 11"),
    "traded player missing": (_drop("17044"), {},
                              "player 17044: not in the valuation snapshot (not rostered when it was built)"),
    "traded player without PPG": (lambda s: s["players"]["17044"].update(ppg=None, basis="none",
                                                                         basis_text="no basis"),
                                  {}, "player 17044 (Hampton, Omarion, RB): no projected PPG in the snapshot"),
    "owner history missing": (_no_owner, {}, "no owner history for 0003 in the valuation snapshot"),
    "unknown pick franchise": (None, {"gave": ("FP_0099_2027_1", "17044")},
                               "original franchise 0099 is not in the valuation snapshot"),
    "unreadable pick year": (None, {"gave": ("FP_0003_20X7_1", "17044")}, "pick year '20X7' is unreadable"),
    "round 1 pick without standings": (None, {"state": pv.SeasonState(
        2026, "unavailable", weeks_completed=6,
        reason="2026 standings were read 340h after the trade and may include later weeks")},
        "2027 round 1 pick (0003): 2026 standings were read 340h after the trade"),
    "standings unreadable": (None, {"state": pv.SeasonState(2026, "unavailable",
                                                           reason="MFL leagueStandings unavailable (URLError)")},
                             "current-season standings: MFL leagueStandings unavailable (URLError), so it cannot be "
                             "confirmed that the valuation snapshot covers the most recently completed week"),
}


def _edited_unsealed():
    snap = snapshot()
    snap["players"]["17044"]["ppg"] = 30.0             # edited by hand, checksum left as it was
    return snap


FILE_CASES = {
    "missing file": (None, "valuation snapshot (data/valuation/trade_valuation_snapshot.json): file is missing"),
    "corrupt file": (SNAP_BYTES[: len(SNAP_BYTES) // 2], "file is corrupt"),
    "duplicate player id": (SNAP_BYTES.replace(b'\n  "17044":', b'\n  "17044":{"pos":"RB","ppg":1.0},\n  "17044":', 1),
                            "file is corrupt (duplicate key '17044')"),
}


class NoGradeBlocksEverything(unittest.TestCase):
    def assert_no_grade(self, kwargs, needle):
        an = grade(**kwargs)
        self.assertTrue(an.no_grade, f"expected NO GRADE naming {needle!r}")
        report = tg.no_grade_report(an)
        self.assertTrue(report.startswith(vs.NO_GRADE_HEADER))
        self.assertIn(needle, report)
        self.assertIn("No letter, no score, no roast and no Discord post were produced.", report)
        for side in (an.side_a, an.side_b):
            self.assertEqual((side.grade, side.grade_score), ("", 0.0))
        tokens = set(report.replace(",", " ").replace(":", " ").split())
        self.assertFalse(tokens & GRADE_LETTERS, tokens & GRADE_LETTERS)
        err, built = roast_context(**kwargs)
        self.assertEqual(type(err).__name__, "NoGradeError", needle)
        self.assertIn(needle, str(err))
        self.assertEqual(built, [])
        res, calls = fire(**kwargs)
        self.assertTrue(res["no_grade"])
        self.assertEqual(calls, [], needle)
        self.assertIsNone(pv._DOLLARS_PER_POINT)                # nothing left loaded for a later caller

    def test_each_snapshot_or_trade_condition(self):
        for name, (mutate, overrides, needle) in SNAPSHOT_MUTATIONS.items():
            with self.subTest(name):
                snap = snapshot()
                if mutate:
                    mutate(snap)
                    reseal(snap)
                self.assert_no_grade({"snap": snap, **overrides}, needle)

    def test_hand_edited_snapshot(self):
        self.assert_no_grade({"snap": _edited_unsealed()},
                             "content checksum does not match (the file was edited or damaged)")

    def test_each_file_condition(self):
        for name, (content, needle) in FILE_CASES.items():
            with self.subTest(name):
                tmp = Path(tempfile.mkdtemp()).resolve()
                path = tmp / "data" / "valuation" / "trade_valuation_snapshot.json"
                path.parent.mkdir(parents=True)
                if content is not None:
                    path.write_bytes(content)
                try:                                       # report the path the way the bot does
                    self.assert_no_grade({"snap": None, "path": path, "repo": tmp}, needle)
                finally:
                    shutil.rmtree(tmp)

    def test_every_check_is_exercised(self):
        failures = set()
        for mutate, overrides, needle in SNAPSHOT_MUTATIONS.values():
            failures.add(needle)
        self.assertEqual(len(failures), len(SNAPSHOT_MUTATIONS))


class BotStopsBeforeDiscord(unittest.TestCase):
    """trade_roast_bot needs discord.py and Keychain secrets at import, so its
    order is checked on the source: the NO GRADE return comes first."""

    def _func(self, path, name):
        tree = ast.parse((SCRIPT_DIR / path).read_text())
        return next(n for n in ast.walk(tree)
                    if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name)

    def _first_call(self, fn, names):
        lines = [n.lineno for n in ast.walk(fn) if isinstance(n, ast.Call)
                 and (getattr(n.func, "attr", None) in names or getattr(n.func, "id", None) in names)]
        self.assertTrue(lines, names)
        return min(lines)

    def _guard(self, fn, needle):
        for n in ast.walk(fn):
            if isinstance(n, ast.If) and needle in ast.unparse(n.test):
                self.assertIsInstance(n.body[-1], ast.Return)
                return n.lineno
        self.fail(f"no `if {needle}` guard in {fn.name}")

    def test_single_trade(self):
        fn = self._func("trade_roast_bot.py", "analyze_and_post")
        guard = self._guard(fn, "analysis.no_grade")
        self.assertLess(guard, self._first_call(fn, {"build_announcement_embed", "send", "create_thread",
                                                     "build_trade_roast_context", "generate_trade_roast",
                                                     "_track_roast_to_worker", "_fetch_gif_via_worker"}))
        self.assertLess(self._first_call(fn, {"analyze_trade"}), guard)

    def test_multiway(self):
        fn = self._func("trade_roast_bot.py", "analyze_and_post_multiway")
        guard = self._guard(fn, "summary.get('no_grade_reports')")
        self.assertLess(guard, self._first_call(fn, {"send", "create_thread", "generate_trade_roast"}))
        prep = next(n for n in ast.walk(fn) if isinstance(n, ast.FunctionDef) and n.name == "_prep")
        self.assertLess(self._guard(prep, "no_grade_reports"),
                        self._first_call(prep, {"build_multiway_embed", "build_multiway_context_text"}))
        summary = self._func("trade_roast_bot.py", "build_multiway_summary")
        self.assertLess(self._first_call(summary, {"analyze_trade"}), self._guard(summary, "no_grade_reports"))
        self.assertLess(self._guard(summary, "no_grade_reports"), self._first_call(summary, {"_slot"}))

    def test_held_trades_never_post(self):
        fn = self._func("trade_roast_bot.py", "hold_no_grade")
        calls = {getattr(n.func, "attr", None) or getattr(n.func, "id", None)
                 for n in ast.walk(fn) if isinstance(n, ast.Call)}
        self.assertFalse(calls & {"send", "create_thread", "_dm_commish", "urlopen", "post"}, calls)

    def test_fire_ab(self):
        fn = self._func("roast_bot_fire_ab.py", "fire_one")
        guard = self._guard(fn, "no_grade")
        self.assertLess(guard, self._first_call(fn, {"build_announcement_embed", "build_trade_roast_context",
                                                     "generate_roast", "discord_post_message"}))

    def test_cli_report_exits_without_a_grade(self):
        fn = self._func("trade_grader.py", "main")
        self.assertIn("no_grade_report", ast.unparse(fn))


GRADE_PATH_FILES = ("trade_grader.py", "pick_valuation.py", "valuation_snapshot.py",
                    "trade_roast_context.py", "trade_roast_bot.py", "roast_bot_fire_ab.py")
VALUATION_FILES = ("pipelines/etl/scripts/extract_valuation_inputs.py",
                   "pipelines/etl/scripts/build_valuation_snapshot.py",
                   "pipelines/etl/scripts/valuation_snapshot.py", "pipelines/etl/scripts/pick_valuation.py",
                   "pipelines/etl/scripts/trade_grader.py", "data/valuation/trade_valuation_snapshot.json")
GRADE_FUNCTIONS = ("analyze_trade", "grade_sides", "_compute_side_value_pts", "_player_production_pts",
                   "_salary_to_pts", "enrich_player", "parse_asset_string", "future_pick_info",
                   "_pick_failures", "load_season_state")
BANNED = {
    "built-in pick curve": ("500.0", "0.03,", "_fit_exponential_curve"),
    "$60 per point": ("or 60", "/ 60", "60.0 if", "= 60.0"),
    "expected auction price = salary": ("max(player.salary", "exp_price", "estimate_production_value"),
    "ADP 999": ("999", "normalized_adp"),
    "projection DB / early projections": ("yoy_signals", "early_projection", "from projection import",
                                          "project_player_ppg", "TRADE_VALUE_MODEL"),
    "career file x.06": ("franchise_career_stats", "CAREER_STATS", "probability_match", "_prob_match",
                         "predict_future_slot"),
}


class NoFallbackConstants(unittest.TestCase):
    def _grade_source(self):
        out = {}
        for f in ("trade_grader.py",):
            tree = ast.parse((SCRIPT_DIR / f).read_text())
            for n in ast.walk(tree):
                if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name in GRADE_FUNCTIONS:
                    out[f"{f}:{n.name}"] = ast.unparse(n)
        for f in ("pick_valuation.py", "valuation_snapshot.py"):
            out[f] = ast.unparse(ast.parse((SCRIPT_DIR / f).read_text()))     # code only, no comments
        return out

    def test_grade_path_has_no_old_substitutes(self):
        sources = self._grade_source()
        self.assertGreaterEqual(len([k for k in sources if k.startswith("trade_grader")]), 8)
        for label, needles in BANNED.items():
            for where, src in sources.items():
                for needle in needles:
                    self.assertFalse(needle in src, f"{label}: {needle!r} in {where}")

    def test_retired_inputs_are_gone(self):
        self.assertFalse((SCRIPT_DIR / "projection.py").exists())
        for f in GRADE_PATH_FILES:
            src = ast.unparse(ast.parse((SCRIPT_DIR / f).read_text()))     # code and docstrings, not comments
            for needle in ("yoy_signals.db", "early_projection_2026", "trade_value_model.json"):
                self.assertFalse(needle in src, f"{needle!r} in {f}")
        # No machine paths anywhere a valuation is built or read.
        for f in VALUATION_FILES:
            text = (REPO / f).read_text()
            for needle in ("Mobile Documents", "CloudDocs", "/Users/", "/home/"):
                self.assertFalse(needle in text, f"{needle!r} in {f}")

    def test_nothing_loaded_means_no_value(self):
        pv.clear_valuation()
        with self.assertRaises(pv.ValuationUnavailable):
            pv.dollars_per_point()
        with self.assertRaises(pv.ValuationUnavailable):
            pv.pick_expected_points(2026, 1, slot=1)
        with self.assertRaises(pv.ValuationUnavailable):
            tg._salary_to_pts(10000)
        side = tg.TradeSide("0001", "A", players_given=[tg.PlayerInfo("1", "X", "RB", "", salary=5000,
                                                                       expected_ppg=10.0)])
        with self.assertRaises(pv.ValuationUnavailable):
            tg.grade_sides(side, tg.TradeSide("0002", "B"))

    def test_the_snapshots_values_are_the_ones_used(self):
        snap = snapshot()
        snap["pick_curve"]["A"] *= 2
        snap["dollars_per_point"]["value"] = 123.0
        snap["players"]["17044"]["ppg"] = 21.5
        an = grade(reseal(snap), gave=("FP_0003_2026_1", "17044"))
        self.assertFalse(an.no_grade, an.no_grade_reasons)
        pk = an.side_a.picks_given[0]
        a, b = snap["pick_curve"]["A"], snap["pick_curve"]["B"]
        self.assertAlmostEqual(pk.expected_points, a * math.exp(-b * pk.predicted_slot), places=3)
        hampton = an.side_b.players_given[0]
        self.assertEqual(hampton.expected_ppg, 21.5)
        self.assertEqual(pv.dollars_per_point(), 123.0)
        self.assertAlmostEqual(tg._salary_to_pts(12300), 100.0)
        pv.clear_valuation()


class Replay(unittest.TestCase):
    """All 27 2026 trades (54 sides) on as-of snapshots: every side graded,
    zero-sum, and the decision 3 split adds up to the full grader."""

    def test_2026_replay_decision_3(self):
        from replay_2026_trade_grades import _SNAPS, d3_parts, replay
        # Pinned: the as-of snapshots are built from the fixture's frozen inputs and
        # coefficients (the MFL folders are dated history), so a later registry
        # refresh can't move these numbers.
        saved = (bvs.INPUT_DIR, bvs.COEFFICIENTS, pv.INSEASON_COEFFICIENTS, pv._COEFFICIENTS)
        bvs.INPUT_DIR, bvs.COEFFICIENTS = PINNED_ROOT / INPUTS_REL, PINNED_ROOT / COEFFICIENTS_REL
        pv.INSEASON_COEFFICIENTS, pv._COEFFICIENTS = PINNED_ROOT / COEFFICIENTS_REL, None
        _SNAPS.clear()
        try:
            parts = d3_parts()
            rows = replay()
        finally:
            bvs.INPUT_DIR, bvs.COEFFICIENTS, pv.INSEASON_COEFFICIENTS, pv._COEFFICIENTS = saved
            _SNAPS.clear()
        self.assertEqual(len(parts), 54)
        by = {(r["key"], r["fid"]): r for r in rows}
        self.assertFalse([r["key"] for r in rows if r["d3_no_grade"]])
        self.assertFalse([r["key"] for r in rows if r["d3_provisional"]])
        for key in {r["key"] for r in rows}:
            a, b = [r for r in rows if r["key"] == key]
            self.assertAlmostEqual(a["d3"][0], -b["d3"][0], places=6)
        self.assertEqual(sum(1 for r in rows if r["d3"][1] != r["d1_d2"][1]), 16)
        self.assertEqual(sum(1 for r in rows if r["d3"][1] != r["live"][1]), 28)
        present_day = sorted({r["key"] for r in rows if r["d3_labels"]})
        self.assertEqual(present_day, ["1774623376", "1775772921", "1776092645", "1776396348"])
        for r in rows:          # as of the last snapshot before the trade, never after
            self.assertTrue(r["d3_labels"] or r["d3_as_of"] <= r["date"], r["key"])
        for p in parts:
            self.assertAlmostEqual(p["steps"][-1][0], p["d3"][0], places=6)
        # 10-06 in season: the two trades the parent review called out.
        self.assertEqual(by[("1791320211", "0006")]["d3"][1], "A")
        self.assertEqual(by[("1791320240", "0010")]["d3"][1], "A-")


# ── CONTRACT: the committed production snapshot, whatever week it holds ──────
CONTRACT_INPUTS = {"rosters", "standings", "snapshot_meta", "player_seasons", "player_ages",
                   "player_registry", "rookie_outcomes", "franchise_history", "inseason_coefficients"}
CONTRACT_KEYS = ("schema_version", "model_version", "season", "as_of", "generated_at", "generator", "inputs",
                 "freshness", "season_state", "dollars_per_point", "pick_curve", "counts", "coverage",
                 "players", "career", "content_sha256")
MFL_INPUTS = ("rosters", "standings", "snapshot_meta")


def contract_failures(root: Path, data: bytes | None = None, rebuild: bool = True) -> list:
    """Everything a committed snapshot must satisfy, checked at its own as-of time.

    root: a repo-shaped tree (the repo itself, or a test copy). data: snapshot
    bytes to check instead of root's committed file. No date, week or value is
    pinned; only internal consistency, the grader's limits and the generator."""
    root = Path(root).resolve()
    raw = (root / SNAPSHOT_REL).read_bytes() if data is None else data
    try:
        snap = json.loads(raw, object_pairs_hook=vs._no_duplicates)
    except ValueError as exc:
        return [f"not strict JSON: {exc}"]
    missing = [k for k in CONTRACT_KEYS if k not in snap]
    if missing:
        return [f"missing metadata: {missing}"]
    f = []
    if snap["schema_version"] != vs.SCHEMA_VERSION:
        f.append(f"schema version {snap['schema_version']!r}")
    if snap["model_version"] != vs.MODEL_VERSION:
        f.append(f"model version {snap['model_version']!r}")
    try:
        as_of = datetime.strptime(str(snap["as_of"]), "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError:
        return f + [f"as_of {snap['as_of']!r} is not a date"]
    try:
        made = datetime.strptime(str(snap["generated_at"]), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if made < as_of:
            f.append("generated_at is before as_of")
    except ValueError:
        f.append(f"generated_at {snap['generated_at']!r} is not a UTC timestamp")
    if snap["freshness"] != bvs.FRESHNESS or bvs.FRESHNESS != {
            "in_season_max_age_days": vs.IN_SEASON_MAX_AGE_DAYS, "offseason_max_age_days": vs.OFFSEASON_MAX_AGE_DAYS,
            "in_season_must_cover_latest_completed_week": True}:
        f.append(f"freshness fields {snap['freshness']} differ from the grader's limits")
    gen = snap["generator"]
    if (gen.get("path") != "pipelines/etl/scripts/build_valuation_snapshot.py" or gen.get("dirty") is not False
            or not re.fullmatch(r"[0-9a-f]{40}", str(gen.get("commit")))):
        f.append(f"generator identity incomplete or dirty: {gen}")
    names = [i.get("name") for i in snap["inputs"]]
    if sorted(names) != sorted(CONTRACT_INPUTS):
        f.append(f"inputs {sorted(names)} are not the snapshot's nine inputs")
    mfl_dir = f"data/mfl-snapshots/{snap['as_of']}/"
    for inp in snap["inputs"]:
        name, rel = inp.get("name"), str(inp.get("path", ""))
        if rel.startswith("/") or ".." in Path(rel).parts:
            f.append(f"input {name} path {rel!r} is not repo-relative")
            continue
        if name in MFL_INPUTS and not rel.startswith(mfl_dir):
            f.append(f"input {name} ({rel}) is not from {mfl_dir}")
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(inp.get("source_date", ""))):
            f.append(f"input {name} source_date {inp.get('source_date')!r} is not a date")
        path = root / rel
        if not path.exists():
            f.append(f"input {name} ({rel}) is missing")
        elif hashlib.sha256(path.read_bytes()).hexdigest() != inp.get("sha256"):
            f.append(f"input {name} ({rel}) changed since the snapshot was built")
    state = snap["season_state"]
    standings = root / mfl_dir / "leagueStandings.json"
    if state.get("source") != mfl_dir + "leagueStandings.json":
        f.append(f"season_state source {state.get('source')!r} is not {mfl_dir}leagueStandings.json")
    elif standings.exists() and state.get("weeks_completed") != bvs.weeks_completed(json.loads(standings.read_text())):
        f.append(f"season_state says week {state.get('weeks_completed')}, but its standings say "
                 f"{bvs.weeks_completed(json.loads(standings.read_text()))}")
    meta = root / mfl_dir / "_snapshot_meta.json"
    if meta.exists() and int(json.loads(meta.read_text())["season_year"]) != snap["season"]:
        f.append(f"season {snap['season']} differs from its MFL snapshot's season")
    counts, players, career = snap["counts"], snap["players"], snap["career"]
    if counts.get("players") != len(players):
        f.append(f"counts.players {counts.get('players')} != {len(players)} players")
    if counts.get("franchises") != len(career) or len(career) != 12:
        f.append(f"counts.franchises {counts.get('franchises')} vs {len(career)} career blocks (need 12)")
    if counts.get("picks") != 36:
        f.append(f"counts.picks {counts.get('picks')} != 36")
    if sum((snap["coverage"].get("by_basis") or {}).values()) != len(players):
        f.append("coverage.by_basis does not add up to the player count")
    own_time = as_of.timestamp() + DAY + 3600              # an hour after its data's day ends
    f += [f"validator: {x}" for x in vs.validate_snapshot(
        snap, now=own_time, league_season=snap["season"],
        live_weeks_completed=state.get("weeks_completed"), repo=root)]
    if rebuild and not f and bvs.render(build_at(root, snap["as_of"], snap["generated_at"])) != raw:
        f.append("does not rebuild byte for byte from its own as_of and generated_at "
                 "with the committed generator and inputs")
    return f


def contract_snapshot() -> dict:
    return json.loads((CONTRACT_ROOT / SNAPSHOT_REL).read_bytes())


class CommittedSnapshotContract(unittest.TestCase):
    """Whatever week is committed: never pinned to a date, week or value."""

    def test_meets_the_contract(self):
        self.assertEqual(contract_failures(CONTRACT_ROOT), [])

    def test_valid_at_its_own_time_and_stale_after_the_limit(self):
        snap = contract_snapshot()
        weeks = snap["season_state"]["weeks_completed"]
        own = datetime.strptime(snap["as_of"], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() + DAY
        limit = vs.IN_SEASON_MAX_AGE_DAYS if weeks >= 1 else vs.OFFSEASON_MAX_AGE_DAYS
        check = lambda now, live: [str(x) for x in vs.validate_snapshot(  # noqa: E731
            snap, now=now, league_season=snap["season"], live_weeks_completed=live, repo=CONTRACT_ROOT)]
        self.assertEqual(check(own + (limit - 0.5) * DAY, weeks), [])
        stale = check(own + (limit + 0.5) * DAY, weeks)
        self.assertTrue(any("stale: built from data as of" in x and f"limit {limit} days" in x for x in stale), stale)
        behind = check(own + 3600, weeks + 1)
        self.assertTrue(any(f"but week {weeks + 1} is complete" in x for x in behind), behind)

    def test_production_limits_unchanged(self):
        self.assertEqual((vs.IN_SEASON_MAX_AGE_DAYS, vs.OFFSEASON_MAX_AGE_DAYS), (8, 14))
        self.assertEqual(vs.NO_GRADE_HEADER, "VALUATION INPUTS UNAVAILABLE — NO GRADE")
        self.assertEqual(vs.SNAPSHOT_PATH, REPO / SNAPSHOT_REL)

    def test_no_private_material(self):
        snap = contract_snapshot()
        text = (CONTRACT_ROOT / SNAPSHOT_REL).read_text() + "".join(
            (CONTRACT_ROOT / i["path"]).read_text() for i in snap["inputs"] if "valuation" in i["path"])
        for banned in ("Library/Mobile Documents", "/Users/", "@", "cookie", "password", "token",
                       "api_key", "http://", "https://", "prompt"):
            self.assertNotIn(banned, text.lower() if banned.islower() else text, banned)


def _bytes(mutate, seal=True) -> bytes:
    snap = contract_snapshot()
    mutate(snap)
    return bvs.render(reseal(snap) if seal else snap)


def _duplicate_first_player() -> bytes:
    raw = (CONTRACT_ROOT / SNAPSHOT_REL).read_bytes()
    start = raw.index(b"\n", raw.index(b'"players": {')) + 1
    line = raw[start:raw.index(b"\n", start) + 1]
    return raw[:start] + line + raw[start:]


# name: (snapshot bytes, text the contract must report)
CONTRACT_BREAKS = {
    "hand edit, checksum not resealed": (lambda: _bytes(lambda s: s["players"][next(iter(s["players"]))].update(
        ppg=99.0), seal=False), "content checksum does not match"),
    "value edited and resealed": (lambda: _bytes(lambda s: s["dollars_per_point"].update(value=59.0)),
                                  "does not rebuild byte for byte"),
    "player count disagrees": (lambda: _bytes(lambda s: s["counts"].update(players=s["counts"]["players"] + 1)),
                               "counts.players"),
    "week disagrees with its standings": (lambda: _bytes(lambda s: s["season_state"].update(
        weeks_completed=s["season_state"]["weeks_completed"] + 1)), "but its standings say"),
    "input changed since the build": (lambda: _bytes(lambda s: s["inputs"][0].update(sha256="0" * 64)),
                                      "changed since the snapshot was built"),
    "input from another day's MFL folder": (lambda: _bytes(lambda s: next(
        i for i in s["inputs"] if i["name"] == "rosters").update(path="data/mfl-snapshots/2026-10-19/rosters.json")),
        "is not from data/mfl-snapshots/"),
    "dirty generator": (lambda: _bytes(lambda s: s["generator"].update(dirty=True)), "generator identity"),
    "weakened freshness": (lambda: _bytes(lambda s: s["freshness"].update(in_season_max_age_days=30)),
                           "differ from the grader's limits"),
    "missing metadata": (lambda: _bytes(lambda s: s.pop("generated_at")), "missing metadata: ['generated_at']"),
    "wrong model": (lambda: _bytes(lambda s: s.update(model_version="trade-valuation-0")), "model version"),
    "duplicate player id": (lambda: _duplicate_first_player(), "not strict JSON: duplicate key"),
}


class ContractCatchesBrokenSnapshots(unittest.TestCase):
    def test_each_break_is_reported(self):
        for name, (make, needle) in CONTRACT_BREAKS.items():
            with self.subTest(name):
                failures = contract_failures(CONTRACT_ROOT, data=make())
                self.assertTrue(any(needle in x for x in failures), (needle, failures))


def make_later_week(root: Path, as_of: str = "2026-10-27", weeks_added: int = 1) -> Path:
    """A repo-shaped tree holding a valid snapshot a week after the pinned one: the
    repo's current inputs and coefficients, plus a synthetic MFL folder (the 10-20
    rosters; standings carried forward `weeks_added` weeks), built by the committed
    generator exactly as a weekly rebuild would."""
    root = Path(root).resolve()
    for rel in [INPUTS_REL / p.name for p in (REPO / INPUTS_REL).glob("*.json")] + [COEFFICIENTS_REL]:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(REPO / rel, root / rel)
    src, dst = PINNED_ROOT / "data" / "mfl-snapshots" / AS_OF, root / "data" / "mfl-snapshots" / as_of
    dst.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src / "rosters.json", dst / "rosters.json")
    meta = json.loads((src / "_snapshot_meta.json").read_text())
    meta["snapshot_date_utc"] = as_of
    (dst / "_snapshot_meta.json").write_text(json.dumps(meta, indent=2, sort_keys=True))
    standings = json.loads((src / "leagueStandings.json").read_text())
    for row in standings["leagueStandings"]["franchise"]:
        w, l, t = (int(x) for x in row["all_play_wlt"].split("-"))
        row["all_play_wlt"] = f"{w + 6 * weeks_added}-{l + 5 * weeks_added}-{t}"
        row["pf"] = f"{float(row['pf']) + 120.0 * weeks_added:.2f}"
    (dst / "leagueStandings.json").write_text(json.dumps(standings, indent=2, sort_keys=True))
    snap = build_at(root, as_of, f"{as_of}T20:00:00Z")
    (root / SNAPSHOT_REL).parent.mkdir(parents=True, exist_ok=True)
    (root / SNAPSHOT_REL).write_bytes(bvs.render(snap))
    return root


def run_module_with_contract_root(root: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, **{CONTRACT_ROOT_ENV: str(root)})
    return subprocess.run([sys.executable, str(Path(__file__).resolve())], env=env, cwd=str(REPO),
                          capture_output=True, text=True, timeout=600)


@unittest.skipIf(os.environ.get(CONTRACT_ROOT_ENV), "already running against a replacement snapshot")
class LaterWeekReplacement(unittest.TestCase):
    """Replacing the committed snapshot with a later valid week keeps the suite
    green; a broken or stale one still fails."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="valuation-week7-")).resolve()
        cls.week7 = make_later_week(cls.tmp / "week7")
        cls.snap7 = json.loads((cls.week7 / SNAPSHOT_REL).read_bytes())

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_simulated_week_7_meets_the_contract(self):
        self.assertEqual((self.snap7["as_of"], self.snap7["season_state"]["weeks_completed"]), ("2026-10-27", 7))
        self.assertEqual(contract_failures(self.week7), [])

    def test_week_7_grades_and_the_week_6_snapshot_is_refused(self):
        now = datetime(2026, 10, 28, 12, tzinfo=timezone.utc).timestamp()
        an = grade(None, live_state(7), now=now, repo=self.week7)
        self.assertFalse(an.no_grade, an.no_grade_reasons)
        self.assertTrue(an.valuation_as_of.startswith("2026-10-27"))
        old = grade(snapshot(), live_state(7), now=now)
        self.assertTrue(old.no_grade)
        self.assertTrue(any("but week 7 is complete" in r for r in old.no_grade_reasons), old.no_grade_reasons)

    def test_whole_module_passes_with_week_7_committed(self):
        res = run_module_with_contract_root(self.week7)
        self.assertEqual(res.returncode, 0, res.stdout[-3000:] + res.stderr[-3000:])
        self.assertIn("OK", res.stderr)

    def test_week_7_is_refused_once_stale(self):
        # Production freshness is unchanged for any committed week: past 8 days in
        # season (or once week 8 completes) the bot gets NO GRADE.
        own = datetime(2026, 10, 28, tzinfo=timezone.utc).timestamp()
        aged = grade(None, live_state(7), now=own + 8.5 * DAY, repo=self.week7)
        self.assertTrue(aged.no_grade)
        self.assertTrue(any("limit 8 days in season" in r for r in aged.no_grade_reasons), aged.no_grade_reasons)
        behind = grade(None, live_state(8), now=own + DAY, repo=self.week7)
        self.assertTrue(any("but week 8 is complete" in r for r in behind.no_grade_reasons), behind.no_grade_reasons)

    def test_whole_module_fails_with_a_broken_week_committed(self):
        for name, mutate, seal in (
                ("internally inconsistent", lambda s: s["counts"].update(players=s["counts"]["players"] - 1), True),
                ("edited without resealing", lambda s: s["dollars_per_point"].update(value=1.0), False),
                ("input changed since the build", lambda s: s["inputs"][0].update(sha256="0" * 64), True)):
            with self.subTest(name):
                broken = self.tmp / f"broken-{name.replace(' ', '-')}"
                shutil.copytree(self.week7, broken)
                snap = json.loads((broken / SNAPSHOT_REL).read_bytes())
                mutate(snap)
                (broken / SNAPSHOT_REL).write_bytes(bvs.render(reseal(snap) if seal else snap))
                self.assertNotEqual(contract_failures(broken), [])
                res = run_module_with_contract_root(broken)
                self.assertNotEqual(res.returncode, 0, name)
                self.assertIn("CommittedSnapshotContract", res.stderr)


if __name__ == "__main__":
    unittest.main()
