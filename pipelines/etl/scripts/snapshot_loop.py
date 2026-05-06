#!/usr/bin/env python3
"""Run snapshot_mfl_state.py on a cadence (5min auction / 1hr idle).

Run:
  python3 pipelines/etl/scripts/snapshot_loop.py --mode auction
  python3 pipelines/etl/scripts/snapshot_loop.py --mode idle --max-iterations 3

Stops on SIGINT / SIGTERM after the current snapshot finishes.
"""
from __future__ import annotations

import argparse
import signal
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
SNAPSHOT_SCRIPT = SCRIPT_DIR / "snapshot_mfl_state.py"

INTERVAL_SECONDS = {"auction": 300, "idle": 3600}

_stop = False


def _on_signal(signum, _frame):
    global _stop
    _stop = True
    print(f"\nReceived signal {signum}; stopping after current snapshot.")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["auction", "idle"], default="idle")
    ap.add_argument("--league-id")
    ap.add_argument("--server")
    ap.add_argument("--season", type=int)
    ap.add_argument("--output-dir")
    ap.add_argument("--max-iterations", type=int, default=0,
                    help="0 = unlimited; otherwise stop after N snapshots")
    args = ap.parse_args()

    interval = INTERVAL_SECONDS[args.mode]
    print(f"snapshot_loop: mode={args.mode}, interval={interval}s, "
          f"max-iterations={args.max_iterations or 'unlimited'}")

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)

    n = 0
    while not _stop:
        n += 1
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] iteration {n} ...")

        cmd = [sys.executable, str(SNAPSHOT_SCRIPT), "--mode", args.mode]
        for opt in ("league_id", "server", "season", "output_dir"):
            val = getattr(args, opt)
            if val is not None:
                cmd.extend([f"--{opt.replace('_', '-')}", str(val)])

        rc = subprocess.run(cmd, check=False).returncode
        print(f"[{datetime.now().strftime('%H:%M:%S')}] iteration {n} done (rc={rc})")

        if args.max_iterations and n >= args.max_iterations:
            print(f"Reached max-iterations={args.max_iterations}")
            break
        if _stop:
            break

        # Sleep in 1s ticks so signals are responsive.
        slept = 0
        while slept < interval and not _stop:
            time.sleep(1)
            slept += 1

    print(f"snapshot_loop: stopped after {n} iterations")
    return 0


if __name__ == "__main__":
    sys.exit(main())
