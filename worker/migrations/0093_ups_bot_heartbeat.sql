-- 0093: proof-of-life heartbeats for local bots (trade_roast today; keyed by
-- bot name so future launchd bots reuse the row shape). Written by
-- POST /api/roast-heartbeat (bearer ROAST_TRACK_API_KEY), read by the public
-- GET for the Commish Settings live status pill — replaces the hardcoded
-- "PROD" label that stayed green through the 2026-07-11 25-hour bot hang.
CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (
  bot     TEXT PRIMARY KEY,
  last_ts INTEGER NOT NULL,
  status  TEXT DEFAULT 'ok',
  env     TEXT DEFAULT ''
);
