#!/usr/bin/env python3
"""Assert a D1 COUNT(*) equals an expected value, else fail the job.

D1 rejects CREATE TEMP TABLE (SQLITE_AUTH), so the temp-table + CHECK trick that
works on stock sqlite3 cannot run there — learned 2026-08-08 when the cap-year
ledger step aborted with SQLITE_AUTH. The assertion therefore lives here, where
it can also print a message worth reading.

Usage: ci_assert_d1_count.py <wrangler-json> <expected-int> <message>
"""
import json
import sys

path = sys.argv[1]
expected = int(sys.argv[2])
message = sys.argv[3] if len(sys.argv) > 3 else "assertion failed"

try:
    with open(path, encoding="utf-8") as fh:
        payload = json.load(fh)
except Exception as exc:  # noqa: BLE001
    print(f"::error::{message} — could not read the query result: {exc}")
    sys.exit(1)

# wrangler --json emits a list of result envelopes.
blocks = payload if isinstance(payload, list) else [payload]
rows = []
for block in blocks:
    if isinstance(block, dict):
        rows.extend(block.get("results") or [])

if not rows:
    # No rows is NOT count 0 — the query itself failed to answer.
    print(f"::error::{message} — query returned no result rows (unreadable, not empty)")
    sys.exit(1)

actual = rows[0].get("n")
if actual is None:
    print(f"::error::{message} — result had no 'n' column: {rows[0]}")
    sys.exit(1)

if int(actual) != expected:
    print(f"::error::{message} — expected {expected}, got {actual}")
    sys.exit(1)

print(f"  OK — {expected} row(s), as expected")
