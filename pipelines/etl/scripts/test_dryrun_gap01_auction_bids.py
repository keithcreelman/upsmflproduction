#!/usr/bin/env python3
"""Offline tests for the GAP-01 auction-bid dry run and the GAP-16 week check.

No network, no D1: the MFL replies are synthetic files in a temp cache, and
the default runs of both scripts' D1 commands must make no `npx` call.

Usage:
  python3 pipelines/etl/scripts/test_dryrun_gap01_auction_bids.py
"""
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import dryrun_gap01_auction_bids as g  # noqa: E402
import check_gap16_last_league_week as w  # noqa: E402

OWNER_NOTE = "private note from an owner, never stored"


def ts(y, mo, d, h=12, mi=0):
    return int(datetime(y, mo, d, h, mi, tzinfo=g.ET).timestamp())


def ev(kind, fid, amount, t, pid="100", idx=0, comment=""):
    return {"type": "AUCTION_" + kind, "reply_index": idx, "player_id": pid, "amount": amount,
            "amount_unreadable": False, "amount_raw": str(amount), "comment": comment, "fid": fid, "ts": t}


class SplitRules(unittest.TestCase):
    def test_two_nominations_in_one_season_are_two_auctions(self):
        es = [ev("INIT", "0001", 1000, ts(2024, 5, 15)), ev("BID", "0002", 5000, ts(2024, 5, 15, 13)),
              ev("WON", "0002", 5000, ts(2024, 5, 17)),
              ev("INIT", "0003", 1000, ts(2024, 7, 27)), ev("WON", "0003", 1000, ts(2024, 7, 28))]
        a = g.split_auctions(es, None, idle_rule=False)
        self.assertEqual([x["split_reason"] for x in a], ["nomination", "nomination"])
        self.assertEqual([x["won"]["amount"] for x in a], [5000, 1000])

    def test_init_with_no_win_is_kept_as_its_own_auction(self):
        es = [ev("INIT", "0006", 1000, ts(2024, 5, 15)), ev("INIT", "0005", 1000, ts(2024, 7, 27)),
              ev("WON", "0005", 1000, ts(2024, 7, 28))]
        a = g.split_auctions(es, None, idle_rule=False)
        self.assertEqual([(x["split_reason"], x["end_reason"]) for x in a],
                         [("nomination", "superseded_by_new_nomination"), ("new_nomination", "won")])

    def test_idle_over_lock_splits_cancelled_fa_bidding(self):
        es = [ev("BID", "0011", 1000, ts(2016, 8, 7, 7)), ev("BID", "0002", 4000, ts(2016, 8, 8, 23)),
              ev("WON", "0007", 9000, ts(2016, 8, 10))]
        a = g.split_auctions(es, None, idle_rule=True)
        self.assertEqual([x["split_reason"] for x in a], ["first_bid", "idle_over_lock"])
        self.assertIsNone(a[0]["won"])

    def test_idle_rule_never_splits_an_era_auction(self):
        es = [ev("BID", "0008", 5000, ts(2018, 5, 1)), ev("BID", "0001", 8000, ts(2018, 5, 5)),
              ev("WON", "0001", 8000, ts(2018, 5, 5, 13))]
        self.assertEqual(len(g.split_auctions(es, None, idle_rule=True)), 1)

    def test_repeated_own_bid_does_not_split(self):
        # Justin Forsett 2015: three $40,000 entries from 0004 inside one real auction.
        t = ts(2015, 8, 9, 8)
        es = [ev("BID", "0004", 11000, t - 3600), ev("BID", "0004", 40000, t, idx=3),
              ev("BID", "0004", 40000, t, idx=2), ev("BID", "0004", 40000, t, idx=1),
              ev("WON", "0004", 1000, t + 86400)]
        self.assertEqual(len(g.split_auctions(es, None, idle_rule=True)), 1)

    def test_mfl_report_start_moves_earlier_bids_out(self):
        es = [ev("BID", "0008", 1000, ts(2014, 8, 7, 23, 59)), ev("BID", "0008", 1000, ts(2014, 8, 8, 0, 1)),
              ev("WON", "0008", 1000, ts(2014, 8, 9, 0, 1))]
        a = g.split_auctions(es, ts(2014, 8, 8, 0, 1), idle_rule=True)
        self.assertEqual([(x["split_reason"], x["won"] is not None) for x in a],
                         [("first_bid", False), ("mfl_report_start", True)])

    def test_same_second_order_follows_mfl_newest_first(self):
        t = ts(2023, 8, 1)
        es = [ev("BID", "0002", 3000, t, idx=0), ev("BID", "0009", 2000, t, idx=1)]
        a = g.split_auctions(es, None, idle_rule=False)
        self.assertEqual([x["amount"] for x in a[0]["events"]], [2000, 3000])


class Replay(unittest.TestCase):
    def rows(self, seq):
        return [{"fid": f, "amount": a, "_amount_raw": r} for f, a, r in seq]

    def test_gore_2016_tie_sets_price_and_own_raise_moves_nothing(self):
        seq = [("0006", 1000, None), ("0003", 41000, None), ("0004", 43000, None),
               ("0003", 43000, None), ("0004", 44000, None)]
        self.assertEqual(g.replay_every_bid(self.rows(seq)), ("0004", 43000))

    def test_unreadable_amount_reads_as_subtraction(self):
        # Pierre Thomas 2014: MFL's price $19,996 = 0006's '19000-4' + $1,000.
        seq = [("0005", 1000, None), ("0010", 5000, None), ("0008", 6000, None), ("0006", None, "19000-4"),
               ("0002", 9000, None), ("0008", 18000, None), ("0008", 20000, None), ("0008", 21000, None)]
        self.assertEqual(g.replay_every_bid(self.rows(seq)), ("0008", 19996))

    def test_unopposed_auction_costs_the_minimum(self):
        self.assertEqual(g.replay_every_bid(self.rows([("0005", 3000, None), ("0005", 3000, None)])), ("0005", 1000))


class Parsing(unittest.TestCase):
    def test_amounts(self):
        self.assertEqual(g.parse_amount("40000"), 40000)
        self.assertEqual(g.parse_amount("40000.00"), 40000)
        self.assertIsNone(g.parse_amount("19000-4"))
        self.assertIsNone(g.parse_amount(""))

    def test_forcer_resolution(self):
        names = {"0005": "HammerTime 🔨 ⏰", "0011": "Gridiron Grits"}
        every = {"hammertime 🔨 ⏰": {"0005"}, "the baster": {"0011"}, "gridiron grits": {"0011"},
                 "shared name": {"0001", "0002"}}
        mojibake = "HammerTime 🔨 ⏰".encode("utf-8").decode("latin-1")
        self.assertEqual(g.resolve_forcer(f"{mojibake} forced bid increase", names, every),
                         (True, "0005", "season_name"))
        self.assertEqual(g.resolve_forcer("The Baster forced bid increase", names, every),
                         (True, "0011", "other_season_name"))
        self.assertEqual(g.resolve_forcer("Shared Name forced bid increase", names, every),
                         (True, None, "unresolved"))
        self.assertEqual(g.resolve_forcer(OWNER_NOTE, names, every), (False, None, ""))

    def test_o102_parse_never_reads_the_comments_column(self):
        html = ("<table><tr><td><a href='player?L=1&amp;P=12626'>Henry, Derrick TEN RB</a></td>"
                "<td>$94,000</td><td></td><td><a href='x?L=1&amp;F=0008'>Team</a></td>"
                "<td>Sat Jul 29 2:01 p.m.</td><td>Thu Aug 3 2:54 p.m.</td>"
                f"<td>{OWNER_NOTE}</td></tr></table>")
        rows = g.parse_o102(html, 2023)
        self.assertEqual(rows[0]["player_id"], "12626")
        self.assertEqual(rows[0]["winner_fid"], "0008")
        self.assertEqual(rows[0]["started_unix"], ts(2023, 7, 29, 14, 1))
        self.assertNotIn(OWNER_NOTE, json.dumps(rows))

    def test_o102_epoch_sentinel_is_missing(self):
        self.assertIsNone(g._o102_time("Wed Dec 31 7:00 p.m.", 2016))

    def test_last_league_week(self):
        self.assertEqual([w.last_league_week(s) for s in (2010, 2020, 2021, 2025)], [16, 16, 17, 17])


class PrivacyScan(unittest.TestCase):
    def test_scan_finds_a_leak_and_passes_clean_files(self):
        with tempfile.TemporaryDirectory() as d:
            bad, ok = Path(d) / "bad.md", Path(d) / "ok.md"
            bad.write_text(f"row ... {OWNER_NOTE} ...")
            ok.write_text("no comments here")
            self.assertFalse(g.privacy_scan([bad, ok], {OWNER_NOTE})["pass"])
            self.assertTrue(g.privacy_scan([ok], {OWNER_NOTE})["pass"])


class SyntheticSeason(unittest.TestCase):
    """One fake 2023 season through build_season -> SQL -> local SQLite, twice."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        cache = g.MflCache(root, offline=True)
        for s in g.CHECK_SEASONS + g.BID_SEASONS:
            p = cache.path_for(s, {"TYPE": "league"})
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"reply": {"league": {"franchises": {"franchise": [
                {"id": "0008", "name": "Keith Team"}, {"id": "0010", "name": "Blake Team"}]}}}}))
            for t in g.AUCTION_TYPES:
                cache.path_for(s, {"TYPE": "transactions", "TRANS_TYPE": t}).write_text(
                    json.dumps({"reply": {"transactions": {}}}))
            (root / str(s) / "O-102.html.json").write_text(json.dumps({"html": "<table></table>"}))
        t0 = ts(2023, 7, 29, 14, 1)
        txs = {
            "AUCTION_INIT": [{"type": "AUCTION_INIT", "franchise": "0008", "timestamp": str(t0),
                              "transaction": f"12626|1000|{OWNER_NOTE}"}],
            "AUCTION_BID": [  # newest first, like MFL
                {"type": "AUCTION_BID", "franchise": "0008", "timestamp": str(t0 + 7200),
                 "transaction": "12626|3000|Blake Team forced bid increase"},
                {"type": "AUCTION_BID", "franchise": "0010", "timestamp": str(t0 + 3600),
                 "transaction": "12626|2000.00|"}],
            "AUCTION_WON": [{"type": "AUCTION_WON", "franchise": "0008", "timestamp": str(t0 + 93600),
                             "transaction": "12626|3000|"},
                            {"type": "AUCTION_WON", "franchise": "", "timestamp": "1487900000",
                             "transaction": "|"}],
        }
        for t, rows in txs.items():
            cache.path_for(2023, {"TYPE": "transactions", "TRANS_TYPE": t}).write_text(
                json.dumps({"reply": {"transactions": {"transaction": rows}}}))
        self.cache = cache

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_store_and_reload(self):
        sd = g.build_season(self.cache, 2023)
        self.assertEqual(sd["counts"]["blank_won_rows"], 1)
        self.assertEqual(len(sd["auctions"]), 1)
        a = sd["auctions"][0]
        self.assertEqual((a["outcome"], a["winner_fid"], a["winning_bid"], a["bid_count"], a["start_basis"]),
                         ("won", "0008", 3000, 3, "nomination"))
        self.assertEqual([(b["seq"], b["fid"], b["amount"], b["forced"], b["forcing_fid"]) for b in sd["bids"]],
                         [(1, "0008", 1000, 0, None), (2, "0010", 2000, 0, None), (3, "0008", 3000, 1, "0010")])
        self.assertEqual(g.integrity_errors(sd["auctions"], sd["bids"]), [])
        a_rows = [g.stored(x, g.AUCTION_COLS) for x in sd["auctions"]]
        b_rows = [g.stored(x, g.BID_COLS) for x in sd["bids"]]
        self.assertNotIn(OWNER_NOTE, json.dumps(a_rows + b_rows))
        self.assertNotIn("forced bid increase", json.dumps(a_rows + b_rows))
        stmts = (g.insert_statements(g.AUCTIONS_TABLE, g.AUCTION_COLS, g.AUCTION_PK, a_rows)
                 + g.insert_statements(g.BIDS_TABLE, g.BID_COLS, g.BID_PK, b_rows))
        conn = sqlite3.connect(":memory:")
        conn.executescript(g.SCHEMA_SQL.read_text())
        for s in stmts:
            conn.execute(s)
        first = conn.total_changes
        self.assertEqual(first, 4)
        for s in stmts:
            conn.execute(s)
        self.assertEqual(conn.total_changes, first, "re-running the load must change nothing")
        self.assertEqual(conn.execute("SELECT COUNT(*) FROM ups_hist_auction_bids").fetchone()[0], 3)
        self.assertEqual((a["price_check"], a["caveat"]), ("last_bid", None))
        self.assertEqual({b["amount_meaning"] for b in sd["bids"]}, {"price_after_bid"})
        self.assertEqual([b["amount_raw"] for b in sd["bids"]], [None, "2000.00", None])

        # verify-d1 reconciles what a load wrote: here the "D1" is this local SQLite copy.
        out = Path(self.tmp.name) / "build"
        out.mkdir()
        (out / "auctions.jsonl").write_text("".join(json.dumps(dict(zip(g.AUCTION_COLS, r))) + "\n" for r in a_rows))
        (out / "bids.jsonl").write_text("".join(json.dumps(dict(zip(g.BID_COLS, r))) + "\n" for r in b_rows))
        (out / "summary.json").write_text(json.dumps({"fingerprints": {
            g.AUCTIONS_TABLE: g.fingerprint(a_rows), g.BIDS_TABLE: g.fingerprint(b_rows)}}))
        conn.row_factory = sqlite3.Row

        def runner(sql):
            rows = [dict(r) for r in conn.execute(sql)]
            if sql.startswith("EXPLAIN"):
                rows = [{"detail": r["detail"]} for r in rows]
            return [{"results": rows, "meta": {"rows_read": len(rows)}}]

        args = type("A", (), {"allow_prod_d1": True, "out": out})()
        self.assertEqual(g.cmd_verify_d1(args, runner=runner), 0)
        conn.execute("UPDATE ups_hist_auctions SET winning_bid = 4000")
        self.assertEqual(g.cmd_verify_d1(args, runner=runner), 1, "a changed price must fail verification")

    def test_unexplained_price_is_flagged(self):
        # Jamison Crowder 2016 shape: a logged rival bid above the winner's that MFL never honored.
        a = {"outcome": "won", "winner_fid": "0008", "winning_bid": 4000}
        evs = [{"fid": "0001", "amount": 3000, "_amount_raw": None}, {"fid": "0008", "amount": 3000, "_amount_raw": None},
               {"fid": "0008", "amount": 4000, "_amount_raw": None}, {"fid": "0005", "amount": 5000, "_amount_raw": None}]
        self.assertEqual(g.price_check(2016, a, evs), "unexplained")
        self.assertEqual(g.price_check(2016, a, evs[:3]), "proxy_replay")
        self.assertEqual(g.price_check(2016, {"outcome": "no_win"}, evs), "none")


class Preflight(unittest.TestCase):
    NOW = datetime(2026, 10, 22, 22, 10, tzinfo=g.timezone.utc)

    def usage(self, today_per_hour, past_per_hour):
        w = {}
        for d in range(0, 8):
            day = (self.NOW - g.timedelta(days=d)).strftime("%Y-%m-%d")
            for h in range(24):
                if d == 0 and h > self.NOW.hour:
                    continue
                w[f"{day}T{h:02d}"] = today_per_hour if d == 0 else past_per_hour
        return w

    def test_passes_in_window_with_headroom(self):
        r = g.preflight_decision(self.usage(1000, 1000), self.usage(100_000, 100_000), self.NOW, 12873, [])
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["writes"]["used_today"], 23000)
        self.assertEqual(r["writes"]["forecast_rest_of_day"], 2000)
        self.assertEqual(r["reads"]["projected"], 2_300_000 + 200_000 + g.LOAD_READS)

    def test_stops_over_either_ceiling_outside_window_or_while_busy(self):
        quiet = self.usage(100, 100)
        self.assertFalse(g.preflight_decision(self.usage(3500, 3500), quiet, self.NOW, 12873, [])["ok"])
        r = g.preflight_decision(quiet, self.usage(190_000, 190_000), self.NOW, 12873, [])
        self.assertFalse(r["checks"]["reads_projected_le_4500000"], r["reads"])  # 4.38M + 0.38M forecast
        spike = self.usage(100_000, 100_000)
        spike[(self.NOW - g.timedelta(days=7)).strftime("%Y-%m-%d") + "T23"] = 2_500_000  # one bad hour last week
        self.assertFalse(g.preflight_decision(quiet, spike, self.NOW, 12873, [])["ok"])
        early = self.NOW.replace(hour=18)
        self.assertFalse(g.preflight_decision(quiet, quiet, early, 12873, [])["ok"])
        self.assertFalse(g.preflight_decision(quiet, quiet, self.NOW, 12873, ["nightly-builders.yml"])["ok"])

    def test_read_ceiling_is_the_conservative_one(self):
        self.assertEqual(g.READ_CEILING, 4_500_000)


class OfflineByDefault(unittest.TestCase):
    def run_script(self, script, *args):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "npx_calls.log"
            fake = Path(d) / "npx"
            fake.write_text(f'#!/bin/sh\necho "$@" >> "{log}"\nexit 97\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            env = {k: v for k, v in os.environ.items() if k != "UPS_ALLOW_PROD_D1_READS"}
            env["PATH"] = d + os.pathsep + env.get("PATH", "")
            env["HOME"] = d
            p = subprocess.run([sys.executable, str(HERE / script), *args], env=env,
                               capture_output=True, text=True, timeout=120)
            calls = log.read_text().splitlines() if log.exists() else []
            return p, calls

    def test_gap01_extract_d1_default_reads_nothing(self):
        p, calls = self.run_script("dryrun_gap01_auction_bids.py", "extract-d1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("SKIPPED", p.stdout)
        self.assertNotIn("PASSED", p.stdout)
        self.assertEqual(calls, [])

    def test_gap01_verify_d1_default_reads_nothing(self):
        p, calls = self.run_script("dryrun_gap01_auction_bids.py", "verify-d1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("SKIPPED", p.stdout)
        self.assertEqual(calls, [])

    def test_gap16_d1_default_reads_nothing(self):
        p, calls = self.run_script("check_gap16_last_league_week.py", "d1")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn("SKIPPED", p.stdout)
        self.assertEqual(calls, [])

    def test_no_write_path_exists(self):
        src = (HERE / "dryrun_gap01_auction_bids.py").read_text()
        self.assertNotIn("--file", src)
        for verb in ("INSERT", "UPDATE", "DELETE", "DROP", "CREATE"):
            self.assertFalse(any(sql.lstrip().upper().startswith(verb) for _, sql in g.D1_READS + g.verify_reads()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
