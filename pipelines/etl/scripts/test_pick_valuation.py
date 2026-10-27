#!/usr/bin/env python3
"""Future picks are valued over bracket odds (Keith 2026-10-20, #1343 decision 2).

The draft order follows the prior season's brackets (canon §A1), so a future
pick is valued over the chance its ORIGINAL franchise lands on the Hawk Tuah
side (N.01-N.06) or the playoff side (N.07-N.12), every slot inside a side
equally likely. The chance comes from the current owner's playoff history
(canon §D.2 tenure) pulled toward 50% (k = 4 next season, 6 further out),
blended in season with that season's All-Play % and points for. Missing or
owner histories that conflict with canon §D.2 make the grade provisional;
missing or invalid core inputs block it (decision 3). Nothing falls back
silently to x.06, which is what the grader did all of 2026.

Offline: no D1, no network. Module state is pinned; nothing is read from the
gitignored career file or the trade-value model.
  python3 pipelines/etl/scripts/test_pick_valuation.py
"""
import json
import sys
import unittest
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO = SCRIPT_DIR.parents[2]
sys.path.insert(0, str(SCRIPT_DIR))
import pick_valuation as pv  # noqa: E402
import trade_grader as tg  # noqa: E402

CURRENT = 2026


def owner(display, seasons, made, tenure):
    return {"display": display, "seasons_count": seasons, "playoff_appearances": made,
            "seasons_by_franchise": tenure}


# A career file in the rebuilder's shape: owner block + 4-season trend, no per-season list.
CAREER = {
    "0001": {"current_year": CURRENT, "trend": [{"season": 2025, "finish": 6}],
             "owner": owner("Contender", 16, 12, {"0001": list(range(2010, 2026))})},
    "0011": {"current_year": CURRENT, "trend": [{"season": 2025, "finish": 7}],
             "owner": owner("Rebuilder", 16, 1, {"0011": list(range(2010, 2026))})},
    "0002": {"current_year": CURRENT, "trend": [{"season": 2025, "finish": 12}],
             "owner": owner("Derrick Whitman", 9, 7, {"0002": [2012, 2013, 2014, 2015, 2016, 2017, 2023, 2024, 2025]})},
}
TEAMS = [f"{i:04d}" for i in range(1, 13)]


def pin(career=None):
    pv._CURVE_A, pv._CURVE_B, pv._DOLLARS_PER_POINT = 500.0, 0.03, 60.0
    pv._CAREER_CACHE = json.loads(json.dumps(career if career is not None else CAREER))
    pv._COEFFICIENTS = None


def in_season(week=4, ap=None, pf=None):
    ap = ap or {f: 0.5 for f in TEAMS}
    pf = pf or {f: 800.0 for f in TEAMS}
    return pv.SeasonState(CURRENT, "in_season", week, ap, pf, "2026-10-06T15:50:11Z")


OFFSEASON = pv.SeasonState(CURRENT, "offseason")


class Mapping(unittest.TestCase):
    def test_canon_bracket_map(self):
        canon = {7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 5: 7, 6: 8, 4: 9, 3: 10, 2: 11, 1: 12}
        self.assertEqual({f: pv.slot_for_finish(f) for f in range(1, 13)}, canon)


class OriginalFranchise(unittest.TestCase):
    def setUp(self):
        pin()

    def test_original_franchise_not_the_holder_sets_the_odds(self):
        # 0001 (a contender) hands over 0011's pick: 0011's history decides it.
        _p, picks, _bb = tg.parse_asset_string("FP_0011_2027_1,", {}, {}, OFFSEASON)
        pk = picks[0]
        self.assertEqual(pk.projection.original_fid, "0011")
        self.assertAlmostEqual(pk.projection.p_playoff, (1 + 2) / (16 + 4))
        holder = pv.project_future_pick("0001", 2027, 1, OFFSEASON)
        self.assertNotAlmostEqual(pk.projection.p_playoff, holder.p_playoff)
        self.assertEqual(pk.original_owner, "0011")

    def test_canon_d2_tenure_is_checked(self):
        bad = json.loads(json.dumps(CAREER))
        bad["0002"]["owner"]["seasons_by_franchise"]["0002"] = [2012, 2013, 2014, 2015, 2016, 2022, 2023, 2024, 2025]
        pin(bad)
        proj = pv.project_future_pick("0002", 2027, 1, OFFSEASON)
        self.assertTrue(proj.provisional)
        joined = " ".join(proj.issues)
        self.assertIn("leaves out 2017", joined)
        self.assertIn("counts 2022", joined)
        pin()
        self.assertFalse(pv.project_future_pick("0002", 2027, 1, OFFSEASON).provisional)


class PickYear(unittest.TestCase):
    def setUp(self):
        pin()

    def test_year_changes_the_shrinkage(self):
        nxt = pv.project_future_pick("0001", 2027, 1, OFFSEASON)
        later = pv.project_future_pick("0001", 2028, 1, OFFSEASON)
        self.assertEqual((nxt.seasons_ahead, nxt.prior_seasons), (0, 4))
        self.assertEqual((later.seasons_ahead, later.prior_seasons), (1, 6))
        self.assertAlmostEqual(nxt.p_playoff, (12 + 2) / (16 + 4))
        self.assertAlmostEqual(later.p_playoff, (12 + 3) / (16 + 6))
        self.assertGreater(nxt.p_playoff, later.p_playoff)   # further out is pulled harder to 50%

    def test_completed_season_sets_the_slot(self):
        proj = pv.project_future_pick("0011", 2026, 1)       # decided by 2025: 0011 finished 7th
        self.assertEqual((proj.basis, proj.slot), ("set", 1))
        self.assertEqual(proj.dist, {1: 1.0})
        self.assertFalse(proj.provisional)


class InSeason(unittest.TestCase):
    def setUp(self):
        pin()

    def test_cutoff_never_reads_later_weeks(self):
        from backtest_pick_slot_model import standings_through
        weeks = {(2025, "0001"): [[1, 8, 11, 120.0], [2, 6, 11, 100.0]],
                 (2025, "0002"): [[1, 3, 11, 90.0], [2, 5, 11, 95.0]]}
        before = standings_through(weeks, 2025, 1)
        weeks[(2025, "0001")].append([2, 0, 11, 5000.0])   # extra later-week rows
        weeks[(2025, "0002")].append([9, 11, 11, 9000.0])
        self.assertEqual(standings_through(weeks, 2025, 1), before)
        self.assertEqual(before[0]["0001"], 8 / 11)

    def test_replay_standings_were_committed_before_each_trade(self):
        data = json.loads((REPO / "tests/fixtures/trade_replay_2026.json").read_text())
        checked = 0
        for t in data["trades"]:
            st = t["season_state"]
            if st.get("snapshot_committed_utc"):
                self.assertLess(st["snapshot_committed_utc"].replace("Z", "+00:00"),
                                t["utc"].replace("Z", "+00:00"), t["key"])
                checked += 1
        self.assertGreaterEqual(checked, 4)

    def test_late_standings_are_refused(self):
        rows = [{"id": f, "all_play_pct": "0.5", "pf": "500", "all_play_wlt": "22-22-0"} for f in TEAMS]
        saved = tg.mfl_fetch
        tg.mfl_fetch = lambda *_a, **_k: {"leagueStandings": {"franchise": rows}}
        try:
            fresh = tg.load_season_state(1_000_000, now=1_000_000 + 600)
            late = tg.load_season_state(1_000_000, now=1_000_000 + 7 * 3600)
        finally:
            tg.mfl_fetch = saved
        self.assertEqual((fresh.status, fresh.weeks_completed), ("in_season", 4))
        self.assertEqual(late.status, "unavailable")
        self.assertIn("after the trade", late.reason)

    def test_current_form_moves_the_odds(self):
        ap = {f: 0.5 for f in TEAMS}; ap["0011"] = 0.85
        pf = {f: 800.0 for f in TEAMS}; pf["0011"] = 1000.0
        hot = pv.project_future_pick("0011", 2027, 1, in_season(4, ap, pf))
        cold = pv.project_future_pick("0011", 2027, 1, OFFSEASON)
        self.assertEqual((hot.basis, hot.weeks_completed), ("in_season", 4))
        self.assertGreater(hot.p_playoff, cold.p_playoff + 0.2)


class BracketUniform(unittest.TestCase):
    def setUp(self):
        pin()

    def test_slots_uniform_within_each_side(self):
        for state in (OFFSEASON, in_season(6)):
            proj = pv.project_future_pick("0011", 2027, 1, state)
            p = proj.p_playoff
            self.assertAlmostEqual(sum(proj.dist.values()), 1.0)
            for s in pv.TOILET_SLOTS:
                self.assertAlmostEqual(proj.dist[s], (1 - p) / 6)
            for s in pv.PLAYOFF_SLOTS:
                self.assertAlmostEqual(proj.dist[s], p / 6)

    def test_value_is_weighted_over_the_twelve_slots(self):
        proj = pv.project_future_pick("0011", 2027, 2, OFFSEASON)
        want = sum(p * pv.pick_expected_points(2027, 2, slot=s) for s, p in proj.dist.items())
        _pl, picks, _bb = tg.parse_asset_string("FP_0011_2027_2,", {}, {}, OFFSEASON)
        self.assertAlmostEqual(picks[0].expected_points, want)


class Wording(unittest.TestCase):
    def setUp(self):
        pin()

    def say(self, p, basis="in_season", issues=()):
        proj = pv.FuturePickProjection("0011", 2027, 1, basis=basis, deciding_season=2026,
                                       weeks_completed=4, p_playoff=p,
                                       dist=pv.bracket_distribution(p), issues=list(issues))
        return pv.describe_pick_odds(proj)

    def test_thresholds(self):
        self.assertTrue(self.say(0.80).startswith("likely playoff side: 20% Hawk Tuah side (1.01-1.06), 80% playoff side (1.07-1.12)"))
        self.assertTrue(self.say(0.7999).startswith("leans playoff side: 21% Hawk Tuah side"))
        self.assertTrue(self.say(0.60).startswith("leans playoff side: 40% Hawk Tuah side"))
        self.assertTrue(self.say(0.5999).startswith("toss-up: 41% Hawk Tuah side"))
        self.assertTrue(self.say(0.20).startswith("likely Hawk Tuah side: 80% Hawk Tuah side"))
        self.assertTrue(self.say(0.2001).startswith("leans Hawk Tuah side: 79% Hawk Tuah side"))
        self.assertTrue(self.say(0.5).startswith("toss-up: 50% Hawk Tuah side (1.01-1.06), 50% playoff side (1.07-1.12)"))

    def test_disclosures_and_banned_phrases(self):
        off = self.say(0.7, "offseason")
        self.assertIn("owner playoff history only, which is a weak signal", off)
        self.assertIn("average slot", off)
        self.assertIn("an average of the odds, not a predicted finish", off)
        self.assertIn("through week 4", self.say(0.7))
        for text in (off, self.say(0.9), self.say(0.5, "league_average", ["x"])):
            for banned in ("predicted slot", "HIGH confidence", "LOW confidence"):
                self.assertNotIn(banned, text)

    def test_roast_and_announcement_carry_the_odds(self):
        from trade_roast_context import render_pick_line
        from trade_announcement import _build_side_block
        _pl, picks, _bb = tg.parse_asset_string("FP_0011_2027_1,", {}, {"0011": "Rebuilder"}, OFFSEASON)
        pk = picks[0]
        line = render_pick_line({"year": 2027, "round": 1, "slot": None, "odds": pk.odds_text,
                                 "value": pk.estimated_value, "contract": tg.rookie_contract_line(pk)})
        self.assertIn("bracket odds: likely Hawk Tuah side: 85% Hawk Tuah side (1.01-1.06)", line)
        self.assertNotIn("predicted slot", line)
        block = _build_side_block(tg.TradeSide("0001", "A", picks_given=[pk]), "0001", {"0011": "Rebuilder"})
        self.assertIn("2027 Rebuilder's 1st Round Pick", block)
        self.assertIn("Bracket odds: likely Hawk Tuah side", block)


class FailVisibly(unittest.TestCase):
    """Decision 3 split: a missing or invalid core input BLOCKS the grade (NO
    GRADE); only an owner history that conflicts with canon §D.2 is valued at
    50/50 and PROVISIONAL (decision 2). Neither falls back to x.06."""

    def setUp(self):
        pin()

    def assert_blocked(self, proj, text):
        self.assertNotEqual(proj.dist, {6: 1.0})
        self.assertFalse(proj.provisional)
        self.assertTrue(any(text in b for b in proj.blocking), proj.blocking)
        self.assertTrue(pv.describe_pick_odds(proj).startswith("UNAVAILABLE ("))

    def test_missing_owner_history(self):
        broken = json.loads(json.dumps(CAREER)); del broken["0011"]["owner"]
        pin(broken)
        self.assert_blocked(pv.project_future_pick("0011", 2027, 1, OFFSEASON), "no owner history for 0011")

    def test_unknown_original_franchise(self):
        self.assert_blocked(pv.project_future_pick("0099", 2027, 1, OFFSEASON), "original franchise 0099")

    def test_unreadable_pick_year(self):
        _pl, picks, _bb = tg.parse_asset_string("FP_0011_20X7_1,", {}, {}, OFFSEASON)
        self.assert_blocked(picks[0].projection, "pick year '20X7' is unreadable")

    def test_missing_current_season_standings_blocks_rounds_1_to_3(self):
        states = (None, pv.SeasonState(CURRENT, "unavailable", reason="MFL leagueStandings unavailable (URLError)"),
                  in_season(4, {f: 0.5 for f in TEAMS[:6]}, {f: 800.0 for f in TEAMS[:6]}))
        for state in states:
            self.assertTrue(pv.project_future_pick("0011", 2027, 1, state).blocking)
            r4 = pv.project_future_pick("0011", 2027, 4, state)     # same value at every slot
            self.assertFalse(r4.blocking)
            self.assertTrue(r4.notes)

    def test_missing_career_block(self):
        pin({})
        self.assert_blocked(pv.project_future_pick("0011", 2027, 1, OFFSEASON), "not in the valuation snapshot")

    def test_d2_conflict_is_provisional_not_blocked(self):
        broken = json.loads(json.dumps(CAREER))
        broken["0002"]["owner"]["seasons_by_franchise"]["0002"].remove(2017)
        pin(broken)
        proj = pv.project_future_pick("0002", 2027, 1, OFFSEASON)
        self.assertEqual(proj.blocking, [])
        self.assertTrue(proj.provisional)
        self.assertEqual(proj.dist, pv.bracket_distribution(0.5))
        self.assertIn("leaves out 2017 (0002)", proj.issues[0])
        self.assertTrue(pv.describe_pick_odds(proj).startswith("PROVISIONAL ("))

    def test_provisional_reaches_the_grade_and_the_roast(self):
        from trade_grader import with_provisional_banner
        broken = json.loads(json.dumps(CAREER))
        broken["0002"]["owner"]["seasons_by_franchise"]["0002"].remove(2017)
        pin(broken)
        _pl, r1, _ = tg.parse_asset_string("FP_0002_2027_1,", {}, {}, OFFSEASON)
        _pl, r4, _ = tg.parse_asset_string("FP_0002_2027_4,", {}, {}, OFFSEASON)
        a = tg.TradeSide("0001", "A", picks_given=r1 + r4)
        b = tg.TradeSide("0011", "B", picks_received=r1 + r4)
        reasons = tg.provisional_reasons(a, b)
        self.assertEqual(len(reasons), 1)                 # round 4+ value does not depend on the slot
        self.assertIn("2027 round 1 pick (0002)", reasons[0])
        tg.grade_sides(a, b)
        report = tg.format_discord_report(tg.TradeAnalysis(side_a=a, side_b=b, provisional_reasons=reasons), {})
        self.assertIn("PROVISIONAL GRADE -- not final", report)
        roast = with_provisional_banner("Roast text.", reasons)
        self.assertTrue(roast.startswith("⚠️ **Provisional grade, not final.**"))
        self.assertTrue(roast.endswith("Roast text."))


class Backtest(unittest.TestCase):
    def test_ruling_model_beats_x06_at_every_horizon_and_in_season(self):
        import backtest_pick_slot_model as bt
        bt.use_live_curve()
        finish, _tenure = bt.load_finishes()
        for lag in (1, 2, 3):
            rows = bt.targets(finish, lag)
            models = bt.offseason_models(lag)
            rule = next(n for n in models if n.endswith("(ruling)"))
            x06 = bt.rmse(bt.score(rows, models["x.06 (live today)"])[0])
            self.assertLess(bt.rmse(bt.score(rows, models[rule])[0]), x06, lag)
        weeks, reg_end = bt.load_weekly()
        res, _ = bt.inseason_backtest(finish, weeks, reg_end, week_list=(4,))
        owner_only, blend = res[4]
        self.assertLess(blend, owner_only * 0.95)

    def test_coefficients_cover_the_regular_season(self):
        data = json.loads(pv.INSEASON_COEFFICIENTS.read_text())
        self.assertEqual(data["fitted_seasons"], [2011, 2025])
        self.assertEqual(sorted(int(w) for w in data["weeks"]), list(range(1, 15)))


class Replay(unittest.TestCase):
    def test_2026_replay(self):
        from replay_2026_trade_grades import replay
        rows = replay()
        self.assertEqual(len(rows), 54)
        by = {(r["key"], r["fid"]): r for r in rows}
        d2_moves = {k for k, r in by.items() if r["d1_d2"][1] != r["d1"][1]}
        self.assertEqual(d2_moves, {("1774623376", "0007"), ("1774623376", "0010"),
                                    ("1779668813", "0004"), ("1779668813", "0003")})
        self.assertEqual(sum(1 for r in rows if r["d1_d2"][1] != r["live"][1]), 14)
        # 03-27: equal and opposite; 10-06: the in-season trades.
        self.assertEqual((by[("1774623376", "0007")]["d1_d2"][1], by[("1774623376", "0010")]["d1_d2"][1]), ("B", "B"))
        self.assertAlmostEqual(by[("1774623376", "0007")]["d1_d2"][0], -by[("1774623376", "0010")]["d1_d2"][0])
        self.assertEqual(by[("1791320211", "0006")]["d1_d2"][1], "A")
        self.assertEqual(by[("1791320240", "0010")]["d1_d2"][1], "A-")
        self.assertFalse(any(r["provisional"] for r in rows))
        pin()


if __name__ == "__main__":
    unittest.main()
