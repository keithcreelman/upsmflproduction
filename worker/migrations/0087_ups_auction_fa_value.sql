-- FA value engine: single-row JSON blob served (commish-gated) by
-- GET /api/auction/fa-value. Mirrors ups_auction_intel (0086).
CREATE TABLE IF NOT EXISTS ups_auction_fa_value (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  payload    TEXT NOT NULL,
  updated_at INTEGER
);
