#!/usr/bin/env python3
"""First-round picks are graded on football value; the rookie contract is shown, not scored.

Keith 2026-10-20, #1343 decision 1 (Option 2). The grader used to charge the
receiver of an R1 pick its full 3-year rookie salary at $60 a point, which
ranked 1.01-1.12 backwards (an earlier first has a higher salary) and made a
straight pick swap a loss for both teams. Now every round is scored like
R2-R6 already were, and the contract plus the 4th-year option (Year 3 salary
+ $5,000, not guaranteed) is shown on its own line. The salary still feeds the
cap view (trade_announcement's net salary change).

Offline: no D1, no network. pick_valuation's module state is pinned so nothing
is read from the gitignored model files.
  python3 pipelines/etl/scripts/test_trade_grader_r1_contract.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pick_valuation as pv  # noqa: E402

pv._CURVE_A, pv._CURVE_B, pv._DOLLARS_PER_POINT = 500.0, 0.03, 60.0
pv._CAREER_CACHE = {}

from trade_grader import (  # noqa: E402
    TradeSide, TradeAnalysis, parse_asset_string, _compute_side_value_pts,
    grade_sides, rookie_contract_line, format_discord_report,
)

# Canon §A1 rookie scale: 1.01 $15K down $1K a slot, floor $5K at 1.11-1.12.
CANON_R1_AAV = {1: 15000, 2: 14000, 3: 13000, 4: 12000, 5: 11000, 6: 10000,
                7: 9000, 8: 8000, 9: 7000, 10: 6000, 11: 5000, 12: 5000}


def pick(token):
    _players, picks, _bb = parse_asset_string(f"{token},", {}, {"0010": "Blake Bombers"})
    return picks[0]


def receive_only(pk):
    return _compute_side_value_pts(TradeSide("0001", "A", picks_received=[pk]))


def swap(gave_a, gave_b):
    """Two sides of a picks-only trade, graded the way analyze_trade grades them."""
    a_gives = [pick(t) for t in gave_a]
    b_gives = [pick(t) for t in gave_b]
    a = TradeSide("0007", "A", picks_given=a_gives, picks_received=b_gives)
    b = TradeSide("0010", "B", picks_given=b_gives, picks_received=a_gives)
    grade_sides(a, b)
    return a, b


class FirstsAreOrdered(unittest.TestCase):
    def test_101_through_112_most_to_least_valuable(self):
        firsts = [pick(f"DP_0_{s - 1}") for s in range(1, 13)]
        self.assertEqual([p.predicted_slot for p in firsts], list(range(1, 13)))
        nets = [receive_only(p)["net_pts"] for p in firsts]
        for s in range(11):
            self.assertGreater(nets[s], nets[s + 1], f"1.{s + 1:02d} vs 1.{s + 2:02d}")

    def test_higher_salary_never_lowers_an_earlier_pick(self):
        for s in range(1, 12):
            earlier, later = pick(f"DP_0_{s - 1}"), pick(f"DP_0_{s}")
            self.assertGreaterEqual(earlier.rookie_aav, later.rookie_aav)
            ve, vl = receive_only(earlier), receive_only(later)
            # Value is the football value itself: no salary is charged to the receiver.
            self.assertEqual(ve["given_pts"], 0)
            self.assertAlmostEqual(ve["net_pts"], earlier.expected_points)
            self.assertGreater(ve["net_pts"], vl["net_pts"])

    def test_same_treatment_as_rounds_two_to_six(self):
        for token in ("DP_0_0", "DP_1_0", "DP_2_0", "DP_3_0", "DP_4_0", "FP_0010_2027_1", "FP_0010_2027_2"):
            pk = pick(token)
            v = receive_only(pk)
            self.assertEqual(v["given_pts"], 0, token)
            self.assertEqual(v["salary_committed"], 0, token)
            self.assertAlmostEqual(v["net_pts"], pk.expected_points)


class PickSwapsAreZeroSum(unittest.TestCase):
    CASES = (
        (["DP_0_9"], ["FP_0010_2027_1"]),        # 2026-03-27: 1.10 for a 2027 1st (graded C / C+)
        (["DP_0_0"], ["DP_0_11"]),               # 1.01 for 1.12
        (["DP_0_5"], ["DP_1_0", "DP_1_1"]),      # a 1st for two 2nds
        (["DP_0_2", "DP_2_4"], ["DP_0_3", "DP_2_3"]),
    )

    def test_equal_and_opposite(self):
        for gave_a, gave_b in self.CASES:
            a, b = swap(gave_a, gave_b)
            self.assertAlmostEqual(a.value_pts["net_pts"], -b.value_pts["net_pts"], msg=gave_a)
            self.assertAlmostEqual(a.grade_score, -b.grade_score, msg=gave_a)
            self.assertFalse(a.grade_score < 0 and b.grade_score < 0, f"both teams lose: {gave_a}")

    def test_the_side_getting_more_football_value_wins(self):
        a, b = swap(["DP_0_11"], ["DP_0_0"])     # A gives 1.12, gets 1.01
        self.assertGreater(a.grade_score, 0)
        self.assertLess(b.grade_score, 0)
        self.assertEqual(a.grade_score, -b.grade_score)


class ContractIsShown(unittest.TestCase):
    def test_terms_match_canon_with_option_year(self):
        for s, aav in CANON_R1_AAV.items():
            t = pv.rookie_contract_terms(1, s)
            self.assertEqual((t["aav"], t["years"], t["tcv"]), (aav, 3, 3 * aav), s)
            self.assertEqual(t["option_salary"], aav + 5000, s)
        self.assertNotIn("option_salary", pv.rookie_contract_terms(2, 1))

    def test_line_for_a_known_slot(self):
        self.assertEqual(
            rookie_contract_line(pick("DP_0_0")),
            "Rookie contract (not in the grade): 1.01 $15,000/yr x 3 = $45,000; "
            "4th-year option $20,000 (Year 3 $15,000 + $5,000), not guaranteed")
        self.assertIn("1.12 $5,000/yr x 3 = $15,000; 4th-year option $10,000",
                      rookie_contract_line(pick("DP_0_11")))

    def test_line_for_a_future_pick_shows_the_slot_range(self):
        line = rookie_contract_line(pick("FP_0010_2027_1"))
        self.assertIn("set by draft slot", line)
        self.assertIn("$10,000/yr x 3 = $30,000 at ~1.06", line)
        self.assertIn("$15,000 at 1.12 to $45,000 at 1.01", line)
        self.assertIn("4th-year option $15,000 (Year 3 $10,000 + $5,000), not guaranteed", line)

    def test_no_contract_line_for_later_rounds(self):
        for token in ("DP_1_0", "DP_2_5", "FP_0010_2027_2", "FP_0010_2027_4"):
            self.assertEqual(rookie_contract_line(pick(token)), "", token)

    def test_visible_in_the_roast_context_line(self):
        from trade_roast_context import render_pick_line
        pk = pick("DP_0_0")
        line = render_pick_line({"year": 2026, "round": 1, "slot": 1, "value": pk.estimated_value,
                                 "contract": rookie_contract_line(pk)})
        self.assertIn("4th-year option $20,000", line)
        self.assertIn("$15,000/yr x 3 = $45,000", line)

    def test_visible_in_the_announcement_and_still_used_for_cap(self):
        from trade_announcement import _build_side_block, _net_salary_change
        first = pick("DP_0_0")
        giver = TradeSide("0007", "A", picks_given=[first])
        block = _build_side_block(giver, "0007", {"0007": "Sex Manther"})
        self.assertIn("2026 Sex Manther's Pick 1.01", block)
        self.assertIn("1.01 $15,000/yr x 3 = $45,000", block)
        self.assertIn("4th-year option $20,000", block)
        # Cap feasibility keeps the salary: the receiver of a current-year 1st owes the rookie.
        receiver = TradeSide("0010", "B", picks_received=[first])
        self.assertEqual(_net_salary_change(receiver), 15000)

    def test_visible_in_the_grade_report(self):
        a, b = swap(["DP_0_9"], ["FP_0010_2027_1"])
        report = format_discord_report(TradeAnalysis(side_a=a, side_b=b), {})
        self.assertIn("2027 R1: Rookie contract (not in the grade): set by draft slot", report)
        self.assertIn("2026 R1: Rookie contract (not in the grade): 1.10 $6,000/yr x 3 = $18,000; "
                      "4th-year option $11,000", report)
        self.assertNotIn("Salary Taken On", report)


if __name__ == "__main__":
    unittest.main()
