#!/usr/bin/env python3
"""scripts/build_sleeper_cache.py: id + bio matching and changed-row-only writes (#1356).

1. Matching. Every case below is a real 2026-10-21 record where one fact alone
   picks the wrong player:
     - Sleeper's retired rows carry stale RotoWire ids now used by active
       players (Amar/Jamar Johnson, Ke'Shawn/Shawn Williams, Tyler Davis DT vs
       a retired kicker Sleeper also lists as "DL");
     - MFL lists Ryan Izzo's ESPN id on Tyler Conklin;
     - birthdates disagree by days (Ladd McConkey 11-01 vs 11-11);
     - names differ (D.J. Moore / DJ Moore, Kamren / Kam Curl), positions
       change (Connor Heyward TE / RB), rookies have no ids in Sleeper (Nyjalik
       Kelly), and Sleeper keeps a "Duplicate Player" row with John
       Franklin-Myers's ids.
2. Writes. Re-running on unchanged data writes 0 rows; one changed player
   writes 1; a player who stops matching is deleted; built_at_utc only moves
   on a real change.
3. Safety. A default or offline run never calls npx/wrangler; --apply refuses
   recorded inputs; a collapse to <500 matches refuses to write.
Each matching and write rule is also checked against a MUTANT copy of the
script with that rule reverted: the check must fail there.

Usage:
  python3 pipelines/etl/scripts/test_build_sleeper_cache.py
"""
import json
import os
import sqlite3
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "scripts" / "build_sleeper_cache.py"
SCHEMA = (ROOT / "worker" / "migrations" / "0141_sleeper_player_cache.sql").read_text()
sys.path.insert(0, str(ROOT / "pipelines" / "etl"))
SOURCE = SCRIPT.read_text()


def load(src=SOURCE):
    mod = types.ModuleType("bsc")
    mod.__file__ = str(SCRIPT)
    exec(compile(src, str(SCRIPT), "exec"), mod.__dict__)
    return mod


B = load()


def mutant(find, replace):
    assert SOURCE.count(find) == 1, f"mutation anchor found {SOURCE.count(find)} times: {find[:60]}"
    return load(SOURCE.replace(find, replace))


# MFL DETAILS rows and Sleeper rows exactly as recorded 2026-10-21 (only the fields
# the resolver reads). Sleeper rows = every row sharing a RotoWire id, ESPN id or
# full name + team with one of these players: the right one and each trap.
MFL = [
    {"id": "17272", "name": "Johnson, Amar", "team": "LAC", "position": "RB", "rotowire_id": "18949", "espn_id": "4878878", "birthdate": "1043989200"},
    {"id": "17396", "name": "Williams, Ke'Shawn", "team": "CIN", "position": "WR", "rotowire_id": "18841", "espn_id": "4570738", "birthdate": "1009429200"},
    {"id": "16767", "name": "Davis, Tyler", "team": "LAR", "position": "DT", "rotowire_id": "17799", "espn_id": "4568217", "birthdate": "973054800"},
    {"id": "13675", "name": "Conklin, Tyler", "team": "DET", "position": "TE", "rotowire_id": "12809", "espn_id": "3915486", "birthdate": "807080400"},
    {"id": "16627", "name": "McConkey, Ladd", "team": "LAC", "position": "WR", "rotowire_id": "17724", "espn_id": "4612826", "birthdate": "1004590800"},
    {"id": "13635", "name": "Moore, D.J.", "team": "BUF", "position": "WR", "rotowire_id": "12477", "espn_id": "3915416", "birthdate": "860994000"},
    {"id": "15001", "name": "Curl, Kamren", "team": "LAR", "position": "S", "rotowire_id": "14381", "espn_id": "4242154", "birthdate": "922856400"},
    {"id": "15800", "name": "Heyward, Connor", "team": "LVR", "position": "TE", "rotowire_id": "15916", "espn_id": "4241961", "birthdate": "916981200"},
    {"id": "17727", "name": "Kelly, Nyjalik", "team": "GBP", "position": "DE", "rotowire_id": "19519", "espn_id": "4726151", "birthdate": "618123600"},
    {"id": "14783", "name": "Hurts, Jalen", "team": "PHI", "position": "QB", "rotowire_id": "14416", "espn_id": "4040715", "birthdate": "902466000"},
    {"id": "13770", "name": "Franklin-Myers, John", "team": "TEN", "position": "DT", "rotowire_id": "12972", "espn_id": "3120464", "birthdate": "843714000"},
]
SLEEPER = {
    "1395": {"full_name": "Shawn Williams", "position": "DB", "fantasy_positions": ["DB"], "rotowire_id": 18841, "espn_id": 15877, "birth_date": "1991-05-13", "news_updated": 1790811630664},
    "4983": {"full_name": "DJ Moore", "team": "BUF", "position": "WR", "fantasy_positions": ["WR"], "rotowire_id": 12477, "espn_id": 3915416, "birth_date": "1997-04-14", "injury_status": "Out", "injury_body_part": "Shoulder - AC Joint", "news_updated": 1792350657538},
    "5094": {"full_name": "Ryan Izzo", "position": "TE", "fantasy_positions": ["TE"], "rotowire_id": 12529, "espn_id": 3915486, "birth_date": "1995-12-21", "news_updated": 1660769154687},
    "5133": {"full_name": "Tyler Conklin", "team": "DET", "position": "TE", "fantasy_positions": ["TE"], "rotowire_id": 12809, "espn_id": 3122920, "birth_date": "1995-07-30", "news_updated": 1790525453291},
    "5251": {"full_name": "Tyler Davis", "position": "K", "fantasy_positions": ["DL"], "rotowire_id": 17799, "espn_id": 3791111, "birth_date": "1994-09-29", "news_updated": 1789176316626},
    "5308": {"full_name": "Duplicate Player", "team": "LAR", "position": "DE", "fantasy_positions": ["DL"], "rotowire_id": 12972, "espn_id": 3120464, "birth_date": "1996-09-26", "injury_status": "Out"},
    "5466": {"full_name": "John Franklin-Myers", "team": "TEN", "position": "DT", "fantasy_positions": ["DL", "LB"], "rotowire_id": 12972, "espn_id": 3120464, "birth_date": "1996-09-26", "news_updated": 1791516649754},
    "6904": {"full_name": "Jalen Hurts", "team": "PHI", "position": "QB", "fantasy_positions": ["QB"], "rotowire_id": 14416, "espn_id": 4040715, "birth_date": "1998-08-07", "injury_status": "IR", "injury_body_part": "Calf", "news_updated": 1792542046812},
    "7136": {"full_name": "Kam Curl", "team": "LAR", "position": "DB", "fantasy_positions": ["DB"], "rotowire_id": 14381, "espn_id": 4242154, "birth_date": "1999-03-31", "news_updated": 1792551948589},
    "7826": {"full_name": "Jamar Johnson", "position": "DB", "fantasy_positions": ["DB"], "rotowire_id": 18949, "birth_date": "1999-11-22", "news_updated": 1788316825503},
    "8181": {"full_name": "Connor Heyward", "team": "LV", "position": "RB", "fantasy_positions": ["RB"], "rotowire_id": 15916, "birth_date": "1999-01-22", "news_updated": 1780611637341},
    "11635": {"full_name": "Ladd McConkey", "team": "LAC", "position": "WR", "fantasy_positions": ["WR"], "rotowire_id": 17724, "birth_date": "2001-11-11", "injury_status": "Out", "injury_body_part": "Concussion", "news_updated": 1792359060261},
    "11799": {"full_name": "Tyler Davis", "team": "LAR", "position": "DT", "fantasy_positions": ["DL"], "birth_date": "2000-11-01", "news_updated": 1733954434620},
    "12928": {"full_name": "Amar Johnson", "team": "LAC", "position": "RB", "fantasy_positions": ["RB"], "birth_date": "2003-01-31", "news_updated": 1752949810943},
    "12971": {"full_name": "Ke'Shawn Williams", "team": "CIN", "position": "WR", "fantasy_positions": ["WR"], "birth_date": "2001-12-27", "news_updated": 1790699104642},
    "13771": {"full_name": "Nyjalik Kelly", "team": "GB", "position": "DE", "fantasy_positions": ["DL"], "birth_date": "2004-10-29", "news_updated": 1777464032685},
}
WANT = {
    "17272": ("12928", "name_team"),   # Johnson, Amar
    "17396": ("12971", "name_team"),   # Williams, Ke'Shawn
    "16767": ("11799", "name_team"),   # Davis, Tyler
    "13675": ("5133", "rotowire_id"),   # Conklin, Tyler
    "16627": ("11635", "rotowire_id"),   # McConkey, Ladd
    "13635": ("4983", "rotowire_id"),   # Moore, D.J.
    "15001": ("7136", "rotowire_id"),   # Curl, Kamren
    "15800": ("8181", "rotowire_id"),   # Heyward, Connor
    "17727": ("13771", "name_team"),   # Kelly, Nyjalik
    "14783": ("6904", "rotowire_id"),   # Hurts, Jalen
    "13770": ("5466", "rotowire_id"),   # Franklin-Myers, John
}


def check_matching(mod):
    rows, _ = mod.resolve(MFL, SLEEPER, now="T")
    got = {r[0]: (r[1], r[12]) for r in rows}
    for pid, want in WANT.items():
        assert got.get(pid) == want, f"{pid}: got {got.get(pid)}, want {want}"


def rows_for(mod, sleeper):
    return mod.resolve(MFL, sleeper, now="2026-10-21T12:00:00Z")[0]


def db_with(rows):
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    cols = ", ".join(B.COLS)
    db.executemany(f"INSERT INTO sleeper_player_cache ({cols}) VALUES ({', '.join('?' * len(B.COLS))})", rows)
    db.commit()
    return db


def apply(db, sql):
    before = db.total_changes
    db.executescript(sql)
    return db.total_changes - before


def check_writes(mod):
    today = rows_for(mod, SLEEPER)
    db = db_with(today)
    assert apply(db, mod.build_sql(today)) == 0, "a rerun on unchanged data must write nothing"
    s2 = json.loads(json.dumps(SLEEPER))
    s2["6904"]["injury_status"] = "Out"
    changed = [r[:13] + ("2026-10-22T12:00:00Z",) for r in rows_for(mod, s2)]
    assert apply(db, mod.build_sql(changed)) == 1, "one changed player = one row written"
    stamp = dict(db.execute("SELECT mfl_player_id, built_at_utc FROM sleeper_player_cache"))
    assert stamp["14783"] == "2026-10-22T12:00:00Z" and stamp["13635"] == "2026-10-21T12:00:00Z", "built_at_utc moves only on change"
    gone = [r for r in changed if r[0] != "15001"]
    assert apply(db, mod.build_sql(gone)) == 1, "a player who no longer matches is deleted"
    assert db.execute("SELECT COUNT(*) FROM sleeper_player_cache").fetchone()[0] == len(gone)


def without(*sids):
    return {k: v for k, v in SLEEPER.items() if k not in sids}


def check_missing_right_row(mod):
    """When Sleeper has no row for the real player yet (a new rookie), the trap
    must stay unattached, not win by default. Real records, right row removed."""
    for pid, gone in (("16767", "11799"), ("13770", "5466")):
        rows, _ = mod.resolve(MFL, without(gone), now="T")
        got = {r[0]: r[1] for r in rows}
        assert pid not in got, f"{pid}: attached to {got.get(pid)} with its real Sleeper row missing"


# A retired RB holding an active RB's stale RotoWire id: same position, no team,
# no ESPN id, different name and birthdate. SYNTHETIC (built on Amar Johnson's
# MFL record); today's real stale-id rows all also contradict on position or id.
STALE_SAME_POS = {"7000": {"full_name": "Retired Back", "position": "RB", "fantasy_positions": ["RB"], "rotowire_id": 18949, "birth_date": "1990-01-01"}}


def check_single_fact(mod):
    rows, _ = mod.resolve([m for m in MFL if m["id"] == "17272"], STALE_SAME_POS, now="T")
    assert not rows, "one shared id, nothing else agreeing, must not attach"


class Matching(unittest.TestCase):
    def test_recorded_cases(self):
        check_matching(B)

    def test_missing_right_row_and_single_fact(self):
        check_missing_right_row(B)
        check_single_fact(B)

    def test_mutants_are_caught(self):
        # On 2026-10-21 data each contradiction rule alone changes no outcome
        # (the right row outscores the trap); together they stop a trap when
        # the right row is missing. Measured: the >= 2 threshold costs one real
        # match (John Parker Romo, FA kicker: only his RotoWire id agrees).
        for label, pairs, check in [
            ("name + team rows are not candidates", [("        for sid, p in by_name_team.get(f\"{norm_name(_mfl_full_name(m))}|{norm_team(m.get('team'))}\", []):\n            cands[sid] = p\n", "")], check_matching),
            ("no contradictions (position, differing ids)", [
                ("    n = -1 if (mpos in POS_COMPAT and spos and not (POS_COMPAT[mpos] & spos)) else 0", "    n = 0"),
                ("    n += 1 if (mrw and mrw == prw) else (-1 if (mrw and prw) else 0)", "    n += 1 if (mrw and mrw == prw) else 0"),
                ("    n += 1 if (mes and mes == pes) else (-1 if (mes and pes) else 0)", "    n += 1 if (mes and mes == pes) else 0")], check_missing_right_row),
            ("Duplicate Player rows count", [("    if (p.get(\"full_name\") or \"\") == \"Duplicate Player\":\n        return -1\n", "")], check_missing_right_row),
            ("one agreeing fact is enough", [("        if scored and scored[0][0] >= 2:", "        if scored and scored[0][0] >= 1:")], check_single_fact),
        ]:
            with self.subTest(label):
                src = SOURCE
                for find, replace in pairs:
                    self.assertEqual(src.count(find), 1, f"mutation anchor: {find[:60]}")
                    src = src.replace(find, replace)
                with self.assertRaises(AssertionError, msg=f"{label}: the reverted rule must fail the check"):
                    check(load(src))


class Writes(unittest.TestCase):
    def test_changed_rows_only(self):
        check_writes(B)

    def test_mutant_always_update_is_caught(self):
        m = mutant("changed_only=True, change_ignore_cols=[\"built_at_utc\"])", "changed_only=False)")
        with self.assertRaises(AssertionError):
            check_writes(m)

    def test_mutant_delete_everything_is_caught(self):
        m = mutant("    stmts = []\n    for i in range(0, len(rows), CHUNK):", "    stmts = [f\"DELETE FROM {TABLE};\\n\"]\n    for i in range(0, len(rows), CHUNK):")
        with self.assertRaises(AssertionError):
            check_writes(m)


class Safety(unittest.TestCase):
    def run_script(self, *args):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "npx_calls.log"
            fake = Path(d) / "npx"
            fake.write_text(f'#!/bin/sh\necho "$@" >> "{log}"\nexit 97\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            mfl, sl, sql = Path(d) / "mfl.json", Path(d) / "sl.json", Path(d) / "out.sql"
            mfl.write_text(json.dumps({"players": {"player": MFL}}))
            sl.write_text(json.dumps(SLEEPER))
            argv = [a.replace("{mfl}", str(mfl)).replace("{sl}", str(sl)).replace("{sql}", str(sql)) for a in args]
            env = dict(os.environ, PATH=d + os.pathsep + os.environ.get("PATH", ""))
            p = subprocess.run([sys.executable, str(SCRIPT), *argv], env=env, capture_output=True, text=True, timeout=120)
            return p, (log.read_text().splitlines() if log.exists() else [])

    def test_small_input_refuses_and_calls_nothing(self):
        p, calls = self.run_script("--dry-run", "--mfl", "{mfl}", "--sleeper", "{sl}", "--sql-out", "{sql}")
        self.assertEqual(calls, [])
        self.assertEqual(p.returncode, 2, p.stdout + p.stderr)
        self.assertIn("REFUSE", p.stdout)

    def test_apply_refuses_recorded_inputs(self):
        p, calls = self.run_script("--apply", "--mfl", "{mfl}", "--sleeper", "{sl}")
        self.assertEqual(calls, [])
        self.assertEqual(p.returncode, 2)
        self.assertIn("never recorded files", p.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
