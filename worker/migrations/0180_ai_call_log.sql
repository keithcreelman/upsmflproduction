-- 0180_ai_call_log.sql
-- One row per AI model call made by an AI feature (first user: the Commissioner Desk). It is the cost ledger the desk's budget gate reads
-- BEFORE every call, and the audit trail for "what did the model see and what did it cost". It never holds question text, answer text,
-- tool results or secrets: those live (for the desk) in ai_desk_questions, which is private and purged.
-- DELIBERATELY SEPARATE from hall_qa_log (the owner-facing Discord Q&A store): different audience, different retention, different permissions.
-- Writes: a handful of rows per desk question. The budget gate does NOT sum this table for the total and monthly caps: it reads two rows of
-- ai_budget_totals (below), so a call costs a handful of rows read however large the ledger grows. Only the per-run and per-question sums
-- read ledger rows, by their own indexes (rows of one run or one question). ai_call_log is never purged by the desk (only ai_desk_questions
-- is); the maintained totals are what make that safe.
-- Numbered 0180 to stay clear of the numbers other open branches already claim (0174 trade idempotency, 0175 bug reports, 0176 beta sessions);
-- renumber at merge time if another file lands first. NOT applied anywhere: local databases only until Keith approves a production migration.
CREATE TABLE IF NOT EXISTS ai_call_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,              -- unix seconds, set by the worker
  feature TEXT NOT NULL,                    -- 'commish_desk'
  run_id TEXT,                              -- an eval run id, or NULL for a live question
  question_id TEXT,                         -- ai_desk_questions.id (no question text here)
  step TEXT NOT NULL,                       -- router | loop | composer | retry
  model TEXT NOT NULL,
  mode TEXT NOT NULL,                       -- live | fake | blocked   (blocked = the gate refused the call; no model was contacted)
  prompt_hash TEXT,                         -- hash of the versioned prompt, never the prompt
  canon_sha TEXT,
  tools TEXT,                               -- comma-separated tool ids used in this step
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  est_cost_usd REAL NOT NULL DEFAULT 0,     -- worst-case reservation written BEFORE the call
  cost_usd REAL,                            -- actual cost from the response usage, written after; NULL while the call is in flight
  latency_ms INTEGER,
  validator_result TEXT,                    -- pass | retry | fail
  state TEXT,                               -- the card state returned
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_created ON ai_call_log (created_at);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_run ON ai_call_log (run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_call_log_question ON ai_call_log (question_id, created_at);

-- Maintained spend aggregate, one row per (mode, period): period is 'total' or a UTC month 'YYYY-MM'. mode is 'live' or 'fake' (separate lanes,
-- same limits). reserved_usd = worst-case estimates of calls still in flight; spent_usd = finalized cost (or the estimate when a call's cost
-- cannot be known). The budget gate updates it in the SAME atomic D1 batch as the ledger row (reserve: guarded INSERT then UPDATE ... WHERE
-- changes() > 0; finalize: row update then totals update), so the two cannot disagree. Missing rows or a missing table mean "blocked".
CREATE TABLE IF NOT EXISTS ai_budget_totals (
  mode TEXT NOT NULL,                       -- live | fake
  period TEXT NOT NULL,                     -- 'total' or 'YYYY-MM' (UTC)
  reserved_usd REAL NOT NULL DEFAULT 0,
  spent_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (mode, period)
);
