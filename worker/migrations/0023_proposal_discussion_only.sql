-- 0023_proposal_discussion_only.sql
-- "Discussion-only" proposals capture sentiment + reasoning but never auto-close
-- on a YES/NO threshold. Used for direction-setting questions where a binding
-- verdict isn't appropriate (e.g. MYM end-of-season concerns — gauging if the
-- league wants to pursue a rule, not voting on a finalized rule).
--
-- Existing proposals default to discussion_only=0 (binding vote) — backwards
-- compatible with everything in the May2026 round.

ALTER TABLE hall_proposals ADD COLUMN discussion_only INTEGER NOT NULL DEFAULT 0;
