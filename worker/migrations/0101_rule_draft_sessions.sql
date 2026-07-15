-- 0101: AI drafting workbench for Rule Proposals v2 — the commish's private
-- pre-publish loop: raw idea in, clarifying Q&A + canon challenges + real D1
-- research out, as a structured draft. Sessions are commish-only. At publish,
-- the session's Q&A is distilled into hall_qa_log kind='keith_ruling' rows so
-- the owner-facing Discuss bot inherits everything Keith already clarified —
-- "have the model underneath well versed on the proposal" (Keith 2026-07-15).

CREATE TABLE IF NOT EXISTS hall_draft_sessions (
  session_id          TEXT PRIMARY KEY,          -- 'rds-<base36 ts>-<4 hex>'
  status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','published','abandoned')),
  raw_text            TEXT,                      -- Keith's original braindump
  draft_json          TEXT,                      -- working structured draft (JSON):
                                                 -- {title,tldr,body_md,rationale_md,
                                                 --  supporting_data_md,pass_yes_count,
                                                 --  deadline_utc,category}
  status_text         TEXT,                      -- live breadcrumb for the polling UI
  model               TEXT,                      -- model that served the last turn
  proposal_id         TEXT,                      -- set at publish -> hall_proposals.id
  turn_count          INTEGER NOT NULL DEFAULT 0,
  turn_started_at_utc TEXT,                      -- in-flight guard; NULL when idle
  created_at_utc      TEXT NOT NULL,
  updated_at_utc      TEXT NOT NULL
);

-- 'user' = Keith's words; 'assistant' = the full Anthropic content blocks
-- (text + tool_use + thinking), VERBATIM — the Messages API requires exact
-- replay within a turn; 'tool_result' = the array of tool_result blocks
-- (replayed on the wire as role 'user'). Keeping tool_result distinct from
-- 'user' is what lets the publish-time distiller read only the human
-- conversation.
CREATE TABLE IF NOT EXISTS hall_draft_messages (
  msg_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id     TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('user','assistant','tool_result')),
  content_json   TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hall_draft_messages_seq
  ON hall_draft_messages(session_id, seq);
