#!/usr/bin/env python3
"""A default run of test_asof_leakage.py must never touch production D1 (#1239).

test_asof_leakage.py reads the production database, so it only runs with
--allow-prod-d1 or UPS_ALLOW_PROD_D1_READS=1. This test runs it the way a
test_*.py sweep does: no flag, no env var. A stand-in `npx` first on PATH
records any call instead of reaching Cloudflare. The run must make no call,
print SKIPPED (never PASSED), and exit 0.

Usage:
  python3 pipelines/etl/scripts/test_asof_leakage_offline_default.py
"""
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "test_asof_leakage.py"


class OfflineByDefault(unittest.TestCase):
    def run_script(self, *args, env_extra=None):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "npx_calls.log"
            fake = Path(d) / "npx"
            fake.write_text(f'#!/bin/sh\necho "$@" >> "{log}"\nexit 97\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            env = {k: v for k, v in os.environ.items() if k != "UPS_ALLOW_PROD_D1_READS"}
            env["PATH"] = d + os.pathsep + env.get("PATH", "")
            env.update(env_extra or {})
            p = subprocess.run([sys.executable, str(SCRIPT), *args], env=env,
                               capture_output=True, text=True, timeout=120)
            calls = log.read_text().splitlines() if log.exists() else []
            return p, calls

    def test_default_run_makes_no_d1_call(self):
        p, calls = self.run_script()
        self.assertEqual(calls, [], "a default run called npx: " + "; ".join(calls[:3]))
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("SKIPPED", p.stdout)
        self.assertNotIn("PASSED", p.stdout)

    def test_other_env_values_do_not_opt_in(self):
        p, calls = self.run_script(env_extra={"UPS_ALLOW_PROD_D1_READS": "yes"})
        self.assertEqual(calls, [])
        self.assertIn("SKIPPED", p.stdout)

    def test_opt_in_does_reach_d1(self):
        # With the opt-in, the script goes for D1 (here: the stand-in, which fails).
        p, calls = self.run_script("--allow-prod-d1")
        self.assertTrue(calls and "d1 execute" in calls[0] and "--remote" in calls[0], calls[:1])
        self.assertNotEqual(p.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
