-- Commish Auction War Room intel blob (single row). Holds the combined
-- quantitative profiles (auction_intel.json) + the multi-agent scouting
-- narratives. Written by pipelines/etl/scripts/build_auction_intel.py via
-- wrangler; served commish-gated by GET /api/auction/intel.
CREATE TABLE IF NOT EXISTS ups_auction_intel (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT NOT NULL,
  updated_at INTEGER
);
