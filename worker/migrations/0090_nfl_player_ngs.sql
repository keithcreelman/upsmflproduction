-- Per (season, gsis_id) Next Gen Stats aggregates (nflverse load_nextgen_stats).
-- NGS publishes WEEKLY AVERAGES (avg_separation, avg_time_to_throw, ...), so we
-- store DENOMINATOR-WEIGHTED SUMS plus the denominator count instead of means:
--   season mean = metric_sum / denom_n, and multi-season re-aggregation stays
--   EXACT (sum the sums, sum the counts) — a mean-of-weekly-means would not be.
--   rec_*  : weighted by targets        sep_sum   = sum(avg_separation x targets)
--                                        cush_sum  = sum(avg_cushion x targets)
--                                        yacoe_sum = sum(avg_yac_above_expectation x targets)
--   rush_* : weighted by rush_attempts  eff_sum   = sum(efficiency x att)
--                                        box8_sum  = sum(percent_attempts_gte_eight_defenders x att)
--                                        ryoe_sum  = straight sum of weekly
--                                        rush_yards_over_expected (already a
--                                        per-week TOTAL, not an average —
--                                        verified: weekly sums == NGS week-0 agg)
--   pass_* : weighted by attempts       tt_sum    = sum(avg_time_to_throw x att)
--                                        agg_sum   = sum(aggressiveness x att)
--                                        cpae_sum  = sum(completion_percentage_above_expectation x att)
-- Weekly rows only (week >= 1 — week 0 is NGS's own season-aggregate row and
-- would double-count) and REG season only. NGS coverage starts 2016.
CREATE TABLE IF NOT EXISTS nfl_player_ngs (
  season     INTEGER NOT NULL,
  gsis_id    TEXT    NOT NULL,
  rec_tgt_n  INTEGER,
  sep_sum    REAL,
  cush_sum   REAL,
  yacoe_sum  REAL,
  rush_att_n INTEGER,
  ryoe_sum   REAL,
  eff_sum    REAL,
  box8_sum   REAL,
  pass_att_n INTEGER,
  tt_sum     REAL,
  agg_sum    REAL,
  cpae_sum   REAL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (season, gsis_id)
);

CREATE INDEX IF NOT EXISTS idx_nfl_player_ngs_gsis ON nfl_player_ngs (gsis_id);
