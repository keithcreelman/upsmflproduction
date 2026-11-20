#!/usr/bin/env python3
"""Offline tests: rebuild_franchise_career_stats.py fails closed (#1329 follow-up).

On 2026-10-13 the weekly owner-career-stats run read an ownership feed with 0
(season, franchise) cells, gave all twelve owners a career of zero, wrote that
to D1 ups_owner_career_stats and exited 0. These tests drive the script's real
main() against an in-memory SQLite stand-in for D1: the real migration schemas
for the tables it writes, and rows copied from a read-only 2026-10-17 snapshot
of production (tests/fixtures/owner_career_stats_2026_10_17.json) for the
tables it reads. Nothing here reaches D1, MFL or the worker: the D1 helpers,
the /api/standings fetch and the MFL ownership fetch are replaced, and the
script's subprocess module is swapped for one that fails the test if called.

  (a) the 10-13 shape (0 ownership cells) exits non-zero and writes nothing
  (b) a partial feed (one completed season missing) exits non-zero, writes nothing
  (c) a run that would lower a stored owner's titles exits non-zero, writes nothing
  (d) "Rico Balderelli" no longer matches "AJ & Rico Balderelli"
  (e) a full run on the snapshot reproduces the 2026-10-06 run (Actions 37514293542)

Usage:
  python3 pipelines/etl/scripts/test_rebuild_franchise_career_stats.py
"""
import contextlib
import copy
import importlib.util
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SCRIPT = HERE / "rebuild_franchise_career_stats.py"
FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "owner_career_stats_2026_10_17.json").read_text())
WORKFLOW = ROOT / ".github" / "workflows" / "owner-career-stats.yml"
MIGRATIONS = ["0027_discord_owners.sql", "0058_ups_owner_career_stats.sql", "0148_owner_career_stats_titles.sql"]
STORED_UPDATED_AT = "2026-10-13 19:48:07"


class _NoSubprocess:
    """Stands in for the script's subprocess module: any call is a test failure."""

    def run(self, *a, **k):
        raise AssertionError(f"the rebuild tried to run a process: {a[:1]}")


class FakeD1:
    """In-memory SQLite in place of production D1."""

    def __init__(self, fx):
        self.db = sqlite3.connect(":memory:")
        self.db.row_factory = sqlite3.Row
        for m in MIGRATIONS:
            self.db.executescript((ROOT / "worker" / "migrations" / m).read_text())
        self.db.executescript("""
            CREATE TABLE src_franchises (season INTEGER, franchise_id TEXT, owner_name TEXT,
                                         PRIMARY KEY (season, franchise_id));
            CREATE TABLE src_standings (season INTEGER, franchise_id TEXT, owner_name TEXT,
                                        h2h_w INTEGER, h2h_l INTEGER, h2h_t INTEGER,
                                        allplay_historical_w INTEGER, allplay_historical_l INTEGER, pf REAL,
                                        PRIMARY KEY (season, franchise_id));
            CREATE TABLE src_final_standings (season INTEGER, franchise_id TEXT, final_finish INTEGER,
                                              regular_season_finish INTEGER, PRIMARY KEY (season, franchise_id));
            CREATE TABLE src_weekly_franchise_summary (season INTEGER, week INTEGER, franchise_id TEXT,
                owner_name TEXT, h2h_wins INTEGER, h2h_losses INTEGER, h2h_ties INTEGER, h2h_games INTEGER,
                allplay_wins INTEGER, allplay_losses INTEGER, h2h_team_score REAL);
        """)
        for table in ("src_franchises", "src_standings", "src_final_standings"):
            cols = fx[table + "_cols"]
            self.db.executemany(f"INSERT INTO {table} ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                                fx[table])
        for i, (fid, team, owner) in enumerate(fx["discord_owners"]):
            self.db.execute("INSERT INTO discord_owners (discord_user_id, franchise_id, team_name, owner_name, "
                            "active_owner) VALUES (?, ?, ?, ?, 'Y')", (f"fixture-{i:02d}", fid, team, owner))
        for r in fx["ups_owner_career_stats_2026_10_17"]:
            cols = list(r)
            self.db.execute(f"INSERT INTO ups_owner_career_stats ({', '.join(cols)}) "
                            f"VALUES ({', '.join('?' * len(cols))})", [r[c] for c in cols])
        self.db.commit()
        self.queries, self.writes = [], []

    def __del__(self):
        self.db.close()

    def query(self, sql):
        assert sql.lstrip().upper().startswith("SELECT"), sql
        self.queries.append(sql)
        return [dict(r) for r in self.db.execute(sql)]

    def execute_file(self, sql_text):
        self.writes.append(sql_text)
        self.db.executescript(sql_text)

    def career(self):
        return {r["franchise_id"]: dict(r) for r in self.db.execute("SELECT * FROM ups_owner_career_stats")}


def load_script():
    spec = importlib.util.spec_from_file_location("rebuild_franchise_career_stats_under_test", SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Run:
    def __init__(self, code, out, err, d1, json_written, writes_before):
        self.code, self.out, self.err, self.d1 = code, out, err, d1
        self.json_written = json_written
        self.new_writes = d1.writes[writes_before:]


def run(fx=None, argv=(), d1=None, mfl=None, patch=None):
    """main() on a fake D1. mfl = what the MFL ownership feed returns (None: unreachable)."""
    fx = fx if fx is not None else copy.deepcopy(FIXTURE)
    d1 = d1 or FakeD1(fx)
    rb = load_script()
    rb.subprocess = _NoSubprocess()
    rb.d1_query = d1.query
    rb.d1_execute_file = d1.execute_file
    statuses = fx["playoff_status"]
    rb.fetch_standings_rows = lambda season: [
        {"franchise_id": f, "playoff_status": st, "division": dv}
        for f, (st, dv) in statuses[str(season)].items()]

    def _mfl():
        if mfl is None:
            raise OSError("offline test: MFL feed unreachable")
        return mfl
    rb.fetch_mfl_ownership = _mfl
    if patch:
        patch(rb)
    writes_before = len(d1.writes)
    with tempfile.TemporaryDirectory() as tmp:
        rb.OUT_PATH = Path(tmp) / "franchise_career_stats.json"
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = rb.main(list(argv)) or 0
            except SystemExit as e:
                code = e.code
        return Run(code, out.getvalue(), err.getvalue(), d1, rb.OUT_PATH.exists(), writes_before)


def drop_rows(fx, table, pred):
    fx[table] = [r for r in fx[table] if not pred(r)]


class FailsClosed(unittest.TestCase):
    def assertRefusedNoWrite(self, r, *needles):
        self.assertNotEqual(r.code, 0, r.out + r.err)
        self.assertEqual(r.new_writes, [], "a refused run wrote to D1")
        self.assertFalse(r.json_written, "a refused run wrote franchise_career_stats.json")
        self.assertIn("Nothing was written", r.err)
        for n in needles:
            self.assertIn(n, r.err)
        stored = r.d1.career()
        self.assertEqual({row["updated_at"] for row in stored.values()}, {STORED_UPDATED_AT})

    # (a) -------------------------------------------------------------------
    def test_a_zero_ownership_cells_exits_nonzero_and_writes_nothing(self):
        fx = copy.deepcopy(FIXTURE)
        fx["src_franchises"] = []
        r = run(fx, mfl={})                      # the 10-13 feed: ok, but no owner names
        self.assertRefusedNoWrite(r, "completed season 2010 is missing", "0 named (season, franchise) cell(s)")

    def test_a_blank_owner_names_exit_nonzero(self):
        fx = copy.deepcopy(FIXTURE)
        fx["src_franchises"] = [[s, f, ""] for s, f, _ in fx["src_franchises"]]
        r = run(fx)
        self.assertRefusedNoWrite(r, "blank owner")

    def test_a_empty_mfl_feed_only_warns_and_the_run_uses_src_franchises(self):
        r = run(mfl={})                          # exactly the 10-13 MFL condition, src_franchises intact
        self.assertEqual(r.code, 0, r.out + r.err)
        self.assertIn("::warning::MFL ownership cross-check: 192 of 192 cell(s) have no MFL owner", r.out)
        self.assertEqual(r.d1.career()["0008"]["owner_seasons_count"], 16)

    def test_a_mfl_feed_end_of_season_owners_warn_but_never_change_the_result(self):
        own = {}
        for s, f, o in FIXTURE["src_franchises"]:
            own.setdefault(int(s), {})[f] = o
        own[2024]["0006"] = "Brian Cross"         # MFL's end-of-season owner for Lima's 2024
        r = run(mfl=own)
        self.assertEqual(r.code, 0, r.out + r.err)
        self.assertIn("1 cell(s) differ", r.out)
        self.assertEqual(r.d1.career()["0006"]["owner_seasons_count"], 1)   # Cross: 2025 only

    def test_a_all_zero_result_is_refused_even_with_allow_decrease(self):
        def zero_owner_blocks(rb):
            real = rb.build_stats

            def build_stats(*a, **k):
                stats = real(*a, **k)
                for e in stats.values():
                    e["owner"].update(seasons_count=0, championships=0, allplay={"w": 0, "l": 0})
                return stats
            rb.build_stats = build_stats
        r = run(argv=["--allow-decrease"], patch=zero_owner_blocks)
        self.assertRefusedNoWrite(r, "every one of the 12 new rows has 0 seasons")

    # (b) -------------------------------------------------------------------
    def test_b_one_completed_season_missing_exits_nonzero_and_writes_nothing(self):
        fx = copy.deepcopy(FIXTURE)
        drop_rows(fx, "src_franchises", lambda r: r[0] == 2015)
        r = run(fx)
        self.assertRefusedNoWrite(r, "completed season 2015 is missing", "180 named (season, franchise) cell(s)")

    def test_b_a_season_short_one_franchise_exits_nonzero(self):
        fx = copy.deepcopy(FIXTURE)
        drop_rows(fx, "src_franchises", lambda r: r[0] == 2019 and r[1] == "0005")
        r = run(fx)
        self.assertRefusedNoWrite(r, "2019 has 11 franchise(s), expected 12")

    def test_b_missing_final_standings_season_exits_nonzero(self):
        fx = copy.deepcopy(FIXTURE)
        drop_rows(fx, "src_final_standings", lambda r: r[0] == 2013)
        r = run(fx)
        self.assertRefusedNoWrite(r, "no final standings for season(s) [2013]")

    def test_b_current_owner_must_equal_src_franchises_exactly(self):
        fx = copy.deepcopy(FIXTURE)
        fx["discord_owners"] = [[f, t, "Shawn B." if f == "0010" else o] for f, t, o in fx["discord_owners"]]
        r = run(fx)
        self.assertRefusedNoWrite(r, "current owner of 0010: src_franchises 2026 says 'Shawn Blake'")

    # (c) -------------------------------------------------------------------
    def test_c_lowering_a_stored_title_count_exits_nonzero_and_writes_nothing(self):
        good = run()                              # stored rows now hold the real careers
        self.assertEqual(good.code, 0, good.out + good.err)
        before = good.d1.career()
        self.assertEqual(before["0005"]["owner_championships"], 1)
        good.d1.db.execute(                       # 2024 final: swap champion and runner-up
            "UPDATE src_final_standings SET final_finish = CASE franchise_id WHEN '0005' THEN 2 ELSE 1 END "
            "WHERE season = 2024 AND franchise_id IN ('0005', '0002')")
        bad = run(d1=good.d1)
        self.assertNotEqual(bad.code, 0, bad.out + bad.err)
        self.assertEqual(bad.new_writes, [])
        self.assertFalse(bad.json_written)
        self.assertIn("0005 Eric Martel: titles would drop 1 -> 0", bad.err)
        self.assertIn("--allow-decrease", bad.err)
        self.assertEqual(bad.d1.career(), before)
        forced = run(d1=good.d1, argv=["--allow-decrease"])
        self.assertEqual(forced.code, 0, forced.out + forced.err)
        self.assertEqual(len(forced.new_writes), 1)
        self.assertEqual(forced.d1.career()["0005"]["owner_championships"], 0)

    def test_c_losing_a_season_vs_stored_exits_nonzero(self):
        good = run()
        good.d1.db.execute(                       # 2010 0007 credited to someone else
            "UPDATE src_franchises SET owner_name = 'Somebody Else' WHERE season = 2010 AND franchise_id = '0007'")
        bad = run(d1=good.d1)
        self.assertNotEqual(bad.code, 0)
        self.assertEqual(bad.new_writes, [])
        self.assertIn("0008 Keith Creelman: seasons would drop 16 -> 15", bad.err)
        self.assertIn("0008 Keith Creelman: all-play games would drop 2634 -> 2491", bad.err)

    def test_c_the_workflow_never_passes_allow_decrease(self):
        code = "\n".join(ln for ln in WORKFLOW.read_text().splitlines() if not ln.lstrip().startswith("#"))
        self.assertIn("rebuild_franchise_career_stats.py", code)
        self.assertNotIn("allow-decrease", code)
        self.assertNotIn("allow_decrease", code.lower())

    # (d) -------------------------------------------------------------------
    def test_d_owner_names_match_exactly_not_by_substring(self):
        rb = load_script()
        self.assertFalse(rb._owners_match("Rico Balderelli", "AJ & Rico Balderelli"))
        self.assertFalse(rb._owners_match("AJ Balderelli", "AJ & Rico Balderelli"))
        self.assertFalse(rb._owners_match("Steve B.", "Steve Bousquet"))
        self.assertFalse(rb._owners_match("Keith Creelman", "Kyle Creelman"))
        self.assertFalse(rb._owners_match("", ""))
        self.assertTrue(rb._owners_match("  keith   creelman ", "Keith Creelman"))

    def test_d_a_co_owner_string_does_not_credit_one_of_the_owners(self):
        # Suppose Rico were a current owner and the 2018 0002 owner string were MFL's
        # "AJ & Rico Balderelli". The old substring rule credited Rico with 2018 on 0002.
        fx = copy.deepcopy(FIXTURE)
        for r in fx["src_franchises"]:
            if r[0] == 2018 and r[1] == "0002":
                r[2] = "AJ & Rico Balderelli"
            if r[0] == 2026 and r[1] == "0005":
                r[2] = "Rico Balderelli"
        fx["discord_owners"] = [[f, t, "Rico Balderelli" if f == "0005" else o] for f, t, o in fx["discord_owners"]]
        r = run(fx)
        self.assertEqual(r.code, 0, r.out + r.err)
        row = r.d1.career()["0005"]
        self.assertEqual(json.loads(row["owner_seasons_by_franchise"]), {"0005": [2019, 2020, 2021, 2022]})
        self.assertEqual((row["owner_allplay_w"], row["owner_allplay_l"]), (304, 419))

    def test_d_duplicate_active_discord_rows_resolve_the_same_way_in_any_order(self):
        for extra_first in (True, False):
            fx = copy.deepcopy(FIXTURE)
            extra = ["0010", "Blake Bombers", "Keith Creelman"]
            fx["discord_owners"] = ([extra] + fx["discord_owners"]) if extra_first else (fx["discord_owners"] + [extra])
            r = run(fx)
            self.assertEqual(r.code, 0, r.out + r.err)
            self.assertEqual(r.d1.career()["0010"]["owner_display"], "Shawn Blake")
            self.assertIn("discord_owners has 2 active rows for 0010", r.out)

    # (e) -------------------------------------------------------------------
    def test_e_full_run_reproduces_the_2026_10_06_run(self):
        r = run()
        self.assertEqual(r.code, 0, r.out + r.err)
        self.assertEqual(len(r.new_writes), 1)
        self.assertTrue(r.json_written)
        self.assertIn("src_franchises ownership: 17 season(s), 204 named (season, fid) cells", r.out)
        rows = r.d1.career()
        self.assertEqual(len(rows), 12)
        self.assertNotIn(STORED_UPDATED_AT, {row["updated_at"] for row in rows.values()})
        for fid, exp in FIXTURE["expected_2026_10_06_run"].items():
            if fid.startswith("_"):
                continue
            row = rows[fid]
            with self.subTest(fid=fid, owner=exp["owner"]):
                self.assertEqual(row["owner_display"], exp["owner"])
                self.assertEqual(row["owner_first_season"], exp["first_season"])
                self.assertEqual(row["owner_seasons_count"], exp["seasons"])
                self.assertEqual(json.loads(row["owner_franchises_owned"]), exp["franchises"])
                self.assertEqual([row["owner_allplay_w"], row["owner_allplay_l"]], exp["allplay"])
                self.assertEqual(json.loads(row["owner_title_years"]), exp["titles"])
                self.assertEqual(row["owner_championships"], len(exp["titles"]))
                self.assertEqual(row["owner_runner_ups"], exp["runner_ups"])
                self.assertEqual(row["owner_allplay_titles"], exp["allplay_titles"])
                self.assertEqual(row["owner_division_titles"], exp["division_titles"])
                self.assertEqual(row["owner_playoff_appearances"], exp["playoffs"])
        keith = rows["0008"]
        self.assertEqual(json.loads(keith["owner_seasons_by_franchise"]),
                         {"0007": [2010], "0008": list(range(2011, 2026))})
        self.assertIsNone(keith["owner_last_championship"])       # Roussin's 2010 title is not Keith's
        self.assertEqual(keith["franchise_last_championship"], 2010)  # franchise fields unchanged

    def test_e_other_owners_match_the_independent_src_franchises_join(self):
        # docs: identity audit 2026-10-17 §1b, computed by SQL over the same snapshot.
        expect = {  # fid: (owner, seasons, AP W-L, H2H W-L, title years)
            "0001": ("Ryan Bousquet", 16, (1444, 1188), (265, 197), [2014, 2021]),
            "0002": ("Derrick Whitman", 9, (856, 584), (152, 115), [2013]),
            "0003": ("Matt Gerardi", 9, (681, 944), (120, 169), [2022]),
            "0004": ("Brian Cutting", 16, (1356, 1278), (243, 219), [2025]),
            "0009": ("Bear Dunn", 15, (1413, 1078), (262, 183), [2016]),
            "0010": ("Shawn Blake", 15, (1328, 1163), (248, 197), [2011, 2015, 2023]),
            "0011": ("Eric Mannila", 16, (1043, 1592), (193, 270), []),
            "0012": ("Chris Klingenberg", 15, (911, 1560), (172, 273), []),
        }
        rows = run().d1.career()
        for fid, (owner, seasons, ap, h2h, titles) in expect.items():
            row = rows[fid]
            with self.subTest(fid=fid, owner=owner):
                self.assertEqual(row["owner_display"], owner)
                self.assertEqual(row["owner_seasons_count"], seasons)
                self.assertEqual((row["owner_allplay_w"], row["owner_allplay_l"]), ap)
                self.assertEqual((row["owner_overall_w"], row["owner_overall_l"]), h2h)
                self.assertEqual(json.loads(row["owner_title_years"]), titles)

    def test_e_dry_run_checks_everything_and_writes_nothing(self):
        r = run(argv=["--dry-run"])
        self.assertEqual(r.code, 0, r.out + r.err)
        self.assertEqual(r.new_writes, [])
        self.assertFalse(r.json_written)
        self.assertIn("DRY RUN", r.out)

    def test_every_d1_call_is_a_read_except_the_one_upsert(self):
        r = run()
        self.assertTrue(all(q.lstrip().upper().startswith("SELECT") for q in r.d1.queries))
        self.assertEqual(len(r.new_writes), 1)
        stmts = [s for s in r.new_writes[0].split("\n") if s.strip()]
        self.assertEqual(len(stmts), 12)
        self.assertTrue(all(s.startswith("INSERT INTO ups_owner_career_stats") for s in stmts))


if __name__ == "__main__":
    unittest.main(verbosity=2)
