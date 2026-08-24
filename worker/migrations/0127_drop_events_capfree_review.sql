-- Cap-free-cut commish review (Keith 2026-08-15).
--
-- A drop of a player who has retired is cap-free, but "cap-free" means free of
-- the §D1 PENALTY -- not free of the §D2a loaded-contract settlement, which is
-- money the owner never actually paid. See docs/league_context_v1.md §D2a.
--
-- Routing, per Keith:
--   "if flagged by MFL it should be automatic ... if no MFL flag it should
--    query real sources and include those sources in the post that I can
--    approve."
--
--   auto    -> MFL injuries says RETIRED. Applies with no human step.
--   pending -> real sources say retired but MFL does not. Money is HELD:
--              /admin/drops/post-mfl must SKIP these rows. Nothing is charged
--              until the commish approves or denies.
--   (absent)-> no retirement signal. Ordinary drop, ordinary penalty.
--
-- ⚠️ DO NOT RUN `wrangler d1 migrations apply` ON THIS D1. The tracker is ~47
-- files behind and replaying it corrupts live contracts (see 0112's header).
-- Hand-apply with: wrangler d1 execute ups-mfl-db --remote --file=<this file>
ALTER TABLE ups_drop_events ADD COLUMN capfree_review_status TEXT;          -- NULL | 'pending' | 'approved' | 'denied'
ALTER TABLE ups_drop_events ADD COLUMN capfree_route TEXT;                  -- 'auto' | 'pending' | 'none' | 'unknown'
ALTER TABLE ups_drop_events ADD COLUMN capfree_evidence_json TEXT;          -- the sources shown to the commish
ALTER TABLE ups_drop_events ADD COLUMN capfree_mfl_designation TEXT;        -- what MFL's injuries export said
ALTER TABLE ups_drop_events ADD COLUMN capfree_settlement_amount INTEGER;   -- §D2a: + owes, - credit
ALTER TABLE ups_drop_events ADD COLUMN capfree_decided_at_utc TEXT;
ALTER TABLE ups_drop_events ADD COLUMN capfree_decided_by TEXT;
ALTER TABLE ups_drop_events ADD COLUMN capfree_last_nudge_utc TEXT;         -- 24h commish DM resurface
ALTER TABLE ups_drop_events ADD COLUMN capfree_thread_message_id TEXT;      -- where the decision gets posted back
