-- 0107: tag auction lots as test so the hub can hide/delete them and real
-- FAA wins never inherit the old "non-ERA => TEST" heuristic.
-- ⚠️ Apply with `wrangler d1 execute ups-mfl-db --remote --file=...`
--    NEVER `wrangler d1 migrations apply` (tracker ~47 behind).
ALTER TABLE ups_auction_lots ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
