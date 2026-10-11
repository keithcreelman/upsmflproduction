-- 0171 — §G3 commissioner rulings on lineup-violation candidates.
--
-- (0168 is held by draft #1189 and 0169/0170 by draft #1219; wrangler applies
-- by name, so this can land before or after them.)
--
-- ups_lineup_violations (0129) is what the ALGORITHM booked: a candidate. It
-- must never be read as a ruling. 2026 proved why — a lineup-read bug booked
-- all 12 franchises in every week 1-4, and the only reason nobody was told or
-- fined is that nothing downstream read that table yet.
--
-- This table is the COMMISSIONER's decision about one candidate, kept apart on
-- purpose so three things stay distinguishable:
--
--   1. the candidate     — ups_lineup_violations row (machine)
--   2. the ruling        — this row: confirmed or excused, by whom, when (Keith)
--   3. the consequence   — sanction_status: what still has to be done on MFL by
--                          hand (pick strip, salary adjustment, retention vote)
--                          and whether it has been done. Nothing here ever
--                          writes MFL.
--
-- The final notice (owner DM + league post) is composed at ruling time and
-- stored, so the text Keith previewed is the text that posts. notice_claimed_*
-- is a claim-before-post guard: the UPDATE that sets it only succeeds once, so
-- a double-tap or a retried request cannot post twice. A failed post leaves the
-- claim in place (fail closed) and records notice_error; re-posting needs an
-- explicit release.

CREATE TABLE IF NOT EXISTS ups_lineup_rulings (
  season                  INTEGER NOT NULL,
  league_id               TEXT    NOT NULL,
  fid                     TEXT    NOT NULL,
  week                    INTEGER NOT NULL,
  ruling                  TEXT    NOT NULL CHECK (ruling IN ('confirmed', 'excused')),
  offense_no              INTEGER NOT NULL DEFAULT 0,   -- at ruling time; 0 when excused
  candidate_reasons_json  TEXT,                         -- snapshot of the booked candidate
  note                    TEXT,
  ruled_by                TEXT    NOT NULL,
  ruled_at_utc            TEXT    NOT NULL,
  owner_notice            TEXT,
  league_notice           TEXT,
  notice_claimed_at_utc   TEXT,
  notice_posted_at_utc    TEXT,
  notice_refs_json        TEXT,                         -- {league_message_id, dm_sent, dm_undeliverable}
  notice_error            TEXT,
  sanction_json           TEXT,                         -- the ladder's plan for this offense
  sanction_status         TEXT    NOT NULL DEFAULT 'none'
                          CHECK (sanction_status IN ('none', 'pending_manual', 'applied_manual')),
  sanction_applied_by     TEXT,
  sanction_applied_at_utc TEXT,
  sanction_note           TEXT,
  PRIMARY KEY (season, league_id, fid, week)
);
