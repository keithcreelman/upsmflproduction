#!/usr/bin/env python3
"""Offline tests for build_ros_projections.py: no network, no D1, no writes outside a temp folder."""
import json
import os
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_ros_projections as B  # noqa: E402

POS = {"1": "QB", "2": "WR", "3": "Coach", "4": "RB", "5": "TE", "6": "DE", "7": "LB", "8": "CB", "9": "PK", "10": "PN", "11": "WR"}
ROSTERED = {"1", "2", "4", "5", "6", "7", "8", "9", "10"}
EV = {"rotowirePoints": 100, "sleeperUpdatedAt": "2026-10-28T00:00:00Z"}


def proj():
    all_pids = {p: 10.0 for p in ROSTERED}
    return {8: dict(all_pids, **{"2": 20.0}), 9: dict(all_pids), 10: dict(all_pids), 11: {"1": 4.0}}


class Window(unittest.TestCase):
    def test_next_week_through_end_week(self):
        self.assertEqual(B.window(7, 17), list(range(8, 18)))
        self.assertEqual(B.window(17, 17), [])
        self.assertEqual(B.window(0, 3), [1, 2, 3])


class Payload(unittest.TestCase):
    def test_a_missing_week_counts_as_zero_and_never_projected_is_null(self):
        p = B.build_payload(2026, 7, 11, proj(), POS, ROSTERED | {"99"}, EV, "t")
        self.assertEqual(p["weeks"], [8, 11])
        self.assertEqual(p["nWeeks"], 4)
        self.assertEqual(p["players"]["2"]["ppg"], 10.0)     # (20+10+10+absent)/4: an absent week counts 0
        self.assertEqual(p["players"]["2"]["w"], [20.0, 10.0, 10.0, None])
        self.assertEqual(p["players"]["2"]["projWeeks"], 3)
        self.assertEqual(p["players"]["1"]["ppg"], 8.5)      # (10+10+10+4)/4

    def test_a_rostered_player_with_no_projection_is_null_not_zero(self):
        P = dict(POS, **{"12": "WR"})
        p = B.build_payload(2026, 7, 11, proj(), P, ROSTERED | {"12"}, EV, "t")
        self.assertIsNone(p["players"]["12"]["ppg"])
        self.assertEqual(p["players"]["12"]["projWeeks"], 0)

    def test_unrostered_and_never_projected_is_left_out_and_non_players_are_dropped(self):
        pr = proj()
        pr[8]["3"] = 5.0
        p = B.build_payload(2026, 7, 11, pr, POS, ROSTERED, EV, "t")
        self.assertNotIn("3", p["players"])
        self.assertNotIn("11", p["players"])

    def test_no_weeks_left_refuses(self):
        with self.assertRaises(B.BuildError):
            B.build_payload(2026, 17, 17, proj(), POS, ROSTERED, EV, "t")


class PlayedGames(unittest.TestCase):
    KICKS = {t: 1000 for t in ("CAR", "GBP")}

    def kicks(self):
        k = dict((("T%02d" % i), 5000) for i in range(26))
        k.update(self.KICKS)
        return k

    def test_a_kicked_off_game_is_dropped_for_his_team_only(self):
        played = B.played_teams({8: self.kicks()}, 2000)
        self.assertEqual(played, {8: ["CAR", "GBP"]})
        team = {"1": "CAR", "2": "T00"}
        p = B.build_payload(2026, 7, 10, proj(), POS, ROSTERED, EV, "t", played, team)
        self.assertEqual(p["players"]["1"]["w"][0], None)              # the Thursday game is gone
        self.assertEqual(p["players"]["1"]["ppg"], 10.0)               # 2 of his 2 remaining weeks: not divided by 3
        self.assertEqual(p["players"]["1"]["remainingWeeks"], 2)
        self.assertEqual(p["players"]["2"]["ppg"], 13.33)              # (20+10+10)/3: his game hasn't been played
        self.assertEqual(p["players"]["2"]["remainingWeeks"], 3)
        self.assertEqual(p["playedExcluded"], {"8": ["CAR", "GBP"]})

    def test_the_kickoff_second_itself_counts_as_played(self):
        self.assertEqual(B.played_teams({8: {"A": 2000}}, 1999), {})
        self.assertEqual(B.played_teams({8: {"A": 2000}}, 2000), {8: ["A"]})

    def test_nothing_played_changes_nothing(self):
        a = B.build_payload(2026, 7, 11, proj(), POS, ROSTERED, EV, "t", None, {"1": "CAR"})
        b = B.build_payload(2026, 7, 11, proj(), POS, ROSTERED, EV, "t", {}, {"1": "CAR"})
        self.assertEqual(a, b)

    def test_the_file_keeps_every_kickoff_and_each_players_team_for_the_worker(self):
        kicks = {8: self.kicks(), 9: self.kicks(), 10: self.kicks()}
        p = B.build_payload(2026, 7, 10, proj(), POS, ROSTERED, EV, "t", {}, {"1": "CAR"}, None, kicks)
        self.assertEqual(sorted(p["kickoffs"]), ["10", "8", "9"])
        self.assertEqual(p["kickoffs"]["9"]["CAR"], 1000)
        self.assertEqual(p["players"]["1"]["team"], "CAR")
        self.assertEqual(p["players"]["2"]["team"], "")                # no team on file: no game to leave out

    def test_a_lagging_completed_week_drops_the_whole_week(self):
        team = {"1": "CAR", "2": "GBP"}
        played = {8: sorted(team.values())}
        p = B.build_payload(2026, 7, 10, proj(), POS, ROSTERED, EV, "t", played, team)
        self.assertEqual(p["players"]["1"]["ppg"], 10.0)
        self.assertEqual(p["players"]["2"]["ppg"], 10.0)

    def test_an_unreadable_or_short_schedule_fails_closed(self):
        good = {"nflSchedule": {"matchup": [{"kickoff": "100", "team": [{"id": "T%02d" % i}, {"id": "U%02d" % i}]} for i in range(14)]}}
        self.assertEqual(len(B.kickoffs_from(good, 2026, 8)), 28)
        short = {"nflSchedule": {"matchup": {"kickoff": "100", "team": [{"id": "A"}, {"id": "B"}]}}}
        for bad in (None, {}, {"nflSchedule": {}}, {"nflSchedule": {"matchup": [{"kickoff": "soon", "team": [{"id": "A"}]}]}}, short):
            with self.assertRaises(B.BuildError):
                B.kickoffs_from(bad, 2026, 8)


class EveryWeeksKickoffs(unittest.TestCase):
    """build() reads every window week, so the worker can draw the line for as long as the file stays in place."""
    def run_build(self, schedule_for):
        now = time.time()
        fake = types.SimpleNamespace(LIVE_SEASON=0, MFL="%d %s %s", MFL_PLAYERS="players %d",
                                     fetch=None, prepare=lambda *a, **k: {"end": 10, "proj": proj(), "pos": POS, "rostered": ROSTERED, "evCoverage": EV, "absent": {}})
        def fetch(url, cache):
            if "weeklyResults" in url:
                return {"weeklyResults": {"week": "7"}}
            if url.startswith("players"):
                return {"players": {"player": [{"id": "1", "team": "T00"}]}}
            return schedule_for(int(url.rsplit("W=", 1)[1]), now)
        fake.fetch = fetch
        with mock.patch.dict(sys.modules, {"season_sim": fake}), mock.patch.object(B, "check_coverage", return_value={}):
            return B.build(2026, "unused")[0]

    @staticmethod
    def good(kick):
        return {"nflSchedule": {"matchup": [{"kickoff": str(int(kick)), "team": [{"id": "T%02d" % i}, {"id": "U%02d" % i}]} for i in range(14)]}}

    def test_a_week_nobody_has_started_still_has_its_kickoffs_in_the_file(self):
        p = self.run_build(lambda wk, now: self.good(now + 86400 * wk))
        self.assertEqual(sorted(p["kickoffs"]), ["10", "8", "9"])
        self.assertEqual(p["playedExcluded"], {})

    def test_an_unreadable_later_week_fails_the_build(self):
        with self.assertRaises(B.BuildError):
            self.run_build(lambda wk, now: {} if wk == 10 else self.good(now + 86400))


class Availability(unittest.TestCase):
    WEEKS = [8, 9, 10, 11]
    PROJ = {w: {"1": 10.0} for w in WEEKS}

    def build(self, a):
        # prepare() has already removed the weeks he is listed out.
        proj = dict((w, {} if w in a["weeks"] else {"1": 10.0}) for w in self.WEEKS)
        return B.build_payload(2026, 7, 11, proj, {"1": "WR"}, {"1"}, {"rotowirePoints": 9}, "t", absent={"1": a})

    def test_a_listed_return_counts_from_that_week(self):
        out = self.build({"weeks": [8, 9], "returns": "Nov 8, 2026", "source": "MFL injuries export (week 8)"})
        self.assertEqual(out["players"]["1"]["w"], [None, None, 10.0, 10.0])
        self.assertEqual(out["players"]["1"]["ppg"], 5.0)
        self.assertEqual(out["avail"]["1"], {"k": "back", "wk": 10})

    def test_a_feed_ahead_of_the_window_still_counts_him_only_from_his_return(self):
        # MFL's feed starts at its own week 9; the window starts at 8. Week 8 still has a projection for him.
        out = B.build_payload(2026, 7, 11, self.PROJ, {"1": "WR"}, {"1"}, {"rotowirePoints": 9}, "t",
                              absent={"1": {"weeks": [9], "returns": "Nov 8, 2026", "source": "MFL injuries export (week 9)"}})
        self.assertEqual(out["players"]["1"]["w"], [None, None, 10.0, 10.0])
        self.assertEqual(out["avail"]["1"], {"k": "back", "wk": 10})

    def test_a_return_after_the_window_has_no_week_left(self):
        out = self.build({"weeks": self.WEEKS, "returns": "Feb 15, 2027", "source": "MFL injuries export (week 8)"})
        self.assertEqual(out["players"]["1"]["ppg"], None)
        self.assertEqual(out["avail"]["1"], {"k": "back", "wk": None})

    def test_no_return_on_file_counts_no_week_whatever_the_forecast_assumed(self):
        # season_sim holds this player out four games and would count the rest; the ruling counts none.
        for source in ("MFL injuries export (week 8)", "MFL rosters export: INJURED_RESERVE"):
            out = self.build({"weeks": [8, 9, 10], "returns": "", "source": source})
            self.assertEqual(out["players"]["1"]["w"], [None, None, None, None])
            self.assertEqual(out["players"]["1"]["ppg"], None)
            self.assertEqual(out["avail"]["1"], {"k": "none"})

    def test_a_reported_absence_keeps_its_own_weeks(self):
        out = self.build({"weeks": [2], "returns": "", "source": "A reported story"})
        self.assertEqual(out["players"]["1"]["w"], [10.0, 10.0, 10.0, 10.0])
        self.assertEqual(out["avail"], {})

    def test_healthy_or_questionable_is_not_listed(self):
        out = B.build_payload(2026, 7, 11, self.PROJ, {"1": "WR"}, {"1"}, {"rotowirePoints": 9}, "t")
        self.assertEqual(out["avail"], {})


class Season(unittest.TestCase):
    def test_the_offseason_is_outside_and_january_is_last_season(self):
        self.assertEqual([m for m in range(1, 13) if B.in_season(m)], [1, 9, 10, 11, 12])
        from datetime import datetime
        self.assertEqual(B.default_season(datetime(2027, 1, 3)), 2026)
        self.assertEqual(B.default_season(datetime(2026, 11, 3)), 2026)


class Rounding(unittest.TestCase):
    def test_the_average_uses_unrounded_numbers(self):
        pr = {8: {"1": 10.04}, 9: {"1": 10.04}, 10: {"1": 10.04}}
        row = B.player_row("1", pr, [8, 9, 10])
        self.assertEqual(row["ppg"], 10.04)                   # rounded weeks would have said 10.0
        self.assertEqual(row["w"], [10.0, 10.0, 10.0])


class Coverage(unittest.TestCase):
    def payload(self):
        return B.build_payload(2026, 7, 11, proj(), POS, ROSTERED, EV, "t")

    def test_passes_and_reports_each_position(self):
        self.assertEqual(B.check_coverage(self.payload(), POS, ROSTERED, EV)["QB"], "1/1")

    def test_mfl_only_file_is_refused(self):
        for ev in (None, {"rotowirePoints": 0}):
            with self.assertRaisesRegex(B.BuildError, "MFL-only"):
                B.check_coverage(self.payload(), POS, ROSTERED, ev)

    def test_thin_position_is_refused(self):
        p = self.payload()
        p["players"]["6"]["ppg"] = None
        with self.assertRaisesRegex(B.BuildError, "DL 0/1"):
            B.check_coverage(p, POS, ROSTERED, EV)

    def test_position_with_no_rostered_player_is_refused(self):
        with self.assertRaisesRegex(B.BuildError, "no rostered players at PN"):
            B.check_coverage(self.payload(), POS, ROSTERED - {"10"}, EV)


class CompletedWeek(unittest.TestCase):
    def test_reads_mfl_week_and_fails_closed(self):
        self.assertEqual(B.completed_week({"weeklyResults": {"week": "7"}}), 7)
        for bad in ({}, {"weeklyResults": {}}, {"weeklyResults": {"week": "x"}}, {"weeklyResults": {"week": "-1"}}, None):
            with self.assertRaises(B.BuildError):
                B.completed_week(bad)


class Main(unittest.TestCase):
    def run_main(self, argv, builder):
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "ros.json")
            code = B.main(["--out", out] + argv, builder=builder)
            data = json.load(open(out)) if os.path.exists(out) else None
            return code, data, sorted(os.listdir(d))

    def test_default_run_touches_nothing(self):
        os.environ.pop("UPS_ALLOW_PROD_D1_READS", None)
        def boom(*a):
            raise AssertionError("the builder (and its D1 read) must not run without the opt-in")
        self.assertEqual(self.run_main([], boom), (0, None, []))

    def test_opted_in_run_writes_the_file_with_no_temp_left(self):
        pay = {"players": {}, "avail": {}, "weeks": [8, 11], "nWeeks": 4, "throughWeek": 7}
        code, data, names = self.run_main(["--allow-prod-d1"], lambda s, c: (pay, {}))
        self.assertEqual((code, data, names), (0, pay, ["ros.json"]))

    def test_a_failed_build_exits_1_and_writes_nothing(self):
        def bad(s, c):
            raise B.BuildError("coverage")
        self.assertEqual(self.run_main(["--allow-prod-d1"], bad), (1, None, []))

    def test_outside_the_window_exits_0_and_writes_nothing(self):
        self.assertEqual(self.run_main(["--allow-prod-d1"], lambda s, c: (None, None)), (0, None, []))


if __name__ == "__main__":
    unittest.main(verbosity=1)
