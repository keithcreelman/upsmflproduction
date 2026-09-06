-- 0133_fantasy_adp.sql
-- Average Draft Position, from external market sources.
--
-- WHY THIS EXISTS. Keeper/trade/draft valuation needs to know what the MARKET
-- charges for a player. Before this table, that number was being approximated
-- from weekly POINT PROJECTIONS converted to a VOR rank — and that proxy is
-- badly wrong exactly where it matters most:
--   * Zach Charbonnet projected RB14 (MFL had him ahead of Kenneth Walker) and
--     the proxy called him a round-3 pick. His real ADP is 135.8 — round 12.
--   * Luther Burden projected WR33 so the proxy said round 8; his real ADP is
--     59.6 — round 5.
-- Projections answer "how many points will he score." ADP answers "what will
-- he cost." A keeper decision needs the second one, and they diverge most for
-- committee backs and for breakout candidates the market has already bid up.
--
-- ⚠️ NOT platform-scoped, deliberately. Every other fantasy_* table starts its
-- PK with `platform` because the row describes something INSIDE one provider's
-- league. ADP is the opposite: it is external market data about NFL players,
-- equally true for a Yahoo, ESPN or CBS league. Scoping it by platform would
-- duplicate identical rows per provider. It is keyed by SOURCE instead, so two
-- sources can disagree and both be stored rather than one silently winning.
CREATE TABLE IF NOT EXISTS fantasy_adp (
  source          TEXT    NOT NULL,   -- 'ffc' | 'fantasypros' — never blended
  season          INTEGER NOT NULL,
  scoring         TEXT    NOT NULL,   -- 'ppr' | 'half_ppr' | 'standard' | '2qb'
  teams           INTEGER NOT NULL,   -- league size the ADP was sampled for
  player_key      TEXT    NOT NULL,   -- normalized name, for joining
  player_name     TEXT    NOT NULL,   -- VERBATIM from the source
  position        TEXT,
  nfl_team        TEXT,

  -- ⚠️ adp is an OVERALL PICK NUMBER (36.0 = late round 3 in a 12-team draft),
  -- not a round. Round is derived, never stored, so the two can never disagree.
  adp             REAL,
  adp_rank        INTEGER,            -- 1 = first off the board by this source
  adp_stdev       REAL,               -- market disagreement; NULL = not published
  high_pick       INTEGER,
  low_pick        INTEGER,
  times_drafted   INTEGER,            -- sample size behind the average
  bye_week        INTEGER,

  source_url      TEXT,
  source_run_id   TEXT,
  fetched_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at_utc  TEXT    NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (source, season, scoring, teams, player_key)
);

-- "What does the market charge for this guy" — the join every caller makes.
CREATE INDEX IF NOT EXISTS idx_fantasy_adp_player
  ON fantasy_adp(player_key, season);

-- "Give me the board in order" — draft-prep reads.
CREATE INDEX IF NOT EXISTS idx_fantasy_adp_board
  ON fantasy_adp(source, season, scoring, teams, adp);
