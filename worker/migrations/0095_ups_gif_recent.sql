-- 0095_ups_gif_recent
--
-- DURABLE anti-repeat ledger for Discord GIF picks (auction narrator).
--
-- Why: the narrator's rotation state was in-memory only (POOL_LAST_USED, a
-- module-scope Map in worker/src/index.js). A Cloudflare Worker isolate dies
-- on cold start — which, with the auction poll running every 5 minutes, is
-- most ticks — so "don't repeat the last 3 GIFs" reset constantly and owners
-- saw the same fist-bump three nominations in a row. This table survives cold
-- starts so the no-repeat window is real.
--
-- scope    = which bucket the pick came from, so pools don't shadow each other:
--              "pool:<pool_id>"      curated_gifs.json pool (e.g. pool:bump)
--              "giphy:<event_kind>"  Giphy fallback (e.g. giphy:overtake)
-- gif_url  = the exact URL posted (PK with scope: re-posting the same GIF in a
--            scope refreshes used_at_unix via INSERT OR REPLACE, never dupes)
-- used_at_unix = epoch seconds of the post.
--
-- Read path: getRecentGifs(env, scope, limit) — newest N urls, excluded from
-- the candidate set before the random pick. Write path: recordGifUse(env,
-- scope, url) — INSERT OR REPLACE + opportunistic prune of rows older than
-- ~14 days for that scope (no cron needed; the table stays tiny).
--
-- BOTH helpers are try/catch fail-soft: a D1 hiccup must NEVER block a post.
-- Worst case we lose the durable no-repeat for one message and fall back to
-- the in-memory POOL_LAST_USED filter. If exclusion would leave zero
-- candidates, the picker falls back to the full set — it never posts nothing.

CREATE TABLE IF NOT EXISTS ups_gif_recent (
  scope        TEXT NOT NULL,
  gif_url      TEXT NOT NULL,
  used_at_unix INTEGER NOT NULL,
  PRIMARY KEY (scope, gif_url)
);

-- Serves both the read path (ORDER BY used_at_unix DESC within a scope) and
-- the prune (DELETE WHERE scope = ? AND used_at_unix < ?).
CREATE INDEX IF NOT EXISTS idx_ups_gif_recent_scope_used
  ON ups_gif_recent (scope, used_at_unix);
