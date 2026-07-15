-- 0100: Rule Proposals v2 — commish-authored proposals with structured
-- rationale/supporting-data, plus the Q&A learning store.
--
-- rationale_md / supporting_data_md render as their OWN messages in the
-- proposal thread (after the tally pin) so the proposal message itself stays
-- under Discord's 2000-char budget.
ALTER TABLE hall_proposals ADD COLUMN rationale_md TEXT;
ALTER TABLE hall_proposals ADD COLUMN supporting_data_md TEXT;

-- Every Discuss submission, thread Q&A, surfaced concern, and commish ruling.
-- This is the bot's memory: fetchQaGrounding() feeds recent rows + all rulings
-- back into the explain/synthesis prompts, with rulings marked AUTHORITATIVE —
-- "always trust my voice as the determining factor" (Keith, 2026-07-15).
CREATE TABLE IF NOT EXISTS hall_qa_log (
  qa_id               INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id         TEXT NOT NULL,
  round_id            TEXT,
  discord_user_id     TEXT,
  display_name        TEXT,
  kind                TEXT NOT NULL CHECK (kind IN
                        ('question','concern','feedback','keith_ruling','commish_verdict')),
  question_text       TEXT,             -- the owner's words (NULL for rulings)
  bot_answer          TEXT,             -- the bot's answer / synthesis
  classification_json TEXT,             -- raw classifier output, for audit
  source              TEXT NOT NULL DEFAULT 'dm_discuss'
                        CHECK (source IN ('dm_discuss','thread_explain','tab')),
  surfaced            INTEGER NOT NULL DEFAULT 0,   -- member clicked "Surface to league"
  surfaced_at_utc     TEXT,
  surface_message_id  TEXT,
  keith_ruling        TEXT,             -- authoritative text (kind=keith_ruling/commish_verdict)
  created_at_utc      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hall_qa_log_proposal
  ON hall_qa_log(proposal_id, created_at_utc);
