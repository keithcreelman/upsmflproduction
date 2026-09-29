# Loaded-Contract Conditional-Drop EXECUTION — design doc (not implemented)

**Status: design/trace only.** No code in this document has been written. Per Keith's ruling
(2026-09-29): *"Before implementing live conditional drops, trace MFL's actual drop and trade
calls and present the execution sequence... Do not merge or deploy the conditional-drop
execution path until its failure handling and live-write sequence have been reviewed."* This
doc is that trace and that review surface. The SELECTION side (an owner picking and confirming
which of their own loaded-contract players to drop, conditional on the trade) is built, tested,
and committed on `feat/loaded-contract-conditional-drops-2026-09-29` — see
`docs/TRADE_WAR_ROOM.md` and that branch's commit history. Nothing there performs a real MFL
drop or trade write. This doc is what a *later*, separately-reviewed PR would build.

**Evidence vocabulary:** **[verified]** = read directly from `worker/src/index.js` /
`worker/src/trade_3way.js` / `worker/src/trade_execution.js` in this session, with file:line
citations. **[inferred]** = a design conclusion drawn from that code, not itself executed.
**[open question]** = something this doc identifies but does not resolve — for Keith.

---

## 1. What already exists, exactly, and where

### 1.1 The drop write

**Route:** `POST /roster-workbench/action?action=drop_player`, `worker/src/index.js:56166`.
**[verified]**

- MFL call: an **import**, `TYPE=taxi_squad`, `DROP=<playerId>`, `FRANCHISE_ID=<franchiseId>`
  (`index.js:56552,56561-56568`) — sent as a GET with the fields as query params, via
  `postMflImportFormForCookie(viewerCookieHeader, ...)`. MFL has no dedicated `TYPE=drop`; a
  drop is expressed as a `DROP=` parameter riding the taxi-squad import. **[verified]**
- Authentication: the **caller's own MFL owner session** (`viewerCookieHeader` / forwarded
  `MFL_USER_ID`), with `FRANCHISE_ID` set for commissioner impersonation; on impersonation
  lockout it retries once *without* `FRANCHISE_ID`, which only succeeds if the caller genuinely
  *is* the owner (`index.js:56596-56610`). Anonymous calls are refused (`index.js:56586-56592`).
  **[verified]**
- **Success/failure detection deliberately does not trust MFL's response body.** The route's
  own header comment (`index.js:56166-56186`) documents two real incidents (2026-08-15,
  2026-09-07) where MFL's response text was misread. Instead it re-reads `TYPE=rosters`
  (`index.js:56665`) and checks whether the player is now located on **no** roster
  (`index.js:56720-56743`). Only an explicit MFL refusal short-circuits before that read
  (`index.js:56660,56869-56892`). **[verified]**
- **If the verifying roster-read itself fails**, the route returns
  `{ ok:true, verified:false, retry_safe:false }` and *explicitly tells the caller not to
  resend*, because "this action is not idempotent" (`index.js:56894-56916`). **[verified]**
- **No structural idempotency lock** guards this route against a duplicate call the way trade
  execution has one (§1.2). Safety today rests on (a) requiring the real owner's/commish's
  session, and (b) that explicit "don't resend on unconfirmed" instruction to callers.
  **[verified]**
- **No D1 write** happens as part of this route, before or after. `ups_drop_events` — the table
  the cap-penalty math actually reads — is populated **separately and asynchronously** by
  `POST /admin/drops/scan-and-record` (`index.js:51473-51530`), which scans MFL's own
  `TYPE=transactions&TRANS_TYPE=FREE_AGENT` export over a rolling window and inserts rows keyed
  `UNIQUE(season, league_id, player_id, dropped_at_unix)`. It discovers *any* drop from MFL's own
  ledger after the fact, regardless of who or what caused it — this route never calls it
  directly. **[verified]**

### 1.2 The trade write

**2-way owner accept:** `POST /trade-offers/action` (aliased `/api/trades/proposals/action`),
`index.js:38893` — `TYPE=tradeResponse` import, sent as the **real owner's own session**
(`postMflImportFormAsViewer`), `index.js:39968-39987`. **[verified]**

**3-way (and any commissioner-impersonated 2-party leg):**
`executeCommishTwoPartyTrade`, `trade_3way.js:92-176` — propose (`TYPE=tradeProposal`,
`trade_3way.js:100-111`) then accept (`TYPE=tradeResponse`, `trade_3way.js:158-168`), both
authenticated as **commissioner** (`env.MFL_APIKEY`), impersonating each side in turn. A 3-way
decomposes into 1–3 of these pairwise MFL trades (`execute3Way`, `trade_3way.js:1118-1284`,
plan built at `1144-1154`, legs run **in order**, `trade_3way.js:1219`). **[verified]**

**Idempotency (why MFL is never called twice for the same execution):**
- The execution ledger (`worker/src/trade_execution.js`) acquires a compare-and-set lock
  (`not_executed`/`blocked_cap` → `executing`) **before** any MFL call
  (`trade_execution.js:97-114`; `trade_3way.js:1186-1201`; `index.js:39945-39966`). A second
  concurrent/duplicate call finds the row already locked and is refused
  (`already_executed`/`execution_in_progress`, `index.js:39958-39965`). **[verified]**
- Independently, MFL's own "Duplicate trade offer" response is treated as *proof the offer
  already exists*, not a failure — the code looks it up via `TYPE=pendingTrades` and accepts the
  existing one instead of creating a second (`trade_3way.js:120-129`). **[verified]**

**Partial-success handling that already exists today** (the direct precedent for everything
this design reuses), from `execute3Way`:
- If a later leg fails after an earlier leg already landed, **nothing is rolled back** — MFL has
  no undo for a completed trade (`trade_3way.js:19-21`, explicit comment). The 3-way row is
  marked `failed` with `failure_reason` naming exactly which trade ids landed
  (`trade_3way.js:1136-1141,1230`); the **execution ledger** moves
  `executing → executed_needs_review` (never back to `not_executed`) carrying
  `mfl_evidence_json: {trade_ids: done}`; a `🚨 partial` DM goes to the commissioner naming the
  landed trade ids and demanding manual intervention (`trade_3way.js:1231-1232`). **[verified]**
- If **no** leg had landed yet, the ledger instead reverts `executing → not_executed` so a future
  attempt can retry cleanly (`trade_3way.js:1241`) — except a commissioner-lockout failure, which
  also reverts to `not_executed` but with a dedicated "toggle lockout and re-run" DM instead
  (`trade_3way.js:1233-1237`). **[verified]**
- If every leg lands but a **post-processing** step fails (extensions, salary adjustments), the
  trade row is marked `completed` (MFL genuinely executed it) with
  `failure_reason: "executed_needs_review:..."`, the ledger sits at `executed_needs_review`, and
  the DM explicitly says the trade **must not be re-run** — only the specific failed
  post-processing step is retryable, via `retry3WayPostProcessing`
  (`trade_3way.js:959-982,1269-1281`), which itself refuses if any *leg* failed, not just
  post-processing (`trade_3way.js:967`). **[verified]**

**Ledger states and transitions** (`trade_execution.js:24-47`): `not_executed`, `executing`,
`mfl_executed`, `postprocessing`, `completed`, `executed_needs_review`, `blocked_cap`. Once a
row reaches any of `mfl_executed | postprocessing | completed | executed_needs_review`
(`MFL_DONE_STATES`), "MFL executed this" is permanent and the row never returns to
`executing`/`not_executed`/`blocked_cap` (`trade_execution.js:34-47`). Post-processing steps are
recorded incrementally into `steps_json` via `recordStep()` (`trade_execution.js:180-187`) —
read-modify-write, so a partially-complete post-processing set is always visible.

### 1.3 No "undo a drop" mechanism exists

Searched the whole worker tree: nothing calls MFL to reverse a drop. **[verified]** The closest
thing — `explainClosedSeasonAnomaly` (`worker/src/fcfs_contract.js:587-615`) — is a read-only
forensic classifier for the FCFS defect scanner; it *observes* that MFL sometimes preserves a
contract when the *same* franchise re-adds the *same* player within 3600s
(`READD_WINDOW_SECONDS`, `fcfs_contract.js:577`), it never calls MFL, and per the adjacent
comment (`fcfs_contract.js:622-623`) "a described contract is never reverted" outside that
narrow window. **A conditional drop, once it actually executes against MFL, is permanent.**
There is no code path that would restore the dropped player or their prior contract terms; a
normal re-add is a fresh acquisition (WW/FAA/etc.), not a reversal.

---

## 2. The one load-bearing design decision: TRADE FIRST, DROP(S) SECOND

Two orderings are possible for a trade that needs conditional drops to be legal. The consequence
of a mid-sequence failure is different enough between them that this is the single most
important call in this design.

**Drop-first:** if the drop lands and the trade then fails for *any* reason (a cap check that
changed between accept and execute, MFL commissioner lockout, a transient MFL error, a race on
asset ownership), **the team has permanently lost a real roster player — including whatever real
cap dead-money penalty that drop carries — for a trade that never happened.** This is exactly
the "never silently strand a team after an irreversible drop" failure the ruling calls out by
name, and there is no undo (§1.3).

**Trade-first:** if the trade lands and a drop then fails, the team is left *over the
loaded-contract limit* until the drop is retried or a commissioner intervenes manually — a
soft, recoverable, purely bookkeeping problem. The trade itself, which both/all parties agreed
to, is not put at risk by a later drop failure. This is also consistent with how the *existing*
post-processing failures already behave (§1.2, "the trade WAS executed... must not be re-run" —
only the failed step is retried).

**Conclusion: the trade always executes first. Every conditional drop is POST-PROCESSING,
recorded as its own step in the SAME execution ledger the extension/salary-adjustment
post-processing already uses** — no new ledger states, no new state machine. A drop step that
fails leaves the trade `completed`/`executed_needs_review` (trade genuinely happened) with the
specific outstanding drop(s) named, exactly mirroring the extension-post-processing-failure case
already built and shipped.

A genuinely-unsatisfied requirement (nobody ever validly selected a drop, or a selection stopped
being valid) is caught **before** execution, by the existing hard block (`capGate()`'s
`loaded_contract_drops_required`, already shipped) — it never reaches this post-processing step
at all. This section is only about what happens once the trade is *already* clear to execute and
carries confirmed drop selections to apply afterward.

---

## 3. Proposed execution sequence

1. **Immediately before firing the MFL trade call** (2-way accept, or `execute3Way`'s existing
   pre-flight), re-run `evaluateTradeCompliance` one more time with the CURRENT contents of
   `ups_trade_conditional_drops` as `conditionalDrops` — the same call `capGate()`/
   `complianceViaSelf()` already make. If `loaded_contracts.status !== "ok" && !== "needs_drops"`
   (i.e. any affected franchise's stored selection is no longer valid — the roster changed again,
   a selected player is no longer loaded, etc.), **hold, exactly like today's `blocked_cap`
   path** — zero MFL writes, approvals kept, a clear DM. This is not new logic; it's the existing
   gate, just re-run at the latest possible moment before commitment, matching "revalidate
   immediately before each acceptance and again before execution."
2. **Execute the trade** via the existing, unmodified mechanism (§1.2) — owner session for a
   2-way accept, `executeCommishTwoPartyTrade` legs for a 3-way. No change to this step at all.
3. Once the ledger reflects `mfl_executed` (trade genuinely landed — the *permanent* marker,
   §1.2), enter **post-processing** exactly where extension/salary-adjustment steps already run.
   For every `(franchise_id, player_id)` pair from the FINAL validated selection (not merely
   whatever was stored — re-confirmed in step 1), execute one drop, **sequentially, one at a
   time** (not in parallel — simpler to reason about, avoids MFL rate/concurrency issues, matches
   the existing legs-run-in-order precedent). Each drop:
   - Calls the **same MFL mechanism** §1.1 already uses (`TYPE=taxi_squad`, `DROP=<playerId>`,
     `FRANCHISE_ID=<franchiseId>`), but **commissioner-impersonated** (`env.MFL_APIKEY`), not an
     owner session — see §4 for why this has to be true uniformly.
   - Uses the **same verification discipline** as the existing route: never trust MFL's response
     text; re-read `TYPE=rosters` and confirm the player is now on no roster.
   - Is recorded via the *existing* `recordStep()` into `steps_json`, keyed distinctly per
     player (e.g. `drop:<franchise_id>:<player_id>`) so a 2-of-N partial completion (the 5→7 case)
     is visible per-player, not as one opaque "drops" blob.
4. If every drop step succeeds: `postprocessing → completed`, same as today.
5. If a drop step fails (a real MFL refusal, or an unconfirmed/ambiguous verification): **stop
   the sequence** (do not attempt the remaining drops blindly, do not touch the trade), move
   `postprocessing → executed_needs_review`, and send a commissioner DM/alert that says, plainly:
   the trade executed and is final; these specific franchise/player drops are confirmed; these
   specific ones are NOT confirmed and need manual attention — mirroring the existing extension-
   failure DM's own wording ("the trade itself must not be re-run") exactly.
6. Drop-penalty dollars are **not** computed or applied by this step. `ups_drop_events` /
   the cap-penalty cron (§1.1) already discovers *any* real MFL drop from MFL's own transaction
   ledger and backfills the penalty asynchronously, regardless of what caused the drop. Nothing
   new is needed here — inventing a second, synchronous penalty computation would risk disagreeing
   with the one authoritative source.

---

## 4. Identity: who authenticates each drop, and why it must be uniform

For a 2-way trade, the **recipient** is present (an owner session exists — they're the one
clicking Accept) at the moment of execution. The **sender**, though, selected their own drop at
*offer creation*, potentially days earlier — their browser session is long gone by the time
someone else decides to accept. For a 3-way, execution runs from a Discord-webhook/background
context (`ctx.waitUntil`) with **no owner session at all**, exactly why `executeCommishTwoPartyTrade`
already uses commissioner impersonation for every leg (§1.2).

**Conclusion: every conditional drop, for either party, 2-way or 3-way, executes via
commissioner impersonation** (`env.MFL_APIKEY`, `FRANCHISE_ID=<affected franchise>`) — the same
authority `executeCommishTwoPartyTrade` already relies on, never a real owner's session. This
keeps the mechanism uniform regardless of who happens to be online when execution actually runs,
and reuses an authority path already proven in production for trade legs.

**[open question] for Keith:** the drop route's own impersonation path is already gated by MFL's
commissioner-lockout setting, with an existing, shipped fallback for trade legs (a `⏸️ lockout`
DM asking the commissioner to toggle lockout and re-run, §1.2). If commissioner lockout is
**habitually left on** in this league, *every* conditional-drop trade would land in
`executed_needs_review` and need 100% manual completion by a human toggling lockout — the trade
itself would still go through, but the drop half would never auto-complete. Worth confirming
lockout's normal operating state before this ships, since it changes how often "needs review"
would actually fire in practice.

---

## 5. Idempotency and retry safety for the drop step specifically

Trade-call idempotency needs no new work — the existing ledger lock plus MFL's own
duplicate-offer detection (§1.2) already cover it completely, and this design does not touch that
mechanism.

For the **drop** step, which has no MFL-side idempotency guarantee (§1.1), a retry (whether
triggered by a commissioner's "retry post-processing" action, or an automatic retry of the same
request) must, before ever re-sending the `DROP=` import:
1. Check `steps_json` for this exact `drop:<franchise_id>:<player_id>` key — if already marked
   done, skip.
2. If not yet marked done (e.g. a crash occurred between the MFL write and the ledger update —
   the exact gap the existing route's own "not idempotent, don't resend on unconfirmed" warning
   exists to guard against), do a **fresh `TYPE=rosters` read first** and check whether the
   player is already absent from every roster. If so, mark the step done from that evidence
   *without* resending — exactly the verification-over-response-text discipline the existing
   route already uses for its own retry safety.
3. Only if the player still appears on the expected roster does a genuine retry actually resend
   the `DROP=` import.

This closes the crash-between-write-and-record gap without inventing any new idempotency
primitive — it's the identical discipline §1.1 already applies to a single request, just also
applied across retries via the ledger's own step record.

---

## 6. What this design deliberately reuses, unchanged

- The execution ledger (`trade_execution.js`) — no new states, no new table, no new locking
  primitive. Conditional drops are one more post-processing step type.
- `executeCommishTwoPartyTrade`'s commissioner-impersonation pattern, for drops too (§4).
- The drop route's own MFL-response-distrust / roster-read-verification discipline (§1.1, §5) —
  reused exactly, not reinvented.
- The cap-penalty cron (`ups_drop_events` / `/admin/drops/scan-and-record`) for dollar amounts —
  not duplicated (§3.6).
- `capGate()` / `evaluateTradeCompliance`'s existing hard-block-before-execution behavior — this
  design only adds a re-check at the latest possible moment (§3.1), it doesn't change what
  "blocked" means or does.

## 7. What is explicitly NOT decided here, and needs review before code is written

- The exact new export/function shape (e.g. `executeCommishDrop(env, franchiseId, playerId)`
  mirroring `executeCommishTwoPartyTrade`'s own shape) — sketched in prose above, not written.
- Whether `recordStep()`'s existing `steps_json` shape needs any new fields to carry
  per-player-drop evidence cleanly, or whether the existing shape already suffices.
- The exact commissioner-facing DM/alert copy for a partial-drop `executed_needs_review` state
  (should mirror the existing extension-failure DM's tone and specificity, not invent a new one).
- The lockout operating-mode open question in §4.
- Whether a commissioner should be able to select/override a drop on an owner's behalf in the
  `executed_needs_review` recovery flow, or whether that recovery is strictly "the owner picks
  again via the existing select-drops surface, then a commissioner-triggered retry re-attempts
  just the outstanding steps."

None of the above changes the two conclusions this doc is actually for: **trade before drop, and
drop authentication is uniformly commissioner-impersonated** — those two should be confirmed (or
overridden) before any of the above gets written as code.
