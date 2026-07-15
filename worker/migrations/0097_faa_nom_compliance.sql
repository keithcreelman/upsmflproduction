-- 0097 — FA-Auction missed-nomination compliance ledger + RULE 2 penalties.
--
-- Canon: league_context_v1.md §A2 (exactly 2 nominations per ET calendar day,
-- a MINIMUM and a MAXIMUM) and §F RULE 2 (the escalating fine schedule, written
-- into canon 2026-07-14 — §A2 had pointed at "see §F" for a schedule that did
-- not exist).
--
-- Two tables, deliberately separate:
--
--   ups_faa_nom_days      — the FACT. One row per franchise per ET day: what
--                           they did, and whether it was a miss. Written once
--                           the day is CLOSED (the 9 AM ET report is the first
--                           moment yesterday's verdict is final and unarguable).
--                           An immutable audit trail — never rewritten to match
--                           a later ruling.
--
--   ups_faa_nom_penalties — the CONSEQUENCE. Derived from the days above, but
--                           stored, not recomputed: a penalty is money, and it
--                           must not silently change if the schedule is edited
--                           later. Offense numbering is stamped at creation.
--
-- Excusing a miss VOIDS rows rather than deleting them. §F RULE 2's caveat
-- ("if you let a member of the CC know ahead of time... no penalty will be
-- enforced") means the commish overrides the machine, and the override itself
-- is history worth keeping — deleting the row would erase the fact that an
-- owner called ahead, which is exactly what protects them next time.

CREATE TABLE IF NOT EXISTS ups_faa_nom_days (
  season            INTEGER NOT NULL,
  league_id         TEXT    NOT NULL,
  fid               TEXT    NOT NULL,   -- 4-char padded franchise id
  et_day            TEXT    NOT NULL,   -- 'YYYY-MM-DD' in America/New_York
  noms_used         INTEGER NOT NULL DEFAULT 0,
  noms_required     INTEGER NOT NULL DEFAULT 2,
  roster_met        INTEGER NOT NULL DEFAULT 0,   -- 1 = could field a legal lineup; the floor is WAIVED
  total_deficit     INTEGER NOT NULL DEFAULT 0,
  missed            INTEGER NOT NULL DEFAULT 0,   -- 1 = out of compliance for this closed day
  -- Commish override (§F RULE 2 caveat). Voided days never count toward an
  -- offense number and never create a penalty.
  voided            INTEGER NOT NULL DEFAULT 0,
  void_reason       TEXT,
  voided_by         TEXT,
  voided_at_utc     TEXT,
  recorded_at_utc   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season, league_id, fid, et_day)
);

CREATE INDEX IF NOT EXISTS idx_faa_nom_days_missed
  ON ups_faa_nom_days (season, league_id, fid, missed, voided);

CREATE TABLE IF NOT EXISTS ups_faa_nom_penalties (
  penalty_id        TEXT    PRIMARY KEY,          -- '<season>|<league>|<fid>|<et_day>|<applies_to_season>'
  season            INTEGER NOT NULL,             -- the auction season that generated it
  league_id         TEXT    NOT NULL,
  fid               TEXT    NOT NULL,
  et_day            TEXT    NOT NULL,             -- the missed day that caused it
  offense_no        INTEGER NOT NULL,             -- 1st/2nd/3rd miss THIS auction; stamped at creation
  amount_k          INTEGER NOT NULL,             -- $K for this offense (3 / 7 / 15 — §F RULE 2)
  -- RULE 2 fines BOTH the current season and the next one. They are separate
  -- rows because they reach MFL at different times: the current-season row can
  -- post now; the next-season row must NOT touch MFL until the 2027 rollover
  -- (Keith 2026-07-14 — "store the 3K on the ledger for 2027... never pass to
  -- MFL until we roll forward next year"). It still shows in reporting today.
  applies_to_season INTEGER NOT NULL,
  posted_to_mfl     INTEGER NOT NULL DEFAULT 0,
  posted_at_utc     TEXT,
  mfl_adj_note      TEXT,
  voided            INTEGER NOT NULL DEFAULT 0,
  void_reason       TEXT,
  voided_by         TEXT,
  voided_at_utc     TEXT,
  created_at_utc    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_faa_nom_pen_lookup
  ON ups_faa_nom_penalties (season, league_id, fid, voided);
CREATE INDEX IF NOT EXISTS idx_faa_nom_pen_pending
  ON ups_faa_nom_penalties (applies_to_season, posted_to_mfl, voided);
