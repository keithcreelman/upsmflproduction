-- Owner bug reports: private storage for the "Report bug" sheet (test-only slice).
--
-- PROVISIONAL NUMBER. 0174 is held by the trade-idempotency PRs (#1396, #1425, #1428) and
-- 0173 collides between main and #1306. The number is re-checked against open PRs and
-- branches when this draft is opened and again before any merge; renumber if it moved.
--
-- Private data: owners' error text and notes. These tables are read only by the worker
-- (owner: their own rows; commissioner: all). Nothing here is ever written to a repo file,
-- a Pages file or a Discord channel in this slice. Idempotent: safe to re-apply.
-- Written rows per report: 2 (+ their index entries). Reads are index-only; see docs/BUG_REPORTS.md.

CREATE TABLE IF NOT EXISTS ups_bug_reports (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  env               TEXT    NOT NULL DEFAULT 'test',          -- 'test' | 'live' (live is not enabled by this slice)
  league_id         TEXT    NOT NULL,
  season            TEXT    NOT NULL,
  franchise_id      TEXT    NOT NULL,                         -- proven from the MFL session, never from the request body
  status            TEXT    NOT NULL DEFAULT 'open',
  summary           TEXT    NOT NULL,                         -- redacted
  note              TEXT    NOT NULL DEFAULT '',              -- redacted
  screen            TEXT    NOT NULL,
  build             TEXT    NOT NULL DEFAULT '',
  viewport          TEXT    NOT NULL DEFAULT '',
  online            INTEGER,
  client_time       TEXT    NOT NULL DEFAULT '',
  err_name          TEXT    NOT NULL DEFAULT '',
  err_message       TEXT    NOT NULL DEFAULT '',              -- redacted
  err_endpoint      TEXT    NOT NULL DEFAULT '',              -- path only: no host, query or fragment
  err_status        INTEGER,
  fingerprint       TEXT    NOT NULL,                         -- duplicate detection
  client_request_id TEXT    NOT NULL,                         -- retry/double-tap detection
  dup_count         INTEGER NOT NULL DEFAULT 0,
  redactions        INTEGER NOT NULL DEFAULT 0,               -- how many secret-looking items were removed
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ups_bug_reports_request ON ups_bug_reports (franchise_id, client_request_id);
CREATE INDEX IF NOT EXISTS idx_ups_bug_reports_team_time ON ups_bug_reports (franchise_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ups_bug_reports_team_fp ON ups_bug_reports (franchise_id, fingerprint, created_at);
CREATE INDEX IF NOT EXISTS idx_ups_bug_reports_status_time ON ups_bug_reports (status, created_at);

CREATE TABLE IF NOT EXISTS ups_bug_report_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL,
  at         TEXT    NOT NULL,
  actor      TEXT    NOT NULL,                                -- 'owner:0001' | 'commish' | 'system'
  kind       TEXT    NOT NULL,                                -- 'submitted' | 'duplicate' (status kinds come later)
  detail     TEXT    NOT NULL DEFAULT ''                      -- redacted
);
CREATE INDEX IF NOT EXISTS idx_ups_bug_report_events_report ON ups_bug_report_events (report_id, id);
