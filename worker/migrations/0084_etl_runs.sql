-- etl_runs — last-run stamp per data source, for the "last updated" indicators.
--
-- The scheduled nflverse-stats-refresh workflow writes one row per source after
-- a successful refresh; /api/data-freshness reads them. Live ADP feeds
-- (FantasyCalc / KTC / DynastyProcess / Sleeper / FantasyPros) are fetched per
-- request and edge-cached, so they don't appear here — their freshness is the
-- board's generated_at.

CREATE TABLE IF NOT EXISTS etl_runs (
  source        TEXT PRIMARY KEY,   -- e.g. nflverse_weekly, nflverse_pace, ff_player_ids
  last_run_utc  TEXT,               -- ISO-8601 UTC of the last successful run
  status        TEXT,               -- ok | error
  detail        TEXT                -- optional (e.g. season range, row count)
);
