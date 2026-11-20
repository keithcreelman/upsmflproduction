-- 0180_ai_call_log.sql
-- One row per AI model call made by an AI feature (first user: the Commissioner Desk). It is the cost ledger the desk's budget gate reads
-- BEFORE every call, and the audit trail for "what did the model see and what did it cost". It never holds question text, answer text,
-- tool results or secrets: those live (for the desk) in ai_desk_questions, which is private and purged.
-- DELIBERATELY SEPARATE from hall_qa_log (the owner-facing Discord Q&A store): different audience, different retention, different permissions.
-- Writes: a handful of rows per desk question. The budget gate sums cost over a bounded window (index on created_at), a few hundred rows at most.
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
