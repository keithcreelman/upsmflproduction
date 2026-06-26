-- FAA Report: commish-gated FA-auction outcomes (2020+). Served by GET /api/auction/faa-report.
-- The columnar blob (~184KB) exceeds D1's 100KB single-statement cap, so it's stored PART-KEYED:
-- build_faa_report.py --push-d1 writes the lean JSON string in <90KB chunks (part 0..n); the worker
-- concatenates payload ORDER BY part and JSON.parse()s the result.
CREATE TABLE IF NOT EXISTS ups_faa_report (
  part       INTEGER PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER
);
