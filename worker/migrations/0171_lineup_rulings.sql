-- 0171 — §G3 commissioner rulings, the final thread post, and forfeited-pick
-- reservations. (0168 is held by draft #1189 and 0169/0170 by draft #1219;
-- wrangler applies by name, so this can land before or after them.)
--
-- ups_lineup_violations (0129) is what the ALGORITHM booked: a candidate. It
-- is never itself an offense. 2026 proved why: a lineup-read bug booked all 12
-- franchises in every week 1-4 (voided 2026-10-11; see
-- docs/incidents/2026-10-11_lineup_false_violations).
--
-- ups_lineup_rulings is the COMMISSIONER's decision on one candidate, kept
-- apart on purpose so these stay distinguishable:
--
--   candidate  ups_lineup_violations row                       (machine)
--   ruling     ruling = confirmed | excused, ruled_by/at       (Keith)
--   offense    offense_no — the season rung, one per franchise-week
--   evidence   evidence_json — every starter behind it, with exact timestamps
--   penalty    penalty_json — what the rung assesses NOW (exact pick if any)
--   status     the publication pipeline:
--                needs_pick_selection  two+ qualifying picks; Keith chooses
--                held                  cannot publish (hold_reason); Keith alerted
--                ready                 verified and composed, not yet posted
--                posted                posted ONCE into the Week N Injury Report thread
--                closed                excused — nothing to publish
--   sanction   assessed = recorded by the ruling;
--              applied  = the exact pick / cap action VERIFIED on MFL.
--              Nothing here ever writes MFL.

CREATE TABLE IF NOT EXISTS ups_lineup_rulings (
  season                   INTEGER NOT NULL,
  league_id                TEXT    NOT NULL,
  fid                      TEXT    NOT NULL,
  week                     INTEGER NOT NULL,
  ruling                   TEXT    NOT NULL CHECK (ruling IN ('confirmed', 'excused')),
  offense_no               INTEGER NOT NULL DEFAULT 0,
  evidence_json            TEXT,
  penalty_json             TEXT,
  pick_options_json        TEXT,
  note                     TEXT,
  ruled_by                 TEXT    NOT NULL,
  ruled_at_utc             TEXT    NOT NULL,
  status                   TEXT    NOT NULL DEFAULT 'held'
                           CHECK (status IN ('needs_pick_selection', 'held', 'ready', 'posted', 'closed')),
  hold_reason              TEXT,
  alerted_reason           TEXT,
  alerted_at_utc           TEXT,
  notice_text              TEXT,
  notice_thread_id         TEXT,
  notice_claimed_at_utc    TEXT,
  notice_posted_at_utc     TEXT,
  notice_message_id        TEXT,
  notice_error             TEXT,
  sanction_status          TEXT    NOT NULL DEFAULT 'none'
                           CHECK (sanction_status IN ('none', 'assessed', 'applied')),
  sanction_verified_at_utc TEXT,
  sanction_verify_json     TEXT,
  PRIMARY KEY (season, league_id, fid, week)
);

-- The exact future pick a ruling forfeits, recorded the moment the ruling is
-- finalized. One reservation per franchise-week (the primary key), and a pick
-- can be held by only ONE live reservation (the partial unique index), so a
-- pick cannot be forfeited twice. released_at_utc is set only if the ruling is
-- excused before it posts; a released row no longer holds the pick.
CREATE TABLE IF NOT EXISTS ups_lineup_pick_reservations (
  season           INTEGER NOT NULL,
  league_id        TEXT    NOT NULL,
  holder_fid       TEXT    NOT NULL,
  week             INTEGER NOT NULL,
  pick_year        INTEGER NOT NULL,
  pick_round       INTEGER NOT NULL,
  original_owner   TEXT    NOT NULL,
  ownership_basis  TEXT    NOT NULL,   -- 'mfl_future_picks' | 'beyond_trade_horizon'
  reserved_at_utc  TEXT    NOT NULL,
  released_at_utc  TEXT,
  PRIMARY KEY (season, league_id, holder_fid, week)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_lineup_pick_reserved_once
  ON ups_lineup_pick_reservations (league_id, pick_year, pick_round, original_owner)
  WHERE released_at_utc IS NULL;
