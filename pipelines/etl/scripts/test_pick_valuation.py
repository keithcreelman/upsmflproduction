#!/usr/bin/env python3
"""Future rookie picks are valued over the bracket-first slot distribution.

The draft order is NOT inverse finish (canon §A1): the Hawk Tuah winner (finish
7) picks 1.01 and the worst team (finish 12) picks 1.06. The old model valued a
future pick at round(13 - average finish), which sent a projected 7th-place team
to 1.06. In production it never got that far: franchise_career_stats.json lost
its per-season list on 2026-05-23, so every owner fell back to finish 6.5 and
every future pick was valued at x.06.

Offline: no D1, no network. Module state is pinned so nothing is read from the
gitignored career-stats file or the trade-value model.
  python3 pipelines/etl/scripts/test_pick_valuation.py
"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pick_valuation as pv  # noqa: E402

# franchise_career_stats.json as the 2026-05-23+ rebuilder writes it: an owner
# block and a 4-season trend, no per-season "seasons" list.
CAREER = {
    "0001": {"franchise_name": "Contender", "trend": [{"season": 2025, "finish": 6}],
             "owner": {"seasons_count": 16, "playoff_appearances": 12}},
    "0011": {"franchise_name": "Rebuilder", "trend": [{"season": 2025, "finish": 7}],
             "owner": {"seasons_count": 16, "playoff_appearances": 1}},
}


def pin(career=CAREER):
    pv._CURVE_A, pv._CURVE_B, pv._DOLLARS_PER_POINT = 500.0, 0.03, 60.0
    pv._CAREER_CACHE = dict(career)


def slot_pts(rnd, slot):
    return 500.0 * math.exp(-0.03 * ((rnd - 1) * 12 + slot))


class DraftOrder(unittest.TestCase):
    def test_slot_for_finish_is_the_canon_bracket_map(self):
        canon = {7: 1, 8: 2, 9: 3, 10: 4, 11: 5, 12: 6, 5: 7, 6: 8, 4: 9, 3: 10, 2: 11, 1: 12}
        self.assertEqual({f: pv.slot_for_finish(f) for f in range(1, 13)}, canon)
        self.assertEqual(sorted(canon.values()), list(range(1, 13)))
        # The old inverse map sent the Hawk Tuah winner to 1.06 and the worst team to 1.01.
        self.assertNotEqual(pv.slot_for_finish(7), 13 - 7)
        self.assertNotEqual(pv.slot_for_finish(12), 13 - 12)


class SlotDistribution(unittest.TestCase):
    def setUp(self):
        pin()

    def test_owner_block_is_read_without_a_seasons_list(self):
        # (made + 2) / (seasons + 4): the shrunk playoff rate, not a 6.5 default.
        self.assertAlmostEqual(pv.playoff_probability("0001"), 14 / 20)
        self.assertAlmostEqual(pv.playoff_probability("0011"), 3 / 20)

    def test_unknown_owner_gets_the_league_average(self):
        self.assertEqual(pv.playoff_probability("9999"), 0.5)
        dist = pv.future_slot_distribution("9999")
        for s in range(1, 13):
            self.assertAlmostEqual(dist[s], 1 / 12)

    def test_bracket_first_is_uniform_inside_each_bracket(self):
        p = pv.playoff_probability("0011")
        dist = pv.future_slot_distribution("0011")
        self.assertAlmostEqual(sum(dist.values()), 1.0)
        for s in pv.TOILET_SLOTS:
            self.assertAlmostEqual(dist[s], (1 - p) / 6)
        for s in pv.PLAYOFF_SLOTS:
            self.assertAlmostEqual(dist[s], p / 6)

    def test_future_pick_is_the_distribution_average(self):
        for rnd in (1, 2, 3):
            for fid in ("0001", "0011"):
                dist = pv.future_slot_distribution(fid)
                want = sum(p * slot_pts(rnd, s) for s, p in dist.items())
                got = pv.pick_expected_points(2027, rnd, original_owner=fid)
                self.assertAlmostEqual(got, want)
                self.assertLess(slot_pts(rnd, 12), got)
                self.assertLess(got, slot_pts(rnd, 1))
            # The usual non-playoff team's pick is worth more than the contender's.
            self.assertGreater(pv.pick_expected_points(2027, rnd, "0011"),
                               pv.pick_expected_points(2027, rnd, "0001"))

    def test_known_slot_is_valued_at_that_slot(self):
        self.assertAlmostEqual(pv.pick_expected_points(2026, 1, slot=1), slot_pts(1, 1))
        self.assertEqual(pv.pick_expected_points(2027, 4, "0011"), pv.FALLBACK_DEEP_ROUND_PTS[4])

    def test_rookie_salary_uses_the_same_distribution(self):
        dist = pv.future_slot_distribution("0011")
        want = sum(p * pv.pick_rookie_salary_aav(1, s) for s, p in dist.items())
        self.assertEqual(pv.expected_rookie_salary_aav(1, "0011"), round(want))
        self.assertEqual(pv.expected_rookie_salary_aav(2, "0011"), 5000)

    def test_display_slot_is_the_rounded_expected_slot(self):
        # 0001: 3.5 + 6 * 0.7 = 7.7 -> ~1.08; 0011: 3.5 + 6 * 0.15 = 4.4 -> ~1.04
        self.assertEqual(pv.predict_future_slot("0001"), 8)
        self.assertEqual(pv.predict_future_slot("0011"), 4)


class TradeGraderPicks(unittest.TestCase):
    def setUp(self):
        pin()

    def test_future_pick_carries_distribution_values(self):
        from trade_grader import parse_asset_string
        _players, picks, _bb = parse_asset_string("FP_0011_2027_1,DP_0_0,", {}, {"0011": "Rebuilder"})
        fp, dp = picks
        self.assertAlmostEqual(fp.expected_points, pv.pick_expected_points(2027, 1, "0011"))
        self.assertEqual(fp.rookie_aav, pv.expected_rookie_salary_aav(1, "0011"))
        self.assertEqual(fp.predicted_slot, pv.predict_future_slot("0011"))
        self.assertEqual((dp.round, dp.predicted_slot, dp.rookie_aav), (1, 1, 15000))


class Backtest(unittest.TestCase):
    def test_proposed_model_beats_the_alternatives(self):
        from backtest_pick_slot_model import run_backtest
        res = run_backtest()
        proposed = next(v for k, v in res.items() if k.endswith("PROPOSED"))
        for name in ("live today: every future pick at x.06",
                     "code as written, data restored: round(13 - avg finish)",
                     "naive fix: canon slot of round(avg finish)",
                     "league average: uniform 1.01-1.12",
                     "finish distribution, shrunk (k=8)"):
            for target_set in ("franchise", "owner"):
                self.assertLess(proposed[target_set]["rmse"], res[name][target_set]["rmse"],
                                f"{name} / {target_set}")
        for target_set in ("franchise", "owner"):
            self.assertLess(proposed[target_set]["logloss"],
                            res["league average: uniform 1.01-1.12"][target_set]["logloss"])


class GradeImpact(unittest.TestCase):
    def test_live_model_reproduces_reference_scores_and_three_letters_move(self):
        from pick_model_grade_impact import analyze
        rows = analyze()
        self.assertEqual(len(rows), 12)
        for r in rows:
            for i in (0, 1):
                self.assertAlmostEqual(r["live"][i], r["ref"][i], delta=0.05, msg=r["ts"])
            if r["cross"]:
                for i in (0, 1):
                    self.assertAlmostEqual(r["cross"][i], r["ref"][i], delta=0.1, msg=r["ts"])
        moved = {(r["ts"], r["fids"][i], r["live_letters"][i], r["new_letters"][i])
                 for r in rows for i in (0, 1) if r["live_letters"][i] != r["new_letters"][i]}
        self.assertEqual(moved, {
            ("1779668813", "0004", "B-", "B"),
            ("1779668813", "0003", "B+", "B"),
            ("1791320211", "0006", "B+", "A-"),
        })


if __name__ == "__main__":
    unittest.main()
