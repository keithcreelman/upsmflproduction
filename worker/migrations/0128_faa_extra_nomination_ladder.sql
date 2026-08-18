-- 0128 — the OTHER half of §F RULE 2: extra nominations.
--
-- §T4.3a has been titled "Missed Nomination / Extra Nomination fines" since it
-- was written, but only the miss ladder was ever recorded or built. Keith
-- supplied the extra-nomination text 2026-08-17; canon gained the schedule the
-- same day. This migration gives it somewhere to live.
--
--   1st  warning        "It can happen by accident we've all done it."
--   2nd  $3K            current season AND next
--   3rd  $7K            current + next ($10K each year, cumulative)
--   4th  $15K           current + next ($25K each year, cumulative)
--   5th  no fine        league-fit review
--
-- It is the miss ladder shifted one rung. The free first offense is not
-- leniency about harm — canon's Principle 0 (Keith 2026-08-17) prices offense
-- #1 on whether a diligent owner can trip it BY ACCIDENT. Over-nominating can
-- happen with a stray tap; missing a nomination for a whole ET day cannot.
--
-- WHY THIS IS NEEDED AT ALL, given the app already blocks a 3rd nomination:
-- the block lives in `performAuctionAction`, i.e. in OUR app. MFL itself
-- imposes no ceiling, so an owner nominating natively on MFL still gets
-- through — which is exactly the mess Keith describes cleaning up by hand
-- ("forces me to go in and remove nominations, which if I don't get to it
-- right away, other owners will bid up a player that will end up being
-- removed"). The block is the guardrail; this is the backstop.
--
-- DESIGN: one new column on each existing table rather than new tables, so
-- extra nominations inherit the whole machinery that already works — the
-- commish void/unvoid path, the immunity re-derivation, the fines-dark
-- auto-void, and the current/next-season split. Two ladders, one ledger.

-- The FACT. `over` mirrors `missed`; the two are mutually exclusive on a given
-- day (noms_used cannot be both < 2 and > 2), which is why one row per
-- franchise per day still holds and the primary key is untouched.
ALTER TABLE ups_faa_nom_days  ADD COLUMN over INTEGER NOT NULL DEFAULT 0;

-- The CONSEQUENCE. 'miss' | 'over'. Defaulting to 'miss' is what makes this
-- migration safe on the rows already banked: every existing penalty was a
-- missed nomination, so the default is not a guess.
ALTER TABLE ups_faa_nom_penalties ADD COLUMN kind TEXT NOT NULL DEFAULT 'miss';

-- Over-nomination penalty_ids carry a '|over' suffix
-- ('<season>|<league>|<fid>|<et_day>|<applies>|over'). Miss ids are left in
-- their original 5-part form on purpose: rewriting them would orphan rows
-- already posted to MFL, whose salaryAdj notes reference them.

CREATE INDEX IF NOT EXISTS idx_faa_nom_days_over
  ON ups_faa_nom_days (season, league_id, fid, over, voided);
CREATE INDEX IF NOT EXISTS idx_faa_nom_pen_kind
  ON ups_faa_nom_penalties (season, league_id, fid, kind, voided);
