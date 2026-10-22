# Front Office → Trades: Trade Builder (proposal)

Status: **proposal only** (Keith 2026-10-22). Separate from the Trade Finder draft (#1381) and from the Front Office stack (#1338). Nothing here changes code, routes or trade behavior, and nothing publishes a trade action.

## What Keith asked for
- **Trade Builder** becomes the first area in Front Office → Trades, with **Trade Finder** next to it.
- It brings over the useful parts of the existing **Trade War Room**, including **two-team and three-team** trades.
- **Player names** open the existing player insights, and **schedule and contract** information is available while building.
- The **Trade War Room link** ultimately lands in this Trades experience.

## What exists today (inventory, 2026-10-22, read-only)
| Area | Where | Notes |
|---|---|---|
| War Room page | `site/trades/trade_workbench.html` (inlined CSS), `trade_workbench.js` (~8.8k lines) | Embedded on MFL's Trades page (`MESSAGE6`) by `site/trades/mfl_hpm_embed_loader.js` as an iframe; preload keys `twb_*` in the hash |
| Two-team builder | `buildTradePayload`, `buildValidationSummary`, `offerIsReady` | Players, future picks (`FP_`), current picks (`DP_`), cap money (`BB_`, capped by `getTradeSalaryMaxK`) |
| Three-team builder | `tw3Movements` and the 3-way screens; `site/shared/trade_3way_view.js` | Movements `{from, to, asset_tokens, cap_k}`; players and future picks; partners accept in Discord |
| Cap and rules | `buildSalaryReconciliation`, multi-year impact; server `worker/src/trade_cap_authority.js` | Over-cap acknowledgement (409 `cap_overage_ack_required`); loaded-contract hard block; roster limits warn only |
| Pre-trade extensions | War Room modal; `worker/src/extension_pricing.js` | |
| Pending offers | banner with accept / reject / revoke / counter / preview | `GET /trade-offers` is slow (~16 s of a 19 s load) |
| Writes | `POST /trade-offers` (= `/api/trades/proposals`), `/trade-offers/action`, `/api/trades/3way*`, `/api/trades/2way*` | All through `worker/src/trade_authz.js` (proven MFL session; own team unless commissioner); kill switches in `worker/src/feature_flags.js` |
| Pre-send check | `POST /api/trades/compliance-preview` | Session-checked, parties only; the handler writes nothing itself, but its compliance dependency must be audited for writes before the builder calls it (a dry run is not proof) |
| Player insights | Front Office slide-over (`openSlideover`: Bio, Actions, Stats, Game Log, Contract History, Transaction Log, News) | The War Room's player names open nothing today. There's no Schedule tab; schedule data is in `fo_data.js` (`nflSchedule`, byes) |
| Links into the War Room | `UPS_FO.warRoomUrl` → MFL `MESSAGE6=N` + `twb_*` hash; callers in `fo_trades.js`, `fo_market.js`, `fo_overview.js`, the slide-over | |

## Proposed experience
**Trades → [Trade Builder] [Trade Finder]**, with Trade Builder first.

1. **Two teams by default** ("Add a third team" switches to three). Each side shows its roster grouped by position, with these columns:
   - season PPG and rank;
   - injury chip;
   - contract (salary, years left, type);
   - bye week and the next three opponents (from MFL's NFL schedule).
   - Picks come grouped by year and round, with forfeits greyed for your team (as on the Draft picks view).
2. **Player names open the existing player panel** (the slide-over), in the same way the #1381 popup does it. The builder stays put underneath, and focus returns to the name when the panel closes.
3. **Trade summary**, updated as assets move:
   - each team's cap room before → after (Front Office cap engine), with the multi-year salary impact;
   - roster counts;
   - each team's modeled lineup before → after (the Trade Finder's calculation; information, never a grade);
   - flags for rule blocks (loaded contract, over the cap) and warnings (roster limits).
4. **Trade deadline**: shows MFL's enforcement time (the `trade_lock` from #1360/#1368). Once MFL refuses trades, the builder says so and offers no send.
5. **Sending** (a later phase, behind a flag): runs the existing pre-send compliance check, then the existing routes and authz, unchanged. No new write route.

## Architecture options
| Option | What | For | Against |
|---|---|---|---|
| A. Embed | Show the War Room iframe inside Trades | Fastest; no logic moves | Two UIs and two cap engines on one screen; player links still dead; phone layout stays the War Room's |
| **B. Extract and share (recommended)** | Move the payload builder, validation, cap reconciliation and 3-way movement logic out of `trade_workbench.js` into `site/shared/trade_*.js` modules used by both the War Room and the new builder; the builder UI is a Front Office view | One source of trade rules; the War Room keeps working during the move; testable modules | Larger first PR; needs parity tests between the old and new pages |
| C. Rewrite | New builder from scratch | Clean | Re-derives a lot of rule-heavy logic; highest regression risk |

## Phased plan (one PR each, all draft until Keith's go)
1. **P1, read-only builder.**
   - Two-team builder in Front Office → Trades with player panel links, contract and schedule columns, and the trade summary (Front Office cap engine). Nothing is sent and the compliance route isn't called.
   - **Hand-off:** "Open in Trade War Room" preloads the same trade with the existing `twb_*` keys.
   - **Preview:** phone preview, with tests for cap parity against the War Room's own reconciliation on fixtures.
2. **P2, shared modules.** Extract the War Room's trade logic (option B) and switch the War Room to it, with no behavior change. A parity test suite covers every existing trade test.
3. **P3, three-team.** Add the three-team builder on the shared movement model.
4. **P4, sending** (behind a new flag, off by default):
   - wire the existing compliance check and send, accept and counter routes;
   - audit the compliance dependency for writes;
   - rehearse in test league 25625 only;
   - production needs Keith's explicit go.
5. **P5, routing.** `warRoomUrl` and the MFL Trades pill land in Front Office → Trades. The War Room page stays as a fallback until parity is signed off, then redirects.

## Safety rules carried over
- **Writes and authz:** no new write routes; `trade_authz` is unchanged; existing kill switches apply.
- **Previews:** replay recordings, block every write, and never include owners' trade messages, `trade_offers_*` files or trade-block notes.
- **Credentials:** no `APIKEY` in Front Office URLs; the builder uses the viewer's session like the Front Office's other reads.
- **Routes:** a new route would need an exact-path exemption from the worker's no-`L` guard. That guard caused the 2026-09-25 3-way cancel incident, so P1 avoids new routes entirely.
- **Known gaps to respect:**
  - The Front Office and worker cap engines agree only in tests.
  - Staged two-way trades stay hidden from owners.
  - A stuck three-way can only be cancelled by the commissioner.
  - `/trade-offers` is slow, so P1 doesn't load pending offers.

## Decisions for Keith (one at a time)
1. **Architecture.** I recommend **B, extract and share**, starting with **P1, the read-only builder**, so the first PR changes no trade behavior.
2. Later: whether the War Room page stays as a fallback after P5, and when the MFL Trades pill switches over.

## Definition of done for P1
- Trades opens on **Trade Builder**, with Trade Finder alongside.
- **Building a two-team trade** shows contract, bye and next-3 opponents for every player.
- **The summary** gives cap before → after (matching the War Room's reconciliation on fixtures), roster counts and lineup before → after.
- **Player names** open the player panel and return focus.
- **No send path:** the only action is "Open in Trade War Room".
- **Phone preview:** works at 320 and 375 px, with 0 writes and 0 worker or MFL requests beyond the recorded reads.
