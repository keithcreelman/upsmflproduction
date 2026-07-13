-- Draft Intel: commish-gated Draft Intel blob. Served by GET /api/auction/draft-intel.
-- The blob can exceed D1's 100KB single-statement cap, so it's stored PART-KEYED:
-- build_draft_intel.py --push-d1 writes the lean JSON string in <90KB chunks (part 0..n); the worker
-- concatenates payload ORDER BY part and JSON.parse()s the result.
CREATE TABLE IF NOT EXISTS ups_draft_intel (
  part       INTEGER PRIMARY KEY,
  payload    TEXT NOT NULL,
  updated_at INTEGER
);
