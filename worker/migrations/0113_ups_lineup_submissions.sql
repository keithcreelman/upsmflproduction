-- 0113 — echo ledger for submitted starting lineups (Keith 2026-08-03).
--
-- WHY THIS EXISTS: MFL gives us no way to read a submitted lineup back.
-- There is no `lineup` EXPORT type at all (only the import); `liveScoring`
-- answers "Live scoring not available until the season starts"; and
-- `weeklyResults` carries no player rows for an unplayed week. So in the
-- preseason a lineup an owner submits is write-only from our side.
--
-- Without a record of it, the Game Day / mobile lineup editors had nothing to
-- seed from and auto-filled the OPTIMAL lineup on every visit — so an owner who
-- deliberately started someone came back to a screen showing optimal, and
-- re-submitting overwrote their real choice with it.
--
-- Written by POST /api/submit-lineup only AFTER MFL accepts the write, read by
-- GET /api/lineup. One row per (season, league, franchise, week); a re-submit
-- replaces it. `week` is stored as TEXT and may be '' — that is MFL's own
-- "current scoring week" default, which the submit path passes through rather
-- than guessing a week number.
--
-- This is an ECHO of what we sent, not an authority on MFL's state: a lineup
-- set natively on MFL leaves no row here, which is why the read distinguishes
-- "no_record" from "empty lineup" and the client must never treat the former as
-- licence to auto-fill.
CREATE TABLE IF NOT EXISTS ups_lineup_submissions (
  season            TEXT    NOT NULL,
  league_id         TEXT    NOT NULL,
  fid               TEXT    NOT NULL,
  week              TEXT    NOT NULL DEFAULT '',
  starters_csv      TEXT    NOT NULL,
  submitted_at_unix INTEGER NOT NULL,
  PRIMARY KEY (season, league_id, fid, week)
);

CREATE INDEX IF NOT EXISTS idx_ups_lineup_submissions_lookup
  ON ups_lineup_submissions (season, league_id, fid);
