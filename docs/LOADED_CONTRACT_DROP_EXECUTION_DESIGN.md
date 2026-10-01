# Loaded-Contract Conditional-Drop EXECUTION — design doc (not implemented)

**Status: design/trace only, REVISION 5.** No execution code in this document has been written.
Round 1 (Keith, 2026-09-29): *"Do not merge, migrate, or deploy PR #1149 as currently written...
Revise the execution design without assuming either operation order is safe."* Round 2 (same day,
after reviewing round 1's §8): *"My send-time rule applies to both teams, not only the initiator
... Please revise the staged-offer design to account for roster changes after creation as
well... Also resolve the inconsistency in §8.1..."* Round 3 (same day, after reviewing round 2):
*"Choose universal staging, not a near-limit heuristic... Address what happens to already-pending
native offers at cutover, and determine whether owners can create or accept trades directly on
MFL outside the War Room; state the enforceable boundary honestly... Do not choose automatic
trade-first or drop-first yet. Stage and collect each owner's named-player consent, then hold
conditional-drop deals for commissioner review. Present the exact manual execution procedure and
its non-atomic risks before any real drop or trade is attempted."* Round 4 (after reviewing round
3's §2.4.3): *"Its manual execution doc §2.4.3 needs correction: after one confirmed drop, a
later drop or the trade can fail. The statement that a failure means 'nothing was taken from
anyone' is false. Do not treat a human following a checklist as an atomic transaction or approve
drop-first by default. Document each partial state, owner notification, and recovery before
selecting an execution order."*

This revision answers round 4 directly: §2.4.3 is rewritten from a single, prescribed
drop-first sequence with a blanket "nothing lost on failure" claim into a general analysis of
every partial state a multi-write sequence (one or more drops, plus the trade) can stop in —
state 0 (nothing executed, costless) through state *k* (some but not all writes confirmed, a
real, non-atomic loss, now with its own PROPOSED `partial_executed` ledger state — design only,
not implemented — plus explicit per-owner notification and explicit non-automatic recovery)
through state *N* (everything confirmed,
success) — symmetric regardless of which write happens first, since a fixed "drops first"
default was exactly what this correction removed, not replaced with a different default.

Round 3's other items stand as previously revised: §2.4 is the decided execution model (manual
commissioner review; §2.1/§2.2 remain as the reasoning for why neither automated ordering was
approved), §8.3 records universal staging as decided over the scoped alternative, and §8.5
addresses cutover for pending native offers and states plainly what universal staging does and
does not control relative to MFL's own native trade tools. §9's Ext1/Ext2/IR classification
question is likewise ruled on and shipped as its own PR (#1152), kept deliberately separate
from this branch and its migration.

Nothing in THIS document (the execution/staging design) is built. The SELECTION mechanism (an
owner picking and confirming which of their own loaded-contract players to drop, conditional on a
trade) is built, tested, and committed — and a satisfied selection is verified to produce **zero**
real MFL writes anywhere in the codebase, by direct test (`tests/trade_loaded_contracts.test.mjs`'s
`LC EXEC-GATE` suite). This doc is what a *later*, separately-reviewed PR would build on top of
that, once the still-open items in §11 are resolved.

**Evidence vocabulary:** **[verified]** = read directly from the worker source in this session,
file:line cited. **[inferred]** = a design conclusion drawn from that code, not itself executed.
**[open question]** = identified, not resolved — for Keith to decide.

---

## 1. What already exists, exactly, and where

### 1.1 The drop write

**Route:** `POST /roster-workbench/action?action=drop_player`, `worker/src/index.js:56197`.
**[verified]**

- MFL call: an **import**, `TYPE=taxi_squad`, `DROP=<playerId>`, `FRANCHISE_ID=<franchiseId>`
  (`index.js:56583,56592-56599`) — a GET with the fields as query params, via
  `postMflImportFormForCookie(viewerCookieHeader, ...)`. MFL has no dedicated `TYPE=drop`; a drop
  rides the taxi-squad import as a `DROP=` parameter. **[verified]**
- Authentication: the **caller's own MFL owner session**, with `FRANCHISE_ID` for commissioner
  impersonation; on impersonation lockout it retries once *without* `FRANCHISE_ID`, which only
  succeeds if the caller genuinely *is* the owner (`index.js:56627-56641`). Anonymous calls are
  refused (`index.js:56222-56228`). **[verified]**
- **Success/failure detection deliberately does not trust MFL's response body** — three real
  incidents are documented in the route: the original misread-response pair, 2026-08-15 and
  2026-09-07 (`index.js:56663-56667,56675-56690`), and a SECOND, separate 2026-09-07 incident
  where a commissioner-lockout refusal was scored as a successful drop
  (`index.js:56746-56750`). It re-reads `TYPE=rosters` (`index.js:56696`) and checks the player
  is now on **no** roster (`index.js:56751-56774`). **Nothing short-circuits before that
  verifying read anymore** — a v1 draft of this doc claimed an explicit MFL refusal bypassed it;
  re-verified against the current code and that is not true. An explicit refusal is acted on only
  *after* the read, and only when the read itself fails (`index.js:56925-56947`, the next
  bullet). **[verified]**
- **If the verifying roster-read itself fails**, the route returns
  `{ ok:true, verified:false, retry_safe:false }` and *explicitly tells the caller not to resend*
  — "this action is not idempotent" (`index.js:56925-56947`). **[verified]**
- **No structural idempotency lock** on this route (unlike trade execution, §1.2). Safety rests on
  (a) requiring the real owner's/commish's session, (b) the "don't resend on unconfirmed"
  instruction. **[verified]**
- **No D1 write** happens in this route. `ups_drop_events` (the table cap-penalty math reads) is
  populated **separately and asynchronously** by `POST /admin/drops/scan-and-record`
  (`index.js:51524-52007`), scanning MFL's own `TYPE=transactions&TRANS_TYPE=FREE_AGENT` export
  over a rolling window, keyed `UNIQUE(season, league_id, player_id, dropped_at_unix)` — it
  discovers *any* drop from MFL's own ledger after the fact, regardless of cause; this route
  never calls it directly. **[verified]**

### 1.2 The trade write

**2-way owner accept:** `POST /trade-offers/action`, `index.js:38910` — `TYPE=tradeResponse`
import, sent as the **real owner's own session** (`postMflImportFormAsViewer`,
`index.js:39999-40008`). **[verified]**

**3-way (and any commissioner-impersonated 2-party leg):** `executeCommishTwoPartyTrade`,
`trade_3way.js:93-177` — propose (`TYPE=tradeProposal`, `:101-112`) then accept
(`TYPE=tradeResponse`, `:159-169`), both authenticated as **commissioner** (`env.MFL_APIKEY`),
impersonating each side in turn. A 3-way decomposes into 1–3 of these pairwise MFL trades
(`execute3Way`, `:1132-1299`, legs run **in order**, `:1219`). **[verified]**

**Idempotency (why MFL is never called twice for the same execution):** the execution ledger
(`trade_execution.js`) acquires a compare-and-set lock (`not_executed`/`blocked_cap` →
`executing`) **before** any MFL call (`trade_execution.js:97-114`; `trade_3way.js:1200-1215`;
`index.js:39976-39997`); a duplicate call finds the row already locked and is refused
(`index.js:39990-39995`). Independently, MFL's own "Duplicate trade offer" response is treated as
*proof the offer already exists*, not a failure (`trade_3way.js:121-130`). **[verified]**

**Partial-success handling that already exists today** (the direct precedent this design reuses),
from `execute3Way`: a later leg failing after an earlier leg landed is **never rolled back** — MFL
has no undo for a completed trade (`trade_3way.js:19-21`) — the row is marked `failed` naming
exactly which trade ids landed, the **execution ledger** moves
`executing → executed_needs_review` (permanent) carrying that evidence, a `🚨 partial` DM goes to
the commissioner (`trade_3way.js:1150-1155,1244-1246`). If **no** leg landed, the ledger instead
reverts to `not_executed` for a clean retry (`:1255`), except a commissioner-lockout failure,
which gets a dedicated "toggle lockout and re-run" DM (`:1247-1251`). If every leg lands but
**post-processing** fails, the trade row is `completed` (MFL genuinely executed it), the ledger
sits at `executed_needs_review`, and the DM says the trade **must not be re-run** — only the
failed step retries, via `retry3WayPostProcessing` (`:969-992,1283-1295`), which itself refuses
if any *leg* failed (`:977`). **[verified]**

**Ledger states/transitions** (`trade_execution.js:24-47`): `not_executed → executing →
mfl_executed → postprocessing → completed`, with `executed_needs_review` and `blocked_cap` as
recoverable side-states. Once at `mfl_executed | postprocessing | completed |
executed_needs_review` (`MFL_DONE_STATES`), "MFL executed this" is **permanent** — never reverts.
Post-processing steps record incrementally into `steps_json` via `recordStep()` (`:180-187`).

### 1.3 No "undo a drop" mechanism exists

Nothing in the worker calls MFL to reverse a drop. **[verified]** The closest thing —
`explainClosedSeasonAnomaly` (`fcfs_contract.js:587-615`) — is a **read-only** forensic classifier
that *observes* MFL sometimes preserves a contract when the *same* franchise re-adds the *same*
player within `READD_WINDOW_SECONDS` (3600s, `:577`); it never calls MFL, and per the adjacent
comment (`:622-623`) "a described contract is never reverted" outside that narrow window. **A
conditional drop, once it actually executes against MFL, is permanent.** There is no path that
restores the player or their prior contract terms; a re-add is a fresh acquisition, not a
reversal.

---

## 2. Neither automatic ordering is assumed safe — both, in full — and Keith's ruling

**Keith's ruling (2026-09-29): "Do not choose automatic trade-first or drop-first yet. Stage
and collect each owner's named-player consent, then hold conditional-drop deals for
commissioner review. Present the exact manual execution procedure and its non-atomic risks
before any real drop or trade is attempted."** Neither §2.1 nor §2.2 below is chosen. §2.4 is
— not as a fallback, but as the decided interim model: no automated write of either kind exists
or is approved. §2.1/§2.2 remain in this document because they are exactly why an automated
ordering is not the safe default right now; §2.4 is the actual procedure.

There are exactly two ways to sequence "the trade" and "the conditional drop(s) it requires" IF
either were automated. Both have a real, irreducible failure mode, because MFL gives no way to
make the pair atomic (§2.5). §2.1/§2.2 present both completely and state the residual risk
plainly, as the reasoning behind Keith's ruling not to automate either one yet.

### 2.1 Ordering A — TRADE FIRST, drop(s) after — NOT THE DECIDED PROCEDURE (Keith's ruling, 2026-09-29, §2.4.3b)

**Kept for the record, not deleted: this is the option Keith's ruling did NOT choose.** *"My
ruling for the design is drop-first under manual commissioner review when a trade requires
conditional loaded-contract drops. The five-loaded maximum is a hard limit; I do not want the
trade executed first and the team left over five while a drop is outstanding."* Everything below
remains accurate analysis of what this ordering would mean; it is not the procedure §2.4.3b
specifies.

**Mechanism:** the trade executes via the existing, unmodified path (§1.2 — owner session for a
2-way accept, `executeCommishTwoPartyTrade` legs for a 3-way). Once the ledger reaches
`mfl_executed` (permanent), each confirmed drop runs as a **post-processing step**, in the same
place extension/salary-adjustment steps already run.

**Failure mode: the trade completes, a drop then fails.** Every specific case Keith asked about:

- **Commissioner lockout is ON at drop time.** The drop's commissioner-impersonated call
  (§4) fails the identical way an `executeCommishTwoPartyTrade` leg already does under lockout
  (`trade_3way.js:113-120,170-172`, an existing, shipped, exact-string detection). The ledger
  moves to `executed_needs_review` (not `not_executed` — the trade already happened and must stay
  final); the DM tells the commissioner to toggle lockout and re-run *only the drop step*
  (mirroring the existing "toggle lockout and re-run" DM, §1.2, but scoped to post-processing so
  it can never re-attempt the trade itself).
- **MFL refuses the drop outright** (a real, explicit MFL error — not ambiguity). Same landing
  spot: `executed_needs_review`, the refusal reason recorded verbatim in `steps_json`, DM to the
  commissioner. No retry is attempted automatically; retrying requires a human to look at *why*
  MFL refused (the player already isn't on that roster for some other reason, a roster-size
  constraint, etc.) before deciding whether to reattempt or resolve manually.
- **Verification comes back ambiguous** (the roster-read itself fails, or times out — §1.1's own
  "not idempotent, don't resend" case). The step is recorded as `unconfirmed`, not `failed` and
  not `done` — a materially different state, because "we don't know" must never be silently
  treated as either outcome. `executed_needs_review`, DM says explicitly "we could not confirm
  whether this drop happened — check the roster before doing anything else" (never "it failed,"
  which would risk a double-drop on manual retry; never "it succeeded," which would risk leaving
  a real violation unresolved).
- **Owner notification.** In every one of the above, the AFFECTED OWNER (not just the
  commissioner) needs to be told their trade executed but their own drop did not confirm —
  otherwise an owner could reasonably believe the deal is fully settled while still sitting over
  the limit through no further fault of their own. This is a **new** notification path this
  design doesn't yet specify precisely (mirrors the existing commissioner DM's content, addressed
  to the owner too) — flagged as unresolved in §8, not assumed.
- **The period above five.** From the moment the trade lands to the moment its drop(s) confirm,
  the affected franchise is **genuinely, verifiably over the 5-loaded-contract limit** — this is
  real, not hypothetical, for as long as the post-processing step takes (ordinarily seconds; on a
  lockout or ambiguous-verification failure, potentially indefinitely, until a human resolves it).
  During that window: the franchise's own further trades are still correctly gated (the live
  `evaluateTradeCompliance` count includes every rostered loaded contract regardless of how it
  got there — confirmed directly this session against HammerTime's live roster, §9); nothing else
  in the app currently reads "loaded-contract count" as a gate on anything OTHER than a new
  trade, so there is no other rule this window would silently violate. But the window is real,
  and if a drop step sits `executed_needs_review` unresolved for an extended time (a lockout no
  one notices, say), the franchise stays over the limit for that entire span with no automatic
  escalation beyond the original DM. **[open question]** whether a stale `executed_needs_review`
  drop needs its own aging alert (re-DM after N hours unresolved) is not decided here.

**What this ordering does NOT risk:** the trade itself is never put at risk by a drop failure —
every party who agreed to the deal gets it, full stop, and the only open question afterward is
bookkeeping (is this franchise still over 5, and does someone need to fix that).

### 2.2 Ordering B — DROP(S) FIRST, trade after — THE DECIDED PROCEDURE (Keith's ruling, 2026-09-29, §2.4.3b)

**This is the ordering Keith's ruling chose.** The failure mode below (an irreversible loss if the
trade then fails) is real and is not softened by the ruling — §2.4.3b is the concrete procedure
that follows from choosing this ordering anyway, plus, per Keith's explicit instruction, an honest
account of what can and cannot be restored when that failure mode happens.

**Mechanism:** each confirmed drop executes (commissioner-impersonated, §4) *before* the trade is
attempted. Only once every affected franchise's drop(s) are confirmed does the trade itself
execute via the normal mechanism.

**Failure mode: a drop completes, the trade then fails.** This is the mode the original v1 doc
flagged and is not retracted here — it is fully as real under a from-scratch analysis:

- **The drop is irreversible the moment it lands** (§1.3) — including whatever real cap
  dead-money penalty it carries (the existing, separate, async `ups_drop_events` cron will pick
  it up regardless, §1.1/§3.6). If the trade that justified the drop then fails for *any* reason —
  a cap check that changed in the interval, MFL commissioner lockout **on the trade itself** (a
  separate, later exposure to the exact same lockout risk Ordering A has on the drop), a
  transient MFL error, a race where an asset changed hands elsewhere between drop and trade — **the
  team has permanently lost a real roster player for a trade that never happened.** There is no
  partial credit, no "at least the drop half worked" — the team is strictly worse off than before
  they agreed to anything, and the OTHER side(s) of the trade got nothing either.
- **Commissioner lockout, MFL refusal, and ambiguous verification all recur here too** — just on
  the *trade* call instead of the drop call, with a categorically worse consequence each time,
  because the thing that already, irreversibly happened is the loss, not the gain.
- **Owner notification** is, if anything, more urgent here: an owner needs to know immediately
  that they lost a player and the trade did NOT go through, so they can decide whether to try to
  reconstruct the deal, ask the other side to re-offer, or escalate to the commissioner — this is
  not "your bookkeeping is temporarily off," it's "you are down a player with nothing to show for
  it."
- **The period above five does not exist under this ordering** — the drop lands before the trade,
  so the franchise is never, at any observable moment, over the limit because of this
  transaction. If "being over 5, even briefly, even automatically-correcting" is itself something
  the league should never observe (as opposed to a bookkeeping nicety), that is a real point in
  this ordering's favor, and it is the one thing Ordering A cannot offer.

**What this ordering does NOT risk:** the loaded-contract limit is never, even momentarily,
exceeded by this transaction.

### 2.3 The actual tradeoff, stated once, plainly — CORRECTED (2026-09-29)

**Keith's correction:** *"Calling trade-first 'soft/recoverable' understates the case where the
trade completes and a required drop cannot: the team remains over the five-loaded-contract
limit, potentially for an extended period."* He is right, and the prior wording of this
paragraph was too soft. Recorded plainly:

Ordering A (trade first) risks the franchise sitting **genuinely, verifiably over the
5-loaded-contract limit** for as long as its compensating drop(s) stay unresolved — seconds in
the ordinary case, but **potentially indefinitely** if the failure requires a human to notice and
act (§2.1's own closing paragraph already says this: "the window is real, and if a drop step sits
`executed_needs_review` unresolved for an extended time... the franchise stays over the limit for
that entire span with no automatic escalation beyond the original DM"). Calling this "soft" is
only true in the narrow sense that no asset is lost — it is not true in the sense that matters for
the rule itself: the limit this whole design exists to enforce is, for real and for however long
it takes a human to fix it, not being enforced.

Ordering B (drop first) never puts the franchise over the limit because of this transaction
(§2.3.1 below proves this from the actual compliance code, not by assertion) — at the cost of a
**hard, irreversible** failure mode: a real, permanent asset loss with no compensating trade,
whenever the *subsequent* step — the trade itself, now the second operation — fails for the same
ordinary reasons (lockout, refusal, ambiguity) that can hit either operation in either order.

Neither of these is free, and neither is disqualifying on its own — one is a real, open-ended
compliance failure with no asset loss; the other is a real, largely-irreversible asset loss with
no compliance failure. This is a genuine value judgment about which kind of failure this league
finds more acceptable, not an engineering question with one correct answer, and Keith has not
made that call. §12 (added later in this document, then itself corrected on 2026-09-29 for
prematurely treating this as decided) tracks this as the same still-open question.

### 2.3.1 Can any sequence guarantee the limit is never temporarily exceeded? — a direct answer

**Yes, with one real qualification — Ordering B (drop-first) can structurally guarantee it, but
only for exposure the trade itself would have caused; it cannot instantly cure a franchise that
was already over the limit before this trade was ever proposed.**

This follows directly from how `evaluateTradeCompliance` already computes both numbers today
(`worker/src/trade_cap_authority.js`), not from a general argument about ordering:

- **`loadedBefore`** (line 254) counts loaded contracts on the franchise's **live, pre-trade**
  roster (`R.byFranchise[fid]`, an actual current-state fetch, not a projection).
- **`loadedAfter`/`projected`** (lines 277, 298, 312-313, 365) starts from `loadedBefore` and
  applies the trade's own net effect — `-1` for each loaded contract this franchise sends away,
  `+1` for each loaded contract it receives — this is the number the 5-contract limit is actually
  checked against, and it is **never true on MFL until the trade itself executes.**
- **The drop candidates a franchise's owner can select from** (lines 392-393, `candidates =
  Object.keys(roster).filter(...)`) are drawn from that SAME live pre-trade roster
  (`R.byFranchise[fid]`), explicitly excluding anything already being sent away in this trade
  (`sentTokensByFranchise[fid]`). **A drop candidate is therefore always a player the franchise
  already, actually holds right now — never one of the incoming assets this trade would deliver,**
  which don't exist on that roster yet to select from.

Put together: if every required drop for a franchise is confirmed **before** the trade's incoming
assets ever land, that franchise's live MFL roster only ever loses loaded contracts (from the
drops) before it can gain any (from the trade) — it cannot pass through an over-5 state caused by
*this transaction*, because the state that would need to be corrected (the incoming assets being
live) never exists before the correction (the drop) already has. Ordering A has no equivalent
guarantee: the incoming assets land the moment the trade executes, and the compensating drop is
strictly the *next*, separate, independently-fallible step — there is no code path today, and
none proposed in this document, that makes those two things atomic (§2.5).

**The qualification:** this only protects against overage *this transaction would cause*. If a
franchise is **already** over 5 loaded contracts on its live roster for reasons that predate this
trade entirely (nothing today enforces the limit continuously — it is only ever checked at trade
time, which is exactly how HammerTime's live roster reached 6+ before anyone noticed, §9), no
ordering fixes that pre-existing overage instantly: the franchise stays over 5 until **all** of
its required drops land, and that takes the same non-zero, sequential time regardless of whether
the trade happens before, after, or in between them. Ordering B's guarantee is specifically that
**the trade never makes an already-compliant franchise's overage worse, or creates a fresh one**
— not that it can teleport a pre-existing violation to zero.

**This is the limitation §3 (item 4, below) and the commissioner queue banner must show, and now
do:** drop-first can promise "the limit itself is never exceeded by this deal," but only by
accepting the real risk of an irreversible loss if the trade side then fails; trade-first avoids
that irreversible loss, but cannot make the equivalent promise about the limit. No sequence gets
both. Which one to prefer — or whether to decide per-deal rather than fix a rule — is Keith's call
(§11), not this document's.

### 2.4 THE DECIDED MODEL (Keith, 2026-09-29): stage consent, hold for commissioner review

Given MFL genuinely cannot make "drop + trade" atomic (§2.5), and given Keith has not approved
automating either ordering, the decided model is: **collect consent through the system, execute
nothing through the system.** A human performs every irreversible write the deal requires — one
or more drops, across one or more franchises, plus the trade itself — in whatever sequence the
specific deal calls for, using the exact terms the system already computed and showed the owner
— never re-deriving them by hand, never guessing.

**2.4.1 What "staged" means here.** Once a franchise's conditional-drop selection reaches
`needs_drops` **and** `satisfied` (every required drop chosen, validated against that
franchise's own roster — the mechanism §8.2 already ships, unchanged), the deal does **not**
proceed to any write. It moves into a **commissioner-review queue** instead — a new state,
distinct from every existing trade state, that this design's `LOADED_CONTRACT_DROP_EXECUTION_LIVE
= false` flag already guarantees can never fall through to a real MFL call (`trade_cap_authority
.js`'s `loadedContractsPermitsWrite()`, §8.1 above — unchanged by this section, still the single
gate every enforcement point calls).

**2.4.2 What the commissioner sees.** A Front Office review panel — new UI, not built by this
document — lists every queued deal with, per §3's already-specified consent requirements, made
visible to the commissioner rather than only to the confirming owner:
- The full trade terms (every asset moving, every side) exactly as both/all parties agreed to
  them — never re-summarized or re-derived, read directly from the stored offer/3-way row.
- Each required drop, **by player name**, per franchise, exactly as the owner selected and
  confirmed it (§3.1).
- Each drop's **expected cap penalty**, from the same `GET /api/cap-penalty/preview` call the
  owner saw before confirming (§3.2) — re-read fresh at review time, not cached from
  confirmation time, since real time may have passed and the penalty depends on live cap state.
- A live, final `evaluateTradeCompliance` re-check (§5) — confirming the deal would still clear
  every gate (cap, loaded-contract, lineup) if executed **right now** — surfaced plainly, not
  buried; a queued deal that has gone stale (a roster changed since staging) must show that
  before the commissioner acts on it, not after.

**2.4.3 The manual execution procedure — every partial state, not an assumed sequence.**

**Keith's correction to the prior revision of this section:** *"after one confirmed drop, a
later drop or the trade can fail. The statement that a failure means 'nothing was taken from
anyone' is false. Do not treat a human following a checklist as an atomic transaction or
approve drop-first by default. Document each partial state, owner notification, and recovery
before selecting an execution order."* The prior revision prescribed drops-before-trade and
claimed a mid-sequence failure cost nothing — true only when the very FIRST write in the
sequence is the one that fails, and false for every other failure point once a deal requires
more than one irreversible write (two or more drops, possibly across two or more franchises in
a 3-way, plus the trade itself). This revision does not prescribe an ordering and treats every
boundary between writes as a point where real, permanent loss can already exist.

A queued deal's execution is a sequence of **N independent, irreversible MFL writes** — every
required drop (one per selected player, potentially spanning more than one franchise) plus the
trade itself — performed one at a time, in whatever sequence the specific deal calls for (§2.4's
opening paragraph already leaves this to the deal; this section does not narrow it to
"drops first" by default, per Keith's instruction). Before and during EACH write in that
sequence:

1. **Re-run the final compliance check** (§2.4.2) fresh, immediately before THIS write — not
   only before the first one. If it no longer clears, STOP before this write, regardless of how
   many prior writes in the sequence already succeeded; do not proceed on stale numbers.
2. **Perform the one write, then verify it actually happened** before treating it as done (§1.1's
   mandatory roster re-read for a drop, never trusting MFL's response text alone; the equivalent
   verification discipline for the trade call itself). Never batch writes on the assumption they
   will all succeed together — MFL gives no such guarantee for any of them.
3. **Record the verified outcome in the execution ledger** (§6's existing vocabulary) before
   moving to the next write in the sequence, so the deal's true partial state is always readable
   from the ledger, never reconstructed from memory.

**Every partial state this sequence can stop in, what it means, and its recovery:**

- **State 0 — nothing executed yet.** Compliance failed the re-check (step 1) before any write
  was attempted. The deal returns to the review queue unchanged, with the reason recorded.
  Recovery: none needed — nothing real happened. Notification: informational only, to the
  commissioner and the deal's owners, that it's paused rather than lost.
- **State *k*, for `1 <= k < N`** — **some writes confirmed, the sequence stopped before
  completing.** This is the state Keith's correction is about, and it is never costless. Whichever
  writes ARE confirmed at this point are real and irreversible: a confirmed drop means a player
  is genuinely gone from that roster, with its real cap dead-money penalty already accruing
  (the existing async `ups_drop_events` cron picks it up regardless of what happens to the rest
  of the sequence, §1.1/§3.6); a confirmed trade leg ahead of a still-pending drop means those
  assets have already changed hands. If the NEXT write then fails, refuses, or comes back
  ambiguous, the deal stops in state *k* — permanently, until a human resolves it:
  - **`partial_executed` is a PROPOSED ledger state — part of this design, not a state that
    exists in the shipped execution ledger today.** Unlike `executed_needs_review`/
    `blocked_cap` (§6, both real, already-shipped states the ledger already has), no code
    anywhere writes or reads `partial_executed` yet; it is named here because the existing
    vocabulary has no state that means "some but not all of a multi-write sequence
    completed," and the ledger will need one before any of this section becomes real. If and
    when this design is implemented, it would record exactly which of the *N* writes
    confirmed and which failed or never ran.
  - **Every owner whose asset already moved — a confirmed drop, or a confirmed trade leg — must
    be notified immediately and explicitly** that their side executed but the rest of the deal
    did not, and that it is now paused for commissioner resolution. Never left for an owner to
    discover on their own by noticing their roster changed.
  - **Recovery is not automatic and is not "just retry the failed write."** The commissioner
    must first understand WHY that write failed (lockout, a genuine MFL refusal, an unrelated
    race) before deciding whether to retry the remaining writes or to negotiate a compensating
    resolution with the affected owner(s) for the loss already incurred. This document does not
    prescribe that compensating mechanism — it is exactly the kind of judgment call this whole
    design routes to a human instead of automating, and is listed unresolved in §11.
  - This state can persist indefinitely (§2.4.4 already flags the commissioner as a single point
    of failure) — whether a stuck `partial_executed` deal needs its own aging alert is listed
    unresolved in §11, the same open item §2.1 already raised for `executed_needs_review`.
- **State *N*** — **every write confirmed.** The deal completed exactly as every party agreed to
  it. Ordinary success notification to every party, same as any other completed trade.

**This analysis is symmetric regardless of which write the commissioner performs first** — a
default "drops first" sequence was specifically what Keith's correction removed, and it is not
reintroduced here: whether the sequence is drop/drop/trade, drop/trade, trade/drop, or any other
order a specific deal calls for, the identical state-*k* analysis applies to whichever write is
not yet confirmed when a later one fails. Which sequence to prefer, if any — and whether that
should be a fixed rule or the commissioner's judgment per deal — remains unresolved (§11), now
informed by this being a real, consequential choice either way, not a free one.

**2.4.3a The canonical two-write case, worked in full — the analysis that informed the ruling
below, kept as the record of why.** §2.4.3 above is deliberately general
(N writes, any order). Keith asked for it concretely, for both partial-outcome directions, against
five specific questions: what is verified before each write, what the ledger records after each
confirmed write, who is notified immediately, what further actions are blocked, and how the
commissioner resolves or escalates. Worked here for the simplest real case — one required drop,
one trade — which generalizes to N drops exactly as §2.4.3 already describes (run the same
per-write discipline once per write, in whichever order the deal calls for).

**Before EITHER write, in either order:** the commissioner re-runs the same live
`evaluateTradeCompliance` the owner last saw (§2.4.2) — not a cached number — and confirms the
recipient (2-way) or all parties (3-way) actually accepted. If it no longer clears, stop; nothing
below applies yet.

| | **Order A: trade, then drop** | **Order B: drop, then trade** |
|---|---|---|
| **1. Verified before this write** | The trade's own terms are re-confirmed unchanged since staging (assets still on the right rosters, nothing double-spent) — the same check `accept2WayTrade`/`execute2Way` already run. | The selected drop is re-confirmed still valid: still on that franchise's roster, still resolves as a loaded contract, not one of the assets this trade would send away (`trade_cap_authority.js` lines 376-388 — the same validation `evaluateTradeCompliance` already runs on every read, re-run here immediately before the write, not trusted from an earlier read). |
| **2. Write + verify** | `executeCommishTwoPartyTrade` (existing, §1.2) — MFL's response is never trusted alone; the roster is re-read afterward exactly as §1.1 already mandates for a drop, applied here to the trade leg too. | `POST /roster-workbench/action {action:"unload_player"}` (existing, ERA-gated, already used by the ERA auto-drop sweep) — it already re-fetches the live `rosters` export after posting and refuses (`ok:false`) unless the player is confirmed off that roster; an inconclusive re-fetch must be treated as `unconfirmed`, never `failed` or `done` (§2.1's own rule, applies identically here). |
| **3. Ledger, if this write is CONFIRMED and the next one hasn't run yet** | Row moves to the proposed `partial_executed` state (§2.4.3); `steps_json` (proposed, not yet a real column — §11) records `{trade: "confirmed", drop: "pending"}` with the MFL trade id as evidence. | `steps_json` records `{drop: "confirmed", trade: "pending"}` with the drop's own verified-roster evidence (the same `verification` object `unload_player` already returns). |
| **3b. Ledger, if this write is CONFIRMED and then the NEXT write FAILS or comes back ambiguous** | `steps_json` updates to `{trade: "confirmed", drop: "failed"\|"unconfirmed", reason: "<verbatim MFL/lockout reason>"}`; row stays `partial_executed` — never rolls back to `not_executed` or forward to `completed`. | `steps_json` updates to `{drop: "confirmed", trade: "failed"\|"unconfirmed", reason: "<verbatim reason>"}`; same rule — stays `partial_executed`. |
| **4. Notified immediately** | Both franchises' owners (`dmAll` to `from_discord_ids`/`to_discord_ids`, the same existing helper `execute2Way` already calls) — told the trade is real and done, but the compensating drop did not confirm, so their roster may still read over the limit; the commissioner (`dmCommish`, existing) — told specifically that the DROP step needs attention, with the failure reason verbatim (never re-summarized), so lockout vs. a genuine MFL refusal vs. ambiguity are distinguishable at a glance. | Both owners — told the drop is real and done (a real player is gone, a real cap penalty is accruing), but the trade itself did not confirm, so nothing was received in return; the commissioner — told the TRADE step needs attention, same verbatim-reason discipline. |
| **5. Further actions blocked** | This specific deal: no further automatic action (§2.4 has none anyway). This FRANCHISE: any NEW trade offer touching it should be held from staging-to-review until this `partial_executed` deal resolves — its true loaded-contract count is only "verifiably over 5, pending a drop" (a known, bounded uncertainty; §11 notes this is not yet enforced anywhere in code and should be before real writes ship). | Same per-franchise hold, for the opposite reason: this franchise's true roster composition is uncertain until the trade's outcome is known (did the counterparty's assets arrive or not) — a NEW deal proposed against it right now would be built on an unverified premise. |
| **6. Commissioner resolves or escalates** | Re-pull the live `rosters` export directly (the same call `unload_player`'s own verification already makes) to get ground truth, independent of what the ledger last recorded. If the reason was `lockout`, toggle it off and retry ONLY the drop step (`unload_player` is idempotent — retrying when the player is already gone is a safe no-op, confirmed by its own pre-write roster read). If it was a genuine MFL refusal (the player already isn't there for some other reason), do not retry blind — resolve manually with the affected owner first. If verification itself was inconclusive, re-check before assuming either outcome — never re-attempt a write whose own prior attempt's outcome is unknown, mirroring the ledger's own "ask MFL, never retry blindly" rule (§6, `trade_execution.js`'s own header comment). | Same re-pull-live-truth-first discipline, applied to the TRADE call: `execute2Way`'s own ledger (`EXEC.EXECUTING`) already refuses to re-attempt a trade whose outcome is ambiguous — that existing guard is reused here, not re-implemented. If the trade genuinely failed and cannot be salvaged, the commissioner must negotiate a **compensating resolution** with the affected owner for the drop already lost — this document does not prescribe that mechanism (§11); there is no automated "give the player back" — the closest thing that exists is the manual, largely-fragile reinstatement path (free-agent re-add + contract restore, contingent on nobody else having claimed the player since), not a real undo. |

**The asymmetry this table makes concrete:** Order A's row 6 has a real, if manual, recovery path
for its failure (retry the drop, or fix lockout and retry). Order B's row 6, on a trade failure,
has no recovery path at all for the asset already lost — only a negotiated compensation the
commissioner must invent case-by-case. This is the same conclusion §2.3.1 reaches from the
compliance math; this table reaches it independently from the recovery mechanics, which is why
§2.3's revised framing no longer calls Order A's failure mode simply "soft" without also stating
plainly what Order B's failure mode costs instead.

### 2.4.3b THE DECIDED PROCEDURE (Keith's ruling, 2026-09-29): drop-first, worked concretely, with an honest restoration account

**The ruling, verbatim:** *"My ruling for the design is drop-first under manual commissioner
review when a trade requires conditional loaded-contract drops. The five-loaded maximum is a
hard limit; I do not want the trade executed first and the team left over five while a drop is
outstanding."* This decides the ordering §2.3/§2.3.1/§2.4.3a left open. **It does not authorize
any production drop or trade** — §2.4's model (stage consent, hold for commissioner review, write
nothing) is unchanged; this section specifies what the eventual manual procedure must do, once
built, not a green light to build and ship it now.

**Scope of the ruling:** applies whenever a franchise's own drop selection is required for a
trade to clear (`needs_drops`, §2.4.1). It says nothing about, and does not change, any trade that
clears without a required drop (`evaluateTradeCompliance` returns `ok`) — those still execute via
the existing, unmodified §1.2 path with no drop involved at all.

**The procedure, in order, for a deal requiring drops across one or more franchises:**

**Step 0 — verify the trade can proceed, before the first drop.** Keith's explicit first
requirement. Re-run the same live `evaluateTradeCompliance` the owner and commissioner last saw
(§2.4.2) — cap, roster, lineup, and every franchise's drop selection still valid against the
CURRENT roster, not a cached read. Confirm the recipient (2-way) or every party (3-way) has
actually accepted, and the offer has not been cancelled or superseded since. **This step reduces,
but cannot eliminate, the risk of dropping a player for a trade that then fails** — it catches
every condition this app can already see (stale terms, a lapsed acceptance, a compliance check
that no longer clears); it cannot see MFL's own live commissioner-lockout state in advance
without attempting a write, because no live, independently-verified read of that setting exists
in this codebase today. (`worker/src/index.js:57391` reads a `commissioner_lockout` field from
MFL's `TYPE=league` export for an unrelated purpose — selecting a UI default franchise — and its
reliability as a true pre-flight lockout signal has **not been independently verified this
session**; using it as a real pre-flight gate is a candidate for later work, not something this
design relies on now.) If Step 0 fails, stop — nothing has been written, the deal returns to the
review queue exactly as §2.4.3's "State 0" already specifies.

**Steps 1..N — each required drop, one at a time, across every franchise that owes one.** For
each drop, in turn (order between different franchises' drops does not matter to each other; see
§2.3.1 — what matters is that every drop happens before the trade):

1. **Verified immediately before this write:** the selected player is still on that franchise's
   roster, still resolves as a loaded contract, and is not one of the assets this trade would
   send away (`trade_cap_authority.js` lines 376-388, re-run fresh, never trusted from an earlier
   read — §2.4.3a row 1).
2. **Snapshot, then write, then verify** — the write itself is the existing, tested
   `POST /roster-workbench/action {action:"unload_player"}` path (ERA-gated, already used by the
   ERA auto-drop sweep), which already re-fetches the live `rosters` export after posting and
   refuses (`ok:false`) unless the player is confirmed off that roster. **New for this design:**
   immediately BEFORE calling `unload_player`, capture that same player's live `salary`,
   `contractStatus`, `contractYear`, and `contractInfo` from the pre-write `rosters` read that
   verification already performs the shape of — this is the exact pre-drop contract, straight
   from MFL, not reconstructed later from auction records or any other secondary source (see
   "What can and cannot be restored" below for why this matters). An inconclusive post-write
   re-fetch is recorded as `unconfirmed`, never `failed` or `done` (§2.1's rule, unchanged).
3. **Ledger record, immediately, before the next drop or the trade:** the row moves to the
   proposed `partial_executed` state (§2.4.3); `steps_json` (proposed, not yet a real column —
   §11) records this drop as `{player_id, franchise_id, status: "confirmed"|"failed"|"unconfirmed",
   pre_drop_snapshot: {salary, contractStatus, contractYear, contractInfo}, mfl_verification:
   <the exact object unload_player already returns>, confirmed_at_utc}`.
4. **Notified immediately:** the affected owner (a real player is gone from their roster, a real
   cap dead-money penalty will accrue via the existing, separate `ups_drop_events` pipeline —
   §1.1/§3.6, unchanged and not sped up by this design) and the commissioner (this specific step's
   outcome, verbatim MFL evidence, not summarized).
5. **If this step FAILS or comes back UNCERTAIN, stop the entire sequence right here** — do not
   attempt the remaining drops, and do not attempt the trade. The deal stays `partial_executed`
   with exactly this drop's status recorded; every already-confirmed drop before it stands (real,
   irreversible, already happened); every drop after it in the plan never ran.
6. **Further actions blocked while ANY step of this deal is unresolved:** this franchise may not
   be offered or accept a NEW trade until this deal resolves — its true loaded-contract count is a
   known, bounded uncertainty (some drops confirmed, the rest pending) that a fresh, unrelated deal
   must not be built on top of (§2.4.3a row 5, unchanged).
7. **Commissioner resolves or escalates a failed/uncertain drop step:** if MFL's response itself
   was an explicit, verified refusal (lockout text, or the write's own post-check proving the
   player is still there), the outcome is already known — fix the cause (toggle lockout off,
   etc.) and retry. If instead the step is `attempting` or `unconfirmed` — this code doesn't
   itself know what happened — a RESUME first RECONCILES before doing anything else (below);
   only once reconciliation resolves the ambiguity does step 1 (a fresh write) or a hold happen.

**Reconciliation evidence — Keith's correction (2026-09-30): "roster presence alone does not
prove what happened. A player could disappear for another reason, or be dropped and re-added
before reconciliation. Use a matching MFL transaction record or other authoritative evidence
tied to the franchise, player, and attempt."** The exact evidence used, precisely, not
summarized: before either writing OR retrying a step recorded `attempting`/`unconfirmed`, the
executor queries MFL's own `TYPE=transactions&TRANS_TYPE=FREE_AGENT` export directly — the real,
authoritative record of what MFL's transaction log shows happened — and looks for a row matching
**this exact franchise, this exact player id, at or after this exact attempt's own timestamp**
(parsed via the same positional field-1 rule this codebase's existing drop-tracker already uses
and has proven live against real data — `_dropPidsFromTx`/`dropPidsFromFreeAgentTx`, duplicated
rather than imported to avoid a circular dependency). Three outcomes, never a fourth:
- **A matching transaction record exists** → CONFIRMED, authoritative, regardless of current
  roster presence — this is exactly what makes "dropped for real, then re-added to the same
  roster before reconciliation runs" safe: presence alone would say "never happened, retry,"
  wrongly attempting a second write; the transaction record instead proves the first one
  already, permanently, happened. Recorded with `reconciled: true` and the transaction's own
  evidence (`{timestamp, franchise, raw_transaction}`), never merged indistinguishably into an
  ordinary direct confirmation, so a commissioner auditing the ledger can always tell the two
  apart and cross-check MFL's own log independently if in doubt.
- **No matching transaction record, and the player is still genuinely present** on that
  franchise's roster → **held for commissioner review — NEVER automatically retried, at any
  elapsed time** (see the export-coverage correction immediately below; this bullet described an
  automatic retry in an earlier revision of this document, now superseded).
- **No matching transaction record, and the player is ABSENT** → an UNRELATED event could have
  moved them (a waiver claim, a different owner's own action, a data lag) — never assumed to be
  this attempt's own doing. Held for commissioner review, not guessed either way. This is exactly
  the case a presence-only check would have gotten wrong: "gone" was never proof it was THIS
  drop that made them gone.
- **The transaction log itself cannot be read** (no API key, a fetch failure) → held, exactly
  like the mandatory pre-drop snapshot's own failure mode — evidence unavailable is never treated
  as evidence of either outcome.

**Export-coverage proof, or the lack of it — Keith's follow-up (2026-09-30), CORRECTED a second
time the same day: "Remove automatic retry based on five minutes passing. Cache bypass and a time
buffer do not establish that MFL's transaction export is complete. A missing matching transaction
must leave the attempt unconfirmed for commissioner review unless you can prove authoritative
coverage through that attempt."** An earlier revision of this fix (same day) introduced a
5-minute buffer (`MIN_RECONCILE_AGE_MS`) that trusted a "no match" result once enough time had
passed since the attempt. Keith's correction: a time buffer is still a guess dressed up as a
rule, not a proof — this codebase has **no proof, at any elapsed time**, that MFL's own
`TYPE=transactions` export is complete through a given moment. The one existing precedent for
using this export to reconcile an ambiguous MFL write (`trade_3way.js`'s
`legExecuted`/`findExecutedTrade`) only ever uses it as SECONDARY corroboration of an
ALREADY-positive signal, never as sole proof of "nothing happened."
- **The buffer was REMOVED.** "No matching transaction record, and the player is still genuinely
  present" now ALWAYS holds for commissioner review — never retried automatically, regardless of
  how much time has passed since the attempt. The ONLY way this specific ambiguity resolves
  within this automated system is if MFL's own export LATER shows the matching transaction on a
  subsequent reconciliation pass (moving straight to `confirmed`, never through a time-based
  "retry" branch).
- **Cloudflare edge-caching is still ruled out.** `findFreeAgentDropTransaction`'s fetch still
  carries `cf: { cacheTtl: 0, cacheEverything: false }` — one proven, fixable class of staleness,
  kept even though the time buffer it was originally paired with was removed; it remains a
  legitimate, separate improvement.
- Tested directly (`tests/trade_2way_drop_first_execute.test.mjs`'s two "no auto-retry" tests):
  the SAME "present, no matching transaction" facts hold identically whether the original attempt
  was 30 seconds ago or 10 days ago — elapsed time makes no difference at all, proving no
  time-based path back to "retry" survives anywhere in this code.

A step recorded `attempting`/`unconfirmed` but no longer part of the freshly-recomputed required
list (the requirement itself recomputes from the live roster every time, §2.3.1 — once a drop
genuinely lands, the very next read may already show one fewer drop required) goes through the
SAME reconciliation, in its own pass, before the main sequence even starts — otherwise that
step's record would sit stuck forever, never revisited because it's no longer "required." An
ambiguous result here still stops the WHOLE sequence, even though the specific step is no longer
required — an unresolved ambiguity anywhere in this deal is reason enough to hold the rest of it,
not something to quietly complete around.

**Idempotency, stated to its actual scope, not claimed beyond it (Keith: "Do not describe
retries as idempotent beyond what those tests and MFL's actual behavior establish"):** what is
proven, by the tests in `tests/trade_2way_drop_first_execute.test.mjs`, is that this
orchestrator's own retry logic never repeats a write already recorded `confirmed`, and never
attempts or re-attempts a write for a step whose outcome reconciliation cannot positively
resolve. This is NOT a claim that `/roster-workbench/action`'s own internal handling of a
literal duplicate POST has been independently verified, nor that MFL's own systems are
idempotent to a repeated identical request — only that this orchestrator's own decision of
whether to issue a write at all is now evidence-based, never a guess from roster state alone.

**Only once EVERY required drop, for every franchise in this deal, is confirmed** does the
sequence proceed to the trade itself.

**The trade write gets the SAME write-ahead + reconciliation discipline as a drop — Keith's
ruling (2026-09-30): "Track the trade write as a step too. A crash after MFL executes the trade
but before the ledger records it needs the same write-ahead and reconciliation discipline as a
drop. Show how duplicate trade execution is prevented when the response is lost."** Built exactly
that way in PR #1163 (`runTradeLegAfterDrops`, `reconcileTradeLeg`, `completeTradeLeg`):
- A `trade` step is recorded `{status:"attempting", from_fid, to_fid, attempted_at_utc}` in
  `steps_json` BEFORE `executeCommishTwoPartyTrade` is ever called — the identical fix Keith
  required for drops, applied here for the first time.
- If `executeCommishTwoPartyTrade` itself reports `!ok` (a lockout, a genuine MFL refusal, a
  network-level exception with zero information, or anything in between), the code does **not**
  immediately declare the player-loss outcome. It ALWAYS reconciles first — querying MFL's own
  `TYPE=transactions&TRANS_TYPE=TRADE` export directly (`findExecutedTrade`/`toMflAsset`, the
  SAME functions the 3-way engine's own `legExecuted` already uses, not a second implementation)
  for a record matching this exact from/to/give/receive since the attempt. A match means the
  write actually reached MFL despite the bad response — completed in the SAME pass, never
  conflated with a plain retry. No match (or the evidence source itself unreadable) means HELD —
  symmetric with the drop-side fix above, **never auto-retried at any elapsed time either**.
- **This is what makes duplicate trade execution structurally impossible when the response is
  lost**, not merely handled by convention: once a `trade` step is recorded `attempting` or
  `unconfirmed`, EVERY subsequent pass (a resume, or the tail of the same pass) reconciles FIRST
  and unconditionally — `executeCommishTwoPartyTrade` is never called a second time once any
  uncertainty is already on record for this deal's trade step. The only two ways this code ever
  calls MFL's propose/accept endpoints for a given deal are: no `trade` step exists yet at all, or
  (defensively) one exists and already reads `confirmed`, in which case it's skipped entirely.
- **Owner-facing copy now names which players and teams were actually dropped** in a partial
  multi-team deal (Keith, 2026-09-30) — `summarizeConfirmedDrops` reads straight from the ledger's
  own recorded `drop:*` steps (never re-derived from the original requirement, which could differ
  from what actually landed) and is threaded into every trade-leg notification, including the
  player-loss DM.
- A REAL, pre-existing state-machine bug was found and fixed while testing this: the trade leg's
  own ledger-state transitions only accepted `from: EXEC.PARTIAL_EXECUTED`, but a RESUME where
  every required drop was already `confirmed` from a prior pass leaves the row at `EXEC.EXECUTING`
  (`resumeDropSequence`'s own claim always moves there; the drop loop's "already confirmed, skip"
  branch never moves it back) — so the trade leg's own completion/hold transitions silently failed
  (swallowed by their own `.catch(() => {})`) in exactly that resume scenario, leaving the ledger
  stuck at `executing` forever even though `ups_2way_trades.status` correctly reached `completed`.
  Fixed by accepting `from: [EXEC.EXECUTING, EXEC.PARTIAL_EXECUTED]` everywhere the trade leg
  transitions the ledger, matching the pattern every OTHER multi-state transition in this file
  already uses. This bug existed in the ORIGINAL (pre-this-pass) code too, silently, because no
  test previously exercised "resume with every drop already confirmed, nothing left to attempt
  except the trade leg" — exactly the scenario this pass's own new tests were built to cover.

**What can and cannot be restored if a drop succeeds but the trade then fails.** Keith: *"Do not
describe restoration as guaranteed unless MFL behavior proves it."* It is not guaranteed. Stated
precisely, not softened:

- **No automated reversal exists, and none is proposed here** (§1.3, unchanged: "nothing in the
  worker calls MFL to reverse a drop... a re-add is a fresh acquisition, not a reversal"). Nothing
  in this design changes that. What follows is a **manual workaround a commissioner can attempt**,
  not a system feature.
- **What CAN plausibly be restored, and how:** if the player is STILL a free agent when the
  commissioner notices and acts, the commissioner can (1) re-add the player to the SAME
  franchise's roster via MFL's native free-agent add, impersonating that franchise (the exact
  mechanism used successfully once already for an accidental-drop incident — `reference_mfl_
  roster_reinstatement_mechanism`), then (2) restore the EXACT pre-drop contract terms via the
  existing, tested `POST /admin/import-salaries` route (dry-run first, always), using the
  `pre_drop_snapshot` this procedure's own step 2 now captures at drop time — not reconstructed
  from `ups_auction_contract_finalizations` (which only exists for auction-won players) or any
  other secondary source, closing the gap the OBJ-incident workaround depended on.
- **What CANNOT be guaranteed, stated plainly, each one a real reason "restoration" is not a
  promise this design can make:**
  - **Whether the player is still unclaimed.** The moment a drop lands, the player is a free
    agent, claimable by ANY owner (via a waiver, FCFS, or a direct free-agent add of their own) —
    entirely outside this app's control, a real race against every other owner in the league. If
    someone else claims him first, there is nothing to restore; step (1) above never becomes
    possible again.
  - **Instantaneous or atomic restoration.** Even when the player is still available, the
    workaround is itself two separate, non-atomic manual writes (re-add, then a separate
    contract-restore import) — the same class of risk this whole document is about, one level
    down. A failure between those two steps leaves the player rostered with a blank contract
    (§1.3's own MFL behavior: "the closest thing... a described contract is never reverted"
    outside the narrow same-franchise re-add window) until the second write completes.
  - **The dead-money cap penalty already charged.** The drop's own cap consequence is priced by
    the existing, SEPARATE, async `ups_drop_events`/dead-money pipeline (§1.1/§3.6), which is not
    proven to run synchronously with, or be reversed by, a later reinstatement. Restoring the
    player does not, by itself, undo whatever penalty that pipeline already recorded or posted;
    reversing it — if warranted — is a distinct, unaddressed manual correction.
  - **Taxi/IR/roster-status nuance.** A plain free-agent re-add restores active-roster membership
    only; any taxi-squad or IR designation the player held before the drop is not restored by the
    same action and would need its own explicit, separate re-application.
  - **Time already elapsed.** Whatever the player would have done on this roster in the interval
    (a lineup slot, a bye-week decision) cannot be retroactively restored regardless of how the
    rest of the workaround goes.
- **Net:** restoration is a real, sometimes-successful, always-manual, never-guaranteed mitigation
  — best attempted immediately, by the commissioner, the moment a trade failure is discovered,
  because every minute of delay is a minute another owner could claim the player. It is not a
  reason to treat the irreversible-loss risk in §2.2/§2.3 as smaller than it is.

### 2.4.3c The player-loss resolution — APPROVED AS POLICY (Keith, 2026-09-30)

**Keith's ruling: "The ranked player-loss procedure is approved as the proposed commissioner
policy: attempt restoration, then seek a facilitated replacement trade, then use the league
dispute process. 'No compensation' must never be the automatic result. This does not authorize
live execution."** The sequenced procedure below (§2.4.3c, as ranked 2026-09-30) is now DECIDED
POLICY, not a pending recommendation — but this is a policy decision only. **It does not flip
`TRADE_2WAY_DROP_EXECUTE_ENABLED` on**, and no code in this design or PR #1163 currently enforces
or automates any step of it (the commissioner still carries out each step by hand, using
ordinary MFL/league mechanisms — §2.4.3b's restoration attempt is the one piece already built,
read-only/dry-run per §12.1, no real write). The remaining release blockers are listed in §12.3.

**Every possible outcome, stated exhaustively, not just the ones with a proposal attached:**

1. **Every drop confirms, the trade confirms.** Success. No resolution needed — this is the
   ordinary case §2.4.3b's happy path already covers.
2. **A drop fails or comes back uncertain before it (or any other drop) confirms.** Nothing
   irreversible has happened for THAT step; §2.4.3b's stop-and-hold procedure applies. No asset
   is lost — this is not a player-loss case.
3. **Every required drop confirms, the trade then fails, and the dropped player is STILL a free
   agent when the commissioner notices.** §2.4.3b's manual workaround (native free-agent re-add +
   `POST /admin/import-salaries` restore from the captured `pre_drop_snapshot`) can be attempted.
   Even here, restoration is not instant or guaranteed to succeed cleanly (§2.4.3b's own honesty:
   the workaround is itself two more non-atomic writes) — but the ASSET is at least still
   available to attempt it on.
4. **Every required drop confirms, the trade then fails, and the dropped player has ALREADY BEEN
   CLAIMED by someone else (a waiver, an FCFS add, a direct free-agent pickup) by the time the
   commissioner notices.** **This is the case with no restoration path at all** — the player is
   gone, on another roster, under a contract the affected owner has no claim to. This is the case
   Keith's instruction specifically addresses: no default assumption of being "made whole," no
   silent cap-money substitution.

**For outcome 4 specifically — Keith asked for a recommended procedure and its consequences for
the owner, not an unranked menu, and then APPROVED it as policy (2026-09-30).** Below is the
decided sequence, not four independent choices. **This is now policy, but policy alone does not
authorize a real write** — `TRADE_2WAY_DROP_EXECUTE_ENABLED` stays off; nothing here is
automated, and every step is still carried out by the commissioner directly through ordinary
means (MFL's own site for a restoration attempt or a replacement trade, the league's existing
dispute process for step 3).

**The approved procedure, in order:**

1. **First, always: the restoration attempt itself (§2.4.3b, already built).** This isn't one of
   the "outcome 4" options — it's outcome 3, and it's tried automatically as part of the
   commissioner's own immediate response, before anything below is ever reached. Outcome 4 only
   exists when this has already failed (the player was claimed by someone else first).
2. **If restoration is impossible: the commissioner facilitates a replacement trade between the
   same two parties (formerly "Option A") — tried FIRST, not as one equal option among several.**
   Reasoning for ranking it first: the original counterparty never gave up their own side either
   (the trade failed entirely), so they still hold exactly what they'd agreed to send — nothing
   new has to be manufactured, no value is injected into the league from outside a trade, and it
   uses a mechanism every owner already trusts (an ordinary negotiated trade), not a new
   commissioner power. It is also the only option that can, in the best case, leave the affected
   owner close to whole rather than merely compensated.
3. **If that fails — the counterparty won't cooperate, or no fair replacement can be found —
   escalate to the league's existing rule-proposal/dispute process (formerly "Option C"), not a
   unilateral commissioner grant (formerly "Option B").** Reasoning: a loss of this weight
   deserves the same due process as any other league dispute, and routing it through the
   league's own existing mechanism avoids the commissioner unilaterally deciding how much a lost
   player was "worth" and unilaterally injecting value into the league to cover it — both of
   which Keith's instruction specifically warns against ("do not assume... or silently substitute
   cap money"). If the league's own process concludes a grant (draft pick, cap relief) is the
   right remedy, that is a decision BY the process, with the same legitimacy as any other league
   ruling — not this design defaulting to it.
4. **No compensation (formerly "Option D") is not a first-class option in this ranking — it is
   the outcome only if step 3's own process concludes that no compensation is warranted.** The
   disclosed-risk consent copy (§3 item 4) means the owner was not misled, but it does not, on
   its own, settle the question of what's owed after a real loss; that is exactly the kind of
   question step 3's process exists to answer.

**What the affected owner experiences under this policy, stated plainly, not softened:**
immediate notification that the drop is real and permanent and the trade did not go through
(§2.4.3b's player-loss DM, already built); a same-day commissioner-led restoration attempt with
no promise it succeeds; if it fails, an offer to negotiate a replacement trade — which could
resolve in hours or could stall if the counterparty is unwilling; if THAT stalls, a real,
possibly multi-day, formal dispute process before any resolution at all. **This policy does not
shrink the core risk §2.2/§2.3 already document — a real asset can still be gone with no fast,
guaranteed remedy — it commits to the most legitimate, least ad hoc ORDER of response once that
risk materializes, and it rules out "no compensation" as anything but that process's own
considered conclusion.**

**Decided policy; still not a green light to build or enable real writes.** `TRADE_2WAY_DROP_
EXECUTE_ENABLED` does not flip on from this ruling alone — §12.3 lists what remains before real
writes are enabled, independent of this policy now being settled.

**2.4.4 Non-atomic risks specific to a HUMAN performing this manually** (in addition to, not
instead of, the underlying MFL non-atomicity in §2.5, which no model here removes):

- **Delay between successive writes in the sequence is now unbounded, not seconds.** An
  automated ordering executes each step within moments of the last (§2.1/§2.2 measure the
  exposure window in seconds-to-minutes on the unhappy path). A human reviewing a queue may
  confirm one write, get interrupted, and not return to perform the next for hours — during
  which every party downstream of that write is waiting on a deal that looks (to them) like
  nothing is happening, and whichever franchise's write already confirmed has already paid its
  real cost (a dropped player's cap dead-money, or an already-moved asset) with the rest of the
  deal not yet delivered. This is a real cost of choosing the manual model over automation, not
  merely the state-*k* failure risk §2.4.3 documents but its slow-motion, still-pending cousin —
  and should be weighed against the safety benefit, not treated as free.
- **A human can skip the per-write compliance re-check, or lose track of which writes in a
  multi-write sequence are already confirmed, despite the documented procedure** — automation
  enforces its sequence mechanically; a documented procedure only enforces itself if followed.
  The review-queue UI should surface the re-check automatically before each write (never a
  separate step to remember) and show the deal's true state — which writes are confirmed, which
  remain — read live from the `partial_executed` ledger state (§2.4.3), not from the
  commissioner's memory of what they already did. Once §11 resolves which sequence a deal should
  follow (if any fixed rule at all, rather than per-deal judgment), the UI should make that
  sequence the only available action — but that sequencing decision, and the UI that enforces
  it, are both listed as unbuilt (§11), not assumed to follow from writing this procedure down.
- **A queued deal can go stale while waiting for review**, exactly as §2.4.2 already flags — the
  live re-check at step 1 of §2.4.3 is what catches this, but only if it is actually run every
  time, including on a deal that has sat in the queue long enough that the commissioner might
  (wrongly) trust the numbers they reviewed earlier without re-pulling them.
- **The commissioner is a single point of both authority and failure.** Every write in this
  model requires a human to act — if the commissioner is unavailable, every queued deal simply
  waits, with no automated fallback and no second authorized executor documented here. **Keith's
  ruling (2026-09-30): no new backup-commissioner authority is granted as part of this PR.** The
  aging alert below (§2.4.3b) is the mitigation this PR ships instead — it makes an unresolved
  wait visible and escalating, rather than silent, but it does not create a second person who can
  act. Whether a backup-commissioner path is ever built is left for a separate decision, not a
  gap in this one.

This procedure supersedes any assumption in §8.2 that staging leads directly to an AUTOMATED
final write — §8.2's step 5 ("the worker executes the real MFL trade... executes any confirmed
drop(s)") describes what happens ONLY if and when Keith later approves automating one of §2.1/
§2.2's orderings. Until then, §8.2's step 5 is this section: a human, not the worker, performs
every write the deal requires, through the review queue, following §2.4.3 exactly.

**2.4.5 An owner can never retrigger a stuck sequence — Keith's ruling (2026-09-30): "an owner
must never retrigger a failed or uncertain execution step. Only a commissioner may resume it
after reviewing the ledger and MFL evidence."** DECIDED, and — checked directly against the code,
not assumed — already structurally true almost everywhere, with one real gap found and closed:
- **`POST /api/trades/2way/execute`**, the drop-first orchestrator's own HTTP entry point, is
  commissioner-only (`isAdminCaller`) — an ordinary owner session is refused 403, server-side,
  tested directly.
- **The ledger lock itself is the deeper enforcement, independent of any route's own authz.**
  `execute2Way`'s ordinary `ledger.acquire()` only succeeds from `NOT_EXECUTED`/`BLOCKED_CAP`; a
  drop-first sequence stuck at `PARTIAL_EXECUTED` or `NEEDS_REVIEW` is in neither state, so even a
  path that reaches `execute2Way` cannot acquire the lock a second time — it safely no-ops
  (`{skipped: "execution_not_acquirable"}`). This is the same lock substrate `resumeDropSequence`
  itself uses, so the two paths can never race into a double execution.
- **The one real gap found while verifying this: `recheck2WayExecution`.** This owner-reachable
  route's own guard (`row.status === 'collecting' && row.to_state === 'accepted'`) does NOT
  exclude a stuck drop-first sequence, because `ups_2way_trades.status` stays `'collecting'`
  throughout the ENTIRE sequence (§8.6's own documented fact, exploited by the cancel/select-drops
  fixes there). The ledger-lock protection above meant this could never cause a SECOND MFL write —
  but it WOULD flip `row.status` to `'executing'` (display: "Clearing final checks," actively
  misrepresenting a deal that is actually stuck awaiting commissioner review) and hand the owner a
  false `{ok:true, rechecking:true}`, silently discarding their action instead of saying it was
  held. Fixed in PR #1163 with the identical ledger-read guard the cancel/select-drops paths
  already use; tested directly (`tests/trade_2way_drop_first_execute.test.mjs`'s "recheck2WayExecution
  must refuse once a drop-first sequence has started").
- **Net:** an owner cannot advance, retrigger, or even cosmetically disturb a stuck sequence
  through any route this app exposes. Only a commissioner (`isAdminCaller`) can call the execute
  route that resumes it.

**2.4.6 Aging alert for unresolved partial sequences — Keith's ruling (2026-09-30): "Add an aging
alert for unresolved partial sequences; route it to the existing commissioner channel and show
the age prominently in the queue."** BUILT in PR #1163, in two parts:
- **Worker-side DM escalation** (`checkAgingDropFirstSequences`, `worker/src/trade_2way.js`):
  scans `ups_trade_executions` for `two_way_staged_drop_first` rows stuck at `PARTIAL_EXECUTED`/
  `NEEDS_REVIEW` for at least 30 minutes since the ledger's own last update, and DMs "the existing
  commissioner channel" — the same `COMMISH_DISCORD_USER_ID` DM mechanism `notifyCommish` already
  uses for every other alert in this feature, not a new or different channel. Rides the same
  `*/2 * * * *` cron tick as the pre-existing auction-poll watchdog (`worker/src/index.js`) —
  deliberately NOT gated on `TRADE_2WAY_DROP_EXECUTE_ENABLED`, since a stuck row's visibility must
  outlive the flag that created it (e.g. the flag gets turned off BECAUSE something got stuck).
  De-duplicated per-trade via the existing `ups_bot_heartbeat` convention (same pattern as
  `dmCommishOncePerBatch`): re-alerts on a 60-minute cadence while the SAME state persists
  unresolved, but re-alerts immediately on any genuine state change (e.g. `PARTIAL_EXECUTED` →
  `NEEDS_REVIEW`), never waiting out the cooldown for a fact that actually changed. Tested
  directly: under-threshold silence, over-threshold alert with the age stated in the DM text,
  same-state dedup, and immediate re-alert on a real state change.
- **Queue UI** (`site/commish/trade_review_queue.html`): a distinct, loud banner — separate from,
  and louder than, the pre-existing generic 48-HOUR staleness marker on every trade — appears on
  any card whose ledger is `PARTIAL_EXECUTED`/`NEEDS_REVIEW` and stuck past the SAME 30-minute
  threshold the DM uses (one number, not two independently-tuned ones), stating the exact stuck
  duration ("STUCK 1h 35m") and restating that only the commissioner can resume it. The card
  itself also gets a distinct danger-colored border, so a stuck deal is visually distinguishable
  from the rest of the queue at a glance, not just in its text. Tested directly
  (`tests/trade_review_queue_page.test.mjs`'s two "AGING BANNER" tests).
- **What this does NOT do:** it does not create a second authorized executor (§2.4.4's
  backup-commissioner question is explicitly declined for this PR, not answered by this alert),
  and it does not resume or retry anything itself — it only makes an existing wait visible and
  escalating instead of silent.

### 2.5 Residual risk, stated plainly

**MFL cannot make this sequence atomic.** There is no MFL API concept of a multi-step transaction,
no rollback, no "propose two things and commit both or neither." Whichever ordering (or whether
neither is automated, §2.4) is chosen, the two operations are two independent HTTP calls to a
third-party platform this app does not control, separated by network time, and either can fail
independently of the other for reasons entirely outside this app's control (MFL's own uptime,
lockout state, rate limits, or a genuinely concurrent conflicting action by an owner). No design
in this document — or any conceivable one, short of MFL itself adding transactional support —
removes that risk. Every mitigation here (idempotent retries, ledger evidence, DMs, the
manual-queue alternative) is about making a partial outcome **visible, bounded, and recoverable
by a human**, never about preventing a partial outcome from being possible.

---

## 3. Consent: what an owner's confirmation must actually cover

Today's shipped "Confirm drop selection" only asks the owner to pick players and click once.
Once real execution exists, that single click authorizes an **irreversible, commissioner-executed
roster action** — the UI and the underlying record must make each of the following explicit and
unambiguous at the moment of confirmation, not imply it or leave it to be inferred:

1. **The named player**, by name (not just an id the owner has to recognize) — already true today
   in the shipped picker (`buildPlayerNamesFor`/`buildPlayerNamesForFid` resolve real names from
   locally-known roster data at create-time; the accept-review context currently falls back to a
   bare id for lack of full roster data there, noted as a known gap when this ships for real,
   since "the named player" needs to be unambiguous in EVERY context that collects consent, not
   just some).
2. **The expected penalty** — the real, authoritative dollar figure from the existing
   `GET /api/cap-penalty/preview` endpoint (the same one the hourly cron and FO/mobile already
   use for real charges), shown before the owner confirms, not after the drop has already
   happened. Today's shipped picker does not yet show this figure at all — a real gap to close
   before this ships for real, not merely a nice-to-have (the owner is currently confirming a
   drop without seeing its cost).
3. **Commissioner execution authority, explicitly stated** — because every drop under this
   design executes via commissioner impersonation, never the owner's own session (§4), the
   confirmation copy must say so plainly: e.g. *"By confirming, you authorize the commissioner
   account to drop [Player Name] from your roster as part of this trade."* This is a **new**
   consent element that today's "Confirm drop selection" copy does not carry, and should be
   added to the copy regardless of when real execution ships, so the selection UI itself never
   implies less authority than the eventual write will actually use.
4. **The non-atomic ordering risk, stated plainly — SHIPPED (2026-09-29), unlike items 2/3
   above.** Keith: *"State plainly whether any sequence can guarantee that a team never
   temporarily exceeds five. If it cannot, show that limitation in the owner-facing consent
   copy."* Unlike items 2/3 (deliberately deferred until real execution exists, so the copy never
   implies more than the app can currently do), this one is true **today**, under the currently
   decided manual-review model (§2.4) — a commissioner performing this by hand faces the exact
   same non-atomicity as an automated write would, per §2.3.1. So it ships now, in the
   interactive picker itself (`site/shared/trade_3way_view.js`'s `renderLoadedContractDrops`,
   right above the "Confirm drop selection" button, visible only to the affected franchise's own
   owner): *"This drop and the trade itself are two separate, irreversible steps a commissioner
   performs by hand — they are not guaranteed to happen together. If the drop happens first and
   the trade then falls through, you lose the player(s) you selected with nothing in return. If
   the trade happens first and this drop then falls through, your roster stays over the
   5-loaded-contract limit until the commissioner resolves it. Confirming this selection does not
   mean either one has happened yet."* Tested in `tests/trade_2way_staged_clients.test.mjs`
   (renders for the affected owner's own interactive picker; absent for every other viewer). The
   commissioner review queue (`site/commish/trade_review_queue.html`) carries the equivalent
   disclosure in its top banner, for the same reason.

Selecting and confirming the drop (today, shipped) is the artifact of this consent, but it does
not yet SAY all four of these things (items 1 and 4 are shipped; items 2 and 3 remain gaps, noted
above). This section is the requirement for what it must say before the
"confirm" click is treated as authorizing a real write — a UI/copy change scoped to the create
and accept-review dialogs (`site/trades/trade_workbench.js`, `site/m/views/trade.js`,
`site/shared/trade_3way_view.js`), not part of this document's code (none is written here).

---

## 4. Identity: who authenticates each write, and why it must be uniform

For a 2-way trade, the **recipient** is present (an owner session exists) at accept time. The
**sender** selected their own drop at *offer creation*, potentially days earlier — their session
is long gone by the time someone else accepts. A 3-way executes from a Discord-webhook/background
context (`ctx.waitUntil`) with **no owner session at all** — exactly why
`executeCommishTwoPartyTrade` already uses commissioner impersonation for every trade leg (§1.2).

**Every conditional drop, for either party, 2-way or 3-way, therefore executes via commissioner
impersonation** (`env.MFL_APIKEY`, `FRANCHISE_ID=<affected franchise>`) — the same authority
`executeCommishTwoPartyTrade` already relies on for trade legs, never a real owner's session. This
is *why* §3's explicit consent-to-commissioner-authority language matters: the owner is not
performing this write themselves, and must knowingly authorize someone else (the commissioner
account) to do it on their behalf.

**[open question] for Keith, unchanged from v1:** if commissioner lockout is habitually left ON,
every conditional-drop write (under EITHER ordering) needs manual lockout-toggling to complete —
worth confirming lockout's normal operating state, since it directly determines how often a human
has to intervene no matter which ordering or the manual-queue option (§2.4) is chosen.

---

## 5. Cap and lineup recalculation

`evaluateTradeCompliance` already, today, recomputes both cap and (as of this same review round)
lineup feasibility with a valid conditional drop excluded from the post-trade roster (see
`worker/src/trade_cap_authority.js`'s `postTradeRosterAfterDrops`, and the dedicated test proving
a selected drop changes the lineup verdict). This means the "what does dropping this player cost,
structurally" answer the owner sees during selection is **already the authoritative, live
recalculation** — nothing new is needed there.

What is genuinely new, for whichever ordering ships: **immediately before firing the actual write
that this section gates** (the trade call under Ordering A, or the drop call under Ordering B),
re-run `evaluateTradeCompliance` one more time with the CURRENT stored selection as
`conditionalDrops` — the same call `capGate()`/`complianceViaSelf()` already make for the
selection-only gate today. If the verdict is no longer `needs_drops`-satisfied (the roster
changed again since the owner confirmed, a selected player is no longer loaded, someone else's
trade already changed the count), **hold — zero writes, exactly like today's `blocked_cap`
path** — this is not new logic, it's the existing gate, re-run at the latest possible moment,
matching "revalidate immediately before each acceptance and again before execution."

---

## 6. Partial-outcome recording and resolution

This section describes partial-outcome recording for an AUTOMATED ordering (§2.1/§2.2), IF one
is ever approved (§2.4 — currently, neither is; the decided model is manual review). For the
decided manual model's own partial-outcome handling — a deal stopping mid-sequence with some
but not all of its writes confirmed — see §2.4.3's `partial_executed` state, which generalizes
this section's two-operation case to a sequence of any length.

Reuses the execution ledger's existing shape (§1.2) exactly — no new states, no new table:

- Whichever operation runs **second** (under either ordering) is post-processing, recorded via
  the existing `recordStep()` into `steps_json`, keyed distinctly per franchise+player (e.g.
  `drop:<franchise_id>:<player_id>`) so a partial completion (the 5→7, two-drop case) is visible
  per player, never as one opaque blob.
- A failure of the second operation lands the ledger at `executed_needs_review` (never a state
  that implies the FIRST operation can be retried or undone) with the specific evidence recorded:
  which step(s) confirmed, which failed, which are ambiguous (§2.1/§2.2's three failure kinds,
  recorded distinctly — `failed` vs `unconfirmed` are never conflated).
- **Resolution is manual**, exactly like today's `executed_needs_review` for extension
  post-processing: a commissioner-facing action retries only the specific outstanding step(s),
  never the whole operation, and never the FIRST operation that already, permanently, happened.
  **[open question]**, unchanged from v1: whether an owner can themselves re-trigger their own
  failed drop step (bounded to their own franchise) or whether this is strictly
  commissioner-only — not decided here.

---

## 7. Idempotency and retry safety for the drop call specifically

Trade-call idempotency needs no new work — the existing ledger lock plus MFL's own
duplicate-offer detection (§1.2) already cover it, under either ordering.

For the **drop** call, which has no MFL-side idempotency guarantee (§1.1), a retry (commissioner-
triggered, or an automatic retry of an ambiguous step) must, before ever re-sending the `DROP=`
import:
1. Check `steps_json` for this exact step key — if already marked `done`, skip.
2. If marked `unconfirmed` (not `done`, not `failed` — §2.1/§2.2's ambiguous case), do a **fresh
   `TYPE=rosters` read first** and check whether the player is already absent. If so, mark the
   step `done` from that evidence *without* resending — the identical verification-over-
   response-text discipline §1.1 already uses for a single request, now also applied across
   retries.
3. Only if the player still appears on the expected roster does a genuine retry resend the
   `DROP=` import.

---

## 8. Native-MFL-bypass: what must stay inside the War Room, and why "stage it if it's over the limit at creation" is not enough

**Keith's review of §8 v1:** *"My send-time rule applies to both teams, not only the initiator...
That is a release blocker for the conditional-drop feature, even if the bypass existed before
this PR... Please revise the staged-offer design to account for roster changes after creation as
well. Staging only offers that are over the limit at creation leaves an initially-clear native
offer open to the same bypass if a roster later changes. Identify which two-team offers must
remain entirely inside the War Room, or demonstrate an enforceable MFL-side control. Do not rely
on a polling sentinel as a guarantee."* This section is that analysis, done rigorously rather than
assumed, and it changes the conclusion from v1.

### 8.0 The problem, restated completely (both teams, and not just at creation)

The 2-way CREATE gate refuses whenever the **initiator's** own requirement isn't satisfied. It
never checked the **recipient's** — by original design, "the recipient's own concern at accept."
That gap alone means a trade where the recipient would go over the limit still becomes a real
`tradeProposal`, natively acceptable, with no code in this app ever running if the recipient
accepts there instead. That much was already identified in v1.

**What v1 missed:** even a trade that is completely clean for *both* sides *at the moment of
creation* is not safe to expose natively, because MFL gives this app no way to keep it clean.
Between creation and whenever the recipient actually clicks Accept — a gap that could be minutes
or weeks — **either side's roster can change for reasons that have nothing to do with this
trade**: a different trade lands, a waiver claim processes, an extension creates a new loaded
contract. `evaluateTradeCompliance`'s own formula is `current loaded contracts (AT THE MOMENT OF
EVALUATION) − loaded sent + loaded received` — "current" is read fresh, every time, from whatever
the roster actually is *then*, never frozen at creation time. A native MFL accept reads none of
this; it just executes. So an offer that was genuinely `ok` when proposed can become a live
violation by the time it's accepted, entirely outside this trade's own content, and MFL's native
accept button would process it anyway with zero enforcement, exactly like the recipient-side gap
v1 already found — just triggered by a *later* event instead of the offer's own initial state.

**A concrete illustration, not a hypothetical:** HammerTime is investigated in §9 as *already*
carrying 6–7 loaded contracts on its live roster today — independent of any trade. Given the
formula above, **every single 2-way trade Hammer is a party to, on either side, right now, is
already over the limit** — not because of anything the trade itself contains, but because
Hammer's own pre-existing roster state alone makes their projected total exceed 5 regardless of
what moves. A trade that doesn't touch a single loaded asset, offered to or by Hammer, would still
show a violation the moment `evaluateTradeCompliance` runs for real — which is exactly the state a
"stage only if the offer itself looks risky at creation" rule would miss, since the offer's own
content was never the risk; the counterparty's *standing* roster state was.

### 8.1 Which offers can be proven safe to expose natively? None, given what MFL provides.

Working through candidate criteria, from narrowest to broadest, and why each one fails to be a
**guarantee** (as opposed to a heuristic that reduces exposure without eliminating it):

- **"Stage only if either side is over the limit at creation"** (v1's design). Fails per §8.0 —
  says nothing about a side that becomes over the limit *after* creation but *before* accept.
- **"Stage only if this trade itself moves a loaded asset."** Fails for the identical reason as
  Hammer's illustration above: a trade that moves nothing loaded can still leave a side over 5,
  because the rule evaluates the side's *total* projected count, not merely this trade's own
  delta. A flat-for-flat trade offered to a franchise that is independently over the limit (for
  any reason, today or acquired later) is exactly as exposed as one that moves a loaded player.
- **"Stage only if either side currently has ≥4 loaded contracts" (a proximity heuristic).**
  Reduces exposure (catches Hammer's case immediately) but is still not a guarantee: a franchise
  at 0, 1, or 2 loaded contracts today can acquire several more from *other* trades before this
  one is accepted — there is no bound on how much a roster can change in the interval, and no
  signal this app can read at creation time that rules that out.
- **"Re-check compliance right before accept, then refuse the native accept if it would
  violate."** This is not actually available — MFL's native accept has no hook this app can
  intercept, refuse, or veto. There is no "ask us first" mechanism, no webhook, no way to make
  MFL itself consult this app before it processes a `tradeResponse`. This was confirmed directly
  against MFL's API surface in this and the prior investigation round: propose/accept/revoke is
  the entire vocabulary, with no conditional or gated variant.

**Conclusion: no criterion narrower than "stage every 2-way trade" can be proven to close this
gap, because the risk is not a property of the offer's own content — it is a property of what
either participant's roster looks like at an unpredictable future moment MFL will act on without
asking this app anything.** This is a stronger, and different, conclusion than v1's "stage the
ones that look risky today." Any narrower rule is a **heuristic that reduces how often the gap is
hit, not a control that closes it** — and per Keith's instruction, a heuristic must not be
presented as a guarantee.

**No enforceable MFL-side control exists**, confirmed by the same research this whole design
already relies on (§1): MFL's import API is propose / accept / reject / revoke, with no
conditional-acceptance concept, no pre-accept webhook, and no way for this app to be consulted
before MFL processes an accept it receives directly. There is nothing "on MFL's side" to
demonstrate here — the absence of such a control is itself the finding.

### 8.2 The staged-execution mechanism (independent of §2's execution model, by design)

**Keith's correction to v1:** *"Resolve the inconsistency in §8.1: it says drops have 'genuinely
executed' before the worker creates the MFL trade, which assumes drop-first while the execution
order is explicitly undecided. Keep the staged approval flow separate from the later irreversible
execution sequence until I rule on it."* v1 conflated two independent decisions — this version
separates them explicitly, and the separation held even once §2 WAS ruled on (§2.4):

- **Staging (this section) decides WHEN a 2-way trade is allowed to become a real, MFL-visible
  transaction at all.** It is a gate on *existence*, not on internal sequencing.
- **Execution (§2 — decided as §2.4, manual commissioner review) decides, once staging has
  cleared, HOW the trade write and the drop write(s) actually happen — currently a human
  performing both by hand, per §2.4.3, never automated.**

Given §8.1's conclusion, the staged mechanism (reusing the 3-way pattern exactly, per v1's own
design) is:

1. Every 2-way trade is created as a D1-only row (`ups_3way_trades`'s pattern, or a parallel
   two-party table with the identical shape) — never a native MFL `tradeProposal` at creation,
   for *every* 2-way trade, not a subset selected by risk at creation time.
2. The recipient sees and interacts with it entirely through this app's own inbox — never MFL's
   native pending-offers list, because for a staged trade it never appears there.
3. The recipient (and the sender, if anything about their own requirement changed since creation)
   selects and confirms their own conditional drop(s) via the already-built selection UI,
   whenever `evaluateTradeCompliance` shows either side needs one.
4. **Immediately before the trade is allowed to leave the staged state**, `evaluateTradeCompliance`
   is re-run one final time, fresh, for both sides. If it is not `ok` for both, the trade is held
   — this is the SAME re-check §5 already specifies for whichever write happens first, not a new
   mechanism.
5. Once that final check is `ok` for both sides — a state reachable either because nobody was ever
   over the limit, or because every needed drop has been resolved — the deal is released to
   execute, per **whichever model §2 settles on**. **Currently (§2.4, Keith's 2026-09-29 ruling):
   this means the deal enters the commissioner-review queue and a human executes every write the
   deal requires by hand, one at a time, following §2.4.3 exactly** — not the worker executing
   automatically. If Keith later
   approves automating one of §2.1/§2.2's orderings, this step becomes the worker executing the
   real MFL trade via commissioner impersonation (`executeCommishTwoPartyTrade`, reused exactly
   as 3-way already uses it) and the confirmed drop(s), in that ordering's sequence — staging
   itself does not presuppose which, and a future change to §2's answer requires no change to
   this section, only to what "released to execute" triggers.

This still closes the bypass for the identical structural reason 3-way already has no exposure:
**there is nothing on MFL's own site to accept until this app itself decides to create it** — now
true for every 2-way trade, not only the ones that looked risky at the moment they were proposed.

### 8.3 Cost — Keith's ruling (2026-09-29): universal staging, not the scoped alternative

**Keith: "Choose universal staging, not a near-limit heuristic. New two-team War Room offers
should remain server-side through owner acceptance and final compliance review, with no native
MFL pending offer that can be accepted around the worker."** Decided. The scoped, heuristic
alternative this section offered in the prior round (stage only offers meeting a proximity
threshold) is NOT chosen — recorded below only so the cost of the decided option is stated
plainly, not to reopen the choice.

Universal staging is a materially larger change than v1's scoped version: **every** 2-way trade —
not just loaded-contract-relevant ones — moves off MFL's native propose/accept flow and onto a
worker-brokered one, for its entire pending lifetime. Concretely this means: new "staged offer"
UI replacing the native inbox card on both platforms for every 2-way trade, every 2-way accept
becoming a commissioner-impersonated write instead of the owner's own session write (a change in
authentication model for the single most common transaction type in the app, not just for
conditional-drop cases), and full de-risking of counter-offers, revokes, and the existing 2-way
notification/DM surface against the new staged shape. None of this is built yet (§11).

### 8.4 A supplementary, imperfect mitigation — explicitly not a substitute, per Keith's instruction

`worker/src/index.js`'s existing "trade-sentinel" sweep (`/admin/trade-sentinel/tick`, already
polling every pending MFL trade for stale-ownership violations and auto-revoking them,
`index.js:36940-37164`, `findOwnershipViolations`) could be extended to *also* check
loaded-contract compliance on every still-**pending, native** offer (i.e. any 2-way trade created
before §8.1-8.3 ship, or predating the cutover in §8.5.1 below) and pre-emptively revoke one that
would violate it. **Keith's instruction is explicit: "Do not rely on a polling sentinel as a
guarantee."** This is recorded here only as a stopgap that narrows a window that already-existing
polling cadence can miss — exactly the class of gap the 2026-09-25 stuck-offer incident
(referenced elsewhere in this repo's history) already demonstrated for a different check — and
must never be presented to owners or to Keith as closing the bypass.

### 8.4a The controlled cutover switch (2026-09-29): closing the in-app bypass server-side

**Keith's correction (2026-09-29): keeping "Stage via War Room" beside the existing direct-MFL
Send button leaves an in-app bypass — hiding a button alone is insufficient. At cutover, the
normal Send action must stage every new two-team offer, and the legacy creation endpoint must
also refuse direct creation server-side while staging is enabled.**

**One new flag, `TRADE_2WAY_CUTOVER_ENABLED`** (default off, fails closed like every other flag
here), checked in exactly two places in `worker/src/index.js`, both BEFORE any MFL call:
- The legacy `POST /trade-offers` / `/api/trades/proposals` CREATE handler — refuses with
  `409 {code:"staging_required"}`.
- The legacy `COUNTER` action (inside `/api/trades/proposals/action`) — a counter rejects the
  original offer and proposes a brand-new one, which is exactly the same "create a new native
  offer" bypass as a direct create, so it gets the identical refusal, checked before the original
  offer is rejected (no side effect on a refused attempt).

Nothing else on either legacy route is touched — reading existing offers, and every action on an
offer that already exists (accept/reject/revoke/ack-cap/select-drops), works exactly as before,
cutover or not. This is deliberate: cutover blocks NEW native creation only, never managing what's
already pending.

**Safety interlock:** `trade_2way.js`'s own `enabled()` check (gating whether staged creation is
allowed at all) now also passes when cutover is on, even if the separate
`TRADE_2WAY_STAGING_ENABLED` flag was left off. Without this, turning cutover on while forgetting
to also flip plain staging on would brick ALL 2-way trade creation league-wide (the legacy path
refuses, and the staged path would ALSO refuse) — exactly the kind of foot-gun
`rule_no_fail_open_guards` warns about, just inverted into a fail-CLOSED foot-gun on something that
must keep working.

**Client-side: the fallback lives in the normal Send flow, not a separate branch.**
`submitTradeCreateWithGates`/`submitViaStagingFallback` (desktop, `trade_workbench.js`) and
`submitTradeCreateWithGatesMobile`/`submitViaStagingFallbackMobile` (mobile, `trade.js`) are the
SAME functions the existing "Submit Offer"/"Send offer" button already called, unchanged in every
other respect. When the legacy create is refused with `staging_required`, they automatically:
run the SAME pre-send compliance popup the dedicated Stage button uses, convert the SAME payload
the direct-MFL path already built into staged movements, and POST to `/api/trades/2way` instead —
so a client that never learned about staging (a stale tab, a cached bundle) still ends up staged
the moment the SERVER says so, never a silent native-MFL send. The owner declining the popup is a
calm "Not sent," never an error. The separate "Stage via War Room" button still exists as an
explicit, always-available choice regardless of cutover state — it was never the bypass; the
normal Send button silently staying direct-only was.

**Tested** (`tests/trade_2way_cutover_switch.test.mjs`, 7/7; `tests/trade_cutover_send_fallback.test.mjs`,
6/6 — both against the real worker + real D1 + a stateful fake MFL): cutover off preserves exactly
today's behavior (a real MFL trade is proposed); a stale client calling the legacy CREATE or
COUNTER endpoint directly is refused with zero MFL writes once cutover is on; an owner can still
accept a native offer that already existed before cutover; cutover on with plain staging off still
permits staged creation (the interlock); an off→on→off flag transition is clean and leaves no
lingering state; and staged offers created while cutover was on survive a rollback (cutover flipped
back off) fully intact — detail GET, accept, and cancel all keep working, because cutover only ever
gates the legacy create route and never touches `ups_2way_trades`. The end-to-end fallback itself
is proven against the real worker too: cutover on makes the SAME normal-Send call land as a real
staged D1 row (readable back through the real detail route), running the popup exactly once, with
zero MFL writes.

**Both flags (`TRADE_2WAY_CUTOVER_ENABLED` and `TRADE_2WAY_STAGING_ENABLED`) remain off. Nothing in
this section has been turned on for real owners.**

**The full two-flag truth table** (Keith's ruling, 2026-09-29: "document and test the full
two-flag truth table... it must never silently reopen the bypass"), tested exhaustively in
`tests/trade_2way_flag_truth_table.test.mjs` (5/5):

| cutover | staging | legacy `/trade-offers` create | staged `/api/trades/2way` create |
|---|---|---|---|
| off | off | succeeds — real native MFL trade (today's actual production default) | refused, `2way_staging_disabled` |
| off | on | succeeds — real native MFL trade, **unchanged** | succeeds — staged in D1 |
| on | off | refused, `staging_required` | succeeds — staged in D1 (the **safety interlock**, §8.4a above) |
| on | on | refused, `staging_required` | succeeds — staged in D1 |

The property that matters, true in every row: **whenever legacy is refused, staged creation is
reachable in that same row** — no combination ever refuses both (a total outage) and none ever
lets legacy quietly still succeed despite cutover being on (the bypass reopening). The `off/on` row
is the **pre-cutover testing window**, not the bypass itself — both paths being simultaneously
available there is expected and safe (staging never touches MFL, so having it on as an option
changes nothing about the legacy path's own behavior); the actual bypass Keith flagged was the
normal Send button staying direct-only once cutover *should* have been on, which the `on/*` rows
exist specifically to close.

### 8.5 Two questions Keith asked directly: cutover, and the honest boundary of what this app controls

**Keith: "Address what happens to already-pending native offers at cutover, and determine
whether owners can create or accept trades directly on MFL outside the War Room; state the
enforceable boundary honestly."**

#### 8.5.1 Already-pending native offers at the moment universal staging ships

Universal staging changes how a **new** 2-way trade is created from that point forward. It has
no retroactive effect on any 2-way `tradeProposal` MFL already knows about from before the
cutover — those offers are, and remain, natively acceptable on MFL.com, exactly as exposed as
they are today, because they were never staged and staging cannot be applied after the fact
(MFL has no mechanism to convert an existing native proposal into a staged one). Three options,
stated plainly rather than picking one silently:

- **A. Let them expire/resolve natively, unmanaged.** Do nothing extra; every pre-cutover offer
  either gets accepted (natively, with the exact bypass risk §8.0 describes, for exactly this
  finite set of already-existing offers) or expires/gets revoked through MFL's own normal
  lifecycle. Simplest, but leaves the precise gap this whole section exists to close open for
  every offer already in flight at cutover — the population is bounded and shrinking, not
  unbounded and ongoing, but it is not zero.
- **B. Revoke every pending native 2-way offer at cutover.** The existing revoke mechanism
  (`revoke2WayOffer`-equivalent, or the trade-sentinel's own revoke path, §8.4) cancels every
  still-pending native offer at the moment staging goes live, with a notification to both
  parties explaining why and inviting them to re-propose the identical deal through the new
  staged flow. Closes the gap completely at cutover, at the cost of actively cancelling real,
  possibly-agreed-but-not-yet-accepted deals that were never risky in the first place (most
  pending offers at any moment involve no loaded-contract exposure at all) — a real, if small,
  disruption to owners mid-negotiation.
- **C. Extend the trade-sentinel (§8.4) to cover ONLY the pending native offers that predate
  cutover, until they naturally clear**, rather than revoking them outright or leaving them
  fully unmanaged. A narrower, time-bounded application of the exact mitigation §8.4 already
  describes and already caveats as "not a guarantee" — appropriate here specifically because the
  population it needs to cover is finite and shrinking (every pre-cutover offer eventually
  resolves one way or another), unlike the ongoing, unbounded case §8.4 explicitly says a
  sentinel cannot be trusted to close.

**This document does not choose between A/B/C — it is Keith's decision**, the same way §2.4 was.
Option C is noted as the one that best matches "not a guarantee, but a bounded, honest stopgap
for a shrinking, known population" rather than either extreme.

#### 8.5.1a Sentinel-table inventory (UNVERIFIED against MFL) + a concrete cutover procedure (2026-09-29, after client wiring shipped)

**Sentinel-table inventory, checked 2026-09-29 — NOT a confirmed live count. Keith's correction
(2026-09-29): do not call the pending-native-offer count zero based on this table; it is
unverified against MFL until the commissioner console or the live inventory route is actually
checked.** `ups_trade_offer_watch` (the sentinel's mirror of every pending MFL offer, in-app AND
native-desktop) holds exactly 4 rows total, ever, all `lifecycle: 'gone'`, all from 2026-07-22 —
nothing since. `TRADE_SENTINEL_ACT_ENABLED` and `TRADE_SENTINEL_ADOPT_NATIVE` have both been live
(`"1"`, via a D1 `ups_settings` override) since 2026-09-18 — 11 days before this check — so
native-offer tracking, not just in-app, has genuinely been running the whole time; the sentinel is
wired into `scheduled()` on both the hourly and `*/5min` crons (`worker/src/index.js`'s
`/admin/trade-sentinel/tick`, STEP A). **None of that proves today's real MFL count is zero** — it
only shows what this app's own mirror last recorded, and a mirror can be stale, can have missed a
poll, or (this session cannot rule out) can have a gap in its own coverage that hasn't surfaced yet.
**This session could not independently confirm the live count via MFL's own `pendingTrades` API
directly** (no `MFL_APIKEY`/`COMMISH_API_KEY` value available in this environment) — a new,
genuinely read-only diagnostic exists for this now (`GET /admin/trade-offers/live-mfl-inventory`,
added this pass, tested in `tests/trade_offers_live_mfl_inventory.test.mjs`; it enumerates every
franchise's `pendingTrades` via the same commissioner-impersonated GET the sentinel's STEP A already
uses, and performs **zero** D1 or MFL writes of any kind), but running it requires the real
`COMMISH_API_KEY`, which only Keith has. **The count remains unverified against MFL until Keith
checks it** — either MFL's own Commissioner → Trades → Pending Trades page directly, or the new
route with his key. Nothing in this section should be read as having settled that question.

**Lockout, checked 2026-09-29 — KEPT OPEN, not resolved either direction.** The league's `lockout`
setting is currently **`"Yes"`** (public `league` export). This is NOT currently a deliberate
control for this feature — it predates this work and its purpose here is unaudited. Real,
already-shipped code (`worker/src/trade_3way.js`, `executeCommishTwoPartyTrade`) detects MFL's own
literal response text — **"Commissioner can not impersonate another franchise with lockout on."`**
— as a distinct failure mode; this has been observed in production MFL responses, not guessed.
That confirms, with direct evidence, one concrete consequence: **while lockout is on, MFL will
itself refuse `executeCommishTwoPartyTrade` — the exact commissioner-impersonation primitive every
3-way and staged-2-way EXECUTION uses.** In plain terms: **lockout, if it is ever on at the moment
this design's own execution path runs, may prevent the eventual commissioner-execution step from
working at all** — this is a real, live risk to the execution design itself, not a side curiosity,
and it should be checked before that path is ever exercised for real. **Whether lockout ALSO
restricts an ORDINARY OWNER's own native trade action (logged into their own MFL account, no
impersonation involved) remains UNVERIFIED, in either direction** — it would require either a live
test against MFL (out of scope: this pass makes zero real MFL writes) or Keith's own knowledge of
MFL's documented lockout behavior. The specific error text MFL returns names impersonation only,
which is suggestive but not proof that ordinary members are unaffected. Treat both halves of this
finding — the confirmed impersonation risk to execution, and the unverified ordinary-owner
question — as open, not settled, before relying on either for a release decision.

**Concrete recommendation, given the above (this document previously offered A/B/C with no
recommendation; here is one):** **Option C, and it requires no new engineering** — the sentinel has
already been running in the ACT+ADOPT_NATIVE configuration for 11+ days, watching every native and
in-app pending offer. **The sentinel's own table shows nothing currently tracked, but that count is
UNVERIFIED against MFL directly (see above) — step 1 below exists specifically to close that gap
before relying on it.** The concrete procedure:

1. **Before flipping the staged-2-way UI live for real owners** (client wiring shipped this pass,
   still gated by `TRADE_2WAY_STAGING_ENABLED`/`TRADE_2WAY_STAGING_EXECUTE`, both off): take one
   final live snapshot **verified directly against MFL** (Keith's own MFL Commissioner console, or
   the new `/admin/trade-offers/live-mfl-inventory` route with his key) to document exactly what, if
   anything, is pending at that moment. The sentinel table's own history (nothing tracked since
   2026-07-22) is a reasonable prior, not a substitute for this check.
2. **Do not revoke anything already pending** (rejects Option B) — an owner's real, possibly
   already-agreed offer that was never risky (most pending offers involve no loaded-contract
   exposure at all) should not be cancelled out from under them; that is a real, avoidable
   disruption for whatever the verified population turns out to be.
3. **Let every pre-cutover native offer resolve under continued sentinel observation** — no new
   code; this is what has already been running since 2026-09-18. Announce to the league (a single
   message) that new 2-way offers should go through the War Room going forward.
4. **Sentinel detection, stated plainly (this is what Keith asked to have described honestly,
   §8.5.2):** the sentinel polls at most every 5 minutes (via the `*/5min` transactions-triggered
   fast path) or hourly (the full sweep) — it can tell the commissioner "this native trade
   executed" typically within that window, generally well before the 156-hour reoffer window or the
   336-hour hard cap it already tracks for its own lifecycle purposes. **It cannot prevent a native
   trade from executing** — MFL processes `ACCEPT` the moment both sides agree, before any poll
   runs; watch-and-alert is detection after the fact, at best a few minutes late, never a block.
5. **After a short, explicit transition window (recommend 2–4 weeks)**, if a native trade the
   sentinel flagged turns out to have created a real loaded-contract or cap violation, that is a
   manual commissioner review case — exactly the same "manual review, not automated action" model
   §2.4 already established for everything else in this design. No new mechanism needed.

This keeps the design's own stated principle intact: a polling sentinel is explicitly **not a
guarantee** (§8.4), and this procedure never claims otherwise — it only ever detects and alerts,
never blocks, and says so.

#### 8.5.2 The honest boundary: universal staging controls what THIS APP creates, not MFL itself

**Directly, plainly: universal staging (§8.1-8.3) closes the bypass for every 2-way trade this
app creates. It does not, and cannot, prevent two owners from arranging and completing a trade
entirely through MFL.com's own native trade tools, outside the War Room altogether, using
nothing this app built at all.**

MFL is the underlying platform this app is built on top of — every owner already has a real MFL
account with real, independent access to MFL's own site, including its own native
propose/accept/reject trade UI, wherever the league's MFL configuration allows it (MFL's own
"League communication" trade-permission setting, or simply MFL's default trade tools if the
league hasn't restricted them — this document has not audited whether this league's MFL
configuration disables native trading for regular owners; that is a separate, checkable fact,
not assumed either way here). If it does not, two owners can propose and accept a trade on MFL
directly, with **zero code in this app ever running**, exactly as they always could before any
of this design existed — universal staging changes nothing about that access, because it is not
this app's to control. This app can only govern what happens when a trade is created **through
it**; it was never given, and MFL does not offer, any way to disable or intercept MFL's own
native trade tools for the league's owners in general.

**What this means in practice:** universal staging is a real, complete fix for the specific gap
this section analyzes — a trade this app creates, that could otherwise be accepted around it. It
is not, and should never be described as, a guarantee that no loaded-contract violation can ever
reach MFL by any path, because a path this app does not create and cannot see (two owners
transacting directly on MFL) remains genuinely open, by the nature of building on top of a
platform this app does not own or administer. The trade-sentinel (§8.4) is the only mitigation
that even partially reaches this class of trade (a native MFL trade this app never created at
all is exactly the kind of "pending, native offer" it already polls) — and, as stated there,
Keith's instruction is explicit that a polling sentinel is not a guarantee either. **If closing
this specific residual gap matters enough to act on, the only lever available is a league-level
MFL setting (restricting native trade permissions for regular owners, leaving trade creation to
the commissioner/War Room only) — a commissioner/league-configuration decision, not something
this app's code can enforce, and outside this document's scope to recommend one way or the
other.**

### 8.6 Per-franchise hold coverage audit (Keith, 2026-09-30): every in-app path, and what it cannot reach

**Keith: "verify that the per-franchise hold covers every in-app creation, counter, acceptance,
and execution path for either affected team, and report any native MFL path it cannot control."**

**In scope: the staged 2-way engine (PR #1163). Covered, verified by test:**

- **Creation** (`createStaged2WayTrade`) — refuses to stage a NEW offer touching either
  franchise. Tested.
- **Counter** — the staged 2-way engine has **no separate counter action or route at all**
  (verified: no "counter" concept anywhere in `trade_2way.js`/`trade_2way_http.js`, and no
  client-side path in `trade_workbench.js` builds one against the staged endpoints). A
  "counter" here is just a fresh new offer, built through the same Send flow as any other offer
  — it reduces entirely to Creation, above, already covered.
- **Acceptance** (`accept2WayTrade`) — refuses to record an accept touching either franchise.
  Tested.
- **Execution, against a DIFFERENT deal** (`executeDropFirstDeal` itself) — a franchise cannot
  have two drop-first sequences in flight; starting execution on deal B while deal A (same
  franchise) is unresolved is refused. A deal can always resume **itself**. Tested.
- **Two gaps this specific audit FOUND and CLOSED, not merely reported** (Keith's request to
  verify surfaced real, previously-unnoticed defects, not just confirm what was already there):
  - **`cancel2WayTrade`** allowed cancelling a trade whose `ups_2way_trades.status` was still
    `'collecting'` — which it stays throughout the ENTIRE drop-first sequence (only
    `runTradeLegAfterDrops` ever sets `'completed'`; the drop loop itself never touches
    `status`). A deal with a real, already-confirmed drop could have been cancelled away,
    misrepresenting an irreversible fact as though nothing happened, and — because the
    commissioner queue's default view excludes `cancelled` trades — vanishing from the review
    queue entirely. **Fixed**: cancellation now refuses once the execution ledger shows any
    attempt has started (any state other than `not_executed`/`blocked_cap`). Tested.
  - **`select2WayLoadedContractDrops`** allowed an owner to change their conditional-drop
    selection at ANY time, with no execution-state check. Once one selected player is already
    confirmed dropped for real, changing the selection to a different player would make the
    orchestrator chase the NEW selection too on its next run — dropping an ADDITIONAL player the
    deal never actually required. **Fixed**: the selection is now frozen once execution has
    started, for the same reason and the same guard as cancellation. Tested.
- **`recheck2WayExecution`** — audited, no fix needed. It calls the ordinary `execute2Way`
  (never `executeDropFirstDeal`), and `execute2Way`'s own `ledger.acquire()` only matches
  `not_executed`/`blocked_cap` — it cannot acquire a lock already held by a drop-first sequence
  (`partial_executed`/`executed_needs_review`), so it safely no-ops rather than interfering. A
  `needs_drops` deal re-checked by its owner still correctly reports "held," exactly as before
  this feature existed — the drop-first executor is reachable only through the dedicated,
  commissioner-only `/api/trades/2way/execute` route, never through this owner-facing action.

**CLOSED, not merely reported (Keith, 2026-09-30 follow-up: "Close those gaps before any
execution flag can be enabled, or make the execution endpoint refuse while they remain"):**
`franchiseHasUnresolvedDropSequence` was moved from `trade_2way.js` to `trade_execution.js`
(the one module both `trade_2way.js` and `trade_3way.js` already import from, avoiding a
circular import) and is now called from every remaining surface:

- **The legacy direct-to-MFL 2-way route** (`worker/src/index.js`) — the hold is checked,
  independent of `TRADE_2WAY_CUTOVER_ENABLED`'s state, at:
  - **Create** (`/trade-offers`) — before any MFL call, right after the existing cutover gate.
  - **Counter** (`/api/trades/proposals/action`, `action:"COUNTER"`) — before the original
    offer is rejected, same discipline the cutover gate already uses there.
  - **Accept** (`action:"ACCEPT"`) — this engine's own "execute" (there is no separate execute
    step; ACCEPT posts straight to MFL) — checked right after the existing loaded-contracts
    gate, before any write.
  - All three tested against the REAL worker + real D1 + a stateful fake MFL
    (`tests/trade_2way_drop_first_execute.test.mjs`).
- **The 3-way engine** (`trade_3way.js`) — "counter" does not exist as a separate concept here
  either (verified: no counter route or client path), so create/accept/execute is the full
  surface:
  - **Create** (`create3WayTrade`) — checked right after the existing "teams must be distinct"
    validation, before any franchise is even asked to consent.
  - **Accept** (`handle3WayButton`'s `accept` action, the Discord-button flow) — checked before
    RECORDING that team's own consent, mirroring `accept2WayTrade`'s exact placement. **Checks
    ALL THREE participants (`[A, B, C]`), not just the responding party** — corrected 2026-09-30,
    second pass, per Keith's own review: *"Check every participant before 3-way acceptance and
    execution. Your test says a different participant's unresolved drop sequence does not block
    acceptance. If that participant is part of the proposed trade, it must block; an unrelated
    franchise should not."* An earlier revision of this check scoped itself to the responding
    franchise alone, reasoning `execute3Way`'s own all-three check was a sufficient backstop once
    everyone was in — Keith's correction is that this let two of three teams record real consent
    on a deal whose third participant's true compliance state was already known-unresolved,
    deferring the refusal to execution time instead of catching it at the first accept. Now
    mirrors `create3WayTrade`'s and `execute3Way`'s own identical `[A, B, C]` loop exactly. Now
    independently exercised by its own dedicated test file
    (`tests/trade_3way_button_hold.test.mjs`, 7/7), using the same real-worker + Discord-fixture
    harness `extension_eligibility.test.mjs`'s own "WORKER (3-way)" section established —
    previously reviewed by inspection only; extending the harness to cover it was out of scope in
    the prior pass, done in this one. Covers: the responding team's own unresolved sequence, a
    DIFFERENT participant of the SAME trade (both the initiator and the un-responded third team),
    and — proving the boundary the other direction — a genuinely UNRELATED franchise that must
    NOT block a trade it isn't part of.
  - **Execute** (`execute3Way`) — checked for all three participants, reusing the EXACT same
    `enterBlockedCap` revert-to-`collecting` + deduplicated-DM mechanism every other
    pre-execution block (cap, loaded-contracts) already uses, so a held 3-way deal is never left
    stuck at `status='executing'`. Tested (create + execute; both against the real worker/D1).

**Still genuinely out of reach — reported, not something any code change here can close:**

- **MFL's own native site** — an owner (or the commissioner, impersonating) can always create or
  accept a trade directly on MFL's website, entirely outside this app's routes. This is the same
  permanent, unclosable architectural boundary §8.0/§8.1 already document — no code in this app
  can ever prevent a native MFL action by design, only detect and react to it after the fact (the
  trade-sentinel, §8.4, with its own already-documented limits).

**The hold's own D1 binding, fixed — Keith's ruling (2026-09-30, second pass): "Fix the D1
binding fallback now, with a test that proves an outbox DB failure cannot bypass or falsely
satisfy the hold. Do not defer this to a background task."** Found while regression-testing this
pass: `franchiseHasUnresolvedDropSequence`, and (tracing the same pattern to its real extent)
`ledgerFor`/`capAckStoreFor`/`conditionalDropStoreFor` (`trade_3way.js`) and `ledgerDbFor`
(`trade_2way.js`) all resolved their D1 binding as `env.TWB_OUTBOX_DB || env.TWB_DB || env.DB ||
env.UPS_MFL_DB` — a legacy ordering from the outbox subsystem (wrangler.toml: both names are
separate bindings to the SAME physical D1 in production today) that meant an UNRELATED
`TWB_OUTBOX_DB` failure could make the hold check throw, or — the more concerning half of Keith's
concern — silently query a stale/mispointed binding and falsely report "no unresolved sequence"
if one ever existed. `ups_2way_trades`/`ups_trade_executions` live in `UPS_MFL_DB` — confirmed by
every OTHER direct read/write in these two files, which require it directly, never this fallback.
Fixed by putting `UPS_MFL_DB` first everywhere this pattern appeared across the drop-first hold,
the execution ledger, and the cap-ack/conditional-drop stores it shares a D1 binding with — the
other names kept only as a last-resort fallback for an environment that somehow never defines
`UPS_MFL_DB` at all. Fixed directly in this pass, not deferred: two dedicated tests
(`tests/trade_2way_drop_first_execute.test.mjs`) prove a broken `TWB_OUTBOX_DB` neither bypasses a
real hold nor falsely blocks a healthy franchise's own ordinary trade. This also, incidentally,
fixed a genuinely pre-existing, previously-failing test
(`trade_2way_authz.test.mjs`'s "a failed D1 audit write is reported honestly") that had been
broken by exactly this bug since the hold was first wired into the legacy create route.

**Net:** the hold now covers every in-app creation, counter, acceptance, and execution path for
both the staged 2-way engine and its two siblings (legacy direct-MFL 2-way, 3-way) — closed, not
just reported, per Keith's explicit instruction. Two real defects (`cancel2WayTrade`,
`select2WayLoadedContractDrops`) were found and fixed along the way, plus the D1-binding fix
above and the 3-way accept-time all-three-participants correction. The one boundary that
remains — MFL's own native website — is not something any in-app hold can ever reach, and is
labeled here as exactly that: outside the app's control, not a gap this design failed to close.

---

## 9. Hammer Times, L.A. Looks, and plain `Vet-Ext1`/`Vet-Ext2` — RULED ON, fix shipped separately

**Both questions this section originally investigated are now decided, and the fix is built —
on its own branch, its own PR, deliberately kept separate from this feature and its migration.**

**Round 3 (Keith, 2026-09-29, final ruling):**
> Plain Ext1: An unsuffixed `Vet-Ext1` or `Rookie-Ext1`... does not count toward the
> five-loaded-contract limit merely because its frozen prior year differs from its new
> extension year. A genuinely restructured Ext1 with a valid `-FL` or `-BL` suffix still
> counts. I agree with the investigation's recommended interpretation.
>
> IR: A loaded contract on IR does count toward the five. IR changes active-roster and cap
> treatment; it does not erase the contract. Add this ruling explicitly to canon and tests.
>
> Please prioritize a separate, narrow classification correction... investigate the four
> plain Ext2 contracts you identified (Gibbs, Flowers, Lamb, Kincaid)... Apply one coherent
> rule based on the contract's genuine loaded structure, not a blanket suffix shortcut... the
> Trade War Room loaded-contract calculation must align with Front Office.

**PR [#1152](https://github.com/keithcreelman/upsmflproduction/pull/1152) implements exactly
this** (own branch `fix/loaded-contract-ext-classification-2026-09-29`, own migration-free
diff, draft, not merged): `resolveLoadedStatus` now excludes a plain Ext-family contract's
frozen prior year from its load-shape test, comparing only the extension's own new year(s) —
verified against all four named Ext2 candidates (each genuinely flat, confirmed from real
per-year data, not assumed from a missing suffix), the IR ruling recorded explicitly in canon
and pinned by a test, and Front Office brought onto the identical classifier (previously an
independent, simpler check) with a parity test proving the two surfaces can never again
silently disagree. Full canon citations, player-level tables for HammerTime and L.A. Looks, and
the league-wide before/after are in that PR's own
`docs/LOADED_CONTRACT_EXT_CLASSIFICATION_INVESTIGATION.md`.

**The numbers, for reference here:** before the fix, HammerTime carried 7 loaded contracts (2
over the limit) and L.A. Looks 8 (3 over) — both genuinely, mechanically computed by the
classifier's existing logic against real, well-formed, fully-reconciled schedules, zero
unresolved contracts. After the fix (PR #1152, not yet merged): HammerTime exactly at 5, L.A.
Looks one under at 4. League-wide, all 12 franchises: 58 → 40 total loaded contracts,
franchises over the limit 5 → 0.

**This execution design's own enforcement is, and remains, independent of the classification
question** — it operates on whatever the live, authoritative loaded-contract count is at the
moment it runs, whichever way #1152 eventually lands. Nothing in this document depends on
#1152 merging first, and #1152 depends on nothing in this document.

---

## 10. What this design deliberately reuses, unchanged

- The execution ledger (`trade_execution.js`) — no new states, no new table, no new locking
  primitive, regardless of which ordering (or the manual-queue alternative, §2.4) is chosen.
- `executeCommishTwoPartyTrade`'s commissioner-impersonation pattern, for drops too (§4) and for
  the staged-2-way execution moment (§8.2).
- The drop route's own MFL-response-distrust / roster-read-verification discipline (§1.1, §7).
- The cap-penalty cron (`ups_drop_events`) for dollar amounts — not duplicated.
- `evaluateTradeCompliance`'s existing recalculation of cap and lineup with a drop excluded (§5)
  — already shipped this review round, reused as-is.

## 11. Decided vs. still open

**Decided by Keith, 2026-09-29:**
- **Execution model: manual commissioner review (§2.4), not automated ordering.** Automating
  either ordering is still not approved; the exact manual procedure and its own, different
  non-atomic risks are specified in §2.4.3/§2.4.3b/§2.4.4.
- **Sequence: drop(s) first, trade after — §2.2/§2.4.3b, not a per-deal or commissioner-judgment
  choice.** *"My ruling for the design is drop-first under manual commissioner review when a
  trade requires conditional loaded-contract drops. The five-loaded maximum is a hard limit; I
  do not want the trade executed first and the team left over five while a drop is
  outstanding."* This does NOT authorize building or enabling the execution code that would carry
  it out (§2.4.3b's own opening line) — it fixes the order that code must follow once it exists.
  §2.3.1's proof (drop-first structurally prevents THIS transaction from ever exceeding the
  5-contract limit) is why the ruling is defensible, not why it was made — the actual reason
  given is that the limit is a hard rule Keith does not want observably violated, even briefly,
  even in the self-correcting case.
- **Staging: universal — every 2-way trade (§8.1-8.3)**, not the narrower, heuristic-scoped
  alternative this document previously offered alongside it.
- **Ext1/Ext2 loaded-contract classification and the IR ruling** (§9) — shipped as PR #1152,
  separate from this branch, not yet merged.

**Decided by Keith, 2026-09-30:**
- **The pre-drop contract snapshot is unconditionally mandatory** (§2.4.3b) — built exactly this
  way in PR #1163.
- **Dead-money-penalty reversal is never automated** — any adjustment after a failed trade
  requires a separate commissioner review and an auditable manual action; no code anywhere does
  this automatically.
- **The player-loss resolution policy** (§2.4.3c) — attempt restoration, then a facilitated
  replacement trade, then the league's existing dispute process; "no compensation" is never the
  automatic result. Policy only — does not authorize live execution.
- **The reconciliation discipline for a missing or ambiguous ledger step** (§2.4.3b's addendum)
  — never presence-alone; a matching MFL FREE_AGENT transaction record (or other authoritative
  evidence tied to the franchise, player, and attempt) is required to mark a step confirmed;
  absent evidence holds for commissioner review rather than guessing either outcome. Built and
  tested in PR #1163.
- **The per-franchise hold covers every in-app creation, counter, acceptance, and execution
  path for either affected team** (§8.6) — the legacy direct-MFL 2-way route (create, counter,
  accept) and the 3-way engine (create, accept, execute) are all wired to the same hold as
  staged 2-way. What it cannot reach — MFL's own native site — is documented in §8.6, not
  silently assumed closed.

**Still open, and needing review before ANY execution code is written:**
- **Cutover for already-pending native offers** (§8.5.1, concrete procedure added §8.5.1a
  2026-09-29) — **recommendation: Option C**, which requires zero new engineering since the
  sentinel has already been running in the ACT+ADOPT_NATIVE configuration since 2026-09-18. **The
  sentinel's own table shows nothing tracked, but that count is UNVERIFIED against MFL directly —
  do not treat it as a proven zero.** Step 1 of the procedure (§8.5.1a) exists specifically to get
  a verified answer (Keith's own MFL console, or the new live-inventory route) before acting. Still
  Keith's decision to approve, not yet acted on.
- **Lockout's effect on the eventual commissioner execution path** (§8.5.1a) — confirmed, with real
  MFL error-text evidence, that lockout blocks commissioner-impersonated transactions specifically,
  which is exactly what `executeCommishTwoPartyTrade` (every 3-way and staged-2-way execution) uses
  — a live risk to that execution step if lockout is ever on when it runs, not merely a side
  finding. Whether lockout ALSO restricts an ordinary owner's own native trade action remains
  UNVERIFIED in either direction. Both halves stay open.
- **Whether to restrict native MFL trade permissions for regular owners at the league-configuration
  level** (§8.5.2) — the only lever that would close the residual "two owners transact directly on
  MFL, outside this app entirely" gap universal staging cannot reach. A commissioner/league-setting
  decision, not code. **Still unaudited** — the public `TYPE=league` export has no such field, and
  auditing it requires MFL's commissioner console directly, which this session has no access to.
  The related `lockout` setting is currently `"Yes"`, but code evidence shows it specifically blocks
  commissioner-IMPERSONATED transactions (MFL's own error text names impersonation), not
  necessarily an ordinary owner's own native trade action — that distinction was not independently
  verified this pass either, and should not be assumed.
- Whether automating the now-decided drop-first sequence is ever revisited — §2.4's ruling is
  explicitly framed as "not yet" ("Do not choose automatic trade-first or drop-first **yet**"),
  not a permanent rejection of automation itself; the ORDER (drop-first) is now fixed for whenever
  automation, if ever approved, is built.
- **The restoration workaround's own extent — two items DECIDED by Keith, 2026-09-30, and one
  still open.** §2.4.3b states what a commissioner CAN and CANNOT do manually if a drop succeeds
  and the trade then fails, and is explicit that none of it is guaranteed.
  - **DECIDED: the pre-drop contract snapshot is mandatory.** *"The exact pre-drop snapshot is
    mandatory. If the player's contract terms or roster state cannot be captured and verified,
    stop before any drop."* Not a nice-to-have, not conditional on anything else — built exactly
    this way in `worker/src/trade_2way.js`'s `captureAndVerifyPreDropSnapshot` (PR #1163), which
    is the ONLY gate on whether a drop write is attempted at all; failing it stops the whole
    sequence before any write, unconditionally.
  - **DECIDED: dead-money-penalty reversal is never automated.** *"Do not automate dead-money-
    penalty reversal. Any adjustment after a failed trade requires a separate commissioner review
    and an auditable manual action."* No code anywhere in this design (or PR #1163) reverses a
    drop's cap penalty; §2.4.3b's restoration section already says reversing it "is a distinct,
    unaddressed manual correction," and that framing is now the decided policy, not a placeholder
    for future automation.
  - **Still open:** whether the commissioner needs an urgency signal for the free-agent race (the
    window is real and time-sensitive; nothing here alerts them beyond the ordinary player-loss
    DM) — not decided, and PR #1163 does not build one.
- **DECIDED (moved from "still open," Keith 2026-09-30): the compensating-resolution POLICY for
  a deal that cannot be restored** (§2.4.3 state *k*) — §2.4.3c's approved, ranked sequence:
  facilitated replacement trade first, the league's existing dispute process as the fallback,
  no-compensation only as that process's own conclusion, never a default. **Policy only — no
  code automates or enforces any step, and `TRADE_2WAY_DROP_EXECUTE_ENABLED` stays off**; §12.3
  lists what remains before real writes are enabled.
- The exact commissioner-facing and owner-facing notification copy for every outcome in §2.4.3
  (state 0 / state *k* `partial_executed` / state *N* success).
- Whether a queued deal sitting unreviewed, or a stuck `partial_executed` deal, needs its own
  aging alert, and whether a backup-commissioner path is needed for when the primary
  commissioner is unavailable (§2.4.4).
- The review-queue UI itself (§2.4.2/§2.4.4) — surfacing each deal's true partial state live
  from the ledger, and enforcing the now-fixed drop-first sequence as the only available action
  (never a chooser between orders — that question is closed).
- The exact consent-copy changes to the shipped selection UI (§3) — item 4 (the ordering-risk
  disclosure) shipped 2026-09-29; items 2/3 (cap penalty figure, explicit commissioner-authority
  language) remain gaps.
- The lockout operating-mode open question (§4), unchanged from v1.
- The exact new function shape for a commissioner-authenticated drop call and its `steps_json`
  shape — sketched concretely now (§2.4.3b: `{player_id, franchise_id, status, pre_drop_snapshot,
  mfl_verification, confirmed_at_utc}` per drop, plus the trade leg) but not written as code, and
  the new `partial_executed` ledger state itself does not yet exist in the shipped schema (§2.4.3).

None of the still-open items is resolved by this document. It is the reviewable design Keith
asked for, with every specific failure mode he named addressed by name, the decided execution
and staging models specified precisely rather than assumed, a real design (not a hand-wave) for
the native-bypass gap and its honest limits, and an explicit list of what still needs a decision
before a single line of execution code is written.

---

## 12. 🚨 The completion gap, and the concrete commissioner-completion plan (2026-09-29)

**A staged two-team trade CANNOT be completed today. This is the single blocking release gate for
cutover — stated here as plainly as possible, not buried:**

- The commissioner review queue that actually shipped (`site/commish/trade_review_queue.html`,
  `GET /api/trades/2way/queue`) is **read-only by design** — no execute or drop action exists on
  it (§2.4.2's "new UI, not built by this document" is now built, but deliberately stops at
  read-only).
- `select2WayLoadedContractDrops` (`worker/src/trade_2way.js`) records and validates a
  conditional-drop selection, but **nothing anywhere calls MFL to actually drop the selected
  player** — the same "no executor" gap this document has named since its first revision.
- `execute2Way` defaults to dry-run (`TRADE_2WAY_STAGING_EXECUTE` unset/off) and there is no
  commissioner-facing action anywhere that flips it live for one specific trade.

**Consequence, stated once more for emphasis: turning on `TRADE_2WAY_CUTOVER_ENABLED` today would
route every new two-team offer into a hold with no finished way out.** A fully-accepted,
fully-compliant staged trade would simply sit — the compliance checks clear, but completion itself
is unavailable, with no button anywhere to finish it. §2.4/§2.4.1-§2.4.4, §6, and §7 above already
specify, in detail, SOME of the policy this section's own eventual implementation must follow
(fresh per-write compliance re-checks, verify-then-record for every irreversible write, the
`partial_executed` proposed ledger state, manual-not-automatic recovery) — **this section does not
re-decide any of that. It also does NOT decide the one piece those sections deliberately left
open: which order a multi-write completion follows (§2.1 vs §2.2, §2.3, §11) — see §12.2's own
correction below.** This section states what's implemented now, presents (never assumes) what a
real completion action would look like, and lists exactly what remains a decision before real
writes are ever enabled.

### 12.1 What's implemented now: read-only "ready to complete" + a byte-identical dry-run preview

`GET /api/trades/2way/queue` (and the review-queue page) now marks each trade `ready_to_complete:
true` when — and only when — the recipient has accepted AND the freshly-recomputed compliance is
fully `"ok"` (never `"needs_drops"`, even satisfied — §2.4.1's own rule: a satisfied selection is
not an executed drop, so a `needs_drops` trade is never "ready," only ever "held"). For a ready
trade, the queue additionally shows a **dry-run preview**: the exact `give`/`receive` asset tokens
and franchise ids `execute2Way` would send, computed by calling the SAME dry-run code path
`execute2Way` already runs today (not a re-derivation — literally the same function, which already
defaults to dry-run and already refuses to reach a real MFL call unless
`TRADE_2WAY_STAGING_EXECUTE=1`). What the commissioner sees in the queue is therefore guaranteed
byte-identical to what a real completion would attempt, because it IS that same code, just never
flipped live. **This is a pure read: `listCommish2WayQueue` calls `execute2Way` in a request-scoped
"preview-only" mode that skips the ledger lock entirely** (no `ledger.acquire()`, no D1 write, no
MFL call under any flag state) — visiting the queue can never itself start an execution attempt,
regardless of the global `TRADE_2WAY_STAGING_EXECUTE` flag's value.

Tested in `tests/trade_2way_completion_preview.test.mjs` — a trade that is accepted-but-not-fully-
compliant is never marked ready; a fully-ready trade's preview exactly matches what `execute2Way`
itself would attempt; loading the queue any number of times never advances the execution ledger or
calls MFL.

**Wording/state correction (2026-09-29):** Keith: *"`ready_to_complete` may mean the trade passes
today's compliance checks, but it must not imply it can currently be executed when the execution
flag is off or conditional drops remain unimplemented. Show 'compliance clear; completion
unavailable' where appropriate."* `previewExecute2Way`/`listCommish2WayQueue` now return a second,
always-`false` field, `completion_available`, alongside `ready_to_complete` — two separate facts,
never collapsed into one. The review-queue page's copy for a ready trade changed from "✓ Ready to
complete — every check clears right now" (which read as a green-lit call to act) to **"Compliance
clear — completion unavailable"**, with the dry-run preview underneath re-labeled "Dry-run preview
only, if this were completed today" and its own caveat restated as "there is no completion action
anywhere in this app yet." The CSS for that line was also detuned from a bold `--ok` (success-green)
style to a neutral one, since a loud success color would visually contradict text that explicitly
says nothing is actionable. Tested in both `tests/trade_2way_completion_preview.test.mjs`
(`completion_available` is `false` in every state, ready or not) and
`tests/trade_review_queue_page.test.mjs` (the rendered page never contains the string "Ready to
complete" on its own — only the corrected copy).

### 12.2 What a real completion action would look like (design, NOT implemented) — RULED ON (2026-09-29)

**History, kept for the record:** an earlier revision of this section wrongly wrote "the trade
executes first" as though decided; Keith corrected that (§2.3/§2.4.3b's opening both quote the
correction), and the section was rewritten to present both options for his ruling, not assume
either. **Keith has since ruled: drop-first, per §2.2/§2.4.3b.** This section is updated again,
now to state the decided sequence — not to re-litigate it, and not to imply the ruling authorizes
building this action (it does not — §2.4.3b's own opening line).

If and when a live single-trade "Complete now" commissioner action is built, it must follow
exactly the procedure §2.4.3b now specifies, applied to the 2-way degenerate case (at most one
drop-per-franchise plus the trade itself, never more than a 3-way's N):

1. **What the commissioner sees, per §2.4.2, extended for staged 2-way specifically:** the full
   accepted terms (read directly from the `ups_2way_trades` row, never re-derived), each
   franchise's own confirmed drop selection by player name (if any), that selection's expected cap
   penalty re-read fresh (not cached from selection time), and the live re-check from §12.1 —
   surfaced as part of the SAME action, never a separate step the commissioner could skip.
2. **Step 0 (§2.4.3b): verify the trade can proceed, before the first drop.** Re-run compliance
   fresh; if it no longer clears, stop before any write — exactly §2.4.3's "State 0" case. This
   reduces, but per §2.4.3b's own honesty, cannot eliminate, the risk of dropping a player for a
   trade that then fails (no proven live pre-check for MFL's own lockout state exists today).
3. **Every required drop, one at a time, across every franchise that owes one — trade last.**
   §2.4.3b's steps 1-7: verify immediately before each write, snapshot the pre-drop contract
   terms before writing (new — closes the restoration gap below), perform the write, verify it
   actually happened, record the outcome in the ledger before the next write, notify the affected
   owner and the commissioner immediately, and stop the ENTIRE sequence — never proceeding to
   remaining drops or the trade — if any single step fails or is uncertain.
4. **Only once every required drop is confirmed does the trade itself execute**, via the
   unmodified §1.2 mechanism, with the identical write-verify-record discipline applied to that
   one write.

**Partial outcome — stop and notify, now stated for the ONE decided order, not a choice between
two:** if a drop fails, refuses, or comes back ambiguous, the sequence stops there — no further
drops, no trade attempt — and the ledger records exactly which drops (if any) are already
confirmed, the failing one's status, and every step still unrun (§2.4.3b steps 3/3b, the proposed
`partial_executed` state and `steps_json` shape). If EVERY required drop confirms and the trade
itself then fails, **the team has lost a real roster player for a trade that never happened** —
§2.4.3b's "What can and cannot be restored" section is the honest account of what a commissioner
can attempt from there, and it is explicit that none of it is guaranteed.

**Cancel / recovery, applied here:** a staged trade that has **not yet** had a completion attempt
started can always be cancelled today, exactly as already built and tested
(`cancel2WayTrade`/`tests/trade_2way_staged.test.mjs`) — this is unaffected by anything in this
section. Once a real completion action exists and a specific attempt is stuck mid-sequence (a
drop confirmed, the next drop or the trade not yet resolved), recovery is NOT "just cancel" —
something real already happened on MFL's side — and follows §2.4.3b's own step 7 ("commissioner
must first understand why before deciding whether to retry the remaining writes or negotiate a
compensating resolution"), unchanged. If the loss cannot be recovered at all (the player was
claimed by someone else before the commissioner could act), §2.4.3c is the concrete, ranked
recommendation for this exact case (a release blocker per Keith's ruling) — still a
recommendation, not a decision, until he rules on it.

### 12.3 Release checklist — decided vs. still blocking, before `TRADE_2WAY_DROP_EXECUTE_ENABLED` can flip on

**Decided (do not re-litigate):**

- **Sequence: drop(s) first, trade after** (§2.2/§2.4.3b, Keith's ruling 2026-09-29).
- **The pre-drop contract snapshot is MANDATORY, unconditionally** (Keith's ruling 2026-09-30) —
  built exactly this way in PR #1163's `captureAndVerifyPreDropSnapshot`: if the player's
  contract terms or roster state cannot be captured and verified, the sequence stops before that
  drop, full stop, not a configurable or skippable check.
- **Dead-money-penalty reversal is NEVER automated** (Keith's ruling 2026-09-30) — any adjustment
  after a failed trade requires a separate commissioner review and an auditable manual action; no
  code in this design or PR #1163 does this automatically.
- **The player-loss resolution policy** (§2.4.3c, Keith's ruling 2026-09-30) — restoration
  attempt, then a facilitated replacement trade, then the league's existing dispute process;
  "no compensation" is never the automatic result. **Policy decided; still not a green light for
  real writes** — nothing automates or enforces any step of it.
- **The reconciliation discipline for a missing/ambiguous ledger step, INCLUDING the trade write
  itself** (Keith's ruling 2026-09-30, two passes the same day, §2.4.3b's addendum) — built and
  tested in PR #1163: never presence-alone, never a matching-transaction requirement satisfied by
  a time buffer, and (second pass) never limited to drops — the trade leg's own write now gets
  the identical write-ahead + reconciliation discipline, closing the "duplicate trade execution
  when the response is lost" risk structurally, not by convention. `tests/trade_2way_drop_first_
  execute.test.mjs` covers both: the drop-side reconciliation suite (including both named
  intervening-change cases and two tests proving elapsed time alone never triggers a retry) and a
  dedicated trade-leg reconciliation suite (a crash-then-resume that reconciles via MFL's own
  TRADE transaction record with zero duplicate MFL calls, a resume that correctly holds when no
  matching record exists, and same-pass reconciliation when the original call's own response was
  ambiguous). A matching MFL transaction record (queried directly, matched to franchise/player or
  franchise/franchise+give/receive, and the attempt timestamp) is the ONLY authoritative evidence
  for a confirmed reconciliation, for either a drop or the trade; absent that record, the step
  holds for commissioner review — permanently, not until some elapsed time passes.
- **The per-franchise hold covers every in-app creation, counter, acceptance, and execution path
  for either affected team, AND checks every participant of a 3-way trade, not just the
  responder** (§8.6, Keith's ruling 2026-09-30, two passes) — CLOSED: the legacy direct-MFL 2-way
  route (create/counter/accept) and the 3-way engine (create/accept/execute) are wired to the
  same hold staged 2-way already had; `handle3WayButton`'s own accept-time check was corrected
  (second pass) to check all three of a 3-way trade's own participants, not the responding
  franchise alone, and is now independently unit-tested
  (`tests/trade_3way_button_hold.test.mjs`, 7/7). MFL's own native site remains outside any
  in-app hold's reach, by design, documented as such in §8.6.
- **The hold's own D1 binding is now correct** (§8.6, Keith's ruling 2026-09-30, second pass) —
  fixed directly, not deferred: `UPS_MFL_DB` is preferred everywhere the drop-first hold, the
  execution ledger, and the cap-ack/conditional-drop stores resolve their D1 binding, so an
  unrelated outbox-DB failure can never bypass or falsely satisfy the hold. Tested directly, and
  this also fixed a genuinely pre-existing, previously-failing test in `trade_2way_authz.test.mjs`
  that had been broken by this exact bug.
- **An owner can never retrigger a failed/uncertain step; only a commissioner may resume it**
  (§2.4.5, Keith's ruling 2026-09-30) — DECIDED and enforced: the execute route is
  commissioner-only, the ledger lock itself independently blocks a second acquisition regardless
  of route, and the one real gap found while verifying this (`recheck2WayExecution` could flip
  `row.status` and hand back a false "rechecking" without ever causing a second write) is now
  closed and tested.
- **The aging-alert question is resolved: built, not merely "needed"** (§2.4.6, Keith's ruling
  2026-09-30) — a commissioner-DM escalation plus a distinct queue-UI banner for any drop-first
  sequence stuck past 30 minutes, both shipped and tested in PR #1163. The immediate,
  higher-urgency alert for the specific player-loss scenario (a confirmed drop followed by a
  failed/unconfirmed trade) fires synchronously the moment it happens (`runTradeLegAfterDrops`'s
  own `notifyCommish` call); the 30-minute aging alert is the FOLLOW-UP if that first alert goes
  unresolved, and (second pass) its own copy now says so explicitly ("PLAYER-LOSS FOLLOW-UP")
  rather than reading as a generic staleness ping when that's what's actually stuck.
- **No new backup-commissioner authority is granted as part of this PR** (§2.4.4, Keith's ruling
  2026-09-30) — explicitly declined here, not left open; the aging alert above is the mitigation
  this PR ships instead of a second authorized executor.
- **No automatic retry from a missing MFL transaction record, at any elapsed time, for either a
  drop or the trade** (§2.4.3b's export-coverage addendum, Keith's ruling 2026-09-30, SECOND
  correction the same day) — an earlier revision of this fix used a 5-minute time buffer before
  trusting a "no match" result; Keith's correction is that a buffer is still a guess, not a proof,
  and this codebase has no independent evidence of the export's actual latency at any elapsed
  time. The buffer was removed entirely. Cloudflare edge-caching is still ruled out via an
  explicit cache-bypass header (a genuinely separate, still-valid fix). Tested directly: the same
  "present, no match" facts hold identically at 30 seconds and at 10 days.

**Still blocking release — genuine decisions, not implementation details:**

- **The exact new `steps_json` shape (drop AND trade steps) and the real `partial_executed`
  ledger state** — PR #1163 has ALREADY built and shipped (behind the flag) the concrete shape
  used throughout this section: a drop step is `{status, franchise_id, player_id,
  pre_drop_snapshot, mfl_verification?, mfl_evidence?, reconciled?, reason?, attempted_at_utc? |
  confirmed_at_utc?}`; the trade step (new, second pass) is `{status, from_fid, to_fid,
  mfl_trade_id?, mfl_evidence?, reconciled?, reason?, attempted_at_utc? | confirmed_at_utc?}` —
  this item is effectively resolved by PR #1163's own code, listed here only until that PR itself
  is reviewed and the shape is considered final.
- **The exact commissioner-facing and owner-facing notification copy** for every outcome named in
  §12.2 — PR #1163 ships real, distinct copy for every case this document names (drop confirmed/
  trade pending, drop failed, drop unconfirmed, reconciled via transaction log, trade completed,
  the player-loss case — now naming which players/teams were actually dropped), plus the aging
  alert's own copy — listed here only pending Keith's review of the actual wording.
- **Whether the commissioner needs an urgency signal for the free-agent race** (§11) — not built;
  the player-loss DM tells the commissioner to act, but nothing pages or escalates if they don't.
  Distinct from §2.4.6's aging alert, which escalates an unresolved LEDGER state (including,
  second pass, an immediate high-urgency variant for the player-loss case specifically), not the
  separate, faster free-agent-reclaim race a restoration attempt runs against.
- **`/roster-workbench/action`'s own real MFL-HTML-form scraping has no test coverage anywhere in
  this repo** (§2.4.3b's test-infrastructure boundary, called out since the first pass, not
  introduced by this one) — a genuine gap before the flag ever flips on for real; every test in
  this feature stubs only that route's JSON response contract, traced exactly from its source.

**Until every "still blocking" item above is explicitly resolved, `TRADE_2WAY_DROP_EXECUTE_
ENABLED` stays off and no commissioner-facing "complete this trade" action runs for real.** §12.1's
read-only/dry-run surface (and now PR #1163's real, flag-gated engine, still never enabled) is
the full extent of what ships in this pass.
