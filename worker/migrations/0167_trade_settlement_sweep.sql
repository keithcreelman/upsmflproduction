-- 0167 — one row per executed MFL trade the traded-salary settlement sweep
-- has acted on (POST /admin/trades/settlement-sweep, hourly cron).
--
-- Keith 2026-10-06: "make the worker auto-post settlements for trades accepted
-- on MFL". The War Room only settles trades accepted THROUGH the War Room; a
-- trade accepted on MFL's own site never had its cap money posted (audit log
-- A01–A06). A row is INSERTed (claimed) BEFORE the MFL write, so a trade is
-- posted at most once even when sweeps overlap or MFL's feed lags.
--   status: claimed → posted | unverified | post_failed, or needs_review
--   (not auto-postable — the commissioner was DMed once). The sweep never
--   retries a claimed trade.
-- The route also creates this table lazily (CREATE TABLE IF NOT EXISTS, same
-- definition), so the feature does not depend on this migration's timing.
CREATE TABLE IF NOT EXISTS ups_trade_settlement_sweep (
  id INTEGER PRIMARY KEY AUTOINCREMENT, league_id TEXT NOT NULL, season TEXT NOT NULL, trade_key TEXT NOT NULL,
  traded_at_unix INTEGER, mfl_trade_id TEXT, payer_fid TEXT, payee_fid TEXT, amount INTEGER, ref TEXT,
  status TEXT NOT NULL, detail TEXT, created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL,
  UNIQUE (league_id, season, trade_key));
