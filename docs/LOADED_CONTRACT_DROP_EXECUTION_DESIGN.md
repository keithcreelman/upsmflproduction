# Loaded-Contract Conditional-Drop EXECUTION — design doc (not implemented)

**Status: design/trace only, REVISION 3.** No code in this document has been written or approved.
Round 1 (Keith, 2026-09-29): *"Do not merge, migrate, or deploy PR #1149 as currently written...
Revise the execution design without assuming either operation order is safe."* Round 2 (same day,
after reviewing round 1's §8): *"My send-time rule applies to both teams, not only the initiator
... That is a release blocker for the conditional-drop feature, even if the bypass existed before
this PR. Please revise the staged-offer design to account for roster changes after creation as
well... Also resolve the inconsistency in §8.1: it says drops have 'genuinely executed' before
the worker creates the MFL trade, which assumes drop-first while the execution order is
explicitly undecided."* This revision answers both: §8 is rewritten from a scoped "stage it if it
looks risky at creation" design to a rigorous analysis of what MFL actually lets this app
guarantee (conclusion: nothing short of staging every 2-way trade, since the risk is a property
of a roster's state at an unpredictable future moment, not of the offer's own content), and §8's
staging mechanism is decoupled from §2's still-open ordering decision, which it no longer assumes.
Nothing here is built. The SELECTION mechanism (an owner picking and confirming which of their
own loaded-contract players to drop, conditional on a trade) is built, tested, and committed —
and a satisfied selection is verified to produce **zero** real MFL writes anywhere in the
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

### 8.2 The staged-execution mechanism (ordering-agnostic — §2 is still Keith's decision)

**Keith's correction to v1:** *"Resolve the inconsistency in §8.1: it says drops have 'genuinely
executed' before the worker creates the MFL trade, which assumes drop-first while the execution
order is explicitly undecided. Keep the staged approval flow separate from the later irreversible
execution sequence until I rule on it."* v1 conflated two independent decisions — this version
separates them explicitly:

- **Staging (this section) decides WHEN a 2-way trade is allowed to become a real, MFL-visible
  transaction at all.** It is a gate on *existence*, not on internal sequencing.
- **Ordering (§2, still Keith's open decision) decides, once staging has cleared, in what
  internal sequence the trade write and the drop write(s) happen relative to EACH OTHER.**

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
   over the limit, or because every needed drop has been resolved per **whichever ordering §2
   settles on** — the worker executes the real MFL trade via commissioner impersonation
   (`executeCommishTwoPartyTrade`, reused exactly as 3-way already uses it), and, per §2's chosen
   ordering, either before or after that call, executes any confirmed drop(s). This step's
   internal sequence is entirely governed by §2's answer — staging does not presuppose it, and a
   change to §2's ordering decision requires no change to this section.

This still closes the bypass for the identical structural reason 3-way already has no exposure:
**there is nothing on MFL's own site to accept until this app itself decides to create it** — now
true for every 2-way trade, not only the ones that looked risky at the moment they were proposed.

### 8.3 Cost, and a scoped alternative if universal staging is more than Keith wants right now

Universal staging is a materially larger change than v1's scoped version: **every** 2-way trade —
not just loaded-contract-relevant ones — moves off MFL's native propose/accept flow and onto a
worker-brokered one, for its entire pending lifetime. Concretely this means: new "staged offer"
UI replacing the native inbox card on both platforms for every 2-way trade, every 2-way accept
becoming a commissioner-impersonated write instead of the owner's own session write (a change in
authentication model for the single most common transaction type in the app, not just for
conditional-drop cases), and full de-risking of counter-offers, revokes, and the existing 2-way
notification/DM surface against the new staged shape.

**If that scope is more than Keith wants approved right now**, the honest, explicitly-bounded
alternative is: stage only offers meeting a heuristic threshold (e.g. either side at ≥3 or ≥4
loaded contracts at creation, or either side's roster having changed at all since a prior
staging-eligible check) — accepting, in writing, that this narrows the *frequency* of exposure
without closing it, and stating that residual risk plainly to owners and to Keith rather than
implying it is closed. This document does not recommend the scoped alternative over universal
staging — it only offers it as the honest, smaller-scope option Keith may prefer to approve first,
with its limits stated rather than hidden.

### 8.4 A supplementary, imperfect mitigation — explicitly not a substitute, per Keith's instruction

`worker/src/index.js`'s existing "trade-sentinel" sweep (`/admin/trade-sentinel/tick`, already
polling every pending MFL trade for stale-ownership violations and auto-revoking them,
`index.js:36940-37164`, `findOwnershipViolations`) could be extended to *also* check
loaded-contract compliance on every still-**pending, native** offer (i.e. any 2-way trade created
before §8.1-8.3 ship, or if only the scoped alternative in §8.3 is approved) and pre-emptively
revoke one that would violate it. **Keith's instruction is explicit: "Do not rely on a polling
sentinel as a guarantee."** This is recorded here only as a stopgap that narrows a window that
already-existing polling cadence can miss — exactly the class of gap the 2026-09-25 stuck-offer
incident (referenced elsewhere in this repo's history) already demonstrated for a different check
— and must never be presented to owners or to Keith as closing the bypass.

---

## 9. Hammer Times, L.A. Looks, and plain `Vet-Ext1` — investigated separately, no repair proposed

Per Keith's separate instructions (2026-09-29, both rounds), this section summarizes two
read-only investigations that report existing roster/rule state plainly, without proposing any
fix, grandfather clause, or production change — that judgment is Keith's. **Full detail, canon
citations, and a recommendation live in their own documents**, referenced below rather than
duplicated here.

**HammerTime carries 7 loaded contracts today, 6 excluding a 7th on IR (Jacobs, Josh)** — the
live gate agrees exactly (`loaded_before: 7`). All seven are correctly, mechanically back-loaded
by the classifier's own documented logic against real, well-formed, fully-reconciled payment
schedules — zero unresolved contracts. **L.A. Looks separately carries 8** — investigated further
in round 2, below.

**Whether IR counts toward the 5** — canon never mentions IR for this specific limit (only for the
active-roster maximum and the 27-player minimum, §B3); the shipped code counts it only because
nothing filters it out, unchanged by any of this session's work and predating it back to the
original PR #1135 merge. Presented as a clean, standalone decision for Keith in
`docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_INVESTIGATION.md` §8, separate from the Ext1 question
below, since neither the code nor canon offers a lean either way.

**Round 2 (Keith, after reviewing round 1's brief mention of Addison/Montgomery): "Before changing
enforcement, investigate the one-year `Vet-Ext1` classification across the league... Show the
contract terms and consequences for Hammer and L.A. Looks, plus tests for both possible
interpretations; recommend the rule supported by canon, but do not silently change production
counts."** That full investigation — canon quotes with line numbers, complete loaded-contract
tables for both named franchises, a league-wide (all 12 franchises) scan, and a recommendation —
is `docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_INVESTIGATION.md`. Its headline finding: a plain
(no `-FL`/`-BL`) `Vet-Ext1` contract is classified loaded today purely because
`resolveLoadedStatus` applies the same generic Year-1-vs-average test to every contract
regardless of shape — but the **same codebase's own extension-pricing logic already treats this
exact shape as flat**, for a documented reason (`contract_classification.js`'s
`resolveExtensionLoadedStatus` docblock: "a single future year... has no shape to compare and is
flat") that describes the Ext1-after-a-final-year pattern precisely. The same real contract is
flat when priced and loaded once it's on the roster — a genuine internal inconsistency, not just
an ambiguous reading of canon. Tests proving both interpretations' exact behavior on the real
contract data, without changing any production file, are
`tests/trade_loaded_contract_ext1_classification.test.mjs` (9 tests, 30 assertions).

**The consequence, precisely** (full tables in the dedicated doc): under the current, shipped
classification, HammerTime is 2 over the limit and L.A. Looks is 3 over. Under the alternate
interpretation the internal-inconsistency evidence supports, HammerTime lands exactly at the
limit (zero headroom) and L.A. Looks lands one UNDER it. League-wide, across all 12 franchises,
the same alternate interpretation moves the total loaded-contract count from 58 to 44 and the
number of franchises over the limit from 5 to 2.

**The recommendation** (§7 of the dedicated doc, not applied here or anywhere in production):
a plain `Vet-Ext1`/`Rookie-Ext1` contract with no suffix should not count toward the 5-loaded
limit, on the strength of the internal-inconsistency evidence above — restructured Ext1s that
have earned a real, canon-sanctioned suffix (e.g. HammerTime's Kenneth Walker III, L.A. Looks'
Sam Darnold) are unaffected either way and correctly stay counted. This recommendation changes no
counts on its own; it is presented for Keith's decision, separate from the IR question, and
separate from whether a NEW trade may increase or maintain an existing over-limit count — this
execution design and its enforcement operate on whatever the live, authoritative count already is
at the moment they run, regardless of how either open question is eventually decided.

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

## 11. What is explicitly NOT decided here, and needs review before ANY of this becomes code

- **Which ordering** (§2.1 Trade-first, §2.2 Drop-first) — or the manual-review-queue alternative
  (§2.4) — Keith wants to run with. Not assumed by this revision, and now explicitly decoupled
  from staging (§8.2) — the ordering decision can be made independently of, and later than, the
  staging decision.
- **Whether to approve UNIVERSAL 2-way staging** (§8.1-8.2, this revision's conclusion: nothing
  narrower is a guarantee) **or the explicitly-bounded scoped alternative** (§8.3, narrower scope,
  stated residual risk) — a separate, real architectural change either way, reviewable on its own
  before drop-execution code is written, and the larger of the two decisions in this document.
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
