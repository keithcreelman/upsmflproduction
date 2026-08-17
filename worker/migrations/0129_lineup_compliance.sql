-- 0129 — §G3 lineup compliance: the injury-status ledger and the violation ladder.
--
-- Canon §G3 (Keith 2026-08-16): a lineup is a violation when it contains a
-- missing starter, a player on bye, a player listed Out, or a player listed
-- Doubtful who does not play — with injury-report timing measured **24 hours
-- before that player's kickoff**.
--
-- Built on the 24-hour anchor per Keith 2026-08-17, replacing the Friday-
-- midnight snapshot in the §H proposal (docs/FOLLOWUP_TASKS_2026-05-26.md).
-- A weekly anchor cannot evaluate a Wednesday or Thursday game — and 2026
-- opens WEDNESDAY Sept 9 — which is the same defect that retired the 2018
-- fixed-day wording. §H's own DM schedule was already per-kickoff; only its
-- violation test was weekly. This makes the test match the delivery.
--
--
-- WHY A SNAPSHOT TABLE IS UNAVOIDABLE
--
-- MFL's TYPE=injuries reports CURRENT status and keeps no history. "Was he
-- declared Out more than 24 hours before kickoff?" is therefore unanswerable
-- from the live feed alone — by the time anyone looks, the feed says only what
-- is true now. Nothing in UPS has ever recorded injury status over time, so
-- the 24-hour rule was not merely unenforced; it was not *computable*.
--
-- ups_injury_status fixes that by recording, per player per week, the FIRST
-- time each distinct status was observed. That first-seen instant is the
-- evidence the rule turns on, and it is why polling has to start well before
-- kickoff: a designation that first appears in our data 3 hours before a game
-- is indistinguishable from one we simply started watching too late. The
-- evaluator refuses to judge in that case rather than guessing (see
-- lineup_compliance.js — an unobserved window yields `unknown`, never a fine).

CREATE TABLE IF NOT EXISTS ups_injury_status (
  season          INTEGER NOT NULL,
  week            INTEGER NOT NULL,
  player_id       TEXT    NOT NULL,
  status          TEXT    NOT NULL,   -- normalized: OUT | DOUBTFUL | QUESTIONABLE | IR | ACTIVE
  first_seen_unix INTEGER NOT NULL,   -- first observation of THIS status this week
  last_seen_unix  INTEGER NOT NULL,
  details         TEXT,
  PRIMARY KEY (season, week, player_id, status)
);

CREATE INDEX IF NOT EXISTS idx_injury_status_week
  ON ups_injury_status (season, week, player_id);

-- Every poll, whether or not anything changed. Without this an empty
-- ups_injury_status is ambiguous — "nobody was hurt" and "the poller was down
-- all week" look identical, and the second must never produce a fine.
CREATE TABLE IF NOT EXISTS ups_injury_polls (
  season       INTEGER NOT NULL,
  week         INTEGER NOT NULL,
  polled_unix  INTEGER NOT NULL,
  rows_seen    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (season, week, polled_unix)
);

-- The violation ladder (§G3). Season-scoped by construction: `season` is part
-- of the key and every offense count filters on it, which is what implements
-- Keith's 2026-08-17 ruling that violations RESET EACH SEASON. Expulsion at #5
-- therefore means five illegal lineups in one season, not five across a decade.
--
-- Mirrors ups_faa_nom_days/penalties deliberately: same void-not-delete
-- immunity path, same re-derivation on excuse, same "voiding is evidence"
-- reasoning. One row per franchise per week — a week with three bad starters
-- is ONE violation, not three, because the ladder counts illegal LINEUPS.
CREATE TABLE IF NOT EXISTS ups_lineup_violations (
  season          INTEGER NOT NULL,
  league_id       TEXT    NOT NULL,
  fid             TEXT    NOT NULL,
  week            INTEGER NOT NULL,
  offense_no      INTEGER NOT NULL DEFAULT 0,  -- 1-based within the season; 0 until finalized
  reasons_json    TEXT,                        -- the per-player verdicts behind it
  -- Set when a verdict needs a human: e.g. a player Out at the 24h mark who
  -- then played. Canon §G3 says "a player listed Out" without a did-not-play
  -- qualifier, so the machine books it and flags it rather than silently
  -- softening the rule in either direction.
  needs_review    INTEGER NOT NULL DEFAULT 0,
  review_note     TEXT,
  -- Commish override, same semantics as §F RULE 2: excusing does not delete,
  -- because the record that an owner gave notice is what protects them later.
  voided          INTEGER NOT NULL DEFAULT 0,
  void_reason     TEXT,
  voided_by       TEXT,
  voided_at_utc   TEXT,
  recorded_at_utc TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season, league_id, fid, week)
);

CREATE INDEX IF NOT EXISTS idx_lineup_violations_ladder
  ON ups_lineup_violations (season, league_id, fid, voided);

-- Every compliance DM sent, per §H ("Log every DM to D1"). Also the send-once
-- guard: a cron that fires twice must not DM an owner twice about the same
-- game window.
CREATE TABLE IF NOT EXISTS ups_lineup_dm_log (
  season       INTEGER NOT NULL,
  league_id    TEXT    NOT NULL,
  fid          TEXT    NOT NULL,
  week         INTEGER NOT NULL,
  window_key   TEXT    NOT NULL,   -- e.g. '2026-09-13T13:00' — the kickoff window
  verdict      TEXT    NOT NULL,   -- violation | advisory | clean
  body         TEXT,
  sent_unix    INTEGER NOT NULL,
  PRIMARY KEY (season, league_id, fid, week, window_key)
);
