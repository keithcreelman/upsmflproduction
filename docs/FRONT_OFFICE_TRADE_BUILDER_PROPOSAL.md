# Front Office → Trades: Trade Builder (revised plan)

**Status:** plan only. Production trade sending stays off, and the War Room link isn't redirected until Keith reviews the working flow.
**Rulings (Keith 2026-10-22):**
- Reuse the War Room's trade logic in shared modules, with one source of truth for trade rules.
- The finished builder preserves everything the War Room does today.
- The War Room keeps working throughout.
- Parity is tested before sending switches.
- No trade rule changes without showing Keith the proposed difference.

Four independent read-only reviews examined the current flow end to end: the War Room client, every write route and its authz, the shared pre-send compliance function, and trade locks with pending offers. Their findings are reconciled below. Security and integrity details are in Keith's private project record (12 items: 4 high, 5 medium, 3 low), not here.

## 1. The end state
Front Office → Trades → **Trade Builder** (Trade Finder alongside). An owner can:
- **Inspect** each player through the existing player panel: stats, game log, contract history, and next a schedule tab (bye plus the next 3 opponents). Contract and schedule columns also show in the builder.
- **Build** a two-team or three-team trade with players, future picks, current-year picks, cap money and pre-trade extensions. The same eligibility rules apply as today.
- **See effects:** each team's cap before → after with the multi-year impact, roster counts, the loaded-contract count, and each modeled lineup before → after (the Trade Finder's calculation, shown as information, never a grade).
- **See MFL's trade lock:** "closes …", "closed", or "can't be confirmed — MFL decides".
- **Complete the same supported process:**
  - propose;
  - review incoming offers, then accept (preview first), reject, revoke or counter;
  - create, recheck, acknowledge or cancel a three-team trade (partners still accept in Discord, as today);
  - over-cap acknowledgment;
  - the staging fallback;
  - every current execution outcome and error message.

## 2. One source of truth for trade rules
**Today** the rules live in five or more places that disagree: the War Room client's own cap engine, its 2-team and 3-team builders, the phone trade tab, the worker's three create paths, the accept gates, and the Front Office cap engine. The parity tests compare worker endpoints only, never the browser math.

**Plan**
1. **Shared pure rules modules** (no network, no `env`), loadable by the worker and the browsers:
   - **assets:** token grammar `P_`/`FP_`/`DP_`/`BB_` and eligibility;
   - **cap:** cap hit, reconciliation, multi-year impact and the cap-money maximum;
   - **loaded contracts:** reuse the existing shared classifier;
   - **extensions:** reuse `site/shared/pretrade_extension.js`;
   - **trade model:** one movement-based model `{from, to, tokens, cap_k}` for two- and three-team trades; the two-team payload is derived from it.
2. **The server's verdict is the authority.** `compliance-preview` returns every rule in one answer: cap and acknowledgment needed, cap money, loaded contracts, pick eligibility and forfeits, roster advisory and the trade lock. "Ready" comes only from that verdict. Browsers use the shared modules to display numbers instantly, never to decide.
3. **Both clients use the shared modules:** the War Room is switched to them first, with byte-identical behavior. The Front Office builder is built on them.
4. **Parity is a test**, not a promise: the same inputs run through the War Room client, the builder and the server, and the expected outputs must match.

The pre-send compliance function was audited: **no data writes found**. One `CREATE TABLE IF NOT EXISTS` runs, as a no-op, when extensions are present. It reads about 6 MFL exports per call, including the full players list, so the builder must debounce it.

## 3. What must be preserved (merged from the four reviews)
**Trade rules**
- **Cap and cap hits:**
  - The cap ceiling comes from MFL. Exactly at the cap is fine; one dollar over needs the affected owner's **acknowledgment** of the exact figure. It isn't a hard block (Keith 2026-09-28). An unreadable cap fails closed.
  - Cap hits: taxi $0 and IR 50% on the sending side. A traded player arrives active at full salary. Cap money is charged to the sender and credited to the receiver in year 0 only. The multi-year view covers 3 seasons.
  - Cap money is at most 50% of the non-taxi salary sent (per side for two-team, per movement for three-team). Money alone is never a trade.
- **Contracts and eligibility:**
  - Loaded contracts: at most 5, counting IR and taxi; a hard block at create and accept. There is no in-trade drop picker (410).
  - Not tradeable: 6th-round picks, picks beyond next year, already-made current-year picks, forfeited picks, and tagged players before the tag deadline.
  - Pre-trade extensions: eligibility and price are re-checked by the server, and the receiver pays the extension's year-1 salary.
- **Accept and integrity:**
  - Every accept re-checks live data. The client's copy is never trusted: the server uses the stored offer only if it matches MFL's own tokens (the `[UPS_TWB_META:` trailer).
  - The drop-first hold applies on every path.
- **Who can act:**
  - Only the signed-in team proposes for itself; a commissioner acts for a team only through their own session.
  - Only the recipient accepts, rejects or counters; only the sender revokes.
  - A three-team trade is cancelled only by its initiator while collecting; the commissioner uses the separate admin action with a reason; nobody cancels once it is executing.
  - A counter is "reject the original, then propose the new offer back".
- **Three-team execution:** a cap hold (`blocked_cap`) keeps every accept, and a recheck executes exactly once.
- **MFL is final:**
  - MFL's calendar lock decides, and its refusal text reaches the owner word for word.
  - A trade MFL records as completed is final.
  - An unconfirmed accept is never sent again; it is settled by asking MFL.

**Plumbing and UX**
- **Sending:** the execution lock is taken before MFL is called. Conditional state updates. Identity, cap, ledger and flag reads all fail closed.
- **Accept screen:** a server PREVIEW before every accept. "Executed — needs review", "Trade not confirmed (not re-sent)" and "Already accepted" are never shown as success.
- **Inbox:** signed out, failed and empty are different states, and counts show "–", never "0", when unknown. Pending offers are always read fresh. Acting in the app clears that offer's Discord reminders.
- **Links and locks:** deep-link keys `twb_*` keep working. When the commissioner lockout is on, "your team" is locked to the signed-in franchise.

## 4. Rule differences found: Keith decides each (current → proposed)
These are where code, canon and clients disagree today. **Nothing changes until Keith rules.** Until then, the parity phase preserves today's server behavior exactly.

| # | Topic | Current | Proposed |
|---|---|---|---|
| R1 | WW pickup pre-trade extensions | Desktop War Room always withholds them (the contract ladder is read before it's loaded); the phone shows them with no ladder gate | Both follow the ladder stage |
| R2 | Cap-money base | Two-team desktop: contracts with years > 0. Three-team desktop and phone: any non-taxi player. Server: raw roster salary | One base; Keith picks it |
| R3 | Tag trade deadline | Client: Thursday 23:59:59 UTC. Worker and canon: Friday 04:00 UTC (about 4 h later). The client also blocks early-locked tags, which canon says are tradeable | Follow canon everywhere |
| R4 | Over-cap wording | Code (and the 09-28 ruling): acknowledgment. Canon text (`league_context_v1.md` ~288) and `TRADE_WAR_ROOM.md` §9/§10 say hard block / no override | Update the canon and doc text to the ruling (text only) |
| R5 | Roster advisory max in season | Server uses MFL `rosterSize` (35); canon and the Front Office use 30 after the contract deadline | 30 per canon (advisory only) |
| R6 | Expired non-rookie contracts | Canon says untradeable; nothing enforces it | Enforce |
| R7 | A three-team or staged trade fully accepted before the lock but executed after it | Whatever MFL does for commissioner writes (unverified) | The worker checks MFL's lock before each leg and holds the trade |
| R8 | Staged two-team conditional drop picker (flags off today) | Still honored | 410, as the 2026-10-01 ruling says for two- and three-team |
| R9 | Counter order | Reject the original, then propose; if the propose fails, the original is lost | Propose first, then reject the original (same end state) |

**Display bugs that follow the server's existing rule (not rule changes):**
- War Room client shows $0 for a fully blank contract (server: full salary).
- War Room client shows IR at 50% when received (server: full).
- The multi-year table counts current-year pick salary that the reconciliation excludes.
- Loaded offers silently drop tokens that aren't on the roster.

## 5. Privacy
Owners' trade messages are written to public repo files today: `site/trades/trade_offers_*`, `trade_outbox_*` and the daily snapshots. A ruling on this is already pending. The builder will **never** read, render or preview those files; messages appear only to the two parties. **Recommended** (with that ruling): move the offer mirror to D1, keyed by MFL trade id. That also removes the slow GitHub read from the pending-offers load (about 16 s today).

## 6. Phases (each its own draft PR; nothing enabled in production without Keith's review)
| Phase | What | Exit test |
|---|---|---|
| **P0 Safety prerequisites** | The private security and integrity items, as separate small PRs; the doc-text fix R4 if approved | Each PR's tests show the bad request can't read or write; test league only |
| **P1 Shared rules, War Room unchanged** | Extract the pure modules; switch the War Room to them | Golden tests: the War Room's payloads, MFL import fields, cap numbers and readiness are byte-identical before and after |
| **P2 One server verdict** | `compliance-preview` returns every rule (adds cap money, pick eligibility, forfeits, the lock); read-only, cost measured, debounced | Verdict = what send/accept would decide, on the parity matrix |
| **P3 Read-only Front Office builder** | Two- and three-team building with player panel, contract, schedule and lineup effects; the lock banner; pending offers shown read-only; "Open in Trade War Room" to send | Phone preview at 320/375 px; builder inputs → same payload as the War Room |
| **P4 Send in the Front Office, behind `FO_TRADE_BUILDER_SEND` (off)** | Propose, accept (preview first), reject, revoke, counter; three-team create, cancel, recheck and acknowledge; idempotency keys; the full error-code map | The parity matrix passes; supervised rehearsal in test league 25625 (two-team, three-team, a failure, a lock, a pending offer); then Keith reviews the working flow |
| **P5 Routing** | The War Room link and MFL's Trades pill land in Front Office → Trades; the War Room stays as a fallback | Keith's go |

## 7. Parity test matrix (merged)
- **Two-team:**
  - cap-money clamp: $21K non-taxi + $5K taxi + a pick → max $10K;
  - IR for taxi, with reconciliation;
  - a multi-year extension;
  - exactly at the cap → ok; $1 over → acknowledgment required;
  - loaded-contract limit;
  - a forfeited pick;
  - tag deadline before and after;
  - a round-6 pick;
  - a counter;
  - Builder and War Room produce identical MFL import fields.
- **Three-team:**
  - a ring A→B→C;
  - only two teams → refused;
  - cap money per movement;
  - a double-click makes exactly one create;
  - a cap hold keeps the accepts and a recheck executes once;
  - leg 2 fails after leg 1 → needs review, no retry.
- **Failures:**
  - signed out → sign-in message;
  - 409 `cap_overage_ack_required` → acknowledgment, then one resend;
  - 409 `staging_required` → staging;
  - 409 `loaded_contract_limit_exceeded` → block;
  - 502 `mfl_rejected` → MFL's text;
  - 503 `execution_unconfirmed` → "not sent again";
  - a lost accept response → settled by asking MFL, never double-sent.
- **Locks:**
  - one second before / at / one second after the lock start → upcoming / upcoming / closed;
  - an unreadable calendar → unconfirmed, no time shown;
  - MFL's calendar refusal on propose, accept and counter.
- **Pending offers:**
  - list for the proven franchise only;
  - accept, revoke (sender only), counter;
  - expired;
  - three-team waiting and held by the cap;
  - a team switch during a slow response never shows the old team's offers.

## 8. Builder design (no rule changes)
- One readiness object `{status, reasons[]}` drives every button.
- Buttons disable on click; idempotency key on every create; never auto-retry a write.
- Show exactly what was offered from the server's tokens (mark missing assets), never a re-hydrated draft.
- The session goes in the request the way the worker requires; never the API key. One table maps every error code to owner wording.
- Request tokens on the inbox and compliance reads, so a late answer can't overwrite a newer one.
- Lock banner and MFL `expires` shown on offers; state badges: Awaiting you / Awaiting them / Accepted, awaiting review / Held by cap / Needs commissioner.
