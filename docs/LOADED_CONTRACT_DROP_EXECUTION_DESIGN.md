# Loaded-Contract Conditional-Drop EXECUTION — design doc (not implemented)

**Status: design/trace only, REVISED.** No code in this document has been written or approved.
Keith's review of the first version (2026-09-29): *"Do not merge, migrate, or deploy PR #1149 as
currently written. I am not yet approving either 'trade first, drops second' or automatic
commissioner-impersonated drops... Revise the execution design without assuming either operation
order is safe."* This version does that: both orderings are presented in full, the native-MFL
bypass gets an actual design (not a rely-on-our-own-routes assumption), and every specific
failure mode Keith named is addressed by name. Nothing here is built. The SELECTION mechanism
(an owner picking and confirming which of their own loaded-contract players to drop, conditional
on a trade) is built, tested, and committed — and, as of the companion fix in this same review
round, a satisfied selection is now verified to produce **zero** real MFL writes anywhere in the
codebase, by direct test (`tests/trade_loaded_contracts.test.mjs`'s `LC EXEC-GATE` suite). This
doc is what a *later*, separately-reviewed PR would build on top of that.

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

## 2. Neither ordering is assumed safe — both, in full

There are exactly two ways to sequence "the trade" and "the conditional drop(s) it requires."
Both have a real, irreducible failure mode, because MFL gives no way to make the pair atomic
(§2.5). This section presents both completely, states the residual risk plainly, and asks Keith
to choose (or direct a manual/staged alternative) rather than assuming either is correct.

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

### 2.4 A third option: hold the whole thing for manual resolution instead of ordering at all

Given MFL genuinely cannot make "drop + trade" atomic (§2.5), a legitimate alternative to
choosing an ordering is **not automating the write at all**: once a franchise's selection is
`needs_drops` (satisfied), route it into a **commissioner-review queue** — visible in a Front
Office panel, naming the exact trade, the exact player(s) selected, and the exact expected
penalty — where a human performs the drop and then releases the trade to execute (or performs
both manually), rather than the system doing either write on its own. This trades speed/
convenience for a human always being the one making the final, irreversible call, which may be
the right choice for a rule this consequential given MFL's total lack of atomicity or undo. This
is presented as a genuine option, not a fallback — Keith may prefer this over EITHER automated
ordering.

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

## 8. Native-MFL-bypass: a staged proposal that cannot be natively accepted

**The problem, confirmed exactly:** the 2-way CREATE gate now refuses whenever the **initiator's**
own requirement isn't satisfied (this review round's fix). It does not, and by original design
never did, check the **recipient's** own requirement at creation — that was always meant to be
"the recipient's own concern at accept." This means: a 2-way trade where the initiator is fine but
the RECIPIENT would go over the limit **still becomes a real, native MFL `tradeProposal`** the
moment it's created — visible and independently acceptable on MFL's own site. If the recipient
accepts there instead of through this app, MFL processes the trade for real and **no code in this
app ever runs** — not the accept-time gate, not the drop requirement, nothing. This is real today,
confirmed by re-reading the create/accept code paths in this review round, and it is not closed by
this round's `needs_drops` fix (which only closes "a satisfied selection unlocks a write **through
this app's own routes**" — it does nothing about MFL's own native accept button, which no
worker-side code has ever gated).

**3-way has no equivalent exposure**, confirmed separately: a 3-way trade is 100% held server-side
(D1 only) until BOTH partners accept AND `capGate()` clears — it never becomes a native MFL
pending trade at any point before execution, so there is nothing for a native accept to bypass.
This asymmetry is architectural, not incidental, and is the direct precedent for the fix below.

### 8.1 Design: make an over-limit-relevant 2-way trade behave like 3-way until it's ready

**When a 2-way trade's participants are ALL clear of the loaded-contract limit** (the overwhelming
majority of trades), nothing changes: the existing native `tradeProposal`/`tradeResponse` flow
stays exactly as it is today — fast, simple, no added complexity for the common case.

**When a 2-way trade would affect the loaded-contract limit for EITHER side** (sender or
recipient — checked the same way `evaluateTradeCompliance` already checks it today, just for
*both* participants at creation instead of only the initiator), the offer is **never proposed to
MFL at creation**. Instead:

1. It is stored exactly like a 3-way — a D1-only row (reusing `ups_3way_trades`'s pattern, or a
   parallel two-party table with the identical shape) — completely invisible to MFL's
   `pendingTrades` export, and therefore to MFL's native site, until it is ready to execute.
2. The recipient sees and interacts with it through this app's own inbox (extending the existing
   2-way inbox UI to also render staged offers, the same way the 3-way inbox already has its own
   card type) — never through MFL's native pending-offers list, because it does not exist there.
3. The recipient (and, if their own status changed since creation, the sender again) selects and
   confirms their own conditional drop(s) through the existing, already-built selection UI.
4. Only once **every** affected participant's requirement is `ok` — either never having been over
   the limit, or (once §§1-7 of this design are built and separately approved) their drop(s)
   having genuinely executed — does the **worker itself** create and immediately accept the real
   MFL trade, via commissioner impersonation, reusing `executeCommishTwoPartyTrade` exactly as
   3-way already does for its own legs. At no point before that moment does a native, independently
   acceptable MFL trade exist for this deal.

This closes the bypass completely, for the same structural reason it is already closed for
3-way: **there is nothing on MFL's own site to accept until the app itself decides to create it.**
It reuses `executeCommishTwoPartyTrade` (already proven in production for 3-way) rather than
inventing a new write path, and it only changes behavior for the subset of 2-way trades that
actually touch the loaded-contract limit — every other 2-way trade is completely unaffected.

**This is a real, substantial change** (a new staging path for a subset of 2-way trades, new
"staged offer" UI on both platforms, and the underlying create/accept HTTP surface reshaped for
that subset) — presented here as a design for review, not implemented. It should be reviewed and
approved as its own unit before any of §§1-7's actual drop-execution code is written, since it
changes *when* a 2-way trade becomes real, independent of whether execution itself is built yet.

### 8.2 A supplementary, imperfect mitigation — not a substitute

Until §8.1 ships, `worker/src/index.js`'s existing "trade-sentinel" sweep (`/admin/trade-sentinel/
tick`, already polling every pending MFL trade for stale-ownership violations and auto-revoking
them) could be extended to *also* check loaded-contract compliance on every still-**pending**
offer, and pre-emptively revoke one that would violate it — narrowing the window a native accept
could exploit. This is confirmed to be a real, existing mechanism (`index.js:36940-37164`,
`findOwnershipViolations`) that currently checks ownership only, not the loaded-contract count.
**This is explicitly a mitigation, not a guarantee** — it depends on polling cadence and can race
a fast native accept, exactly the class of gap the 2026-09-25 stuck-offer incident (referenced
elsewhere in this repo's history) already demonstrated for a different check. §8.1 is the actual
fix; this is at most a stopgap while §8.1 is reviewed, and should not be presented to owners or
Keith as closing the bypass on its own.

---

## 9. Hammer Times — the existing roster, investigated separately (read-only, no repair proposed)

Per Keith's separate instruction, this section reports the existing state of HammerTime's roster
plainly, without proposing any fix, grandfather clause, or correction — that judgment is Keith's,
not this design's.

**Re-fetched live** (this review round) via the same public exports the trade-compliance gate
itself reads, and cross-checked against the same live-hitting worker endpoint, both matching
exactly: HammerTime carries **7 loaded contracts including IR, 6 excluding IR**. The live gate
itself, run against this exact roster, reports `loaded_before: 7`.

| Player | Pos | Status | Why the shipped classifier calls it loaded |
|---|---|---|---|
| McBride, Trey (15794) | TE | ROSTER | Y1 $9K < $22K avg (CL2/TCV44K) |
| Smith, Geno (11150) | QB | ROSTER | Y1 $9K < $15K avg (CL3/TCV45K) |
| Addison, Jordan (16186) | WR | ROSTER | Y1 $7K < $12K avg (CL2/TCV24K) — see caveat below |
| Chase, Ja'Marr (15281) | WR | ROSTER | Y1 $26K < $64.5K avg (CL2/TCV129K) |
| Walker III, Kenneth (15711) | RB | ROSTER | Y1 $15K < $37K avg (CL2/TCV74K) |
| Montgomery, David (14071) | RB | ROSTER | Y1 $12K < $21K avg (CL2/TCV42K) — see caveat below |
| Jacobs, Josh (14073) | RB | **INJURED RESERVE** | Y1 $18K < $30K avg (CL3/TCV90K) |

All seven are correctly, mechanically back-loaded by the classifier's own documented logic (Year 1
below TCV÷CL) against real, well-formed, fully-reconciled payment schedules — zero unresolved
contracts on this roster.

**Whether IR counts toward the 5 — a genuinely open question, not a settled rule:** canon
(`docs/league_context_v1.md`) states the 5-loaded-contract maximum in three places (§2.G, §6.G,
§C2) without ever mentioning IR. It explicitly excludes IR from the active-roster maximum and the
27-player minimum (§B3), and separately guarantees taxi contracts can never be loaded at all
(§C2), which is why taxi needs no carve-out in the count — but that specific reasoning does not
extend to IR, where a loaded contract demonstrably exists today (Jacobs). **The shipped code
counts IR players toward the 5 — but only because nothing in the scan filters them out**
(`trade_cap_authority.js:254-270` classifies and counts every rostered player before the taxi
skip at `:273`; the IR flag is read only for the *active*-count and cap-charge calculations,
never for this one). This behavior predates this session entirely (present in the original PR
#1135 merge and the version before it) and was not decided by, or changed by, this session's
work. Whether IR *should* count is Keith's call, separate from whether a new trade may increase
or maintain an existing over-limit count — this design and its enforcement do not depend on the
answer either way, since they operate on whatever the live count already is.

**A separate, genuinely uncertain observation, reported neutrally:** Addison and Montgomery are
both `Vet-Ext1` (a one-year extension) with no `-FL`/`-BL` suffix. Canon §C4 states a 1-year
extension's status suffix is never `-FL`/`-BL`. Both contracts' schedules follow the documented
1-year-extension raise pattern exactly (the prior year's salary plus the standard positional
raise). The shipped classifier's Year-1-vs-average test, applied to this contract shape, calls
both back-loaded anyway — and `contract_classification.js:438-445` contains a comment, written
about *extension pricing previews*, that this same comparison "would misclassify almost every
extension." Whether that reasoning also applies to classifying an *existing, already-extended*
roster contract (as opposed to pricing a new one) is a real, substantive question this
investigation surfaces but does not resolve — it is the entire difference between HammerTime's
count landing at 5 (at the limit, not over) or 7. Reported here as a finding for Keith's judgment,
not asserted as a bug and not proposed as something to fix.

**Also observed, not investigated further:** L.A. Looks (franchise 0001) showed `loaded_before: 8`
in the same live gate run — out of scope for this investigation, flagged only so it isn't lost.

---

## 10. What this design deliberately reuses, unchanged

- The execution ledger (`trade_execution.js`) — no new states, no new table, no new locking
  primitive, regardless of which ordering (or the manual-queue alternative, §2.4) is chosen.
- `executeCommishTwoPartyTrade`'s commissioner-impersonation pattern, for drops too (§4) and for
  the staged-2-way execution moment (§8.1).
- The drop route's own MFL-response-distrust / roster-read-verification discipline (§1.1, §7).
- The cap-penalty cron (`ups_drop_events`) for dollar amounts — not duplicated.
- `evaluateTradeCompliance`'s existing recalculation of cap and lineup with a drop excluded (§5)
  — already shipped this review round, reused as-is.

## 11. What is explicitly NOT decided here, and needs review before ANY of this becomes code

- **Which ordering** (§2.1 Trade-first, §2.2 Drop-first) — or the manual-review-queue alternative
  (§2.4) — Keith wants to run with. Not assumed by this revision.
- **The staged-2-way design** (§8.1) as the fix for the native-MFL bypass — a separate, real
  architectural change, reviewable on its own before drop-execution code is written.
- The exact commissioner-facing (and, newly, owner-facing per §2.1) notification copy for every
  failure kind (`failed` vs `unconfirmed`, §2.1/§2.2/§6).
- Whether a stale, unresolved `executed_needs_review` drop needs its own aging alert (§2.1).
- Whether an owner can retry their own failed drop step, or whether that's commissioner-only (§6).
- The exact consent-copy changes to the shipped selection UI (§3) — a scoped, separate UI change
  that should land regardless of which ordering is chosen, since it's needed either way.
- The lockout operating-mode open question (§4), unchanged from v1.
- The exact new function shape for a commissioner-authenticated drop call and any new
  `steps_json` fields it needs — sketched in prose (§1.1, §7), not written.

None of the above is resolved by this document. It is the reviewable design Keith asked for, with
every specific failure mode he named addressed by name, both orderings presented without either
being assumed safe, a real design (not a hand-wave) for the native-bypass gap, and an explicit
list of what still needs a decision before a single line of execution code is written.
