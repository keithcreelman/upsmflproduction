-- 0168: one row per (trade, team, limit) the after-trade roster check has told someone about
-- (POST /admin/trades/roster-check, worker/src/trade_roster_check.js). Written BEFORE the DM (status
-- 'sending') and deleted again if no DM lands, so an alert is retried, never swallowed; 'notified'
-- rows are never re-sent. escalated_at_utc = the one commissioner escalation after the deadline.
-- The route also creates this table on demand.
CREATE TABLE IF NOT EXISTS ups_trade_roster_check (
  league_id        TEXT NOT NULL,
  season           TEXT NOT NULL,
  check_key        TEXT NOT NULL,     -- "<tradeTs>_<fidA>_<fidB>|<franchise>|roster|qb"
  franchise_id     TEXT NOT NULL,
  kind             TEXT NOT NULL,     -- 'roster' | 'qb'
  trade_ts         INTEGER NOT NULL,
  deadline_unix    INTEGER,
  status           TEXT NOT NULL,     -- 'sending' | 'notified'
  message          TEXT,
  notified_owner   INTEGER DEFAULT 0,
  notified_commish INTEGER DEFAULT 0,
  escalated_at_utc TEXT,
  created_at_utc   TEXT NOT NULL,
  updated_at_utc   TEXT NOT NULL,
  PRIMARY KEY (league_id, season, check_key)
);
