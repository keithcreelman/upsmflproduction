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

### 2.1 Ordering A — TRADE FIRST, drop(s) after

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

### 2.2 Ordering B — DROP(S) FIRST, trade after

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

### 2.3 The actual tradeoff, stated once, plainly

Ordering A trades a temporary, self-correcting-in-the-success-case rule exposure (being over 5
for a bounded window) for a **soft, recoverable** failure mode (bookkeeping stays off until a
human fixes it — nothing was taken from anyone). Ordering B eliminates that rule exposure
entirely, at the cost of a **hard, irreversible** failure mode (a real, permanent asset loss with
no compensating trade) whenever the *subsequent* step — the trade itself, now the second
operation instead of the first — fails for the same set of ordinary reasons (lockout, refusal,
ambiguity) that can hit either operation in either order.

This is a real value judgment about which kind of failure is more acceptable in this league, not
an engineering question with one correct answer, and it should not be assumed. This doc's own
prior draft assumed Ordering A; on Keith's instruction it is now presented, not assumed.

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
  waits, with no automated fallback and no second authorized executor documented here. Whether a
  backup-commissioner path is needed is not decided in this document.

This procedure supersedes any assumption in §8.2 that staging leads directly to an AUTOMATED
final write — §8.2's step 5 ("the worker executes the real MFL trade... executes any confirmed
drop(s)") describes what happens ONLY if and when Keith later approves automating one of §2.1/
§2.2's orderings. Until then, §8.2's step 5 is this section: a human, not the worker, performs
every write the deal requires, through the review queue, following §2.4.3 exactly.

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

Selecting and confirming the drop (today, shipped) is the artifact of this consent, but it does
not yet SAY these three things. This section is the requirement for what it must say before the
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

#### 8.5.1a Empirical inventory + a concrete cutover procedure (2026-09-29, after client wiring shipped)

**Live inventory, checked 2026-09-29:** `ups_trade_offer_watch` (the sentinel's mirror of every
pending MFL offer, in-app AND native-desktop) holds exactly 4 rows total, ever, all
`lifecycle: 'gone'`, all from 2026-07-22 — nothing since. `TRADE_SENTINEL_ACT_ENABLED` and
`TRADE_SENTINEL_ADOPT_NATIVE` have both been live (`"1"`, via a D1 `ups_settings` override) since
2026-09-18 — 11 days before this check — so native-offer tracking, not just in-app, has genuinely
been running the whole time; the sentinel is wired into `scheduled()` on both the hourly and
`*/5min` crons (`worker/src/index.js`'s `/admin/trade-sentinel/tick`, STEP A). **This session could
not independently confirm the live count via MFL's own `pendingTrades` API directly** (no
`MFL_APIKEY`/`COMMISH_API_KEY` value available in this environment) — a new, genuinely read-only
diagnostic exists for this now (`GET /admin/trade-offers/live-mfl-inventory`, added this pass,
tested in `tests/trade_offers_live_mfl_inventory.test.mjs`; it enumerates every franchise's
`pendingTrades` via the same commissioner-impersonated GET the sentinel's STEP A already uses, and
performs **zero** D1 or MFL writes of any kind), but running it requires the real
`COMMISH_API_KEY`, which only Keith has. The fastest, zero-engineering way to get a live,
authoritative answer right now is simply **MFL's own Commissioner → Trades → Pending Trades page**
— no new code, no deploy, and it is the same data source this whole section is reasoning about.

**Lockout, checked 2026-09-29:** the league's `lockout` setting is currently **`"Yes"`** (public
`league` export). This is NOT currently a deliberate control for this feature — it predates this
work and its purpose here is unaudited — but it is directly relevant to what a cutover can rely
on. Real, already-shipped code (`worker/src/trade_3way.js`, `executeCommishTwoPartyTrade`) detects
MFL's own literal response text — **"Commissioner can not impersonate another franchise with
lockout on."`** — as a distinct failure mode; this has been observed in production MFL responses,
not guessed. That confirms, with direct evidence: **lockout blocks commissioner-impersonated
transactions specifically** (this app's own `executeCommishTwoPartyTrade`, used for every 3-way and
staged-2-way execution, would itself be refused by MFL while lockout is on). **Whether lockout ALSO
restricts an ORDINARY OWNER's own native trade action (logged into their own MFL account, no
impersonation involved) was NOT independently verified this pass** — it would require either a live
test against MFL (out of scope: this pass makes zero real MFL writes) or Keith's own knowledge of
MFL's documented lockout behavior. The specific error text MFL returns names impersonation only,
which is suggestive but not proof that ordinary members are unaffected — treat this as an open
question, not a settled fact, before relying on it for anything.

**Concrete recommendation, given the above (this document previously offered A/B/C with no
recommendation; here is one):** **Option C, and it requires no new engineering** — the sentinel has
already been running in the ACT+ADOPT_NATIVE configuration for 11+ days, watching every native and
in-app pending offer. The empirical population needing "cutover" management is, right now, zero.
The concrete procedure:

1. **Before flipping the staged-2-way UI live for real owners** (client wiring shipped this pass,
   still gated by `TRADE_2WAY_STAGING_ENABLED`/`TRADE_2WAY_STAGING_EXECUTE`, both off): take one
   final live snapshot (Keith's own MFL Commissioner console, or the new
   `/admin/trade-offers/live-mfl-inventory` route with his key) to document exactly what, if
   anything, is pending at that moment. Given the current empirical trend (zero for the last ~2.5
   months), the expected answer is "nothing," but confirm rather than assume.
2. **Do not revoke anything already pending** (rejects Option B) — an owner's real, possibly
   already-agreed offer that was never risky (most pending offers involve no loaded-contract
   exposure at all) should not be cancelled out from under them; that is a real, avoidable
   disruption for a population that is empirically at or near zero.
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
- **Execution model: manual commissioner review (§2.4), not automated ordering.** Neither §2.1
  (trade-first) nor §2.2 (drop-first) is approved for automation; the exact manual procedure and
  its own, different non-atomic risks are specified in §2.4.3/§2.4.4.
- **Staging: universal — every 2-way trade (§8.1-8.3)**, not the narrower, heuristic-scoped
  alternative this document previously offered alongside it.
- **Ext1/Ext2 loaded-contract classification and the IR ruling** (§9) — shipped as PR #1152,
  separate from this branch, not yet merged.

**Still open, and needing review before ANY execution code is written:**
- **Cutover for already-pending native offers** (§8.5.1, concrete procedure added §8.5.1a
  2026-09-29) — **recommendation: Option C**, which requires zero new engineering since the
  sentinel has already been running in the ACT+ADOPT_NATIVE configuration since 2026-09-18 and the
  live population needing cutover management is empirically at or near zero right now. Still
  Keith's decision to approve, not yet acted on.
- **Whether to restrict native MFL trade permissions for regular owners at the league-configuration
  level** (§8.5.2) — the only lever that would close the residual "two owners transact directly on
  MFL, outside this app entirely" gap universal staging cannot reach. A commissioner/league-setting
  decision, not code. **Still unaudited** — the public `TYPE=league` export has no such field, and
  auditing it requires MFL's commissioner console directly, which this session has no access to.
  The related `lockout` setting is currently `"Yes"`, but code evidence shows it specifically blocks
  commissioner-IMPERSONATED transactions (MFL's own error text names impersonation), not
  necessarily an ordinary owner's own native trade action — that distinction was not independently
  verified this pass either, and should not be assumed.
- Whether automating one of §2.1/§2.2's orderings is ever revisited, and if so which — §2.4's
  ruling is explicitly framed as "not yet" ("Do not choose automatic trade-first or drop-first
  **yet**"), not a permanent rejection.
- **Which sequence a multi-write deal's manual execution should follow, if any fixed rule at
  all** (§2.4.3's closing paragraph) — a fixed rule (always drops first, always trade first,
  something conditional) versus leaving it to the commissioner's judgment per deal. Explicitly
  NOT decided by removing the prior draft's "drops first by default" assumption — that removal
  was a correction, not a decision for the opposite default.
- **The compensating-resolution mechanism for a `partial_executed` deal** (§2.4.3, state *k*) —
  once the commissioner understands why a mid-sequence write failed, what recovery actually
  looks like for the owner(s) whose asset already, irreversibly moved (retry the remaining
  writes once the cause clears; negotiate an adjustment; something else) is explicitly not
  prescribed here.
- The exact commissioner-facing and owner-facing notification copy for every outcome in §2.4.3
  (state 0 / state *k* `partial_executed` / state *N* success).
- Whether a queued deal sitting unreviewed, or a stuck `partial_executed` deal, needs its own
  aging alert, and whether a backup-commissioner path is needed for when the primary
  commissioner is unavailable (§2.4.4).
- The review-queue UI itself (§2.4.2/§2.4.4) — surfacing each deal's true partial state live
  from the ledger, and once the sequencing question above is resolved, enforcing whatever
  sequence rule follows from it.
- The exact consent-copy changes to the shipped selection UI (§3) — needed regardless of the
  execution model, and not yet built.
- The lockout operating-mode open question (§4), unchanged from v1.
- The exact new function shape for a commissioner-authenticated drop call and any new
  `steps_json` fields it needs (including the new `partial_executed` ledger state, §2.4.3) —
  sketched in prose (§1.1, §2.4.3, §7), not written.

None of the still-open items is resolved by this document. It is the reviewable design Keith
asked for, with every specific failure mode he named addressed by name, the decided execution
and staging models specified precisely rather than assumed, a real design (not a hand-wave) for
the native-bypass gap and its honest limits, and an explicit list of what still needs a decision
before a single line of execution code is written.
